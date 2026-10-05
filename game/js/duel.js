/*!
 * G.duel — backend-free duel links: payload codec, hop recorder, ghost geometry.
 *
 * A finished run is turned into a short string that travels in location.hash
 * (web) or in Telegram's startapp parameter. The receiver regenerates the same
 * cosmos from the seed, draws the challenger's death altitude as an exact line
 * and, when the payload carries a path, a faint approximate ghost of the
 * challenger's hops. Nothing here validates scores; the ghost is cosmetic.
 *
 * Payload (all fields ASCII, '_' separated, the path is always LAST because
 * base64url contains '-' and '_'):
 *   'd' + seed36 + '_' + score + '_' + altM + '_' + name [ + '_' + pathB64url ]
 *   seed36  seed in base36 (uint32)         score/altM  decimal non-negative ints
 *   name    [A-Za-z0-9]{1..NAME_MAX}, default 'You'
 *   path    base64url (no padding) of 5-byte hop records, omitted when the whole
 *           payload would exceed CONFIG.SHARE.PAYLOAD_MAX characters.
 *
 * Hop record (5 bytes, one per latch→release):
 *   [0] planet ordinal delta  u8   zigzag(delta of ordinalOf(planetId) from the
 *                                  previous hop; first hop: from ordinal 0 =
 *                                  planet 0). 0 = same planet re-latched, 1 = −1,
 *                                  2 = +1, 3 = −2, … range −128..+127. The delta
 *                                  is SIGNED because the generator appends
 *                                  satellites after the main chain, so a
 *                                  satellite → next-main latch moves backwards
 *                                  in id order; real deltas stay within ±32.
 *   [1] latch angle           u8   theta quantised to 2π/256
 *   [2] latch radius 7 bits        r / 2.5 px, 0..127 (≤ 317.5 px)
 *       | 0x80                     'rewound here' flag
 *   [3] release angle         u8   theta quantised to 2π/256
 *   [4] heat 7 bits                heat at release, 0..127 ↔ 0..1
 *       | 0x80                     orbit direction s = +1 (clear bit: s = −1)
 *
 * Planet ordinals: planet ids are k*1000 + idx (idx < 32 per chunk), so
 * ordinalOf(id) = k*32 + idx keeps consecutive deltas small across chunks.
 * A flight cannot cross a whole 2000 px chunk, so |delta| ≤ 32 < 128.
 *
 * PURE: everything except readFromLocation() / buildLinks() / shareText() is
 * deterministic and touches no DOM, clock or randomness. Those three read
 * window.location, G.CONFIG.SHARE, G.sdk and G.i18n defensively (all optional).
 *
 * Public API (JSDoc on each member below):
 *   G.duel.ordinalOf(id) / idFromOrdinal(ord)
 *   G.duel.createRecorder(opts?) → { onLatch, onRelease, markRewound, hops, toBytes, toBase64Url }
 *   G.duel.encode({seed, score, altM, name, path}) → string
 *   G.duel.decode(payload) → DecodedDuel | null
 *   G.duel.base64urlEncode(bytes) / base64urlDecode(str)
 *   G.duel.readFromLocation() → {kind:'duel', decoded} | {kind:'daily', dateKey} | null
 *   G.duel.buildLinks(payload) → { web, telegram, best }
 *   G.duel.shareText({name, score, mode, dailyNumber, seed, url?, payload?}) → string
 *   G.duel.expandPath(decoded, lookupPlanet) → [{type:'arc',…}, {type:'curve',…}, …]
 *   G.duel.MAX_HOPS, G.duel.RECORD_BYTES
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

  var TWO_PI = Math.PI * 2;

  /** Bytes per hop record. */
  var RECORD_BYTES = 5;
  /** Longest path the recorder serialises (design: 300 hops = 1500 bytes). */
  var MAX_HOPS = 300;
  /** Planets per chunk slot in the ordinal space (generator emits < 32 per chunk). */
  var ORDINALS_PER_CHUNK = 32;
  /** Planet ids are k*1000 + idx. */
  var IDS_PER_CHUNK = 1000;
  /** Signed ordinal delta range representable by the zigzag byte. */
  var DELTA_MIN = -128;
  var DELTA_MAX = 127;
  /** Latch radius quantisation step (px). */
  var RADIUS_STEP = 2.5;
  /** Hard ceilings for tolerant numeric parsing. */
  var MAX_SCORE = 1e9;
  var MAX_ALT_M = 1e9;
  var MAX_SEED = 0xFFFFFFFF;
  /** Anything longer than this is not a payload we produced; refuse early. */
  var MAX_INPUT_CHARS = 8192;

  /** Defaults used when G.CONFIG (built by the sim agent) is absent, e.g. in unit tests. */
  var SHARE_DEFAULTS = { APP_URL: '', TELEGRAM_APP: '', PAYLOAD_MAX: 1500, NAME_MAX: 12 };
  var PHYSICS_DEFAULTS = { V_ORBIT: 420, GRAVITY: 520, HOT_BOOST: 0.5, COMET_R: 9, COL_W: 540, WALL_RESTITUTION: 0.85 };

  /** Title orbit the run starts in (design core_loop START); used when the first release has no latch. */
  var START_LATCH = { planetId: 0, theta: -Math.PI / 2, r: 120, s: 1 };

  /** Ghost flight integration: sim rate, emitted sample rate, max flight time. */
  var GHOST_DT = 1 / 120;
  var GHOST_SAMPLE_EVERY = 4;
  var GHOST_MAX_S = 1.5;

  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64_LOOKUP = (function () {
    var table = {};
    for (var i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charAt(i)] = i;
    return table;
  }());

  var SEED36_RE = /^[0-9a-z]{1,7}$/;
  var DIGITS_RE = /^[0-9]{1,15}$/;
  var NAME_STRIP_RE = /[^A-Za-z0-9]/g;
  var DATE_KEY_RE = /^(\d{4})(\d{2})(\d{2})$/;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /** Current share config merged over defaults. */
  function shareConfig() {
    var cfg = (G.CONFIG && G.CONFIG.SHARE) || {};
    return {
      APP_URL: typeof cfg.APP_URL === 'string' ? cfg.APP_URL : SHARE_DEFAULTS.APP_URL,
      TELEGRAM_APP: typeof cfg.TELEGRAM_APP === 'string' ? cfg.TELEGRAM_APP : SHARE_DEFAULTS.TELEGRAM_APP,
      PAYLOAD_MAX: isFiniteNumber(cfg.PAYLOAD_MAX) ? cfg.PAYLOAD_MAX : SHARE_DEFAULTS.PAYLOAD_MAX,
      NAME_MAX: isFiniteNumber(cfg.NAME_MAX) ? cfg.NAME_MAX : SHARE_DEFAULTS.NAME_MAX
    };
  }

  /** Physics constants the ghost shares with the sim (from G.CONFIG when present). */
  function physics() {
    var cfg = G.CONFIG || {};
    var out = {};
    Object.keys(PHYSICS_DEFAULTS).forEach(function (key) {
      out[key] = isFiniteNumber(cfg[key]) ? cfg[key] : PHYSICS_DEFAULTS[key];
    });
    return out;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** Non-negative integer from anything numeric-ish; NaN → 0. */
  function toNonNegInt(v, max) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return clamp(Math.floor(n), 0, max);
  }

  /** Normalises an angle into [0, 2π). */
  function normAngle(theta) {
    var a = Number(theta);
    if (!isFinite(a)) return 0;
    a = a % TWO_PI;
    return a < 0 ? a + TWO_PI : a;
  }

  /** Angle → byte (2π/256 steps). */
  function quantAngle(theta) {
    return Math.round(normAngle(theta) / TWO_PI * 256) & 255;
  }

  /** Byte → angle in radians, [0, 2π). */
  function dequantAngle(byte) {
    return (byte & 255) / 256 * TWO_PI;
  }

  /** Signed delta (−128..127) → zigzag byte (0, 1, 2, 3, … = 0, −1, +1, −2, …). */
  function zigzag(delta) {
    var d = clamp(Math.round(Number(delta) || 0), DELTA_MIN, DELTA_MAX);
    return d >= 0 ? d * 2 : -d * 2 - 1;
  }

  /** Zigzag byte → signed delta. */
  function unzigzag(byte) {
    var b = byte & 255;
    return (b & 1) ? -((b + 1) >>> 1) : b >>> 1;
  }

  /**
   * Strips a display name to [A-Za-z0-9], capped at NAME_MAX; empty → 'You'.
   * @param {*} name
   * @returns {string}
   */
  function sanitizeName(name) {
    var max = shareConfig().NAME_MAX;
    var clean = String(name == null ? '' : name).replace(NAME_STRIP_RE, '').slice(0, max);
    return clean || 'You';
  }

  // ---------------------------------------------------------------------------
  // Ordinals
  // ---------------------------------------------------------------------------

  /**
   * Chunk-local ordinal of a planet id: k*32 + idx for id = k*1000 + idx.
   * @param {number} id planet id from the generator
   * @returns {number}
   */
  function ordinalOf(id) {
    var n = toNonNegInt(id, Number.MAX_SAFE_INTEGER);
    var k = Math.floor(n / IDS_PER_CHUNK);
    var idx = n - k * IDS_PER_CHUNK;
    return k * ORDINALS_PER_CHUNK + Math.min(idx, ORDINALS_PER_CHUNK - 1);
  }

  /**
   * Inverse of ordinalOf.
   * @param {number} ord
   * @returns {number} planet id
   */
  function idFromOrdinal(ord) {
    var n = toNonNegInt(ord, Number.MAX_SAFE_INTEGER);
    var k = Math.floor(n / ORDINALS_PER_CHUNK);
    return k * IDS_PER_CHUNK + (n - k * ORDINALS_PER_CHUNK);
  }

  // ---------------------------------------------------------------------------
  // base64url
  // ---------------------------------------------------------------------------

  /**
   * Encodes bytes as base64url without padding ('-' and '_' alphabet).
   * @param {Uint8Array|number[]} bytes
   * @returns {string}
   */
  function base64urlEncode(bytes) {
    var src = bytes || [];
    var out = '';
    var i;
    for (i = 0; i + 2 < src.length; i += 3) {
      var n = ((src[i] & 255) << 16) | ((src[i + 1] & 255) << 8) | (src[i + 2] & 255);
      out += B64_ALPHABET.charAt(n >>> 18) + B64_ALPHABET.charAt((n >>> 12) & 63) +
        B64_ALPHABET.charAt((n >>> 6) & 63) + B64_ALPHABET.charAt(n & 63);
    }
    var rest = src.length - i;
    if (rest === 1) {
      var a = src[i] & 255;
      out += B64_ALPHABET.charAt(a >>> 2) + B64_ALPHABET.charAt((a << 4) & 63);
    } else if (rest === 2) {
      var b = ((src[i] & 255) << 8) | (src[i + 1] & 255);
      out += B64_ALPHABET.charAt(b >>> 10) + B64_ALPHABET.charAt((b >>> 4) & 63) + B64_ALPHABET.charAt((b << 2) & 63);
    }
    return out;
  }

  /**
   * Decodes base64url (padding optional, standard '+' '/' also accepted).
   * @param {string} str
   * @returns {Uint8Array|null} null when the string is not valid base64url
   */
  function base64urlDecode(str) {
    if (typeof str !== 'string') return null;
    var s = str.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (s.length % 4 === 1) return null;
    var outLen = Math.floor(s.length * 3 / 4);
    var out = new Uint8Array(outLen);
    var o = 0;
    var i;
    for (i = 0; i + 3 < s.length; i += 4) {
      var q0 = B64_LOOKUP[s.charAt(i)], q1 = B64_LOOKUP[s.charAt(i + 1)];
      var q2 = B64_LOOKUP[s.charAt(i + 2)], q3 = B64_LOOKUP[s.charAt(i + 3)];
      if (q0 === undefined || q1 === undefined || q2 === undefined || q3 === undefined) return null;
      var n = (q0 << 18) | (q1 << 12) | (q2 << 6) | q3;
      out[o++] = (n >>> 16) & 255;
      out[o++] = (n >>> 8) & 255;
      out[o++] = n & 255;
    }
    var rest = s.length - i;
    if (rest === 2) {
      var a0 = B64_LOOKUP[s.charAt(i)], a1 = B64_LOOKUP[s.charAt(i + 1)];
      if (a0 === undefined || a1 === undefined) return null;
      out[o++] = ((a0 << 2) | (a1 >>> 4)) & 255;
    } else if (rest === 3) {
      var b0 = B64_LOOKUP[s.charAt(i)], b1 = B64_LOOKUP[s.charAt(i + 1)], b2 = B64_LOOKUP[s.charAt(i + 2)];
      if (b0 === undefined || b1 === undefined || b2 === undefined) return null;
      out[o++] = ((b0 << 2) | (b1 >>> 4)) & 255;
      out[o++] = ((b1 << 4) | (b2 >>> 2)) & 255;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Hop records
  // ---------------------------------------------------------------------------

  /**
   * Serialises one hop into 5 bytes at `offset`.
   * @param {Uint8Array} out
   * @param {number} offset
   * @param {{dPlanet:number, latchTheta:number, r:number, rewound:boolean, releaseTheta:number, heat:number, s:number}} hop
   */
  function writeRecord(out, offset, hop) {
    var radiusQ = clamp(Math.round(hop.r / RADIUS_STEP), 0, 127);
    var heatQ = clamp(Math.round(hop.heat * 127), 0, 127);
    out[offset] = zigzag(hop.dPlanet);
    out[offset + 1] = quantAngle(hop.latchTheta);
    out[offset + 2] = radiusQ | (hop.rewound ? 0x80 : 0);
    out[offset + 3] = quantAngle(hop.releaseTheta);
    out[offset + 4] = heatQ | (hop.s > 0 ? 0x80 : 0);
  }

  /**
   * Parses whole 5-byte records; a trailing partial record is ignored.
   * @param {Uint8Array} bytes
   * @returns {Array<{dPlanet:number, latchAngle:number, r:number, rewound:boolean, releaseAngle:number, heat:number, s:number}>}
   */
  function parseRecords(bytes) {
    var hops = [];
    var count = Math.min(MAX_HOPS, Math.floor(bytes.length / RECORD_BYTES));
    for (var i = 0; i < count; i++) {
      var o = i * RECORD_BYTES;
      hops.push({
        dPlanet: unzigzag(bytes[o]),
        latchAngle: dequantAngle(bytes[o + 1]),
        r: (bytes[o + 2] & 0x7F) * RADIUS_STEP,
        rewound: (bytes[o + 2] & 0x80) !== 0,
        releaseAngle: dequantAngle(bytes[o + 3]),
        heat: (bytes[o + 4] & 0x7F) / 127,
        s: (bytes[o + 4] & 0x80) ? 1 : -1
      });
    }
    return hops;
  }

  /**
   * Creates a recorder that main.js feeds with LATCH / RELEASE events and the
   * rewind flow. Hops are closed on release; a hop still pending at death is
   * not serialised (its release angle is unknown; the death line is exact anyway).
   *
   * @param {{start?: {planetId:number, theta:number, r:number, s:number}}} [opts]
   *   `start` describes the orbit the run begins in, used when the first release
   *   arrives without a preceding latch (the title orbit never emits LATCH).
   *   Defaults to the design's start orbit: planet 0, r 120, θ −π/2, s +1.
   * @returns {{
   *   onLatch: function({planetId:number, theta:number, r:number, s:number}):void,
   *   onRelease: function({theta:number, heat:number}):void,
   *   markRewound: function():void,
   *   hops: number,
   *   toBytes: function():Uint8Array,
   *   toBase64Url: function():string
   * }}
   */
  function createRecorder(opts) {
    var start = (opts && opts.start) || START_LATCH;
    var completed = [];
    var pending = null;
    var lastLatch = null;
    var prevOrdinal = 0;

    function open(latch, rewound) {
      var ordinal = ordinalOf(latch.planetId);
      pending = {
        dPlanet: clamp(ordinal - prevOrdinal, DELTA_MIN, DELTA_MAX),
        ordinal: ordinal,
        latchTheta: Number(latch.theta) || 0,
        r: isFiniteNumber(latch.r) ? latch.r : 0,
        s: latch.s < 0 ? -1 : 1,
        rewound: !!rewound,
        releaseTheta: 0,
        heat: 0
      };
      lastLatch = { planetId: latch.planetId, theta: pending.latchTheta, r: pending.r, s: pending.s };
    }

    var recorder = {
      /**
       * A tether was attached.
       * @param {{planetId:number, theta:number, r:number, s:number}} latch
       */
      onLatch: function (latch) {
        if (!latch) return;
        open(latch, false);
      },
      /**
       * The tether was released (or snapped). Closes the pending hop; when no
       * latch preceded it, records the hop against the last known latch or `start`.
       * @param {{theta:number, heat:number}} release
       */
      onRelease: function (release) {
        if (!release) return;
        if (!pending) open(lastLatch || start, false);
        pending.releaseTheta = Number(release.theta) || 0;
        pending.heat = clamp(Number(release.heat) || 0, 0, 1);
        if (completed.length < MAX_HOPS) {
          completed.push(pending);
          prevOrdinal = pending.ordinal;
        }
        pending = null;
      },
      /**
       * The player used REWIND: the next release happens from the last latch
       * again. Flags the pending hop, or re-opens the last latch, as 'rewound'.
       */
      markRewound: function () {
        if (pending) {
          pending.rewound = true;
          return;
        }
        open(lastLatch || start, true);
      },
      /** Serialised hop records (pending hop excluded). */
      toBytes: function () {
        var out = new Uint8Array(completed.length * RECORD_BYTES);
        for (var i = 0; i < completed.length; i++) writeRecord(out, i * RECORD_BYTES, completed[i]);
        return out;
      },
      /** toBytes() as base64url. */
      toBase64Url: function () {
        return base64urlEncode(recorder.toBytes());
      }
    };
    Object.defineProperty(recorder, 'hops', {
      enumerable: true,
      /** Number of completed hops. */
      get: function () { return completed.length; }
    });
    return recorder;
  }

  // ---------------------------------------------------------------------------
  // Payload codec
  // ---------------------------------------------------------------------------

  /**
   * Builds a duel payload. The path is dropped when the whole payload would
   * exceed CONFIG.SHARE.PAYLOAD_MAX characters (the death line still works).
   * @param {{seed:number, score:number, altM:number, name?:string, path?:Uint8Array|null}} run
   * @returns {string}
   */
  function encode(run) {
    var src = run || {};
    var seed = toNonNegInt(src.seed, MAX_SEED);
    var head = 'd' + seed.toString(36) + '_' + toNonNegInt(src.score, MAX_SCORE) + '_' +
      toNonNegInt(src.altM, MAX_ALT_M) + '_' + sanitizeName(src.name);
    var path = src.path;
    if (path && path.length >= RECORD_BYTES) {
      var usable = path.subarray ? path.subarray(0, MAX_HOPS * RECORD_BYTES) : Array.prototype.slice.call(path, 0, MAX_HOPS * RECORD_BYTES);
      var withPath = head + '_' + base64urlEncode(usable);
      if (withPath.length <= shareConfig().PAYLOAD_MAX) return withPath;
      G.log('[duel] path dropped: payload would be', withPath.length, 'chars');
    }
    return head;
  }

  /**
   * Parses a payload produced by encode(). Tolerant: numerics are clamped, the
   * name is re-sanitised, an undecodable path yields hasPath=false; structural
   * garbage (wrong prefix, non-base36 seed, non-numeric score, overlong input)
   * yields null.
   * @param {string} payload
   * @returns {null|{seed:number, score:number, altM:number, name:string, hasPath:boolean,
   *   path:Array<{dPlanet:number, latchAngle:number, r:number, rewound:boolean, releaseAngle:number, heat:number, s:number}>}}
   */
  function decode(payload) {
    if (typeof payload !== 'string') return null;
    var str = payload.trim();
    if (str.length < 2 || str.length > MAX_INPUT_CHARS) return null;
    if (str.charAt(0) === '#') str = str.slice(1);
    if (str.charAt(0) !== 'd') return null;

    var parts = str.slice(1).split('_');
    if (parts.length < 4) return null;
    var seed36 = parts[0].toLowerCase();
    var scoreStr = parts[1];
    var altStr = parts[2];
    var nameStr = parts[3];
    var pathStr = parts.length > 4 ? parts.slice(4).join('_') : '';

    if (!SEED36_RE.test(seed36) || !DIGITS_RE.test(scoreStr) || !DIGITS_RE.test(altStr)) return null;
    var seed = parseInt(seed36, 36);
    if (!isFinite(seed) || seed > MAX_SEED) return null;

    var hops = [];
    if (pathStr) {
      var bytes = base64urlDecode(pathStr);
      if (bytes) hops = parseRecords(bytes);
      else G.log('[duel] path ignored: not base64url');
    }
    return {
      seed: seed,
      score: toNonNegInt(scoreStr, MAX_SCORE),
      altM: toNonNegInt(altStr, MAX_ALT_M),
      name: sanitizeName(nameStr),
      path: hops,
      hasPath: hops.length > 0
    };
  }

  // ---------------------------------------------------------------------------
  // Launch parameters
  // ---------------------------------------------------------------------------

  /**
   * Validates a 'YYYYMMDD' daily key (calendar-plausible, not a real-date check).
   * @param {*} value
   * @returns {string|null}
   */
  function dateKeyOf(value) {
    var m = DATE_KEY_RE.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    var month = Number(m[2]), day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return m[0];
  }

  /** Interprets one raw launch value as a duel payload or a daily key. */
  function classify(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    var value = raw;
    try { value = decodeURIComponent(raw); } catch (err) { value = raw; }
    var dateKey = dateKeyOf(value);
    if (dateKey) return { kind: 'daily', dateKey: dateKey };
    var decoded = decode(value);
    return decoded ? { kind: 'duel', decoded: decoded } : null;
  }

  function safeCall(fn, ctx, args) {
    try { return fn.apply(ctx, args); } catch (err) { return null; }
  }

  /** location.search parameter or null, never throws. */
  function queryParam(name) {
    try {
      return new URLSearchParams(window.location.search || '').get(name);
    } catch (err) {
      return null;
    }
  }

  /**
   * Telegram's raw start_param: initDataUnsafe first, then the tgWebAppStartParam
   * key, which Telegram clients put in the hash fragment (some in the query string).
   */
  function telegramStartParam() {
    var raw = null;
    try {
      var tg = (G.sdk && G.sdk.tg) || (window.Telegram && window.Telegram.WebApp) || null;
      var unsafe = tg && tg.initDataUnsafe;
      if (unsafe && typeof unsafe.start_param === 'string') raw = unsafe.start_param;
    } catch (err) { raw = null; }
    if (!raw) {
      try {
        raw = new URLSearchParams((window.location.hash || '').replace(/^#/, '')).get('tgWebAppStartParam');
      } catch (err) { raw = null; }
    }
    if (!raw) raw = queryParam('tgWebAppStartParam');
    return raw || null;
  }

  /**
   * Finds a duel payload or daily key in the launch context, in this order:
   * location.hash '#d…', query ?d=YYYYMMDD (or ?d=payload), G.sdk.getParam('d'),
   * G.sdk.getParam('startapp'), the raw Telegram start_param (initDataUnsafe or
   * tgWebAppStartParam in the hash / query; whole value = payload, or 'k1-v1'
   * style with key 'd' / 'startapp').
   * @returns {{kind:'duel', decoded:object}|{kind:'daily', dateKey:string}|null}
   */
  function readFromLocation() {
    var result = null;
    var hash = '';
    try { hash = String(window.location.hash || ''); } catch (err) { hash = ''; }
    if (hash.length > 1) result = classify(hash.slice(1));
    if (result) return result;

    result = classify(queryParam('d'));
    if (result) return result;

    if (G.sdk && typeof G.sdk.getParam === 'function') {
      result = classify(safeCall(G.sdk.getParam, G.sdk, ['d'])) || classify(safeCall(G.sdk.getParam, G.sdk, ['startapp']));
      if (result) return result;
    }

    var raw = telegramStartParam();
    if (!raw) return null;
    result = classify(raw);
    if (result) return result;
    var kv = {};
    raw.split('_').forEach(function (part) {
      var idx = part.indexOf('-');
      if (idx > 0) kv[part.slice(0, idx)] = part.slice(idx + 1);
    });
    return classify(kv.d) || classify(kv.startapp);
  }

  /**
   * Links that carry a payload.
   * @param {string} payload
   * @returns {{web:string, telegram:string|null, best:string}}
   */
  function buildLinks(payload) {
    var cfg = shareConfig();
    var p = String(payload == null ? '' : payload);
    var base = cfg.APP_URL;
    if (!base) {
      try { base = String(window.location.href || '').split('#')[0]; } catch (err) { base = ''; }
    }
    var web = base + '#' + p;
    var telegram = cfg.TELEGRAM_APP ? 'https://t.me/' + cfg.TELEGRAM_APP + '?startapp=' + p : null;
    return { web: web, telegram: telegram, best: telegram || web };
  }

  /** i18n lookup with English fallback when G.i18n (or the key) is missing. */
  function tr(key, vars, fallback) {
    var i18n = G.i18n;
    if (i18n && typeof i18n.t === 'function' && (typeof i18n.has !== 'function' || i18n.has(key))) {
      var text = safeCall(i18n.t, i18n, [key, vars]);
      if (typeof text === 'string' && text !== key) return text;
    }
    return fallback.replace(/\{(\w+)\}/g, function (m, name) {
      return vars && vars[name] != null ? String(vars[name]) : m;
    });
  }

  /** Locale-grouped integer when G.i18n.fmtNumber exists. */
  function fmtNumber(n) {
    var i18n = G.i18n;
    if (i18n && typeof i18n.fmtNumber === 'function') {
      var text = safeCall(i18n.fmtNumber, i18n, [n]);
      if (typeof text === 'string' && text) return text;
    }
    return String(n);
  }

  /**
   * Share message for a run: "<name> · Tetherloop · Daily #N\n<shareText with
   * score and url resolved>". Uses G.i18n keys shareText / dailyNumber / cosmos
   * when present, English otherwise.
   * @param {{name?:string, score?:number, mode?:'free'|'daily'|'duel', dailyNumber?:number,
   *   seed?:number, url?:string, payload?:string}} opts
   *   `url` is used verbatim; without it, `payload` is turned into buildLinks().best;
   *   without either the APP_URL is used.
   * @returns {string}
   */
  function shareText(opts) {
    var o = opts || {};
    var score = fmtNumber(toNonNegInt(o.score, MAX_SCORE));
    var url = typeof o.url === 'string' && o.url ? o.url : (o.payload ? buildLinks(o.payload).best : buildLinks('').web.replace(/#$/, ''));
    var seed36 = toNonNegInt(o.seed, MAX_SEED).toString(36);
    var label = o.mode === 'daily'
      ? tr('dailyNumber', { n: toNonNegInt(o.dailyNumber, MAX_SCORE) }, 'Daily #{n}')
      : tr('cosmos', { seed: seed36 }, 'Cosmos {seed}');
    var body = tr('shareText', { score: score, url: url }, 'I scored {score} — can you beat me? {url}');
    return sanitizeName(o.name) + ' · ' + (G.NAME || 'Tetherloop') + ' · ' + label + '\n' + body;
  }

  // ---------------------------------------------------------------------------
  // Ghost geometry
  // ---------------------------------------------------------------------------

  /** Sweep end angle so the arc runs from `from` to `to` in direction s. */
  function arcEnd(from, to, s) {
    var delta = normAngle(to - from);
    if (s > 0) return from + delta;
    return from - (delta === 0 ? 0 : TWO_PI - delta);
  }

  /**
   * True when hop `next` is the rewind re-open of hop `prev`'s own latch: the
   * player died during prev's flight, REWIND put the comet back on the same
   * tether, and the recorder re-opened that latch flagged 'rewound'. prev's
   * flight therefore did not lead to next's latch point and must not be joined
   * to it. (A rewind after dying while tethered flags the hop itself instead;
   * that hop's own latch WAS reached by the previous flight.)
   */
  function isRewindOfSameLatch(prev, next) {
    return !!next && next.rewound && next.planetId === prev.planetId &&
      next.r === prev.r && next.s === prev.s && next.from === prev.from;
  }

  /** Integrates one ghost flight; returns sample points (world coords). */
  function flight(x0, y0, vx, vy, phys, nextLatch) {
    var pts = [[x0, y0]];
    var x = x0, y = y0;
    var minX = phys.COMET_R, maxX = phys.COL_W - phys.COMET_R;
    var steps = Math.round(GHOST_MAX_S / GHOST_DT);
    var bestIdx = 0;
    var bestD = nextLatch ? Math.hypot(nextLatch[0] - x0, nextLatch[1] - y0) : Infinity;
    for (var i = 1; i <= steps; i++) {
      vy -= phys.GRAVITY * GHOST_DT;
      x += vx * GHOST_DT;
      y += vy * GHOST_DT;
      if (x < minX) { x = minX + (minX - x); vx = -vx * phys.WALL_RESTITUTION; }
      else if (x > maxX) { x = maxX - (x - maxX); vx = -vx * phys.WALL_RESTITUTION; }
      if (i % GHOST_SAMPLE_EVERY === 0) {
        pts.push([x, y]);
        if (nextLatch) {
          var d = Math.hypot(nextLatch[0] - x, nextLatch[1] - y);
          if (d < bestD) { bestD = d; bestIdx = pts.length - 1; }
        }
      }
    }
    if (nextLatch) {
      pts.length = Math.max(1, bestIdx + 1);
      pts.push([nextLatch[0], nextLatch[1]]);
    }
    return pts;
  }

  /**
   * Turns decoded hops into drawable ghost segments: for each hop an arc on the
   * recorded planet from latch to release angle in direction s, then a curve of
   * the flight (speed V_ORBIT*(1+HOT_BOOST*heat), gravity GRAVITY, wall bounces)
   * for ≤ 1.5 s or, when a next hop exists, cut at the sample nearest to its
   * latch point and joined to that point (the curve's last point IS the next
   * latch point, so the renderer needs no separate join). A flight the player
   * died in and rewound out of (the next hop re-opens the same latch, flagged
   * rewound) runs the full 1.5 s unjoined instead. Hops whose planet the lookup
   * does not know are skipped; malformed hop entries are ignored. Every
   * coordinate is finite.
   *
   * @param {{path:Array}} decoded result of decode()
   * @param {function(number):({x0:number, y:number, R?:number}|null|undefined)} lookupPlanet
   *   returns the planet for an id (G.sim.gen-backed; drift ignored, x0 used)
   * @returns {Array<{type:'arc', cx:number, cy:number, r:number, from:number, to:number, s:number, rewound:boolean, planetId:number}
   *   | {type:'curve', pts:number[][], heat:number}>}
   */
  function expandPath(decoded, lookupPlanet) {
    var hops = (decoded && decoded.path) || [];
    if (!hops.length || typeof lookupPlanet !== 'function') return [];
    var phys = physics();

    var resolved = [];
    var ordinal = 0;
    for (var i = 0; i < hops.length; i++) {
      var hop = hops[i];
      if (!hop || typeof hop !== 'object') continue;
      var dPlanet = Number(hop.dPlanet);
      ordinal = Math.max(0, ordinal + (isFinite(dPlanet) ? clamp(Math.round(dPlanet), DELTA_MIN, DELTA_MAX) : 0));
      var id = idFromOrdinal(ordinal);
      var planet = safeCall(lookupPlanet, null, [id]);
      if (!planet || !isFiniteNumber(planet.x0) || !isFiniteNumber(planet.y)) continue;
      var r = isFiniteNumber(hop.r) ? hop.r : 0;
      var from = normAngle(hop.latchAngle);
      var to = arcEnd(from, normAngle(hop.releaseAngle), hop.s);
      resolved.push({
        planetId: id, cx: planet.x0, cy: planet.y, r: r, from: from, to: to,
        s: hop.s < 0 ? -1 : 1, heat: clamp(Number(hop.heat) || 0, 0, 1), rewound: !!hop.rewound,
        latchPt: [planet.x0 + r * Math.cos(from), planet.y + r * Math.sin(from)]
      });
    }

    var out = [];
    for (var j = 0; j < resolved.length; j++) {
      var h = resolved[j];
      var next = resolved[j + 1] || null;
      if (isRewindOfSameLatch(h, next)) next = null;
      out.push({ type: 'arc', cx: h.cx, cy: h.cy, r: h.r, from: h.from, to: h.to, s: h.s, rewound: h.rewound, planetId: h.planetId });
      var speed = phys.V_ORBIT * (1 + phys.HOT_BOOST * h.heat);
      var x0 = h.cx + h.r * Math.cos(h.to);
      var y0 = h.cy + h.r * Math.sin(h.to);
      var vx = -h.s * speed * Math.sin(h.to);
      var vy = h.s * speed * Math.cos(h.to);
      out.push({ type: 'curve', pts: flight(x0, y0, vx, vy, phys, next ? next.latchPt : null), heat: h.heat });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  G.duel = {
    MAX_HOPS: MAX_HOPS,
    RECORD_BYTES: RECORD_BYTES,
    ordinalOf: ordinalOf,
    idFromOrdinal: idFromOrdinal,
    sanitizeName: sanitizeName,
    createRecorder: createRecorder,
    encode: encode,
    decode: decode,
    base64urlEncode: base64urlEncode,
    base64urlDecode: base64urlDecode,
    readFromLocation: readFromLocation,
    buildLinks: buildLinks,
    shareText: shareText,
    expandPath: expandPath
  };
}());
