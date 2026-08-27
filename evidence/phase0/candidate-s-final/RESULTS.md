# Candidate S final Phase 0 evidence

Status: **superseded historical FAIL / STOP**. Candidate S did not complete its mandatory channel/state/Firefox/full-matrix proof. Its Chromium/WebKit `location.origin` interpretation was invalidated by Candidate T's corrected oracle; Candidate S remains non-green for the other causal failures. Phase 1 and Phase 2 remain unauthorized and were not started.

## Exact build identity

- Candidate: `S`
- Renderer response digest: `6151c464125e477953afe47e7ea31f649dfc99eae423939cbe7da0f14cf5ab45`
- Renderer response bytes: `28,536`
- Renderer bootstrap hash: `sha256-u4rPtb6QUDlZ2rtefGUk2132+jeP69f6GH2/UF1jX+E=`
- Renderer CSS hash: `sha256-0yba3n3V5zo4mSzIvh6CHzhiRHKWz9Ume+msXTSyMhU=`
- Checked-in factory bytes: `1,942`
- Checked-in factory digest: `45bfe6e63b5baf7c527388413d17836e7e89f4426eb6efe86bb59546d9f1bd0a`
- Final single-Worker composite bytes: `7,769`
- Final single-Worker composite digest: `b6e46bcad286580338268094f745c61a476062b6f1c690cc24d3bebf86576ce5`

The composite contains one trusted prelude IIFE and one sibling checked-in factory closure. It uses one classic Blob URL per Worker, no module Worker, no second Blob URL, no dynamic import, no `importScripts`, no data URL, no `eval`, and no `Function`.

## Browser matrix

Playwright `1.62.1`; installed browser builds:

| Engine | Browser build | Candidate S result |
|---|---|---|
| Chromium | Chrome for Testing `151.0.7922.34`, Playwright build `v1234` | Classic Worker starts and renders, but renderer origin is `http://app.localhost:4173`, not opaque; FAIL |
| Firefox | `153.0`, Playwright build `v1538` | Service Worker is active and controlling, but renderer navigation is blocked before handshake with `NS_ERROR_CONTENT_BLOCKED`; FAIL |
| WebKit | `26.5`, Playwright build `v2336` | Classic Worker starts and renders, but renderer origin is `http://app.localhost:4173`, not opaque; FAIL |

## Exact command and result

```text
SMALLFRAME_CANDIDATE=S npm run test:e2e
```

Result: **2 passed, 10 failed of 12 tests**.

The two passing tests were the Chromium and WebKit verified-cache/provenance tests. The ten failures are not counted as security passes. Chromium/WebKit boundary failures are the decisive invariant failure; Firefox failures occur earlier at renderer navigation. The watchdog/offline failures are downstream after the mandatory boundary is already red.

## CSP and protocol evidence

The cached renderer response used the required literal policy:

```text
default-src 'none'; script-src 'sha256-k1LNUjRshUM/FY2lojokcgkqO1jX4XVKnwBzWwlqeo0=' 'wasm-unsafe-eval' blob:; style-src 'sha256-0yba3n3V5zo4mSzIvh6CHzhiRHKWz9Ume+msXTSyMhU='; img-src 'none'; font-src 'none'; connect-src 'none'; worker-src blob:; child-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; frame-ancestors http://app.localhost:4173; sandbox allow-scripts; require-trusted-types-for 'script'; trusted-types smallframe-renderer-worker
```

Chromium and WebKit accepted the verified Service Worker cache response, accepted the authenticated `prelude-ready` proof with `workerKind=classic-blob`, `blobCount=1`, `dynamicImport=false`, and `importScripts=false`, and rendered the checked-in factory output. Their `location.origin` was nevertheless `http://app.localhost:4173`. The response-header `sandbox allow-scripts` did not make the no-attribute initial iframe navigation opaque. This fails Candidate S’s required opaque-origin invariant and invalidates the subsequent same-origin run as a security proof.

Firefox diagnostic state after the corrected activation/controller wait:

```text
controller: http://app.localhost:4173/sw.js
registration scope: http://app.localhost:4173/
registration active: activated
registration waiting: null
registration installing: null
renderer request: http://app.localhost:4173/runtime/renderer/6151c464125e477953afe47e7ea31f649dfc99eae423939cbe7da0f14cf5ab45.html
request failure: NS_ERROR_CONTENT_BLOCKED
console: CSP frame-src blocked http://app.localhost:4173/sw.js; allowed source is http://app.localhost:4173/runtime/renderer/
controller status: RENDERER_HANDSHAKE_TIMEOUT
```

The Firefox result is not attributed to missing Service Worker activation. It is a distinct frame-navigation/CSP behavior after `activated` and control were proven. Relaxing `frame-src` to include `sw.js` would broaden the policy and was not attempted.

## Artifacts

The final Playwright trace zips are preserved under `evidence/phase0/candidate-s-final/traces/`. A trace is supporting diagnostic material only; the result above is based on browser behavior, response provenance, cache digest/policy, controller state, and canary assertions.

## Recommendation

**FAIL / STOP Candidate S.** Do not implement QuickJS automatically. The next bounded investigation should first determine whether a browser-supported architecture can simultaneously obtain verified-cache delivery, an opaque renderer origin, and a Worker-only publisher boundary without adding `allow-same-origin`, relaxing CSP, using a second executable URL, or broadening network authority. No later phase is authorized by this report.
