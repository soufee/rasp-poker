export async function sendVerificationEmail(email: string, token: string) {
  // Заглушка: в реальном приложении здесь будет интеграция с SendGrid/AWS SES/Nodemailer
  console.log(`[EMAIL STUB] Sending verification email to ${email}`);
  console.log(`[EMAIL STUB] Token: ${token}`);
  console.log(`[EMAIL STUB] Link: http://localhost:3000/auth/verify?token=${token}`);
}

export async function sendPasswordResetEmail(email: string, token: string) {
  console.log(`[EMAIL STUB] Sending password reset email to ${email}`);
  console.log(`[EMAIL STUB] Token: ${token}`);
  console.log(`[EMAIL STUB] Link: http://localhost:3000/auth/reset-password?token=${token}`);
}
