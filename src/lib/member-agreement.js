import { get } from 'svelte/store';
import { locale } from './i18n.js';
import { createMarkdownRenderer } from './markdown.js';
import agreementEn from '../../content/contracts/en/member-agreement.md?raw';

const agreementsByLocale = {
  en: agreementEn,
  fr: agreementEn,
};

// Every link opens in a new tab so following one (e.g. the privacy policy)
// doesn't lose the half-filled registration form behind the modal.
const markdown = createMarkdownRenderer({ opensInNewTab: () => true });

function normalizeContractMarkdown(source) {
  return source.replace(/\+\+/g, '');
}

/** HTML body for the member agreement in the active locale (falls back to English). */
export function getMemberAgreementHtml(localeCode = get(locale)) {
  const source = agreementsByLocale[localeCode] ?? agreementsByLocale.en;
  return markdown.parse(normalizeContractMarkdown(source));
}
