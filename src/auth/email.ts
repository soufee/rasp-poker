import { config } from '../config/env';
import { sendAppMail } from '../mail/send';

function getApplicationUrl(): string {
  return config.appUrl.replace(/\/$/, '');
}

/**
 * Email confirmation after registration (TTL handled by Redis token).
 */
export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const link = `${getApplicationUrl()}/?verify=${encodeURIComponent(token)}`;
  const subject = 'Подтверждение email — Расписной покер';
  const text = [
    'Здравствуйте!',
    '',
    'Вы зарегистрировались в игре «Расписной покер».',
    'Подтвердите адрес электронной почты, перейдя по ссылке (действует 24 часа):',
    '',
    link,
    '',
    'После подтверждения вам будет доступна рейтинговая игра с другими людьми.',
    'Тренировка с ботами доступна и без подтверждения.',
  ].join('\n');

  await sendAppMail({ to: email, subject, text });
}

/**
 * Password recovery (TTL handled by Redis token, typically 1 hour).
 */
export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const link = `${getApplicationUrl()}/?reset=${encodeURIComponent(token)}`;
  const subject = 'Восстановление пароля — Расписной покер';
  const text = [
    'Здравствуйте!',
    '',
    'Мы получили запрос на сброс пароля для вашего аккаунта в «Расписном покере».',
    'Чтобы задать новый пароль, откройте ссылку (действует 1 час):',
    '',
    link,
    '',
    'Если вы не запрашивали сброс — просто удалите это письмо. Пароль не изменится.',
  ].join('\n');

  await sendAppMail({ to: email, subject, text });
}

/**
 * Generic transactional mail from the app (welcome, notices, etc.).
 */
export async function sendNotificationEmail(
  email: string,
  subject: string,
  body: string,
): Promise<void> {
  await sendAppMail({
    to: email,
    subject: `${subject} — Расписной покер`,
    text: body,
  });
}
