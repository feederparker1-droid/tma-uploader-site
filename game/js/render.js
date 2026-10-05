/**
 * G.render — the Canvas 2D renderer of Tetherloop (one canvas, no assets).
 *
 * Everything on screen is procedural: sky gradient by altitude, three
 * pre-rendered starfield tiles with parallax, nebula blobs, decorative far
 * planets on wide screens, cached planet sprites (craters, bands, rings, hot
 * corona, drift trail), the tether with heat colour ramp, aim guide, reticle
 * with orbit preview, the comet with a skin-styled trail, a 400-slot particle
 * pool, 12 floating labels, the in-game HUD and the post effects
 * (vignette / flash / shake / zoom). Glow is ONE pre-rendered 128 px radial
 * sprite blitted in 'lighter' mode (tinted copies are cached per colour);
 * shadowBlur is never used per frame.
 *
 * Depends on G.CONFIG (read when used, never cached), the Run shape produced by
 * G.sim (G.sim.planetX for drifting planets, G.sim.gen for the share card), the
 * SkinDef / ThemeDef shapes of G.meta and optionally G.i18n / G.sdk. Every
 * sibling global is guarded: the module works with only G.CONFIG present.
 *
 * Coordinates: world x in [0, COL_W], world y UP (10 px = 1 m). The logical
 * space is the 540x960 safe zone with its origin at the zone's top-left,
 * scaled to fit the canvas and centred; logical y = VIEW_H - (worldY - camY).
 * After drawFrame() returns, ctx is left in LOGICAL space (scale + offset
 * applied, no shake / zoom) so ui.js draws menus on top with G.render.ui.
 *
 * Public API (JSDoc on each member below):
 *   init(canvas)                          resize(cssW, cssH, dpr)
 *   view                                  worldToScreen(x, y, camY) / pointerToLogical(cx, cy) / logicalToPointer(lx, ly)
 *   setTheme(themeDef) / setSkin(skinDef) / setReduceMotion(bool) / setQualityAuto(avgFrameMs) → level (0..3)
 *   drawFrame(run, frame)                 (single-call frame; see Frame typedef)
 *   particles.spawn(kind, x, y, opts)     floatText(text, x, y, opts)
 *   shake(px) / zoomPulse() / flash()     onEvent(evt) (optional sim-event → juice mapping)
 *   reset()                               drawShareCard(run, meta) → 1080x1080 canvas
 *   ui.{button, panel, text, icon, toggle, ring, measureText, roundRect, font}
 *   heatColor(heat) / skyColorAt(altM) / THEME_DEFAULT / SKIN_DEFAULT / quality / hud
 *
 * @typedef {Object} Frame
 * @property {number} [alpha=1]        interpolation between run.prevComet and run.comet
 * @property {number} [camY]           smoothed camera bottom (world y); defaults to run.camBottom
 * @property {number} [t]              wall-clock seconds (drives twinkle, pulses, particle dt)
 * @property {number} [simT]           sim seconds (drift phase); defaults to run.t
 * @property {boolean} [held]
 * @property {?Object} [target]        result of G.sim.getTarget(run)
 * @property {boolean} [showReticle=true]
 * @property {boolean} [showAimGuide=true]
 * @property {{shake?:number, zoom?:number, flash?:number, vignette?:number}} [effects]
 *           shake: extra px, zoom: extra scale (1.04) or delta (0.04), flash/vignette: alpha 0..1
 * @property {number} [heat]           defaults to run.heat
 * @property {?{altM:number, name:string, ghost?:Array}} [duel]
 * @property {?number} [bestAltM]      previous best altitude (m) → dashed BEST line in free play
 * @property {number} [M] @property {number} [pool]
 * @property {?Object} [hud]           { score, alt, banked, pool, M, duelName, duelScore, dailyNumber, missionText }.
 *                                     When absent the HUD layer is skipped (title screen draws its own chrome).
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
  var FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  /** Minimal config used only when config.js is missing (unit tests of the kit). */
  var FALLBACK_CFG = {
    COL_W: 540, VIEW_H: 960, COMET_R: 9, V_ORBIT: 420, GRAVITY: 520, HOT_BOOST: 0.5, HOT_SHOT_HEAT: 0.7,
    LOOKAHEAD_FADE: [1000, 1170], CHUNK_H: 2000, CAM_START: -480,
    SCORE: { M_CAP: 5 }, PERF: { DPR_CAP: 2, PARTICLE_POOL: 400, AUTO_QUALITY_MS: 20 }
  };
  function cfg() { return G.CONFIG || FALLBACK_CFG; }

  /** Fallback theme when G.meta is not loaded (mirrors G.meta.THEMES[0]). */
  var THEME_DEFAULT = Object.freeze({
    id: 'indigo', unlockAltM: 0, mood: 'minor', starHue: 220,
    skyStops: [[0, '#0b1030'], [300, '#0d2a3a'], [700, '#2a1240'], [1200, '#3a2a10'], [2000, '#0a0a14']],
    nebula: [[260, 60, 45], [200, 70, 40], [320, 50, 40]],
    planetPalettes: [
      ['#8fb3ff', '#4a63c7', '#1d2a6b'], ['#ffb38a', '#d96b4a', '#6b2a1f'], ['#b8f0d8', '#4fbf9a', '#1f5c48'],
      ['#e6c4ff', '#9b5fd9', '#3f2370'], ['#fff0a8', '#d9b24f', '#6b5520'], ['#c9d6e8', '#7a8aa6', '#2f3a4d']
    ],
    tether: '#6ff', hot: '#ff5a3c', text: '#eef'
  });
  /** Fallback skin when G.meta is not loaded (mirrors G.meta.SKINS[0]). */
  var SKIN_DEFAULT = Object.freeze({ id: 'ember', price: 0, hueA: 18, hueB: 0, style: 'ribbon', width: 8, timbre: 'triangle' });

  var RETICLE = { green: '#58ffb0', amber: '#ffc44d', red: '#ff5a6a' };
  var M_TIERS = ['#ffffff', '#6ff5ff', '#ffd54a', '#ff9a3c', '#ff4d5a']; // 1.0, 2.0, 3.0, 4.0, 5.0
  var QUALITY = [
    { dpr: 2, glow: true, label: 'high' },
    { dpr: 1.5, glow: true, label: 'medium' },
    { dpr: 1, glow: true, label: 'low' },
    { dpr: 1, glow: false, label: 'minimal' }
  ];
  var TRAIL_LEN = 40;
  var FLOAT_POOL = 12;
  var STAR_LAYERS = [
    { n: 180, size: 1, par: 0.15, alpha: 0.55 },
    { n: 90, size: 1.6, par: 0.35, alpha: 0.75 },
    { n: 40, size: 2.4, par: 0.6, alpha: 0.95 }
  ];
  var TWINKLERS = 24;
  var NEBULA_WRAP = 2400;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                         */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function posMod(v, m) { v = v % m; return v < 0 ? v + m : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) {
    t = clamp(t, 0, 1);
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  /** mulberry32, duplicated here so the renderer never depends on G.sim for its own visuals. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Deterministic visual noise in [0,1) from an integer (trail sparks / jagged offsets). */
  function noise(i) {
    var t = Math.imul(i | 0, 0x9E3779B9) ^ 0x5bd1e995;
    t = Math.imul(t ^ (t >>> 13), 0x85ebca6b);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  }

  /** Parses '#rgb' / '#rrggbb' / 'rgb(a)(...)' / 'hsl(...)' into [r,g,b] (0..255). */
  var colorCache = {}, colorCacheCount = 0;
  function parseColor(str) {
    if (colorCache[str]) return colorCache[str];
    if (colorCacheCount > 256) { colorCache = {}; colorCacheCount = 0; }
    var out = [238, 238, 255];
    if (typeof str === 'string') {
      var s = str.trim();
      if (s[0] === '#') {
        var h = s.slice(1);
        if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var v = parseInt(h.slice(0, 6), 16);
        if (!isNaN(v)) out = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      } else if (/^rgba?\(/i.test(s)) {
        var m = s.match(/[\d.]+/g);
        if (m && m.length >= 3) out = [+m[0], +m[1], +m[2]];
      } else if (/^hsla?\(/i.test(s)) {
        var mh = s.match(/[\d.]+/g);
        if (mh && mh.length >= 3) out = hslToRgb(+mh[0], +mh[1] / 100, +mh[2] / 100);
      }
    }
    colorCache[str] = out;
    colorCacheCount++;
    return out;
  }
  function hslToRgb(h, s, l) {
    h = posMod(h, 360) / 360;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) {
      t = posMod(t, 1);
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (a === undefined ? 1 : a) + ')'; }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function lighten(c, t) { return mix(c, [255, 255, 255], t); }
  function darken(c, t) { return mix(c, [0, 0, 0], t); }
  function hsl(h, s, l, a) { return 'hsla(' + (posMod(h, 360) | 0) + ',' + (s | 0) + '%,' + (l | 0) + '%,' + (a === undefined ? 1 : a) + ')'; }

  /* ------------------------------------------------------------------ */
  /* State                                                                 */
  /* ------------------------------------------------------------------ */

  var canvas = null, ctx = null;
  var theme = THEME_DEFAULT, skin = SKIN_DEFAULT;
  var reduceMotion = false;
  var qualityLevel = 0, calmCalls = 0;
  var deviceDpr = 1;
  var view = {
    scale: 1, offX: 0, offY: 0, cssW: 540, cssH: 960, dpr: 1, logicalW: 540, logicalH: 960, landscape: false,
    safe: { x0: 0, y0: 0, x1: 540, y1: 960 }, visible: { x0: 0, y0: 0, x1: 540, y1: 960 }
  };
  var res = 1;                 // offscreen sprite resolution (device px per logical px)
  var glow = null;             // 128 px white radial sprite
  var glowTints = {}, glowTintCount = 0;
  var planetCache = {}, planetCacheCount = 0;
  var decorCache = {}, decorCacheCount = 0;
  var forceGlow = false;       // share card: glow pass regardless of the auto-quality level
  var stars = null;            // { seed, res, tiles: [canvas x3], twinklers: [] }
  var nebula = null;           // { themeId, blobs: [{canvas, size, x, y, speed}] }
  var vignetteGrad = null, vignetteKey = '';
  var lastFrameT = null, frameIndex = 0;
  var lastRun = null, lastCometX = 0, lastCometY = 0;
  var trail = [];              // [{x, y, heat}] most recent last
  var particles = [], particleCursor = 0;
  var rings = [];              // expanding loop circles
  var floats = [];
  var emberAcc = 0, heatEmberAcc = 0;
  var fx = { shakeAmp: 0, shakeT: 1, zoomT: 1, flashFrames: 0, fringeFrames: 0, flashAlpha: 0 };
  var hudRects = { pause: { x: 0, y: 0, w: 44, h: 44 } };

  /* ------------------------------------------------------------------ */
  /* Init / view                                                           */
  /* ------------------------------------------------------------------ */

  function makeCanvas(w, h) {
    var cv = document.createElement('canvas');
    cv.width = clamp(Math.round(num(w, 1)), 1, 8192);
    cv.height = clamp(Math.round(num(h, 1)), 1, 8192);
    return cv;
  }

  /** Pre-renders the single 128 px glow sprite (white, radial falloff). */
  function makeGlow() {
    var cv = makeCanvas(128, 128), c = cv.getContext('2d');
    var g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    return cv;
  }

  /** Tinted copy of the glow sprite for a CSS colour (cached, bounded). */
  function glowFor(color) {
    if (!color || color === '#fff' || color === '#ffffff') return glow;
    var t = glowTints[color];
    if (t) return t;
    if (glowTintCount > 48) { glowTints = {}; glowTintCount = 0; }
    var cv = makeCanvas(128, 128), c = cv.getContext('2d');
    c.drawImage(glow, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = color;
    c.fillRect(0, 0, 128, 128);
    glowTints[color] = cv;
    glowTintCount++;
    return cv;
  }

  /** Blits a glow stamp of diameter `size` centred on (x, y) in lighter mode. */
  function stampGlow(c, x, y, size, color, alpha) {
    if (!(QUALITY[qualityLevel].glow || forceGlow) || alpha <= 0) return;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = alpha;
    c.drawImage(glowFor(color), x - size / 2, y - size / 2, size, size);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /**
   * Binds the renderer to a canvas: creates the 2D context, the glow sprite,
   * the particle / label pools and a default view.
   * @param {HTMLCanvasElement} cv
   */
  function init(cv) {
    canvas = cv;
    ctx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
    glow = makeGlow();
    glowTints = {}; glowTintCount = 0;
    planetCache = {}; planetCacheCount = 0;
    decorCache = {}; decorCacheCount = 0;
    stars = null; nebula = null;
    initPools();
    resize(view.cssW, view.cssH, deviceDpr);
  }

  function initPools() {
    var n = (cfg().PERF && cfg().PERF.PARTICLE_POOL) || 400;
    particles = new Array(n);
    for (var i = 0; i < n; i++) {
      particles[i] = { alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff', shape: 'circle', grav: 0, drag: 0, add: true };
    }
    particleCursor = 0;
    floats = new Array(FLOAT_POOL);
    for (var j = 0; j < FLOAT_POOL; j++) floats[j] = { alive: false, text: '', x: 0, y: 0, t: 0, color: '#fff', size: 22 };
    rings = [];
    trail = [];
  }

  /**
   * Sets the canvas backing size and computes the logical view.
   * @param {number} cssW canvas CSS width (px)
   * @param {number} cssH canvas CSS height (px)
   * @param {number} [dpr=1] devicePixelRatio (capped by PERF.DPR_CAP and the auto-quality level)
   */
  function resize(cssW, cssH, dpr) {
    var C = cfg();
    cssW = Math.max(1, num(cssW, 540));
    cssH = Math.max(1, num(cssH, 960));
    deviceDpr = Math.max(0.5, num(dpr, deviceDpr || 1));
    var cap = (C.PERF && C.PERF.DPR_CAP) || 2;
    var eff = Math.min(deviceDpr, cap, QUALITY[qualityLevel].dpr);
    if (canvas) {
      canvas.width = Math.max(1, Math.round(cssW * eff));
      canvas.height = Math.max(1, Math.round(cssH * eff));
      if (canvas.style) { canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px'; }
    }
    var scale = Math.min(cssW / C.COL_W, cssH / C.VIEW_H);
    view.cssW = cssW; view.cssH = cssH; view.dpr = eff; view.scale = scale;
    view.offX = (cssW - C.COL_W * scale) / 2;
    view.offY = (cssH - C.VIEW_H * scale) / 2;
    view.logicalW = cssW / scale;
    view.logicalH = cssH / scale;
    view.landscape = cssW > cssH;
    view.safe = { x0: 0, y0: 0, x1: C.COL_W, y1: C.VIEW_H };
    view.visible = { x0: -view.offX / scale, y0: -view.offY / scale, x1: C.COL_W + view.offX / scale, y1: C.VIEW_H + view.offY / scale };
    var newRes = clamp(Math.round(scale * eff * 4) / 4, 0.5, 3);
    if (newRes !== res) {
      res = newRes;
      planetCache = {}; planetCacheCount = 0;
      decorCache = {}; decorCacheCount = 0;
      stars = null;
    }
    vignetteGrad = null;
    if (ctx) applyBaseTransform();
  }

  function applyBaseTransform() {
    var k = view.dpr * view.scale;
    ctx.setTransform(k, 0, 0, k, view.dpr * view.offX, view.dpr * view.offY);
  }

  /**
   * World → logical screen coordinates.
   * @param {number} x world x  @param {number} y world y  @param {number} camY camera bottom (world y)
   * @returns {number[]} [sx, sy]
   */
  function worldToScreen(x, y, camY) { return [x, cfg().VIEW_H - (y - camY)]; }

  /**
   * Pointer client coordinates → logical coordinates (for canvas UI hit tests).
   * @returns {number[]} [lx, ly]
   */
  function pointerToLogical(clientX, clientY) {
    var left = 0, top = 0, kx = 1, ky = 1;
    if (canvas && typeof canvas.getBoundingClientRect === 'function') {
      var r = canvas.getBoundingClientRect();
      left = r.left; top = r.top;
      if (r.width > 0) kx = view.cssW / r.width;
      if (r.height > 0) ky = view.cssH / r.height;
    }
    return [((clientX - left) * kx - view.offX) / view.scale, ((clientY - top) * ky - view.offY) / view.scale];
  }

  /** Inverse of pointerToLogical (tests, cursor placement). @returns {number[]} [clientX, clientY] */
  function logicalToPointer(lx, ly) {
    var left = 0, top = 0, kx = 1, ky = 1;
    if (canvas && typeof canvas.getBoundingClientRect === 'function') {
      var r = canvas.getBoundingClientRect();
      left = r.left; top = r.top;
      if (r.width > 0) kx = view.cssW / r.width;
      if (r.height > 0) ky = view.cssH / r.height;
    }
    return [(lx * view.scale + view.offX) / kx + left, (ly * view.scale + view.offY) / ky + top];
  }

  /** @param {Object} themeDef ThemeDef from G.meta.THEMES (falls back to THEME_DEFAULT) */
  function setTheme(themeDef) {
    var next = themeDef && Array.isArray(themeDef.skyStops) ? themeDef : THEME_DEFAULT;
    if (next === theme) return;
    theme = next;
    planetCache = {}; planetCacheCount = 0;
    decorCache = {}; decorCacheCount = 0;
    nebula = null;
    stars = null;
    heatRamp = null;
  }
  /** @param {Object} skinDef SkinDef from G.meta.SKINS (falls back to SKIN_DEFAULT) */
  function setSkin(skinDef) { skin = skinDef && skinDef.style ? skinDef : SKIN_DEFAULT; }
  /** @param {boolean} on disables shake, zoom pulses and the death double draw */
  function setReduceMotion(on) { reduceMotion = !!on; }

  /**
   * Auto quality: called with the average frame time (ms) over the last ~2 s.
   * Steps down DPR 2 → 1.5 → 1 → no glow pass while frames exceed
   * PERF.AUTO_QUALITY_MS, steps back up after three calm samples (< 55 %).
   * Details of the current level are exposed by the `quality` getter.
   * @param {number} avgFrameMs
   * @returns {number} current quality level: 0 high (DPR 2), 1 medium (1.5), 2 low (1), 3 minimal (no glow)
   */
  function setQualityAuto(avgFrameMs) {
    var limit = (cfg().PERF && cfg().PERF.AUTO_QUALITY_MS) || 20;
    var before = qualityLevel;
    if (num(avgFrameMs, 0) > limit) {
      calmCalls = 0;
      if (qualityLevel < QUALITY.length - 1) qualityLevel++;
    } else if (num(avgFrameMs, limit) < limit * 0.55) {
      calmCalls++;
      if (calmCalls >= 3 && qualityLevel > 0) { qualityLevel--; calmCalls = 0; }
    } else {
      calmCalls = 0;
    }
    if (qualityLevel !== before) resize(view.cssW, view.cssH, deviceDpr);
    return qualityLevel;
  }
  function qualityInfo() {
    var q = QUALITY[qualityLevel];
    return { level: qualityLevel, label: q.label, dpr: view.dpr, glow: q.glow };
  }

  /* ------------------------------------------------------------------ */
  /* Colour ramps                                                          */
  /* ------------------------------------------------------------------ */

  /** Sky colour [r,g,b] at an altitude (m) from theme.skyStops (clamped at both ends). */
  function skyColorAt(altM) {
    var stops = theme.skyStops;
    if (altM <= stops[0][0]) return parseColor(stops[0][1]);
    for (var i = 1; i < stops.length; i++) {
      if (altM <= stops[i][0]) {
        var t = (altM - stops[i - 1][0]) / Math.max(1e-6, stops[i][0] - stops[i - 1][0]);
        return mix(parseColor(stops[i - 1][1]), parseColor(stops[i][1]), t);
      }
    }
    return parseColor(stops[stops.length - 1][1]);
  }

  var heatRamp = null;
  /** Heat → colour: theme tether (0) → white (0.5) → amber (0.7) → red (0.9+). Returns a CSS string (32 quantized steps). */
  function heatColor(heat) {
    if (!heatRamp) {
      heatRamp = [];
      var c0 = parseColor(theme.tether), c1 = [255, 255, 255], c2 = [255, 179, 71], c3 = [255, 59, 59];
      for (var i = 0; i <= 32; i++) {
        var h = i / 32, c;
        if (h < 0.5) c = mix(c0, c1, h / 0.5);
        else if (h < 0.7) c = mix(c1, c2, (h - 0.5) / 0.2);
        else if (h < 0.9) c = mix(c2, c3, (h - 0.7) / 0.2);
        else c = c3;
        heatRamp.push(rgba(c));
      }
    }
    return heatRamp[clamp(Math.round(clamp(num(heat, 0), 0, 1) * 32), 0, 32)];
  }

  /** Skin colour [r,g,b] at trail position u (0 = tail/hueB, 1 = head/hueA), heat and time. */
  function skinRgb(sk, u, heat, t) {
    var hueA = num(sk.hueA, 0), hueB = num(sk.hueB, hueA);
    var hue = lerp(hueB, hueA, u);
    if (sk.cycle) hue = t * 90 + u * 120;
    var sat = sk.sat === 0 ? 0 : 90;
    var c = hslToRgb(hue, sat / 100, sk.sat === 0 ? 0.8 : 0.62);
    if (heat > 0) c = mix(c, [255, 214, 170], clamp(heat, 0, 1) * 0.8);
    return c;
  }
  function skinMainColor(sk) {
    if (sk.core && sk.edge) return sk.edge;
    return rgba(skinRgb(sk, 1, 0, 0));
  }

  /* ------------------------------------------------------------------ */
  /* Starfield / nebula / decor sprites                                    */
  /* ------------------------------------------------------------------ */

  /** Builds the three 540x960 star tiles and the twinkling star list for a seed. */
  function buildStars(seed) {
    var C = cfg();
    var rng = mulberry32((seed >>> 0) ^ 0x51A7F1E1);
    var tiles = [], twinklers = [];
    for (var L = 0; L < STAR_LAYERS.length; L++) {
      var layer = STAR_LAYERS[L];
      var cv = makeCanvas(C.COL_W * res, C.VIEW_H * res), c = cv.getContext('2d');
      c.scale(res, res);
      for (var i = 0; i < layer.n; i++) {
        var x = rng() * C.COL_W, y = rng() * C.VIEW_H;
        var size = layer.size * (0.7 + rng() * 0.6);
        var hue = theme.starHue + (rng() * 40 - 20);
        var light = 75 + rng() * 22;
        var sat = theme.monochrome ? 0 : 35 + rng() * 30;
        c.fillStyle = hsl(hue, sat, light, layer.alpha * (0.6 + rng() * 0.4));
        c.beginPath();
        c.arc(x, y, size / 2, 0, TAU);
        c.fill();
        if (L === STAR_LAYERS.length - 1 && twinklers.length < TWINKLERS) {
          twinklers.push({ x: x, y: y, size: size, f: 1.5 + rng() * 3, phase: rng() * TAU, hue: hue, sat: sat });
        }
      }
      tiles.push(cv);
    }
    stars = { seed: seed >>> 0, res: res, tiles: tiles, twinklers: twinklers };
  }

  /** Pre-renders the three nebula blobs for the current theme. */
  function buildNebula() {
    var blobs = [];
    var spec = [
      { x: 110, y: 300, size: 900, speed: 0.021 },
      { x: 430, y: 1250, size: 700, speed: 0.017 },
      { x: 260, y: 2000, size: 600, speed: 0.013 }
    ];
    for (var i = 0; i < 3; i++) {
      var hslv = (theme.nebula && theme.nebula[i]) || [220, 50, 40];
      var cv = makeCanvas(256, 256), c = cv.getContext('2d');
      var g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, hsl(hslv[0], hslv[1], hslv[2], 1));
      g.addColorStop(0.45, hsl(hslv[0], hslv[1], hslv[2], 0.45));
      g.addColorStop(1, hsl(hslv[0], hslv[1], hslv[2], 0));
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 256);
      blobs.push({ canvas: cv, size: spec[i].size, x: spec[i].x, y: spec[i].y, speed: spec[i].speed });
    }
    nebula = { themeId: theme.id, blobs: blobs };
  }

  /** Gradient disc sprite for a decorative far planet (cached by palette + radius). */
  function decorSprite(d) {
    var R = Math.round(d.R);
    var palIdx = posMod(num(d.palette, 0) | 0, 6);
    var key = palIdx + '_' + R;
    var s = decorCache[key];
    if (s) return s;
    if (decorCacheCount > 240) { decorCache = {}; decorCacheCount = 0; }
    var pal = theme.planetPalettes[palIdx].map(parseColor);
    var size = Math.ceil((R * 2 + 4) * res);
    var cv = makeCanvas(size, size), c = cv.getContext('2d');
    c.scale(res, res);
    var cx = R + 2;
    var g = c.createRadialGradient(cx - R * 0.35, cx - R * 0.35, R * 0.1, cx, cx, R);
    g.addColorStop(0, rgba(pal[0]));
    g.addColorStop(0.6, rgba(pal[1]));
    g.addColorStop(1, rgba(darken(pal[2], 0.3)));
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cx, R, 0, TAU);
    c.fill();
    s = { canvas: cv, half: cx };
    decorCache[key] = s;
    decorCacheCount++;
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Planet sprites                                                        */
  /* ------------------------------------------------------------------ */

  /** True for a planet whose geometry can be drawn (finite position, radius >= 1 px). */
  function drawablePlanet(p) {
    return !!p && isFinite(p.y) && typeof p.R === 'number' && p.R >= 1 && p.R < 1e5;
  }

  function hotPalette(th) {
    var h = parseColor(th.hot);
    return [lighten(h, 0.45), h, darken(h, 0.6)];
  }

  /** Draws one half of a planet ring (back half before the body, front half after). */
  function drawRingHalf(c, R, pal, back) {
    var rx = R * 1.65, ry = R * 0.42, rot = -0.35;
    c.save();
    c.rotate(rot);
    c.beginPath();
    c.ellipse(0, 0, rx, ry, 0, back ? Math.PI : 0, back ? TAU : Math.PI);
    c.lineWidth = R * 0.16;
    c.strokeStyle = rgba(pal[0], 0.55);
    c.stroke();
    c.beginPath();
    c.ellipse(0, 0, rx - R * 0.02, ry - R * 0.02, 0, back ? Math.PI : 0, back ? TAU : Math.PI);
    c.lineWidth = R * 0.04;
    c.strokeStyle = rgba(pal[2], 0.7);
    c.stroke();
    c.restore();
  }

  /**
   * Renders a planet into an offscreen sprite at resolution `rs`.
   * The box is 2R + 24 px square (3.5R + 24 for ringed planets so the ring fits).
   */
  function makePlanetSprite(p, rs, th) {
    var R = p.R;
    var half = (p.ring ? R * 1.75 : R) + 12;
    var size = Math.ceil(half * 2 * rs);
    var cv = makeCanvas(size, size), c = cv.getContext('2d');
    c.scale(rs, rs);
    c.translate(half, half);
    var pal = p.hot ? hotPalette(th) : th.planetPalettes[posMod(num(p.palette, 0) | 0, 6)].map(parseColor);
    if (p.ring) drawRingHalf(c, R, pal, true);

    var g = c.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.08, 0, 0, R);
    g.addColorStop(0, rgba(pal[0]));
    g.addColorStop(0.55, rgba(pal[1]));
    g.addColorStop(1, rgba(pal[2]));
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, R, 0, TAU);
    c.fill();

    c.save();
    c.beginPath();
    c.arc(0, 0, R - 0.5, 0, TAU);
    c.clip();
    var bands = Array.isArray(p.bands) ? p.bands : [];
    for (var b = 0; b < bands.length; b++) {
      var bd = bands[b];
      if (!bd || typeof bd !== 'object') continue;
      c.globalAlpha = clamp(num(bd.alpha, 0.1), 0, 1);
      c.fillStyle = rgba(b % 2 === 0 ? pal[0] : pal[2]);
      var bh = Math.abs(num(bd.h, 4));
      c.fillRect(-R, num(bd.yOff, 0) - bh / 2, R * 2, bh);
    }
    c.globalAlpha = 1;
    var craters = Array.isArray(p.craters) ? p.craters : [];
    for (var k = 0; k < craters.length; k++) {
      var cr = craters[k];
      if (!cr || typeof cr !== 'object') continue;
      var rx = Math.max(1, Math.abs(num(cr.rx, 4))), ry = Math.max(1, Math.abs(num(cr.ry, rx * 0.7)));
      c.save();
      c.translate(num(cr.dx, 0), num(cr.dy, 0));
      c.rotate(num(cr.rot, 0));
      c.scale(1, ry / rx);
      var cg = c.createRadialGradient(0, 0, 0, 0, 0, rx);
      cg.addColorStop(0, rgba(pal[2], 0.6));
      cg.addColorStop(0.75, rgba(pal[2], 0.35));
      cg.addColorStop(1, rgba(pal[2], 0));
      c.fillStyle = cg;
      c.beginPath();
      c.arc(0, 0, rx, 0, TAU);
      c.fill();
      c.beginPath();
      c.arc(0, 0, rx * 0.85, 0.2, Math.PI * 0.9);
      c.lineWidth = 1;
      c.strokeStyle = rgba(pal[0], 0.28);
      c.stroke();
      c.restore();
    }
    // terminator shading (light from top-left)
    var sh = c.createRadialGradient(-R * 0.4, -R * 0.4, R * 0.3, 0, 0, R * 1.05);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(0.7, 'rgba(0,0,0,0.05)');
    sh.addColorStop(1, 'rgba(0,0,0,0.5)');
    c.fillStyle = sh;
    c.fillRect(-R, -R, R * 2, R * 2);
    c.restore();

    // 1 px rim light
    c.beginPath();
    c.arc(0, 0, R - 0.5, 0, TAU);
    c.lineWidth = 1;
    c.strokeStyle = rgba(pal[0], 0.45);
    c.stroke();
    if (p.ring) drawRingHalf(c, R, pal, false);
    return { canvas: cv, half: half, res: rs, hot: !!p.hot, p: p };
  }

  /**
   * Cached sprite of a planet. The cache is keyed by planet id but validated
   * against the planet OBJECT: ids restart at 0 in every run, so a new run with
   * a different seed must never be drawn with the previous run's sprites.
   */
  function planetSprite(p) {
    var s = planetCache[p.id];
    if (s && s.res === res && s.p === p) return s;
    if (planetCacheCount > 160) { planetCache = {}; planetCacheCount = 0; }
    if (!s) planetCacheCount++;
    s = makePlanetSprite(p, res, theme);
    planetCache[p.id] = s;
    return s;
  }

  /** Planet by id from run.planets (plain object or Map). */
  function planetById(run, id) {
    var ps = run.planets;
    if (!ps) return null;
    if (typeof Map === 'function' && ps instanceof Map) return ps.get(id) || ps.get(+id) || null;
    return ps[id] || null;
  }

  /** Drops sprites of planets that left the run or sit 1200 px below the camera. */
  function evictPlanetSprites(run, camY) {
    var keys = Object.keys(planetCache);
    for (var i = 0; i < keys.length; i++) {
      var p = planetById(run, keys[i]);
      if (!p || p.y < camY - 1200) { delete planetCache[keys[i]]; planetCacheCount--; }
    }
    if (planetCacheCount < 0) planetCacheCount = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Particles / floating text / effects                                   */
  /* ------------------------------------------------------------------ */

  var PARTICLE_KINDS = {
    latch: 8, release: 6, graze: 14, hotshot: 20, loop: 60, death: 200, wall: 6, embers: 1
  };

  function allocParticle() {
    var n = particles.length;
    for (var i = 0; i < n; i++) {
      var p = particles[(particleCursor + i) % n];
      if (!p.alive) { particleCursor = (particleCursor + i + 1) % n; return p; }
    }
    var old = particles[particleCursor];
    particleCursor = (particleCursor + 1) % n;
    return old;
  }

  function emit(x, y, vx, vy, life, size, color, shape, grav, drag, add) {
    var p = allocParticle();
    p.alive = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = life; p.max = life;
    p.size = size; p.color = color; p.shape = shape; p.grav = grav; p.drag = drag; p.add = add;
    return p;
  }

  /**
   * Spawns a burst of a given kind at a WORLD position.
   * kinds: latch(8) release(6) graze(14) hotshot(20) loop(60 + expanding ring) death(200) wall(6) embers(stream)
   * @param {string} kind
   * @param {number} x @param {number} y world coordinates
   * @param {{color?:string, dir?:number[], side?:number, count?:number, hue?:number}} [opts]
   */
  function spawn(kind, x, y, opts) {
    opts = opts || {};
    x = num(x, 0); y = num(y, 0);
    var n = num(opts.count, PARTICLE_KINDS[kind] || 8);
    var skinCol = skinMainColor(skin);
    var seed = (frameIndex * 131 + (x * 7 | 0) + (y * 13 | 0)) | 0;
    var i, a, sp, dx = 0, dy = 0;
    if (Array.isArray(opts.dir)) {
      var l = Math.hypot(opts.dir[0], opts.dir[1]) || 1;
      dx = opts.dir[0] / l; dy = opts.dir[1] / l;
    }
    switch (kind) {
      case 'latch':
        for (i = 0; i < n; i++) {
          a = noise(seed + i) * TAU; sp = 120 + noise(seed + i + 77) * 160;
          emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.35, 2.5, opts.color || theme.tether, 'spark', 0, 4, true);
        }
        break;
      case 'release':
        for (i = 0; i < n; i++) {
          a = noise(seed + i) * TAU; sp = 60 + noise(seed + i + 31) * 120;
          emit(x, y, Math.cos(a) * sp - dx * 80, Math.sin(a) * sp - dy * 80, 0.4, 2, opts.color || skinCol, 'circle', 0, 3, true);
        }
        break;
      case 'graze':
        for (i = 0; i < n; i++) {
          a = (noise(seed + i) - 0.5) * 0.9; sp = 200 + noise(seed + i + 5) * 260;
          var gx = dx || Math.cos(noise(seed + i + 9) * TAU), gy = dy || Math.sin(noise(seed + i + 9) * TAU);
          var ca = Math.cos(a), sa = Math.sin(a);
          emit(x, y, (gx * ca - gy * sa) * sp, (gx * sa + gy * ca) * sp, 0.3 + noise(seed + i + 3) * 0.2, 1.4, i % 3 === 0 ? '#ffe9a8' : '#ffffff', 'spark', 0, 2, true);
        }
        break;
      case 'hotshot':
        for (i = 0; i < n; i++) {
          a = noise(seed + i) * TAU; sp = 140 + noise(seed + i + 17) * 220;
          emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.5, 2.2, i % 2 ? '#ffb347' : '#fff1c0', i % 2 ? 'spark' : 'circle', -120, 3, true);
        }
        break;
      case 'loop':
        for (i = 0; i < n; i++) {
          a = (i / n) * TAU; sp = 180 + noise(seed + i) * 60;
          emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.55, 2.4, opts.color || (i % 3 === 0 ? '#ffffff' : skinCol), 'circle', 0, 2.5, true);
        }
        if (rings.length > 5) rings.shift();
        rings.push({ x: x, y: y, t: 0, life: 0.5, color: opts.color || skinCol });
        break;
      case 'death':
        for (i = 0; i < n; i++) {
          a = noise(seed + i) * TAU; sp = 40 + noise(seed + i + 101) * 420;
          var hot = i % 4 === 0;
          emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.6 + noise(seed + i + 7) * 0.7, hot ? 3 : 1.6 + noise(seed + i + 2) * 2,
            hot ? '#ffffff' : (i % 3 === 0 ? '#ff7a5a' : skinCol), i % 2 ? 'spark' : 'circle', -200, 1.2, true);
        }
        break;
      case 'wall':
        var side = num(opts.side, x < cfg().COL_W / 2 ? -1 : 1);
        for (i = 0; i < n; i++) {
          a = (noise(seed + i) - 0.5) * 1.6; sp = 90 + noise(seed + i + 3) * 160;
          emit(x, y, -side * Math.cos(a) * sp, Math.sin(a) * sp, 0.3, 1.8, opts.color || rgba(parseColor(theme.text)), 'spark', 0, 3, true);
        }
        break;
      case 'embers':
        for (i = 0; i < n; i++) {
          a = noise(seed + i) * TAU; sp = 20 + noise(seed + i + 1) * 40;
          emit(x + Math.cos(a) * 3, y + Math.sin(a) * 3, Math.cos(a) * sp - dx * 60, Math.sin(a) * sp - dy * 60, 0.5 + noise(seed + i + 2) * 0.5, 1.6,
            opts.color || (i % 2 ? '#ff8a3c' : '#ffd27a'), 'circle', 60, 1.5, true);
        }
        break;
      default:
        for (i = 0; i < n; i++) {
          a = noise(seed + i) * TAU; sp = 80 + noise(seed + i + 11) * 140;
          emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.4, 2, opts.color || '#ffffff', 'circle', 0, 3, true);
        }
    }
  }

  function updateParticles(dt) {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy -= p.grav * dt;
      var k = 1 - Math.min(0.9, p.drag * dt);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (var r = rings.length - 1; r >= 0; r--) {
      rings[r].t += dt;
      if (rings[r].t >= rings[r].life) rings.splice(r, 1);
    }
  }

  function drawParticles(c, camY) {
    var H = cfg().VIEW_H;
    var y0 = camY - 100, y1 = camY + H + 100;
    var glowOn = QUALITY[qualityLevel].glow;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (!p.alive || p.y < y0 || p.y > y1) continue;
      var u = p.life / p.max;
      var sx = p.x, sy = H - (p.y - camY);
      c.globalCompositeOperation = p.add && glowOn ? 'lighter' : 'source-over';
      c.globalAlpha = clamp(u * 1.2, 0, 1);
      if (p.shape === 'spark') {
        var l = Math.hypot(p.vx, p.vy);
        var len = clamp(l * 0.03, 3, 14);
        var nx = l > 1e-6 ? p.vx / l : 1, ny = l > 1e-6 ? -p.vy / l : 0;
        c.strokeStyle = p.color;
        c.lineWidth = p.size * (0.4 + 0.6 * u);
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(sx - nx * len, sy - ny * len);
        c.lineTo(sx, sy);
        c.stroke();
      } else {
        c.fillStyle = p.color;
        c.beginPath();
        c.arc(sx, sy, Math.max(0.4, p.size * (0.5 + 0.5 * u)), 0, TAU);
        c.fill();
      }
    }
    for (var r = 0; r < rings.length; r++) {
      var rg = rings[r];
      var k = easeOutCubic(rg.t / rg.life);
      c.globalCompositeOperation = glowOn ? 'lighter' : 'source-over';
      c.globalAlpha = (1 - k) * 0.9;
      c.strokeStyle = rg.color;
      c.lineWidth = 3 * (1 - k) + 1;
      c.beginPath();
      c.arc(rg.x, H - (rg.y - camY), 220 * k + 1, 0, TAU);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /**
   * Shows a floating label at a WORLD position (pool of 12): easeOutBack in over
   * 220 ms, rises 40 px, fades over 700 ms.
   * @param {string} text @param {number} x @param {number} y
   * @param {{color?:string, size?:number}} [opts]
   */
  function floatText(text, x, y, opts) {
    opts = opts || {};
    var slot = null, oldest = null;
    for (var i = 0; i < floats.length; i++) {
      if (!floats[i].alive) { slot = floats[i]; break; }
      if (!oldest || floats[i].t > oldest.t) oldest = floats[i];
    }
    slot = slot || oldest;
    slot.alive = true; slot.text = String(text == null ? '' : text); slot.x = num(x, 270); slot.y = num(y, 480);
    slot.t = 0; slot.color = opts.color || '#ffffff'; slot.size = num(opts.size, 22);
  }

  function drawFloats(c, dt, camY) {
    var H = cfg().VIEW_H;
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i];
      if (!f.alive) continue;
      f.t += dt;
      if (f.t > 0.92) { f.alive = false; continue; }
      var sIn = Math.max(0.02, easeOutBack(f.t / 0.22));
      var rise = 40 * easeOutCubic(f.t / 0.9);
      var alpha = f.t < 0.22 ? 1 : clamp(1 - (f.t - 0.22) / 0.7, 0, 1);
      var sx = clamp(f.x, 60, cfg().COL_W - 60), sy = H - (f.y + rise - camY);
      c.save();
      c.translate(sx, sy);
      c.scale(sIn, sIn);
      c.globalAlpha = alpha;
      uiText(f.text, 0, 0, { size: f.size, weight: 800, align: 'center', baseline: 'middle', color: f.color, halo: true, spacing: 0.06 });
      c.restore();
    }
    c.globalAlpha = 1;
  }

  /** Screen shake of `px` amplitude (decaying sine, 350 ms). No-op under reduce motion. */
  function shake(px) {
    if (reduceMotion) return;
    var remaining = fx.shakeAmp * Math.max(0, 1 - fx.shakeT / 0.35);
    fx.shakeAmp = Math.max(remaining, num(px, 0));
    fx.shakeT = 0;
  }
  /** 1.0 → 1.04 → 1.0 zoom over 180 ms (bank). No-op under reduce motion. */
  function zoomPulse() { if (!reduceMotion) fx.zoomT = 0; }
  /** Two-frame white flash plus a one-frame red/cyan double draw of the comet (death). */
  function flash(frames) {
    fx.flashFrames = Math.max(fx.flashFrames, num(frames, 2));
    if (!reduceMotion) fx.fringeFrames = 1;
  }

  /** Clears run-scoped visual state (trail, particles, labels, effects). Call on a new run. */
  function reset() {
    trail.length = 0;
    rings.length = 0;
    for (var i = 0; i < particles.length; i++) particles[i].alive = false;
    for (var j = 0; j < floats.length; j++) floats[j].alive = false;
    fx.shakeAmp = 0; fx.shakeT = 1; fx.zoomT = 1; fx.flashFrames = 0; fx.fringeFrames = 0;
    emberAcc = 0; heatEmberAcc = 0;
    planetCache = {}; planetCacheCount = 0;
    lastRun = null;
  }

  function tr(key, fallback, vars) {
    if (G.i18n && typeof G.i18n.t === 'function' && (typeof G.i18n.has !== 'function' || G.i18n.has(key))) {
      var s = G.i18n.t(key, vars);
      if (typeof s === 'string' && s && s !== key) return s;
    }
    var out = fallback;
    if (vars) for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) out = out.split('{' + k + '}').join(String(vars[k]));
    return out;
  }
  function fmt(n) {
    n = Math.round(num(n, 0));
    if (G.i18n && typeof G.i18n.fmtNumber === 'function') return G.i18n.fmtNumber(n);
    return String(n);
  }

  /**
   * Optional convenience: maps a sim event to particles / labels / shake per the
   * design's juice table. main.js may call this instead of wiring each kind.
   * @param {Object} evt sim event ({type, ...})
   */
  function onEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    // HOT_SHOT / LONG_SHOT / LINE_PASSED carry no position: anchor them to the comet as last drawn.
    var x = num(evt.x, lastCometX), y = num(evt.y, lastCometY);
    switch (evt.type) {
      case 'LATCH': spawn('latch', x, y); shake(2); break;
      case 'RELEASE': spawn('release', x, y); break;
      case 'GRAZE': spawn('graze', x, y); floatText(tr('graze', 'GRAZE') + ' +' + fmt(evt.amount), x, y + 20, { color: '#ffe9a8', size: 20 }); break;
      case 'HOT_SHOT': floatText(tr('hotShot', 'HOT SHOT'), x, y + 30, { color: '#ffb347', size: 24 }); break;
      case 'LONG_SHOT': floatText(tr('longShot', 'LONG SHOT') + ' +' + fmt(evt.amount), x, y + 30, { color: '#cfe9ff', size: 20 }); break;
      case 'LOOP':
        spawn('loop', x, y);
        floatText(tr('bank', 'BANKED').toUpperCase() + ' +' + fmt(num(evt.pooledBefore, 0) + num(evt.amount, 0)), x, y + 40, { color: '#ffd54a', size: 26 });
        shake(5); zoomPulse();
        break;
      case 'WALL': spawn('wall', x, y, { side: evt.side }); break;
      case 'SNAP': spawn('wall', x, y, { count: 6, color: '#ff8a6a' }); shake(2); break;
      case 'LINE_PASSED': floatText(tr('linePassed', 'LINE PASSED'), cfg().COL_W / 2, y + 40, { color: '#58ffb0', size: 26 }); break;
      case 'DEATH': spawn('death', x, y); shake(8); flash(2); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                                 */
  /* ------------------------------------------------------------------ */

  function planetListOf(run) {
    if (Array.isArray(run.planetList)) return run.planetList;
    var out = [], ps = run.planets;
    if (!ps) return out;
    if (typeof Map === 'function' && ps instanceof Map) { ps.forEach(function (p) { out.push(p); }); return out; }
    for (var k in ps) if (Object.prototype.hasOwnProperty.call(ps, k)) out.push(ps[k]);
    return out;
  }
  function planetXAt(p, t) {
    if (G.sim && typeof G.sim.planetX === 'function') return G.sim.planetX(p, t);
    return p.x0;
  }
  function cometPos(run, alpha) {
    var c = run.comet || { x: 270, y: 0, vx: 0, vy: 0 }, pc = run.prevComet || c;
    return [lerp(num(pc.x, c.x), num(c.x, 0), alpha), lerp(num(pc.y, c.y), num(c.y, 0), alpha)];
  }

  /**
   * Draws one complete frame: world, HUD (when frame.hud is given) and post
   * effects. Leaves ctx in logical space for ui.js. Never throws on a missing
   * run field; the title screen is a run in TITLE_ORBIT so `run` is always set.
   * @param {Object} run   Run from G.sim.createRun / step
   * @param {Frame} frame
   */
  function drawFrame(run, frame) {
    if (!ctx || !run) return;
    frame = frame || {};
    var C = cfg();
    var H = C.VIEW_H, W = C.COL_W;
    var t = num(frame.t, lastFrameT === null ? 0 : lastFrameT + 1 / 60);
    var dt = lastFrameT === null ? 1 / 60 : clamp(t - lastFrameT, 0, 0.05);
    lastFrameT = t;
    frameIndex++;
    var simT = num(frame.simT, num(run.t, 0));
    var alpha = clamp(num(frame.alpha, 1), 0, 1);
    var camY = num(frame.camY, num(run.camBottom, C.CAM_START));
    var heat = clamp(num(frame.heat, num(run.heat, 0)), 0, 1);
    var effects = frame.effects || {};
    var state = run.state || 'TITLE_ORBIT';
    var M = num(frame.M, run.score ? num(run.score.M, 1) : 1);
    var pool = num(frame.pool, run.score ? num(run.score.pool, 0) : 0);

    if (run !== lastRun) { reset(); lastRun = run; }
    var cp = cometPos(run, alpha);
    if (trail.length && Math.hypot(cp[0] - lastCometX, cp[1] - lastCometY) > 200) trail.length = 0;
    lastCometX = cp[0]; lastCometY = cp[1];
    if (state !== 'DEAD') {
      trail.push({ x: cp[0], y: cp[1], heat: heat });
      if (trail.length > TRAIL_LEN) trail.shift();
    }

    if (!stars || stars.seed !== (run.seed >>> 0) || stars.res !== res) buildStars(run.seed >>> 0);
    if (!nebula || nebula.themeId !== theme.id) buildNebula();
    evictPlanetSprites(run, camY);
    updateParticles(dt);

    // --- camera transform: base + shake + zoom -----------------------------
    applyBaseTransform();
    var shakeX = 0, shakeY = 0, zoom = 1;
    if (!reduceMotion) {
      fx.shakeT += dt;
      var env = fx.shakeAmp * Math.max(0, 1 - fx.shakeT / 0.35);
      if (env > 0.01) { shakeX = env * Math.sin(fx.shakeT * TAU * 17); shakeY = env * 0.7 * Math.sin(fx.shakeT * TAU * 13 + 1.3); }
      var extra = num(effects.shake, 0);
      if (extra > 0) { shakeX += extra * Math.sin(t * TAU * 17); shakeY += extra * 0.7 * Math.cos(t * TAU * 13); }
      fx.zoomT += dt;
      if (fx.zoomT < 0.18) zoom *= 1 + 0.04 * Math.sin(Math.PI * fx.zoomT / 0.18);
      var ez = num(effects.zoom, 0);
      if (ez > 0) zoom *= ez > 0.5 ? ez : 1 + ez;
    }
    var c = ctx;
    if (zoom !== 1 || shakeX || shakeY) {
      c.translate(W / 2 + shakeX, H / 2 + shakeY);
      c.scale(zoom, zoom);
      c.translate(-W / 2, -H / 2);
    }
    var vis = view.visible;
    var pad = 40 / zoom;
    var vx0 = vis.x0 - pad, vy0 = vis.y0 - pad, vx1 = vis.x1 + pad, vy1 = vis.y1 + pad;

    // --- sky ------------------------------------------------------------------
    var bright = M >= 3 ? 0.08 : 0;
    var skyBottom = skyColorAt(Math.max(0, camY / 10)), skyTop = skyColorAt(Math.max(0, (camY + H) / 10));
    if (bright) { skyBottom = lighten(skyBottom, bright); skyTop = lighten(skyTop, bright); }
    var sg = c.createLinearGradient(0, vy0, 0, vy1);
    sg.addColorStop(0, rgba(lighten(skyTop, 0.02)));
    sg.addColorStop(1, rgba(skyBottom));
    c.fillStyle = sg;
    c.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);

    // --- nebula (parallax 0.1, slow drift) -------------------------------------
    c.globalAlpha = 0.10;
    for (var nb = 0; nb < nebula.blobs.length; nb++) {
      var blob = nebula.blobs[nb];
      var cxN = blob.x + Math.sin(t * blob.speed * TAU + nb) * 60;
      var baseY = posMod(blob.y + camY * 0.1, NEBULA_WRAP);
      for (var rep = -1; rep <= 1; rep++) {
        var cyN = baseY + rep * NEBULA_WRAP - 600;
        if (cyN + blob.size / 2 < vy0 || cyN - blob.size / 2 > vy1) continue;
        c.drawImage(blob.canvas, cxN - blob.size / 2, cyN - blob.size / 2, blob.size, blob.size);
        if (vx1 - vx0 > W + 200) {
          c.drawImage(blob.canvas, cxN - blob.size / 2 - W * 1.4, cyN - blob.size / 2 + 180, blob.size * 0.8, blob.size * 0.8);
          c.drawImage(blob.canvas, cxN - blob.size / 2 + W * 1.3, cyN - blob.size / 2 - 220, blob.size * 0.9, blob.size * 0.9);
        }
      }
    }
    c.globalAlpha = 1;

    // --- starfield tiles ------------------------------------------------------
    var txStart = Math.floor(vx0 / W) * W;
    for (var L = 0; L < 3; L++) {
      var par = STAR_LAYERS[L].par;
      var ty = posMod(camY * par, H);
      for (var tx = txStart; tx < vx1; tx += W) {
        for (var yy = ty - H; yy < vy1; yy += H) {
          if (yy + H < vy0) continue;
          c.drawImage(stars.tiles[L], tx, yy, W, H);
        }
      }
    }
    // twinkle (near layer, column tiles only)
    var tyNear = posMod(camY * STAR_LAYERS[2].par, H);
    for (var tw = 0; tw < stars.twinklers.length; tw++) {
      var st = stars.twinklers[tw];
      var a = 0.5 + 0.5 * Math.sin(t * st.f + st.phase);
      for (var yy2 = tyNear - H; yy2 < vy1; yy2 += H) {
        var sy2 = yy2 + st.y;
        if (sy2 < vy0 || sy2 > vy1) continue;
        c.globalAlpha = a * 0.9;
        c.fillStyle = hsl(st.hue, st.sat, 92);
        c.beginPath();
        c.arc(st.x, sy2, st.size * (0.5 + 0.4 * a), 0, TAU);
        c.fill();
      }
    }
    c.globalAlpha = 1;

    // --- decor far planets (wide screens, parallax 0.35) ------------------------
    if (vis.x1 - vis.x0 > W + 120 && run.chunks) {
      for (var ck in run.chunks) {
        if (!Object.prototype.hasOwnProperty.call(run.chunks, ck)) continue;
        var chunk = run.chunks[ck];
        var decor = chunk && chunk.decor;
        if (!decor) continue;
        for (var di = 0; di < decor.length; di++) {
          var d = decor[di];
          if (!d || !isFinite(d.x) || !isFinite(d.y) || !(d.R >= 1) || d.R > 1e4) continue;
          var dsy = H - ((d.y - camY) * 0.35 + H * (1 - 0.35) * 0.5); // parallax 0.35 about the view centre
          if (dsy + d.R < vy0 || dsy - d.R > vy1 || d.x + d.R < vx0 || d.x - d.R > vx1) continue;
          var ds = decorSprite(d);
          c.globalAlpha = 0.5;
          c.drawImage(ds.canvas, d.x - ds.half, dsy - ds.half, ds.half * 2, ds.half * 2);
        }
      }
      c.globalAlpha = 1;
    }

    // --- lookahead fog -----------------------------------------------------------
    var camBottom = num(run.camBottom, camY);
    var fogA = camBottom + C.LOOKAHEAD_FADE[0], fogB = camBottom + C.LOOKAHEAD_FADE[1];
    var fsy0 = H - (fogA - camY), fsy1 = H - (fogB - camY);
    if (fsy0 > vy0) {
      var fg = c.createLinearGradient(0, fsy0, 0, fsy1);
      fg.addColorStop(0, rgba(skyTop, 0));
      fg.addColorStop(1, rgba(skyTop, 1));
      c.fillStyle = fg;
      c.fillRect(vx0, fsy1, vx1 - vx0, fsy0 - fsy1);
      if (fsy1 > vy0) { c.fillStyle = rgba(skyTop); c.fillRect(vx0, vy0, vx1 - vx0, fsy1 - vy0); }
    }
    function fogAlpha(y) { return 1 - clamp((y - fogA) / Math.max(1, fogB - fogA), 0, 1); }

    // --- column edge lines ---------------------------------------------------------
    var textCol = parseColor(theme.text);
    var cometSy = H - (cp[1] - camY);
    c.setLineDash([3, 7]);
    c.lineWidth = 1.5;
    c.strokeStyle = rgba(textCol, 0.12);
    c.beginPath(); c.moveTo(0.75, vy0); c.lineTo(0.75, vy1); c.moveTo(W - 0.75, vy0); c.lineTo(W - 0.75, vy1); c.stroke();
    var eg = c.createLinearGradient(0, cometSy - 60, 0, cometSy + 60);
    eg.addColorStop(0, rgba(textCol, 0)); eg.addColorStop(0.5, rgba(textCol, 0.38)); eg.addColorStop(1, rgba(textCol, 0));
    c.strokeStyle = eg;
    c.beginPath(); c.moveTo(0.75, cometSy - 60); c.lineTo(0.75, cometSy + 60); c.moveTo(W - 0.75, cometSy - 60); c.lineTo(W - 0.75, cometSy + 60); c.stroke();
    c.setLineDash([]);

    // --- best / duel dashed line + label -----------------------------------------------
    var duel = frame.duel || (run.duel ? { altM: run.duel.altM, name: run.duel.name } : null);
    var lineY = null, lineLabel = '', lineColor = null;
    if (duel && isFinite(duel.altM)) {
      lineY = duel.altM * 10; lineLabel = tr('fellHere', '{name} fell here', { name: duel.name || 'Rival' }); lineColor = [255, 110, 120];
    } else if (frame.bestAltM !== null && frame.bestAltM !== undefined && num(frame.bestAltM, 0) > 0) {
      lineY = num(frame.bestAltM, 0) * 10; lineLabel = tr('best', 'BEST').toUpperCase() + ' ' + fmt(frame.bestAltM) + ' m'; lineColor = textCol;
    }
    if (lineY !== null) {
      var lsy = H - (lineY - camY);
      if (lsy > vy0 - 20 && lsy < vy1 + 20) {
        var la = 0.5 * fogAlpha(lineY);
        c.setLineDash([10, 8]);
        c.lineWidth = 1.5;
        c.strokeStyle = rgba(lineColor, la);
        c.beginPath(); c.moveTo(0, lsy); c.lineTo(W, lsy); c.stroke();
        c.setLineDash([]);
        c.globalAlpha = la * 1.6;
        uiText(lineLabel, W - 12, lsy - 6, { size: 14, weight: 600, align: 'right', baseline: 'bottom', color: rgba(lineColor), spacing: 0.06 });
        c.globalAlpha = 1;
      }
    }

    // --- ghost path (duel) ---------------------------------------------------------------
    var ghost = frame.duel && Array.isArray(frame.duel.ghost) ? frame.duel.ghost : null;
    if (ghost && ghost.length) {
      c.setLineDash([3, 6]);
      c.lineWidth = 1.5;
      c.strokeStyle = 'rgba(190,190,210,0.25)';
      c.beginPath();
      for (var gi = 0; gi < ghost.length; gi++) {
        var seg = ghost[gi];
        if (seg.type === 'arc' && isFinite(seg.cx) && isFinite(seg.cy) && seg.r > 0) {
          if (seg.cy + seg.r < camY - 50 || seg.cy - seg.r > camY + H + 50) continue;
          var ssy = H - (seg.cy - camY);
          c.moveTo(seg.cx + seg.r * Math.cos(seg.from), ssy - seg.r * Math.sin(seg.from));
          c.arc(seg.cx, ssy, seg.r, -seg.from, -seg.to, seg.s > 0);
        } else if (seg.type === 'curve' && Array.isArray(seg.pts)) {
          var first = true;
          for (var pi = 0; pi < seg.pts.length; pi++) {
            var gp = seg.pts[pi];
            if (!gp || !isFinite(gp[0]) || !isFinite(gp[1]) || gp[1] < camY - 50 || gp[1] > camY + H + 50) { first = true; continue; }
            var gsy = H - (gp[1] - camY);
            if (first) { c.moveTo(gp[0], gsy); first = false; } else c.lineTo(gp[0], gsy);
          }
        }
      }
      c.stroke();
      c.setLineDash([]);
    }

    // --- persistent path line --------------------------------------------------------------
    var samples = run.samples;
    if (Array.isArray(samples) && samples.length > 1) {
      c.lineWidth = 2;
      c.lineJoin = 'round';
      c.strokeStyle = skinMainColor(skin);
      c.globalAlpha = 0.22;
      c.beginPath();
      var pen = false, lo = camY - 60, hi = camY + H + 60;
      for (var si = 0; si < samples.length; si++) {
        var smp = samples[si];
        var inside = smp[1] >= lo && smp[1] <= hi;
        if (!inside) { pen = false; continue; }
        var psy = H - (smp[1] - camY);
        if (!pen) {
          if (si > 0) c.moveTo(samples[si - 1][0], H - (samples[si - 1][1] - camY)); else c.moveTo(smp[0], psy);
          pen = true;
        }
        c.lineTo(smp[0], psy);
      }
      c.stroke();
      c.globalAlpha = 1;
    }

    // --- planets -------------------------------------------------------------------------------
    var list = planetListOf(run);
    var hotVisible = 0;
    var tetherPlanet = null;
    for (var pi2 = 0; pi2 < list.length; pi2++) {
      var p = list[pi2];
      if (!drawablePlanet(p)) continue;
      if (run.tether && p.id === run.tether.planetId) tetherPlanet = p;
      var py = H - (p.y - camY);
      var box = (p.ring ? p.R * 1.75 : p.R) + 12;
      if (py + box < vy0 || py - box > vy1) continue;
      var px = planetXAt(p, simT);
      var fa = fogAlpha(p.y);
      if (fa <= 0.01) continue;
      if (p.drifting) {
        for (var dtI = 1; dtI <= 3; dtI++) {
          var trailX = planetXAt(p, simT - dtI * 0.12);
          c.globalAlpha = fa * (0.22 - dtI * 0.06);
          c.fillStyle = rgba(textCol);
          c.beginPath();
          c.arc(trailX, py, 2.2, 0, TAU);
          c.fill();
        }
      }
      if (p.hot) {
        hotVisible++;
        var pulse = 1 + 0.075 * (1 + Math.sin(t * TAU * 1.5));
        stampGlow(c, px, py, p.R * 2.6 * pulse, theme.hot, 0.55 * fa);
      }
      var spr = planetSprite(p);
      c.globalAlpha = fa;
      c.drawImage(spr.canvas, px - spr.half, py - spr.half, spr.half * 2, spr.half * 2);
    }
    c.globalAlpha = 1;
    if (hotVisible && state !== 'DEAD') {
      emberAcc += 6 * dt * hotVisible;
      while (emberAcc >= 1) {
        emberAcc -= 1;
        var hp = pickVisibleHot(list, camY, H, frameIndex + (emberAcc * 97 | 0));
        if (hp) {
          var ea = noise(frameIndex * 7 + 3) * TAU;
          var ex = planetXAt(hp, simT) + Math.cos(ea) * (hp.R + 2), ey = hp.y + Math.sin(ea) * (hp.R + 2);
          spawn('embers', ex, ey, { count: 1, dir: [-Math.cos(ea), -Math.sin(ea)] });
        }
      }
    }

    // --- tether -----------------------------------------------------------------------------------
    var tethered = (state === 'TETHERED' || state === 'TITLE_ORBIT' || state === 'READY_ORBIT') && run.tether && tetherPlanet;
    var heatCol = heatColor(heat);
    if (tethered) {
      var tpx = planetXAt(tetherPlanet, simT), tpy = H - (tetherPlanet.y - camY);
      var w = C.V_ORBIT / Math.max(1, num(run.tether.r, 120));
      var sag = 6 * clamp(1 - (w - 1.4) / 5.6, 0, 1);
      var ddx = tpx - cp[0], ddy = tpy - cometSy, dl = Math.hypot(ddx, ddy) || 1;
      var nxp = -ddy / dl * (run.tether.s > 0 ? 1 : -1), nyp = ddx / dl * (run.tether.s > 0 ? 1 : -1);
      var mx = (cp[0] + tpx) / 2 + nxp * sag, my = (cometSy + tpy) / 2 + nyp * sag;
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.strokeStyle = heatCol;
      c.beginPath();
      c.moveTo(cp[0], cometSy);
      c.quadraticCurveTo(mx, my, tpx, tpy);
      c.stroke();
      var stamps = Math.max(1, Math.floor(dl / 24));
      for (var sI = 0; sI <= stamps; sI++) {
        var u = sI / stamps, iu = 1 - u;
        var qx = iu * iu * cp[0] + 2 * iu * u * mx + u * u * tpx;
        var qy = iu * iu * cometSy + 2 * iu * u * my + u * u * tpy;
        stampGlow(c, qx, qy, 18 + heat * 10, heatCol, 0.35);
      }
      // aim guide
      if (frame.showAimGuide !== false && state === 'TETHERED') {
        var boost = 1 + C.HOT_BOOST * heat;
        var avx = num(run.comet.vx, 0) * boost, avy = num(run.comet.vy, 0) * boost;
        c.fillStyle = rgba(textCol, 0.35);
        for (var gI = 1; gI <= 10; gI++) {
          var tt = gI * 0.035;
          var gxp = cp[0] + avx * tt, gyp = cp[1] + avy * tt - 0.5 * C.GRAVITY * tt * tt;
          c.beginPath();
          c.arc(gxp, H - (gyp - camY), 2.4, 0, TAU);
          c.fill();
        }
      }
    }

    // --- reticle ------------------------------------------------------------------------------------
    var target = frame.target;
    if (frame.showReticle !== false && target && drawablePlanet(target.planet) && state === 'FLIGHT') {
      var tp = target.planet;
      var tcx = num(target.cx, planetXAt(tp, simT)), tcy = H - (num(target.cy, tp.y) - camY);
      var col = RETICLE[target.color] || RETICLE.green;
      var approach = clamp(num(target.d, 300) / 300, 0.35, 1);
      var bs = tp.R + 8 + 10 * approach, arm = 8 + 6 * approach;
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.lineCap = 'round';
      c.beginPath();
      for (var cI = 0; cI < 4; cI++) {
        var sxs = cI % 2 === 0 ? -1 : 1, sys = cI < 2 ? -1 : 1;
        c.moveTo(tcx + sxs * bs, tcy + sys * (bs - arm));
        c.lineTo(tcx + sxs * bs, tcy + sys * bs);
        c.lineTo(tcx + sxs * (bs - arm), tcy + sys * bs);
      }
      c.stroke();
      c.globalAlpha = 0.6;
      c.lineWidth = 1.5;
      c.setLineDash(target.color === 'red' ? [] : [6, 8]);
      c.beginPath();
      c.arc(tcx, tcy, Math.max(1, num(target.d, 1)), 0, TAU);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }

    // --- comet trail ----------------------------------------------------------------------------------
    drawTrail(c, camY, heat, t);

    // --- comet core + glow + squash ---------------------------------------------------------------------
    if (state !== 'DEAD') {
      var skinCore = skin.core ? skin.core : rgba(lighten(skinRgb(skin, 1, heat, t), 0.1));
      var glowCol = skin.core && skin.edge ? skin.edge : rgba(skinRgb(skin, 1, heat, t));
      stampGlow(c, cp[0], cometSy, 48 + heat * 16, glowCol, 0.9);
      c.save();
      c.translate(cp[0], cometSy);
      if (state === 'FLIGHT') {
        var vxs = num(run.comet.vx, 0), vys = -num(run.comet.vy, 0);
        if (Math.hypot(vxs, vys) > 20) { c.rotate(Math.atan2(vys, vxs)); c.scale(1.15, 0.87); }
      }
      var R0 = C.COMET_R;
      var cg2 = c.createRadialGradient(-R0 * 0.25, -R0 * 0.25, 0, 0, 0, R0);
      if (skin.core && skin.edge) {
        cg2.addColorStop(0, skin.core); cg2.addColorStop(0.7, skin.core); cg2.addColorStop(1, skin.edge);
      } else {
        cg2.addColorStop(0, '#ffffff'); cg2.addColorStop(0.45, rgba(lighten(skinRgb(skin, 1, heat, t), 0.35))); cg2.addColorStop(1, skinCore);
      }
      c.fillStyle = cg2;
      c.beginPath();
      c.arc(0, 0, R0, 0, TAU);
      c.fill();
      if (skin.edge) { c.lineWidth = 1.5; c.strokeStyle = skin.edge; c.stroke(); }
      c.restore();
      if (fx.fringeFrames > 0) {
        fx.fringeFrames--;
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = 0.6;
        c.fillStyle = '#ff2a3c';
        c.beginPath(); c.arc(cp[0] - 2, cometSy, R0, 0, TAU); c.fill();
        c.fillStyle = '#2af0ff';
        c.beginPath(); c.arc(cp[0] + 2, cometSy, R0, 0, TAU); c.fill();
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      }
      // heat arc
      if (heat > 0.005) {
        c.lineWidth = 3;
        c.lineCap = 'butt';
        c.strokeStyle = heatCol;
        c.beginPath();
        c.arc(cp[0], cometSy, 16, -Math.PI / 2, -Math.PI / 2 + heat * TAU);
        c.stroke();
        var tickA = -Math.PI / 2 + C.HOT_SHOT_HEAT * TAU;
        c.lineWidth = 2;
        c.strokeStyle = '#ffffff';
        c.beginPath();
        c.moveTo(cp[0] + Math.cos(tickA) * 13, cometSy + Math.sin(tickA) * 13);
        c.lineTo(cp[0] + Math.cos(tickA) * 20, cometSy + Math.sin(tickA) * 20);
        c.stroke();
      }
      // heat embers streaming backward
      if (heat > 0.3 && (state === 'TETHERED' || state === 'FLIGHT')) {
        heatEmberAcc += heat * 20 * dt;
        var bvx = num(run.comet.vx, 0), bvy = num(run.comet.vy, 0), bl = Math.hypot(bvx, bvy) || 1;
        while (heatEmberAcc >= 1) {
          heatEmberAcc -= 1;
          spawn('embers', cp[0] - bvx / bl * 6, cp[1] - bvy / bl * 6, { count: 1, dir: [bvx / bl, bvy / bl], color: heatCol });
        }
      } else {
        heatEmberAcc = 0;
      }
    }

    // --- particles / floating text ---------------------------------------------------------------------
    drawParticles(c, camY);
    drawFloats(c, dt, camY);

    // --- HUD -------------------------------------------------------------------------------------------
    applyBaseTransform();
    if (frame.hud) drawHud(run, frame, frame.hud, cp, cometSy, t, M, pool, state);

    // --- vignette / flash --------------------------------------------------------------------------------
    var vig = Math.max(num(effects.vignette, 0), heat * 0.25);
    if (vig > 0.002) {
      var vk = vis.x0 + '_' + vis.y0 + '_' + vis.x1 + '_' + vis.y1;
      if (!vignetteGrad || vignetteKey !== vk) {
        var vcx = (vis.x0 + vis.x1) / 2, vcy = (vis.y0 + vis.y1) / 2;
        var vr = Math.hypot(vis.x1 - vis.x0, vis.y1 - vis.y0) / 2;
        vignetteGrad = c.createRadialGradient(vcx, vcy, vr * 0.45, vcx, vcy, vr);
        vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
        vignetteGrad.addColorStop(1, 'rgba(0,0,0,1)');
        vignetteKey = vk;
      }
      c.globalAlpha = clamp(vig, 0, 1);
      c.fillStyle = vignetteGrad;
      c.fillRect(vis.x0, vis.y0, vis.x1 - vis.x0, vis.y1 - vis.y0);
      c.globalAlpha = 1;
    }
    var flashA = num(effects.flash, 0);
    if (fx.flashFrames > 0) { fx.flashFrames--; flashA = Math.max(flashA, 0.85); }
    if (flashA > 0.002) {
      c.globalAlpha = clamp(flashA, 0, 1);
      c.fillStyle = '#ffffff';
      c.fillRect(vis.x0, vis.y0, vis.x1 - vis.x0, vis.y1 - vis.y0);
      c.globalAlpha = 1;
    }
  }

  function pickVisibleHot(list, camY, H, salt) {
    var hot = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && p.hot && p.y > camY - 50 && p.y < camY + H + 50) hot.push(p);
    }
    if (!hot.length) return null;
    return hot[Math.floor(noise(salt) * hot.length) % hot.length];
  }

  /** Comet trail in the skin's style (ribbon / beads / sparks / jagged), 'lighter' unless the skin has a solid core. */
  function drawTrail(c, camY, heat, t) {
    var n = trail.length;
    if (n < 2) return;
    var H = cfg().VIEW_H;
    var width = clamp(Math.abs(num(skin.width, 8)), 1, 64);
    var solid = !!(skin.core && skin.edge);
    var glowOn = QUALITY[qualityLevel].glow;
    c.globalCompositeOperation = solid || !glowOn ? 'source-over' : 'lighter';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    var style = skin.style || 'ribbon';
    var i, u, sx, sy, px, py;
    if (style === 'beads') {
      for (i = 0; i < n; i += 2) {
        u = i / (n - 1);
        sx = trail[i].x; sy = H - (trail[i].y - camY);
        c.globalAlpha = 0.15 + 0.75 * u;
        c.fillStyle = rgba(skinRgb(skin, u, trail[i].heat, t));
        c.beginPath();
        c.arc(sx, sy, 1 + (width * 0.6) * u, 0, TAU);
        c.fill();
      }
    } else if (style === 'sparks') {
      for (i = 1; i < n; i++) {
        u = i / (n - 1);
        sx = trail[i].x; sy = H - (trail[i].y - camY);
        px = trail[i - 1].x; py = H - (trail[i - 1].y - camY);
        var dx = sx - px, dy = sy - py, dl = Math.hypot(dx, dy) || 1;
        var j1 = (noise(i * 3 + frameIndex) - 0.5) * width * 1.2, j2 = (noise(i * 3 + frameIndex + 1) - 0.5) * width * 1.2;
        var len = (4 + noise(i + frameIndex * 5) * 10) * (0.3 + 0.7 * u);
        c.globalAlpha = 0.25 + 0.7 * u;
        c.strokeStyle = rgba(skinRgb(skin, u, trail[i].heat, t));
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(sx + j1 - dx / dl * len, sy + j2 - dy / dl * len);
        c.lineTo(sx + j1, sy + j2);
        c.stroke();
        if (i % 5 === 0) {
          c.fillStyle = '#ffffff';
          c.beginPath(); c.arc(sx + j2, sy + j1, 1.2, 0, TAU); c.fill();
        }
      }
    } else if (style === 'jagged') {
      c.lineWidth = 2;
      for (var pass = 0; pass < 2; pass++) {
        c.strokeStyle = rgba(skinRgb(skin, pass ? 0 : 1, heat, t));
        c.globalAlpha = pass ? 0.5 : 0.9;
        c.beginPath();
        for (i = 0; i < n; i++) {
          u = i / (n - 1);
          sx = trail[i].x; sy = H - (trail[i].y - camY);
          var k = (noise(i * 7 + (frameIndex >> 1) + pass * 999) - 0.5) * width * (pass ? -1 : 1) * (0.3 + 0.7 * u);
          var ox = i > 0 ? sy - (H - (trail[i - 1].y - camY)) : 0, oy = i > 0 ? -(sx - trail[i - 1].x) : 0;
          var ol = Math.hypot(ox, oy) || 1;
          if (i === 0) c.moveTo(sx, sy); else c.lineTo(sx + ox / ol * k, sy + oy / ol * k);
        }
        c.stroke();
      }
    } else {
      // ribbon: tapered polyline segments, colour lerps hueB → hueA tail → head.
      // Butt caps: round caps would overlap at every joint and bead in lighter mode.
      c.lineCap = 'butt';
      var passes = skin.offset ? 2 : 1;
      for (var ps = 0; ps < passes; ps++) {
        var off = skin.offset ? (ps === 0 ? -3 : 3) : 0;
        for (i = 1; i < n; i++) {
          u = i / (n - 1);
          sx = trail[i].x + off; sy = H - (trail[i].y - camY);
          px = trail[i - 1].x + off; py = H - (trail[i - 1].y - camY);
          var col = skin.offset ? hslToRgb(ps === 0 ? num(skin.hueA, 0) : num(skin.hueB, 0), 0.9, 0.6) : skinRgb(skin, u, trail[i].heat, t);
          if (solid) {
            c.globalAlpha = 0.25 + 0.7 * u;
            c.lineWidth = lerp(1, width, u) + 2;
            c.strokeStyle = skin.edge;
            c.beginPath(); c.moveTo(px, py); c.lineTo(sx, sy); c.stroke();
            c.strokeStyle = skin.core;
          } else {
            c.strokeStyle = rgba(col);
            c.globalAlpha = (0.2 + 0.75 * u) / passes;
          }
          c.lineWidth = lerp(1, width, u);
          c.beginPath(); c.moveTo(px, py); c.lineTo(sx, sy); c.stroke();
        }
        c.fillStyle = c.strokeStyle;
        c.beginPath(); c.arc(sx, sy, c.lineWidth / 2, 0, TAU); c.fill();
      }
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                   */
  /* ------------------------------------------------------------------ */

  function safeInsets() {
    var sa = G.sdk && G.sdk.safeArea;
    if (typeof sa === 'function') sa = sa();
    sa = sa || {};
    var s = view.scale || 1;
    return { top: num(sa.top, 0) / s, right: num(sa.right, 0) / s, bottom: num(sa.bottom, 0) / s, left: num(sa.left, 0) / s };
  }

  function mTierColor(M) {
    return M_TIERS[clamp(Math.floor(num(M, 1) + 1e-6) - 1, 0, M_TIERS.length - 1)];
  }

  function drawHud(run, frame, hud, cp, cometSy, t, M, pool, state) {
    var c = ctx, C = cfg(), W = C.COL_W, H = C.VIEW_H;
    var vis = view.visible, ins = safeInsets();
    var textCol = theme.text;
    var top = Math.max(0, vis.y0 + ins.top);
    var leftPanelW = -vis.x0 - ins.left, rightPanelW = vis.x1 - W - ins.right;
    var sidePanels = view.landscape && leftPanelW >= 200 && rightPanelW >= 200;
    var score = num(hud.score, run.score ? num(run.score.alt, 0) + num(run.score.banked, 0) : 0);
    var alt = num(hud.alt, run.score ? num(run.score.alt, 0) : 0);
    var banked = num(hud.banked, run.score ? num(run.score.banked, 0) : 0);
    var hudM = num(hud.M, M), hudPool = num(hud.pool, pool);

    // pause button (top-left of the safe zone, 44 px)
    var pr = hudRects.pause;
    pr.w = 44; pr.h = 44; pr.x = Math.max(12, ins.left + 12); pr.y = top + 12;
    if (sidePanels) pr.x = vis.x0 + ins.left + 32;
    uiRoundRect(pr.x, pr.y, pr.w, pr.h, 12);
    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = rgba(parseColor(textCol), 0.35);
    c.stroke();
    uiIcon('pause', pr.x + pr.w / 2, pr.y + pr.h / 2, 20, textCol);

    // score block
    var scoreX, scoreY, align;
    if (sidePanels) { scoreX = -32 - ins.left; scoreY = top + 60; align = 'right'; }
    else { scoreX = W / 2; scoreY = top + 24; align = 'center'; }
    var scoreStr = fmt(score);
    uiText(scoreStr, scoreX, scoreY, { size: 56, weight: 800, align: align, baseline: 'top', color: textCol, halo: true, spacing: 0.04 });
    var sm = uiMeasure(scoreStr, 56, 800);
    var altLabel = tr('alt', 'ALT').toUpperCase() + ' ' + fmt(alt) + ' m';
    var styleLabel = tr('style', 'STYLE').toUpperCase() + ' ' + fmt(banked);
    var labelsW = uiMeasure(altLabel, 12, 600, 0.06).width + uiMeasure(styleLabel, 12, 600, 0.06).width + 24;
    var barW = clamp(Math.max(sm.width, labelsW), 170, 260), barY = scoreY + 64;
    var barX = align === 'center' ? scoreX - barW / 2 : scoreX - barW;
    var total = Math.max(1, alt + banked);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    uiRoundRect(barX, barY, barW, 4, 2); c.fill();
    c.fillStyle = rgba(parseColor(textCol), 0.85);
    uiRoundRect(barX, barY, barW * (alt / total), 4, 2); c.fill();
    if (banked > 0) {
      c.fillStyle = skinMainColor(skin);
      uiRoundRect(barX + barW * (alt / total), barY, barW * (banked / total), 4, 2); c.fill();
    }
    uiText(altLabel, barX, barY + 10, { size: 12, weight: 600, align: 'left', baseline: 'top', color: rgba(parseColor(textCol), 0.7), spacing: 0.06 });
    uiText(styleLabel, barX + barW, barY + 10, { size: 12, weight: 600, align: 'right', baseline: 'top', color: rgba(parseColor(textCol), 0.7), spacing: 0.06 });

    // M pill under the score
    var chipY = barY + 32;
    if (hudM > 1.001 || hudPool > 0) {
      var mLabel = 'x' + hudM.toFixed(1);
      var mw = uiMeasure(mLabel, 16, 800).width + 22;
      var mx = align === 'center' ? scoreX - mw / 2 : scoreX - mw;
      var mcol = mTierColor(hudM);
      uiRoundRect(mx, chipY, mw, 26, 13);
      c.fillStyle = rgba(parseColor(mcol), 0.18); c.fill();
      c.lineWidth = 1.5; c.strokeStyle = mcol; c.stroke();
      uiText(mLabel, mx + mw / 2, chipY + 13, { size: 16, weight: 800, align: 'center', baseline: 'middle', color: mcol, spacing: 0.04 });
      chipY += 34;
    }

    // duel chip while below the line
    var duelName = hud.duelName || (frame.duel && frame.duel.name) || (run.duel && run.duel.name);
    var chipX = sidePanels ? W + 32 + ins.right : scoreX, chipAlign = sidePanels ? 'left' : align, cy2 = sidePanels ? top + 60 : chipY;
    if (duelName && run.duel && !run.lineCrossed) {
      var dScore = num(hud.duelScore, num(run.duel.score, 0));
      var dLabel = String(duelName).toUpperCase() + ' ' + fmt(dScore);
      var dw = uiMeasure(dLabel, 14, 600).width + 44;
      var dx = chipAlign === 'center' ? chipX - dw / 2 : chipAlign === 'right' ? chipX - dw : chipX;
      uiRoundRect(dx, cy2, dw, 28, 14);
      c.fillStyle = 'rgba(255,90,106,0.18)'; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = '#ff5a6a'; c.stroke();
      c.fillStyle = '#ff5a6a';
      c.beginPath(); c.arc(dx + 16, cy2 + 14, 9, 0, TAU); c.fill();
      uiText(String(duelName).charAt(0).toUpperCase(), dx + 16, cy2 + 14, { size: 12, weight: 800, align: 'center', baseline: 'middle', color: '#1a0a0e' });
      uiText(dLabel, dx + 32, cy2 + 14, { size: 14, weight: 600, align: 'left', baseline: 'middle', color: textCol, spacing: 0.06 });
      cy2 += 36;
    }
    if (sidePanels) {
      if (hud.dailyNumber !== undefined && hud.dailyNumber !== null) {
        uiText(tr('dailyNumber', 'Daily #{n}', { n: hud.dailyNumber }), chipX, cy2, { size: 16, weight: 600, align: 'left', baseline: 'top', color: rgba(parseColor(textCol), 0.85), spacing: 0.06 });
        cy2 += 26;
      }
      if (frame.bestAltM) {
        uiText(tr('best', 'BEST').toUpperCase() + ' ' + fmt(frame.bestAltM) + ' m', chipX, cy2, { size: 16, weight: 600, align: 'left', baseline: 'top', color: rgba(parseColor(textCol), 0.7), spacing: 0.06 });
        cy2 += 26;
      }
      if (hud.missionText) {
        uiText(String(hud.missionText), chipX, cy2, { size: 14, weight: 600, align: 'left', baseline: 'top', color: rgba(parseColor(textCol), 0.7), maxWidth: rightPanelW - 48 });
      }
    }

    // pool label beside the comet
    if (hudPool > 0 && state !== 'DEAD') {
      var rate = 1 + 2 * clamp(hudPool / 300, 0, 1);
      var pulse = 1 + 0.08 * Math.sin(t * TAU * rate);
      var side = cp[0] < W / 2 ? 1 : -1;
      var lx = cp[0] + side * 26, ly = cometSy - 6;
      var label = '+' + fmt(hudPool) + ' x' + hudM.toFixed(1);
      c.save();
      c.translate(lx, ly);
      c.scale(pulse, pulse);
      uiText(label, 0, 0, { size: 18, weight: 800, align: side > 0 ? 'left' : 'right', baseline: 'middle', color: mTierColor(hudM), halo: true, spacing: 0.04 });
      c.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI primitive kit                                                      */
  /* ------------------------------------------------------------------ */

  function fontStr(size, weight) { return (weight || 600) + ' ' + Math.max(1, num(size, 16)) + 'px ' + FONT; }

  /** Adds a rounded-rect path (begins a new path). */
  function uiRoundRect(x, y, w, h, r) {
    var c = ctx;
    r = Math.max(0, Math.min(num(r, 14), Math.abs(w) / 2, Math.abs(h) / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  var supportsLetterSpacing = null;
  function letterSpacingSupported() {
    if (supportsLetterSpacing === null) supportsLetterSpacing = !!(ctx && 'letterSpacing' in ctx);
    return supportsLetterSpacing;
  }

  /**
   * Measures a string.
   * @returns {{width:number, height:number}}
   */
  function uiMeasure(str, size, weight, spacing) {
    if (!ctx) return { width: 0, height: num(size, 16) };
    str = String(str == null ? '' : str);
    size = num(size, 16);
    var c = ctx;
    c.font = fontStr(size, weight || 600);
    var w = c.measureText(str).width;
    var sp = num(spacing, 0) * size;
    if (sp && str.length > 1) w += sp * (str.length - 1);
    return { width: w, height: size * 1.2 };
  }

  /**
   * Draws text. opts: size, weight, align ('left'|'center'|'right'), baseline, color,
   * halo (glow halo behind, for big numbers), maxWidth (shrinks the font to fit),
   * spacing (letter spacing in em; manual fallback when ctx.letterSpacing is missing).
   */
  function uiText(str, x, y, opts) {
    if (!ctx) return;
    opts = opts || {};
    var c = ctx;
    str = String(str == null ? '' : str);
    var size = num(opts.size, 16), weight = opts.weight || 600;
    var spacing = num(opts.spacing, 0);
    if (opts.maxWidth > 0) {
      var m = uiMeasure(str, size, weight, spacing);
      if (m.width > opts.maxWidth) size = Math.max(8, size * opts.maxWidth / m.width);
    }
    c.font = fontStr(size, weight);
    c.textBaseline = opts.baseline || 'alphabetic';
    var color = opts.color || theme.text;
    var align = opts.align || 'left';
    var manual = spacing > 0 && !letterSpacingSupported() && str.length > 1;
    var width = uiMeasure(str, size, weight, spacing).width;
    if (opts.halo) {
      var hx = align === 'center' ? x : align === 'right' ? x - width / 2 : x + width / 2;
      var hy = c.textBaseline === 'top' ? y + size * 0.55 : c.textBaseline === 'bottom' ? y - size * 0.45 : c.textBaseline === 'middle' ? y : y - size * 0.35;
      var prevA = c.globalAlpha;
      stampGlow(c, hx, hy, Math.max(width, size) * 1.5 + size, color, 0.28 * prevA);
      c.globalAlpha = prevA;
      c.save();
      c.translate(hx, hy);
      c.scale(1.06, 1.06);
      c.translate(-hx, -hy);
      c.globalAlpha = 0.22 * prevA;
      c.fillStyle = color;
      drawRawText(c, str, x, y, align, size, spacing, manual, width);
      c.restore();
      c.globalAlpha = prevA;
    }
    c.fillStyle = color;
    drawRawText(c, str, x, y, align, size, spacing, manual, width);
    if (letterSpacingSupported()) c.letterSpacing = '0px';
  }

  function drawRawText(c, str, x, y, align, size, spacing, manual, width) {
    if (manual) {
      var sx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
      c.textAlign = 'left';
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        c.fillText(ch, sx, y);
        sx += c.measureText(ch).width + spacing * size;
      }
      return;
    }
    if (letterSpacingSupported()) c.letterSpacing = (spacing * size) + 'px';
    c.textAlign = align;
    var ax = x;
    if (spacing > 0 && letterSpacingSupported() && align !== 'left') {
      // letterSpacing adds trailing space after the last glyph; re-centre.
      ax = align === 'center' ? x + spacing * size / 2 : x + spacing * size;
    }
    c.fillText(str, ax, y);
  }

  /** Draws a translucent dark panel with a hairline stroke. opts: radius, alpha, stroke. */
  function uiPanel(rect, opts) {
    if (!ctx) return rect;
    opts = opts || {};
    var c = ctx;
    uiRoundRect(rect.x, rect.y, rect.w, rect.h, num(opts.radius, 20));
    c.fillStyle = opts.fill || 'rgba(6,8,20,' + num(opts.alpha, 0.82) + ')';
    c.fill();
    if (opts.stroke !== false) {
      c.lineWidth = 1;
      c.strokeStyle = opts.stroke || rgba(parseColor(theme.text), 0.18);
      c.stroke();
    }
    return rect;
  }

  /**
   * Draws a button (14 px radius, 2 px stroke in the theme text colour, filled when
   * primary / pressed). opts: icon, primary, disabled, pressed, small, color.
   * @returns {Object} the rect (for hit testing)
   */
  function uiButton(rect, label, opts) {
    if (!ctx) return rect;
    opts = opts || {};
    var c = ctx;
    var textCol = parseColor(opts.color || theme.text);
    var prevA = c.globalAlpha;
    if (opts.disabled) c.globalAlpha = prevA * 0.4;
    uiRoundRect(rect.x, rect.y, rect.w, rect.h, 14);
    var fg = rgba(textCol), bg = 'rgba(10,12,28,0.92)';
    if (opts.primary) { c.fillStyle = opts.pressed ? rgba(lighten(textCol, 0.2)) : fg; fg = bg; }
    else c.fillStyle = opts.pressed ? rgba(textCol, 0.25) : 'rgba(10,12,28,0.55)';
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = rgba(textCol);
    c.stroke();
    var size = opts.small ? 14 : 18;
    label = String(label == null ? '' : label);
    var tw = label ? uiMeasure(label, size, 600, 0.06).width : 0;
    var iconSize = opts.small ? 18 : 22, gap = label && opts.icon ? 10 : 0;
    var total = tw + (opts.icon ? iconSize + gap : 0);
    var startX = rect.x + rect.w / 2 - total / 2;
    var cy = rect.y + rect.h / 2;
    if (opts.icon) {
      uiIcon(opts.icon, startX + iconSize / 2, cy, iconSize, fg);
      startX += iconSize + gap;
    }
    if (label) uiText(label, startX, cy, { size: size, weight: 600, align: 'left', baseline: 'middle', color: fg, spacing: 0.06, maxWidth: rect.w - 24 - (opts.icon ? iconSize + gap : 0) });
    c.globalAlpha = prevA;
    return rect;
  }

  /** Toggle row: label on the left, pill switch on the right. @returns {Object} rect */
  function uiToggle(rect, on, label) {
    if (!ctx) return rect;
    var c = ctx;
    var textCol = theme.text;
    var cy = rect.y + rect.h / 2;
    if (label) uiText(label, rect.x + 4, cy, { size: 18, weight: 600, align: 'left', baseline: 'middle', color: textCol, maxWidth: rect.w - 80 });
    var pw = 52, ph = 30, px = rect.x + rect.w - pw - 4, py = cy - ph / 2;
    uiRoundRect(px, py, pw, ph, ph / 2);
    c.fillStyle = on ? rgba(parseColor(theme.tether), 0.85) : 'rgba(255,255,255,0.14)';
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = rgba(parseColor(textCol), on ? 0.9 : 0.35);
    c.stroke();
    c.fillStyle = on ? '#0a0c1c' : rgba(parseColor(textCol), 0.9);
    c.beginPath();
    c.arc(on ? px + pw - ph / 2 : px + ph / 2, cy, ph / 2 - 4, 0, TAU);
    c.fill();
    return rect;
  }

  /** Progress ring: background track + arc from 12 o'clock for frac of a turn. */
  function uiRing(x, y, r, frac, color, width) {
    if (!ctx) return;
    var c = ctx;
    r = Math.max(0, num(r, 0));
    width = Math.max(0.5, num(width, 4));
    c.lineWidth = width;
    c.lineCap = 'round';
    c.strokeStyle = rgba(parseColor(color || theme.text), 0.2);
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke();
    frac = clamp(num(frac, 0), 0, 1);
    if (frac > 0) {
      c.strokeStyle = color || theme.text;
      c.beginPath(); c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + frac * TAU); c.stroke();
    }
  }

  var ICON_NAMES = ['play', 'skins', 'missions', 'daily', 'share', 'support', 'settings', 'mute', 'unmute', 'pause', 'home', 'back', 'close',
    'rewind', 'dust', 'check', 'lock', 'trophy', 'flame', 'loop', 'gear', 'globe', 'copy', 'telegram'];

  /**
   * Draws an icon by path commands, centred on (x, y) in a `size` box.
   * @param {string} name one of ICON_NAMES
   */
  function uiIcon(name, x, y, size, color) {
    if (!ctx) return;
    var c = ctx;
    var s = Math.abs(num(size, 24)) / 2;
    c.save();
    c.translate(x, y);
    c.lineWidth = Math.max(1.5, s * 0.22);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = color || theme.text;
    c.fillStyle = color || theme.text;
    var i, a;
    switch (name) {
      case 'play':
        c.beginPath(); c.moveTo(-s * 0.6, -s * 0.8); c.lineTo(s * 0.85, 0); c.lineTo(-s * 0.6, s * 0.8); c.closePath(); c.fill();
        break;
      case 'skins':
        for (i = 0; i < 3; i++) {
          a = -Math.PI / 2 + i * TAU / 3;
          c.globalAlpha = 0.55 + 0.45 * (i === 0 ? 1 : 0);
          c.beginPath(); c.arc(Math.cos(a) * s * 0.42, Math.sin(a) * s * 0.42, s * 0.45, 0, TAU); c.fill();
        }
        c.globalAlpha = 1;
        break;
      case 'missions':
        c.beginPath(); c.arc(0, 0, s * 0.9, 0, TAU); c.stroke();
        c.beginPath(); c.arc(0, 0, s * 0.5, 0, TAU); c.stroke();
        c.beginPath(); c.arc(0, 0, s * 0.15, 0, TAU); c.fill();
        break;
      case 'daily':
        uiRoundRect(-s * 0.85, -s * 0.7, s * 1.7, s * 1.5, s * 0.2); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.85, -s * 0.25); c.lineTo(s * 0.85, -s * 0.25); c.stroke();
        for (i = 0; i < 6; i++) {
          c.beginPath(); c.arc(-s * 0.5 + (i % 3) * s * 0.5, s * 0.1 + Math.floor(i / 3) * s * 0.4, s * 0.1, 0, TAU); c.fill();
        }
        c.beginPath(); c.moveTo(-s * 0.4, -s * 0.95); c.lineTo(-s * 0.4, -s * 0.5); c.moveTo(s * 0.4, -s * 0.95); c.lineTo(s * 0.4, -s * 0.5); c.stroke();
        break;
      case 'share':
        c.beginPath(); c.moveTo(0, s * 0.35); c.lineTo(0, -s * 0.9); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.45, -s * 0.45); c.lineTo(0, -s * 0.9); c.lineTo(s * 0.45, -s * 0.45); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.7, -s * 0.1); c.lineTo(-s * 0.7, s * 0.85); c.lineTo(s * 0.7, s * 0.85); c.lineTo(s * 0.7, -s * 0.1); c.stroke();
        break;
      case 'support':
        c.beginPath(); c.moveTo(0, s * 0.8);
        c.bezierCurveTo(-s * 1.4, -s * 0.2, -s * 0.5, -s * 1.1, 0, -s * 0.35);
        c.bezierCurveTo(s * 0.5, -s * 1.1, s * 1.4, -s * 0.2, 0, s * 0.8); c.closePath(); c.fill();
        break;
      case 'settings':
      case 'gear':
        c.beginPath();
        for (i = 0; i < 16; i++) {
          a = i * TAU / 16;
          var rr = i % 2 === 0 ? s * 0.95 : s * 0.68;
          if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        c.closePath(); c.fill();
        c.globalCompositeOperation = 'destination-out';
        c.beginPath(); c.arc(0, 0, s * 0.3, 0, TAU); c.fill();
        c.globalCompositeOperation = 'source-over';
        break;
      case 'mute':
      case 'unmute':
        c.beginPath(); c.moveTo(-s * 0.9, -s * 0.35); c.lineTo(-s * 0.4, -s * 0.35); c.lineTo(s * 0.1, -s * 0.85); c.lineTo(s * 0.1, s * 0.85); c.lineTo(-s * 0.4, s * 0.35); c.lineTo(-s * 0.9, s * 0.35); c.closePath(); c.fill();
        if (name === 'unmute') {
          c.beginPath(); c.arc(s * 0.1, 0, s * 0.55, -0.9, 0.9); c.stroke();
          c.beginPath(); c.arc(s * 0.1, 0, s * 0.9, -0.9, 0.9); c.stroke();
        } else {
          c.beginPath(); c.moveTo(s * 0.4, -s * 0.4); c.lineTo(s * 0.95, s * 0.4); c.moveTo(s * 0.95, -s * 0.4); c.lineTo(s * 0.4, s * 0.4); c.stroke();
        }
        break;
      case 'pause':
        uiRoundRect(-s * 0.7, -s * 0.8, s * 0.45, s * 1.6, s * 0.12); c.fill();
        uiRoundRect(s * 0.25, -s * 0.8, s * 0.45, s * 1.6, s * 0.12); c.fill();
        break;
      case 'home':
        c.beginPath(); c.moveTo(-s * 0.95, 0); c.lineTo(0, -s * 0.9); c.lineTo(s * 0.95, 0); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.65, -s * 0.15); c.lineTo(-s * 0.65, s * 0.85); c.lineTo(s * 0.65, s * 0.85); c.lineTo(s * 0.65, -s * 0.15); c.stroke();
        break;
      case 'back':
        c.beginPath(); c.moveTo(s * 0.7, 0); c.lineTo(-s * 0.7, 0); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.1, -s * 0.65); c.lineTo(-s * 0.75, 0); c.lineTo(-s * 0.1, s * 0.65); c.stroke();
        break;
      case 'close':
        c.beginPath(); c.moveTo(-s * 0.7, -s * 0.7); c.lineTo(s * 0.7, s * 0.7); c.moveTo(s * 0.7, -s * 0.7); c.lineTo(-s * 0.7, s * 0.7); c.stroke();
        break;
      case 'rewind':
        c.beginPath(); c.arc(0, 0, s * 0.8, -Math.PI * 0.35, Math.PI * 1.35); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.95, -s * 0.9); c.lineTo(-s * 0.55, -s * 0.2); c.lineTo(-s * 1.0, -s * 0.05); c.closePath(); c.fill();
        break;
      case 'dust':
        for (i = 0; i < 5; i++) {
          a = i * TAU / 5 - Math.PI / 2;
          c.beginPath(); c.arc(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.55, s * (0.14 + 0.06 * (i % 2)), 0, TAU); c.fill();
        }
        c.beginPath(); c.arc(0, 0, s * 0.3, 0, TAU); c.fill();
        break;
      case 'check':
        c.beginPath(); c.moveTo(-s * 0.8, 0); c.lineTo(-s * 0.2, s * 0.6); c.lineTo(s * 0.85, -s * 0.6); c.stroke();
        break;
      case 'lock':
        uiRoundRect(-s * 0.7, -s * 0.1, s * 1.4, s * 1.0, s * 0.18); c.fill();
        c.beginPath(); c.arc(0, -s * 0.3, s * 0.45, Math.PI, TAU); c.stroke();
        break;
      case 'trophy':
        c.beginPath(); c.moveTo(-s * 0.6, -s * 0.9); c.lineTo(s * 0.6, -s * 0.9); c.lineTo(s * 0.45, s * 0.05); c.quadraticCurveTo(0, s * 0.5, -s * 0.45, s * 0.05); c.closePath(); c.fill();
        c.beginPath(); c.moveTo(-s * 0.6, -s * 0.7); c.quadraticCurveTo(-s * 1.1, -s * 0.5, -s * 0.5, -s * 0.1); c.moveTo(s * 0.6, -s * 0.7); c.quadraticCurveTo(s * 1.1, -s * 0.5, s * 0.5, -s * 0.1); c.stroke();
        c.beginPath(); c.moveTo(0, s * 0.3); c.lineTo(0, s * 0.7); c.stroke();
        uiRoundRect(-s * 0.45, s * 0.65, s * 0.9, s * 0.25, s * 0.08); c.fill();
        break;
      case 'flame':
        c.beginPath(); c.moveTo(0, -s * 0.95);
        c.bezierCurveTo(s * 0.9, -s * 0.2, s * 0.8, s * 0.95, 0, s * 0.95);
        c.bezierCurveTo(-s * 0.8, s * 0.95, -s * 0.9, -s * 0.2, 0, -s * 0.95); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.35)';
        c.beginPath(); c.moveTo(0, s * 0.05); c.bezierCurveTo(s * 0.4, s * 0.35, s * 0.35, s * 0.9, 0, s * 0.9); c.bezierCurveTo(-s * 0.35, s * 0.9, -s * 0.4, s * 0.35, 0, s * 0.05); c.fill();
        break;
      case 'loop':
        c.beginPath(); c.arc(0, 0, s * 0.8, -Math.PI * 0.5, Math.PI * 1.25); c.stroke();
        c.beginPath(); c.moveTo(s * 0.05, -s * 1.05); c.lineTo(s * 0.55, -s * 0.8); c.lineTo(s * 0.05, -s * 0.45); c.closePath(); c.fill();
        break;
      case 'globe':
        c.beginPath(); c.arc(0, 0, s * 0.9, 0, TAU); c.stroke();
        c.beginPath(); c.ellipse(0, 0, s * 0.4, s * 0.9, 0, 0, TAU); c.stroke();
        c.beginPath(); c.moveTo(-s * 0.9, 0); c.lineTo(s * 0.9, 0); c.moveTo(-s * 0.75, -s * 0.45); c.lineTo(s * 0.75, -s * 0.45); c.moveTo(-s * 0.75, s * 0.45); c.lineTo(s * 0.75, s * 0.45); c.stroke();
        break;
      case 'copy':
        uiRoundRect(-s * 0.85, -s * 0.85, s * 1.1, s * 1.3, s * 0.15); c.stroke();
        uiRoundRect(-s * 0.25, -s * 0.45, s * 1.1, s * 1.3, s * 0.15); c.fill();
        break;
      case 'telegram':
        c.beginPath(); c.arc(0, 0, s * 0.95, 0, TAU); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.75)';
        c.beginPath(); c.moveTo(-s * 0.6, -s * 0.05); c.lineTo(s * 0.55, -s * 0.5); c.lineTo(s * 0.3, s * 0.5); c.lineTo(-s * 0.05, s * 0.2); c.lineTo(-s * 0.2, s * 0.45); c.lineTo(-s * 0.2, s * 0.1); c.closePath(); c.fill();
        break;
      default:
        c.beginPath(); c.arc(0, 0, s * 0.7, 0, TAU); c.stroke();
    }
    c.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Share card                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Renders the 1080x1080 share card: sky by altitude, stars, the run's
   * trajectory artwork with planets, and the name / score / label / url text.
   * @param {Object} run
   * @param {{name?:string, score?:number, altM?:number, style?:number, rankId?:string, label?:string, url?:string, beatMe?:boolean, theme?:Object, skin?:Object}} meta
   * @returns {HTMLCanvasElement}
   */
  function drawShareCard(run, meta) {
    meta = meta || {};
    run = run || {};
    var C = cfg();
    var S = 1080, MARGIN = 64;
    var cv = makeCanvas(S, S), c = cv.getContext('2d');
    var savedTheme = theme, savedSkin = skin, savedCtx = ctx, savedHeat = heatRamp;
    if (meta.theme && Array.isArray(meta.theme.skyStops)) { theme = meta.theme; heatRamp = null; }
    if (meta.skin && meta.skin.style) skin = meta.skin;
    ctx = c;
    forceGlow = true;
    try {
      var samples = [];
      if (Array.isArray(run.samples)) {
        for (var smpI = 0; smpI < run.samples.length; smpI++) {
          var smp = run.samples[smpI];
          if (smp && isFinite(smp[0]) && isFinite(smp[1])) samples.push(smp);
        }
      }
      if (samples.length < 2) samples = [[270, 120], [270, 0]];
      var yMin = Infinity, yMax = -Infinity;
      for (var i = 0; i < samples.length; i++) { if (samples[i][1] < yMin) yMin = samples[i][1]; if (samples[i][1] > yMax) yMax = samples[i][1]; }
      yMin = Math.min(yMin, -120) - 60; yMax = Math.max(yMax, yMin + 900) + 60;
      var altM = num(meta.altM, Math.floor(num(run.maxY, 0) / 10));

      // sky
      var skyB = skyColorAt(0), skyT = skyColorAt(Math.max(0, altM));
      var sg = c.createLinearGradient(0, 0, 0, S);
      sg.addColorStop(0, rgba(skyT)); sg.addColorStop(1, rgba(skyB));
      c.fillStyle = sg; c.fillRect(0, 0, S, S);
      // stars: a dedicated 2x tile set from the run seed
      var rng = mulberry32((num(run.seed, 1) >>> 0) ^ 0x51A7F1E1);
      for (var L = 0; L < STAR_LAYERS.length; L++) {
        var layer = STAR_LAYERS[L];
        for (var si = 0; si < layer.n * 2; si++) {
          var sx = rng() * S, sy = rng() * S, sz = layer.size * (0.7 + rng() * 0.6) * 1.6;
          c.fillStyle = hsl(theme.starHue + rng() * 40 - 20, theme.monochrome ? 0 : 40 + rng() * 25, 78 + rng() * 20, layer.alpha * (0.5 + rng() * 0.5));
          c.beginPath(); c.arc(sx, sy, sz / 2, 0, TAU); c.fill();
        }
      }
      // nebula glow
      var nebs = theme.nebula || THEME_DEFAULT.nebula;
      for (var nb = 0; nb < 3; nb++) {
        var ng = c.createRadialGradient(200 + nb * 340, 300 + nb * 220, 0, 200 + nb * 340, 300 + nb * 220, 420);
        ng.addColorStop(0, hsl(nebs[nb][0], nebs[nb][1], nebs[nb][2], 0.16)); ng.addColorStop(1, hsl(nebs[nb][0], nebs[nb][1], nebs[nb][2], 0));
        c.fillStyle = ng; c.fillRect(0, 0, S, S);
      }

      // trajectory artwork
      var artTop = MARGIN + 110, artBottom = S - MARGIN - 300;
      var artH = artBottom - artTop, artW = S - MARGIN * 2;
      var sc = Math.min(artW / C.COL_W, artH / (yMax - yMin));
      var ox = S / 2 - C.COL_W * sc / 2, oy = artTop + artH / 2 + (yMax - yMin) * sc / 2;
      function wx(x) { return ox + x * sc; }
      function wy(y) { return oy - (y - yMin) * sc; }
      c.save();
      c.beginPath(); c.rect(MARGIN, artTop - 20, S - MARGIN * 2, artH + 40); c.clip();
      // column edges
      c.setLineDash([4, 10]); c.lineWidth = 2; c.strokeStyle = rgba(parseColor(theme.text), 0.18);
      c.beginPath(); c.moveTo(wx(0), artTop - 20); c.lineTo(wx(0), artBottom + 20); c.moveTo(wx(C.COL_W), artTop - 20); c.lineTo(wx(C.COL_W), artBottom + 20); c.stroke();
      c.setLineDash([]);
      // planets
      var kMin = Math.max(0, Math.floor(yMin / C.CHUNK_H)), kMax = Math.max(0, Math.floor(yMax / C.CHUNK_H));
      var spriteRes = clamp(sc * 2, 0.5, 3);
      for (var k = kMin; k <= kMax && k - kMin < 40; k++) {
        var chunk = (run.chunks && run.chunks[k]) || (G.sim && typeof G.sim.gen === 'function' && run.seed !== undefined ? G.sim.gen(run.seed >>> 0, k) : null);
        if (!chunk || !chunk.planets) continue;
        for (var pi = 0; pi < chunk.planets.length; pi++) {
          var p = chunk.planets[pi];
          if (!drawablePlanet(p) || !isFinite(p.x0) || p.y < yMin - p.R || p.y > yMax + p.R) continue;
          var spr = makePlanetSprite(p, spriteRes, theme);
          var size = spr.half * 2 * sc;
          if (p.hot) stampGlow(c, wx(p.x0), wy(p.y), p.R * 2.6 * sc, theme.hot, 0.6);
          c.drawImage(spr.canvas, wx(p.x0) - size / 2, wy(p.y) - size / 2, size, size);
        }
      }
      // path
      var skinCol = skinMainColor(skin);
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = 0.35; c.lineWidth = Math.max(6, 10 * sc); c.strokeStyle = skinCol;
      c.beginPath();
      for (var s1 = 0; s1 < samples.length; s1++) { if (s1 === 0) c.moveTo(wx(samples[s1][0]), wy(samples[s1][1])); else c.lineTo(wx(samples[s1][0]), wy(samples[s1][1])); }
      c.stroke();
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 0.95; c.lineWidth = Math.max(2, 3 * sc);
      c.strokeStyle = skin.core && skin.edge ? skin.edge : skinCol;
      c.stroke();
      c.globalAlpha = 1;
      var last = samples[samples.length - 1];
      stampGlow(c, wx(last[0]), wy(last[1]), 70, skinCol, 0.9);
      c.fillStyle = '#ffffff'; c.beginPath(); c.arc(wx(last[0]), wy(last[1]), Math.max(4, 6 * sc), 0, TAU); c.fill();
      c.restore();

      // header
      var textCol = theme.text;
      var name = String(meta.name || 'You');
      uiText(name, MARGIN, MARGIN + 10, { size: 44, weight: 800, align: 'left', baseline: 'top', color: textCol, spacing: 0.04, maxWidth: 520 });
      if (meta.label) uiText(String(meta.label), S - MARGIN, MARGIN + 18, { size: 30, weight: 600, align: 'right', baseline: 'top', color: rgba(parseColor(textCol), 0.8), spacing: 0.06, maxWidth: 440 });
      uiText(String(G.NAME || 'Tetherloop').toUpperCase(), MARGIN, MARGIN + 66, { size: 22, weight: 600, align: 'left', baseline: 'top', color: rgba(parseColor(textCol), 0.6), spacing: 0.12 });

      // footer
      var score = num(meta.score, run.score ? num(run.score.alt, 0) + num(run.score.banked, 0) : 0);
      var style = num(meta.style, run.score ? num(run.score.banked, 0) : 0);
      // footer rows (top → bottom): score 120 px, ALT · STYLE, BEAT ME pill, rank | url
      var fy = artBottom + 20;
      uiText(fmt(score), S / 2, fy, { size: 120, weight: 800, align: 'center', baseline: 'top', color: textCol, halo: true, spacing: 0.02 });
      uiText(tr('alt', 'ALT').toUpperCase() + ' ' + fmt(altM) + ' m   ·   ' + tr('style', 'STYLE').toUpperCase() + ' ' + fmt(style), S / 2, fy + 140, { size: 30, weight: 600, align: 'center', baseline: 'top', color: rgba(parseColor(textCol), 0.85), spacing: 0.06 });
      if (meta.beatMe) {
        var bm = tr('beatMe', 'BEAT ME');
        var bw = uiMeasure(bm, 28, 800, 0.08).width + 64;
        uiRoundRect(S / 2 - bw / 2, fy + 190, bw, 46, 23);
        c.fillStyle = skinCol; c.fill();
        uiText(bm, S / 2, fy + 213, { size: 28, weight: 800, align: 'center', baseline: 'middle', color: '#0a0c1c', spacing: 0.08 });
      }
      var rankLine = meta.rankId ? tr('rank_' + meta.rankId, String(meta.rankId).toUpperCase()).toUpperCase() : '';
      if (rankLine) uiText(rankLine, MARGIN, S - MARGIN + 8, { size: 24, weight: 600, align: 'left', baseline: 'bottom', color: rgba(parseColor(textCol), 0.7), spacing: 0.1 });
      if (meta.url) uiText(String(meta.url).replace(/^https?:\/\//, ''), S - MARGIN, S - MARGIN + 8, { size: 22, weight: 600, align: 'right', baseline: 'bottom', color: rgba(parseColor(textCol), 0.7), maxWidth: rankLine ? 700 : 940 });
    } finally {
      ctx = savedCtx; theme = savedTheme; skin = savedSkin; heatRamp = savedHeat;
      forceGlow = false;
    }
    return cv;
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                                 */
  /* ------------------------------------------------------------------ */

  G.render = {
    THEME_DEFAULT: THEME_DEFAULT,
    SKIN_DEFAULT: SKIN_DEFAULT,
    ICON_NAMES: ICON_NAMES,
    init: init,
    resize: resize,
    view: view,
    worldToScreen: worldToScreen,
    pointerToLogical: pointerToLogical,
    logicalToPointer: logicalToPointer,
    setTheme: setTheme,
    setSkin: setSkin,
    setReduceMotion: setReduceMotion,
    setQualityAuto: setQualityAuto,
    drawFrame: drawFrame,
    drawShareCard: drawShareCard,
    particles: { spawn: spawn, kinds: PARTICLE_KINDS },
    floatText: floatText,
    shake: shake,
    zoomPulse: zoomPulse,
    flash: flash,
    onEvent: onEvent,
    reset: reset,
    heatColor: heatColor,
    skyColorAt: skyColorAt,
    /** HUD hit rects maintained by drawFrame (logical coords): { pause: {x,y,w,h} }. */
    hud: hudRects,
    ui: {
      button: uiButton,
      panel: uiPanel,
      text: uiText,
      icon: uiIcon,
      toggle: uiToggle,
      ring: uiRing,
      measureText: uiMeasure,
      roundRect: uiRoundRect,
      font: fontStr
    }
  };
  Object.defineProperties(G.render, {
    /** @type {CanvasRenderingContext2D|null} */
    ctx: { get: function () { return ctx; }, enumerable: true },
    /** @type {HTMLCanvasElement|null} */
    canvas: { get: function () { return canvas; }, enumerable: true },
    theme: { get: function () { return theme; }, enumerable: true },
    skin: { get: function () { return skin; }, enumerable: true },
    reduceMotion: { get: function () { return reduceMotion; }, enumerable: true },
    /** Current auto-quality info { level, label, dpr, glow }. */
    quality: { get: qualityInfo, enumerable: true },
    /** Live particle count (debug panel). */
    particleCount: {
      get: function () { var n = 0; for (var i = 0; i < particles.length; i++) if (particles[i].alive) n++; return n; },
      enumerable: true
    }
  });
})();
