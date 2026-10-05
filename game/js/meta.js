/*!
 * G.meta — progression, persistence and daily bookkeeping for Tetherloop.
 *
 * Owns everything that outlives a single run: best score, dust (soft currency),
 * owned/equipped cosmetics, lifetime stats, settings, the UTC-dated Daily
 * (seed, number, best-of-day, medal, streak) and the three missions rolled per
 * UTC day. The run itself (G.sim) never touches this module; the integrator
 * forwards sim events through onEvent() and hands the finished run to onRunEnd().
 *
 * Persistence goes through G.storage when it is present. Every storage call is
 * wrapped so a missing or throwing storage module degrades to an in-memory
 * session store with identical behaviour. Values written during the session
 * are served from that in-memory cache; a 'g:storage' event whose source is not
 * 'local' (another tab, a cloud mirror pull, an import) invalidates the cached
 * copy so the next read sees the fresh value.
 *
 * Determinism: dateKey/dailySeed/dailyNumber/rollMissions/rankFor/medalFor are
 * pure functions of their arguments. freeSeed() is the only clock-derived value.
 *
 * Classic script (IIFE), no dependencies beyond the optional G.storage,
 * G.CONFIG, G.i18n, G.audio and G.sdk — each guarded, so the module also loads
 * standalone in a unit test.
 *
 * Public API (JSDoc on each member below):
 *   Tables   G.meta.SKINS, THEMES, MISSIONS, AD_TRY_VIEWS
 *   Lifecycle G.meta.init() → state ; G.meta.state (read-only use)
 *   Dates    dateKey(date?), dailySeed(dateKey), dailyNumber(dateKey), freeSeed(), dailyInfo()
 *   Tiers    rankFor(score), medalFor(score)
 *   Settings settings, setSetting(key, value)
 *   Cosmetics equip(skinId), equipTheme(themeId), equipped, sessionTry(skinId), sessionSkin,
 *            isOwned(skinId), canAfford(skinId), buySkin(skinId), adTryView(skinId),
 *            themeUnlocked(themeId), themeProgress(themeId)
 *   Identity name, setName(str), sanitizeName(str)
 *   Runs     startRun(mode), onEvent(evt), onRunEnd(summary), doubleDust(dustEarned), dustBalance()
 *   Missions rollMissions(dateKey), missionsToday(), claimMission(id), unclaimedCount()
 *   Tutorial markTutorialSeen(), tutorialSeen
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

  /* ------------------------------------------------------------------ */
  /* Constants                                                            */
  /* ------------------------------------------------------------------ */

  /** Rewarded "Try this skin" views needed for a permanent unlock. */
  var AD_TRY_VIEWS = 3;
  /** Salt mixed into the daily seed before rolling the day's missions (design: mulberry32(dailySeed ^ 0x4D15)). */
  var MISSION_SALT = 0x4D15;
  /** Missions rolled per UTC day. */
  var MISSIONS_PER_DAY = 3;
  /** Streak length whose multiples pay double dust for the whole day. */
  var STREAK_BONUS_EVERY = 7;
  /** Epoch of "Daily #0" (2026-01-01 UTC). */
  var DAILY_EPOCH_MS = Date.UTC(2026, 0, 1);
  var DAY_MS = 86400000;
  /** Floor for the "beat your best" mission target. */
  var BEAT_BEST_MIN = 50;
  /** Altitude a run must reach for the "runs above 200 m" day mission. */
  var RUNS_ABOVE_ALT_M = 200;
  /** Altitude for the "zero grazes" run mission. */
  var ZERO_GRAZE_ALT_M = 150;

  /**
   * Fallback copies of the G.CONFIG tables this module reads. Used only when
   * config.js is not loaded (unit tests); in the game every read goes to G.CONFIG.
   */
  var FALLBACK = {
    DUST: { DIV: 10, PER_GRAZE: 2, PER_LOOP: 10, CAP: 400 },
    RANKS: [['dust', 0], ['pebble', 150], ['meteor', 400], ['comet', 800], ['star', 1400], ['nova', 2200], ['quasar', 3500]],
    MEDALS: { bronze: 300, silver: 700, gold: 1400 },
    NAME_MAX: 12
  };

  var DEFAULT_SETTINGS = { sound: true, music: true, haptics: true, reduceMotion: false, aimGuide: true };
  var DEFAULT_STATS = { runs: 0, totalAltM: 0, loops: 0, grazes: 0, hotShots: 0, duelsWon: 0 };
  var SKIN_DEFAULT = 'ember';
  var THEME_DEFAULT = 'indigo';
  var NAME_STRIP_RE = /[^A-Za-z0-9]/g;

  /* ------------------------------------------------------------------ */
  /* Data tables                                                          */
  /* ------------------------------------------------------------------ */

  /** Latch-chime timbre implied by a trail style when the skin does not name one. */
  var TIMBRE_BY_STYLE = { ribbon: 'triangle', beads: 'sine', sparks: 'square', jagged: 'saw' };

  /**
   * Comet trail skins. Prices in dust; price 0 = always owned.
   * Normalised below so every entry carries id, price, style, hueA, hueB, width and timbre.
   */
  var SKINS = [
    { id: 'ember', price: 0, hueA: 18, hueB: 0, style: 'ribbon', width: 8, timbre: 'triangle' },
    { id: 'ion', price: 400, hueA: 190, hueB: 210, style: 'beads', timbre: 'sine' },
    { id: 'petal', price: 500, hueA: 330, hueB: 350, style: 'beads' },
    { id: 'static', price: 600, hueA: 0, hueB: 0, style: 'jagged', sat: 0, timbre: 'saw' },
    { id: 'prism', price: 800, hueA: 0, hueB: 300, style: 'ribbon', cycle: true },
    { id: 'sunspot', price: 900, hueA: 45, hueB: 30, style: 'sparks', timbre: 'square' },
    { id: 'void', price: 1000, hueA: 0, hueB: 0, style: 'ribbon', core: '#000', edge: '#fff' },
    { id: 'glitch', price: 1200, hueA: 160, hueB: 300, style: 'ribbon', offset: true }
  ].map(function (s) {
    s.hueA = isNum(s.hueA) ? s.hueA : 0;
    s.hueB = isNum(s.hueB) ? s.hueB : s.hueA;
    s.width = isNum(s.width) ? s.width : 8;
    s.timbre = s.timbre || TIMBRE_BY_STYLE[s.style] || 'triangle';
    return Object.freeze(s);
  });

  /**
   * Sky themes, unlocked by lifetime altitude (stats.totalAltM). skyStops are
   * [altitudeM, hex] pairs the renderer interpolates by altitude; nebula holds
   * three [h, s, l] triples; planetPalettes six 3-stop gradients; mood drives
   * the music scale (minor/major pentatonic).
   */
  var THEMES = [
    {
      id: 'indigo', unlockAltM: 0, mood: 'minor', starHue: 220,
      skyStops: [[0, '#0b1030'], [300, '#0d2a3a'], [700, '#2a1240'], [1200, '#3a2a10'], [2000, '#0a0a14']],
      nebula: [[260, 60, 45], [200, 70, 40], [320, 50, 40]],
      planetPalettes: [
        ['#8fb3ff', '#4a63c7', '#1d2a6b'],
        ['#ffb38a', '#d96b4a', '#6b2a1f'],
        ['#b8f0d8', '#4fbf9a', '#1f5c48'],
        ['#e6c4ff', '#9b5fd9', '#3f2370'],
        ['#fff0a8', '#d9b24f', '#6b5520'],
        ['#c9d6e8', '#7a8aa6', '#2f3a4d']
      ],
      tether: '#6ff', hot: '#ff5a3c', text: '#eef'
    },
    {
      id: 'ember', unlockAltM: 2000, mood: 'major', starHue: 20,
      skyStops: [[0, '#2a0b12'], [300, '#4a1420'], [700, '#6b2a1a'], [1200, '#3a1a30'], [2000, '#120408']],
      nebula: [[15, 80, 45], [345, 60, 40], [40, 70, 42]],
      planetPalettes: [
        ['#ffd9a8', '#e0864a', '#6b2f14'],
        ['#ffb0a0', '#c94f3d', '#5c1a12'],
        ['#ffe6b8', '#d9a24f', '#6b4a14'],
        ['#f2c4d0', '#b05a78', '#4d1f33'],
        ['#ffc98a', '#cc6b2a', '#5c2a0a'],
        ['#e8d0c0', '#9a7060', '#3f2a22']
      ],
      tether: '#ffd27a', hot: '#ff3d2e', text: '#fff0e8'
    },
    {
      id: 'mint', unlockAltM: 6000, mood: 'major', starHue: 160,
      skyStops: [[0, '#06241f'], [300, '#0b3a33'], [700, '#13524a'], [1200, '#1d3a4a'], [2000, '#04120f']],
      nebula: [[160, 60, 40], [190, 55, 38], [120, 50, 36]],
      planetPalettes: [
        ['#c8ffe8', '#5fd4a8', '#1f6b52'],
        ['#d8fff0', '#7ad9c8', '#2a6b66'],
        ['#eafff2', '#a0e0b0', '#3a7a4a'],
        ['#c0f0ff', '#58b8d9', '#1f5a70'],
        ['#fff8c8', '#d9d070', '#6b6520'],
        ['#d8e8e0', '#8aa69a', '#35463f']
      ],
      tether: '#aaffdd', hot: '#ff7a3c', text: '#eafff6'
    },
    {
      id: 'vapor', unlockAltM: 15000, mood: 'minor', starHue: 300,
      skyStops: [[0, '#1a0b2e'], [300, '#2d1050'], [700, '#4a1a6b'], [1200, '#1a3a6b'], [2000, '#0b0618']],
      nebula: [[300, 70, 45], [200, 80, 45], [330, 65, 45]],
      planetPalettes: [
        ['#ffc0f0', '#d95fc0', '#6b1f5c'],
        ['#c0f0ff', '#5fb8e8', '#1f4a7a'],
        ['#e0c0ff', '#9a5fe8', '#3a1f7a'],
        ['#ffd0e0', '#e87aa0', '#7a2a48'],
        ['#c8fff8', '#60d0d8', '#1f5c66'],
        ['#dcd0f0', '#8c7fb0', '#3a334d']
      ],
      tether: '#ff7ad9', hot: '#ff5a7a', text: '#f6e8ff'
    },
    {
      id: 'ink', unlockAltM: 30000, mood: 'minor', starHue: 0, monochrome: true,
      skyStops: [[0, '#000000'], [300, '#0a0a0a'], [700, '#141414'], [1200, '#0d0d0d'], [2000, '#000000']],
      nebula: [[0, 0, 25], [0, 0, 18], [0, 0, 30]],
      planetPalettes: [
        ['#ffffff', '#d0d0d0', '#707070'],
        ['#f4f4f4', '#bcbcbc', '#606060'],
        ['#ffffff', '#c8c8c8', '#585858'],
        ['#ededed', '#b0b0b0', '#505050'],
        ['#fafafa', '#c0c0c0', '#666666'],
        ['#e4e4e4', '#a8a8a8', '#484848']
      ],
      tether: '#ffffff', hot: '#ff5a3c', text: '#ffffff'
    }
  ].map(Object.freeze);

  /**
   * Mission table. kind 'run': progress is the best single-run value of the
   * metric; kind 'day': progress accumulates across the day's runs.
   * target 0 on 'beatBest' means "computed at roll time" (max(best + 1, 50)).
   */
  var MISSIONS = [
    { id: 1, key: 'mission_1', target: 10, reward: 120, kind: 'run', metric: 'grazes' },
    { id: 2, key: 'mission_2', target: 150, reward: 150, kind: 'run', metric: 'banked' },
    { id: 3, key: 'mission_3', target: 300, reward: 120, kind: 'run', metric: 'altM' },
    { id: 4, key: 'mission_4', target: 3, reward: 150, kind: 'run', metric: 'loops' },
    { id: 5, key: 'mission_5', target: 5, reward: 120, kind: 'run', metric: 'hotShots' },
    { id: 6, key: 'mission_6', target: 4, reward: 150, kind: 'run', metric: 'maxM' },
    { id: 7, key: 'mission_7', target: 2, reward: 120, kind: 'day', metric: 'runsAbove200' },
    { id: 8, key: 'mission_8', target: 5, reward: 150, kind: 'day', metric: 'bankRuns' },
    { id: 9, key: 'mission_9', target: 1, reward: 80, kind: 'day', metric: 'daily' },
    { id: 10, key: 'mission_10', target: 1, reward: 120, kind: 'run', metric: 'zeroGrazeAlt150' },
    { id: 11, key: 'mission_11', target: 60, reward: 120, kind: 'run', metric: 'surviveS' },
    { id: 12, key: 'mission_12', target: 0, reward: 200, kind: 'run', metric: 'beatBest' }
  ].map(Object.freeze);

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                        */
  /* ------------------------------------------------------------------ */

  /** @param {*} v @returns {boolean} true for a finite number. */
  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** @param {*} v @param {number} fb @returns {number} v when finite, else fb. */
  function num(v, fb) {
    return isNum(v) ? v : fb;
  }

  /** @param {*} v @param {number} fb @returns {number} non-negative integer. */
  function nonNegInt(v, fb) {
    var n = num(v, fb);
    return n > 0 ? Math.floor(n) : 0;
  }

  /** @param {Object} obj @param {string} key @returns {boolean} own-property test. */
  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** @param {*} v @returns {boolean} true for a plain object (not array/null). */
  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** @returns {Object} the live G.CONFIG (or an empty object when config.js is absent). */
  function cfg() {
    return isObj(G.CONFIG) ? G.CONFIG : {};
  }

  /**
   * Dust tuning from G.CONFIG.DUST, each field falling back to the contract
   * value when it is missing or not a finite number (a corrupt debug-panel edit
   * must never turn the persisted dust balance into NaN).
   * @returns {{DIV:number, PER_GRAZE:number, PER_LOOP:number, CAP:number}}
   */
  function dustConfig() {
    var d = isObj(cfg().DUST) ? cfg().DUST : {};
    var f = FALLBACK.DUST;
    var div = num(d.DIV, f.DIV);
    return {
      DIV: div > 0 ? div : f.DIV,
      PER_GRAZE: num(d.PER_GRAZE, f.PER_GRAZE),
      PER_LOOP: num(d.PER_LOOP, f.PER_LOOP),
      CAP: num(d.CAP, f.CAP)
    };
  }

  /** @returns {Array<[string, number]>} rank table sorted by threshold. */
  function rankTable() {
    var r = cfg().RANKS;
    return Array.isArray(r) && r.length ? r : FALLBACK.RANKS;
  }

  /** @returns {{bronze:number, silver:number, gold:number}} */
  function medalTable() {
    var m = cfg().MEDALS;
    return isObj(m) ? m : FALLBACK.MEDALS;
  }

  /** @returns {number} maximum display-name length (CONFIG.SHARE.NAME_MAX). */
  function nameMax() {
    var share = cfg().SHARE;
    return isObj(share) && isNum(share.NAME_MAX) && share.NAME_MAX > 0 ? Math.floor(share.NAME_MAX) : FALLBACK.NAME_MAX;
  }

  /**
   * Standard mulberry32 PRNG (same algorithm as G.sim.mulberry32; duplicated so
   * meta never depends on the simulation module).
   * @param {number} seed uint32
   * @returns {function():number} float in [0,1)
   */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** @param {*} v @returns {string} two-digit zero-padded. */
  function pad2(v) {
    return (v < 10 ? '0' : '') + v;
  }

  /* ------------------------------------------------------------------ */
  /* Persistence layer: G.storage with an in-memory session fallback      */
  /* ------------------------------------------------------------------ */

  /** @type {Map<string,*>} session cache; authoritative for keys written this session. */
  var mem = new Map();

  /** @returns {Object|null} G.storage when it exposes get/set. */
  function backend() {
    var s = G.storage;
    return s && typeof s.get === 'function' && typeof s.set === 'function' ? s : null;
  }

  /** @returns {boolean} true when G.storage can currently serve reads (so the session cache may be dropped). */
  function storageReadable() {
    var s = backend();
    if (!s) return false;
    try {
      s.get('best', 0);
      return true;
    } catch (err) {
      return false;
    }
  }

  var kv = {
    /**
     * @param {string} key
     * @param {*} fb fallback when missing or unreadable
     * @returns {*}
     */
    get: function (key, fb) {
      if (mem.has(key)) return mem.get(key);
      var s = backend();
      if (!s) return fb;
      try {
        var v = s.get(key, fb);
        return v === undefined ? fb : v;
      } catch (err) {
        G.log('[meta] storage.get failed for', key, err);
        return fb;
      }
    },
    /**
     * @param {string} key
     * @param {*} value JSON-serialisable
     */
    set: function (key, value) {
      mem.set(key, value);
      var s = backend();
      if (!s) return;
      try {
        s.set(key, value);
      } catch (err) {
        G.log('[meta] storage.set failed for', key, err);
      }
    },
    /** @param {string} key */
    remove: function (key) {
      mem.delete(key);
      var s = backend();
      if (!s || typeof s.remove !== 'function') return;
      try {
        s.remove(key);
      } catch (err) {
        G.log('[meta] storage.remove failed for', key, err);
      }
    }
  };

  /* ------------------------------------------------------------------ */
  /* Dates                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * UTC calendar key of a moment.
   * @param {Date|number} [date] Date or epoch ms; defaults to now. Invalid input → now.
   * @returns {string} 'YYYYMMDD'
   */
  function dateKey(date) {
    var ms = date && typeof date.getTime === 'function' ? date.getTime() : date;
    var d = new Date(isNum(ms) ? ms : Date.now());
    return String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  }

  /**
   * Parses a date key.
   * @param {string} key 'YYYYMMDD'
   * @returns {{y:number, m:number, d:number}|null} null when malformed
   */
  function parseDateKey(key) {
    if (typeof key !== 'string' || !/^\d{8}$/.test(key)) return null;
    var y = +key.slice(0, 4), m = +key.slice(4, 6), d = +key.slice(6, 8);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d };
  }

  /** @param {string} key @returns {number} UTC midnight (ms) of the key, NaN when malformed. */
  function keyToMs(key) {
    var p = parseDateKey(key);
    return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN;
  }

  /** @param {string} key @param {number} days @returns {string} the key shifted by whole days. */
  function shiftDateKey(key, days) {
    var ms = keyToMs(key);
    return dateKey(isNaN(ms) ? undefined : ms + days * DAY_MS);
  }

  /**
   * Seed of a day's cosmos: (yyyy*10000 + mm*100 + dd) ^ 0x5EED1234.
   * @param {string} key 'YYYYMMDD'
   * @returns {number} uint32 (a malformed key seeds from today's key)
   */
  function dailySeed(key) {
    var p = parseDateKey(key) || parseDateKey(dateKey());
    return ((p.y * 10000 + p.m * 100 + p.d) ^ 0x5EED1234) >>> 0;
  }

  /**
   * "Daily #N": whole days since 2026-01-01 UTC (may be negative before that).
   * @param {string} key 'YYYYMMDD'
   * @returns {number}
   */
  function dailyNumber(key) {
    var ms = keyToMs(key);
    if (isNaN(ms)) ms = keyToMs(dateKey());
    return Math.round((ms - DAILY_EPOCH_MS) / DAY_MS);
  }

  var freeSeedCounter = 0;

  /**
   * Seed for free play: wall clock, high-resolution clock and a per-session
   * counter mixed through integer hashing. Never zero-entropy on fast repeats.
   * @returns {number} uint32
   */
  function freeSeed() {
    var now = Date.now();
    var perf = 0;
    try {
      if (window.performance && typeof window.performance.now === 'function') perf = window.performance.now();
    } catch (err) {
      perf = 0;
    }
    freeSeedCounter = (freeSeedCounter + 1) >>> 0;
    var h = Math.imul(now >>> 0, 2654435761) >>> 0;
    h ^= Math.imul(Math.floor(now / 4294967296) >>> 0, 0x85EBCA6B);
    h ^= (perf * 1000) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
    h ^= Math.imul(freeSeedCounter, 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /* ------------------------------------------------------------------ */
  /* Tiers                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Rank for a (best) score.
   * @param {number} score
   * @returns {{id:string, threshold:number, next:({id:string, threshold:number}|null), index:number}}
   */
  function rankFor(score) {
    var table = rankTable();
    var s = num(score, 0);
    var index = 0;
    for (var i = 0; i < table.length; i++) {
      if (s >= table[i][1]) index = i;
    }
    var next = index + 1 < table.length ? { id: table[index + 1][0], threshold: table[index + 1][1] } : null;
    return { id: table[index][0], threshold: table[index][1], next: next, index: index };
  }

  /**
   * Daily medal for a score.
   * @param {number} score
   * @returns {null|'bronze'|'silver'|'gold'}
   */
  function medalFor(score) {
    var m = medalTable();
    var s = num(score, 0);
    if (s >= m.gold) return 'gold';
    if (s >= m.silver) return 'silver';
    if (s >= m.bronze) return 'bronze';
    return null;
  }

  /** @param {string|null} medal @returns {number} ordering value for "did the medal improve" checks. */
  function medalRank(medal) {
    return medal === 'gold' ? 3 : medal === 'silver' ? 2 : medal === 'bronze' ? 1 : 0;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Live persisted state. Mutated only through the API below.
   * @type {{best:number, dust:number, owned:string[], equip:{skin:string, theme:string},
   *         streak:{last:(string|null), count:number}, stats:Object, settings:Object,
   *         seenTutorial:boolean, name:string}}
   */
  var state = freshState();
  /** @type {string|null} skin equipped only for this session via sessionTry(). */
  var sessionSkin = null;
  /** @type {Object|null} per-run metric tracker created by startRun(). */
  var tracker = null;
  /** @type {{dateKey:string, rec:Object}|null} cached mission record for the current UTC day. */
  var missionCache = null;
  var initialised = false;

  /** @returns {Object} default state before anything is loaded. */
  function freshState() {
    return {
      best: 0,
      dust: 0,
      owned: [],
      equip: { skin: SKIN_DEFAULT, theme: THEME_DEFAULT },
      streak: { last: null, count: 0 },
      stats: Object.assign({}, DEFAULT_STATS),
      settings: Object.assign({}, DEFAULT_SETTINGS),
      seenTutorial: false,
      name: ''
    };
  }

  /** @param {string} id @returns {Object|null} skin definition. */
  function skinById(id) {
    for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === id) return SKINS[i];
    return null;
  }

  /** @param {string} id @returns {Object|null} theme definition. */
  function themeById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return null;
  }

  /** @param {number} id @returns {Object|null} mission definition. */
  function missionById(id) {
    for (var i = 0; i < MISSIONS.length; i++) if (MISSIONS[i].id === id) return MISSIONS[i];
    return null;
  }

  /**
   * Strips a display name to [A-Za-z0-9] and caps it at CONFIG.SHARE.NAME_MAX.
   * @param {*} str
   * @returns {string} possibly empty
   */
  function sanitizeName(str) {
    return String(str == null ? '' : str).replace(NAME_STRIP_RE, '').slice(0, nameMax());
  }

  /** @returns {string} sanitized G.sdk.user.name, or 'You'. */
  function defaultName() {
    var user = null;
    try {
      user = G.sdk && G.sdk.user;
    } catch (err) {
      user = null;
    }
    var clean = user && typeof user.name === 'string' ? sanitizeName(user.name) : '';
    return clean || 'You';
  }

  /** Reads one persisted key into `state`, validating its shape. @param {string} key */
  function loadKey(key) {
    var v;
    switch (key) {
      case 'best':
        state.best = nonNegInt(kv.get('best', 0), 0);
        break;
      case 'dust':
        state.dust = nonNegInt(kv.get('dust', 0), 0);
        break;
      case 'owned':
        v = kv.get('owned', []);
        state.owned = Array.isArray(v) ? v.filter(function (id, i, arr) {
          return typeof id === 'string' && skinById(id) && arr.indexOf(id) === i;
        }) : [];
        break;
      case 'equip':
        v = kv.get('equip', null);
        state.equip = {
          skin: isObj(v) && typeof v.skin === 'string' ? v.skin : SKIN_DEFAULT,
          theme: isObj(v) && typeof v.theme === 'string' ? v.theme : THEME_DEFAULT
        };
        break;
      case 'streak':
        v = kv.get('streak', null);
        state.streak = {
          last: isObj(v) && parseDateKey(v.last) ? v.last : null,
          count: isObj(v) ? nonNegInt(v.count, 0) : 0
        };
        if (!state.streak.last) state.streak.count = 0;
        break;
      case 'stats':
        v = kv.get('stats', null);
        state.stats = {};
        Object.keys(DEFAULT_STATS).forEach(function (k) {
          state.stats[k] = isObj(v) ? nonNegInt(v[k], 0) : 0;
        });
        break;
      case 'settings':
        v = kv.get('settings', null);
        state.settings = {};
        Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
          state.settings[k] = isObj(v) && typeof v[k] === 'boolean' ? v[k] : DEFAULT_SETTINGS[k];
        });
        break;
      case 'seenTutorial':
        state.seenTutorial = kv.get('seenTutorial', false) === true;
        break;
      case 'name':
        state.name = sanitizeName(kv.get('name', ''));
        break;
      default:
        break;
    }
  }

  var STATE_KEYS = ['best', 'dust', 'owned', 'equip', 'streak', 'stats', 'settings', 'seenTutorial', 'name'];

  /** Drops an equipped cosmetic the player does not actually have (corrupt or imported state). */
  function validateEquip() {
    if (!skinById(state.equip.skin) || !isOwned(state.equip.skin)) state.equip.skin = SKIN_DEFAULT;
    if (!themeById(state.equip.theme) || !themeUnlocked(state.equip.theme)) state.equip.theme = THEME_DEFAULT;
  }

  /** Pushes the audio/haptics settings to the sibling modules when they are present. @param {string} key */
  function applySetting(key) {
    var v = state.settings[key];
    try {
      if (key === 'sound' && G.audio && typeof G.audio.setSfx === 'function') G.audio.setSfx(v);
      if (key === 'music' && G.audio && typeof G.audio.setMusic === 'function') G.audio.setMusic(v);
      if (key === 'haptics') {
        if (G.sdk) G.sdk.hapticsEnabled = v;
        kv.set('haptics', v);
      }
    } catch (err) {
      G.log('[meta] applying setting', key, 'failed:', err);
    }
  }

  var listening = false;

  /** Invalidates the session cache for writes that did not originate here (other tab, mirror pull, import). */
  function installStorageListener() {
    if (listening || typeof window.addEventListener !== 'function') return;
    listening = true;
    window.addEventListener('g:storage', function (ev) {
      var detail = ev && ev.detail;
      if (!detail || typeof detail.key !== 'string' || detail.source === 'local') return;
      mem.delete(detail.key);
      if (STATE_KEYS.indexOf(detail.key) >= 0) {
        loadKey(detail.key);
        if (detail.key === 'owned' || detail.key === 'equip' || detail.key === 'stats') validateEquip();
      }
      if (missionCache && detail.key === 'missions:' + missionCache.dateKey) missionCache = null;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cosmetics                                                            */
  /* ------------------------------------------------------------------ */

  /** @param {string} skinId @returns {boolean} owned (free skins always are). */
  function isOwned(skinId) {
    var skin = skinById(skinId);
    if (!skin) return false;
    return skin.price === 0 || state.owned.indexOf(skinId) >= 0;
  }

  /**
   * Adds a skin to the owned list and persists it. A skin the player is
   * currently trying for the session becomes their permanent equip, so an ad
   * unlock keeps showing what they were looking at on the next launch.
   * @param {string} skinId
   */
  function grantSkin(skinId) {
    if (state.owned.indexOf(skinId) < 0) {
      state.owned.push(skinId);
      kv.set('owned', state.owned.slice());
    }
    if (sessionSkin === skinId) {
      sessionSkin = null;
      state.equip.skin = skinId;
      kv.set('equip', Object.assign({}, state.equip));
    }
  }

  /** @param {string} themeId @returns {boolean} */
  function themeUnlocked(themeId) {
    var theme = themeById(themeId);
    return !!theme && state.stats.totalAltM >= theme.unlockAltM;
  }

  /* ------------------------------------------------------------------ */
  /* Streak                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Streak as seen from a given day: the stored count when the last Daily was
   * played that day or the day before, else 0 (broken).
   * @param {string} key
   * @returns {number}
   */
  function streakFor(key) {
    var last = state.streak.last;
    if (!last) return 0;
    // Date keys are fixed-width digit strings, so string order is calendar order.
    // A `last` newer than `key` (device clock behind, cloud mirror from another
    // device) still means the streak is alive.
    if (last >= key || last === shiftDateKey(key, -1)) return state.streak.count;
    return 0;
  }

  /**
   * Registers a Daily run on `key`: extends, keeps or restarts the streak. A key
   * older than the registered day (clock skew, mirrored state) never regresses it.
   * @param {string} key
   */
  function touchStreak(key) {
    var last = state.streak.last;
    if (last && last >= key) return;
    var count = last === shiftDateKey(key, -1) ? state.streak.count + 1 : 1;
    state.streak = { last: key, count: count };
    kv.set('streak', { last: key, count: count });
  }

  /** @param {string} key @returns {boolean} true when `key` is a 7th/14th/… streak day (double dust). */
  function isBonusDay(key) {
    return state.streak.last === key && state.streak.count > 0 && state.streak.count % STREAK_BONUS_EVERY === 0;
  }

  /* ------------------------------------------------------------------ */
  /* Missions                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Deterministically draws the day's mission ids without replacement.
   * PURE: same key → same ids.
   * @param {string} key 'YYYYMMDD'
   * @returns {number[]} MISSIONS_PER_DAY distinct ids
   */
  function rollMissions(key) {
    var rng = mulberry32((dailySeed(key) ^ MISSION_SALT) >>> 0);
    var pool = MISSIONS.map(function (m) { return m.id; });
    var ids = [];
    while (ids.length < MISSIONS_PER_DAY && pool.length) {
      var i = Math.floor(rng() * pool.length);
      ids.push(pool.splice(i, 1)[0]);
    }
    return ids;
  }

  /** @param {Object} def mission definition @returns {number} target, resolving dynamic ones. */
  function targetFor(def) {
    if (def.metric === 'beatBest') return Math.max(state.best + 1, BEAT_BEST_MIN);
    return def.target;
  }

  /**
   * Returns the mission record for a day, rolling and persisting it on first use.
   * Record: { ids:[3], targets:[3], progress:[3], claimed:[3 bool] }.
   * @param {string} key
   * @returns {Object}
   */
  function missionRecord(key) {
    if (missionCache && missionCache.dateKey === key) return missionCache.rec;
    var storeKey = 'missions:' + key;
    var raw = kv.get(storeKey, null);
    var ids = rollMissions(key);
    var rec = { ids: ids, targets: [], progress: [], claimed: [] };
    var valid = isObj(raw) && Array.isArray(raw.ids) && raw.ids.length === ids.length &&
      raw.ids.every(function (id, i) { return id === ids[i]; });
    for (var i = 0; i < ids.length; i++) {
      var def = missionById(ids[i]);
      var storedTarget = valid && Array.isArray(raw.targets) ? raw.targets[i] : undefined;
      rec.targets.push(isNum(storedTarget) && storedTarget > 0 ? storedTarget : targetFor(def));
      rec.progress.push(valid && Array.isArray(raw.progress) ? Math.max(0, num(raw.progress[i], 0)) : 0);
      rec.claimed.push(valid && Array.isArray(raw.claimed) ? raw.claimed[i] === true : false);
    }
    if (!valid || !Array.isArray(raw.targets)) kv.set(storeKey, rec);
    missionCache = { dateKey: key, rec: rec };
    return rec;
  }

  /** Persists the cached record for `key`. @param {string} key */
  function saveMissionRecord(key) {
    if (missionCache && missionCache.dateKey === key) kv.set('missions:' + key, missionCache.rec);
  }

  /**
   * Metric value of one finished (or in-progress) run for a mission definition.
   * @param {Object} def
   * @param {Object} s normalised run summary
   * @returns {number} contribution ('day' kinds) or value ('run' kinds)
   */
  function runMetric(def, s) {
    switch (def.metric) {
      case 'grazes': return s.grazes;
      case 'banked': return s.banked;
      case 'altM': return s.altM;
      case 'loops': return s.loops;
      case 'hotShots': return s.hotShots;
      case 'maxM': return s.maxM;
      case 'surviveS': return s.durationS;
      case 'beatBest': return s.score;
      case 'zeroGrazeAlt150': return s.altM >= ZERO_GRAZE_ALT_M && s.grazes === 0 ? 1 : 0;
      case 'runsAbove200': return s.altM >= RUNS_ABOVE_ALT_M ? 1 : 0;
      case 'bankRuns': return s.banked > 0 ? 1 : 0;
      case 'daily': return s.mode === 'daily' ? 1 : 0;
      default: return 0;
    }
  }

  /**
   * Applies a finished run to the day's missions.
   * @param {string} key
   * @param {Object} s normalised run summary
   * @returns {number[]} ids that became complete with this run
   */
  function applyRunToMissions(key, s) {
    var rec = missionRecord(key);
    var completed = [];
    for (var i = 0; i < rec.ids.length; i++) {
      var def = missionById(rec.ids[i]);
      var before = rec.progress[i];
      var value = runMetric(def, s);
      var after = def.kind === 'day' ? before + value : Math.max(before, value);
      rec.progress[i] = after;
      if (before < rec.targets[i] && after >= rec.targets[i]) completed.push(def.id);
    }
    saveMissionRecord(key);
    return completed;
  }

  /* ------------------------------------------------------------------ */
  /* Runs                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Normalises a run summary, filling gaps from the live tracker.
   * @param {Object} summary
   * @returns {Object}
   */
  function normaliseSummary(summary) {
    var src = isObj(summary) ? summary : {};
    var t = tracker || {};
    var mode = typeof src.mode === 'string' ? src.mode : (t.mode || 'free');
    var altM = nonNegInt(src.altM, 0);
    var banked = Math.max(nonNegInt(src.banked, 0), nonNegInt(t.banked, 0));
    var score = nonNegInt(src.score, altM + banked);
    var durationS = Math.max(0, num(src.durationS, isNum(t.startedAt) ? (Date.now() - t.startedAt) / 1000 : 0));
    return {
      mode: mode,
      score: score,
      altM: altM,
      banked: banked,
      grazes: Math.max(nonNegInt(src.grazes, 0), nonNegInt(t.grazes, 0)),
      loops: Math.max(nonNegInt(src.loops, 0), nonNegInt(t.loops, 0)),
      hotShots: Math.max(nonNegInt(src.hotShots, 0), nonNegInt(t.hotShots, 0)),
      maxM: Math.max(num(src.maxM, 1), num(t.maxM, 1), 1),
      durationS: durationS,
      usedRewind: src.usedRewind === true,
      duelWon: src.duelWon === true,
      seed: isNum(src.seed) ? src.seed >>> 0 : null,
      dateKey: parseDateKey(src.dateKey) ? src.dateKey : (parseDateKey(t.dateKey) ? t.dateKey : dateKey())
    };
  }

  /**
   * Dust earned by a run (before any doubling): floor(score/DIV) + PER_GRAZE*grazes + PER_LOOP*loops, capped.
   * @param {Object} s normalised summary
   * @returns {number}
   */
  function dustFor(s) {
    var d = dustConfig();
    var raw = Math.floor(s.score / d.DIV) + d.PER_GRAZE * s.grazes + d.PER_LOOP * s.loops;
    return Math.max(0, Math.min(d.CAP, raw));
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */

  var meta = {
    /** Trail skin definitions (frozen). */
    SKINS: SKINS,
    /** Sky theme definitions (frozen). */
    THEMES: THEMES,
    /** Mission table (frozen). */
    MISSIONS: MISSIONS,
    /** Rewarded views needed to unlock a skin permanently. */
    AD_TRY_VIEWS: AD_TRY_VIEWS,
    /** Live state object (read-only use; mutate through the API). */
    state: state,

    /**
     * Loads persisted state (best, dust, owned, equip, streak, stats, settings,
     * seenTutorial, name), validates it, pushes settings to G.audio / G.sdk and
     * starts listening for external storage changes. Idempotent: a second call
     * re-reads storage (and keeps the in-memory session state when storage is
     * absent or throwing).
     * @returns {Object} G.meta.state
     */
    init: function () {
      try {
        if (G.storage && typeof G.storage.init === 'function') G.storage.init();
      } catch (err) {
        G.log('[meta] storage.init failed:', err);
      }
      // The session cache is dropped only when storage can re-serve the values;
      // with no (or a throwing) backend it IS the player's progress for this session.
      if (!initialised || storageReadable()) mem.clear();
      STATE_KEYS.forEach(loadKey);
      validateEquip();
      sessionSkin = null;
      tracker = null;
      missionCache = null;
      Object.keys(state.settings).forEach(applySetting);
      installStorageListener();
      initialised = true;
      G.log('[meta] init: best', state.best, 'dust', state.dust, 'owned', state.owned.length);
      return state;
    },

    dateKey: dateKey,
    dailySeed: dailySeed,
    dailyNumber: dailyNumber,
    freeSeed: freeSeed,
    rankFor: rankFor,
    medalFor: medalFor,
    rollMissions: rollMissions,
    sanitizeName: sanitizeName,

    /**
     * Everything the Daily panel and title badge show.
     * @returns {{dateKey:string, number:number, seed:number, best:number, medal:(string|null),
     *            streak:number, yesterdayBest:number, msToReset:number}}
     */
    dailyInfo: function () {
      var now = Date.now();
      var key = dateKey(now);
      var best = nonNegInt(kv.get('bestDaily:' + key, 0), 0);
      return {
        dateKey: key,
        number: dailyNumber(key),
        seed: dailySeed(key),
        best: best,
        medal: medalFor(best),
        streak: streakFor(key),
        yesterdayBest: nonNegInt(kv.get('bestDaily:' + shiftDateKey(key, -1), 0), 0),
        msToReset: Math.max(0, keyToMs(key) + DAY_MS - now)
      };
    },

    /** @returns {{sound:boolean, music:boolean, haptics:boolean, reduceMotion:boolean, aimGuide:boolean}} live settings. */
    get settings() {
      return state.settings;
    },

    /**
     * Changes one setting, persists the settings object and forwards it to
     * G.audio (sound/music) or G.sdk.hapticsEnabled + the 'haptics' key (haptics).
     * @param {string} key one of the settings keys
     * @param {boolean} value
     * @returns {boolean} true when the key is known
     */
    setSetting: function (key, value) {
      if (!has(DEFAULT_SETTINGS, key)) return false;
      state.settings[key] = !!value;
      kv.set('settings', Object.assign({}, state.settings));
      applySetting(key);
      return true;
    },

    /**
     * Equips an owned skin permanently (clears any session try).
     * @param {string} skinId
     * @returns {boolean}
     */
    equip: function (skinId) {
      if (!isOwned(skinId)) return false;
      state.equip.skin = skinId;
      sessionSkin = null;
      kv.set('equip', Object.assign({}, state.equip));
      return true;
    },

    /**
     * Equips an unlocked theme.
     * @param {string} themeId
     * @returns {boolean}
     */
    equipTheme: function (themeId) {
      if (!themeUnlocked(themeId)) return false;
      state.equip.theme = themeId;
      kv.set('equip', Object.assign({}, state.equip));
      return true;
    },

    /** @returns {{skin:Object, theme:Object}} effective skin (session try wins) and theme definitions. */
    get equipped() {
      return {
        skin: (sessionSkin && skinById(sessionSkin)) || skinById(state.equip.skin) || SKINS[0],
        theme: themeById(state.equip.theme) || THEMES[0]
      };
    },

    /**
     * Equips a skin for this session only (rewarded "Try this skin"); an owned
     * skin is simply equipped.
     * @param {string} skinId
     * @returns {boolean} false for an unknown skin
     */
    sessionTry: function (skinId) {
      if (!skinById(skinId)) return false;
      if (isOwned(skinId)) return meta.equip(skinId);
      sessionSkin = skinId;
      return true;
    },

    /** @returns {string|null} id of the skin equipped only for this session. */
    get sessionSkin() {
      return sessionSkin;
    },

    isOwned: isOwned,

    /** @param {string} skinId @returns {boolean} purchasable right now. */
    canAfford: function (skinId) {
      var skin = skinById(skinId);
      return !!skin && !isOwned(skinId) && state.dust >= skin.price;
    },

    /**
     * Spends dust on a skin.
     * @param {string} skinId
     * @returns {boolean} false when unknown, already owned or unaffordable
     */
    buySkin: function (skinId) {
      if (!meta.canAfford(skinId)) return false;
      state.dust -= skinById(skinId).price;
      kv.set('dust', state.dust);
      grantSkin(skinId);
      return true;
    },

    /**
     * Records one rewarded "Try this skin" view; AD_TRY_VIEWS views unlock permanently.
     * @param {string} skinId
     * @returns {{views:number, unlocked:boolean}}
     */
    adTryView: function (skinId) {
      if (!skinById(skinId)) return { views: 0, unlocked: false };
      var key = 'adTry:' + skinId;
      var views = nonNegInt(kv.get(key, 0), 0);
      if (isOwned(skinId)) return { views: views, unlocked: true };
      views += 1;
      kv.set(key, views);
      if (views >= AD_TRY_VIEWS) grantSkin(skinId);
      return { views: views, unlocked: views >= AD_TRY_VIEWS };
    },

    themeUnlocked: themeUnlocked,

    /**
     * @param {string} themeId
     * @returns {{have:number, need:number, remaining:number}|null} null for an unknown theme
     */
    themeProgress: function (themeId) {
      var theme = themeById(themeId);
      if (!theme) return null;
      var have = state.stats.totalAltM;
      return { have: have, need: theme.unlockAltM, remaining: Math.max(0, theme.unlockAltM - have) };
    },

    /** @returns {string} display name: stored name, else sanitized G.sdk.user.name, else 'You'. */
    get name() {
      return state.name || defaultName();
    },

    /**
     * Stores a display name (sanitized to [A-Za-z0-9]{0,NAME_MAX}); empty clears it.
     * @param {*} str
     * @returns {string} the effective name afterwards
     */
    setName: function (str) {
      var clean = sanitizeName(str);
      state.name = clean;
      if (clean) kv.set('name', clean); else kv.remove('name');
      return meta.name;
    },

    /**
     * Starts tracking a run's per-run mission metrics and rolls today's missions
     * if they are not rolled yet.
     * @param {string} mode 'free' | 'daily' | 'duel'
     * @returns {Object} the tracker (mode, dateKey, grazes, loops, hotShots, banked, maxM, startedAt)
     */
    startRun: function (mode) {
      tracker = {
        mode: typeof mode === 'string' ? mode : 'free',
        dateKey: dateKey(),
        grazes: 0,
        loops: 0,
        hotShots: 0,
        banked: 0,
        maxM: 1,
        startedAt: Date.now()
      };
      // Roll today's missions now so dynamic targets snapshot the pre-run best.
      missionRecord(tracker.dateKey);
      return tracker;
    },

    /** @returns {Object|null} the active run tracker. */
    get run() {
      return tracker;
    },

    /**
     * Feeds a sim event into the active run tracker (GRAZE, LOOP, HOT_SHOT and
     * any event carrying a chain multiplier M). No-op without an active run.
     * @param {{type:string, M?:number, bankedTotal?:number}} evt
     */
    onEvent: function (evt) {
      if (!tracker || !evt || typeof evt.type !== 'string') return;
      switch (evt.type) {
        case 'GRAZE': tracker.grazes += 1; break;
        case 'LOOP':
          tracker.loops += 1;
          if (isNum(evt.bankedTotal)) tracker.banked = Math.max(tracker.banked, evt.bankedTotal);
          break;
        case 'HOT_SHOT': tracker.hotShots += 1; break;
        default: break;
      }
      if (isNum(evt.M) && evt.M > tracker.maxM) tracker.maxM = evt.M;
    },

    /**
     * Books a finished run: dust (capped, x2 on 7th streak days), best + rank,
     * daily best + medal, lifetime stats, missions, streak (daily mode only).
     * @param {{mode:string, score:number, altM:number, banked:number, grazes:number, loops:number,
     *          hotShots:number, maxM:number, durationS:number, usedRewind:boolean, duelWon:boolean,
     *          seed:number, dateKey?:string}} summary
     * @returns {{dustEarned:number, dustGained:number, dustDoubled:boolean, dust:number, newBest:boolean,
     *            best:number, rank:Object, prevRank:Object, dailyBest:number, dailyMedal:(string|null),
     *            dailyMedalNew:boolean, missionsCompletedNow:number[], streak:number}}
     */
    onRunEnd: function (summary) {
      var s = normaliseSummary(summary);
      var key = s.dateKey;
      // Roll (and snapshot "beat your best") BEFORE this run can move state.best.
      missionRecord(key);

      if (s.mode === 'daily') touchStreak(key);
      var doubled = isBonusDay(key);
      var dustEarned = dustFor(s);
      var dustGained = doubled ? dustEarned * 2 : dustEarned;
      state.dust += dustGained;
      kv.set('dust', state.dust);

      var prevBest = state.best;
      var newBest = s.score > prevBest;
      if (newBest) {
        state.best = s.score;
        kv.set('best', state.best);
      }

      var dailyBest = 0;
      var dailyMedal = null;
      var dailyMedalNew = false;
      if (s.mode === 'daily') {
        var dailyKey = 'bestDaily:' + key;
        var prevDaily = nonNegInt(kv.get(dailyKey, 0), 0);
        dailyBest = Math.max(prevDaily, s.score);
        if (dailyBest > prevDaily) kv.set(dailyKey, dailyBest);
        dailyMedal = medalFor(dailyBest);
        dailyMedalNew = medalRank(dailyMedal) > medalRank(medalFor(prevDaily));
      }

      state.stats.runs += 1;
      state.stats.totalAltM += s.altM;
      state.stats.loops += s.loops;
      state.stats.grazes += s.grazes;
      state.stats.hotShots += s.hotShots;
      if (s.duelWon) state.stats.duelsWon += 1;
      kv.set('stats', Object.assign({}, state.stats));

      var completed = applyRunToMissions(key, s);
      tracker = null;

      return {
        dustEarned: dustEarned,
        dustGained: dustGained,
        dustDoubled: doubled,
        dust: state.dust,
        newBest: newBest,
        best: state.best,
        rank: rankFor(state.best),
        prevRank: rankFor(prevBest),
        dailyBest: dailyBest,
        dailyMedal: dailyMedal,
        dailyMedalNew: dailyMedalNew,
        missionsCompletedNow: completed,
        streak: streakFor(key)
      };
    },

    /**
     * Grants the run's dust a second time after the Double Dust rewarded ad.
     * @param {number} dustEarned the (capped) value reported by onRunEnd
     * @returns {number} new dust balance
     */
    doubleDust: function (dustEarned) {
      var add = Math.min(dustConfig().CAP, nonNegInt(dustEarned, 0));
      if (add > 0) {
        state.dust += add;
        kv.set('dust', state.dust);
      }
      return state.dust;
    },

    /**
     * Today's three missions. While a run is active, 'run' missions show the
     * larger of the stored progress and the live run value.
     * @returns {Array<{id:number, key:string, target:number, progress:number, claimed:boolean, reward:number, done:boolean, kind:string}>}
     */
    missionsToday: function () {
      var key = dateKey();
      var rec = missionRecord(key);
      // Altitude/score are unknown until the run ends; duration comes from the tracker clock.
      var live = tracker ? normaliseSummary({ mode: tracker.mode, altM: 0, score: 0, dateKey: key }) : null;
      return rec.ids.map(function (id, i) {
        var def = missionById(id);
        var progress = rec.progress[i];
        if (live && def.kind === 'run') progress = Math.max(progress, runMetric(def, live));
        var target = rec.targets[i];
        return {
          id: id,
          key: def.key,
          kind: def.kind,
          target: target,
          progress: Math.min(progress, target),
          claimed: rec.claimed[i],
          reward: def.reward,
          done: rec.progress[i] >= target
        };
      });
    },

    /**
     * Pays out a completed, unclaimed mission.
     * @param {number} id
     * @returns {number} dust gained, 0 when not claimable
     */
    claimMission: function (id) {
      var key = dateKey();
      var rec = missionRecord(key);
      var i = rec.ids.indexOf(id);
      if (i < 0 || rec.claimed[i] || rec.progress[i] < rec.targets[i]) return 0;
      rec.claimed[i] = true;
      saveMissionRecord(key);
      var reward = missionById(id).reward;
      state.dust += reward;
      kv.set('dust', state.dust);
      return reward;
    },

    /** @returns {number} completed missions awaiting a claim today. */
    unclaimedCount: function () {
      return meta.missionsToday().filter(function (m) { return m.done && !m.claimed; }).length;
    },

    /** Marks the first-run tutorial as seen (persisted). */
    markTutorialSeen: function () {
      state.seenTutorial = true;
      kv.set('seenTutorial', true);
    },

    /** @returns {boolean} */
    get tutorialSeen() {
      return state.seenTutorial;
    },

    /** @returns {number} current dust. */
    dustBalance: function () {
      return state.dust;
    },

    /** @returns {boolean} true once init() ran. */
    get initialised() {
      return initialised;
    }
  };

  G.meta = meta;
})();
