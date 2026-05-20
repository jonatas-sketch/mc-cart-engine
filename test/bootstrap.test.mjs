import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDom, runBootstrap, flush } from './helpers/dom-fixture.mjs';

const UUID_A = '11111111-2222-3333-4444-555555555555';

test('bootstrap: lê storeId de data-store-id', async () => {
  const fetchCalls = [];
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    fetchImpl: (url) => { fetchCalls.push(url); return new Promise(() => {}); /* never resolves */ },
  });
  runBootstrap(window, script);
  await flush(window, 10);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], new RegExp(`/api/storefront/${UUID_A}/loader\\.js$`));
});

test('bootstrap: lê storeId de fragment #store=uuid quando data-store-id ausente', async () => {
  const fetchCalls = [];
  const { window, script } = buildDom({
    srcFragment: `https://cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@v1.0.0/bootstrap/mc-bootstrap.js#store=${UUID_A}`,
    fetchImpl: (url) => { fetchCalls.push(url); return new Promise(() => {}); },
  });
  runBootstrap(window, script);
  await flush(window, 10);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], new RegExp(`/api/storefront/${UUID_A}/loader\\.js$`));
});

test('bootstrap: aborta silenciosamente quando não encontra storeId', async () => {
  let fetchCalled = false;
  const { window, script } = buildDom({
    srcFragment: 'https://cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@v1.0.0/bootstrap/mc-bootstrap.js',
    fetchImpl: () => { fetchCalled = true; return Promise.resolve({ ok: true, text: () => '' }); },
  });
  runBootstrap(window, script);
  await flush(window, 10);
  assert.equal(fetchCalled, false);
});

test('bootstrap: Railway 200 → injeta loader.js inline no <head>', async () => {
  const loaderJs = 'window.__loaderRan = true; window.mcCartConfig = { cart_mode: "drawer" };';
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    fetchImpl: () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(loaderJs),
    }),
  });
  runBootstrap(window, script);
  await flush(window, 50);

  // Verify a new <script> with the loader's text was appended.
  const scripts = window.document.head.querySelectorAll('script');
  // First script is the bootstrap entry; second should be the injected loader.
  assert.equal(scripts.length, 2);
  // Sanity: loaderJs side effect should have run via eval
  assert.equal(window.__loaderRan, true);
  // Per-key checks (jsdom objects fail strict deepEqual across realms vs Node literal)
  assert.equal(window.mcCartConfig.cart_mode, 'drawer');
});

test('bootstrap: Railway 200 → persiste snapshot em localStorage após 500ms', async () => {
  const loaderJs = 'window.mcCartConfig = { cart_mode: "cart-page", domain: "loja-b.myshopify.com", token: "abc" };';
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(loaderJs) }),
  });
  runBootstrap(window, script);
  await flush(window, 700);

  const raw = window.localStorage.getItem('mc_cart_snapshot_v1_' + UUID_A);
  assert.ok(raw, 'localStorage key should be set');
  const snap = JSON.parse(raw);
  assert.equal(snap.v, 1);
  assert.equal(snap.cfg.cart_mode, 'cart-page');
  assert.equal(snap.engineFile, 'mc-cart-page.js');
  assert.ok(snap.savedAt > 0);
});

test('bootstrap: Railway 500 + snapshot LS válido → hidrata mcCartConfig + injeta engine do CDN', async () => {
  const seedSnap = {
    v: 1,
    savedAt: Date.now() - 60_000, // 1 min ago
    cfg: { cart_mode: 'drawer', domain: 'b.myshopify.com', token: 't' },
    engineFile: 'mc-cart.js',
  };
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    localStorageSeed: { ['mc_cart_snapshot_v1_' + UUID_A]: JSON.stringify(seedSnap) },
    fetchImpl: () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') }),
  });
  runBootstrap(window, script);
  await flush(window, 50);

  assert.equal(window.mcCartConfig.cart_mode, 'drawer');
  assert.equal(window.__mcStoreId, UUID_A);
  assert.ok(window.__mcCartFallbackMode);
  assert.equal(window.__mcCartFallbackMode.source, 'localstorage');
  assert.equal(window.__mcCartFallbackMode.reason, 'railway_503');

  const scripts = window.document.head.querySelectorAll('script');
  const engineScript = Array.from(scripts).find((s) => s.src && s.src.includes('/engines/mc-cart.js'));
  assert.ok(engineScript, 'engine script tag should be appended');
  assert.match(engineScript.src, /cdn\.jsdelivr\.net.*mc-cart-engine@v1\.0\.0/);
});

test('bootstrap: snapshot expirado (>7d) é tratado como ausente', async () => {
  const seedSnap = {
    v: 1,
    savedAt: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
    cfg: { cart_mode: 'drawer' },
    engineFile: 'mc-cart.js',
  };
  let beaconCalled = false;
  let beaconBody = null;
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    localStorageSeed: { ['mc_cart_snapshot_v1_' + UUID_A]: JSON.stringify(seedSnap) },
    fetchImpl: () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') }),
    sendBeaconImpl: (url, body) => { beaconCalled = true; beaconBody = body; return true; },
  });
  runBootstrap(window, script);
  await flush(window, 50);

  assert.equal(window.mcCartConfig, undefined);
  assert.equal(beaconCalled, true);
  const payload = JSON.parse(beaconBody);
  assert.equal(payload.outcome, 'no_snapshot');
  assert.equal(payload.storeId, UUID_A);
});

test('bootstrap: snapshot hit dispara beacon com outcome=snapshot_hit', async () => {
  const seedSnap = {
    v: 1,
    savedAt: Date.now() - 60_000,
    cfg: { cart_mode: 'native' },
    engineFile: 'mc-cart-native.js',
  };
  let beaconBody = null;
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    localStorageSeed: { ['mc_cart_snapshot_v1_' + UUID_A]: JSON.stringify(seedSnap) },
    fetchImpl: () => Promise.reject(new Error('network down')),
    sendBeaconImpl: (url, body) => { beaconBody = body; return true; },
  });
  runBootstrap(window, script);
  await flush(window, 50);

  assert.ok(beaconBody);
  const payload = JSON.parse(beaconBody);
  assert.equal(payload.outcome, 'snapshot_hit');
  assert.equal(payload.reason, 'network down');
  assert.equal(payload.snapshotAt, seedSnap.savedAt);
});

test('bootstrap: timeout 3s força fallback', async () => {
  // Fetch never resolves
  let beaconBody = null;
  const seedSnap = {
    v: 1, savedAt: Date.now() - 60_000,
    cfg: { cart_mode: 'drawer' }, engineFile: 'mc-cart.js',
  };
  const { window, script } = buildDom({
    dataStoreId: UUID_A,
    localStorageSeed: { ['mc_cart_snapshot_v1_' + UUID_A]: JSON.stringify(seedSnap) },
    fetchImpl: () => new Promise(() => {}),
    sendBeaconImpl: (url, body) => { beaconBody = body; return true; },
  });
  runBootstrap(window, script);
  // Advance jsdom timers to 3.5s
  await flush(window, 3500);

  assert.ok(beaconBody);
  const payload = JSON.parse(beaconBody);
  assert.equal(payload.reason, 'timeout');
  assert.equal(payload.outcome, 'snapshot_hit');
});

test('bootstrap: ?mc_force_fallback=1 pula Railway e vai direto pro fallback', async () => {
  const seedSnap = {
    v: 1, savedAt: Date.now() - 60_000,
    cfg: { cart_mode: 'drawer' }, engineFile: 'mc-cart.js',
  };
  let fetchCalled = false;
  // Override jsdom URL via dom options
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://acmestore.example/products/widget?mc_force_fallback=1',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.localStorage.setItem('mc_cart_snapshot_v1_' + UUID_A, JSON.stringify(seedSnap));
  window.fetch = () => { fetchCalled = true; return Promise.resolve({ ok: true, text: () => Promise.resolve('') }); };
  const script = window.document.createElement('script');
  script.setAttribute('data-store-id', UUID_A);
  window.document.head.appendChild(script);
  Object.defineProperty(window.document, 'currentScript', { configurable: true, get: () => script });
  const src = (await import('node:fs')).readFileSync(new URL('../bootstrap/mc-bootstrap.js', import.meta.url), 'utf-8');
  window.eval(src);
  await new Promise((r) => window.setTimeout(r, 30));

  assert.equal(fetchCalled, false, 'Railway should NOT be called when forced');
  assert.ok(window.__mcCartFallbackMode);
  assert.equal(window.__mcCartFallbackMode.reason, 'forced');
});
