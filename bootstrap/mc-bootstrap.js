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

  // Kick off Railway fetch — fallback path will be wired in next steps.
  try {
    fetch(APP_ORIGIN + '/api/storefront/' + STORE_ID + '/loader.js', { credentials: 'include' });
  } catch (e) { /* swallow for now */ }
})();
