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
