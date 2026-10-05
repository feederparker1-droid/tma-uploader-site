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

  /** Generates chunks up to camBottom + VIEW_H + GEN_AHEAD and releases those below camBottom - RELEASE_BELOW. */
  function ensureChunks(run) {
    var C = cfg();
    var kMax = Math.floor((run.camBottom + C.VIEW_H + GEN_AHEAD) / C.CHUNK_H);
    var kMin = Math.max(0, Math.floor((run.camBottom - RELEASE_BELOW) / C.CHUNK_H));
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
   * Target selection — the SAME function the latch uses (WYSIWYG reticle).
   * Candidates: planets with R + LATCH_MIN_CLEAR <= d <= tetherRange(A) and
   * dot(vhat, phat) >= TARGET_CONE_COS; the minimum of d + W*(1-dot)/2 wins.
   * Colour: 'red' when the orbit circle of radius d intersects another planet,
   * else 'amber' when it crosses a wall, else 'green'. Null outside FLIGHT.
   * @param {Object} run
   * @returns {null|{planet:Object, d:number, color:('green'|'amber'|'red'), cx:number, cy:number}}
   */
  function getTarget(run) {
    if (run.state !== STATES.FLIGHT) return null;
    var C = cfg();
    var c = run.comet;
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
    run.releaseInfo = { y: c.y, heat: run.heat };
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
    run.maxY = snap.maxY;
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

  var ALIGN_RAD = 12 * Math.PI / 180; // release window around the aim direction
  var LOOP_R = 140;                    // loop when the rod is this short or shorter
  var HEAT_SAFE = 0.85;                // planned heat at release must stay below this
  var HEAT_PANIC = 0.9;                // unconditional release
  var ARC_STEP = 0.05;                 // rad between collision samples along a planned arc
  var ARC_PAD = 3;                     // px of extra clearance in arc checks
  var AIM_OFFSET = 60;                 // flyby clearance above the planet radius when aiming (px)
  var CRASH_HORIZON = 0.3;             // s of ballistic lookahead for the emergency latch

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

  /** Signed difference a - b wrapped to [-pi, pi). */
  function angleDiff(a, b) {
    var d = a - b;
    return d - TAU * Math.floor((d + Math.PI) / TAU);
  }

  /**
   * Aim direction (rad) from (x, y) toward the flyby point of N: the planet centre
   * offset perpendicular to the line of sight by R + AIM_OFFSET on the side of the
   * column centre, so the approach is never head-on and the resulting orbit radius
   * is short enough to loop. Straight up when N is null. `noise` is added.
   */
  function aimAngle(run, x, y, N, noise) {
    if (!N) return Math.PI / 2 + noise;
    var nx = planetX(N, run.t), ny = N.y;
    var dx = nx - x, dy = ny - y;
    var len = hypot(dx, dy) || 1;
    var side = nx <= cfg().COL_W / 2 ? 1 : -1;
    var off = (N.R + AIM_OFFSET) * side;
    var ax = nx + (dy / len) * off;
    var ay = ny - (dx / len) * off;
    return Math.atan2(ay - y, ax - x) + noise;
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

  /** True when the ballistic path hits a planet within `horizon` seconds. */
  function collisionImminent(run, horizon) {
    var C = cfg();
    var dt = 1 / C.SIM_HZ;
    var x = run.comet.x, y = run.comet.y, vx = run.comet.vx, vy = run.comet.vy;
    var list = run.planetList;
    var steps = Math.ceil(horizon / dt);
    for (var i = 0; i < steps; i++) {
      vy -= C.GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      for (var j = 0; j < list.length; j++) {
        var q = list[j];
        if (hypot(planetX(q, run.t) - x, q.y - y) <= q.R + C.COMET_R) return true;
      }
    }
    return false;
  }

  /** True when the arc of the orbit circle from theta0 over `arc` rad in direction s hits no wall or planet. */
  function arcClear(run, p, cx, cy, d, theta0, s, arc) {
    var C = cfg();
    var pad = C.COMET_R + ARC_PAD;
    var wallLo = pad, wallHi = C.COL_W - pad;
    var list = run.planetList;
    var threats = [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === p) continue;
      var qx = planetX(q, run.t);
      var dc = hypot(qx - cx, q.y - cy);
      if (dc + q.R + pad >= d && dc - q.R - pad <= d) threats.push({ x: qx, y: q.y, R: q.R });
    }
    var needWall = (cx - d < wallLo) || (cx + d > wallHi);
    if (!needWall && threats.length === 0) return true;
    for (var phi = 0; phi <= arc; phi += ARC_STEP) {
      var th = theta0 + s * phi;
      var x = cx + d * Math.cos(th), y = cy + d * Math.sin(th);
      if (x < wallLo || x > wallHi) return false;
      for (var j = 0; j < threats.length; j++) {
        if (hypot(x - threats[j].x, y - threats[j].y) <= threats[j].R + pad) return false;
      }
    }
    return true;
  }

  /**
   * Plans a latch on planet p from comet state c ({x, y, vx, vy}): finds the
   * release angle aimed at the next main planet, checks the heat budget, the
   * horizon and the arc for collisions. Null when not feasible.
   */
  function latchPlan(run, c, p, noise) {
    var C = cfg();
    var cx = planetX(p, run.t), cy = p.y;
    var relx = c.x - cx, rely = c.y - cy;
    var d = hypot(relx, rely);
    var theta0 = Math.atan2(rely, relx);
    var cross = relx * c.vy - rely * c.vx;
    var s = cross < 0 ? -1 : 1;
    var w = C.V_ORBIT / d;
    var rate = (p.hot ? 2 : 1) / C.T_BURN;
    var N = nextMain(run, p);
    var thetaR = theta0;
    for (var it = 0; it < 2; it++) {
      var rx = cx + d * Math.cos(thetaR), ry = cy + d * Math.sin(thetaR);
      thetaR = aimAngle(run, rx, ry, N, noise) - s * Math.PI / 2;
    }
    var delta = posMod((thetaR - theta0) * s, TAU);
    if (run.heat + (delta / w) * rate > HEAT_SAFE) return null;
    var loop = !p.hot && d <= LOOP_R && run.heat + ((delta + TAU) / w) * rate <= HEAT_SAFE;
    var arc = loop ? delta + TAU : delta;
    if (cy + d * Math.sin(thetaR) - C.COMET_R < run.camBottom + 40) return null;
    if (!arcClear(run, p, cx, cy, d, theta0, s, arc)) return null;
    return { s: s, delta: delta, loop: loop, thetaR: thetaR };
  }

  /**
   * Reference decision function: the design's scripted bot. Latches when a
   * planned orbit is safe, releases when the tangent is within 12 degrees of
   * the direction to the next main-chain planet (heat < 0.9), loops when the
   * rod is <= 140 px and the heat budget allows. Pure in (run, noise).
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
      var N = nextMain(run, p);
      var aim = aimAngle(run, c.x, c.y, N, noise);
      var tangent = T.theta + T.s * Math.PI / 2;
      if (!p.hot && T.r <= LOOP_R && T.loops === 0) {
        var remaining = TAU - T.loopAcc;
        var deltaAfter = posMod((aim - T.s * Math.PI / 2 - (T.theta + T.s * remaining)) * T.s, TAU);
        if (run.heat + ((remaining + deltaAfter) / w) * rate <= HEAT_SAFE) return true;
      }
      if (run.heat >= HEAT_PANIC) return false;
      var mis = angleDiff(aim, tangent);
      var misNext = angleDiff(aim, tangent + T.s * w / C.SIM_HZ);
      if (Math.abs(mis) <= ALIGN_RAD && Math.abs(misNext) >= Math.abs(mis)) return false;
      return true;
    }
    var tg = getTarget(run);
    if (!tg) return false;
    if (latchPlan(run, predictComet(run), tg.planet, noise)) return true;
    if (collisionImminent(run, CRASH_HORIZON)) return true;
    return c.vy < 0 && c.y - run.camBottom < 300 && tg.color !== 'red';
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
   * Clumsy bot: ±noiseDeg of aim noise (re-rolled at every latch) and a reaction
   * delay (default 150 ms) between deciding to press / release and doing it.
   * Per-run state lives in opts.state (created on first call).
   * @param {Object} run
   * @param {function(): number} rng seeded source of noise
   * @param {{noiseDeg?:number, delayMs?:number, state?:Object}} [opts]
   * @returns {{held:boolean}}
   */
  function clumsy(run, rng, opts) {
    opts = opts || {};
    var noiseDeg = opts.noiseDeg === undefined ? 25 : opts.noiseDeg;
    var delayMs = opts.delayMs === undefined ? 150 : opts.delayMs;
    var st = opts.state;
    if (!st) {
      st = opts.state = { hand: false, pendingAt: -1, pendingVal: false, noise: 0, latchSeen: -1 };
    }
    if (st.latchSeen !== run.counters.latches) {
      st.latchSeen = run.counters.latches;
      st.noise = (rng() * 2 - 1) * noiseDeg * Math.PI / 180;
    }
    if (st.pendingAt >= 0) {
      if (run.step >= st.pendingAt) { st.hand = st.pendingVal; st.pendingAt = -1; }
      return { held: st.hand };
    }
    var intent = decide(run, st.noise);
    if (intent !== st.hand) {
      st.pendingAt = run.step + Math.round(delayMs / 1000 * cfg().SIM_HZ);
      st.pendingVal = intent;
    }
    return { held: st.hand };
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
    bots: { perfect: perfect, clumsy: clumsy, decide: decide, latchPlan: latchPlan, nextMain: nextMain }
  };
})();
