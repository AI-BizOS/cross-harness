import { STRINGS, translate } from './strings.js';

let current = 'en';

/** zh for Chinese locales or an explicit choice, else en. */
export function pickLang(explicit = null, env = process.env) {
  const wanted = String(explicit || env.TROUPE_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase();
  return wanted.startsWith('zh') ? 'zh' : 'en';
}

export function setLang(lang) {
  current = STRINGS[lang] ? lang : 'en';
  return current;
}

export function getLang() {
  return current;
}

export function t(key, params) {
  return translate(current, key, params);
}
