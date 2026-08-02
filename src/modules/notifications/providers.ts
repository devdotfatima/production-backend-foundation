import nodemailer from 'nodemailer';
import twilio from 'twilio';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { z } from 'zod';
import type { Env } from '#app/config/env.js';
import { decryptSecret } from '#app/lib/crypto.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

const destinationSchema = z.object({ destination: z.string().min(1) });
const otpSchema = destinationSchema.extend({
  challengeId: z.uuid(),
  encryptedCode: z.string().min(1),
  purpose: z
    .enum(['SIGNUP', 'LOGIN', 'VERIFY_EMAIL', 'VERIFY_PHONE', 'PASSWORD_RESET', 'EMAIL_CHANGE'])
    .optional(),
});
const pushSchema = z.object({
  userId: z.uuid(),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(500),
  data: z.record(z.string(), z.string()).optional(),
});

export interface NotificationProviders {
  sendEmail(eventType: string, payload: unknown): Promise<void>;
  sendSms(eventType: string, payload: unknown): Promise<void>;
  sendPush(payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export type NotificationProviderDependencies = {
  config: Env;
  database: Pick<PrismaClient, 'device' | 'otpChallenge'>;
  logger: Pick<Logger, 'info'>;
};

function createFirebaseApp(config: Env): App | null {
  if (!config.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  const account = z
    .object({ project_id: z.string(), client_email: z.string(), private_key: z.string() })
    .parse(JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON));
  return initializeApp(
    {
      credential: cert({
        projectId: account.project_id,
        clientEmail: account.client_email,
        privateKey: account.private_key.replace(/\\n/g, '\n'),
      }),
    },
    `${config.QUEUE_PREFIX}:notifications:${process.pid}`,
  );
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function createNotificationProviders(
  dependencies: NotificationProviderDependencies,
): NotificationProviders {
  const { config, database, logger } = dependencies;
  const smtp = config.SMTP_HOST
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
      })
    : null;
  const sms = config.TWILIO_ACCOUNT_SID
    ? twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN)
    : null;
  const firebaseApp = createFirebaseApp(config);

  return {
    async sendEmail(eventType, payload) {
      let destination: string;
      let subject: string;
      let text: string;

      if (eventType === 'auth.otp') {
        const value = otpSchema.parse(payload);
        const challenge = await database.otpChallenge.findFirst({
          where: {
            id: value.challengeId,
            consumedAt: null,
            lockedAt: null,
            deletedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!challenge) return;
        destination = value.destination;
        const isPasswordReset = value.purpose === 'PASSWORD_RESET';
        subject = isPasswordReset ? 'Your password reset code' : 'Your verification code';
        text = `${subject} is ${decryptSecret(value.encryptedCode)}. It expires in 5 minutes.`;
      } else if (eventType === 'auth.signup_existing') {
        const value = destinationSchema.parse(payload);
        destination = value.destination;
        subject = 'A signup was requested for your account';
        text =
          'Someone attempted to sign up using this email. Your existing account was not changed.';
      } else {
        throw new Error(`Unsupported email event: ${eventType}`);
      }

      if (!smtp) {
        logger.info({ eventType, destination }, 'Email provider is in structured-log mode');
        return;
      }
      await smtp.sendMail({ from: config.EMAIL_FROM, to: destination, subject, text });
    },

    async sendSms(eventType, payload) {
      if (eventType !== 'auth.otp') throw new Error(`Unsupported SMS event: ${eventType}`);
      const value = otpSchema.parse(payload);
      const challenge = await database.otpChallenge.findFirst({
        where: {
          id: value.challengeId,
          consumedAt: null,
          lockedAt: null,
          deletedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!challenge) return;
      const body = `${value.purpose === 'PASSWORD_RESET' ? 'Your password reset code' : 'Your verification code'} is ${decryptSecret(value.encryptedCode)}. It expires in 5 minutes.`;
      if (!sms) {
        logger.info(
          { eventType, destination: value.destination },
          'SMS provider is in structured-log mode',
        );
        return;
      }
      await sms.messages.create({ from: config.TWILIO_FROM, to: value.destination, body });
    },

    async sendPush(payload) {
      const value = pushSchema.parse(payload);
      const devices = await database.device.findMany({
        where: { userId: value.userId, deletedAt: null },
        select: { fcmToken: true },
      });
      if (devices.length === 0) return;
      if (!firebaseApp) {
        logger.info(
          { userId: value.userId, deviceCount: devices.length },
          'FCM provider is in structured-log mode',
        );
        return;
      }

      for (const batch of chunks(
        devices.map((device) => device.fcmToken),
        500,
      )) {
        const message: MulticastMessage = {
          tokens: batch,
          notification: { title: value.title, body: value.body },
          ...(value.data ? { data: value.data } : {}),
        };
        const result = await getMessaging(firebaseApp).sendEachForMulticast(message);
        const staleTokens = result.responses.flatMap((item, index) => {
          const code = item.error?.code;
          return code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
            ? [batch[index]!]
            : [];
        });
        if (staleTokens.length > 0) {
          await database.device.deleteMany({ where: { fcmToken: { in: staleTokens } } });
        }
      }
    },

    async close() {
      smtp?.close();
      if (firebaseApp) await deleteApp(firebaseApp);
    },
  };
}
