/**
 * G.sim — the PURE, deterministic simulation of Tetherloop.
 *
 * Responsibilities
 *   - Seeded world generator: gen(seed, k) builds chunk k (2000 px tall) from a
 *     mulberry32 stream seeded with hashSeedForChunk(seed, k). The main chain is
 *     laid out hop by hop under feasibility bounds so that EVERY chunk satisfies
 *     the invariants without rejection sampling: any two planets have centre
 *     distance >= R1 + R2 + MIN_SEP, consecutive main planets have distance in
 *     [R1 + R2 + MIN_SEP, tetherRange(A) + 200], the first main planet of chunk
 *     k > 0 sits at y = yBase + 120 and the last at y = yBase + 1880 (both with
 *     x in [180, 360]) so the cross-chunk hop is always 240 px tall and at most
 *     180 px wide. Chunk 0 starts with planet 0 at (270, 0), R = 56.
 *   - Fixed-step run simulation: step(run, {held}) advances exactly 1 / SIM_HZ s
 *     through TITLE_ORBIT / READY_ORBIT → TETHERED → FLIGHT → DEAD, emitting plain
 *     event objects into run.events (the caller drains the array after each step).
 *   - Target selection getTarget(run) is the single function used both by the
 *     renderer (reticle colour) and by the latch itself: what you see is what you
 *     get. Early-press forgiveness: holding with no target latches the first
 *     valid target that appears while still held.
 *   - Scoring (pool / banked / chain multiplier), rewind snapshots, duel line,
 *     path samples and two reference bots used by the tuning gate in
 *     tests/sim.test.mjs.
 *
 * Purity contract: no DOM, no Date, no Math.random, no performance.now and no
 * G.storage / G.sdk / G.audio. The only global read is G.CONFIG (mutable in place
 * by the debug panel, so values are read when used, never cached at load time).
 * Math.sin / cos / atan2 are allowed: identical levels across devices are
 * required, bit-identical replays are not (the duel ghost is keyframe based).
 *
 * Coordinates: world x in [0, COL_W] (the column), world y UP in px (10 px = 1 m).
 *
 * Public API (JSDoc on each member below):
 *   G.sim.mulberry32(seed) → rng()            G.sim.hashSeedForChunk(seed, k)
 *   G.sim.difficultyAt(A_m)                  G.sim.tetherRange(A_m)
 *   G.sim.gen(seed, k) → chunk               G.sim.planetX(planet, t)
 *   G.sim.createRun({seed, mode, duel})      G.sim.step(run, {held}) → run.events
 *   G.sim.getTarget(run)                     G.sim.rewind(run) → bool
 *   G.sim.scoreOf(run)                       G.sim.deathType / G.sim.STATES
 *   G.sim.onGraze / onHotShot / onLongShot / onLoop (run, …) → event
 *   G.sim.bots.perfect(run) / clumsy(run, rng, opts) / decide(run, aimNoiseRad)
 */
(function () {
  'use strict';

  var G = window.G = window.G || {};
  if (typeof G.DEBUG !== 'boolean') {
    G.DEBUG = /[?&]debug=1/.test((window.location && window.location.search) || '');
  }
  G.log = G.log || function () {
    if (G.DEBUG) console.log.apply(console, arguments);
  };

  var TAU = Math.PI * 2;

  /** Run states. */
  var STATES = {
    TITLE_ORBIT: 'TITLE_ORBIT',
    READY_ORBIT: 'READY_ORBIT',
    TETHERED: 'TETHERED',
    FLIGHT: 'FLIGHT',
    DEAD: 'DEAD'
  };

  /** Death type constants. */
  var DEATH = { FELL: 'FELL', BURNED: 'BURNED', CRASHED: 'CRASHED' };

  /** Interval (in steps) between path samples kept for the share card. */
  var SAMPLE_EVERY = 4;
  /** Chunks are generated up to camBottom + VIEW_H + this (px). */
  var GEN_AHEAD = 2400;
  /** Chunks entirely below camBottom - this (px) are released. */
  var RELEASE_BELOW = 1200;
  /** Lateral slack added to tetherRange for the maximum main-chain hop (px). */
  var HOP_SLACK = 200;
  /** Main planets of chunk k > 0 start this far above the chunk base (px). */
  var FIRST_Y = 120;
  /** The last main planet of every chunk sits this far below the chunk top (px). */
  var LAST_Y_FROM_TOP = 120;
  /** x range of the first and last main planet of a chunk. */
  var JOINT_X = [180, 360];
  /** Radius of the start planet. */
  var START_R = 56;
  /** Title/ready orbit radius around the start planet. */
  var TITLE_R = 120;

  function cfg() { return G.CONFIG; }

  /* ------------------------------------------------------------------ */
  /* Random numbers                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * mulberry32 PRNG.
   * @param {number} seed any integer (coerced to uint32)
   * @returns {function(): number} returns floats in [0, 1)
   */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Per-chunk seed: (seed ^ (k * 0x9E3779B9)) >>> 0 with int32 multiply.
   * @param {number} seed run seed (uint32)
   * @param {number} k chunk index
   * @returns {number} uint32
   */
  function hashSeedForChunk(seed, k) {
    return ((seed >>> 0) ^ Math.imul(k | 0, 0x9E3779B9)) >>> 0;
  }

  /* ------------------------------------------------------------------ */
  /* Difficulty                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Difficulty row for an altitude: the last row whose `from` is <= A.
   * @param {number} A altitude in metres (chunk base)
   * @returns {{from:number,R:number[],gap:number[],lat:number,hot:number,drift:number}}
   */
  function difficultyAt(A) {
    var rows = cfg().DIFFICULTY;
    var row = rows[0];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].from <= A) row = rows[i];
    }
    return row;
  }

  /**
   * Tether range in px: `base` up to startDropM, linear to `end` at endM, constant after.
   * @param {number} A altitude in metres
   * @returns {number} px
   */
  function tetherRange(A) {
    var T = cfg().TETHER_RANGE;
    if (A <= T.startDropM) return T.base;
    if (A >= T.endM) return T.end;
    return T.base + (T.end - T.base) * (A - T.startDropM) / (T.endM - T.startDropM);
  }

  /** Altitude (m) at the base of the chunk containing world y. */
  function chunkAltitudeAt(y) {
    var h = cfg().CHUNK_H;
    return Math.max(0, Math.floor(y / h)) * (h / 10);
  }

  /* ------------------------------------------------------------------ */
  /* World generation                                                       */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function hypot(x, y) { return Math.sqrt(x * x + y * y); }
  function posMod(v, m) { v = v % m; return v < 0 ? v + m : v; }

  /**
   * x position of a planet at sim time t (drift applied, clamped to the margins).
   * @param {Object} p planet
   * @param {number} t sim seconds since run start
   * @returns {number}
   */
  function planetX(p, t) {
    var x = p.x0;
    if (p.drifting) x += p.amp * Math.sin(TAU * t / p.period + p.phase);
    var C = cfg();
    return clamp(x, p.R + C.MARGIN, C.COL_W - p.R - C.MARGIN);
  }

  function makePlanet(x0, y, R, main) {
    return {
      id: 0, x0: x0, y: y, R: R, hot: false, drifting: false, amp: 0, period: 0, phase: 0,
      main: main, palette: 0, ring: false, craters: [], bands: []
    };
  }

  /**
   * True when a body of radius R at (x, y) with drift amplitude `amp` keeps the
   * separation invariant against every planet in `list` (their own drift included).
   */
  function clearanceOk(list, x, y, R, amp, skip) {
    var sep = cfg().MIN_SEP;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === skip) continue;
      var need = R + q.R + sep + amp + (q.drifting ? q.amp : 0);
      if (hypot(q.x0 - x, q.y - y) < need) return false;
    }
    return true;
  }

  /** Draws the deterministic visual descriptors of a planet from the rng. */
  function decoratePlanet(p, rng) {
    p.palette = Math.floor(rng() * 6);
    p.ring = p.R >= 44 && rng() < 0.25;
    var nC = 3 + Math.floor(rng() * 4);
    for (var i = 0; i < nC; i++) {
      var ang = rng() * TAU;
      var dist = rng() * 0.7 * p.R;
      var rx = (0.08 + rng() * 0.14) * p.R;
      p.craters.push({
        dx: Math.cos(ang) * dist,
        dy: Math.sin(ang) * dist,
        rx: rx,
        ry: rx * (0.6 + rng() * 0.4),
        rot: rng() * Math.PI
      });
    }
    var nB = 2 + Math.floor(rng() * 3);
    for (var j = 0; j < nB; j++) {
      p.bands.push({
        yOff: (rng() * 1.6 - 0.8) * p.R,
        h: (0.08 + rng() * 0.17) * p.R,
        alpha: 0.08 + rng() * 0.12
      });
    }
  }

  /** Draws hot / drifting flags for a planet (drift needs clearance in `list`). */
  function flagPlanet(p, rng, row, A, list, allowHot, allowDrift) {
    var C = cfg();
    var hotRoll = rng();
    p.hot = allowHot && hotRoll < row.hot;
    var driftRoll = rng();
    var amp = C.DRIFT.amp[0] + rng() * (C.DRIFT.amp[1] - C.DRIFT.amp[0]);
    var period = C.DRIFT.period[0] + rng() * (C.DRIFT.period[1] - C.DRIFT.period[0]);
    var phase = rng() * TAU;
    if (allowDrift && A >= C.DRIFT_MIN_A && driftRoll < row.drift && clearanceOk(list, p.x0, p.y, p.R, amp, p)) {
      p.drifting = true;
      p.amp = amp;
      p.period = period;
      p.phase = phase;
    }
  }

  /**
   * Generates chunk k of the world for `seed`. Pure and deterministic.
   * @param {number} seed run seed (uint32)
   * @param {number} k chunk index (>= 0); chunk k covers y in [k*CHUNK_H, (k+1)*CHUNK_H)
   * @returns {{k:number, yBase:number, planets:Object[], decor:Object[]}}
   */
  function gen(seed, k) {
    var C = cfg();
    var rng = mulberry32(hashSeedForChunk(seed, k));
    var H = C.CHUNK_H;
    var yBase = k * H;
    var A = k * (H / 10);
    var row = difficultyAt(A);
    var range = tetherRange(A);
    var sep = C.MIN_SEP;
    var margin = C.MARGIN;
    var Rmin = row.R[0], Rmax = row.R[1];
    var gapMin = row.gap[0], gapMax = row.gap[1];
    var maxHop = range + HOP_SLACK;
    var mains = [];

    // --- main chain: first planet -------------------------------------------------
    var first;
    if (k === 0) {
      first = makePlanet(C.COL_W / 2, 0, START_R, true);
    } else {
      first = makePlanet(JOINT_X[0] + rng() * (JOINT_X[1] - JOINT_X[0]), yBase + FIRST_Y, Rmin + rng() * (Rmax - Rmin), true);
    }
    mains.push(first);

    // --- main chain: hop count under feasibility bounds ---------------------------
    var yEnd = yBase + H - LAST_Y_FROM_TOP;
    var L = yEnd - first.y;
    var lastMinWorst = Math.max(gapMin, Rmax + Rmin + sep);
    var nLo = Math.ceil(L / gapMax);
    var nHi = Math.floor((L - lastMinWorst) / gapMin) + 1;
    if (nHi < nLo) nLo = nHi = Math.max(1, Math.round(L / ((gapMin + gapMax) / 2)));
    var n = nLo + Math.floor(rng() * (nHi - nLo + 1));
    if (n > nHi) n = nHi;

    var prev = first;
    var y = first.y;
    var Lr = L;
    for (var i = 0; i < n; i++) {
      var m = n - i; // hops remaining including this one
      var Rtry = Rmin + rng() * (Rmax - Rmin);
      var gap, x, R, D;
      if (m === 1) {
        // Final hop: exact landing on yEnd, x in the joint range intersected with
        // the lateral reach of the previous planet so D <= maxHop. The previous hop
        // reserved at least Rprev + Rmin + sep of vertical room, so R >= Rmin here.
        gap = Lr;
        var reach = Math.sqrt(Math.max(0, maxHop * maxHop - gap * gap));
        var ja = Math.max(JOINT_X[0], prev.x0 - reach);
        var jb = Math.min(JOINT_X[1], prev.x0 + reach);
        var jr = rng();
        x = ja <= jb ? ja + jr * (jb - ja) : clamp(prev.x0, JOINT_X[0], JOINT_X[1]);
        D = hypot(gap, x - prev.x0);
        R = Math.min(Rtry, D - sep - prev.R);
      } else {
        var futureMin = (m === 2) ? Math.max(gapMin, Rtry + Rmin + sep) : (m - 2) * gapMin + lastMinWorst;
        var lo = Math.max(gapMin, Lr - (m - 1) * gapMax);
        var hi = Math.min(gapMax, Lr - futureMin);
        if (lo > hi) lo = hi = Lr / m;
        gap = lo + rng() * (hi - lo);
        var latEff = Math.min(row.lat, Math.sqrt(Math.max(0, maxHop * maxHop - gap * gap)));
        var dx = (rng() * 2 - 1) * latEff;
        x = clamp(prev.x0 + dx, Rtry + margin, C.COL_W - Rtry - margin);
        D = hypot(gap, x - prev.x0);
        R = Rtry;
        var maxR = D - sep - prev.R;
        if (R > maxR) {
          if (maxR >= Rmin) {
            R = maxR;
          } else {
            // Shrinking alone would go below Rmin: push x sideways until R = Rmin fits.
            var minD = prev.R + Rmin + sep;
            var need = Math.sqrt(Math.max(0, minD * minD - gap * gap));
            var xLo = Rmin + margin, xHi = C.COL_W - Rmin - margin;
            var xA = prev.x0 + (dx >= 0 ? need : -need);
            var xB = prev.x0 + (dx >= 0 ? -need : need);
            if (xA >= xLo && xA <= xHi) x = xA;
            else if (xB >= xLo && xB <= xHi) x = xB;
            else x = (prev.x0 - xLo > xHi - prev.x0) ? xLo : xHi;
            D = hypot(gap, x - prev.x0);
            R = Math.min(Rmin, D - sep - prev.R);
          }
        }
      }
      y += gap;
      Lr -= gap;
      var p = makePlanet(x, y, R, true);
      mains.push(p);
      prev = p;
    }

    // --- main chain flags (hot: never first, never two in a row; drift: joints excluded)
    for (var f = 0; f < mains.length; f++) {
      var isJoint = (f === 0 || f === mains.length - 1);
      var prevHot = f > 0 && mains[f - 1].hot;
      flagPlanet(mains[f], rng, row, A, mains, f > 0 && !prevHot, !isJoint);
    }

    var planets = mains.slice();

    // --- satellites: one side planet per eligible interior main row --------------
    if (A >= C.SATELLITE_MIN_A) {
      for (var s = 1; s < mains.length - 1; s++) {
        if (rng() >= C.SATELLITE_P) continue;
        var mp = mains[s];
        var Rs = Rmin + rng() * (Rmax - Rmin);
        var ys = mp.y + (rng() < 0.5 ? -C.SATELLITE_DY : C.SATELLITE_DY);
        var side = rng() < 0.5 ? -1 : 1;
        var minOff = mp.R + Rs + C.SATELLITE_MIN_OFF;
        var sxLo = Rs + margin, sxHi = C.COL_W - Rs - margin;
        var placed = null;
        for (var attempt = 0; attempt < 2 && !placed; attempt++) {
          var sd = attempt === 0 ? side : -side;
          var a = sd > 0 ? mp.x0 + minOff : sxLo;
          var b = sd > 0 ? sxHi : mp.x0 - minOff;
          if (a > b) continue;
          var sx = a + rng() * (b - a);
          if (clearanceOk(planets, sx, ys, Rs, 0, null)) placed = makePlanet(sx, ys, Rs, false);
        }
        if (!placed) continue;
        planets.push(placed);
        flagPlanet(placed, rng, row, A, planets, true, true);
      }
    }

    // --- ids and visuals (after all positions and flags) --------------------------
    for (var v = 0; v < planets.length; v++) {
      planets[v].id = k * 1000 + v;
      decoratePlanet(planets[v], rng);
    }

    // --- decorative far planets outside the column --------------------------------
    var decor = [];
    var nDecor = 3 + Math.floor(rng() * 4);
    for (var d = 0; d < nDecor; d++) {
      for (var tries = 0; tries < 5; tries++) {
        var dSide = rng() < 0.5 ? -1 : 1;
        var dx0 = dSide < 0 ? -400 + rng() * 340 : C.COL_W + 60 + rng() * 340;
        var dy0 = yBase + rng() * H;
        var dR = 20 + rng() * 40;
        var pal = Math.floor(rng() * 6);
        var free = true;
        for (var e = 0; e < decor.length; e++) {
          if (decor[e].side === dSide && hypot(decor[e].x - dx0, decor[e].y - dy0) < decor[e].R + dR + 20) { free = false; break; }
        }
        if (free) { decor.push({ x: dx0, y: dy0, R: dR, palette: pal, side: dSide }); break; }
      }
    }

    return { k: k, yBase: yBase, planets: planets, decor: decor };
  }

  /* ------------------------------------------------------------------ */
  /* Run lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  function emit(run, evt) { run.events.push(evt); return evt; }

  function addChunk(run, k) {
    var chunk = gen(run.seed, k);
    run.chunks[k] = chunk;
    for (var i = 0; i < chunk.planets.length; i++) run.planets[chunk.planets[i].id] = chunk.planets[i];
    emit(run, { type: 'CHUNK', k: k });
  }

  function removeChunk(run, k) {
    var chunk = run.chunks[k];
    for (var i = 0; i < chunk.planets.length; i++) delete run.planets[chunk.planets[i].id];
    delete run.chunks[k];
  }

  function rebuildPlanetList(run) {
    var list = [];
    var keys = Object.keys(run.planets);
    for (var i = 0; i < keys.length; i++) list.push(run.planets[keys[i]]);
    list.sort(function (a, b) { return a.id - b.id; });
    run.planetList = list;
  }

  /**
   * Generates chunks up to camBottom + VIEW_H + GEN_AHEAD and releases those
   * below camBottom - RELEASE_BELOW. A non-finite camera (only reachable through
   * corrupted debug-panel values) leaves the loaded set untouched instead of
   * looping forever.
   */
  function ensureChunks(run) {
    var C = cfg();
    var kMax = Math.floor((run.camBottom + C.VIEW_H + GEN_AHEAD) / C.CHUNK_H);
    var kMin = Math.max(0, Math.floor((run.camBottom - RELEASE_BELOW) / C.CHUNK_H));
    if (!isFinite(kMax) || !isFinite(kMin)) return;
    var changed = false;
    for (var k = kMin; k <= kMax; k++) {
      if (!run.chunks[k]) { addChunk(run, k); changed = true; }
    }
    var keys = Object.keys(run.chunks);
    for (var i = 0; i < keys.length; i++) {
      var kk = +keys[i];
      if (kk < kMin) { removeChunk(run, kk); changed = true; }
    }
    if (changed) rebuildPlanetList(run);
  }

  /** Planet by id, regenerating its chunk if it was released (rewind safety). */
  function getPlanet(run, id) {
    var p = run.planets[id];
    if (p) return p;
    addChunk(run, Math.floor(id / 1000));
    rebuildPlanetList(run);
    return run.planets[id];
  }

  /**
   * Creates a run in TITLE_ORBIT around planet 0 (the live title scene).
   * @param {{seed:number, mode?:('free'|'daily'|'duel'), duel?:(Object|null)}} opts
   * @returns {Object} run (see module header / contract for the shape)
   */
  function createRun(opts) {
    opts = opts || {};
    var C = cfg();
    var run = {
      seed: (opts.seed || 0) >>> 0,
      mode: opts.mode || 'free',
      duel: opts.duel || null,
      state: STATES.TITLE_ORBIT,
      t: 0,
      step: 0,
      comet: { x: 0, y: 0, vx: 0, vy: 0 },
      prevComet: { x: 0, y: 0 },
      tether: null,
      heat: 0,
      camBottom: C.CAM_START,
      maxY: 0,
      chunks: {},
      planets: {},
      planetList: [],
      score: { alt: 0, banked: 0, pool: 0, M: 1 },
      counters: { grazes: 0, loops: 0, hotShots: 0, longShots: 0, latches: 0, wallBounces: 0, snaps: 0, maxM: 1 },
      deathType: null,
      deathT: null,
      rewind: { used: false, snapshot: null },
      samples: [],
      grazedThisEpisode: {},
      releaseInfo: null,
      lastReleaseY: null,
      events: [],
      held: false,
      prevHeld: false,
      lineCrossed: false,
      launched: false,
      armed: true,
      burnWarned: false,
      rewoundAtLatch: false
    };
    ensureChunks(run);
    var theta = -Math.PI / 2;
    run.tether = {
      planetId: 0, r: TITLE_R, theta: theta, s: 1, loopAcc: 0, loops: 0,
      startTheta: theta, startT: 0, altAtLatchM: 0, latchY: 0
    };
    placeOnTether(run);
    run.tether.latchY = run.comet.y;
    run.prevComet.x = run.comet.x;
    run.prevComet.y = run.comet.y;
    run.samples.push([run.comet.x, run.comet.y]);
    return run;
  }

  /** Puts the comet on the rod at tether.theta and sets the tangential velocity. */
  function placeOnTether(run) {
    var T = run.tether;
    var p = getPlanet(run, T.planetId);
    var cx = planetX(p, run.t), cy = p.y;
    var V = cfg().V_ORBIT;
    run.comet.x = cx + T.r * Math.cos(T.theta);
    run.comet.y = cy + T.r * Math.sin(T.theta);
    run.comet.vx = -T.s * V * Math.sin(T.theta);
    run.comet.vy = T.s * V * Math.cos(T.theta);
  }

  /* ------------------------------------------------------------------ */
  /* Scoring                                                                */
  /* ------------------------------------------------------------------ */

  function bumpM(run, inc) {
    var S = cfg().SCORE;
    run.score.M = Math.min(S.M_CAP, run.score.M + inc);
    if (run.score.M > run.counters.maxM) run.counters.maxM = run.score.M;
  }

  /**
   * GRAZE: pool += GRAZE * M, then M += GRAZE_M (capped).
   * @param {Object} run
   * @param {Object} planet grazed planet
   * @returns {{type:string, planetId:number, amount:number, M:number, x:number, y:number}} event
   */
  function onGraze(run, planet) {
    var S = cfg().SCORE;
    var amount = S.GRAZE * run.score.M;
    run.score.pool += amount;
    bumpM(run, S.GRAZE_M);
    run.counters.grazes++;
    return emit(run, { type: 'GRAZE', planetId: planet.id, amount: amount, M: run.score.M, x: run.comet.x, y: run.comet.y });
  }

  /**
   * HOT SHOT: pool += HOT * M, then M += HOT_M (capped).
   * @returns {{type:string, amount:number, M:number}} event
   */
  function onHotShot(run) {
    var S = cfg().SCORE;
    var amount = S.HOT * run.score.M;
    run.score.pool += amount;
    bumpM(run, S.HOT_M);
    run.counters.hotShots++;
    return emit(run, { type: 'HOT_SHOT', amount: amount, M: run.score.M });
  }

  /**
   * LONG SHOT: pool += LONG * M (M unchanged).
   * @returns {{type:string, amount:number, M:number}} event
   */
  function onLongShot(run) {
    var S = cfg().SCORE;
    var amount = S.LONG * run.score.M;
    run.score.pool += amount;
    run.counters.longShots++;
    return emit(run, { type: 'LONG_SHOT', amount: amount, M: run.score.M });
  }

  /**
   * LOOP: pool += LOOP * M, then BANK (banked += pool, pool = 0, M = 1).
   * @returns {{type:string, amount:number, bankedTotal:number, pooledBefore:number, x:number, y:number}} event
   */
  function onLoop(run) {
    var S = cfg().SCORE;
    var amount = S.LOOP * run.score.M;
    var pooledBefore = run.score.pool;
    run.score.pool += amount;
    run.score.banked += run.score.pool;
    run.score.pool = 0;
    run.score.M = 1;
    run.counters.loops++;
    return emit(run, { type: 'LOOP', amount: amount, bankedTotal: run.score.banked, pooledBefore: pooledBefore, x: run.comet.x, y: run.comet.y });
  }

  /** SCORE = ALT + BANKED. */
  function scoreOf(run) { return run.score.alt + run.score.banked; }

  /* ------------------------------------------------------------------ */
  /* Targeting                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Target selection for an arbitrary comet state {x, y, vx, vy} (see getTarget).
   * Candidates: planets with R + LATCH_MIN_CLEAR <= d <= tetherRange(A) and
   * dot(vhat, phat) >= TARGET_CONE_COS; the minimum of d + W*(1-dot)/2 wins.
   * Colour: 'red' when the orbit circle of radius d intersects another planet,
   * else 'amber' when it crosses a wall, else 'green'.
   */
  function selectTarget(run, c) {
    var C = cfg();
    var speed = hypot(c.vx, c.vy);
    var vhx = 0, vhy = 1;
    if (speed > 1e-9) { vhx = c.vx / speed; vhy = c.vy / speed; }
    var range = tetherRange(chunkAltitudeAt(c.y));
    var list = run.planetList;
    var best = null, bestCost = 0, bestD = 0, bestCx = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var cx = planetX(p, run.t);
      var px = cx - c.x, py = p.y - c.y;
      var d = hypot(px, py);
      if (d < p.R + C.LATCH_MIN_CLEAR || d > range) continue;
      var dot = (px * vhx + py * vhy) / d;
      if (dot < C.TARGET_CONE_COS) continue;
      var cost = d + C.TARGET_DOT_WEIGHT * (1 - dot) / 2;
      if (best === null || cost < bestCost) { best = p; bestCost = cost; bestD = d; bestCx = cx; }
    }
    if (best === null) return null;
    var color = 'green';
    for (var j = 0; j < list.length; j++) {
      var q = list[j];
      if (q === best) continue;
      if (hypot(planetX(q, run.t) - bestCx, q.y - best.y) < bestD + q.R + C.COMET_R) { color = 'red'; break; }
    }
    if (color === 'green' && (bestCx - bestD < C.COMET_R || bestCx + bestD > C.COL_W - C.COMET_R)) color = 'amber';
    return { planet: best, d: bestD, color: color, cx: bestCx, cy: best.y };
  }

  /**
   * Target selection — the SAME function the latch uses (WYSIWYG reticle).
   * Null outside FLIGHT; otherwise selectTarget() for the current comet.
   * @param {Object} run
   * @returns {null|{planet:Object, d:number, color:('green'|'amber'|'red'), cx:number, cy:number}}
   */
  function getTarget(run) {
    if (run.state !== STATES.FLIGHT) return null;
    return selectTarget(run, run.comet);
  }

  /* ------------------------------------------------------------------ */
  /* Step                                                                   */
  /* ------------------------------------------------------------------ */

  function die(run, type) {
    run.state = STATES.DEAD;
    run.deathType = type;
    run.deathT = run.t;
    emit(run, { type: 'DEATH', deathType: type, x: run.comet.x, y: run.comet.y, pool: run.score.pool });
  }

  /** Graze detection for every planet except `excludeId`, once per planet per episode. */
  function checkGrazes(run, excludeId) {
    var C = cfg();
    var c = run.comet;
    var list = run.planetList;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q.id === excludeId || run.grazedThisEpisode[q.id]) continue;
      var sd = hypot(planetX(q, run.t) - c.x, q.y - c.y) - q.R - C.COMET_R;
      if (sd > 0 && sd <= C.GRAZE_BAND) {
        run.grazedThisEpisode[q.id] = true;
        onGraze(run, q);
      }
    }
  }

  /** True when the comet centre is within R + COMET_R of any planet other than `excludeId`. */
  function hitsPlanet(run, excludeId) {
    var C = cfg();
    var c = run.comet;
    var list = run.planetList;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q.id === excludeId) continue;
      if (hypot(planetX(q, run.t) - c.x, q.y - c.y) <= q.R + C.COMET_R) return true;
    }
    return false;
  }

  /** Latches the comet to `tg` (result of getTarget). */
  function latch(run, tg) {
    var C = cfg();
    var c = run.comet;
    var p = tg.planet;
    var relx = c.x - tg.cx, rely = c.y - tg.cy;
    var theta = Math.atan2(rely, relx);
    var cross = relx * c.vy - rely * c.vx;
    var s = cross < 0 ? -1 : 1;
    run.tether = {
      planetId: p.id, r: tg.d, theta: theta, s: s, loopAcc: 0, loops: 0,
      startTheta: theta, startT: run.t, altAtLatchM: Math.floor(c.y / 10), latchY: c.y
    };
    run.state = STATES.TETHERED;
    run.counters.latches++;
    c.vx = -s * C.V_ORBIT * Math.sin(theta);
    c.vy = s * C.V_ORBIT * Math.cos(theta);
    emit(run, { type: 'LATCH', planetId: p.id, r: tg.d, theta: theta, s: s, x: c.x, y: c.y });
    if (run.releaseInfo && (c.y - run.releaseInfo.y) / 10 >= C.LONG_SHOT_M) onLongShot(run);
    run.grazedThisEpisode = {};
    run.rewind.snapshot = {
      comet: { x: c.x, y: c.y, vx: c.vx, vy: c.vy },
      tether: copyTether(run.tether),
      t: run.t,
      camBottom: run.camBottom,
      maxY: run.maxY,
      step: run.step
    };
  }

  function copyTether(T) {
    return {
      planetId: T.planetId, r: T.r, theta: T.theta, s: T.s, loopAcc: T.loopAcc, loops: T.loops,
      startTheta: T.startTheta, startT: T.startT, altAtLatchM: T.altAtLatchM, latchY: T.latchY
    };
  }

  /**
   * Releases the tether. `forced` (wall snap) applies no heat boost and no HOT SHOT.
   * A SNAP is always followed by a RELEASE event so path recorders see every hop closed.
   */
  function release(run, forced) {
    var C = cfg();
    var T = run.tether;
    var c = run.comet;
    var speed = C.V_ORBIT * (forced ? 1 : 1 + C.HOT_BOOST * run.heat);
    c.vx = -T.s * speed * Math.sin(T.theta);
    c.vy = T.s * speed * Math.cos(T.theta);
    run.state = STATES.FLIGHT;
    run.releaseInfo = { y: c.y, heat: run.heat, planetId: T.planetId };
    run.lastReleaseY = c.y;
    var hotShot = !forced && run.heat >= C.HOT_SHOT_HEAT;
    emit(run, { type: 'RELEASE', heat: run.heat, hotShot: hotShot, theta: T.theta, x: c.x, y: c.y, speed: speed });
    if (hotShot) onHotShot(run);
    run.grazedThisEpisode = {};
    run.grazedThisEpisode[T.planetId] = true;
    if (!run.launched) {
      run.launched = true;
      emit(run, { type: 'LAUNCH' });
    }
    run.tether = null;
  }

  /** Advances the orbit (title / ready states): position only, heat frozen. */
  function orbitAdvance(run, dt) {
    var T = run.tether;
    var w = cfg().V_ORBIT / T.r;
    T.theta = wrapAngle(T.theta + T.s * w * dt);
    placeOnTether(run);
  }

  function wrapAngle(a) {
    a = posMod(a + Math.PI, TAU) - Math.PI;
    return a;
  }

  function stepTethered(run, held, dt) {
    var C = cfg();
    var T = run.tether;
    var p = getPlanet(run, T.planetId);
    if (!held) { release(run, false); return; }
    var w = C.V_ORBIT / T.r;
    T.theta = wrapAngle(T.theta + T.s * w * dt);
    T.loopAcc += w * dt;
    placeOnTether(run);
    var c = run.comet;

    var rate = (p.hot ? 2 : 1) / C.T_BURN;
    var before = run.heat;
    run.heat += dt * rate;
    if (before < 0.5 && run.heat >= 0.5 && !run.burnWarned) {
      run.burnWarned = true;
      emit(run, { type: 'BURN_WARN' });
    }
    if (run.heat >= 1) { run.heat = 1; die(run, DEATH.BURNED); return; }

    while (T.loopAcc >= TAU) {
      T.loopAcc -= TAU;
      T.loops++;
      onLoop(run);
    }

    if (c.x < C.COMET_R || c.x > C.COL_W - C.COMET_R) {
      c.x = clamp(c.x, C.COMET_R, C.COL_W - C.COMET_R);
      run.counters.snaps++;
      run.armed = false;
      emit(run, { type: 'SNAP', x: c.x, y: c.y });
      release(run, true);
      if ((c.x <= C.COMET_R && c.vx < 0) || (c.x >= C.COL_W - C.COMET_R && c.vx > 0)) c.vx = -c.vx * C.WALL_RESTITUTION;
      return;
    }

    if (hitsPlanet(run, p.id)) { die(run, DEATH.CRASHED); return; }
    checkGrazes(run, p.id);
  }

  function stepFlight(run, held, dt) {
    var C = cfg();
    var c = run.comet;
    c.vy -= C.GRAVITY * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;

    if (c.x < C.COMET_R) {
      c.x = 2 * C.COMET_R - c.x;
      if (c.vx < 0) c.vx = -c.vx * C.WALL_RESTITUTION;
      run.counters.wallBounces++;
      emit(run, { type: 'WALL', x: c.x, y: c.y, side: -1 });
    } else if (c.x > C.COL_W - C.COMET_R) {
      c.x = 2 * (C.COL_W - C.COMET_R) - c.x;
      if (c.vx > 0) c.vx = -c.vx * C.WALL_RESTITUTION;
      run.counters.wallBounces++;
      emit(run, { type: 'WALL', x: c.x, y: c.y, side: 1 });
    }

    run.heat = Math.max(0, run.heat - dt / C.T_COOL);
    if (run.heat < 0.5) run.burnWarned = false;

    if (hitsPlanet(run, -1)) { die(run, DEATH.CRASHED); return; }
    checkGrazes(run, -1);
    if (c.y + C.COMET_R < run.camBottom) { die(run, DEATH.FELL); return; }

    if (held && run.armed) {
      var tg = getTarget(run);
      if (tg) latch(run, tg);
    }
  }

  /** Post-motion bookkeeping: altitude, camera, chunks, samples, duel line. */
  function afterMove(run) {
    var C = cfg();
    var c = run.comet;
    if (c.y > run.maxY) run.maxY = c.y;
    var alt = Math.floor(run.maxY / 10);
    if (alt > run.score.alt) run.score.alt = alt;
    var camTarget = c.y - C.CAM_ANCHOR * C.VIEW_H;
    if (camTarget > run.camBottom) run.camBottom = camTarget;
    ensureChunks(run);
    if (run.step % SAMPLE_EVERY === 0) run.samples.push([c.x, c.y]);
    if (run.duel && !run.lineCrossed && run.score.alt > run.duel.altM) {
      run.lineCrossed = true;
      emit(run, { type: 'LINE_PASSED', altM: run.score.alt });
    }
  }

  /**
   * Advances the run by exactly one fixed step (dt = 1 / SIM_HZ).
   * @param {Object} run
   * @param {{held:boolean}} input input flags sampled at the start of the step
   * @returns {Object[]} run.events (the caller drains it)
   */
  function step(run, input) {
    var held = !!(input && input.held);
    run.prevHeld = run.held;
    run.held = held;
    if (run.state === STATES.DEAD) return run.events;
    var dt = 1 / cfg().SIM_HZ;
    run.prevComet.x = run.comet.x;
    run.prevComet.y = run.comet.y;
    run.t += dt;
    run.step += 1;
    if (!held) run.armed = true;

    if (run.state === STATES.TITLE_ORBIT || run.state === STATES.READY_ORBIT) {
      if (held && !run.prevHeld) {
        var T = run.tether;
        run.state = STATES.TETHERED;
        run.heat = 0;
        T.startT = run.t;
        T.startTheta = T.theta;
        T.loopAcc = 0;
        T.loops = 0;
        run.grazedThisEpisode = {};
      } else {
        orbitAdvance(run, dt);
      }
    }
    if (run.state === STATES.TETHERED) stepTethered(run, held, dt);
    if (run.state === STATES.FLIGHT) stepFlight(run, held, dt);
    afterMove(run);
    return run.events;
  }

  /**
   * Rewind (rewarded): restores the snapshot taken at the last latch, keeps the
   * score (alt / banked / pool / M) as at death, heat = 0, state READY_ORBIT.
   * ALT is "always safe", so maxY is never lowered: ALT === floor(maxY / 10)
   * stays true after a rewind (the snapshot's maxY is only used when it is
   * higher, which cannot happen in practice but keeps the field consistent).
   * Once per run and only from DEAD.
   * @param {Object} run
   * @returns {boolean} true when the rewind was applied
   */
  function rewind(run) {
    var snap = run.rewind.snapshot;
    if (!snap || run.rewind.used || run.state !== STATES.DEAD) return false;
    run.comet.x = snap.comet.x; run.comet.y = snap.comet.y;
    run.comet.vx = snap.comet.vx; run.comet.vy = snap.comet.vy;
    run.prevComet.x = snap.comet.x; run.prevComet.y = snap.comet.y;
    run.tether = copyTether(snap.tether);
    run.tether.loopAcc = 0;
    run.tether.loops = 0;
    run.t = snap.t;
    run.step = snap.step;
    run.camBottom = snap.camBottom;
    run.maxY = Math.max(run.maxY, snap.maxY);
    run.heat = 0;
    run.state = STATES.READY_ORBIT;
    run.deathType = null;
    run.deathT = null;
    run.rewind.used = true;
    run.rewoundAtLatch = true;
    run.launched = false;
    run.armed = false;
    run.burnWarned = false;
    run.grazedThisEpisode = {};
    run.releaseInfo = null;
    ensureChunks(run);
    getPlanet(run, run.tether.planetId);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Bots (used by the tuning gate; deterministic given their inputs)      */
  /* ------------------------------------------------------------------ */

  var LOOP_R = 140;                    // loop when the rod is this short or shorter
  var HEAT_SAFE = 0.75;                // planned heat at release must stay below this
  var HEAT_PANIC = 0.9;                // unconditional release
  var ARC_STEP = 0.05;                 // rad between collision samples along a planned arc
  var SCAN_STEP = 0.1;                 // rad between alignment samples when scanning a lap
  var ARC_PAD = 8;                     // px of extra clearance in arc / path checks
  var PLAN_PAD = 10;                   // extra px of path clearance demanded when planning (hysteresis)
  var LATE_RAD = 45 * Math.PI / 180;   // release window after a blocked ideal release
  var RELEASE_HORIZON = 0.45;          // s of ballistic lookahead for a release
  var CRASH_HORIZON = 0.3;             // s of ballistic lookahead for the emergency latch
  var BALLISTIC_SUB = 3;               // sim steps per ballistic sample
  var AIM_OFFSET = 60;                 // flyby clearance above the planet radius when aiming (px)
  var HORIZON_PAD = 40;                // px a release point must stay above camBottom
  var PARK_ARC = Math.PI / 2;          // rad of clear orbit a lenient 'park' latch requires
  var AIM_REFINE = 8;                  // ternary-search refinements of the release angle
  var ALIGN_RAD = 12 * Math.PI / 180;  // a local alignment within this is taken as the release point
  var AIM_MAX_MIS = 30 * Math.PI / 180; // a plan whose best alignment is worse than this is rejected

  /** Lowest main planet strictly above planet p (null when none is loaded). */
  function nextMain(run, p) {
    var list = run.planetList;
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q.main || q.y <= p.y + 1) continue;
      if (best === null || q.y < best.y) best = q;
    }
    return best;
  }

  /**
   * Aim direction (rad) from (x, y) at time t toward the flyby point of N: the
   * planet centre offset perpendicular to the line of sight by R + AIM_OFFSET on
   * the side of the column centre, so the approach is never head-on and the
   * resulting orbit is short enough to loop; raised by the gravity drop a shot
   * of `speed` suffers on the way there. Straight up when N is null.
   */
  function aimAngle(run, t, x, y, N, noise, speed) {
    if (!N) return Math.PI / 2 + noise;
    var C = cfg();
    var nx = planetX(N, t), ny = N.y;
    var dx = nx - x, dy = ny - y;
    var len = hypot(dx, dy) || 1;
    var side = nx <= C.COL_W / 2 ? 1 : -1;
    var off = (N.R + AIM_OFFSET) * side;
    var fx = nx + (dy / len) * off;
    var fy = ny - (dx / len) * off;
    var ay = fy;
    for (var it = 0; it < 2; it++) {
      var tf = hypot(fx - x, ay - y) / speed;
      ay = fy + 0.5 * C.GRAVITY * tf * tf;
    }
    return Math.atan2(ay - y, fx - x) + noise;
  }

  /**
   * Release angle for an orbit around p (radius d, direction s) at theta0 now
   * with heat `heat0` rising at `rate` per second: the first point, from
   * LATE_RAD behind the comet to a lap ahead, where the tangent's misalignment
   * with the aim at the next main planet (seen from that point, at the time the
   * comet gets there, drift and launch speed included) has a local minimum
   * within ALIGN_RAD; else the best alignment of the lap. Refined by ternary
   * search; robust where a fixed-point iteration would oscillate. `forceUp`
   * aims straight up instead of at the next main planet. `lateRad` is how far
   * behind the comet the scan starts: LATE_RAD on the rod (a release point just
   * passed is still usable), 0 when planning a latch (nothing behind the latch
   * point is reachable, so the plan is judged on the arc ahead only).
   * @returns {{thetaR:number, delta:number, mis:number}} delta = arc to travel (negative when just passed), mis = residual misalignment (rad)
   */
  function releaseAngle(run, p, d, s, theta0, heat0, rate, noise, forceUp, lateRad) {
    var C = cfg();
    var w = C.V_ORBIT / d;
    var N = forceUp ? null : nextMain(run, p);
    var late = lateRad === undefined ? LATE_RAD : lateRad;
    var cy = p.y;
    function misAt(phi) {
      var tAt = run.t + Math.max(0, phi) / w;
      var th = theta0 + s * phi;
      var rx = planetX(p, tAt) + d * Math.cos(th), ry = cy + d * Math.sin(th);
      var speed = C.V_ORBIT * (1 + C.HOT_BOOST * Math.min(1, heat0 + Math.max(0, phi) / w * rate));
      return Math.abs(angleDiff(aimAngle(run, tAt, rx, ry, N, noise, speed), th + s * Math.PI / 2));
    }
    var bestPhi = 0, bestMis = Infinity;
    var prev2 = Infinity, prev1 = misAt(-late - SCAN_STEP), found = NaN;
    for (var phi = -late; phi < TAU; phi += SCAN_STEP) {
      var m = misAt(phi);
      if (m < bestMis) { bestMis = m; bestPhi = phi; }
      if (prev1 <= ALIGN_RAD && prev1 < prev2 && prev1 <= m) { found = phi - SCAN_STEP; break; }
      prev2 = prev1;
      prev1 = m;
    }
    var centre = isNaN(found) ? bestPhi : found;
    var lo = centre - SCAN_STEP, hi = centre + SCAN_STEP;
    for (var it = 0; it < AIM_REFINE; it++) {
      var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (misAt(m1) < misAt(m2)) hi = m2; else lo = m1;
    }
    var delta = Math.max(-late, (lo + hi) / 2);
    return { thetaR: theta0 + s * delta, delta: delta, mis: misAt(delta) };
  }

  /** Signed difference a - b wrapped to [-pi, pi). */
  function angleDiff(a, b) {
    var diff = a - b;
    return diff - TAU * Math.floor((diff + Math.PI) / TAU);
  }

  /**
   * True when a ballistic path from (x, y) at time t0 with velocity (vx, vy)
   * dies within `horizon` seconds: hits a planet (with ARC_PAD + extraPad clearance) or
   * falls under the camera horizon. Sampled every BALLISTIC_SUB sim steps
   * (<= 16 px of travel per sample, well under any planet's padded radius).
   */
  function pathDeadly(run, t0, x, y, vx, vy, horizon, extraPad) {
    var C = cfg();
    var dt = BALLISTIC_SUB / C.SIM_HZ;
    var list = run.planetList;
    var steps = Math.ceil(horizon / dt);
    var reach = Math.max(Math.abs(vx), Math.abs(vy) + C.GRAVITY * horizon) * horizon + 100;
    var pad = C.COMET_R + ARC_PAD + (extraPad || 0);
    var near = [];
    for (var j = 0; j < list.length; j++) {
      var q = list[j];
      if (Math.abs(q.y - y) <= reach + q.R) near.push(q);
    }
    for (var i = 1; i <= steps; i++) {
      vy -= C.GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      if (y + C.COMET_R < run.camBottom) return true;
      var tAt = t0 + i * dt;
      for (var k = 0; k < near.length; k++) {
        var n = near[k];
        if (hypot(planetX(n, tAt) - x, n.y - y) <= n.R + pad) return true;
      }
    }
    return false;
  }

  /**
   * True when the arc of the orbit circle around p (radius d) from theta0 over
   * `arc` rad in direction s hits no wall or planet. Drifting planets (and the
   * orbit centre itself) are evaluated at the time the comet reaches each
   * sample: time advances by d / V_ORBIT per radian.
   */
  function arcClear(run, p, d, theta0, s, arc) {
    var C = cfg();
    var pad = C.COMET_R + ARC_PAD;
    var wallLo = pad, wallHi = C.COL_W - pad;
    var cy = p.y;
    var cx = planetX(p, run.t);
    var list = run.planetList;
    var slack = pad + (p.drifting ? p.amp : 0);
    var threats = [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === p) continue;
      var dc = hypot(q.x0 - p.x0, q.y - cy);
      var qs = slack + (q.drifting ? q.amp : 0);
      if (dc + q.R + qs >= d && dc - q.R - qs <= d) threats.push(q);
    }
    var needWall = (cx - d - slack < wallLo) || (cx + d + slack > wallHi);
    if (!needWall && threats.length === 0) return true;
    var secPerRad = d / C.V_ORBIT;
    for (var phi = 0; phi <= arc; phi += ARC_STEP) {
      var tAt = run.t + phi * secPerRad;
      var th = theta0 + s * phi;
      var x = planetX(p, tAt) + d * Math.cos(th), y = cy + d * Math.sin(th);
      if (x < wallLo || x > wallHi) return false;
      for (var j = 0; j < threats.length; j++) {
        var tq = threats[j];
        if (hypot(x - planetX(tq, tAt), y - tq.y) <= tq.R + pad) return false;
      }
    }
    return true;
  }

  /** Orbit direction the sim would pick for comet state c around a planet centred at (cx, cy). */
  function orbitDir(c, cx, cy) {
    var cross = (c.x - cx) * c.vy - (c.y - cy) * c.vx;
    return cross < 0 ? -1 : 1;
  }

  /**
   * Plans a latch on planet p from comet state c ({x, y, vx, vy}): the release
   * angle aimed at the next main planet, the heat budget, an optional loop, the
   * arc up to the release and the flight after it. Null when not feasible; the
   * optional `diag` object receives the name of the failing check in `reason`.
   * @returns {null|{s:number, delta:number, loop:boolean, thetaR:number}}
   */
  function latchPlan(run, c, p, noise, diag) {
    var C = cfg();
    var cx = planetX(p, run.t), cy = p.y;
    var d = hypot(c.x - cx, c.y - cy);
    var theta0 = Math.atan2(c.y - cy, c.x - cx);
    var s = orbitDir(c, cx, cy);
    var w = C.V_ORBIT / d;
    var rate = (p.hot ? 2 : 1) / C.T_BURN;
    var ra = releaseAngle(run, p, d, s, theta0, run.heat, rate, noise, false, 0);
    if (ra.mis > AIM_MAX_MIS) return fail(diag, 'aim');
    var heatAtRelease = run.heat + (ra.delta / w) * rate;
    if (heatAtRelease > HEAT_SAFE) return fail(diag, 'heat');
    var loop = !p.hot && d <= LOOP_R && heatAtRelease + (TAU / w) * rate <= HEAT_SAFE;
    var arc = loop ? ra.delta + TAU : ra.delta;
    if (loop) heatAtRelease += (TAU / w) * rate;
    var tRel = run.t + arc / w;
    var relX = planetX(p, tRel) + d * Math.cos(ra.thetaR), relY = cy + d * Math.sin(ra.thetaR);
    if (relY - C.COMET_R < run.camBottom + HORIZON_PAD) return fail(diag, 'horizon');
    if (!arcClear(run, p, d, theta0, s, arc)) return fail(diag, 'arc');
    var speed = C.V_ORBIT * (1 + C.HOT_BOOST * heatAtRelease);
    if (pathDeadly(run, tRel, relX, relY, -s * speed * Math.sin(ra.thetaR), s * speed * Math.cos(ra.thetaR), RELEASE_HORIZON, PLAN_PAD)) return fail(diag, 'path');
    return { s: s, delta: ra.delta, loop: loop, thetaR: ra.thetaR };
  }

  function fail(diag, reason) {
    if (diag) diag.reason = reason;
    return null;
  }

  /**
   * Lenient "park" plan used when the comet is about to pass its target or is
   * falling: `arc` rad of clear orbit, and a release (toward the next main
   * planet, or straight up when none is reachable) within the heat budget. The
   * flight after that release is not checked.
   */
  function parkPlan(run, c, p, arc) {
    var C = cfg();
    var cx = planetX(p, run.t), cy = p.y;
    var d = hypot(c.x - cx, c.y - cy);
    var theta0 = Math.atan2(c.y - cy, c.x - cx);
    var s = orbitDir(c, cx, cy);
    var w = C.V_ORBIT / d;
    var rate = (p.hot ? 2 : 1) / C.T_BURN;
    var ra = releaseAngle(run, p, d, s, theta0, run.heat, rate, 0, false, 0);
    if (ra.mis > AIM_MAX_MIS) ra = releaseAngle(run, p, d, s, theta0, run.heat, rate, 0, true, 0);
    var toRelease = Math.max(arc, ra.delta);
    if (run.heat + (toRelease / w) * rate > HEAT_SAFE) return false;
    return arcClear(run, p, d, theta0, s, arc);
  }

  /**
   * Comet state one integration step ahead (no walls), used so a latch planned on
   * this step is evaluated on the state the latch will actually see.
   */
  function predictComet(run) {
    var C = cfg();
    var dt = 1 / C.SIM_HZ;
    var c = run.comet;
    var vy = c.vy - C.GRAVITY * dt;
    return { x: c.x + c.vx * dt, y: c.y + vy * dt, vx: c.vx, vy: vy };
  }

  /**
   * Reference decision function: the design's scripted bot. Latches when a
   * planned orbit is safe, releases when the tangent reaches the aim at the next
   * main-chain planet (or the first safe moment within 45 degrees after it) with
   * heat < 0.9, loops when the rod is <= 140 px and the heat budget allows, and
   * never releases into a planet or under the horizon unless the orbit itself is
   * about to crash. Pure in (run, noise).
   * @param {Object} run
   * @param {number} noise aim noise in radians (0 for the perfect bot)
   * @returns {boolean} desired `held`
   */
  function decide(run, noise) {
    var C = cfg();
    if (run.state === STATES.DEAD) return false;
    if (run.state === STATES.TITLE_ORBIT || run.state === STATES.READY_ORBIT) return !run.held;
    var c = run.comet;
    if (run.state === STATES.TETHERED) {
      var T = run.tether;
      var p = getPlanet(run, T.planetId);
      var w = C.V_ORBIT / T.r;
      var rate = (p.hot ? 2 : 1) / C.T_BURN;
      var boost = 1 + C.HOT_BOOST * run.heat;
      var releaseDanger = pathDeadly(run, run.t, c.x, c.y, c.vx * boost, c.vy * boost, RELEASE_HORIZON);
      var orbitDanger = !arcClear(run, p, T.r, T.theta, T.s, w * CRASH_HORIZON);
      if (run.heat >= HEAT_PANIC) return false;
      if (orbitDanger && !releaseDanger) return false;
      var ra = releaseAngle(run, p, T.r, T.s, T.theta, run.heat, rate, noise);
      // No reachable aim on this orbit (e.g. a park): leave at the top instead.
      if (ra.mis > AIM_MAX_MIS) ra = releaseAngle(run, p, T.r, T.s, T.theta, run.heat, rate, noise, true);
      if (!p.hot && T.r <= LOOP_R && T.loops === 0) {
        var remaining = TAU - T.loopAcc;
        var afterLoop = posMod((ra.thetaR - T.theta - T.s * remaining) * T.s, TAU);
        if (run.heat + ((remaining + afterLoop) / w) * rate <= HEAT_SAFE) return true;
      }
      var ahead = ra.delta > Math.PI ? ra.delta - TAU : ra.delta;
      if (ahead <= 0.5 * w / C.SIM_HZ && ahead >= -LATE_RAD && !releaseDanger) return false;
      return true;
    }
    var pc = predictComet(run);
    var tg = selectTarget(run, pc);
    var imminent = pathDeadly(run, run.t, c.x, c.y, c.vx, c.vy, CRASH_HORIZON);
    if (!tg) return false;
    if (run.releaseInfo && tg.planet.id === run.releaseInfo.planetId && !imminent && c.vy > 0) return false;
    if (latchPlan(run, pc, tg.planet, noise)) return true;
    if (imminent) return true;
    var passing = (tg.cx - pc.x) * pc.vx + (tg.cy - pc.y) * pc.vy < 0 || pc.vy < 0;
    if (passing && parkPlan(run, pc, tg.planet, PARK_ARC)) return true;
    return c.vy < 0 && c.y - run.camBottom < 300 && parkPlan(run, pc, tg.planet, C.V_ORBIT / tg.d * CRASH_HORIZON);
  }

  /**
   * Perfect bot: the reference decision with no noise and no delay.
   * @param {Object} run
   * @returns {{held:boolean}}
   */
  function perfect(run) {
    return { held: decide(run, 0) };
  }

  /**
   * Clumsy bot: ±noiseDeg of aim noise (re-rolled for every press, i.e. every
   * tether episode) on every release, and a reaction delay (default 150 ms) on
   * presses: the press is decided on the state the player anticipates delayMs
   * ahead and lands delayMs later, so planned latches are roughly on time while
   * emergencies (imminent crashes, falling) are reacted to late. Release timing
   * is anticipated like a human tracking a periodic motion; its error is the aim
   * noise. Per-run state lives in opts.state (created on first call).
   * @param {Object} run
   * @param {function(): number} [rng] seeded source of noise (default: a stream derived from run.seed)
   * @param {{noiseDeg?:number, delayMs?:number, state?:Object}} [opts]
   * @returns {{held:boolean}}
   */
  function clumsy(run, rng, opts) {
    opts = opts || {};
    var noiseDeg = opts.noiseDeg === undefined ? 25 : opts.noiseDeg;
    var delayMs = opts.delayMs === undefined ? 150 : opts.delayMs;
    var delaySteps = Math.round(delayMs / 1000 * cfg().SIM_HZ);
    var st = opts.state;
    if (!st) {
      // No rng given: a stream derived from the run seed keeps the bot deterministic.
      if (typeof rng !== 'function') rng = mulberry32(hashSeedForChunk(run.seed, 0x51));
      st = opts.state = { rng: rng, hand: false, pendingAt: -1, noise: (rng() * 2 - 1) * noiseDeg * Math.PI / 180 };
    }
    rng = typeof rng === 'function' ? rng : st.rng;
    if (st.hand) {
      st.hand = decide(run, st.noise);
      st.pendingAt = -1;
      return { held: st.hand };
    }
    if (st.pendingAt < 0) {
      // A fresh aim error for the episode this press will start; the plan that
      // triggers the press is validated with the same error it will fly with.
      var noise = (rng() * 2 - 1) * noiseDeg * Math.PI / 180;
      if (decide(anticipate(run, delaySteps), noise)) { st.pendingAt = run.step + delaySteps; st.noise = noise; }
    }
    if (st.pendingAt >= 0 && run.step >= st.pendingAt) { st.hand = true; st.pendingAt = -1; }
    return { held: st.hand };
  }

  /**
   * Read-only view of the run as a player anticipates it `steps` later while
   * flying (ballistic comet, cooled heat, advanced time). Presses are decided on
   * this view and land `steps` later, so a planned latch is roughly on time while
   * anything unforeseen (walls, emergencies) is reacted to late.
   */
  function anticipate(run, steps) {
    if (run.state !== STATES.FLIGHT) return run;
    var C = cfg();
    var dt = 1 / C.SIM_HZ;
    var c = run.comet;
    var x = c.x, y = c.y, vx = c.vx, vy = c.vy;
    for (var i = 0; i < steps; i++) {
      vy -= C.GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
    }
    var view = Object.create(run);
    view.comet = { x: x, y: y, vx: vx, vy: vy };
    view.heat = Math.max(0, run.heat - steps * dt / C.T_COOL);
    view.t = run.t + steps * dt;
    return view;
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                                 */
  /* ------------------------------------------------------------------ */

  G.sim = {
    STATES: STATES,
    deathType: DEATH,
    mulberry32: mulberry32,
    hashSeedForChunk: hashSeedForChunk,
    difficultyAt: difficultyAt,
    tetherRange: tetherRange,
    gen: gen,
    planetX: planetX,
    createRun: createRun,
    step: step,
    getTarget: getTarget,
    rewind: rewind,
    scoreOf: scoreOf,
    onGraze: onGraze,
    onHotShot: onHotShot,
    onLongShot: onLongShot,
    onLoop: onLoop,
    bots: { perfect: perfect, clumsy: clumsy, decide: decide, latchPlan: latchPlan, releaseAngle: releaseAngle, nextMain: nextMain }
  };
})();
