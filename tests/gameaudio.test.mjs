// Tests for game/js/gameaudio.js (G.gameAudio), layered on game/js/audio.js.
// Run: node tests/gameaudio.test.mjs
//
// Node part: audio.js + gameaudio.js evaluated in a vm context without any Web
// Audio API — API shape, key/phrase generation, counters and no-op safety.
// Browser part: Playwright + headless Chromium (autoplay allowed) — silence
// before unlock, every sim event type with realistic (and hostile) fields, 3 s
// of update() over synthetic run states with the AudioNode creation count
// frozen after the first second, setChain → music intensity, death/restore on
// the music lowpass, and OfflineAudioContext renders of LOOP/DEATH/… voices
// with peak-amplitude checks.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const JS = (f) => path.resolve(here, '../game/js', f);
const AUDIO = JS('audio.js');
const GAMEAUDIO = JS('gameaudio.js');
const STORAGE = JS('storage.js');
const CONFIG = JS('config.js');

const MINOR_PENT = [0, 3, 5, 7, 10];
const MAJOR_PENT = [0, 2, 4, 7, 9];

/** One realistic instance of every sim event type (fields per the sim contract). */
const EVENTS = [
  { type: 'LATCH', planetId: 5, r: 120, theta: -1.57, s: 1, x: 270, y: 120 },
  { type: 'RELEASE', heat: 0.8, hotShot: true, theta: 0.3, x: 300, y: 150, speed: 588 },
  { type: 'HOT_SHOT', amount: 10, M: 2 },
  { type: 'GRAZE', planetId: 6, amount: 5, M: 2, x: 200, y: 400 },
  { type: 'LONG_SHOT', amount: 10, M: 2 },
  { type: 'LOOP', amount: 20, bankedTotal: 120, pooledBefore: 150, x: 270, y: 400 },
  { type: 'WALL', x: 9, y: 500, side: -1 },
  { type: 'SNAP', x: 531, y: 600 },
  { type: 'BURN_WARN' },
  { type: 'LINE_PASSED', altM: 300 },
  { type: 'CHUNK', k: 1 },
  { type: 'LAUNCH' },
  { type: 'DEATH', deathType: 'FELL', x: 270, y: 100, pool: 40 },
  { type: 'DEATH', deathType: 'BURNED', x: 100, y: 900, pool: 0 },
  { type: 'DEATH', deathType: 'CRASHED', x: 400, y: 700, pool: 12 },
];

const HOSTILE = [
  null, undefined, {}, { type: 42 }, { type: '' }, { type: 'NOPE' },
  { type: 'LATCH', x: NaN }, { type: 'LOOP', pooledBefore: Infinity, x: 'left' },
  { type: 'RELEASE', heat: 'hot' }, { type: 'GRAZE', M: -5, x: 1e9 }, { type: 'WALL', side: 'left' },
  { type: 'DEATH' }, { type: 'DEATH', deathType: 'WHATEVER' }, { type: 'HOT_SHOT', M: NaN },
];

const SKIN = { id: 'ember', price: 0, hueA: 18, hueB: 0, style: 'ribbon', width: 8, timbre: 'triangle' };
const THEME = { id: 'indigo', unlockAltM: 0, mood: 'minor', tether: '#6ff', hot: '#ff5a3c', text: '#eef' };

/* ------------------------------------------------------------------ */
/* Node (vm) part                                                       */
/* ------------------------------------------------------------------ */

function loadVm() {
  const win = new EventTarget();
  const document = { hidden: false, addEventListener() {} };
  Object.assign(win, {
    window: win, document, location: { search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval, CustomEvent, console,
  });
  win.G = { CONFIG: { V_ORBIT: 420, COL_W: 540 } };
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(AUDIO, 'utf8'), win, { filename: 'audio.js' });
  vm.runInContext(fs.readFileSync(GAMEAUDIO, 'utf8'), win, { filename: 'gameaudio.js' });
  return win;
}

describe('G.gameAudio (node, no Web Audio)', () => {
  test('exposes the contract API and audio.js grew ctx()/buses()', () => {
    const { G } = loadVm();
    for (const fn of ['init', 'newRun', 'onEvent', 'update', 'setChain', 'death', 'restore', 'newBest', 'ui', 'silence', 'renderEvent']) {
      assert.equal(typeof G.gameAudio[fn], 'function', fn);
    }
    assert.equal(typeof G.audio.ctx, 'function');
    assert.equal(typeof G.audio.buses, 'function');
    assert.equal(G.audio.ctx(), null);
    assert.equal(G.audio.buses(), null);
  });

  test('newRun picks a root in A3–E4, a pentatonic mode by theme.mood and a resolving 8-note phrase', () => {
    const { G } = loadVm();
    const GA = G.gameAudio;
    GA.init();
    const seen = new Set();
    for (let seed = 1; seed <= 200; seed++) {
      GA.newRun({ seed, skin: SKIN, theme: THEME });
      const k = GA.key;
      assert.ok(k.root >= 57 && k.root <= 64, 'root in A3..E4: ' + k.root);
      seen.add(k.root);
      assert.equal(k.mode, 'minor');
      assert.deepEqual(Array.from(k.scale), MINOR_PENT);
      assert.equal(k.phrase.length, 8);
      const last = k.phrase[7] - k.root;
      assert.ok(last === 0 || last === 12, 'note 8 resolves to the root: ' + last);
      for (let i = 0; i < 8; i++) {
        const semis = k.phrase[i] - k.root;
        assert.ok(semis >= 0 && semis <= 22, 'within two octaves: ' + semis);
        assert.ok(MINOR_PENT.includes(semis % 12), 'in scale: ' + semis);
      }
      for (let i = 1; i < 7; i++) {
        // Steps are at most two scale degrees (≤ 7 semitones in a pentatonic).
        assert.ok(Math.abs(k.phrase[i] - k.phrase[i - 1]) <= 7, 'walk step ≤ 2 degrees');
      }
    }
    assert.ok(seen.size >= 6, 'roots vary across seeds: ' + [...seen].join(','));

    GA.newRun({ seed: 42, skin: SKIN, theme: { mood: 'major' } });
    assert.equal(GA.key.mode, 'major');
    assert.deepEqual(Array.from(GA.key.scale), MAJOR_PENT);
    for (const n of GA.key.phrase) assert.ok(MAJOR_PENT.includes((n - GA.key.root) % 12));

    GA.newRun({ seed: 42 });
    assert.equal(GA.key.mode, 'minor', 'no theme → minor');
  });

  test('phrase is deterministic per seed and varies between seeds', () => {
    const { G } = loadVm();
    const GA = G.gameAudio;
    GA.newRun({ seed: 12345, skin: SKIN, theme: THEME });
    const a = GA.key;
    GA.newRun({ seed: 999, skin: SKIN, theme: THEME });
    GA.newRun({ seed: 12345, skin: SKIN, theme: THEME });
    const b = GA.key;
    assert.deepEqual(a.phrase, b.phrase);
    assert.equal(a.root, b.root);
    const phrases = new Set();
    for (let s = 0; s < 40; s++) {
      GA.newRun({ seed: s * 7919 + 3, theme: THEME });
      phrases.add(GA.key.phrase.join(','));
    }
    assert.ok(phrases.size >= 30, 'distinct phrases: ' + phrases.size);
  });

  test('timbre follows skin.timbre, then skin.style, then triangle', () => {
    const { G } = loadVm();
    const GA = G.gameAudio;
    const cases = [
      [{ timbre: 'saw' }, 'saw'], [{ timbre: 'square' }, 'square'], [{ timbre: 'sine' }, 'sine'],
      [{ style: 'beads' }, 'sine'], [{ style: 'sparks' }, 'square'], [{ style: 'jagged' }, 'saw'], [{ style: 'ribbon' }, 'triangle'],
      [{ timbre: 'organ' }, 'triangle'], [{}, 'triangle'], [undefined, 'triangle'],
    ];
    for (const [skin, want] of cases) {
      GA.newRun({ seed: 1, skin, theme: THEME });
      assert.equal(GA.key.timbre, want, JSON.stringify(skin));
    }
  });

  test('everything is a safe no-op without Web Audio, counters still follow play', () => {
    const { G } = loadVm();
    const GA = G.gameAudio;
    GA.init();
    GA.init();
    GA.newRun({ seed: 3, skin: SKIN, theme: THEME });
    assert.doesNotThrow(() => {
      for (const e of EVENTS) GA.onEvent(e);
      for (const e of HOSTILE) GA.onEvent(e);
      GA.update(null, 1 / 60);
      GA.update({ state: 'TETHERED', tether: { planetId: 1, r: 80 }, heat: 0.7, comet: { x: 100 }, planets: {} }, 1 / 60);
      GA.update({}, NaN);
      GA.setChain(3, 1000);
      GA.setChain(NaN, undefined);
      GA.death();
      GA.restore();
      GA.newBest();
      GA.silence();
      assert.equal(GA.ui('coin'), false);
      assert.equal(GA.ui(42), false);
    });
    assert.equal(GA.key.latchCount, 2, 'LATCH counted (1 realistic + 1 hostile)');
    assert.equal(GA.key.grazeChain, 1, 'hostile GRAZE with M=-5 reset the climb (M dropped) and then counted itself');
    assert.equal(G.audio.state.unlocked, false);
    assert.rejects(GA.renderEvent({ type: 'LOOP' }), /unsupported/);
  });

  test('setChain maps (M, altM) to music intensity clamp((M-1)/4 + altM/4000, 0, 1)', () => {
    const { G } = loadVm();
    const GA = G.gameAudio;
    const cases = [[1, 0, 0], [2, 1000, 0.5], [3, 2000, 1], [5, 0, 1], [1, 2000, 0.5], [9, 99999, 1], [1.5, 500, 0.25]];
    for (const [M, alt, want] of cases) {
      GA.setChain(M, alt);
      assert.ok(Math.abs(G.audio.music.getIntensity() - want) < 1e-9, `setChain(${M}, ${alt}) → ${want}`);
    }
    GA.setChain(2, 1000);
    GA.setChain(NaN, NaN);                // ignored numerics keep the last altitude, M falls back to 1
    assert.ok(Math.abs(G.audio.music.getIntensity() - 0.25) < 1e-9);
  });

  test('graze climb resets when the chain multiplier drops', () => {
    const { G } = loadVm();
    const GA = G.gameAudio;
    GA.newRun({ seed: 5, theme: THEME });
    for (let i = 0; i < 4; i++) GA.onEvent({ type: 'GRAZE', M: 2, x: 100, y: 100 });
    assert.equal(GA.key.grazeChain, 4);
    GA.setChain(3, 100);
    assert.equal(GA.key.grazeChain, 4, 'rising M keeps the climb');
    GA.setChain(1, 100);
    assert.equal(GA.key.grazeChain, 0, 'drop resets');
    GA.onEvent({ type: 'GRAZE', M: 1 });
    GA.newRun({ seed: 6, theme: THEME });
    assert.equal(GA.key.grazeChain, 0);
    assert.equal(GA.key.latchCount, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Browser part                                                         */
/* ------------------------------------------------------------------ */

describe('G.gameAudio (Chromium)', () => {
  let browser;

  before(async () => {
    const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs');
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  /**
   * Fresh page with (config.js | minimal G.CONFIG), storage.js, audio.js and
   * gameaudio.js loaded. Every BaseAudioContext.create*() node factory is
   * wrapped first so window.__nodes counts AudioNode creations.
   */
  async function newPage() {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.setContent('<!doctype html><meta charset="utf-8"><title>gameaudio</title>');
    await page.evaluate(() => {
      window.__nodes = 0;
      const proto = BaseAudioContext.prototype;
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (!/^create/.test(k) || k === 'createBuffer' || k === 'createPeriodicWave') continue;
        const orig = proto[k];
        if (typeof orig !== 'function') continue;
        proto[k] = function (...a) { window.__nodes++; return orig.apply(this, a); };
      }
    });
    if (fs.existsSync(CONFIG)) {
      await page.addScriptTag({ path: CONFIG });
    } else {
      await page.evaluate(() => { window.G = { CONFIG: { V_ORBIT: 420, COL_W: 540, VIEW_H: 960 } }; });
    }
    await page.addScriptTag({ path: STORAGE });
    await page.addScriptTag({ path: AUDIO });
    await page.addScriptTag({ path: GAMEAUDIO });
    return { page, errors };
  }

  test('before unlock nothing is created and no context exists', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(({ EVENTS, SKIN, THEME }) => {
      const GA = window.G.gameAudio;
      GA.init();
      GA.newRun({ seed: 1, skin: SKIN, theme: THEME });
      for (const e of EVENTS) GA.onEvent(e);
      for (let i = 0; i < 30; i++) {
        GA.update({ state: 'TETHERED', tether: { planetId: 0, r: 120 }, heat: 0.9, comet: { x: 270, y: 120 }, planets: { 0: { hot: true } } }, 1 / 60);
      }
      GA.setChain(3, 500);
      GA.death();
      GA.restore();
      GA.newBest();
      GA.silence();
      return { nodes: window.__nodes, ctx: window.G.audio.ctx(), buses: window.G.audio.buses(), rig: GA._test.rigBuilt(), key: GA.key };
    }, { EVENTS, SKIN, THEME });
    assert.deepEqual(errors, []);
    assert.equal(r.nodes, 0, 'no AudioNode created before unlock');
    assert.equal(r.ctx, null);
    assert.equal(r.buses, null);
    assert.equal(r.rig, false);
    assert.equal(r.key.latchCount, 1);
    await page.close();
  });

  test('init + unlock exposes ctx/buses; every event type (and hostile input) plays without exceptions and voices tear down', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(async ({ EVENTS, HOSTILE, SKIN, THEME }) => {
      const A = window.G.audio;
      const GA = window.G.gameAudio;
      GA.init();
      const unlocked = await A.unlock();
      const ctx = A.ctx();
      const buses = A.buses();
      const busInfo = {
        ctxRunning: !!ctx && ctx.state === 'running',
        sfx: buses && buses.sfx instanceof GainNode,
        music: buses && buses.music instanceof GainNode,
        master: buses && buses.master instanceof GainNode,
        reverbSend: buses && buses.reverbSend,
        musicFilter: buses && buses.musicFilter instanceof BiquadFilterNode,
      };
      GA.newRun({ seed: 2026, skin: SKIN, theme: THEME });
      const before = window.__nodes;
      // Wrap the phrase twice (16 latches) with the chain at x3 so the octave doubling runs too.
      GA.setChain(3, 0);
      for (let i = 0; i < 16; i++) GA.onEvent({ type: 'LATCH', planetId: i, r: 60 + i * 10, theta: 0, s: 1, x: 100 + i * 20, y: i * 200 });
      // Climb the graze scale past the wrap.
      for (let i = 0; i < 12; i++) GA.onEvent({ type: 'GRAZE', planetId: i, amount: 5, M: 3, x: 50 * i, y: 100 });
      for (const e of EVENTS) GA.onEvent(e);
      for (const e of HOSTILE) GA.onEvent(e);
      // Each skin timbre at least once.
      for (const timbre of ['sine', 'square', 'saw']) {
        GA.newRun({ seed: 7, skin: { style: 'beads', timbre }, theme: { mood: 'major' } });
        GA.onEvent({ type: 'LATCH', planetId: 1, r: 100, theta: 0, s: 1, x: 270, y: 0 });
      }
      const created = window.__nodes - before;
      const active = GA._test.activeVoices();
      const uiOk = GA.ui('tick');
      const uiBad = GA.ui('__proto__');
      GA.newBest();
      return { unlocked, busInfo, created, active, uiOk, uiBad, rig: GA._test.rigBuilt(), key: GA.key };
    }, { EVENTS, HOSTILE, SKIN, THEME });
    assert.deepEqual(errors, []);
    assert.equal(r.unlocked, true);
    assert.deepEqual(r.busInfo, { ctxRunning: true, sfx: true, music: true, master: true, reverbSend: null, musicFilter: true });
    assert.equal(r.rig, true);
    assert.ok(r.created > 60, 'voices created nodes: ' + r.created);
    assert.ok(r.active > 0 && r.active <= 16, 'polyphony capped at 16: ' + r.active);
    assert.equal(r.uiOk, true);
    assert.equal(r.uiBad, false);
    assert.equal(r.key.latchCount, 1, 'newRun resets the melody position');

    await page.waitForTimeout(1300);
    const settled = await page.evaluate(() => ({ voices: window.G.gameAudio._test.activeVoices(), audioVoices: window.G.audio._test.activeVoices() }));
    assert.equal(settled.voices, 0, 'every one-shot voice disposed itself');
    assert.equal(settled.audioVoices, 0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('3 s of update(): hum/hiss/clicks follow the run and the AudioNode count is frozen after the first second', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(async ({ SKIN, THEME }) => {
      const A = window.G.audio;
      const GA = window.G.gameAudio;
      GA.init();
      await A.unlock();
      GA.newRun({ seed: 11, skin: SKIN, theme: THEME });
      const planets = new Map([[5, { id: 5, x0: 270, y: 400, R: 50, hot: true }], [6, { id: 6, x0: 100, y: 900, R: 40, hot: false }]]);
      const mk = (state, r, heat, x, planetId) => ({
        state, heat, t: 0,
        comet: { x, y: 400 + r, vx: 0, vy: 0 },
        tether: state === 'TETHERED' ? { planetId, r, theta: 0, s: 1, loopAcc: 0 } : null,
        planets,
        score: { alt: 100, banked: 0, pool: 20, M: 2 },
      });
      const FRAMES = 180;
      const dt = 1 / 60;
      const samples = {};
      let countAt1s = -1;
      for (let i = 0; i < FRAMES; i++) {
        let run;
        if (i < 120) {
          const k = i / 119;                         // tethered: r 60→300, heat 0→1, x 0→540, hot planet
          run = mk('TETHERED', 60 + 240 * k, k, 540 * k, 5);
        } else if (i < 135) {
          run = mk('TETHERED', 150, 0.2, 270, 6);    // cold planet, low heat: hum on, no clicks, no wobble
        } else if (i < 160) {
          run = mk('FLIGHT', 0, Math.max(0, 0.6 - (i - 135) / 40), 270, 0);
        } else {
          run = mk('DEAD', 0, 0, 270, 0);
        }
        GA.update(run, dt);
        if (i === 59) countAt1s = window.__nodes;
        if (i === 20 || i === 100 || i === 119 || i === 134 || i === 150 || i === 179) samples[i] = GA._test.snapshot();
        await new Promise((res) => setTimeout(res, 16));
      }
      // A null / malformed run must not throw either.
      GA.update(null, dt);
      GA.update({ state: 'TETHERED' }, dt);
      GA.update({ state: 'TETHERED', tether: { r: NaN }, comet: null, planets: null, heat: 'x' }, dt);
      const countEnd = window.__nodes;
      return { countAt1s, countEnd, samples, voices: GA._test.activeVoices() };
    }, { SKIN, THEME });
    assert.deepEqual(errors, []);
    assert.ok(r.countAt1s > 0, 'rig nodes created: ' + r.countAt1s);
    assert.equal(r.countEnd, r.countAt1s, `no AudioNode created after the first second (${r.countAt1s} → ${r.countEnd})`);
    assert.equal(r.voices, 0, 'update() never creates one-shot voices');

    const s20 = r.samples[20];
    assert.equal(s20.humOn, true);
    // Frame 20: r ≈ 108.4 → w ≈ 3.87 → f ≈ 322 Hz, cutoff ≈ 1562 Hz; pan ≈ (0.168-0.5)*1.2 = -0.40.
    const r20 = 60 + 240 * (20 / 119);
    const w20 = 420 / r20;
    assert.ok(Math.abs(s20.humTarget.f - (90 + 60 * w20)) < 1e-6, 'hum frequency target: ' + s20.humTarget.f);
    assert.ok(Math.abs(s20.humTarget.cutoff - (400 + 300 * w20)) < 1e-6, 'hum cutoff target: ' + s20.humTarget.cutoff);
    assert.ok(Math.abs(s20.humTarget.pan - (((540 * 20 / 119) / 540 - 0.5) * 1.2)) < 1e-6, 'pan target: ' + s20.humTarget.pan);
    assert.equal(s20.humTarget.hot, true);
    assert.ok(Math.abs(s20.humGain - 0.10) < 0.02, 'hum gain ramped in: ' + s20.humGain);

    const s100 = r.samples[100];
    assert.ok(Math.abs(s100.humFreq - s100.humTarget.f) / s100.humTarget.f < 0.15, `live hum frequency tracks target: ${s100.humFreq} vs ${s100.humTarget.f}`);
    assert.ok(s100.humFreq < s20.humFreq, 'wider orbit → lower hum');
    assert.ok(s100.wobble > 0.2, 'hot planet wobble depth: ' + s100.wobble);
    assert.ok(s100.clickOn, 'click train running at heat ≈ 0.84');
    assert.ok(s100.clicks > 3, 'clicks scheduled: ' + s100.clicks);
    const heat100 = 100 / 119;
    assert.ok(Math.abs(s100.hiss - 0.18 * heat100 * heat100) < 1e-6, 'hiss target 0.18·heat²: ' + s100.hiss);
    assert.ok(s100.hissGain > 0.05, 'live hiss gain follows: ' + s100.hissGain);

    const s119 = r.samples[119];
    assert.ok(s119.clicks >= s100.clicks + 3, 'click train kept firing as heat → 1');
    assert.ok(s119.humTarget.pan > 0.55, 'pan clamped to +0.6 at the right wall: ' + s119.humTarget.pan);

    const s134 = r.samples[134];
    assert.equal(s134.humOn, true);
    assert.equal(s134.humTarget.hot, false);
    assert.equal(s134.clickOn, false, 'clicks stop below heat 0.5');
    assert.ok(s134.wobble < 0.1, 'wobble fades on a cold planet: ' + s134.wobble);

    const s150 = r.samples[150];
    assert.equal(s150.humOn, false, 'no hum in FLIGHT');
    assert.ok(s150.humGain < 0.01, 'hum gain ramped out: ' + s150.humGain);
    assert.ok(s150.hiss > 0 && s150.hiss < 0.18 * 0.36 + 1e-9, 'hiss keeps following heat in flight: ' + s150.hiss);

    const s179 = r.samples[179];
    assert.equal(s179.humOn, false);
    assert.equal(s179.hiss, 0, 'DEAD → hiss silent');
    assert.ok(s179.hissGain < 0.01, 'hiss gain ramped to 0: ' + s179.hissGain);
    assert.equal(s179.clickOn, false);
    await page.close();
  });

  test('BURN_WARN arms the click train, RELEASE/DEATH cut it, DEATH kills the hum', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(async ({ SKIN, THEME }) => {
      const GA = window.G.gameAudio;
      GA.init();
      await window.G.audio.unlock();
      GA.newRun({ seed: 1, skin: SKIN, theme: THEME });
      const run = { state: 'TETHERED', heat: 0.55, tether: { planetId: 0, r: 100 }, comet: { x: 270 }, planets: { 0: { hot: false } } };
      GA.update(run, 1 / 60);
      const c0 = GA._test.clicks();
      GA.onEvent({ type: 'BURN_WARN' });
      GA.update(run, 1 / 60);
      const afterWarn = GA._test.snapshot();
      GA.onEvent({ type: 'RELEASE', heat: 0.55, hotShot: false, theta: 0, x: 270, y: 0, speed: 500 });
      const afterRelease = GA._test.snapshot();
      run.heat = 0.9;
      GA.update(run, 1 / 60);
      const rearmed = GA._test.snapshot();
      GA.onEvent({ type: 'DEATH', deathType: 'BURNED', x: 270, y: 0, pool: 0 });
      const afterDeath = GA._test.snapshot();
      return { c0, afterWarn, afterRelease, rearmed, afterDeath };
    }, { SKIN, THEME });
    assert.deepEqual(errors, []);
    assert.ok(r.afterWarn.clicks > r.c0, 'blips booked after BURN_WARN');
    assert.equal(r.afterWarn.clickOn, true);
    assert.equal(r.afterRelease.clickOn, false, 'RELEASE cuts the train');
    assert.equal(r.rearmed.clickOn, true, 'tethered again at heat 0.9 → train restarts');
    assert.equal(r.afterDeath.clickOn, false, 'BURNED death cuts the train');
    assert.equal(r.afterDeath.humOn, false, 'death kills the hum');
    assert.equal(r.afterDeath.slammed, true, 'DEATH event slams the music lowpass');
    await page.close();
  });

  test('setChain drives music intensity; death() slams the music lowpass to 250 Hz and restore() reopens it', async () => {
    const { page, errors } = await newPage();
    const base = await page.evaluate(async () => {
      const A = window.G.audio;
      const GA = window.G.gameAudio;
      GA.init();
      await A.unlock();
      A.music.start('main');
      GA.setChain(1, 0);                       // intensity 0 → bus cutoff settles at its floor (1200 Hz)
      const I0 = A.music.getIntensity();
      GA.setChain(3, 2000);
      const I1 = A.music.getIntensity();
      GA.setChain(2, 1000);
      const Imid = A.music.getIntensity();
      GA.setChain(1, 0);
      return { I0, I1, Imid, playing: A.music.isPlaying() };
    });
    assert.deepEqual(base, { I0: 0, I1: 1, Imid: 0.5, playing: true });
    await page.waitForTimeout(1200);
    const open = await page.evaluate(() => window.G.gameAudio._test.musicCutoff());
    assert.ok(open > 1000 && open < 1400, 'cutoff at intensity 0 floor: ' + open);

    await page.evaluate(() => window.G.gameAudio.death());
    await page.waitForTimeout(550);
    const slammed = await page.evaluate(() => ({ cutoff: window.G.gameAudio._test.musicCutoff(), flag: window.G.gameAudio._test.snapshot().slammed }));
    assert.ok(slammed.cutoff < 300, 'slammed to 250 Hz: ' + slammed.cutoff);
    assert.equal(slammed.flag, true);

    await page.evaluate(() => { window.G.gameAudio.death(); window.G.gameAudio.restore(); }); // repeated slam is harmless; restore is idempotent
    await page.waitForTimeout(450);
    const restored = await page.evaluate(() => ({ cutoff: window.G.gameAudio._test.musicCutoff(), flag: window.G.gameAudio._test.snapshot().slammed }));
    assert.ok(restored.cutoff > 1000, 'restored toward the pre-slam cutoff: ' + restored.cutoff);
    assert.equal(restored.flag, false);

    // newRun() after a death also reopens the filter.
    await page.evaluate(() => window.G.gameAudio.death());
    await page.waitForTimeout(500);
    await page.evaluate(() => window.G.gameAudio.newRun({ seed: 5 }));
    await page.waitForTimeout(450);
    const viaNewRun = await page.evaluate(() => window.G.gameAudio._test.musicCutoff());
    assert.ok(viaNewRun > 1000, 'newRun restores the slam: ' + viaNewRun);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('with SFX off (or ad-muted) events create nothing but counters still advance', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(async ({ EVENTS, SKIN, THEME }) => {
      const A = window.G.audio;
      const GA = window.G.gameAudio;
      GA.init();
      await A.unlock();
      GA.newRun({ seed: 9, skin: SKIN, theme: THEME });
      GA.update({ state: 'FLIGHT', heat: 0, comet: { x: 270 }, tether: null, planets: {} }, 1 / 60); // builds the rig
      A.setSfx(false);
      const before = window.__nodes;
      for (const e of EVENTS) GA.onEvent(e);
      const sfxOff = window.__nodes - before;
      A.setSfx(true);
      A.adMute(true);
      for (const e of EVENTS) GA.onEvent(e);
      const adMuted = window.__nodes - before;
      A.adMute(false);
      return { sfxOff, adMuted, latches: GA.key.latchCount, voices: GA._test.activeVoices() };
    }, { EVENTS, SKIN, THEME });
    assert.deepEqual(errors, []);
    assert.equal(r.sfxOff, 0, 'no nodes with SFX off');
    assert.equal(r.adMuted, 0, 'no nodes while ad-muted');
    assert.equal(r.latches, 2);
    assert.equal(r.voices, 0);
    await page.close();
  });

  test('offline renders of LOOP, DEATH (all three) and the other one-shots peak within [0.05, 0.99]', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(async ({ SKIN, THEME }) => {
      const GA = window.G.gameAudio;
      GA.init();
      GA.newRun({ seed: 77, skin: SKIN, theme: THEME });
      const peak = async (evt, seconds) => {
        const buf = await GA.renderEvent(evt, seconds);
        let p = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > p) p = v; }
        }
        return { peak: p, length: buf.length, channels: buf.numberOfChannels };
      };
      const out = {};
      out.LOOP = await peak({ type: 'LOOP', amount: 20, bankedTotal: 120, pooledBefore: 150, x: 270, y: 400 }, 1.5);
      out.LOOP_rich = await peak({ type: 'LOOP', pooledBefore: 900, x: 270 }, 1.0);
      out.DEATH_FELL = await peak({ type: 'DEATH', deathType: 'FELL', x: 270, y: 0, pool: 40 }, 1.5);
      out.DEATH_BURNED = await peak({ type: 'DEATH', deathType: 'BURNED', x: 270, y: 0, pool: 0 }, 1.5);
      out.DEATH_CRASHED = await peak({ type: 'DEATH', deathType: 'CRASHED', x: 270, y: 0, pool: 0 }, 1.5);
      out.LATCH = await peak({ type: 'LATCH', planetId: 1, r: 100, theta: 0, s: 1, x: 270, y: 0 }, 1.0);
      GA.setChain(4, 0);
      out.LATCH_x4 = await peak({ type: 'LATCH', planetId: 1, r: 100, theta: 0, s: 1, x: 270, y: 0 }, 1.0);
      out.RELEASE = await peak({ type: 'RELEASE', heat: 0.9, hotShot: true, theta: 0, x: 400, y: 0, speed: 600 }, 0.6);
      out.HOT_SHOT = await peak({ type: 'HOT_SHOT', amount: 10, M: 2 }, 0.6);
      out.GRAZE = await peak({ type: 'GRAZE', planetId: 2, amount: 5, M: 2, x: 100, y: 0 }, 0.5);
      out.LONG_SHOT = await peak({ type: 'LONG_SHOT', amount: 10, M: 2 }, 0.5);
      out.WALL = await peak({ type: 'WALL', x: 9, y: 0, side: -1 }, 0.4);
      out.SNAP = await peak({ type: 'SNAP', x: 531, y: 0 }, 0.4);
      out.LINE_PASSED = await peak({ type: 'LINE_PASSED', altM: 300 }, 0.8);
      for (const timbre of ['sine', 'square', 'saw']) {
        GA.newRun({ seed: 3, skin: { timbre }, theme: { mood: 'major' } });
        out['LATCH_' + timbre] = await peak({ type: 'LATCH', planetId: 1, r: 100, theta: 0, s: 1, x: 270, y: 0 }, 0.8);
      }
      let silentErr = null;
      try { await GA.renderEvent({ type: 'CHUNK', k: 1 }); } catch (e) { silentErr = String(e); }
      let badErr = null;
      try { await GA.renderEvent(null); } catch (e) { badErr = String(e); }
      return { out, silentErr, badErr, unlocked: window.G.audio.state.unlocked };
    }, { SKIN, THEME });
    assert.deepEqual(errors, []);
    assert.equal(r.unlocked, false, 'offline rendering needs no unlock');
    for (const [name, { peak, length, channels }] of Object.entries(r.out)) {
      assert.equal(channels, 2, name + ' stereo');
      assert.ok(length > 0, name + ' length');
      assert.ok(peak >= 0.05 && peak <= 0.99, `${name} peak ${peak.toFixed(3)} within [0.05, 0.99]`);
    }
    assert.ok(r.out.LOOP_rich.peak >= r.out.LOOP.peak * 0.95, 'bigger pool is not quieter');
    assert.match(r.silentErr, /silent event/);
    assert.match(r.badErr, /bad event/);
    await page.close();
  });

  test('renders differ by key: a major-mode LATCH and a minor-mode LATCH are not the same signal', async () => {
    const { page } = await newPage();
    const r = await page.evaluate(async () => {
      const GA = window.G.gameAudio;
      const zc = async () => {
        const buf = await GA.renderEvent({ type: 'LATCH', planetId: 1, r: 100, theta: 0, s: 1, x: 270, y: 0 }, 0.3);
        const d = buf.getChannelData(0);
        let z = 0;
        const n = Math.floor(buf.sampleRate * 0.1);
        for (let i = 1; i < n; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) z++;
        return z;
      };
      const a = [];
      for (let s = 0; s < 6; s++) { GA.newRun({ seed: s * 31 + 1, theme: { mood: 'minor' } }); a.push(await zc()); }
      return a;
    });
    assert.ok(new Set(r).size >= 3, 'different seeds → different first notes (zero crossings): ' + r.join(','));
    await page.close();
  });
});
