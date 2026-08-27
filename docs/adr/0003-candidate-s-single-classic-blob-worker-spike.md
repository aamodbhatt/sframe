# ADR-0003: Candidate S single classic Blob Worker remains blocked

Status: **superseded historical failure**

Date: 2026-08-21
Scope: one explicitly authorized Candidate S Phase 0 rescue

## Decision

Stop Candidate S. Do not begin Phase 1 or Phase 2, do not edit
`APEX_MVP_BUILD_SPEC.md`, and do not implement QuickJS automatically.

Candidate S replaced the existing two-Blob ES-module/dynamic-import loader with
one classic Blob Worker. It does not pass the required opaque-origin boundary
in the pinned browser matrix.

## Supersession note

ADR-0004 supersedes the causal interpretation of Candidate S's Chromium/WebKit
`location.origin` observation. `location.origin` reports the document URL and
is not the effective sandbox-origin oracle; the correct evidence is
`self.origin === "null"`, controller-observed `MessageEvent.origin === "null"`,
and the denied DOM/storage/network authorities. Candidate S remains a
historical non-green candidate because its Worker-global channel was forgeable,
its event state was defective, Firefox compatibility was unresolved, and its
full matrix was incomplete—not because the Chromium/WebKit
`location.origin` value alone proved same-origin execution.

## Candidate S design tested

- The initial iframe navigation had no iframe `sandbox` attribute, matching the
  bounded Candidate R rescue shape.
- The verified Service Worker response retained the literal response-header
  `sandbox allow-scripts`, `connect-src 'none'`, exact content-addressed path,
  and cache/network provenance checks.
- The Worker payload contained one trusted prelude IIFE and one sibling,
  checked-in factory closure (`apps/controller/public/candidate-s-factory.js`).
- There was exactly one classic Blob URL per Worker. The loader used no module
  Worker, second Blob, dynamic import, `importScripts`, data URL, `eval`, or
  `Function`.
- The prelude captured pristine messaging, structured-clone, timing, and
  randomness operations; installed the message protocol before publisher code;
  used a one-shot synchronous factory bridge; generated a per-Worker session
  nonce; sequence-checked input/output; independently cloned output; and
  removed the bridge before `prelude-ready`.
- The renderer kept the sole Blob URL alive until authenticated `prelude-ready`,
  then revoked it. A bounded external watchdog terminated a hung event and
  attempted a clean restart from current controller state.
- Firefox setup was corrected to wait for activation/control with a bounded
  reload path, and the parent handshake listener was installed before iframe
  navigation and removed only after a valid handshake or bounded failure.

## Exact evidence

Final command:

```text
SMALLFRAME_CANDIDATE=S npm run test:e2e
```

Final result: **2 passed, 10 failed of 12 tests**.

Final build identity:

```text
renderer digest: 6151c464125e477953afe47e7ea31f649dfc99eae423939cbe7da0f14cf5ab45
renderer bytes: 28,536
renderer script hash: sha256-u4rPtb6QUDlZ2rtefGUk2132+jeP69f6GH2/UF1jX+E=
factory digest: 45bfe6e63b5baf7c527388413d17836e7e89f4426eb6efe86bb59546d9f1bd0a
factory bytes: 1,942
composite digest: b6e46bcad286580338268094f745c61a476062b6f1c690cc24d3bebf86576ce5
composite bytes: 7,769
```

Installed engines were Chromium/Chrome for Testing `151.0.7922.34` (Playwright
build `v1234`), Firefox `153.0` (build `v1538`), and WebKit `26.5` (build
`v2336`) under Playwright `1.62.1`.

## First causal failures

### Chromium and WebKit

Both engines proved the verified cache response and accepted the authenticated
classic Worker readiness message. The fixture rendered, and the Worker proof
reported `workerKind=classic-blob`, `blobCount=1`, `dynamicImport=false`, and
`importScripts=false`. The renderer nevertheless reported:

```text
location.origin = http://app.localhost:4173
expected        = null
```

Because the iframe sandbox attribute was absent, the response-header
`sandbox allow-scripts` did not produce the required opaque origin in this
Service Worker-delivered navigation. This is a direct Candidate S invariant
failure, not a Worker-loader failure. The same-origin Worker run cannot be
counted as a security proof. Adding `allow-same-origin` or relaxing CSP was
not attempted.

### Firefox

The corrected diagnostic proved:

```text
controller: http://app.localhost:4173/sw.js
registration: active=activated, waiting=null, installing=null
renderer request: /runtime/renderer/6151c464125e477953afe47e7ea31f649dfc99eae423939cbe7da0f14cf5ab45.html
request failure: NS_ERROR_CONTENT_BLOCKED
console: frame-src blocked http://app.localhost:4173/sw.js
status: RENDERER_HANDSHAKE_TIMEOUT
```

Firefox therefore failed before the Worker boundary. This is not attributed
to an activation timeout or a missing controller. Adding `sw.js` to the
controller `frame-src` policy would broaden the frame authority and was not
used.

## Consequence and next investigation

Candidate S does not prove opaque origin, three-engine Worker confinement,
offline reopen, watchdog recovery, or the mandatory adversarial matrix. The
next bounded investigation must first establish whether a browser-supported
navigation/runtime can simultaneously provide verified-cache delivery, an
opaque renderer origin, and one classic Worker without changing the security
invariants. Any design requiring `allow-same-origin`, relaxed CSP, a second
executable URL, or broader network authority is rejected by the authorization.

The authoritative specification remains unchanged. Final traces and the full
report are preserved under
`evidence/phase0/candidate-s-final/`.
