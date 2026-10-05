// Tests for game/js/meta.js
// Run: node tests/meta.test.mjs
//
// The module is a classic browser script, so it is evaluated inside a vm
// sandbox with a tiny window/localStorage shim and a controllable UTC clock,
// after the real storage.js, i18n.js and config.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const JS = (name) => path.resolve(here, '../game/js', name);
const SOURCES = ['storage.js', 'i18n.js', 'config.js', 'meta.js'].map((f) => [f, fs.readFileSync(JS(f), 'utf8')]);
const META_SOURCE = fs.readFileSync(JS('meta.js'), 'utf8');

let passed = 0;
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

/* ------------------------------------------------------------------ */
/* Shims                                                                */
/* ------------------------------------------------------------------ */

const DAY = 86400000;
/** 2026-03-10T12:00Z — a fixed "now" so date-keyed tests are reproducible. */
const T0 = Date.UTC(2026, 2, 10, 12, 0, 0);

function makeLocalStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
    _map: m
  };
}

/**
 * Evaluates the module chain in a fresh sandbox.
 * @param {{ls?:object, now?:number, scripts?:string[], storage?:object|null, audio?:object, sdk?:object, search?:string}} [opts]
 *   storage: null removes G.storage after storage.js ran; an object replaces it.
 */
function load(opts = {}) {
  const ls = opts.ls ?? makeLocalStorage();
  const clock = { now: opts.now ?? T0 };
  const target = new EventTarget();
  const logs = [];
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  }
  const sandbox = {
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) },
    Intl,
    Date: FakeDate,
    setTimeout, clearTimeout,
    CustomEvent,
    location: { search: opts.search ?? '', hash: '', href: 'https://example.test/game/' },
    navigator: { languages: ['en-US'], language: 'en-US' },
    document: { hidden: false, addEventListener() {}, documentElement: { setAttribute() {} } },
    performance: { now: () => (clock.now - T0) + 0.5 },
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    dispatchEvent: (ev) => target.dispatchEvent(ev)
  };
  sandbox.window = sandbox;
  Object.defineProperty(sandbox, 'localStorage', { get() { return ls; } });
  sandbox.G = {};
  const scripts = opts.scripts ?? SOURCES.map(([f]) => f);
  for (const [file, src] of SOURCES) {
    if (!scripts.includes(file)) continue;
    if (file === 'meta.js') {
      if (opts.storage === null) delete sandbox.G.storage;
      else if (opts.storage) sandbox.G.storage = opts.storage;
      if (opts.audio) sandbox.G.audio = opts.audio;
      if (opts.sdk) sandbox.G.sdk = opts.sdk;
    }
    vm.runInNewContext(src, sandbox, { filename: file });
  }
  return { G: sandbox.G, meta: sandbox.G.meta, ls, clock, logs, sandbox };
}

/** Strips vm-realm prototypes so deepEqual compares structure only. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Reads a logical key straight from the fake localStorage (envelope unwrapped). */
function stored(ls, key) {
  const raw = ls.getItem('g1.' + key);
  return raw === null ? undefined : JSON.parse(raw).v;
}

/** Writes an envelope straight into the fake localStorage (simulates another tab / mirror). */
function storeRaw(ls, key, value, ts = 1) {
  ls.setItem('g1.' + key, JSON.stringify({ v: value, _ts: ts }));
}

/** A full run summary that satisfies every 'run' mission except the zero-graze one. */
function bigRun(overrides = {}) {
  return {
    mode: 'free', score: 10000, altM: 5000, banked: 5000, grazes: 50, loops: 10, hotShots: 10, maxM: 5,
    durationS: 120, usedRewind: false, duelWon: false, seed: 1, ...overrides
  };
}

/** First date key on/after `from` whose roll contains every id in `ids`. */
function findDateWith(meta, ids, from = Date.UTC(2026, 0, 1)) {
  for (let i = 0; i < 2000; i++) {
    const key = meta.dateKey(from + i * DAY);
    const roll = meta.rollMissions(key);
    if (ids.every((id) => roll.includes(id))) return key;
  }
  throw new Error(`no date rolls ${ids}`);
}

/** Moves the sandbox clock to noon UTC of the given date key. */
function gotoDate(ctx, key) {
  ctx.clock.now = Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), 12);
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */
console.log('# meta (node/vm)');

const base = load();
base.meta.init();

test('module attaches G.meta with the contract surface', () => {
  const m = base.meta;
  for (const fn of ['init', 'dateKey', 'dailySeed', 'dailyNumber', 'freeSeed', 'dailyInfo', 'rankFor', 'medalFor',
    'setSetting', 'equip', 'equipTheme', 'sessionTry', 'isOwned', 'canAfford', 'buySkin', 'adTryView',
    'themeUnlocked', 'themeProgress', 'setName', 'startRun', 'onEvent', 'onRunEnd', 'doubleDust',
    'missionsToday', 'claimMission', 'unclaimedCount', 'markTutorialSeen', 'dustBalance', 'rollMissions', 'sanitizeName']) {
    assert.equal(typeof m[fn], 'function', `G.meta.${fn}`);
  }
  assert.equal(m.SKINS.length, 8);
  assert.equal(m.THEMES.length, 5);
  assert.equal(m.MISSIONS.length, 12);
  assert.equal(m.AD_TRY_VIEWS, 3);
  assert.equal(typeof m.settings, 'object');
  assert.equal(typeof m.equipped.skin, 'object');
  assert.equal(typeof m.name, 'string');
  assert.equal(m.tutorialSeen, false);
  assert.equal(m.state, m.init(), 'init returns the same state object');
});

test('source hygiene: classic strict script, no Math.random, console only via G.log', () => {
  assert.ok(/'use strict'/.test(META_SOURCE));
  assert.ok(!/^\s*(import|export)\b/m.test(META_SOURCE));
  assert.ok(!/Math\.random/.test(META_SOURCE), 'meta must be deterministic apart from freeSeed');
  assert.ok(!/\bfetch\(|XMLHttpRequest/.test(META_SOURCE));
  const body = META_SOURCE.replace(/G\.log = G\.log \|\|[^\n]*/, '');
  assert.ok(!/console\.(log|warn|error|info|debug)\(/.test(body));
  assert.ok(!/TODO|FIXME|XXX/.test(META_SOURCE));
});

test('SKINS: every entry carries id, price, style, hues, width, timbre; ids match the design', () => {
  const ids = plain(base.meta.SKINS.map((s) => s.id));
  assert.deepEqual(ids, ['ember', 'ion', 'petal', 'static', 'prism', 'sunspot', 'void', 'glitch']);
  const prices = plain(base.meta.SKINS.map((s) => s.price));
  assert.deepEqual(prices, [0, 400, 500, 600, 800, 900, 1000, 1200]);
  const timbreByStyle = { ribbon: 'triangle', beads: 'sine', sparks: 'square', jagged: 'saw' };
  for (const s of base.meta.SKINS) {
    assert.ok(['ribbon', 'beads', 'sparks', 'jagged'].includes(s.style), s.id);
    assert.equal(typeof s.hueA, 'number');
    assert.equal(typeof s.hueB, 'number');
    assert.equal(s.width, 8);
    assert.ok(['triangle', 'sine', 'square', 'saw'].includes(s.timbre), s.id);
    if (!['static', 'sunspot', 'ion', 'ember'].includes(s.id)) assert.equal(s.timbre, timbreByStyle[s.style]);
    assert.ok(Object.isFrozen(s));
  }
  assert.equal(base.meta.SKINS.find((s) => s.id === 'petal').timbre, 'sine');
  assert.equal(base.meta.SKINS.find((s) => s.id === 'void').core, '#000');
  assert.equal(base.meta.SKINS.find((s) => s.id === 'glitch').offset, true);
  assert.equal(base.meta.SKINS.find((s) => s.id === 'prism').cycle, true);
});

test('THEMES: full palettes, ascending unlock altitudes, valid hex colours', () => {
  const t = base.meta.THEMES;
  assert.deepEqual(plain(t.map((x) => x.id)), ['indigo', 'ember', 'mint', 'vapor', 'ink']);
  assert.deepEqual(plain(t.map((x) => x.unlockAltM)), [0, 2000, 6000, 15000, 30000]);
  assert.deepEqual(plain(t.map((x) => x.mood)), ['minor', 'major', 'major', 'minor', 'minor']);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  for (const th of t) {
    assert.equal(th.skyStops.length, 5, th.id);
    assert.deepEqual(plain(th.skyStops.map((s) => s[0])), [0, 300, 700, 1200, 2000]);
    th.skyStops.forEach((s) => assert.match(s[1], hex));
    assert.equal(th.nebula.length, 3);
    th.nebula.forEach((n) => assert.equal(n.length, 3));
    assert.equal(th.planetPalettes.length, 6);
    th.planetPalettes.forEach((p) => { assert.equal(p.length, 3); p.forEach((c) => assert.match(c, hex)); });
    assert.match(th.tether, hex);
    assert.match(th.hot, hex);
    assert.match(th.text, hex);
    assert.equal(typeof th.starHue, 'number');
  }
  assert.equal(t[4].monochrome, true);
  assert.deepEqual(plain(t[0].skyStops), [[0, '#0b1030'], [300, '#0d2a3a'], [700, '#2a1240'], [1200, '#3a2a10'], [2000, '#0a0a14']]);
});

test('MISSIONS table matches the design (ids, targets, rewards, kinds)', () => {
  const m = plain(base.meta.MISSIONS);
  assert.deepEqual(m.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(m.map((x) => x.key), m.map((x) => `mission_${x.id}`));
  assert.deepEqual(m.map((x) => x.target), [10, 150, 300, 3, 5, 4, 2, 5, 1, 1, 60, 0]);
  assert.deepEqual(m.map((x) => x.reward), [120, 150, 120, 150, 120, 150, 120, 150, 80, 120, 120, 200]);
  assert.deepEqual(m.filter((x) => x.kind === 'day').map((x) => x.id), [7, 8, 9]);
  assert.deepEqual(m.map((x) => x.metric), ['grazes', 'banked', 'altM', 'loops', 'hotShots', 'maxM',
    'runsAbove200', 'bankRuns', 'daily', 'zeroGrazeAlt150', 'surviveS', 'beatBest']);
});

test('i18n: every skin/theme/rank/mission/medal key exists in every language', () => {
  const S = base.G.i18n.STRINGS;
  const keys = [
    ...base.meta.SKINS.map((s) => `skin_${s.id}`),
    ...base.meta.THEMES.map((t) => `theme_${t.id}`),
    ...base.G.CONFIG.RANKS.map((r) => `rank_${r[0]}`),
    ...base.meta.MISSIONS.map((m) => m.key),
    'medal_bronze', 'medal_silver', 'medal_gold',
    'holdToPlay', 'leftOnTable', 'rewindKeep', 'duelVs', 'youBeat', 'dailyNumber', 'cosmos', 'views', 'resetsIn'
  ];
  for (const lang of Object.keys(S)) {
    for (const k of keys) assert.equal(typeof S[lang][k], 'string', `${lang}.${k}`);
  }
  base.G.i18n.init({ lang: 'tr' });
  assert.equal(base.G.i18n.t('mission_3', { n: 300 }), '300 m yüksekliğe ulaş');
  assert.equal(base.G.i18n.t('rank_quasar'), 'Kuasar');
  base.G.i18n.setLang('en');
  assert.equal(base.G.i18n.t('mission_12'), 'Beat your best');
});

test('dateKey(): UTC calendar key, tolerant of Date/ms/invalid input', () => {
  const m = base.meta;
  assert.equal(m.dateKey(new Date(Date.UTC(2026, 0, 1))), '20260101');
  assert.equal(m.dateKey(Date.UTC(2026, 11, 31, 23, 59, 59)), '20261231');
  assert.equal(m.dateKey(Date.UTC(2027, 0, 1, 0, 0, 0)), '20270101', 'midnight belongs to the new day');
  assert.equal(m.dateKey(), '20260310', 'defaults to the (fake) clock');
  assert.equal(m.dateKey(new Date(NaN)), '20260310');
  assert.equal(m.dateKey('garbage'), '20260310');
});

test('dailySeed(): (yyyy*10000+mm*100+dd) ^ 0x5EED1234 as uint32', () => {
  const m = base.meta;
  assert.equal(m.dailySeed('20260105'), ((20260105 ^ 0x5EED1234) >>> 0));
  assert.equal(m.dailySeed('20991231'), ((20991231 ^ 0x5EED1234) >>> 0));
  assert.notEqual(m.dailySeed('20260105'), m.dailySeed('20260106'));
  assert.ok(m.dailySeed('20260105') >= 0 && m.dailySeed('20260105') <= 0xFFFFFFFF);
  assert.equal(m.dailySeed('nope'), m.dailySeed(m.dateKey()), 'malformed key → today');
});

test('dailyNumber(): days since 2026-01-01 UTC', () => {
  const m = base.meta;
  assert.equal(m.dailyNumber('20260101'), 0);
  assert.equal(m.dailyNumber('20260102'), 1);
  assert.equal(m.dailyNumber('20260201'), 31);
  assert.equal(m.dailyNumber('20270101'), 365);
  assert.equal(m.dailyNumber('20251231'), -1);
  assert.equal(m.dailyNumber('20260310'), Math.round((Date.UTC(2026, 2, 10) - Date.UTC(2026, 0, 1)) / DAY));
});

test('freeSeed(): uint32, differs across rapid calls', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = base.meta.freeSeed();
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xFFFFFFFF);
    seen.add(s);
  }
  assert.ok(seen.size >= 195, `expected near-unique seeds, got ${seen.size}`);
});

test('rankFor(): thresholds from CONFIG.RANKS with next tier', () => {
  const r = base.meta.rankFor;
  assert.deepEqual(plain(r(0)), { id: 'dust', threshold: 0, next: { id: 'pebble', threshold: 150 }, index: 0 });
  assert.equal(r(149).id, 'dust');
  assert.equal(r(150).id, 'pebble');
  assert.equal(r(399).id, 'pebble');
  assert.equal(r(400).id, 'meteor');
  assert.equal(r(800).id, 'comet');
  assert.equal(r(1400).id, 'star');
  assert.equal(r(2200).id, 'nova');
  assert.deepEqual(plain(r(3500)), { id: 'quasar', threshold: 3500, next: null, index: 6 });
  assert.equal(r(999999).id, 'quasar');
  assert.equal(r(NaN).id, 'dust');
  assert.equal(r(-5).id, 'dust');
});

test('medalFor(): bronze 300 / silver 700 / gold 1400', () => {
  const m = base.meta.medalFor;
  assert.equal(m(0), null);
  assert.equal(m(299), null);
  assert.equal(m(300), 'bronze');
  assert.equal(m(699), 'bronze');
  assert.equal(m(700), 'silver');
  assert.equal(m(1399), 'silver');
  assert.equal(m(1400), 'gold');
  assert.equal(m(undefined), null);
});

test('init(): defaults with empty storage', () => {
  const { meta } = load();
  const st = meta.init();
  assert.equal(st.best, 0);
  assert.equal(st.dust, 0);
  assert.deepEqual(plain(st.owned), []);
  assert.equal(meta.equipped.skin.id, 'ember');
  assert.equal(meta.equipped.theme.id, 'indigo');
  assert.deepEqual(plain(meta.settings), { sound: true, music: true, haptics: true, reduceMotion: false, aimGuide: true });
  assert.equal(meta.name, 'You');
  assert.equal(meta.tutorialSeen, false);
  assert.equal(meta.dustBalance(), 0);
  assert.equal(meta.sessionSkin, null);
  assert.equal(meta.initialised, true);
});

test('init(): loads and validates persisted state, dropping corrupt values', () => {
  const ls = makeLocalStorage();
  storeRaw(ls, 'best', 1234);
  storeRaw(ls, 'dust', -40);
  storeRaw(ls, 'owned', ['ion', 'bogus', 'ion', 42, 'glitch']);
  storeRaw(ls, 'equip', { skin: 'petal', theme: 'ink' });
  storeRaw(ls, 'stats', { runs: 7, totalAltM: 'x', loops: 2 });
  storeRaw(ls, 'settings', { sound: false, music: 'yes', aimGuide: false });
  storeRaw(ls, 'streak', { last: 'notadate', count: 9 });
  storeRaw(ls, 'seenTutorial', 1);
  storeRaw(ls, 'name', 'Mr. Rö-bot 9000!!');
  const { meta } = load({ ls });
  const st = meta.init();
  assert.equal(st.best, 1234);
  assert.equal(st.dust, 0, 'negative dust clamps to 0');
  assert.deepEqual(plain(st.owned), ['ion', 'glitch']);
  assert.equal(meta.equipped.skin.id, 'ember', 'unowned equipped skin falls back');
  assert.equal(meta.equipped.theme.id, 'indigo', 'locked equipped theme falls back');
  assert.deepEqual(plain(st.stats), { runs: 7, totalAltM: 0, loops: 2, grazes: 0, hotShots: 0, duelsWon: 0 });
  assert.deepEqual(plain(meta.settings), { sound: false, music: true, haptics: true, reduceMotion: false, aimGuide: false });
  assert.deepEqual(plain(st.streak), { last: null, count: 0 });
  assert.equal(meta.tutorialSeen, false, 'non-boolean seenTutorial is ignored');
  assert.equal(meta.name, 'MrRbot9000');
});

test('buy / equip / sessionTry / adTry flows and persistence across reloads', () => {
  const ls = makeLocalStorage();
  storeRaw(ls, 'dust', 1000);
  const ctx = load({ ls });
  const { meta } = ctx;
  meta.init();

  assert.equal(meta.isOwned('ember'), true, 'free skin always owned');
  assert.equal(meta.isOwned('ion'), false);
  assert.equal(meta.canAfford('ion'), true);
  assert.equal(meta.canAfford('glitch'), false, '1200 > 1000');
  assert.equal(meta.canAfford('ember'), false, 'owned is not purchasable');
  assert.equal(meta.canAfford('nope'), false);

  assert.equal(meta.buySkin('ion'), true);
  assert.equal(meta.dustBalance(), 600);
  assert.equal(meta.isOwned('ion'), true);
  assert.equal(meta.buySkin('ion'), false, 'cannot buy twice');
  assert.equal(meta.dustBalance(), 600);
  assert.equal(meta.buySkin('void'), false, 'unaffordable');
  assert.equal(stored(ls, 'dust'), 600);
  assert.deepEqual(stored(ls, 'owned'), ['ion']);

  assert.equal(meta.equip('ion'), true);
  assert.equal(meta.equipped.skin.id, 'ion');
  assert.equal(meta.equip('petal'), false, 'not owned');
  assert.equal(meta.equip('nope'), false);
  assert.equal(meta.equipped.skin.id, 'ion');
  assert.deepEqual(stored(ls, 'equip'), { skin: 'ion', theme: 'indigo' });

  assert.equal(meta.sessionTry('petal'), true);
  assert.equal(meta.sessionSkin, 'petal');
  assert.equal(meta.equipped.skin.id, 'petal', 'session try wins for rendering');
  assert.equal(meta.state.equip.skin, 'ion', 'but the persisted equip is untouched');
  assert.deepEqual(stored(ls, 'equip'), { skin: 'ion', theme: 'indigo' });
  assert.equal(meta.sessionTry('nope'), false);
  assert.equal(meta.equip('ion'), true);
  assert.equal(meta.sessionSkin, null, 'equip clears the session try');
  assert.equal(meta.sessionTry('ion'), true, 'trying an owned skin equips it');
  assert.equal(meta.sessionSkin, null);

  assert.deepEqual(plain(meta.adTryView('static')), { views: 1, unlocked: false });
  assert.deepEqual(plain(meta.adTryView('static')), { views: 2, unlocked: false });
  assert.equal(meta.isOwned('static'), false);
  assert.equal(stored(ls, 'adTry:static'), 2);
  assert.deepEqual(plain(meta.adTryView('static')), { views: 3, unlocked: true });
  assert.equal(meta.isOwned('static'), true);
  assert.deepEqual(plain(meta.adTryView('static')), { views: 3, unlocked: true }, 'owned: no further counting');
  assert.deepEqual(plain(meta.adTryView('ember')), { views: 0, unlocked: true });
  assert.deepEqual(plain(meta.adTryView('nope')), { views: 0, unlocked: false });
  assert.equal(meta.dustBalance(), 600, 'ad unlocks cost no dust');

  const again = load({ ls });
  again.meta.init();
  assert.deepEqual(plain(again.meta.state.owned), ['ion', 'static']);
  assert.equal(again.meta.equipped.skin.id, 'ion');
  assert.equal(again.meta.dustBalance(), 600);
  assert.equal(again.meta.sessionSkin, null, 'session tries do not persist');
});

test('onRunEnd(): dust formula floor(score/10) + 2*grazes + 10*loops, capped at 400', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  const r = meta.onRunEnd({ mode: 'free', score: 1234, altM: 980, banked: 254, grazes: 7, loops: 2, hotShots: 1, maxM: 3, durationS: 40 });
  assert.equal(r.dustEarned, 123 + 14 + 20);
  assert.equal(r.dustGained, r.dustEarned);
  assert.equal(r.dustDoubled, false);
  assert.equal(r.dust, 157);
  assert.equal(meta.dustBalance(), 157);
  assert.equal(stored(ctx.ls, 'dust'), 157);
  assert.equal(r.newBest, true);
  assert.equal(r.best, 1234);
  assert.equal(r.rank.id, 'comet');
  assert.equal(r.prevRank.id, 'dust');
  assert.equal(r.dailyBest, 0);
  assert.equal(r.dailyMedal, null);
  assert.equal(r.dailyMedalNew, false);
  assert.equal(r.streak, 0);
  assert.ok(Array.isArray(r.missionsCompletedNow));
  assert.deepEqual(plain(meta.state.stats), { runs: 1, totalAltM: 980, loops: 2, grazes: 7, hotShots: 1, duelsWon: 0 });

  const capped = meta.onRunEnd(bigRun());
  assert.equal(capped.dustEarned, 400, 'cap applies before anything else');
  assert.equal(meta.dustBalance(), 557);
  assert.equal(capped.newBest, true);
  assert.equal(capped.prevRank.id, 'comet');
  assert.equal(capped.rank.id, 'quasar');

  const worse = meta.onRunEnd({ mode: 'free', score: 50, altM: 50, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 5 });
  assert.equal(worse.newBest, false);
  assert.equal(worse.best, 10000);
  assert.equal(worse.dustEarned, 5);
  assert.equal(meta.state.stats.runs, 3);
  assert.equal(stored(ctx.ls, 'best'), 10000);

  const won = meta.onRunEnd({ mode: 'duel', score: 10, altM: 10, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 3, duelWon: true });
  assert.equal(won.dustEarned, 1);
  assert.equal(meta.state.stats.duelsWon, 1);

  const garbage = meta.onRunEnd(null);
  assert.equal(garbage.dustEarned, 0);
  assert.equal(garbage.newBest, false);
  assert.equal(meta.state.stats.runs, 5);
});

test('onRunEnd(): daily best, medals and dailyInfo()', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  let r = meta.onRunEnd({ mode: 'daily', score: 350, altM: 350, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 30 });
  assert.equal(r.dailyBest, 350);
  assert.equal(r.dailyMedal, 'bronze');
  assert.equal(r.dailyMedalNew, true);
  assert.equal(r.streak, 1);
  assert.equal(stored(ctx.ls, 'bestDaily:20260310'), 350);

  r = meta.onRunEnd({ mode: 'daily', score: 320, altM: 320, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 30 });
  assert.equal(r.dailyBest, 350, 'best of day keeps the higher score');
  assert.equal(r.dailyMedal, 'bronze');
  assert.equal(r.dailyMedalNew, false);

  r = meta.onRunEnd({ mode: 'daily', score: 800, altM: 600, banked: 200, grazes: 0, loops: 1, hotShots: 0, maxM: 1, durationS: 30 });
  assert.equal(r.dailyBest, 800);
  assert.equal(r.dailyMedal, 'silver');
  assert.equal(r.dailyMedalNew, true);

  const info = meta.dailyInfo();
  assert.equal(info.dateKey, '20260310');
  assert.equal(info.number, meta.dailyNumber('20260310'));
  assert.equal(info.seed, meta.dailySeed('20260310'));
  assert.equal(info.best, 800);
  assert.equal(info.medal, 'silver');
  assert.equal(info.streak, 1);
  assert.equal(info.yesterdayBest, 0);
  assert.equal(info.msToReset, 12 * 3600 * 1000, 'noon → 12 h to UTC midnight');

  ctx.clock.now += DAY;
  const next = meta.dailyInfo();
  assert.equal(next.dateKey, '20260311');
  assert.equal(next.best, 0);
  assert.equal(next.medal, null);
  assert.equal(next.yesterdayBest, 800);
  assert.equal(next.streak, 1, 'yesterday\'s Daily keeps the streak alive today');
  assert.equal(next.seed, meta.dailySeed('20260311'));

  ctx.clock.now += DAY;
  assert.equal(meta.dailyInfo().streak, 0, 'a missed day breaks the streak');
});

test('streak: increments on consecutive UTC days, idempotent within a day, resets after a gap; free runs never touch it', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  const daily = (score = 100) => meta.onRunEnd({ mode: 'daily', score, altM: score, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  const free = () => meta.onRunEnd({ mode: 'free', score: 100, altM: 100, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });

  assert.equal(free().streak, 0);
  assert.deepEqual(plain(meta.state.streak), { last: null, count: 0 });
  assert.equal(daily().streak, 1);
  assert.equal(daily().streak, 1, 'second Daily the same day does not double count');
  assert.deepEqual(stored(ctx.ls, 'streak'), { last: '20260310', count: 1 });
  ctx.clock.now += DAY;
  assert.equal(daily().streak, 2);
  ctx.clock.now += DAY;
  assert.equal(daily().streak, 3);
  assert.equal(free().streak, 3, 'free runs report but do not change the streak');
  ctx.clock.now += 2 * DAY;
  assert.equal(free().streak, 0, 'gap day: reported streak is 0 before a Daily is played');
  assert.equal(daily().streak, 1, 'gap → restart at 1');
  assert.deepEqual(stored(ctx.ls, 'streak'), { last: '20260314', count: 1 });
});

test('7th streak day doubles dust for every run that day (cap before doubling)', () => {
  const ls = makeLocalStorage();
  storeRaw(ls, 'streak', { last: '20260309', count: 6 });
  const ctx = load({ ls });
  const { meta } = ctx;
  meta.init();

  const freeBefore = meta.onRunEnd({ mode: 'free', score: 500, altM: 500, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(freeBefore.dustDoubled, false, 'streak day 7 is not reached until a Daily is played');
  assert.equal(freeBefore.dustGained, 50);

  const r = meta.onRunEnd({ mode: 'daily', score: 1000, altM: 1000, banked: 0, grazes: 10, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(r.streak, 7);
  assert.equal(r.dustEarned, 120, 'reported value is before doubling');
  assert.equal(r.dustDoubled, true);
  assert.equal(r.dustGained, 240);
  assert.equal(meta.dustBalance(), 50 + 240);

  const capped = meta.onRunEnd(bigRun());
  assert.equal(capped.dustEarned, 400);
  assert.equal(capped.dustGained, 800, 'cap applies before the x2');
  assert.equal(meta.dustBalance(), 290 + 800);

  ctx.clock.now += DAY;
  const day8 = meta.onRunEnd({ mode: 'daily', score: 100, altM: 100, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(day8.streak, 8);
  assert.equal(day8.dustDoubled, false);

  for (let i = 0; i < 6; i++) {
    ctx.clock.now += DAY;
    meta.onRunEnd({ mode: 'daily', score: 100, altM: 100, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  }
  assert.equal(meta.state.streak.count, 14);
  const day14 = meta.onRunEnd({ mode: 'free', score: 100, altM: 100, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(day14.dustDoubled, true, 'every 7th day doubles');
  assert.equal(day14.dustGained, 20);
});

test('doubleDust(): adds the earned amount once more, clamped to the cap, ignores junk', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  meta.onRunEnd({ mode: 'free', score: 1000, altM: 1000, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(meta.dustBalance(), 100);
  assert.equal(meta.doubleDust(100), 200);
  assert.equal(stored(ctx.ls, 'dust'), 200);
  assert.equal(meta.doubleDust(9999), 600, 'clamped to CONFIG.DUST.CAP');
  assert.equal(meta.doubleDust(-5), 600);
  assert.equal(meta.doubleDust(NaN), 600);
  assert.equal(meta.doubleDust(12.9), 612);
});

test('rollMissions(): deterministic per date, 3 distinct ids from the 12-entry table, full coverage over a year', () => {
  const { meta } = base;
  const a = meta.rollMissions('20260310');
  const b = meta.rollMissions('20260310');
  assert.deepEqual(plain(a), plain(b));
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
  const seen = new Set();
  let differentDays = 0;
  let prev = null;
  for (let i = 0; i < 365; i++) {
    const key = meta.dateKey(Date.UTC(2026, 0, 1) + i * DAY);
    const ids = meta.rollMissions(key);
    assert.equal(ids.length, 3, key);
    assert.equal(new Set(ids).size, 3, key);
    ids.forEach((id) => { assert.ok(Number.isInteger(id) && id >= 1 && id <= 12); seen.add(id); });
    if (prev && prev.join() !== ids.join()) differentDays++;
    prev = ids;
  }
  assert.equal(seen.size, 12, 'every mission is rolled at some point');
  assert.ok(differentDays > 300, 'rolls vary day to day');
  const other = load();
  assert.deepEqual(plain(other.meta.rollMissions('20260310')), plain(a), 'identical across module instances');
});

test('missionsToday(): rolls, persists {ids,targets,progress,claimed} and re-reads the stored record', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  const today = meta.missionsToday();
  assert.deepEqual(plain(today.map((m) => m.id)), plain(meta.rollMissions('20260310')));
  for (const m of today) {
    assert.equal(m.key, `mission_${m.id}`);
    assert.equal(m.progress, 0);
    assert.equal(m.claimed, false);
    assert.equal(m.done, false);
    assert.ok(m.target > 0);
    assert.equal(m.reward, meta.MISSIONS.find((d) => d.id === m.id).reward);
  }
  const rec = stored(ctx.ls, 'missions:20260310');
  assert.deepEqual(rec.ids, plain(today.map((m) => m.id)));
  assert.deepEqual(rec.progress, [0, 0, 0]);
  assert.deepEqual(rec.claimed, [false, false, false]);
  assert.deepEqual(rec.targets, plain(today.map((m) => m.target)));
  assert.equal(meta.unclaimedCount(), 0);

  const reloaded = load({ ls: ctx.ls });
  reloaded.meta.init();
  assert.deepEqual(plain(reloaded.meta.missionsToday()), plain(today));
});

test('missions: run-kind progress is best-of-run, day-kind accumulates, completion is reported once; claim pays dust', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  // A day whose roll holds "Reach 300 m" (3) and "Finish 2 runs above 200 m today" (7).
  const key = findDateWith(meta, [3, 7]);
  gotoDate(ctx, key);

  const small = { mode: 'free', score: 250, altM: 250, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 20 };
  let r = meta.onRunEnd(small);
  let ms = meta.missionsToday();
  const m3 = () => ms.find((m) => m.id === 3);
  const m7 = () => ms.find((m) => m.id === 7);
  assert.equal(m3().progress, 250);
  assert.equal(m3().done, false);
  assert.equal(m7().progress, 1);
  assert.deepEqual(plain(r.missionsCompletedNow), []);

  r = meta.onRunEnd({ ...small, altM: 180, score: 180 });
  ms = meta.missionsToday();
  assert.equal(m3().progress, 250, 'run-kind keeps the best run');
  assert.equal(m7().progress, 1, 'a run below 200 m does not count');
  assert.deepEqual(plain(r.missionsCompletedNow), []);

  r = meta.onRunEnd({ ...small, altM: 420, score: 420 });
  ms = meta.missionsToday();
  assert.equal(m3().progress, 300, 'displayed progress is capped at the target');
  assert.equal(m3().done, true);
  assert.equal(m7().progress, 2);
  assert.equal(m7().done, true);
  assert.deepEqual(plain(r.missionsCompletedNow).sort(), [3, 7]);
  assert.equal(meta.unclaimedCount(), 2);

  r = meta.onRunEnd({ ...small, altM: 900, score: 900 });
  assert.deepEqual(plain(r.missionsCompletedNow), [], 'completion is only reported once');

  const before = meta.dustBalance();
  assert.equal(meta.claimMission(3), 120);
  assert.equal(meta.dustBalance(), before + 120);
  assert.equal(meta.claimMission(3), 0, 'no double claim');
  assert.equal(meta.unclaimedCount(), 1);
  const undone = ms.find((m) => m.id !== 3 && m.id !== 7);
  assert.equal(meta.claimMission(undone.id), 0, 'incomplete mission pays nothing');
  assert.equal(meta.claimMission(99), 0);
  assert.equal(meta.claimMission(7), 120);
  assert.equal(meta.unclaimedCount(), 0);
  const rec = stored(ctx.ls, 'missions:' + key);
  assert.equal(rec.claimed[rec.ids.indexOf(3)], true);
  assert.equal(rec.claimed[rec.ids.indexOf(7)], true);
  assert.equal(stored(ctx.ls, 'dust'), meta.dustBalance());
});

test('missions: "beat your best" snapshots max(best+1, 50) at roll time; zero-graze and Daily missions', () => {
  const ls = makeLocalStorage();
  storeRaw(ls, 'best', 700);
  const ctx = load({ ls });
  const { meta } = ctx;
  meta.init();
  const key12 = findDateWith(meta, [12]);
  gotoDate(ctx, key12);
  let m12 = meta.missionsToday().find((m) => m.id === 12);
  assert.equal(m12.target, 701);
  let r = meta.onRunEnd({ mode: 'free', score: 700, altM: 700, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(meta.missionsToday().find((m) => m.id === 12).done, false, 'equal is not beating');
  r = meta.onRunEnd({ mode: 'free', score: 701, altM: 701, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.ok(r.missionsCompletedNow.includes(12));
  m12 = meta.missionsToday().find((m) => m.id === 12);
  assert.equal(m12.target, 701, 'target stays as rolled even though best moved');
  assert.equal(m12.done, true);

  const fresh = load();
  fresh.meta.init();
  gotoDate(fresh, key12);
  assert.equal(fresh.meta.missionsToday().find((m) => m.id === 12).target, 50, 'floor of 50 for a new player');

  const key10 = findDateWith(meta, [10]);
  gotoDate(ctx, key10);
  meta.onRunEnd({ mode: 'free', score: 200, altM: 200, banked: 0, grazes: 1, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(meta.missionsToday().find((m) => m.id === 10).progress, 0, 'a graze spoils it');
  meta.onRunEnd({ mode: 'free', score: 149, altM: 149, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(meta.missionsToday().find((m) => m.id === 10).progress, 0, '149 m is short');
  r = meta.onRunEnd({ mode: 'free', score: 150, altM: 150, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.ok(r.missionsCompletedNow.includes(10));

  const key9 = findDateWith(meta, [9]);
  gotoDate(ctx, key9);
  meta.onRunEnd({ mode: 'free', score: 10, altM: 10, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.equal(meta.missionsToday().find((m) => m.id === 9).progress, 0);
  r = meta.onRunEnd({ mode: 'daily', score: 10, altM: 10, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  assert.ok(r.missionsCompletedNow.includes(9));
  assert.equal(meta.claimMission(9), 80);
});

test('missions: UTC rollover mid-session switches to the new day and keeps yesterday\'s record', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  meta.onRunEnd(bigRun());
  const yesterday = meta.missionsToday();
  assert.ok(yesterday.some((m) => m.done));
  ctx.clock.now += DAY;
  const today = meta.missionsToday();
  assert.deepEqual(plain(today.map((m) => m.id)), plain(meta.rollMissions('20260311')));
  assert.ok(today.every((m) => m.progress === 0 && !m.done));
  assert.ok(stored(ctx.ls, 'missions:20260310').progress.some((p) => p > 0), 'old record stays persisted');
  assert.ok(stored(ctx.ls, 'missions:20260311'));
});

test('startRun/onEvent: live tracker feeds missionsToday() and fills gaps in the run summary', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  const key = findDateWith(meta, [1, 4]);
  gotoDate(ctx, key);
  assert.equal(meta.run, null);
  meta.onEvent({ type: 'GRAZE' });
  assert.equal(meta.run, null, 'events without a run are ignored');

  const tr = meta.startRun('free');
  assert.equal(tr.mode, 'free');
  assert.equal(tr.dateKey, key);
  for (let i = 0; i < 4; i++) meta.onEvent({ type: 'GRAZE', planetId: i, amount: 5, M: 1 + 0.5 * i, x: 0, y: 0 });
  meta.onEvent({ type: 'LOOP', amount: 20, bankedTotal: 80, pooledBefore: 60, x: 0, y: 0 });
  meta.onEvent({ type: 'HOT_SHOT', amount: 10, M: 2.75 });
  meta.onEvent({ type: 'WALL', x: 9, y: 0, side: -1 });
  meta.onEvent(null);
  meta.onEvent({ nope: true });
  assert.equal(tr.grazes, 4);
  assert.equal(tr.loops, 1);
  assert.equal(tr.hotShots, 1);
  assert.equal(tr.banked, 80);
  assert.equal(tr.maxM, 2.75);

  const live = meta.missionsToday();
  assert.equal(live.find((m) => m.id === 1).progress, 4, 'live graze progress');
  assert.equal(live.find((m) => m.id === 4).progress, 1, 'live loop progress');
  assert.equal(live.find((m) => m.id === 1).done, false, 'live progress never completes a mission before run end');

  ctx.clock.now += 65000;
  const r = meta.onRunEnd({ mode: 'free', score: 300, altM: 220 });
  assert.equal(meta.run, null, 'tracker is cleared');
  assert.equal(r.dustEarned, 30 + 8 + 10, 'grazes/loops came from the tracker');
  assert.deepEqual(plain(meta.state.stats), { runs: 1, totalAltM: 220, loops: 1, grazes: 4, hotShots: 1, duelsWon: 0 });
  const after = meta.missionsToday();
  assert.equal(after.find((m) => m.id === 1).progress, 4);
  assert.equal(after.find((m) => m.id === 4).progress, 1);
  const m11 = after.find((m) => m.id === 11);
  if (m11) assert.equal(m11.progress, 60, 'duration derived from the tracker clock (65 s, capped at target)');

  meta.startRun('daily');
  const r2 = meta.onRunEnd({ mode: 'daily', score: 100, altM: 100, grazes: 9, loops: 0, hotShots: 0, maxM: 1, durationS: 5 });
  assert.equal(r2.dustEarned, 10 + 18, 'explicit summary values win over an idle tracker');
  assert.equal(meta.missionsToday().find((m) => m.id === 1).progress, 9);
});

test('themes: lifetime altitude unlocks, progress readout, equipTheme gating', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  assert.equal(meta.themeUnlocked('indigo'), true);
  assert.equal(meta.themeUnlocked('ember'), false);
  assert.equal(meta.themeUnlocked('nope'), false);
  assert.deepEqual(plain(meta.themeProgress('ember')), { have: 0, need: 2000, remaining: 2000 });
  assert.equal(meta.themeProgress('nope'), null);
  assert.equal(meta.equipTheme('ember'), false);
  assert.equal(meta.equipped.theme.id, 'indigo');

  meta.onRunEnd({ mode: 'free', score: 1500, altM: 1500, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 60 });
  meta.onRunEnd({ mode: 'free', score: 800, altM: 800, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 60 });
  assert.deepEqual(plain(meta.themeProgress('ember')), { have: 2300, need: 2000, remaining: 0 });
  assert.deepEqual(plain(meta.themeProgress('mint')), { have: 2300, need: 6000, remaining: 3700 });
  assert.equal(meta.themeUnlocked('ember'), true);
  assert.equal(meta.equipTheme('ember'), true);
  assert.equal(meta.equipTheme('mint'), false);
  assert.equal(meta.equipTheme('nope'), false);
  assert.equal(meta.equipped.theme.id, 'ember');
  assert.deepEqual(stored(ctx.ls, 'equip'), { skin: 'ember', theme: 'ember' });

  const again = load({ ls: ctx.ls });
  again.meta.init();
  assert.equal(again.meta.equipped.theme.id, 'ember');
  assert.equal(again.meta.state.stats.totalAltM, 2300);
});

test('settings: persisted, forwarded to G.audio / G.sdk, unknown keys rejected', () => {
  const calls = [];
  const audio = { setSfx: (v) => calls.push(['sfx', v]), setMusic: (v) => calls.push(['music', v]) };
  const sdk = { hapticsEnabled: true, user: null };
  const ls = makeLocalStorage();
  storeRaw(ls, 'settings', { music: false });
  const ctx = load({ ls, audio, sdk });
  const { meta } = ctx;
  meta.init();
  assert.deepEqual(plain(calls), [['sfx', true], ['music', false]], 'init pushes the persisted settings to audio');
  assert.equal(sdk.hapticsEnabled, true);
  assert.equal(stored(ls, 'haptics'), true, 'sdk reads the haptics key on its own init');

  calls.length = 0;
  assert.equal(meta.setSetting('sound', false), true);
  assert.deepEqual(plain(calls), [['sfx', false]]);
  assert.equal(meta.setSetting('haptics', 0), true);
  assert.equal(meta.settings.haptics, false);
  assert.equal(sdk.hapticsEnabled, false);
  assert.equal(stored(ls, 'haptics'), false);
  assert.equal(meta.setSetting('reduceMotion', true), true);
  assert.equal(meta.setSetting('aimGuide', false), true);
  assert.equal(meta.setSetting('volume', 1), false, 'unknown key');
  assert.equal(meta.setSetting('__proto__', true), false);
  assert.deepEqual(stored(ls, 'settings'), { sound: false, music: false, haptics: false, reduceMotion: true, aimGuide: false });
  assert.equal(meta.settings, meta.state.settings, 'settings is the live object');

  const broken = load({ audio: { setSfx() { throw new Error('boom'); }, setMusic() {} } });
  broken.meta.init();
  assert.equal(broken.meta.setSetting('sound', false), true, 'a throwing audio module never breaks settings');
  assert.equal(broken.meta.settings.sound, false);
});

test('name: default from G.sdk.user sanitized, setName sanitizes/caps/persists/clears', () => {
  const ls = makeLocalStorage();
  const ctx = load({ ls, sdk: { user: { name: 'Ali Veli!' }, hapticsEnabled: true } });
  const { meta } = ctx;
  meta.init();
  assert.equal(meta.name, 'AliVeli');
  assert.equal(meta.setName('Zoë-Ω Löwe 12345678'), 'ZoLwe1234567');
  assert.equal(meta.name, 'ZoLwe1234567');
  assert.equal(meta.name.length, 12);
  assert.equal(stored(ls, 'name'), 'ZoLwe1234567');
  assert.equal(meta.setName('<script>'), 'script');
  assert.equal(meta.setName('   '), 'AliVeli', 'empty clears back to the default');
  assert.equal(stored(ls, 'name'), undefined);
  assert.equal(meta.setName(null), 'AliVeli');
  assert.equal(meta.setName(12345), '12345');
  assert.equal(meta.sanitizeName('a b-c'), 'abc');
  assert.equal(meta.sanitizeName(''), '');

  const noSdk = load({ ls });
  noSdk.meta.init();
  assert.equal(noSdk.meta.name, '12345', 'stored name wins');
  noSdk.meta.setName('');
  assert.equal(noSdk.meta.name, 'You');

  const throwing = load({ sdk: { get user() { throw new Error('nope'); } } });
  throwing.meta.init();
  assert.equal(throwing.meta.name, 'You');
});

test('tutorial flag persists', () => {
  const ctx = load();
  ctx.meta.init();
  assert.equal(ctx.meta.tutorialSeen, false);
  ctx.meta.markTutorialSeen();
  assert.equal(ctx.meta.tutorialSeen, true);
  assert.equal(stored(ctx.ls, 'seenTutorial'), true);
  const again = load({ ls: ctx.ls });
  again.meta.init();
  assert.equal(again.meta.tutorialSeen, true);
});

test('in-memory fallback: a throwing G.storage keeps every feature working for the session', () => {
  const storage = {
    init() { throw new Error('blocked'); },
    get() { throw new Error('blocked'); },
    set() { throw new Error('blocked'); },
    remove() { throw new Error('blocked'); },
    available: false
  };
  const ctx = load({ storage });
  const { meta } = ctx;
  const st = meta.init();
  assert.equal(st.dust, 0);
  const r = meta.onRunEnd(bigRun({ mode: 'daily' }));
  assert.equal(r.dustEarned, 400);
  assert.equal(meta.dustBalance(), 400);
  assert.equal(meta.buySkin('ion'), true);
  assert.equal(meta.dustBalance(), 0);
  assert.equal(meta.isOwned('ion'), true);
  assert.equal(meta.equip('ion'), true);
  assert.equal(meta.equipped.skin.id, 'ion');
  assert.equal(meta.dailyInfo().best, 10000, 'daily best is served from memory');
  assert.equal(meta.dailyInfo().streak, 1);
  assert.ok(meta.missionsToday().some((m) => m.done));
  assert.equal(meta.setSetting('music', false), true);
  assert.equal(meta.setName('Mem'), 'Mem');
  meta.markTutorialSeen();
  assert.equal(meta.tutorialSeen, true);
  assert.deepEqual(plain(meta.adTryView('void')), { views: 1, unlocked: false });
  assert.deepEqual(plain(meta.adTryView('void')), { views: 2, unlocked: false });
  assert.equal(ctx.logs.length, 0, 'storage failures are silent unless G.DEBUG');

  const debug = load({ storage, search: '?debug=1' });
  debug.meta.init();
  debug.meta.onRunEnd(bigRun());
  assert.equal(debug.G.DEBUG, true);
  assert.ok(debug.logs.some((l) => String(l[0]).includes('[meta] storage.set failed')), 'failures are reported via G.log in debug mode');
});

test('in-memory fallback: no G.storage at all (meta loaded standalone)', () => {
  const ctx = load({ storage: null, scripts: ['config.js', 'meta.js'] });
  const { meta } = ctx;
  assert.equal(ctx.G.storage, undefined);
  assert.equal(ctx.G.i18n, undefined);
  meta.init();
  assert.equal(meta.onRunEnd({ mode: 'free', score: 500, altM: 500, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 1 }).dustEarned, 50);
  assert.equal(meta.dustBalance(), 50);
  assert.equal(meta.state.best, 500);
  assert.equal(meta.rankFor(meta.state.best).id, 'meteor');
  assert.equal(meta.missionsToday().length, 3);
});

test('works without config.js (fallback tables mirror the contract)', () => {
  const ctx = load({ scripts: ['storage.js', 'meta.js'] });
  const { meta } = ctx;
  assert.equal(ctx.G.CONFIG, undefined);
  meta.init();
  assert.equal(meta.rankFor(3500).id, 'quasar');
  assert.equal(meta.medalFor(700), 'silver');
  assert.equal(meta.onRunEnd(bigRun()).dustEarned, 400);
  assert.equal(meta.setName('abcdefghijklmnop'), 'abcdefghijkl');
});

test('external storage changes (other tab / mirror pull) refresh the cached state', () => {
  const ctx = load();
  const { meta, ls, sandbox } = ctx;
  meta.init();
  meta.onRunEnd({ mode: 'free', score: 100, altM: 100, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 1 });
  assert.equal(meta.dustBalance(), 10);
  storeRaw(ls, 'dust', 777, Date.now() + 10);
  storeRaw(ls, 'owned', ['glitch'], Date.now() + 10);
  sandbox.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'dust', source: 'external' } }));
  sandbox.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'owned', source: 'mirror' } }));
  assert.equal(meta.dustBalance(), 777);
  assert.equal(meta.isOwned('glitch'), true);
  storeRaw(ls, 'dust', 1, Date.now() + 20);
  sandbox.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'dust', source: 'local' } }));
  assert.equal(meta.dustBalance(), 777, 'our own writes do not trigger a reload');
  sandbox.dispatchEvent(new CustomEvent('g:storage', { detail: {} }));
  sandbox.dispatchEvent(new CustomEvent('g:storage'));
  assert.equal(meta.dustBalance(), 777);
});

test('G.storage integration: meta keys land under the g1. prefix with envelopes and keys() lists them', () => {
  const ctx = load();
  const { meta, G, ls } = ctx;
  meta.init();
  meta.onRunEnd({ mode: 'daily', score: 400, altM: 400, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 1 });
  meta.markTutorialSeen();
  const keys = G.storage.keys();
  for (const k of ['best', 'bestDaily:20260310', 'dust', 'missions:20260310', 'seenTutorial', 'stats', 'streak', 'haptics']) {
    assert.ok(keys.includes(k), `missing ${k} in ${keys}`);
  }
  assert.ok(ls.getItem('g1.best'));
  assert.equal(G.storage.get('best'), 400);
  assert.equal(G.storage.get('bestDaily:20260310'), 400);
});

test('"beat your best" is snapshotted BEFORE the run moves state.best (first run of the day)', () => {
  const ls = makeLocalStorage();
  storeRaw(ls, 'best', 700);
  const ctx = load({ ls });
  const { meta } = ctx;
  meta.init();
  gotoDate(ctx, findDateWith(meta, [12]));
  // Nobody opened the missions panel today: the roll happens inside onRunEnd.
  const r = meta.onRunEnd({ mode: 'free', score: 900, altM: 900, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  const m12 = meta.missionsToday().find((m) => m.id === 12);
  assert.equal(m12.target, 701, 'target comes from the best BEFORE this run');
  assert.equal(m12.done, true);
  assert.ok(r.missionsCompletedNow.includes(12));
  assert.equal(meta.state.best, 900);

  // startRun also rolls, so a title-screen tracker snapshots the pre-run best as well.
  const fresh = load();
  fresh.meta.init();
  gotoDate(fresh, findDateWith(fresh.meta, [12]));
  fresh.meta.startRun('free');
  assert.equal(stored(fresh.ls, 'missions:' + fresh.meta.dateKey()).targets[fresh.meta.rollMissions(fresh.meta.dateKey()).indexOf(12)], 50);
});

test('streak never regresses on a stale date key (clock skew / mirrored state) and a newer last day keeps it alive', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  const daily = (dateKey) => meta.onRunEnd({ mode: 'daily', score: 100, altM: 100, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10, dateKey });
  daily('20260310');
  daily('20260311');
  daily('20260312');
  assert.deepEqual(plain(meta.state.streak), { last: '20260312', count: 3 });
  const stale = daily('20260310');
  assert.deepEqual(plain(meta.state.streak), { last: '20260312', count: 3 }, 'an older key never rewrites the streak');
  assert.equal(stale.streak, 3, 'reported from the newer registered day');
  assert.equal(stale.dustDoubled, false);
  assert.deepEqual(stored(ctx.ls, 'streak'), { last: '20260312', count: 3 });
  // The device is still on the 10th (clock behind the device that played the 12th): the streak reads alive.
  assert.equal(meta.dailyInfo().streak, 3);
  // Continuing on the 13th extends it normally.
  assert.equal(daily('20260313').streak, 4);
  // A key far in the past is ignored, a gap in the future restarts.
  assert.equal(daily('20200101').streak, 4);
  assert.equal(daily('20260320').streak, 1);
});

test('init() re-run keeps the in-memory session store when storage is absent or throwing', () => {
  const throwing = { init() { throw new Error('x'); }, get() { throw new Error('x'); }, set() { throw new Error('x'); }, remove() { throw new Error('x'); }, available: false };
  const ctx = load({ storage: throwing });
  ctx.meta.init();
  ctx.meta.onRunEnd({ mode: 'daily', score: 1000, altM: 1000, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 10 });
  ctx.meta.setName('Keep');
  ctx.meta.init();
  assert.equal(ctx.meta.dustBalance(), 100);
  assert.equal(ctx.meta.state.best, 1000);
  assert.equal(ctx.meta.name, 'Keep');
  assert.equal(ctx.meta.dailyInfo().best, 1000);

  const none = load({ storage: null, scripts: ['config.js', 'meta.js'] });
  none.meta.init();
  none.meta.onRunEnd({ mode: 'free', score: 500, altM: 500, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 1 });
  none.meta.init();
  assert.equal(none.meta.dustBalance(), 50);

  // With a working backend a re-init still re-reads storage (external edits win).
  const ok = load();
  ok.meta.init();
  ok.meta.onRunEnd({ mode: 'free', score: 500, altM: 500, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 1 });
  storeRaw(ok.ls, 'dust', 999, Date.now() + 5);
  ok.meta.init();
  assert.equal(ok.meta.dustBalance(), 999);
});

test('a corrupt CONFIG.DUST (debug panel) never persists NaN dust', () => {
  const ctx = load();
  const { meta, G } = ctx;
  meta.init();
  const run = () => meta.onRunEnd({ mode: 'free', score: 100, altM: 100, banked: 0, grazes: 1, loops: 1, hotShots: 0, maxM: 1, durationS: 1 });
  G.CONFIG.DUST.CAP = NaN;
  assert.equal(run().dustEarned, 22, 'NaN cap falls back to the contract cap');
  G.CONFIG.DUST.CAP = 400;
  G.CONFIG.DUST.DIV = 0;
  assert.equal(run().dustEarned, 22, 'zero divisor falls back to 10');
  G.CONFIG.DUST.DIV = 'ten';
  G.CONFIG.DUST.PER_GRAZE = Infinity;
  G.CONFIG.DUST.PER_LOOP = undefined;
  assert.equal(run().dustEarned, 22);
  delete G.CONFIG.DUST;
  assert.equal(run().dustEarned, 22);
  assert.equal(meta.dustBalance(), 88);
  assert.equal(stored(ctx.ls, 'dust'), 88);
  assert.equal(meta.doubleDust(22), 110);
});

test('impossible calendar keys (Feb 31) are treated as malformed, so every stored key is canonical', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  assert.equal(meta.dailyNumber('20260231'), meta.dailyNumber(meta.dateKey()), 'malformed → today');
  assert.equal(meta.dailyNumber('20260229'), meta.dailyNumber(meta.dateKey()), '2026 is not a leap year');
  assert.equal(meta.dailyNumber('20280229'), meta.dailyNumber('20280228') + 1, '2028 is');
  assert.equal(meta.dailySeed('20261301'), meta.dailySeed(meta.dateKey()));
  meta.onRunEnd({ mode: 'daily', score: 400, altM: 400, banked: 0, grazes: 0, loops: 0, hotShots: 0, maxM: 1, durationS: 1, dateKey: '20260231' });
  assert.equal(stored(ctx.ls, 'bestDaily:20260231'), undefined);
  assert.equal(stored(ctx.ls, 'bestDaily:20260310'), 400, 'booked on the real day instead');
  storeRaw(ctx.ls, 'streak', { last: '20260231', count: 5 });
  meta.init();
  assert.deepEqual(plain(meta.state.streak), { last: null, count: 0 });
});

test('an ad unlock while session-trying that skin promotes it to the permanent equip', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  assert.equal(meta.sessionTry('static'), true);
  meta.adTryView('static');
  meta.adTryView('static');
  assert.equal(meta.state.equip.skin, 'ember', 'nothing permanent before the third view');
  assert.deepEqual(plain(meta.adTryView('static')), { views: 3, unlocked: true });
  assert.equal(meta.sessionSkin, null);
  assert.equal(meta.state.equip.skin, 'static');
  assert.equal(meta.equipped.skin.id, 'static');
  assert.deepEqual(stored(ctx.ls, 'equip'), { skin: 'static', theme: 'indigo' });
  const again = load({ ls: ctx.ls });
  again.meta.init();
  assert.equal(again.meta.equipped.skin.id, 'static', 'survives a reload');

  // Buying while trying a DIFFERENT skin leaves the try alone.
  storeRaw(ctx.ls, 'dust', 5000, Date.now() + 5);
  const rich = load({ ls: ctx.ls });
  rich.meta.init();
  rich.meta.sessionTry('void');
  assert.equal(rich.meta.buySkin('ion'), true);
  assert.equal(rich.meta.sessionSkin, 'void');
  assert.equal(rich.meta.state.equip.skin, 'static');
  // Buying the tried skin itself equips it permanently too.
  assert.equal(rich.meta.buySkin('void'), true);
  assert.equal(rich.meta.sessionSkin, null);
  assert.equal(rich.meta.state.equip.skin, 'void');
});

test('junk summaries and events never poison persisted numbers', () => {
  const ctx = load();
  const { meta } = ctx;
  meta.init();
  meta.startRun('free');
  meta.onEvent({ type: 'GRAZE', M: Infinity });
  meta.onEvent({ type: 'LOOP', bankedTotal: NaN });
  meta.onEvent({ type: 'HOT_SHOT', M: -4 });
  assert.deepEqual(plain(meta.run).grazes, 1);
  assert.equal(meta.run.maxM, 1);
  assert.equal(meta.run.banked, 0);
  const r = meta.onRunEnd({ mode: 'daily', score: Infinity, altM: -Infinity, banked: NaN, grazes: 'x', loops: null, hotShots: {}, maxM: Infinity, durationS: -5, dateKey: 12345 });
  for (const v of [r.dustEarned, r.dustGained, r.dust, r.best, r.dailyBest, r.streak]) assert.ok(Number.isFinite(v), String(v));
  for (const v of Object.values(plain(meta.state.stats))) assert.ok(Number.isFinite(v));
  assert.equal(stored(ctx.ls, 'dust'), meta.dustBalance());
  assert.equal(meta.rankFor(Infinity).id, 'dust');
  assert.equal(meta.medalFor(-Infinity), null);
  assert.equal(meta.doubleDust(Infinity), meta.dustBalance());
  assert.equal(meta.themeProgress('ember').remaining, 2000);
});

console.log(`\n${passed} tests passed`);
