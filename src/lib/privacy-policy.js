import { get } from 'svelte/store';
import { locale } from './i18n.js';
import { createMarkdownRenderer } from './markdown.js';
import policyEn from '../../content/policies/en/privacy-policy.md?raw';
import policyFr from '../../content/policies/fr/privacy-policy.md?raw';

const policiesByLocale = {
  en: policyEn,
  fr: policyFr,
};

const markdown = createMarkdownRenderer();

/** HTML body for the privacy policy in the active locale (falls back to English). */
export function getPrivacyPolicyHtml(localeCode = get(locale)) {
  const source = policiesByLocale[localeCode] ?? policiesByLocale.en;
  return markdown.parse(source);
}
