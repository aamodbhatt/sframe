# ADR-0001: Opaque sandbox navigation is not service-worker controlled in the pinned browsers

Status: **rejected premise / Phase 0 blocker**

Date: 2026-08-21
Scope: Phase 0 browser security spike

## Decision

Do not claim the Phase 0 renderer architecture passes. Do not add
`allow-same-origin`, use a Blob/document CSP fallback, execute publisher code
in a DOM realm, or remove the renderer response CSP to make the demo load.

The safer contract for this revision is to remove the exact opaque-renderer
path from the supported matrix until a browser-supported design is proven. The
implementation stops before Phase 1 and Phase 2; no package, personal-app, or
shared-room gate may be reported green from this spike.

## Evidence

The local test used the exact loopback contract and pinned Playwright engines:

- controller: `http://app.localhost:4173`
- service worker: verified build-pinned renderer response in Cache Storage
- iframe: `sandbox="allow-scripts"`, no `allow-same-origin`
- renderer cache entry: `smallframe-renderer-<digest>` with the synthetic CSP,
  `connect-src 'none'`, `sandbox allow-scripts`, and `frame-ancestors
  http://app.localhost:4173`
- comparison: the same worker intercepted the implemented normal parent
  `/sw-probe` request; the probe returns a Service Worker provenance header and
  is asserted by the Phase 0 E2E suite

The historical `npm run build && npm run test:e2e` run was made with Chromium
133.0.6943.16,
Firefox 134.0, and WebKit 18.2. All six browser tests failed before app boot.
The iframe navigation received the network controller response and was
blocked by `frame-ancestors 'none'`; the service worker did not intercept the
opaque sandbox navigation. The parent worker installed and its cache contained
the verified renderer, so this is specifically the required opaque-navigation
premise, not a missing build artifact. The historical `0/6` result means two
dependent tests were run in each of three engines; it is not six independent
security proofs.

The refreshed matrix uses Playwright 1.62.1 and is recorded in ADR-0002. It
retains the same decision: a green cache inspection or parent probe does not
substitute for actual opaque-frame navigation control.

## Security consequence

Serving the network response with relaxed frame ancestry would make the local
demo appear to work but would not prove verified-cache navigation or offline
reopen. Allowing same-origin access would destroy the opaque-origin invariant.
Neither is an acceptable fix.

## Revisit condition

Reopen only after a documented browser/runtime design proves, in all supported
engines, that an opaque `allow-scripts` navigation receives the exact verified
cached response and reopens while the renderer origin is unavailable. Any
change to the supported browser matrix or security invariant requires founder
authorization and a new ADR.
