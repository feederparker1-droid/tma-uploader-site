// Tests for game/js/i18n.js
// Run: node tests/i18n.test.mjs
//
// The module is a classic browser script, so the Node part loads it into a `vm`
// sandbox with a tiny window/document/navigator shim. Browser-only behaviour
// (<html lang/dir>, the 'g:lang' CustomEvent, data-i18n markup) runs in headless
// Chromium via Playwright at the end.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(here, '../game/js/i18n.js');
const source = fs.readFileSync(MODULE_PATH, 'utf8');

// Keys the game renders inside buttons/chips; they must stay ≤ 20 characters
// (counted in code points) in every language so layouts never overflow.
const BUTTON_KEYS = [
  'play', 'continue', 'watchAdToContinue', 'continueFree', 'skipAd', 'retry', 'home',
  'pause', 'resume', 'settings', 'share', 'claim', 'equip', 'equipped', 'close', 'back',
  'yes', 'no', 'ok', 'cancel', 'noThanks', 'playAgain', 'challengeFriend', 'rate', 'more',
  'on', 'off', 'howToPlay', 'missions', 'daily', 'copied', 'unlocked'
];
const BUTTON_MAX = 20;

// Minimum key set demanded by CONTRACT-SHARED.md.
const REQUIRED_KEYS = [
  'play', 'tapToStart', 'tapOrSpace', 'gameOver', 'score', 'best', 'newBest', 'continue',
  'watchAdToContinue', 'continueFree', 'skipAd', 'retry', 'home', 'pause', 'resume',
  'settings', 'sound', 'music', 'haptics', 'language', 'on', 'off', 'share', 'shareText',
  'copied', 'linkCopied', 'challengeFriend', 'daily', 'dailyChallenge', 'dailyDone',
  'dailyRank', 'streak', 'missions', 'missionDone', 'claim', 'coins', 'skins', 'themes',
  'locked', 'unlocked', 'unlockFor', 'equip', 'equipped', 'howToPlay', 'loading',
  'adNotAvailable', 'adLoading', 'rewardGranted', 'noThanks', 'close', 'back', 'yes', 'no',
  'ok', 'cancel', 'comingSoon', 'support', 'rate', 'more', 'beatYourBest', 'playAgain',
  'newRecord', 'combo', 'perfect', 'great', 'good', 'miss', 'level', 'round', 'time',
  'highscores', 'you', 'friend', 'seedLabel', 'version'
];

const REQUIRED_LANGS = ['en', 'tr', 'ru', 'es', 'pt', 'de', 'fr', 'id', 'hi'];

let passed = 0;
const warnings = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}`);
    throw err;
  }
}

/**
 * Load the module into a fresh sandbox.
 * @param {{search?: string, languages?: string[], storage?: object, sdk?: object, G?: object}} [env]
 */
function load(env = {}) {
  const htmlAttrs = {};
  const events = [];
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: console.error },
    Intl,
    location: { search: env.search ?? '' },
    navigator: { languages: env.languages ?? ['en-US'], language: (env.languages ?? ['en-US'])[0] },
    document: {
      documentElement: { setAttribute: (k, v) => { htmlAttrs[k] = v; } }
    },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent: (ev) => { events.push(ev); return true; }
  };
  sandbox.window = sandbox;
  sandbox.G = { ...(env.G ?? {}) };
  if (env.storage) sandbox.G.storage = env.storage;
  if (env.sdk) sandbox.G.sdk = env.sdk;
  vm.runInNewContext(source, sandbox, { filename: 'i18n.js' });
  return { G: sandbox.G, i18n: sandbox.G.i18n, htmlAttrs, events, logs, sandbox };
}

/** Strip vm-realm prototypes so deepEqual compares structure, not Array/Object identity. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function placeholders(str) {
  return [...str.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  const calls = [];
  return {
    data,
    calls,
    get: (k, fb) => (k in data ? data[k] : fb),
    set: (k, v) => { data[k] = v; calls.push([k, v]); }
  };
}

// ---------------------------------------------------------------------------
// Node tests
// ---------------------------------------------------------------------------
console.log('# i18n (node/vm)');

const base = load();
const { STRINGS } = base.i18n;
const EN_KEYS = Object.keys(STRINGS.en).sort();

test('module attaches G.i18n with the public surface', () => {
  for (const fn of ['init', 't', 'has', 'setLang', 'detect', 'dir', 'nativeName', 'fmtNumber', 'apply']) {
    assert.equal(typeof base.i18n[fn], 'function', `G.i18n.${fn} should be a function`);
  }
  assert.equal(typeof base.G.log, 'function');
  assert.equal(base.G.DEBUG, false);
});

test('required languages are present and ar is RTL', () => {
  for (const lang of REQUIRED_LANGS) assert.ok(STRINGS[lang], `missing language ${lang}`);
  assert.deepEqual(plain(base.i18n.available).slice(0, 9), REQUIRED_LANGS);
  assert.ok(STRINGS.ar, 'ar table present');
  assert.equal(base.i18n.dir('ar'), 'rtl');
  assert.equal(base.i18n.dir('en'), 'ltr');
});

test('en covers every required key', () => {
  const missing = REQUIRED_KEYS.filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});

test('every language has exactly the same key set as en', () => {
  for (const lang of Object.keys(STRINGS)) {
    const keys = Object.keys(STRINGS[lang]).sort();
    const extra = keys.filter((k) => !EN_KEYS.includes(k));
    const missing = EN_KEYS.filter((k) => !keys.includes(k));
    assert.deepEqual({ lang, extra, missing }, { lang, extra: [], missing: [] });
  }
});

test('no empty, non-string or untrimmed values', () => {
  for (const lang of Object.keys(STRINGS)) {
    for (const [k, v] of Object.entries(STRINGS[lang])) {
      assert.equal(typeof v, 'string', `${lang}.${k} must be a string`);
      assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
      assert.equal(v, v.trim(), `${lang}.${k} has stray whitespace`);
    }
  }
});

test('placeholders are preserved in every language', () => {
  assert.deepEqual(placeholders(STRINGS.en.shareText), ['score', 'url']);
  assert.deepEqual(placeholders(STRINGS.en.unlockFor), ['cost']);
  for (const lang of Object.keys(STRINGS)) {
    for (const k of EN_KEYS) {
      assert.deepEqual(
        placeholders(STRINGS[lang][k]),
        placeholders(STRINGS.en[k]),
        `${lang}.${k} placeholder mismatch`
      );
    }
  }
});

test('button-ish keys are ≤ 20 characters in every language', () => {
  const violations = [];
  for (const lang of Object.keys(STRINGS)) {
    for (const k of BUTTON_KEYS) {
      const len = [...STRINGS[lang][k]].length;
      if (len > 14) warnings.push(`${lang}.${k} is ${len} chars: "${STRINGS[lang][k]}"`);
      if (len > BUTTON_MAX) violations.push(`${lang}.${k} (${len})`);
    }
  }
  for (const w of warnings) console.log(`warn ${w}`);
  assert.deepEqual(violations, []);
});

test('nativeName returns endonyms for every available language', () => {
  for (const code of base.i18n.available) {
    const name = base.i18n.nativeName(code);
    assert.ok(name && name !== code, `${code} needs a native name`);
  }
  assert.equal(base.i18n.nativeName('tr'), 'Türkçe');
  assert.equal(base.i18n.nativeName('xx'), 'xx');
});

test('t() returns current-language text and fills placeholders', () => {
  const { i18n } = load({ languages: ['tr-TR'] });
  i18n.init();
  assert.equal(i18n.lang, 'tr');
  assert.equal(i18n.t('play'), 'Oyna');
  assert.equal(
    i18n.t('shareText', { score: 1200, url: 'https://x.y/g' }),
    '1200 puan yaptım, sen geçebilir misin? https://x.y/g'
  );
  assert.equal(i18n.t('unlockFor', { cost: 50 }), '50 ile kilidi aç');
});

test('t() fallback: missing var stays visible, unknown key returns the key and warns', () => {
  const ctx = load({ G: { DEBUG: true } });
  ctx.i18n.init({ lang: 'de' });
  assert.equal(ctx.i18n.t('unlockFor', {}), 'Für {cost} freischalten');
  assert.equal(ctx.i18n.t('unlockFor', { cost: null }), 'Für {cost} freischalten');
  const before = ctx.logs.length;
  assert.equal(ctx.i18n.t('definitelyNotAKey'), 'definitelyNotAKey');
  assert.ok(ctx.logs.length > before, 'G.log should have warned about the missing key');
  assert.ok(ctx.logs.at(-1).join(' ').includes('definitelyNotAKey'));
  assert.equal(ctx.i18n.has('play'), true);
  assert.equal(ctx.i18n.has('definitelyNotAKey'), false);
});

test('t() falls back to English when a key is missing in the active language', () => {
  const ctx = load();
  ctx.i18n.init({ lang: 'fr' });
  ctx.i18n.STRINGS.en.__probe = 'probe-en';
  assert.equal(ctx.i18n.t('__probe'), 'probe-en');
  delete ctx.i18n.STRINGS.en.__probe;
});

test('detect(): first supported entry from a fake navigator.languages list', () => {
  const { i18n } = load();
  assert.equal(i18n.detect(['zh-CN', 'ja', 'pt-BR', 'en']), 'pt');
  assert.equal(i18n.detect(['ES-419']), 'es');
  assert.equal(i18n.detect(['in-ID']), 'id', 'legacy "in" subtag maps to id');
  assert.equal(i18n.detect(['zh-CN', 'ja']), 'en', 'nothing supported → en');
  assert.equal(i18n.detect([]), 'en');
  assert.equal(i18n.detect(null), 'en');
});

test('init(): picks from navigator.languages when nothing else is set', () => {
  const ctx = load({ languages: ['ko-KR', 'ru-RU', 'en-US'] });
  assert.equal(ctx.i18n.init(), 'ru');
  assert.equal(ctx.i18n.lang, 'ru');
  assert.equal(ctx.htmlAttrs.lang, 'ru');
  assert.equal(ctx.htmlAttrs.dir, 'ltr');
});

test('init(): falls back to navigator.language when languages[] is empty', () => {
  const ctx = load();
  ctx.sandbox.navigator = { languages: [], language: 'hi-IN' };
  assert.equal(ctx.i18n.init(), 'hi');
});

test('init(): precedence opts.lang > ?lang= > stored > sdk user > navigator', () => {
  const storage = memoryStorage({ lang: 'fr' });
  const sdk = { user: { lang: 'id' } };
  const nav = ['de-DE'];

  assert.equal(load({ search: '?lang=es', languages: nav, storage, sdk }).i18n.init({ lang: 'tr' }), 'tr');
  assert.equal(load({ search: '?x=1&lang=es&debug=1', languages: nav, storage, sdk }).i18n.init(), 'es');
  assert.equal(load({ languages: nav, storage, sdk }).i18n.init(), 'fr');
  assert.equal(load({ languages: nav, sdk }).i18n.init(), 'id');
  assert.equal(load({ languages: nav }).i18n.init(), 'de');
  assert.equal(load({ search: '?lang=klingon', languages: nav }).i18n.init(), 'de', 'unsupported ?lang= is ignored');
});

test('init(): an unsupported candidate falls through to the next source, not straight to navigator', () => {
  const sdk = { user: { lang: 'tr' } };
  assert.equal(load({ search: '?lang=klingon', languages: ['de-DE'], sdk }).i18n.init(), 'tr');
  assert.equal(load({ search: '?lang=klingon', languages: ['de-DE'], sdk }).i18n.init({ lang: 'xx' }), 'tr');
  const storage = memoryStorage({ lang: 'fr' });
  assert.equal(load({ languages: ['de-DE'], storage, sdk: { user: { lang: 'zz' } } }).i18n.init(), 'fr');
  assert.equal(load({ languages: ['de-DE'], storage: memoryStorage({ lang: { v: 'tr' } }), sdk }).i18n.init(), 'tr', 'non-string stored value is ignored');
  assert.equal(load({ languages: ['de-DE'] }).i18n.init({ lang: 42 }), 'de');
});

test('init(): survives a throwing G.sdk.user getter and a missing document', () => {
  const ctx = load({ languages: ['ru-RU'], sdk: { get user() { throw new Error('boom'); } } });
  assert.equal(ctx.i18n.init(), 'ru');
  ctx.sandbox.document = undefined;
  assert.equal(ctx.i18n.init({ lang: 'tr' }), 'tr');
  assert.equal(ctx.i18n.setLang('de'), 'de');
  assert.equal(ctx.i18n.apply(), undefined);
});

test('Object.prototype names are never treated as keys or languages', () => {
  const { i18n } = load();
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(i18n.t(bad), bad);
    assert.equal(i18n.t(bad, { x: 1 }), bad);
    assert.equal(i18n.has(bad), false);
    assert.equal(i18n.nativeName(bad), bad);
    assert.equal(i18n.dir(bad), 'ltr');
    assert.equal(i18n.setLang(bad), 'en');
    assert.equal(i18n.detect([bad]), 'en');
  }
  assert.equal(i18n.t(), 'undefined');
  assert.equal(i18n.t(123), '123');
  assert.equal(i18n.t('unlockFor', 'not-an-object'), 'Unlock for {cost}');
  assert.equal(i18n.t('unlockFor', Object.create({ cost: 5 })), 'Unlock for 5');
});

test('init(): survives a broken storage module', () => {
  const storage = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('blocked'); } };
  const ctx = load({ languages: ['pt-PT'], storage });
  assert.equal(ctx.i18n.init(), 'pt');
  assert.equal(ctx.i18n.setLang('tr'), 'tr', 'setLang still works when persist throws');
});

test('setLang(): persists, updates <html>, dispatches g:lang; rejects unknown codes', () => {
  const storage = memoryStorage();
  const ctx = load({ storage });
  ctx.i18n.init();
  assert.equal(ctx.i18n.setLang('ar'), 'ar');
  assert.equal(ctx.i18n.lang, 'ar');
  assert.equal(ctx.i18n.isRtl, true);
  assert.deepEqual(plain(storage.calls), [['lang', 'ar']]);
  assert.equal(ctx.htmlAttrs.lang, 'ar');
  assert.equal(ctx.htmlAttrs.dir, 'rtl');
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].type, 'g:lang');
  assert.deepEqual(plain(ctx.events[0].detail), { lang: 'ar', dir: 'rtl' });

  assert.equal(ctx.i18n.setLang('xx'), 'ar', 'unknown code keeps current language');
  assert.equal(ctx.events.length, 1, 'no event for a rejected code');
  assert.equal(storage.calls.length, 1);

  assert.equal(ctx.i18n.setLang('EN-gb'), 'en', 'region/case are normalised');
  assert.equal(ctx.htmlAttrs.dir, 'ltr');
});

test('available is a fresh copy and lang is read-only', () => {
  const { i18n } = load();
  const a = i18n.available;
  a.push('zz');
  assert.ok(!i18n.available.includes('zz'));
  assert.throws(() => { 'use strict'; i18n.lang = 'tr'; }, TypeError);
});

test('fmtNumber(): locale grouping with Latin digits everywhere', () => {
  const { i18n } = load();
  i18n.init({ lang: 'en' });
  assert.equal(i18n.fmtNumber(1234567), '1,234,567');
  i18n.setLang('tr');
  assert.equal(i18n.fmtNumber(1234567), '1.234.567');
  i18n.setLang('de');
  assert.equal(i18n.fmtNumber(-9876543.6), '-9.876.544');
  i18n.setLang('hi');
  assert.equal(i18n.fmtNumber(1234567), '12,34,567');
  i18n.setLang('ar');
  assert.match(i18n.fmtNumber(1234567), /^1[,٬]234[,٬]567$/);
  assert.equal(i18n.fmtNumber(NaN), '0');
  assert.equal(i18n.fmtNumber('42'), '42');
  assert.equal(i18n.fmtNumber(-0), '0');
  assert.equal(i18n.fmtNumber(-0.4), '0');
  assert.equal(i18n.fmtNumber(Infinity), '0');
  assert.equal(i18n.fmtNumber(null), '0');
  assert.equal(i18n.fmtNumber(undefined), '0');
  assert.equal(i18n.fmtNumber(12n), '12');
  i18n.setLang('en');
  assert.equal(i18n.fmtNumber(Number.MAX_SAFE_INTEGER), '9,007,199,254,740,991');
  assert.equal(i18n.fmtNumber(1e21), '1,000,000,000,000,000,000,000');
});

test('fmtNumber(): falls back to manual grouping without Intl', () => {
  const ctx = load();
  ctx.sandbox.Intl = undefined;
  ctx.i18n.init({ lang: 'en' });
  assert.equal(ctx.i18n.fmtNumber(1234567), '1,234,567');
  assert.equal(ctx.i18n.fmtNumber(-1000), '-1,000');
  assert.equal(ctx.i18n.fmtNumber(999), '999');
  assert.equal(ctx.i18n.fmtNumber(-0), '0');
  assert.equal(ctx.i18n.fmtNumber(1e21), '1,000,000,000,000,000,000,000', 'no exponent form for huge values');
  assert.equal(ctx.i18n.fmtNumber(-1e21), '-1,000,000,000,000,000,000,000');
  ctx.i18n.setLang('tr');
  assert.equal(ctx.i18n.fmtNumber(1234567), '1,234,567', 'fallback grouping is used for every language');
});

test('setLang(): falls back to document.createEvent when CustomEvent is not a constructor', () => {
  const ctx = load();
  ctx.sandbox.CustomEvent = {};
  let created = null;
  ctx.sandbox.document.createEvent = (type) => {
    created = { type, initCustomEvent(name, bubbles, cancelable, detail) { this.name = name; this.detail = detail; } };
    return created;
  };
  assert.equal(ctx.i18n.setLang('fr'), 'fr');
  assert.equal(created.type, 'CustomEvent');
  assert.equal(created.name, 'g:lang');
  assert.deepEqual(plain(created.detail), { lang: 'fr', dir: 'ltr' });
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0], created);

  ctx.sandbox.document = undefined;
  assert.equal(ctx.i18n.setLang('de'), 'de', 'no event sink at all is still safe');
  assert.equal(ctx.events.length, 1);
});

test('rapid repeated setLang/init calls stay consistent and emit one event per call', () => {
  const storage = memoryStorage();
  const ctx = load({ storage });
  const codes = ['tr', 'ar', 'en', 'hi', 'ar', 'tr', 'tr'];
  for (const code of codes) assert.equal(ctx.i18n.setLang(code), code);
  assert.equal(ctx.events.length, codes.length);
  assert.equal(ctx.i18n.lang, 'tr');
  assert.equal(ctx.htmlAttrs.dir, 'ltr');
  assert.equal(storage.data.lang, 'tr');
  assert.equal(ctx.i18n.init(), 'tr', 'init re-reads the persisted choice');
  assert.equal(ctx.i18n.init(), 'tr', 'double init is idempotent');
  assert.equal(ctx.events.length, codes.length, 'init does not emit g:lang');
});

test('module adds nothing to window except G', () => {
  const ctx = load();
  const before = new Set(Object.keys(load().sandbox));
  const extra = Object.keys(ctx.sandbox).filter((k) => !before.has(k));
  assert.deepEqual(extra, []);
  assert.deepEqual(Object.keys(ctx.G).sort(), ['DEBUG', 'i18n', 'log']);
  assert.ok(!/^\s*(import|export)\b/m.test(source), 'must stay a classic script');
  assert.ok(/'use strict'/.test(source));
  assert.ok(!/\bfetch\(|XMLHttpRequest|<script/.test(source), 'zero network');
  assert.ok(!/console\.(log|warn|error|info|debug)\(/.test(source.replace(/G\.log = G\.log \|\|[^\n]*/, '')), 'console only via G.log');
});

test('DEBUG flag is derived from ?debug=1 and kept when already set', () => {
  assert.equal(load({ search: '?debug=1' }).G.DEBUG, true);
  assert.equal(load({ search: '?debug=0' }).G.DEBUG, false);
  assert.equal(load({ G: { DEBUG: true } }).G.DEBUG, true);
});

// ---------------------------------------------------------------------------
// Browser tests (Playwright / headless Chromium)
// ---------------------------------------------------------------------------
console.log('# i18n (chromium)');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <h1 data-i18n="gameOver"></h1>
    <button id="b" data-i18n="play" data-i18n-title="close"></button>
    <span id="s" data-i18n="shareText"></span>
  </body></html>`);
  await page.addScriptTag({ path: MODULE_PATH });

  const result = await page.evaluate(() => {
    const out = {};
    const events = [];
    window.addEventListener('g:lang', (e) => events.push(e.detail));
    window.G.storage = { data: {}, get(k, fb) { return k in this.data ? this.data[k] : fb; }, set(k, v) { this.data[k] = v; } };

    out.initLang = G.i18n.init({ lang: 'tr' });
    out.htmlLang = document.documentElement.lang;
    out.htmlDir = document.documentElement.dir;
    G.i18n.apply();
    out.h1 = document.querySelector('h1').textContent;
    out.btn = document.getElementById('b').textContent;
    out.btnTitle = document.getElementById('b').title;
    out.btnAria = document.getElementById('b').getAttribute('aria-label');
    out.span = document.getElementById('s').textContent;

    G.i18n.setLang('ar');
    G.i18n.apply(document.body);
    out.arDir = document.documentElement.dir;
    out.arLang = document.documentElement.lang;
    out.arH1 = document.querySelector('h1').textContent;
    out.stored = G.storage.data.lang;
    out.events = events;
    out.fmt = G.i18n.fmtNumber(1234567);
    return out;
  });

  test('browser: init sets <html lang/dir>', () => {
    assert.equal(result.initLang, 'tr');
    assert.equal(result.htmlLang, 'tr');
    assert.equal(result.htmlDir, 'ltr');
  });

  test('browser: apply() translates data-i18n and data-i18n-title markup', () => {
    assert.equal(result.h1, 'Oyun Bitti');
    assert.equal(result.btn, 'Oyna');
    assert.equal(result.btnTitle, 'Kapat');
    assert.equal(result.btnAria, 'Kapat');
    assert.equal(result.span, STRINGS.tr.shareText, 'placeholders stay visible when no vars are given');
  });

  test('browser: setLang → rtl, persisted, real CustomEvent delivered', () => {
    assert.equal(result.arLang, 'ar');
    assert.equal(result.arDir, 'rtl');
    assert.equal(result.arH1, 'انتهت اللعبة');
    assert.equal(result.stored, 'ar');
    assert.deepEqual(result.events, [{ lang: 'ar', dir: 'rtl' }]);
    assert.match(result.fmt, /^1[,٬]234[,٬]567$/);
  });

  // A real browser's navigator.languages drives detection when nothing else is set.
  const ctx = await browser.newContext({ locale: 'pt-BR' });
  const p2 = await ctx.newPage();
  await p2.setContent('<!doctype html><html><body></body></html>');
  await p2.addScriptTag({ path: MODULE_PATH });
  const detected = await p2.evaluate(() => ({ langs: navigator.languages, picked: G.i18n.init() }));
  test('browser: init() follows navigator.languages (pt-BR → pt)', () => {
    assert.ok(detected.langs.some((l) => /^pt/i.test(l)), `expected pt in ${detected.langs}`);
    assert.equal(detected.picked, 'pt');
  });
  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\n${passed} tests passed, ${warnings.length} length warning(s) (labels > 14 chars, all ≤ ${BUTTON_MAX})`);
