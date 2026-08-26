/* ============================================================
   MC Cart Engine v2.0
   Reads window.mcCartConfig and renders a full cart drawer
   using Shopify Storefront API.
   ============================================================ */
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

(function(){
'use strict';

const C = window.mcCartConfig;
if (!C) return console.error('MC Cart: window.mcCartConfig not found');

/* ---- Checkout Pool (Phase 1 — spec § 9.2) ----
   The loader emits window.mcCartConfig.pool = { assigned, members, availability }.
   - Legacy / pool-of-1: pool.assigned is set (or pool is absent) — behave as before.
   - Pool-of-N: pool.assigned is null. First add-to-cart calls /api/pool/resolve
     to lock in a sticky member; subsequent calls reuse activeMemberId.
   API / HDR are `let` (not const) so they can be re-pointed at the resolved member.
*/
function getActiveCheckout(){
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  if (pool && pool.assigned) {
    return {
      memberId: pool.assigned.memberId,
      domain: pool.assigned.domain,
      storefrontToken: pool.assigned.storefrontToken,
    };
  }
  // Pool-of-N with no pre-resolved member. Default to the first listed member
  // (the loader orders primary first via getActivePoolMembers ORDER BY
  // is_primary DESC). Init hooks like initPageVariants query the Storefront
  // API before the user clicks Add to Cart, and they need valid credentials.
  // When the user actually adds to cart, ensureActiveCheckoutForAdd calls
  // /api/pool/resolve which may override to the bucketed member.
  if (pool && Array.isArray(pool.members) && pool.members.length > 0) {
    var first = pool.members[0];
    if (first && first.domain && first.storefrontToken) {
      return {
        memberId: first.id,
        domain: first.domain,
        storefrontToken: first.storefrontToken,
      };
    }
  }
  // Legacy single-checkout path. The loader always emits a `pool` object
  // (even an empty one for non-pool tenants), so we can't gate this on
  // `!pool` — that branch is now dead. Fall through here whenever neither
  // pool.assigned nor pool.members yielded credentials, including the
  // pool-disabled case where pool === { assigned: null, members: [], availability: {} }.
  // Without this fallback, API stays '' and fetch posts to the current page URL → 404.
  var legacyDomain = window.mcCartConfig && (window.mcCartConfig.checkout_domain || window.mcCartConfig.domain);
  var legacyToken = window.mcCartConfig && (window.mcCartConfig.checkout_token || window.mcCartConfig.token);
  if (legacyDomain && legacyToken) {
    return {
      memberId: null,
      domain: legacyDomain,
      storefrontToken: legacyToken,
    };
  }
  return null;
}

function poolAvailabilityFor(sku){
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  if (!pool || !pool.availability) return null;
  return pool.availability[sku] || null;
}

function getPoolStoreId(){
  return window.__mcStoreId || (window.mcCartConfig && window.mcCartConfig.store_id) || '';
}

function getPoolOrigin(){
  if (window.mcCartConfig && window.mcCartConfig.app_origin) return window.mcCartConfig.app_origin;
  // Derive from __mcTrackUrl if present (e.g. "https://www.mcsync.app/api/track")
  try {
    if (window.__mcTrackUrl) {
      var u = new URL(window.__mcTrackUrl);
      return u.origin;
    }
  } catch(e) {}
  return 'https://www.mcsync.app';
}

function getPoolVisitorId(){
  try {
    var cached = localStorage.getItem('mc_pool_visitor');
    if (cached) return cached;
    var id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (String(Date.now()) + '.' + Math.random().toString(36).slice(2));
    localStorage.setItem('mc_pool_visitor', id);
    return id;
  } catch(e) {
    return 'anon-' + Date.now();
  }
}

async function resolvePoolMember(sku, primaryProductGid){
  var storeId = getPoolStoreId();
  if (!storeId) return null;
  var origin = getPoolOrigin();
  var body = { visitorId: getPoolVisitorId(), storeId: storeId };
  if (sku) body.sku = sku;
  if (primaryProductGid) body.primaryProductGid = primaryProductGid;
  try {
    var res = await fetch(origin + '/api/pool/resolve', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    var json = await res.json();
    // assigned = { memberId, domain, storefrontToken, productGid, variantsBySku }
    // productGid is the MEMBER'S gid (translated from primary's), or null if
    // no translation was possible. Phase 1.5.
    return json.assigned || null;
  } catch(e) {
    return null;
  }
}

async function reportMemberFailure(memberId, failureCode, detail){
  if (!memberId) return;
  var storeId = getPoolStoreId();
  if (!storeId) return;
  var origin = getPoolOrigin();
  try {
    await fetch(origin + '/api/pool/member-failure', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberId, storeId: storeId, failureCode: failureCode, detail: detail || '' }),
    });
  } catch(e) { /* best-effort */ }
}

// Phase 1.5: replaced broken `fallbackToNativeCart` (which posted a productGid
// to /cart/add and got "Cannot find variant"). Shows an inline error in the
// cart drawer instead. Caller should ALREADY have opened the drawer via mcOpen().
function showCartError(reason){
  try {
    var body = document.querySelector('.mc-body');
    if (!body) {
      console.error('MC Cart: error ' + reason + ' (drawer not mounted)');
      return;
    }
    var msg = 'Não foi possível adicionar o produto no momento. Tente recarregar a página ou tente novamente em alguns segundos.';
    body.innerHTML =
      '<div style="padding:40px 24px;text-align:center">' +
      '  <div style="font-size:38px;margin-bottom:12px">⚠️</div>' +
      '  <p style="font-size:15px;line-height:1.5;color:#dc2626;font-weight:600;margin:0 0 8px">' + msg + '</p>' +
      '  <p style="font-size:12px;color:#666;margin:0 0 20px">Código: ' + String(reason || 'unknown') + '</p>' +
      '  <button onclick="window.mcClose && window.mcClose()" style="padding:10px 24px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer">Fechar</button>' +
      '</div>';
  } catch(e) {
    console.error('MC Cart: showCartError failed', e);
  }
}

// Active checkout state. Mutated by applyActiveCheckout() when the pool resolves
// a sticky member. API and HDR are read by gql() below — keep them `let`.
let activeMemberId = null;
// Sprint 2 P0-2: variant translation maps are now scoped by MEMBER productGid
// (the gid of the product in the active member's store). Previously these
// were flat `{[sku]: variantId}` dicts — when a customer added two different
// products in one session, the second resolve would overwrite the first
// (SKUs collide, options keys are per-product), silently translating bundle/
// upsell clicks for product A to whatever variant of product B happened to
// share the same SKU. Keying by productGid solves both same-SKU collisions
// across products AND lets translateVariantId pick the right product context.
//
// Shape: { [memberProductGid]: { [sku]: variantId } }
//                              { [optionsKey]: variantId }
let activeVariantsBySkuByProduct = {};
let activeVariantsByOptionsByProduct = {};
// `activeMemberProductGid` is the LAST-RESOLVED member productGid (most
// recent /api/pool/resolve hit). Used as a fallback hint when callers don't
// pass a productGid into translateVariantId. The slow-path query in
// translateVariantId scopes by whichever productGid was passed in.
let activeMemberProductGid = null;
// PR #92: reverse product mapping for the currently-active pool member.
// Key = member's productGid (both gid://shopify/Product/... and raw numeric
// id forms), value = corresponding primary productGid. Built from
// `member.productMappings` in the loader emission. Used by mcItemPasses
// to reverse-translate cart line productIds (which come from the member's
// cartLinesAdd response) back to primary productGids — so upsell/addon/
// bundle trigger rules (baked in cart_config with PRIMARY productGids)
// still match when the cart is served from a secondary.
let activeMemberReverseProductMap = {};
let API = '';
let HDR = {'Content-Type':'application/json'};

function applyActiveCheckout(active){
  if (!active || !active.domain || !active.storefrontToken) return false;
  var prevMemberId = activeMemberId;
  activeMemberId = active.memberId || null;
  API = `https://${active.domain}/api/2024-10/graphql.json`;
  HDR = {'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':active.storefrontToken};
  // When the member changes, previous translation data is stale for the new
  // store. Init paths (initActiveCheckout) pass neither field — that's
  // correct because primary's IDs already match what the theme embedded, so
  // no translation is needed.
  if (prevMemberId !== activeMemberId) {
    activeVariantsBySkuByProduct = {};
    activeVariantsByOptionsByProduct = {};
    activeMemberProductGid = null;
    activeMemberReverseProductMap = {};
    // Rebuild the reverse product map from the new active member's
    // productMappings (loader now emits these per PR #92). Empty for
    // primary (loader emits full mappings but primary.productMappings is
    // typically {} in DB — primary doesn't map to itself) and for legacy
    // tenants without pool.
    var pool = window.mcCartConfig && window.mcCartConfig.pool;
    var members = pool && Array.isArray(pool.members) ? pool.members : [];
    for (var mi = 0; mi < members.length; mi++) {
      if (!members[mi] || members[mi].id !== activeMemberId) continue;
      var pm = members[mi].productMappings || {};
      for (var primaryGid in pm) {
        var mapping = pm[primaryGid];
        var memberGid = mapping && mapping.memberProductGid;
        if (!memberGid) continue;
        activeMemberReverseProductMap[memberGid] = primaryGid;
        var rawMem = String(memberGid).split('/').pop();
        if (rawMem) activeMemberReverseProductMap[rawMem] = primaryGid;
      }
      break;
    }
  }
  // Sprint 2 P0-2: MERGE variantsBySku/Options into the per-product map keyed
  // by the resolved member productGid. Previously these dicts were flat and
  // got overwritten on every resolve — adding product B silently invalidated
  // the lookup for product A even though both lived under the same member.
  // Now each product keeps its own entry, so subsequent translateVariantId
  // calls can pick the right product's table.
  if (active.productGid) {
    activeMemberProductGid = active.productGid;
    var key = active.productGid;
    if (active.variantsBySku && typeof active.variantsBySku === 'object') {
      activeVariantsBySkuByProduct[key] = Object.assign(
        {},
        activeVariantsBySkuByProduct[key] || {},
        active.variantsBySku
      );
      // Index under the raw numeric form too so callers that pass either
      // gid://shopify/Product/123 or "123" hit the same bucket.
      var rawKey = String(key).split('/').pop();
      if (rawKey && rawKey !== key) {
        activeVariantsBySkuByProduct[rawKey] = activeVariantsBySkuByProduct[key];
      }
    }
    if (active.variantsByOptions && typeof active.variantsByOptions === 'object') {
      activeVariantsByOptionsByProduct[key] = Object.assign(
        {},
        activeVariantsByOptionsByProduct[key] || {},
        active.variantsByOptions
      );
      var rawKey2 = String(key).split('/').pop();
      if (rawKey2 && rawKey2 !== key) {
        activeVariantsByOptionsByProduct[rawKey2] = activeVariantsByOptionsByProduct[key];
      }
    }
  }
  return true;
}

// Initialize from whichever path is available right now. Legacy tenants get the
// direct checkout_domain/checkout_token read; pool-of-1 tenants get pool.assigned;
// pool-of-N tenants start with pool.members[0] (primary) as a default so any
// synchronous Storefront call fires against a valid token — see PR #74 for
// why that matters for initPageVariants. bootstrapActiveMember() below runs
// async and overrides with the visitor's sticky member before fetchCart runs,
// so the cart doesn't get wiped when the sticky member differs from primary.
(function initActiveCheckout(){
  var active = getActiveCheckout();
  if (active) applyActiveCheckout(active);
})();

// Phase 1.5.8: pool-of-N async bootstrap. The sync init above defaults to
// primary for pool-of-N (no pool.assigned emitted), but the visitor's actual
// sticky member is determined server-side from the `mc_pool_v` cookie. If
// they're a secondary sticky, fetchCart on init queries primary with a
// secondary-scoped cartId, gets `data.cart === null`, then wipes
// localStorage.mc_cartId — user's cart silently evaporates on every page
// navigation. Resolve first (credentials:'include' ships the cookie),
// apply the sticky member, then let fetchCart hit the right Storefront.
async function bootstrapActiveMember(){
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  if (!pool || !Array.isArray(pool.members) || pool.members.length === 0) return;
  // Legacy pool-of-1 already handled via pool.assigned + sync initActiveCheckout.
  if (pool.assigned) return;
  try {
    var resolved = await resolvePoolMember(null, null);
    if (resolved && resolved.domain && resolved.storefrontToken) {
      applyActiveCheckout({
        memberId: resolved.memberId,
        domain: resolved.domain,
        storefrontToken: resolved.storefrontToken,
      });
    }
  } catch(e) {
    // Network failure: fetchCart stays pointed at the default (primary). Worst
    // case that's the same as before this fix — cart gets wiped if it belonged
    // to a secondary. Don't make a failed resolve block the rest of init.
    console.warn('MC Cart: bootstrapActiveMember failed — staying on default', e);
  }
}

// Resolve a pool member on add-to-cart when we don't have a sticky one yet,
// or when the sticky member doesn't have the requested SKU. Returns either the
// member-specific variant GID to add (may be null if none was returned), or
// throws to signal "pool exhausted — caller should fall back to native cart".
async function ensureActiveCheckoutForAdd(sku, variantGidIfKnown, primaryProductGid){
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  var havePool = !!(pool && Array.isArray(pool.members) && pool.members.length > 0);

  // Legacy / pool-of-1 with pool.assigned already applied — nothing to do.
  if (!havePool || (pool.assigned && activeMemberId)) {
    return { variantGid: variantGidIfKnown || null, productGid: null };
  }

  // Check SKU availability for the sticky member — re-resolve if it isn't in the
  // allowed list for this SKU.
  if (activeMemberId && sku) {
    var allowed = poolAvailabilityFor(sku);
    if (allowed && Array.isArray(allowed) && allowed.length && allowed.indexOf(activeMemberId) === -1) {
      activeMemberId = null; // force re-resolve below
    }
  }

  // Even when we have a sticky member, re-resolve if we have a primaryProductGid
  // so the translation (primary → member gid) runs. Phase 1.5: the translation
  // is cheap server-side; doing it on every add-to-cart keeps the logic simple.
  if (activeMemberId && !primaryProductGid) {
    return { variantGid: variantGidIfKnown || null, productGid: null };
  }

  var resolved = await resolvePoolMember(sku, primaryProductGid);
  if (!resolved || !resolved.domain || !resolved.storefrontToken) {
    var err = new Error('pool_no_eligible_member');
    err.poolExhausted = true;
    throw err;
  }
  applyActiveCheckout({
    memberId: resolved.memberId,
    domain: resolved.domain,
    storefrontToken: resolved.storefrontToken,
    productGid: resolved.productGid || null,
    variantsBySku: resolved.variantsBySku || {},
    variantsByOptions: resolved.variantsByOptions || {},
  });
  return {
    variantGid: variantGidIfKnown || null,
    // resolved.productGid = MEMBER's productGid translated from the primary's
    // (for the `primaryProductGid` we passed). Null when no translation was
    // possible; caller should use the original productGid.
    productGid: resolved.productGid || null,
  };
}

// Classify a Storefront API error for member-failure reporting.
function classifyStorefrontError(err){
  if (!err) return '5xx';
  var msg = String(err.message || err);
  if (err.status === 401 || /401|unauthor/i.test(msg)) return '401';
  if (err.status === 410 || /410|gone/i.test(msg)) return '410';
  if (err.status && err.status >= 500) return '5xx';
  if (/5\d\d/.test(msg)) return '5xx';
  return '5xx';
}

// Phase 1.5.5: translate a PRIMARY-store variant GID into the active member's
// variant GID. The PDP was rendered with primary IDs (initPageVariants always
// runs against primary — getActiveCheckout defaults to members[0] on init per
// PR #74); calling cartLinesAdd on a non-primary member with a primary variant
// GID returns a null cart and the self-heal createCart then also fails. This
// helper is the runtime bridge until Phase 2 moves bucketing into the loader.
//
// Priority of lookups (PR #93):
//   (1) activeVariantsByOptionsByProduct[memberProductGid][optsKey] — when
//       selectedOptions passed, this is UNIQUE per variant even when multiple
//       variants share the same SKU.
//   (2) activeVariantsBySkuByProduct[memberProductGid][sku] — fast path for
//       products where each variant has a unique SKU.
//   (3) Slow path: query the member fresh for its product variants, prefer
//       matching by selectedOptions, fall back to SKU. Memoize both maps for
//       subsequent adds — keyed by memberProductGid so different products
//       don't clobber each other.
//   (4) Last resort: return primaryVariantId unchanged; the downstream
//       Storefront error flows through classifyStorefrontError as before.
//
// Sprint 2 P0-2: `memberProductGidHint` lets callers pass the EXACT product
// context (member-translated GID) so SKU/options lookups don't bleed across
// products. Falls back to activeMemberProductGid (last-resolved) when the
// hint is absent — matches pre-Sprint-2 behavior for legacy callers.
async function translateVariantId(primaryVariantId, sku, selectedOptions, memberProductGidHint){
  if (!activeMemberId || !primaryVariantId) return primaryVariantId;
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  if (!pool || !Array.isArray(pool.members) || pool.members.length === 0) {
    return primaryVariantId;
  }
  // If the active member IS the primary, the theme's embedded IDs already match.
  var primary = pool.members.find(function(m){ return m && m.is_primary; });
  if (primary && activeMemberId === primary.id) return primaryVariantId;

  // Determine which member product to scope this lookup to. Prefer the hint
  // (caller knows exactly which product they're translating); fall back to
  // last-resolved for legacy callers that don't pass one.
  var scopeGid = memberProductGidHint || activeMemberProductGid || null;
  var rawScopeGid = scopeGid ? String(scopeGid).split('/').pop() : null;

  function pickFromMap(byProduct, k) {
    if (!byProduct || !k) return null;
    if (scopeGid && byProduct[scopeGid] && byProduct[scopeGid][k]) {
      return byProduct[scopeGid][k];
    }
    if (rawScopeGid && byProduct[rawScopeGid] && byProduct[rawScopeGid][k]) {
      return byProduct[rawScopeGid][k];
    }
    return null;
  }

  // (1) selectedOptions-first lookup. Unambiguous even when SKUs collide.
  var optsKey = _mcOptionsKey(selectedOptions);
  if (optsKey) {
    var hitOpts = pickFromMap(activeVariantsByOptionsByProduct, optsKey);
    if (hitOpts) return hitOpts;
  }

  // (2) SKU-keyed fast path for products with unique SKUs per variant.
  if (sku) {
    var hitSku = pickFromMap(activeVariantsBySkuByProduct, sku);
    if (hitSku) return hitSku;
  }

  // (3) Slow path: neither fast-path lookup hit, so query the member product
  // fresh. Need at least one identifier (optsKey or sku) AND a known member
  // productGid to scope the query.
  if ((!optsKey && !sku) || !scopeGid) return primaryVariantId;
  try {
    var data = await gql(
      `query($id:ID!){product(id:$id){variants(first:100){edges{node{id sku selectedOptions{name value}}}}}}`,
      { id: scopeGid }
    );
    var edges = data && data.product && data.product.variants && data.product.variants.edges;
    if (!edges) return primaryVariantId;
    // Build BOTH SKU-keyed and options-keyed fresh maps. Memoize into the
    // per-product maps so subsequent calls hit the fast path without re-
    // querying — and so other products' tables aren't disturbed.
    var freshBySku = {};
    var freshByOptions = {};
    for (var i = 0; i < edges.length; i++) {
      var n = edges[i] && edges[i].node;
      if (!n) continue;
      if (n.sku) freshBySku[n.sku] = n.id;
      var nOptsKey = _mcOptionsKey(n.selectedOptions);
      if (nOptsKey) freshByOptions[nOptsKey] = n.id;
    }
    activeVariantsBySkuByProduct[scopeGid] = Object.assign(
      {},
      activeVariantsBySkuByProduct[scopeGid] || {},
      freshBySku
    );
    activeVariantsByOptionsByProduct[scopeGid] = Object.assign(
      {},
      activeVariantsByOptionsByProduct[scopeGid] || {},
      freshByOptions
    );
    if (rawScopeGid && rawScopeGid !== scopeGid) {
      activeVariantsBySkuByProduct[rawScopeGid] = activeVariantsBySkuByProduct[scopeGid];
      activeVariantsByOptionsByProduct[rawScopeGid] = activeVariantsByOptionsByProduct[scopeGid];
    }
    // Prefer options-keyed match when available (unambiguous for shared-SKU
    // products); fall back to SKU-keyed match; last to primary unchanged.
    if (optsKey && freshByOptions[optsKey]) return freshByOptions[optsKey];
    if (sku && freshBySku[sku]) return freshBySku[sku];
    return primaryVariantId;
  } catch(e) {
    console.warn('MC Cart: translateVariantId fallback query failed', e);
    return primaryVariantId;
  }
}

// Diagnostic helper — dump everything the cart engine knows at this moment.
// Exposed on window so it can be called from DevTools console without relying
// on source-mapped internals. Returns plain JSON so the result can be copied
// straight into a bug report. No PII, no tokens.
window.__mcCartDebug = function(){
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  // Sprint 2 P0-2: maps are now per-product. Surface both the product-keyed
  // view and a flattened total count so legacy debug expectations still work.
  var perProductSkuCounts = {};
  var totalSkuEntries = 0;
  for (var pgid in (activeVariantsBySkuByProduct || {})) {
    var inner = activeVariantsBySkuByProduct[pgid] || {};
    var c = Object.keys(inner).length;
    perProductSkuCounts[pgid] = c;
    totalSkuEntries += c;
  }
  return {
    activeMemberId: activeMemberId,
    activeMemberProductGid: activeMemberProductGid,
    activeVariantsBySkuCount: totalSkuEntries,
    activeVariantsBySkuByProduct: activeVariantsBySkuByProduct,
    activeVariantsBySkuPerProductCounts: perProductSkuCounts,
    cartId: cartId,
    cartLinesCount: Array.isArray(cartLines) ? cartLines.length : 0,
    poolPresent: !!pool,
    poolMemberCount: pool && Array.isArray(pool.members) ? pool.members.length : 0,
    poolMemberIds: pool && Array.isArray(pool.members) ? pool.members.map(function(m){ return { id: m.id, is_primary: !!m.is_primary }; }) : [],
    poolAssignedMemberId: pool && pool.assigned ? pool.assigned.memberId : null,
    poolAvailabilitySkuCount: pool && pool.availability ? Object.keys(pool.availability).length : 0,
    pageProductGid: (typeof pageProductData !== 'undefined' && pageProductData) ? pageProductData.id : null,
    pageProductVariantCount: (typeof pageProductData !== 'undefined' && pageProductData && pageProductData.variants) ? pageProductData.variants.length : 0,
  };
};

const CUR = C.currency || '$';
const COL = C.colors || {};
const TXT = C.texts || {};

/* ---- Vitrine Image Helper ---- */
const VIM = C.vitrineImageMap || {};
// PR #91: secondary index keyed by `productGid|optionsKey`. Covers the case
// where a product's variants share the same SKU (so the SKU-keyed map from
// PR #89 collapses them all to one image). Cart engine builds the same
// canonical key populate-vitrine-images wrote: lowercased name=value pairs,
// sorted, joined by "|".
const VIM_BY_OPTIONS = C.variantImagesByOptions || {};
const USE_VIM = !!C.useVitrineImages;

function _mcOptionsKey(selectedOptions){
  if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) return '';
  var parts = [];
  for (var i = 0; i < selectedOptions.length; i++) {
    var o = selectedOptions[i];
    if (o && o.name && o.value) {
      parts.push(String(o.name).toLowerCase() + '=' + String(o.value).toLowerCase());
    }
  }
  if (parts.length === 0) return '';
  parts.sort();
  return parts.join('|');
}

// Resolve image with a 4-tier fallback:
//   (1) VIM[variantGid] — direct variant GID lookup (PRs #79, #88, #89).
//       Covers the common case (SKU unique per variant, or member variantGid
//       registered via PR #88/#89).
//   (2) VIM_BY_OPTIONS[productGid|optionsKey] — PR #91 selectedOptions
//       fallback. Covers shared-SKU-across-variants where (1) misses on
//       secondaries because populate-vitrine-images' SKU index collapsed
//       N variants into one entry.
//   (3) VIM[productGid] — product-level featured image. Last resort before
//       falling off to the checkout's own image.
//   (4) checkoutUrl — raw image from cartLinesAdd. Native when USE_VIM is
//       off or when no vitrine image is available at all.
function mcImg(checkoutUrl, variantGid, productGid, selectedOptions){
  if (!USE_VIM) return checkoutUrl || '';
  if (VIM[variantGid]) return VIM[variantGid];
  if (selectedOptions && productGid) {
    var optsKey = _mcOptionsKey(selectedOptions);
    if (optsKey) {
      var k = productGid + '|' + optsKey;
      if (VIM_BY_OPTIONS[k]) return VIM_BY_OPTIONS[k];
      // Raw numeric id form — matches the dual gid + raw emission the
      // loader does for the other maps, for cases where a downstream path
      // passes the short id instead of the full gid.
      var rawProd = String(productGid).split('/').pop();
      if (rawProd) {
        var k2 = rawProd + '|' + optsKey;
        if (VIM_BY_OPTIONS[k2]) return VIM_BY_OPTIONS[k2];
      }
    }
  }
  if (VIM[productGid]) return VIM[productGid];
  return checkoutUrl || '';
}
// Conditional display rule check for upsell/addon/bundle items.
// If item._trigger is set, only render the item when the cart contains
// a line whose product matches trigger.productGid AND any of whose
// selectedOptions has value === trigger.optionValue (case-insensitive).
// This powers the "show this upsell only when cart has cup color X"
// feature configured in the dashboard.
function mcItemPasses(item){
  var t = item && item._trigger;
  if(!t || !t.productGid || !t.optionValue) return true;
  var targetGid = String(t.productGid);
  // Strip prefix to allow matching against either form the cart line stores
  var targetRawId = targetGid.split('/').pop();
  var targetVal = String(t.optionValue).toLowerCase();
  for(var i=0;i<cartLines.length;i++){
    var line = cartLines[i];
    if(!line) continue;
    var lineProductId = String(line.productId || '');
    var lineRawProduct = lineProductId.split('/').pop();
    var productMatch = lineProductId === targetGid || lineRawProduct === targetRawId;
    // PR #92: when cart is served from a non-primary pool member, line.productId
    // is the MEMBER's productGid; trigger.productGid is always the PRIMARY's
    // (baked into cart_config at dashboard save time). Direct comparison fails.
    // Reverse-translate line.productId → primary via
    // activeMemberReverseProductMap (built in applyActiveCheckout from the
    // active member's productMappings) and compare again.
    if (!productMatch) {
      var reversed = activeMemberReverseProductMap[lineProductId] || activeMemberReverseProductMap[lineRawProduct];
      if (reversed) {
        var reversedStr = String(reversed);
        var reversedRaw = reversedStr.split('/').pop();
        productMatch = reversedStr === targetGid || reversedRaw === targetRawId;
      }
    }
    if(!productMatch) continue;
    var opts = line.selectedOptions || [];
    for(var j=0;j<opts.length;j++){
      if(opts[j] && String(opts[j].value || '').toLowerCase() === targetVal) return true;
    }
  }
  return false;
}

// For upsell/addon/bundle items: VIM is the source of truth (rebuilt fresh
// every page load from product_mappings). item.vitrineImage is a stale copy
// baked into cart_config when the merchant ran the populate sync, and gets
// invalidated whenever Loja B is reconnected (variant IDs change). We try
// VIM first by raw variantId / productId / GIDs, then fall back to the baked
// copy, then to the raw checkout image.
function mcItemImg(item){
  if(!USE_VIM) return item.image || '';
  if(item.variantId){
    var v = VIM[item.variantId] || VIM['gid://shopify/ProductVariant/'+item.variantId];
    if(v) return v;
  }
  if(item.productId){
    var p = VIM[item.productId] || VIM['gid://shopify/Product/'+item.productId];
    if(p) return p;
  }
  return item.vitrineImage || item.image || '';
}

/* ---- State ---- */
let cartId = localStorage.getItem('mc_cartId') || null;
let cartLines = []; // {lineId, variantId, productId, title, variant, price, comparePrice, qty, image, selectedOptions}
let cartNote = '';
let addonChecked = {}; // variantId -> bool
let timerInterval = null;
let timerSeconds = 0;
let drawerOpen = false;
let cartCost = null; // {subtotalAmount:{amount}, totalAmount:{amount}} from API
let productCache = {}; // productGid -> {options, variants}

/* ---- Helpers ---- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => {const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;};
const fmt = n => parseFloat(n).toFixed(2);

/* ---- Tracking ---- */
function trackEvent(eventName, data){
  try{
    const cur = getCurrencyCode();
    const w = window;
    const found = [];
    // Gerar event_id unico para deduplicacao browser + server
    const eventId = genEventId();
    // Meta Pixel (fbq) — com eventID para deduplicar com CAPI
    if(w.fbq && typeof w.fbq==='function'){
      found.push('fbq');
      if(eventName==='ViewContent') w.fbq('track','ViewContent',{content_ids:data.contentIds||[],content_type:'product',content_name:data.name||'',value:parseFloat(data.price)||0,currency:cur},{eventID:eventId});
      else if(eventName==='AddToCart') w.fbq('track','AddToCart',{content_name:data.name,content_ids:[data.variantId],content_type:'product',value:parseFloat(data.price),currency:cur,num_items:data.qty||1},{eventID:eventId});
      else if(eventName==='InitiateCheckout') w.fbq('track','InitiateCheckout',{value:parseFloat(data.total),currency:cur,num_items:data.numItems,content_type:'product'},{eventID:eventId});
      else if(eventName==='RemoveFromCart') w.fbq('trackCustom','RemoveFromCart',{content_name:data.name,content_ids:[data.variantId],content_type:'product'},{eventID:eventId});
    }
    // Google Analytics 4 (gtag)
    if(w.gtag && typeof w.gtag==='function'){
      found.push('gtag');
      if(eventName==='AddToCart') w.gtag('event','add_to_cart',{currency:cur,value:parseFloat(data.price),items:[{item_id:data.variantId,item_name:data.name,price:parseFloat(data.price),quantity:data.qty||1}]});
      else if(eventName==='InitiateCheckout') w.gtag('event','begin_checkout',{currency:cur,value:parseFloat(data.total),items:data.items||[]});
      else if(eventName==='RemoveFromCart') w.gtag('event','remove_from_cart',{currency:cur,items:[{item_id:data.variantId,item_name:data.name}]});
    }
    // Google Tag Manager (dataLayer)
    if(w.dataLayer && Array.isArray(w.dataLayer)){
      found.push('dataLayer');
      if(eventName==='AddToCart') w.dataLayer.push({event:'add_to_cart',ecommerce:{currency:cur,value:parseFloat(data.price),items:[{item_id:data.variantId,item_name:data.name,price:parseFloat(data.price),quantity:data.qty||1}]}});
      else if(eventName==='InitiateCheckout') w.dataLayer.push({event:'begin_checkout',ecommerce:{currency:cur,value:parseFloat(data.total),items:data.items||[]}});
      else if(eventName==='RemoveFromCart') w.dataLayer.push({event:'remove_from_cart',ecommerce:{items:[{item_id:data.variantId,item_name:data.name}]}});
    }
    // TikTok Pixel
    if(w.ttq && w.ttq.track){
      found.push('ttq');
      if(eventName==='AddToCart') w.ttq.track('AddToCart',{content_id:data.variantId,content_name:data.name,value:parseFloat(data.price),currency:cur});
      else if(eventName==='InitiateCheckout') w.ttq.track('InitiateCheckout',{value:parseFloat(data.total),currency:cur});
    }
    // Google Ads Conversions
    if(C.gadsConversionId){
      var g = w.gtag;
      if(g && typeof g==='function'){
        if(eventName==='ViewContent' && C.gadsPageViewLabel){
          g('event','conversion',{send_to: C.gadsConversionId+'/'+C.gadsPageViewLabel});
          found.push('gads');
        }
        else if(eventName==='AddToCart' && C.gadsAddToCartLabel){
          g('event','conversion',{send_to: C.gadsConversionId+'/'+C.gadsAddToCartLabel, value: parseFloat(data.price)||0, currency: cur});
          found.push('gads');
        }
        else if(eventName==='InitiateCheckout' && C.gadsCheckoutLabel){
          g('event','conversion',{send_to: C.gadsConversionId+'/'+C.gadsCheckoutLabel, value: parseFloat(data.total)||0, currency: cur});
          found.push('gads');
        }
      }
    }
    // Meta Conversions API (server-side)
    if(C.capiEndpoint){
      found.push('CAPI');
      sendCAPI(eventName, data, cur, eventId);
    }
    // Always log tracking for debugging (visible in browser console)
    console.log('%c[MC Cart Track]%c '+eventName+' → '+found.join(', ')+' | currency: '+cur, 'background:#59493a;color:#fff;padding:2px 6px;border-radius:3px','color:#59493a', data);
    if(!found.length && !C.capiEndpoint) console.warn('[MC Cart] No tracking pixels found on page. Make sure Meta Pixel (fbq), gtag, dataLayer, or ttq are loaded BEFORE mc-cart.');
    // A/B test impression tracking (fires once per page load when test is active)
    if(window.__mcAbTestId && !window.__mcAbImpSent){
      window.__mcAbImpSent=true;
      if(window.__mcStoreId&&window.__mcTrackUrl){
        try{fetch(window.__mcTrackUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:window.__mcStoreId,ab_test_id:window.__mcAbTestId,ab_variant:window.__mcAbVariant,ab_visitor_id:window.__mcAbVisitorId,ab_event:'impression'}),keepalive:true}).catch(()=>{});}catch(e){}
      }
    }
  }catch(e){console.warn('MC Cart: tracking error',e);}
}

/* ---- Meta Conversions API (Server-Side) ---- */
function getCookie(name){try{const m=document.cookie.match(new RegExp('(^| )'+name+'=([^;]+)'));return m?m[2]:'';}catch(e){return '';}}
function setCookie(name,value,maxAgeDays){try{document.cookie=name+'='+value+';path=/;max-age='+(maxAgeDays*86400)+';SameSite=Lax';}catch(e){}}
function genEventId(){return Date.now().toString(36)+'.'+Math.random().toString(36).substr(2,8);}

/* ---- Stable order-event id for /api/track idempotency ----
   Espelha a regra de src/lib/ingest/client-event-id.ts (fonte testável).
   Devolve um id ESTÁVEL por carrinho: re-firar o checkout do MESMO carrinho
   (retry do keepalive, clique duplo, reload + novo checkout) reusa o id e o
   backend deduplica; carrinhos diferentes recebem ids diferentes e NUNCA
   colapsam dois pedidos legítimos. Persistido em sessionStorage p/ sobreviver a
   reload, e LIMPO após o checkout (ver mcCheckout) — o cartId persiste no
   localStorage e não é zerado pela compra, então um 2º checkout do mesmo cart
   na mesma sessão deve gerar id novo, não reusar o anterior.
   Inócuo com a flag INGEST_DEDUPE_ENABLED OFF: o backend ignora o campo.
   cartId nulo → sempre id novo (sem carrinho não há "mesmo evento" a deduplicar). */
function mcEventTokenNew(){
  try{ if(window.crypto&&window.crypto.randomUUID) return window.crypto.randomUUID(); }catch(e){}
  return Date.now().toString(36)+'.'+Math.random().toString(36).slice(2,12);
}
function mcCheckoutEventId(cartId){
  var key = (typeof cartId==='string') ? cartId.trim() : '';
  if(!key) return mcEventTokenNew();
  var sk = 'mc_evt:'+key;
  try{
    var existing = sessionStorage.getItem(sk);
    if(existing) return existing;
    var fresh = mcEventTokenNew();
    sessionStorage.setItem(sk, fresh);
    return fresh;
  }catch(e){
    // sessionStorage indisponível (modo privado/quota): id novo, sem persistir.
    return mcEventTokenNew();
  }
}

/* ---- External ID (persistent anonymous identifier for Meta matching) ---- */
function getMcExtId(){
  let id = getCookie('_mc_ext_id');
  if(!id){
    id = 'mc.'+Date.now().toString(36)+'.'+Math.random().toString(36).substr(2,12);
    setCookie('_mc_ext_id', id, 365);
  }
  return id;
}
const mcExtId = getMcExtId();

/* ---- First-Party FBC Cookie (survives Safari ITP) ---- */
(function persistFbc(){
  try{
    var fbclid = mcFbclidCru();
    // ⛔ nao sobrescrever o _fbc do fbevents.js (timestamp do clique)
    if(fbclid && !getCookie('_fbc')){
      setCookie('_fbc', 'fb.1.'+Date.now()+'.'+fbclid, 90);
    }
  }catch(e){}
})();

/* ---- First-Party GCLID Cookie (for Google Ads server-side conversions) ---- */
(function persistGclid(){
  try{
    const p = new URLSearchParams(window.location.search);
    const gclid = p.get('gclid');
    if(gclid) setCookie('_mc_gclid', gclid, 90);
  }catch(e){}
})();

/* ---- Google Ads gtag.js loader (reuses existing gtag if loaded by GA4/GTM) ---- */
if(C.gadsConversionId){
  if(!window.gtag){
    var _gadsScript = document.createElement('script');
    _gadsScript.async = true;
    _gadsScript.src = 'https://www.googletagmanager.com/gtag/js?id=' + C.gadsConversionId;
    document.head.appendChild(_gadsScript);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){window.dataLayer.push(arguments);};
    window.gtag('js', new Date());
  }
  window.gtag('config', C.gadsConversionId, {allow_enhanced_conversions: true});
}

function sendCAPI(eventName, data, cur, eventId){
  try{
    // Map event names to Meta standard events
    const metaEventMap = {ViewContent:'ViewContent',AddToCart:'AddToCart',InitiateCheckout:'InitiateCheckout',RemoveFromCart:'RemoveFromCart'};
    const metaEvent = metaEventMap[eventName];
    if(!metaEvent) return;

    if(!eventId) eventId = genEventId();
    const fbp = getCookie('_fbp');
    const fbc = getCookie('_fbc') || (function(){
      // fbclid CRU: URLSearchParams decodifica e este fbc vai direto no evento CAPI (fix #469)
      const fbclid = mcFbclidCru();
      if(fbclid) return 'fb.1.'+Date.now()+'.'+fbclid;
      return '';
    })();

    // Build custom_data based on event type
    let custom_data = {};
    if(eventName==='ViewContent'){
      custom_data = {
        content_ids: data.contentIds||[],
        content_type: 'product',
        content_name: data.name||'',
        value: parseFloat(data.price)||0,
        currency: cur,
      };
    } else if(eventName==='AddToCart'){
      custom_data = {
        value: parseFloat(data.price)||0,
        currency: cur,
        content_ids: [data.variantId],
        content_name: data.name,
        content_type: 'product',
        num_items: data.qty||1,
      };
    } else if(eventName==='InitiateCheckout'){
      custom_data = {
        value: parseFloat(data.total)||0,
        currency: cur,
        num_items: data.numItems||0,
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
      }]
    };

    // Send to server (fire-and-forget, non-blocking)
    fetch(C.capiEndpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
      keepalive: true,
    }).then(r=>r.json()).then(res=>{
      if(res.success) console.log('%c[MC CAPI]%c '+metaEvent+' sent ✓ (events_received: '+res.events_received+')', 'background:#1877F2;color:#fff;padding:2px 6px;border-radius:3px','color:#1877F2');
      else console.warn('[MC CAPI] Error:', res);
    }).catch(e=>console.warn('[MC CAPI] Network error:', e.message));
  }catch(e){console.warn('[MC CAPI] Error:', e);}
}

/* ---- UTM Capture ---- */
function getUTMs(){
  try{
    const params = new URLSearchParams(window.location.search);
    const utms = {};
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','ttclid','ref','msclkid','li_fat_id','mc_cid','mc_eid'].forEach(k=>{
      // fbclid nunca via URLSearchParams: ela decodifica, e este valor vira
      // note_attributes → fbc do Purchase no servidor (fix #469)
      const v = (k==='fbclid') ? mcFbclidCru() : params.get(k);
      if(v) utms[k] = v;
    });
    // Capture _ga cookie for GA cross-domain
    try{const ga=document.cookie.split(';').find(c=>c.trim().startsWith('_ga='));if(ga)utms['_ga']=ga.split('=').slice(1).join('=').trim();}catch(e){}
    return utms;
  }catch(e){return {};}
}
// Capture UTMs on page load — save to BOTH sessionStorage and localStorage
// sessionStorage = current session, localStorage = persists across sessions (first-touch attribution)
const pageUTMs = getUTMs();
console.log('%c[MC Cart]%c Initialized | UTMs on page: '+(Object.keys(pageUTMs).length?JSON.stringify(pageUTMs):'(none)') +' | Pixels: '+(window.fbq?'fbq✓':'fbq✗')+' '+(window.gtag?'gtag✓':'gtag✗')+' '+(window.dataLayer?'dL✓':'dL✗')+' '+(window.ttq?'ttq✓':'ttq✗'), 'background:#59493a;color:#fff;padding:2px 6px;border-radius:3px','color:#59493a');
if(Object.keys(pageUTMs).length > 0){
  // MC Sync email UTMs always take priority — overwrite everything
  // so the order attribution correctly reflects the email click-through.
  // Ad platform tracking (Meta Pixel, CAPI, Google, TikTok) is independent
  // and unaffected by UTM changes here.
  if(pageUTMs.utm_source === 'mcsync'){
    sessionStorage.setItem('mc_utms', JSON.stringify(pageUTMs));
    localStorage.setItem('mc_utms_first', JSON.stringify(pageUTMs));
    localStorage.setItem('mc_utms_last', JSON.stringify(pageUTMs));
  } else {
    sessionStorage.setItem('mc_utms', JSON.stringify(pageUTMs));
    if(!localStorage.getItem('mc_utms_first')) localStorage.setItem('mc_utms_first', JSON.stringify(pageUTMs));
    localStorage.setItem('mc_utms_last', JSON.stringify(pageUTMs));
  }
}
function getSavedUTMs(){
  try{
    // Priority: sessionStorage (current session) > localStorage last-touch > localStorage first-touch
    const session = sessionStorage.getItem('mc_utms');
    if(session){ const parsed=JSON.parse(session); if(Object.keys(parsed).length>0) return parsed; }
    const last = localStorage.getItem('mc_utms_last');
    if(last){ const parsed=JSON.parse(last); if(Object.keys(parsed).length>0) return parsed; }
    const first = localStorage.getItem('mc_utms_first');
    if(first) return JSON.parse(first);
    return {};
  }catch(e){return {};}
}
// Helper: get ISO currency code from symbol
function getCurrencyCode(){
  const raw = (C.currencyCode || C.currency || 'USD').replace(/[^A-Za-z]/g,'');
  return raw.length === 3 ? raw.toUpperCase() : 'USD';
}

/* ---- CSS (all scoped with .mc-) ---- */
function injectStyles(){
  if ($('#mc-cart-styles')) return;
  const bg = COL.bg||'#FFFFFF', accent = COL.accent||'#f6f6f7', text = COL.text||'#000',
        sav = COL.savings||'#2ea818', btn = COL.button||'#000', btnT = COL.buttonText||'#fff',
        btnR = COL.buttonRadius??0, tog = COL.toggle||btn;
  const hdr = C.header||{};
  const s = document.createElement('style'); s.id='mc-cart-styles';
  s.textContent = `
@keyframes mc-spin{to{transform:rotate(360deg)}}
@keyframes mc-slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
@keyframes mc-fadeIn{from{opacity:0}to{opacity:1}}
@keyframes mc-pulse{0%,100%{opacity:1}50%{opacity:.4}}

.mc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99998;opacity:0;transition:opacity .3s;pointer-events:none}
.mc-overlay.mc-open{opacity:1;pointer-events:auto}

.mc-drawer{position:fixed;top:0;right:0;width:420px;max-width:100vw;height:100vh;height:100dvh;background:${bg};z-index:99999;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:13px;color:${text};box-shadow:-4px 0 30px rgba(0,0,0,.12);-webkit-font-smoothing:antialiased}
.mc-drawer.mc-open{transform:translateX(0)}

.mc-header{display:flex;align-items:center;padding:${hdr.height==='tall'?'20px':'14px'} 16px;background:${hdr.bg||'#fff'};border-bottom:${hdr.border!==false?'1px solid #e8e8e8':'none'}}
.mc-header-title{flex:1;font-size:16px;font-weight:700;text-align:${hdr.align||'left'}}
.mc-header-count{font-weight:400;color:#888}
.mc-close{background:none;border:none;font-size:22px;cursor:pointer;color:${hdr.closeColor||'#637381'};padding:4px 8px;line-height:1}

.mc-body{flex:1;overflow-y:auto;overscroll-behavior:contain}
.mc-body::-webkit-scrollbar{width:4px}.mc-body::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}

.mc-empty{padding:60px 20px;text-align:center;color:#888;font-size:14px}
.mc-empty svg{margin-bottom:16px;opacity:.3}

/* Announce */
.mc-announce{padding:10px 16px;text-align:center;font-size:12px;line-height:1.5}
.mc-announce b{font-weight:700}

/* Rewards */
.mc-rewards{padding:10px 16px;border-bottom:1px solid #eee}
.mc-rewards-text{font-size:11px;text-align:center;margin-bottom:6px}
.mc-rewards-bar{width:100%;height:5px;border-radius:3px;overflow:hidden}
.mc-rewards-fill{height:100%;border-radius:3px;transition:width .4s ease}

/* Line item */
.mc-item{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid #f0f0f0}
.mc-item-img{width:64px!important;height:64px!important;max-width:64px!important;border-radius:8px;object-fit:cover;background:#fff;flex-shrink:0}
.mc-item-info{flex:1;min-width:0}
.mc-item-top{display:flex;justify-content:space-between;gap:8px}
.mc-item-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-item-price{font-size:12px;font-weight:700;white-space:nowrap}
.mc-item-variant{font-size:10px;color:#888;margin-top:2px}
.mc-item-strike{text-decoration:line-through;color:#aaa;font-size:11px;margin-right:4px;font-weight:400}
.mc-item-savings{font-size:11px;color:${sav};font-weight:600;margin-top:2px}
.mc-item-bottom{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.mc-qty{display:inline-flex;align-items:center;border:1px solid #ddd;border-radius:20px;overflow:hidden}
.mc-qty button{width:28px;height:28px;border:none;background:transparent;font-size:15px;cursor:pointer;color:${text};display:flex;align-items:center;justify-content:center}
.mc-qty button:hover{background:#f5f5f5}
.mc-qty span{font-size:11px;font-weight:600;min-width:22px;text-align:center}
.mc-remove{font-size:10px;color:#999;cursor:pointer;text-decoration:underline;background:none;border:none;font-family:inherit}
.mc-remove:hover{color:#c00}

/* Variant selector */
.mc-var-group{margin-top:6px}
.mc-var-label{font-size:9px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.mc-var-opts{display:flex;flex-wrap:wrap;gap:4px}
.mc-var-pill{padding:3px 8px;border:1px solid ${(C.pillDesign||{}).border||'#ddd'};border-radius:${(C.pillDesign||{}).radius||4}px;font-size:10px;font-weight:500;cursor:pointer;background:none;color:${text};font-family:inherit;transition:all .15s;white-space:nowrap}
.mc-var-pill:hover{border-color:${(C.pillDesign||{}).activeBg||btn}}
.mc-var-pill.mc-var-active{border-color:${(C.pillDesign||{}).activeBg||btn};background:${(C.pillDesign||{}).activeBg||btn};color:${(C.pillDesign||{}).activeText||btnT}}
.mc-var-pill.mc-var-unavail{opacity:.35;cursor:not-allowed;text-decoration:line-through}
.mc-var-swatch{width:${(C.swatchDesign||{}).cartSize ?? 28}px;height:${(C.swatchDesign||{}).cartSize ?? 28}px;border-radius:${(C.swatchDesign||{}).radius||6}px;border:2px solid transparent;cursor:pointer;background:#f5f5f5;transition:all .15s;padding:0;overflow:hidden}
.mc-var-swatch:hover{border-color:${(C.swatchDesign||{}).activeBorder||btn}}
.mc-var-swatch.mc-var-active{border-color:${(C.swatchDesign||{}).activeBorder||btn};box-shadow:0 0 0 1px ${(C.swatchDesign||{}).activeBorder||btn}}
.mc-var-swatch.mc-var-unavail{opacity:.35;cursor:not-allowed}
.mc-var-swatch img{width:100%;height:100%;object-fit:cover;display:block;border-radius:${Math.max(0,((C.swatchDesign||{}).radius||6)-2)}px}
.mc-var-dropdown{width:100%;padding:6px 10px;border:1px solid ${(C.dropdownDesign||{}).border||'#ddd'};border-radius:${(C.dropdownDesign||{}).radius||6}px;font-size:11px;font-family:inherit;background:${(C.dropdownDesign||{}).bg||'#fff'};color:${(C.dropdownDesign||{}).text||text};cursor:pointer;outline:none}

/* Notes */
.mc-notes{padding:12px 16px;border-top:1px solid #f0f0f0}
.mc-notes-title{font-size:11px;font-weight:600;margin-bottom:6px}
.mc-notes textarea{width:100%;padding:8px;border:1px solid #e0e0e0;border-radius:6px;font-size:11px;resize:none;height:56px;font-family:inherit;color:${text};outline:none}
.mc-notes textarea:focus{border-color:${btn}}

/* Upsells */
.mc-upsells{padding:14px 16px;border-top:1px solid #f0f0f0}
.mc-upsells-title{font-size:13px;font-weight:700;margin-bottom:10px}
.mc-ups-scroll{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;cursor:grab;-webkit-overflow-scrolling:touch}
.mc-ups-scroll::-webkit-scrollbar{height:3px}.mc-ups-scroll::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
.mc-ups-scroll.mc-grabbing{cursor:grabbing;user-select:none}
.mc-ups-card{flex:0 0 110px;max-width:110px;text-align:center;box-sizing:border-box}
.mc-ups-card img{width:110px!important;height:110px!important;max-width:110px!important;border-radius:6px;object-fit:cover;background:#f5f5f5;border:1px solid #eee;display:block}
.mc-ups-card .mc-ups-name{font-size:10px;font-weight:500;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.mc-ups-card .mc-ups-price{font-size:10px;font-weight:700;margin-top:1px}
.mc-ups-card .mc-ups-add{margin-top:4px;background:none;border:1px solid #ddd;border-radius:14px;padding:3px 12px;font-size:9px;font-weight:600;cursor:pointer;color:${text};font-family:inherit;transition:all .15s}
.mc-ups-card .mc-ups-add:hover{border-color:${btn};background:${btn};color:${btnT}}

/* Block upsells */
.mc-ups-block{display:flex;flex-direction:column;gap:6px}
.mc-ups-block-item{display:flex;align-items:center;gap:10px;padding:8px;background:${accent};border-radius:8px}
.mc-ups-block-item img{width:44px!important;height:44px!important;max-width:44px!important;border-radius:6px;object-fit:cover}
.mc-ups-block-item .mc-ups-bi-info{flex:1;min-width:0}
.mc-ups-block-item .mc-ups-bi-name{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-ups-block-item .mc-ups-bi-price{font-size:11px;font-weight:700}
.mc-ups-block-item .mc-ups-bi-add{background:${btn};color:${btnT};border:none;border-radius:14px;padding:5px 12px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}

/* Add-ons */
.mc-addons{padding:12px 16px;border-top:1px solid #f0f0f0}
.mc-addon-row{display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:12px}
.mc-addon-row input[type="checkbox"]{width:16px;height:16px;accent-color:${tog};cursor:pointer}
.mc-addon-row img{width:30px;height:30px;border-radius:4px;object-fit:cover}
.mc-addon-row .mc-ao-name{flex:1;font-weight:500}
.mc-addon-row .mc-ao-price{font-weight:700}

/* Bundle */
.mc-bundle{margin:12px 16px;padding:16px;border-radius:12px}
.mc-bundle-inner{display:flex;align-items:flex-start;gap:12px}
.mc-bundle-info{flex:1;min-width:0}
.mc-bundle-title{font-size:14px;font-weight:700;margin-bottom:2px}
.mc-bundle-subtitle{font-size:11px;color:#888;margin-bottom:10px}
.mc-bundle-btn{background:#fff;border:1px solid #222;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:.5px;transition:all .15s}
.mc-bundle-btn:hover{background:#222;color:#fff}
.mc-bundle-images{display:flex;gap:8px;flex-shrink:0}
.mc-bundle-images img{width:70px!important;height:70px!important;max-width:70px!important;border-radius:8px;object-fit:cover;background:#f5f5f5}
.mc-bundle-images .mc-bundle-img-label{font-size:9px;color:#666;margin-top:3px;text-align:center;max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Discount */
.mc-discount{padding:12px 16px;border-top:1px solid #eee;display:flex;gap:6px}
.mc-discount input{flex:1;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:12px;font-family:inherit;outline:none;color:${text}}
.mc-discount input:focus{border-color:${btn}}
.mc-discount button{padding:8px 14px;background:${btn};color:${btnT};border:none;font-size:11px;font-weight:700;cursor:pointer;border-radius:${btnR}px;font-family:inherit;white-space:nowrap}

/* Trust */
.mc-trust{padding:10px 16px;border-top:1px solid #f0f0f0;display:flex;align-items:center;gap:6px;font-size:11px;color:#888}
.mc-trust svg{flex-shrink:0}

/* Footer */
.mc-footer{border-top:1px solid #e8e8e8;padding:14px 16px;background:${bg}}
.mc-subtotal-row{display:flex;justify-content:space-between;margin-bottom:4px}
.mc-subtotal-label{font-size:12px}
.mc-subtotal-val{font-size:16px;font-weight:700}
.mc-ship-note{font-size:10px;color:#888;margin-bottom:10px}
.mc-checkout-btn{width:100%;background:${btn};color:${btnT};border:none;padding:14px;font-size:12px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:1.5px;border-radius:${btnR}px;font-family:inherit;transition:opacity .2s}
.mc-checkout-btn:hover{opacity:.9}
.mc-continue{display:block;text-align:center;margin-top:8px;font-size:11px;color:#888;cursor:pointer;text-decoration:underline;background:none;border:none;font-family:inherit}

/* Recs (empty cart) */
.mc-recs{padding:20px 16px}
.mc-recs-title{font-size:13px;font-weight:600;text-align:center;margin-bottom:14px;color:#888}
.mc-recs-grid{display:flex;flex-direction:column;gap:8px}
.mc-recs-carousel{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}
.mc-rec-card{display:flex;align-items:center;gap:10px;padding:10px;background:#f5f5f5;border:1px solid #e8e8e8;border-radius:8px;cursor:pointer;transition:background .15s}
.mc-rec-card:hover{background:#ebebeb}
.mc-rec-card img{width:50px!important;height:50px!important;max-width:50px!important;border-radius:6px;object-fit:cover}
.mc-rec-card .mc-rec-info{flex:1;min-width:0}
.mc-rec-card .mc-rec-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-rec-card .mc-rec-price{font-size:12px;font-weight:700;margin-top:2px}
.mc-rec-card .mc-rec-add{background:${btn};color:${btnT};border:none;border-radius:14px;padding:5px 12px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}

/* Spinner */
.mc-spinner{display:inline-block;width:16px;height:16px;border:2px solid #ddd;border-top-color:${btn};border-radius:50%;animation:mc-spin .6s linear infinite}

/* Page-level variant selector */
.mc-page-price{font-family:'Inter',system-ui,sans-serif;font-size:24px;font-weight:600;color:${text};margin:8px 0 12px}
.mc-page-variants{margin-bottom:12px;font-family:'Inter',system-ui,sans-serif}
.mc-page-var-group{margin-bottom:12px}
.mc-page-var-label{font-size:12px;font-weight:600;color:#555;margin-bottom:8px}
.mc-page-var-opts{display:flex;flex-wrap:wrap;gap:8px}
.mc-page-var-pill{padding:8px 18px;border:1.5px solid ${(C.pillDesign||{}).border||'#ddd'};border-radius:${(C.pillDesign||{}).radius||6}px;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:${text};font-family:inherit;transition:all .15s}
.mc-page-var-pill:hover{border-color:${(C.pillDesign||{}).activeBg||btn}}
.mc-page-var-pill.mc-pv-active{border-color:${(C.pillDesign||{}).activeBg||btn};background:${(C.pillDesign||{}).activeBg||btn};color:${(C.pillDesign||{}).activeText||btnT}}
.mc-page-var-pill.mc-pv-unavail{opacity:.35;cursor:not-allowed;text-decoration:line-through}
.mc-page-var-swatch{width:${(C.swatchDesign||{}).size||42}px;height:${(C.swatchDesign||{}).size||42}px;border-radius:${(C.swatchDesign||{}).radius||8}px;border:2px solid transparent;cursor:pointer;overflow:hidden;padding:0;background:#f5f5f5;transition:all .15s}
.mc-page-var-swatch:hover{border-color:${(C.swatchDesign||{}).activeBorder||btn}}
.mc-page-var-swatch.mc-pv-active{border-color:${(C.swatchDesign||{}).activeBorder||btn};box-shadow:0 0 0 1px ${(C.swatchDesign||{}).activeBorder||btn}}
.mc-page-var-swatch.mc-pv-unavail{opacity:.35;cursor:not-allowed}
.mc-page-var-swatch img{width:100%;height:100%;object-fit:cover;display:block;border-radius:${Math.max(0,((C.swatchDesign||{}).radius||8)-2)}px}
.mc-page-var-dropdown{width:100%;padding:10px 14px;border:1.5px solid ${(C.dropdownDesign||{}).border||'#ddd'};border-radius:${(C.dropdownDesign||{}).radius||6}px;font-size:13px;font-family:inherit;background:${(C.dropdownDesign||{}).bg||'#fff'};color:${(C.dropdownDesign||{}).text||text};cursor:pointer;outline:none;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%23666' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}

/* Mobile */
@media(max-width:500px){
  .mc-drawer{width:100vw}
}
`;
  document.head.appendChild(s);
}

/* ---- Build DOM ---- */
function buildDrawer(){
  if ($('#mc-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id='mc-overlay'; overlay.className='mc-overlay';
  document.body.appendChild(overlay);

  const drawer = document.createElement('div');
  drawer.id='mc-drawer'; drawer.className='mc-drawer';
  document.body.appendChild(drawer);

  // Close on overlay click
  overlay.addEventListener('click', mcClose);
  // Robust desktop close: mousedown outside drawer
  document.addEventListener('mousedown', function(e){
    if(!drawerOpen) return;
    const d = $('#mc-drawer');
    if(d && !d.contains(e.target) && !e.target.closest('[onclick*="mcAddToCart"]') && !e.target.closest('[onclick*="mcOpen"]')){
      mcClose();
    }
  });
}

/* ---- Render ---- */
function render(){
  const d = $('#mc-drawer'); if(!d) return;
  const totalQty = cartLines.reduce((s,l)=>s+l.qty,0);
  const subtotal = cartLines.reduce((s,l)=>s+parseFloat(l.price)*l.qty,0);
  const hdr = C.header||{};
  const isEmpty = cartLines.length === 0;

  let html = '';

  // Header
  html += `<div class="mc-header">
    <span class="mc-header-title">${esc(hdr.title||'Your Bag')} <span class="mc-header-count">(${totalQty})</span></span>
    <button class="mc-close" onclick="mcClose()" aria-label="Close">&times;</button>
  </div>`;

  // Body
  html += '<div class="mc-body">';

  if(isEmpty){
    html += `<div class="mc-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>
      <div>${esc(TXT.empty||'Your cart is empty')}</div>
    </div>`;
    // Recommendations
    if(C.upsells && C.upsells.items && C.upsells.items.length > 0){
      html += renderRecs();
    }
  } else {
    // Announcement (before)
    if(C.announce && C.announce.position !== 'after'){
      html += renderAnnounce();
    }
    // Rewards
    if(C.rewards){
      html += renderRewards(subtotal);
    }
    // Notes (above)
    if(C.notes && C.notes.placement === 'above'){
      html += renderNotes();
    }
    // Social proof
    html += renderSocialProof();
    // Product countdown
    html += renderProductCountdown();
    // Cart items
    cartLines.forEach((line,i)=>{
      html += renderLine(line, i);
    });
    // Announcement (after)
    if(C.announce && C.announce.position === 'after'){
      html += renderAnnounce();
    }
    // Bundle (after_item position)
    if(C.bundle && C.bundle.items && C.bundle.items.length > 0 && C.bundle.position === 'after_item'){
      html += renderBundle();
    }
    // Notes (below)
    if(C.notes && C.notes.placement !== 'above'){
      html += renderNotes();
    }
    // Bundle (before_upsells position)
    if(C.bundle && C.bundle.items && C.bundle.items.length > 0 && C.bundle.position !== 'after_item'){
      html += renderBundle();
    }
    // Upsells
    if(C.upsells && C.upsells.items && C.upsells.items.length > 0 && C.upsells.position !== 'top'){
      html += renderUpsells();
    }
    // Add-ons
    if(C.addons && C.addons.items && C.addons.items.length > 0){
      html += renderAddons();
    }
    // Trust badge (bottom position, inside body)
    if(C.trustBadge && C.trustBadge.position === 'bottom'){
      html += renderTrust();
    }
  }

  html += '</div>'; // end body

  // Footer (only when not empty)
  if(!isEmpty){
    // Discount codes
    if(C.discountCode){
      html += renderDiscount();
    }
    // Use API total if available (includes discounts), otherwise local calculation
    const displayTotal = cartCost ? parseFloat(cartCost.totalAmount.amount) : subtotal;
    const hasDiscount = cartCost && parseFloat(cartCost.totalAmount.amount) < subtotal;
    html += `<div class="mc-footer">
      <div class="mc-subtotal-row">
        <span class="mc-subtotal-label">${esc(TXT.subtotal||'Subtotal')}</span>
        <span class="mc-subtotal-val">${hasDiscount ? `<span style="text-decoration:line-through;color:#aaa;font-size:12px;font-weight:400;margin-right:6px">${CUR} ${fmt(subtotal)}</span>` : ''}${CUR} ${fmt(displayTotal)}</span>
      </div>
      ${hasDiscount ? `<div style="font-size:11px;color:#2ea818;font-weight:600;margin-bottom:4px">${esc(TXT.discounts||'Discount')} applied! You save ${CUR} ${fmt(subtotal - displayTotal)}</div>` : ''}
      <div class="mc-ship-note">${esc(TXT.shipNote||'Shipping calculated at checkout')}</div>
      <button class="mc-checkout-btn" onclick="mcCheckout()">${esc(TXT.checkout||'CHECKOUT')}</button>
      <button class="mc-continue" onclick="mcClose()">${esc(TXT.continue||'Or continue shopping')}</button>
    </div>`;
  }

  d.innerHTML = html;

  // Setup drag scroll for upsell carousel
  setupDragScroll();
  // Start timer if needed
  setupTimer();
  // Start product countdowns
  startProductCountdowns();
}

function renderLine(line, idx){
  let priceHTML = '';
  if(C.showStrikethrough && line.comparePrice && parseFloat(line.comparePrice) > parseFloat(line.price)){
    priceHTML = `<span class="mc-item-strike">${CUR} ${fmt(line.comparePrice)}</span>${CUR} ${fmt(line.price)}`;
  } else {
    priceHTML = `${CUR} ${fmt(line.price)}`;
  }
  let savingsHTML = '';
  if(C.showSavings && line.comparePrice && parseFloat(line.comparePrice) > parseFloat(line.price)){
    const saved = (parseFloat(line.comparePrice)-parseFloat(line.price))*line.qty;
    savingsHTML = `<div class="mc-item-savings">${esc(TXT.save||'Save')} ${CUR} ${fmt(saved)}</div>`;
  }
  const qtyBreaksHTML = renderQuantityBreaks(line);
  // Render variant selectors if product has options AND variantInCart is enabled
  let variantHTML = '';
  const cached = productCache[line.productId];
  if(C.variantInCart && cached && cached.options && cached.options.length > 0 && !(cached.options.length===1 && cached.options[0].values.length<=1)){
    variantHTML = cached.options.map(opt => {
      if(opt.values.length <= 1) return ''; // Skip single-value options
      const currentVal = line.selectedOptions?.find(so=>so.name===opt.name)?.value || '';
      const optStyle = (C.varStyles||{})[opt.name] || C.variantDisplay || 'pill';
      let optsHTML = '';
      if(optStyle === 'swatch'){
        optsHTML = opt.values.map(val => {
          const isActive = val === currentVal;
          const matchV = cached.variants.find(v => v.selectedOptions.some(so=>so.name===opt.name && so.value===val));
          const img = matchV?.image?.url || '';
          const avail = cached.variants.some(v => v.availableForSale && v.selectedOptions.some(so=>so.name===opt.name && so.value===val));
          const colorHex = (C.swatchColors||{})[val];
          return `<button class="mc-var-swatch${isActive?' mc-var-active':''}${!avail?' mc-var-unavail':''}" title="${esc(val)}" onclick="mcSwitchVariant(${idx},'${esc(opt.name)}','${esc(val)}')" ${!avail?'disabled':''}>${colorHex ? `<span style="display:block;width:100%;height:100%;background:${esc(colorHex)}"></span>` : (img ? `<img src="${img}" alt="${esc(val)}">` : `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:8px">${esc(val.substring(0,3))}</span>`)}</button>`;
        }).join('');
      } else if(optStyle === 'dropdown'){
        const opts = opt.values.map(val => {
          const avail = cached.variants.some(v => v.availableForSale && v.selectedOptions.some(so=>so.name===opt.name && so.value===val));
          return `<option value="${esc(val)}"${val===currentVal?' selected':''}${!avail?' disabled':''}>${esc(val)}${!avail?' (indisponível)':''}</option>`;
        }).join('');
        optsHTML = `<select class="mc-var-dropdown" onchange="mcSwitchVariant(${idx},'${esc(opt.name)}',this.value)">${opts}</select>`;
      } else {
        optsHTML = opt.values.map(val => {
          const isActive = val === currentVal;
          const avail = cached.variants.some(v => v.availableForSale && v.selectedOptions.some(so=>so.name===opt.name && so.value===val));
          return `<button class="mc-var-pill${isActive?' mc-var-active':''}${!avail?' mc-var-unavail':''}" onclick="mcSwitchVariant(${idx},'${esc(opt.name)}','${esc(val)}')" ${!avail?'disabled':''}>${esc(val)}</button>`;
        }).join('');
      }
      return `<div class="mc-var-group"><div class="mc-var-label">${esc(opt.name)}</div><div class="mc-var-opts">${optsHTML}</div></div>`;
    }).join('');
  }

  return `<div class="mc-item" data-idx="${idx}">
    <img class="mc-item-img" src="${line.image||''}" alt="" onerror="this.style.background='#eee';this.src=''">
    <div class="mc-item-info">
      <div class="mc-item-top"><span class="mc-item-name">${esc(line.title)}</span><span class="mc-item-price">${priceHTML}</span></div>
      ${line.variant && (!C.variantInCart || !cached)?`<div class="mc-item-variant">${esc(line.variant)}</div>`:''}
      ${variantHTML}
      ${savingsHTML}
      ${qtyBreaksHTML}
      <div class="mc-item-bottom">
        <div class="mc-qty">
          <button onclick="mcUpdateQty(${idx},${line.qty-1})">−</button>
          <span>${line.qty}</span>
          <button onclick="mcUpdateQty(${idx},${line.qty+1})">+</button>
        </div>
        <button class="mc-remove" onclick="mcUpdateQty(${idx},0)">${esc(TXT.remove||'Remove')}</button>
      </div>
    </div>
  </div>`;
}

function renderAnnounce(){
  const a = C.announce;
  const text = (a.text || '').replace(/\{timer\}/gi, '<b class="mc-timer">--:--</b>');
  return `<div class="mc-announce" style="background:${a.bg||'#CDE0E0'};border-bottom:1px solid ${a.border||'#C5E6FD'}">${text}</div>`;
}

function renderRewards(subtotal){
  const rw = C.rewards;
  if(!rw.tiers || !rw.tiers.length) return '';
  // Ensure subtotal is a number
  const sub = parseFloat(subtotal) || 0;
  // Find highest incomplete tier (ensure min is parsed as number)
  const sorted = [...rw.tiers].map(t=>({...t, min:parseFloat(t.min)||0})).sort((a,b)=>a.min-b.min);
  let activeTier = sorted.find(t => sub < t.min);
  let pct = 100;
  let text = esc(rw.doneText||'All rewards unlocked!');
  let isComplete = !activeTier;
  if(activeTier){
    const remaining = activeTier.min - sub;
    // Substitute {AMOUNT} placeholder. If the merchant didn't use it,
    // append the remaining amount automatically so the customer always
    // sees how much is left ("Spend $50 more to get free shipping").
    const tierText = activeTier.text || '';
    // Token substitution is case-insensitive + global so a merchant typing
    // {amount}, {Amount} or using it twice still renders — engine placeholder
    // contract (the dashboard hint at cart/rewards announces {AMOUNT}).
    if(/\{amount\}/i.test(tierText)){
      text = tierText.replace(/\{amount\}/gi, '<b>'+CUR+' '+fmt(remaining)+'</b>');
    } else {
      text = esc(tierText) + ' <b>('+CUR+' '+fmt(remaining)+' to go)</b>';
    }
    pct = Math.min(100, (sub/activeTier.min)*100);
  }
  // Use a different fill color when the bar is full so the change is
  // visually obvious. Falls back to a green if not configured.
  const fillColor = isComplete
    ? (rw.barFgComplete || '#10b981')
    : (rw.barFg || '#93D3FF');
  return `<div class="mc-rewards">
    <div class="mc-rewards-text">${text}</div>
    <div class="mc-rewards-bar" style="background:${rw.barBg||'#E2E2E2'}"><div class="mc-rewards-fill" style="width:${pct}%;background:${fillColor}"></div></div>
  </div>`;
}

function renderNotes(){
  const n = C.notes;
  return `<div class="mc-notes">
    <div class="mc-notes-title">${esc(n.title||'Add special instructions')}</div>
    <textarea placeholder="${esc(n.placeholder||'Special instructions for your order')}" onchange="cartNote=this.value">${esc(cartNote)}</textarea>
  </div>`;
}

function renderUpsells(){
  const up = C.upsells;
  // Filter: skip items already in the cart, AND skip items whose
  // _trigger doesn't match any current cart line.
  const items = up.items.filter(u => !cartLines.find(l=>l.variantId===u.variantId) && mcItemPasses(u));
  if(!items.length) return '';
  const dir = up.direction || 'carousel';
  let inner = '';
  if(dir === 'carousel'){
    inner = `<div class="mc-ups-scroll">${items.map(u=>`<div class="mc-ups-card">
      <img src="${mcItemImg(u)}" alt="" onerror="this.style.background='#eee'">
      <div class="mc-ups-name">${esc(u.name.split('—')[0].split(' — ')[0])}</div>
      <div class="mc-ups-price">${CUR} ${fmt(u.price)}</div>
      <button class="mc-ups-add" onclick="mcAddVariant('${u.variantId}', '${u.productGid||''}')">${esc(up.btnText||'Add')}</button>
    </div>`).join('')}</div>`;
  } else {
    inner = `<div class="mc-ups-block">${items.map(u=>`<div class="mc-ups-block-item">
      <img src="${mcItemImg(u)}" alt="" onerror="this.style.background='#eee'">
      <div class="mc-ups-bi-info"><div class="mc-ups-bi-name">${esc(u.name.split('—')[0].split(' — ')[0])}</div><div class="mc-ups-bi-price">${CUR} ${fmt(u.price)}</div></div>
      <button class="mc-ups-bi-add" onclick="mcAddVariant('${u.variantId}', '${u.productGid||''}')">${esc(up.btnText||'Add')}</button>
    </div>`).join('')}</div>`;
  }
  return `<div class="mc-upsells"><div class="mc-upsells-title">${esc(up.title||"You'll Also Love")}</div>${inner}</div>`;
}

function renderAddons(){
  const items = C.addons.items.filter(mcItemPasses);
  if(!items.length) return '';
  return `<div class="mc-addons">${items.map(a=>{
    const checked = addonChecked[a.variantId] ? 'checked' : '';
    return `<label class="mc-addon-row"><input type="checkbox" ${checked} onchange="mcToggleAddon('${a.variantId}',this.checked,'${a.productGid||''}')"><img src="${mcItemImg(a)}" alt="" onerror="this.style.background='#eee'"><span class="mc-ao-name">${esc(a.name.split('—')[0].split(' — ')[0])}</span><span class="mc-ao-price">${CUR} ${fmt(a.price)}</span></label>`;
  }).join('')}</div>`;
}

function renderBundle(){
  const bd = C.bundle;
  const items = bd.items.filter(b => !cartLines.find(l=>l.variantId===b.variantId) && mcItemPasses(b));
  if(!items.length) return '';
  // Sprint 2 P0-2: pass per-item {variantId, productGid} to mcAddBundle so
  // the engine can pre-scope each translation by product. Use a JSON string
  // (HTML-escaped) so the onclick attribute parses cleanly with quotes.
  const itemsPayload = items.map(b => ({
    variantId: b.variantId,
    productGid: b.productGid || ''
  }));
  const payloadStr = JSON.stringify(itemsPayload).replace(/"/g, '&quot;');
  return `<div class="mc-bundle" style="background:${bd.bg||'#f5f0eb'}">
    <div class="mc-bundle-inner">
      <div class="mc-bundle-info">
        <div class="mc-bundle-title" style="color:${C.colors?.text||'#000'}">${esc(bd.title||'Add The Starter Kit')}</div>
        <div class="mc-bundle-subtitle">${esc(bd.subtitle||'')}</div>
        <button class="mc-bundle-btn" onclick="mcAddBundle(${payloadStr})">${esc(bd.btnText||'ADD TO BAG')} &nbsp;|&nbsp; ${CUR} ${fmt(bd.price)}</button>
      </div>
      <div class="mc-bundle-images">${items.map(b=>`<div><img src="${mcItemImg(b)}" alt="" onerror="this.style.background='#eee'"><div class="mc-bundle-img-label">${esc(b.name.split('—')[0].split(' — ')[0])}</div></div>`).join('')}</div>
    </div>
  </div>`;
}

function renderDiscount(){
  const dc = C.discountCode;
  return `<div class="mc-discount">
    <input type="text" placeholder="${esc(dc.placeholder||'Discount code')}" id="mc-dc-input">
    <button onclick="mcApplyDiscount()">${esc(dc.btnText||'Apply')}</button>
  </div>`;
}

function renderTrust(){
  const tb = C.trustBadge;
  let icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
  if(tb.preset === 'payment'){
    icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="1.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>';
  } else if(tb.preset === 'minimal'){
    icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';
  }
  return `<div class="mc-trust">${icon} ${esc(tb.text||'Your order is protected by secure checkout')}</div>`;
}

function renderRecs(){
  if(!C.upsells || !C.upsells.items || !C.upsells.items.length) return '';
  const items = C.upsells.items.filter(mcItemPasses);
  if(!items.length) return '';
  return `<div class="mc-recs">
    <div class="mc-recs-title">Add your favourite items to your cart.</div>
    <div class="mc-recs-grid">${items.map(u=>`<div class="mc-rec-card" onclick="mcAddVariant('${u.variantId}', '${u.productGid||''}')">
      <img src="${mcItemImg(u)}" alt="" onerror="this.style.background='#eee'">
      <div class="mc-rec-info"><div class="mc-rec-name">${esc(u.name.split('—')[0].split(' — ')[0])}</div><div class="mc-rec-price">${CUR} ${fmt(u.price)}</div></div>
      <button class="mc-rec-add" onclick="event.stopPropagation();mcAddVariant('${u.variantId}', '${u.productGid||''}')">${esc(C.upsells.btnText||'Add')}</button>
    </div>`).join('')}</div>
  </div>`;
}

/* ---- Timer ---- */
function setupTimer(){
  if(!C.announce || !C.announce.timer) return;
  const el = $('.mc-timer'); if(!el) return;
  if(timerInterval) clearInterval(timerInterval);
  if(timerSeconds <= 0){
    const parts = C.announce.timer.split(':');
    timerSeconds = (parseInt(parts[0])||0)*60 + (parseInt(parts[1])||0);
  }
  const updateTimer = ()=>{
    const el2 = $('.mc-timer'); if(!el2) return;
    if(timerSeconds <= 0){ clearInterval(timerInterval); el2.textContent='00:00'; return; }
    timerSeconds--;
    const m=String(Math.floor(timerSeconds/60)).padStart(2,'0');
    const s=String(timerSeconds%60).padStart(2,'0');
    el2.textContent=m+':'+s;
  };
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

/* ---- Drag scroll ---- */
function setupDragScroll(){
  const el = $('.mc-ups-scroll'); if(!el) return;
  let isDown=false, startX, scrollLeft;
  el.addEventListener('mousedown',e=>{isDown=true;el.classList.add('mc-grabbing');startX=e.pageX-el.offsetLeft;scrollLeft=el.scrollLeft;e.preventDefault()});
  el.addEventListener('mouseleave',()=>{isDown=false;el.classList.remove('mc-grabbing')});
  el.addEventListener('mouseup',()=>{isDown=false;el.classList.remove('mc-grabbing')});
  el.addEventListener('mousemove',e=>{if(!isDown)return;e.preventDefault();const x=e.pageX-el.offsetLeft;el.scrollLeft=scrollLeft-(x-startX)*1.5});
}

/* ---- Storefront API ---- */
// PR #92: gql against the PRIMARY pool member regardless of current active
// member. Some client paths need primary's catalog even when bucketing
// routed the visitor to a secondary — most importantly `initPageVariants`,
// which the theme embeds on the PDP with the PRIMARY productGid. Querying
// the secondary with a primary productGid returns null → no selectors
// render → the bug owner reported after PR #85 swapped init to resolve
// sticky member. Use this when the operation is about what the VISITOR
// sees on the theme (primary's catalog is the source of truth there), not
// about where their cart will land (which is handled by the translation
// layer PRs #79/#82). Falls through to the default `gql` when pool is
// empty or primary lacks credentials — matches legacy behavior.
async function gqlPrimary(query, variables){
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  var primary = pool && Array.isArray(pool.members)
    ? pool.members.find(function(m){ return m && m.is_primary; })
    : null;
  if (!primary || !primary.domain || !primary.storefrontToken) {
    return gql(query, variables || {});
  }
  var r = await fetch('https://' + primary.domain + '/api/2024-10/graphql.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': primary.storefrontToken,
    },
    body: JSON.stringify({ query: query, variables: variables || {} }),
  });
  if (!r.ok) {
    var err = new Error('Storefront HTTP ' + r.status);
    err.status = r.status;
    throw err;
  }
  var j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

async function gql(query, variables={}){
  const r = await fetch(API,{method:'POST',headers:HDR,body:JSON.stringify({query,variables})});
  // Surface HTTP status on transport-level errors so pool failure classification
  // can distinguish 401 / 410 / 5xx. Token revoked (401) and store gone (410) are
  // the signals that trigger member eviction per spec § 9.2.
  if(!r.ok){
    const err = new Error('Storefront HTTP '+r.status);
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  if(j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

async function createCart(variantId, qty=1){
  const input = {lines:[{merchandiseId:variantId,quantity:qty}],note:cartNote||undefined};
  // If a specific discount code is configured, include it — Shopify will validate the rules
  if(C.autoDiscount) input.discountCodes = [C.autoDiscount];
  const data = await gql(`mutation($input:CartInput!){cartCreate(input:$input){cart{id checkoutUrl cost{subtotalAmount{amount}totalAmount{amount}}discountCodes{code applicable}discountAllocations{discountedAmount{amount}}lines(first:50){edges{node{id quantity cost{totalAmount{amount}subtotalAmount{amount}}merchandise{...on ProductVariant{id title priceV2{amount}compareAtPriceV2{amount}image{url}selectedOptions{name value}product{id title}}}}}}}userErrors{code field message}}}`,
    {input});
  const result = data && data.cartCreate;
  const cart = result && result.cart;
  if (!cart) {
    // cartCreate returned null cart — the merchandiseId doesn't exist on the
    // active member store. Common when variant translation fell back to the
    // primary id (missing mapping, SKU collision) and we're pointed at a
    // member that doesn't have that exact variant. Surface Shopify's
    // userErrors so the failure is diagnosable instead of crashing with
    // TypeError: Cannot read properties of null (reading 'id').
    const userErrors = (result && result.userErrors) || [];
    const detail = userErrors.length
      ? userErrors.map(function(e){ return (e.code || '') + ':' + (e.message || ''); }).join('; ')
      : 'cart_null';
    var err = new Error('cartCreate failed: ' + detail);
    err.cartCreateFailed = true;
    err.userErrors = userErrors;
    throw err;
  }
  cartId = cart.id;
  localStorage.setItem('mc_cartId', cartId);
  if(cart.cost) cartCost = cart.cost;
  syncLines(cart.lines.edges);
  return cart;
}

async function addLine(variantId, qty=1){
  if(!cartId) return createCart(variantId, qty);
  // Phase 1.5.4: Shopify cart IDs are scoped per store. When bucketing
  // switches the active member mid-session, the cached cartId belongs to
  // the previous member's Shopify store and cartLinesAdd will return a
  // null cart (or a GraphQL error) on the new member. Detect and auto-heal
  // by falling back to createCart — the cart starts empty on the new member
  // but the shopper still gets a working checkout.
  try {
    const data = await gql(`mutation($cartId:ID!,$lines:[CartLineInput!]!){cartLinesAdd(cartId:$cartId,lines:$lines){cart{id checkoutUrl cost{subtotalAmount{amount}totalAmount{amount}}discountAllocations{discountedAmount{amount}}lines(first:50){edges{node{id quantity cost{totalAmount{amount}subtotalAmount{amount}}merchandise{...on ProductVariant{id title priceV2{amount}compareAtPriceV2{amount}image{url}selectedOptions{name value}product{id title}}}}}}}userErrors{code field message}}}`,
      {cartId,lines:[{merchandiseId:variantId,quantity:qty}]});
    const result = data.cartLinesAdd;
    const cart = result && result.cart;
    if (!cart) {
      // cartLinesAdd returned null cart — cartId belongs to a different store.
      throw new Error('cart_stale_on_member');
    }
    if(cart.cost) cartCost = cart.cost;
    if(C.autoDiscount) await applyAutoDiscount();
    syncLines(cart.lines.edges);
    return cart;
  } catch (err) {
    var msg = (err && err.message) || '';
    // 2026-08-23 — antes, QUALQUER erro aqui destruía o carrinho do cliente e
    // recriava com apenas o item novo: blip de rede, 429 de throttle, 5xx,
    // timeout, userError de estoque. Quem tinha 4 itens e adicionava o quinto
    // durante um soluço da Shopify ficava com um carrinho de 1 item, em
    // silêncio — só um console.warn. O ticket médio despencava e nada
    // registrava o motivo.
    if (!mcDeveRecriarCarrinho(msg)) {
      console.warn('MC Cart: cartLinesAdd falhou (transitório), carrinho preservado —', msg);
      throw err; // o chamador já trata; melhor não adicionar do que perder tudo
    }
    console.warn('MC Cart: carrinho pertence a outra loja, recriando —', msg);
    cartId = null;
    try { localStorage.removeItem('mc_cartId'); } catch(e) { /* noop */ }
    return createCart(variantId, qty);
  }
}

/**
 * Só um carrinho comprovadamente morto justifica descartar o do cliente.
 *
 * `cart_stale_on_member` é o erro que o próprio addLine lança quando
 * `cartLinesAdd` devolve `cart` nulo — sinal de que o cartId pertence a outra
 * loja. Fora isso, aceitamos apenas mensagens da Shopify que digam
 * explicitamente que o carrinho não existe mais.
 *
 * Tudo o mais é transitório e preservar é o correto: não adicionar um item é
 * um problema pequeno; perder o carrinho inteiro é uma venda.
 */
function mcDeveRecriarCarrinho(msg){
  if (!msg) return false;
  if (msg === 'cart_stale_on_member') return true;
  return /\bcart\b[\s\S]{0,40}?(not found|does not exist|no longer|invalid)|(invalid|unknown)\s+cart\b/i.test(msg);
}

async function updateLine(lineId, qty){
  if(!cartId) return;
  const linesFrag = `cost{subtotalAmount{amount}totalAmount{amount}}discountAllocations{discountedAmount{amount}}lines(first:50){edges{node{id quantity cost{totalAmount{amount}subtotalAmount{amount}}merchandise{...on ProductVariant{id title priceV2{amount}compareAtPriceV2{amount}image{url}selectedOptions{name value}product{id title}}}}}}`;
  const mutation = qty <= 0
    ? `mutation($cartId:ID!,$lineIds:[ID!]!){cartLinesRemove(cartId:$cartId,lineIds:$lineIds){cart{id checkoutUrl ${linesFrag}}}}`
    : `mutation($cartId:ID!,$lines:[CartLineUpdateInput!]!){cartLinesUpdate(cartId:$cartId,lines:$lines){cart{id checkoutUrl ${linesFrag}}}}`;
  const vars = qty <= 0
    ? {cartId,lineIds:[lineId]}
    : {cartId,lines:[{id:lineId,quantity:qty}]};
  const data = await gql(mutation, vars);
  const cart = qty <= 0 ? data.cartLinesRemove.cart : data.cartLinesUpdate.cart;
  if(cart.cost) cartCost = cart.cost;
  syncLines(cart.lines.edges);
  return cart;
}

async function fetchCart(){
  if(!cartId) return;
  try{
    const data = await gql(`query($id:ID!){cart(id:$id){id checkoutUrl cost{subtotalAmount{amount}totalAmount{amount}}discountCodes{code applicable}discountAllocations{discountedAmount{amount}}lines(first:50){edges{node{id quantity cost{totalAmount{amount}subtotalAmount{amount}}merchandise{...on ProductVariant{id title priceV2{amount}compareAtPriceV2{amount}image{url}selectedOptions{name value}product{id title}}}}}}}}`,{id:cartId});
    if(!data.cart){ cartId=null; localStorage.removeItem('mc_cartId'); return; }
    if(data.cart.cost) cartCost = data.cart.cost;
    // Auto-apply discount if configured and not yet applied
    if(C.autoDiscount && data.cart.lines.edges.length > 0){
      const applied = data.cart.discountCodes?.find(d=>d.code===C.autoDiscount && d.applicable);
      if(!applied) await applyAutoDiscount();
    }
    syncLines(data.cart.lines.edges);
    // Fetch product data for variant selectors
    await fetchProductsForCart();
  }catch(e){
    // Don't wipe cartId on transient errors (network, rate limit, 5xx). The
    // ONLY legitimate signal that a cart no longer exists is Shopify returning
    // `data.cart === null`, handled in the branch above. Wiping on any error
    // turned normal flakiness into "lost cart on page nav" for visitors who
    // were sticky-routed to a secondary whose init bootstrap hadn't completed
    // yet. If the cartId is genuinely dead on the active store, addLine's
    // self-heal (PR #78) recreates the cart on the next add-to-cart.
    console.warn('MC Cart: fetchCart failed (keeping cartId)', e);
  }
}

async function fetchProductsForCart(){
  const productIds = [...new Set(cartLines.map(l=>l.productId).filter(Boolean))];
  for(const pid of productIds){
    if(productCache[pid]) continue;
    try{
      const data = await gql(`query($id:ID!){product(id:$id){id options{name values}variants(first:100){edges{node{id title availableForSale selectedOptions{name value}priceV2{amount}compareAtPriceV2{amount}image{url}}}}}}`,{id:pid});
      if(data.product){
        productCache[data.product.id] = {
          options: data.product.options,
          variants: data.product.variants.edges.map(({node})=>node),
        };
      }
    }catch(e){ console.warn('MC Cart: failed to fetch product', pid, e); }
  }
  render(); // Re-render with variant selectors
}

async function applyAutoDiscount(){
  if(!cartId || !C.autoDiscount) return;
  try{
    const data = await gql(`mutation($cartId:ID!,$codes:[String!]!){cartDiscountCodesUpdate(cartId:$cartId,discountCodes:$codes){cart{id cost{subtotalAmount{amount}totalAmount{amount}}discountCodes{code applicable}}userErrors{field message}}}`,
      {cartId, codes:[C.autoDiscount]});
    if(data.cartDiscountCodesUpdate?.cart?.cost) cartCost = data.cartDiscountCodesUpdate.cart.cost;
  }catch(e){
    console.warn('MC Cart: failed to apply discount', e);
  }
}

function syncLines(edges){
  cartLines = edges.map(({node})=>{
    const v = node.merchandise;
    return {
      lineId: node.id,
      variantId: v.id,
      productId: v.product?.id || '',
      title: v.product.title,
      variant: v.title !== 'Default Title' ? v.title : '',
      price: v.priceV2.amount,
      comparePrice: v.compareAtPriceV2?.amount || null,
      qty: node.quantity,
      image: mcImg(v.image?.url || '', v.id, v.product?.id || '', v.selectedOptions || []),
      selectedOptions: v.selectedOptions || [],
    };
  });
  render();
}

/* ---- Public API ---- */
window.mcOpen = function(){
  drawerOpen = true;
  const o=$('#mc-overlay'), d=$('#mc-drawer');
  if(o) o.classList.add('mc-open');
  if(d) d.classList.add('mc-open');
  document.body.style.overflow='hidden';
  render();
};

window.mcClose = function(){
  drawerOpen = false;
  const o=$('#mc-overlay'), d=$('#mc-drawer');
  if(o) o.classList.remove('mc-open');
  if(d) d.classList.remove('mc-open');
  document.body.style.overflow='';
};

window.mcAddToCart = async function(productGid){
  mcOpen();
  // Show loading in body
  const body = $('.mc-body');
  if(body && cartLines.length===0) body.innerHTML='<div style="padding:60px;text-align:center"><div class="mc-spinner"></div></div>';
  // Pool resolve + Phase 1.5 translation: pass the theme-embedded productGid
  // (which is the PRIMARY checkout's gid) so the server can translate it into
  // the chosen member's own productGid. `translated` will be the member's gid
  // or null if no translation was needed / possible.
  let translatedProductGid = null;
  try{
    const r = await ensureActiveCheckoutForAdd(null, null, productGid);
    translatedProductGid = r && r.productGid ? r.productGid : null;
  }catch(err){
    if(err && err.poolExhausted){
      console.warn('MC Cart: pool exhausted — showing error');
      showCartError('pool_no_eligible_member');
      return;
    }
  }
  const effectiveProductGid = translatedProductGid || productGid;
  try{
    // Fetch product with all variants and options (on the active checkout store)
    const data = await gql(`query($id:ID!){product(id:$id){id options{name values}variants(first:100){edges{node{id title availableForSale selectedOptions{name value}priceV2{amount}compareAtPriceV2{amount}image{url}}}}}}`,{id:effectiveProductGid});
    const product = data.product;
    // Cache product data for variant switching
    productCache[product.id] = {
      options: product.options,
      variants: product.variants.edges.map(({node})=>node),
    };
    const vid = product.variants.edges[0]?.node.id;
    if(!vid) throw new Error('No variant found');
    // Check if any variant of this product is already in cart
    const existing = cartLines.find(l=>l.variantId===vid);
    if(existing){
      await updateLine(existing.lineId, existing.qty+1);
    } else {
      await addLine(vid);
    }
    // Track AddToCart
    const added = cartLines.find(l=>l.variantId===vid);
    if(added) trackEvent('AddToCart',{name:added.title,variantId:vid,price:added.price,qty:1,currency:getCurrencyCode()});
    // A/B add_to_cart event
    if(window.__mcAbTestId&&window.__mcStoreId&&window.__mcTrackUrl){try{fetch(window.__mcTrackUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:window.__mcStoreId,ab_test_id:window.__mcAbTestId,ab_variant:window.__mcAbVariant,ab_visitor_id:window.__mcAbVisitorId,ab_event:'add_to_cart'}),keepalive:true}).catch(()=>{});}catch(e){}}
  }catch(e){
    console.error('MC Cart: addToCart error', e);
    // Phase 1.5: report Storefront failure for eviction/debug, then show an
    // inline error in the drawer. We no longer redirect to `/cart/add` because
    // that endpoint rejects product GIDs (expects variant IDs) and produces
    // Shopify's generic error page — worse UX than an inline message.
    if(activeMemberId){
      reportMemberFailure(activeMemberId, classifyStorefrontError(e), String(e && e.message || e));
    }
    showCartError(classifyStorefrontError(e));
  }
};

// Phase 1.5.7: session cache for primary-variant SKU+productGid lookups. Bundles
// and repeat clicks re-enter mcAddVariant with the same baked variantIds; we
// amortize the extra primary Storefront round-trip across them.
var __mcPrimaryVariantCache = {};

async function queryPrimaryVariantInfo(primary, primaryVariantId){
  if (!primary || !primary.domain || !primary.storefrontToken || !primaryVariantId) return null;
  if (__mcPrimaryVariantCache[primaryVariantId]) return __mcPrimaryVariantCache[primaryVariantId];
  try {
    var res = await fetch('https://' + primary.domain + '/api/2024-10/graphql.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': primary.storefrontToken,
      },
      body: JSON.stringify({
        // PR #93: fetch selectedOptions too, so mcAddVariant can drive
        // translateVariantId via the unambiguous selectedOptions path when
        // variants share the same SKU.
        query: 'query($id:ID!){node(id:$id){...on ProductVariant{sku selectedOptions{name value} product{id}}}}',
        variables: { id: primaryVariantId },
      }),
    });
    if (!res.ok) return null;
    var json = await res.json();
    var node = json && json.data && json.data.node;
    if (!node || !node.product || !node.product.id) return null;
    var info = { sku: node.sku || null, productGid: node.product.id, selectedOptions: node.selectedOptions || [] };
    __mcPrimaryVariantCache[primaryVariantId] = info;
    return info;
  } catch(e) {
    console.warn('MC Cart: queryPrimaryVariantInfo failed for ' + primaryVariantId, e);
    return null;
  }
}

window.mcAddVariant = async function(variantId, primaryProductGidArg){
  // Phase 1.5.7: translate baked primary variantIds to the active member's
  // equivalent. This path is used by upsells, addons, bundles, and recs — all
  // driven by cart_config entries that the dashboard saved with PRIMARY's
  // variant GIDs. When bucketing routes to a non-primary member, those IDs
  // don't exist in the member store and cartCreate returns null cart.
  //
  // Sprint 2 P0-2: callers now pass `primaryProductGidArg` directly when
  // cart_config items carry it (after the new save-side enrichment runs).
  // That short-circuits queryPrimaryVariantInfo's productGid fetch and lets
  // the resolve endpoint populate the per-product variantsBySku map up front
  // — so even the FIRST click on a bundle item lands cleanly without the
  // brittle per-product round trip pattern.
  var pool = window.mcCartConfig && window.mcCartConfig.pool;
  var primary = (pool && Array.isArray(pool.members))
    ? pool.members.find(function(m){ return m && m.is_primary; })
    : null;

  // We still query the primary for sku + selectedOptions even when we already
  // have productGid — they're needed to drive translateVariantId's fast path.
  var info = null;
  if (primary) {
    info = await queryPrimaryVariantInfo(primary, variantId);
  }
  var primaryProductGid = (primaryProductGidArg && String(primaryProductGidArg)) || (info ? info.productGid : null);
  var primarySku = info ? info.sku : null;
  var primarySelectedOptions = info ? info.selectedOptions : null;

  // Sprint 2 P0-2 Fix #4: when the active member is a secondary, the raw
  // primary variantId is INVALID at cartLinesAdd — sending it returns a null
  // cart and the self-heal createCart then fails too. Translation requires
  // either (a) a SKU or (b) selectedOptions. If queryPrimaryVariantInfo
  // returned null (primary's storefront token lacks the variant, primary is
  // down, or rate limited) we can't translate.
  //
  // OLD behavior: fall back to the raw primary variantId, which silently
  // corrupted carts on secondary members ("Código: 5xx" or wrong variant
  // appearing in the drawer).
  // NEW behavior: surface an explicit error so the customer sees a clear
  // message AND telemetry captures the failure mode.
  //
  // We're permissive when no pool exists or the active member IS primary —
  // the raw variantId is correct in those paths.
  var needsTranslation = !!(activeMemberId && primary && activeMemberId !== primary.id);
  var canTranslate = !!(primarySku || (primarySelectedOptions && primarySelectedOptions.length));
  if (needsTranslation && !canTranslate) {
    var reason = info ? 'translation_metadata_missing' : 'primary_query_failed';
    console.warn(
      'MC Cart: mcAddVariant cannot translate variantId=' + variantId +
      ' to secondary member=' + activeMemberId +
      ' (reason=' + reason + ', primaryProductGid=' + (primaryProductGid || 'null') +
      '). Refusing to send raw primary variantId (would corrupt cart).'
    );
    if(activeMemberId){
      reportMemberFailure(
        activeMemberId,
        'translation_unavailable',
        reason + ' for variantId=' + variantId + ' productGid=' + (primaryProductGid || 'null')
      );
    }
    mcOpen();
    showCartError('item_unavailable');
    return;
  }

  try{
    // Pass primaryProductGid so the server-side translation runs (resolve
    // populates activeVariantsBySkuByProduct + activeMemberProductGid
    // specifically for this product). Without it, fast path can't key into
    // anything useful.
    await ensureActiveCheckoutForAdd(null, variantId, primaryProductGid);
  }catch(err){
    if(err && err.poolExhausted){
      console.warn('MC Cart: pool exhausted — showing error');
      mcOpen();
      showCartError('pool_no_eligible_member');
      return;
    }
  }

  // Translate primary variantId → active member variantId. No-op when active
  // is primary (pool.members[0] on init, or sticky-resolved primary). When
  // active is a secondary, fast path uses the per-product variantsBySku map
  // (Sprint 2 P0-2); slow path queries the member product fresh; last resort
  // returns primaryVariantId unchanged so the downstream Shopify error
  // surfaces via the defensive createCart path (PR #80) rather than silently
  // adding the wrong variant.
  //
  // Pass activeMemberProductGid as the scope hint — applyActiveCheckout
  // (called inside ensureActiveCheckoutForAdd) just set it to the resolved
  // MEMBER productGid for this primaryProductGid, so the lookup hits the
  // correct per-product bucket.
  var memberVariantId = variantId;
  if (primarySku || (primarySelectedOptions && primarySelectedOptions.length)) {
    memberVariantId = await translateVariantId(variantId, primarySku, primarySelectedOptions, activeMemberProductGid);
  }

  try{
    // cartLines stores MEMBER variant ids (syncLines reads them from the
    // cartLinesAdd response), so dedupe must compare against the translated id.
    const existing = cartLines.find(l=>l.variantId===memberVariantId);
    if(existing){
      await updateLine(existing.lineId, existing.qty+1);
    } else {
      await addLine(memberVariantId);
    }
    const added = cartLines.find(l=>l.variantId===memberVariantId);
    // Pixel events keep the ORIGINAL (primary) variantId for attribution
    // stability across stores — it's the "logical" id merchants configured.
    if(added) trackEvent('AddToCart',{name:added.title,variantId,price:added.price,qty:1,currency:getCurrencyCode()});
    // A/B add_to_cart event
    if(window.__mcAbTestId&&window.__mcStoreId&&window.__mcTrackUrl){try{fetch(window.__mcTrackUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:window.__mcStoreId,ab_test_id:window.__mcAbTestId,ab_variant:window.__mcAbVariant,ab_visitor_id:window.__mcAbVisitorId,ab_event:'add_to_cart'}),keepalive:true}).catch(()=>{});}catch(e){}}
  }catch(e){
    console.error('MC Cart: addVariant error', e);
    if(activeMemberId){
      reportMemberFailure(activeMemberId, classifyStorefrontError(e), String(e && e.message || e));
    }
    mcOpen();
    showCartError(classifyStorefrontError(e));
  }
};

window.mcUpdateQty = async function(idx, newQty){
  const line = cartLines[idx]; if(!line) return;
  const wasRemoved = newQty <= 0;
  const removedName = line.title;
  const removedVid = line.variantId;
  // Optimistic update
  if(newQty <= 0) cartLines.splice(idx,1); else line.qty = newQty;
  render();
  try{
    await updateLine(line.lineId, newQty);
    if(wasRemoved) trackEvent('RemoveFromCart',{name:removedName,variantId:removedVid});
  }catch(e){
    console.error('MC Cart: updateQty error', e);
    await fetchCart();
  }
};

window.mcSwitchVariant = async function(idx, optionName, optionValue){
  const line = cartLines[idx]; if(!line) return;
  const cached = productCache[line.productId]; if(!cached) return;
  // Build new selected options by replacing the changed one
  const currentOpts = (line.selectedOptions || []).map(so => ({...so}));
  const newOpts = currentOpts.map(so => so.name === optionName ? {...so, value: optionValue} : so);
  // If option not in list, add it
  if(!newOpts.find(so=>so.name===optionName)) newOpts.push({name:optionName, value:optionValue});
  // Find matching variant
  const match = cached.variants.find(v =>
    v.selectedOptions.every(so => {
      const sel = newOpts.find(n=>n.name===so.name);
      return sel && sel.value === so.value;
    })
  );
  if(!match || !match.availableForSale) return;
  if(match.id === line.variantId) return; // Same variant
  // Optimistic update
  const oldLineId = line.lineId;
  const qty = line.qty;
  line.variantId = match.id;
  line.variant = match.title !== 'Default Title' ? match.title : '';
  line.price = match.priceV2.amount;
  line.comparePrice = match.compareAtPriceV2?.amount || null;
  line.image = mcImg(match.image?.url || '', match.id, line.productId, match.selectedOptions) || line.image;
  line.selectedOptions = match.selectedOptions;
  render();
  // API: remove old line, add new variant
  try{
    await updateLine(oldLineId, 0);
    await addLine(match.id, qty);
  }catch(e){
    console.error('MC Cart: switchVariant error', e);
    await fetchCart();
  }
};

window.mcToggleAddon = async function(variantId, checked, productGid){
  addonChecked[variantId] = checked;
  if(checked){
    // Sprint 2 P0-2: forward productGid so the translation is product-scoped.
    await mcAddVariant(variantId, productGid || '');
  } else {
    const line = cartLines.find(l=>l.variantId===variantId);
    if(line){
      const idx = cartLines.indexOf(line);
      await mcUpdateQty(idx, 0);
    }
  }
};

window.mcAddBundle = async function(items){
  // PR #92: verbose per-item logging. The previous loop silently swallowed
  // mcAddVariant failures (mcAddVariant catches its own errors and calls
  // showCartError but doesn't re-throw) — when one item in a multi-item
  // bundle fails to land on the secondary, the drawer showed only the
  // successful item(s) with no hint of what went wrong. Log a summary per
  // variantId so the console gives us something to triage with.
  //
  // We also check cartLines length before/after each attempt since
  // mcAddVariant dedupes by translated member variantId — the incoming
  // `vid` is the PRIMARY variantId that no longer matches cartLines on a
  // secondary (where lines carry member variantIds). The old
  // `cartLines.find(l=>l.variantId===vid)` check never matched on
  // secondaries, which was harmless but also useless. Using linesBefore/
  // linesAfter gives a post-facto signal of whether the add actually
  // landed.
  //
  // Sprint 2 P0-2: accept either legacy shape (array of variantId strings)
  // or new shape (array of {variantId, productGid}) so the engine can
  // pre-scope each translation by product when productGid is available.
  var normalized = (items || []).map(function(it){
    if (typeof it === 'string') return { variantId: it, productGid: '' };
    if (it && typeof it === 'object') return { variantId: it.variantId, productGid: it.productGid || '' };
    return null;
  }).filter(Boolean);
  var results = [];
  for (const it of normalized) {
    var linesBefore = Array.isArray(cartLines) ? cartLines.length : 0;
    try {
      await mcAddVariant(it.variantId, it.productGid);
      var linesAfter = Array.isArray(cartLines) ? cartLines.length : 0;
      results.push({ vid: it.variantId, added: linesAfter > linesBefore, linesBefore: linesBefore, linesAfter: linesAfter });
    } catch (err) {
      console.warn('MC Cart: mcAddBundle item threw', { vid: it.variantId, err: err });
      results.push({ vid: it.variantId, added: false, error: String((err && err.message) || err) });
    }
  }
  console.log('MC Cart: mcAddBundle summary', results);
};

window.mcApplyDiscount = function(){
  const input = $('#mc-dc-input');
  if(!input || !input.value.trim()) return;
  // Note: Storefront API discount codes are applied at checkout.
  // We store the code and append it to the checkout URL.
  localStorage.setItem('mc_discount', input.value.trim());
  input.style.borderColor='#2ea818';
  input.value = input.value.trim() + ' ✓';
  input.disabled = true;
};

window.mcCheckout = async function(){
  if(!cartId) return;
  try{
    // Save UTMs + tracking IDs as cart attributes (flow through to order note_attributes)
    const utms = getSavedUTMs();
    const attributes = Object.entries(utms).map(([k,v])=>({key:k,value:v}));
    // Note: document.referrer is intentionally NOT captured as a cart attribute.
    // It adds noise to order.note_attributes (typically the in-session product
    // page URL, not the marketing source). Shopify's native `referring_site`
    // already captures the real HTTP Referer at landing (facebook.com / google.com /
    // etc for ad traffic), and the UTMs above carry the explicit campaign data.
    // Meta tracking IDs — these bridge the browser session to the server-side Purchase event
    attributes.push({key:'_mc_ext_id',value:mcExtId});
    const _fbc = getCookie('_fbc'); if(_fbc) attributes.push({key:'_fbc',value:_fbc});
    const _fbp = getCookie('_fbp'); if(_fbp) attributes.push({key:'_fbp',value:_fbp});
    // A/B test attributes for purchase attribution (flow through to order note_attributes)
    if(window.__mcAbTestId){
      attributes.push({key:'_mc_ab_variant',value:window.__mcAbVariant});
      attributes.push({key:'_mc_ab_test_id',value:window.__mcAbTestId});
      utms.utm_content = 'variant_' + window.__mcAbVariant;
    }
    if(attributes.length > 0){
      try{
        await gql(`mutation($cartId:ID!,$attributes:[AttributeInput!]!){cartAttributesUpdate(cartId:$cartId,attributes:$attributes){cart{id}userErrors{message}}}`,{cartId:cartId,attributes:attributes});
        console.log('%c[MC Cart]%c Tracking attributes saved to cart ✓','background:#1a8c3e;color:#fff;padding:2px 6px;border-radius:3px','color:#1a8c3e', attributes);
      }catch(e){console.warn('[MC Cart] Failed to save attributes to cart:', e);}
    }

    // Also save cart note with UTMs for easy visibility in Shopify admin
    if(Object.keys(utms).length > 0){
      const utmNote = Object.entries(utms).map(([k,v])=>k+': '+v).join(' | ');
      const fullNote = cartNote ? cartNote + '\n---\n' + utmNote : utmNote;
      try{
        await gql(`mutation($cartId:ID!,$note:String!){cartNoteUpdate(cartId:$cartId,note:$note){cart{id}userErrors{message}}}`,{cartId:cartId,note:fullNote});
      }catch(e){console.warn('[MC Cart] Failed to save note:', e);}
    }

    const data = await gql(`query($id:ID!){cart(id:$id){checkoutUrl}}`,{id:cartId});
    let url = data.cart.checkoutUrl;
    // Build URL using URL API for safe param handling
    const urlObj = new URL(url);
    // Remove preview_theme_id param (leaks from Shopify preview mode)
    urlObj.searchParams.delete('preview_theme_id');
    // Add discount code
    const discount = localStorage.getItem('mc_discount');
    if(discount) urlObj.searchParams.set('discount', discount);
    // Add cart note
    if(cartNote) urlObj.searchParams.set('note', cartNote);
    // Pass UTM parameters to checkout URL (redundant with cart attributes, but helps with GA tracking)
    Object.entries(utms).forEach(([k,v])=>{
      urlObj.searchParams.set(k, v);
    });
    url = urlObj.toString();
    // Always log checkout URL for debugging
    console.log('%c[MC Cart Checkout]%c URL: '+url, 'background:#1a8c3e;color:#fff;padding:2px 6px;border-radius:3px','color:#1a8c3e');
    console.log('%c[MC Cart UTMs]%c', 'background:#59493a;color:#fff;padding:2px 6px;border-radius:3px','color:#59493a', Object.keys(utms).length ? utms : '(nenhuma UTM capturada — URL da página não continha utm_source, fbclid, etc.)');
    // Track InitiateCheckout
    const subtotal = cartLines.reduce((s,l)=>s+parseFloat(l.price)*l.qty,0);
    trackEvent('InitiateCheckout',{
      total:subtotal,
      numItems:cartLines.reduce((s,l)=>s+l.qty,0),
      currency:getCurrencyCode(),
      items:cartLines.map(l=>({item_id:l.variantId,item_name:l.title,price:parseFloat(l.price),quantity:l.qty}))
    });
    // MC Sync order tracking (fire-and-forget). event_id = id estável por
    // carrinho p/ idempotência do /api/track (deduplica retries; inócuo com a
    // flag off). Gerado ANTES do 1º envio e reusado nos reenvios do mesmo cart.
    if(window.__mcStoreId&&window.__mcTrackUrl){try{var mcEvtId=mcCheckoutEventId(cartId);fetch(window.__mcTrackUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:window.__mcStoreId,event_id:mcEvtId,cartId:cartId,subtotal:subtotal,currency:getCurrencyCode(),itemCount:cartLines.reduce((s,l)=>s+l.qty,0),utms:getSavedUTMs(),referrer:document.referrer||''}),keepalive:true}).catch(()=>{});
      // Limpa o id do evento após o disparo do checkout: o cartId persiste no
      // localStorage e não é zerado pela compra; sem isto um 2º checkout do MESMO
      // cartId na mesma sessão reusaria o id e (flag on) o 2º pedido distinto
      // seria deduplicado/perdido. Removendo, um novo checkout gera id novo.
      try{ sessionStorage.removeItem('mc_evt:'+cartId); }catch(e){}}catch(e){}}
    // A/B checkout event
    if(window.__mcAbTestId&&window.__mcStoreId&&window.__mcTrackUrl){try{fetch(window.__mcTrackUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:window.__mcStoreId,ab_test_id:window.__mcAbTestId,ab_variant:window.__mcAbVariant,ab_visitor_id:window.__mcAbVisitorId,ab_event:'checkout'}),keepalive:true}).catch(()=>{});}catch(e){}}
    // Use location.href instead of window.open to avoid popup blockers on mobile
    window.location.href = url;
  }catch(e){
    console.error('MC Cart: checkout error', e);
  }
};

/* ---- Page Variant Selector ---- */
let pageSelectedOptions = {}; // {optionName: value}
let pageProductData = null; // cached product data for page selector

function renderPageVariants(productGid){
  if(!C.variantOnPage) return;
  // Find all containers with data-mc-variants matching this product
  const containers = document.querySelectorAll('[data-mc-variants="'+productGid+'"]');
  if(!containers.length) return;
  if(!pageProductData) return;

  const options = pageProductData.options || [];
  const variants = pageProductData.variants || [];
  if(!options.length || (options.length===1 && options[0].values.length<=1)) return;

  // Semeia TODAS as opções antes de renderizar. O laço abaixo pula as de valor
  // único, então elas nunca entrariam em pageSelectedOptions — e é isso que
  // fazia getSelectedVariant() não casar nenhuma variante.
  mcSeedDefaultOptions(options, pageSelectedOptions);

  containers.forEach(container => {
    let html = '<div class="mc-page-variants">';
    options.forEach(opt => {
      if(opt.values.length <= 1) return;
      const currentVal = pageSelectedOptions[opt.name] || opt.values[0];
      // Initialize default selection
      if(!pageSelectedOptions[opt.name]) pageSelectedOptions[opt.name] = opt.values[0];
      const optStyle = (C.varStyles||{})[opt.name] || C.variantDisplay || 'pill';
      let optsHTML = '';
      if(optStyle === 'swatch'){
        optsHTML = opt.values.map(val => {
          const isActive = val === currentVal;
          const matchV = variants.find(v=>v.selectedOptions.some(so=>so.name===opt.name&&so.value===val));
          const img = matchV?.image?.url || '';
          const avail = variants.some(v=>v.availableForSale&&v.selectedOptions.some(so=>so.name===opt.name&&so.value===val));
          const colorHex = (C.swatchColors||{})[val];
          return `<button class="mc-page-var-swatch${isActive?' mc-pv-active':''}${!avail?' mc-pv-unavail':''}" title="${esc(val)}" onclick="mcPageSelectOption('${esc(opt.name)}','${esc(val)}','${productGid}')" ${!avail?'disabled':''}>${colorHex ? `<span style="display:block;width:100%;height:100%;background:${esc(colorHex)}"></span>` : (img?`<img src="${img}" alt="${esc(val)}">`:`<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:10px">${esc(val.substring(0,4))}</span>`)}</button>`;
        }).join('');
      } else if(optStyle === 'dropdown'){
        const opts = opt.values.map(val => {
          const avail = variants.some(v=>v.availableForSale&&v.selectedOptions.some(so=>so.name===opt.name&&so.value===val));
          return `<option value="${esc(val)}"${val===currentVal?' selected':''}${!avail?' disabled':''}>${esc(val)}${!avail?' (indisponível)':''}</option>`;
        }).join('');
        optsHTML = `<select class="mc-page-var-dropdown" onchange="mcPageSelectOption('${esc(opt.name)}',this.value,'${productGid}')">${opts}</select>`;
      } else {
        optsHTML = opt.values.map(val => {
          const isActive = val === currentVal;
          const avail = variants.some(v=>v.availableForSale&&v.selectedOptions.some(so=>so.name===opt.name&&so.value===val));
          return `<button class="mc-page-var-pill${isActive?' mc-pv-active':''}${!avail?' mc-pv-unavail':''}" onclick="mcPageSelectOption('${esc(opt.name)}','${esc(val)}','${productGid}')" ${!avail?'disabled':''}>${esc(val)}</button>`;
        }).join('');
      }
      html += `<div class="mc-page-var-group"><div class="mc-page-var-label">${esc(opt.name)}</div><div class="mc-page-var-opts">${optsHTML}</div></div>`;
    });
    html += '</div>';
    container.innerHTML = html;
  });

  // Update button price/image if product info display exists
  updatePageProductDisplay();
}

function updatePageProductDisplay(){
  if(!pageProductData) return;
  const match = getSelectedVariant();
  if(!match) return;
  // Update any elements with data-mc-price or data-mc-image
  document.querySelectorAll('[data-mc-price]').forEach(el=>{el.textContent = CUR+' '+fmt(match.priceV2.amount);});
  document.querySelectorAll('[data-mc-image]').forEach(el=>{if(match.image?.url) el.src=match.image.url;});
}

// 2026-08-23 — semeia o default de TODA opção, inclusive as de valor único.
// renderPageVariants() pula essas (`if(opt.values.length <= 1) return;`) porque
// não há o que escolher, e por isso nunca as semeava. Só que
// getSelectedVariant() casa pelo conjunto COMPLETO de selectedOptions da
// variante: uma opção não semeada faz `undefined === 'One Size'` e derruba o
// .every() de todas as variantes. O cliente clicava Vermelho e comprava Preto.
function mcSeedDefaultOptions(options, selected){
  (options||[]).forEach(function(opt){
    if(!opt || !opt.name || !opt.values || !opt.values.length) return;
    if(selected[opt.name] === undefined) selected[opt.name] = opt.values[0];
  });
  return selected;
}

function getSelectedVariant(){
  if(!pageProductData) return null;
  const variants = pageProductData.variants || [];
  mcSeedDefaultOptions(pageProductData.options, pageSelectedOptions);
  const match = variants.find(v=>v.selectedOptions.every(so=>pageSelectedOptions[so.name]===so.value));
  if(match) return match;
  // Sem correspondência exata. O `|| variants[0]` que estava aqui é como o
  // cliente acabava pagando por uma variante que não escolheu. Só devolve a
  // única variante quando de fato não há escolha a fazer.
  if(variants.length === 1) return variants[0];
  return null;
}

window.mcPageSelectOption = function(optName, optValue, productGid){
  pageSelectedOptions[optName] = optValue;
  renderPageVariants(productGid);
};

// Override mcAddToCart to use page-selected variant
const originalAddToCart = window.mcAddToCart;
window.mcAddToCart = async function(productGid){
  if(C.variantOnPage && pageProductData){
    const selected = getSelectedVariant();
    if(selected){
      mcOpen();
      const body = $('.mc-body');
      if(body && cartLines.length===0) body.innerHTML='<div style="padding:60px;text-align:center"><div class="mc-spinner"></div></div>';
      // Pool resolve — pass productGid so the server can translate it to the
      // chosen member's own gid. We intentionally pass `null` for the SKU arg
      // even though `selected.sku` is available:
      //   - The SKU param drives an availability filter in pickPoolMember
      //     that excludes any member whose availability map doesn't list the
      //     SKU. That map is computed by a periodic crawl of each member's
      //     Storefront catalog (availableForSale=true products).
      //   - When the member catalog has stale or partial availability (e.g.
      //     a product was cloned but not yet marked available, or the clone
      //     landed on a SKU-collision target product — see PR #77), the
      //     filter silently removes the secondary and weight is no longer
      //     honored. Bucketing becomes 100% primary.
      //   - We rely on (a) product_mappings translation (PR #79) to get the
      //     right variant, and (b) cartCreate's defensive null-cart handler
      //     below to surface a classifiable error when a member genuinely
      //     cannot fulfill. That's a better tradeoff than silent bucket skew.
      // `selected.sku` still reaches translateVariantId client-side for the
      // variant lookup — the SKU path there is independent from the resolve
      // filter semantics.
      try{
        await ensureActiveCheckoutForAdd(null, selected.id, productGid);
      }catch(err){
        if(err && err.poolExhausted){
          console.warn('MC Cart: pool exhausted — showing error');
          showCartError('pool_no_eligible_member');
          return;
        }
      }
      try{
        // Phase 1.5.5: swap primary variant id → active member's variant id.
        // No-op on primary. On secondary, uses activeVariantsByOptionsByProduct
        // (Sprint 2 P0-2, unambiguous when variants share a SKU and scoped per
        // product) / activeVariantsBySkuByProduct from resolve (zero round-trip)
        // or falls back to a fresh member product query. cartLines stores MEMBER
        // variant ids (syncLines reads them from cartLinesAdd response), so
        // dedupe must compare against the member id.
        // activeMemberProductGid = MEMBER's productGid translated from the
        // primary `productGid` we passed into ensureActiveCheckoutForAdd above.
        const variantId = await translateVariantId(selected.id, selected.sku, selected.selectedOptions, activeMemberProductGid);
        const existing = cartLines.find(l=>l.variantId===variantId);
        if(existing){
          await updateLine(existing.lineId, existing.qty+1);
        } else {
          await addLine(variantId);
        }
        trackEvent('AddToCart',{name:pageProductData.title||'',variantId:selected.id,price:selected.priceV2.amount,qty:1,currency:getCurrencyCode()});
        // A/B add_to_cart event
        if(window.__mcAbTestId&&window.__mcStoreId&&window.__mcTrackUrl){try{fetch(window.__mcTrackUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId:window.__mcStoreId,ab_test_id:window.__mcAbTestId,ab_variant:window.__mcAbVariant,ab_visitor_id:window.__mcAbVisitorId,ab_event:'add_to_cart'}),keepalive:true}).catch(()=>{});}catch(e){}}
      }catch(e){
        console.error('MC Cart: addToCart error', e);
        if(activeMemberId){
          reportMemberFailure(activeMemberId, classifyStorefrontError(e), String(e && e.message || e));
        }
        showCartError(classifyStorefrontError(e));
      }
      return;
    }
  }
  // Fallback to original behavior
  return originalAddToCart(productGid);
};

/* ---- Page Price Override ----
 *
 * Goal (2026-05-03 simplification per merchant feedback):
 * Show the current variant's price in ONE element placed above the variant
 * pickers. Don't touch the theme's existing price elements — the merchant
 * hides those via theme CSS. We just paint the right number on top.
 *
 * Anchor priority:
 *   1. [data-mc-price] — explicit merchant placement, fully controlled.
 *   2. Auto-injected <div class="mc-page-price"> placed immediately before
 *      the first [data-mc-variants] element.
 *
 * Price source: ALWAYS primary's catalog (via gqlPrimary in initPageVariants).
 * All pool members share prices in this product setup, so a per-member
 * overlay would just add complexity without changing the displayed value.
 *
 * Variant-change triggers (any of):
 *   - URL ?variant= changes (popstate, history.pushState/replaceState)
 *   - <input/select name="id"> change events
 *   - Document-level click (catches custom variant buttons that don't fire
 *     `change` and don't update the URL — common in modern dropshipping
 *     themes with swatch-style pickers).
 */
let _pagePriceWatcherInstalled = false;
let _pagePriceEl = null;

function pageVariantIdFromUrl(){
  try { return new URL(window.location.href).searchParams.get('variant') || null; }
  catch(e){ return null; }
}

function pageCurrentVariantId(){
  const fromUrl = pageVariantIdFromUrl();
  if(fromUrl) return fromUrl;
  try {
    // Prefer the cart-add form's id (always reflects the visitor's current
    // selection in any standard Shopify theme — the form has to submit a
    // valid variant ID to /cart/add). Standalone [name="id"] inputs come
    // second since some themes have stale duplicates outside the form.
    const form = document.querySelector('form[action*="/cart/add"]');
    if(form){
      const idEl = form.querySelector('input[name="id"], select[name="id"]');
      if(idEl && idEl.value) return idEl.value;
    }
    const el = document.querySelector('input[name="id"], select[name="id"]');
    if(el && el.value) return el.value;
  } catch(e) { /* ignore */ }
  return null;
}

// Read selected option values directly from the cart-add form. Shopify's
// product form always carries the current variant selection — either as
// option1/option2/option3, options[Name], or a hidden id. This is far more
// reliable than guessing which button is "active" in the theme markup.
function pageDetectFromForm(){
  if(!pageProductData || !pageProductData.options) return null;
  try {
    // A page can have MULTIPLE cart-add forms (PDP form + cart drawer mini-form
    // + sticky bar variant). Iterate all of them and return the first that
    // resolves every option name. This avoids picking the cart-drawer form
    // that only has `id` and missing options[Name] fields.
    const forms = document.querySelectorAll('form[action*="/cart/add"]');
    for(const form of forms){
      const fd = new FormData(form);
      const result = {};
      for(let i = 0; i < pageProductData.options.length; i++){
        const opt = pageProductData.options[i];
        let val = fd.get('options[' + opt.name + ']')
               || fd.get(opt.name)
               || fd.get('option-' + (i + 1))
               || fd.get('option' + (i + 1));
        if(val) result[opt.name] = String(val);
      }
      if(Object.keys(result).length === pageProductData.options.length) return result;
    }
    return null;
  } catch(e) {
    return null;
  }
}

// Cross-reference any :checked radio/checkbox in the document against the
// known option values. Theme-agnostic: doesn't care about the input's name,
// only that its value matches one of the values we expect for some option.
// Catches themes where variant pickers are radios but use unusual `name`
// attributes (e.g. `id-Color`, `Option_Color`, etc).
function pageDetectFromCheckedInputs(){
  if(!pageProductData || !pageProductData.options) return null;
  try {
    const valueToOption = {};
    for(const opt of pageProductData.options){
      for(const val of (opt.values || [])){
        if(!valueToOption[val]) valueToOption[val] = opt.name;
      }
    }
    const result = {};
    document.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach(function(el){
      const v = el.value;
      const optName = valueToOption[v];
      if(optName && !result[optName]) result[optName] = v;
    });
    return Object.keys(result).length === pageProductData.options.length ? result : null;
  } catch(e) {
    return null;
  }
}

// Last-resort heuristic: among buttons whose text matches one of an option's
// values, find the one with the darkest background (active state typically
// inverts colors). Returns the matched value or null. Used per-option when
// no class/aria/form signal worked.
function pageFindActiveByDarkestBg(values){
  try {
    const candidates = document.querySelectorAll('button, [role="button"], label');
    let bestVal = null;
    let bestBrightness = 999;
    for(const el of candidates){
      const txt = (el.textContent || '').trim();
      if(!txt) continue;
      const matchedVal = values.find(function(v){
        return txt === v || txt.startsWith(v + ' ') || txt.startsWith(v + '(') || txt === v.trim();
      });
      if(!matchedVal) continue;
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(el) : null;
      if(!cs) continue;
      const bg = cs.backgroundColor || '';
      const m = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if(!m) continue;
      const brightness = (parseInt(m[1]) + parseInt(m[2]) + parseInt(m[3])) / 3;
      // Skip near-white / transparent backgrounds — they're inactive states.
      // Active buttons in this style are typically brightness < 100.
      if(brightness >= 200) continue;
      if(brightness < bestBrightness){
        bestBrightness = brightness;
        bestVal = matchedVal;
      }
    }
    return bestVal;
  } catch(e) {
    return null;
  }
}

function findPageVariantById(id){
  if(!id || !pageProductData || !pageProductData.variants) return null;
  const idStr = String(id);
  return pageProductData.variants.find(v => v.id === idStr || (v.id && v.id.endsWith('/' + idStr))) || null;
}

// Detect the customer's currently-selected variant by reading the THEME'S
// option pickers (radio inputs, selects, OR buttons with active styling).
// Many modern dropshipping themes use custom <button> swatches that don't
// update the URL or fire `change` on a hidden input, so the ID-based path
// stays stuck on the default variant. Reading the active OPTIONS works
// regardless of how the theme implements the pickers.
function pageDetectActiveOptions(){
  if(!pageProductData || !pageProductData.options) return null;
  const result = {};
  for(const opt of pageProductData.options){
    const optName = opt.name;
    const values = opt.values || [];
    let value = null;

    // 1. <input type="radio" name="options[X]" checked> or name="X"
    let radio = document.querySelector('input[name="options[' + CSS.escape(optName) + ']"]:checked')
              || document.querySelector('input[name="' + CSS.escape(optName) + '"]:checked');
    if(radio && radio.value) value = radio.value;

    // 2. <select name="options[X]"> or name="X"
    if(!value){
      const sel = document.querySelector('select[name="options[' + CSS.escape(optName) + ']"], select[name="' + CSS.escape(optName) + '"]');
      if(sel && sel.value) value = sel.value;
    }

    // 3. Active button — match each option value's text against the DOM,
    //    pick the candidate with the most "active" signals (aria-pressed,
    //    is-active/active/selected class, or pressed-state class names).
    if(!value){
      const ACTIVE_CLASSES = ['is-active', 'active', 'selected', 'is-selected', 'mc-pv-active', 'is-checked', 'product-form__option--selected'];
      for(const val of values){
        const candidates = document.querySelectorAll('button, [role="button"], label, a');
        for(const el of candidates){
          const txt = (el.textContent || '').trim();
          if(!txt) continue;
          // Match exact, startsWith (catches "M ( 15in ... )" buttons), or
          // wrapping label (theme renders inner span/text).
          const matchesText = txt === val || txt.startsWith(val + ' ') || txt.startsWith(val + '(') || txt === val.trim();
          if(!matchesText) continue;
          const isActive = el.getAttribute('aria-pressed') === 'true'
            || el.getAttribute('aria-checked') === 'true'
            || ACTIVE_CLASSES.some(function(c){ return el.classList.contains(c); });
          if(isActive){ value = val; break; }
        }
        if(value) break;
      }
    }

    if(value) result[optName] = value;
  }
  return Object.keys(result).length === pageProductData.options.length ? result : null;
}

function findPageVariantByOptions(opts){
  if(!opts || !pageProductData || !pageProductData.variants) return null;
  const names = Object.keys(opts);
  return pageProductData.variants.find(function(v){
    if(!v.selectedOptions) return false;
    return names.every(function(n){
      return v.selectedOptions.some(function(so){ return so.name === n && so.value === opts[n]; });
    });
  }) || null;
}

function ensurePagePriceElement(){
  if(_pagePriceEl && document.body && document.body.contains(_pagePriceEl)) return _pagePriceEl;
  // Priority 1: explicit merchant placement.
  const explicit = document.querySelector('[data-mc-price]');
  if(explicit){
    _pagePriceEl = explicit;
    return _pagePriceEl;
  }
  // Priority 2: a previous engine instance OR a stale theme-added element
  // already exists with our class. Reuse it (and clean up extras) so we
  // never end up with duplicate "$ X.XX" stacked on the page after a
  // re-render or an in-page navigation that re-runs initPageVariants.
  const existing = document.querySelectorAll('.mc-page-price');
  if(existing.length){
    _pagePriceEl = existing[0];
    // Make sure the element carries [data-mc-price] so updatePageProductDisplay
    // (the engine's own price-painter, called on every mcPageSelectOption click)
    // finds it. This is what makes the price track variant clicks the same way
    // the cart drawer does — both go through the same path.
    if(!_pagePriceEl.hasAttribute('data-mc-price')) _pagePriceEl.setAttribute('data-mc-price', '');
    for(let i = 1; i < existing.length; i++){
      try { existing[i].remove(); } catch(e) { /* ignore */ }
    }
    return _pagePriceEl;
  }
  // Priority 3: auto-inject before [data-mc-variants]. The element gets BOTH
  // the .mc-page-price class (for our default styling) AND data-mc-price so
  // the engine's existing updatePageProductDisplay() — which already runs on
  // every variant click via mcPageSelectOption — keeps it in sync without
  // any of the heuristic detection chain.
  const anchor = document.querySelector('[data-mc-variants]');
  if(anchor && anchor.parentNode){
    const div = document.createElement('div');
    div.className = 'mc-page-price';
    div.setAttribute('data-mc-price', '');
    anchor.parentNode.insertBefore(div, anchor);
    _pagePriceEl = div;
    return _pagePriceEl;
  }
  return null;
}

function applyPagePrice(variant){
  if(!variant || !variant.priceV2) return;
  const el = ensurePagePriceElement();
  if(!el) return;
  el.textContent = CUR + ' ' + fmt(variant.priceV2.amount);
}

function setupPagePriceOverride(){
  if(!C.overridePagePrice || !pageProductData || _pagePriceWatcherInstalled) return;
  _pagePriceWatcherInstalled = true;

  // Make sure the [data-mc-price] anchor is in the DOM. The engine's
  // updatePageProductDisplay (called on every variant click via
  // mcPageSelectOption → renderPageVariants) writes to it directly.
  ensurePagePriceElement();

  // FAST PATH: when our engine renders the PDP variant pickers
  // (variantOnPage:true and an anchor exists), the engine's own click
  // handler already keeps [data-mc-price] in sync with every variant
  // change — same path the cart drawer uses. Installing our own
  // detection-chain listener here would create a double-update race
  // (correct paint, then ~100ms later our heuristic re-detect overwrites
  // with wrong variant). Bail out before installing listeners.
  const enginePickerActive = !!C.variantOnPage && document.querySelectorAll('[data-mc-variants]').length > 0;
  if(enginePickerActive) return;

  function tick(){
    let variant = null;
    // Priority 1 — cart-add form options. Walks ALL forms; returns first
    // with full options resolved (skips the cart-drawer mini-form which
    // only carries `id`).
    const fromForm = pageDetectFromForm();
    if(fromForm) variant = findPageVariantByOptions(fromForm);
    // Priority 2 — checked radios/checkboxes whose value matches a known
    // option value. Theme-agnostic, ignores the input's `name`.
    if(!variant){
      const fromInputs = pageDetectFromCheckedInputs();
      if(fromInputs) variant = findPageVariantByOptions(fromInputs);
    }
    // Priority 3 — heuristic class/attr detection (aria-pressed, .is-active,
    // .selected, etc).
    if(!variant){
      const opts = pageDetectActiveOptions();
      if(opts) variant = findPageVariantByOptions(opts);
    }
    // Priority 4 — per-option darkest-background fallback. For themes whose
    // active button is signaled only by inline-style background (no class,
    // no aria, no form sync), pick the one with the darkest computed BG.
    if(!variant && pageProductData.options){
      const result = {};
      for(const opt of pageProductData.options){
        const v = pageFindActiveByDarkestBg(opt.values || []);
        if(v) result[opt.name] = v;
      }
      if(Object.keys(result).length === pageProductData.options.length){
        variant = findPageVariantByOptions(result);
      }
    }
    // Priority 5 — variant ID from URL or [name="id"].
    if(!variant){
      const id = pageCurrentVariantId();
      variant = findPageVariantById(id);
    }
    // Priority 6 — first variant fallback.
    if(!variant && pageProductData.variants) variant = pageProductData.variants[0];
    if(variant) applyPagePrice(variant);
  }

  tick();

  window.addEventListener('popstate', tick);
  const _push = history.pushState;
  history.pushState = function(){ _push.apply(this, arguments); setTimeout(tick, 0); };
  const _replace = history.replaceState;
  history.replaceState = function(){ _replace.apply(this, arguments); setTimeout(tick, 0); };

  document.addEventListener('change', function(e){
    const t = e.target;
    if(t && (t.name === 'id' || (t.matches && t.matches('[name="id"]')))){
      setTimeout(tick, 0);
    }
  }, true);

  document.addEventListener('click', function(){ setTimeout(tick, 100); }, true);
}

/* ---- Init page variant selectors ---- */
async function initPageVariants(){
  // Load product data when EITHER variant rendering OR price override is enabled.
  //
  // Source of productGid (priority order):
  //   1. `[data-mc-variants="..."]` — explicit theme integration; required
  //      whenever the merchant wants the variant SELECTOR rendered (we need
  //      that DOM anchor to know WHERE to inject the picker).
  //   2. `C.currentProductGid` — set by the loader when the URL matches
  //      `/products/{handle}` and the handle has a primary `product_mappings`
  //      entry. Enough for the price-override path even when the theme has
  //      no [data-mc-variants] attribute. Without this fallback every store
  //      would need a manual theme edit just to opt in to overridePagePrice.
  const needsRender = !!C.variantOnPage;
  const needsPriceOverride = !!C.overridePagePrice;
  if(!needsRender && !needsPriceOverride) return;
  const containers = document.querySelectorAll('[data-mc-variants]');
  let productGid = null;
  if(containers.length){
    productGid = containers[0].getAttribute('data-mc-variants');
  } else if(needsPriceOverride && C.currentProductGid){
    productGid = C.currentProductGid;
  }
  if(!productGid) return;
  try{
    // PR #92: always query the PRIMARY store's catalog for the PDP variant
    // picker. data-mc-variants is set by the theme liquid from
    // stores.product_mappings[handle].checkoutGid which is always primary's
    // productGid. If we query the ACTIVE member (which might be a secondary
    // when bucketing moved the visitor), a primary productGid returns null
    // there and the variant selector never renders. Primary is always the
    // canonical source for what the customer sees on the theme; cart-level
    // translation handles where the add-to-cart actually lands.
    const data = await gqlPrimary(`query($id:ID!){product(id:$id){id title options{name values}variants(first:100){edges{node{id sku title availableForSale selectedOptions{name value}priceV2{amount}compareAtPriceV2{amount}image{url}}}}}}`,{id:productGid});
    if(data.product){
      pageProductData = {
        ...data.product,
        variants: data.product.variants.edges.map(({node})=>node),
      };
      productCache[data.product.id] = {options:data.product.options, variants:pageProductData.variants};
      // setupPagePriceOverride must run BEFORE renderPageVariants so that the
      // [data-mc-price] anchor is in the DOM when renderPageVariants → end of
      // pipeline calls updatePageProductDisplay (which writes the initial
      // variant price to that anchor). Otherwise the first paint misses.
      if(needsPriceOverride) setupPagePriceOverride();
      // renderPageVariants needs the [data-mc-variants] DOM anchor — skip it
      // when we got here via the C.currentProductGid fallback path.
      if(needsRender && containers.length) renderPageVariants(productGid);
    }
  }catch(e){console.warn('MC Cart: failed to load product variants', e);}
}

/* ---- Quantity Breaks / Volume Discounts ---- */
function renderQuantityBreaks(line){
  if(!C.quantityBreaks || !C.quantityBreaks.enabled) return '';
  const breaks = C.quantityBreaks.tiers || [];
  if(!breaks.length) return '';
  let html = '<div class="mc-qty-breaks" style="padding:4px 0;margin-top:4px">';
  breaks.forEach(b => {
    const active = line.qty >= b.qty;
    html += `<span style="display:inline-block;font-size:9px;padding:2px 6px;border-radius:10px;margin-right:4px;${active?'background:#10b981;color:#fff':'background:#f1f5f9;color:#64748b'}">${b.qty}+ = ${b.discount}% off</span>`;
  });
  html += '</div>';
  return html;
}

/* ---- Countdown Timer per Product ---- */
function renderProductCountdown(){
  if(!C.productCountdown || !C.productCountdown.enabled) return '';
  const mins = parseInt(C.productCountdown.minutes) || 10;
  const text = C.productCountdown.text || 'Offer ends in {TIMER}';
  const bg = C.productCountdown.bg || '#fef3c7';
  const color = C.productCountdown.color || '#92400e';
  return `<div class="mc-product-countdown" style="background:${bg};color:${color};padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;text-align:center;margin:8px 0">
    ${text.replace(/\{timer\}/gi,'<span class="mc-product-timer" data-minutes="'+mins+'">'+String(mins).padStart(2,'0')+':00</span>')}
  </div>`;
}
function startProductCountdowns(){
  document.querySelectorAll('.mc-product-timer').forEach(el => {
    if(el.dataset.started) return;
    el.dataset.started = '1';
    let secs = (parseInt(el.dataset.minutes)||10)*60;
    const key = 'mc_countdown_' + el.dataset.minutes;
    const saved = parseInt(sessionStorage.getItem(key));
    if(saved && saved > 0) secs = saved;
    const tick = () => {
      if(secs <= 0){el.textContent='00:00';return;}
      secs--;
      sessionStorage.setItem(key, secs);
      el.textContent = String(Math.floor(secs/60)).padStart(2,'0')+':'+String(secs%60).padStart(2,'0');
    };
    setInterval(tick, 1000);
    tick();
  });
}

/* ---- Social Proof ---- */
function renderSocialProof(){
  if(!C.socialProof || !C.socialProof.enabled) return '';
  const sp = C.socialProof;
  const viewers = sp.minViewers + Math.floor(Math.random()*(sp.maxViewers-sp.minViewers+1));
  const sold = sp.minSold + Math.floor(Math.random()*(sp.maxSold-sp.minSold+1));

  // Detect-and-adapt: if the merchant typed {count} in the template, substitute
  // it in place (the dashboard UI hints {count} as a placeholder). Otherwise
  // keep the legacy behavior of auto-prepending the number before the text so
  // existing stores that never used the placeholder don't lose their number.
  function withCount(text, n){
    var s = typeof text === 'string' ? text : '';
    if(/\{count\}/i.test(s)) return s.replace(/\{count\}/gi, '<b>'+n+'</b>');
    return '<b>'+n+'</b> '+s;
  }

  let html = '<div class="mc-social-proof" style="padding:8px 12px;font-size:11px;color:#64748b;display:flex;flex-direction:column;gap:4px">';
  if(sp.showViewers !== false){
    const txt = sp.viewersText || 'people are viewing this right now';
    html += `<div style="display:flex;align-items:center;gap:4px"><span style="width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block;animation:mc-pulse 1.5s infinite"></span> ${withCount(txt, viewers)}</div>`;
  }
  if(sp.showSold !== false){
    const txt = sp.soldText || 'sold in the last 24 hours';
    html += `<div style="display:flex;align-items:center;gap:4px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> ${withCount(txt, sold)}</div>`;
  }
  html += '</div>';
  return html;
}

/* ---- Init ---- */
injectStyles();
buildDrawer();
render();
// Serialize init so the Storefront-facing calls (fetchCart, initPageVariants)
// see a settled active member. bootstrapActiveMember resolves the sticky
// member via /api/pool/resolve for pool-of-N; it's a no-op otherwise.
(async function cartInit(){
  await bootstrapActiveMember();
  if(cartId) await fetchCart();
  await initPageVariants();
})();

// Fire ViewContent event on product pages (pixel + CAPI)
if(C.currentProductGid){
  trackEvent('ViewContent',{
    contentIds:[C.currentProductGid],
    name: document.title || C.currentProductHandle || '',
    price: 0
  });
}

// Cloud mode: exibir botoes que estao escondidos (display:none)
// Se mc-cart.js carregou, a assinatura esta ativa — pode mostrar
document.querySelectorAll('#mc-cloud-root').forEach(function(el){ el.style.display = ''; });

})();
