/**
 * G.CONFIG / G.NAME / G.VERSION — every tunable number of Tetherloop in one place.
 *
 * Classic script (IIFE), no dependencies, works from file://. Loaded FIRST.
 * Nothing in the game hardcodes these numbers; the debug panel (?debug=1) mutates
 * this object in place at runtime, so modules must read G.CONFIG.<field> when
 * they need a value rather than caching copies at load time.
 *
 * Units: world x in [0, COL_W] px, world y UP in px, 10 px = 1 m, seconds for time.
 *
 * TUNING LOG (mandatory gate of the design, tests/sim.test.mjs "tuning gate"):
 *   The only rows that may change after the physics lock are DIFFICULTY gap/lat/hot.
 *   Measured with the table below (node tests/sim.test.mjs), after the review fix of
 *   the bot planner (latch plans only consider release angles ahead of the latch point):
 *     perfect bot : 20/20 seeds (1..20) reached 3000 m alive — floor MET
 *                   (seeds 21..40, robustness line: 20/20; seeds 1..10 to 6000 m: 8/10, both FELL)
 *     clumsy bot  : median death 11.7 s over 40 seeds (p25 7.1 s, p75 18.2 s, max 148 s;
 *                   28 crashed on the rod after an emergency latch, 9 fell, 3 crashed in flight),
 *                   design band 20–70 s NOT MET. The median is insensitive to the
 *                   sanctioned knobs: gap −30 px → 9.7 s, gap +40 px → 9.3 s, lat −80 px → 14.2 s,
 *                   hot = 0 everywhere → unchanged. It is set by the prescribed ±25° aim noise
 *                   (±15° → 15.2 s, ±10° → 39 s, 0° → 161 s, same table), so the table keeps
 *                   the design values; retuning gap/lat/hot cannot move this gate.
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

  /** Display name of the game. */
  G.NAME = 'Tetherloop';
  /** Semantic version, also read by scripts/pack.sh. */
  G.VERSION = '1.0.0';

  G.CONFIG = {
    // --- fixed-step simulation -------------------------------------------------
    SIM_HZ: 120,              // steps per second (dt = 1/120)
    MAX_STEPS_PER_FRAME: 8,   // accumulator cap: slow down instead of teleporting
    COMET_R: 9,               // comet collision radius (px)
    COL_W: 540,               // playable column width (px)
    VIEW_H: 960,              // logical portrait view height (px)

    // --- physics (locked; never retuned after hour 12) --------------------------
    V_ORBIT: 420,             // constant tangential speed while tethered (px/s)
    GRAVITY: 520,             // downward acceleration in flight (px/s^2)
    T_BURN: 2.4,              // seconds of hold (on a cold planet) until BURNED
    T_COOL: 0.5,              // seconds for heat to cool from 1 to 0 in flight
    HOT_BOOST: 0.5,           // launch speed = V_ORBIT * (1 + HOT_BOOST * heat)
    HOT_SHOT_HEAT: 0.7,       // release heat threshold for the HOT SHOT bonus
    GRAZE_BAND: 14,           // surface distance (0, GRAZE_BAND] px counts as a graze
    WALL_RESTITUTION: 0.85,   // vx multiplier on a side-wall bounce

    // --- targeting --------------------------------------------------------------
    LATCH_MIN_CLEAR: 13,      // minimum latch distance above the planet radius (px)
    TARGET_CONE_COS: -0.1736, // cos(100 deg): candidates must satisfy dot(vhat, phat) >= this
    TARGET_DOT_WEIGHT: 120,   // cost = d + TARGET_DOT_WEIGHT * (1 - dot) / 2
    TETHER_RANGE: { base: 300, startDropM: 800, endM: 2000, end: 220 }, // px by altitude (m)

    // --- world / camera ---------------------------------------------------------
    CHUNK_H: 2000,            // chunk height (px) = 200 m
    CAM_ANCHOR: 0.60,         // camBottom = max(camBottom, comet.y - CAM_ANCHOR * VIEW_H)
    CAM_START: -480,          // initial camBottom (px)
    LOOKAHEAD_FADE: [1000, 1170], // world above camBottom + a fades to alpha 0 by camBottom + b
    LONG_SHOT_M: 25,          // altitude gain release -> latch (m) for LONG SHOT

    // --- scoring ----------------------------------------------------------------
    SCORE: { GRAZE: 5, GRAZE_M: 0.5, HOT: 10, HOT_M: 0.25, LONG: 10, LOOP: 20, M_CAP: 5 },
    REWIND: { MIN_POOL: 40, MIN_ALT_M: 150, OFFER_S: 4 },
    DUST: { DIV: 10, PER_GRAZE: 2, PER_LOOP: 10, CAP: 400 },
    RANKS: [['dust', 0], ['pebble', 150], ['meteor', 400], ['comet', 800], ['star', 1400], ['nova', 2200], ['quasar', 3500]],
    MEDALS: { bronze: 300, silver: 700, gold: 1400 },

    // --- difficulty table: rows by altitude A (m) at the chunk base ---------------
    // R: planet radius range (px); gap: vertical hop range (px); lat: max lateral hop (px);
    // hot: probability of a hot planet; drift: probability of a drifting planet (applied from 700 m).
    // Measured tuning gate (see header): design values kept unchanged.
    DIFFICULTY: [
      { from: 0,    R: [44, 72], gap: [170, 230], lat: 140, hot: 0.00, drift: 0.00 },
      { from: 200,  R: [36, 64], gap: [200, 280], lat: 180, hot: 0.00, drift: 0.00 },
      { from: 400,  R: [36, 64], gap: [200, 280], lat: 180, hot: 0.10, drift: 0.00 },
      { from: 600,  R: [30, 56], gap: [230, 320], lat: 220, hot: 0.15, drift: 0.15 }, // drift only from 700 m (gen: A >= DRIFT_MIN_A)
      { from: 1200, R: [26, 50], gap: [250, 340], lat: 250, hot: 0.22, drift: 0.25 },
      { from: 2000, R: [26, 46], gap: [260, 350], lat: 260, hot: 0.28, drift: 0.30 }
    ],
    SATELLITE_P: 0.35,        // probability of a side planet per eligible main row
    SATELLITE_MIN_A: 100,     // satellites only in chunks whose base altitude (m) is >= this
    SATELLITE_DY: 40,         // satellite y offset from its main row (px)
    SATELLITE_MIN_OFF: 110,   // satellite x offset is at least R1 + R2 + this (px)
    DRIFT: { amp: [40, 80], period: [3, 5] }, // drifting planet amplitude (px) and period (s)
    DRIFT_MIN_A: 700,         // drifting planets only from this altitude (m)
    MIN_SEP: 90,              // any two planets: centre distance >= R1 + R2 + MIN_SEP
    MARGIN: 70,               // planet centre x in [R + MARGIN, COL_W - R - MARGIN]

    // --- monetisation pacing -----------------------------------------------------
    ADS: { EVERY_N_DEATHS: 3, MIN_GAP_MS: 90000, MIN_RUN_S: 15, FIRST_AFTER_DEATHS: 3, REWARD_TIMEOUT_MS: 30000 },

    // --- sharing -----------------------------------------------------------------
    SHARE: {
      APP_URL: 'https://feederparker1-droid.github.io/tma-uploader-site/game/',
      TELEGRAM_APP: '',
      ITCH_URL: '',
      PAYLOAD_MAX: 1500,
      NAME_MAX: 12
    },

    // --- performance -------------------------------------------------------------
    PERF: { DPR_CAP: 2, PARTICLE_POOL: 400, AUTO_QUALITY_MS: 20 },

    TUTORIAL: true
  };
})();
