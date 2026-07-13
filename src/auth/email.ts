function getApplicationUrl(): string {
  return process.env.APP_URL || 'http://localhost:3000';
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  // Replace this stub with a transactional email provider.
  const link = `${getApplicationUrl()}/?verify=${encodeURIComponent(token)}`;
  console.log(`[EMAIL STUB] Sending verification email to ${email}`);
  console.log(`[EMAIL STUB] Token: ${token}`);
  console.log(`[EMAIL STUB] Link: ${link}`);
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const link = `${getApplicationUrl()}/?reset=${encodeURIComponent(token)}`;
  console.log(`[EMAIL STUB] Sending password reset email to ${email}`);
  console.log(`[EMAIL STUB] Token: ${token}`);
  console.log(`[EMAIL STUB] Link: ${link}`);
}
