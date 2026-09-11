// Sends transactional emails (verification, password reset) via Resend's
// REST API. Uses Resend's shared test sender ('onboarding@resend.dev') so
// no domain verification is required to get started — swap FROM_EMAIL for
// your own verified domain address later if you want branded emails.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'CourtFinder <onboarding@resend.dev>';
const APP_BASE_URL = process.env.APP_BASE_URL; // e.g. https://courtfind.onrender.com

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set — email cannot be sent');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function sendVerificationEmail(toEmail, token) {
  const link = `${APP_BASE_URL}/api/auth/verify-email?token=${token}`;
  return sendEmail({
    to: toEmail,
    subject: 'Verify your CourtFinder account',
    html: `
      <p>Welcome to CourtFinder — click below to verify your email and activate your account:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours.</p>
    `,
  });
}

async function sendPasswordResetEmail(toEmail, token) {
  const link = `${APP_BASE_URL}/reset-password.html?token=${token}`;
  return sendEmail({
    to: toEmail,
    subject: 'Reset your CourtFinder password',
    html: `
      <p>Click below to reset your password:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    `,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
