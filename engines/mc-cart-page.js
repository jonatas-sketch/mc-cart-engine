/* ============================================================
   MC Cart Page Engine v1.2 — CF override (Fase 1)
   Reads window.mcCartConfig and lets the customer use the theme's
   native /cart page; intercepts the "Finalizar compra" click to
   translate the vitrine cart into a Loja B Storefront cart and
   redirect to checkoutUrl.

   Spec: docs/superpowers/specs/2026-05-07-cart-modes-and-variant-pairing-design.md §3
   Phase 3.2: full pixel + CAPI + cookie + attribution parity with drawer engine.
   v1.2: CF checkout override — flag-gated, inert when POOL.cfTargets is unset.
   ============================================================ */
(function(){
'use strict';

const C = window.mcCartConfig;
// Cart Mode Unification (PR-A, 2026-05-21) — triple-mode boot guard.
// 'theme-drawer' is the canonical post-migration name.
// 'cart-page' is legacy: kept during deprecation window so stores still
//   in cart-page (DB) continue to work until SQL migration moves them.
// 'skip-checkout' is legacy: kept to cover the 5min loader in-process
//   cache window after SQL migration — some browsers may still receive
//   a stale loader emitting cart_mode='skip-checkout' for a few minutes.
// Future PR-C cleanup will collapse this to just 'theme-drawer'.
if (!C || (C.cart_mode !== 'theme-drawer' && C.cart_mode !== 'cart-page' && C.cart_mode !== 'skip-checkout')) return;

/* ---- Singleton de boot (2026-08-24) ----
   Em 24/08 a Messyd tinha DOIS ScriptTags do mesmo loader e o engine bootava
   duas vezes por pageview: dois wrappers de `fetch`, dois listeners de submit,
   dois ViewContent. Medido em s88hcy-cb: SEIS.

   A limpeza na Admin API e o `createScriptTag` idempotente atacam a origem,
   mas o cliente precisa de defesa própria — basta uma corrida no OAuth, um
   DELETE que falhou em silêncio, ou alguém colando o script no tema.

   A dedupe de ATC NÃO cobre isto: ela vive no closure de cada IIFE, então dois
   engines têm dois estados independentes. E ela não protege ViewContent nem os
   listeners de checkout.

   Grok 4.6 e Codex gpt-5.6-sol apontaram este item independentemente, os dois
   como prioridade 1. */
if (window.__mcPageEngineBooted) {
  try { console.warn('[MC Page] engine já ativo nesta página — segundo boot ignorado (ScriptTag duplicado?)'); } catch (e) {}
  return;
}
window.__mcPageEngineBooted = true;

/* O bloco de pixel inteiro esta atras de `if (w.fbq)`. Garantir o SDK AQUI, no
   boot, e o que faz o engine parar de depender do app da Meta existir. */
mcGarantirSdkMeta(window);

const POOL = C.pool || { members: [], assigned: null };
let assignedMember = null;
let inFlight = false;

/* ---- Cookie helpers (same shape as drawer) ---- */
function getCookie(name){
  try {
    const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return m ? m[2] : '';
  } catch (e) { return ''; }
}
function setCookie(name, value, maxAgeDays){
  try {
    document.cookie = name + '=' + value + ';path=/;max-age=' + (maxAgeDays * 86400) + ';SameSite=Lax';
  } catch (e) {}
}
function genEventId(){
  return Date.now().toString(36) + '.' + Math.random().toString(36).substr(2, 8);
}

/* ---- Pool cookie helpers (JSON-encoded, different from tracking cookies) ---- */
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
    document.cookie = name + '=' + v + ';path=/;max-age=' + (7 * 24 * 3600);
  } catch (e) {}
}

/* ---- First-party persistent anonymous ID ---- */
function getMcExtId(){
  let id = getCookie('_mc_ext_id');
  if (!id) {
    id = 'mc.' + Date.now().toString(36) + '.' + Math.random().toString(36).substr(2, 12);
    setCookie('_mc_ext_id', id, 365);
  }
  return id;
}
const mcExtId = getMcExtId();

/* ---- First-party FBC cookie (survives Safari ITP) ---- */
(function persistFbc(){
  try {
    const p = new URLSearchParams(window.location.search);
    const fbclid = p.get('fbclid');
    if (fbclid) {
      const fbc = 'fb.1.' + Date.now() + '.' + fbclid;
      setCookie('_fbc', fbc, 90);
    }
  } catch (e) {}
})();

/* ---- First-party GCLID cookie ---- */
(function persistGclid(){
  try {
    const p = new URLSearchParams(window.location.search);
    const gclid = p.get('gclid');
    if (gclid) setCookie('_mc_gclid', gclid, 90);
  } catch (e) {}
})();

/* ---- Google Ads gtag.js loader ---- */
if (C.gadsConversionId) {
  if (!window.gtag) {
    var _gadsScript = document.createElement('script');
    _gadsScript.async = true;
    _gadsScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + C.gadsConversionId;
    document.head.appendChild(_gadsScript);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){ window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
  }
  window.gtag('config', C.gadsConversionId, { allow_enhanced_conversions: true });
}

/* ---- UTM capture + persistence ---- */
function getUTMs(){
  try {
    const params = new URLSearchParams(window.location.search);
    const utms = {};
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','ttclid','ref','msclkid','li_fat_id','mc_cid','mc_eid'].forEach(function(k){
      const v = params.get(k);
      if (v) utms[k] = v;
    });
    try {
      const ga = document.cookie.split(';').find(function(c){ return c.trim().startsWith('_ga='); });
      if (ga) utms['_ga'] = ga.split('=').slice(1).join('=').trim();
    } catch (e) {}
    return utms;
  } catch (e) { return {}; }
}

function getSavedUTMs(){
  try {
    const s = sessionStorage.getItem('mc_utms');
    if (s) return JSON.parse(s);
    const l = localStorage.getItem('mc_utms_last');
    if (l) return JSON.parse(l);
  } catch (e) {}
  return {};
}

// On page load: capture UTMs into session + first/last touch
(function captureUTMs(){
  const pageUTMs = getUTMs();
  if (Object.keys(pageUTMs).length > 0) {
    try {
      if (pageUTMs.utm_source === 'mcsync') {
        // MC Sync email UTMs take priority (overwrite)
        sessionStorage.setItem('mc_utms', JSON.stringify(pageUTMs));
        localStorage.setItem('mc_utms_first', JSON.stringify(pageUTMs));
        localStorage.setItem('mc_utms_last', JSON.stringify(pageUTMs));
      } else {
        sessionStorage.setItem('mc_utms', JSON.stringify(pageUTMs));
        if (!localStorage.getItem('mc_utms_first')) localStorage.setItem('mc_utms_first', JSON.stringify(pageUTMs));
        localStorage.setItem('mc_utms_last', JSON.stringify(pageUTMs));
      }
    } catch (e) {}
  }
})();

/* ---- Meta Conversions API (server-side) ---- */
function sendCAPI(eventName, data, cur, eventId){
  try {
    const metaEventMap = { ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', RemoveFromCart: 'RemoveFromCart' };
    const metaEvent = metaEventMap[eventName];
    if (!metaEvent) return;

    if (!eventId) eventId = genEventId();
    const fbp = getCookie('_fbp');
    const fbc = getCookie('_fbc') || (function(){
      const p = new URLSearchParams(window.location.search);
      const fbclid = p.get('fbclid');
      if (fbclid) return 'fb.1.' + Date.now() + '.' + fbclid;
      return '';
    })();

    let custom_data = {};
    if (eventName === 'ViewContent') {
      custom_data = {
        content_ids: data.contentIds || [],
        content_type: 'product',
        content_name: data.name || '',
        value: parseFloat(data.price) || 0,
        currency: cur,
      };
    } else if (eventName === 'AddToCart') {
      custom_data = {
        value: parseFloat(data.price) || 0,
        currency: cur,
        content_ids: [data.variantId],
        content_name: data.name,
        content_type: 'product',
        num_items: data.qty || 1,
      };
    } else if (eventName === 'InitiateCheckout') {
      custom_data = {
        value: parseFloat(data.total) || 0,
        currency: cur,
        num_items: data.numItems || 0,
        content_type: 'product',
      };
    } else if (eventName === 'RemoveFromCart') {
      custom_data = {
        content_ids: data.variantId ? [data.variantId] : [],
        content_name: data.name || '',
        content_type: 'product',
      };
    }

    const payload = {
      events: [{
        event_name: metaEvent,
        event_id: eventId,
        source_url: window.location.href,
        fbc: fbc,
        fbp: fbp,
        external_id: mcExtId,
        custom_data: custom_data,
        user_data: {},
      }],
    };

    fetch(C.capiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).then(function(r){ return r.json(); }).then(function(res){
      if (res.success) console.log('[MC Page CAPI] ' + metaEvent + ' sent ok (events_received: ' + res.events_received + ')');
      else console.warn('[MC Page CAPI] Error:', res);
    }).catch(function(e){ console.warn('[MC Page CAPI] Network error:', e.message); });
  } catch (e) { console.warn('[MC Page CAPI] Error:', e); }
}

/* ---- Destino do evento no Meta (2026-08-25) ----
   `fbq('track', ...)` transmite para TODO pixel inicializado na pagina. Medido
   na messyd.com em 24/08, o unico pixel inicializado era o `1508619400546807`,
   do app do Facebook da Shopify — porque `buildConfigJS` nunca emitia `pxMeta`
   e o loader do theme-drawer nunca injeta `fbq('init', ...)`.

   Resultado: o evento do navegador caia num pixel e o do CAPI (que le
   `cart_config.pxMeta` no servidor) em OUTRO. Pixels diferentes: a dedup por
   `event_id` nunca teve como funcionar, mesmo com `trackEvent` gerando um id
   so para os dois lados.

   `trackSingle` nomeia o destino. ⚠️ Ele exige o pixel inicializado — trocar
   sem o `init` apagaria o evento do navegador dos DOIS pixels (alerta do
   Grok 4.6 na auditoria).

   Sem `pxMeta` configurado, o comportamento antigo e preservado: nao ha alvo
   para nomear, e deixar de disparar seria pior. */
/* ---- SDK da Meta (2026-08-25) ----
   O engine so disparava pixel dentro de `if (w.fbq && ...)`, e em theme-drawer
   o loader NUNCA injeta o SDK — `buildPixelScripts` faz isso so no caminho
   drawer/sync. Entao o `fbq` da pagina vinha do app Facebook & Instagram, que
   roda em `runtimeContext: OPEN`.

   Consequencia: remover o app apagaria o lado navegador INTEIRO, em silencio.
   O app virou dependencia escondida do MC Sync sem ninguem decidir isso.

   O snippet oficial da Meta se auto-protege (`if(f.fbq)return;`), entao isto e
   inerte enquanto o app estiver na pagina e assume quando ele sair.

   Achado por Grok 4.6 e Codex gpt-5.6-sol, independentemente. */
function mcGarantirSdkMeta(w){
  try {
    if (!C.pxMeta) return;      // sem pixel configurado nao ha o que carregar
    if (w.fbq) return;          // app/tema/GTM ja carregou; nao substituir
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

var _mcPixelInicializado = false;

function mcEnviarFbq(w, verbo, evento, dados, opts){
  mcGarantirSdkMeta(w);
  if (C.pxMeta) {
    if (!_mcPixelInicializado) {
      try { w.fbq('init', C.pxMeta); } catch (e) {}
      _mcPixelInicializado = true;
    }
    var verboUnico = verbo === 'trackCustom' ? 'trackSingleCustom' : 'trackSingle';
    w.fbq(verboUnico, C.pxMeta, evento, dados, opts);
    return;
  }
  w.fbq(verbo, evento, dados, opts);
}

/* ---- Pixel + CAPI firing ---- */
function trackEvent(eventName, data){
  try {
    const cur = (C.currencyCode || 'USD').replace(/[^A-Za-z]/g, '').toUpperCase() || 'USD';
    const w = window;
    const found = [];
    const eventId = genEventId();

    // Meta Pixel (fbq) — with eventID for browser/CAPI dedup
    if (w.fbq && typeof w.fbq === 'function') {
      found.push('fbq');
      if (eventName === 'ViewContent') {
        mcEnviarFbq(w, 'track', 'ViewContent', {
          content_ids: data.contentIds || [],
          content_type: 'product',
          content_name: data.name || '',
          value: parseFloat(data.price) || 0,
          currency: cur,
        }, { eventID: eventId });
      } else if (eventName === 'AddToCart') {
        mcEnviarFbq(w, 'track', 'AddToCart', {
          content_name: data.name,
          content_ids: [data.variantId],
          content_type: 'product',
          value: parseFloat(data.price) || 0,
          currency: cur,
          num_items: data.qty || 1,
        }, { eventID: eventId });
      } else if (eventName === 'InitiateCheckout') {
        mcEnviarFbq(w, 'track', 'InitiateCheckout', {
          value: parseFloat(data.total) || 0,
          currency: cur,
          num_items: data.numItems || 0,
          content_type: 'product',
        }, { eventID: eventId });
      } else if (eventName === 'RemoveFromCart') {
        mcEnviarFbq(w, 'trackCustom', 'RemoveFromCart', {
          content_name: data.name,
          content_ids: [data.variantId],
          content_type: 'product',
        }, { eventID: eventId });
      }
    }

    // Google Analytics 4 (gtag)
    if (w.gtag && typeof w.gtag === 'function') {
      found.push('gtag');
      if (eventName === 'AddToCart') {
        w.gtag('event', 'add_to_cart', {
          currency: cur,
          value: parseFloat(data.price) || 0,
          items: [{ item_id: data.variantId, item_name: data.name, price: parseFloat(data.price) || 0, quantity: data.qty || 1 }],
        });
      } else if (eventName === 'InitiateCheckout') {
        w.gtag('event', 'begin_checkout', {
          currency: cur,
          value: parseFloat(data.total) || 0,
          items: data.items || [],
        });
      } else if (eventName === 'RemoveFromCart') {
        w.gtag('event', 'remove_from_cart', {
          currency: cur,
          items: [{ item_id: data.variantId, item_name: data.name }],
        });
      }
    }

    // Google Tag Manager (dataLayer)
    if (w.dataLayer && Array.isArray(w.dataLayer)) {
      found.push('dataLayer');
      if (eventName === 'AddToCart') {
        w.dataLayer.push({ event: 'add_to_cart', ecommerce: { currency: cur, value: parseFloat(data.price) || 0, items: [{ item_id: data.variantId, item_name: data.name, price: parseFloat(data.price) || 0, quantity: data.qty || 1 }] } });
      } else if (eventName === 'InitiateCheckout') {
        w.dataLayer.push({ event: 'begin_checkout', ecommerce: { currency: cur, value: parseFloat(data.total) || 0, items: data.items || [] } });
      } else if (eventName === 'RemoveFromCart') {
        w.dataLayer.push({ event: 'remove_from_cart', ecommerce: { items: [{ item_id: data.variantId, item_name: data.name }] } });
      }
    }

    // TikTok Pixel
    if (w.ttq && w.ttq.track) {
      found.push('ttq');
      if (eventName === 'AddToCart') w.ttq.track('AddToCart', { content_id: data.variantId, content_name: data.name, value: parseFloat(data.price) || 0, currency: cur });
      else if (eventName === 'InitiateCheckout') w.ttq.track('InitiateCheckout', { value: parseFloat(data.total) || 0, currency: cur });
    }

    // Google Ads Conversions
    if (C.gadsConversionId) {
      const g = w.gtag;
      if (g && typeof g === 'function') {
        if (eventName === 'ViewContent' && C.gadsPageViewLabel) {
          g('event', 'conversion', { send_to: C.gadsConversionId + '/' + C.gadsPageViewLabel });
          found.push('gads');
        } else if (eventName === 'AddToCart' && C.gadsAddToCartLabel) {
          g('event', 'conversion', { send_to: C.gadsConversionId + '/' + C.gadsAddToCartLabel, value: parseFloat(data.price) || 0, currency: cur });
          found.push('gads');
        } else if (eventName === 'InitiateCheckout' && C.gadsCheckoutLabel) {
          g('event', 'conversion', { send_to: C.gadsConversionId + '/' + C.gadsCheckoutLabel, value: parseFloat(data.total) || 0, currency: cur });
          found.push('gads');
        }
      }
    }

    // Meta Conversions API (server-side)
    if (C.capiEndpoint) {
      found.push('CAPI');
      sendCAPI(eventName, data, cur, eventId);
    }

    console.log('[MC Page Track] ' + eventName + ' → ' + (found.join(', ') || 'none'), data);

    // A/B test impression tracking (fires once per page load when test is active)
    if (window.__mcAbTestId && !window.__mcAbImpSent) {
      window.__mcAbImpSent = true;
      if (window.__mcStoreId && window.__mcTrackUrl) {
        try {
          fetch(window.__mcTrackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              storeId: window.__mcStoreId,
              ab_test_id: window.__mcAbTestId,
              ab_variant: window.__mcAbVariant,
              ab_visitor_id: window.__mcAbVisitorId,
              ab_event: 'impression',
            }),
            keepalive: true,
          }).catch(function(){});
        } catch (e) {}
      }
    }
  } catch (e) { console.warn('[MC Page] track error', e); }
}

/* ---- Pool member assignment (lazy, on first ATC or first checkout click) ----
   The loader (src/app/api/storefront/[storeId]/loader.js/route.ts) emits POOL.members
   without a `status` field — `getActivePoolMembers` already filters for active members
   server-side, so every entry in POOL.members is guaranteed active. Use
   `(m.status || 'active') === 'active'` defensively (matches pickCoherentMember's
   semantics in cart-coherent.ts). Skip engine has a latent bug here — strict equality
   `m.status === 'active'` always fails because m.status is undefined. Mode A fixes it. */
async function ensureMemberAssigned(){
  if (assignedMember) return assignedMember;

  function isActive(m){ return m && (m.status || 'active') === 'active'; }

  const cookie = readCookie('mc_pool_v1');
  if (cookie && cookie.mId) {
    // 2026-08-23 — só honra o cookie se ele foi gravado sob a MESMA
    // configuração de pool. O cookie tem precedência sobre o sorteio e é
    // reescrito a cada visita com 7 dias, então sem esta checagem **mudar peso
    // no dashboard nunca alcançava visitante recorrente**: a distribuição
    // antiga fossilizava. Medido na Mesyd com 70/30/1 configurados, o member
    // de peso 1 recebia 18,5% do tráfego — 18x o configurado — convertendo a
    // 28,9% contra 69,1% do member de peso 30.
    //
    // Loader sem `version` (versão velha em cache no CDN): respeita o cookie.
    // Re-sortear todo mundo a cada página seria pior que a distribuição parada.
    var mesmaConfig = !POOL.version || cookie.pv === POOL.version;
    if (mesmaConfig) {
      const fromCookie = (POOL.members || []).find(function(m){ return isActive(m) && m.id === cookie.mId; });
      if (fromCookie) { assignedMember = fromCookie; return fromCookie; }
    }
  }
  if (POOL.assigned && POOL.assigned.memberId) {
    const fromLoader = (POOL.members || []).find(function(m){ return m && m.id === POOL.assigned.memberId; });
    if (fromLoader) { assignedMember = fromLoader; }
  }
  if (!assignedMember) {
    // BUG FIX 2026-05-17 (PR after #265): previously `.find(isActive)` —
    // returned the FIRST active member, which is always primary because
    // getActivePoolMembers orders by `is_primary DESC`. That defeated the
    // pool's weighted distribution entirely: a member with weight 99 vs a
    // primary with weight 1 still received 0% of cart-page traffic because
    // primary was always picked first. Drawer mode escaped this because it
    // calls /api/pool/resolve which uses pickPoolMember's weighted bucket.
    // Now we do weighted random selection client-side using the `weight`
    // field emitted by the loader (PoolEmittedMember.weight).
    var candidates = (POOL.members || []).filter(isActive)
      .filter(function(m){ return (m.weight == null ? 1 : m.weight) > 0; });
    if (candidates.length === 0) {
      // Defensive fallback — no positive-weight members. Use any active.
      assignedMember = (POOL.members || []).find(isActive);
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
    // 2026-08-23: the loader can emit members:[] — a DB timeout, a stale CDN
    // copy, or a store with no pool rows. theme-drawer cannot checkout with an
    // empty pool, so fall back to the single-checkout credentials on config.
    //
    // NOT when POOL.allCapped: that empty pool is intentional — every member
    // hit its daily sales cap — and falling back would re-open the capped
    // checkout, defeating the cap the loader just enforced.
    var legacyMaps = C && C.legacyProductMappings;
    var temMapa = !!legacyMaps && Object.keys(legacyMaps).length > 0;
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
      // pickCoherentMember() searches POOL.members — NOT `assignedMember`.
      // Without this push the synthesized member is invisible to it and the
      // checkout still dies one step later on 'no_member_can_fulfill', which
      // is exactly how the 2026-08-23 fix looked correct while being inert.
      if (!Array.isArray(POOL.members)) POOL.members = [];
      POOL.members.push(assignedMember);
    } else {
      // Sem mapa não há last-resort possível: translateLine() devolveria null
      // para toda linha e o checkout morreria um passo adiante, com um código
      // enganoso. Falha aqui, nomeada, para o log dizer a verdade.
      if (!POOL.allCapped && C && C.domain && C.token && !temMapa) {
        logSystemEvent('mode_a_last_resort_no_mappings', {});
      }
      throw new Error('no_active_pool_member');
    }
  }

  writeCookie('mc_pool_v1', { v: 1, mId: assignedMember.id, pv: POOL.version || null, exp: Date.now() + 7 * 24 * 3600 * 1000 });
  return assignedMember;
}

/* ---- Translation chain (mirrors src/lib/checkout-pool/translate-line.ts) ---- */
function optionsKey(selectedOptions){
  if (!selectedOptions || !selectedOptions.length) return '';
  const parts = selectedOptions
    .filter(function(o){ return o && o.name && o.value; })
    .map(function(o){ return o.name.toLowerCase() + '=' + o.value.toLowerCase(); });
  if (!parts.length) return '';
  parts.sort();
  return parts.join('|');
}

function translateLine(line, member){
  const productGid = 'gid://shopify/Product/' + String(line.productId);
  const mappings = (member && member.productMappings) || {};
  const m = mappings[productGid];
  if (!m) return null;

  const variantIdStr = String(line.variantId);
  if (m.vitrineVariantPairs && m.vitrineVariantPairs[variantIdStr]) {
    return m.vitrineVariantPairs[variantIdStr];
  }
  const k = optionsKey(line.selectedOptions);
  if (k && m.variantsByOptions && m.variantsByOptions[k]) {
    return m.variantsByOptions[k];
  }
  if (line.sku && m.variantsBySku && m.variantsBySku[line.sku]) {
    return m.variantsBySku[line.sku];
  }
  return null;
}

/* ---- Cart-coherent member selection (mirrors src/lib/checkout-pool/cart-coherent.ts) ---- */
function pickCoherentMember(lines, members, assignedMemberId){
  function fulfills(member){
    for (let i = 0; i < lines.length; i++) {
      if (translateLine(lines[i], member) == null) return false;
    }
    return true;
  }
  if (assignedMemberId) {
    const a = (members || []).find(function(m){ return m && m.id === assignedMemberId && (m.status || 'active') === 'active'; });
    if (a && fulfills(a)) return a;
  }
  // 2026-08-23 — sorteia por PESO entre os que atendem, em vez de caminhar o
  // array e pegar o primeiro. A ordem emitida pelo loader é
  // `is_primary DESC, created_at ASC`, então o fallback em ordem fazia o
  // secundário MAIS ANTIGO absorver todas as falhas do primary, seja qual
  // fosse o peso dele. Medido em teste: com pesos 1 e 99, o de peso 1 levava
  // 100% dos fallbacks. Na Mesyd isso ajudava a explicar o member de peso 1
  // recebendo 18,5% do trafego e convertendo a 28,9%.
  var aptos = [];
  for (let i = 0; i < (members || []).length; i++) {
    const m = members[i];
    if (!m) continue;
    if ((m.status || 'active') !== 'active') continue;
    if (m.id === assignedMemberId) continue;
    if (fulfills(m)) aptos.push(m);
  }
  if (aptos.length === 0) return null;
  if (aptos.length === 1) return aptos[0];

  var total = 0;
  for (var j = 0; j < aptos.length; j++) {
    total += (aptos[j].weight == null ? 1 : aptos[j].weight);
  }
  // Todos com peso 0: melhor um checkout que nenhum.
  if (total <= 0) return aptos[0];

  var r = Math.random() * total;
  for (var k = 0; k < aptos.length; k++) {
    r -= (aptos[k].weight == null ? 1 : aptos[k].weight);
    if (r < 0) return aptos[k];
  }
  return aptos[aptos.length - 1];
}

/* ---- ClickFunnels override (Fase 1) — mirrors src/lib/checkout-pool/cf-eligibility.ts ---- */
function cfPickTarget(cartLines){
  var cfTargets = POOL.cfTargets;
  if (!cfTargets || !cartLines || !cartLines.length) return null;
  var gids = {};
  for (var i=0;i<cartLines.length;i++){ gids['gid://shopify/Product/'+cartLines[i].productId] = 1; }
  var keys = Object.keys(gids);
  if (keys.length !== 1) return null;
  var target = cfTargets[keys[0]];
  if (!target || target.capped) return null;
  var cfLines = [];
  for (var j=0;j<cartLines.length;j++){
    var m = target.variantMap[String(cartLines[j].variantId)];
    if (!m) return null;
    cfLines.push({ cf_variant_id: m.cf_variant_id, cf_price_id: m.cf_price_id, quantity: cartLines[j].quantity });
  }
  return { target: target, cfLines: cfLines };
}
function cfCanaryPick(cookie, productId, weight){
  if (cookie && cookie.pid === productId && (cookie.roll === 'cf' || cookie.roll === 'shopify')) {
    return { roll: cookie.roll, persist: false };
  }
  var roll = (Math.random() * 100 < weight) ? 'cf' : 'shopify';
  return { roll: roll, persist: true };
}
function cfBuildBridgeUrl(target, cfLines, passthrough){
  var u = new URL(target.bridgeUrl);
  u.searchParams.set('cf_product_id', String(target.cfProductId));
  u.searchParams.set('cf_lines', JSON.stringify(cfLines));
  for (var k in passthrough){
    if (Object.prototype.hasOwnProperty.call(passthrough, k)) {
      var v = passthrough[k];
      if (v != null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}
// Returns true if it redirected to a CF bridge (caller must `return`).
function maybeRedirectToCf(vitrineCart){
  if (!POOL.cfTargets) return false;
  var picked = cfPickTarget(vitrineCart.lines);
  if (!picked) return false;
  var pid = picked.target.vitrineProductId;
  var cookie = readCookie('mc_cf_v1');
  var canary = cfCanaryPick(cookie, pid, (picked.target.weight == null ? 0 : picked.target.weight));
  if (canary.persist) {
    writeCookie('mc_cf_v1', { v: 1, pid: pid, roll: canary.roll, exp: Date.now() + 7*24*3600*1000 });
  }
  if (canary.roll !== 'cf') return false;
  // best-effort: mark the vitrine cart so the abandoned-cart poller can skip it
  try { fetch('/cart/update.js', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ attributes: { _mc_cf: '1' } }), keepalive: true }); } catch(e){}
  // pixel mirror — identical to the permalink branch. total:0 is intentional:
  // CF's own server-side Purchase carries the real amount.
  trackEvent('InitiateCheckout', {
    total: 0,
    numItems: vitrineCart.totalQuantity,
    items: vitrineCart.lines.map(function(l){ return { item_id: String(l.variantId), quantity: l.quantity }; }),
  });
  var utms = getSavedUTMs() || {};
  var passthrough = {
    utm_source: utms.utm_source, utm_medium: utms.utm_medium, utm_campaign: utms.utm_campaign,
    utm_content: utms.utm_content, utm_term: utms.utm_term,
    gclid: utms.gclid, fbclid: utms.fbclid, ttclid: utms.ttclid,
    _fbc: getCookie('_fbc'), _fbp: getCookie('_fbp'), mc_ext_id: getMcExtId(),
    mc_ab_test_id: window.__mcAbTestId, mc_ab_variant: window.__mcAbVariant,
  };
  // 2026-08-23 — passa pelo mesmo goToCheckout do caminho Shopify para herdar
  // o watchdog. Antes era `window.location.href = ...` direto, e o chamador
  // dava `return` com o overlay armado: se a navegação não acontecesse
  // (navegador in-app, iframe), o cliente ficava preso do mesmo jeito.
  goToCheckout(cfBuildBridgeUrl(picked.target, picked.cfLines, passthrough));
  return true;
}

/* ---- Storefront cart create on Loja B (multi-line) ---- */
async function createLojaBCart(member, lines, opts){
  // opts: { autoDiscount, extraDiscountCodes, attributes, note }
  const url = 'https://' + member.domain + '/api/2024-10/graphql.json';
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Storefront-Access-Token': member.storefrontToken,
  };

  const input = { lines: lines };
  const codes = [];
  if (opts && opts.autoDiscount) codes.push(opts.autoDiscount);
  if (opts && Array.isArray(opts.extraDiscountCodes)) {
    for (let i = 0; i < opts.extraDiscountCodes.length; i++) {
      const c = opts.extraDiscountCodes[i];
      if (c) codes.push(c);
    }
  }
  if (codes.length) input.discountCodes = codes;
  if (opts && opts.attributes && opts.attributes.length) input.attributes = opts.attributes;
  if (opts && opts.note) input.note = opts.note;

  const body = JSON.stringify({
    // 2026-08-24 — pede de volta as LINHAS e os WARNINGS. Uma variante
    // apagada e recriada na Loja B deixa o mapa apontando para o GID antigo;
    // translateLine devolve esse GID (nao-nulo), pickCoherentMember aprova o
    // member, e a Shopify DESCARTA a linha em silencio. Sem conferir, o
    // cliente era redirecionado para um checkout com item faltando.
    query: 'mutation($input:CartInput!){cartCreate(input:$input){cart{id checkoutUrl cost{totalAmount{amount}} lines(first:250){pageInfo{hasNextPage}edges{node{id quantity merchandise{... on ProductVariant{id}}}}}}userErrors{message}warnings{code target message}}}',
    variables: { input: input },
  });
  const res = await fetch(url, { method: 'POST', headers: headers, body: body });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  const userErrors = data.data && data.data.cartCreate && data.data.cartCreate.userErrors;
  if (userErrors && userErrors.length) throw new Error(userErrors[0].message);
  if (!data.data || !data.data.cartCreate || !data.data.cartCreate.cart) throw new Error('cartCreate_no_cart');

  // 2026-08-24 — a Shopify aceita o cartCreate e DESCARTA silenciosamente uma
  // linha cujo merchandiseId nao existe mais (variante apagada e recriada na
  // Loja B: o mapa segue com o GID antigo). Sem esta conferencia o cliente ia
  // para um checkout com item faltando — e pagava por menos do que escolheu.
  //
  // Falhar aqui e melhor: o chamador ja tenta outro member, e se nenhum
  // atender o erro aparece nomeado em vez de virar um pedido errado.
  const cart = data.data.cartCreate.cart;
  const warnings = data.data.cartCreate.warnings;
  // `lines(first:250)` satura em 250. Sem olhar o pageInfo, um carrinho grande
  // e INTEIRO seria reprovado como se tivesse perdido linhas.
  const temMaisPaginas = !!(cart.lines && cart.lines.pageInfo && cart.lines.pageInfo.hasNextPage);
  // Compara com merchandiseIds DISTINTOS, nao com a contagem crua: o carrinho
  // da vitrine pode ter duas linhas da MESMA variante (propriedades de linha
  // diferentes), e a Shopify funde as duas numa so. Isso e legitimo. Comparar
  // pela contagem crua reprovaria essa venda.
  // Compara por IDENTIDADE e QUANTIDADE, nao por contagem de linhas.
  //
  // Contar linhas nao prova quais sobreviveram: com a variante A repetida (duas
  // linhas, atributos diferentes) e a variante B stale, a Shopify mantem as
  // duas A e descarta B — recebidas=2, esperadas=2, e o carrinho ERRADO
  // passava. Agrupar quantidade por merchandiseId pega esse caso.
  const enviado = {};
  for (let i = 0; i < lines.length; i++) {
    const mid = lines[i] && lines[i].merchandiseId;
    if (!mid) continue;
    enviado[mid] = (enviado[mid] || 0) + (lines[i].quantity || 1);
  }
  const recebido = {};
  const edges = (cart.lines && cart.lines.edges) || [];
  for (let i = 0; i < edges.length; i++) {
    const n = edges[i] && edges[i].node;
    const mid = n && n.merchandise && n.merchandise.id;
    if (!mid) continue;
    recebido[mid] = (recebido[mid] || 0) + (n.quantity || 1);
  }
  if (!temMaisPaginas) {
    const idsEnviados = Object.keys(enviado);
    for (let i = 0; i < idsEnviados.length; i++) {
      const mid = idsEnviados[i];
      if ((recebido[mid] || 0) < enviado[mid]) {
        throw new Error('cartCreate_linhas_descartadas:' + mid.split('/').pop());
      }
    }
  }

  // So aviso sobre MERCHANDISE derruba o carrinho.
  //
  // O engine manda o cupom automatico e os cupons nativos da vitrine. Um cupom
  // que existe na Loja A e nao na Loja B devolve DISCOUNT_NOT_FOUND /
  // DISCOUNT_NOT_APPLICABLE: a Shopify cria o carrinho e ignora o desconto —
  // isso sempre foi venda boa. Reprovar aqui faria o engine tentar o proximo
  // member com o MESMO cupom, esgotar o pool e mostrar o modal de erro.
  if (warnings && warnings.length) {
    for (let w = 0; w < warnings.length; w++) {
      const code = String((warnings[w] && warnings[w].code) || '');
      if (code.indexOf('MERCHANDISE') === 0) {
        throw new Error('cartCreate_warning:' + code);
      }
    }
  }
  return cart;
}

/* ---- Loading overlay ---- */
function escapeHtml(s){
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function showLoadingOverlay(){
  if (document.getElementById('mc-page-overlay')) return;
  // Subtle overlay that mimics a native browser/Shopify checkout transition:
  // no white modal box, no text, just a centered ring spinner over a faint
  // backdrop. Looks like the page is fading out into the next route rather
  // than like a custom MC popup. Merchant can opt back into a labeled modal
  // by setting cart_config.cartPageLoadingText — when present we render the
  // text alongside the spinner (still in a subtle pill, not a heavy modal).
  const text = (C.cartPageLoadingText && String(C.cartPageLoadingText)) || '';
  const o = document.createElement('div');
  o.id = 'mc-page-overlay';
  o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.18);z-index:99999;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);transition:opacity .2s ease;';
  const spinnerSvg = '<svg width="40" height="40" viewBox="0 0 24 24" style="animation:mcSpin .8s linear infinite;display:block;"><circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,.25)" stroke-width="2.5" fill="none"/><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2.5" fill="none" stroke-dasharray="60" stroke-dashoffset="40" stroke-linecap="round"/></svg>';
  if (text) {
    o.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;">' +
      spinnerSvg +
      '<span style="color:#fff;font:500 13px/1.4 system-ui,-apple-system,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.2);letter-spacing:.01em;">' + escapeHtml(text) + '</span>' +
      '</div>' +
      '<style>@keyframes mcSpin{to{transform:rotate(360deg)}}</style>';
  } else {
    o.innerHTML = spinnerSvg + '<style>@keyframes mcSpin{to{transform:rotate(360deg)}}</style>';
  }
  document.body.appendChild(o);
}
function hideLoadingOverlay(){
  const o = document.getElementById('mc-page-overlay');
  if (o) o.remove();
}

/* ---- Error UX ---- */
function showErrorModal(message){
  try { alert(message); } catch (e) { console.error('[MC Page] alert blocked:', message); }
}

function logSystemEvent(code, detail){
  try {
    const url = window.__mcTrackUrl;
    if (!url) return;
    const storeId = window.__mcStoreId;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: storeId, code: code, source: 'mc-cart-page', detail: detail || null }),
      keepalive: true,
    }).catch(function(){});
  } catch (e) {}
}

/* ---- Read native vitrine cart ---- */
/* 2026-08-25 — UMA retentativa curta. Medido em producao: entre 13:10:43 e
   13:11:43 saíram cinco `mode_a_checkout_error` com `cart_read_failed`, do
   MESMO cliente tentando de novo; as 13:12:02 ele passou e as seis tentativas
   seguintes foram todas boas. O /cart.js e endpoint da propria Shopify e o
   soluco foi dela — mas quem pagou foram cinco cliques de alguem que ja tinha
   decidido comprar.

   Falha persistente continua estourando: engolir faria o cliente ver um botao
   que nao faz nada, e sem telemetria. */
async function readVitrineCart(){
  let r = await fetch('/cart.js', { credentials: 'same-origin' }).catch(function(){ return null; });
  if (!r || !r.ok) {
    await new Promise(function(res){ setTimeout(res, 250); });
    r = await fetch('/cart.js', { credentials: 'same-origin' }).catch(function(){ return null; });
  }
  if (!r || !r.ok) throw new Error('cart_read_failed');
  const cart = await r.json();
  const lines = (cart.items || []).map(function(it){
    let selectedOptions = [];
    if (Array.isArray(it.options_with_values)) {
      selectedOptions = it.options_with_values.map(function(o){ return { name: o.name, value: o.value }; });
    } else if (Array.isArray(it.variant_options) && Array.isArray(it.options)) {
      selectedOptions = it.options.map(function(name, i){ return { name: name, value: it.variant_options[i] }; });
    }
    return {
      productId: it.product_id,
      variantId: it.variant_id,
      sku: it.sku || null,
      selectedOptions: selectedOptions,
      quantity: it.quantity || 1,
    };
  });
  return {
    items: cart.items || [],
    lines: lines,
    totalQuantity: cart.item_count || 0,
    note: cart.note || '',
    discount_applications: cart.discount_applications || [],
    cart_level_discount_applications: cart.cart_level_discount_applications || [],
    // Ajax API (2024+) exposes codes applied to the native cart — via
    // /discount/CODE or POST /cart/update.js {discount} — as
    // discount_codes: [{code, applicable}]. The *_discount_applications
    // entries carry title/value but no `code`, so without this field a
    // code the customer already sees applied in the vitrine drawer was
    // silently dropped on the way to the checkout store.
    discount_codes: Array.isArray(cart.discount_codes) ? cart.discount_codes : [],
  };
}

/* ---- Build cart attributes from UTMs + meta cookies + AB test ---- */
function buildCartAttributes(){
  const utms = getSavedUTMs();
  const cartAttributes = [];
  const utmKeys = Object.keys(utms);
  for (let i = 0; i < utmKeys.length; i++) {
    const k = utmKeys[i];
    const v = utms[k];
    if (v) cartAttributes.push({ key: k, value: String(v) });
  }
  // NOTE: document.referrer was previously captured here, but it adds noise
  // to the order's note_attributes (e.g. "https://www.serelune.co.uk/products/..."
  // for in-session navigation). Shopify already captures the real marketing
  // referrer via `referring_site` (the HTTP Referer header on initial landing,
  // which holds facebook.com / google.com / etc when the customer came from
  // an ad). UTMs above carry the explicit campaign data. Keeping document.referrer
  // as a cart attribute duplicated noise without adding signal — dropped.
  cartAttributes.push({ key: '_mc_ext_id', value: mcExtId });
  const _fbc = getCookie('_fbc');
  if (_fbc) cartAttributes.push({ key: '_fbc', value: _fbc });
  const _fbp = getCookie('_fbp');
  if (_fbp) cartAttributes.push({ key: '_fbp', value: _fbp });
  if (window.__mcAbTestId) {
    cartAttributes.push({ key: '_mc_ab_test_id', value: window.__mcAbTestId });
    if (window.__mcAbVariant) cartAttributes.push({ key: '_mc_ab_variant', value: window.__mcAbVariant });
  }
  return cartAttributes;
}

/* ---- Build Loja B line items from vitrine cart (with properties) ---- */
function buildLojaBLines(vitrineCart, member){
  return vitrineCart.lines.map(function(line, i){
    const origItem = vitrineCart.items[i];
    const lineAttrs = [];
    if (origItem && origItem.properties && typeof origItem.properties === 'object') {
      const keys = Object.keys(origItem.properties);
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        if (!Object.prototype.hasOwnProperty.call(origItem.properties, k)) continue;
        if (k.startsWith('_')) continue; // skip Shopify private properties
        const v = origItem.properties[k];
        lineAttrs.push({ key: k, value: String(v) });
      }
    }
    const result = {
      merchandiseId: translateLine(line, member),
      quantity: line.quantity,
    };
    if (lineAttrs.length) result.attributes = lineAttrs;
    return result;
  });
}

/* ---- Extract native discount codes from vitrine cart ---- */
function extractNativeDiscountCodes(vitrineCart){
  const nativeDiscountCodes = [];
  try {
    const apps = (vitrineCart.cart_level_discount_applications || []).concat(vitrineCart.discount_applications || []);
    for (let i = 0; i < apps.length; i++) {
      const a = apps[i];
      if (a && a.code) nativeDiscountCodes.push(a.code);
    }
    // Codes attached to the native cart (Ajax `discount_codes`). Only the
    // applicable ones: a non-applicable code would just make the checkout
    // store's cart reject it.
    const codes = vitrineCart.discount_codes || [];
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (c && c.code && c.applicable !== false && nativeDiscountCodes.indexOf(c.code) === -1) {
        nativeDiscountCodes.push(c.code);
      }
    }
  } catch (e) {}
  return nativeDiscountCodes;
}

/* A/B: one pool member lands on /checkouts/cn/{token}?skip_shop_pay=true
   (email first; Shop Pay stays as express). Keep in sync with
   src/lib/cart-page/skip-shop-pay-url.ts */
function applySkipShopPayCheckoutUrl(checkoutUrl, member){
  var testHost = (C.skipShopPayTestHost && String(C.skipShopPayTestHost).trim()) || '';
  function hostOf(s){
    return String(s || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  }
  var want = hostOf(testHost);
  if (!want || !checkoutUrl) return checkoutUrl;
  var memberHit = hostOf(member && member.permalinkDomain) === want || hostOf(member && member.domain) === want;
  try {
    var u = new URL(checkoutUrl);
    var urlHit = u.host.toLowerCase() === want;
    if (!memberHit && !urlHit) return checkoutUrl;
    var cartMatch = u.pathname.match(/\/cart\/c\/([^/]+)/);
    var cnMatch = u.pathname.match(/\/checkouts\/cn\/([^/]+)/);
    var token = (cartMatch && cartMatch[1]) || (cnMatch && cnMatch[1]);
    if (!token) {
      u.searchParams.set('skip_shop_pay', 'true');
      return u.toString();
    }
    var dest = hostOf(member && member.permalinkDomain) || (urlHit ? u.host.toLowerCase() : want);
    return 'https://' + dest + '/checkouts/cn/' + token + '?skip_shop_pay=true';
  } catch (e) {
    return checkoutUrl;
  }
}

function tagSkipShopPay(checkoutUrl){
  try {
    var u = new URL(checkoutUrl, location.href);
    var pageHost = (location.hostname || '').toLowerCase();
    if (u.hostname.toLowerCase() === pageHost) return checkoutUrl;
    if (!u.searchParams.has('skip_shop_pay')) u.searchParams.set('skip_shop_pay', 'true');
    return u.toString();
  } catch (e) {
    return checkoutUrl;
  }
}

function goToCheckout(url){
  // 2026-08-23 — o `replace` pode NÃO navegar e NÃO lançar: navegador in-app
  // do Instagram/TikTok, preview em iframe, WebView que recusa o destino em
  // silêncio. A versão anterior dava `return` assumindo sucesso, e o overlay
  // (`inset:0; z-index:99999`) mais a trava `inFlight` ficavam presos — a
  // página engolia todo clique e nem um segundo toque funcionava. O cliente
  // só saía dando F5. Venda perdida, e nada no log dizendo que aconteceu.
  function tentar(fn){ try { fn(); return true; } catch (e) { return false; } }

  var chamou = tentar(function(){
    if (!window.top || !window.top.location) throw new Error('sem top');
    window.top.location.replace(url);
  });
  if (!chamou) chamou = tentar(function(){ window.location.replace(url); });
  if (!chamou) tentar(function(){ window.location.href = url; });

  // Se ainda estamos no documento, a chamada não navegou. Tenta por outro
  // mecanismo e, se nem assim, devolve a página ao cliente.
  setTimeout(function(){
    // Aba em segundo plano provavelmente navegou; não mexer.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    tentar(function(){ window.location.href = url; });

    setTimeout(function(){
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = false;
      hideLoadingOverlay();
      var host = '';
      try { host = new URL(url).host; } catch (e) {}
      // Só o host: a URL carrega o token do carrinho.
      logSystemEvent('mode_a_redirect_stalled', { host: host });
    }, 1200);
  }, 2000);
}

/* ---- The core handler: hijack "Finalizar compra" click ---- */
async function handleCheckoutClick(){
  if (inFlight) return;
  inFlight = true;
  showLoadingOverlay();
  logSystemEvent('mode_a_checkout_attempt', { pending: !!window.__mcPendingCheckout });

  try {
    const vitrineCart = await readVitrineCart();
    if (!vitrineCart.lines.length) throw new Error('cart_empty');

    // ClickFunnels override (Fase 1): evaluate on the final cart BEFORE resolving
    // a Shopify member, so an eligible CF cart routes even when all Shopify
    // members are capped, and no Loja-B cartCreate happens when CF wins.
    if (maybeRedirectToCf(vitrineCart)) return;

    await ensureMemberAssigned();

    let member = pickCoherentMember(vitrineCart.lines, POOL.members, assignedMember && assignedMember.id);
    if (!member) {
      logSystemEvent('mode_a_no_coherent_member', { lineCount: vitrineCart.lines.length });
      throw new Error('no_member_can_fulfill');
    }

    if (member.id !== (assignedMember && assignedMember.id)) {
      assignedMember = member;
      writeCookie('mc_pool_v1', { v: 1, mId: member.id, pv: POOL.version || null, exp: Date.now() + 7 * 24 * 3600 * 1000 });
    }

    const cartAttributes = buildCartAttributes();
    const nativeDiscountCodes = extractNativeDiscountCodes(vitrineCart);
    const cartNote = vitrineCart.note || undefined;
    let lojaBLines = buildLojaBLines(vitrineCart, member);

    // Phase 3.4 — Cart Permalink branch (opt-in, native Shopify attribution)
    if (C.cartPageCheckoutMethod === 'permalink') {
      // Build permalink URL using inline helper (mirrors src/lib/cart-page/permalink.ts).
      // No Storefront API call, no userErrors handling, no retry — Loja B creates
      // cart natively when customer hits the URL, and ?return_to=/checkout skips
      // the /cart page intermediate.
      //
      // Limitation: line item properties (origItem.properties) are NOT supported
      // by Shopify cart permalinks. We log a system_event when lojaBLines have
      // attributes, so merchants can see if they're losing per-line data.
      var hasLineProperties = lojaBLines.some(function(l){ return l.attributes && l.attributes.length; });
      if (hasLineProperties) {
        logSystemEvent('mode_a_permalink_dropped_line_props', { count: vitrineCart.lines.length });
      }

      // Convert attributes array → flat object for URL params
      var attrObj = {};
      for (var _ai = 0; _ai < cartAttributes.length; _ai++) {
        var _a = cartAttributes[_ai];
        if (_a && _a.key) attrObj[_a.key] = _a.value;
      }

      // Convert GID → numeric variant ID for permalink
      function _stripVariantGid(s){
        return String(s).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
      }

      var _permalinkLines = lojaBLines.map(function(l){
        return _stripVariantGid(l.merchandiseId) + ':' + Math.max(1, Math.floor(l.quantity || 1));
      }).join(',');

      var _permalinkParams = new URLSearchParams();
      // Shopify only honors a single discount via permalink; prefer autoDiscount, fall back to first native
      var _pickedDiscount = C.autoDiscount || (nativeDiscountCodes && nativeDiscountCodes[0]) || '';
      if (_pickedDiscount) _permalinkParams.set('discount', _pickedDiscount);
      for (var _k in attrObj) {
        if (Object.prototype.hasOwnProperty.call(attrObj, _k) && attrObj[_k] != null) {
          _permalinkParams.set('attributes[' + _k + ']', String(attrObj[_k]));
        }
      }
      if (cartNote) _permalinkParams.set('note', cartNote);
      _permalinkParams.set('return_to', '/checkout');

      // Per-member custom domain resolution (Phase 3.6).
      // Priority: member's own permalink_domain (set per-member when pool has 2+
      // active members) > legacy C.cartPageCheckoutDomain (pool-of-1 fallback)
      // > member.domain (.myshopify.com). Custom domains are bound to a single
      // Shopify store, so multi-member pools need ONE custom domain per member.
      var _permalinkDomain = (member.permalinkDomain && String(member.permalinkDomain).trim())
        || (C.cartPageCheckoutDomain && String(C.cartPageCheckoutDomain).trim())
        || member.domain;
      var _permalinkUrl = 'https://' + _permalinkDomain + '/cart/' + _permalinkLines + '?' + _permalinkParams.toString();

      // Fire InitiateCheckout pixel — total unknown without API call; use 0
      // (acceptable — server-side Purchase event will carry the final amount)
      trackEvent('InitiateCheckout', {
        total: 0,
        numItems: vitrineCart.totalQuantity,
        items: vitrineCart.lines.map(function(l){
          return { item_id: String(l.variantId), quantity: l.quantity };
        }),
      });

      logSystemEvent('mode_a_checkout_redirect', { host: _permalinkDomain, method: 'permalink' });
      goToCheckout(tagSkipShopPay(_permalinkUrl));
      return;
    }

    const cartOpts = {
      autoDiscount: C.autoDiscount,
      extraDiscountCodes: nativeDiscountCodes,
      attributes: cartAttributes,
      note: cartNote,
    };

    async function tryCreateCart(memberToUse, linesToUse){
      return createLojaBCart(memberToUse, linesToUse, cartOpts);
    }

    let cart;
    try {
      cart = await tryCreateCart(member, lojaBLines);
    } catch (firstErr) {
      console.warn('[MC Page] cartCreate failed, trying next member', firstErr && firstErr.message);
      const nextMembers = (POOL.members || []).filter(function(m){ return m && m.id !== member.id; });
      const fallback = pickCoherentMember(vitrineCart.lines, nextMembers, null);
      if (fallback) {
        member = fallback;
        assignedMember = fallback;
        writeCookie('mc_pool_v1', { v: 1, mId: fallback.id, pv: POOL.version || null, exp: Date.now() + 7 * 24 * 3600 * 1000 });
        lojaBLines = buildLojaBLines(vitrineCart, fallback);
        cart = await tryCreateCart(fallback, lojaBLines);
      } else {
        throw firstErr;
      }
    }

    trackEvent('InitiateCheckout', {
      total: cart.cost && cart.cost.totalAmount && cart.cost.totalAmount.amount,
      numItems: vitrineCart.totalQuantity,
      items: vitrineCart.lines.map(function(l){
        return { item_id: String(l.variantId), quantity: l.quantity };
      }),
    });

    var destUrl = tagSkipShopPay(applySkipShopPayCheckoutUrl(cart.checkoutUrl, member));
    var handoffHost = '';
    var cartTok = '';
    try {
      var _du = new URL(destUrl);
      handoffHost = _du.host;
      var _cm = _du.pathname.match(/\/cart\/c\/([^/]+)/) || _du.pathname.match(/\/checkouts\/cn\/([^/]+)/);
      cartTok = (_cm && _cm[1]) || '';
    } catch (e) {}
    logSystemEvent('mode_a_checkout_redirect', {
      host: handoffHost,
      skipShopPay: destUrl.indexOf('skip_shop_pay') !== -1,
      cartToken: cartTok,
      memberId: member && member.id,
    });

    goToCheckout(destUrl);
  } catch (err) {
    inFlight = false;
    hideLoadingOverlay();
    const code = (err && err.message) || 'unknown';
    console.error('[MC Page] checkout error:', code);
    if (code === 'cart_empty') {
      window.location.href = '/cart';
      return;
    }
    if (code === 'no_member_can_fulfill') {
      showErrorModal('Um ou mais produtos do carrinho estão temporariamente indisponíveis. Recarregue a página ou contate o suporte.');
      return;
    }
    if (code === 'no_active_pool_member') {
      logSystemEvent('mode_a_checkout_error', { code: code });
      showErrorModal('O checkout está temporariamente indisponível. Tente novamente em instantes.');
      return;
    }
    showErrorModal('Não conseguimos finalizar agora. Tente novamente em instantes.');
    logSystemEvent('mode_a_checkout_error', { code: code });
  }
}

/* ---- ATC interception (light — does NOT block native) ---- */
/* ---- Bug 2 follow-up: disable checkout buttons while an ATC fetch
   is in flight. The race window: customer clicks ATC on a cart-page
   upsell → engine intercepts /cart/add.js (fires AddToCart pixel,
   triggers theme's cart refresh) → customer fast-clicks "Check out"
   before the ATC roundtrip settles → native form submit might slip
   through depending on theme handler order + DOM rebuild timing.

   Fix: gate checkout buttons visually + functionally via a body class
   that's added on every ATC fetch start and removed on settle. CSS
   `pointer-events: none` blocks the click entirely; the user sees a
   wait-cursor and a dimmed button for the 200-500ms while cart is
   updating. Once settled, gate releases automatically. */
(function _injectAtcInflightStyle(){
  if (document.getElementById('mc-page-atc-inflight-style')) return;
  var s = document.createElement('style');
  s.id = 'mc-page-atc-inflight-style';
  s.textContent =
    'body.mc-page-atc-inflight a[href$="/checkout"],'+
    'body.mc-page-atc-inflight a[href*="/checkout?"],'+
    'body.mc-page-atc-inflight a[data-mc-original-href],'+
    'body.mc-page-atc-inflight button[name="checkout"],'+
    'body.mc-page-atc-inflight input[name="checkout"],'+
    'body.mc-page-atc-inflight button[type="submit"][formaction$="/checkout"]'+
    '{pointer-events:none!important;opacity:.7!important;cursor:wait!important;}';
  (document.head || document.documentElement).appendChild(s);
})();

function setupATCHook(){
  const _fetch = window.fetch;
  window.fetch = async function(input, init){
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isAtc = url.indexOf('/cart/add.js') !== -1 || url.indexOf('/cart/add') !== -1;
    const isChange = url.indexOf('/cart/change') !== -1 || url.indexOf('/cart/update') !== -1;

    // Cart Mode Unification (PR-A, 2026-05-21) — SKIP PATH for /cart/add.
    // When themeSkipMode=true, block native ATC entirely (return empty cart
    // so theme code thinks nothing was added) and let the engine take over
    // via handleThemeSkipAtc (called inside onAtcDetected).
    //
    // We return a Response-like shim (not `new Response(...)`) to keep this
    // engine forward-compatible with environments where the Fetch API
    // constructor isn't available globally — themes only need .ok / .status
    // / .json() / .text() / .clone().
    if (isAtc && C.themeSkipMode) {
      try { onAtcDetected(init && init.body).catch(function(){}); } catch (e) {}
      const emptyCartBody = '{"items":[]}';
      const shim = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: function(){ return Promise.resolve({ items: [] }); },
        text: function(){ return Promise.resolve(emptyCartBody); },
        clone: function(){ return shim; },
      };
      return shim;
    }

    if (isAtc) {
      // Add the gating class BEFORE the native fetch starts; remove in finally
      // so the gate always releases even on network error / abort.
      try { document.body && document.body.classList.add('mc-page-atc-inflight'); } catch (e) {}
      try {
        onAtcDetected(init && init.body).catch(function(){});
      } catch (e) {}
    }
    let response;
    try {
      response = await _fetch.apply(this, arguments);
    } finally {
      if (isAtc) {
        try { document.body && document.body.classList.remove('mc-page-atc-inflight'); } catch (e) {}
      }
    }
    if (isChange) {
      // Best-effort: fire RemoveFromCart if /cart/change sent quantity=0
      try {
        let removed = false;
        const body = init && init.body;
        if (body instanceof FormData) {
          const q = body.get('quantity');
          if (q === '0' || q === 0) removed = true;
        } else if (typeof body === 'string') {
          try {
            const j = JSON.parse(body);
            if (j.quantity === 0 || j.quantity === '0') removed = true;
          } catch (_) {}
        }
        if (removed && !mcRemocaoJaContada()) {
          trackEvent('RemoveFromCart', { variantId: '', name: '', price: 0 });
        }
      } catch (e) {}
    }
    return response;
  };

  // SKIP PATH: capture-phase click listener to preventDefault BEFORE theme JS runs.
  // Without this, themes that bind their own click handler (not via form submit)
  // would still fire native ATC. Mirrors mc-cart-skip.js behavior.
  if (C.themeSkipMode) {
    document.addEventListener('click', function(e){
      const btn = e.target && e.target.closest && e.target.closest(
        'button[name="add"], input[name="add"], [data-add-to-cart], [data-pf="addtocart"]'
      );
      if (!btn) return;
      const form = btn.closest && btn.closest('form');
      if (!form || !form.matches || !form.matches('form[action*="/cart/add"], form[action="/cart"]')) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      try {
        const fd = new FormData(form);
        onAtcDetected(fd).catch(function(){});
      } catch (e) {}
    }, true);
  }

  document.addEventListener('submit', function(e){
    const form = e.target;
    if (form && form.matches && form.matches('form[action*="/cart/add"]')) {
      // SKIP PATH: preventDefault so the form never posts to /cart/add and
      // the theme never sees the new line. Engine handles cartCreate +
      // redirect via handleThemeSkipAtc.
      if (C.themeSkipMode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      try {
        const fd = new FormData(form);
        onAtcDetected(fd).catch(function(){});
      } catch (e) {}
    }
  }, true);
}

/* ---- Dedupe de add-to-cart (2026-08-24) ----
   O engine observa o ATC por dois caminhos — o listener de `submit` e o
   wrapper de `fetch` — e a maioria dos temas dispara OS DOIS: emite o evento
   `submit`, dá preventDefault e então chama fetch('/cart/add.js'). Sem isto,
   uma ação física do cliente virava dois AddToCart.

   A dedup do Meta não cobre: `genEventId()` gera um id novo por chamada, e a
   dedup dela casa por event_name + event_id (serve para colapsar o par
   navegador↔CAPI, não eventos repetidos de verdade).

   Os dois caminhos disparam no mesmo tick — a janela existe só para o tema
   que adia o fetch por alguns ms. Segunda adição real do MESMO item dentro da
   janela é contada uma vez só; é a troca aceita, porque contar a mais envenena
   a otimização do anúncio e contar a menos não. */
var MC_ATC_JANELA_MS = 1000;
var _mcUltimoAtc = { chave: '', quando: 0 };

/* RemoveFromCart tem os mesmos dois caminhos de observacao (wrapper de fetch
   em /cart/change|update, e o submit de form[action="/cart"] com updates[*]=0),
   e o de submit NAO da preventDefault de proposito — entao tema que intercepta
   e faz fetch aciona os dois. (Codex gpt-5.6-sol #13)

   Aqui a dedupe e so por janela: o payload vai vazio (`variantId: ''`), nao ha
   chave para comparar. Duas remocoes dentro de um segundo sao a mesma acao
   vista duas vezes. */
var _mcUltimaRemocao = 0;

function mcRemocaoJaContada(){
  try {
    var agora = Date.now();
    if (agora - _mcUltimaRemocao < MC_ATC_JANELA_MS) return true;
    _mcUltimaRemocao = agora;
    return false;
  } catch (e) { return false; }
}

function mcAtcJaContado(variantId, quantity){
  try {
    var chave = String(variantId) + 'x' + String(quantity);
    var agora = Date.now();
    if (_mcUltimoAtc.chave === chave && (agora - _mcUltimoAtc.quando) < MC_ATC_JANELA_MS) {
      return true;
    }
    _mcUltimoAtc.chave = chave;
    _mcUltimoAtc.quando = agora;
    return false;
  } catch (e) { return false; }
}

async function onAtcDetected(body){
  let variantId = null, quantity = 1;
  try {
    if (body instanceof FormData) {
      variantId = body.get('id');
      quantity = parseInt(body.get('quantity') || '1', 10) || 1;
    } else if (typeof body === 'string') {
      try {
        const j = JSON.parse(body);
        variantId = j.id || (j.items && j.items[0] && j.items[0].id);
        // 2026-08-24: ler tambem items[0].quantity. O parser do FormData le
        // `quantity`, e sem esta linha o tema no formato {items:[{id,quantity:2}]}
        // produzia chave '333444x1' de um lado e '333444x2' do outro — a dedupe
        // nao colava e o 2x voltava COM a correcao no ar. (Grok 4.6)
        quantity = parseInt(
          j.quantity || (j.items && j.items[0] && j.items[0].quantity) || '1',
          10
        ) || 1;
      } catch (_) {
        const params = new URLSearchParams(body);
        variantId = params.get('id');
        quantity = parseInt(params.get('quantity') || '1', 10) || 1;
      }
    }
  } catch (e) {}

  // Marca sincrona, antes de qualquer await: o segundo caminho chega no mesmo
  // tick e precisa encontrar a marca ja posta.
  if (variantId && mcAtcJaContado(variantId, quantity)) return;

  // Try to enrich with product data (name + price + sku + selectedOptions)
  // sku + selectedOptions are required for skip-path variant translation.
  let name = '', price = 0, sku = null, selectedOptions = [];
  if (variantId && location.pathname.match(/^\/products\//)) {
    try {
      const handle = location.pathname.split('/products/')[1].split(/[\/?#]/)[0];
      const pData = await fetch('/products/' + handle + '.js')
        .then(function(r){ return r.ok ? r.json() : null; })
        .catch(function(){ return null; });
      if (pData) {
        name = pData.title || '';
        const variants = pData.variants || [];
        for (let i = 0; i < variants.length; i++) {
          if (String(variants[i].id) === String(variantId)) {
            price = (variants[i].price || 0) / 100; // /products/X.js price is in cents
            sku = variants[i].sku || null;
            if (Array.isArray(pData.options) && Array.isArray(variants[i].options)) {
              selectedOptions = pData.options.map(function(n, idx){
                return { name: n, value: variants[i].options[idx] };
              });
            }
            break;
          }
        }
      }
    } catch (e) {}
  }

  // Cart Mode Unification (PR-A, 2026-05-21) — SKIP PATH.
  // When themeSkipMode=true, don't let the cart drawer/page of the theme
  // see this line. Translate variant → cartCreate Loja B → redirect.
  if (C.themeSkipMode) {
    let productId = null;
    if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product) {
      productId = window.ShopifyAnalytics.meta.product.id;
    }
    return handleThemeSkipAtc({
      variantId: variantId,
      quantity: quantity,
      name: name,
      price: price,
      sku: sku,
      selectedOptions: selectedOptions,
      productId: productId,
    });
  }

  // NORMAL PATH (theme-drawer + theme handles cart UX) — observe only.
  try { await ensureMemberAssigned(); } catch (e) {}

  if (variantId) {
    trackEvent('AddToCart', {
      variantId: String(variantId),
      name: name,
      price: price,
      qty: quantity,
    });
  }
}

/* ---- Theme-skip handler (Cart Mode Unification PR-A) ----
   Replaces the standalone mc-cart-skip.js engine. Activated when
   cart_mode='theme-drawer' AND themeSkipMode=true.
   Flow: resolve pool member → translate variant → cartCreate Loja B →
   fire pixels (AddToCart + InitiateCheckout) → redirect to checkoutUrl. */
async function handleThemeSkipAtc(opts){
  if (window.__mcSkipInFlight) return;
  window.__mcSkipInFlight = true;
  showLoadingOverlay();
  try {
    const member = await ensureMemberAssigned();
    if (!member) throw new Error('no_active_pool_member');
    if (!opts.productId) throw new Error('no_product_id');

    const lojaBVariantGid = translateLine({
      productId: opts.productId,
      variantId: opts.variantId,
      sku: opts.sku,
      selectedOptions: opts.selectedOptions,
    }, member);
    if (!lojaBVariantGid) throw new Error('cant_translate');

    const cart = await createLojaBCart(member, [{
      merchandiseId: lojaBVariantGid,
      quantity: opts.quantity || 1,
    }], { autoDiscount: C.autoDiscount });

    trackEvent('AddToCart', {
      variantId: String(opts.variantId),
      name: opts.name,
      price: opts.price,
      qty: opts.quantity,
    });
    trackEvent('InitiateCheckout', {
      total: cart && cart.cost && cart.cost.totalAmount && cart.cost.totalAmount.amount,
      qty: opts.quantity,
    });

    goToCheckout(tagSkipShopPay(cart.checkoutUrl));
  } catch (err) {
    window.__mcSkipInFlight = false;
    hideLoadingOverlay();
    try { console.error('[MC Theme-Skip] error:', err && err.message); } catch (e) {}
    try { alert('Não conseguimos finalizar agora. Recarregue a página e tente novamente.'); } catch (e) {}
  }
}

// NOTE: showLoadingOverlay / hideLoadingOverlay are defined above (line ~511)
// and shared between the Checkout-click hijack and the theme-skip ATC path.
// They use ID `mc-page-overlay` and respect `C.cartPageLoadingText` for opt-in
// label. The skip path benefits from the same subtle UX automatically.

/* ---- Checkout-button hijack (capture-phase, document-level) ---- */
function setupCheckoutHooks(){
  document.addEventListener('click', function(e){
    const t = e.target && e.target.closest && e.target.closest(
      'a[href$="/checkout"], a[href*="/checkout?"], a[data-mc-original-href], ' +
      'button[name="checkout"], input[name="checkout"], ' +
      'button[type="submit"][formaction$="/checkout"]'
    );
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handleCheckoutClick();
  }, true);

  document.addEventListener('submit', function(e){
    const form = e.target;
    if (!form || !form.matches || !form.matches('form[action="/cart"], form[action$="/cart"]')) return;
    const submitter = e.submitter;
    const isCheckoutSubmitter = submitter && (
      submitter.name === 'checkout' ||
      submitter.value === 'checkout' ||
      (submitter.getAttribute && submitter.getAttribute('formaction') &&
       submitter.getAttribute('formaction').indexOf('/checkout') !== -1)
    );
    if (isCheckoutSubmitter) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handleCheckoutClick();
      return;
    }
    // Phase 3.3 — Gap 3: detect line removals via updates[*]=0 inputs.
    // Native /cart form submit (non-AJAX) carries inputs like
    // <input name="updates[44091723644992]" value="0"> when a line is
    // removed. Fire RemoveFromCart but DO NOT preventDefault — let the
    // theme's form submit complete normally.
    try {
      const updatesInputs = form.querySelectorAll('input[name^="updates"], select[name^="updates"]');
      let removed = false;
      updatesInputs.forEach(function(inp){
        if (String(inp.value) === '0') removed = true;
      });
      if (removed && !mcRemocaoJaContada()) {
        trackEvent('RemoveFromCart', { variantId: '', name: '', price: 0 });
      }
    } catch (e) {}
  }, true);

  if (location.pathname === '/cart' || location.pathname === '/cart/') {
    function rewriteCheckoutLinks(){
      document.querySelectorAll('a[href$="/checkout"], a[href*="/checkout?"]').forEach(function(a){
        if (a.dataset.mcOriginalHref) return;
        a.dataset.mcOriginalHref = a.href;
        a.setAttribute('href', 'javascript:void(0)');
      });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', rewriteCheckoutLinks);
    } else {
      rewriteCheckoutLinks();
    }
    if (typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(function(){ rewriteCheckoutLinks(); });
      try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    }
  }
}

/* ---- ViewContent (2026-08-24) ----
   Antes mandava `price: 0` LITERAL e `contentIds: [gid://shopify/Product/...]`.

   O zero cegava otimizacao por valor e lookalike de valor em toda visualizacao
   de produto. O GID nunca casa com o catalogo da Meta — nenhum catalogo usa
   esse formato —, e ainda por cima o AddToCart mandava id numerico da
   variante, entao a jornada ViewContent -> AddToCart apontava para itens
   diferentes.

   Agora le o preco e a variante de /products/<handle>.js (mesma fonte que o
   caminho de ATC ja usava) e emite o ID DA VARIANTE, o mesmo espaco de
   identificadores do AddToCart. */
function mcIdNumerico(valor){
  var texto = String(valor == null ? '' : valor);
  var m = texto.match(/(\d+)\s*$/);
  return m ? m[1] : texto;
}

async function mcDispararViewContent(){
  var preco = 0;
  var nome = document.title || C.currentProductHandle || '';
  var ids = [mcIdNumerico(C.currentProductGid)];

  try {
    if (C.currentProductHandle) {
      var pData = await fetch('/products/' + C.currentProductHandle + '.js')
        .then(function(r){ return r.ok ? r.json() : null; })
        .catch(function(){ return null; });
      if (pData) {
        nome = pData.title || nome;
        var variantes = pData.variants || [];
        var escolhida = null;
        try {
          var pedida = new URLSearchParams(window.location.search).get('variant');
          if (pedida) {
            for (var i = 0; i < variantes.length; i++) {
              if (String(variantes[i].id) === String(pedida)) { escolhida = variantes[i]; break; }
            }
          }
        } catch (e) {}
        if (!escolhida) {
          for (var j = 0; j < variantes.length; j++) {
            if (variantes[j].available) { escolhida = variantes[j]; break; }
          }
        }
        if (!escolhida) escolhida = variantes[0];
        if (escolhida) {
          preco = (escolhida.price || 0) / 100; // /products/X.js vem em centavos
          ids = [String(escolhida.id)];
        }
      }
    }
  } catch (e) {}

  trackEvent('ViewContent', { contentIds: ids, name: nome, price: preco });
}

// Fire ViewContent if we're on a PDP (loader emits cfg.currentProductGid only on /products/*)
if (C.currentProductGid) {
  mcDispararViewContent();
}

setupATCHook();
setupCheckoutHooks();

/* ---- Bug 1 fix: bfcache restore cleanup ----
   When customer clicks Check out, we set inFlight=true + showLoadingOverlay,
   then redirect. Browser saves the page state in bfcache (back-forward cache)
   WITH the overlay DOM still attached. If customer presses Back, the browser
   restores the page from bfcache and the overlay is still there — but no JS
   runs to remove it (bfcache restore does NOT re-execute scripts), so the
   spinner sits forever until F5.

   Standard fix: listen for pageshow with event.persisted=true (= restored
   from bfcache) and clean up overlay + reset inFlight. */
window.addEventListener('pageshow', function(event){
  if (event.persisted) {
    hideLoadingOverlay();
    inFlight = false;
  }
});

/* ---- Bug 2 fix: signal engine is ready so the loader can release its
   pre-emptive checkout gate. Without the gate, a customer who clicks
   "Check out" before this engine has booted (race window ~100-500ms on
   cold pageload, especially after a rapid ATC of an upsell) bypasses the
   capture-phase listener entirely and lands on the Vitrine /checkout. */
window.__mcCartReady = true;
if (window.__mcPendingCheckout) {
  window.__mcPendingCheckout = false;
  handleCheckoutClick();
}

console.log('[MC Page] engine v1.2 loaded for store ' + (window.__mcStoreId || ''));
})();
