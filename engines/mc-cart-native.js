/* ============================================================
   MC Cart Native Engine v1.0
   Observational micro-engine for single-store deployments.
   Adds pixel/CAPI tracking on top of the theme's native cart
   without rendering UI or hijacking navigation.

   Spec: docs/superpowers/specs/2026-05-15-native-mode-single-store.md
   ============================================================ */
(function(){
'use strict';

var C = window.mcCartConfig;
if (!C || C.cart_mode !== 'native') return;

/* ---- Cookie helpers (mirrors mc-cart.js patterns) ---- */
function getCookie(name){
  var m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : null;
}
function setCookie(name, value, days){
  var maxAge = (days || 365) * 24 * 3600;
  document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;max-age=' + maxAge + ';SameSite=Lax';
}
function uuid(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/* ---- First-party attribution cookies (Safari ITP survival) ---- */
function rewriteAttributionCookies(){
  try {
    var u = new URL(location.href);
    var fbclid = u.searchParams.get('fbclid');
    var gclid  = u.searchParams.get('gclid');
    if (fbclid) setCookie('_fbc', 'fb.1.' + Date.now() + '.' + fbclid, 90);
    if (gclid)  setCookie('_mc_gclid', gclid, 90);
    if (!getCookie('_mc_ext_id')) setCookie('_mc_ext_id', uuid(), 365);
  } catch (e) { /* best effort */ }
}

/* ---- PDP detection ---- */
function isPdp(){
  return /^\/products\//.test(location.pathname);
}

/* ---- Attribution capture into cart_attributes ----
 * Writes UTM params (from URL) + first-party cookies (_mc_ext_id, _fbc)
 * into Shopify cart attributes. Shopify carries cart_attributes into the
 * order's note_attributes, which the orders/create webhook reads via
 * buildPurchaseEvent (meta-capi.ts) to populate user_data.external_id
 * + user_data.fbc on the Purchase CAPI event. Without this, Meta CAPI
 * Event Match Quality drops because external_id is missing.
 *
 * Mirrors the drawer engine's behavior at mc-cart.js:2018-2026. Gated by
 * sessionStorage so we only POST once per session — repeat page views in
 * the same tab don't hammer /cart/update.js.
 */
function captureAttributionToCart(){
  try {
    if (sessionStorage.getItem('mc_native_attribution_written') === '1') return;

    var u = new URL(location.href);
    var attrs = {};

    var params = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
    for (var i = 0; i < params.length; i++) {
      var v = u.searchParams.get(params[i]);
      if (v) attrs[params[i]] = v;
    }
    var fbclid = u.searchParams.get('fbclid');
    var gclid  = u.searchParams.get('gclid');
    if (fbclid) attrs.fbclid = fbclid;
    if (gclid)  attrs.gclid  = gclid;

    /* First-party cookies — critical for Meta CAPI Event Match Quality.
       _mc_ext_id is always present (rewriteAttributionCookies generates
       one if missing). _fbc only exists if the customer clicked through
       a Meta ad (or the cookie was set by a previous fbclid visit). */
    var extId = getCookie('_mc_ext_id');
    var fbc = getCookie('_fbc');
    if (extId) attrs._mc_ext_id = extId;
    if (fbc) attrs._fbc = fbc;

    if (Object.keys(attrs).length === 0) return;

    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ attributes: attrs }),
      keepalive: true
    }).then(function(){
      try { sessionStorage.setItem('mc_native_attribution_written', '1'); } catch (e) {}
    }).catch(function(){});
  } catch (e) { /* swallow */ }
}

/* ---- Pixel + CAPI firing (mirrors mc-cart.js patterns) ---- */
function gaEventName(name){
  if (name === 'AddToCart')        return 'add_to_cart';
  if (name === 'InitiateCheckout') return 'begin_checkout';
  if (name === 'ViewContent')      return 'view_item';
  return name;
}

function trackEvent(eventName, payload){
  try {
    var cur = C.currencyCode || 'USD';
    var eventId = uuid();
    payload = payload || {};

    /* Browser pixels — synchronous queue, flushed by browser on unload */
    if (window.fbq) {
      var fbPayload = {
        currency: cur,
        content_ids: payload.content_ids || (payload.variantId ? [String(payload.variantId)] : undefined),
        content_type: payload.content_type || 'product',
        value: parseFloat(payload.value || 0),
        num_items: payload.quantity || payload.num_items
      };
      window.fbq('track', eventName, fbPayload, { eventID: eventId });
    }
    if (window.gtag) {
      var gaPayload = {
        currency: cur,
        value: parseFloat(payload.value || 0)
      };
      if (payload.variantId) {
        gaPayload.items = [{ item_id: String(payload.variantId), quantity: payload.quantity || 1 }];
      }
      window.gtag('event', gaEventName(eventName), gaPayload);
    }
    if (window.ttq && window.ttq.track) {
      window.ttq.track(eventName, {
        content_id: payload.variantId ? String(payload.variantId) : undefined,
        currency: cur,
        value: parseFloat(payload.value || 0)
      });
    }
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({
        event: gaEventName(eventName),
        ecommerce: { currency: cur, value: parseFloat(payload.value || 0) }
      });
    }

    /* CAPI server-side — async, keepalive survives page unload */
    if (C.capiToken || C.pxMeta) {
      var capiUrl = C._capiEndpoint;
      if (!capiUrl && C.storeId) {
        capiUrl = '/api/capi/' + C.storeId;
      }
      if (capiUrl) {
        fetch(capiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_name: eventName,
            event_id: eventId,
            external_id: getCookie('_mc_ext_id'),
            fbc: getCookie('_fbc'),
            fbp: getCookie('_fbp'),
            payload: payload,
            page_url: location.href
          }),
          keepalive: true
        }).catch(function(){});
      }
    }
  } catch (e) {
    console.warn('[MC Native] trackEvent error', e);
  }
}

/* ---- Product ID detection on PDP (4-tier chain) ---- */
function readProductIdFromPDP(){
  /* Tier 1: ShopifyAnalytics meta (modern themes) */
  try {
    var sa = window.ShopifyAnalytics;
    if (sa && sa.meta && sa.meta.product && sa.meta.product.id) {
      return String(sa.meta.product.id);
    }
  } catch (e) {}

  /* Tier 2: JSON-LD Product schema */
  try {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var parsed = JSON.parse(scripts[i].textContent || '{}');
      var nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n && (n['@type'] === 'Product' || (Array.isArray(n['@type']) && n['@type'].indexOf('Product') >= 0))) {
          if (n.productID) return String(n.productID);
          if (n.sku)       return String(n.sku);
        }
      }
    }
  } catch (e) {}

  /* Tier 3: Open Graph meta tags */
  try {
    var og = document.querySelector('meta[property="og:product:id"], meta[property="product:retailer_item_id"]');
    if (og && og.content) return String(og.content);
  } catch (e) {}

  /* Tier 4: URL handle */
  try {
    var m = location.pathname.match(/^\/products\/([^\/?#]+)/);
    if (m && m[1]) return m[1];
  } catch (e) {}

  return null;
}

function fireViewContent(){
  var productId = readProductIdFromPDP();
  if (!productId) return;
  trackEvent('ViewContent', {
    content_ids: [productId],
    content_type: 'product'
  });
}

/* ---- ATC body parsing (FormData / JSON / URLSearchParams) ---- */
function parseAtcBody(body){
  var result = { variantId: null, quantity: 1, productId: null };
  try {
    if (body instanceof FormData) {
      result.variantId = body.get('id');
      result.quantity = parseInt(body.get('quantity') || '1', 10) || 1;
      result.productId = body.get('product-id') || body.get('product_id');
    } else if (typeof body === 'string') {
      try {
        var j = JSON.parse(body);
        result.variantId = j.id || (j.items && j.items[0] && j.items[0].id);
        result.quantity = parseInt(j.quantity || (j.items && j.items[0] && j.items[0].quantity) || '1', 10) || 1;
        result.productId = j.product_id;
      } catch (_) {
        var params = new URLSearchParams(body);
        result.variantId = params.get('id');
        result.quantity = parseInt(params.get('quantity') || '1', 10) || 1;
        result.productId = params.get('product-id') || params.get('product_id');
      }
    }
  } catch (e) {}
  return result;
}

/* ---- Dedupe de add-to-cart (2026-08-24) ----
   Dois caminhos observam o ATC: o wrapper de `fetch` e o listener de `submit`.
   A maioria dos temas dispara OS DOIS (emite submit, da preventDefault, chama
   fetch), e cada acao fisica virava dois AddToCart.

   ⛔ O caminho do fetch espera `res.ok` — so conta adicao que DEU CERTO. Uma
   dedupe de "o primeiro vence" faria o submit (que dispara na hora, sem
   confirmar nada) ganhar do caminho bom. Por isso o submit AGENDA em vez de
   contar, e o fetch cancela o agendamento assim que aparece:

     submit  -> agenda
     fetch   -> cancela o agendado; conta so se res.ok
     sem fetch (XHR/jQuery) -> o agendado dispara e cobre
     POST nativo -> a pagina navega; `pagehide` descarrega o agendado antes

   Mapa por chave, nao slot unico: duas variantes diferentes na mesma janela
   sao duas adicoes de verdade. */
var MC_ATC_ESPERA_MS = 1200;
var MC_ATC_JANELA_MS = 1500;
var _mcAtcContado = {};
var _mcAtcPendente = {};

/* A resposta do /cart/add.js traz o item adicionado com `price` em centavos,
   `product_id` e `variant_id`. E a fonte certa do valor: nao custa requisicao
   extra e acerta inclusive o produto RECOMENDADO na PDP — caso em que buscar
   por handle da URL falha, porque a variante nao pertence ao produto da pagina.

   ⚠️ Ler sempre de um clone. Consumir o corpo original deixa o tema sem nada
   para ler e quebra o carrinho da loja. */
function mcEnriquecerComResposta(base, corpo){
  if (!base || !corpo) return base;
  try {
    var itens = corpo.items || (corpo.id ? [corpo] : []);
    var alvo = null;
    for (var i = 0; i < itens.length; i++) {
      var vid = itens[i].variant_id || itens[i].id;
      if (String(vid) === String(base.variantId)) { alvo = itens[i]; break; }
    }
    if (!alvo && itens.length === 1) alvo = itens[0];
    if (!alvo) return base;
    return {
      variantId: base.variantId,
      quantity: base.quantity,
      productId: alvo.product_id || base.productId,
      // `price` e o unitario em centavos; `line_price` seria o total da linha.
      price: (alvo.price || 0) / 100,
      name: alvo.product_title || alvo.title || base.name || ''
    };
  } catch (e) { return base; }
}

function mcChaveAtc(parsed){
  return String(parsed.variantId) + 'x' + String(parsed.quantity);
}

function mcPodarAtc(){
  var agora = Date.now();
  for (var k in _mcAtcContado) {
    if (agora - _mcAtcContado[k] > MC_ATC_JANELA_MS) delete _mcAtcContado[k];
  }
}

function mcCancelarPendente(chave){
  var p = _mcAtcPendente[chave];
  if (p) {
    clearTimeout(p.timer);
    delete _mcAtcPendente[chave];
  }
}

function mcContarAtc(parsed){
  if (!parsed || !parsed.variantId) return;
  var chave = mcChaveAtc(parsed);
  var agora = Date.now();
  mcPodarAtc();
  if (_mcAtcContado[chave] && (agora - _mcAtcContado[chave]) < MC_ATC_JANELA_MS) return;
  _mcAtcContado[chave] = agora;
  mcCancelarPendente(chave);
  trackEvent('AddToCart', {
    variantId: parsed.variantId,
    name: parsed.name || '',
    content_ids: [String(parsed.productId || parsed.variantId)],
    content_type: 'product',
    // 2026-08-24: era `0` fixo. Toda adicao chegava na Meta valendo zero,
    // cegando otimizacao por valor. Agora vem da resposta do /cart/add.js.
    value: parsed.price || 0,
    quantity: parsed.quantity
  });
}

function mcAgendarAtc(parsed){
  if (!parsed || !parsed.variantId) return;
  var chave = mcChaveAtc(parsed);
  if (_mcAtcPendente[chave]) return;
  if (_mcAtcContado[chave] && (Date.now() - _mcAtcContado[chave]) < MC_ATC_JANELA_MS) return;
  // Guarda o dado JUNTO do timer: a descarga do `pagehide` precisa saber o que
  // contar, e um id de timer sozinho nao diz nada.
  _mcAtcPendente[chave] = {
    parsed: parsed,
    timer: setTimeout(function(){
      delete _mcAtcPendente[chave];
      mcContarAtc(parsed);
    }, MC_ATC_ESPERA_MS)
  };
}

/* POST nativo navega antes do timer. Descarrega o que estiver agendado. */
function mcDescarregarPendentes(){
  var chaves = Object.keys(_mcAtcPendente);
  for (var i = 0; i < chaves.length; i++) {
    var p = _mcAtcPendente[chaves[i]];
    if (!p) continue;
    clearTimeout(p.timer);
    delete _mcAtcPendente[chaves[i]];
    mcContarAtc(p.parsed);
  }
}

function onAtcSuccess(body){
  mcContarAtc(parseAtcBody(body));
}

/* ---- Fetch wrap — observe-only, never blocks ---- */
function setupATCHook(){
  var _fetch = window.fetch;
  window.fetch = function(input, init){
    var url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch (e) {}
    var isAtc = url.indexOf('/cart/add.js') !== -1 || url.indexOf('/cart/add') !== -1;
    var parsedAqui = null;
    if (isAtc) {
      // O fetch e autoritativo: existindo, ele decide. Cancela o agendamento
      // que o submit deixou, inclusive quando a resposta for erro — adicao que
      // falhou nao pode virar AddToCart pela porta dos fundos.
      try {
        parsedAqui = parseAtcBody(init && init.body);
        if (parsedAqui && parsedAqui.variantId) mcCancelarPendente(mcChaveAtc(parsedAqui));
      } catch (e) {}
    }
    var promise = _fetch.apply(this, arguments);
    if (isAtc) {
      promise.then(function(res){
        if (!(res && res.ok)) return;
        var base;
        try { base = parsedAqui || parseAtcBody(init && init.body); } catch (e) { return; }
        var lendo = null;
        try {
          if (typeof res.clone === 'function') lendo = res.clone().json();
        } catch (e) { lendo = null; }
        if (!lendo || typeof lendo.then !== 'function') { mcContarAtc(base); return; }
        lendo.then(function(corpo){
          mcContarAtc(mcEnriquecerComResposta(base, corpo));
        }).catch(function(){ mcContarAtc(base); });
      }).catch(function(){});
    }
    return promise;
  };

  /* Form submit fallback for legacy themes that don't use fetch */
  document.addEventListener('submit', function(e){
    var form = e.target;
    if (form && form.matches && form.matches('form[action*="/cart/add"]')) {
      try {
        mcAgendarAtc(parseAtcBody(new FormData(form)));
      } catch (err) {}
    }
  }, true);

  // POST nativo faz a pagina navegar antes do timer vencer. Sem isto, tema
  // sem AJAX perderia o AddToCart inteiro.
  window.addEventListener('pagehide', mcDescarregarPendentes);
  window.addEventListener('beforeunload', mcDescarregarPendentes);
}

/* ---- Checkout click hook — observe-only, never preventDefault ---- */
function fireInitiateCheckout(){
  trackEvent('InitiateCheckout', {});
}

function setupCheckoutClickHook(){
  document.addEventListener('click', function(e){
    var t = null;
    try {
      t = e.target && e.target.closest && e.target.closest(
        'a[href$="/checkout"], a[href*="/checkout?"], ' +
        'button[name="checkout"], input[name="checkout"], ' +
        'button[type="submit"][formaction$="/checkout"]'
      );
    } catch (err) {}
    if (!t) return;
    /* DO NOT preventDefault — native click proceeds */
    try { fireInitiateCheckout(); } catch (err) {}
  }, true); /* capture phase runs before theme handlers */
}

/* ---- Boot ---- */
rewriteAttributionCookies();
if (isPdp()) {
  captureAttributionToCart();
  fireViewContent();
} else if (/^\/cart\/?$/.test(location.pathname)) {
  // Customer landed directly on /cart (email link, bookmark, back-button).
  // Still need to persist attribution to cart_attributes for Purchase CAPI.
  captureAttributionToCart();
}
setupATCHook();
setupCheckoutClickHook();

console.log('[MC Native] engine v1 loaded for store ' + (window.__mcStoreId || ''));
})();
