/**
 * G.storage — namespaced, crash-proof persistence for the game.
 *
 * Responsibilities
 *   - Wraps localStorage behind a tiny JSON API (get / set / remove / keys).
 *   - Every key is prefixed with 'g1.' so the game never collides with other
 *     apps hosted on the same origin (GitHub Pages shares one origin per site).
 *   - Every value is stored as an envelope  {"v": <value>, "_ts": <epoch ms>}
 *     so that copies living in different places (localStorage, Telegram
 *     CloudStorage, CrazyGames data API, ...) can be reconciled: the newest
 *     timestamp wins, in both directions. Local stamps are monotonic per key
 *     (never below the stamp already stored), so a device with a slow clock can
 *     still overwrite a copy it previously adopted from a mirror.
 *   - Survives incognito / blocked storage: the availability probe and every
 *     single localStorage access are wrapped in try/catch, and the module falls
 *     back to an in-memory Map that behaves identically for the session.
 *   - Mirrors (attachMirror) receive debounced, fire-and-forget pushes on set()
 *     and immediate removes on remove(); pullMirrors() merges remote copies back.
 *   - Emits a window 'g:storage' CustomEvent {detail:{key, source}} after every
 *     mutation so UI code can react without polling. Writes made by another tab
 *     of the same origin are picked up through the native 'storage' event and
 *     re-emitted with source 'external'.
 *   - export() / import() produce and consume a JSON snapshot for support.
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

  /** Namespace prefix applied to every physical localStorage key. */
  var PREFIX = 'g1.';
  /** Key used by the availability probe; never stored for long. */
  var PROBE_KEY = PREFIX + '__probe';
  /** Default debounce for mirror pushes (ms). */
  var DEFAULT_DEBOUNCE_MS = 800;
  /** Default upper bound for a single mirror call before it is given up on (ms). */
  var DEFAULT_MIRROR_TIMEOUT_MS = 5000;
  /** Snapshot format version written by export(). */
  var EXPORT_FORMAT = 1;

  /** @type {Storage|null} the real localStorage once it passed the probe. */
  var backend = null;
  /**
   * In-memory layer keyed by the PREFIXED key. Holds everything when there is
   * no backend, and otherwise only what the backend refused: a string for a
   * rejected write, `null` as a tombstone for a rejected removal. An entry here
   * is therefore always fresher than the backend copy and is read first.
   * @type {Map<string,(string|null)>}
   */
  var memory = new Map();
  /** @type {Set<string>} manifest of logical (unprefixed) keys known to exist. */
  var manifest = new Set();
  /** @type {Array<Object>} attached mirrors. */
  var mirrors = [];
  /** @type {Map<string,number>} pending debounce timers per logical key. */
  var timers = new Map();
  var initialised = false;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                        */
  /* ------------------------------------------------------------------ */

  /** @param {string} key @returns {string} the physical key. */
  function physical(key) {
    return PREFIX + key;
  }

  /** @param {string} pkey @returns {boolean} true when pkey is one of ours (probe excluded). */
  function isOurs(pkey) {
    return typeof pkey === 'string' && pkey.indexOf(PREFIX) === 0 && pkey !== PROBE_KEY;
  }

  /** @param {*} key @returns {boolean} true when key is a usable logical key. */
  function isValidKey(key) {
    return typeof key === 'string' && key.length > 0;
  }

  /**
   * Builds the storage envelope for a value.
   * @param {*} value
   * @param {number} ts
   * @returns {{v:*, _ts:number}}
   */
  function envelope(value, ts) {
    return { v: value, _ts: ts };
  }

  /** @param {*} obj @returns {boolean} true when obj looks like an envelope. */
  function isEnvelope(obj) {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
      typeof obj._ts === 'number' && isFinite(obj._ts) && 'v' in obj;
  }

  /**
   * Serialises an envelope. Returns null when the value has no JSON form
   * (functions, symbols, cyclic structures, toJSON returning undefined) so that
   * callers never store an envelope without a `v`.
   * @param {{v:*, _ts:number}} env
   * @returns {string|null}
   */
  function serialise(env) {
    var body;
    try {
      body = JSON.stringify(env.v);
    } catch (err) {
      G.log('[storage] value is not serialisable:', err);
      return null;
    }
    if (body === undefined) return null;
    return '{"v":' + body + ',"_ts":' + env._ts + '}';
  }

  /**
   * Parses a raw stored string into an envelope. Tolerates corrupted JSON and
   * legacy raw values (which are promoted to an envelope with _ts = 0 so that any
   * timestamped copy beats them).
   * @param {string|null|undefined} raw
   * @returns {{v:*, _ts:number}|null}
   */
  function parseEnvelope(raw) {
    if (typeof raw !== 'string') return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      G.log('[storage] corrupted JSON ignored:', raw.slice(0, 80));
      return null;
    }
    if (isEnvelope(parsed)) return parsed;
    return envelope(parsed, 0);
  }

  /**
   * Reads the raw string for a physical key. The memory layer wins because it
   * only ever holds writes/removals the backend refused, i.e. the newest state.
   * @returns {string|null}
   */
  function readRaw(pkey) {
    if (memory.has(pkey)) return memory.get(pkey);
    if (backend) {
      try {
        var raw = backend.getItem(pkey);
        if (typeof raw === 'string') return raw;
      } catch (err) {
        G.log('[storage] getItem failed:', err);
      }
    }
    return null;
  }

  /**
   * Writes a raw string for a physical key. Falls back to memory when the
   * backend rejects the write (quota exceeded, storage revoked mid-session).
   */
  function writeRaw(pkey, raw) {
    if (backend) {
      try {
        backend.setItem(pkey, raw);
        memory.delete(pkey);
        return;
      } catch (err) {
        G.log('[storage] setItem failed, using memory:', err);
      }
    }
    memory.set(pkey, raw);
  }

  /** Deletes a physical key from every place it might live (tombstone on failure). */
  function deleteRaw(pkey) {
    memory.delete(pkey);
    if (!backend) return;
    try {
      backend.removeItem(pkey);
    } catch (err) {
      G.log('[storage] removeItem failed, tombstoning:', err);
      memory.set(pkey, null);
    }
  }

  /** Dispatches the 'g:storage' event; never throws. */
  function emit(key, source) {
    try {
      if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('g:storage', { detail: { key: key, source: source } }));
      }
    } catch (err) {
      G.log('[storage] event dispatch failed:', err);
    }
  }

  /** Marks a mutation: manifest bookkeeping, revision bump and event. */
  function commit(key, present, source) {
    if (present) manifest.add(key);
    else manifest.delete(key);
    storage.rev++;
    emit(key, source);
  }

  /**
   * Timestamp for a local write of `key`: the current clock, but never below
   * the stamp already stored for that key (plus one), so the write always wins
   * a merge against the copy it replaces even when this device's clock lags.
   * @param {string} key
   * @returns {number}
   */
  function stampFor(key) {
    var now = Date.now();
    var current = parseEnvelope(readRaw(physical(key)));
    return current && current._ts >= now ? current._ts + 1 : now;
  }

  /**
   * Races a mirror promise against the configured timeout. Resolves with
   * `undefined` on failure or timeout so callers never need try/catch.
   * @param {Promise|*} promise
   * @returns {Promise<*>}
   */
  function settle(promise) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      var timer = setTimeout(function () { finish(undefined); }, storage.mirrorTimeoutMs);
      Promise.resolve(promise).then(finish, function (err) {
        G.log('[storage] mirror call failed:', err);
        finish(undefined);
      });
    });
  }

  /** Calls `fn` on a mirror, guarding synchronous throws, and returns a settled promise. */
  function callMirror(mirror, method, args) {
    var result;
    try {
      result = mirror[method].apply(mirror, args);
    } catch (err) {
      G.log('[storage] mirror', mirror.name, method, 'threw:', err);
      return Promise.resolve(undefined);
    }
    return settle(result);
  }

  /** Pushes the current raw value of `key` to every mirror (fire & forget). */
  function pushKey(key) {
    var raw = readRaw(physical(key));
    if (raw === null) return;
    for (var i = 0; i < mirrors.length; i++) pushToMirror(mirrors[i], key, raw);
  }

  /** Pushes one raw value to one mirror, honouring its optional maxLength. */
  function pushToMirror(mirror, key, raw) {
    if (typeof mirror.maxLength === 'number' && raw.length > mirror.maxLength) {
      G.log('[storage] mirror', mirror.name, 'skipped oversized key', key, raw.length);
      return;
    }
    callMirror(mirror, 'set', [key, raw]);
  }

  /** Cancels a pending debounced push for a key, if any. */
  function cancelTimer(key) {
    if (timers.has(key)) {
      clearTimeout(timers.get(key));
      timers.delete(key);
    }
  }

  /** (Re)starts the debounce timer for a key. */
  function schedulePush(key) {
    if (!mirrors.length) return;
    cancelTimer(key);
    timers.set(key, setTimeout(function () {
      timers.delete(key);
      pushKey(key);
    }, storage.debounceMs));
  }

  /** Rebuilds the manifest from the active backend (prefix scan) and the memory layer. */
  function rebuildManifest() {
    manifest.clear();
    if (backend) {
      try {
        for (var i = 0; i < backend.length; i++) {
          var pkey = backend.key(i);
          if (isOurs(pkey)) manifest.add(pkey.slice(PREFIX.length));
        }
      } catch (err) {
        G.log('[storage] key scan failed:', err);
      }
    }
    memory.forEach(function (raw, pkey) {
      var key = pkey.slice(PREFIX.length);
      if (raw === null) manifest.delete(key);
      else manifest.add(key);
    });
  }

  /** Probes window.localStorage with a set/read/remove round-trip. */
  function probeLocalStorage() {
    try {
      var ls = window.localStorage;
      if (!ls) return null;
      ls.setItem(PROBE_KEY, '1');
      var ok = ls.getItem(PROBE_KEY) === '1';
      ls.removeItem(PROBE_KEY);
      return ok ? ls : null;
    } catch (err) {
      G.log('[storage] localStorage unavailable, using memory:', err);
      return null;
    }
  }

  /**
   * Handles the native 'storage' event fired when ANOTHER document of this
   * origin writes localStorage: keeps the manifest honest and re-emits as a
   * 'g:storage' event with source 'external'. Nothing is pushed to mirrors
   * (the writing tab owns that).
   * @param {StorageEvent} ev
   */
  function onExternalStorage(ev) {
    if (!ev || ev.storageArea !== backend) return;
    if (ev.key === null) {
      // localStorage.clear() elsewhere: everything we knew about is gone.
      var known = Array.from(manifest);
      memory.clear();
      rebuildManifest();
      known.forEach(function (key) { if (!manifest.has(key)) emit(key, 'external'); });
      return;
    }
    if (!isOurs(ev.key)) return;
    var key = ev.key.slice(PREFIX.length);
    memory.delete(physical(key));
    if (typeof ev.newValue === 'string') manifest.add(key);
    else manifest.delete(key);
    emit(key, 'external');
  }

  /** Flushes pending pushes when the page is about to disappear; listens for cross-tab writes. */
  function installLifecycleHooks() {
    try {
      if (typeof window.addEventListener !== 'function') return;
      window.addEventListener('pagehide', function () { storage.flush(); });
      if (backend) window.addEventListener('storage', onExternalStorage);
      if (window.document && typeof window.document.addEventListener === 'function') {
        window.document.addEventListener('visibilitychange', function () {
          if (window.document.hidden) storage.flush();
        });
      }
    } catch (err) {
      G.log('[storage] lifecycle hooks unavailable:', err);
    }
  }

  /** Makes sure init() ran, so every public call is safe in any load order. */
  function ensureInit() {
    if (!initialised) storage.init();
  }

  /**
   * Reconciles one key between local storage and every mirror.
   * The copy with the newest _ts wins; losers are overwritten. The local copy
   * is read AFTER the mirrors answered, so a set() made while the mirrors were
   * being queried is compared with its real timestamp instead of a stale one.
   * @param {string} key
   * @returns {Promise<void>}
   */
  function reconcileKey(key) {
    var candidates = mirrors.map(function (mirror) {
      return callMirror(mirror, 'get', [key]).then(function (raw) {
        var env = parseEnvelope(raw);
        return { mirror: mirror, raw: env ? raw : null, env: env };
      });
    });
    return Promise.all(candidates).then(function (remotes) {
      var localRaw = readRaw(physical(key));
      var local = parseEnvelope(localRaw);
      var bestTs = local ? local._ts : -1;
      var bestRaw = local ? localRaw : null;
      var winner = null;
      remotes.forEach(function (remote) {
        if (remote.env && remote.env._ts > bestTs) {
          bestTs = remote.env._ts;
          bestRaw = remote.raw;
          winner = remote.mirror;
        }
      });
      if (bestRaw === null) return;
      // Whatever the outcome, every holder is brought up to date below, so a
      // pending debounced push of this key would only duplicate work.
      cancelTimer(key);
      if (winner) {
        // Store the remote copy normalised (keeps its _ts) and announce it.
        bestRaw = serialise(parseEnvelope(bestRaw));
        writeRaw(physical(key), bestRaw);
        commit(key, true, 'mirror:' + winner.name);
      }
      remotes.forEach(function (remote) {
        if (remote.mirror === winner || mirrors.indexOf(remote.mirror) === -1) return;
        if (!remote.env || remote.env._ts < bestTs) pushToMirror(remote.mirror, key, bestRaw);
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */

  var storage = {
    /** Prefix applied to every physical key (read-only by convention). */
    PREFIX: PREFIX,

    /** True when real localStorage passed the probe; false when running on the in-memory fallback. */
    available: false,

    /** Monotonic revision counter, bumped on every local mutation. Cheap change detection for UIs. */
    rev: 0,

    /** Debounce window for mirror pushes after set(), in ms. */
    debounceMs: DEFAULT_DEBOUNCE_MS,

    /** Maximum time a single mirror call may take before being abandoned, in ms. */
    mirrorTimeoutMs: DEFAULT_MIRROR_TIMEOUT_MS,

    /**
     * Detects localStorage availability and seeds the manifest. Idempotent; every
     * other method calls it lazily, so load order does not matter.
     * @returns {boolean} the detected availability.
     */
    init: function () {
      if (initialised) return storage.available;
      initialised = true;
      backend = probeLocalStorage();
      storage.available = !!backend;
      rebuildManifest();
      installLifecycleHooks();
      G.log('[storage] init, localStorage available:', storage.available, 'keys:', manifest.size);
      return storage.available;
    },

    /**
     * Reads a value.
     * @param {string} key logical key (without prefix)
     * @param {*} [fallback] returned when the key is missing or unreadable
     * @returns {*}
     */
    get: function (key, fallback) {
      ensureInit();
      if (!isValidKey(key)) return fallback;
      var env = parseEnvelope(readRaw(physical(key)));
      if (!env) return fallback;
      manifest.add(key);
      return env.v;
    },

    /**
     * Returns the stored timestamp (epoch ms) of a key, or 0 when it is missing
     * or untimestamped. Useful for "last played" style UI without reading the value.
     * @param {string} key
     * @returns {number}
     */
    timestamp: function (key) {
      ensureInit();
      if (!isValidKey(key)) return 0;
      var env = parseEnvelope(readRaw(physical(key)));
      return env ? env._ts : 0;
    },

    /**
     * Writes a JSON-serialisable value, records the key in the manifest, bumps
     * rev, emits 'g:storage' and schedules a debounced push to all mirrors.
     * Passing `undefined` removes the key (mirrors JSON semantics).
     * @param {string} key
     * @param {*} value
     * @returns {boolean} true when the write (or removal) was accepted; false for
     *   an invalid key or a value without a JSON form (function, symbol, cycle).
     */
    set: function (key, value) {
      ensureInit();
      if (!isValidKey(key)) return false;
      if (value === undefined) {
        storage.remove(key);
        return true;
      }
      var raw = serialise(envelope(value, stampFor(key)));
      if (raw === null) {
        G.log('[storage] set rejected: value for', key, 'has no JSON form');
        return false;
      }
      writeRaw(physical(key), raw);
      commit(key, true, 'local');
      schedulePush(key);
      return true;
    },

    /**
     * Deletes a key locally and (immediately, fire & forget) from every mirror.
     * Removing a key that does not exist is a no-op locally (no rev bump, no
     * event) but is still forwarded to the mirrors so stray remote copies die.
     * @param {string} key
     * @returns {boolean} true when the key existed
     */
    remove: function (key) {
      ensureInit();
      if (!isValidKey(key)) return false;
      var existed = manifest.has(key) || readRaw(physical(key)) !== null;
      cancelTimer(key);
      deleteRaw(physical(key));
      if (existed) commit(key, false, 'local');
      for (var i = 0; i < mirrors.length; i++) callMirror(mirrors[i], 'remove', [key]);
      return existed;
    },

    /**
     * Lists every logical key currently stored (sorted for stable output).
     * @returns {string[]}
     */
    keys: function () {
      ensureInit();
      return Array.from(manifest).sort();
    },

    /**
     * Registers a remote copy of the store.
     * @param {{name:string, get:function(string):Promise<?string>, set:function(string,string):Promise,
     *          remove:function(string):Promise, bulkKeys?:function():Promise<string[]>, maxLength?:number}} mirror
     *   `get` must resolve to the exact string previously passed to `set`, or null.
     *   Keys are handed over UNPREFIXED so adapters can apply provider-specific rules
     *   (e.g. Telegram CloudStorage allows only [A-Za-z0-9_-]). `maxLength`, when set,
     *   skips pushes whose serialised value would exceed the provider's limit.
     *   Attaching a mirror with the name of an existing one replaces it. Call
     *   pullMirrors() afterwards to reconcile what was written before the attach.
     * @returns {function():void} detach function; also available as detachMirror(name).
     */
    attachMirror: function (mirror) {
      ensureInit();
      var valid = mirror && typeof mirror.name === 'string' && mirror.name &&
        typeof mirror.get === 'function' && typeof mirror.set === 'function' &&
        typeof mirror.remove === 'function';
      if (!valid) {
        G.log('[storage] attachMirror rejected invalid mirror:', mirror);
        return function () {};
      }
      storage.detachMirror(mirror.name);
      mirrors.push(mirror);
      G.log('[storage] mirror attached:', mirror.name);
      return function () { storage.detachMirror(mirror.name); };
    },

    /**
     * Removes a mirror by name. Pending pushes still in the debounce window are
     * not delivered to it.
     * @param {string} name
     * @returns {boolean} true when a mirror was removed
     */
    detachMirror: function (name) {
      var before = mirrors.length;
      mirrors = mirrors.filter(function (m) { return m.name !== name; });
      return mirrors.length !== before;
    },

    /** @returns {string[]} names of attached mirrors, in attach order. */
    mirrorNames: function () {
      return mirrors.map(function (m) { return m.name; });
    },

    /**
     * Pulls keys from every mirror and merges by timestamp: the copy with the
     * newest _ts wins and is written to every place holding an older copy
     * (local included). Local writes made this way emit 'g:storage' with
     * source 'mirror:<name>' and bump rev. Never throws, never rejects.
     * @param {string[]|string} [keys] defaults to the union of local keys and every mirror's bulkKeys()
     * @returns {Promise<void>}
     */
    pullMirrors: function (keys) {
      ensureInit();
      if (!mirrors.length) return Promise.resolve();
      if (typeof keys === 'string') keys = [keys];
      var listing = Array.isArray(keys)
        ? Promise.resolve(keys.filter(isValidKey))
        : collectKeys();
      return listing.then(function (list) {
        var unique = Array.from(new Set(list));
        return Promise.all(unique.map(function (key) {
          return reconcileKey(key).then(null, function (err) {
            G.log('[storage] reconcile failed for', key, err);
          });
        }));
      }).then(function () {
        G.log('[storage] pullMirrors done');
      }, function (err) {
        G.log('[storage] pullMirrors failed:', err);
      });
    },

    /**
     * Immediately pushes every pending debounced write to the mirrors. Called
     * automatically on pagehide / visibility hidden; safe to call any time.
     */
    flush: function () {
      var pending = Array.from(timers.keys());
      pending.forEach(function (key) {
        cancelTimer(key);
        pushKey(key);
      });
    },

    /**
     * Serialises the whole store (envelopes included, so timestamps survive).
     * @returns {string} JSON: {format, exportedAt, prefix, data:{key:{v,_ts}}}
     */
    export: function () {
      ensureInit();
      var data = {};
      storage.keys().forEach(function (key) {
        var env = parseEnvelope(readRaw(physical(key)));
        if (env) data[key] = env;
      });
      return JSON.stringify({
        format: EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        prefix: PREFIX,
        data: data
      });
    },

    /**
     * Restores a snapshot produced by export(). Also accepts a plain
     * {key: value} object (values are stamped with the current time). Envelope
     * timestamps are preserved. Each imported key emits 'g:storage' and is
     * pushed to the mirrors through the usual debounce. Entries without a JSON
     * form are skipped and not counted.
     * @param {string|Object} json
     * @returns {{ok:boolean, imported:number, error?:string}}
     */
    import: function (json) {
      ensureInit();
      var parsed;
      try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json;
      } catch (err) {
        return { ok: false, imported: 0, error: 'invalid JSON' };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, imported: 0, error: 'snapshot must be an object' };
      }
      var data = parsed.format === EXPORT_FORMAT && parsed.data && typeof parsed.data === 'object'
        ? parsed.data
        : parsed;
      var imported = 0;
      Object.keys(data).forEach(function (key) {
        if (!isValidKey(key)) return;
        var entry = data[key];
        var raw = serialise(isEnvelope(entry) ? entry : envelope(entry, Date.now()));
        if (raw === null) {
          G.log('[storage] import skipped key without JSON form:', key);
          return;
        }
        writeRaw(physical(key), raw);
        commit(key, true, 'import');
        schedulePush(key);
        imported++;
      });
      return { ok: true, imported: imported };
    }
  };

  /** Union of local keys and every mirror's bulkKeys() (when provided). */
  function collectKeys() {
    var local = storage.keys();
    var remote = mirrors
      .filter(function (m) { return typeof m.bulkKeys === 'function'; })
      .map(function (m) {
        return callMirror(m, 'bulkKeys', []).then(function (list) {
          return Array.isArray(list) ? list.filter(isValidKey) : [];
        });
      });
    return Promise.all(remote).then(function (lists) {
      return lists.reduce(function (acc, list) { return acc.concat(list); }, local);
    });
  }

  G.storage = storage;
})();
