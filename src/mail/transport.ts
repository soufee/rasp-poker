import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';

let transporter: Transporter | null = null;

export function isMailConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.password);
}

export function getMailTransporter(): Transporter | null {
  if (!isMailConfigured()) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure, // true for 465 SMTPS
      auth: {
        user: config.smtp.user,
        pass: config.smtp.password,
      },
      logger: config.smtp.debug,
      debug: config.smtp.debug,
    });
  }

  return transporter;
}

/** Verify SMTP credentials (call on boot when configured). */
export async function verifyMailTransport(): Promise<boolean> {
  const transport = getMailTransporter();
  if (!transport) {
    console.log('[mail] SMTP not configured — emails will be logged to console only');
    return false;
  }

  try {
    await transport.verify();
    console.log(
      `[mail] SMTP ready (${config.smtp.host}:${config.smtp.port}) as ${config.smtp.user}`,
    );
    return true;
  } catch (err) {
    console.error('[mail] SMTP verify failed:', err instanceof Error ? err.message : err);
    if (config.isProduction) {
      throw new Error('SMTP is required in production but verification failed');
    }
    return false;
  }
}
