import { derived, get, writable } from 'svelte/store';
import en from '../../locales/en.json';
import fr from '../../locales/fr.json';

const STORAGE_KEY = 'arl-locale';
const dictionaries = { en, fr };

function resolveInitialLocale() {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryLang = params.get('lang');
    if (queryLang === 'en' || queryLang === 'fr') {
      return queryLang;
    }
  }

  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'fr') {
      return stored;
    }
  }

  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr')) {
    return 'fr';
  }

  return 'en';
}

function lookup(dict, key) {
  const parts = key.split('.');
  let value = dict;

  for (const part of parts) {
    if (value == null || typeof value !== 'object') {
      return undefined;
    }
    value = value[part];
  }

  return value;
}

function interpolate(template, vars) {
  if (typeof template !== 'string') {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`
  );
}

function translate(localeCode, key, vars = {}) {
  const dict = dictionaries[localeCode] ?? dictionaries.en;
  let value = lookup(dict, key);

  if (value === undefined) {
    value = lookup(dictionaries.en, key) ?? key;
  }

  if (typeof value !== 'string') {
    return value;
  }

  return interpolate(value, vars);
}

export const locale = writable(resolveInitialLocale());

locale.subscribe((code) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code;
  }

  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // private browsing or storage disabled
  }
});

/** Reactive translate function — use as `$t('domain.key')` in templates. */
export const t = derived(locale, ($locale) => {
  return (key, vars = {}) => translate($locale, key, vars);
});

/** Non-reactive translate for scripts and API clients. */
export function translateKey(key, vars = {}) {
  return translate(get(locale), key, vars);
}

/** Quote list for the current locale (reactive via `$quotes`). */
export const quotes = derived(locale, ($locale) => {
  const items = lookup(dictionaries[$locale], 'quotes.items');
  if (Array.isArray(items)) {
    return items;
  }

  return lookup(dictionaries.en, 'quotes.items') ?? [];
});

/** FAQ list for the current locale (reactive via `$faq`). */
export const faq = derived(locale, ($locale) => {
  const items = lookup(dictionaries[$locale], 'how_this_works.faq');
  if (Array.isArray(items)) {
    return items;
  }

  return lookup(dictionaries.en, 'how_this_works.faq') ?? [];
});
