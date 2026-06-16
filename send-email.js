import 'dotenv/config';
import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  console.error('Missing RESEND_API_KEY. Copy .env.example to .env and set your key.');
  process.exit(1);
}

const resend = new Resend(apiKey);

const { data, error } = await resend.emails.send({
  from: 'noreply@activistresourcelibrary.com',
  to: 'samuel@apathyisboring.com',
  subject: 'Hello World',
  html: '<p>Congrats on sending your <strong>first email</strong>!</p>',
});

if (error) {
  console.error('Failed to send email:', error);
  process.exit(1);
}

console.log('Email sent:', data);
