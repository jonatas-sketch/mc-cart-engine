import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = path.resolve(__dirname, '..', '..', 'bootstrap', 'mc-bootstrap.js');

export function readBootstrapSource() {
  return fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');
}

/**
 * Monta um DOM com um <script> que simula a injeção pelo Shopify ScriptTag.
 * @param {Object} opts
 * @param {string} [opts.dataStoreId] — valor de data-store-id, se houver
 * @param {string} [opts.srcFragment] — ex: 'https://cdn.../mc-bootstrap.js#store=abc-uuid'
 * @param {Record<string, string>} [opts.localStorageSeed] — chaves a popular antes do boot
 * @param {Function} [opts.fetchImpl] — substitui window.fetch
 * @param {Function} [opts.sendBeaconImpl] — substitui navigator.sendBeacon
 */
export function buildDom({ dataStoreId, srcFragment, localStorageSeed = {}, fetchImpl, sendBeaconImpl } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://acmestore.example/products/widget',
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // Seed localStorage
  for (const [k, v] of Object.entries(localStorageSeed)) window.localStorage.setItem(k, v);

  // Stub fetch
  window.fetch = fetchImpl || (() => Promise.reject(new Error('fetch not stubbed')));

  // Stub sendBeacon
  if (sendBeaconImpl) window.navigator.sendBeacon = sendBeaconImpl;

  // Insert the bootstrap <script> tag with attributes
  const script = window.document.createElement('script');
  if (dataStoreId) script.setAttribute('data-store-id', dataStoreId);
  script.setAttribute('src', srcFragment || 'https://cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@v1.0.0/bootstrap/mc-bootstrap.js');
  window.document.head.appendChild(script);

  // jsdom does not set document.currentScript for scripts whose .text we eval — we'll patch via Object.defineProperty inside runBootstrap.
  return { dom, window, script };
}

export function runBootstrap(window, script) {
  // Make document.currentScript point at our script during eval
  Object.defineProperty(window.document, 'currentScript', {
    configurable: true,
    get: () => script,
  });
  const src = readBootstrapSource();
  window.eval(src);
}

/** Wait for microtasks/timers to settle. */
export function flush(window, ms = 0) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
