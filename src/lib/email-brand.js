import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Apathy is Boring layout for Activist Resource Library transactional emails.
 *
 * Ringold and P22 Mackinac Pro are not loaded: email clients drop webfonts,
 * and those licences are not confirmed for email. Headlines use Inter bold
 * uppercase; body uses Inter with a Helvetica/Arial fallback.
 * Emails are English-only, so this uses the English light wordmark.
 * The French wordmark is not wired until French email copy exists.
 */

export const EMAIL_COLORS = {
  lemon: '#FFDD2A',
  lavender: '#E2A0FF',
  light: '#FAF9F7',
  plum: '#450000',
  dark: '#231F20',
  pear: '#B4C616',
  mint: '#024238',
  grape: '#473198',
};

/** One place for the office line. Override with env if the office moves. */
export const orgContact = {
  name: 'Apathy is Boring',
  tagline: 'GET INVOLVED, BECAUSE APATHY IS BORING',
  address:
    process.env.ORG_ADDRESS?.trim() ||
    '5310 Boulevard Saint-Laurent, Montréal QC H2T 1S1',
  phone: process.env.ORG_PHONE?.trim() || '514.844.2472',
  websiteUrl: 'https://www.apathyisboring.com',
  websiteLabel: 'apathyisboring.com',
};

/**
 * English light wordmark, flattened onto Mint so clients that drop PNG
 * transparency still show it. 2× (400×228), displayed at 200×114.
 * Sent inline (`cid:aisb-logo`) because the live site does not serve this file yet.
 */
export const EMAIL_LOGO = {
  path: '/assets/brand/apathy-is-boring-logo-light.png',
  width: 200,
  height: 114,
  alt: 'Apathy is Boring',
  cid: 'aisb-logo',
};

const LOGO_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../assets/brand/apathy-is-boring-logo-light.png',
);

let cachedLogoAttachment = null;

/** Inline image for Resend. Reference it as `cid:${EMAIL_LOGO.cid}`. */
export function emailLogoAttachment() {
  if (!cachedLogoAttachment) {
    cachedLogoAttachment = {
      filename: 'apathy-is-boring-logo.png',
      content: fs.readFileSync(LOGO_FILE),
      contentType: 'image/png',
      inlineContentId: EMAIL_LOGO.cid,
    };
  }
  return cachedLogoAttachment;
}

const FONT_SANS = "'Inter', Helvetica, Arial, sans-serif";
const INTER_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,700;1,400;1,700&display=swap';

const LINK_STYLE = `color:${EMAIL_COLORS.grape};font-weight:700;text-decoration:none;`;

export function emailLogoUrl() {
  return `cid:${EMAIL_LOGO.cid}`;
}

function funderLogoUrl() {
  return process.env.EMAIL_FUNDER_LOGO_URL?.trim() || '';
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(href) {
  const value = typeof href === 'string' ? href.trim() : '';
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) {
    return value;
  }
  return '';
}

function htmlWithBreaks(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * Table layout, inline CSS, bgcolor for Outlook. Returns HTML and plain text.
 *
 * @param {object} options
 * @param {string} options.subject
 * @param {string} [options.preheader]
 * @param {string} options.headline
 * @param {string} [options.intro]
 * @param {Array<[string, string, string?]>} [options.details] label, value, optional href
 * @param {string[]} [options.paragraphs]
 * @param {{ label: string, href: string }} [options.cta]
 * @param {Array<[string, string]>} [options.links]
 * @param {string} options.why Why the recipient got this email (footer; no unsubscribe on transactional mail)
 * @param {boolean} [options.funderStrip] YES Employment emails: logo strip when EMAIL_FUNDER_LOGO_URL is set
 * @param {string} [options.logoUrl] Defaults to the inline logo. Pass an http(s) URL for a browser preview.
 * @returns {{ html: string, text: string, attachments: object[] }}
 */
export function renderBrandedEmail({
  subject,
  preheader,
  headline,
  intro = '',
  details = [],
  paragraphs = [],
  cta = null,
  links = [],
  why,
  funderStrip = false,
  logoUrl = emailLogoUrl(),
}) {
  const preview = String(preheader || intro || subject || '')
    .replace(/\s+/g, ' ')
    .trim();
  const rows = details.filter(([, value]) => value);
  const bodyParagraphs = paragraphs.filter((paragraph) => paragraph && String(paragraph).trim());
  const textLinks = [];
  const ctaHref = cta ? safeHref(cta.href) : '';

  const textLines = [orgContact.tagline, '', headline, ''];
  if (intro) {
    textLines.push(intro, '');
  }
  for (const [label, value] of rows) {
    textLines.push(`${label}: ${value}`);
  }
  if (rows.length) {
    textLines.push('');
  }
  for (const paragraph of bodyParagraphs) {
    textLines.push(paragraph, '');
  }
  if (cta && ctaHref) {
    textLines.push(`${cta.label}: ${ctaHref}`, '');
  }
  for (const [label, href] of links) {
    const safe = safeHref(href);
    if (!safe || (ctaHref && safe === ctaHref)) {
      continue;
    }
    textLinks.push([label, safe]);
    textLines.push(`${label}: ${safe}`);
  }
  if (textLinks.length) {
    textLines.push('');
  }
  textLines.push(
    `${orgContact.name} · ${orgContact.address} · ${orgContact.phone} · ${orgContact.websiteLabel}`,
    why,
  );

  const detailHtml = rows
    .map(([label, value, href]) => {
      const safe = safeHref(href);
      const content = safe
        ? `<a href="${escapeHtml(safe)}" style="${LINK_STYLE}">${escapeHtml(value)}</a>`
        : htmlWithBreaks(value);
      return `<p style="margin:0 0 12px;font-family:${FONT_SANS};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.dark};"><strong>${escapeHtml(label)}</strong><br>${content}</p>`;
    })
    .join('');

  const paragraphHtml = bodyParagraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 1em;font-family:${FONT_SANS};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.dark};">${htmlWithBreaks(paragraph)}</p>`,
    )
    .join('');

  const ctaHtml =
    cta && ctaHref
      ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:20px auto;"><tr><td bgcolor="${EMAIL_COLORS.lemon}" style="background:${EMAIL_COLORS.lemon};border-radius:8px;"><a href="${escapeHtml(ctaHref)}" style="display:inline-block;padding:12px 22px;font-family:${FONT_SANS};font-size:15px;font-weight:700;line-height:1.5;text-transform:uppercase;color:${EMAIL_COLORS.dark};text-decoration:none;">${escapeHtml(cta.label)}</a></td></tr></table>`
      : '';

  const linkHtml = textLinks.length
    ? `<p style="margin:0 0 1em;font-family:${FONT_SANS};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.dark};">${textLinks
        .map(
          ([label, href]) =>
            `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${escapeHtml(label)}</a>`,
        )
        .join(' · ')}</p>`
    : '';

  const funderUrl = funderStrip ? funderLogoUrl() : '';
  const funderHtml = funderUrl
    ? `<tr><td align="center" bgcolor="${EMAIL_COLORS.light}" style="background:${EMAIL_COLORS.light};padding:4px 15px 24px;"><img src="${escapeHtml(funderUrl)}" alt="This project is funded by YES Employment." width="600" style="display:block;margin:0 auto;max-width:100%;height:auto;border:0;"></td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(subject)}</title>
<link href="${INTER_STYLESHEET}" rel="stylesheet">
<style>@media (max-width:600px){.container{width:100%!important}}</style>
</head>
<body style="margin:0;padding:0;background:${EMAIL_COLORS.light};" bgcolor="${EMAIL_COLORS.light}">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preview)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${EMAIL_COLORS.light}"><tr><td align="center">
<table role="presentation" class="container" width="700" cellpadding="0" cellspacing="0" style="max-width:700px;width:100%;">
<tr><td align="center" bgcolor="${EMAIL_COLORS.mint}" style="background:${EMAIL_COLORS.mint};padding:28px 24px 20px;">
<a href="${escapeHtml(orgContact.websiteUrl)}" style="text-decoration:none;"><img src="${escapeHtml(logoUrl)}" alt="${EMAIL_LOGO.alt}" width="${EMAIL_LOGO.width}" height="${EMAIL_LOGO.height}" style="display:block;margin:0 auto;width:${EMAIL_LOGO.width}px;height:${EMAIL_LOGO.height}px;border:0;"></a>
<p style="margin:12px 0 0;font-family:${FONT_SANS};font-size:16px;line-height:1.4;font-weight:700;text-transform:uppercase;color:${EMAIL_COLORS.light};">${escapeHtml(orgContact.tagline)}</p>
</td></tr>
<tr><td bgcolor="${EMAIL_COLORS.dark}" style="background:${EMAIL_COLORS.dark};font-size:0;line-height:0;height:2px;">&nbsp;</td></tr>
<tr><td bgcolor="${EMAIL_COLORS.light}" style="background:${EMAIL_COLORS.light};font-size:0;line-height:0;height:3px;">&nbsp;</td></tr>
<tr><td bgcolor="${EMAIL_COLORS.dark}" style="background:${EMAIL_COLORS.dark};font-size:0;line-height:0;height:2px;">&nbsp;</td></tr>
<tr><td bgcolor="${EMAIL_COLORS.light}" style="background:${EMAIL_COLORS.light};padding:24px 15px;font-family:${FONT_SANS};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.dark};text-align:left;">
<h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:21px;line-height:1.3;font-weight:700;text-transform:uppercase;color:${EMAIL_COLORS.dark};">${escapeHtml(headline)}</h1>
${intro ? `<p style="margin:0 0 1em;font-family:${FONT_SANS};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.dark};">${htmlWithBreaks(intro)}</p>` : ''}
${detailHtml}
${paragraphHtml}
${ctaHtml}
${linkHtml}
<hr style="border:0;border-top:2px dotted ${EMAIL_COLORS.dark};margin:20px 0;">
</td></tr>
${funderHtml}
<tr><td bgcolor="${EMAIL_COLORS.dark}" style="background:${EMAIL_COLORS.dark};padding:20px 15px;font-family:${FONT_SANS};font-size:13px;line-height:1.6;color:${EMAIL_COLORS.light};text-align:center;">
${escapeHtml(orgContact.name)} · ${escapeHtml(orgContact.address)} · ${escapeHtml(orgContact.phone)} · <a href="${escapeHtml(orgContact.websiteUrl)}" style="color:${EMAIL_COLORS.light};text-decoration:underline;">${escapeHtml(orgContact.websiteLabel)}</a><br>
${escapeHtml(why)}
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  return {
    html,
    text: textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    attachments: [emailLogoAttachment()],
  };
}
