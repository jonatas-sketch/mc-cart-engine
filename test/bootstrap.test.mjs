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
