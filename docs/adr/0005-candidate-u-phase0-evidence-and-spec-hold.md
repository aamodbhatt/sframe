# ADR-0005: Candidate U closes the Phase 0 evidence loop with a specification hold

Status: **accepted normative local architecture / Phase 1 authorized**

Date: 2026-08-27

## Context

Candidates original, R, A, and S disproved combinations of opaque iframe navigation, Service Worker control, and Blob module Worker loading. Candidate T found a browser-supported shape, but its channel/parser surface and Phase 0 evidence were not yet sufficiently hardened. Candidate U retains the viable browser shape and adds exact protocol, lifecycle, Wasm, hostile-input, production-config, and Durable Object evidence.

## Decision

Use Candidate U as the normative local engineering architecture. Do not call it deployed, independently secure, beta-ready, or market-proven.

## Founder acceptance

On 2026-08-27, the founder explicitly accepted both local specification amendments in this ADR and required the exact Firefox `/sw.js` exception and negative tests to remain. The authorization extends through Phase 1 only. It does not authorize deployment, publication, spending, or market/security validation claims.

The tested browser architecture is:

1. A trusted controller registers and waits for its minimal Service Worker.
2. The Service Worker synthesizes one content-addressed renderer response and exact CSP.
3. The controller reads the cached response, verifies its digest and policy, then creates the frame.
4. Response CSP `sandbox allow-scripts` gives the renderer an effective opaque origin.
5. The renderer creates one classic Blob Worker containing a trusted lexical prelude/factory sibling and hostile publisher code.
6. The prelude starts the build-pinned Wasm probe, captures intrinsics, validates the app descriptor, and communicates only over its private port.
7. The renderer normalizes declarative output and the controller remains the owner of state and privileged effects.

## Channel and lifecycle invariants

- Controller/renderer and renderer/Worker messages carry exact channel, protocol, random session, sequence, and type fields.
- Ready/init have exact schemas; ready transfers zero ports and init transfers exactly one port once.
- Unknown fields/types, wrong session/version, replay, extra ports, oversized serialization, invalid transition, `messageerror`, and dispatch exceptions fail closed.
- App-ready occurs exactly once per running generation; render/state batches are rejected before readiness.
- Publisher global messages cannot become trusted transitions. Captured intrinsics and lexical port authority survive prototype/global poisoning.
- Fatal Candidate U sessions close ports, terminate the Worker, remove the iframe, retain local export, and expose a bounded nonsecret stop code.
- A one-second watchdog permits one restart from the last accepted state. Exhausting that budget fail-stops.

## Wasm and artifact identity

The build embeds a 135-byte no-import Wasm probe with SHA-256 `ea721686a3134105abccd5acb58347456d52433a0421875b9c461e27bf35f20c`. All three engines start it under the exact allowed CSP and fail closed when `wasm-unsafe-eval` is removed. This is a Phase 0 startup probe, not the Phase 1 production verifier.

Final valid Candidate U identity:

```text
renderer SHA-256: 57e167b0e04b716e51a29c6b1362e3e26789893efce441b6f5da79a7148d4007
renderer bytes: 81,092
bootstrap CSP hash: sha256-Dz5dPcBD2Q/W0ifzVjVVWxMW7Gccyjv+UthV1oUEHAI=
trusted CSS CSP hash: sha256-0yba3n3V5zo4mSzIvh6CHzhiRHKWz9Ume+msXTSyMhU=
factory SHA-256: 40d1358fa698a70a2c8bb2eecb2dee695ce8e1c425359ce7cb8e4c2b9baec485
factory bytes: 9,992
composite SHA-256: c85f6ae405086d39d89fc6433b92e62cf779b41d70b128e43097c5241e14d9c2
composite bytes: 33,901
```

## Evidence

- Final valid architecture matrix: 24/24 across Chromium 151, Firefox 153, and WebKit 26.5.
- Exact channel attack matrix: 63/63 (21 fixtures × three engines).
- Malformed publisher matrix: 48/48 (16 fixtures × three engines).
- Contained poison/global-forge matrix: 6/6.
- Wasm-CSP fail-closed matrix: 3/3.
- Runtime one-byte renderer rejection: 3/3; deterministic renderer/factory/composite mutations changed all digests.
- Syntax fixture rejected at build with `APP_SOURCE_SYNTAX_INVALID`.
- Full Vitest suite: 62/62; focused DO/fallback suite: 13/13.
- npm audit: zero known advisories after exact non-major upgrades.
- Wrangler dry-run: 32.50 KiB / 8.24 KiB gzip with DO, D1, and R2 bindings.

One WebKit watchdog run stalled once during development. The isolated case then passed four consecutive times and two later complete 24-test matrices passed. Record this history; do not erase it from release risk assessment.

## Accepted local specification amendments

`APEX_MVP_BUILD_SPEC.md` remains unchanged. The founder accepted:

1. **Sandbox change:** omit the iframe `sandbox` attribute and require the exact cached response CSP sandbox plus the tested opacity/authority oracles. The attribute caused opaque navigation to bypass Service Worker control in the pinned engines, so the spec's claim of two independent sandbox layers is false for the working design.
2. **Worker-loader change:** replace the two-Blob module/dynamic-import loader with one classic Blob Worker whose trusted lexical sibling owns the private port and captured intrinsics. Blob module loading from the opaque renderer failed cross-engine.

Also retain the exact Firefox `/sw.js` `frame-src` exception and its negative controls. No `allow-same-origin`, broad `'self'`, network renderer fallback, DOM publisher realm, QuickJS, arbitrary publisher network, or weakened CSP is authorized.

## Residual holds

Candidate U proves a dangerous premise locally; it does not complete Phase 1 or Phase 2. The production signed package verifier, personal product vertical slice, adaptation evidence, human demand interviews, deployed Cloudflare behavior, and independent review remain outstanding.
