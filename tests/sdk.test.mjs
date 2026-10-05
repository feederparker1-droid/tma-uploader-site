// Tests for game/js/sdk.js (G.sdk).
// Run: node tests/sdk.test.mjs
//
// Every scenario runs in real Chromium (Playwright). The page is served from a
// virtual https origin via page.route so ?sdk=… forcing and location.search
// behave exactly as on a real host, while no byte ever leaves the test. Vendor
// SDKs are replaced by in-page mocks and script loading is intercepted through
// the G.sdk._test.loadScript seam; time is controlled through G.sdk._test.now.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK_PATH = path.resolve(here, '../game/js/sdk.js');
const ORIGIN = 'https://game.test';
const BLANK_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>sdk test</title></head><body></body></html>';

const deepEq = (actual, expected) => assert.deepEqual(structuredClone(actual), expected);

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

/* ------------------------------------------------------------------ */
/* In-page mocks (serialised into the browser with page.evaluate)       */
/* ------------------------------------------------------------------ */

/** Shared spy/recording helpers installed on window.__t before anything else. */
function installHarness() {
  const t = {
    events: [],                     // ordered hook / telemetry log
    calls: {},                      // name → argument lists
    scripts: [],                    // URLs handed to the loadScript seam
    clipboard: [],                  // texts written to the clipboard stub
  };
  t.spy = (name, impl) => function (...args) {
    (t.calls[name] = t.calls[name] || []).push(args);
    t.events.push(name);
    return impl ? impl.apply(this, args) : undefined;
  };
  t.hooks = {
    pause: () => t.events.push('pause'),
    mute: () => t.events.push('mute'),
    resume: () => t.events.push('resume'),
    unmute: () => t.events.push('unmute'),
  };
  // Deterministic clipboard: headless Chromium has no clipboard permission.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (s) => { t.clipboard.push(s); return Promise.resolve(); } },
  });
  // Minimal G.storage stand-in so mirror attachment can be observed.
  const store = new Map();
  window.G = window.G || {};
  window.G.storage = {
    mirrors: [],
    attachMirror(m) { this.mirrors.push(m); return () => { this.mirrors = this.mirrors.filter((x) => x !== m); }; },
    get(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
    set(key, value) { store.set(key, value); window.dispatchEvent(new CustomEvent('g:storage', { detail: { key } })); },
  };
  window.__t = t;
}

/** CrazyGames SDK v3 mock. `opts` is JSON (evaluated in page). */
function installCrazyGames(opts) {
  const t = window.__t;
  const data = new Map();
  const ad = {
    requestAd: t.spy('requestAd', (type, cb) => {
      if (opts.adMode === 'hang') return;
      if (opts.adMode === 'startOnly') { setTimeout(() => cb.adStarted(), 5); return; }
      if (opts.adMode === 'error') { setTimeout(() => cb.adError(new Error('no fill')), 5); return; }
      setTimeout(() => cb.adStarted(), 5);
      setTimeout(() => cb.adFinished(), 15);
    }),
  };
  window.CrazyGames = {
    SDK: {
      environment: opts.environment || 'crazygames',
      init: t.spy('init', () => opts.initRejects ? Promise.reject(new Error('init failed')) : Promise.resolve()),
      game: {
        loadingStart: t.spy('loadingStart'),
        loadingStop: t.spy('loadingStop'),
        gameplayStart: t.spy('gameplayStart'),
        gameplayStop: t.spy('gameplayStop'),
        happytime: t.spy('happytime'),
        inviteLink: t.spy('inviteLink', (params) => Promise.resolve('https://www.crazygames.com/game/x?seed=' + params.seed)),
        getInviteParam: t.spy('getInviteParam', (name) => (name === 'seed' ? '42' : undefined)),
      },
      ad,
      banner: { requestResponsiveBanner: t.spy('requestResponsiveBanner'), clearBanner: t.spy('clearBanner') },
      user: {
        isUserAccountAvailable: true,
        getUser: () => Promise.resolve({ username: 'bob', profilePictureUrl: 'https://img/x.png' }),
      },
      data: {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, v); },
        removeItem: (k) => { data.delete(k); },
        _keys: () => Array.from(data.keys()),
      },
    },
  };
}

/** Poki SDK mock; rewardedBreak resolves `opts.rewardedResult`. */
function installPoki(opts) {
  const t = window.__t;
  window.PokiSDK = {
    init: t.spy('init', () => Promise.resolve()),
    setDebug: t.spy('setDebug'),
    gameLoadingFinished: t.spy('gameLoadingFinished'),
    gameplayStart: t.spy('gameplayStart'),
    gameplayStop: t.spy('gameplayStop'),
    commercialBreak: t.spy('commercialBreak', (onStart) => { onStart(); return new Promise((r) => setTimeout(r, 10)); }),
    rewardedBreak: t.spy('rewardedBreak', (onStart) => { onStart(); return new Promise((r) => setTimeout(() => r(opts.rewardedResult), 10)); }),
    shareableURL: t.spy('shareableURL', (params) => Promise.resolve('https://poki.com/g/x?gdseed=' + params.seed)),
    getURLParam: t.spy('getURLParam', (name) => (name === 'seed' ? '7' : '')),
  };
}

/** Telegram WebApp mock. */
function installTelegram(opts) {
  const t = window.__t;
  const cloud = new Map();
  const tg = {
    initData: 'query_id=AAE&user=%7B%22id%22%3A7%7D&hash=abc',
    initDataUnsafe: {
      user: { id: 7, first_name: 'Ada', last_name: 'L', username: 'ada', language_code: 'tr', is_premium: true, photo_url: 'https://img/a.png' },
      start_param: opts.startParam,
    },
    platform: opts.platform || 'ios',
    version: '8.0',
    colorScheme: 'dark',
    themeParams: { bg_color: '#101010' },
    safeAreaInset: { top: 47, right: 0, bottom: 34, left: 0 },
    contentSafeAreaInset: { top: 20, right: 0, bottom: 0, left: 0 },
    isVersionAtLeast: (v) => parseFloat(v) <= parseFloat(opts.version || '8.0'),
    ready: t.spy('ready'),
    expand: t.spy('expand'),
    requestFullscreen: t.spy('requestFullscreen'),
    disableVerticalSwipes: t.spy('disableVerticalSwipes'),
    setHeaderColor: t.spy('setHeaderColor'),
    setBackgroundColor: t.spy('setBackgroundColor'),
    onEvent: t.spy('onEvent'),
    openTelegramLink: t.spy('openTelegramLink'),
    openInvoice: t.spy('openInvoice', (url, cb) => setTimeout(() => cb(opts.invoiceStatus || 'paid'), 5)),
    HapticFeedback: {
      impactOccurred: t.spy('impactOccurred'),
      notificationOccurred: t.spy('notificationOccurred'),
      selectionChanged: t.spy('selectionChanged'),
    },
    CloudStorage: {
      getItem: (k, cb) => setTimeout(() => cb(null, cloud.has(k) ? cloud.get(k) : ''), 1),
      setItem: (k, v, cb) => setTimeout(() => { cloud.set(k, v); cb(null, true); }, 1),
      removeItem: (k, cb) => setTimeout(() => { cloud.delete(k); cb(null, true); }, 1),
      _keys: () => Array.from(cloud.keys()),
    },
  };
  window.Telegram = { WebApp: tg };
}

/* ------------------------------------------------------------------ */
/* Page factory                                                         */
/* ------------------------------------------------------------------ */

/**
 * Opens a page on the virtual origin, installs the harness and optional vendor
 * mock, loads sdk.js and wires the loadScript seam (recording, resolving or
 * rejecting per `scriptMode`). Returns the page plus a list of external hosts
 * the page tried to reach (must stay empty).
 */
async function openPage({ query = '', debug = false, mock = null, mockOpts = {}, lazy = false, scriptMode = 'resolve', clock = false } = {}) {
  const page = await browser.newPage();
  const external = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) return route.fulfill({ status: 200, contentType: 'text/html', body: BLANK_HTML });
    external.push(url);
    return route.abort();
  });
  await page.goto(`${ORIGIN}/${query}`);
  if (debug) await page.evaluate(() => { window.G = { DEBUG: true }; });
  await page.evaluate(installHarness);
  const installer = { crazygames: installCrazyGames, poki: installPoki, telegram: installTelegram }[mock];
  if (installer && !lazy) await page.evaluate(installer, mockOpts);
  if (installer && lazy) {
    // The mock appears only when the vendor "script" loads, like the real SDK would.
    await page.evaluate(({ src, opts }) => {
      window.__lazyMock = () => (0, eval)('(' + src + ')')(opts);
    }, { src: installer.toString(), opts: mockOpts });
  }
  await page.addScriptTag({ path: SDK_PATH });
  await page.evaluate(({ scriptMode, clock }) => {
    const t = window.__t;
    G.sdk._test.loadScript = (url) => {
      t.scripts.push(url);
      if (scriptMode === 'reject') return Promise.reject(new Error('blocked'));
      if (scriptMode === 'hang') return new Promise(() => {});
      if (window.__lazyMock) window.__lazyMock();
      return Promise.resolve();
    };
    if (clock) { t.clock = 0; G.sdk._test.now = () => t.clock; }
  }, { scriptMode, clock });
  return { page, external };
}

/** Initialises G.sdk inside the page with the harness hooks and extra config. */
const init = (page, extra = {}) => page.evaluate((extra) => {
  const cfg = Object.assign({ hooks: window.__t.hooks }, extra);
  if (extra.withInvoice) cfg.createInvoice = (itemId) => { window.__t.invoiceItem = itemId; return Promise.resolve('https://t.me/$invoice/abc'); };
  return G.sdk.init(cfg).then(() => ({ provider: G.sdk.provider, ready: G.sdk.ready, caps: G.sdk.caps, user: G.sdk.user }));
}, extra);

const harness = (page) => page.evaluate(() => ({
  events: window.__t.events, calls: window.__t.calls, scripts: window.__t.scripts, clipboard: window.__t.clipboard,
}));
const hookEvents = (page) => page.evaluate(() => window.__t.events.filter((e) => ['pause', 'mute', 'resume', 'unmute'].includes(e)));
const clearEvents = (page) => page.evaluate(() => { window.__t.events.length = 0; });
const setClock = (page, ms) => page.evaluate((ms) => { window.__t.clock = ms; }, ms);

/* ------------------------------------------------------------------ */
/* (a) No SDK present → provider 'none'                                 */
/* ------------------------------------------------------------------ */

describe('provider none (standalone)', () => {
  test('detects none, loads nothing, ads unavailable, share falls back to clipboard', async () => {
    const { page, external } = await openPage();
    const r = await init(page, { appUrl: 'https://example.com/game/' });
    assert.equal(r.provider, 'none');
    assert.equal(r.ready, true);
    assert.equal(await page.evaluate(() => G.sdk.isStandalone), true);
    assert.equal(r.caps.rewarded, false);
    assert.equal(r.caps.interstitial, false);
    assert.equal(r.caps.share, true);
    assert.equal(r.caps.iap, false);

    deepEq(await page.evaluate(() => G.sdk.showInterstitial({ placement: 'gameover' })), { shown: false, reason: 'unsupported' });
    deepEq(await page.evaluate(() => G.sdk.showRewarded({ placement: 'revive' })), { rewarded: false, reason: 'unavailable' });
    assert.equal(await page.evaluate(() => G.sdk.canShowRewarded()), false);
    deepEq(await hookEvents(page), []);

    const share = await page.evaluate(() => G.sdk.share({ text: 'Beat me!', params: { seed: 'abc', ref: 'u1' } }));
    assert.equal(share.ok, true);
    assert.equal(share.method, 'clipboard');
    assert.equal(share.url, 'https://example.com/game/?seed=abc&ref=u1');
    const h = await harness(page);
    assert.equal(h.clipboard[0], 'Beat me! https://example.com/game/?seed=abc&ref=u1');
    deepEq(h.scripts, []);
    deepEq(external, []);

    const safe = await page.evaluate(() => document.documentElement.style.getPropertyValue('--safe-top').trim());
    assert.equal(safe, 'env(safe-area-inset-top, 0px)');
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 0, rewardedShown: 0, rewardedGranted: 0 });
    await page.close();
  });

  test('getParam reads the URL query; purchase unsupported', async () => {
    const { page } = await openPage({ query: '?seed=99&ref=zed' });
    await init(page);
    assert.equal(await page.evaluate(() => G.sdk.getParam('seed')), '99');
    assert.equal(await page.evaluate(() => G.sdk.getParam('ref')), 'zed');
    assert.equal(await page.evaluate(() => G.sdk.getParam('missing')), null);
    deepEq(await page.evaluate(() => G.sdk.purchase('skin_gold', { title: 'Gold', stars: 50 })), { ok: false, status: 'unsupported' });
    await page.close();
  });

  test('DEBUG fake ad overlay grants the reward and runs the hooks in order', async () => {
    const { page } = await openPage({ debug: true });
    await init(page);
    assert.equal(await page.evaluate(() => G.DEBUG), true);
    assert.equal(await page.evaluate(() => G.sdk.canShowRewarded()), true);
    await page.evaluate(() => { G.sdk._test.timeouts.fakeAd = 400; });

    const resultPromise = page.evaluate(() => G.sdk.showRewarded({ placement: 'revive' }));
    await page.waitForSelector('[data-sdk-fake-ad]', { state: 'attached' });
    assert.match(await page.textContent('[data-sdk-fake-ad]'), /Test ad/);
    // A second request while the overlay is up is refused.
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'busy' });
    deepEq(await resultPromise, { rewarded: true });
    assert.equal(await page.$('[data-sdk-fake-ad]'), null);
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 0, rewardedShown: 1, rewardedGranted: 1 });
    await page.close();
  });

  test('closing the fake ad early yields no reward', async () => {
    const { page } = await openPage({ debug: true });
    await init(page);
    await page.evaluate(() => { G.sdk._test.timeouts.fakeAd = 5000; });
    const resultPromise = page.evaluate(() => G.sdk.showRewarded());
    await page.click('[data-sdk-fake-ad] button');
    deepEq(await resultPromise, { rewarded: false, reason: 'skipped' });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    await page.close();
  });

  test('onPause/onResume follow document visibility', async () => {
    const { page } = await openPage();
    await init(page);
    const log = await page.evaluate(async () => {
      const out = [];
      G.sdk.onPause((r) => out.push('pause:' + r));
      G.sdk.onResume((r) => out.push('resume:' + r));
      let hidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      return out;
    });
    deepEq(log, ['pause:visibility', 'resume:visibility']);
    await page.close();
  });

  test('haptics honour the user setting from G.storage', async () => {
    const { page } = await openPage();
    await init(page);
    const r = await page.evaluate(() => {
      const calls = [];
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { calls.push(p); return true; } });
      const first = G.sdk.haptic('light');
      G.storage.set('haptics', false);
      const second = G.sdk.haptic('heavy');
      G.storage.set('haptics', true);
      const third = G.sdk.haptic('success');
      return { first, second, third, calls, enabled: G.sdk.hapticsEnabled };
    });
    assert.equal(r.first, true);
    assert.equal(r.second, false);
    assert.equal(r.third, true);
    deepEq(r.calls, [[10], [10, 40, 20]]);
    assert.equal(r.enabled, true);
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* (b) CrazyGames                                                       */
/* ------------------------------------------------------------------ */

describe('provider crazygames (forced via ?sdk=crazygames)', () => {
  test('loads the vendor script through the seam, inits, exposes caps/user', async () => {
    const { page, external } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', lazy: true });
    const r = await init(page);
    assert.equal(r.provider, 'crazygames');
    assert.equal(r.ready, true);
    assert.equal(r.caps.rewarded, true);
    assert.equal(r.caps.interstitial, true);
    assert.equal(r.caps.inviteLink, true);
    assert.equal(r.caps.cloudSave, true);
    assert.equal(r.caps.banner, true);
    deepEq(r.user, { id: 'bob', name: 'bob', avatar: 'https://img/x.png', lang: null, premium: false });
    const h = await harness(page);
    deepEq(h.scripts, ['https://sdk.crazygames.com/crazygames-sdk-v3.js']);
    assert.equal(h.calls.init.length, 1);
    deepEq(external, []);
    assert.equal(await page.evaluate(() => G.sdk.isStandalone), false);
    await page.close();
  });

  test('rewarded ad: hooks ordered pause,mute,resume,unmute and reward granted', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await init(page);
    const pauseLog = await page.evaluate(() => {
      const out = [];
      G.sdk.onPause((r) => out.push('pause:' + r));
      G.sdk.onResume((r) => out.push('resume:' + r));
      window.__pauseLog = out;
      return out;
    });
    assert.equal(pauseLog.length, 0);
    deepEq(await page.evaluate(() => G.sdk.showRewarded({ placement: 'revive' })), { rewarded: true });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    deepEq(await page.evaluate(() => window.__pauseLog), ['pause:ad', 'resume:ad']);
    const h = await harness(page);
    assert.equal(h.calls.requestAd[0][0], 'rewarded');
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 0, rewardedShown: 1, rewardedGranted: 1 });
    assert.equal(await page.evaluate(() => G.sdk._test.state().adRunning), false);
    await page.close();
  });

  test('adError yields no reward and no stray resume', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', mockOpts: { adMode: 'error' } });
    await init(page);
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'error' });
    deepEq(await hookEvents(page), []);
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 0, rewardedShown: 0, rewardedGranted: 0 });
    await page.close();
  });

  test('rewarded timeout releases the hooks', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', mockOpts: { adMode: 'startOnly' } });
    await init(page);
    await page.evaluate(() => { G.sdk._test.timeouts.rewarded = 150; });
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'timeout' });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    assert.equal(await page.evaluate(() => G.sdk._test.state().adRunning), false);
    await page.close();
  });

  test('gameplayStart/Stop and loadingStart/Stop never double-fire; ads pause telemetry', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', clock: true });
    await init(page);
    await page.evaluate(() => {
      G.sdk.loadingStart(); G.sdk.loadingStart(); G.sdk.loadingStop(); G.sdk.loadingStop();
      G.sdk.gameplayStop();                       // not playing yet → ignored
      G.sdk.gameplayStart(); G.sdk.gameplayStart();
      G.sdk.gameplayStop(); G.sdk.gameplayStop();
      G.sdk.gameplayStart();                      // playing again
    });
    let h = await harness(page);
    assert.equal(h.calls.loadingStart.length, 1);
    assert.equal(h.calls.loadingStop.length, 1);
    assert.equal(h.calls.gameplayStart.length, 2);
    assert.equal(h.calls.gameplayStop.length, 1);

    // An ad while playing: the adapter stops telemetry before and restarts after.
    await clearEvents(page);
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: true });
    h = await harness(page);
    deepEq(h.events, ['gameplayStop', 'requestAd', 'pause', 'mute', 'resume', 'unmute', 'gameplayStart']);
    assert.equal(await page.evaluate(() => G.sdk._test.state().gameplayActive), true);

    // happyTime is throttled.
    await page.evaluate(() => { G.sdk.happyTime(); G.sdk.happyTime(); });
    await setClock(page, 20000);
    await page.evaluate(() => G.sdk.happyTime());
    h = await harness(page);
    assert.equal(h.calls.happytime.length, 2);
    await page.close();
  });

  test('share uses inviteLink, getParam uses getInviteParam, banner proxies', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await init(page);
    const share = await page.evaluate(() => G.sdk.share({ text: 'Go', params: { seed: 's1' } }));
    assert.equal(share.ok, true);
    assert.equal(share.method, 'clipboard');
    assert.equal(share.url, 'https://www.crazygames.com/game/x?seed=s1');
    assert.equal(await page.evaluate(() => G.sdk.getParam('seed')), '42');
    assert.equal(await page.evaluate(() => G.sdk.getParam('other')), null);
    assert.equal(await page.evaluate(() => G.sdk.banner.show('ad-slot')), true);
    assert.equal(await page.evaluate(() => G.sdk.banner.clear('ad-slot')), true);
    const h = await harness(page);
    deepEq(h.calls.requestResponsiveBanner, [['ad-slot']]);
    deepEq(h.calls.clearBanner, [['ad-slot']]);
    await page.close();
  });

  test('attaches a G.storage mirror on SDK.data with the g1. prefix', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await init(page);
    const r = await page.evaluate(async () => {
      const m = G.storage.mirrors[0];
      await m.set('best', '{"v":12,"_ts":1}');
      const got = await m.get('best');
      const missing = await m.get('nope');
      await m.remove('best');
      const afterRemove = await m.get('best');
      return { name: m.name, got, missing, afterRemove, keys: window.CrazyGames.SDK.data._keys(), count: G.storage.mirrors.length };
    });
    assert.equal(r.count, 1);
    assert.equal(r.name, 'crazygames-data');
    assert.equal(r.got, '{"v":12,"_ts":1}');
    assert.equal(r.missing, null);
    assert.equal(r.afterRemove, null);
    deepEq(r.keys, []);
    await page.close();
  });

  test('script load failure degrades to no ads but keeps the provider', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', scriptMode: 'reject' });
    const r = await init(page);
    assert.equal(r.provider, 'crazygames');
    assert.equal(r.ready, true);
    assert.equal(r.caps.rewarded, false);
    assert.equal(r.caps.interstitial, false);
    assert.equal(r.caps.cloudSave, false);
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'unavailable' });
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'unsupported' });
    assert.equal(await page.evaluate(() => G.sdk.getParam('seed')), null);
    const share = await page.evaluate(() => G.sdk.share({ text: 'x', params: { seed: '1' } }));
    assert.equal(share.method, 'clipboard');
    await page.evaluate(() => { G.sdk.gameplayStart(); G.sdk.gameplayStop(); }); // must not throw without SDK
    await page.close();
  });

  test('script load timeout degrades too', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', scriptMode: 'hang' });
    await page.evaluate(() => { G.sdk._test.timeouts.script = 100; });
    const r = await init(page);
    assert.equal(r.provider, 'crazygames');
    assert.equal(r.ready, true);
    assert.equal(r.caps.rewarded, false);
    await page.close();
  });

  test('environment "disabled" degrades', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', mockOpts: { environment: 'disabled' } });
    const r = await init(page);
    assert.equal(r.caps.rewarded, false);
    assert.equal(r.ready, true);
    await page.close();
  });

  test('auto-detects CrazyGames when window.CrazyGames is present (no ?sdk=)', async () => {
    const { page } = await openPage({ mock: 'crazygames' });
    const r = await init(page);
    assert.equal(r.provider, 'crazygames');
    deepEq((await harness(page)).scripts, []); // already present → not loaded again
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* (c) Poki                                                             */
/* ------------------------------------------------------------------ */

describe('provider poki', () => {
  test('rewardedBreak resolving false → rewarded:false; hooks still paired', async () => {
    const { page } = await openPage({ query: '?sdk=poki', mock: 'poki', mockOpts: { rewardedResult: false }, lazy: true });
    const r = await init(page);
    assert.equal(r.provider, 'poki');
    assert.equal(r.caps.rewarded, true);
    deepEq((await harness(page)).scripts, ['https://game-cdn.poki.com/scripts/v2/poki-sdk.js']);
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'incomplete' });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 0, rewardedShown: 1, rewardedGranted: 0 });
    await page.close();
  });

  test('rewardedBreak true grants; commercialBreak after warmup; loading/share/getParam', async () => {
    const { page } = await openPage({ query: '?sdk=poki', mock: 'poki', mockOpts: { rewardedResult: true }, clock: true });
    await init(page);
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: true });
    await setClock(page, 400000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: true });
    await page.evaluate(() => { G.sdk.loadingStart(); G.sdk.loadingStop(); G.sdk.loadingStart(); G.sdk.loadingStop(); });
    const h = await harness(page);
    assert.equal(h.calls.gameLoadingFinished.length, 1);
    deepEq(h.calls.setDebug, [[false]]);
    const share = await page.evaluate(() => G.sdk.share({ text: 'Go', params: { seed: 's9' } }));
    assert.equal(share.url, 'https://poki.com/g/x?gdseed=s9');
    assert.equal(await page.evaluate(() => G.sdk.getParam('seed')), '7');
    assert.equal(await page.evaluate(() => G.sdk.getParam('zzz')), null);
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* (d) Telegram                                                         */
/* ------------------------------------------------------------------ */

describe('provider telegram', () => {
  const startParam = 'seed-42_ref-abc';

  test('auto-detects from initData, boots WebApp, decodes start_param, haptics, safe area', async () => {
    const { page, external } = await openPage({ mock: 'telegram', mockOpts: { startParam } });
    const r = await init(page);
    assert.equal(r.provider, 'telegram');
    assert.equal(r.caps.share, true);
    assert.equal(r.caps.haptics, true);
    assert.equal(r.caps.cloudSave, true);
    assert.equal(r.caps.iap, false); // no createInvoice hook
    assert.equal(r.caps.rewarded, false);
    deepEq(r.user, { id: '7', name: 'Ada L', avatar: 'https://img/a.png', lang: 'tr', premium: true });
    deepEq(external, []);
    deepEq((await harness(page)).scripts, []); // WebApp already present

    assert.equal(await page.evaluate(() => G.sdk.getParam('seed')), '42');
    assert.equal(await page.evaluate(() => G.sdk.getParam('ref')), 'abc');
    assert.equal(await page.evaluate(() => G.sdk.getParam('nope')), null);

    const h1 = await page.evaluate(() => [G.sdk.haptic('light'), G.sdk.haptic('heavy'), G.sdk.haptic('success'), G.sdk.haptic('selection')]);
    deepEq(h1, [true, true, true, true]);
    const h = await harness(page);
    deepEq(h.calls.impactOccurred, [['light'], ['heavy']]);
    deepEq(h.calls.notificationOccurred, [['success']]);
    assert.equal(h.calls.selectionChanged.length, 1);
    assert.equal(h.calls.ready.length, 1);
    assert.equal(h.calls.expand.length, 1);
    assert.equal(h.calls.requestFullscreen.length, 1);        // ios + v8.0
    assert.equal(h.calls.disableVerticalSwipes.length, 1);    // ≥7.7
    deepEq(h.calls.setHeaderColor, [['#101010']]);
    assert.equal(await page.evaluate(() => G.sdk.isMobile), true);

    deepEq(await page.evaluate(() => G.sdk.safeArea), { top: 67, right: 0, bottom: 34, left: 0 });
    const vars = await page.evaluate(() => {
      const s = document.documentElement.style;
      return ['top', 'right', 'bottom', 'left'].map((k) => s.getPropertyValue('--safe-' + k).trim());
    });
    deepEq(vars, ['67px', '0px', '34px', '0px']);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'unsupported' });
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'unavailable' });
    assert.equal(await page.evaluate(() => G.sdk.tg === window.Telegram.WebApp), true);
    await page.close();
  });

  test('desktop platform skips requestFullscreen; old versions skip swipes/cloud', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam, platform: 'tdesktop', version: '6.0' } });
    const r = await init(page);
    const h = await harness(page);
    assert.equal(h.calls.requestFullscreen, undefined);
    assert.equal(h.calls.disableVerticalSwipes, undefined);
    assert.equal(r.caps.cloudSave, false);
    assert.equal(await page.evaluate(() => G.storage.mirrors.length), 0);
    await page.close();
  });

  test('purchase via createInvoice → openInvoice → paid', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam, invoiceStatus: 'paid' } });
    const r = await init(page, { withInvoice: true });
    assert.equal(r.caps.iap, true);
    deepEq(await page.evaluate(() => G.sdk.purchase('skin_gold', { title: 'Gold skin', stars: 50 })), { ok: true, status: 'paid' });
    const h = await harness(page);
    assert.equal(await page.evaluate(() => window.__t.invoiceItem), 'skin_gold');
    assert.equal(h.calls.openInvoice[0][0], 'https://t.me/$invoice/abc');
    await page.close();
  });

  test('purchase cancelled → ok:false; without createInvoice → unsupported', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam, invoiceStatus: 'cancelled' } });
    await init(page, { withInvoice: true });
    deepEq(await page.evaluate(() => G.sdk.purchase('x')), { ok: false, status: 'cancelled' });
    await page.close();

    const second = await openPage({ mock: 'telegram', mockOpts: { startParam } });
    await init(second.page);
    deepEq(await second.page.evaluate(() => G.sdk.purchase('x')), { ok: false, status: 'unsupported' });
    await second.page.close();
  });

  test('share opens the Telegram share dialog with an encoded startapp param', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam } });
    await init(page, { tgAppUrl: 'https://t.me/mybot/game' });
    const share = await page.evaluate(() => G.sdk.share({ text: 'Beat 120!', params: { seed: 'x-1', ref: 'u 2' } }));
    assert.equal(share.ok, true);
    assert.equal(share.method, 'telegram');
    assert.equal(share.url, 'https://t.me/mybot/game?startapp=seed-x-1_ref-u2');
    const h = await harness(page);
    const opened = new URL(h.calls.openTelegramLink[0][0]);
    assert.equal(opened.origin + opened.pathname, 'https://t.me/share/url');
    assert.equal(opened.searchParams.get('url'), 'https://t.me/mybot/game?startapp=seed-x-1_ref-u2');
    assert.equal(opened.searchParams.get('text'), 'Beat 120!');
    await page.close();
  });

  test('CloudStorage mirror sanitises keys and round-trips values', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam } });
    await init(page);
    const r = await page.evaluate(async () => {
      const m = G.storage.mirrors[0];
      await m.set('daily.2026-10-05', '{"v":3,"_ts":5}');
      const got = await m.get('daily.2026-10-05');
      const missing = await m.get('missing');
      const keys = window.Telegram.WebApp.CloudStorage._keys();
      await m.remove('daily.2026-10-05');
      return { name: m.name, maxLength: m.maxLength, got, missing, keys, after: window.Telegram.WebApp.CloudStorage._keys() };
    });
    assert.equal(r.name, 'telegram-cloud');
    assert.equal(r.maxLength, 4096);
    assert.equal(r.got, '{"v":3,"_ts":5}');
    assert.equal(r.missing, null);
    deepEq(r.keys, ['g1_daily_2026-10-05']);
    deepEq(r.after, []);
    await page.close();
  });

  test('forced ?sdk=telegram without WebApp loads the script then degrades on failure', async () => {
    const { page } = await openPage({ query: '?sdk=telegram', scriptMode: 'reject' });
    const r = await init(page);
    assert.equal(r.provider, 'telegram');
    assert.equal(r.ready, true);
    deepEq((await harness(page)).scripts, ['https://telegram.org/js/telegram-web-app.js']);
    deepEq(await page.evaluate(() => G.sdk.purchase('x')), { ok: false, status: 'unsupported' });
    assert.equal((await page.evaluate(() => G.sdk.share({ text: 'hi', params: { seed: '1' } }))).method, 'clipboard');
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* GameDistribution                                                     */
/* ------------------------------------------------------------------ */

describe('provider gd', () => {
  test('placeholder gameId → script not loaded, caps off', async () => {
    const { page } = await openPage({ query: '?sdk=gd' });
    const r = await init(page);
    assert.equal(r.provider, 'gd');
    assert.equal(r.caps.interstitial, false);
    deepEq((await harness(page)).scripts, []);
    assert.equal(await page.evaluate(() => window.GD_OPTIONS), undefined);
    await page.close();
  });

  test('gdid set → GD_OPTIONS prepared, script loaded, events routed, ads work', async () => {
    const { page } = await openPage({ query: '?sdk=gd&gdid=0123456789abcdef0123456789abcdef', clock: true });
    await page.evaluate(() => {
      // The seam stands in for the script: install the gdsdk mock on "load".
      const inner = G.sdk._test.loadScript;
      G.sdk._test.loadScript = (url) => {
        const t = window.__t;
        window.gdsdk = {
          showAd: t.spy('showAd', (type) => new Promise((resolve) => {
            window.GD_OPTIONS.onEvent({ name: 'SDK_GAME_PAUSE' });
            setTimeout(() => {
              if (type === 'rewarded') window.GD_OPTIONS.onEvent({ name: 'SDK_REWARDED_WATCH_COMPLETE' });
              window.GD_OPTIONS.onEvent({ name: 'SDK_GAME_START' });
              resolve();
            }, 10);
          })),
          preloadAd: t.spy('preloadAd', () => Promise.resolve()),
        };
        return inner(url);
      };
    });
    const r = await init(page);
    assert.equal(r.caps.interstitial, true);
    assert.equal(r.caps.rewarded, true);
    assert.equal(await page.evaluate(() => window.GD_OPTIONS.gameId), '0123456789abcdef0123456789abcdef');
    deepEq((await harness(page)).scripts, ['https://html5.api.gamedistribution.com/main.min.js']);

    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: true });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    await clearEvents(page);
    await setClock(page, 500000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: true });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);

    // SDK-driven pause outside an ad reaches onPause/onResume and the hooks.
    await clearEvents(page);
    const log = await page.evaluate(() => {
      const out = [];
      G.sdk.onPause((r) => out.push('pause:' + r));
      G.sdk.onResume((r) => out.push('resume:' + r));
      window.GD_OPTIONS.onEvent({ name: 'SDK_GAME_PAUSE' });
      window.GD_OPTIONS.onEvent({ name: 'SDK_GAME_START' });
      return out;
    });
    deepEq(log, ['pause:ad', 'resume:ad']);
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* (e) Interstitial pacing with an injected clock                       */
/* ------------------------------------------------------------------ */

describe('interstitial pacing', () => {
  test('warmup, min interval, busy and timeout are enforced', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', clock: true });
    await init(page, { interstitialWarmup: 90000, interstitialMinInterval: 150000 });
    const show = () => page.evaluate(() => G.sdk.showInterstitial({ placement: 'gameover' }));

    deepEq(await show(), { shown: false, reason: 'warmup' });
    await setClock(page, 89999);
    deepEq(await show(), { shown: false, reason: 'warmup' });
    await setClock(page, 90000);
    deepEq(await show(), { shown: true });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);

    await setClock(page, 90000 + 149999);
    deepEq(await show(), { shown: false, reason: 'interval' });
    await setClock(page, 90000 + 150000);
    deepEq(await show(), { shown: true });
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 2, rewardedShown: 0, rewardedGranted: 0 });

    // A rewarded ad counts as an ad break for pacing purposes.
    await setClock(page, 90000 + 150000 + 10000);
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: true });
    await setClock(page, 90000 + 150000 + 10000 + 149000);
    deepEq(await show(), { shown: false, reason: 'interval' });
    await setClock(page, 90000 + 150000 + 10000 + 150000);

    // Concurrency: second call while the first runs → busy.
    const both = await page.evaluate(() => Promise.all([G.sdk.showInterstitial(), G.sdk.showInterstitial()]));
    deepEq(both, [{ shown: true }, { shown: false, reason: 'busy' }]);
    assert.equal(await page.evaluate(() => G.sdk._test.state().adRunning), false);
    await page.close();
  });

  test('interstitial timeout resolves {shown:false, reason:"timeout"} and releases hooks', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', mockOpts: { adMode: 'startOnly' }, clock: true });
    await init(page, { interstitialWarmup: 0 });
    await page.evaluate(() => { G.sdk._test.timeouts.interstitial = 150; });
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'timeout' });
    deepEq(await hookEvents(page), ['pause', 'mute', 'resume', 'unmute']);
    assert.equal(await page.evaluate(() => G.sdk._test.state().adRunning), false);
    await page.close();
  });

  test('config defaults: 90s warmup and 150s interval', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', clock: true });
    await init(page);
    await setClock(page, 89000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'warmup' });
    await setClock(page, 90000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: true });
    await setClock(page, 90000 + 149000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'interval' });
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* Misc                                                                 */
/* ------------------------------------------------------------------ */

describe('misc', () => {
  test('init is idempotent and _test.setProvider allows re-init', async () => {
    const { page } = await openPage({ mock: 'crazygames' });
    await init(page);
    const r = await page.evaluate(async () => {
      const p1 = G.sdk.init();
      const p2 = G.sdk.init();
      await p1;
      const same = p1 === p2;
      G.sdk._test.setProvider('none');
      await G.sdk.init({});
      return { same, provider: G.sdk.provider, initCalls: window.__t.calls.init.length };
    });
    assert.equal(r.same, true);
    assert.equal(r.provider, 'none');
    assert.equal(r.initCalls, 1);
    await page.close();
  });

  test('unknown ?sdk= value falls through to detection', async () => {
    const { page } = await openPage({ query: '?sdk=bogus' });
    const r = await init(page);
    assert.equal(r.provider, 'none');
    await page.close();
  });

  test('tgWebAppPlatform in the hash selects telegram and loads its script', async () => {
    const { page } = await openPage({ query: '#tgWebAppPlatform=ios&tgWebAppStartParam=seed-5', scriptMode: 'reject' });
    const r = await init(page);
    assert.equal(r.provider, 'telegram');
    deepEq((await harness(page)).scripts, ['https://telegram.org/js/telegram-web-app.js']);
    assert.equal(await page.evaluate(() => G.sdk.getParam('seed')), '5');
    await page.close();
  });

  test('hooks that throw never break the ad flow', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await page.evaluate(() => G.sdk.init({ hooks: { pause() { throw new Error('boom'); }, resume() { throw new Error('boom'); } } }));
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: true });
    await page.close();
  });
});

/* ------------------------------------------------------------------ */
/* Hardening: adversarial scenarios                                     */
/* ------------------------------------------------------------------ */

describe('hardening', () => {
  test('a vendor adStarted arriving after our timeout is ignored (game never stays paused)', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await init(page);
    const r = await page.evaluate(async () => {
      // The mock starts the ad 300ms after the request; our timeout fires at 100ms.
      window.CrazyGames.SDK.ad.requestAd = (type, cb) => {
        setTimeout(() => cb.adStarted(), 300);
        setTimeout(() => cb.adFinished(), 400);
      };
      G.sdk._test.timeouts.rewarded = 100;
      const result = await G.sdk.showRewarded();
      await new Promise((res) => setTimeout(res, 500));
      return { result, state: G.sdk._test.state() };
    });
    deepEq(r.result, { rewarded: false, reason: 'timeout' });
    assert.equal(r.state.hooksEngaged, false);
    assert.equal(r.state.adRunning, false);
    deepEq(r.state.pauseReasons, []);
    deepEq(await hookEvents(page), []);
    await page.close();
  });

  test('every public method is safe before init()', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', debug: true });
    const r = await page.evaluate(async () => {
      const out = {};
      const calls = {
        interstitial: () => G.sdk.showInterstitial(),
        share: () => G.sdk.share({ text: 'x', params: { seed: '1' } }),
        haptic: () => G.sdk.haptic('light'),
        unknownHaptic: () => G.sdk.haptic('nope'),
        getParam: () => G.sdk.getParam('seed'),
        telemetry: () => { G.sdk.loadingStart(); G.sdk.loadingStop(); G.sdk.gameplayStart(); G.sdk.gameplayStop(); G.sdk.happyTime(); return 'ok'; },
        purchase: () => G.sdk.purchase('x'),
        banner: () => G.sdk.banner.show('a'),
        canShowRewarded: () => G.sdk.canShowRewarded(),
        isMobile: () => typeof G.sdk.isMobile,
        unsubscribe: () => { G.sdk.onPause('not a function')(); G.sdk.onResume(() => {})(); return 'ok'; },
      };
      for (const [name, fn] of Object.entries(calls)) {
        try { out[name] = await fn(); } catch (e) { out[name] = 'THREW: ' + e.message; }
      }
      return out;
    });
    deepEq(r.interstitial, { shown: false, reason: 'unsupported' });
    assert.equal(r.share.method, 'clipboard');
    assert.equal(r.unknownHaptic, false);
    assert.equal(r.getParam, null);
    assert.equal(r.telemetry, 'ok');
    deepEq(r.purchase, { ok: false, status: 'unsupported' });
    assert.equal(r.banner, false);
    assert.equal(r.canShowRewarded, true); // provider 'none' + DEBUG before init
    assert.equal(r.isMobile, 'boolean');
    assert.equal(r.unsubscribe, 'ok');
    await page.close();
  });

  test('a rewarded ad that never showed (adError) does not block the next interstitial', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames', mockOpts: { adMode: 'error' }, clock: true });
    await init(page, { interstitialWarmup: 0 });
    deepEq(await page.evaluate(() => G.sdk.showRewarded()), { rewarded: false, reason: 'error' });
    assert.equal(await page.evaluate(() => G.sdk._test.state().lastAdAt), null);
    await page.evaluate(() => {
      window.CrazyGames.SDK.ad.requestAd = (type, cb) => { setTimeout(() => cb.adStarted(), 2); setTimeout(() => cb.adFinished(), 5); };
    });
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: true });
    deepEq(await page.evaluate(() => G.sdk.stats), { interstitialsShown: 1, rewardedShown: 0, rewardedGranted: 0 });
    await page.close();
  });

  test('Poki: gameLoadingFinished is sent once even without loadingStart, and before gameplayStart', async () => {
    const { page } = await openPage({ query: '?sdk=poki', mock: 'poki', mockOpts: { rewardedResult: true } });
    await init(page);
    await page.evaluate(() => { G.sdk.gameplayStart(); G.sdk.gameplayStop(); G.sdk.loadingStop(); G.sdk.loadingStop(); });
    const h = await harness(page);
    assert.equal(h.calls.gameLoadingFinished.length, 1);
    deepEq(h.events.filter((e) => e !== 'init' && e !== 'setDebug'), ['gameLoadingFinished', 'gameplayStart', 'gameplayStop']);
    await page.close();
  });

  test('?sdk= forcing is case-insensitive; invalid pacing numbers fall back to defaults', async () => {
    const { page } = await openPage({ query: '?sdk=CrazyGames', mock: 'crazygames', clock: true });
    const r = await init(page, { interstitialWarmup: -5, interstitialMinInterval: NaN });
    assert.equal(r.provider, 'crazygames');
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'warmup' });
    await setClock(page, 90000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: true });
    await setClock(page, 90000 + 149000);
    deepEq(await page.evaluate(() => G.sdk.showInterstitial()), { shown: false, reason: 'interval' });
    await page.close();
  });

  test('Telegram < 6.9 gets the bg_color keyword instead of a hex header colour', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam: 'seed-1', version: '6.1' } });
    await init(page);
    const h = await harness(page);
    deepEq(h.calls.setHeaderColor, [['bg_color']]);
    deepEq(h.calls.setBackgroundColor, [['#101010']]);
    await page.close();
  });

  test('Telegram share truncates oversized startapp payloads to 512 chars', async () => {
    const { page } = await openPage({ mock: 'telegram', mockOpts: { startParam: 'seed-1' } });
    await init(page, { tgAppUrl: 'https://t.me/mybot/game' });
    const share = await page.evaluate(() => G.sdk.share({ text: 'x', params: { seed: 'a'.repeat(600) } }));
    assert.equal(new URL(share.url).searchParams.get('startapp').length, 512);
    await page.close();
  });

  test('survives a throwing G.storage and a missing G.storage', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await page.evaluate(() => { G.storage.get = () => { throw new Error('quota'); }; G.storage.attachMirror = () => { throw new Error('nope'); }; });
    const r = await init(page);
    assert.equal(r.ready, true);
    assert.equal(await page.evaluate(() => G.sdk.hapticsEnabled), true);
    await page.close();

    const second = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await second.page.evaluate(() => { delete G.storage; });
    const r2 = await init(second.page);
    assert.equal(r2.ready, true);
    assert.equal(r2.caps.cloudSave, true);
    assert.equal(await second.page.evaluate(() => G.sdk.hapticsEnabled), true);
    await second.page.close();
  });

  test('init without hooks still pairs ad breaks; rapid repeated calls stay consistent', async () => {
    const { page } = await openPage({ query: '?sdk=crazygames', mock: 'crazygames' });
    await page.evaluate(() => G.sdk.init());
    const r = await page.evaluate(async () => {
      const results = await Promise.all([G.sdk.showRewarded(), G.sdk.showRewarded(), G.sdk.showRewarded()]);
      const after = await G.sdk.showRewarded();
      return { results, after, state: G.sdk._test.state(), stats: G.sdk.stats };
    });
    deepEq(r.results, [{ rewarded: true }, { rewarded: false, reason: 'busy' }, { rewarded: false, reason: 'busy' }]);
    deepEq(r.after, { rewarded: true });
    assert.equal(r.state.adRunning, false);
    assert.equal(r.state.hooksEngaged, false);
    deepEq(r.stats, { interstitialsShown: 0, rewardedShown: 2, rewardedGranted: 2 });
    await page.close();
  });

  test('loads from file:// with no page errors and no console output when DEBUG is off', async () => {
    // A real shell next to the module, loaded via a classic <script src> like game/index.html will.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-file-'));
    const shell = path.join(dir, 'index.html');
    fs.writeFileSync(shell, `<!doctype html><html><head><meta charset="utf-8"><title>file test</title></head><body><script src="file://${SDK_PATH}"></script></body></html>`);
    const page = await browser.newPage();
    const noise = [];
    page.on('pageerror', (e) => noise.push('pageerror: ' + e.message));
    page.on('console', (m) => noise.push(m.type() + ': ' + m.text()));
    try {
      await page.goto('file://' + shell);
      const r = await page.evaluate(async () => {
        await G.sdk.init({ hooks: {} });
        await G.sdk.showRewarded();
        await G.sdk.share({ text: 'x' });
        return { provider: G.sdk.provider, ready: G.sdk.ready, debug: G.DEBUG, standalone: G.sdk.isStandalone, protocol: location.protocol };
      });
      deepEq(r, { provider: 'none', ready: true, debug: false, standalone: true, protocol: 'file:' });
      deepEq(noise, []);
    } finally {
      await page.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no global leaks beyond window.G (and GD_OPTIONS only for the gd provider)', async () => {
    const { page } = await openPage();
    const before = await page.evaluate(() => Object.keys(window));
    await init(page);
    const added = await page.evaluate((before) => Object.keys(window).filter((k) => !before.includes(k)), before);
    deepEq(added, []);
    await page.close();
  });
});
