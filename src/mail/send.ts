import { config } from '../config/env';
import { getMailTransporter, isMailConfigured } from './transport';

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Low-level send from the application mailbox.
 * Falls back to console when SMTP is not configured (local/dev).
 */
export async function sendAppMail(input: SendMailInput): Promise<{ mode: 'smtp' | 'console' }> {
  const from = config.smtp.from || config.smtp.user || 'noreply@localhost';

  if (!isMailConfigured()) {
    console.log('[mail:console] ────────────────────────────────');
    console.log(`[mail:console] From: ${from}`);
    console.log(`[mail:console] To: ${input.to}`);
    console.log(`[mail:console] Subject: ${input.subject}`);
    console.log(`[mail:console] ${input.text}`);
    console.log('[mail:console] ────────────────────────────────');
    return { mode: 'console' };
  }

  const transport = getMailTransporter();
  if (!transport) {
    throw new Error('Mail transport unavailable');
  }

  await transport.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html ?? wrapHtml(input.subject, input.text),
  });

  if (config.smtp.debug) {
    console.log(`[mail] sent to ${input.to}: ${input.subject}`);
  }

  return { mode: 'smtp' };
}

function wrapHtml(title: string, bodyText: string): string {
  const paragraphs = bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith('http://') || line.startsWith('https://')) {
        return `<p><a href="${escapeHtml(line)}" style="color:#1a73e8;word-break:break-all;">${escapeHtml(line)}</a></p>`;
      }
      return `<p style="margin:0 0 12px;line-height:1.5;">${escapeHtml(line)}</p>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#0f1419;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f1419;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#1a2332;border-radius:12px;padding:28px 24px;color:#e8eef7;">
        <tr><td>
          <div style="font-size:20px;font-weight:700;margin-bottom:8px;">♠ Расписной покер</div>
          <div style="font-size:12px;color:#8b9bb4;margin-bottom:20px;">${escapeHtml(title)}</div>
          ${paragraphs}
          <hr style="border:none;border-top:1px solid #2a3548;margin:24px 0;"/>
          <p style="margin:0;font-size:12px;color:#6b7a90;">Это автоматическое письмо. Если вы не запрашивали действие — просто проигнорируйте его.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
