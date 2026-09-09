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
/* Flags do bloco multi-pixel (ver 'Multi-pixel da Meta' abaixo). native: a vitrine E o checkout; o pixel da loja e do tema/app — aditivo, sem injetar SDK. */
var MC_META_NOMEAR_DESTINO = false;
var MC_META_CARREGAR_SDK = false;

/* ---- Cookie helpers (mirrors mc-cart.js patterns) ---- */
function getCookie(name){
  var m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : null;
}
/* ---- fbclid CRU (2026-08-26) ----
   A Meta acusou "Server sending modified fbclid value in fbc parameter":
   63 conjuntos de anuncios, R$ 44.610 de investimento afetado, atingindo
   Purchase, ViewContent e AddToCart.

   `URLSearchParams.get('fbclid')` DECODIFICA percent-encoding e troca `+` por
   espaco. A Meta espera o valor exatamente como veio na URL. */
function mcFbclidCru(){
  try {
    var q = String(window.location.search || '').replace(/^\?/, '');
    if (!q) return '';
    var partes = q.split('&');
    for (var i = 0; i < partes.length; i++) {
      if (partes[i].indexOf('fbclid=') === 0) return partes[i].slice(7);
    }
  } catch (e) {}
  return '';
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
    var fbclid = mcFbclidCru();
    var gclid  = u.searchParams.get('gclid');
    // ⛔ nao sobrescrever o _fbc do fbevents.js (timestamp do clique)
    if (fbclid && !getCookie('_fbc')) setCookie('_fbc', 'fb.1.' + Date.now() + '.' + fbclid, 90);
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
    // fbclid CRU (fix #469): searchParams decodifica; este attr vira
    // note_attributes → fbc do Purchase no servidor
    var fbclid = mcFbclidCru();
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

/* ---- Multi-pixel da Meta (2026-09-09) ----
   O loader emite `metaPixelIds` (principal primeiro; so ids, nunca token).
   Cada pixel configurado e inicializado UMA vez. O que acontece depois
   depende de dois flags definidos no boot de cada engine:
     MC_META_NOMEAR_DESTINO — true: cada evento sai por `trackSingle` para
       CADA pixel (page engine, desenho de #461: o evento nomeia o pixel das
       campanhas). false: `fbq(verbo)` de sempre, que alcanca os pixels
       inicializados — os configurados E qualquer outro que tema/app tenha
       inicializado (drawer/native/skip: aditivo, ninguem deixa de receber).
     MC_META_CARREGAR_SDK — true: injeta fbevents.js quando nao ha fbq
       (page engine, #462). false: sem fbq na pagina nada e disparado, como
       sempre foi nesses engines (consentimento fica com o tema/CMP).
   O mesmo eventID vai a todo pixel — e ele que casa com o CAPI, que o relay
   abre em leque para os mesmos pixels. Loader antigo em cache (so `pxMeta`)
   continua valendo: um pixel.
   Bloco IDENTICO nos 4 engines — ha teste de paridade textual
   (multi-pixel-nos-engines.test.ts). Edite os quatro juntos. */
/* MC:META-MULTIPIXEL:INICIO */
function mcMetaPixelIds(){
  var ids = [];
  try {
    var lista = Array.isArray(C.metaPixelIds) ? C.metaPixelIds : (C.pxMeta ? [C.pxMeta] : []);
    for (var i = 0; i < lista.length; i++) {
      var id = String(lista[i] || '').trim();
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
  } catch (e) {}
  return ids;
}

/* O snippet oficial da Meta se auto-protege (`if(f.fbq)return;`): inerte
   enquanto outro app/tema carregou o SDK, assume quando ele sair. */
function mcGarantirSdkMeta(w){
  try {
    if (!MC_META_CARREGAR_SDK) return;
    if (w.fbq) return;                    // app/tema/GTM ja carregou; nao substituir
    if (!mcMetaPixelIds().length) return; // sem pixel configurado nao ha o que carregar
    /* eslint-disable */
    (function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    if(s&&s.parentNode){s.parentNode.insertBefore(t,s);}else{(b.head||b.documentElement).appendChild(t);}
    })(w,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
  } catch (e) {}
}

var _mcPixelsInicializados = {};

function mcEnviarFbq(w, verbo, evento, dados, opts){
  mcGarantirSdkMeta(w);
  if (!w.fbq) return;
  var ids = mcMetaPixelIds();
  for (var i = 0; i < ids.length; i++) {
    if (!_mcPixelsInicializados[ids[i]]) {
      /* Marca SO se o init nao lancou; senao tenta de novo no proximo evento. */
      try { w.fbq('init', ids[i]); _mcPixelsInicializados[ids[i]] = true; } catch (e) {}
    }
  }
  /* Cada chamada protegida: um pixel que lance nao pode derrubar os demais
     nem o GA4/TikTok/CAPI do mesmo evento (o trackEvent tem um try so). */
  if (ids.length && MC_META_NOMEAR_DESTINO) {
    /* trackSingle nomeia o destino; exige o init acima (sem ele o evento some). */
    var verboUnico = verbo === 'trackCustom' ? 'trackSingleCustom' : 'trackSingle';
    for (var j = 0; j < ids.length; j++) {
      try { w.fbq(verboUnico, ids[j], evento, dados, opts); } catch (e) {}
    }
    return;
  }
  try { w.fbq(verbo, evento, dados, opts); } catch (e) {}
}
/* MC:META-MULTIPIXEL:FIM */

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
    mcGarantirSdkMeta(window);
    if (window.fbq) {
      var fbPayload = {
        currency: cur,
        content_ids: payload.content_ids || (payload.variantId ? [String(payload.variantId)] : undefined),
        content_type: payload.content_type || 'product',
        value: parseFloat(payload.value || 0),
        num_items: payload.quantity || payload.num_items
      };
      mcEnviarFbq(window, 'track', eventName, fbPayload, { eventID: eventId });
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
