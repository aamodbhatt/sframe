# ADR-0002: Phase 0 architecture-rescue candidates remain unproven

Status: **rejected for this build / Phase 0 remains blocked**

Date: 2026-08-21
Scope: authorized bounded Phase 0 architecture-rescue investigation

## Decision

Do not advance to Phase 1 or Phase 2. The original architecture, Candidate R,
and Candidate A do not satisfy the required three-engine Phase 0 proof. Preserve
ADR-0001 as the decision record for the original opaque sandbox navigation
failure. Candidate R and Candidate A are investigation evidence, not supported
runtime designs and not specification amendments.

No `allow-same-origin`, relaxed network renderer policy, arbitrary Blob/data
document fallback, publisher DOM execution, dedicated renderer origin, or
controller storage shortcut was used.

## Toolchain and exact evidence setup

The authoritative specification was read completely and its SHA-256 remains:

```text
4785a7ee793862a48f5e6504dee2828d7a8095cb6b96b42c4dff95a3853af9e1
```

The official Microsoft Playwright release page lists v1.62.1 as the latest
1.62 release. The official browser guidance requires installing the browser
builds matching the Playwright release. The repository now pins
`@playwright/test`, `playwright`, and `playwright-core` at `1.62.1`.

Installed exact engines:

| Engine | Playwright binary | Install location |
|---|---|---|
| Chromium | Chrome for Testing 151.0.7922.34, build v1234 | `~/Library/Caches/ms-playwright/chromium-1234` |
| Firefox | 153.0, build v1538 | `~/Library/Caches/ms-playwright/firefox-1538` |
| WebKit | 26.5, build v2336 | `~/Library/Caches/ms-playwright/webkit-2336` |

The E2E command is now a clean build gate:

```text
npm run test:e2e
  -> npm run clean
  -> npm run build
  -> playwright test --config=playwright.config.ts
```

The evidence suite records controlling Service Worker URL, verified cache
presence, cache-body SHA-256, cached response CSP/provenance, a real parent
`/sw-probe` response, direct network fallback provenance and fail-closed CSP,
iframe response provenance where applicable, canary counts, and a persistent
profile warm renderer-offline reopen attempt.

## Comparison

### Original architecture

The original contract keeps `iframe sandbox="allow-scripts"` with no
`allow-same-origin` and navigates to the content-addressed renderer path.

Final command:

```text
SMALLFRAME_CANDIDATE=original npm run test:e2e
```

Result: **6 passed, 3 failed of 9 tests**.

- Chromium and WebKit completed the evidence assertions: the controller was
  Service Worker controlled, the verified cache entry existed with the exact
  digest/provenance, the parent probe was Service Worker served, and the
  iframe response was the network fallback with `frame-ancestors 'none'`.
- The opaque iframe did not boot the app. The renderer navigation was not
  Service Worker controlled; the network fallback was rejected by the required
  frame-ancestor policy.
- Firefox did not complete controller attestation and therefore could not
  enter the renderer proof. Its three tests failed at the controller/iframe
  setup boundary.

This is a fail-closed observation, not a passing Phase 0 gate.

### Candidate R — response-CSP-only opaque sandbox

Candidate R removes only the iframe `sandbox` attribute for the initial
navigation. It keeps the exact content-addressed path, the verified synthetic
response with literal `sandbox allow-scripts`, the controller attestation, the
network response with `frame-ancestors 'none'`, and the original fragment
nonce protocol.

Final command:

```text
SMALLFRAME_CANDIDATE=R npm run test:e2e
```

Result: **2 passed, 7 failed of 9 tests**.

Final build output: renderer digest
`ffb1cf9c3be0d0c4391dc64cc35027a902ab1d25fbe9f58e080b35483cc36a7a`, 16,302
bytes, renderer script hash
`N+XHjvyCoJwcNeLZ1hYeU8u0lDgiimP3kosS5ijmOTU=`.

- Chromium and WebKit passed the cache/provenance/direct-fallback evidence,
  proving that the candidate can receive the verified cache response for the
  iframe navigation.
- Chromium failed when the opaque renderer attempted to start the required
  Blob module Worker; the controller reported `WORKER_TERMINATED` before app
  boot. The worker’s generated Blob URL was `blob:null/...`.
- WebKit failed the same app-worker proof with a cross-origin script-load
  denial for the `blob:null` app module.
- Firefox failed before controller attestation and did not produce an app
  frame.
- The persistent-profile warm renderer-offline reopen did not boot the app in
  any engine.

Candidate R therefore does not prove the mandatory Worker-only publisher
boundary, renderer output, MessagePort channel, replay/recovery behavior, or
offline reopen.

### Candidate A — verified `srcdoc`

Candidate A keeps `iframe sandbox="allow-scripts"` and no
`allow-same-origin`. Before assigning `srcdoc`, the controller reads the
verified cache entry, enforces the 2 MiB bound, uses fatal UTF-8 decoding,
rejects BOM, checks the exact UTF-8 byte round trip, and recomputes SHA-256.
The exact verified string is accepted by a closure-private one-use
`smallframe-controller` Trusted Types policy. The candidate artifact places a
renderer meta CSP first in `<head>`; the meta policy tightens `connect-src`
and does not claim `sandbox` or `frame-ancestors`. The controller CSP includes
only the exact renderer script/style hashes and the renderer Worker policy
name needed by the inherited Trusted Types requirement. The URL-fragment
nonce is replaced by a renderer-generated 128-bit one-shot challenge checked
against the parent window, opaque origin, protocol, session, and transferred
port.

Final command:

```text
SMALLFRAME_CANDIDATE=A npm run test:e2e
```

Result: **2 passed, 7 failed of 9 tests**.

Final build output: renderer digest
`f1af3881bde57f42011bc6f41b39a49452ea6dfde4e2dfa5d220f6135531595d`, 16,809
bytes, renderer script hash
`Z7MdaDFA/tWYNNQe/Y/cfBurgm9QiRtEC6XFgAq2uTY=`.

- Chromium passed the verified cache-body/policy evidence and verified the
  renderer meta policy shape, but failed at the required Blob module Worker
  startup with `WORKER_TERMINATED`.
- Firefox failed before controller attestation.
- WebKit reached the renderer but rejected loading the `blob:null` app module
  with “Cross-origin script load denied by Cross-Origin Resource Sharing
  policy.”
- The persistent-profile warm renderer-offline reopen did not boot the app in
  any engine.

Candidate A also does not prove the mandatory Worker, Wasm, channel, app ABI,
adversarial, or offline claims.

## Exact commands and supporting checks

These checks passed after the rescue changes:

```text
npm install --save-dev @playwright/test@1.62.1 --save-exact
npx playwright install chromium firefox webkit
npm run build
npm run typecheck
npm test
npm run lint
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
npm run doctor
npx playwright --version
npx playwright install --dry-run chromium firefox webkit
```

The browser failure traces are generated by Playwright under
`test-results/<test-slug>-<browser>/trace.zip`; the final original run left
the Firefox traces at:

```text
test-results/phase0-Phase-0-response-pr-72854-and-verified-cache-evidence-firefox/trace.zip
test-results/phase0-renderer-boundary-channel-and-canary-behavior-firefox/trace.zip
test-results/phase0-persistent-profile-warm-renderer-offline-reopen-firefox/trace.zip
```

Each candidate run used the same clean command and emitted its own equivalent
engine-specific trace paths before the next clean run removed generated test
artifacts. No trace is treated as proof by itself; the response headers,
cache-body digest, browser behavior, and canary results are the evidence.

## Unresolved risks and explicitly unproven requirements

The early Worker load failure prevents valid claims for the following required
proofs: app Worker confinement, storage/API unavailability in the app Worker,
real Wasm startup, declarative renderer output, MessagePort sequencing/replay
rejection, bounded Worker termination/recovery, mutated artifact/header/UTF-8/
size/path/query/cache/stale-worker/bypass fixtures, persistent offline reopen,
and the full §11.6 adversarial surface matrix. The initial scaffold also does
not claim production Wasm, package/CLI completion, shared rooms, or Phase 1/2
protocol gates.

## Proposed specification amendment (not applied)

Do not edit `APEX_MVP_BUILD_SPEC.md` as part of this hold. A future amendment
must update every affected claim and test obligation at least in:

1. **§0 Directive to the implementation agent:** state that the original
   opaque service-worker navigation premise and both bounded rescue candidates
   are currently rejected, and require a browser-supported replacement before
   later phases.
2. **§6.2 Components and §6.4 Non-negotiable invariants:** separate the
   verified-cache response claim from the unproven opaque-frame navigation and
   Blob module-Worker claims.
3. **§9.5 Offline and PWA behavior:** remove any offline-reopen acceptance
   claim until a persistent-profile test boots the app with renderer delivery
   unavailable.
4. **§11.1–§11.6:** record the three-engine failures, define whether the
   supported Worker URL model can work from an opaque origin, and retain the
   no-weakening rules for `allow-same-origin`, network headers, and DOM
   publisher execution. Candidate A’s `srcdoc` meta CSP must not be described
   as supplying sandbox or frame-ancestor protection.
5. **§14.3:** retain the current clean E2E command and record the exact
   Playwright/browser pin used for future reruns.
6. **§15.2–§15.3:** classify the evidence suite as a prerequisite spike and
   do not count cache inspection or a parent probe as a renderer-navigation
   security proof; the historical 0/6 was two dependent tests across three
   engines, not six independent proofs.
7. **§17:** keep the stop-at-Phase-0 rule when any required engine fails and
   prohibit Phase 1/2 claims from this scaffold.
8. **§18.1 steps 2, 11, 14, and 15 and §18.2 Evidence MVP:** remove the
   renderer/offline/app-boundary completion claims until all mandatory Worker,
   Wasm, adversarial, persistent-profile, and canary evidence is green.
9. **§23 Fresh-task handoff:** require the next implementation owner to review
   ADR-0001 and ADR-0002, obtain explicit founder authorization for any new
   architecture, and report the exact current-engine traces before changing
   the boundary.

## Recommendation

**FAIL / HOLD.** Keep the Phase 0 gate red, preserve ADR-0001 and this ADR,
and do not begin Phases 1–2. A future architecture investigation needs a
different browser-supported isolation/runtime design or an explicitly
authorized change to the supported matrix and invariants; neither is inferred
from these results.
