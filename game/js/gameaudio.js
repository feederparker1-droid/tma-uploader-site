/**
 * G.gameAudio — Tetherloop's gameplay sound layer, built on top of G.audio.
 *
 * G.audio owns the AudioContext, the master chain (sfx bus / music bus →
 * compressor → destination), the UI SFX palette and the generative music.
 * This module adds the sounds that depend on run state and only exist while
 * a run is alive. It never creates a second AudioContext: everything hangs
 * off G.audio.ctx() and G.audio.buses().sfx, so the user's Sound toggle,
 * volume and ad-mute apply automatically.
 *
 *   KEY AND MELODY   newRun() picks a root in A3–E4 and a pentatonic mode from
 *                    the theme (minor for moody skies, major for warm ones) and
 *                    walks an 8-note phrase that resolves to the root. Every
 *                    LATCH plays the next phrase note in the skin's timbre, so
 *                    a long chain of hops sounds like a finished melody.
 *   ORBIT HUM        persistent triangle+sine pair following angular speed
 *                    while TETHERED, lowpassed, panned by comet x, with a 5 Hz
 *                    amplitude wobble over hot planets.
 *   HEAT             persistent bandpassed noise whose gain follows heat², and
 *                    a 1.8 kHz click train from heat 0.5 whose period tightens
 *                    from 300 ms to 60 ms — the audible burn warning.
 *   ONE-SHOTS        RELEASE, HOT_SHOT, GRAZE, LONG_SHOT, LOOP, WALL, SNAP,
 *                    LINE_PASSED, DEATH (three flavours), LAUNCH; each a few
 *                    short-lived nodes torn down when their sources end.
 *   MUSIC CONTROL    setChain() maps chain multiplier + altitude to
 *                    G.audio.music.setIntensity(); death() slams the music bus
 *                    lowpass to 250 Hz and restore() opens it again.
 *
 * Persistent nodes (hum, hiss, click train, LFO, reverb send) are created ONCE
 * per unlocked context and reused; update() only touches AudioParams. Every
 * node creation sits in try/catch; with no unlocked, running context every
 * call is a cheap no-op. No assets, no network, no Math.random (a local
 * mulberry32 seeds the phrase and the noise buffer). Logging via G.log only.
 *
 * SOUND TABLE (voice, envelope, pitch) — see the matching function for detail.
 *   LATCH       phrase note, skin timbre (triangle|sine|square|saw), 12 ms attack,
 *               420 ms exponential decay, into the reverb send; M ≥ 3 adds the
 *               octave above at −8 dB.
 *   RELEASE     noise → bandpass 4 kHz→400 Hz over 150 ms + sine chirp starting at
 *               300 + 600·heat Hz rising ×1.8 over 120 ms (hot releases whistle).
 *   HOT_SHOT    bell: sine 2.4 kHz 80 ms with a 3.6 kHz partial at −12 dB.
 *   GRAZE       20 ms highpassed noise tick + 90 ms sine ping on the scale degree
 *               given by the consecutive-graze count (climbs, wraps after 10).
 *   LONG_SHOT   soft two-note sine ping, two octaves up (root → fifth).
 *   LOOP        triangle arpeggio root–fifth–octave 60 ms apart (300 ms decay)
 *               + sine thump 90→45 Hz 120 ms + "cash" sine 2.4 kHz, gain
 *               0.1 + 0.2·min(1, pool/300).
 *   WALL        "tonk": triangle 220 Hz, 40 ms, lowpass 1 kHz, panned to the wall.
 *   SNAP        sawtooth burst 180 Hz, 60 ms, lowpass 2.5 kHz + 15 ms noise tick.
 *   LINE_PASSED two triangle notes a major third apart (root, +4) 90 ms apart.
 *   DEATH       FELL/CRASHED: sine thud 70→35 Hz over 180 ms + lowpassed noise
 *               crash 1.5 kHz→150 Hz 400 ms (+ highpassed crack when CRASHED).
 *               BURNED: click train cut, 500 ms noise crash lowpass 6 kHz→200 Hz.
 *   BURN_WARN   arms the click train (first blip immediately).
 *   LAUNCH      G.audio 'whoosh' at low gain.   CHUNK: silent.
 *   HUM         triangle + sine (+6 cents) → lowpass → wobble → gain 0.10 → pan;
 *               f = 90 + 60·w, cutoff = 400 + 300·w, w = V_ORBIT / r; in 60 ms,
 *               out 80 ms; pan = (x/540 − 0.5)·1.2 clamped ±0.6; LFO 5 Hz when hot.
 *   HISS        looped noise → bandpass 3 kHz Q 1 → gain 0.18·heat².
 *   CLICKS      persistent 1.8 kHz sine gated by 2 ms gain blips; period
 *               lerp(300, 60 ms) over heat 0.5→1.0, tethered only.
 *   REVERB      local send: two delays 0.23/0.31 s, feedback 0.32, lowpass 3 kHz,
 *               wet 0.22 into the sfx bus (G.audio has no shared reverb).
 *
 * Classic script (IIFE) on window.G. Load after audio.js.
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

  var OfflineContextCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext || null;

  var MINOR_PENT = [0, 3, 5, 7, 10];
  var MAJOR_PENT = [0, 2, 4, 7, 9];
  /** Root range A3..E4 as MIDI (inclusive). */
  var ROOT_LO = 57;
  var ROOT_HI = 64;
  var PHRASE_LEN = 8;
  /** Scale degrees spanned by the phrase walk (two pentatonic octaves). */
  var WALK_SPAN = 10;
  var GRAZE_WRAP = 10;

  var DEFAULT_V_ORBIT = 420;
  var COL_W = 540;

  var HUM_GAIN = 0.10;
  var HUM_IN_S = 0.06;
  var HUM_OUT_S = 0.08;
  var HISS_MAX = 0.18;
  var CLICK_GAIN = 0.3;
  var CLICK_LEN_S = 0.002;
  var CLICK_LOOKAHEAD_S = 0.12;
  var CLICK_PERIOD_HI_S = 0.3;
  var CLICK_PERIOD_LO_S = 0.06;
  var WOBBLE_DEPTH = 0.4;

  var SLAM_HZ = 250;
  var SLAM_S = 0.4;
  var RESTORE_S = 0.3;

  var MAX_VOICES = 16;
  var EPS = 0.0005;
  var LATENCY_S = 0.005;

  var TIMBRES = { triangle: 'triangle', sine: 'sine', square: 'square', saw: 'sawtooth' };
  var STYLE_TIMBRE = { ribbon: 'triangle', beads: 'sine', sparks: 'square', jagged: 'saw' };
  /** Per-timbre level + lowpass so square/saw sit at the same loudness as triangle/sine. */
  var TIMBRE_MIX = {
    triangle: { gain: 0.36, lp: 0 },
    sine: { gain: 0.42, lp: 0 },
    square: { gain: 0.16, lp: 3000 },
    sawtooth: { gain: 0.18, lp: 2600 }
  };

  /* ------------------------------------------------------------------ */
  /* Module state                                                         */
  /* ------------------------------------------------------------------ */

  /** Per-run musical state. */
  var key = {
    root: 60,
    scale: MINOR_PENT,
    mode: 'minor',
    phrase: [60, 63, 65, 67, 70, 67, 65, 60],
    timbre: 'triangle',
    latchCount: 0,
    grazeChain: 0,
    M: 1,
    altM: 0
  };

  /** Continuous-layer state (what update() last asked for). */
  var st = {
    humOn: false,
    humTarget: { f: 0, cutoff: 0, pan: 0, hot: false },
    hiss: 0,
    clickOn: false,
    clickNext: -1,
    clicks: 0,
    slammed: false,
    preSlam: 4000,
    restoreTimer: 0
  };

  /** The persistent live rig (built once per context). */
  var rig = null;
  var initialised = false;

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Local mulberry32 (G.sim may be absent when this module runs). */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Semitones above the root for a scale degree index spanning several octaves. */
  function degreeSemis(scale, deg) {
    var n = scale.length;
    return scale[deg % n] + 12 * Math.floor(deg / n);
  }

  function safeDisconnect(node) {
    try { node.disconnect(); } catch (e) { /* already detached */ }
  }

  function safeStop(src, when) {
    try { src.stop(when); } catch (e) { /* already stopped */ }
  }

  function audio() {
    return G.audio && typeof G.audio.ctx === 'function' ? G.audio : null;
  }

  /** @returns {AudioContext|null} the unlocked context in any state (automation booked while suspended applies on resume). */
  function anyCtx() {
    var A = audio();
    if (!A || !A.state || !A.state.unlocked) return null;
    return A.ctx() || null;
  }

  /** @returns {AudioContext|null} the running, unlocked context — null means "stay silent". */
  function liveCtx() {
    var ctx = anyCtx();
    if (!ctx) return null;
    if (ctx.state && ctx.state !== 'running') return null;
    return ctx;
  }

  /** Like liveCtx() but also false when the SFX toggle or an ad mute makes voices pointless. */
  function audibleCtx() {
    var A = audio();
    if (!A || !A.state.sfx || A.state.adMuted) return null;
    return liveCtx();
  }

  /* ------------------------------------------------------------------ */
  /* Target: where voices render to (live sfx bus or an offline context)  */
  /* ------------------------------------------------------------------ */

  /** 2 s of deterministic white noise. */
  function makeNoise(ctx) {
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var rnd = mulberry32(0x5eed);
    for (var i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
    return buf;
  }

  /**
   * Feedback-delay reverb send (two delays 0.23/0.31 s cross-fed at 0.32,
   * lowpass 3 kHz, wet 0.22) feeding `bus`. Returns its input node.
   */
  function makeReverb(ctx, bus) {
    var input = ctx.createGain();
    input.gain.value = 1;
    var d1 = ctx.createDelay(1);
    d1.delayTime.value = 0.23;
    var d2 = ctx.createDelay(1);
    d2.delayTime.value = 0.31;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    lp.Q.value = 0.5;
    var fb = ctx.createGain();
    fb.gain.value = 0.32;
    var wet = ctx.createGain();
    wet.gain.value = 0.22;
    input.connect(d1);
    input.connect(d2);
    d1.connect(lp);
    d2.connect(lp);
    lp.connect(fb);
    fb.connect(d1);
    fb.connect(d2);
    lp.connect(wet);
    wet.connect(bus);
    return input;
  }

  /** A render target: context, output bus, noise buffer, reverb input and voice list. */
  function makeTarget(ctx, bus) {
    var T = { ctx: ctx, bus: bus, noise: makeNoise(ctx), reverbIn: null, voices: [] };
    try { T.reverbIn = makeReverb(ctx, bus); } catch (e) { G.log('gameaudio: reverb unavailable', e); }
    return T;
  }

  /* ------------------------------------------------------------------ */
  /* Persistent live rig: hum, hiss, click train                          */
  /* ------------------------------------------------------------------ */

  /**
   * Builds (once) the long-lived nodes on the live context. Rebuilt only if
   * G.audio ever hands out a different context.
   */
  function ensureRig(ctx) {
    if (rig && rig.ctx === ctx) return rig;
    var A = audio();
    var buses = A && typeof A.buses === 'function' ? A.buses() : null;
    if (!buses || !buses.sfx) return null;
    try {
      var T = makeTarget(ctx, buses.sfx);
      var R = { ctx: ctx, T: T, buses: buses };

      // Orbit hum: oscA (triangle) + oscB (sine, +6 cents) → lowpass → wobble → gain → pan → sfx.
      R.humPan = null;
      var humTail = buses.sfx;
      if (typeof ctx.createStereoPanner === 'function') {
        R.humPan = ctx.createStereoPanner();
        R.humPan.pan.value = 0;
        R.humPan.connect(buses.sfx);
        humTail = R.humPan;
      }
      R.humGain = ctx.createGain();
      R.humGain.gain.value = 0;
      R.humGain.connect(humTail);
      R.wobble = ctx.createGain();
      R.wobble.gain.value = 1;
      R.wobble.connect(R.humGain);
      R.humFilter = ctx.createBiquadFilter();
      R.humFilter.type = 'lowpass';
      R.humFilter.frequency.value = 400;
      R.humFilter.Q.value = 1;
      R.humFilter.connect(R.wobble);
      R.oscA = ctx.createOscillator();
      R.oscA.type = 'triangle';
      R.oscA.frequency.value = 174;
      R.oscA.connect(R.humFilter);
      R.oscB = ctx.createOscillator();
      R.oscB.type = 'sine';
      R.oscB.frequency.value = 174;
      R.oscB.detune.value = 6;
      R.oscB.connect(R.humFilter);
      // 5 Hz amplitude wobble: lfo → depth → wobble.gain (summed with its base value 1).
      R.lfo = ctx.createOscillator();
      R.lfo.type = 'sine';
      R.lfo.frequency.value = 5;
      R.lfoDepth = ctx.createGain();
      R.lfoDepth.gain.value = 0;
      R.lfo.connect(R.lfoDepth);
      R.lfoDepth.connect(R.wobble.gain);

      // Heat hiss: looped noise → bandpass 3 kHz Q 1 → gain → sfx.
      R.hissGain = ctx.createGain();
      R.hissGain.gain.value = 0;
      R.hissGain.connect(buses.sfx);
      R.hissFilter = ctx.createBiquadFilter();
      R.hissFilter.type = 'bandpass';
      R.hissFilter.frequency.value = 3000;
      R.hissFilter.Q.value = 1;
      R.hissFilter.connect(R.hissGain);
      R.hissSrc = ctx.createBufferSource();
      R.hissSrc.buffer = T.noise;
      R.hissSrc.loop = true;
      R.hissSrc.connect(R.hissFilter);

      // Click train: 1.8 kHz sine gated by 2 ms gain blips scheduled in update().
      R.clickGain = ctx.createGain();
      R.clickGain.gain.value = 0;
      R.clickGain.connect(buses.sfx);
      R.clickOsc = ctx.createOscillator();
      R.clickOsc.type = 'sine';
      R.clickOsc.frequency.value = 1800;
      R.clickOsc.connect(R.clickGain);

      R.oscA.start();
      R.oscB.start();
      R.lfo.start();
      R.hissSrc.start();
      R.clickOsc.start();

      st.humOn = false;
      st.clickOn = false;
      st.clickNext = -1;
      rig = R;
      G.log('gameaudio: rig built');
      return rig;
    } catch (e) {
      G.log('gameaudio: rig failed', e);
      return null;
    }
  }

  /** Ramp an AudioParam linearly from its current value (discarding queued automation). */
  function rampTo(param, value, seconds, t) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

  /** Smooth per-frame follow (no event pile-up concerns: past events are pruned). */
  function follow(param, value, tau, t) {
    param.setTargetAtTime(value, t, tau);
  }

  function humOff(R, t) {
    if (!st.humOn) return;
    st.humOn = false;
    rampTo(R.humGain.gain, 0, HUM_OUT_S, t);
  }

  function clickOff(R, t) {
    st.clickOn = false;
    st.clickNext = -1;
    var g = R.clickGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
  }

  /** Books click blips inside the lookahead window at the current heat period. */
  function clickSchedule(R, heat, t) {
    var period = lerp(CLICK_PERIOD_HI_S, CLICK_PERIOD_LO_S, clamp((heat - 0.5) / 0.5, 0, 1));
    if (st.clickNext < t) st.clickNext = t + LATENCY_S;
    var g = R.clickGain.gain;
    var guard = 0;
    while (st.clickNext < t + CLICK_LOOKAHEAD_S && guard++ < 8) {
      var c = st.clickNext;
      g.setValueAtTime(0, c);
      g.linearRampToValueAtTime(CLICK_GAIN, c + 0.0005);
      g.setValueAtTime(CLICK_GAIN, c + CLICK_LEN_S - 0.0005);
      g.linearRampToValueAtTime(0, c + CLICK_LEN_S);
      st.clickNext += period;
      st.clicks++;
    }
    st.clickOn = true;
  }

  /* ------------------------------------------------------------------ */
  /* One-shot voice toolkit                                               */
  /* ------------------------------------------------------------------ */

  /**
   * One short-lived voice: an output gain (+ optional panner) into the target
   * bus and an optional send into the reverb. Sources/nodes are recorded so
   * the voice can be torn down when the last source ends.
   */
  function voice(T, opts) {
    var ctx = T.ctx;
    var out = ctx.createGain();
    out.gain.value = clamp(num(opts.gain, 1), 0, 1);
    var nodes = [out];
    var tail = out;
    var pan = clamp(num(opts.pan, 0), -1, 1);
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      var p = ctx.createStereoPanner();
      p.pan.value = pan;
      out.connect(p);
      tail = p;
      nodes.push(p);
    }
    tail.connect(T.bus);
    var send = clamp(num(opts.send, 0), 0, 1);
    if (send > 0 && T.reverbIn) {
      var s = ctx.createGain();
      s.gain.value = send;
      out.connect(s);
      s.connect(T.reverbIn);
      nodes.push(s);
    }
    return { T: T, ctx: ctx, t0: ctx.currentTime + LATENCY_S, out: out, nodes: nodes, sources: [], pending: 0 };
  }

  /** Attack → (hold) → exponential decay to silence at `end`. */
  function envelope(param, t, end, attack, peak, hold) {
    var dur = end - t;
    var a = clamp(attack || 0.003, 0.0005, dur * 0.5);
    var decayStart = Math.max(t + a, Math.min(t + a + (hold || 0), end - 0.005));
    param.setValueAtTime(EPS, t);
    param.linearRampToValueAtTime(peak, t + a);
    if (hold) param.setValueAtTime(peak, decayStart);
    param.exponentialRampToValueAtTime(EPS, end);
  }

  /** Optional filter between a source and its envelope gain. */
  function filterStage(v, type, f0, f1, q, t, end, into) {
    if (!type || !f0) return into;
    var f = v.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, end);
    f.Q.value = q || 0.7;
    f.connect(into);
    v.nodes.push(f);
    return f;
  }

  /**
   * Oscillator voice. spec: { at, dur, type, freq, to, glide, attack, hold, gain, lp, lpTo, q }
   */
  function osc(v, s) {
    var ctx = v.ctx;
    var t = v.t0 + (s.at || 0);
    var end = t + s.dur;
    var o = ctx.createOscillator();
    o.type = s.type || 'sine';
    o.frequency.setValueAtTime(s.freq, t);
    if (s.to) o.frequency.exponentialRampToValueAtTime(s.to, t + (s.glide || s.dur));
    var g = ctx.createGain();
    envelope(g.gain, t, end, s.attack, s.gain || 0.3, s.hold);
    g.connect(v.out);
    o.connect(filterStage(v, s.lp ? 'lowpass' : null, s.lp, s.lpTo, s.q, t, end, g));
    v.nodes.push(o, g);
    o.start(t);
    o.stop(end + 0.01);
    v.sources.push(o);
  }

  /**
   * Filtered noise burst. spec: { at, dur, attack, hold, gain, filter, freq, to, q }
   */
  function noise(v, s) {
    var ctx = v.ctx;
    var t = v.t0 + (s.at || 0);
    var end = t + s.dur;
    var src = ctx.createBufferSource();
    src.buffer = v.T.noise;
    src.loop = true;
    var g = ctx.createGain();
    envelope(g.gain, t, end, s.attack, s.gain || 0.3, s.hold);
    g.connect(v.out);
    src.connect(filterStage(v, s.filter, s.freq, s.to, s.q, t, end, g));
    v.nodes.push(src, g);
    src.start(t);
    src.stop(end + 0.01);
    v.sources.push(src);
  }

  function disposeVoice(v) {
    var i = v.T.voices.indexOf(v);
    if (i >= 0) v.T.voices.splice(i, 1);
    v.nodes.forEach(safeDisconnect);
    v.nodes.length = 0;
  }

  function killVoice(v) {
    var t = v.ctx.currentTime;
    try {
      v.out.gain.cancelScheduledValues(t);
      v.out.gain.setValueAtTime(v.out.gain.value, t);
      v.out.gain.linearRampToValueAtTime(0, t + 0.015);
    } catch (e) { /* param already gone */ }
    v.sources.forEach(function (src) { safeStop(src, t + 0.02); });
    var i = v.T.voices.indexOf(v);
    if (i >= 0) v.T.voices.splice(i, 1);
  }

  /** Registers the voice and tears it down once every source has ended. */
  function finish(v) {
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
    v.T.voices.push(v);
    while (v.T.voices.length > MAX_VOICES) killVoice(v.T.voices[0]);
  }

  /** Runs a recipe inside a fresh voice; a throwing recipe leaves nothing connected. */
  function play(T, opts, recipe) {
    var v;
    try {
      v = voice(T, opts || {});
    } catch (e) {
      G.log('gameaudio: voice failed', e);
      return false;
    }
    try {
      recipe(v);
    } catch (e) {
      v.sources.forEach(function (src) { safeStop(src, 0); });
      disposeVoice(v);
      G.log('gameaudio: recipe failed', e);
      return false;
    }
    finish(v);
    return true;
  }

  /** Column x → stereo pan in [-0.6, 0.6]. */
  function panOf(x) {
    return clamp((num(x, COL_W / 2) / COL_W - 0.5) * 1.2, -0.6, 0.6);
  }

  /* ------------------------------------------------------------------ */
  /* Sound recipes                                                        */
  /* ------------------------------------------------------------------ */

  /** Info the recipes need from the run state (computed without mutating it). */
  function info() {
    return {
      midi: key.phrase[key.latchCount % PHRASE_LEN],
      M: key.M,
      grazeDeg: key.grazeChain % GRAZE_WRAP
    };
  }

  /**
   * LATCH — phrase note in the skin timbre: 12 ms attack, 420 ms exponential
   * decay, 70% into the reverb send. M ≥ 3 doubles the note an octave up at −8 dB.
   */
  function sfxLatch(T, evt, inf) {
    var type = TIMBRES[key.timbre] || 'triangle';
    var mix = TIMBRE_MIX[type];
    var hz = midiToHz(inf.midi);
    play(T, { pan: panOf(evt.x) * 0.5, send: 0.7 }, function (v) {
      osc(v, { type: type, freq: hz, dur: 0.42, attack: 0.012, gain: mix.gain, lp: mix.lp });
      if (inf.M >= 3) {
        osc(v, { type: type, freq: hz * 2, dur: 0.36, attack: 0.012, gain: mix.gain * 0.4, lp: mix.lp });
      }
    });
  }

  /** RELEASE — noise bandpass 4 kHz→400 Hz 150 ms + sine chirp from 300 + 600·heat Hz rising ×1.8. */
  function sfxRelease(T, evt) {
    var heat = clamp(num(evt.heat, 0), 0, 1);
    var f0 = 300 + 600 * heat;
    play(T, { pan: panOf(evt.x) }, function (v) {
      noise(v, { dur: 0.15, attack: 0.004, gain: 0.3, filter: 'bandpass', freq: 4000, to: 400, q: 1.2 });
      osc(v, { type: 'sine', freq: f0, to: f0 * 1.8, glide: 0.12, dur: 0.14, attack: 0.004, gain: 0.16 + 0.1 * heat });
    });
  }

  /** HOT_SHOT — bell: sine 2.4 kHz 80 ms + 3.6 kHz partial at −12 dB, into the send. */
  function sfxHotShot(T) {
    play(T, { send: 0.6 }, function (v) {
      osc(v, { type: 'sine', freq: 2400, dur: 0.08, attack: 0.002, gain: 0.3 });
      osc(v, { type: 'sine', freq: 3600, dur: 0.06, attack: 0.002, gain: 0.075 });
    });
  }

  /** GRAZE — 20 ms highpassed (3 kHz) noise tick + 90 ms sine ping on scale degree grazeChain mod 10 (an octave above the root). */
  function sfxGraze(T, evt, inf) {
    var hz = midiToHz(key.root + 12 + degreeSemis(key.scale, inf.grazeDeg));
    play(T, { pan: panOf(evt.x), send: 0.3 }, function (v) {
      noise(v, { dur: 0.02, attack: 0.001, gain: 0.25, filter: 'highpass', freq: 3000 });
      osc(v, { type: 'sine', freq: hz, dur: 0.09, attack: 0.002, gain: 0.28 });
    });
  }

  /** LONG_SHOT — soft two-note sine ping two octaves up: root then fifth, 70 ms apart. */
  function sfxLongShot(T) {
    var base = key.root + 24;
    play(T, { send: 0.5 }, function (v) {
      osc(v, { type: 'sine', freq: midiToHz(base), dur: 0.08, attack: 0.002, gain: 0.18 });
      osc(v, { at: 0.07, type: 'sine', freq: midiToHz(base + 7), dur: 0.12, attack: 0.002, gain: 0.18 });
    });
  }

  /**
   * LOOP — triangle arpeggio root, fifth, octave (60 ms apart, 300 ms decay)
   * + sine thump 90→45 Hz over 100 ms (120 ms) + "cash" sine 2.4 kHz (120 ms)
   * with gain 0.1 + 0.2·min(1, pooledBefore / 300).
   */
  function sfxLoop(T, evt) {
    var pool = Math.max(0, num(evt.pooledBefore, 0));
    var cash = 0.1 + 0.2 * Math.min(1, pool / 300);
    var r = key.root + 12;
    play(T, { pan: panOf(evt.x) * 0.5, send: 0.6 }, function (v) {
      osc(v, { type: 'triangle', freq: midiToHz(r), dur: 0.3, attack: 0.004, gain: 0.3 });
      osc(v, { at: 0.06, type: 'triangle', freq: midiToHz(r + 7), dur: 0.3, attack: 0.004, gain: 0.3 });
      osc(v, { at: 0.12, type: 'triangle', freq: midiToHz(r + 12), dur: 0.3, attack: 0.004, gain: 0.3 });
      osc(v, { type: 'sine', freq: 90, to: 45, glide: 0.1, dur: 0.12, attack: 0.002, gain: 0.6 });
      osc(v, { at: 0.12, type: 'sine', freq: 2400, dur: 0.12, attack: 0.002, gain: cash });
      osc(v, { at: 0.12, type: 'sine', freq: 4800, dur: 0.08, attack: 0.002, gain: cash * 0.25 });
    });
  }

  /** WALL — "tonk": triangle 220 Hz 40 ms through a 1 kHz lowpass, panned toward the wall. */
  function sfxWall(T, evt) {
    var side = num(evt.side, 0);
    play(T, { pan: clamp(side, -1, 1) * 0.5 }, function (v) {
      osc(v, { type: 'triangle', freq: 220, dur: 0.04, attack: 0.002, gain: 0.45, lp: 1000 });
    });
  }

  /** SNAP — sawtooth burst 180 Hz 60 ms (lowpass 2.5 kHz) + 15 ms highpassed tick. */
  function sfxSnap(T, evt) {
    play(T, { pan: panOf(evt.x) }, function (v) {
      osc(v, { type: 'sawtooth', freq: 180, dur: 0.06, attack: 0.002, gain: 0.3, lp: 2500 });
      noise(v, { dur: 0.015, attack: 0.001, gain: 0.15, filter: 'highpass', freq: 2000 });
    });
  }

  /** LINE_PASSED — two triangle notes a major third apart (root+12, root+16), 90 ms apart. */
  function sfxLinePassed(T) {
    var r = key.root + 12;
    play(T, { send: 0.6 }, function (v) {
      osc(v, { type: 'triangle', freq: midiToHz(r), dur: 0.16, attack: 0.004, gain: 0.3 });
      osc(v, { at: 0.09, type: 'triangle', freq: midiToHz(r + 4), dur: 0.24, attack: 0.004, gain: 0.3 });
    });
  }

  /**
   * DEATH — FELL/CRASHED: sine thud 70→35 Hz over 180 ms + lowpassed noise crash
   * 1.5 kHz→150 Hz over 400 ms (CRASHED adds a 60 ms highpassed crack).
   * BURNED: 500 ms noise crash with lowpass sweeping 6 kHz→200 Hz.
   */
  function sfxDeath(T, evt) {
    var burned = evt.deathType === 'BURNED';
    play(T, { pan: panOf(evt.x) * 0.5 }, function (v) {
      if (burned) {
        noise(v, { dur: 0.5, attack: 0.004, gain: 0.6, filter: 'lowpass', freq: 6000, to: 200, q: 0.8 });
        return;
      }
      osc(v, { type: 'sine', freq: 70, to: 35, glide: 0.18, dur: 0.2, attack: 0.002, gain: 0.7 });
      noise(v, { dur: 0.4, attack: 0.004, gain: 0.5, filter: 'lowpass', freq: 1500, to: 150, q: 0.8 });
      if (evt.deathType === 'CRASHED') {
        noise(v, { dur: 0.06, attack: 0.001, gain: 0.3, filter: 'highpass', freq: 2500 });
      }
    });
  }

  /**
   * Dispatches one event to its recipe inside target T. Pure synthesis: no
   * counters, no live-rig side effects (those live in onEvent).
   * @returns {boolean} true when the event has a sound
   */
  function fire(T, evt, inf) {
    switch (evt.type) {
      case 'LATCH': sfxLatch(T, evt, inf); return true;
      case 'RELEASE': sfxRelease(T, evt); return true;
      case 'HOT_SHOT': sfxHotShot(T); return true;
      case 'GRAZE': sfxGraze(T, evt, inf); return true;
      case 'LONG_SHOT': sfxLongShot(T); return true;
      case 'LOOP': sfxLoop(T, evt); return true;
      case 'WALL': sfxWall(T, evt); return true;
      case 'SNAP': sfxSnap(T, evt); return true;
      case 'LINE_PASSED': sfxLinePassed(T); return true;
      case 'DEATH': sfxDeath(T, evt); return true;
      default: return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */

  /** Idempotent; creates nothing (the rig is built lazily once G.audio is unlocked). */
  function init() {
    if (initialised) return;
    initialised = true;
    if (G.audio && typeof G.audio.init === 'function') {
      try { G.audio.init(); } catch (e) { G.log('gameaudio: audio init failed', e); }
    }
    G.log('gameaudio: init');
  }

  /**
   * Seeds the run's key: root A3–E4, pentatonic mode by theme.mood
   * ('major' → major pentatonic, anything else → minor), an 8-note phrase by a
   * seeded random walk (steps −2..+2 degrees over two octaves) that resolves to
   * the root on note 8, and the latch timbre from skin.timbre (or skin.style).
   * Also opens the music lowpass again if a death left it slammed.
   * @param {{seed:number, skin?:Object, theme?:Object}} opts
   */
  function newRun(opts) {
    opts = opts || {};
    var seed = (num(opts.seed, 1) >>> 0) ^ 0xA0D10;
    var rnd = mulberry32(seed);
    var theme = opts.theme || {};
    var skin = opts.skin || {};

    key.mode = theme.mood === 'major' ? 'major' : 'minor';
    key.scale = key.mode === 'major' ? MAJOR_PENT : MINOR_PENT;
    key.root = ROOT_LO + Math.floor(rnd() * (ROOT_HI - ROOT_LO + 1));

    var deg = Math.floor(rnd() * key.scale.length);
    var phrase = [];
    for (var i = 0; i < PHRASE_LEN; i++) {
      if (i === PHRASE_LEN - 1) {
        deg = deg >= key.scale.length ? key.scale.length : 0; // nearest root (octave or unison)
      } else if (i > 0) {
        var step = Math.floor(rnd() * 5) - 2;
        if (step === 0) step = rnd() < 0.5 ? -1 : 1;
        deg = clamp(deg + step, 0, WALK_SPAN - 1);
      }
      phrase.push(key.root + degreeSemis(key.scale, deg));
    }
    key.phrase = phrase;

    var timbre = typeof skin.timbre === 'string' ? skin.timbre : STYLE_TIMBRE[skin.style];
    key.timbre = TIMBRES[timbre] ? timbre : 'triangle';
    key.latchCount = 0;
    key.grazeChain = 0;
    key.M = 1;
    key.altM = 0;

    restore();
    G.log('gameaudio: newRun root', key.root, key.mode, key.timbre, phrase.join(' '));
  }

  /** Tracks the chain multiplier from events that carry it; a drop resets the graze climb. */
  function trackM(M) {
    M = num(M, NaN);
    if (!isFinite(M)) return;
    if (M < key.M) key.grazeChain = 0;
    key.M = M;
  }

  /**
   * Plays the sound for one sim event (any {type,...} object; unknown types are
   * ignored). Counters advance even while silent so the melody position keeps
   * following play.
   */
  function onEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    if (evt.M !== undefined) trackM(evt.M);
    var inf = info();

    // Bookkeeping independent of audibility.
    switch (evt.type) {
      case 'LATCH': key.latchCount++; break;
      case 'GRAZE': key.grazeChain++; break;
      default: break;
    }

    // Side effects on the persistent layers (need a live context).
    var ctx = liveCtx();
    if (ctx && rig) {
      var t = ctx.currentTime;
      try {
        if (evt.type === 'BURN_WARN') {
          st.clickNext = t + LATENCY_S; // first blip now; update() keeps the train going
        } else if (evt.type === 'DEATH') {
          clickOff(rig, t);
          humOff(rig, t);
          follow(rig.hissGain.gain, 0, 0.05, t);
          st.hiss = 0;
        } else if (evt.type === 'RELEASE' || evt.type === 'SNAP') {
          clickOff(rig, t);
        }
      } catch (e) {
        G.log('gameaudio: layer side effect failed', e);
      }
    }
    if (evt.type === 'DEATH') death();

    var actx = audibleCtx();
    if (!actx) return;
    if (evt.type === 'LAUNCH') {
      G.audio.play('whoosh', { gain: 0.35 });
      return;
    }
    var R = ensureRig(actx);
    if (!R) return;
    fire(R.T, evt, inf);
  }

  /**
   * Drives the continuous layers from the run state; call once per rendered frame.
   * Hum while run.state === 'TETHERED' (frequency/cutoff from w = V_ORBIT / r,
   * pan from comet x, 5 Hz wobble over a hot planet), heat hiss from run.heat
   * while TETHERED or in FLIGHT, click train while tethered with heat ≥ 0.5.
   * Only AudioParams are touched here; no nodes are created after the rig exists.
   * @param {Object|null} run  the sim Run (see sim contract)
   * @param {number} dt        frame seconds (unused for now; kept for the contract)
   */
  function update(run, dt) { // eslint-disable-line no-unused-vars
    var ctx = liveCtx();
    if (!ctx) return;
    var R = ensureRig(ctx);
    if (!R) return;
    var t = ctx.currentTime;
    try {
      var state = run && typeof run.state === 'string' ? run.state : 'DEAD';
      var tether = run && run.tether;
      var tethered = state === 'TETHERED' && !!tether;
      var heat = (state === 'TETHERED' || state === 'FLIGHT') ? clamp(num(run.heat, 0), 0, 1) : 0;

      if (tethered) {
        var r = Math.max(20, num(tether.r, 120));
        var V = G.CONFIG && isFinite(G.CONFIG.V_ORBIT) ? G.CONFIG.V_ORBIT : DEFAULT_V_ORBIT;
        var w = V / r;
        var f = 90 + 60 * w;
        var cutoff = 400 + 300 * w;
        var pan = panOf(run.comet && run.comet.x);
        var planet = null;
        if (run.planets) {
          planet = typeof run.planets.get === 'function' ? run.planets.get(tether.planetId) : run.planets[tether.planetId];
        }
        var hot = !!(planet && planet.hot);
        follow(R.oscA.frequency, f, 0.03, t);
        follow(R.oscB.frequency, f, 0.03, t);
        follow(R.humFilter.frequency, cutoff, 0.03, t);
        if (R.humPan) follow(R.humPan.pan, pan, 0.05, t);
        if (hot !== st.humTarget.hot || !st.humOn) follow(R.lfoDepth.gain, hot ? WOBBLE_DEPTH : 0, 0.1, t);
        st.humTarget.f = f;
        st.humTarget.cutoff = cutoff;
        st.humTarget.pan = pan;
        st.humTarget.hot = hot;
        if (!st.humOn) {
          st.humOn = true;
          rampTo(R.humGain.gain, HUM_GAIN, HUM_IN_S, t);
        }
      } else {
        humOff(R, t);
      }

      var hiss = HISS_MAX * heat * heat;
      if (Math.abs(hiss - st.hiss) > 0.0005 || (hiss === 0 && st.hiss !== 0)) {
        follow(R.hissGain.gain, hiss, 0.03, t);
        st.hiss = hiss;
      }

      if (tethered && heat >= 0.5) {
        clickSchedule(R, heat, t);
      } else if (st.clickOn) {
        clickOff(R, t);
      }
    } catch (e) {
      G.log('gameaudio: update failed', e);
    }
  }

  /**
   * Music layer control: intensity = clamp((M − 1) / 4 + altM / 4000, 0, 1).
   * @param {number} M     chain multiplier (1..5)
   * @param {number} altM  altitude in metres
   */
  function setChain(M, altM) {
    trackM(M);
    key.altM = num(altM, key.altM);
    var I = clamp((num(M, 1) - 1) / 4 + key.altM / 4000, 0, 1);
    var A = audio();
    if (A && A.music && typeof A.music.setIntensity === 'function') A.music.setIntensity(I);
  }

  function musicFilter() {
    var A = audio();
    var buses = A && typeof A.buses === 'function' ? A.buses() : null;
    return buses && buses.musicFilter && buses.musicFilter.frequency ? buses.musicFilter : null;
  }

  /** Slams the music bus lowpass to 250 Hz over 400 ms (fallback: a deep duck). */
  function death() {
    var ctx = anyCtx();
    if (!ctx) return;
    var fl = musicFilter();
    if (!fl) {
      if (G.audio && typeof G.audio.duck === 'function') G.audio.duck(400, 0.9);
      return;
    }
    try {
      var p = fl.frequency;
      var t = ctx.currentTime;
      clearTimeout(st.restoreTimer);
      if (!st.slammed) st.preSlam = clamp(num(p.value, 4000), SLAM_HZ, 20000);
      st.slammed = true;
      p.cancelScheduledValues(t);
      p.setValueAtTime(Math.max(num(p.value, st.preSlam), SLAM_HZ + 1), t);
      p.exponentialRampToValueAtTime(SLAM_HZ, t + SLAM_S);
    } catch (e) {
      G.log('gameaudio: slam failed', e);
    }
  }

  /** Opens the music lowpass again over 300 ms, then hands the cutoff back to music.setIntensity(). */
  function restore() {
    if (!st.slammed) return;
    var ctx = anyCtx();
    var fl = musicFilter();
    if (!ctx || !fl) return; // keeps `slammed` so a later call (retry / newRun) finishes the job
    st.slammed = false;
    try {
      var p = fl.frequency;
      var t = ctx.currentTime;
      p.cancelScheduledValues(t);
      p.setValueAtTime(Math.max(num(p.value, SLAM_HZ), 1), t);
      p.linearRampToValueAtTime(st.preSlam, t + RESTORE_S);
      clearTimeout(st.restoreTimer);
      st.restoreTimer = setTimeout(function () {
        var A = audio();
        if (A && A.music && typeof A.music.getIntensity === 'function') A.music.setIntensity(A.music.getIntensity());
      }, RESTORE_S * 1000 + 20);
    } catch (e) {
      G.log('gameaudio: restore failed', e);
    }
  }

  /** New best / duel won fanfare (G.audio 'newBest'). */
  function newBest() {
    var A = audio();
    if (A) A.play('newBest');
  }

  /** UI sounds pass straight through to G.audio.play. @returns {boolean} */
  function ui(name) {
    var A = audio();
    return !!(A && typeof name === 'string' && A.play(name));
  }

  /** Silences every gameplay voice and layer (pause / scene change). Rig is kept. */
  function silence() {
    var ctx = liveCtx();
    if (!ctx || !rig) return;
    var t = ctx.currentTime;
    try {
      rig.T.voices.slice().forEach(killVoice);
      humOff(rig, t);
      clickOff(rig, t);
      follow(rig.hissGain.gain, 0, 0.03, t);
      st.hiss = 0;
    } catch (e) {
      G.log('gameaudio: silence failed', e);
    }
  }

  /**
   * Renders one event's sound through an OfflineAudioContext (own master gain +
   * compressor, same voice code) for QA/tests. Uses the current run key; never
   * touches the live rig or counters.
   * @param {Object} evt
   * @param {number} [seconds=1.5]
   * @returns {Promise<AudioBuffer>}
   */
  function renderEvent(evt, seconds) {
    if (!OfflineContextCtor) return Promise.reject(new Error('OfflineAudioContext unsupported'));
    if (!evt || typeof evt.type !== 'string') return Promise.reject(new Error('bad event'));
    var sampleRate = 44100;
    var length = Math.ceil(sampleRate * clamp(num(seconds, 1.5), 0.05, 30));
    var octx;
    try {
      octx = new OfflineContextCtor(2, length, sampleRate);
      var comp = octx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 12;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      comp.connect(octx.destination);
      var master = octx.createGain();
      master.gain.value = 0.8;
      master.connect(comp);
      var T = makeTarget(octx, master);
      if (!fire(T, evt, info())) return Promise.reject(new Error('silent event: ' + evt.type));
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise(function (resolve, reject) {
      var p = octx.startRendering();
      if (p && typeof p.then === 'function') {
        p.then(resolve, reject);
      } else {
        octx.oncomplete = function (ev) { resolve(ev.renderedBuffer); };
      }
    });
  }

  G.gameAudio = {
    init: init,
    newRun: newRun,
    onEvent: onEvent,
    update: update,
    setChain: setChain,
    death: death,
    restore: restore,
    newBest: newBest,
    ui: ui,
    silence: silence,
    renderEvent: renderEvent,
    /** Read-only snapshot of the run key (root MIDI, mode, phrase, timbre, counters). */
    get key() {
      return {
        root: key.root, mode: key.mode, scale: key.scale.slice(), phrase: key.phrase.slice(), timbre: key.timbre,
        latchCount: key.latchCount, grazeChain: key.grazeChain, M: key.M, altM: key.altM
      };
    },
    /** Introspection for tests and the debug overlay. */
    _test: {
      rigBuilt: function () { return !!rig; },
      activeVoices: function () { return rig ? rig.T.voices.length : 0; },
      snapshot: function () {
        return {
          humOn: st.humOn,
          humTarget: { f: st.humTarget.f, cutoff: st.humTarget.cutoff, pan: st.humTarget.pan, hot: st.humTarget.hot },
          humFreq: rig ? rig.oscA.frequency.value : 0,
          humGain: rig ? rig.humGain.gain.value : 0,
          humCutoff: rig ? rig.humFilter.frequency.value : 0,
          humPan: rig && rig.humPan ? rig.humPan.pan.value : 0,
          wobble: rig ? rig.lfoDepth.gain.value : 0,
          hiss: st.hiss,
          hissGain: rig ? rig.hissGain.gain.value : 0,
          clickOn: st.clickOn,
          clicks: st.clicks,
          slammed: st.slammed
        };
      },
      clicks: function () { return st.clicks; },
      musicCutoff: function () {
        var fl = musicFilter();
        return fl ? fl.frequency.value : null;
      }
    }
  };
})();
