// Tests for game/js/render.js (G.render).
// Run: node tests/render.test.mjs
//
// Static part: source conventions (strict mode, no shadowBlur, no Math.random,
// exported API list). Browser part (Playwright, headless Chromium): loads
// config/storage/i18n/sim/duel/meta/render (no sdk/audio), creates a real run
// driven 600 steps by the perfect bot, resizes to portrait 390x844 and
// landscape 1280x720, draws 60 frames each without exceptions and asserts the
// column contains non-background pixels; share card 1080x1080 with pixel
// variance; every ui primitive and icon; pointer <-> logical roundtrip; all
// particle kinds, floating text and effects; auto-quality stepping; every
// theme and skin; duel ghost + dashed line; DEAD state; hostile / minimal runs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const JS = (f) => path.resolve(here, '../game/js', f);
const FILES = ['config.js', 'storage.js', 'i18n.js', 'sim.js', 'duel.js', 'meta.js', 'render.js'].map(JS);
const SRC = fs.readFileSync(JS('render.js'), 'utf8');

const API = ['init', 'resize', 'view', 'worldToScreen', 'pointerToLogical', 'logicalToPointer', 'setTheme', 'setSkin', 'setReduceMotion',
  'setQualityAuto', 'drawFrame', 'drawShareCard', 'particles', 'floatText', 'shake', 'zoomPulse', 'flash', 'onEvent', 'reset',
  'heatColor', 'skyColorAt', 'hud', 'ui', 'THEME_DEFAULT', 'SKIN_DEFAULT', 'ICON_NAMES'];
const UI = ['button', 'panel', 'text', 'icon', 'toggle', 'ring', 'measureText', 'roundRect', 'font'];
const ICONS = ['play', 'skins', 'missions', 'daily', 'share', 'support', 'settings', 'mute', 'unmute', 'pause', 'home', 'back', 'close',
  'rewind', 'dust', 'check', 'lock', 'trophy', 'flame', 'loop', 'gear', 'globe', 'copy', 'telegram'];

/* ------------------------------------------------------------------ */
/* Static source checks                                                 */
/* ------------------------------------------------------------------ */

describe('render.js source conventions', () => {
  test('strict IIFE, no shadowBlur assignments, no Math.random, no ES modules', () => {
    assert.match(SRC, /^\(function \(\) \{\s*'use strict';/m);
    assert.doesNotMatch(SRC, /shadowBlur\s*=/);
    assert.doesNotMatch(SRC, /Math\.random/);
    assert.doesNotMatch(SRC, /^\s*(import|export)\s/m);
    assert.doesNotMatch(SRC, /TODO|FIXME|XXX/);
  });
  test('glow is a single pre-rendered sprite used in lighter mode', () => {
    assert.match(SRC, /function makeGlow\(\)/);
    assert.match(SRC, /globalCompositeOperation = 'lighter'/);
  });
});

/* ------------------------------------------------------------------ */
/* Browser part                                                         */
/* ------------------------------------------------------------------ */

describe('G.render in headless Chromium', () => {
  let browser;

  before(async () => {
    const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs');
    browser = await chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); });

  async function newPage(opts = {}) {
    const page = await browser.newPage({ viewport: { width: opts.w || 390, height: opts.h || 844 }, deviceScaleFactor: opts.dpr || 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<!doctype html><meta charset="utf-8"><title>render</title><style>html,body{margin:0;background:#000}canvas{display:block}</style><canvas id="game"></canvas>');
    for (const f of FILES) await page.addScriptTag({ path: f });
    await page.evaluate(() => {
      G.storage.init();
      G.i18n.init({ lang: 'en' });
      G.meta.init();
      G.render.init(document.getElementById('game'));
      G.render.resize(innerWidth, innerHeight, devicePixelRatio);
    });
    return { page, errors };
  }

  /** Browser-side helpers injected once per page: run factory, frame builder, pixel stats. */
  const HELPERS = `
    window.T = {
      makeRun(seed, steps) {
        const run = G.sim.createRun({ seed, mode: 'free', duel: null });
        const events = [];
        for (let i = 0; i < steps; i++) {
          const held = G.sim.bots.perfect(run).held;
          G.sim.step(run, { held });
          for (const e of run.events) events.push(e);
          run.events.length = 0;
          if (run.state === 'DEAD') break;
        }
        return { run, events };
      },
      frame(run, t, extra) {
        const target = G.sim.getTarget(run);
        return Object.assign({
          alpha: 0.5, camY: run.camBottom, t, simT: run.t, held: run.held, target,
          showReticle: true, showAimGuide: true, effects: { shake: 0, zoom: 1, flash: 0, vignette: 0 },
          heat: run.heat, duel: null, bestAltM: 50, M: run.score.M, pool: run.score.pool,
          hud: { score: G.sim.scoreOf(run), alt: run.score.alt, banked: run.score.banked, pool: run.score.pool, M: run.score.M,
                 duelName: null, duelScore: null, dailyNumber: 42, missionText: 'Graze 5 planets 2/5' }
        }, extra || {});
      },
      // pixel statistics of a canvas region (device px)
      stats(cv, x, y, w, h) {
        const c = cv.getContext('2d');
        const d = c.getImageData(x, y, w, h).data;
        let n = 0, sum = [0, 0, 0], sq = [0, 0, 0];
        const hist = new Map();
        for (let i = 0; i < d.length; i += 4) {
          n++;
          for (let k = 0; k < 3; k++) { sum[k] += d[i + k]; sq[k] += d[i + k] * d[i + k]; }
          const key = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4);
          hist.set(key, (hist.get(key) || 0) + 1);
        }
        let dominant = 0;
        for (const v of hist.values()) if (v > dominant) dominant = v;
        const variance = sum.map((s, k) => sq[k] / n - (s / n) * (s / n)).reduce((a, b) => a + b, 0) / 3;
        return { n, variance, distinct: hist.size, nonDominantFrac: 1 - dominant / n };
      },
      columnStats() {
        const cv = G.render.canvas, v = G.render.view;
        const x = Math.round(v.offX * v.dpr), y = Math.round(v.offY * v.dpr);
        const w = Math.round(540 * v.scale * v.dpr), h = Math.round(960 * v.scale * v.dpr);
        return T.stats(cv, x, y, w, h);
      }
    };`;

  test('exposes the contract API and ui kit', async () => {
    const { page, errors } = await newPage();
    const shape = await page.evaluate(({ API, UI }) => ({
      api: API.filter((k) => !(k in G.render)),
      ui: UI.filter((k) => typeof G.render.ui[k] !== 'function'),
      ctx: !!G.render.ctx, canvas: !!G.render.canvas,
      spawn: typeof G.render.particles.spawn,
      view: G.render.view,
      icons: G.render.ICON_NAMES.slice()
    }), { API, UI });
    assert.deepEqual(shape.api, [], 'missing API members');
    assert.deepEqual(shape.ui, [], 'missing ui primitives');
    assert.ok(shape.ctx && shape.canvas);
    assert.equal(shape.spawn, 'function');
    for (const n of ICONS) assert.ok(shape.icons.includes(n), 'icon ' + n);
    assert.equal(shape.view.cssW, 390);
    assert.equal(shape.view.cssH, 844);
    assert.equal(shape.view.landscape, false);
    assert.ok(Math.abs(shape.view.scale - Math.min(390 / 540, 844 / 960)) < 1e-9);
    assert.deepEqual(shape.view.safe, { x0: 0, y0: 0, x1: 540, y1: 960 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('worldToScreen and pointer <-> logical roundtrip', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(() => {
      const out = {};
      out.w2s = [G.render.worldToScreen(270, 480, 0), G.render.worldToScreen(100, -480, -480), G.render.worldToScreen(0, 1500, 1000)];
      out.round = [];
      for (const [lx, ly] of [[0, 0], [540, 960], [270, 480], [-40, 1000], [600, -20]]) {
        const [cx, cy] = G.render.logicalToPointer(lx, ly);
        const [bx, by] = G.render.pointerToLogical(cx, cy);
        out.round.push([lx, ly, bx, by]);
      }
      const v = G.render.view;
      out.corner = G.render.pointerToLogical(0, 0);
      out.visible = v.visible;
      return out;
    });
    assert.deepEqual(r.w2s[0], [270, 480]);
    assert.deepEqual(r.w2s[1], [100, 960]);
    assert.deepEqual(r.w2s[2], [0, 460]);
    for (const [lx, ly, bx, by] of r.round) {
      assert.ok(Math.abs(lx - bx) < 1e-6 && Math.abs(ly - by) < 1e-6, `roundtrip ${lx},${ly} -> ${bx},${by}`);
    }
    assert.ok(Math.abs(r.corner[0] - r.visible.x0) < 1e-6 && Math.abs(r.corner[1] - r.visible.y0) < 1e-6);
    assert.deepEqual(errors, []);
    await page.close();
  });

  for (const [label, w, h, dpr] of [['portrait 390x844', 390, 844, 2], ['landscape 1280x720', 1280, 720, 1]]) {
    test(`draws 60 frames of a real 600-step run in ${label} with content in the column`, async () => {
      const { page, errors } = await newPage({ w, h, dpr });
      await page.addScriptTag({ content: HELPERS });
      const r = await page.evaluate(([w, h, dpr]) => {
        G.render.resize(w, h, dpr);
        const { run, events } = T.makeRun(12345, 600);
        for (const e of events) G.render.onEvent(e);
        G.render.setTheme(G.meta.THEMES[0]);
        G.render.setSkin(G.meta.SKINS[0]);
        const t0 = performance.now();
        let frames = 0;
        for (let i = 0; i < 60; i++) {
          // keep the sim alive a few steps per frame so the trail / tether animate
          for (let s = 0; s < 2 && run.state !== 'DEAD'; s++) {
            G.sim.step(run, { held: G.sim.bots.perfect(run).held });
            for (const e of run.events) G.render.onEvent(e);
            run.events.length = 0;
          }
          G.render.drawFrame(run, T.frame(run, i / 60));
          frames++;
        }
        const ms = (performance.now() - t0) / frames;
        const st = T.columnStats();
        return {
          frames, ms, st, state: run.state, latches: run.counters.latches, alt: run.score.alt,
          view: G.render.view, pause: G.render.hud.pause, particles: G.render.particleCount,
          canvasW: G.render.canvas.width, canvasH: G.render.canvas.height
        };
      }, [w, h, dpr]);
      assert.equal(r.frames, 60);
      assert.ok(r.latches >= 2, 'the perfect bot latched at least twice: ' + r.latches);
      assert.equal(r.view.landscape, w > h);
      assert.equal(r.canvasW, Math.round(w * Math.min(dpr, 2)));
      assert.equal(r.canvasH, Math.round(h * Math.min(dpr, 2)));
      assert.ok(r.st.n > 10000, 'column region sampled');
      assert.ok(r.st.variance > 50, 'column has pixel variance: ' + r.st.variance);
      assert.ok(r.st.nonDominantFrac > 0.08, 'column has non-background pixels: ' + r.st.nonDominantFrac);
      assert.ok(r.st.distinct > 40, 'column has many colours: ' + r.st.distinct);
      assert.ok(r.particles <= 400, 'particle pool bounded');
      assert.ok(r.pause.w >= 44 && r.pause.h >= 44, 'pause rect exposed');
      assert.ok(r.ms < 80, 'headless frame time sane: ' + r.ms.toFixed(2) + ' ms');
      assert.deepEqual(errors, []);
      await page.close();
    });
  }

  test('share card is 1080x1080 with non-trivial content and never mutates renderer state', async () => {
    const { page, errors } = await newPage();
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate(() => {
      const { run } = T.makeRun(777, 900);
      G.render.setTheme(G.meta.THEMES[1]);
      const before = { theme: G.render.theme.id, skin: G.render.skin.id, ctx: G.render.ctx };
      const cv = G.render.drawShareCard(run, {
        name: 'Ali', score: G.sim.scoreOf(run), altM: run.score.alt, style: run.score.banked, rankId: 'meteor',
        label: 'Daily #42', url: G.CONFIG.SHARE.APP_URL, beatMe: true, theme: G.meta.THEMES[3], skin: G.meta.SKINS[6]
      });
      const after = { theme: G.render.theme.id, skin: G.render.skin.id, ctxSame: G.render.ctx === before.ctx };
      const whole = T.stats(cv, 0, 0, 1080, 1080);
      const art = T.stats(cv, 64, 180, 952, 560);
      const footer = T.stats(cv, 64, 820, 952, 200);
      // minimal meta / fake run must also work
      const cv2 = G.render.drawShareCard({ seed: 1, samples: [[270, 0], [280, 300]], score: { alt: 30, banked: 0 } }, {});
      return { w: cv.width, h: cv.height, whole, art, footer, before, after, w2: cv2.width, h2: cv2.height };
    });
    assert.equal(r.w, 1080); assert.equal(r.h, 1080);
    assert.equal(r.w2, 1080); assert.equal(r.h2, 1080);
    assert.ok(r.whole.variance > 100, 'card variance ' + r.whole.variance);
    assert.ok(r.art.nonDominantFrac > 0.05, 'artwork region has content ' + r.art.nonDominantFrac);
    assert.ok(r.footer.nonDominantFrac > 0.03, 'footer has text ' + r.footer.nonDominantFrac);
    assert.equal(r.after.theme, r.before.theme);
    assert.equal(r.after.skin, r.before.skin);
    assert.ok(r.after.ctxSame);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('ui primitives and every icon draw without error and produce pixels', async () => {
    const { page, errors } = await newPage();
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate((ICONS) => {
      const ui = G.render.ui, c = G.render.ctx;
      c.fillStyle = '#000'; c.fillRect(-500, -500, 2000, 3000);
      ui.panel({ x: 20, y: 20, w: 500, h: 900 }, { radius: 24 });
      ui.button({ x: 40, y: 40, w: 460, h: 64 }, 'PLAY', { icon: 'play', primary: true });
      ui.button({ x: 40, y: 120, w: 460, h: 56 }, 'Disabled', { disabled: true });
      ui.button({ x: 40, y: 190, w: 220, h: 56 }, 'Pressed', { pressed: true, small: true, icon: 'share' });
      ui.button({ x: 280, y: 190, w: 220, h: 56 }, '', { icon: 'settings' });
      ui.button({ x: 40, y: 260, w: 460, h: 56 }, 'A very long label that must shrink to fit inside the button width', {});
      ui.text('1,234', 270, 340, { size: 56, weight: 800, align: 'center', baseline: 'top', halo: true, spacing: 0.06 });
      ui.text('left', 40, 420, { size: 18, align: 'left' });
      ui.text('right', 500, 420, { size: 18, align: 'right', color: '#ffd54a' });
      ui.text('shrunk to a max width of eighty pixels', 40, 450, { size: 18, maxWidth: 80 });
      ui.toggle({ x: 40, y: 480, w: 460, h: 56 }, true, 'Sound');
      ui.toggle({ x: 40, y: 540, w: 460, h: 56 }, false, 'Music');
      ui.ring(100, 650, 30, 0.66, '#58ffb0', 6);
      ui.ring(180, 650, 30, 0, null, 4);
      ui.ring(260, 650, 30, 1, '#ff5a6a');
      ui.roundRect(300, 620, 200, 60, 14); c.fillStyle = '#345'; c.fill();
      const m = ui.measureText('HOLD TO PLAY', 24, 800);
      const m2 = ui.measureText('HOLD TO PLAY', 24, 800, 0.06);
      const iconStats = [];
      ICONS.forEach((name, i) => {
        const x = 50 + (i % 8) * 60, y = 720 + Math.floor(i / 8) * 60;
        ui.icon(name, x, y, 32, '#fff');
        const v = G.render.view;
        iconStats.push([name, T.stats(G.render.canvas, Math.round((x - 18 + v.offX / v.scale) * v.scale * v.dpr) , Math.round((y - 18 + v.offY / v.scale) * v.scale * v.dpr), Math.round(36 * v.scale * v.dpr), Math.round(36 * v.scale * v.dpr)).nonDominantFrac]);
      });
      ui.icon('not-an-icon', 270, 900, 32, '#fff');
      const font = ui.font(18, 600);
      return { m, m2, iconStats, font, all: T.columnStats() };
    }, ICONS);
    assert.ok(r.m.width > 50 && r.m.height > 0);
    assert.ok(r.m2.width > r.m.width, 'letter spacing widens measurement');
    assert.match(r.font, /^600 18px system-ui/);
    for (const [name, frac] of r.iconStats) assert.ok(frac > 0.02, `icon ${name} drew pixels (${frac})`);
    assert.ok(r.all.distinct > 30);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('particles (all kinds), floating text, effects, reduce motion and pool bounds', async () => {
    const { page, errors } = await newPage();
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate(() => {
      const { run } = T.makeRun(4242, 300);
      const kinds = Object.keys(G.render.particles.kinds);
      const counts = {};
      for (const k of kinds) {
        G.render.reset();
        G.render.particles.spawn(k, run.comet.x, run.comet.y, { dir: [1, 0], side: -1 });
        counts[k] = G.render.particleCount;
      }
      G.render.reset();
      for (let i = 0; i < 5; i++) G.render.particles.spawn('death', 270, run.comet.y);
      const maxCount = G.render.particleCount;
      for (let i = 0; i < 20; i++) G.render.floatText('GRAZE +' + i, 100 + i * 10, run.comet.y + i, { color: '#ffe9a8', size: 20 });
      G.render.floatText(null, NaN, undefined);
      G.render.shake(8); G.render.zoomPulse(); G.render.flash();
      G.render.particles.spawn('unknown-kind', 1, 2);
      let t = 0;
      for (let i = 0; i < 90; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t, { effects: { shake: 3, zoom: 0.04, flash: i < 2 ? 0.5 : 0, vignette: 0.1 } })); }
      const afterParticles = G.render.particleCount;
      G.render.setReduceMotion(true);
      G.render.shake(8); G.render.zoomPulse(); G.render.flash();
      for (let i = 0; i < 10; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t)); }
      const rm = G.render.reduceMotion;
      G.render.setReduceMotion(false);
      // event mapping convenience
      const evts = [
        { type: 'LATCH', planetId: 5, r: 120, theta: -1.57, s: 1, x: 270, y: 120 }, { type: 'RELEASE', heat: 0.8, hotShot: true, theta: 0.3, x: 300, y: 150, speed: 588 },
        { type: 'HOT_SHOT', amount: 10, M: 2 }, { type: 'GRAZE', planetId: 6, amount: 5, M: 2, x: 200, y: 400 }, { type: 'LONG_SHOT', amount: 10, M: 2 },
        { type: 'LOOP', amount: 20, bankedTotal: 120, pooledBefore: 150, x: 270, y: 400 }, { type: 'WALL', x: 9, y: 500, side: -1 }, { type: 'SNAP', x: 531, y: 600 },
        { type: 'BURN_WARN' }, { type: 'LINE_PASSED', altM: 300 }, { type: 'CHUNK', k: 1 }, { type: 'LAUNCH' }, { type: 'DEATH', deathType: 'FELL', x: 270, y: 100, pool: 40 },
        null, undefined, {}, { type: 42 }, { type: 'GRAZE', x: NaN, amount: 'x' }
      ];
      for (const e of evts) G.render.onEvent(e);
      for (let i = 0; i < 30; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t)); }
      return { counts, maxCount, afterParticles, rm, after: G.render.particleCount };
    });
    assert.equal(r.counts.latch, 8); assert.equal(r.counts.release, 6); assert.equal(r.counts.graze, 14);
    assert.equal(r.counts.hotshot, 20); assert.equal(r.counts.loop, 60); assert.equal(r.counts.death, 200);
    assert.equal(r.counts.wall, 6); assert.equal(r.counts.embers, 1);
    assert.equal(r.maxCount, 400, 'pool caps at 400');
    assert.ok(r.afterParticles < 400, 'particles die over time');
    assert.equal(r.rm, true);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('auto quality steps DPR 2 -> 1.5 -> 1 -> no glow and recovers', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(() => {
      const seq = [];
      G.render.resize(390, 844, 3);
      seq.push([G.render.quality.level, G.render.view.dpr]);
      for (let i = 0; i < 3; i++) { const level = G.render.setQualityAuto(30); const q = G.render.quality; seq.push([level, G.render.view.dpr, q.glow, G.render.canvas.width, q.level, q.label]); }
      const stuck = G.render.setQualityAuto(30);
      const calm = [];
      for (let i = 0; i < 12; i++) calm.push(G.render.setQualityAuto(5));
      const noisy = G.render.setQualityAuto(15);
      const nan = G.render.setQualityAuto(NaN);
      return { seq, stuck, calm, noisy, nan };
    });
    assert.deepEqual(r.seq[0], [0, 2]);
    assert.deepEqual(r.seq[1].slice(0, 3), [1, 1.5, true]);
    assert.deepEqual(r.seq[2].slice(0, 3), [2, 1, true]);
    assert.deepEqual(r.seq[3].slice(0, 3), [3, 1, false]);
    assert.equal(r.seq[1][3], Math.round(390 * 1.5));
    for (const row of r.seq.slice(1)) { assert.equal(typeof row[0], 'number', 'returns the numeric level'); assert.equal(row[0], row[4], 'quality getter agrees'); }
    assert.deepEqual(r.seq.slice(1).map((x) => x[5]), ['medium', 'low', 'minimal']);
    assert.equal(r.stuck, 3, 'does not step below the last level');
    assert.equal(r.nan, 0, 'NaN sample holds the level');
    assert.equal(r.calm[r.calm.length - 1], 0, 'recovers after calm samples: ' + r.calm.join(','));
    assert.equal(r.noisy, 0, 'mid-range samples hold the level');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('every theme and skin renders; heat/sky colour ramps are sane', async () => {
    const { page, errors } = await newPage();
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate(() => {
      const { run } = T.makeRun(99, 500);
      const out = { themes: [], skins: [] };
      let t = 0;
      for (const th of G.meta.THEMES) {
        G.render.setTheme(th);
        for (let i = 0; i < 4; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t, { heat: i / 3 })); }
        out.themes.push([th.id, G.render.theme.id, T.columnStats().distinct]);
      }
      for (const sk of G.meta.SKINS) {
        G.render.setSkin(sk);
        for (let i = 0; i < 6; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t, { heat: 0.5 })); }
        out.skins.push([sk.id, G.render.skin.id, T.columnStats().distinct]);
      }
      G.render.setTheme(null); G.render.setSkin(undefined);
      out.fallback = [G.render.theme.id, G.render.skin.id];
      out.heat = [0, 0.5, 0.7, 0.95, 2, -1, NaN].map((h) => G.render.heatColor(h));
      out.sky = [0, 150, 300, 5000].map((a) => G.render.skyColorAt(a));
      return out;
    });
    for (const [id, got, distinct] of r.themes) { assert.equal(got, id); assert.ok(distinct > 20, id); }
    for (const [id, got, distinct] of r.skins) { assert.equal(got, id); assert.ok(distinct > 20, id); }
    assert.deepEqual(r.fallback, ['indigo', 'ember']);
    for (const col of r.heat) assert.match(col, /^rgba\(\d+,\d+,\d+,1\)$/);
    assert.equal(r.heat[1], 'rgba(255,255,255,1)', 'heat 0.5 is white');
    assert.equal(r.heat[3], 'rgba(255,59,59,1)', 'heat >= 0.9 is red');
    assert.equal(r.heat[4], r.heat[3]); assert.equal(r.heat[5], r.heat[0]); assert.equal(r.heat[6], r.heat[0]);
    assert.deepEqual(r.sky[0], [11, 16, 48]);
    assert.deepEqual(r.sky[3], [10, 10, 20]);
    assert.ok(r.sky[1][1] > r.sky[0][1] && r.sky[1][1] < r.sky[2][1], 'sky interpolates between stops');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('duel ghost + line, DEAD state, TITLE run without hud, minimal fake run and no-canvas safety', async () => {
    const { page, errors } = await newPage({ w: 1280, h: 720, dpr: 1 });
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate(() => {
      const { run } = T.makeRun(2024, 700);
      // duel ghost built with G.duel from a recorded path
      const rec = G.duel.createRecorder();
      rec.onLatch({ planetId: 0, theta: -1.57, r: 120, s: 1 }); rec.onRelease({ theta: 0.4, heat: 0.3 });
      rec.onLatch({ planetId: 1, theta: 2.0, r: 90, s: -1 }); rec.markRewound(); rec.onRelease({ theta: 1.0, heat: 0.8 });
      const payload = G.duel.encode({ seed: run.seed, score: 640, altM: 55, name: 'Ali', path: rec.toBytes() });
      const decoded = G.duel.decode(payload);
      const ghost = G.duel.expandPath(decoded, (id) => { const p = run.planets[id]; return p ? { x0: p.x0, y: p.y, R: p.R } : null; });
      run.duel = { seed: run.seed, score: 640, altM: 55, name: 'Ali' };
      let t = 0;
      for (let i = 0; i < 20; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t, { duel: { altM: 55, name: 'Ali', ghost }, hud: { score: 10, duelName: 'Ali', duelScore: 640, dailyNumber: 7, missionText: 'Bank 100 in one loop' } })); }
      const duelStats = T.columnStats();
      // dead
      run.state = 'DEAD'; run.deathType = 'FELL';
      for (let i = 0; i < 10; i++) { t += 1 / 60; G.render.drawFrame(run, T.frame(run, t)); }
      // title run, no hud
      const title = G.sim.createRun({ seed: 5, mode: 'free', duel: null });
      for (let i = 0; i < 10; i++) { t += 1 / 60; G.render.drawFrame(title, { t, alpha: 1 }); }
      G.render.drawFrame(title);
      G.render.drawFrame(title, null);
      // minimal fake run: no planetList, no samples, drifting + hot + ring planet, bogus fields
      const fake = {
        seed: 9, state: 'FLIGHT', t: 1, comet: { x: 200, y: 300, vx: 50, vy: 200 }, prevComet: { x: 198, y: 296 }, camBottom: -200, heat: 0.8,
        tether: null, chunks: { 0: { decor: [{ x: -200, y: 100, R: 30, palette: 2, side: -1 }] } },
        planets: { 7: { id: 7, x0: 300, y: 500, R: 50, hot: true, drifting: true, amp: 40, period: 3, phase: 0, palette: 1, ring: true, craters: [{ dx: 5, dy: 5, rx: 6, ry: 4, rot: 0.3 }], bands: [{ yOff: 0, h: 6, alpha: 0.1 }] },
                   8: { id: 8, x0: 'nope', y: NaN, R: 20 } },
        score: { alt: 1, banked: 2, pool: 3, M: 2.5 }
      };
      for (let i = 0; i < 10; i++) { t += 1 / 60; G.render.drawFrame(fake, { t, hud: {}, target: { planet: fake.planets[7], d: 150, color: 'amber', cx: 300, cy: 500 } }); }
      G.render.drawFrame(fake, { t, hud: { score: 'x' }, target: { planet: fake.planets[7], d: 150, color: 'red' }, effects: null });
      G.render.drawFrame(null, {});
      G.render.drawFrame(undefined);
      G.render.resize(0, 0, 0); G.render.resize(NaN, undefined); G.render.resize(800, 600, 1);
      G.render.drawFrame(fake, { t });
      return { duelStats, view: G.render.view.cssW };
    });
    assert.ok(r.duelStats.distinct > 20);
    assert.equal(r.view, 800);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('planet sprites are never reused across runs that recycle planet ids', async () => {
    const { page, errors } = await newPage({ w: 540, h: 960, dpr: 1 });
    const r = await page.evaluate(() => {
      const px = (x, y) => Array.from(G.render.ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      const bright = (c) => c[0] + c[1] + c[2];
      // run A: the title run, planet 0 at (270, 0) with R = 56
      const title = G.sim.createRun({ seed: 5, mode: 'free', duel: null });
      for (let i = 0; i < 3; i++) G.render.drawFrame(title, { t: i / 60 });
      const onBigPlanet = px(270 + 40, 480);
      // run B: same planet id 0 at the same place but R = 20 (a new seed re-uses ids from 0)
      const small = { seed: 5, state: 'FLIGHT', t: 1, camBottom: -480, heat: 0, tether: null, chunks: {},
        comet: { x: 100, y: 600, vx: 0, vy: 0 }, prevComet: { x: 100, y: 600 }, score: { alt: 0, banked: 0, pool: 0, M: 1 },
        planets: { 0: { id: 0, x0: 270, y: 0, R: 20, palette: 0 } } };
      for (let i = 0; i < 3; i++) G.render.drawFrame(small, { t: 1 + i / 60 });
      const ring40 = px(270 + 40, 480), ring40b = px(270, 480 - 40), sky = px(270 + 120, 480), centre = px(270, 480);
      // and back to a third run whose planet 0 is big again
      const again = G.sim.createRun({ seed: 6, mode: 'free', duel: null });
      for (let i = 0; i < 3; i++) G.render.drawFrame(again, { t: 2 + i / 60 });
      const bigAgain = px(270 + 40, 480);
      return { onBigPlanet, ring40, ring40b, sky, centre, bigAgain, bright: [bright(onBigPlanet), bright(ring40), bright(sky), bright(centre), bright(bigAgain)] };
    });
    const [big, ring, sky, centre, bigAgain] = r.bright;
    assert.ok(big > sky + 60, 'run A planet body is visible at radius 40: ' + JSON.stringify(r.onBigPlanet));
    assert.ok(Math.abs(ring - sky) < 30, 'run B shows sky at radius 40 (no stale R=56 sprite): ' + JSON.stringify(r.ring40) + ' vs ' + JSON.stringify(r.sky));
    assert.ok(Math.abs(r.bright[1] - sky) < 30 && Math.abs(r.ring40b.reduce((a, b) => a + b, 0) - sky) < 30);
    assert.ok(centre > sky + 60, 'run B small planet body is drawn at its centre');
    assert.ok(bigAgain > sky + 60, 'run C big planet redrawn after the small one');
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('positionless events (HOT_SHOT / LONG_SHOT / LINE_PASSED) label the comet, not world (270, 0)', async () => {
    const { page, errors } = await newPage({ w: 540, h: 960, dpr: 1 });
    await page.addScriptTag({ content: HELPERS });
    const r = await page.evaluate(() => {
      // comet high up at y = 3000 flying upward; world (270, 0) is far below the camera
      const run = { seed: 11, state: 'FLIGHT', t: 2, camBottom: 2500, heat: 0, tether: null, chunks: {},
        comet: { x: 270, y: 3000, vx: 0, vy: 300 }, prevComet: { x: 270, y: 2998 }, score: { alt: 300, banked: 0, pool: 0, M: 1 }, planets: {} };
      const region = () => T.stats(G.render.canvas, 150, 960 - (3000 - 2500) - 110, 240, 80); // 30..110 px above the comet
      const out = {};
      const times = [5, 5.05, 5.1, 5.15]; // the label scales in over 220 ms, so advance wall time
      for (const type of ['HOT_SHOT', 'LONG_SHOT', 'LINE_PASSED']) {
        G.render.reset();
        for (const t of times) G.render.drawFrame(run, { t });
        const before = region().nonDominantFrac;
        G.render.reset();
        G.render.drawFrame(run, { t: times[0] });
        G.render.onEvent({ type, amount: 10, M: 2, altM: 300 });
        for (const t of times.slice(1)) G.render.drawFrame(run, { t });
        out[type] = [before, region().nonDominantFrac];
      }
      return out;
    });
    for (const [type, [before, after]] of Object.entries(r)) {
      assert.ok(after > before + 0.02, type + ' label appears above the comet: ' + before + ' -> ' + after);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('hostile geometry never throws: bad planet radii, decor, Map planets, ui kit, share card', async () => {
    const { page, errors } = await newPage();
    const r = await page.evaluate(() => {
      const out = [];
      const mk = (planets, extra) => Object.assign({ seed: 3, state: 'FLIGHT', t: 1, comet: { x: 200, y: 300, vx: 50, vy: 200 }, prevComet: { x: 198, y: 296 },
        camBottom: -200, heat: 0.5, tether: null, chunks: {}, planets, score: { alt: 1, banked: 2, pool: 3, M: 2.5 } }, extra || {});
      const cases = {
        nanR: { 1: { id: 1, x0: 270, y: 300, R: NaN } },
        zeroR: { 1: { id: 1, x0: 270, y: 300, R: 0 } },
        negR: { 1: { id: 1, x0: 270, y: 300, R: -5, ring: true } },
        tinyR: { 1: { id: 1, x0: 270, y: 300, R: 0.2, ring: true, craters: [{ dx: 0, dy: 0, rx: -3, ry: -1 }] } },
        hugeR: { 1: { id: 1, x0: 270, y: 300, R: 1e6 } },
        strR: { 1: { id: 1, x0: 270, y: 300, R: '40' } },
        nullP: { 1: null, 2: undefined, 3: 7 },
        nanPalette: { 1: { id: 1, x0: 270, y: 300, R: 40, palette: NaN, ring: true, bands: [{ yOff: NaN, h: -3, alpha: 7 }], craters: [null] } }
      };
      for (const k in cases) {
        try {
          const run = mk(cases[k], { chunks: { 0: { decor: [{ x: -200, y: 100, R: NaN, palette: 1 }, { x: NaN, y: 100, R: 30, palette: NaN }, null, { x: -200, y: 300, R: -4 }, { x: -300, y: 500, R: 30, palette: -7 }] } } });
          G.render.resize(1280, 720, 1);
          for (let i = 0; i < 3; i++) G.render.drawFrame(run, { t: i / 60, hud: {}, target: { planet: run.planets[1], d: NaN, color: 'green' } });
          G.render.resize(390, 844, 2);
          out.push([k, 'ok']);
        } catch (e) { out.push([k, 'THROW ' + e.message]); }
      }
      try {
        const m = new Map(); m.set(1, { id: 1, x0: 270, y: 300, R: 40 });
        const run = mk(m);
        for (let i = 0; i < 3; i++) G.render.drawFrame(run, { t: 1 + i / 60 });
        const v = G.render.view;
        const c = G.render.ctx.getImageData(Math.round((270 + v.offX / v.scale) * v.scale * v.dpr), Math.round((960 - 500 + v.offY / v.scale) * v.scale * v.dpr), 1, 1).data;
        out.push(['map', c[0] + c[1] + c[2] > 120 ? 'ok' : 'planet from Map not drawn ' + Array.from(c).join(',')]);
      } catch (e) { out.push(['map', 'THROW ' + e.message]); }
      try {
        const run = mk({ 1: { id: 1, x0: 270, y: 300, R: 40 } });
        G.render.drawFrame(run, { t: 2, camY: Infinity, heat: Infinity, M: Infinity, pool: Infinity, hud: { score: Infinity } });
        G.render.drawFrame(run, { t: 2.1, camY: -Infinity });
        G.render.drawFrame(run, { t: 2.2, camY: NaN, alpha: NaN, effects: { shake: NaN, zoom: NaN, flash: NaN, vignette: NaN } });
        run.camBottom = 1e9; run.comet.y = 1e9; run.maxY = 1e9; run.score.alt = 1e8;
        G.render.drawFrame(run, { t: 2.3, hud: {} });
        G.render.resize(1, 1, 1); G.render.drawFrame(mk({}), { t: 3, hud: {} });
        G.render.resize(0.3, 0.3, 0.1); G.render.drawFrame(mk({}), { t: 3.1, hud: {} });
        G.render.resize(8000, 8000, 2); G.render.drawFrame(mk({}), { t: 3.2, hud: {} });
        G.render.resize(Infinity, Infinity, Infinity); G.render.drawFrame(mk({}), { t: 3.3, hud: {} });
        G.render.resize(390, 844, 2);
        out.push(['extremes', 'ok']);
      } catch (e) { out.push(['extremes', 'THROW ' + e.message]); }
      try {
        const ui = G.render.ui;
        ui.roundRect(0, 0, 10, 10, -5); ui.ring(10, 10, -5, 0.5); ui.ring(10, 10, NaN, 2, '#fff', -1); ui.button({ x: 0, y: 0, w: -50, h: 20 }, null, { icon: 'play' });
        ui.text(undefined, NaN, NaN, { size: -4, maxWidth: 0, spacing: NaN, halo: true, align: 'center' });
        ui.toggle({ x: 0, y: 0, w: 0, h: 0 }, true, 'x'); ui.panel({ x: 0, y: 0, w: 0, h: 0 }, { radius: -3 }); ui.icon('play', 0, 0, -10); ui.icon('daily', 0, 0, NaN);
        out.push(['ui', 'ok']);
      } catch (e) { out.push(['ui', 'THROW ' + e.message]); }
      try {
        const a = G.render.drawShareCard({ seed: NaN, samples: [[NaN, NaN], null, [1]], chunks: { 0: { planets: [{ id: 0, x0: 270, y: 0, R: NaN }, { id: 1, x0: NaN, y: 100, R: 30 }, null] } } },
          { theme: {}, skin: {}, name: 12, label: {}, rankId: 'nope', url: 'x', beatMe: 1 });
        const b = G.render.drawShareCard(null, null);
        const c3 = G.render.drawShareCard({ seed: 1, samples: [[270, 0], [270, 300000]], maxY: 300000 }, {});
        out.push(['card', a.width === 1080 && b.width === 1080 && c3.width === 1080 ? 'ok' : 'bad size']);
      } catch (e) { out.push(['card', 'THROW ' + e.message]); }
      try {
        // skin with hostile width and the glow pass off: trail / card still draw
        G.render.setSkin({ id: 'x', style: 'beads', width: -20 });
        for (let i = 0; i < 3; i++) G.render.setQualityAuto(100);
        const run = mk({ 1: { id: 1, x0: 270, y: 300, R: 40, hot: true } });
        for (let i = 0; i < 5; i++) G.render.drawFrame(run, { t: 4 + i / 60, hud: {} });
        const cv = G.render.drawShareCard(run, { name: 'Q' });
        G.render.setSkin(G.meta.SKINS[0]);
        for (let i = 0; i < 12; i++) G.render.setQualityAuto(1);
        out.push(['skin', cv.width === 1080 && G.render.quality.level === 0 ? 'ok' : 'bad']);
      } catch (e) { out.push(['skin', 'THROW ' + e.message]); }
      return out;
    });
    for (const [k, v] of r) assert.equal(v, 'ok', k + ': ' + v);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('loads and draws with only config.js present (no sim / meta / i18n / sdk)', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<!doctype html><meta charset="utf-8"><title>render-solo</title><canvas id="game"></canvas>');
    for (const f of ['config.js', 'render.js'].map(JS)) await page.addScriptTag({ path: f });
    const r = await page.evaluate(() => {
      G.render.init(document.getElementById('game')); G.render.resize(390, 844, 2);
      const run = { seed: 1, state: 'TETHERED', t: 1, comet: { x: 270, y: 120, vx: 420, vy: 0 }, prevComet: { x: 270, y: 120 }, camBottom: -480, heat: 0.6,
        tether: { planetId: 0, r: 120, s: 1 }, planets: { 0: { id: 0, x0: 270, y: 0, R: 56, drifting: true, amp: 40, period: 3, phase: 0 } }, samples: [[270, 0], [270, 120]],
        score: { alt: 0, banked: 0, pool: 50, M: 2 }, duel: { altM: 50, name: 'Ali', score: 300 } };
      for (let i = 0; i < 5; i++) {
        G.render.onEvent({ type: 'LOOP', amount: 20, pooledBefore: 10, x: 270, y: 120 });
        G.render.drawFrame(run, { t: i / 60, hud: { score: 5, dailyNumber: 3 }, bestAltM: 30, showAimGuide: true });
      }
      const cv = G.render.drawShareCard(run, { name: 'X', score: 5, altM: 3, style: 2, rankId: 'dust', label: 'Cosmos 1', url: 'u', beatMe: true });
      return [G.render.theme.id, G.render.skin.id, cv.width, G.render.setQualityAuto(50), G.render.heatColor(0.5)];
    });
    assert.deepEqual(r, ['indigo', 'ember', 1080, 1, 'rgba(255,255,255,1)']);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('drawFrame before init is a no-op and resize before init computes the view', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.setContent('<!doctype html><meta charset="utf-8"><title>render-noinit</title>');
    for (const f of FILES) await page.addScriptTag({ path: f });
    const r = await page.evaluate(() => {
      G.render.drawFrame({ state: 'TITLE_ORBIT' }, {});
      G.render.resize(1000, 500, 1);
      G.render.ui.text('x', 0, 0);
      G.render.ui.button({ x: 0, y: 0, w: 10, h: 10 }, 'x');
      return { scale: G.render.view.scale, landscape: G.render.view.landscape, m: G.render.ui.measureText('abc', 12) };
    });
    assert.ok(Math.abs(r.scale - 500 / 960) < 1e-9);
    assert.equal(r.landscape, true);
    assert.deepEqual(r.m, { width: 0, height: 12 });
    assert.deepEqual(errors, []);
    await page.close();
  });
});
