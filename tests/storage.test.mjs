// Tests for game/js/storage.js (G.storage).
// Run: node tests/storage.test.mjs
//
// Node part: the classic script is evaluated inside a vm context with a tiny
// window/localStorage shim (plus throwing variants) and a controllable clock.
// Browser part: Playwright + Chromium prove the file works from file:// with
// real localStorage/CustomEvent and falls back on an opaque origin.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(here, '../game/js/storage.js');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deep equality for values that may come from another realm (the vm context or
 * the browser): structuredClone re-creates them with this realm's prototypes so
 * strict deep comparison can be used.
 */
const deepEq = (actual, expected) => assert.deepEqual(structuredClone(actual), expected);

/* ------------------------------------------------------------------ */
/* Shims                                                                */
/* ------------------------------------------------------------------ */

/** Minimal Web Storage implementation backed by a Map. */
function makeLocalStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
    _map: m,
  };
}

/**
 * Evaluates storage.js in a fresh context.
 * @param {{ls?:object, denyAccess?:boolean, search?:string, now?:number}} opts
 */
function load(opts = {}) {
  const ls = opts.ls ?? makeLocalStorage();
  const clock = { now: opts.now ?? 1_000_000 };
  const win = new EventTarget();
  Object.defineProperty(win, 'localStorage', {
    get() {
      if (opts.denyAccess) throw new DOMException('Access denied', 'SecurityError');
      return ls;
    },
  });
  win.location = { search: opts.search ?? '' };
  win.CustomEvent = CustomEvent;
  win.document = { hidden: false, addEventListener() {} };
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const sandbox = { window: win, console, setTimeout, clearTimeout, Date: FakeDate };
  vm.runInNewContext(SCRIPT, sandbox, { filename: 'storage.js' });
  const events = [];
  win.addEventListener('g:storage', (e) => events.push(e.detail));
  return { G: win.G, S: win.G.storage, win, ls, clock, events };
}

/** Records every call and lets tests script the responses. */
function makeMirror(name, store = new Map(), options = {}) {
  const calls = [];
  const mirror = {
    name,
    store,
    calls,
    ...options,
    async get(key) { calls.push(['get', key]); return store.has(key) ? store.get(key) : null; },
    async set(key, value) { calls.push(['set', key, value]); store.set(key, value); },
    async remove(key) { calls.push(['remove', key]); store.delete(key); },
  };
  return mirror;
}

const env = (v, ts) => JSON.stringify({ v, _ts: ts });

/* ------------------------------------------------------------------ */
/* Core API                                                             */
/* ------------------------------------------------------------------ */

describe('init and availability', () => {
  test('detects working localStorage and leaves no probe key behind', () => {
    const { S, ls } = load();
    assert.equal(S.init(), true);
    assert.equal(S.available, true);
    assert.equal(ls.length, 0);
    assert.equal(S.PREFIX, 'g1.');
  });

  test('init is idempotent and lazy (set before init works)', () => {
    const { S } = load();
    assert.equal(S.set('a', 1), true);
    assert.equal(S.available, true);
    assert.equal(S.init(), true);
    assert.equal(S.get('a'), 1);
  });

  test('sets G.DEBUG from ?debug=1 and defines G.log', () => {
    const on = load({ search: '?x=1&debug=1' });
    assert.equal(on.G.DEBUG, true);
    assert.equal(typeof on.G.log, 'function');
    const off = load({ search: '?debug=0' });
    assert.equal(off.G.DEBUG, false);
  });

  test('seeds the manifest from existing prefixed keys only', () => {
    const ls = makeLocalStorage();
    ls.setItem('g1.foo', env(1, 5));
    ls.setItem('g1.bar', env(2, 6));
    ls.setItem('other.baz', 'x');
    ls.setItem('g1', 'not-prefixed-enough');
    const { S } = load({ ls });
    deepEq(S.keys(), ['bar', 'foo']);
    assert.equal(S.get('foo'), 1);
  });
});

describe('set / get / remove / keys', () => {
  test('round-trips every JSON type and stores an envelope under the prefixed key', () => {
    const { S, ls, clock } = load({ now: 42 });
    const samples = { n: 3.5, s: 'héllo', b: false, z: null, o: { a: [1, { b: 2 }] }, arr: [1, 'x', null] };
    for (const [k, v] of Object.entries(samples)) assert.equal(S.set(k, v), true);
    for (const [k, v] of Object.entries(samples)) deepEq(S.get(k), v);
    deepEq(JSON.parse(ls.getItem('g1.n')), { v: 3.5, _ts: 42 });
    assert.equal(S.timestamp('n'), 42);
    clock.now = 99;
    S.set('n', 4);
    assert.equal(S.timestamp('n'), 99);
    deepEq(S.keys(), ['arr', 'b', 'n', 'o', 's', 'z']);
  });

  test('bumps rev on every mutation and get returns the fallback for missing keys', () => {
    const { S } = load();
    const r0 = S.rev;
    S.set('k', 1);
    assert.equal(S.rev, r0 + 1);
    S.remove('k');
    assert.equal(S.rev, r0 + 2);
    assert.equal(S.get('k', 'fb'), 'fb');
    assert.equal(S.get('k'), undefined);
  });

  test('remove reports existence and clears the manifest', () => {
    const { S, ls } = load();
    S.set('k', 1);
    assert.equal(S.remove('k'), true);
    assert.equal(S.remove('k'), false);
    assert.equal(ls.getItem('g1.k'), null);
    deepEq(S.keys(), []);
  });

  test('set(key, undefined) removes; invalid keys and unserialisable values are rejected', () => {
    const { S } = load();
    S.set('k', 1);
    S.set('k', undefined);
    assert.equal(S.get('k', 'gone'), 'gone');
    assert.equal(S.set('', 1), false);
    assert.equal(S.set(123, 1), false);
    assert.equal(S.get(null, 'fb'), 'fb');
    assert.equal(S.remove(undefined), false);
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(S.set('cyc', cyclic), false);
    deepEq(S.keys(), []);
  });
});

describe('in-memory fallback', () => {
  test('localStorage access throwing (sandboxed iframe) falls back to memory', () => {
    const { S, ls } = load({ denyAccess: true });
    assert.equal(S.init(), false);
    assert.equal(S.available, false);
    assert.equal(S.set('score', 10), true);
    assert.equal(S.get('score'), 10);
    deepEq(S.keys(), ['score']);
    assert.equal(S.remove('score'), true);
    assert.equal(S.get('score', 0), 0);
    assert.equal(ls.length, 0);
  });

  test('setItem throwing during the probe (private mode quota) falls back to memory', () => {
    const ls = makeLocalStorage();
    ls.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    const { S } = load({ ls });
    assert.equal(S.available, false);
    S.set('a', { x: 1 });
    deepEq(S.get('a'), { x: 1 });
  });

  test('a write failing mid-session is kept in memory and still readable', () => {
    const { S, ls } = load();
    S.set('ok', 1);
    const realSet = ls.setItem.bind(ls);
    ls.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    assert.equal(S.set('big', 'payload'), true);
    assert.equal(S.get('big'), 'payload');
    deepEq(S.keys(), ['big', 'ok']);
    ls.setItem = realSet;
    S.set('big', 'again');
    assert.equal(ls.getItem('g1.big') !== null, true);
    assert.equal(S.get('big'), 'again');
  });
});

describe('corruption tolerance', () => {
  test('corrupted JSON yields the fallback and does not throw', () => {
    const ls = makeLocalStorage();
    ls.setItem('g1.bad', '{"v": oops');
    const { S } = load({ ls });
    assert.equal(S.get('bad', 'fb'), 'fb');
    assert.equal(S.timestamp('bad'), 0);
    deepEq(S.keys(), ['bad']);
    assert.equal(S.set('bad', 1), true);
    assert.equal(S.get('bad'), 1);
  });

  test('legacy raw JSON values (no envelope) are readable with timestamp 0', () => {
    const ls = makeLocalStorage();
    ls.setItem('g1.legacy', '42');
    ls.setItem('g1.legacyObj', '{"a":1}');
    ls.setItem('g1.legacyArr', '[1,2]');
    const { S } = load({ ls });
    assert.equal(S.get('legacy'), 42);
    deepEq(S.get('legacyObj'), { a: 1 });
    deepEq(S.get('legacyArr'), [1, 2]);
    assert.equal(S.timestamp('legacy'), 0);
  });
});

describe('events', () => {
  test("dispatches 'g:storage' with key and source on set and remove", () => {
    const { S, events } = load();
    S.set('a', 1);
    S.remove('a');
    deepEq(events, [
      { key: 'a', source: 'local' },
      { key: 'a', source: 'local' },
    ]);
  });

  test('a missing CustomEvent constructor is tolerated', () => {
    const { S, win } = load();
    win.CustomEvent = undefined;
    assert.equal(S.set('a', 1), true);
    assert.equal(S.get('a'), 1);
  });
});

/* ------------------------------------------------------------------ */
/* Mirrors                                                              */
/* ------------------------------------------------------------------ */

describe('mirrors: debounced push', () => {
  test('uses the default 800ms debounce and coalesces rapid writes into one push', async () => {
    const { S } = load({ now: 7 });
    assert.equal(S.debounceMs, 800);
    const m = makeMirror('cloud');
    S.attachMirror(m);
    S.set('score', 1);
    S.set('score', 2);
    S.set('score', 3);
    await sleep(500);
    deepEq(m.calls, []);
    await sleep(500);
    // Three writes in the same millisecond get strictly increasing stamps (7, 8, 9).
    deepEq(m.calls, [['set', 'score', env(3, 9)]]);
  });

  test('pushes the raw envelope string, unprefixed key, to every mirror', async () => {
    const { S } = load({ now: 11 });
    S.debounceMs = 20;
    const a = makeMirror('a');
    const b = makeMirror('b');
    S.attachMirror(a);
    S.attachMirror(b);
    S.set('x', { hi: true });
    await sleep(60);
    deepEq(a.calls, [['set', 'x', env({ hi: true }, 11)]]);
    deepEq(b.calls, [['set', 'x', env({ hi: true }, 11)]]);
    deepEq(JSON.parse(a.store.get('x')), { v: { hi: true }, _ts: 11 });
  });

  test('remove is pushed immediately and cancels a pending set push', async () => {
    const { S } = load();
    S.debounceMs = 30;
    const m = makeMirror('cloud');
    S.attachMirror(m);
    S.set('x', 1);
    S.remove('x');
    await sleep(70);
    deepEq(m.calls, [['remove', 'x']]);
  });

  test('flush() delivers pending pushes right away', async () => {
    const { S } = load({ now: 3 });
    const m = makeMirror('cloud');
    S.attachMirror(m);
    S.set('x', 1);
    S.flush();
    deepEq(m.calls, [['set', 'x', env(1, 3)]]);
    await sleep(850);
    assert.equal(m.calls.length, 1);
  });

  test('mirror failures (sync throw, rejection) are swallowed', async () => {
    const { S } = load();
    S.debounceMs = 10;
    const thrower = { name: 'thrower', get() { throw new Error('x'); }, set() { throw new Error('x'); }, remove() { throw new Error('x'); } };
    const rejecter = { name: 'rejecter', get: async () => { throw new Error('y'); }, set: async () => { throw new Error('y'); }, remove: async () => { throw new Error('y'); } };
    S.attachMirror(thrower);
    S.attachMirror(rejecter);
    assert.equal(S.set('x', 1), true);
    assert.equal(S.remove('x'), true);
    S.set('y', 2);
    await sleep(40);
    await S.pullMirrors(['y']);
    assert.equal(S.get('y'), 2);
  });

  test('attachMirror validates, replaces same-name mirrors and returns a detach function', async () => {
    const { S } = load();
    S.debounceMs = 10;
    assert.equal(typeof S.attachMirror(null), 'function');
    assert.equal(typeof S.attachMirror({ name: 'nope' }), 'function');
    deepEq(S.mirrorNames(), []);
    const first = makeMirror('cloud');
    const second = makeMirror('cloud');
    S.attachMirror(first);
    const detach = S.attachMirror(second);
    deepEq(S.mirrorNames(), ['cloud']);
    S.set('x', 1);
    await sleep(40);
    assert.equal(first.calls.length, 0);
    assert.equal(second.calls.length, 1);
    detach();
    deepEq(S.mirrorNames(), []);
    assert.equal(S.detachMirror('cloud'), false);
    S.set('x', 2);
    await sleep(40);
    assert.equal(second.calls.length, 1);
  });

  test('respects an optional maxLength on the mirror', async () => {
    const { S } = load();
    S.debounceMs = 10;
    const m = makeMirror('tg', new Map(), { maxLength: 40 });
    S.attachMirror(m);
    S.set('small', 1);
    S.set('large', 'x'.repeat(100));
    await sleep(40);
    deepEq(m.calls.map((c) => c[1]), ['small']);
  });
});

describe('mirrors: pullMirrors merge rules', () => {
  test('newer mirror copy wins: local updated, timestamp kept, event + rev', async () => {
    const { S, events } = load({ now: 100 });
    S.set('score', 5);
    const m = makeMirror('cloud', new Map([['score', env(9, 200)]]));
    S.attachMirror(m);
    const rev = S.rev;
    events.length = 0;
    await S.pullMirrors(['score']);
    assert.equal(S.get('score'), 9);
    assert.equal(S.timestamp('score'), 200);
    assert.equal(S.rev, rev + 1);
    deepEq(events, [{ key: 'score', source: 'mirror:cloud' }]);
    deepEq(m.calls, [['get', 'score']]);
  });

  test('newer local copy wins: pushed to the mirror, local untouched', async () => {
    const { S, events } = load({ now: 300 });
    S.set('score', 5);
    const m = makeMirror('cloud', new Map([['score', env(9, 200)]]));
    S.attachMirror(m);
    events.length = 0;
    const rev = S.rev;
    await S.pullMirrors(['score']);
    assert.equal(S.get('score'), 5);
    assert.equal(S.rev, rev);
    deepEq(events, []);
    deepEq(m.calls, [['get', 'score'], ['set', 'score', env(5, 300)]]);
  });

  test('missing on the mirror → local pushed; missing locally → mirror adopted', async () => {
    const { S } = load({ now: 50 });
    S.set('onlyLocal', 'L');
    const m = makeMirror('cloud', new Map([['onlyRemote', env('R', 10)]]));
    S.attachMirror(m);
    await S.pullMirrors(['onlyLocal', 'onlyRemote']);
    assert.equal(m.store.get('onlyLocal'), env('L', 50));
    assert.equal(S.get('onlyRemote'), 'R');
    assert.equal(S.timestamp('onlyRemote'), 10);
    deepEq(S.keys(), ['onlyLocal', 'onlyRemote']);
  });

  test('equal timestamps are left alone', async () => {
    const { S } = load({ now: 77 });
    S.set('k', 'same');
    const m = makeMirror('cloud', new Map([['k', env('same', 77)]]));
    S.attachMirror(m);
    await S.pullMirrors(['k']);
    deepEq(m.calls, [['get', 'k']]);
  });

  test('corrupted or legacy mirror values lose to timestamped local copies', async () => {
    const { S } = load({ now: 5 });
    S.set('a', 1);
    S.set('b', 2);
    const m = makeMirror('cloud', new Map([['a', '{broken'], ['b', '"legacy"']]));
    S.attachMirror(m);
    await S.pullMirrors(['a', 'b']);
    assert.equal(S.get('a'), 1);
    assert.equal(S.get('b'), 2);
    assert.equal(m.store.get('a'), env(1, 5));
    assert.equal(m.store.get('b'), env(2, 5));
  });

  test('with several mirrors the newest copy propagates everywhere else', async () => {
    const { S } = load({ now: 100 });
    S.set('k', 'local');
    const older = makeMirror('older', new Map([['k', env('old', 50)]]));
    const newest = makeMirror('newest', new Map([['k', env('new', 150)]]));
    const empty = makeMirror('empty');
    S.attachMirror(older);
    S.attachMirror(newest);
    S.attachMirror(empty);
    await S.pullMirrors(['k']);
    assert.equal(S.get('k'), 'new');
    assert.equal(S.timestamp('k'), 150);
    assert.equal(older.store.get('k'), env('new', 150));
    assert.equal(empty.store.get('k'), env('new', 150));
    deepEq(newest.calls, [['get', 'k']]);
  });

  test('without a key list it merges local keys plus every bulkKeys()', async () => {
    const { S } = load({ now: 1 });
    S.set('local1', 1);
    const m = makeMirror('cloud', new Map([['remote1', env('r', 9)]]), { bulkKeys: async () => ['remote1', ''] });
    const noBulk = makeMirror('plain');
    S.attachMirror(m);
    S.attachMirror(noBulk);
    await S.pullMirrors();
    deepEq(S.keys(), ['local1', 'remote1']);
    assert.equal(S.get('remote1'), 'r');
    assert.equal(noBulk.store.get('remote1'), env('r', 9));
    assert.equal(noBulk.store.get('local1'), env(1, 1));
  });

  test('never rejects: hanging mirror calls time out, bad input is ignored', async () => {
    const { S } = load();
    S.mirrorTimeoutMs = 40;
    S.set('k', 1);
    const hang = { name: 'hang', get: () => new Promise(() => {}), set: () => new Promise(() => {}), remove: () => new Promise(() => {}) };
    S.attachMirror(hang);
    const t0 = Date.now();
    await S.pullMirrors(['k', 42, null]);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(S.get('k'), 1);
    S.detachMirror('hang');
    await S.pullMirrors(['k']);
  });

  test('a pull result cancels a pending debounced push of the same key', async () => {
    const { S } = load({ now: 10 });
    S.debounceMs = 30;
    const m = makeMirror('cloud', new Map([['k', env('remote', 500)]]));
    S.attachMirror(m);
    S.set('k', 'local');
    await S.pullMirrors(['k']);
    await sleep(60);
    assert.equal(S.get('k'), 'remote');
    deepEq(m.calls.filter((c) => c[0] === 'set'), []);
  });
});

/* ------------------------------------------------------------------ */
/* Export / import                                                      */
/* ------------------------------------------------------------------ */

describe('export / import', () => {
  test('round-trips values and timestamps into a fresh store', () => {
    const a = load({ now: 1234 });
    a.S.set('score', 99);
    a.clock.now = 2000;
    a.S.set('settings', { sound: false, lang: 'tr' });
    const json = a.S.export();
    const snapshot = JSON.parse(json);
    assert.equal(snapshot.format, 1);
    assert.equal(snapshot.prefix, 'g1.');
    assert.equal(typeof snapshot.exportedAt, 'string');
    deepEq(snapshot.data, {
      score: { v: 99, _ts: 1234 },
      settings: { v: { sound: false, lang: 'tr' }, _ts: 2000 },
    });

    const b = load({ now: 5000 });
    const result = b.S.import(json);
    deepEq(result, { ok: true, imported: 2 });
    deepEq(b.S.keys(), ['score', 'settings']);
    assert.equal(b.S.get('score'), 99);
    assert.equal(b.S.timestamp('score'), 1234);
    deepEq(b.S.get('settings'), { sound: false, lang: 'tr' });
    deepEq(b.events, [
      { key: 'score', source: 'import' },
      { key: 'settings', source: 'import' },
    ]);
    // Re-exporting the imported store yields the identical data section.
    deepEq(JSON.parse(b.S.export()).data, snapshot.data);
  });

  test('accepts a plain {key: value} object, stamping the current time', () => {
    const { S } = load({ now: 777 });
    const result = S.import({ coins: 12, skin: 'neon' });
    deepEq(result, { ok: true, imported: 2 });
    assert.equal(S.get('coins'), 12);
    assert.equal(S.timestamp('skin'), 777);
  });

  test('rejects invalid input without throwing', () => {
    const { S } = load();
    deepEq(S.import('{not json'), { ok: false, imported: 0, error: 'invalid JSON' });
    assert.equal(S.import('[1,2]').ok, false);
    assert.equal(S.import('null').ok, false);
    deepEq(S.import('{}'), { ok: true, imported: 0 });
    deepEq(S.keys(), []);
  });

  test('imported keys are pushed to mirrors through the debounce', async () => {
    const { S } = load();
    S.debounceMs = 10;
    const m = makeMirror('cloud');
    S.attachMirror(m);
    S.import(JSON.stringify({ format: 1, data: { k: { v: 1, _ts: 5 } } }));
    await sleep(40);
    deepEq(m.calls, [['set', 'k', env(1, 5)]]);
  });
});

/* ------------------------------------------------------------------ */
/* Regressions found in review                                          */
/* ------------------------------------------------------------------ */

describe('memory layer precedence and tombstones', () => {
  test('a rejected rewrite of an existing key is read back (memory beats stale backend)', () => {
    const { S, ls } = load({ now: 1 });
    S.set('ok', 1);
    ls.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    assert.equal(S.set('ok', 2), true);
    assert.equal(S.get('ok'), 2);
    assert.equal(JSON.parse(ls.getItem('g1.ok')).v, 1);
    assert.equal(S.export().includes('"v":2'), true);
  });

  test('a rejected removal leaves a tombstone: key reads as gone until written again', () => {
    const { S, ls } = load();
    S.set('k', 1);
    const realRemove = ls.removeItem.bind(ls);
    ls.removeItem = () => { throw new DOMException('denied', 'SecurityError'); };
    assert.equal(S.remove('k'), true);
    assert.equal(S.get('k', 'gone'), 'gone');
    assert.equal(S.timestamp('k'), 0);
    deepEq(S.keys(), []);
    assert.equal(S.remove('k'), false);
    ls.removeItem = realRemove;
    S.set('k', 2);
    assert.equal(S.get('k'), 2);
    deepEq(S.keys(), ['k']);
  });

  test('values without a JSON form are rejected by set and skipped by import', () => {
    const { S } = load();
    assert.equal(S.set('fn', function () {}), false);
    assert.equal(S.set('sym', Symbol('s')), false);
    assert.equal(S.set('toJsonUndef', { toJSON() { return undefined; } }), false);
    assert.equal(S.get('fn', 'absent'), 'absent');
    deepEq(S.import({ good: 1, bad: () => 1 }), { ok: true, imported: 1 });
    deepEq(S.keys(), ['good']);
  });

  test('set(key, undefined) reports acceptance even when the key was absent', () => {
    const { S } = load();
    assert.equal(S.set('nothing', undefined), true);
    deepEq(S.keys(), []);
  });
});

describe('monotonic timestamps', () => {
  test('writes in the same millisecond get strictly increasing stamps', () => {
    const { S } = load({ now: 50 });
    S.set('k', 1);
    S.set('k', 2);
    S.set('k', 3);
    assert.equal(S.timestamp('k'), 52);
    S.set('other', 1);
    assert.equal(S.timestamp('other'), 50);
  });

  test('a local write after adopting a future-stamped mirror copy still wins the next pull', async () => {
    const { S, clock } = load({ now: 100 });
    const m = makeMirror('cloud', new Map([['k', env('remote', 5000)]]));
    S.attachMirror(m);
    await S.pullMirrors(['k']);
    assert.equal(S.get('k'), 'remote');
    clock.now = 200;
    S.set('k', 'mine');
    assert.equal(S.timestamp('k'), 5001);
    await S.pullMirrors(['k']);
    assert.equal(S.get('k'), 'mine');
    assert.equal(m.store.get('k'), env('mine', 5001));
  });
});

describe('remove and get bookkeeping', () => {
  test('removing a missing key is a local no-op but still reaches the mirrors', async () => {
    const { S, events } = load();
    const m = makeMirror('cloud', new Map([['ghost', env(1, 1)]]));
    S.attachMirror(m);
    const rev = S.rev;
    assert.equal(S.remove('ghost'), false);
    assert.equal(S.rev, rev);
    deepEq(events, []);
    await sleep(0);
    deepEq(m.calls, [['remove', 'ghost']]);
    assert.equal(m.store.has('ghost'), false);
  });

  test('get() of a key written behind our back makes it appear in keys()', () => {
    const { S, ls } = load();
    S.init();
    ls.setItem('g1.sneaky', env(1, 1));
    deepEq(S.keys(), []);
    assert.equal(S.get('sneaky'), 1);
    deepEq(S.keys(), ['sneaky']);
  });

  test('double init installs the lifecycle hooks once (one flush per pagehide)', () => {
    const { S, win } = load({ now: 1 });
    S.init();
    S.init();
    const m = makeMirror('cloud');
    S.attachMirror(m);
    S.set('k', 1);
    win.dispatchEvent(new Event('pagehide'));
    deepEq(m.calls, [['set', 'k', env(1, 1)]]);
  });
});

describe('pullMirrors concurrency', () => {
  test('a set() made while mirrors are being read is compared with its real timestamp', async () => {
    const { S, clock } = load({ now: 100 });
    let release;
    const m = {
      name: 'slow',
      calls: [],
      get: () => new Promise((r) => { release = () => r(env('remote', 150)); }),
      async set(k, v) { this.calls.push(['set', k, v]); },
      async remove() {},
    };
    S.attachMirror(m);
    S.set('k', 'old');
    const pull = S.pullMirrors(['k']);
    await sleep(5);
    clock.now = 200;
    S.set('k', 'newLocal');
    release();
    await pull;
    assert.equal(S.get('k'), 'newLocal');
    assert.equal(S.timestamp('k'), 200);
    deepEq(m.calls, [['set', 'k', env('newLocal', 200)]]);
    await sleep(900);
    assert.equal(m.calls.length, 1);
  });

  test('a mirror detached during a pull is not written to afterwards', async () => {
    const { S } = load({ now: 100 });
    let release;
    const m = {
      name: 'late',
      calls: [],
      get: () => new Promise((r) => { release = () => r(null); }),
      async set(k, v) { this.calls.push(['set', k, v]); },
      async remove() {},
    };
    S.set('k', 1);
    S.attachMirror(m);
    const pull = S.pullMirrors(['k']);
    await sleep(5);
    S.detachMirror('late');
    release();
    await pull;
    deepEq(m.calls, []);
  });

  test('accepts a single key string', async () => {
    const { S } = load({ now: 1 });
    const m = makeMirror('cloud', new Map([['solo', env('s', 9)]]));
    S.attachMirror(m);
    await S.pullMirrors('solo');
    assert.equal(S.get('solo'), 's');
  });
});

describe('cross-tab storage events (synthetic)', () => {
  const storageEvent = (win, props) => Object.assign(new Event('storage'), props);

  test('external set / remove update the manifest and emit source external', () => {
    const { S, ls, win, events } = load();
    S.init();
    ls.setItem('g1.tab', env(1, 1));
    win.dispatchEvent(storageEvent(win, { key: 'g1.tab', newValue: env(1, 1), storageArea: ls }));
    deepEq(S.keys(), ['tab']);
    assert.equal(S.get('tab'), 1);
    ls.removeItem('g1.tab');
    win.dispatchEvent(storageEvent(win, { key: 'g1.tab', newValue: null, storageArea: ls }));
    deepEq(S.keys(), []);
    deepEq(events, [{ key: 'tab', source: 'external' }, { key: 'tab', source: 'external' }]);
  });

  test('external clear() emits for every vanished key; foreign keys and areas are ignored', () => {
    const { S, ls, win, events } = load();
    S.set('a', 1);
    S.set('b', 2);
    events.length = 0;
    win.dispatchEvent(storageEvent(win, { key: 'other.x', newValue: '1', storageArea: ls }));
    win.dispatchEvent(storageEvent(win, { key: 'g1.a', newValue: null, storageArea: {} }));
    deepEq(events, []);
    deepEq(S.keys(), ['a', 'b']);
    ls.clear();
    win.dispatchEvent(storageEvent(win, { key: null, newValue: null, storageArea: ls }));
    deepEq(S.keys(), []);
    deepEq(events.map((e) => e.key).sort(), ['a', 'b']);
    assert.equal(events.every((e) => e.source === 'external'), true);
  });
});

/* ------------------------------------------------------------------ */
/* Real browser                                                         */
/* ------------------------------------------------------------------ */

describe('browser (Playwright/Chromium)', () => {
  let browser;
  let dir;
  const pageUrl = () => 'file://' + path.join(dir, 'index.html');

  before(async () => {
    const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs');
    browser = await chromium.launch();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-storage-'));
    fs.copyFileSync(SCRIPT_PATH, path.join(dir, 'storage.js'));
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<!doctype html><meta charset="utf-8"><title>storage</title><script src="storage.js"></script>');
  });

  after(async () => {
    if (browser) await browser.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('persists across reloads from file:// and fires g:storage with real CustomEvent', async () => {
    const page = await browser.newPage();
    await page.goto(pageUrl());
    const first = await page.evaluate(() => {
      const G = window.G;
      const seen = [];
      window.addEventListener('g:storage', (e) => seen.push(e.detail));
      G.storage.set('best', 1234);
      G.storage.set('settings', { sound: true });
      return {
        available: G.storage.available,
        raw: localStorage.getItem('g1.best'),
        seen,
        keys: G.storage.keys(),
      };
    });
    assert.equal(first.available, true);
    deepEq(JSON.parse(first.raw).v, 1234);
    deepEq(first.seen, [{ key: 'best', source: 'local' }, { key: 'settings', source: 'local' }]);
    deepEq(first.keys, ['best', 'settings']);

    await page.reload();
    const second = await page.evaluate(() => ({
      best: window.G.storage.get('best'),
      settings: window.G.storage.get('settings'),
      keys: window.G.storage.keys(),
    }));
    assert.equal(second.best, 1234);
    deepEq(second.settings, { sound: true });
    deepEq(second.keys, ['best', 'settings']);
    await page.evaluate(() => localStorage.clear());
    await page.close();
  });

  test('falls back to memory on an opaque origin where localStorage throws', async () => {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: SCRIPT_PATH });
    const result = await page.evaluate(() => {
      let lsThrows = false;
      try { window.localStorage.getItem('x'); } catch (e) { lsThrows = true; }
      const G = window.G;
      G.storage.set('score', 7);
      return { lsThrows, available: G.storage.available, score: G.storage.get('score'), keys: G.storage.keys() };
    });
    assert.equal(result.lsThrows, true);
    assert.equal(result.available, false);
    assert.equal(result.score, 7);
    deepEq(result.keys, ['score']);
    await page.close();
  });

  test('a write in one tab is visible in another tab as an external g:storage event', async () => {
    const context = await browser.newContext();
    const writer = await context.newPage();
    const reader = await context.newPage();
    await writer.goto(pageUrl());
    await reader.goto(pageUrl());
    await reader.evaluate(() => {
      window.seen = [];
      window.addEventListener('g:storage', (e) => window.seen.push(e.detail));
      window.G.storage.init();
    });
    await writer.evaluate(() => { window.G.storage.set('xtab', { from: 'writer' }); });
    await reader.waitForFunction(() => window.seen.length > 0, null, { timeout: 5000 });
    const state = await reader.evaluate(() => ({
      seen: window.seen,
      keys: window.G.storage.keys(),
      value: window.G.storage.get('xtab'),
    }));
    deepEq(state.seen, [{ key: 'xtab', source: 'external' }]);
    deepEq(state.keys, ['xtab']);
    deepEq(state.value, { from: 'writer' });
    await writer.evaluate(() => { window.G.storage.remove('xtab'); });
    await reader.waitForFunction(() => window.seen.length > 1, null, { timeout: 5000 });
    deepEq(await reader.evaluate(() => window.G.storage.keys()), []);
    await writer.evaluate(() => localStorage.clear());
    await context.close();
  });
});
