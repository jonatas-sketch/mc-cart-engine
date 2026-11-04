/* ============================================================
   MC Cart Skip-Checkout Engine v1.0
   Reads window.mcCartConfig and intercepts native ATC, redirecting
   directly to the Loja B Storefront checkout for the selected
   single-variant product. No drawer, no /cart page.

   Spec: docs/superpowers/specs/2026-05-07-cart-modes-and-variant-pairing-design.md §4
   ============================================================ */
(function(){
'use strict';

const C = window.mcCartConfig;
if (!C || C.cart_mode !== 'skip-checkout') return;
/* Flags do bloco multi-pixel (ver 'Multi-pixel da Meta' abaixo). skip (legado): aditivo, sem injetar SDK. */
var MC_META_NOMEAR_DESTINO = false;
var MC_META_CARREGAR_SDK = false;

const POOL = C.pool || { members: [], assigned: null };
let assignedMember = null;
let inFlight = false;

/* ---- Cookie helpers ---- */
function readCookie(name){
  try {
    const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    if (!m) return null;
    return JSON.parse(decodeURIComponent(m[2]));
  } catch (e) { return null; }
}

function writeCookie(name, value){
  try {
    const v = encodeURIComponent(JSON.stringify(value));
    document.cookie = name + '=' + v + ';path=/;max-age=' + (7*24*3600);
  } catch (e) {}
}

/* ---- Pool member assignment ---- */
async function ensureMemberAssigned(){
  if (assignedMember) return assignedMember;

  const cookie = readCookie('mc_pool_v1');
  if (cookie && cookie.mId) {
    const fromCookie = (POOL.members || []).find(function(m){ return m && m.id === cookie.mId && m.status === 'active'; });
    if (fromCookie) { assignedMember = fromCookie; return fromCookie; }
  }

  if (POOL.assigned && POOL.assigned.memberId) {
    const fromLoader = (POOL.members || []).find(function(m){ return m && m.id === POOL.assigned.memberId; });
    if (fromLoader) { assignedMember = fromLoader; }
  }
  if (!assignedMember) {
    // BUG FIX 2026-05-17: previously `.find(...)` returned the FIRST active
    // member, always primary (server orders by is_primary DESC), defeating
    // the weighted pool entirely. Now do weighted random selection using
    // the `weight` emitted by the loader. Mirrors the fix in mc-cart-page.js.
    function isActiveS(m){ return m && (m.status == null || m.status === 'active'); }
    var candidates = (POOL.members || []).filter(isActiveS)
      .filter(function(m){ return (m.weight == null ? 1 : m.weight) > 0; });
    if (candidates.length === 0) {
      assignedMember = (POOL.members || []).find(isActiveS);
    } else if (candidates.length === 1) {
      assignedMember = candidates[0];
    } else {
      var totalWeight = 0;
      for (var ci = 0; ci < candidates.length; ci++) {
        totalWeight += (candidates[ci].weight == null ? 1 : candidates[ci].weight);
      }
      var r = Math.random() * totalWeight;
      for (var i = 0; i < candidates.length; i++) {
        r -= (candidates[i].weight == null ? 1 : candidates[i].weight);
        if (r < 0) { assignedMember = candidates[i]; break; }
      }
      if (!assignedMember) assignedMember = candidates[candidates.length - 1];
    }
  }
  if (!assignedMember) {
    // 2026-08-23: same last-resort as mc-cart-page.js — empty pool must
    // not hard-fail when the loader already put checkout credentials on C,
    // but an `allCapped` empty pool is intentional and must be respected.
    var legacyMaps = C && C.legacyProductMappings;
    var temMapa = !!legacyMaps && Object.keys(legacyMaps).length > 0;
    // Sem mapa o member sintetizado nao traduz nada — melhor nao existir.
    if (!POOL.allCapped && C && C.domain && C.token && temMapa) {
      assignedMember = {
        id: 'legacy-config',
        domain: C.domain,
        storefrontToken: C.token,
        productMappings: legacyMaps,
        is_primary: true,
        weight: 1,
        status: 'active',
      };
      // Must live in POOL.members — that is the array pickCoherentMember reads.
      if (!Array.isArray(POOL.members)) POOL.members = [];
      POOL.members.push(assignedMember);
    } else {
      throw new Error('no_active_pool_member');
    }
  }

  writeCookie('mc_pool_v1', { v: 1, mId: assignedMember.id, pv: POOL.version || null, exp: Date.now() + 7*24*3600*1000 });
  return assignedMember;
}

/* ---- Translation chain (mirrors Phase 1's translateLine) ---- */
function optionsKey(selectedOptions){
  if (!selectedOptions || !selectedOptions.length) return '';
  const parts = selectedOptions
    .filter(function(o){ return o && o.name && o.value; })
    .map(function(o){ return o.name.toLowerCase() + '=' + o.value.toLowerCase(); });
  if (!parts.length) return '';
  parts.sort();
  return parts.join('|');
}

function translateVariant(vitrineProductId, vitrineVariantId, sku, selectedOptions, member){
  // Match the Phase 1 chain: vitrineVariantPairs → variantsByOptions → variantsBySku
  const productGid = 'gid://shopify/Product/' + String(vitrineProductId);
  const mappings = (member && member.productMappings) || {};
  const mapping = mappings[productGid];
  if (!mapping) return null;

  // (1) Explicit pair
  if (mapping.vitrineVariantPairs && mapping.vitrineVariantPairs[String(vitrineVariantId)]) {
    return mapping.vitrineVariantPairs[String(vitrineVariantId)];
  }
  // (2) Options canonical
  const k = optionsKey(selectedOptions);
  if (k && mapping.variantsByOptions && mapping.variantsByOptions[k]) {
    return mapping.variantsByOptions[k];
  }
  // (3) SKU
  if (sku && mapping.variantsBySku && mapping.variantsBySku[sku]) {
    return mapping.variantsBySku[sku];
  }
  return null;
}

/* ---- Storefront cart create on Loja B ---- */
async function createLojaBCart(member, lojaBVariantGid, quantity, autoDiscount){
  const url = 'https://' + member.domain + '/api/2024-10/graphql.json';
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Storefront-Access-Token': member.storefrontToken,
  };
  const input = { lines: [{ merchandiseId: lojaBVariantGid, quantity: quantity || 1 }] };
  if (autoDiscount) input.discountCodes = [autoDiscount];

  const body = JSON.stringify({
    query: 'mutation($input:CartInput!){cartCreate(input:$input){cart{id checkoutUrl cost{totalAmount{amount}}}}}',
    variables: { input: input },
  });
  const res = await fetch(url, { method: 'POST', headers: headers, body: body });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data.cartCreate.cart;
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

/* ---- Pixel firing (Meta, GA4, TikTok, dataLayer) ---- */
function trackEvent(eventName, payload){
  try {
    const cur = C.currencyCode || 'USD';
    // eventID por evento (2026-09-09): mesmo id em todo pixel — e a chave da
    // dedup se este engine um dia passar a chamar o relay CAPI.
    const eventId = Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10);
    mcGarantirSdkMeta(window);
    if (window.fbq) {
      if (eventName === 'AddToCart') {
        mcEnviarFbq(window, 'track', 'AddToCart', {
          content_ids: [payload.variantId],
          content_type: 'product',
          value: parseFloat(payload.value || 0),
          currency: cur,
          num_items: payload.quantity,
        }, { eventID: eventId });
      } else if (eventName === 'InitiateCheckout') {
        mcEnviarFbq(window, 'track', 'InitiateCheckout', {
          value: parseFloat(payload.total || 0),
          currency: cur,
          num_items: payload.quantity,
        }, { eventID: eventId });
      }
    }
    if (window.gtag) {
      if (eventName === 'AddToCart') {
        window.gtag('event', 'add_to_cart', {
          currency: cur,
          value: parseFloat(payload.value || 0),
          items: [{ item_id: payload.variantId, quantity: payload.quantity }],
        });
      } else if (eventName === 'InitiateCheckout') {
        window.gtag('event', 'begin_checkout', {
          currency: cur,
          value: parseFloat(payload.total || 0),
        });
      }
    }
    if (window.ttq && window.ttq.track) {
      if (eventName === 'AddToCart') window.ttq.track('AddToCart', { content_id: payload.variantId, currency: cur, value: parseFloat(payload.value || 0) });
      else if (eventName === 'InitiateCheckout') window.ttq.track('InitiateCheckout', { currency: cur, value: parseFloat(payload.total || 0) });
    }
    if (window.dataLayer && Array.isArray(window.dataLayer)) {
      window.dataLayer.push({
        event: eventName === 'AddToCart' ? 'add_to_cart' : 'begin_checkout',
        ecommerce: { currency: cur, value: parseFloat(payload.value || payload.total || 0) },
      });
    }
  } catch (e) { console.warn('[MC Skip] track error', e); }
}

/* ---- Loading overlay ---- */
function showLoadingOverlay(){
  if (document.getElementById('mc-skip-overlay')) return;
  const o = document.createElement('div');
  o.id = 'mc-skip-overlay';
  o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
  o.innerHTML = '<div style="background:#fff;color:#222;padding:18px 24px;border-radius:6px;font:14px system-ui;box-shadow:0 8px 32px rgba(0,0,0,.3);">' +
    'Indo pro checkout...' +
    '</div>';
  document.body.appendChild(o);
}
function hideLoadingOverlay(){
  const o = document.getElementById('mc-skip-overlay');
  if (o) o.remove();
}

/* ---- The core handler ---- */
async function handleSkipCheckout(form){
  if (inFlight) return;
  inFlight = true;
  showLoadingOverlay();

  try {
    const variantInput = form && form.querySelector('[name="id"]');
    const variantId = variantInput && variantInput.value;
    if (!variantId) throw new Error('no_variant_selected');

    const qtyInput = form && form.querySelector('[name="quantity"]');
    const quantity = qtyInput ? parseInt(qtyInput.value, 10) || 1 : 1;

    // Find product_id: try ShopifyAnalytics meta first, then form data attribute
    let productId = null;
    if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product) {
      productId = window.ShopifyAnalytics.meta.product.id;
    }
    if (!productId && form.dataset && form.dataset.productId) productId = form.dataset.productId;
    if (!productId) {
      throw new Error('no_product_id');
    }

    // Read SKU + selectedOptions from /products/<handle>.js
    const handle = (window.location.pathname.match(/\/products\/([^/?#]+)/) || [])[1] || '';
    let selectedOptions = [];
    let sku = null;
    if (handle) {
      const productData = await fetch('/products/' + handle + '.js')
        .then(function(r){ return r.ok ? r.json() : null; })
        .catch(function(){ return null; });
      if (productData && productData.variants) {
        const variant = productData.variants.find(function(v){ return String(v.id) === String(variantId); });
        if (variant) {
          sku = variant.sku || null;
          if (Array.isArray(productData.options) && Array.isArray(variant.options)) {
            selectedOptions = productData.options.map(function(name, i){ return { name: name, value: variant.options[i] }; });
          }
        }
      }
    }

    const member = await ensureMemberAssigned();
    const lojaBVariantGid = translateVariant(productId, variantId, sku, selectedOptions, member);
    if (!lojaBVariantGid) throw new Error('cant_translate');

    const cart = await createLojaBCart(member, lojaBVariantGid, quantity, C.autoDiscount);

    trackEvent('AddToCart', { variantId: variantId, value: 0, quantity: quantity });
    trackEvent('InitiateCheckout', { total: cart.cost && cart.cost.totalAmount && cart.cost.totalAmount.amount, quantity: quantity });

    window.location.href = cart.checkoutUrl;
  } catch (err) {
    inFlight = false;
    hideLoadingOverlay();
    console.error('[MC Skip] error:', err && err.message);
    alert('Não conseguimos finalizar agora. Recarregue a página e tente novamente.');
  }
}

/* ---- PDP button override (skipBtn* config) ---- */
function applySkipBtnOverride(){
  // Defaults match src/lib/pdp-button-validation.ts PDP_BUTTON_DEFAULTS.
  var text   = (typeof C.skipBtnText    === 'string' && C.skipBtnText.trim())   ? C.skipBtnText.trim().slice(0,40) : null;
  var bg     = (typeof C.skipBtnBg      === 'string' && /^#[0-9a-fA-F]{6}$/.test(C.skipBtnBg))      ? C.skipBtnBg      : null;
  var color  = (typeof C.skipBtnColor   === 'string' && /^#[0-9a-fA-F]{6}$/.test(C.skipBtnColor))   ? C.skipBtnColor   : null;
  var hover  = (typeof C.skipBtnHoverBg === 'string' && /^#[0-9a-fA-F]{6}$/.test(C.skipBtnHoverBg)) ? C.skipBtnHoverBg : null;
  var rRaw   = typeof C.skipBtnRadius === 'number' ? C.skipBtnRadius : NaN;
  var radius = (isFinite(rRaw) && rRaw >= 0 && rRaw <= 24) ? Math.floor(rRaw) : null;

  // No-op when nothing is configured — legacy skip-mode stores keep the theme's
  // button untouched.
  if (!text && !bg && !color && !hover && radius === null) return;

  var btns = document.querySelectorAll(
    'button[name="add"], input[name="add"], [data-add-to-cart], [data-pf="addtocart"]'
  );
  if (!btns.length) return;

  // Inject hover stylesheet once.
  if (hover && !document.getElementById('mc-skip-hover-style')) {
    var s = document.createElement('style');
    s.id = 'mc-skip-hover-style';
    s.textContent = '.mc-skip-styled:hover{background-color:' + hover + ' !important;}';
    document.head.appendChild(s);
  }

  btns.forEach(function(btn){
    // Text override: replace the FIRST text-node child (preserves icon
    // <span>/<svg> siblings). If no text node exists, prepend one.
    if (text) {
      var node = null;
      for (var i = 0; i < btn.childNodes.length; i++) {
        var n = btn.childNodes[i];
        if (n.nodeType === 3 && n.textContent && n.textContent.trim()) { node = n; break; }
      }
      if (node) node.textContent = text;
      else btn.insertBefore(document.createTextNode(text), btn.firstChild);
    }
    if (bg)     btn.style.backgroundColor = bg;
    if (color)  btn.style.color           = color;
    if (radius !== null) btn.style.borderRadius = radius + 'px';
    if (hover)  btn.classList.add('mc-skip-styled');
  });
}

/* ---- Hook native ATC: capture-phase document listener + form submit ---- */
function setupATCInterception(){
  // Block native fetch to /cart/add — return empty cart (no real add happens)
  const _fetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/cart/add.js') !== -1 || url.indexOf('/cart/add') !== -1) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return _fetch.apply(this, arguments);
  };

  // Capture-phase click on ATC buttons
  document.addEventListener('click', async function(e){
    const btn = e.target && e.target.closest && e.target.closest(
      'button[name="add"], input[name="add"], [data-add-to-cart], [data-pf="addtocart"]'
    );
    if (!btn) return;
    const form = btn.closest('form');
    if (!form || !form.matches('form[action*="/cart/add"], form[action="/cart"]')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleSkipCheckout(form);
  }, true);

  // Capture-phase form submit — covers Enter-key submit + non-button triggers
  document.addEventListener('submit', async function(e){
    const form = e.target;
    if (!form || !form.matches || !form.matches('form[action*="/cart/add"]')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleSkipCheckout(form);
  }, true);
}

applySkipBtnOverride();
setupATCInterception();
console.log('[MC Skip] engine v1 loaded for store ' + (window.__mcStoreId || ''));
})();
