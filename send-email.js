import 'dotenv/config';
import { Resend } from 'resend';
import { renderBrandedEmail } from './src/lib/email-brand.js';

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  console.error('Missing RESEND_API_KEY. Copy .env.example to .env and set your key.');
  process.exit(1);
}

const resend = new Resend(apiKey);
const subject = 'Activist Resource Library email check';
const { html, text, attachments } = renderBrandedEmail({
  subject,
  preheader: 'Apathy is Boring transactional email check.',
  headline: 'Email check',
  intro: 'This is a branded smoke test from the Activist Resource Library.',
  paragraphs: ['If the header, button, and footer look like Apathy is Boring, the template is working.'],
  cta: { label: 'Visit the library', href: 'https://activistresourcelibrary.com' },
  why: 'You are receiving this because someone ran the email smoke test.',
});

const { data, error } = await resend.emails.send({
  from: 'noreply@activistresourcelibrary.com',
  replyTo: process.env.EMAIL_REPLY_TO?.trim() || 'samuel@apathyisboring.com',
  to: 'samuel@apathyisboring.com',
  subject,
  html,
  text,
  attachments,
});

if (error) {
  console.error('Failed to send email:', error);
  process.exit(1);
}

console.log('Email sent:', data);
