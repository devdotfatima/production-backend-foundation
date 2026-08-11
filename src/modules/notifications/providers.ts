import twilio from 'twilio';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { z } from 'zod';
import type { Env } from '#app/config/env.js';
import { candidateMetadataHashes, decryptSecret, normalizeEmail } from '#app/lib/crypto.js';
import {
  createLogEmailTransport,
  createSmtpEmailTransport,
  type EmailTransport,
} from '#app/modules/notifications/email-transport.js';
import { renderEmailTemplate } from '#app/modules/notifications/templates/index.js';
import { notificationAllowed } from '#app/modules/notifications/notification-preferences.service.js';
import { createUnsubscribeToken } from '#app/modules/notifications/unsubscribe.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

const destinationSchema = z.object({
  destination: z.string().min(1),
  userId: z.uuid().optional(),
  organizationId: z.uuid().optional(),
  locale: z.string().optional(),
});
const otpSchema = destinationSchema.extend({
  challengeId: z.uuid(),
  encryptedCode: z.string().min(1),
  purpose: z
    .enum(['SIGNUP', 'LOGIN', 'VERIFY_EMAIL', 'VERIFY_PHONE', 'PASSWORD_RESET', 'EMAIL_CHANGE'])
    .optional(),
});

const OTP_EXPIRY_MINUTES = '5';
const invitationSchema = destinationSchema.extend({
  invitationId: z.uuid(),
  encryptedToken: z.string().min(1),
  organizationName: z.string().min(1),
  expiresInDays: z.string().default('7'),
});
const announcementSchema = destinationSchema.extend({
  userId: z.uuid(),
  topic: z.literal('product_updates'),
  headline: z.string().min(1),
  message: z.string().min(1),
  actionUrl: z.url(),
});

/** List-Unsubscribe/-Post are only meaningful (and only sent) for non-transactional templates. */
function unsubscribeHeaders(
  transactional: boolean,
  config: Env,
  userId?: string,
  topic?: 'product_updates',
): Record<string, string> | undefined {
  if (transactional) return undefined;
  const mailto = `mailto:${config.EMAIL_FROM}?subject=unsubscribe`;
  if (!config.EMAIL_UNSUBSCRIBE_URL || !userId || !topic) {
    return { 'List-Unsubscribe': `<${mailto}>` };
  }
  const unsubscribeUrl = new URL(config.EMAIL_UNSUBSCRIBE_URL);
  unsubscribeUrl.searchParams.set('token', createUnsubscribeToken(userId, topic));
  return {
    'List-Unsubscribe': `<${unsubscribeUrl.toString()}>, <${mailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
const pushSchema = z.object({
  userId: z.uuid(),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(500),
  data: z.record(z.string(), z.string()).optional(),
});

export interface NotificationProviders {
  sendEmail(
    eventType: string,
    payload: unknown,
    context?: ProviderDeliveryContext,
  ): Promise<ProviderDeliveryResult>;
  sendSms(
    eventType: string,
    payload: unknown,
    context?: ProviderDeliveryContext,
  ): Promise<ProviderDeliveryResult>;
  sendPush(payload: unknown, context?: ProviderDeliveryContext): Promise<ProviderDeliveryResult>;
  close(): Promise<void>;
}

export interface ProviderDeliveryContext {
  /** Stable across BullMQ retries so idempotent transports/clients can suppress duplicates. */
  deliveryId: string;
}

export interface ProviderDeliveryResult {
  status: 'sent' | 'suppressed';
  provider: string;
  messageId?: string;
  templateKey?: string;
}

export type NotificationProviderDependencies = {
  config: Env;
  database: Pick<PrismaClient, 'device' | 'otpChallenge' | 'user' | 'emailSuppression'>;
  logger: Pick<Logger, 'info'>;
};

async function isSuppressed(
  database: NotificationProviderDependencies['database'],
  destination: string,
): Promise<boolean> {
  const normalized = normalizeEmail(destination);
  return Boolean(
    await database.emailSuppression.findFirst({
      where: {
        destinationHash: { in: candidateMetadataHashes(normalized) },
        deletedAt: null,
      },
      select: { id: true },
    }),
  );
}

async function resolvedLocale(
  database: NotificationProviderDependencies['database'],
  userId: string | undefined,
  requested: string | undefined,
): Promise<string | undefined> {
  if (requested || !userId) return requested;
  const user = await database.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { locale: true },
  });
  return user?.locale;
}

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
  const emailTransport: EmailTransport =
    config.EMAIL_PROVIDER === 'smtp' || config.SMTP_HOST
      ? createSmtpEmailTransport(config)
      : createLogEmailTransport(logger);
  const sms =
    config.SMS_PROVIDER === 'twilio' || config.TWILIO_ACCOUNT_SID
      ? twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN)
      : null;
  const firebaseApp = createFirebaseApp(config);

  return {
    async sendEmail(eventType, payload, context) {
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
          select: { id: true, userId: true, user: { select: { locale: true } } },
        });
        if (!challenge) return { status: 'suppressed', provider: 'policy' };
        if (await isSuppressed(database, value.destination)) {
          return { status: 'suppressed', provider: 'suppression-list' };
        }
        const templateKey =
          value.purpose === 'PASSWORD_RESET' ? 'auth-password-reset-otp' : 'auth-verification-otp';
        const rendered = renderEmailTemplate(
          templateKey,
          {
            code: decryptSecret(value.encryptedCode),
            expiresInMinutes: OTP_EXPIRY_MINUTES,
          },
          value.locale ?? challenge.user?.locale,
        );
        const sent = await emailTransport.send({
          to: value.destination,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: unsubscribeHeaders(rendered.transactional, config),
          deliveryId: context?.deliveryId,
        });
        return {
          status: 'sent',
          provider: emailTransport.provider,
          templateKey,
          ...sent,
        };
      }
      if (eventType === 'auth.signup_existing') {
        const value = destinationSchema.parse(payload);
        if (await isSuppressed(database, value.destination)) {
          return { status: 'suppressed', provider: 'suppression-list' };
        }
        const rendered = renderEmailTemplate(
          'auth-signup-existing',
          {},
          await resolvedLocale(database, value.userId, value.locale),
        );
        const sent = await emailTransport.send({
          to: value.destination,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: unsubscribeHeaders(rendered.transactional, config),
          deliveryId: context?.deliveryId,
        });
        return {
          status: 'sent',
          provider: emailTransport.provider,
          templateKey: 'auth-signup-existing',
          ...sent,
        };
      }
      if (eventType === 'organization.invitation') {
        const value = invitationSchema.parse(payload);
        if (await isSuppressed(database, value.destination)) {
          return { status: 'suppressed', provider: 'suppression-list' };
        }
        const actionUrl = new URL('/invitations/accept', config.APP_ORIGIN);
        actionUrl.searchParams.set('token', decryptSecret(value.encryptedToken));
        const rendered = renderEmailTemplate(
          'organization-invitation',
          {
            organizationName: value.organizationName,
            actionUrl: actionUrl.toString(),
            expiresInDays: value.expiresInDays,
          },
          await resolvedLocale(database, value.userId, value.locale),
        );
        const sent = await emailTransport.send({
          to: value.destination,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          deliveryId: context?.deliveryId,
        });
        return {
          status: 'sent',
          provider: emailTransport.provider,
          templateKey: 'organization-invitation',
          ...sent,
        };
      }
      if (eventType === 'product.announcement') {
        const value = announcementSchema.parse(payload);
        if (
          (await isSuppressed(database, value.destination)) ||
          !(await notificationAllowed(value.userId, 'EMAIL', value.topic, value.organizationId))
        ) {
          return { status: 'suppressed', provider: 'preference-policy' };
        }
        const rendered = renderEmailTemplate(
          'product-announcement',
          { headline: value.headline, message: value.message, actionUrl: value.actionUrl },
          await resolvedLocale(database, value.userId, value.locale),
        );
        const sent = await emailTransport.send({
          to: value.destination,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          headers: unsubscribeHeaders(rendered.transactional, config, value.userId, value.topic),
          deliveryId: context?.deliveryId,
        });
        return {
          status: 'sent',
          provider: emailTransport.provider,
          templateKey: 'product-announcement',
          ...sent,
        };
      }
      throw new Error(`Unsupported email event: ${eventType}`);
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
      if (!challenge) return { status: 'suppressed', provider: 'policy' };
      const body = `${value.purpose === 'PASSWORD_RESET' ? 'Your password reset code' : 'Your verification code'} is ${decryptSecret(value.encryptedCode)}. It expires in 5 minutes.`;
      if (!sms) {
        logger.info(
          { eventType, destination: value.destination },
          'SMS provider is in structured-log mode',
        );
        return { status: 'sent', provider: 'log' };
      }
      const sent = await sms.messages.create({
        from: config.TWILIO_FROM,
        to: value.destination,
        body,
      });
      return { status: 'sent', provider: 'twilio', messageId: sent.sid };
    },

    async sendPush(payload, context) {
      const value = pushSchema.parse(payload);
      const devices = await database.device.findMany({
        where: { userId: value.userId, deletedAt: null },
        select: { fcmToken: true },
      });
      if (devices.length === 0) return { status: 'suppressed', provider: 'policy' };
      if (!firebaseApp) {
        logger.info(
          { userId: value.userId, deviceCount: devices.length },
          'FCM provider is in structured-log mode',
        );
        return { status: 'sent', provider: 'log' };
      }

      for (const batch of chunks(
        devices.map((device) => device.fcmToken),
        500,
      )) {
        const message: MulticastMessage = {
          tokens: batch,
          notification: { title: value.title, body: value.body },
          ...(value.data || context
            ? {
                data: {
                  ...(value.data ?? {}),
                  ...(context ? { notificationDeliveryId: context.deliveryId } : {}),
                },
              }
            : {}),
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
      return { status: 'sent', provider: 'firebase' };
    },

    async close() {
      await emailTransport.close();
      if (firebaseApp) await deleteApp(firebaseApp);
    },
  };
}
