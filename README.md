# mc-cart-engine

Public CDN mirror for the MC Sync cart engine and bootstrap. **Read-only mirror** — source of truth is `github.com/jonatas-sketch/mc-sync-ui/public/mc-cart*.js`. PRs that change `engines/*` are opened automatically by the [sync workflow](https://github.com/jonatas-sketch/mc-sync-ui/blob/main/.github/workflows/sync-engine-to-cdn.yml).

## What is this?

The MC Sync SaaS injects a `<script src>` tag into every customer's Shopify store. Until 2026-05-20 that tag pointed to `mcsync.app/api/storefront/{storeId}/loader.js` — making Railway a single point of failure for cart UI (vide [outage 2026-05-19](https://github.com/jonatas-sketch/mc-sync-ui/blob/main/docs/SPEC-cdn-fallback-mc-cart.md)). This repo hosts an immutable, jsDelivr-served bootstrap that orchestrates Railway-first / localStorage-fallback boot, so the cart keeps working when the upstream is down.

## Versioning

Strict SemVer pinned by **immutable tag**. `v1.0.0`, `v1.0.1`, … `v1.1.0`. Never `@latest`. Never overwrite tags. Rollback = re-create ScriptTags pointing to the previous tag (see [SPEC §5.3](https://github.com/jonatas-sketch/mc-sync-ui/blob/main/docs/SPEC-cdn-fallback-mc-cart.md)).

## Served via

- `https://cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@vX.Y.Z/bootstrap/mc-bootstrap.js`
- `https://cdn.jsdelivr.net/gh/jonatas-sketch/mc-cart-engine@vX.Y.Z/engines/mc-cart.js`
- (and variants `mc-cart-page.js`, `mc-cart-skip.js`, `mc-cart-native.js`)

jsDelivr caches each tag for 7 days (`Cache-Control: public, max-age=604800`).

## Local development

```bash
npm install
npm test
```

Tests use Node's built-in `node:test` + `jsdom` to simulate the browser environment for the bootstrap IIFE.
