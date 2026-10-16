// Tiny translation layer. English is the source language and doubles as the key:
//   t('Start ride')                      -> 'Iniciar paseo' in Spanish, unchanged in English
//   t('Level {n}', { n: 3 })             -> 'Nivel 3'
// A string with no Spanish entry falls back to English, so a missed key is never blank.
// Static text in index.html is translated in place by applyDom(); text written by JS goes through t().

import { ES } from './lang/es.js';

export const LANGS = { en: 'English', es: 'Español' };
const DICT = { es: ES };
const KEY = 'spinquest.lang';

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved in LANGS) return saved;
  } catch { /* private mode */ }
  const nav = typeof navigator !== 'undefined' ? (navigator.language || '') : '';
  return nav.toLowerCase().startsWith('es') ? 'es' : 'en';
}

let lang = detect();
const listeners = new Set();

export const getLang = () => lang;

/** The language's own number formatting (1,234 vs 1.234). */
export const locale = () => (lang === 'es' ? 'es-ES' : 'en-US');

export function t(key, params) {
  let s = DICT[lang]?.[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}

export function setLang(next) {
  if (!(next in LANGS) || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
  if (typeof document !== 'undefined') { document.documentElement.lang = lang; applyDom(); }
  listeners.forEach((fn) => fn(lang));
}

/** Run `fn` whenever the language changes (after the static page has been re-translated). */
export const onLangChange = (fn) => { listeners.add(fn); };

// ---- static page text ---------------------------------------------------------------------------
// Each text node / attribute remembers its original English, so switching back and forth never drifts.

const ATTRS = ['title', 'placeholder', 'aria-label'];
const original = new WeakMap(); // node or element -> English source
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function textNodes(root) {
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !['SCRIPT', 'STYLE'].includes(n.parentElement.tagName) && norm(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  while (walk.nextNode()) out.push(walk.currentNode);
  return out;
}

export function applyDom(root = document.body) {
  for (const n of textNodes(root)) {
    if (n.parentElement.closest('[data-no-i18n]')) continue;
    let src = original.get(n);
    if (src === undefined) { src = n.nodeValue; original.set(n, src); }
    const key = norm(src);
    const out = t(key);
    // keep the original leading/trailing space so inline text still sits against its neighbours
    n.nodeValue = out === key ? src : (/^\s/.test(src) ? ' ' : '') + out + (/\s$/.test(src) ? ' ' : '');
  }
  for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const mark = `i18n-${a}`;
      if (!el.hasAttribute(`data-${mark}`)) el.setAttribute(`data-${mark}`, el.getAttribute(a));
      const src = el.getAttribute(`data-${mark}`);
      el.setAttribute(a, t(norm(src)));
    }
  }
}
