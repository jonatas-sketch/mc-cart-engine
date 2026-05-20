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
    var snap = readSnapshot();
    if (!snap) {
      try { console.warn('[MC Cart] Railway unavailable + no local snapshot. Reason:', reason); } catch (e) {}
      sendBeacon(reason, 'no_snapshot', null);
      return;
    }
    window.mcCartConfig = snap.cfg;
    window.__mcStoreId  = STORE_ID;
    window.__mcTrackUrl = APP_ORIGIN + '/api/track';
    window.__mcCartFallbackMode = {
      reason: reason,
      since: Date.now(),
      snapshotAt: snap.savedAt,
      source: 'localstorage',
    };
    try { console.warn('[MC Cart] running in fallback mode', window.__mcCartFallbackMode); } catch (e) {}

    var engineFile = snap.engineFile || deriveEngineFile(snap.cfg);
    var s = document.createElement('script');
    s.src = CDN_ENGINE_BASE + '/' + engineFile;
    s.defer = true;
    document.head.appendChild(s);

    // Inter font (mirror loader behavior)
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(l);

    sendBeacon(reason, 'snapshot_hit', snap.savedAt);
  }

  function readSnapshot() {
    try {
      var raw = localStorage.getItem('mc_cart_snapshot_v1_' + STORE_ID);
      if (!raw) return null;
      var snap = JSON.parse(raw);
      if (!snap || snap.v !== 1 || !snap.cfg || !snap.savedAt) return null;
      if (Date.now() - snap.savedAt > SNAPSHOT_TTL_MS) return null;
      return snap;
    } catch (e) { return null; }
  }

  function sendBeacon(reason, outcome, snapshotAt) {
    try {
      var payload = JSON.stringify({
        storeId: STORE_ID,
        reason: reason,
        outcome: outcome,
        snapshotAt: snapshotAt,
        t: Date.now(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(BEACON_URL, payload);
      } else {
        fetch(BEACON_URL, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
      }
    } catch (e) {}
  }
})();
