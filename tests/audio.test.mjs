// Tests for game/js/audio.js (G.audio).
// Run: node tests/audio.test.mjs
//
// Node part: the classic script is evaluated in a vm context without any Web
// Audio API to prove the module degrades gracefully (API shape, settings
// persistence through a fake G.storage, no-ops before unlock).
// Browser part: Playwright + headless Chromium (autoplay allowed) exercises
// the real AudioContext: every SFX, polyphony cap, generative music, intensity
// → BPM, adMute, duck, stopAll, visibility handling and OfflineAudioContext
// renders with peak-amplitude checks.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(here, '../game/js/audio.js');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

const SFX_NAMES = [
  'tap', 'flip', 'pop', 'coin', 'combo', 'hit', 'explode', 'whoosh', 'swoosh', 'powerup', 'fail',
  'success', 'tick', 'unlock', 'click', 'land', 'bounce', 'newBest', 'countdown', 'perfect',
  'shield', 'warning', 'select',
];

/* ------------------------------------------------------------------ */
/* Node (vm) part                                                       */
/* ------------------------------------------------------------------ */

/** Minimal G.storage stand-in recording writes. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    writes: [],
    get(key, fallback) { return map.has(key) ? map.get(key) : fallback; },
    set(key, value) { map.set(key, value); this.writes.push([key, value]); },
  };
}

/** Evaluates audio.js in a context with no AudioContext. */
function load({ storage, search = '' } = {}) {
  const win = new EventTarget();
  const document = { hidden: false, addEventListener() {} };
  Object.assign(win, {
    window: win,
    document,
    location: { search },
    setTimeout, clearTimeout, setInterval, clearInterval,
    CustomEvent,
    console,
  });
  if (storage) win.G = { storage };
  vm.createContext(win);
  vm.runInContext(SCRIPT, win, { filename: 'audio.js' });
  return win;
}

describe('G.audio (node, no Web Audio)', () => {
  test('exposes the contract API and every SFX name', () => {
    const { G } = load();
    const a = G.audio;
    for (const fn of ['init', 'unlock', 'play', 'setSfx', 'setMusic', 'setVolume', 'adMute', 'duck', 'stopAll', 'testTone', 'renderSfx']) {
      assert.equal(typeof a[fn], 'function', fn);
    }
    for (const fn of ['start', 'stop', 'setIntensity', 'isPlaying', 'getBpm']) {
      assert.equal(typeof a.music[fn], 'function', 'music.' + fn);
    }
    assert.deepEqual([...a.names].sort(), [...SFX_NAMES].sort());
    assert.deepEqual([...a.music.tracks].sort(), ['daily', 'main', 'menu']);
    assert.equal(a.supported, false);
    assert.equal(typeof G.log, 'function');
    assert.equal(G.DEBUG, false);
  });

  test('init() gives the default state and is idempotent', () => {
    const { G } = load();
    const s1 = G.audio.init();
    const s2 = G.audio.init();
    assert.equal(s1, s2);
    assert.equal(s1, G.audio.state);
    assert.deepEqual(
      { unlocked: s1.unlocked, sfx: s1.sfx, music: s1.music, volume: s1.volume, ducked: s1.ducked, adMuted: s1.adMuted },
      { unlocked: false, sfx: true, music: true, volume: 0.8, ducked: false, adMuted: false },
    );
  });

  test('reads persisted settings from G.storage and coerces bad values', () => {
    const storage = fakeStorage({ sfx: false, music: 'yes', volume: 0.25 });
    const { G } = load({ storage });
    const s = G.audio.init();
    assert.equal(s.sfx, false);
    assert.equal(s.music, true, 'non-boolean falls back to default');
    assert.equal(s.volume, 0.25);
  });

  test('setters persist through G.storage and clamp volume', () => {
    const storage = fakeStorage();
    const { G } = load({ storage });
    G.audio.init();
    G.audio.setSfx(false);
    G.audio.setMusic(false);
    G.audio.setVolume(1.7);
    G.audio.setVolume(-3);
    G.audio.setVolume('0.4');
    G.audio.setVolume('nope');
    assert.deepEqual(storage.writes, [['sfx', false], ['music', false], ['volume', 1], ['volume', 0], ['volume', 0.4], ['volume', 0.4]]);
    assert.equal(G.audio.state.volume, 0.4);
  });

  test('dispatches g:audio on setting changes', () => {
    const win = load();
    const seen = [];
    win.addEventListener('g:audio', (e) => seen.push(e.detail));
    win.G.audio.setVolume(0.5);
    win.G.audio.setMusic(false);
    assert.deepEqual(structuredClone(seen), [{ key: 'volume', value: 0.5 }, { key: 'music', value: false }]);
  });

  test('everything is a safe no-op without Web Audio', async () => {
    const { G } = load();
    const a = G.audio;
    assert.equal(await a.unlock(), false);
    assert.equal(a.state.unlocked, false);
    assert.equal(a.play('coin'), false);
    assert.equal(a.play('definitely-not-a-sound'), false);
    assert.equal(a.testTone(), false);
    a.music.start('main');
    assert.equal(a.music.isPlaying(), false);
    a.music.setIntensity(1);
    assert.equal(a.music.getBpm(), 0, 'no track ever began');
    a.adMute(true);
    assert.equal(a.state.adMuted, true);
    assert.equal(a.state.masterGain, 0);
    a.adMute(false);
    assert.equal(a.state.masterGain, 0.8);
    a.duck(60);
    assert.equal(a.state.ducked, true);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(a.state.ducked, false);
    a.stopAll();
    await assert.rejects(a.renderSfx('coin'), /unsupported/);
  });

  test('prototype keys are not SFX or track names', () => {
    const { G } = load();
    const a = G.audio;
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 42, null, undefined, {}]) {
      assert.equal(a.play(bad), false, 'play(' + String(bad) + ')');
      assert.doesNotThrow(() => a.music.start(bad), 'music.start(' + String(bad) + ')');
    }
    assert.equal(a.music.isPlaying(), false);
    assert.equal(a.names.includes('constructor'), false);
  });

  test('survives a G.storage whose get/set throw (blocked storage)', () => {
    const storage = {
      get() { throw new Error('SecurityError'); },
      set() { throw new Error('QuotaExceededError'); },
    };
    const { G } = load({ storage });
    const s = G.audio.init();
    assert.deepEqual({ sfx: s.sfx, music: s.music, volume: s.volume }, { sfx: true, music: true, volume: 0.8 });
    assert.doesNotThrow(() => { G.audio.setVolume(0.3); G.audio.setSfx(false); G.audio.setMusic(false); });
    assert.equal(s.volume, 0.3);
    assert.equal(s.sfx, false);
  });

  test('follows external g:storage changes without echoing a write', () => {
    const storage = fakeStorage({ volume: 0.8 });
    const win = load({ storage });
    const { G } = win;
    G.audio.init();
    storage.set('volume', 0.2);      // simulates a mirror pull / import landing in storage
    storage.set('sfx', false);
    storage.writes.length = 0;
    win.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'volume', source: 'external' } }));
    win.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'sfx', source: 'external' } }));
    win.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'unrelated', source: 'external' } }));
    win.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'constructor', source: 'external' } }));
    win.dispatchEvent(new CustomEvent('g:storage'));
    assert.equal(G.audio.state.volume, 0.2);
    assert.equal(G.audio.state.sfx, false);
    assert.deepEqual(storage.writes, [], 'syncing from storage never writes back');
    // Its own writes are not re-applied through the event (no feedback loop).
    G.audio.setVolume(0.6);
    assert.deepEqual(storage.writes, [['volume', 0.6]]);
    assert.equal(G.audio.state.volume, 0.6);
  });

  test('non-finite option values are tolerated before unlock', () => {
    const { G } = load();
    const a = G.audio;
    assert.doesNotThrow(() => {
      a.duck(NaN, Infinity);
      a.duck(1e12, -5);
      a.music.stop(NaN);
      a.music.setIntensity(NaN);
      a.setVolume(NaN);
    });
    assert.equal(a.state.ducked, true, 'oversized duck is clamped, not ignored');
    assert.equal(a.music.getIntensity(), 0.5);
    assert.equal(a.state.volume, 0.8);
    a.stopAll(); // clears the (clamped, 60 s) duck timer so the process can exit
    assert.equal(a.state.ducked, false);
  });
});

/* ------------------------------------------------------------------ */
/* Browser part                                                         */
/* ------------------------------------------------------------------ */

describe('G.audio (Chromium)', () => {
  let browser;

  before(async () => {
    const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs');
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  /** Fresh page with audio.js loaded (and an optional fake G.storage seeded first). */
  async function newAudioPage(storageInit) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent('<!doctype html><meta charset="utf-8"><title>audio</title>');
    if (storageInit) {
      await page.evaluate((init) => {
        const map = new Map(Object.entries(init));
        window.G = {
          storage: {
            writes: [],
            get(k, f) { return map.has(k) ? map.get(k) : f; },
            set(k, v) { map.set(k, v); this.writes.push([k, v]); },
          },
        };
      }, storageInit);
    }
    await page.addScriptTag({ path: SCRIPT_PATH });
    return { page, errors };
  }

  test('unlocks, plays every SFX without exceptions and caps polyphony', async () => {
    const { page, errors } = await newAudioPage();
    const r = await page.evaluate(async (names) => {
      const a = window.G.audio;
      a.init();
      const unlocked = await a.unlock();
      const again = await a.unlock();
      const perName = {};
      for (const n of names) {
        const before = a._test.voicesCreated;
        const ok = a.play(n, { pan: 0.3 });
        perName[n] = { ok, created: a._test.voicesCreated - before };
      }
      const afterAll = a._test.activeVoices();
      for (let i = 0; i < 20; i++) a.play('tap', { pitch: i - 10 });
      for (let i = 0; i < 10; i++) a.play('combo', { step: i });
      a.play('countdown', { step: 3 });
      a.play('countdown', { step: 0 });
      const peakActive = a._test.activeVoices();
      const tone = a.testTone();
      return {
        unlocked, again, state: a._test.contextState(), perName, afterAll, peakActive, tone,
        dropped: a.stats.voicesDropped, created: a.stats.voicesCreated, unknown: a.play('nope'),
      };
    }, SFX_NAMES);
    assert.deepEqual(errors, []);
    assert.equal(r.unlocked, true);
    assert.equal(r.again, true, 'unlock is idempotent');
    assert.equal(r.state, 'running');
    for (const n of SFX_NAMES) {
      assert.equal(r.perName[n].ok, true, n + ' played');
      assert.equal(r.perName[n].created, 1, n + ' created one voice');
    }
    assert.ok(r.afterAll <= 12 && r.afterAll > 0, 'active voices after 23 plays: ' + r.afterAll);
    assert.ok(r.peakActive <= 12, 'polyphony cap: ' + r.peakActive);
    assert.ok(r.dropped >= SFX_NAMES.length + 32 + 1 - 12, 'oldest voices dropped: ' + r.dropped);
    assert.equal(r.created, SFX_NAMES.length + 32 + 1);
    assert.equal(r.tone, true);
    assert.equal(r.unknown, false);

    // Every voice tears itself down once its sources end.
    await page.waitForTimeout(900);
    const settled = await page.evaluate(() => window.G.audio._test.activeVoices());
    assert.equal(settled, 0);
    await page.close();
  });

  test('generative music schedules notes, follows intensity and switches tracks', async () => {
    const { page, errors } = await newAudioPage();
    const first = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      await a.unlock();
      a.music.start('main');
      return { playing: a.music.isPlaying(), track: a.music.getTrack(), notes: a._test.notesScheduled, pad: a._test.padOscillators() };
    });
    assert.equal(first.playing, true);
    assert.equal(first.track, 'main');
    assert.equal(first.pad, 6);

    await page.waitForTimeout(1200);
    const second = await page.evaluate(() => window.G.audio._test.notesScheduled);
    assert.ok(second > first.notes + 8, `notes scheduled grew: ${first.notes} → ${second}`);
    await page.waitForTimeout(600);
    const third = await page.evaluate(() => window.G.audio._test.notesScheduled);
    assert.ok(third > second, 'scheduler keeps running');

    const bpm = await page.evaluate(() => {
      const a = window.G.audio;
      const out = {};
      a.music.setIntensity(0); out.lo = a.music.getBpm();
      a.music.setIntensity(1); out.hi = a.music.getBpm();
      a.music.setIntensity(0.5); out.mid = a.music.getBpm();
      a.music.setIntensity(7); out.clamped = a.music.getIntensity();
      return out;
    });
    assert.equal(bpm.lo, 96);
    assert.equal(bpm.hi, 132);
    assert.equal(bpm.mid, 114);
    assert.equal(bpm.clamped, 1);

    const switched = await page.evaluate(async () => {
      const a = window.G.audio;
      a.music.start('menu');
      const menu = { track: a.music.getTrack(), bpm: a.music.getBpm(), pad: a._test.padOscillators() };
      a.music.start('daily');
      const daily = { track: a.music.getTrack(), bpm: a.music.getBpm() };
      a.music.start('unknown-track');
      const fallback = a.music.getTrack();
      return { menu, daily, fallback };
    });
    assert.deepEqual(switched.menu, { track: 'menu', bpm: 100, pad: 6 });
    assert.deepEqual(switched.daily, { track: 'daily', bpm: 128 });
    assert.equal(switched.fallback, 'main');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('adMute drives the master gain to 0 regardless of settings and restores it', async () => {
    const { page } = await newAudioPage();
    await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      await a.unlock();
      a.setVolume(0.6);
    });
    await page.waitForTimeout(120);
    const before = await page.evaluate(() => window.G.audio._test.masterGainValue());
    assert.ok(Math.abs(before - 0.6) < 0.01, 'volume applied: ' + before);

    const muted = await page.evaluate(() => {
      const a = window.G.audio;
      a.adMute(true);
      a.setVolume(1); // user settings must not undo the ad mute
      return { adMuted: a.state.adMuted, target: a.state.masterGain, sfx: a.play('coin') };
    });
    assert.deepEqual(muted, { adMuted: true, target: 0, sfx: false });
    await page.waitForTimeout(120);
    const during = await page.evaluate(() => window.G.audio._test.masterGainValue());
    assert.ok(during < 0.001, 'master gain muted: ' + during);

    await page.evaluate(() => window.G.audio.adMute(false));
    await page.waitForTimeout(120);
    const restored = await page.evaluate(() => ({ gain: window.G.audio._test.masterGainValue(), target: window.G.audio.state.masterGain }));
    assert.ok(Math.abs(restored.gain - 1) < 0.01, 'restored to volume: ' + restored.gain);
    assert.equal(restored.target, 1);
    await page.close();
  });

  test('duck lowers the music bus temporarily and stopAll silences everything', async () => {
    const { page } = await newAudioPage();
    const ducked = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      await a.unlock();
      a.music.start('main');
      for (let i = 0; i < 5; i++) a.play('explode');
      a.duck(400, 0.5);
      return a.state.ducked;
    });
    assert.equal(ducked, true);
    await page.waitForTimeout(500);
    const afterDuck = await page.evaluate(() => window.G.audio.state.ducked);
    assert.equal(afterDuck, false);

    const stopped = await page.evaluate(() => {
      const a = window.G.audio;
      a.play('explode');
      a.duck(1000, 0.5);
      a.stopAll();
      return { playing: a.music.isPlaying(), ducked: a.state.ducked, notes: a._test.notesScheduled };
    });
    assert.equal(stopped.playing, false);
    assert.equal(stopped.ducked, false);
    await page.waitForTimeout(400);
    const later = await page.evaluate(() => ({
      voices: window.G.audio._test.activeVoices(),
      notes: window.G.audio._test.notesScheduled,
      pad: window.G.audio._test.padOscillators(),
    }));
    assert.equal(later.voices, 0, 'all SFX voices gone');
    assert.equal(later.notes, stopped.notes, 'no further notes scheduled');
    assert.equal(later.pad, 0, 'pad oscillators released');
    await page.close();
  });

  test('settings: sfx/music toggles, persistence via G.storage, music remembers the wanted track', async () => {
    const { page } = await newAudioPage({ volume: 0.35, music: false });
    const r = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      const initial = { volume: a.state.volume, music: a.state.music };
      a.music.start('menu');            // before unlock + music off: remembered only
      await a.unlock();
      const afterUnlock = a.music.isPlaying();
      a.setMusic(true);                 // wanted track starts now
      const afterEnable = { playing: a.music.isPlaying(), track: a.music.getTrack() };
      a.setSfx(false);
      const sfxOff = a.play('coin');
      a.setSfx(true);
      const sfxOn = a.play('coin');
      a.setMusic(false);
      const musicOff = a.music.isPlaying();
      a.setVolume(0.9);
      return { initial, afterUnlock, afterEnable, sfxOff, sfxOn, musicOff, writes: window.G.storage.writes };
    });
    assert.deepEqual(r.initial, { volume: 0.35, music: false });
    assert.equal(r.afterUnlock, false);
    assert.deepEqual(r.afterEnable, { playing: true, track: 'menu' });
    assert.equal(r.sfxOff, false);
    assert.equal(r.sfxOn, true);
    assert.equal(r.musicOff, false);
    assert.deepEqual(r.writes, [['music', true], ['sfx', false], ['sfx', true], ['music', false], ['volume', 0.9]]);
    await page.close();
  });

  test('music starts on unlock when requested earlier and pauses while the document is hidden', async () => {
    const { page } = await newAudioPage();
    const r = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      a.music.start('daily');
      const beforeUnlock = a.music.isPlaying();
      await a.unlock();
      const afterUnlock = { playing: a.music.isPlaying(), track: a.music.getTrack() };

      // Simulate the tab being hidden, then visible again.
      let hidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
      const whileHidden = a.music.isPlaying();
      await new Promise((res) => setTimeout(res, 700));
      const ctxHidden = a._test.contextState();
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 150));
      const visible = { playing: a.music.isPlaying(), track: a.music.getTrack(), ctx: a._test.contextState() };
      return { beforeUnlock, afterUnlock, whileHidden, ctxHidden, visible };
    });
    assert.equal(r.beforeUnlock, false);
    assert.deepEqual(r.afterUnlock, { playing: true, track: 'daily' });
    assert.equal(r.whileHidden, false);
    assert.equal(r.ctxHidden, 'suspended');
    assert.deepEqual(r.visible, { playing: true, track: 'daily', ctx: 'running' });
    await page.close();
  });

  test('hostile inputs: NaN options, prototype names and testTone with SFX off leak nothing', async () => {
    const { page, errors } = await newAudioPage();
    const r = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      await a.unlock();
      const before = a._test.voicesCreated;
      const nan = a.play('coin', { pitch: NaN, gain: NaN, pan: NaN, step: NaN });
      const huge = a.play('combo', { pitch: 1e9, gain: 1e9, pan: -1e9, step: 1e9 });
      const str = a.play('tick', { pitch: '12', gain: '0.1' });
      const nonObj = a.play('pop', 5);
      const created = a._test.voicesCreated - before;
      const proto = ['__proto__', 'constructor', 'toString'].map((n) => a.play(n));
      const active = a._test.activeVoices();
      a.music.start('constructor');
      const track = a.music.getTrack();
      a.music.start('__proto__');
      const track2 = a.music.getTrack();
      a.setSfx(false);
      const toneOff = a.testTone();
      const sfxOff = a.play('coin');
      a.setSfx(true);
      let renderErr = null;
      try { await a.renderSfx('constructor'); } catch (e) { renderErr = String(e); }
      const shortRender = await a.renderSfx('tick', {}, NaN);
      return { nan, huge, str, nonObj, created, proto, active, track, track2, toneOff, sfxOff, renderErr, shortLen: shortRender.length };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual([r.nan, r.huge, r.str, r.nonObj], [true, true, true, true], 'bad numbers are sanitised, not fatal');
    assert.equal(r.created, 4);
    assert.deepEqual(r.proto, [false, false, false]);
    assert.ok(r.active <= 4, 'no stray voices from prototype names: ' + r.active);
    assert.equal(r.track, 'main');
    assert.equal(r.track2, 'main');
    assert.equal(r.toneOff, true, 'testTone bypasses the SFX toggle');
    assert.equal(r.sfxOff, false);
    assert.match(r.renderErr, /unknown sfx/);
    assert.equal(r.shortLen, Math.ceil(1.5 * 44100), 'NaN seconds falls back to the default length');
    await page.waitForTimeout(700);
    const settled = await page.evaluate(() => window.G.audio._test.activeVoices());
    assert.equal(settled, 0);
    await page.close();
  });

  test('a throwing AudioContext.resume() makes unlock resolve false without page errors', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent('<!doctype html><meta charset="utf-8"><title>audio</title>');
    await page.evaluate(() => {
      AudioContext.prototype.resume = function () { throw new Error('nope'); };
      Object.defineProperty(AudioContext.prototype, 'state', { configurable: true, get: () => 'suspended' });
    });
    await page.addScriptTag({ path: SCRIPT_PATH });
    const r = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      const first = await a.unlock();
      window.dispatchEvent(new PointerEvent('pointerdown'));
      window.dispatchEvent(new KeyboardEvent('keydown'));
      await new Promise((res) => setTimeout(res, 20));
      return { first, unlocked: a.state.unlocked, play: a.play('coin'), tone: a.testTone() };
    });
    assert.deepEqual(r, { first: false, unlocked: false, play: false, tone: false });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('music requested before unlock while the tab is hidden starts once visible', async () => {
    const { page, errors } = await newAudioPage();
    const r = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      let hidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      a.music.start('menu');
      await a.unlock();                 // unlock while hidden: context runs, music must wait
      const whileHidden = { playing: a.music.isPlaying(), unlocked: a.state.unlocked };
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 100));
      const visible = { playing: a.music.isPlaying(), track: a.music.getTrack() };
      // Explicit stop while hidden must not resurrect the track on the next visible.
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      a.music.stop(0);
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 100));
      const afterStop = a.music.isPlaying();
      return { whileHidden, visible, afterStop };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(r.whileHidden, { playing: false, unlocked: true });
    assert.deepEqual(r.visible, { playing: true, track: 'menu' });
    assert.equal(r.afterStop, false);
    await page.close();
  });

  test('external storage changes reach the live master gain', async () => {
    const { page } = await newAudioPage({ volume: 0.8 });
    await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      await a.unlock();
      window.G.storage.set('volume', 0.25);
      window.G.storage.writes.length = 0;
      window.dispatchEvent(new CustomEvent('g:storage', { detail: { key: 'volume', source: 'external' } }));
    });
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => ({
      gain: window.G.audio._test.masterGainValue(),
      volume: window.G.audio.state.volume,
      writes: window.G.storage.writes,
    }));
    assert.ok(Math.abs(r.gain - 0.25) < 0.01, 'master gain follows storage: ' + r.gain);
    assert.equal(r.volume, 0.25);
    assert.deepEqual(r.writes, []);
    await page.close();
  });

  test('offline renders: coin, fail and newBest have healthy peaks; every SFX is audible and unclipped', async () => {
    const { page } = await newAudioPage();
    const peaks = await page.evaluate(async (names) => {
      const a = window.G.audio;
      a.init();
      const out = {};
      for (const n of names) {
        const buf = await a.renderSfx(n, {}, 1.5);
        let peak = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            const v = Math.abs(d[i]);
            if (v > peak) peak = v;
          }
        }
        out[n] = { peak, length: buf.length, sampleRate: buf.sampleRate };
      }
      return out;
    }, SFX_NAMES);
    for (const n of ['coin', 'fail', 'newBest']) {
      const { peak, length, sampleRate } = peaks[n];
      assert.equal(length, Math.ceil(1.5 * sampleRate));
      assert.ok(peak >= 0.05 && peak <= 0.99, `${n} peak ${peak.toFixed(3)} within [0.05, 0.99]`);
    }
    for (const n of SFX_NAMES) {
      assert.ok(peaks[n].peak >= 0.02 && peaks[n].peak <= 0.99, `${n} audible and unclipped (peak ${peaks[n].peak.toFixed(3)})`);
    }
    await page.close();
  });

  test('pitch and step options change the rendered sound', async () => {
    const { page } = await newAudioPage();
    const r = await page.evaluate(async () => {
      const a = window.G.audio;
      a.init();
      const sig = async (name, opts) => {
        const buf = await a.renderSfx(name, opts, 0.5);
        const d = buf.getChannelData(0);
        // Count zero crossings in the first 60 ms as a cheap pitch proxy.
        let z = 0;
        const n = Math.floor(buf.sampleRate * 0.06);
        for (let i = 1; i < n; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) z++;
        return z;
      };
      return {
        base: await sig('tick', {}),
        up: await sig('tick', { pitch: 12 }),
        combo0: await sig('combo', { step: 0 }),
        combo9: await sig('combo', { step: 9 }),
        quiet: await (async () => {
          const buf = await a.renderSfx('coin', { gain: 0.1 }, 0.5);
          let p = 0; const d = buf.getChannelData(0);
          for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
          return p;
        })(),
      };
    });
    assert.ok(r.up > r.base * 1.6, `pitch +12 roughly doubles zero crossings: ${r.base} → ${r.up}`);
    assert.ok(r.combo9 > r.combo0 * 2, `combo step 9 is much higher than step 0: ${r.combo0} → ${r.combo9}`);
    assert.ok(r.quiet < 0.08, 'gain option attenuates the voice: ' + r.quiet.toFixed(3));
    await page.close();
  });
});
