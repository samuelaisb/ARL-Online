import { translateKey } from './i18n.js';

export async function sendContactMessage({ name, email, message, website = '' }) {
  const response = await fetch('/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, message, website }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || translateKey('about.contact_error'));
  }

  return result;
}
