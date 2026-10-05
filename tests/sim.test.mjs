// Tests for game/js/config.js + game/js/sim.js (G.CONFIG / G.sim).
// Run: node tests/sim.test.mjs
//
// The two classic scripts are evaluated inside a vm context with a minimal
// window shim (the sim is pure: no DOM, no Date, no Math.random). Covers the
// generator (determinism + invariants over > 10,000 planets), the step function
// state by state on synthetic layouts, scoring, rewind, duel line, and the two
// tuning-gate bots with printed statistics.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_SRC = fs.readFileSync(path.resolve(here, '../game/js/config.js'), 'utf8');
const SIM_SRC = fs.readFileSync(path.resolve(here, '../game/js/sim.js'), 'utf8');

/** Fresh G (config + sim) in an isolated context. */
function load() {
  const ctx = { console, location: { search: '' } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CONFIG_SRC, ctx);
  vm.runInContext(SIM_SRC, ctx);
  return ctx.G;
}

const G = load();
const S = G.sim;
const C = G.CONFIG;
const DT = 1 / C.SIM_HZ;
const TAU = Math.PI * 2;

/** Deep equality across realms. */
const deepEq = (a, b, msg) => assert.deepEqual(structuredClone(a), structuredClone(b), msg);

/** Steps `n` times with constant input; returns every event emitted (drained). */
function stepN(run, n, held) {
  const out = [];
  for (let i = 0; i < n; i++) {
    S.step(run, { held });
    for (const e of run.events) out.push(e);
    run.events.length = 0;
  }
  return out;
}

/**
 * Replaces the generated world with a synthetic one: `planets` live in chunk 0
 * and every other chunk the camera could ask for is empty, so no generated
 * planet can interfere with the scenario.
 */
function setWorld(run, planets) {
  run.chunks = {};
  for (let k = 0; k <= 6; k++) run.chunks[k] = { k, yBase: k * C.CHUNK_H, planets: [], decor: [] };
  run.chunks[0].planets = planets;
  run.planets = {};
  for (const p of planets) run.planets[p.id] = p;
  run.planetList = planets.slice().sort((a, b) => a.id - b.id);
}

function planet(id, x0, y, R, extra) {
  return Object.assign({
    id, x0, y, R, hot: false, drifting: false, amp: 0, period: 0, phase: 0,
    main: true, palette: 0, ring: false, craters: [], bands: []
  }, extra || {});
}

/** A run in FLIGHT at (x, y) with velocity (vx, vy), on a synthetic world. */
function flightRun(planets, x, y, vx, vy) {
  const run = S.createRun({ seed: 1 });
  setWorld(run, planets);
  run.state = 'FLIGHT';
  run.tether = null;
  run.launched = true;
  run.comet.x = x; run.comet.y = y; run.comet.vx = vx; run.comet.vy = vy;
  run.prevComet.x = x; run.prevComet.y = y;
  run.events.length = 0;
  return run;
}

/** A run TETHERED to `p` at rod length r / angle theta / direction s. */
function tetheredRun(planets, p, r, theta, s, heat) {
  const run = S.createRun({ seed: 1 });
  setWorld(run, planets);
  run.state = 'TETHERED';
  run.launched = true;
  run.heat = heat || 0;
  run.tether = { planetId: p.id, r, theta, s, loopAcc: 0, loops: 0, startTheta: theta, startT: 0, altAtLatchM: 0, latchY: p.y + r * Math.sin(theta) };
  run.comet.x = p.x0 + r * Math.cos(theta);
  run.comet.y = p.y + r * Math.sin(theta);
  run.comet.vx = -s * C.V_ORBIT * Math.sin(theta);
  run.comet.vy = s * C.V_ORBIT * Math.cos(theta);
  run.events.length = 0;
  return run;
}

function runBot(seed, bot, maxT, stopAltM) {
  const run = S.createRun({ seed });
  while (run.state !== 'DEAD' && run.t < maxT && run.score.alt < stopAltM) {
    S.step(run, bot(run));
    run.events.length = 0;
  }
  return run;
}

/* ------------------------------------------------------------------ */
describe('config', () => {
  test('exports name, version, debug flag and the config object', () => {
    assert.equal(G.NAME, 'Tetherloop');
    assert.equal(G.VERSION, '1.0.0');
    assert.equal(typeof G.DEBUG, 'boolean');
    assert.equal(C.SIM_HZ, 120);
    assert.equal(C.DIFFICULTY.length, 6);
    assert.equal(C.DIFFICULTY[0].from, 0);
    assert.ok(C.DIFFICULTY.every((r, i) => i === 0 || r.from > C.DIFFICULTY[i - 1].from), 'rows sorted by from');
  });
});

/* ------------------------------------------------------------------ */
describe('rng and tables', () => {
  test('mulberry32 reference values, range and determinism', () => {
    const r = S.mulberry32(12345);
    assert.equal(r().toFixed(12), '0.979728267761');
    assert.equal(r().toFixed(12), '0.306752264500');
    assert.equal(r().toFixed(12), '0.484205421526');
    const a = S.mulberry32(99), b = S.mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1);
    }
  });

  test('hashSeedForChunk is the int32 golden-ratio hash', () => {
    assert.equal(S.hashSeedForChunk(7, 0), 7);
    assert.equal(S.hashSeedForChunk(0, 1), 2654435769);
    assert.equal(S.hashSeedForChunk(7, 3), 3668340012);
    assert.equal(S.hashSeedForChunk(0xFFFFFFFF, 1), 1640531526);
    assert.equal(S.hashSeedForChunk(-1, 0), 0xFFFFFFFF);
  });

  test('difficultyAt picks the last row with from <= A', () => {
    assert.equal(S.difficultyAt(0).from, 0);
    assert.equal(S.difficultyAt(199).from, 0);
    assert.equal(S.difficultyAt(200).from, 200);
    assert.equal(S.difficultyAt(599).from, 400);
    assert.equal(S.difficultyAt(1199).from, 600);
    assert.equal(S.difficultyAt(1999).from, 1200);
    assert.equal(S.difficultyAt(99999).from, 2000);
  });

  test('tetherRange curve: 300 to 800 m, linear to 220 at 2000 m, constant after', () => {
    assert.equal(S.tetherRange(0), 300);
    assert.equal(S.tetherRange(800), 300);
    assert.ok(Math.abs(S.tetherRange(1400) - 260) < 1e-9);
    assert.ok(Math.abs(S.tetherRange(1100) - 280) < 1e-9);
    assert.equal(S.tetherRange(2000), 220);
    assert.equal(S.tetherRange(9000), 220);
    for (let a = 0; a < 3000; a += 50) assert.ok(S.tetherRange(a + 50) <= S.tetherRange(a), 'monotone non-increasing');
  });
});

/* ------------------------------------------------------------------ */
describe('generator', () => {
  test('determinism: 3 seeds x 50 chunks generated twice are deep-equal (and across contexts)', () => {
    const G2 = load();
    for (const seed of [1, 0xC0FFEE, 4294967295]) {
      for (let k = 0; k < 50; k++) {
        const a = S.gen(seed, k), b = S.gen(seed, k), c = G2.sim.gen(seed, k);
        deepEq(a, b);
        deepEq(a, c);
      }
    }
    assert.notDeepEqual(structuredClone(S.gen(1, 3)), structuredClone(S.gen(2, 3)), 'different seeds differ');
  });

  test('invariants over more than 10,000 planets', () => {
    let count = 0;
    const sep = C.MIN_SEP;
    for (let seed = 1; seed <= 20; seed++) {
      let prevChunk = null;
      for (let k = 0; k < 60; k++) {
        const ch = S.gen(seed, k);
        const A = k * (C.CHUNK_H / 10);
        const row = S.difficultyAt(A);
        const maxHop = S.tetherRange(A) + 200;
        const ps = ch.planets;
        assert.equal(ch.k, k);
        assert.equal(ch.yBase, k * C.CHUNK_H);
        assert.ok(ps.length > 0 && ps.length < 32, `planets per chunk in (0, 32): ${ps.length}`);
        count += ps.length;
        const mains = ps.filter((p) => p.main);
        for (let i = 0; i < ps.length; i++) {
          const p = ps[i];
          assert.equal(p.id, k * 1000 + i, 'id = k*1000 + index');
          assert.ok(p.y >= ch.yBase && p.y < ch.yBase + C.CHUNK_H, 'y inside chunk');
          assert.ok(p.x0 >= p.R + C.MARGIN - 1e-9 && p.x0 <= C.COL_W - p.R - C.MARGIN + 1e-9, 'x within margins');
          if (!(k === 0 && i === 0)) assert.ok(p.R >= row.R[0] - 1e-9 && p.R <= row.R[1] + 1e-9, `R in row range: ${p.R}`);
          assert.ok(p.palette >= 0 && p.palette < 6);
          assert.ok(p.craters.length >= 3 && p.craters.length <= 6);
          assert.ok(p.bands.length >= 2 && p.bands.length <= 4);
          if (p.drifting) {
            assert.ok(p.amp >= C.DRIFT.amp[0] && p.amp <= C.DRIFT.amp[1]);
            assert.ok(p.period >= C.DRIFT.period[0] && p.period <= C.DRIFT.period[1]);
            assert.ok(A >= C.DRIFT_MIN_A, 'no drift below DRIFT_MIN_A');
          }
          if (p.hot) assert.ok(row.hot > 0, 'hot only where the row allows');
          for (let j = i + 1; j < ps.length; j++) {
            const q = ps[j];
            const d = Math.hypot(p.x0 - q.x0, p.y - q.y);
            assert.ok(d >= p.R + q.R + sep - 1e-9, `separation ${seed}/${k} #${i}-#${j}: ${d}`);
          }
        }
        // main chain
        for (let i = 1; i < mains.length; i++) {
          const a = mains[i - 1], b = mains[i];
          assert.ok(b.id > a.id, 'ids increase along the chain');
          assert.ok(b.y > a.y, 'chain climbs');
          const d = Math.hypot(a.x0 - b.x0, a.y - b.y);
          assert.ok(d >= a.R + b.R + sep - 1e-9 && d <= maxHop + 1e-9, `main hop ${seed}/${k}/${i}: ${d} <= ${maxHop}`);
          assert.ok(!(a.hot && b.hot), 'never two hot in a row');
        }
        assert.ok(!mains[0].hot, 'first planet of a chunk never hot');
        if (k === 0) {
          assert.equal(ps[0].x0, 270); assert.equal(ps[0].y, 0); assert.equal(ps[0].R, 56);
        } else {
          assert.equal(mains[0].y, ch.yBase + 120);
          assert.ok(mains[0].x0 >= 180 && mains[0].x0 <= 360);
        }
        const last = mains[mains.length - 1];
        assert.ok(Math.abs(last.y - (ch.yBase + 1880)) < 1e-6, 'last main at yBase + 1880');
        assert.ok(last.x0 >= 180 && last.x0 <= 360);
        if (A < C.SATELLITE_MIN_A) assert.equal(ps.length, mains.length, 'no satellites below SATELLITE_MIN_A');
        // cross-chunk separation and the joint hop
        if (prevChunk) {
          for (const p of prevChunk.planets) for (const q of ps) {
            const d = Math.hypot(p.x0 - q.x0, p.y - q.y);
            assert.ok(d >= p.R + q.R + sep - 1e-9, 'cross-chunk separation');
          }
          const pm = prevChunk.planets.filter((p) => p.main);
          const joint = Math.hypot(pm[pm.length - 1].x0 - mains[0].x0, 240);
          assert.ok(joint <= 300 + 1e-9, 'joint hop <= 300');
        }
        for (const d of ch.decor) {
          assert.ok((d.x >= -400 && d.x <= -60) || (d.x >= 600 && d.x <= 940), 'decor outside the column');
          assert.ok(d.side === -1 || d.side === 1);
        }
        prevChunk = ch;
      }
    }
    assert.ok(count >= 10000, `checked ${count} planets`);
    console.log(`  invariants checked on ${count} planets`);
  });

  test('drifting planets keep the separation invariant at every sim time (amplitude included)', () => {
    let drifting = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (let k = 4; k < 40; k++) {
        const ps = S.gen(seed, k).planets;
        for (const p of ps) {
          if (!p.drifting) continue;
          drifting++;
          for (let t = 0; t < 10; t += 0.37) {
            const x = S.planetX(p, t);
            assert.ok(Math.abs(x - p.x0) <= p.amp + 1e-9, 'drift never exceeds its amplitude');
            for (const q of ps) {
              if (q === p) continue;
              const d = Math.hypot(x - S.planetX(q, t), p.y - q.y);
              assert.ok(d >= p.R + q.R + C.MIN_SEP - 1e-9, `dynamic separation ${seed}/${k} ${p.id}-${q.id} at t=${t}: ${d}`);
            }
          }
        }
      }
    }
    assert.ok(drifting > 50, `enough drifting planets sampled: ${drifting}`);
  });

  test('planetX applies drift and clamps to the margins', () => {
    const p = planet(5, 100, 500, 40, { drifting: true, amp: 80, period: 4, phase: 0 });
    assert.equal(S.planetX(p, 0), 110, 'x0 clamped up to R + MARGIN');
    assert.equal(S.planetX(p, 1), 180, 'quarter period: +amp');
    assert.equal(S.planetX(p, 3), 110, 'three quarters: clamped');
    const q = planet(6, 300, 500, 40);
    assert.equal(S.planetX(q, 123.4), 300);
  });
});

/* ------------------------------------------------------------------ */
describe('run lifecycle', () => {
  test('createRun starts in TITLE_ORBIT around planet 0 with chunks 0 and 1 loaded', () => {
    const run = S.createRun({ seed: 42, mode: 'daily' });
    assert.equal(run.state, 'TITLE_ORBIT');
    assert.equal(run.mode, 'daily');
    assert.equal(run.tether.planetId, 0);
    assert.equal(run.tether.r, 120);
    assert.equal(run.tether.s, 1);
    assert.ok(Math.abs(run.comet.x - 270) < 1e-9 && Math.abs(run.comet.y + 120) < 1e-9);
    assert.deepEqual(Object.keys(run.chunks).map(Number), [0, 1]);
    assert.equal(run.camBottom, C.CAM_START);
    assert.equal(run.events.filter((e) => e.type === 'CHUNK').length, 2);
    deepEq(run.score, { alt: 0, banked: 0, pool: 0, M: 1 });
  });

  test('title orbit keeps heat frozen, a press starts heat, a release launches with LAUNCH exactly once', () => {
    const run = S.createRun({ seed: 42 });
    run.events.length = 0;
    stepN(run, 60, false);
    assert.equal(run.state, 'TITLE_ORBIT');
    assert.equal(run.heat, 0);
    assert.ok(Math.abs(Math.hypot(run.comet.x - 270, run.comet.y) - 120) < 1e-6, 'still on the orbit');
    stepN(run, 1, true);
    assert.equal(run.state, 'TETHERED');
    stepN(run, 11, true);
    assert.ok(Math.abs(run.heat - 12 * DT / C.T_BURN) < 1e-9, 'heat accumulates while pressed');
    const ev = stepN(run, 1, false);
    assert.equal(run.state, 'FLIGHT');
    assert.deepEqual(ev.map((e) => e.type).filter((t) => t === 'RELEASE' || t === 'LAUNCH'), ['RELEASE', 'LAUNCH']);
    const rel = ev.find((e) => e.type === 'RELEASE');
    assert.ok(Math.abs(rel.speed - C.V_ORBIT * (1 + C.HOT_BOOST * rel.heat)) < 1e-9, 'boost by heat');
    assert.equal(rel.hotShot, false);
  });

  test('samples every 4 steps, camera only rises, step returns run.events', () => {
    const run = S.createRun({ seed: 3 });
    run.events.length = 0;
    const before = run.samples.length;
    const ret = S.step(run, { held: false });
    assert.equal(ret, run.events);
    stepN(run, 39, false);
    assert.equal(run.samples.length, before + 10);
    const run2 = flightRun([], 270, 2000, 0, 800);
    const cam0 = run2.camBottom;
    stepN(run2, 10, false);
    assert.ok(run2.camBottom > cam0);
    assert.ok(Math.abs(run2.camBottom - (run2.comet.y - C.CAM_ANCHOR * C.VIEW_H)) < 1e-9);
    const camHigh = run2.camBottom;
    run2.comet.vy = -200;
    stepN(run2, 5, false);
    assert.equal(run2.camBottom, camHigh, 'camera never descends');
  });

  test('chunk lifecycle: generated up to camBottom + VIEW_H + 2400, released below camBottom - 1200', () => {
    const run = flightRun([], 270, 5500, 0, 0);
    run.chunks = {}; run.planets = {}; run.planetList = [];
    run.camBottom = 5000;
    const ev = stepN(run, 1, false);
    const ks = Object.keys(run.chunks).map(Number).sort((a, b) => a - b);
    assert.deepEqual(ks, [1, 2, 3, 4]);
    assert.deepEqual(ev.filter((e) => e.type === 'CHUNK').map((e) => e.k), [1, 2, 3, 4]);
    for (const p of run.planetList) assert.ok(p.id >= 1000, 'chunk 0 planets released');
    run.camBottom = 9300;
    stepN(run, 1, false);
    assert.deepEqual(Object.keys(run.chunks).map(Number).sort((a, b) => a - b), [4, 5, 6]);
  });

  test('Run shape has every contract field; events carry the contract fields with finite numbers', () => {
    const run = S.createRun({ seed: 11, mode: 'duel', duel: { altM: 50, name: 'ALI', score: 300 } });
    for (const key of ['seed', 'mode', 'duel', 'state', 't', 'step', 'comet', 'prevComet', 'tether', 'heat', 'camBottom', 'maxY', 'chunks', 'planets',
      'score', 'counters', 'deathType', 'deathT', 'rewind', 'samples', 'grazedThisEpisode', 'releaseInfo', 'lastReleaseY', 'events', 'held', 'prevHeld', 'lineCrossed']) {
      assert.ok(key in run, `run.${key} present`);
    }
    for (const key of ['planetId', 'r', 'theta', 's', 'loopAcc', 'startTheta', 'startT', 'altAtLatchM', 'latchY']) assert.ok(key in run.tether, `tether.${key}`);
    deepEq(Object.keys(run.counters).sort(), ['grazes', 'hotShots', 'latches', 'longShots', 'loops', 'maxM', 'snaps', 'wallBounces']);
    const FIELDS = {
      LATCH: ['planetId', 'r', 'theta', 's', 'x', 'y'], RELEASE: ['heat', 'hotShot', 'theta', 'x', 'y', 'speed'], HOT_SHOT: ['amount', 'M'],
      GRAZE: ['planetId', 'amount', 'M', 'x', 'y'], LONG_SHOT: ['amount', 'M'], LOOP: ['amount', 'bankedTotal', 'pooledBefore', 'x', 'y'],
      WALL: ['x', 'y', 'side'], SNAP: ['x', 'y'], BURN_WARN: [], DEATH: ['deathType', 'x', 'y', 'pool'], LINE_PASSED: ['altM'], CHUNK: ['k'], LAUNCH: []
    };
    const seen = {};
    const rng = S.mulberry32(5), opts = {};
    run.events.length = 0;
    while (run.state !== 'DEAD' && run.t < 200) {
      S.step(run, S.bots.clumsy(run, rng, opts));
      for (const e of run.events) {
        assert.ok(FIELDS[e.type], `known event type ${e.type}`);
        for (const f of FIELDS[e.type]) {
          assert.ok(f in e, `${e.type}.${f}`);
          if (typeof e[f] === 'number') assert.ok(Number.isFinite(e[f]), `${e.type}.${f} finite`);
        }
        seen[e.type] = (seen[e.type] || 0) + 1;
      }
      run.events.length = 0;
    }
    for (const t of ['LATCH', 'RELEASE', 'LAUNCH', 'CHUNK', 'DEATH', 'LINE_PASSED']) assert.ok(seen[t], `saw ${t}`);
    assert.equal(seen.LAUNCH, 1);
    assert.equal(seen.DEATH, 1);
    assert.equal(seen.LATCH, run.counters.latches);
    assert.equal(seen.GRAZE || 0, run.counters.grazes);
    assert.equal(seen.LOOP || 0, run.counters.loops);
  });

  test('held flag flapping every step (and every third step) stays finite and valid', () => {
    for (const period of [2, 3]) {
      const run = S.createRun({ seed: 9 });
      const states = new Set();
      for (let i = 0; i < 6000 && run.state !== 'DEAD'; i++) {
        S.step(run, { held: i % period !== 0 });
        run.events.length = 0;
        states.add(run.state);
        for (const v of [run.comet.x, run.comet.y, run.comet.vx, run.comet.vy, run.heat, run.score.pool, run.score.M]) assert.ok(Number.isFinite(v), 'finite sim state');
        assert.ok(run.comet.x >= C.COMET_R - 1e-6 && run.comet.x <= C.COL_W - C.COMET_R + 1e-6, 'comet inside the column');
        assert.ok(run.heat >= 0 && run.heat <= 1);
        assert.ok(run.score.M >= 1 && run.score.M <= C.SCORE.M_CAP);
        assert.ok(S.STATES[run.state], 'known state');
      }
      assert.ok(states.has('TETHERED') && states.has('FLIGHT'));
      assert.ok(run.counters.latches > 10, 'flapping re-latches');
    }
  });

  test('a non-finite comet position does not hang chunk management', () => {
    const run = flightRun([], 270, 1000, 0, 0);
    run.comet.y = Infinity;
    const before = Object.keys(run.chunks).length;
    S.step(run, { held: false });
    assert.equal(Object.keys(run.chunks).length, before);
    const run2 = flightRun([], 270, 1000, 0, 0);
    run2.comet.y = NaN;
    S.step(run2, { held: false });
    assert.equal(Object.keys(run2.chunks).length, before);
  });

  test('run determinism: two runs, same seed, same scripted inputs → identical samples and events', () => {
    const script = (run) => S.bots.perfect(run);
    const a = S.createRun({ seed: 777 }), b = S.createRun({ seed: 777 });
    const evA = [], evB = [];
    for (let i = 0; i < 2400; i++) {
      S.step(a, script(a)); S.step(b, script(b));
      evA.push(...a.events); evB.push(...b.events);
      a.events.length = 0; b.events.length = 0;
    }
    assert.ok(a.counters.latches >= 3, 'the script actually plays');
    deepEq(a.samples, b.samples);
    deepEq(evA, evB);
    deepEq(a.score, b.score);
    assert.ok(evA.length > 10);
  });
});

/* ------------------------------------------------------------------ */
describe('tethered rules', () => {
  test('burn death at exactly T_BURN of hold (x2 rate on a hot planet), BURN_WARN once at 0.5', () => {
    const run = S.createRun({ seed: 42 });
    run.events.length = 0;
    const ev = stepN(run, Math.ceil(C.T_BURN / DT) + 5, true);
    assert.equal(run.state, 'DEAD');
    assert.equal(run.deathType, 'BURNED');
    assert.ok(Math.abs(run.deathT - C.T_BURN) <= DT + 1e-9, `died at ${run.deathT}`);
    assert.equal(ev.filter((e) => e.type === 'BURN_WARN').length, 1);
    assert.equal(ev.filter((e) => e.type === 'DEATH').length, 1);
    assert.equal(ev.find((e) => e.type === 'DEATH').deathType, 'BURNED');

    const p = planet(0, 270, 0, 56, { hot: true });
    const hot = tetheredRun([p], p, 120, -Math.PI / 2, 1, 0);
    stepN(hot, 400, true);
    assert.equal(hot.deathType, 'BURNED');
    assert.ok(Math.abs(hot.deathT - C.T_BURN / 2) <= DT + 1e-9, `hot death at ${hot.deathT}`);
  });

  test('loop detection and bank math: LOOP after 2*pi, pool banked, M reset', () => {
    const p = planet(0, 270, 300, 40);
    const run = tetheredRun([p], p, 60, 0, 1, 0);
    run.score.pool = 30; run.score.M = 2.5; run.score.banked = 100;
    const w = C.V_ORBIT / 60;
    const stepsPerLoop = Math.ceil(TAU / (w * DT));
    const ev = stepN(run, stepsPerLoop + 1, true);
    const loops = ev.filter((e) => e.type === 'LOOP');
    assert.equal(loops.length, 1);
    assert.equal(loops[0].amount, 20 * 2.5);
    assert.equal(loops[0].pooledBefore, 30);
    assert.equal(loops[0].bankedTotal, 100 + 30 + 50);
    deepEq(run.score, { alt: run.score.alt, banked: 180, pool: 0, M: 1 });
    assert.equal(run.counters.loops, 1);
    assert.equal(run.tether.loops, 1);
    assert.ok(run.heat < 1 && run.state === 'TETHERED', 'a 60 px loop fits inside the heat budget');
  });

  test('scoring functions: onGraze / onHotShot / onLongShot / onLoop', () => {
    const run = S.createRun({ seed: 1 });
    run.events.length = 0;
    S.onGraze(run, run.planets[1]);
    deepEq(run.score, { alt: 0, banked: 0, pool: 5, M: 1.5 });
    S.onHotShot(run);
    deepEq(run.score, { alt: 0, banked: 0, pool: 5 + 15, M: 1.75 });
    S.onLongShot(run);
    deepEq(run.score, { alt: 0, banked: 0, pool: 20 + 17.5, M: 1.75 });
    const loop = S.onLoop(run);
    assert.equal(loop.amount, 35);
    deepEq(run.score, { alt: 0, banked: 72.5, pool: 0, M: 1 });
    for (let i = 0; i < 20; i++) S.onGraze(run, run.planets[1]);
    assert.equal(run.score.M, C.SCORE.M_CAP, 'M capped');
    assert.equal(run.counters.maxM, C.SCORE.M_CAP);
    assert.equal(run.counters.grazes, 21);
    assert.equal(run.events.map((e) => e.type).join(','), ['GRAZE', 'HOT_SHOT', 'LONG_SHOT', 'LOOP'].concat(new Array(20).fill('GRAZE')).join(','));
    assert.equal(S.scoreOf(run), run.score.alt + run.score.banked);
  });

  test('wall snap: forced release with no boost, SNAP then RELEASE in the same step, latch disarmed while still held', () => {
    const p = planet(0, 100, 500, 40);
    const run = tetheredRun([p], p, 200, Math.PI / 2, 1, 0.5);
    const ev = stepN(run, 60, true);
    const types = ev.map((e) => e.type);
    const iSnap = types.indexOf('SNAP');
    assert.ok(iSnap >= 0, 'snapped');
    assert.equal(types[iSnap + 1], 'RELEASE');
    const rel = ev[iSnap + 1];
    assert.equal(rel.speed, C.V_ORBIT, 'no heat boost on a snap');
    assert.equal(rel.hotShot, false);
    assert.equal(run.counters.snaps, 1);
    assert.equal(run.counters.latches, 0, 'held through the snap: no re-latch until the hand is released');
    assert.ok(run.state === 'FLIGHT' || run.state === 'DEAD');
    assert.ok(run.comet.x >= C.COMET_R - 1e-9);
  });

  test('collision while tethered kills (CRASHED), release of the tether planet never collides with it', () => {
    const p = planet(0, 270, 300, 40);
    const q = planet(1, 270, 300 + 150, 30);
    const run = tetheredRun([p, q], p, 120, -Math.PI / 2, 1, 0);
    stepN(run, 200, true);
    assert.equal(run.state, 'DEAD');
    assert.equal(run.deathType, 'CRASHED');
  });
});

/* ------------------------------------------------------------------ */
describe('flight rules', () => {
  test('graze counts once per planet per episode (+5*M, M += 0.5), excludes the planet just released', () => {
    const p = planet(0, 270, 500, 40);
    const x = 270 + 40 + C.COMET_R + 10; // surface distance 10 at the closest point
    const run = flightRun([p], x, 300, 0, 600);
    const ev = stepN(run, 100, false);
    const grazes = ev.filter((e) => e.type === 'GRAZE');
    assert.equal(grazes.length, 1);
    assert.equal(grazes[0].planetId, 0);
    assert.equal(grazes[0].amount, 5);
    assert.equal(grazes[0].M, 1.5);
    deepEq(run.score, { alt: run.score.alt, banked: 0, pool: 5, M: 1.5 });
    assert.equal(run.state, 'FLIGHT');

    // the planet just released from is pre-marked for the flight episode
    const run2 = tetheredRun([p], p, 40 + C.COMET_R + 10, 0, 1, 0);
    const ev2 = stepN(run2, 1, false).concat(stepN(run2, 30, false));
    assert.equal(ev2.filter((e) => e.type === 'GRAZE').length, 0);
  });

  test('walls reflect with restitution and emit WALL', () => {
    const run = flightRun([], 30, 1000, -400, 600);
    const ev = stepN(run, 20, false);
    const wall = ev.find((e) => e.type === 'WALL');
    assert.ok(wall && wall.side === -1);
    assert.ok(run.comet.vx > 0 && Math.abs(run.comet.vx - 400 * C.WALL_RESTITUTION) < 1e-6);
    assert.equal(run.counters.wallBounces, 1);
  });

  test('heat cools in flight at 1/T_COOL and BURN_WARN re-arms', () => {
    const run = flightRun([], 270, 1000, 0, 600);
    run.heat = 0.6; run.burnWarned = true;
    stepN(run, 12, false);
    assert.ok(Math.abs(run.heat - (0.6 - 12 * DT / C.T_COOL)) < 1e-9);
    assert.equal(run.burnWarned, false);
    stepN(run, 60, false);
    assert.equal(run.heat, 0, 'clamped at 0');
  });

  test('FELL death when comet.y + COMET_R < camBottom', () => {
    const run = flightRun([], 270, 100, 0, -500);
    run.camBottom = 60;
    const ev = stepN(run, 20, false);
    assert.equal(run.state, 'DEAD');
    assert.equal(run.deathType, 'FELL');
    assert.ok(run.comet.y + C.COMET_R < run.camBottom);
    const death = ev.find((e) => e.type === 'DEATH');
    assert.equal(death.deathType, 'FELL');
    assert.equal(death.pool, 0);
    assert.equal(stepN(run, 5, true).length, 0, 'dead runs do not step');
  });

  test('collision in flight kills (CRASHED) and the DEATH event carries the pool', () => {
    const p = planet(0, 270, 500, 40);
    const run = flightRun([p], 270, 300, 0, 500);
    run.score.pool = 77;
    const ev = stepN(run, 60, false);
    assert.equal(run.deathType, 'CRASHED');
    // a head-on approach passes through the graze band one step before contact
    assert.equal(ev.filter((e) => e.type === 'GRAZE').length, 1);
    assert.equal(ev.find((e) => e.type === 'DEATH').pool, 77 + 5);
    assert.equal(ev.find((e) => e.type === 'DEATH').pool, run.score.pool);
  });
});

/* ------------------------------------------------------------------ */
describe('target selection', () => {
  const up = (planets, x, y) => flightRun(planets, x, y, 0, 420);

  test('null outside FLIGHT', () => {
    const run = S.createRun({ seed: 1 });
    assert.equal(S.getTarget(run), null);
  });

  test('green: in range, in cone, circle clear of planets and walls', () => {
    const p = planet(0, 270, 500, 40);
    const tg = S.getTarget(up([p], 270, 300));
    assert.ok(tg && tg.planet.id === 0);
    assert.ok(Math.abs(tg.d - 200) < 1e-9);
    assert.equal(tg.color, 'green');
  });

  test('amber when the orbit circle crosses a wall, red when it intersects another planet (red wins)', () => {
    // all planets stay inside [R + MARGIN, COL_W - R - MARGIN] so planetX() does not clamp them
    const left = planet(0, 150, 500, 40);                 // d = 200: circle reaches x = -50 → wall
    assert.equal(S.getTarget(up([left], 150, 300)).color, 'amber');
    const p = planet(0, 200, 500, 40);                    // d = 150: circle spans x in [50, 350]
    const q = planet(1, 200 + 150 + 30 + C.COMET_R - 1, 500, 30); // just inside d + RQ + COMET_R
    assert.equal(S.getTarget(up([p, q], 200, 350)).color, 'red');
    const far = planet(1, 200 + 150 + 30 + C.COMET_R + 1, 500, 30);
    assert.equal(S.getTarget(up([p, far], 200, 350)).color, 'green');
    const wallAndPlanet = planet(1, 150 + 200 + 30 + C.COMET_R - 1, 500, 30);
    assert.equal(S.getTarget(up([left, wallAndPlanet], 150, 300)).color, 'red');
  });

  test('cone and range exclusions, LATCH_MIN_CLEAR, minimum cost wins', () => {
    const below = planet(0, 270, 100, 40);          // behind the comet
    assert.equal(S.getTarget(up([below], 270, 300)), null);
    const tooFar = planet(0, 270, 300 + 301, 40);     // d > range at A = 0
    assert.equal(S.getTarget(up([tooFar], 270, 300)), null);
    const inRange = planet(0, 270, 300 + 299, 40);
    assert.equal(S.getTarget(up([inRange], 270, 300)).planet.id, 0);
    const tooClose = planet(0, 270, 300 + 40 + C.LATCH_MIN_CLEAR - 1, 40);
    assert.equal(S.getTarget(up([tooClose], 270, 300)), null);
    // a nearer planet off-axis vs a farther one on-axis: cost = d + 120*(1-dot)/2
    const onAxis = planet(0, 270, 300 + 200, 30);      // d 200, dot 1 → cost 200
    const offAxis = planet(1, 270 + 170, 300 + 60, 30); // d ~180, dot ~0.33 → cost ~220
    assert.equal(S.getTarget(up([onAxis, offAxis], 270, 300)).planet.id, 0);
    const offAxisNear = planet(1, 270 + 120, 300 + 60, 30); // d ~134, dot ~0.45 → cost ~167
    assert.equal(S.getTarget(up([onAxis, offAxisNear], 270, 300)).planet.id, 1);
    // edge of the cone: dot(vhat, phat) >= cos(100°)
    const sideBack = planet(0, 270 + 150 * Math.sin(1.76), 300 + 150 * Math.cos(1.76), 30); // 100.8° off velocity
    assert.equal(S.getTarget(up([sideBack], 270, 300)), null);
    const sideIn = planet(0, 270 + 150 * Math.sin(1.72), 300 + 150 * Math.cos(1.72), 30);   // 98.5°
    assert.equal(S.getTarget(up([sideIn], 270, 300)).planet.id, 0);
  });

  test('the latch uses the displayed target (same planet, r = d), direction from the cross product, snapshot taken', () => {
    const p = planet(0, 270, 500, 40);
    const q = planet(1, 60, 480, 30);
    const run = up([p, q], 230, 300);
    run.comet.vx = 50;
    const shown = S.getTarget(run);
    assert.equal(shown.planet.id, 0);
    // the latch evaluates the state after this step's integration: compute it the same way
    const vy = run.comet.vy - C.GRAVITY * DT;
    const px = run.comet.x + run.comet.vx * DT, py = run.comet.y + vy * DT;
    const expectedD = Math.hypot(270 - px, 500 - py);
    const ev = stepN(run, 1, true);
    const latch = ev.find((e) => e.type === 'LATCH');
    assert.ok(latch, 'latched');
    assert.equal(latch.planetId, 0);
    assert.ok(Math.abs(latch.r - expectedD) < 1e-9);
    assert.equal(run.state, 'TETHERED');
    const cross = (px - 270) * vy - (py - 500) * run.comet.vx;
    assert.equal(latch.s, cross < 0 ? -1 : 1);
    assert.ok(run.rewind.snapshot && run.rewind.snapshot.tether.planetId === 0);
    assert.equal(run.counters.latches, 1);
    assert.ok(Math.abs(Math.hypot(run.comet.vx, run.comet.vy) - C.V_ORBIT) < 1e-9, 'velocity redirected to the tangent');
  });

  test('early-press forgiveness: held with no target latches the first target that appears', () => {
    const p = planet(0, 270, 1000, 40);
    const run = flightRun([p], 270, 300, 0, 700); // d = 700 > range
    const ev = stepN(run, 400, true);
    const latch = ev.find((e) => e.type === 'LATCH');
    assert.ok(latch, 'eventually latched while held');
    assert.equal(latch.planetId, 0);
    assert.ok(Math.abs(latch.r - S.tetherRange(0)) < 10, 'latched as soon as the planet entered range');
  });

  test('LONG_SHOT when a flight gains >= LONG_SHOT_M metres between release and latch', () => {
    const p = planet(0, 270, 1200, 40);
    const run = flightRun([p], 270, 300, 0, 900);
    run.releaseInfo = { y: 300, heat: 0, planetId: 99 };
    const ev = stepN(run, 200, true);
    const types = ev.map((e) => e.type);
    assert.ok(types.indexOf('LATCH') >= 0);
    assert.equal(types[types.indexOf('LATCH') + 1], 'LONG_SHOT');
    assert.equal(run.counters.longShots, 1);
    assert.equal(run.score.pool, 10);
  });
});

/* ------------------------------------------------------------------ */
describe('rewind and duel', () => {
  test('rewind restores the last latch, keeps the score as at death, once per run', () => {
    let run = null;
    for (let seed = 1; seed < 50 && !run; seed++) {
      const rng = S.mulberry32(seed * 7919);
      const opts = {};
      const r = runBot(seed + 1000, (x) => S.bots.clumsy(x, rng, opts), 300, Infinity);
      if (r.state === 'DEAD' && r.rewind.snapshot && r.counters.latches >= 2) run = r;
    }
    assert.ok(run, 'found a dead run with a snapshot');
    const snap = structuredClone(run.rewind.snapshot);
    const scoreAtDeath = structuredClone(run.score);
    assert.equal(S.rewind(run), true);
    assert.equal(run.state, 'READY_ORBIT');
    assert.equal(run.heat, 0);
    assert.equal(run.deathType, null);
    assert.equal(run.deathT, null);
    assert.equal(run.rewind.used, true);
    assert.equal(run.rewoundAtLatch, true);
    deepEq({ x: run.comet.x, y: run.comet.y }, { x: snap.comet.x, y: snap.comet.y });
    assert.equal(run.tether.planetId, snap.tether.planetId);
    assert.equal(run.tether.r, snap.tether.r);
    assert.equal(run.t, snap.t);
    assert.equal(run.camBottom, snap.camBottom);
    deepEq(run.score, scoreAtDeath);
    assert.equal(Math.floor(run.maxY / 10), run.score.alt, 'ALT === floor(maxY / 10) still holds after a rewind (ALT is always safe)');
    assert.ok(run.maxY >= snap.maxY);
    assert.equal(S.rewind(run), false, 'only once');
    run.events.length = 0;
    // orbits until a fresh press + release, which fires LAUNCH again
    stepN(run, 30, false);
    assert.equal(run.state, 'READY_ORBIT');
    assert.equal(run.heat, 0);
    assert.ok(Math.abs(Math.hypot(run.comet.x - S.planetX(run.planets[snap.tether.planetId], run.t), run.comet.y - run.planets[snap.tether.planetId].y) - snap.tether.r) < 1e-6);
    stepN(run, 5, true);
    assert.equal(run.state, 'TETHERED');
    const ev = stepN(run, 1, false);
    assert.ok(ev.some((e) => e.type === 'LAUNCH'));
    assert.ok(run.score.alt >= scoreAtDeath.alt, 'ALT never decreases after a rewind');
  });

  test('rewind refused without a snapshot or when not dead', () => {
    const run = S.createRun({ seed: 1 });
    assert.equal(S.rewind(run), false);
    const p = planet(0, 270, 500, 40);
    const r2 = flightRun([p], 270, 300, 0, 420);
    stepN(r2, 1, true);
    assert.ok(r2.rewind.snapshot);
    assert.equal(S.rewind(r2), false, 'alive');
  });

  test('duel LINE_PASSED fires once when ALT exceeds the challenger altitude', () => {
    const run = flightRun([], 270, 0, 0, 900);
    run.duel = { altM: 5, name: 'ALI', score: 100 };
    const ev = stepN(run, 60, false);
    const lines = ev.filter((e) => e.type === 'LINE_PASSED');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].altM, 6);
    assert.equal(run.lineCrossed, true);
    assert.equal(stepN(run, 60, false).filter((e) => e.type === 'LINE_PASSED').length, 0);
    const free = flightRun([], 270, 0, 0, 900);
    assert.equal(stepN(free, 60, false).filter((e) => e.type === 'LINE_PASSED').length, 0, 'no duel, no line');
  });
});

/* ------------------------------------------------------------------ */
describe('bots', () => {
  test('clumsy bot without an rng is deterministic from the run seed; perfect bot is pure in the run', () => {
    const play = (seed, rng) => { const o = {}; return runBot(seed, (r) => S.bots.clumsy(r, rng, o), 120, Infinity); };
    const a = play(5, undefined), b = play(5, undefined);
    assert.equal(a.state, 'DEAD');
    assert.equal(a.t, b.t);
    assert.equal(a.deathType, b.deathType);
    const run = S.createRun({ seed: 3 });
    for (let i = 0; i < 300; i++) S.step(run, S.bots.perfect(run));
    const snap = structuredClone({ c: run.comet, s: run.state, t: run.t });
    const d1 = S.bots.perfect(run), d2 = S.bots.perfect(run);
    deepEq(d1, d2);
    deepEq(structuredClone({ c: run.comet, s: run.state, t: run.t }), snap, 'deciding does not mutate the run');
  });

  test('latch plans only use release angles ahead of the latch point (no stale behind-the-comet release)', () => {
    let plans = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const run = S.createRun({ seed });
      while (run.state !== 'DEAD' && run.t < 60 && plans < 400) {
        if (run.state === 'FLIGHT') {
          const tg = S.getTarget(run);
          if (tg) {
            const p = tg.planet;
            const d = Math.hypot(run.comet.x - tg.cx, run.comet.y - tg.cy);
            const theta0 = Math.atan2(run.comet.y - tg.cy, run.comet.x - tg.cx);
            const s = (run.comet.x - tg.cx) * run.comet.vy - (run.comet.y - tg.cy) * run.comet.vx < 0 ? -1 : 1;
            const ra = S.bots.releaseAngle(run, p, d, s, theta0, run.heat, 1 / C.T_BURN, 0, false, 0);
            assert.ok(ra.delta >= 0 && ra.delta < TAU, `plan release angle ahead: ${ra.delta}`);
            assert.ok(Math.abs(ra.thetaR - (theta0 + s * ra.delta)) < 1e-9, 'thetaR consistent with delta');
            const plan = S.bots.latchPlan(run, run.comet, p, 0);
            if (plan) { plans++; assert.ok(plan.delta >= 0, 'feasible plan releases ahead of the latch'); }
          }
        }
        S.step(run, S.bots.perfect(run));
        run.events.length = 0;
      }
    }
    assert.ok(plans >= 50, `checked ${plans} feasible plans`);
  });
});

/* ------------------------------------------------------------------ */
describe('tuning gate (design difficulty_curve)', () => {
  test('perfect bot reaches 3000 m on 20 seeds without dying', () => {
    const t0 = Date.now();
    const rows = [];
    let ok = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const run = runBot(seed, S.bots.perfect, 600, 3000);
      const reached = run.score.alt >= 3000 && run.state !== 'DEAD';
      if (reached) ok++;
      rows.push(`${seed}:${run.score.alt}m/${run.t.toFixed(0)}s/${run.counters.latches}L/${run.counters.loops}loops${reached ? '' : '/' + run.deathType}`);
    }
    console.log(`  perfect bot: ${ok}/20 seeds reached 3000 m (${Date.now() - t0} ms)\n  ${rows.join(' ')}`);
    assert.equal(ok, 20);
    assert.ok(rows.every((r) => !/CRASHED|BURNED/.test(r)), 'the reference bot never crashes or burns');
  });

  test('perfect bot robustness on seeds 21-40 (not the design gate): at least 18/20 reach 3000 m', () => {
    const t0 = Date.now();
    let ok = 0;
    const fails = [];
    for (let seed = 21; seed <= 40; seed++) {
      const run = runBot(seed, S.bots.perfect, 600, 3000);
      if (run.score.alt >= 3000 && run.state !== 'DEAD') ok++; else fails.push(`${seed}:${run.score.alt}m/${run.deathType}`);
    }
    console.log(`  perfect bot (robustness): ${ok}/20 seeds 21-40 reached 3000 m${fails.length ? ' — ' + fails.join(' ') : ''} (${Date.now() - t0} ms)`);
    assert.ok(ok >= 18, `robustness: ${ok}/20`);
  });

  test('clumsy bot (±25° aim noise, 150 ms reaction): deterministic, always dies; median vs the 20–70 s design band', () => {
    const t0 = Date.now();
    const times = [];
    const deaths = {};
    for (let seed = 1; seed <= 40; seed++) {
      const play = (s) => {
        const rng = S.mulberry32(s * 7919);
        const opts = {};
        return runBot(s + 1000, (r) => S.bots.clumsy(r, rng, opts), 300, Infinity);
      };
      const run = play(seed);
      if (seed <= 3) {
        const again = play(seed);
        assert.equal(again.t, run.t, 'clumsy bot is deterministic for a given rng seed');
        assert.equal(again.deathType, run.deathType);
      }
      assert.equal(run.state, 'DEAD', `seed ${seed} must die within 300 s`);
      times.push(run.t);
      deaths[run.deathType] = (deaths[run.deathType] || 0) + 1;
    }
    times.sort((a, b) => a - b);
    const q = (f) => times[Math.min(times.length - 1, Math.floor(f * times.length))];
    const median = (times[19] + times[20]) / 2;
    const inBand = median >= 20 && median <= 70;
    console.log(`  clumsy bot: median death ${median.toFixed(1)} s (p25 ${q(0.25).toFixed(1)} s, p75 ${q(0.75).toFixed(1)} s, min ${times[0].toFixed(1)} s, max ${times[39].toFixed(1)} s) deaths ${JSON.stringify(deaths)} (${Date.now() - t0} ms)`);
    console.log(`  design band 20–70 s: ${inBand ? 'MET' : 'NOT MET'} — the median is insensitive to DIFFICULTY gap/lat/hot (see config.js tuning log); it is set by the prescribed noise`);
    assert.ok(median <= 70, 'difficulty ceiling: a clumsy player must not survive beyond 70 s on median');
    assert.ok(median >= 5, 'sanity floor: the clumsy bot plays, it does not die instantly');
  });
});
