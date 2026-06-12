import { marked } from 'marked';
import { get } from 'svelte/store';
import { locale } from './i18n.js';
import agreementEn from '../../content/contracts/en/member-agreement.md?raw';

const agreementsByLocale = {
  en: agreementEn,
  fr: agreementEn,
};

marked.use({ gfm: true, breaks: true });

function normalizeContractMarkdown(source) {
  return source.replace(/\+\+/g, '');
}

/** HTML body for the member agreement in the active locale (falls back to English). */
export function getMemberAgreementHtml(localeCode = get(locale)) {
  const source = agreementsByLocale[localeCode] ?? agreementsByLocale.en;
  return marked.parse(normalizeContractMarkdown(source));
}
