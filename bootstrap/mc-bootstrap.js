/* mc-bootstrap.js v1.0.0 — MC Cart CDN bootstrap (Fase 1)
 * Reads data-store-id or src fragment, tries Railway, falls back to localStorage snapshot.
 * Served via cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@v1.0.0/bootstrap/mc-bootstrap.js
 */
(function () {
  'use strict';

  var APP_ORIGIN      = 'https://www.mcsync.app';
  var CDN_ENGINE_BASE = 'https://cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@v1.0.0/engines';
  var BEACON_URL      = APP_ORIGIN + '/api/cart-fallback-beacon';
  var TIMEOUT_MS      = 3000;
  var SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function findStoreId() {
    var cur = document.currentScript;
    if (!cur) {
      var nodes = document.querySelectorAll('script[src*="mc-bootstrap"]');
      cur = nodes[nodes.length - 1];
    }
    if (!cur) return null;
    var ds = cur.getAttribute('data-store-id');
    if (ds) return ds;
    var src = cur.src || '';
    var m = src.match(/[#?&]store=([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  var STORE_ID = findStoreId();
  if (!STORE_ID) return;

  var aborted = false;
  var ctrl    = new AbortController();
  var tid     = setTimeout(function () {
    aborted = true; ctrl.abort();
    proceedWithFallback('timeout');
  }, TIMEOUT_MS);

  fetch(APP_ORIGIN + '/api/storefront/' + STORE_ID + '/loader.js', {
    signal: ctrl.signal,
    credentials: 'include',
  })
    .then(function (r) {
      if (!r.ok) throw new Error('railway_' + r.status);
      return r.text();
    })
    .then(function (jsText) {
      clearTimeout(tid);
      if (aborted) return;
      // Append a marker <script> element for observability (visible in DevTools,
      // shows up in querySelectorAll('script')). Use a non-executing type so it
      // does NOT run a second time in real browsers — we execute the loader
      // text via eval, which works in both real browsers and jsdom outside-only.
      var s = document.createElement('script');
      s.type = 'application/javascript-loaded';
      s.text = jsText;
      s.setAttribute('data-mc-loader', '1');
      document.head.appendChild(s);
      try { (0, eval)(jsText); } catch (e) {}
      setTimeout(persistSnapshot, 500);
    })
    .catch(function (err) {
      clearTimeout(tid);
      if (aborted) return;
      proceedWithFallback((err && err.message) || 'fetch_error');
    });

  function persistSnapshot() {
    try {
      if (!window.mcCartConfig) return;
      var snap = {
        v: 1,
        savedAt: Date.now(),
        cfg: window.mcCartConfig,
        engineFile: deriveEngineFile(window.mcCartConfig),
      };
      localStorage.setItem('mc_cart_snapshot_v1_' + STORE_ID, JSON.stringify(snap));
    } catch (e) {}
  }

  function deriveEngineFile(cfg) {
    var mode = cfg && cfg.cart_mode;
    if (mode === 'cart-page' || mode === 'theme-drawer') return 'mc-cart-page.js';
    if (mode === 'skip-checkout')                          return 'mc-cart-skip.js';
    if (mode === 'native')                                 return 'mc-cart-native.js';
    return 'mc-cart.js';
  }

  function proceedWithFallback(reason) {
    // Stub here; filled in Task 2.7.
  }
})();
