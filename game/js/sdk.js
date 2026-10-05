/*!
 * G.sdk — one adapter for every place the game can be hosted.
 *
 * Providers: 'crazygames' | 'poki' | 'gd' (GameDistribution) | 'telegram' | 'none'.
 * The game code never talks to a vendor SDK directly; it calls G.sdk and gets
 * the same promise-shaped answers everywhere. Zero network by default: the
 * vendor script is loaded only for the provider that was detected or forced
 * via ?sdk=…, and a load failure or 4s timeout degrades to "no ads" without
 * ever rejecting init().
 *
 * Classic script (IIFE), no dependencies, works from file://.
 *
 * Public API (JSDoc on each member below):
 *   G.sdk.init(config)                 → Promise<void>  (never rejects, idempotent)
 *   G.sdk.provider / ready / caps / user / safeArea / stats / sessionStart
 *   G.sdk.isMobile / isStandalone / hapticsEnabled
 *   G.sdk.loadingStart() loadingStop() gameplayStart() gameplayStop() happyTime()
 *   G.sdk.showInterstitial({placement}) → Promise<{shown, reason?}>
 *   G.sdk.showRewarded({placement})     → Promise<{rewarded, reason?}>
 *   G.sdk.canShowRewarded()             → boolean
 *   G.sdk.share({text, url?, params?})  → Promise<{ok, method, url?, reason?}>
 *   G.sdk.getParam(name)                → string|null
 *   G.sdk.haptic(kind)
 *   G.sdk.purchase(itemId, {title, stars}) → Promise<{ok, status}>
 *   G.sdk.onPause(cb) / onResume(cb)    → unsubscribe function
 *   G.sdk.banner.show(containerId) / banner.clear(containerId)
 *   G.sdk.tg / cg / poki / gd           raw vendor objects (null when absent)
 *   G.sdk._test                         test seams: now(), loadScript(), timeouts, setProvider()
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

  /** Provider identifiers accepted by ?sdk= and exposed as G.sdk.provider. */
  var PROVIDERS = ['crazygames', 'poki', 'gd', 'telegram', 'none'];

  /** Vendor script URLs — loaded only for the active provider. */
  var SCRIPT_URLS = {
    crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
    poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
    gd: 'https://html5.api.gamedistribution.com/main.min.js',
    telegram: 'https://telegram.org/js/telegram-web-app.js'
  };

  /** GD gameId value that means "not configured yet": the script is then not loaded at all. */
  var GD_PLACEHOLDER_ID = 'REPLACE_WITH_GD_GAME_ID';

  /** Minimum spacing between happytime() signals (ms) — the vendor asks for "sparingly". */
  var HAPPY_TIME_MIN_INTERVAL = 10000;

  /** navigator.vibrate patterns per haptic kind (ms). */
  var VIBRATE_PATTERNS = {
    light: [10],
    medium: [20],
    heavy: [35],
    success: [10, 40, 20],
    error: [30, 40, 30, 40, 30],
    selection: [5]
  };

  /** Telegram HapticFeedback mapping per haptic kind. */
  var TG_HAPTICS = {
    light: ['impactOccurred', 'light'],
    medium: ['impactOccurred', 'medium'],
    heavy: ['impactOccurred', 'heavy'],
    success: ['notificationOccurred', 'success'],
    error: ['notificationOccurred', 'error'],
    selection: ['selectionChanged']
  };

  /** Telegram platforms where requestFullscreen() makes sense. */
  var TG_MOBILE_PLATFORMS = { android: true, android_x: true, ios: true };

  /** Characters allowed in a Telegram startapp parameter are [A-Za-z0-9_-]. */
  var START_PARAM_KEY_RE = /[^A-Za-z0-9]/g;
  var START_PARAM_VALUE_RE = /[^A-Za-z0-9-]/g;

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  /** Durations the adapter waits before giving up (ms). Overridable via G.sdk._test.timeouts. */
  var timeouts = {
    script: 4000,
    interstitial: 30000,
    rewarded: 45000,
    fakeAd: 3000
  };

  var noop = function () {};

  /** Default interstitial pacing (ms). */
  var DEFAULT_MIN_INTERVAL = 150000;
  var DEFAULT_WARMUP = 90000;

  /** Longest startapp value Telegram accepts. */
  var START_PARAM_MAX_LENGTH = 512;

  /**
   * Normalises the init() config. Called once at load with no argument so every
   * public method is safe to call before init(), and again from init().
   */
  function normalizeConfig(config) {
    config = config || {};
    var hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
    return {
      gdGameId: typeof config.gdGameId === 'string' && config.gdGameId ? config.gdGameId : null,
      hooks: hooks,
      createInvoice: typeof config.createInvoice === 'function' ? config.createInvoice : null,
      interstitialMinInterval: nonNegativeNumber(config.interstitialMinInterval, DEFAULT_MIN_INTERVAL),
      interstitialWarmup: nonNegativeNumber(config.interstitialWarmup, DEFAULT_WARMUP),
      appUrl: typeof config.appUrl === 'string' && config.appUrl ? config.appUrl : null,
      tgAppUrl: typeof config.tgAppUrl === 'string' && config.tgAppUrl ? config.tgAppUrl : null
    };
  }

  /** `value` when it is a finite number ≥ 0, otherwise `fallback`. */
  function nonNegativeNumber(value, fallback) {
    return typeof value === 'number' && isFinite(value) && value >= 0 ? value : fallback;
  }

  var state = {
    config: normalizeConfig(),
    initPromise: null,
    forcedProvider: null,      // set by _test.setProvider()
    scriptFailed: false,       // vendor script missing/failed → ads degraded
    adRunning: false,
    adBreakId: 0,              // incremented per ad break; stale vendor callbacks are ignored
    resumeGameplayAfterAd: false, // gameplay telemetry was active when the ad break began
    hooksEngaged: false,       // hooks.pause()+mute() were called and await release
    listenersBound: false,     // document/window listeners attached once per page
    lastAdAt: null,            // clock time of the last completed ad break
    lastHappyAt: null,
    loadingActive: false,
    gameplayActive: false,
    poki: { loadingFinishedSent: false },
    gd: { rewardedComplete: false },
    pauseReasons: {},          // reason → true while that reason keeps the game paused
    pauseCbs: [],
    resumeCbs: [],
    storageMirrorDetach: null
  };

  /** Returns location.search parameter `name` or null. Never throws. */
  function queryParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (err) {
      return null;
    }
  }

  /** Returns a parameter from Telegram's URL hash (tgWebAppPlatform, tgWebAppStartParam, …). */
  function hashParam(name) {
    try {
      var hash = (window.location.hash || '').replace(/^#/, '');
      return new URLSearchParams(hash).get(name);
    } catch (err) {
      return null;
    }
  }

  /** Current hostname (lower-case) or ''. */
  function hostname() {
    try {
      return String(window.location.hostname || '').toLowerCase();
    } catch (err) {
      return '';
    }
  }

  /** Monotonic clock in ms; tests override via G.sdk._test.now. */
  function now() {
    var override = sdk._test && sdk._test.now;
    if (typeof override === 'function') return override();
    if (window.performance && typeof window.performance.now === 'function') return window.performance.now();
    return Date.now();
  }

  /** Calls fn(...args) swallowing exceptions; returns the result or `undefined`. */
  function safe(fn, ctx, args) {
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(ctx, args || []);
    } catch (err) {
      G.log('[sdk] call threw:', err);
      return undefined;
    }
  }

  /** True when `obj[method]` is callable. */
  function has(obj, method) {
    return !!obj && typeof obj[method] === 'function';
  }

  /** Builds a fresh capability object with everything off. */
  function noCaps() {
    return {
      rewarded: false, interstitial: false, share: false, haptics: false,
      iap: false, cloudSave: false, inviteLink: false, banner: false
    };
  }

  /**
   * Resolves/rejects with `promise`, or calls `onTimeout()` and resolves with
   * its return value after `ms`. The late settlement of `promise` is ignored.
   */
  function withTimeout(promise, ms, onTimeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try {
          resolve(onTimeout());
        } catch (err) {
          reject(err);
        }
      }, ms);
      Promise.resolve(promise).then(function (value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Pause / resume bookkeeping
  // ---------------------------------------------------------------------------

  /** Invokes every callback in `list` with `reason`, isolating exceptions. */
  function emit(list, reason) {
    for (var i = 0; i < list.length; i++) safe(list[i], null, [reason]);
  }

  /** Marks `reason` as holding the game paused; fires onPause on the first reason. */
  function holdPause(reason) {
    var wasPaused = Object.keys(state.pauseReasons).length > 0;
    state.pauseReasons[reason] = true;
    if (!wasPaused) emit(state.pauseCbs, reason);
  }

  /** Releases `reason`; fires onResume when no reason remains. */
  function releasePause(reason) {
    if (!state.pauseReasons[reason]) return;
    delete state.pauseReasons[reason];
    if (Object.keys(state.pauseReasons).length === 0) emit(state.resumeCbs, reason);
  }

  /**
   * Calls hooks.pause() then hooks.mute() exactly once per ad break.
   * @param {number} [breakId] the ad break the caller belongs to; a vendor
   *   callback arriving after that break ended (timeout) is ignored so the game
   *   can never be left paused and muted. Omit for SDK-driven pauses (GD events).
   */
  function engageHooks(breakId) {
    if (breakId !== undefined && (breakId !== state.adBreakId || !state.adRunning)) {
      G.log('[sdk] ignoring stale ad start (break ' + breakId + ')');
      return;
    }
    if (state.hooksEngaged) return;
    state.hooksEngaged = true;
    var hooks = state.config.hooks;
    safe(hooks.pause, hooks);
    safe(hooks.mute, hooks);
    holdPause('ad');
  }

  /** Calls hooks.resume() then hooks.unmute() if the hooks are currently engaged. */
  function releaseHooks() {
    if (!state.hooksEngaged) return;
    state.hooksEngaged = false;
    var hooks = state.config.hooks;
    safe(hooks.resume, hooks);
    safe(hooks.unmute, hooks);
    releasePause('ad');
  }

  /**
   * Marks the beginning of an ad break; pauses gameplay telemetry if the game
   * forgot to. Returns the break id adapters hand back to engageHooks().
   */
  function beginAdBreak() {
    state.adRunning = true;
    state.adBreakId++;
    state.resumeGameplayAfterAd = state.gameplayActive;
    if (state.gameplayActive) sdk.gameplayStop();
    return state.adBreakId;
  }

  /** Ends an ad break: releases hooks, restores gameplay telemetry, stamps the clock. */
  function endAdBreak(countsAsBreak) {
    releaseHooks();
    state.adRunning = false;
    if (countsAsBreak) state.lastAdAt = now();
    if (state.resumeGameplayAfterAd) sdk.gameplayStart();
    state.resumeGameplayAfterAd = false;
  }

  // ---------------------------------------------------------------------------
  // Provider detection and script loading
  // ---------------------------------------------------------------------------

  /** Detection order: forced → Telegram → CrazyGames → Poki → GD → none. */
  function detectProvider() {
    var forced = state.forcedProvider || String(queryParam('sdk') || '').toLowerCase();
    if (forced && PROVIDERS.indexOf(forced) !== -1) return forced;

    var tg = window.Telegram && window.Telegram.WebApp;
    var tgInUrl = /tgWebAppPlatform/.test((window.location.hash || '') + (window.location.search || ''));
    if ((tg && tg.initData) || tgInUrl) return 'telegram';

    var host = hostname();
    if (/(^|\.)crazygames\.com$/.test(host) || window.CrazyGames) return 'crazygames';
    if (window.PokiSDK || host.indexOf('poki') !== -1) return 'poki';
    if (window.gdsdk || window.GD_OPTIONS || queryParam('gdid')) return 'gd';
    return 'none';
  }

  /**
   * Appends a <script> tag and resolves on load. Rejects on error or after
   * `timeouts.script` ms. Tests replace this via G.sdk._test.loadScript.
   * @param {string} url
   * @returns {Promise<void>}
   */
  function loadScriptDefault(url) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = url;
      el.async = true;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('script failed: ' + url)); };
      (document.head || document.documentElement).appendChild(el);
    });
  }

  /** Loads a vendor script through the (possibly injected) loader with the shared timeout. */
  function loadScript(url) {
    var loader = (sdk._test && typeof sdk._test.loadScript === 'function') ? sdk._test.loadScript : loadScriptDefault;
    var attempt;
    try {
      attempt = Promise.resolve(loader(url));
    } catch (err) {
      attempt = Promise.reject(err);
    }
    return withTimeout(attempt, timeouts.script, function () {
      throw new Error('script timeout: ' + url);
    });
  }

  /** Records that the vendor SDK is unusable and switches every ad capability off. */
  function degrade(reason) {
    state.scriptFailed = true;
    sdk.caps.rewarded = false;
    sdk.caps.interstitial = false;
    sdk.caps.inviteLink = false;
    sdk.caps.cloudSave = false;
    sdk.caps.banner = false;
    G.log('[sdk] degraded (' + sdk.provider + '):', reason);
  }

  // ---------------------------------------------------------------------------
  // Generic share helpers (navigator.share → clipboard)
  // ---------------------------------------------------------------------------

  /** Appends `params` to `base` as query parameters and returns the URL string. */
  function withQuery(base, params) {
    var url;
    try {
      url = new URL(base, window.location.href);
    } catch (err) {
      return base;
    }
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  /** Canonical app URL for share links in the 'none' provider. */
  function appUrl() {
    if (state.config && state.config.appUrl) return state.config.appUrl;
    try {
      return window.location.origin + window.location.pathname;
    } catch (err) {
      return '';
    }
  }

  /** Writes text to the clipboard; resolves {ok, method:'clipboard'}. */
  function shareViaClipboard(text, url) {
    var payload = url ? (text ? text + ' ' + url : url) : text;
    var clipboard = navigator.clipboard;
    if (!has(clipboard, 'writeText') || !payload) return Promise.resolve({ ok: false, method: 'none', url: url });
    return clipboard.writeText(payload).then(function () {
      return { ok: true, method: 'clipboard', url: url };
    }, function (err) {
      G.log('[sdk] clipboard failed:', err);
      return { ok: false, method: 'none', url: url, reason: 'clipboard' };
    });
  }

  /**
   * navigator.share when available; a user cancellation (AbortError) is final,
   * every other failure (typical on desktop browsers) falls back to the clipboard.
   */
  function shareNative(text, url) {
    if (!has(navigator, 'share')) return shareViaClipboard(text, url);
    var data = {};
    if (text) data.text = text;
    if (url) data.url = url;
    var attempt;
    try {
      attempt = Promise.resolve(navigator.share(data));
    } catch (err) {
      attempt = Promise.reject(err);
    }
    return attempt.then(function () {
      return { ok: true, method: 'native', url: url };
    }, function (err) {
      if (err && err.name === 'AbortError') return { ok: false, method: 'native', url: url, reason: 'cancelled' };
      G.log('[sdk] navigator.share failed, falling back:', err);
      return shareViaClipboard(text, url);
    });
  }

  // ---------------------------------------------------------------------------
  // Telegram start_param encoding: 'k1-v1_k2-v2'
  // ---------------------------------------------------------------------------

  /** Encodes params into a Telegram-safe startapp string ('seed-42_ref-abc'). */
  function encodeStartParam(params) {
    return Object.keys(params || {}).map(function (key) {
      var k = String(key).replace(START_PARAM_KEY_RE, '');
      var v = String(params[key]).replace(START_PARAM_VALUE_RE, '');
      return k && v ? k + '-' + v : '';
    }).filter(Boolean).join('_').slice(0, START_PARAM_MAX_LENGTH);
  }

  /** Decodes 'seed-42_ref-abc' into {seed:'42', ref:'abc'}. */
  function decodeStartParam(raw) {
    var out = {};
    String(raw || '').split('_').forEach(function (part) {
      var idx = part.indexOf('-');
      if (idx <= 0) return;
      out[part.slice(0, idx)] = part.slice(idx + 1);
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Safe area → CSS custom properties
  // ---------------------------------------------------------------------------

  /** Writes --safe-* variables on :root from G.sdk.safeArea (or env() fallbacks). */
  function applySafeAreaVars(useEnvFallback) {
    var root = document.documentElement;
    if (!root || !root.style) return;
    ['top', 'right', 'bottom', 'left'].forEach(function (side) {
      var value = useEnvFallback
        ? 'env(safe-area-inset-' + side + ', 0px)'
        : Math.max(0, Math.round(sdk.safeArea[side] || 0)) + 'px';
      root.style.setProperty('--safe-' + side, value);
    });
  }

  /** Recomputes the safe area from Telegram's two inset objects (summed). */
  function refreshTelegramSafeArea(tg) {
    var a = tg.safeAreaInset || {};
    var b = tg.contentSafeAreaInset || {};
    sdk.safeArea = {
      top: (a.top || 0) + (b.top || 0),
      right: (a.right || 0) + (b.right || 0),
      bottom: (a.bottom || 0) + (b.bottom || 0),
      left: (a.left || 0) + (b.left || 0)
    };
    applySafeAreaVars(false);
  }

  // ---------------------------------------------------------------------------
  // Fake ad overlay (provider 'none' + DEBUG)
  // ---------------------------------------------------------------------------

  /**
   * Shows a full-screen "Test ad" overlay with a countdown and resolves
   * {rewarded:true} when it completes, or {rewarded:false, reason:'skipped'}
   * when the tester closes it early.
   */
  function showFakeAd(label) {
    return new Promise(function (resolve) {
      var durationMs = timeouts.fakeAd;
      var overlay = document.createElement('div');
      overlay.setAttribute('data-sdk-fake-ad', label || 'rewarded');
      overlay.setAttribute('role', 'dialog');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;gap:16px;background:#111;color:#fff;' +
        'font:600 20px/1.4 system-ui,sans-serif;text-align:center;';
      var title = document.createElement('div');
      title.textContent = 'Test ad (' + Math.round(durationMs / 1000) + 's)';
      var counter = document.createElement('div');
      counter.style.cssText = 'font-size:48px;font-variant-numeric:tabular-nums;';
      var close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Close (no reward)';
      close.style.cssText = 'margin-top:8px;padding:10px 18px;border:1px solid #666;border-radius:8px;' +
        'background:transparent;color:#fff;font:inherit;font-size:16px;cursor:pointer;';
      overlay.appendChild(title);
      overlay.appendChild(counter);
      overlay.appendChild(close);

      var started = Date.now();
      var finished = false;
      var ticker = null;
      function finish(result) {
        if (finished) return;
        finished = true;
        clearInterval(ticker);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }
      function tick() {
        var left = Math.max(0, durationMs - (Date.now() - started));
        counter.textContent = Math.ceil(left / 1000);
        if (left <= 0) finish({ rewarded: true });
      }
      close.addEventListener('click', function () { finish({ rewarded: false, reason: 'skipped' }); });
      (document.body || document.documentElement).appendChild(overlay);
      tick();
      ticker = setInterval(tick, 100);
    });
  }

  // ---------------------------------------------------------------------------
  // Provider adapters. Each returns a Promise<void> from init(); failures must
  // be reported via degrade() rather than rejecting.
  // ---------------------------------------------------------------------------

  var adapters = {};

  /* ---------------------------------- none ------------------------------- */
  adapters.none = {
    init: function () {
      sdk.caps.share = has(navigator, 'share') || has(navigator.clipboard, 'writeText');
      sdk.caps.haptics = has(navigator, 'vibrate');
      applySafeAreaVars(true);
      return Promise.resolve();
    },
    interstitial: function () {
      return Promise.resolve({ shown: false, reason: 'unsupported' });
    },
    rewarded: function (placement, breakId) {
      if (!G.DEBUG) return Promise.resolve({ rewarded: false, reason: 'unavailable' });
      engageHooks(breakId);
      return showFakeAd('rewarded');
    },
    share: function (text, url, params) {
      var link = withQuery(url || appUrl(), params);
      return shareNative(text, link);
    },
    getParam: function () { return null; }
  };

  /* -------------------------------- CrazyGames --------------------------- */
  adapters.crazygames = {
    init: function () {
      var load = window.CrazyGames ? Promise.resolve() : loadScript(SCRIPT_URLS.crazygames);
      return load.then(function () {
        var SDK = window.CrazyGames && window.CrazyGames.SDK;
        if (!SDK) throw new Error('CrazyGames SDK missing after load');
        sdk.cg = SDK;
        return SDK.init();
      }).then(function () {
        var SDK = sdk.cg;
        if (SDK.environment === 'disabled') throw new Error('environment disabled');
        sdk.caps.rewarded = true;
        sdk.caps.interstitial = true;
        sdk.caps.share = true;
        sdk.caps.inviteLink = has(SDK.game, 'inviteLink');
        sdk.caps.cloudSave = !!(SDK.data && has(SDK.data, 'getItem'));
        sdk.caps.banner = has(SDK.banner, 'requestResponsiveBanner');
        sdk.caps.haptics = has(navigator, 'vibrate');
        applySafeAreaVars(true);
        if (sdk.caps.cloudSave) attachStorageMirror(crazyGamesMirror(SDK.data));
        return loadCrazyGamesUser(SDK);
      }).catch(function (err) {
        degrade(err);
        sdk.caps.share = has(navigator, 'share') || has(navigator.clipboard, 'writeText');
        sdk.caps.haptics = has(navigator, 'vibrate');
        applySafeAreaVars(true);
      });
    },
    loadingStart: function () { safe(sdk.cg.game.loadingStart, sdk.cg.game); },
    loadingStop: function () { safe(sdk.cg.game.loadingStop, sdk.cg.game); },
    gameplayStart: function () { safe(sdk.cg.game.gameplayStart, sdk.cg.game); },
    gameplayStop: function () { safe(sdk.cg.game.gameplayStop, sdk.cg.game); },
    happyTime: function () { safe(sdk.cg.game.happytime, sdk.cg.game); },
    interstitial: function (placement, breakId) {
      return requestCrazyGamesAd('midgame', breakId).then(function (finished) {
        return finished ? { shown: true } : { shown: false, reason: 'error' };
      });
    },
    rewarded: function (placement, breakId) {
      return requestCrazyGamesAd('rewarded', breakId).then(function (finished) {
        return finished ? { rewarded: true } : { rewarded: false, reason: 'error' };
      });
    },
    share: function (text, url, params) {
      var fallback = withQuery(url || appUrl(), params);
      if (!sdk.caps.inviteLink) return shareNative(text, fallback);
      return Promise.resolve(safe(sdk.cg.game.inviteLink, sdk.cg.game, [params || {}])).then(function (link) {
        return shareNative(text, typeof link === 'string' && link ? link : fallback);
      }, function () {
        return shareNative(text, fallback);
      });
    },
    getParam: function (name) {
      if (state.scriptFailed || !has(sdk.cg && sdk.cg.game, 'getInviteParam')) return null;
      var value = safe(sdk.cg.game.getInviteParam, sdk.cg.game, [name]);
      return value === undefined || value === null ? null : String(value);
    },
    banner: {
      show: function (id) { safe(sdk.cg.banner.requestResponsiveBanner, sdk.cg.banner, [id]); return true; },
      clear: function (id) { safe(sdk.cg.banner.clearBanner, sdk.cg.banner, [id]); return true; }
    }
  };

  /** Resolves with true when the CrazyGames ad finished, false on adError. */
  function requestCrazyGamesAd(type, breakId) {
    return new Promise(function (resolve) {
      var callbacks = {
        adStarted: function () { engageHooks(breakId); },
        adFinished: function () { resolve(true); },
        adError: function (err) { G.log('[sdk] crazygames adError:', err); resolve(false); }
      };
      try {
        sdk.cg.ad.requestAd(type, callbacks);
      } catch (err) {
        G.log('[sdk] crazygames requestAd threw:', err);
        resolve(false);
      }
    });
  }

  /** Populates G.sdk.user from the CrazyGames account, if any. */
  function loadCrazyGamesUser(SDK) {
    if (!SDK.user || !SDK.user.isUserAccountAvailable || !has(SDK.user, 'getUser')) return Promise.resolve();
    return Promise.resolve(safe(SDK.user.getUser, SDK.user)).then(function (u) {
      if (!u) return;
      sdk.user = {
        id: u.id || u.username || null,
        name: u.username || null,
        avatar: u.profilePictureUrl || null,
        lang: null,
        premium: false
      };
    }, function (err) {
      G.log('[sdk] crazygames getUser failed:', err);
    });
  }

  /** G.storage mirror on the CrazyGames data API (synchronous, wrapped in promises). */
  function crazyGamesMirror(data) {
    var PREFIX = 'g1.';
    function wrap(fn) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          try {
            resolve(fn.apply(null, args));
          } catch (err) {
            reject(err);
          }
        });
      };
    }
    return {
      name: 'crazygames-data',
      get: wrap(function (key) {
        var value = data.getItem(PREFIX + key);
        return typeof value === 'string' ? value : null;
      }),
      set: wrap(function (key, raw) { return data.setItem(PREFIX + key, raw); }),
      remove: wrap(function (key) { return data.removeItem(PREFIX + key); })
    };
  }

  /* ----------------------------------- Poki ------------------------------ */
  adapters.poki = {
    init: function () {
      var load = window.PokiSDK ? Promise.resolve() : loadScript(SCRIPT_URLS.poki);
      return load.then(function () {
        var P = window.PokiSDK;
        if (!P) throw new Error('PokiSDK missing after load');
        sdk.poki = P;
        safe(P.setDebug, P, [!!G.DEBUG]);
        return P.init();
      }).then(function () {
        var P = sdk.poki;
        sdk.caps.rewarded = has(P, 'rewardedBreak');
        sdk.caps.interstitial = has(P, 'commercialBreak');
        sdk.caps.share = true;
        sdk.caps.inviteLink = has(P, 'shareableURL');
        sdk.caps.haptics = has(navigator, 'vibrate');
        applySafeAreaVars(true);
      }).catch(function (err) {
        degrade(err);
        sdk.caps.share = has(navigator, 'share') || has(navigator.clipboard, 'writeText');
        sdk.caps.haptics = has(navigator, 'vibrate');
        applySafeAreaVars(true);
      });
    },
    /** Poki requires gameLoadingFinished exactly once, even if loadingStart() was never called. */
    loadingStop: function () {
      if (state.poki.loadingFinishedSent) return;
      state.poki.loadingFinishedSent = true;
      safe(sdk.poki.gameLoadingFinished, sdk.poki);
    },
    /** Poki's required order is gameLoadingFinished → gameplayStart, so the first is implied. */
    gameplayStart: function () {
      adapters.poki.loadingStop();
      safe(sdk.poki.gameplayStart, sdk.poki);
    },
    gameplayStop: function () { safe(sdk.poki.gameplayStop, sdk.poki); },
    interstitial: function (placement, breakId) {
      var started = false;
      var p = safe(sdk.poki.commercialBreak, sdk.poki, [function () { started = true; engageHooks(breakId); }]);
      return Promise.resolve(p).then(function () {
        return started ? { shown: true } : { shown: false, reason: 'skipped' };
      }, function (err) {
        G.log('[sdk] poki commercialBreak failed:', err);
        return { shown: false, reason: 'error' };
      });
    },
    rewarded: function (placement, breakId) {
      var p = safe(sdk.poki.rewardedBreak, sdk.poki, [function () { engageHooks(breakId); }]);
      return Promise.resolve(p).then(function (success) {
        return success ? { rewarded: true } : { rewarded: false, reason: 'incomplete' };
      }, function (err) {
        G.log('[sdk] poki rewardedBreak failed:', err);
        return { rewarded: false, reason: 'error' };
      });
    },
    share: function (text, url, params) {
      var fallback = withQuery(url || appUrl(), params);
      if (!sdk.caps.inviteLink) return shareNative(text, fallback);
      return Promise.resolve(safe(sdk.poki.shareableURL, sdk.poki, [params || {}])).then(function (link) {
        return shareNative(text, typeof link === 'string' && link ? link : fallback);
      }, function () {
        return shareNative(text, fallback);
      });
    },
    getParam: function (name) {
      if (state.scriptFailed || !has(sdk.poki, 'getURLParam')) return null;
      var value = safe(sdk.poki.getURLParam, sdk.poki, [name]);
      return value === undefined || value === null || value === '' ? null : String(value);
    }
  };

  /* ------------------------------ GameDistribution ----------------------- */
  adapters.gd = {
    init: function () {
      var gameId = state.config.gdGameId || queryParam('gdid') || GD_PLACEHOLDER_ID;
      sdk.caps.share = has(navigator, 'share') || has(navigator.clipboard, 'writeText');
      sdk.caps.haptics = has(navigator, 'vibrate');
      applySafeAreaVars(true);
      if (gameId === GD_PLACEHOLDER_ID) {
        degrade('GD gameId not configured');
        return Promise.resolve();
      }
      var existing = window.GD_OPTIONS || {};
      var userOnEvent = typeof existing.onEvent === 'function' ? existing.onEvent : null;
      window.GD_OPTIONS = Object.assign({}, existing, {
        gameId: gameId,
        onEvent: function (event) {
          handleGdEvent(event);
          if (userOnEvent) safe(userOnEvent, null, [event]);
        }
      });
      var load = window.gdsdk ? Promise.resolve() : loadScript(SCRIPT_URLS.gd);
      return load.then(function () {
        if (!window.gdsdk) throw new Error('gdsdk missing after load');
        sdk.gd = window.gdsdk;
        sdk.caps.interstitial = has(sdk.gd, 'showAd');
        sdk.caps.rewarded = has(sdk.gd, 'preloadAd') && has(sdk.gd, 'showAd');
      }).catch(degrade);
    },
    interstitial: function (placement, breakId) {
      engageHooks(breakId);
      return Promise.resolve(safe(sdk.gd.showAd, sdk.gd)).then(function () {
        return { shown: true };
      }, function (err) {
        G.log('[sdk] gd showAd failed:', err);
        return { shown: false, reason: 'error' };
      });
    },
    rewarded: function (placement, breakId) {
      state.gd.rewardedComplete = false;
      return Promise.resolve(safe(sdk.gd.preloadAd, sdk.gd, ['rewarded'])).then(function () {
        engageHooks(breakId);
        return Promise.resolve(safe(sdk.gd.showAd, sdk.gd, ['rewarded']));
      }).then(function () {
        return { rewarded: true };
      }, function (err) {
        G.log('[sdk] gd rewarded failed:', err);
        return state.gd.rewardedComplete ? { rewarded: true } : { rewarded: false, reason: 'error' };
      });
    },
    share: function (text, url, params) {
      return shareNative(text, withQuery(url || appUrl(), params));
    },
    getParam: function () { return null; }
  };

  /**
   * Routes GD_OPTIONS.onEvent into pause/resume + rewarded bookkeeping. While
   * one of our own ad calls is running, the release is left to endAdBreak().
   */
  function handleGdEvent(event) {
    var name = event && event.name;
    if (name === 'SDK_GAME_PAUSE') {
      engageHooks();
    } else if (name === 'SDK_GAME_START') {
      if (!state.adRunning) releaseHooks();
    } else if (name === 'SDK_REWARDED_WATCH_COMPLETE') {
      state.gd.rewardedComplete = true;
    }
  }

  /* --------------------------------- Telegram ---------------------------- */
  adapters.telegram = {
    init: function () {
      var present = window.Telegram && window.Telegram.WebApp;
      var load = present ? Promise.resolve() : loadScript(SCRIPT_URLS.telegram);
      return load.then(function () {
        var tg = window.Telegram && window.Telegram.WebApp;
        if (!tg) throw new Error('Telegram.WebApp missing after load');
        sdk.tg = tg;
        setupTelegram(tg);
      }).catch(function (err) {
        degrade(err);
        sdk.caps.share = has(navigator, 'share') || has(navigator.clipboard, 'writeText');
        sdk.caps.haptics = has(navigator, 'vibrate');
        applySafeAreaVars(true);
      });
    },
    interstitial: function () {
      return Promise.resolve({ shown: false, reason: 'unsupported' });
    },
    rewarded: function () {
      return Promise.resolve({ rewarded: false, reason: 'unavailable' });
    },
    share: function (text, url, params) {
      var base = url || state.config.tgAppUrl || appUrl();
      var startapp = encodeStartParam(params);
      var link = startapp ? withQuery(base, { startapp: startapp }) : base;
      var shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text || '');
      if (!has(sdk.tg, 'openTelegramLink')) return shareNative(text, link);
      try {
        sdk.tg.openTelegramLink(shareUrl);
        return Promise.resolve({ ok: true, method: 'telegram', url: link });
      } catch (err) {
        G.log('[sdk] openTelegramLink failed:', err);
        return shareNative(text, link);
      }
    },
    getParam: function (name) {
      var unsafe = sdk.tg && sdk.tg.initDataUnsafe;
      var raw = (unsafe && unsafe.start_param) || hashParam('tgWebAppStartParam');
      if (!raw) return null;
      var decoded = decodeStartParam(raw);
      return Object.prototype.hasOwnProperty.call(decoded, name) ? decoded[name] : null;
    },
    haptic: function (kind) {
      var spec = TG_HAPTICS[kind];
      var hf = sdk.tg && sdk.tg.HapticFeedback;
      if (!spec || !has(hf, spec[0])) return false;
      safe(hf[spec[0]], hf, spec.slice(1));
      return true;
    },
    purchase: function (itemId) {
      var tg = sdk.tg;
      var createInvoice = state.config.createInvoice;
      if (typeof createInvoice !== 'function' || !has(tg, 'openInvoice')) {
        return Promise.resolve({ ok: false, status: 'unsupported' });
      }
      return Promise.resolve().then(function () {
        return createInvoice(itemId);
      }).then(function (invoiceUrl) {
        if (typeof invoiceUrl !== 'string' || !invoiceUrl) throw new Error('createInvoice returned no URL');
        return new Promise(function (resolve) {
          tg.openInvoice(invoiceUrl, function (status) {
            resolve({ ok: status === 'paid', status: status || 'failed' });
          });
        });
      }).catch(function (err) {
        G.log('[sdk] purchase failed:', err);
        return { ok: false, status: 'failed' };
      });
    }
  };

  /** Applies the Telegram boot sequence: ready/expand/fullscreen/theme/user/safe-area/mirror. */
  function setupTelegram(tg) {
    var isVersion = function (v) { return has(tg, 'isVersionAtLeast') && safe(tg.isVersionAtLeast, tg, [v]) === true; };
    safe(tg.ready, tg);
    safe(tg.expand, tg);
    if (isVersion('8.0') && TG_MOBILE_PLATFORMS[tg.platform] && has(tg, 'requestFullscreen')) safe(tg.requestFullscreen, tg);
    if (isVersion('7.7') && has(tg, 'disableVerticalSwipes')) safe(tg.disableVerticalSwipes, tg);
    var bg = tg.themeParams && tg.themeParams.bg_color;
    if (bg) {
      // setHeaderColor accepts hex colours only from 6.9; older clients take the 'bg_color' keyword.
      if (has(tg, 'setHeaderColor')) safe(tg.setHeaderColor, tg, [isVersion('6.9') ? bg : 'bg_color']);
      if (has(tg, 'setBackgroundColor')) safe(tg.setBackgroundColor, tg, [bg]);
    }

    var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) {
      sdk.user = {
        id: u.id !== undefined && u.id !== null ? String(u.id) : null,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || null,
        avatar: u.photo_url || null,
        lang: u.language_code || null,
        premium: !!u.is_premium
      };
    }

    sdk.caps.share = true;
    sdk.caps.inviteLink = true;
    sdk.caps.haptics = !!tg.HapticFeedback || has(navigator, 'vibrate');
    sdk.caps.iap = typeof state.config.createInvoice === 'function' && has(tg, 'openInvoice');
    sdk.caps.cloudSave = isVersion('6.9') && !!tg.CloudStorage && has(tg.CloudStorage, 'getItem');

    refreshTelegramSafeArea(tg);
    if (has(tg, 'onEvent')) {
      ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged'].forEach(function (name) {
        safe(tg.onEvent, tg, [name, function () { refreshTelegramSafeArea(tg); }]);
      });
    }
    if (sdk.caps.cloudSave) attachStorageMirror(telegramMirror(tg.CloudStorage));
  }

  /** G.storage mirror on Telegram CloudStorage (callback API → promises, keys sanitised). */
  function telegramMirror(cs) {
    function cloudKey(key) {
      return ('g1_' + String(key).replace(/[^A-Za-z0-9_-]/g, '_')).slice(0, 128);
    }
    function call(method, args) {
      return new Promise(function (resolve, reject) {
        try {
          cs[method].apply(cs, args.concat([function (err, value) {
            if (err) reject(err); else resolve(value);
          }]));
        } catch (err) {
          reject(err);
        }
      });
    }
    return {
      name: 'telegram-cloud',
      maxLength: 4096,
      get: function (key) {
        return call('getItem', [cloudKey(key)]).then(function (value) {
          return typeof value === 'string' && value ? value : null;
        });
      },
      set: function (key, raw) { return call('setItem', [cloudKey(key), raw]); },
      remove: function (key) { return call('removeItem', [cloudKey(key)]); }
    };
  }

  /** Attaches a mirror to G.storage when it exists; harmless otherwise. */
  function attachStorageMirror(mirror) {
    if (!G.storage || typeof G.storage.attachMirror !== 'function') {
      G.log('[sdk] G.storage absent; mirror', mirror.name, 'not attached');
      return;
    }
    if (state.storageMirrorDetach) safe(state.storageMirrorDetach);
    var detach = safe(G.storage.attachMirror, G.storage, [mirror]);
    state.storageMirrorDetach = typeof detach === 'function' ? detach : null;
  }

  // ---------------------------------------------------------------------------
  // Haptics settings sync with G.storage
  // ---------------------------------------------------------------------------

  /** Reads the persisted 'haptics' setting (default true) into sdk.hapticsEnabled. */
  function syncHapticsSetting() {
    if (!G.storage || typeof G.storage.get !== 'function') return;
    var stored = safe(G.storage.get, G.storage, ['haptics', true]);
    if (typeof stored === 'boolean') sdk.hapticsEnabled = stored;
  }

  /** Coarse-pointer or mobile UA detection; Telegram mobile platforms count too. */
  function detectMobile() {
    var coarse = false;
    try {
      coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (err) { /* matchMedia unsupported */ }
    var ua = (navigator.userAgent || '');
    var tgMobile = !!(sdk.tg && TG_MOBILE_PLATFORMS[sdk.tg.platform]);
    return coarse || tgMobile || /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
  }

  // ---------------------------------------------------------------------------
  // Public object
  // ---------------------------------------------------------------------------

  var sdk = {
    /** Active provider id. Valid after init(); 'none' until then. */
    provider: 'none',
    /** True once init() has settled (even when degraded). */
    ready: false,
    /** Capability flags; consult before showing ad / share / shop UI. */
    caps: noCaps(),
    /** {id, name, avatar, lang, premium} or null. */
    user: null,
    /** Safe-area insets in px (Telegram); zeros elsewhere (CSS vars then use env()). */
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    /** Ad counters for analytics/debug. */
    stats: { interstitialsShown: 0, rewardedShown: 0, rewardedGranted: 0 },
    /** Clock value (now()) when init() was called. */
    sessionStart: 0,
    /** Coarse pointer / mobile UA. */
    isMobile: false,
    /** True when no portal SDK hosts the game (provider 'none'). */
    isStandalone: true,
    /** User preference gate for haptic(). Mirrors G.storage 'haptics' when present. */
    hapticsEnabled: true,
    /** Raw vendor objects, null until the matching provider initialised. */
    tg: null,
    cg: null,
    poki: null,
    gd: null,

    /**
     * Detects/loads the provider and performs its boot sequence. Safe to call
     * more than once (returns the same promise). Never rejects.
     * @param {object} [config]
     * @param {boolean} [config.debug]                  force G.DEBUG on
     * @param {string}  [config.gdGameId]               GameDistribution game id
     * @param {{pause?:Function,resume?:Function,mute?:Function,unmute?:Function}} [config.hooks]
     * @param {(itemId:string)=>Promise<string>} [config.createInvoice]  Telegram Stars invoice link factory
     * @param {number}  [config.interstitialMinInterval=150000]
     * @param {number}  [config.interstitialWarmup=90000]
     * @param {string}  [config.appUrl]                 canonical https URL for share links
     * @param {string}  [config.tgAppUrl]               t.me/<bot>/<app> URL for Telegram share links
     * @returns {Promise<void>}
     */
    init: function (config) {
      if (state.initPromise) return state.initPromise;
      config = config || {};
      if (config.debug) G.DEBUG = true;
      state.config = normalizeConfig(config);
      sdk.sessionStart = now();
      sdk.provider = detectProvider();
      sdk.isStandalone = sdk.provider === 'none';
      sdk.caps = noCaps();
      sdk.user = null;
      sdk.tg = sdk.cg = sdk.poki = sdk.gd = null;
      sdk.safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
      state.poki.loadingFinishedSent = false;
      G.log('[sdk] init provider=' + sdk.provider);

      if (!state.listenersBound) {
        state.listenersBound = true;
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) holdPause('visibility'); else releasePause('visibility');
        });
        window.addEventListener('g:storage', function (ev) {
          if (ev && ev.detail && ev.detail.key === 'haptics') syncHapticsSetting();
        });
        if (document.hidden) holdPause('visibility');
      }
      syncHapticsSetting();

      var adapter = adapters[sdk.provider];
      state.initPromise = Promise.resolve().then(function () {
        return adapter.init();
      }).catch(function (err) {
        degrade(err);
      }).then(function () {
        sdk.isMobile = detectMobile();
        sdk.ready = true;
        G.log('[sdk] ready', sdk.provider, sdk.caps);
      });
      return state.initPromise;
    },

    /** Signals that loading started (CrazyGames). Paired with loadingStop(). */
    loadingStart: function () {
      if (state.loadingActive) return;
      state.loadingActive = true;
      G.log('[sdk] loadingStart');
      if (!state.scriptFailed) safe(adapters[sdk.provider].loadingStart);
    },

    /**
     * Signals that loading finished (CrazyGames loadingStop, Poki
     * gameLoadingFinished). Paired for CrazyGames; Poki's one-shot signal is
     * sent even when loadingStart() was never called.
     */
    loadingStop: function () {
      var wasActive = state.loadingActive;
      state.loadingActive = false;
      if (!wasActive && sdk.provider !== 'poki') return;
      G.log('[sdk] loadingStop');
      if (!state.scriptFailed) safe(adapters[sdk.provider].loadingStop);
    },

    /** Real play begins (after menu / ad / pause). Never sends two starts in a row. */
    gameplayStart: function () {
      if (state.gameplayActive) return;
      state.gameplayActive = true;
      G.log('[sdk] gameplayStart');
      if (!state.scriptFailed) safe(adapters[sdk.provider].gameplayStart);
    },

    /** Play stops (death / menu / pause / ad). No-op when not playing. */
    gameplayStop: function () {
      if (!state.gameplayActive) return;
      state.gameplayActive = false;
      G.log('[sdk] gameplayStop');
      if (!state.scriptFailed) safe(adapters[sdk.provider].gameplayStop);
    },

    /** Exciting moment (new best, big combo). Throttled to one per 10s. */
    happyTime: function () {
      var t = now();
      if (state.lastHappyAt !== null && t - state.lastHappyAt < HAPPY_TIME_MIN_INTERVAL) return;
      state.lastHappyAt = t;
      G.log('[sdk] happyTime');
      if (!state.scriptFailed) safe(adapters[sdk.provider].happyTime);
    },

    /**
     * Shows a midgame interstitial at a natural break.
     * Enforces: not while another ad runs, session warmup, minimum interval.
     * hooks.pause()+mute() are called when the ad starts, resume()+unmute()
     * when it ends (also on error / 30s timeout).
     * @param {{placement?:string}} [opts]
     * @returns {Promise<{shown:boolean, reason?:string}>}
     */
    showInterstitial: function (opts) {
      var placement = (opts && opts.placement) || 'midgame';
      if (state.adRunning) return Promise.resolve({ shown: false, reason: 'busy' });
      if (!sdk.caps.interstitial) return Promise.resolve({ shown: false, reason: 'unsupported' });
      var t = now();
      if (t - sdk.sessionStart < state.config.interstitialWarmup) return Promise.resolve({ shown: false, reason: 'warmup' });
      if (state.lastAdAt !== null && t - state.lastAdAt < state.config.interstitialMinInterval) {
        return Promise.resolve({ shown: false, reason: 'interval' });
      }
      G.log('[sdk] showInterstitial', placement);
      var breakId = beginAdBreak();
      var attempt = Promise.resolve().then(function () {
        return adapters[sdk.provider].interstitial(placement, breakId);
      });
      var run = withTimeout(attempt, timeouts.interstitial, function () {
        return { shown: false, reason: 'timeout' };
      }).catch(function (err) {
        G.log('[sdk] interstitial error:', err);
        return { shown: false, reason: 'error' };
      });
      return run.then(function (result) {
        if (result.shown) sdk.stats.interstitialsShown++;
        endAdBreak(result.shown || result.reason === 'timeout');
        return result;
      });
    },

    /**
     * Shows a rewarded ad. With provider 'none' and G.DEBUG a built-in
     * "Test ad" overlay stands in; in production standalone it is unavailable.
     * @param {{placement?:string}} [opts]
     * @returns {Promise<{rewarded:boolean, reason?:string}>}
     */
    showRewarded: function (opts) {
      var placement = (opts && opts.placement) || 'rewarded';
      if (state.adRunning) return Promise.resolve({ rewarded: false, reason: 'busy' });
      if (!sdk.canShowRewarded()) return Promise.resolve({ rewarded: false, reason: 'unavailable' });
      G.log('[sdk] showRewarded', placement);
      var breakId = beginAdBreak();
      var attempt = Promise.resolve().then(function () {
        return adapters[sdk.provider].rewarded(placement, breakId);
      });
      var run = withTimeout(attempt, timeouts.rewarded, function () {
        return { rewarded: false, reason: 'timeout' };
      }).catch(function (err) {
        G.log('[sdk] rewarded error:', err);
        return { rewarded: false, reason: 'error' };
      });
      return run.then(function (result) {
        // The ad "showed" when the provider actually started it (hooks engaged);
        // only a shown ad counts towards interstitial pacing.
        var shown = state.hooksEngaged || result.rewarded || result.reason === 'timeout';
        if (shown) sdk.stats.rewardedShown++;
        if (result.rewarded) sdk.stats.rewardedGranted++;
        endAdBreak(shown);
        return result;
      });
    },

    /** True when showRewarded() can produce a reward (real or debug fake). */
    canShowRewarded: function () {
      return sdk.caps.rewarded || (sdk.provider === 'none' && !!G.DEBUG);
    },

    /**
     * Shares a challenge link. Provider link builders (CrazyGames inviteLink,
     * Poki shareableURL, Telegram share dialog) are used when available; the
     * 'none' provider appends `params` to appUrl as query parameters and uses
     * navigator.share, then the clipboard.
     * @param {{text?:string, url?:string, params?:object}} opts
     * @returns {Promise<{ok:boolean, method:string, url?:string, reason?:string}>}
     */
    share: function (opts) {
      opts = opts || {};
      var text = opts.text || '';
      var adapter = adapters[sdk.provider];
      var impl = state.scriptFailed && sdk.provider !== 'telegram' ? adapters.none.share : adapter.share;
      return Promise.resolve().then(function () {
        return impl(text, opts.url || null, opts.params || {});
      }).catch(function (err) {
        G.log('[sdk] share failed:', err);
        return { ok: false, method: 'none', reason: 'error' };
      });
    },

    /**
     * Reads a launch parameter: URL query first, then the provider's invite
     * mechanism (CrazyGames getInviteParam, Poki getURLParam, Telegram
     * start_param encoded as 'k1-v1_k2-v2').
     * @param {string} name
     * @returns {string|null}
     */
    getParam: function (name) {
      var fromQuery = queryParam(name);
      if (fromQuery !== null && fromQuery !== '') return fromQuery;
      var value = safe(adapters[sdk.provider].getParam, null, [name]);
      return value === undefined ? null : value;
    },

    /**
     * Haptic feedback. Telegram HapticFeedback when hosted there, otherwise
     * navigator.vibrate. Silently ignored when hapticsEnabled is false.
     * @param {'light'|'medium'|'heavy'|'success'|'error'|'selection'} kind
     * @returns {boolean} whether a haptic request was issued
     */
    haptic: function (kind) {
      if (!sdk.hapticsEnabled || !VIBRATE_PATTERNS[kind]) return false;
      if (sdk.provider === 'telegram' && adapters.telegram.haptic(kind)) return true;
      if (!has(navigator, 'vibrate')) return false;
      return safe(navigator.vibrate, navigator, [VIBRATE_PATTERNS[kind]]) === true;
    },

    /**
     * In-app purchase. Telegram Stars via config.createInvoice(itemId) →
     * WebApp.openInvoice; every other provider answers status 'unsupported'.
     * @param {string} itemId
     * @param {{title?:string, stars?:number}} [meta]  descriptive, forwarded for logging
     * @returns {Promise<{ok:boolean, status:string}>}
     */
    purchase: function (itemId, meta) {
      G.log('[sdk] purchase', itemId, meta);
      if (sdk.provider !== 'telegram' || state.scriptFailed) return Promise.resolve({ ok: false, status: 'unsupported' });
      return adapters.telegram.purchase(itemId);
    },

    /**
     * Registers a pause listener (tab hidden, GD SDK_GAME_PAUSE, ad start).
     * The callback receives the reason: 'visibility' | 'ad' (GD SDK pauses are
     * routed through the ad hooks and report 'ad'). Reasons are reference
     * counted: overlapping causes fire one pause and one resume.
     * @param {(reason:string)=>void} cb
     * @returns {() => void} unsubscribe
     */
    onPause: function (cb) {
      return subscribe(state.pauseCbs, cb);
    },

    /**
     * Registers a resume listener (tab visible, GD SDK_GAME_START, ad end).
     * @param {(reason:string)=>void} cb
     * @returns {() => void} unsubscribe
     */
    onResume: function (cb) {
      return subscribe(state.resumeCbs, cb);
    },

    /** Responsive banner (CrazyGames only). Returns false when unsupported. */
    banner: {
      /** @param {string} containerId DOM id of the banner container */
      show: function (containerId) {
        if (!sdk.caps.banner || !adapters[sdk.provider].banner) return false;
        return adapters[sdk.provider].banner.show(containerId);
      },
      /** @param {string} containerId */
      clear: function (containerId) {
        if (!sdk.caps.banner || !adapters[sdk.provider].banner) return false;
        return adapters[sdk.provider].banner.clear(containerId);
      }
    },

    /**
     * Test seams. `now` and `loadScript` are consulted on every call so tests
     * can inject a fake clock and skip real vendor downloads; `timeouts` can be
     * shortened; `setProvider` forces the provider for a subsequent init().
     */
    _test: {
      now: null,
      loadScript: null,
      timeouts: timeouts,
      /** Forces `provider` and resets init so it can run again in the same page. */
      setProvider: function (provider) {
        if (PROVIDERS.indexOf(provider) === -1) throw new Error('unknown provider: ' + provider);
        state.forcedProvider = provider;
        state.initPromise = null;
        state.scriptFailed = false;
        sdk.ready = false;
      },
      /** Internal state snapshot for assertions. */
      state: function () {
        return {
          adRunning: state.adRunning,
          hooksEngaged: state.hooksEngaged,
          gameplayActive: state.gameplayActive,
          loadingActive: state.loadingActive,
          lastAdAt: state.lastAdAt,
          scriptFailed: state.scriptFailed,
          pauseReasons: Object.keys(state.pauseReasons)
        };
      }
    }
  };

  /** Adds cb to list (once) and returns a remover. */
  function subscribe(list, cb) {
    if (typeof cb !== 'function') return noop;
    if (list.indexOf(cb) === -1) list.push(cb);
    return function () {
      var idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  // Usable before init(): layout code may branch on isMobile while booting.
  sdk.isMobile = detectMobile();

  G.sdk = sdk;
})();
