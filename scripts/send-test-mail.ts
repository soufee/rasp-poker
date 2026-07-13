/**
 * Manual SMTP check:
 *   SMTP_PASSWORD=... npx tsx scripts/send-test-mail.ts you@example.com
 */
import { config, validateConfig } from '../src/config/env';
import { verifyMailTransport, isMailConfigured } from '../src/mail/transport';
import { sendAppMail } from '../src/mail/send';

async function main(): Promise<void> {
  validateConfig();
  const to = process.argv[2] || config.smtp.user;
  if (!to) {
    console.error('Usage: npx tsx scripts/send-test-mail.ts <email>');
    process.exit(1);
  }

  console.log('SMTP configured:', isMailConfigured());
  await verifyMailTransport();

  const result = await sendAppMail({
    to,
    subject: 'Тест SMTP — Расписной покер',
    text: [
      'Это тестовое письмо от rasp-poker.',
      `Время: ${new Date().toISOString()}`,
      `APP_ENV: ${config.appEnv}`,
      `SMTP host: ${config.smtp.host}:${config.smtp.port}`,
    ].join('\n'),
  });

  console.log('Send result:', result);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
