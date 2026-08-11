import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { Env } from '#app/config/env.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  deliveryId?: string;
}

export interface EmailTransport {
  readonly provider: string;
  send(message: EmailMessage): Promise<{ messageId?: string }>;
  close(): Promise<void>;
}

/**
 * The swap point for a client that wants SES, Resend, or Postmark instead of SMTP: implement this
 * interface against the provider's API and select it in createNotificationProviders based on an
 * env flag. Message construction (templates/index.ts) never changes when the transport does.
 */
export function createSmtpEmailTransport(config: Env): EmailTransport {
  const transport: Transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });

  return {
    provider: 'smtp',
    async send(message) {
      const result: unknown = await transport.sendMail({
        from: config.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
        ...(message.deliveryId
          ? { messageId: `<${message.deliveryId}@backend-notifications.local>` }
          : {}),
      });
      if (
        typeof result === 'object' &&
        result !== null &&
        'messageId' in result &&
        typeof result.messageId === 'string'
      ) {
        return { messageId: result.messageId };
      }
      return {};
    },
    async close() {
      transport.close();
    },
  };
}

/** Selected when SMTP is unconfigured, so local development never depends on a real mailbox. */
export function createLogEmailTransport(logger: Pick<Logger, 'info'>): EmailTransport {
  return {
    provider: 'log',
    async send(message) {
      logger.info(
        { to: message.to, subject: message.subject, deliveryId: message.deliveryId },
        'Email provider is in structured-log mode',
      );
      return message.deliveryId ? { messageId: `log:${message.deliveryId}` } : {};
    },
    async close() {},
  };
}
