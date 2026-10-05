// Tests for game/js/duel.js
// Run: node tests/duel.test.mjs
//
// duel.js is a classic browser script; the Node part loads it into a `vm`
// sandbox with a window/location shim (optionally alongside i18n.js for the
// share text). A short Playwright section checks readFromLocation against a
// real location.hash in headless Chromium.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DUEL_PATH = path.resolve(here, '../game/js/duel.js');
const I18N_PATH = path.resolve(here, '../game/js/i18n.js');
const duelSource = fs.readFileSync(DUEL_PATH, 'utf8');
const i18nSource = fs.readFileSync(I18N_PATH, 'utf8');

const TWO_PI = Math.PI * 2;
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

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}`);
    throw err;
  }
}

/** Smallest signed difference between two angles, in (−π, π]. */
function angDiff(a, b) {
  return Math.abs((((a - b) % TWO_PI) + 3 * Math.PI) % TWO_PI - Math.PI);
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Load duel.js (and optionally i18n.js) into a fresh sandbox.
 * @param {{hash?:string, search?:string, href?:string, sdk?:object, telegram?:object, config?:object, withI18n?:boolean, G?:object}} [env]
 */
function load(env = {}) {
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: console.error },
    Intl,
    URLSearchParams,
    Uint8Array,
    location: {
      hash: env.hash ?? '',
      search: env.search ?? '',
      href: env.href ?? 'https://example.test/game/' + (env.search ?? '') + (env.hash ?? '')
    },
    navigator: { languages: ['en-US'], language: 'en-US' },
    document: { documentElement: { setAttribute() {} } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent: () => true
  };
  sandbox.window = sandbox;
  if (env.telegram) sandbox.Telegram = env.telegram;
  sandbox.G = { ...(env.G ?? {}) };
  if (env.sdk) sandbox.G.sdk = env.sdk;
  if (env.config !== undefined) sandbox.G.CONFIG = env.config;
  if (env.withI18n) vm.runInNewContext(i18nSource, sandbox, { filename: 'i18n.js' });
  vm.runInNewContext(duelSource, sandbox, { filename: 'duel.js' });
  return { G: sandbox.G, duel: sandbox.G.duel, logs, sandbox };
}

/** Strip vm-realm prototypes so deepEqual compares structure. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Random hops as a walk along the generation order (delta 0..6 per hop, like a real run). */
function randomHops(duelApi, rng, count) {
  const hops = [];
  let ordinal = 0;
  for (let i = 0; i < count; i++) {
    ordinal += Math.floor(rng() * 7);
    hops.push({
      planetId: duelApi.idFromOrdinal(ordinal),
      theta: rng() * 4 * Math.PI - 2 * Math.PI,
      r: 30 + rng() * 280,
      s: rng() < 0.5 ? 1 : -1,
      releaseTheta: rng() * TWO_PI,
      heat: rng()
    });
  }
  return hops;
}

/** Feeds hops through a recorder. */
function recordRun(duelApi, hops) {
  const rec = duelApi.createRecorder();
  for (const h of hops) {
    rec.onLatch({ planetId: h.planetId, theta: h.theta, r: h.r, s: h.s });
    rec.onRelease({ theta: h.releaseTheta, heat: h.heat });
  }
  return { rec, sorted: hops };
}

const CONFIG = {
  V_ORBIT: 420, GRAVITY: 520, HOT_BOOST: 0.5, COMET_R: 9, COL_W: 540, WALL_RESTITUTION: 0.85,
  SHARE: { APP_URL: 'https://feederparker1-droid.github.io/tma-uploader-site/game/', TELEGRAM_APP: '', ITCH_URL: '', PAYLOAD_MAX: 1500, NAME_MAX: 12 }
};

// ---------------------------------------------------------------------------
// Node tests
// ---------------------------------------------------------------------------
console.log('# duel (node/vm)');

const base = load({ config: CONFIG });
const { duel } = base;

test('module attaches G.duel with the contract surface', () => {
  for (const fn of ['ordinalOf', 'idFromOrdinal', 'createRecorder', 'encode', 'decode', 'base64urlEncode',
    'base64urlDecode', 'readFromLocation', 'buildLinks', 'shareText', 'expandPath']) {
    assert.equal(typeof duel[fn], 'function', `G.duel.${fn}`);
  }
  assert.equal(duel.MAX_HOPS, 300);
  assert.equal(duel.RECORD_BYTES, 5);
  assert.equal(typeof base.G.log, 'function');
});

test('ordinalOf / idFromOrdinal: k*32+idx, roundtrip, chunk crossing deltas stay small', () => {
  assert.equal(duel.ordinalOf(0), 0);
  assert.equal(duel.ordinalOf(7), 7);
  assert.equal(duel.ordinalOf(1000), 32);
  assert.equal(duel.ordinalOf(3005), 3 * 32 + 5);
  for (let k = 0; k < 50; k++) {
    for (let idx = 0; idx < 32; idx++) {
      const id = k * 1000 + idx;
      assert.equal(duel.idFromOrdinal(duel.ordinalOf(id)), id);
    }
  }
  // last planet of chunk k (idx 13) to first of chunk k+1 (idx 0): delta 19, fits a byte
  assert.equal(duel.ordinalOf(5000) - duel.ordinalOf(4013), 19);
  // idx beyond the ordinal slot is clamped, never aliases into the next chunk
  assert.equal(duel.ordinalOf(999), 31);
  assert.equal(duel.ordinalOf(-5), 0);
  assert.equal(duel.ordinalOf('abc'), 0);
});

test('base64url matches Buffer for 0..64 byte vectors and random data', () => {
  const rng = mulberry32(7);
  for (let len = 0; len <= 64; len++) {
    for (let rep = 0; rep < 3; rep++) {
      const bytes = Uint8Array.from({ length: len }, () => Math.floor(rng() * 256));
      const expected = Buffer.from(bytes).toString('base64url');
      const got = duel.base64urlEncode(bytes);
      assert.equal(got, expected, `encode len ${len}`);
      assert.ok(!/[+/=]/.test(got), 'no padding or standard chars');
      const back = duel.base64urlDecode(got);
      assert.deepEqual(Array.from(back), Array.from(bytes), `decode len ${len}`);
    }
  }
  // padding and standard alphabet are tolerated on input
  const std = Buffer.from([251, 255, 191, 0, 1]).toString('base64');
  assert.deepEqual(Array.from(duel.base64urlDecode(std)), [251, 255, 191, 0, 1]);
  // invalid input
  assert.equal(duel.base64urlDecode('abc$'), null);
  assert.equal(duel.base64urlDecode('a'), null);
  assert.equal(duel.base64urlDecode(42), null);
  assert.deepEqual(Array.from(duel.base64urlDecode('')), []);
});

test('recorder: 5 bytes per hop, hops count, first hop delta is the absolute ordinal', () => {
  const rec = duel.createRecorder();
  assert.equal(rec.hops, 0);
  rec.onLatch({ planetId: 3, theta: Math.PI / 2, r: 100, s: 1 });
  assert.equal(rec.hops, 0, 'pending hop not counted');
  rec.onRelease({ theta: Math.PI, heat: 0.5 });
  rec.onLatch({ planetId: 1002, theta: 0, r: 250, s: -1 });
  rec.onRelease({ theta: -Math.PI / 2, heat: 1 });
  assert.equal(rec.hops, 2);
  const bytes = rec.toBytes();
  assert.equal(bytes.length, 10);
  assert.deepEqual(Array.from(bytes.slice(0, 5)), [3, 64, 40, 128, 64 | 0x80]);
  assert.deepEqual(Array.from(bytes.slice(5, 10)), [34 - 3, 0, 100, 192, 127]);
  assert.equal(rec.toBase64Url(), Buffer.from(bytes).toString('base64url'));
});

test('recorder: title-orbit release without a latch records the start orbit (planet 0, r120, θ−π/2, s+1)', () => {
  const rec = duel.createRecorder();
  rec.onRelease({ theta: 0, heat: 0.3 });
  assert.equal(rec.hops, 1);
  const hop = duel.decode(duel.encode({ seed: 1, score: 0, altM: 0, path: rec.toBytes() })).path[0];
  assert.equal(hop.dPlanet, 0);
  assert.ok(Math.abs(hop.latchAngle - (3 * Math.PI / 2)) < 0.03);
  assert.equal(hop.r, 120);
  assert.equal(hop.s, 1);
  assert.ok(Math.abs(hop.heat - 0.3) < 0.01);
  // a custom start orbit is honoured
  const rec2 = duel.createRecorder({ start: { planetId: 2, theta: 0, r: 80, s: -1 } });
  rec2.onRelease({ theta: 1, heat: 0 });
  const b = rec2.toBytes();
  assert.equal(b[0], 2);
  assert.equal(b[2], 32);
  assert.equal(b[4] & 0x80, 0);
});

test('recorder: markRewound flags the pending hop, or re-opens the last latch with delta 0', () => {
  // death while tethered → rewind → release: same hop, flagged
  const a = duel.createRecorder();
  a.onLatch({ planetId: 4, theta: 0, r: 60, s: 1 });
  a.markRewound();
  a.onRelease({ theta: 1, heat: 0.2 });
  let bytes = a.toBytes();
  assert.equal(bytes.length, 5);
  assert.equal(bytes[2] & 0x80, 0x80);
  // death in flight → rewind → release from the same latch: new hop, dPlanet 0, flagged
  const b = duel.createRecorder();
  b.onLatch({ planetId: 4, theta: 0.5, r: 60, s: -1 });
  b.onRelease({ theta: 2, heat: 0.9 });
  b.markRewound();
  b.onRelease({ theta: 3, heat: 0.1 });
  bytes = b.toBytes();
  assert.equal(bytes.length, 10);
  assert.equal(bytes[5], 0, 'same planet');
  assert.equal(bytes[7] & 0x80, 0x80, 'rewound bit');
  assert.equal(bytes[6], bytes[1], 'same latch angle');
  assert.equal(bytes[4] & 0x80, 0, 's=-1 keeps dir bit clear');
  assert.equal(bytes[9] & 0x80, 0, 'direction copied from the latch');
});

test('recorder: planet deltas clamp to 0..255 (backward latch → 0, huge jump → 255) and hops cap at 300', () => {
  const rec = duel.createRecorder();
  rec.onLatch({ planetId: 2005, theta: 0, r: 50, s: 1 });
  rec.onRelease({ theta: 1, heat: 0 });
  rec.onLatch({ planetId: 2003, theta: 0, r: 50, s: 1 }); // backward
  rec.onRelease({ theta: 1, heat: 0 });
  rec.onLatch({ planetId: 90000, theta: 0, r: 50, s: 1 }); // far ahead
  rec.onRelease({ theta: 1, heat: 0 });
  const bytes = rec.toBytes();
  assert.equal(bytes[0], 2 * 32 + 5);
  assert.equal(bytes[5], 0);
  assert.equal(bytes[10], 255);
  for (let i = 0; i < 400; i++) {
    rec.onLatch({ planetId: i, theta: 0, r: 50, s: 1 });
    rec.onRelease({ theta: 0, heat: 0 });
  }
  assert.equal(rec.hops, 300);
  assert.equal(rec.toBytes().length, 1500);
  // bad input never throws
  rec.onLatch(null); rec.onRelease(undefined);
  rec.onLatch({ planetId: 'x', theta: NaN, r: Infinity, s: 0 });
  rec.onRelease({ theta: 'q', heat: 9 });
  assert.equal(rec.toBytes().length, 1500);
});

test('encode: payload format, base36 seed, path is last field', () => {
  const p = duel.encode({ seed: 123456789, score: 1240, altM: 980, name: 'Ali', path: null });
  assert.equal(p, 'd' + (123456789).toString(36) + '_1240_980_Ali');
  const rec = duel.createRecorder();
  rec.onLatch({ planetId: 1, theta: 0, r: 100, s: 1 });
  rec.onRelease({ theta: 1, heat: 0.5 });
  const withPath = duel.encode({ seed: 1, score: 2, altM: 3, name: 'Bo', path: rec.toBytes() });
  assert.equal(withPath, 'd1_2_3_Bo_' + rec.toBase64Url());
  assert.ok(/^d[0-9a-z]+_\d+_\d+_[A-Za-z0-9]{1,12}(_[A-Za-z0-9_-]+)?$/.test(withPath));
  // numerics are clamped, not rejected
  const weird = duel.encode({ seed: -4, score: -10, altM: 12.9, name: 'X' });
  assert.equal(weird, 'd0_0_12_X');
  const big = duel.encode({ seed: 2 ** 40, score: 1e12, altM: 'nope', name: 'X' });
  assert.equal(big, 'd' + (0xFFFFFFFF).toString(36) + '_1000000000_0_X');
  // paths shorter than one record are omitted
  assert.equal(duel.encode({ seed: 1, score: 1, altM: 1, name: 'A', path: new Uint8Array([1, 2, 3]) }), 'd1_1_1_A');
});

test('encode/decode roundtrip for random payloads including 300 hops (PAYLOAD_MAX raised)', () => {
  const wide = load({ config: { ...CONFIG, SHARE: { ...CONFIG.SHARE, PAYLOAD_MAX: 10000 } } }).duel;
  const rng = mulberry32(2026);
  for (let round = 0; round < 40; round++) {
    const hopCount = round === 0 ? 300 : Math.floor(rng() * 40);
    const hops = randomHops(wide, rng, hopCount);
    const { rec, sorted } = recordRun(wide, hops);
    const seed = Math.floor(rng() * 2 ** 32);
    const score = Math.floor(rng() * 5000);
    const altM = Math.floor(rng() * 4000);
    const name = 'Pl' + Math.floor(rng() * 1e6).toString(36);
    const payload = wide.encode({ seed, score, altM, name, path: rec.toBytes() });
    const d = wide.decode(payload);
    assert.ok(d, 'decodes');
    assert.equal(d.seed, seed);
    assert.equal(d.score, score);
    assert.equal(d.altM, altM);
    assert.equal(d.name, name.slice(0, 12));
    assert.equal(d.hasPath, hopCount > 0);
    assert.equal(d.path.length, hopCount);
    let ordinal = 0;
    sorted.forEach((h, i) => {
      const got = d.path[i];
      ordinal += got.dPlanet;
      assert.equal(wide.idFromOrdinal(ordinal), h.planetId, `planet ${i}`);
      assert.ok(angDiff(got.latchAngle, h.theta) <= Math.PI / 256 + 1e-9, `latch angle ${i}`);
      assert.ok(angDiff(got.releaseAngle, h.releaseTheta) <= Math.PI / 256 + 1e-9, `release angle ${i}`);
      assert.ok(Math.abs(got.r - h.r) <= 1.25 + 1e-9, `radius ${i}`);
      assert.ok(Math.abs(got.heat - h.heat) <= 0.5 / 127 + 1e-9, `heat ${i}`);
      assert.equal(got.s, h.s, `dir ${i}`);
      assert.equal(got.rewound, false);
    });
    if (hopCount === 300) assert.ok(payload.length > 1500, '300 hops exceed the default cap');
  }
});

test('truncation at PAYLOAD_MAX drops only the path; shorter paths survive', () => {
  const rng = mulberry32(99);
  const long = recordRun(duel, randomHops(duel, rng, 300)).rec;
  const dropped = duel.encode({ seed: 77, score: 500, altM: 400, name: 'Long', path: long.toBytes() });
  assert.equal(dropped, 'd' + (77).toString(36) + '_500_400_Long');
  assert.ok(dropped.length <= CONFIG.SHARE.PAYLOAD_MAX);
  const d = duel.decode(dropped);
  assert.deepEqual(plain(d), { seed: 77, score: 500, altM: 400, name: 'Long', path: [], hasPath: false });

  const short = recordRun(duel, randomHops(duel, rng, 200)).rec;
  const kept = duel.encode({ seed: 77, score: 500, altM: 400, name: 'Long', path: short.toBytes() });
  assert.ok(kept.length <= 1500 && kept.length > 1300, `200 hops fit (${kept.length})`);
  assert.equal(duel.decode(kept).path.length, 200);
  // exactly at the cap is allowed
  const head = 'd' + (77).toString(36) + '_500_400_Long_';
  const hopsThatFit = Math.floor(((1500 - head.length) * 3 / 4) / 5);
  const exact = recordRun(duel, randomHops(duel, rng, hopsThatFit)).rec;
  const exactPayload = duel.encode({ seed: 77, score: 500, altM: 400, name: 'Long', path: exact.toBytes() });
  assert.ok(exactPayload.length <= 1500 && duel.decode(exactPayload).hasPath);
});

test('name sanitization: strips non-alphanumerics, caps at NAME_MAX, defaults to You', () => {
  assert.equal(duel.sanitizeName('Ali Veli!'), 'AliVeli');
  assert.equal(duel.sanitizeName('  Ömer_<script>  '), 'merscript');
  assert.equal(duel.sanitizeName('abcdefghijklmnop'), 'abcdefghijkl');
  assert.equal(duel.sanitizeName(''), 'You');
  assert.equal(duel.sanitizeName(null), 'You');
  assert.equal(duel.sanitizeName('🚀🚀'), 'You');
  assert.equal(duel.encode({ seed: 1, score: 1, altM: 1, name: 'a-b c' }), 'd1_1_1_abc');
  assert.equal(duel.decode('d1_1_1_<b>hi</b>').name, 'bhib');
  assert.equal(duel.decode('d1_1_1_').name, 'You');
  assert.equal(duel.decode('d1_1_1_WayTooLongNameHere').name, 'WayTooLongNa');
  const tight = load({ config: { ...CONFIG, SHARE: { ...CONFIG.SHARE, NAME_MAX: 4 } } }).duel;
  assert.equal(tight.sanitizeName('Alexander'), 'Alex');
});

test('decode: tolerant on numerics and bad paths, null on garbage / overlong', () => {
  // leading '#' tolerated, uppercase seed tolerated, whitespace trimmed
  assert.equal(duel.decode('#dZZ_1_2_A').seed, parseInt('zz', 36));
  assert.equal(duel.decode('  d1_1_2_A  ').altM, 2);
  // clamps
  assert.equal(duel.decode('d1_99999999999999_2_A').score, 1e9);
  // bad path → no path, rest kept
  const badPath = duel.decode('d1_5_6_A_$$$$');
  assert.equal(badPath.hasPath, false);
  assert.equal(badPath.score, 5);
  // trailing partial record ignored, empty path field tolerated
  assert.equal(duel.decode('d1_5_6_A_' + Buffer.from([1, 2, 3, 4, 5, 6]).toString('base64url')).path.length, 1);
  assert.equal(duel.decode('d1_5_6_A_').hasPath, false);
  // path containing '_' and '-' survives the split
  const bytes = Uint8Array.from({ length: 60 }, (_, i) => (i * 97 + 251) & 255);
  const p = 'd1_5_6_A_' + Buffer.from(bytes).toString('base64url');
  assert.ok(/[-_]/.test(p.slice(10)), 'vector exercises both url chars');
  assert.deepEqual(Array.from(duel.decode(p).path.map((h) => h.dPlanet)), Array.from(bytes.filter((_, i) => i % 5 === 0)));
  // garbage
  for (const bad of ['', 'd', 'x1_1_1_A', 'd1_1_1', 'd_1_1_A', 'd1_a_1_A', 'd1_1_b_A', 'd1_-1_1_A', 'd1_1.5_1_A',
    'dzzzzzzzz_1_1_A', 'd' + (2 ** 32).toString(36) + '_1_1_A', 'd1__1_A', 20260105, null, undefined, {}, 'd1_1_1_A'.padEnd(9000, 'A')]) {
    assert.equal(duel.decode(bad), null, `garbage: ${String(bad).slice(0, 30)}`);
  }
  // seed at the uint32 ceiling is fine
  assert.equal(duel.decode('d' + (0xFFFFFFFF).toString(36) + '_1_1_A').seed, 0xFFFFFFFF);
});

test('readFromLocation: hash payload wins, hash tolerates percent-encoding', () => {
  const payload = duel.encode({ seed: 42, score: 300, altM: 200, name: 'Ali' });
  let r = load({ config: CONFIG, hash: '#' + payload, search: '?d=20260105' }).duel.readFromLocation();
  assert.equal(r.kind, 'duel');
  assert.equal(r.decoded.seed, 42);
  assert.equal(r.decoded.name, 'Ali');
  r = load({ config: CONFIG, hash: '#' + encodeURIComponent(payload) }).duel.readFromLocation();
  assert.equal(r.decoded.score, 300);
  // non-duel hash falls through
  assert.equal(load({ config: CONFIG, hash: '#settings' }).duel.readFromLocation(), null);
  assert.equal(load({ config: CONFIG }).duel.readFromLocation(), null);
});

test('readFromLocation: ?d=YYYYMMDD → daily, ?d=payload → duel, invalid date ignored', () => {
  let r = load({ config: CONFIG, search: '?x=1&d=20260105' }).duel.readFromLocation();
  assert.deepEqual(plain(r), { kind: 'daily', dateKey: '20260105' });
  r = load({ config: CONFIG, search: '?d=' + duel.encode({ seed: 5, score: 1, altM: 1, name: 'Q' }) }).duel.readFromLocation();
  assert.equal(r.kind, 'duel');
  assert.equal(r.decoded.seed, 5);
  assert.equal(load({ config: CONFIG, search: '?d=20261399' }).duel.readFromLocation(), null);
  assert.equal(load({ config: CONFIG, search: '?d=2026010' }).duel.readFromLocation(), null);
  assert.equal(load({ config: CONFIG, search: '?d=' }).duel.readFromLocation(), null);
});

test('readFromLocation: G.sdk.getParam d / startapp fallbacks, errors swallowed', () => {
  const payload = duel.encode({ seed: 9, score: 50, altM: 40, name: 'Tg' });
  const calls = [];
  const sdk = { getParam: (n) => { calls.push(n); return n === 'startapp' ? payload : null; } };
  let r = load({ config: CONFIG, sdk }).duel.readFromLocation();
  assert.equal(r.kind, 'duel');
  assert.equal(r.decoded.seed, 9);
  assert.deepEqual(calls, ['d', 'startapp']);
  r = load({ config: CONFIG, sdk: { getParam: (n) => (n === 'd' ? '20260301' : null) } }).duel.readFromLocation();
  assert.deepEqual(plain(r), { kind: 'daily', dateKey: '20260301' });
  r = load({ config: CONFIG, sdk: { getParam: () => { throw new Error('boom'); } } }).duel.readFromLocation();
  assert.equal(r, null);
  r = load({ config: CONFIG, sdk: {} }).duel.readFromLocation();
  assert.equal(r, null);
});

test('readFromLocation: raw Telegram start_param (whole payload, k1-v1 style, tgWebAppStartParam hash)', () => {
  const payload = duel.encode({ seed: 11, score: 10, altM: 5, name: 'Raw' });
  const tg = (start_param) => ({ WebApp: { initDataUnsafe: { start_param } } });
  let r = load({ config: CONFIG, telegram: tg(payload) }).duel.readFromLocation();
  assert.equal(r.kind, 'duel');
  assert.equal(r.decoded.seed, 11);
  // the k1-v1 style G.sdk uses ('d-20260105_ref-abc')
  r = load({ config: CONFIG, telegram: tg('ref-abc_d-20260105') }).duel.readFromLocation();
  assert.deepEqual(plain(r), { kind: 'daily', dateKey: '20260105' });
  // G.sdk.tg object preferred when present
  r = load({ config: CONFIG, sdk: { tg: { initDataUnsafe: { start_param: '20260202' } } } }).duel.readFromLocation();
  assert.deepEqual(plain(r), { kind: 'daily', dateKey: '20260202' });
  // Telegram puts the start param in the hash as a k=v list
  r = load({ config: CONFIG, hash: '#tgWebAppData=x&tgWebAppStartParam=' + payload + '&tgWebAppVersion=7' }).duel.readFromLocation();
  assert.equal(r.kind, 'duel');
  assert.equal(r.decoded.name, 'Raw');
  // garbage start_param
  assert.equal(load({ config: CONFIG, telegram: tg('hello') }).duel.readFromLocation(), null);
});

test('buildLinks: web hash link, telegram link only when TELEGRAM_APP is set, best prefers telegram', () => {
  const payload = 'd1_2_3_A';
  let links = duel.buildLinks(payload);
  assert.equal(links.web, CONFIG.SHARE.APP_URL + '#' + payload);
  assert.equal(links.telegram, null);
  assert.equal(links.best, links.web);
  const tgDuel = load({ config: { ...CONFIG, SHARE: { ...CONFIG.SHARE, TELEGRAM_APP: 'tetherbot/play' } } }).duel;
  links = tgDuel.buildLinks(payload);
  assert.equal(links.telegram, 'https://t.me/tetherbot/play?startapp=' + payload);
  assert.equal(links.best, links.telegram);
  // no G.CONFIG at all → current page without hash
  const bare = load({ href: 'https://host.test/game/index.html#old', hash: '#old' }).duel;
  assert.equal(bare.buildLinks(payload).web, 'https://host.test/game/index.html#' + payload);
});

test('shareText: placeholders resolved via real G.i18n (en + tr), url from payload, daily and cosmos labels', () => {
  const { duel: d, G } = load({ config: CONFIG, withI18n: true });
  G.i18n.init({ lang: 'en' });
  const payload = d.encode({ seed: 46655, score: 1240, altM: 980, name: 'Ali' });
  const text = d.shareText({ name: 'Ali', score: 1240, mode: 'daily', dailyNumber: 277, seed: 46655, payload });
  assert.ok(!/\{(score|url|n|seed|name)\}/.test(text), 'no unresolved placeholders');
  assert.ok(text.includes('1,240'), 'formatted score');
  assert.ok(text.includes(CONFIG.SHARE.APP_URL + '#' + payload), 'link');
  assert.ok(text.includes('Daily #277'));
  assert.ok(text.includes('Ali'));
  assert.ok(text.includes('I scored 1,240'));
  const free = d.shareText({ name: 'Ali', score: 90, mode: 'free', seed: 46655, url: 'https://x.y/#p' });
  assert.ok(free.includes('Cosmos zzz'));
  assert.ok(free.endsWith('https://x.y/#p'));
  G.i18n.setLang('tr');
  const tr = d.shareText({ name: 'Ali', score: 1240, mode: 'free', seed: 1, url: 'https://x.y/#p' });
  assert.ok(tr.includes('1.240') && tr.includes('puan') && tr.includes('https://x.y/#p'));
});

test('shareText: English fallback without G.i18n, defaults when fields are missing', () => {
  const text = duel.shareText({ score: 15 });
  assert.ok(text.startsWith('You · Tetherloop · Cosmos 0\n'));
  assert.ok(text.includes('I scored 15'));
  assert.ok(text.includes(CONFIG.SHARE.APP_URL));
  assert.ok(!/\{\w+\}/.test(text));
  assert.equal(typeof duel.shareText(), 'string');
});

/** Synthetic cosmos for the ghost: main chain climbing 240 px per planet. */
function syntheticLookup() {
  const planets = new Map();
  for (let k = 0; k < 4; k++) {
    for (let idx = 0; idx < 8; idx++) {
      planets.set(k * 1000 + idx, { x0: 180 + ((k * 8 + idx) % 4) * 60, y: k * 2000 + idx * 240, R: 40 });
    }
  }
  return (id) => planets.get(id) || null;
}

test('expandPath: arc + curve per hop, finite coords, arc sweeps in direction s, curve joins the next latch point', () => {
  const rec = duel.createRecorder();
  const hops = [
    { planetId: 0, theta: -Math.PI / 2, r: 120, s: 1, release: 0.3, heat: 0.2 },
    { planetId: 1, theta: 0.2, r: 70, s: -1, release: 2.5, heat: 0.9 },
    { planetId: 3, theta: 3, r: 150, s: 1, release: 1, heat: 0 },
    { planetId: 1000, theta: 1, r: 60, s: -1, release: 1, heat: 0.5 },
    { planetId: 1001, theta: 5, r: 90, s: 1, release: 4, heat: 1 }
  ];
  for (const h of hops) {
    rec.onLatch({ planetId: h.planetId, theta: h.theta, r: h.r, s: h.s });
    rec.onRelease({ theta: h.release, heat: h.heat });
  }
  const decoded = duel.decode(duel.encode({ seed: 1, score: 1, altM: 1, name: 'G', path: rec.toBytes() }));
  const lookup = syntheticLookup();
  const ghost = duel.expandPath(decoded, lookup);
  assert.equal(ghost.length, 10);
  for (let i = 0; i < ghost.length; i++) {
    const seg = ghost[i];
    assert.equal(seg.type, i % 2 === 0 ? 'arc' : 'curve');
    if (seg.type === 'arc') {
      for (const k of ['cx', 'cy', 'r', 'from', 'to']) assert.ok(Number.isFinite(seg[k]), `${k} finite`);
      const hop = hops[i / 2];
      const planet = lookup(hop.planetId);
      assert.equal(seg.cx, planet.x0);
      assert.equal(seg.cy, planet.y);
      assert.equal(seg.s, hop.s);
      assert.equal(seg.planetId, hop.planetId);
      assert.ok(hop.s > 0 ? seg.to >= seg.from : seg.to <= seg.from, 'sweep follows s');
      assert.ok(Math.abs(seg.to - seg.from) <= TWO_PI + 1e-9);
      // endpoint angle equals the recorded release angle modulo 2π
      assert.ok(angDiff(seg.to, hop.release) <= Math.PI / 256 + 1e-9, 'arc ends at the release angle');
    } else {
      assert.ok(seg.pts.length >= 2);
      for (const [x, y] of seg.pts) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y));
        assert.ok(x >= 9 - 1e-9 && x <= 531 + 1e-9, `x inside the column (${x})`);
      }
      assert.ok(seg.pts.length <= 1 + 1.5 * 30 + 1);
      // the curve starts at the arc's release point
      const arc = ghost[i - 1];
      assert.ok(Math.abs(seg.pts[0][0] - (arc.cx + arc.r * Math.cos(arc.to))) < 1e-9);
      assert.ok(Math.abs(seg.pts[0][1] - (arc.cy + arc.r * Math.sin(arc.to))) < 1e-9);
      const nextArc = ghost[i + 1];
      const last = seg.pts[seg.pts.length - 1];
      if (nextArc) {
        assert.ok(Math.abs(last[0] - (nextArc.cx + nextArc.r * Math.cos(nextArc.from))) < 1e-9, 'joins next latch x');
        assert.ok(Math.abs(last[1] - (nextArc.cy + nextArc.r * Math.sin(nextArc.from))) < 1e-9, 'joins next latch y');
      } else {
        assert.equal(seg.pts.length, 1 + 1.5 * 30, 'final flight runs the full 1.5 s');
      }
    }
  }
  // speed scales with heat: hotter release travels further in the first sample
  const cold = ghost[5].pts, hot = ghost[3].pts;
  const stepLen = (pts) => Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  assert.ok(stepLen(hot) > stepLen(cold));
});

test('expandPath: unknown planets skipped, bad input tolerated, deterministic', () => {
  assert.deepEqual(plain(duel.expandPath(null, () => null)), []);
  assert.deepEqual(plain(duel.expandPath({ path: [] }, () => null)), []);
  assert.deepEqual(plain(duel.expandPath({ path: [{ dPlanet: 0 }] }, 'nope')), []);
  const decoded = { path: [
    { dPlanet: 0, latchAngle: 0, r: 100, rewound: false, releaseAngle: 1, heat: 0.5, s: 1 },
    { dPlanet: 7, latchAngle: 0, r: 100, rewound: true, releaseAngle: 1, heat: 0.5, s: 1 }, // id 7 → unknown below
    { dPlanet: 25, latchAngle: NaN, r: NaN, rewound: false, releaseAngle: 'x', heat: 3, s: -1 } // id 1000
  ] };
  const lookup = (id) => (id === 7 ? undefined : syntheticLookup()(id));
  const a = duel.expandPath(decoded, lookup);
  assert.equal(a.length, 4, 'two hops drawn, the unknown one skipped');
  assert.equal(a[2].planetId, 1000);
  assert.equal(a[2].r, 0);
  for (const seg of a) {
    if (seg.type === 'curve') for (const [x, y] of seg.pts) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
  assert.deepEqual(plain(duel.expandPath(decoded, lookup)), plain(a));
  // a lookup that throws is treated as unknown
  assert.deepEqual(plain(duel.expandPath(decoded, () => { throw new Error('gen failed'); })), []);
});

test('expandPath honours G.CONFIG physics when present', () => {
  const decoded = { path: [{ dPlanet: 0, latchAngle: 0, r: 100, rewound: false, releaseAngle: Math.PI / 2, heat: 0, s: 1 }] };
  const fast = load({ config: { ...CONFIG, V_ORBIT: 840 } }).duel.expandPath(decoded, syntheticLookup());
  const normal = duel.expandPath(decoded, syntheticLookup());
  const dx = (segs) => Math.abs(segs[1].pts[1][0] - segs[1].pts[0][0]);
  assert.ok(Math.abs(dx(fast) - 2 * dx(normal)) < 1e-6);
});

// ---------------------------------------------------------------------------
// Playwright: real location.hash in Chromium
// ---------------------------------------------------------------------------
console.log('# duel (chromium)');

const browser = await chromium.launch();
const SCRATCH = process.env.CLAUDE_SCRATCHPAD || fs.mkdtempSync(path.join(os.tmpdir(), 'duel-test-'));
const hostHtml = path.join(SCRATCH, 'duel-host.html');
fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(hostHtml, '<!doctype html><html><head><meta charset="utf-8"><title>duel host</title>' +
  '<script src="file://' + DUEL_PATH + '"></script></head><body></body></html>');
try {
  const payload = duel.encode({ seed: 777, score: 640, altM: 512, name: 'Browser', path: (() => {
    const rec = duel.createRecorder();
    rec.onLatch({ planetId: 0, theta: 0, r: 120, s: 1 });
    rec.onRelease({ theta: 1, heat: 0.4 });
    return rec.toBytes();
  })() });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await testAsync('readFromLocation reads #payload from a real file:// location and decodes the path', async () => {
    await page.goto('file://' + hostHtml + '#' + payload);
    const r = await page.evaluate(() => G.duel.readFromLocation());
    assert.equal(r.kind, 'duel');
    assert.equal(r.decoded.seed, 777);
    assert.equal(r.decoded.name, 'Browser');
    assert.equal(r.decoded.hasPath, true);
    assert.equal(r.decoded.path.length, 1);
    await page.goto('file://' + hostHtml + '?d=20260105');
    assert.deepEqual(await page.evaluate(() => G.duel.readFromLocation()), { kind: 'daily', dateKey: '20260105' });
    await page.goto('file://' + hostHtml);
    assert.equal(await page.evaluate(() => G.duel.readFromLocation()), null);
  });

  await testAsync('browser roundtrip: encode → decode → expandPath yields finite geometry; no page errors', async () => {
    const out = await page.evaluate(() => {
      const rec = G.duel.createRecorder();
      for (let i = 0; i < 20; i++) { rec.onLatch({ planetId: i, theta: i, r: 60 + i * 5, s: i % 2 ? 1 : -1 }); rec.onRelease({ theta: i + 1, heat: (i % 10) / 10 }); }
      const p = G.duel.encode({ seed: 1, score: 2, altM: 3, name: 'B', path: rec.toBytes() });
      const d = G.duel.decode(p);
      const ghost = G.duel.expandPath(d, (id) => ({ x0: 100 + (id % 5) * 80, y: id * 230, R: 40 }));
      return { hops: d.path.length, segs: ghost.length, finite: ghost.every((s) => s.type === 'arc' ? [s.cx, s.cy, s.r, s.from, s.to].every(Number.isFinite) : s.pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) };
    });
    assert.deepEqual(out, { hops: 20, segs: 40, finite: true });
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  fs.rmSync(hostHtml, { force: true });
}

console.log(`\n${passed} tests passed`);
