/**
 * G.audio — zero-asset Web Audio synthesiser: UI/gameplay SFX + generative music.
 *
 * Responsibilities
 *   - Lazy AudioContext: nothing is created until unlock() runs from a user
 *     gesture (pointerdown / keydown / touchend). init() also installs passive
 *     gesture listeners so the context unlocks (and recovers from an iOS
 *     "interrupted" state) even if the integrator forgets to call unlock().
 *   - Master chain:  sfxBus ─┐
 *                    musicBus → lowpass → duck → fade ─┴→ master → compressor → destination
 *     adMute() drives the master gain to 0 independently of the user settings
 *     and restores the configured volume afterwards.
 *   - 23 named procedural SFX (see SFX table below for the voice design of each),
 *     polyphony capped at MAX_VOICES (oldest voice is faded out and dropped),
 *     every per-voice node is disconnected when its source ends — no leaks.
 *   - Generative music: three tracks (menu / main / daily) built from a scale, a
 *     four-bar chord cycle, bass on roots, an arpeggio layer, a detuned-saw pad
 *     and noise/sine percussion. A 25 ms setInterval lookahead scheduler books
 *     notes 100 ms ahead (never from the rAF loop). Intensity 0..1 maps to
 *     tempo, bus cutoff, hat density, kick pattern and arpeggio octave.
 *   - duck() dips the music under important SFX, stopAll() silences everything,
 *     document.hidden pauses the music and suspends the context, visibility
 *     restores both. The "wanted" track is the single source of truth: it is
 *     (re)started whenever unlock, music-on and visibility all hold.
 *   - Settings (sfx / music / volume) persist through G.storage when present and
 *     follow external changes (cloud mirror pulls, imports) via 'g:storage'.
 *   - renderSfx() renders any SFX through an OfflineAudioContext for QA/tests.
 *
 * Classic script (IIFE), no dependencies, works from file://.
 */
(function () {
  'use strict';

  var G = window.G = window.G || {};
  if (typeof G.DEBUG !== 'boolean') {
    G.DEBUG = /[?&]debug=1/.test(window.location && window.location.search || '');
  }
  G.log = G.log || function () {
    if (G.DEBUG) console.log.apply(console, arguments);
  };

  /* ------------------------------------------------------------------ */
  /* Constants                                                            */
  /* ------------------------------------------------------------------ */

  var AudioContextCtor = window.AudioContext || window.webkitAudioContext || null;
  var OfflineContextCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext || null;

  /** Maximum simultaneously sounding SFX voices; the oldest is dropped beyond this. */
  var MAX_VOICES = 12;
  /** Default master volume when nothing is persisted. */
  var DEFAULT_VOLUME = 0.8;
  /** Mix level of the music bus relative to SFX (SFX bus sits at 1.0). */
  var MUSIC_LEVEL = 0.5;
  /** Scheduler period and how far ahead notes are booked. */
  var TICK_MS = 25;
  var LOOKAHEAD_S = 0.1;
  /** Music grid: 16th-note steps, four bars per chord cycle. */
  var STEPS_PER_BAR = 16;
  var BARS = 4;
  /** Small offset so SFX never schedule in the past. */
  var SFX_LATENCY_S = 0.005;
  /** Floor for exponential ramps (AudioParam forbids ramps to exactly 0). */
  var EPS = 0.0005;
  /** Audio settings that G.storage remembers (key → coercion). */
  var SETTINGS = {
    sfx: { fallback: true, coerce: toBool },
    music: { fallback: true, coerce: toBool },
    volume: { fallback: DEFAULT_VOLUME, coerce: toUnit }
  };
  /** Scale degrees (semitones) used by 'combo' steps: major pentatonic over two octaves. */
  var COMBO_DEGREES = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  /** Sanity limits for caller-supplied numbers (semitones, seconds, milliseconds). */
  var MAX_PITCH_SEMITONES = 48;
  var MAX_RENDER_SECONDS = 30;
  var MAX_DUCK_MS = 60000;

  /* ------------------------------------------------------------------ */
  /* Module state                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Public, read-only-by-convention snapshot of the audio state.
   * @type {{unlocked:boolean, sfx:boolean, music:boolean, volume:number, ducked:boolean, adMuted:boolean, masterGain:number}}
   */
  var state = {
    unlocked: false,
    sfx: true,
    music: true,
    volume: DEFAULT_VOLUME,
    ducked: false,
    adMuted: false,
    masterGain: DEFAULT_VOLUME
  };

  /** Counters for QA, tests and the debug overlay. */
  var stats = { voicesCreated: 0, voicesDropped: 0, notesScheduled: 0 };

  /** @type {Object|null} the live rig (context + master chain), built on unlock(). */
  var rig = null;
  var initialised = false;
  var duckTimer = 0;
  var hiddenSuspendTimer = 0;
  /**
   * The track the game wants to hear (null = none). It starts, or restarts
   * after unlock / music-on / tab visible, as soon as every precondition holds.
   */
  var wantedTrack = null;
  /** True while this module writes a setting, so its own 'g:storage' echo is ignored. */
  var writingSetting = false;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                        */
  /* ------------------------------------------------------------------ */

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function toBool(v, fallback) {
    return typeof v === 'boolean' ? v : fallback;
  }

  /** Finite number or fallback: AudioParam setters throw on NaN/Infinity. */
  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  /** Own-property lookup so 'constructor', '__proto__' etc. never resolve. */
  function has(obj, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isHidden() {
    return typeof document !== 'undefined' && !!document.hidden;
  }

  function toUnit(v, fallback) {
    var n = Number(v);
    return (typeof v === 'number' || typeof v === 'string') && isFinite(n) ? clamp(n, 0, 1) : fallback;
  }

  /** @param {number} midi @returns {number} frequency in Hz. */
  function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Deterministic LCG in [0,1) — keeps the music CPU-cheap and reproducible. */
  function lcg(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function now() {
    return rig ? rig.ctx.currentTime : 0;
  }

  /**
   * Moves an AudioParam to a value, optionally over a short linear ramp,
   * discarding any automation already queued on it.
   */
  function setParam(param, value, rampS) {
    var t = now();
    param.cancelScheduledValues(t);
    if (rampS > 0) {
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + rampS);
    } else {
      param.setValueAtTime(value, t);
    }
  }

  function safeDisconnect(node) {
    try { node.disconnect(); } catch (e) { /* already detached */ }
  }

  function safeStop(source, when) {
    try { source.stop(when); } catch (e) { /* already stopped */ }
  }

  function readSetting(key) {
    var spec = SETTINGS[key];
    try {
      if (G.storage && typeof G.storage.get === 'function') {
        return spec.coerce(G.storage.get(key, spec.fallback), spec.fallback);
      }
    } catch (e) {
      G.log('audio: settings read failed', key, e);
    }
    return spec.fallback;
  }

  function writeSetting(key, value) {
    writingSetting = true;
    try {
      if (G.storage && typeof G.storage.set === 'function') G.storage.set(key, value);
    } catch (e) {
      G.log('audio: settings write failed', key, e);
    }
    writingSetting = false;
    try {
      window.dispatchEvent(new CustomEvent('g:audio', { detail: { key: key, value: value } }));
    } catch (e) { /* CustomEvent unavailable: nothing to notify */ }
  }

  /* ------------------------------------------------------------------ */
  /* Rig: context + master chain (live or offline)                        */
  /* ------------------------------------------------------------------ */

  /** 2 s of deterministic white noise shared by every noise voice of a rig. */
  function makeNoiseBuffer(ctx) {
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var rnd = lcg(0x9e3779b9);
    for (var i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
    return buf;
  }

  /**
   * Builds the master chain inside a context. Used for the live context and
   * for OfflineAudioContext renders so both go through the same limiter.
   * @param {BaseAudioContext} ctx
   */
  function createRig(ctx) {
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    comp.connect(ctx.destination);

    var master = ctx.createGain();
    master.gain.value = state.adMuted ? 0 : state.volume;
    master.connect(comp);

    var sfxBus = ctx.createGain();
    sfxBus.gain.value = state.sfx ? 1 : 0;
    sfxBus.connect(master);

    var musicFade = ctx.createGain();
    musicFade.gain.value = 0;
    musicFade.connect(master);
    var duck = ctx.createGain();
    duck.connect(musicFade);
    var musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 4000;
    musicFilter.Q.value = 0.5;
    musicFilter.connect(duck);
    var musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_LEVEL;
    musicBus.connect(musicFilter);

    return {
      ctx: ctx,
      comp: comp,
      master: master,
      sfxBus: sfxBus,
      musicBus: musicBus,
      musicFilter: musicFilter,
      duck: duck,
      musicFade: musicFade,
      noise: makeNoiseBuffer(ctx),
      voices: [],
      layers: null
    };
  }

  /** Applies volume + adMute to the master gain. */
  function applyMasterGain(rampS) {
    state.masterGain = state.adMuted ? 0 : state.volume;
    if (rig) setParam(rig.master.gain, state.masterGain, rampS);
  }

  /** iOS needs an actual (silent) buffer to play before the context is truly live. */
  function playSilentKick(ctx) {
    try {
      var src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.onended = function () { safeDisconnect(src); };
      src.start();
    } catch (e) { /* purely a best-effort nudge */ }
  }

  /** Creates the live context, retrying without the options bag for engines that reject it. */
  function createContext() {
    try {
      return new AudioContextCtor({ latencyHint: 'interactive' });
    } catch (e1) {
      try {
        return new AudioContextCtor();
      } catch (e2) {
        G.log('audio: AudioContext failed', e2);
        return null;
      }
    }
  }

  function contextRunning() {
    return !!rig && (rig.ctx.state === 'running' || rig.ctx.state === undefined);
  }

  /** ctx.resume() as a promise, even on engines where it throws or returns nothing. */
  function resumeContext(ctx) {
    if (!ctx.state || ctx.state === 'running' || typeof ctx.resume !== 'function') return Promise.resolve();
    try {
      var p = ctx.resume();
      return p && typeof p.then === 'function' ? p : Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* SFX voice toolkit                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * One SFX instance: an output gain (+ optional panner) into the rig's sfx bus
   * plus the sources/nodes created by the recipe so they can be torn down.
   */
  function createVoice(r, opts, bus) {
    var ctx = r.ctx;
    var out = ctx.createGain();
    out.gain.value = clamp(num(opts.gain, 1), 0, 1);
    var nodes = [out];
    var tail = out;
    var panAmount = clamp(num(opts.pan, 0), -1, 1);
    if (panAmount !== 0 && typeof ctx.createStereoPanner === 'function') {
      var pan = ctx.createStereoPanner();
      pan.pan.value = panAmount;
      out.connect(pan);
      tail = pan;
      nodes.push(pan);
    }
    tail.connect(bus || r.sfxBus);
    return {
      rig: r,
      ctx: ctx,
      t0: ctx.currentTime + SFX_LATENCY_S,
      ratio: Math.pow(2, clamp(num(opts.pitch, 0), -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES) / 12),
      step: Math.round(num(opts.step, 0)),
      out: out,
      nodes: nodes,
      sources: [],
      pending: 0
    };
  }

  /**
   * Standard pluck envelope: linear attack to peak, optional hold, exponential
   * decay to silence at `end`.
   */
  function envelope(param, t, end, attack, peak, hold) {
    var dur = end - t;
    var a = clamp(attack || 0.003, 0.0005, dur * 0.5);
    var decayStart = Math.max(t + a, Math.min(t + a + (hold || 0), end - 0.005));
    param.setValueAtTime(EPS, t);
    param.linearRampToValueAtTime(peak, t + a);
    if (hold) param.setValueAtTime(peak, decayStart);
    param.exponentialRampToValueAtTime(EPS, end);
  }

  /**
   * Optional filter stage shared by tone() and noiseBurst().
   * @returns {AudioNode} node to connect the source into (filter or gain).
   */
  function filterStage(v, s, t, end, into) {
    if (!s.filter && !s.lp) return into;
    var f = v.ctx.createBiquadFilter();
    f.type = s.filter || 'lowpass';
    var f0 = s.filter ? s.freq : s.lp;
    var f1 = s.filter ? s.to : s.lpTo;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, end);
    f.Q.value = s.q || 0.7;
    f.connect(into);
    v.nodes.push(f);
    return f;
  }

  /**
   * Oscillator voice.
   * @param {Object} v voice
   * @param {Object} s spec: { at, dur, type, freq, to, glide, sweep:[[dt,hz]...], attack, hold, gain,
   *                          lp, lpTo, q, vib (cents), vibHz }
   *   Tonal frequencies are multiplied by the voice pitch ratio (opts.pitch).
   */
  function tone(v, s) {
    var ctx = v.ctx;
    var t = v.t0 + (s.at || 0);
    var end = t + s.dur;
    var o = ctx.createOscillator();
    o.type = s.type || 'sine';
    o.frequency.setValueAtTime(s.freq * v.ratio, t);
    var sweep = s.sweep || (s.to ? [[s.glide || s.dur, s.to]] : []);
    for (var i = 0; i < sweep.length; i++) {
      o.frequency.exponentialRampToValueAtTime(sweep[i][1] * v.ratio, t + sweep[i][0]);
    }
    var g = ctx.createGain();
    envelope(g.gain, t, end, s.attack, s.gain || 0.3, s.hold);
    g.connect(v.out);
    o.connect(filterStage(v, { lp: s.lp, lpTo: s.lpTo, q: s.q }, t, end, g));
    v.nodes.push(o, g);
    if (s.vib) {
      var lfo = ctx.createOscillator();
      lfo.frequency.value = s.vibHz || 6;
      var depth = ctx.createGain();
      depth.gain.value = s.vib;
      lfo.connect(depth);
      depth.connect(o.detune);
      lfo.start(t);
      lfo.stop(end + 0.01);
      v.nodes.push(lfo, depth);
      v.sources.push(lfo);
    }
    o.start(t);
    o.stop(end + 0.01);
    v.sources.push(o);
  }

  /**
   * Filtered noise burst.
   * @param {Object} v voice
   * @param {Object} s spec: { at, dur, attack, gain, filter:'lowpass'|'highpass'|'bandpass', freq, to, q }
   */
  function noiseBurst(v, s) {
    var ctx = v.ctx;
    var t = v.t0 + (s.at || 0);
    var end = t + s.dur;
    var src = ctx.createBufferSource();
    src.buffer = v.rig.noise;
    src.loop = true;
    var g = ctx.createGain();
    envelope(g.gain, t, end, s.attack, s.gain || 0.3, s.hold);
    g.connect(v.out);
    src.connect(filterStage(v, s, t, end, g));
    v.nodes.push(src, g);
    src.start(t);
    src.stop(end + 0.01);
    v.sources.push(src);
  }

  /** Registers the voice for polyphony accounting and tears it down once every source ended. */
  function finishVoice(v) {
    var r = v.rig;
    v.pending = v.sources.length;
    if (!v.pending) {
      disposeVoice(v);
      return;
    }
    v.sources.forEach(function (src) {
      src.onended = function () {
        src.onended = null;
        if (--v.pending === 0) disposeVoice(v);
      };
    });
    r.voices.push(v);
    stats.voicesCreated++;
    while (r.voices.length > MAX_VOICES) {
      killVoice(r.voices[0]);
      stats.voicesDropped++;
    }
  }

  /** Fast fade (15 ms) and stop; onended then disposes the nodes. */
  function killVoice(v) {
    var t = v.ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.linearRampToValueAtTime(0, t + 0.015);
    v.sources.forEach(function (src) { safeStop(src, t + 0.02); });
    forgetVoice(v);
  }

  function forgetVoice(v) {
    var i = v.rig.voices.indexOf(v);
    if (i >= 0) v.rig.voices.splice(i, 1);
  }

  function disposeVoice(v) {
    forgetVoice(v);
    v.nodes.forEach(safeDisconnect);
    v.nodes.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* SFX table                                                            */
  /* ------------------------------------------------------------------ */

  /** Shorthand used by chord/arpeggio SFX: a list of [at, freq, dur]. */
  function run(v, notes, base) {
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var spec = {};
      for (var k in base) spec[k] = base[k];
      spec.at = n[0];
      spec.freq = n[1];
      spec.dur = n[2];
      tone(v, spec);
    }
  }

  /**
   * Every SFX recipe. Each entry documents voice type, envelope and pitch so
   * the palette stays distinct: UI blips are short and tonal, impacts are
   * low noise + sine thumps, rewards are bright ascending major figures,
   * failures descend, sweeps are filtered noise.
   */
  var SFX = {
    /** tap — wooden "tok": triangle 1000→720 Hz over 50 ms, 70 ms decay, plus a 20 ms highpassed click. */
    tap: function (v) {
      tone(v, { type: 'triangle', freq: 1000, to: 720, glide: 0.05, dur: 0.07, attack: 0.002, gain: 0.55 });
      noiseBurst(v, { dur: 0.02, gain: 0.12, filter: 'highpass', freq: 3000 });
    },
    /** click — dry mechanical: 2.4 kHz square through a 3.5 kHz lowpass for 25 ms, plus a 15 ms 5 kHz noise tick. */
    click: function (v) {
      tone(v, { type: 'square', freq: 2400, dur: 0.025, attack: 0.001, gain: 0.25, lp: 3500 });
      noiseBurst(v, { dur: 0.015, gain: 0.2, filter: 'highpass', freq: 5000 });
    },
    /** tick — metronome tick: pure sine 1500→1400 Hz, 1 ms attack, 45 ms decay. */
    tick: function (v) {
      tone(v, { type: 'sine', freq: 1500, to: 1400, dur: 0.045, attack: 0.001, gain: 0.5 });
    },
    /** select — menu blip: sine 660 Hz (E5) 100 ms with a quiet 1320 Hz octave for sparkle. */
    select: function (v) {
      tone(v, { type: 'sine', freq: 660, dur: 0.1, attack: 0.003, gain: 0.45 });
      tone(v, { type: 'sine', freq: 1320, dur: 0.07, attack: 0.003, gain: 0.15 });
    },
    /** flip — card flip: bandpassed noise sweeping 600→2600 Hz over 130 ms under a triangle glide 500→820 Hz. */
    flip: function (v) {
      noiseBurst(v, { dur: 0.13, attack: 0.01, gain: 0.35, filter: 'bandpass', freq: 600, to: 2600, q: 1.2 });
      tone(v, { type: 'triangle', freq: 500, to: 820, glide: 0.1, dur: 0.11, attack: 0.01, gain: 0.2 });
    },
    /** pop — bubble pop: sine sweeping 320→950 Hz in 45 ms, 85 ms total. */
    pop: function (v) {
      tone(v, { type: 'sine', freq: 320, to: 950, glide: 0.045, dur: 0.085, attack: 0.002, gain: 0.6 });
    },
    /** coin — classic two-note pickup: lowpassed square B5 (988 Hz) 70 ms then E6 (1319 Hz) 340 ms with a sine 2637 Hz halo. */
    coin: function (v) {
      tone(v, { type: 'square', freq: 987.77, dur: 0.07, attack: 0.002, hold: 0.05, gain: 0.28, lp: 4000 });
      tone(v, { at: 0.07, type: 'square', freq: 1318.5, dur: 0.34, attack: 0.002, gain: 0.28, lp: 4500 });
      tone(v, { at: 0.07, type: 'sine', freq: 2637, dur: 0.25, attack: 0.002, gain: 0.08 });
    },
    /** combo — ascending pentatonic step: triangle + sine octave, base C5 (523 Hz), opts.step 0..9 picks the degree, 200 ms. */
    combo: function (v) {
      var deg = COMBO_DEGREES[clamp(v.step, 0, COMBO_DEGREES.length - 1)];
      var f = 523.25 * Math.pow(2, deg / 12);
      tone(v, { type: 'triangle', freq: f, dur: 0.2, attack: 0.003, gain: 0.45 });
      tone(v, { type: 'sine', freq: f * 2, dur: 0.14, attack: 0.003, gain: 0.14 });
    },
    /** hit — impact: lowpassed noise 900→200 Hz 130 ms plus a sine thump 190→60 Hz 160 ms. */
    hit: function (v) {
      noiseBurst(v, { dur: 0.13, attack: 0.002, gain: 0.6, filter: 'lowpass', freq: 900, to: 200 });
      tone(v, { type: 'sine', freq: 190, to: 60, glide: 0.1, dur: 0.16, attack: 0.002, gain: 0.7 });
    },
    /** explode — boom: highpassed crack 80 ms, lowpassed noise 2200→120 Hz over 600 ms and a sub sine 95→28 Hz. */
    explode: function (v) {
      noiseBurst(v, { dur: 0.08, gain: 0.4, filter: 'highpass', freq: 2500 });
      noiseBurst(v, { dur: 0.6, attack: 0.005, gain: 0.8, filter: 'lowpass', freq: 2200, to: 120, q: 0.8 });
      tone(v, { type: 'sine', freq: 95, to: 28, glide: 0.5, dur: 0.6, attack: 0.005, gain: 0.6 });
    },
    /** whoosh — rising air: bandpassed noise 300→3200 Hz, 140 ms swell, 360 ms total. */
    whoosh: function (v) {
      noiseBurst(v, { dur: 0.36, attack: 0.14, gain: 0.5, filter: 'bandpass', freq: 300, to: 3200, q: 1.5 });
    },
    /** swoosh — falling air (mirror of whoosh): bandpassed noise 3400→350 Hz, 30 ms attack, 250 ms. */
    swoosh: function (v) {
      noiseBurst(v, { dur: 0.25, attack: 0.03, gain: 0.5, filter: 'bandpass', freq: 3400, to: 350, q: 1.5 });
    },
    /** powerup — rising major arpeggio from G4 (392 Hz), six lowpassed square notes 50 ms apart, then a vibrato triangle G6 held 300 ms. */
    powerup: function (v) {
      var base = 392;
      var notes = [];
      var degrees = [0, 4, 7, 12, 16, 19];
      for (var i = 0; i < degrees.length; i++) {
        notes.push([i * 0.05, base * Math.pow(2, degrees[i] / 12), 0.09]);
      }
      run(v, notes, { type: 'square', attack: 0.003, gain: 0.22, lp: 3000 });
      tone(v, { at: 0.3, type: 'triangle', freq: base * 4, dur: 0.3, attack: 0.01, gain: 0.3, vib: 12, vibHz: 7 });
    },
    /** fail — descending "wah": lowpassed sawtooth G4 → E4 → C4 (392/330/262 Hz) 150 ms apart, the last drooping to 230 Hz over 300 ms. */
    fail: function (v) {
      run(v, [[0, 392, 0.17], [0.15, 330, 0.17]], { type: 'sawtooth', attack: 0.01, gain: 0.3, lp: 1400 });
      tone(v, { at: 0.3, type: 'sawtooth', freq: 262, to: 230, glide: 0.3, dur: 0.3, attack: 0.01, gain: 0.3, lp: 1400 });
    },
    /** success — major triad up: triangle C5 E5 G5 (90 ms apart, 100 ms each) then C6 held 330 ms with a sine C7 halo. */
    success: function (v) {
      run(v, [[0, 523.25, 0.1], [0.09, 659.25, 0.1], [0.18, 783.99, 0.1], [0.27, 1046.5, 0.33]],
        { type: 'triangle', attack: 0.004, gain: 0.35 });
      tone(v, { at: 0.27, type: 'sine', freq: 2093, dur: 0.25, attack: 0.004, gain: 0.08 });
    },
    /** unlock — two bells: additive sines at C6 (1047 Hz) with 2.0× and 3.01× partials, 600 ms decay, second bell G6 (1568 Hz) 120 ms later. */
    unlock: function (v) {
      tone(v, { type: 'sine', freq: 1046.5, dur: 0.6, attack: 0.002, gain: 0.35 });
      tone(v, { type: 'sine', freq: 1046.5 * 2, dur: 0.4, attack: 0.002, gain: 0.12 });
      tone(v, { type: 'sine', freq: 1046.5 * 3.01, dur: 0.25, attack: 0.002, gain: 0.06 });
      tone(v, { at: 0.12, type: 'sine', freq: 1568, dur: 0.48, attack: 0.002, gain: 0.3 });
      tone(v, { at: 0.12, type: 'sine', freq: 1568 * 2, dur: 0.3, attack: 0.002, gain: 0.1 });
    },
    /** land — soft thud: sine 130→50 Hz over 100 ms, 130 ms total, with 50 ms of lowpassed (700 Hz) noise. */
    land: function (v) {
      tone(v, { type: 'sine', freq: 130, to: 50, glide: 0.1, dur: 0.13, attack: 0.002, gain: 0.6 });
      noiseBurst(v, { dur: 0.05, gain: 0.25, filter: 'lowpass', freq: 700 });
    },
    /** bounce — "boing": triangle 300 Hz rising to 620 Hz in 60 ms then falling to 340 Hz by 200 ms. */
    bounce: function (v) {
      tone(v, { type: 'triangle', freq: 300, sweep: [[0.06, 620], [0.2, 340]], dur: 0.2, attack: 0.003, gain: 0.45 });
    },
    /** newBest — fanfare: lowpassed square C5 E5 G5 C6 (70 ms apart) doubled by triangle an octave down, then E6 held 320 ms with vibrato, E5 body and a 7 kHz shimmer. */
    newBest: function (v) {
      var steps = [[0, 523.25, 0.09], [0.07, 659.25, 0.09], [0.14, 783.99, 0.09], [0.21, 1046.5, 0.09]];
      run(v, steps, { type: 'square', attack: 0.003, gain: 0.25, lp: 3500 });
      run(v, steps.map(function (n) { return [n[0], n[1] / 2, n[2]]; }), { type: 'triangle', attack: 0.003, gain: 0.15 });
      tone(v, { at: 0.28, type: 'square', freq: 1318.5, dur: 0.32, attack: 0.01, gain: 0.3, lp: 3500, vib: 10, vibHz: 6.5 });
      tone(v, { at: 0.28, type: 'triangle', freq: 659.25, dur: 0.32, attack: 0.01, gain: 0.2 });
      noiseBurst(v, { at: 0.28, dur: 0.2, attack: 0.02, gain: 0.08, filter: 'highpass', freq: 7000 });
    },
    /** countdown — gated beep: lowpassed square A5 (880 Hz) 110 ms; opts.step 0 is the "go" beep, E6 (1320 Hz) held 300 ms. */
    countdown: function (v) {
      if (v.step === 0) {
        tone(v, { type: 'square', freq: 1320, dur: 0.3, attack: 0.003, hold: 0.24, gain: 0.3, lp: 3000 });
      } else {
        tone(v, { type: 'square', freq: 880, dur: 0.11, attack: 0.003, hold: 0.08, gain: 0.3, lp: 2500 });
      }
    },
    /** perfect — sparkle: sine G6 (1568 Hz) 60 ms into C7 (2093 Hz) 240 ms with a C8 partial and a faint 6 kHz shimmer. */
    perfect: function (v) {
      tone(v, { type: 'sine', freq: 1568, dur: 0.06, attack: 0.002, gain: 0.3 });
      tone(v, { at: 0.06, type: 'sine', freq: 2093, dur: 0.24, attack: 0.002, gain: 0.35 });
      tone(v, { at: 0.06, type: 'sine', freq: 4186, dur: 0.15, attack: 0.002, gain: 0.08 });
      noiseBurst(v, { at: 0.06, dur: 0.18, attack: 0.02, gain: 0.06, filter: 'highpass', freq: 6000 });
    },
    /** shield — "bwoom" hum: sawtooth 110→220 Hz with a resonant lowpass opening 300→2800 Hz and 9 Hz vibrato, sine 220→440 Hz underneath, 320 ms. */
    shield: function (v) {
      tone(v, { type: 'sawtooth', freq: 110, to: 220, glide: 0.25, dur: 0.32, attack: 0.03, gain: 0.3, lp: 300, lpTo: 2800, q: 3, vib: 8, vibHz: 9 });
      tone(v, { type: 'sine', freq: 220, to: 440, glide: 0.25, dur: 0.32, attack: 0.03, gain: 0.2 });
    },
    /** warning — two-tone alarm: lowpassed square A4 (440 Hz) then F#4 (370 Hz), 100 ms gated beeps 150 ms apart. */
    warning: function (v) {
      tone(v, { type: 'square', freq: 440, dur: 0.1, attack: 0.003, hold: 0.08, gain: 0.3, lp: 2000 });
      tone(v, { at: 0.15, type: 'square', freq: 370, dur: 0.1, attack: 0.003, hold: 0.08, gain: 0.3, lp: 2000 });
    }
  };

  var SFX_NAMES = Object.keys(SFX);

  /**
   * Builds and registers one SFX voice inside a rig. A recipe that throws
   * (an engine rejecting a parameter) leaves no connected nodes behind.
   */
  function triggerSfx(r, name, opts) {
    var v = createVoice(r, opts || {});
    try {
      SFX[name](v);
    } catch (e) {
      v.sources.forEach(function (src) { safeStop(src, 0); });
      disposeVoice(v);
      throw e;
    }
    finishVoice(v);
    return v;
  }

  /* ------------------------------------------------------------------ */
  /* Music: tracks                                                        */
  /* ------------------------------------------------------------------ */

  var MINOR_PENT = [0, 3, 5, 7, 10];
  var DORIAN = [0, 2, 3, 5, 7, 9, 10];
  var LYDIAN = [0, 2, 4, 6, 7, 9, 11];

  /**
   * Track definitions. `root` is the bass MIDI note; chords are semitone
   * offsets from it (one per bar, cycling); patterns are 16-step strings
   * ('x' = hit) picked by intensity.
   */
  var TRACKS = {
    /** Menu: D dorian, 76–100 BPM, no kick, sparse sine arpeggio, generous pad. Calm. */
    menu: {
      root: 38, scale: DORIAN, bpm: [76, 100],
      chords: [[0, 3, 7], [5, 9, 12], [7, 10, 14], [10, 14, 17]],
      kick: '', kickHi: '',
      hatLo: '....x.......x...', hatHi: '..x...x...x...x.', hat16: 'x.x.x.x.x.x.x.x.',
      snare: '',
      bass: 'x.......x.......',
      arp: 'x...x.x...x.....', arpHi: 'x.x...x.x.x...x.',
      arpType: 'sine', bassType: 'triangle', padGain: 0.2, padCutoff: [500, 1600]
    },
    /** Main: A minor pentatonic, 96–132 BPM, four-on-the-floor kick, driving 8th/16th hats, triangle arpeggio. */
    main: {
      root: 45, scale: MINOR_PENT, bpm: [96, 132],
      chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]],
      kick: 'x...x...x...x...', kickHi: 'x..x..x.x...x.x.',
      hatLo: '..x...x...x...x.', hatHi: 'x.x.x.x.x.x.x.x.', hat16: 'xxxxxxxxxxxxxxxx',
      snare: '....x.......x...',
      bass: 'x..x..x...x.x...',
      arp: 'x.x.x.x.x.x.x.x.', arpHi: 'xxxxxxxxxxxxxxxx',
      arpType: 'triangle', bassType: 'triangle', padGain: 0.12, padCutoff: [600, 2200]
    },
    /** Daily: F lydian, 100–128 BPM, half-time kick, syncopated bass, dotted square arpeggio. Brighter, seeded per UTC day. */
    daily: {
      root: 41, scale: LYDIAN, bpm: [100, 128],
      chords: [[0, 4, 7], [2, 6, 9], [4, 7, 11], [7, 11, 14]],
      kick: 'x.......x.......', kickHi: 'x...x...x...x..x',
      hatLo: '..x...x...x...x.', hatHi: 'x.x.x.x.x.x.x.x.', hat16: 'xxxxxxxxxxxxxxxx',
      snare: '....x.......x..x',
      bass: 'x.x...x.x.x...x.',
      arp: 'x..x..x..x..x..x', arpHi: 'x.xx.x.xx.x.xx.x',
      arpType: 'square', bassType: 'sawtooth', padGain: 0.14, padCutoff: [700, 2600]
    }
  };

  /** Mutable music engine state. */
  var mus = {
    track: null,
    cfg: null,
    playing: false,
    intensity: 0.5,
    step: 0,
    nextTime: 0,
    timer: 0,
    fadeTimer: 0,
    rng: lcg(1),
    arpIdx: 0,
    arpDir: 1,
    pad: null
  };

  /* ------------------------------------------------------------------ */
  /* Music: persistent layer nodes                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Per-layer nodes that live for the whole session. Hat and snare envelopes
   * are scheduled on these shared gains (their tails are shorter than one
   * step), so a hit costs exactly one source node.
   */
  function ensureLayers(r) {
    if (r.layers) return r.layers;
    var ctx = r.ctx;
    function gainTo(dest, value) {
      var g = ctx.createGain();
      g.gain.value = value;
      g.connect(dest);
      return g;
    }
    var hatFilter = ctx.createBiquadFilter();
    hatFilter.type = 'highpass';
    hatFilter.frequency.value = 7000;
    var hatGain = gainTo(r.musicBus, 0);
    hatFilter.connect(hatGain);
    var snareFilter = ctx.createBiquadFilter();
    snareFilter.type = 'bandpass';
    snareFilter.frequency.value = 1800;
    snareFilter.Q.value = 0.8;
    var snareGain = gainTo(r.musicBus, 0);
    snareFilter.connect(snareGain);
    var bassFilter = ctx.createBiquadFilter();
    bassFilter.type = 'lowpass';
    bassFilter.frequency.value = 520;
    bassFilter.connect(r.musicBus);
    var arpFilter = ctx.createBiquadFilter();
    arpFilter.type = 'lowpass';
    arpFilter.frequency.value = 2500;
    arpFilter.connect(r.musicBus);
    var padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 1000;
    var padGain = gainTo(r.musicBus, 0);
    padFilter.connect(padGain);
    r.layers = {
      hatFilter: hatFilter, hatGain: hatGain,
      snareFilter: snareFilter, snareGain: snareGain,
      bassFilter: bassFilter, arpFilter: arpFilter,
      padFilter: padFilter, padGain: padGain
    };
    return r.layers;
  }

  /** Six detuned sawtooth oscillators (two per chord tone) feeding the pad filter. */
  function buildPad(r, cfg) {
    var ctx = r.ctx;
    var L = ensureLayers(r);
    var oscs = [];
    for (var i = 0; i < 3; i++) {
      for (var d = -1; d <= 1; d += 2) {
        var o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = d * 7;
        o.frequency.value = midiToHz(cfg.root + 12 + cfg.chords[0][i]);
        o.connect(L.padFilter);
        o.start();
        oscs.push(o);
      }
    }
    L.padGain.gain.cancelScheduledValues(ctx.currentTime);
    L.padGain.gain.setValueAtTime(0, ctx.currentTime);
    L.padGain.gain.linearRampToValueAtTime(cfg.padGain, ctx.currentTime + 1.2);
    return oscs;
  }

  function destroyPad(r) {
    if (!mus.pad) return;
    var t = r.ctx.currentTime;
    mus.pad.forEach(function (o) {
      safeStop(o, t + 0.02);
      o.onended = function () { safeDisconnect(o); };
    });
    mus.pad = null;
  }

  /** Glides the pad to the bar's chord (80 ms portamento avoids clicks). */
  function retunePad(cfg, chord, t) {
    if (!mus.pad) return;
    for (var i = 0; i < 3; i++) {
      var hz = midiToHz(cfg.root + 12 + chord[i]);
      mus.pad[2 * i].frequency.exponentialRampToValueAtTime(hz, t + 0.08);
      mus.pad[2 * i + 1].frequency.exponentialRampToValueAtTime(hz, t + 0.08);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Music: per-note voices                                               */
  /* ------------------------------------------------------------------ */

  /** Connects a short-lived source, disconnecting it (and its gain) when it ends. */
  function transient(src, extra) {
    src.onended = function () {
      src.onended = null;
      safeDisconnect(src);
      if (extra) safeDisconnect(extra);
    };
  }

  /** Sine thump 160→45 Hz; its 220 ms tail can outlast a 16th, so it owns its gain. */
  function playKick(r, t) {
    var o = r.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.07);
    var g = r.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.22);
    o.connect(g);
    g.connect(r.musicBus);
    o.start(t);
    o.stop(t + 0.23);
    transient(o, g);
  }

  /** Noise hat; a random buffer offset keeps consecutive hits from sounding identical. */
  function playHat(r, t, gain) {
    var L = r.layers;
    var src = r.ctx.createBufferSource();
    src.buffer = r.noise;
    src.connect(L.hatFilter);
    L.hatGain.gain.setValueAtTime(gain, t);
    L.hatGain.gain.exponentialRampToValueAtTime(EPS, t + 0.04);
    src.start(t, mus.rng() * 1.5);
    src.stop(t + 0.05);
    transient(src);
  }

  function playSnare(r, t) {
    var L = r.layers;
    var src = r.ctx.createBufferSource();
    src.buffer = r.noise;
    src.connect(L.snareFilter);
    L.snareGain.gain.setValueAtTime(0.35, t);
    L.snareGain.gain.exponentialRampToValueAtTime(EPS, t + 0.12);
    src.start(t, mus.rng() * 1.5);
    src.stop(t + 0.13);
    transient(src);
  }

  function playBass(r, cfg, midi, t, dur) {
    var L = r.layers;
    var o = r.ctx.createOscillator();
    o.type = cfg.bassType;
    o.frequency.value = midiToHz(midi);
    var g = r.ctx.createGain();
    envelope(g.gain, t, t + dur, 0.01, 0.5, dur * 0.3);
    o.connect(g);
    g.connect(L.bassFilter);
    o.start(t);
    o.stop(t + dur + 0.01);
    transient(o, g);
  }

  function playArp(r, cfg, midi, t, dur) {
    var L = r.layers;
    var o = r.ctx.createOscillator();
    o.type = cfg.arpType;
    o.frequency.value = midiToHz(midi);
    var g = r.ctx.createGain();
    envelope(g.gain, t, t + dur, 0.005, 0.22);
    o.connect(g);
    g.connect(L.arpFilter);
    o.start(t);
    o.stop(t + dur + 0.01);
    transient(o, g);
  }

  /* ------------------------------------------------------------------ */
  /* Music: scheduler                                                     */
  /* ------------------------------------------------------------------ */

  function currentBpm() {
    return mus.cfg ? lerp(mus.cfg.bpm[0], mus.cfg.bpm[1], mus.intensity) : 0;
  }

  function stepDuration() {
    return 60 / currentBpm() / 4;
  }

  function hit(pattern, pos) {
    return pattern.charAt(pos) === 'x';
  }

  function hatPattern(cfg, I) {
    return I < 0.4 ? cfg.hatLo : (I < 0.75 ? cfg.hatHi : cfg.hat16);
  }

  /**
   * Picks the next arpeggio note: mostly chord tones walked up and down,
   * sometimes a scale passing tone, one octave higher at high intensity.
   */
  function nextArpMidi(cfg, chord) {
    var semis;
    if (mus.rng() < 0.7) {
      mus.arpIdx += mus.arpDir;
      if (mus.arpIdx >= chord.length || mus.arpIdx < 0) {
        mus.arpDir = -mus.arpDir;
        mus.arpIdx = clamp(mus.arpIdx, 0, chord.length - 1);
      }
      semis = chord[mus.arpIdx];
    } else {
      semis = cfg.scale[Math.floor(mus.rng() * cfg.scale.length)];
    }
    if (mus.rng() < 0.15) mus.arpDir = -mus.arpDir;
    return cfg.root + (mus.intensity > 0.6 ? 36 : 24) + semis;
  }

  /** Books every layer event for one 16th-note step at absolute time t. */
  function scheduleStep(step, t) {
    var cfg = mus.cfg;
    var I = mus.intensity;
    var bar = Math.floor(step / STEPS_PER_BAR);
    var pos = step % STEPS_PER_BAR;
    var chord = cfg.chords[bar % cfg.chords.length];
    var sd = stepDuration();

    if (pos === 0) retunePad(cfg, chord, t);

    if (hit(I < 0.7 ? cfg.kick : cfg.kickHi, pos)) {
      playKick(rig, t);
      stats.notesScheduled++;
    }
    if (hit(hatPattern(cfg, I), pos)) {
      var accent = pos % 4 === 0 ? 0.25 : 0.14;
      playHat(rig, t, accent * (0.9 + mus.rng() * 0.2));
      stats.notesScheduled++;
    }
    if (I >= 0.5 && hit(cfg.snare, pos)) {
      playSnare(rig, t);
      stats.notesScheduled++;
    }
    if (hit(cfg.bass, pos)) {
      playBass(rig, cfg, cfg.root + chord[0], t, sd * 1.8);
      stats.notesScheduled++;
    }
    if (hit(I < 0.5 ? cfg.arp : cfg.arpHi, pos)) {
      playArp(rig, cfg, nextArpMidi(cfg, chord), t, sd * 1.8);
      stats.notesScheduled++;
    }
  }

  /** setInterval callback: books all steps falling inside the lookahead window. */
  function schedulerTick() {
    if (!mus.playing || !rig) return;
    var t = rig.ctx.currentTime;
    if (mus.nextTime < t - 0.25) {
      // The tab was throttled: resync instead of burst-scheduling the backlog.
      mus.nextTime = t + 0.02;
    }
    while (mus.nextTime < t + LOOKAHEAD_S) {
      scheduleStep(mus.step, mus.nextTime);
      mus.nextTime += stepDuration();
      mus.step = (mus.step + 1) % (STEPS_PER_BAR * BARS);
    }
  }

  /** Applies intensity to tempo-independent parameters (cutoffs). */
  function applyIntensity() {
    if (!rig || !mus.cfg) return;
    var I = mus.intensity;
    var t = rig.ctx.currentTime;
    rig.musicFilter.frequency.setTargetAtTime(lerp(1200, 9000, I * I), t, 0.25);
    if (rig.layers) {
      rig.layers.padFilter.frequency.setTargetAtTime(lerp(mus.cfg.padCutoff[0], mus.cfg.padCutoff[1], I), t, 0.25);
      rig.layers.arpFilter.frequency.setTargetAtTime(lerp(1800, 6000, I), t, 0.25);
    }
  }

  /** Seeds the daily track by UTC day so every player hears the same variation that day. */
  function trackSeed(trackId) {
    if (trackId === 'daily') return Math.floor(Date.now() / 86400000) * 7919 + 17;
    return (Date.now() & 0xffffff) ^ (trackId === 'menu' ? 0x51ed : 0xa11c);
  }

  function beginMusic(trackId) {
    if (!rig || !contextRunning()) return;
    if (mus.playing && mus.track === trackId) return;
    teardownMusic();
    var cfg = TRACKS[trackId];
    mus.track = trackId;
    mus.cfg = cfg;
    mus.playing = true;
    mus.step = 0;
    mus.arpIdx = 0;
    mus.arpDir = 1;
    mus.rng = lcg(trackSeed(trackId));
    mus.nextTime = rig.ctx.currentTime + 0.05;
    ensureLayers(rig);
    mus.pad = buildPad(rig, cfg);
    applyIntensity();
    setParam(rig.musicFade.gain, 1, 0.4);
    mus.timer = setInterval(schedulerTick, TICK_MS);
    schedulerTick();
    G.log('audio: music start', trackId, Math.round(currentBpm()) + 'bpm');
  }

  /** Stops scheduling and fades the music bus out; the pad is torn down after the fade. */
  function haltMusic(fadeMs) {
    if (!mus.playing) return;
    mus.playing = false;
    clearInterval(mus.timer);
    mus.timer = 0;
    var ms = clamp(num(fadeMs, 600), 0, MAX_DUCK_MS);
    setParam(rig.musicFade.gain, 0, ms / 1000);
    clearTimeout(mus.fadeTimer);
    mus.fadeTimer = setTimeout(teardownMusic, ms + 60);
  }

  /** Stops the scheduler (if still running) and releases the pad oscillators. */
  function teardownMusic() {
    clearTimeout(mus.fadeTimer);
    mus.fadeTimer = 0;
    if (mus.playing) {
      mus.playing = false;
      clearInterval(mus.timer);
      mus.timer = 0;
    }
    if (rig) destroyPad(rig);
  }

  /**
   * Starts the wanted track when the context runs, music is on and the tab is
   * visible; a no-op otherwise (beginMusic also ignores an already-playing track).
   */
  function syncMusic() {
    if (wantedTrack && state.music && !isHidden()) beginMusic(wantedTrack);
  }

  /* ------------------------------------------------------------------ */
  /* Visibility, gesture and storage handling                             */
  /* ------------------------------------------------------------------ */

  function onVisibilityChange() {
    if (isHidden()) {
      haltMusic(120);
      clearTimeout(hiddenSuspendTimer);
      hiddenSuspendTimer = setTimeout(function () {
        if (rig && isHidden() && rig.ctx.state === 'running' && typeof rig.ctx.suspend === 'function') {
          try { rig.ctx.suspend().catch(function () {}); } catch (e) { /* engine refused; harmless */ }
        }
      }, 400);
      return;
    }
    clearTimeout(hiddenSuspendTimer);
    if (!rig || !state.unlocked) return;
    // 'suspended' (our own) or 'interrupted' (iOS) both need a resume first.
    resumeContext(rig.ctx).then(syncMusic, function (e) {
      G.log('audio: resume on visible failed', e);
    });
  }

  /** Any gesture unlocks, or re-resumes after an iOS interruption; free once running. */
  function onGesture() {
    if (rig && rig.ctx.state === 'running' && state.unlocked) return;
    unlock();
  }

  /** Re-applies a setting changed outside this module (mirror pull, import, other tab). */
  function onStorageChange(ev) {
    var key = ev && ev.detail && ev.detail.key;
    if (writingSetting || !has(SETTINGS, key)) return;
    var value = readSetting(key);
    if (state[key] === value) return;
    state[key] = value;
    applySetting(key);
    G.log('audio: setting synced from storage', key, value);
  }

  /** Pushes state.sfx / state.music / state.volume into the running graph. */
  function applySetting(key) {
    if (key === 'sfx') {
      if (!rig) return;
      setParam(rig.sfxBus.gain, state.sfx ? 1 : 0, 0.02);
      if (!state.sfx) rig.voices.slice().forEach(killVoice);
    } else if (key === 'music') {
      if (state.music) syncMusic(); else haltMusic(400);
    } else {
      applyMasterGain(0.05);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Sets up state and listeners. Idempotent, synchronous, never creates an
   * AudioContext. Reads 'sfx' / 'music' / 'volume' from G.storage when present.
   * @returns {Object} the live state object (G.audio.state)
   */
  function init() {
    if (initialised) return state;
    initialised = true;
    state.sfx = readSetting('sfx');
    state.music = readSetting('music');
    state.volume = readSetting('volume');
    state.masterGain = state.volume;
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    ['pointerdown', 'keydown', 'touchend'].forEach(function (type) {
      window.addEventListener(type, onGesture, { capture: true, passive: true });
    });
    window.addEventListener('g:storage', onStorageChange);
    G.log('audio: init', state);
    return state;
  }

  /**
   * Creates/resumes the AudioContext. Call from a user gesture. Idempotent.
   * @returns {Promise<boolean>} true when the context is running
   */
  function unlock() {
    init();
    if (!AudioContextCtor) return Promise.resolve(false);
    if (!rig) {
      var ctxCreated = createContext();
      if (!ctxCreated) return Promise.resolve(false);
      rig = createRig(ctxCreated);
    }
    var ctx = rig.ctx;
    return resumeContext(ctx).then(function () {
      if (!contextRunning()) return false;
      if (!state.unlocked) {
        state.unlocked = true;
        playSilentKick(ctx);
        applyMasterGain(0);
        G.log('audio: unlocked', ctx.sampleRate + 'Hz');
      }
      syncMusic();
      return true;
    }, function (e) {
      G.log('audio: resume failed', e);
      return false;
    });
  }

  /**
   * Plays a named SFX.
   * @param {string} name one of G.audio.names
   * @param {{pitch?:number, step?:number, gain?:number, pan?:number}} [opts]
   *   pitch: semitone offset; step: integer for 'combo' (ascending) and
   *   'countdown' (0 = go); gain: 0..1 voice level; pan: -1..1.
   * @returns {boolean} true when a voice was started
   */
  function play(name, opts) {
    if (!has(SFX, name)) {
      G.log('audio: unknown sfx', name);
      return false;
    }
    if (!state.sfx || state.adMuted || !contextRunning()) return false;
    try {
      triggerSfx(rig, name, opts);
      return true;
    } catch (e) {
      G.log('audio: sfx failed', name, e);
      return false;
    }
  }

  /** @param {boolean} on enable/disable SFX (persisted). */
  function setSfx(on) {
    state.sfx = !!on;
    writeSetting('sfx', state.sfx);
    applySetting('sfx');
  }

  /** @param {boolean} on enable/disable music (persisted); the wanted track resumes when re-enabled. */
  function setMusic(on) {
    state.music = !!on;
    writeSetting('music', state.music);
    applySetting('music');
  }

  /** @param {number} v master volume 0..1 (persisted). */
  function setVolume(v) {
    state.volume = toUnit(v, state.volume);
    writeSetting('volume', state.volume);
    applySetting('volume');
  }

  /**
   * Mutes the master output while an ad plays, regardless of user settings,
   * and restores the configured volume afterwards.
   * @param {boolean} on
   */
  function adMute(on) {
    state.adMuted = !!on;
    applyMasterGain(0.01);
  }

  /**
   * Temporarily lowers the music (e.g. under an important SFX).
   * @param {number} [ms=400] total duck time
   * @param {number} [depth=0.4] 0..1 amount removed from the music level
   */
  function duck(ms, depth) {
    var total = clamp(num(ms, 400), 50, MAX_DUCK_MS) / 1000;
    var d = clamp(num(depth, 0.4), 0, 1);
    clearTimeout(duckTimer);
    state.ducked = true;
    if (rig) {
      var p = rig.duck.gain;
      var t = rig.ctx.currentTime;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(1 - d, t + 0.03);
      p.setValueAtTime(1 - d, t + total * 0.4);
      p.linearRampToValueAtTime(1, t + total);
    }
    duckTimer = setTimeout(function () { state.ducked = false; }, total * 1000);
  }

  /** Silences every SFX voice and stops the music (short fade). For game over / scene changes. */
  function stopAll() {
    wantedTrack = null;
    clearTimeout(duckTimer);
    state.ducked = false;
    if (!rig) return;
    rig.voices.slice().forEach(killVoice);
    haltMusic(200);
    setParam(rig.duck.gain, 1, 0.05);
  }

  /**
   * QA helper: 300 ms sine at A4 straight into the master chain, so it is
   * audible even with SFX switched off (volume and adMute still apply).
   * @returns {boolean} true when the tone was started
   */
  function testTone() {
    if (!contextRunning()) return false;
    var v = createVoice(rig, {}, rig.master);
    tone(v, { type: 'sine', freq: 440, dur: 0.3, attack: 0.01, hold: 0.2, gain: 0.3 });
    finishVoice(v);
    return true;
  }

  /**
   * Renders an SFX through a fresh OfflineAudioContext (same master chain).
   * @param {string} name
   * @param {Object} [opts] same as play()
   * @param {number} [seconds=1.5]
   * @returns {Promise<AudioBuffer>}
   */
  function renderSfx(name, opts, seconds) {
    if (!OfflineContextCtor) return Promise.reject(new Error('OfflineAudioContext unsupported'));
    if (!has(SFX, name)) return Promise.reject(new Error('unknown sfx: ' + name));
    var sampleRate = 44100;
    var length = Math.ceil(sampleRate * clamp(num(seconds, 1.5), 0.05, MAX_RENDER_SECONDS));
    var octx;
    try {
      octx = new OfflineContextCtor(2, length, sampleRate);
    } catch (e) {
      return Promise.reject(e);
    }
    var r = createRig(octx);
    r.master.gain.value = state.volume;
    r.sfxBus.gain.value = 1;
    triggerSfx(r, name, opts || {});
    return new Promise(function (resolve, reject) {
      var p = octx.startRendering();
      if (p && typeof p.then === 'function') {
        p.then(resolve, reject);
      } else {
        octx.oncomplete = function (ev) { resolve(ev.renderedBuffer); };
      }
    });
  }

  var music = {
    /**
     * Starts (or switches to) a track. Before unlock / while music is off the
     * request is remembered and honoured later.
     * @param {'main'|'menu'|'daily'} [trackId='main']
     */
    start: function (trackId) {
      wantedTrack = has(TRACKS, trackId) ? trackId : 'main';
      syncMusic();
    },
    /** Stops the music and forgets the wanted track. @param {number} [fadeMs=600] */
    stop: function (fadeMs) {
      wantedTrack = null;
      haltMusic(fadeMs);
    },
    /** @param {number} x 0..1 drives tempo, cutoffs, hat density, kick pattern and arpeggio octave. */
    setIntensity: function (x) {
      mus.intensity = toUnit(x, mus.intensity);
      applyIntensity();
    },
    /** @returns {boolean} */
    isPlaying: function () {
      return mus.playing;
    },
    /** @returns {number} current tempo of the active (or last) track at the current intensity; 0 before any start. */
    getBpm: currentBpm,
    /** @returns {string|null} the playing track id. */
    getTrack: function () {
      return mus.playing ? mus.track : null;
    },
    /** @returns {number} */
    getIntensity: function () {
      return mus.intensity;
    },
    /** Available track ids. */
    tracks: Object.keys(TRACKS)
  };

  G.audio = {
    init: init,
    unlock: unlock,
    play: play,
    setSfx: setSfx,
    setMusic: setMusic,
    setVolume: setVolume,
    adMute: adMute,
    duck: duck,
    stopAll: stopAll,
    testTone: testTone,
    renderSfx: renderSfx,
    music: music,
    /** Live state snapshot (read-only by convention). */
    state: state,
    /** All SFX names. */
    names: SFX_NAMES,
    /** Whether the Web Audio API exists in this browser. */
    supported: !!AudioContextCtor,
    /** Counters: voicesCreated, voicesDropped, notesScheduled. */
    stats: stats,
    /** Introspection for tests and the debug overlay. */
    _test: {
      get voicesCreated() { return stats.voicesCreated; },
      get notesScheduled() { return stats.notesScheduled; },
      activeVoices: function () { return rig ? rig.voices.length : 0; },
      masterGainValue: function () { return rig ? rig.master.gain.value : null; },
      contextState: function () { return rig ? rig.ctx.state : null; },
      padOscillators: function () { return mus.pad ? mus.pad.length : 0; }
    }
  };
})();
