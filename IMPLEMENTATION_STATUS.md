# Smallframe implementation status

Updated: 2026-08-27 (Asia/Kolkata)

## Executive state

Candidate U has **green local Phase 0 technical evidence**. It is not a completed MVP and cannot yet become the normative architecture because it differs from two requirements in `APEX_MVP_BUILD_SPEC.md`. ADR-0005 records the working design and the founder-acceptance hold. Phase 1 and Phase 2 have not been started or claimed.

This result is meaningful: the browser isolation premise, channel confinement, artifact pinning, bounded watchdog recovery, actual Wasm startup, strict deployment configuration, and a minimal SQLite Durable Object CAS/ticket/fallback spike now work locally. It is not proof that the business will sell, that Cloudflare production will behave identically, or that the system has received independent review.

## Contract and workspace

- Normative spec read completely: 2,256 lines.
- Spec SHA-256: `4785a7ee793862a48f5e6504dee2828d7a8095cb6b96b42c4dff95a3853af9e1`.
- The normative spec was not edited.
- Workspace: `/Users/aamodbhatt/Documents/AB-_Test (05)`.
- Initial Git state: empty `main` branch with no commits and only the normative specification present. This status and the implementation are included in the first local checkpoint; no unrelated founder work was overwritten.
- Host baseline: Apple M3 MacBook Air, 16 GB RAM, macOS 26.5; repository stays Docker/GPU/model-free.

## Phase sequence

- [x] Phase 0 repository/toolchain/test foundation.
- [x] Required Phase 0 architecture/design ADRs.
- [x] Candidate U controller/Service Worker/renderer/Worker prototype.
- [x] Malicious canary, channel, hostile publisher, CSP, and tamper evidence.
- [x] Three-engine valid browser evidence.
- [x] Production-HTTPS/local-loopback configuration assertion wired to Worker and DO startup.
- [x] Minimal local SQLite Durable Object CAS/ticket/budgeted-fallback spike.
- [x] Phase 0 technical evidence gate locally green.
- [ ] Founder accepts Candidate U's normative sandbox/Worker-loader amendments.
- [ ] Phase 1 — not started or claimed.
- [ ] Phase 1 gate — not started or claimed.
- [ ] Phase 2 — not started or claimed.
- [ ] Phase 2 gate — not started or claimed.
- [ ] Validation Hold A demand evidence — humans/interviews cannot be fabricated locally.

## Candidate U decision

Candidate U preserves the content-addressed Service Worker renderer response, exact response-header CSP sandbox, effective opaque origin, declarative app protocol, and Worker-only publisher execution. It adds:

- one classic Blob Worker with a trusted lexical prelude/factory sibling;
- a private one-use MessageChannel not exposed through publisher-global messaging;
- captured intrinsics and null-prototype/descriptor-safe parsing;
- exact channel/version/session/sequence/type schemas and 256 KiB bounds;
- fail-closed `messageerror`, replay, wrong-session, extra-field/port/type, invalid-transition, and dispatch handling;
- one app-ready per running generation and strict lifecycle ordering;
- a 135-byte build-pinned no-import Wasm startup probe;
- fatal iframe destruction, one bounded watchdog restart, and final fail-stop;
- expanded malformed descriptor/result and poisoning fixtures.

Final valid build identity:

```text
renderer: 57e167b0e04b716e51a29c6b1362e3e26789893efce441b6f5da79a7148d4007 (81,092 bytes)
factory: 40d1358fa698a70a2c8bb2eecb2dee695ce8e1c425359ce7cb8e4c2b9baec485 (9,992 bytes)
composite: c85f6ae405086d39d89fc6433b92e62cf779b41d70b128e43097c5241e14d9c2 (33,901 bytes)
Wasm: ea721686a3134105abccd5acb58347456d52433a0421875b9c461e27bf35f20c (135 bytes)
```

## Browser evidence

Pinned matrix: Playwright 1.62.1; Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5.

| Matrix | Result |
|---|---:|
| Final valid architecture | 24/24 |
| Channel attack fixtures | 63/63 |
| Hostile publisher fixtures | 48/48 |
| Contained poison/global-forge | 6/6 |
| Wasm denied by CSP | 3/3 fail-closed |
| Runtime one-byte renderer tamper | 3/3 rejected |
| Syntax fixture | exact build rejection |

One WebKit watchdog test stalled once during development. It then passed four isolated repetitions and two later complete 24-test matrices. This history remains a release-risk input rather than being hidden.

Full report: `evidence/phase0/candidate-u-final/RESULTS.md`.

## Runtime configuration and Cloudflare spike

The strict runtime module now runs at the first Worker request and Durable Object construction. It accepts only exact canonical origins, requires HTTPS/WSS outside loopback local mode, forbids local mode with public origins, rejects trailing-dot/wildcard/path/userinfo/default-port aliases, validates immutable build identity, and verifies own structural D1/R2/DO bindings. It reduces binding handles to presence markers and does not retain/log unknown secret fields.

The API derives exact CORS from the controller origin and centrally applies HSTS outside local mode plus `nosniff`, `no-referrer`, and CORP headers. Normal controller-origin problems remain browser-readable; attacker origins are not reflected.

Wrangler dry-run is green with `ROOMS` (SQLite DO), `DB` (D1), and `PACKAGES` (private R2): 32.50 KiB uncompressed / 8.24 KiB gzip.

The Miniflare spike proves exact ETag CAS, one winning concurrent write, fixed-size capability hashes, conditional 304 reads, bounded streaming PUT, readable CORS head/error responses, hash-only 30-second tickets, same-room one-use behavior, exact subprotocol selection, held-fetch wake/timeout, flap-resistant client fallback state, and room-expiry alarm transport cleanup.

## Current verification

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 44 source files |
| `npm test` | PASS — 62/62 |
| `npm run test:phase0:do` | PASS — 13/13 |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | PASS |
| `cargo test --workspace --all-features` | PASS |
| `npm run doctor` | PASS (loopback probes authorized) |
| `SMALLFRAME_CANDIDATE=U npm run build` | PASS |
| final Candidate U valid Playwright matrix | PASS — 24/24 |
| channel matrix | PASS — 63/63 |
| hostile/CSP/tamper matrices | PASS — 60/60 browser assertions plus syntax rejection |
| `npm audit --package-lock-only` | PASS — 0 advisories |
| Wrangler deploy dry-run | PASS |

Exact dev-dependency fixes: AJV 8.20.0, Vite 6.4.3, Vitest 3.2.7. Miniflare's Undici override remains scoped at 7.29.0.

## Normative deviations requiring founder acceptance

1. The spec requires the iframe attribute and response CSP to independently impose sandboxing. The working design omits the iframe `sandbox` attribute because that opaque navigation bypassed Service Worker control in the three pinned engines. It relies on the exact cached response CSP and the tested opacity/authority oracles.
2. The spec requires a two-Blob module/dynamic-import loader. The working design uses one classic Blob Worker because module loading from the opaque renderer failed cross-engine. A trusted lexical sibling owns the private port and captured intrinsics.

Compatibility constraint to retain: Firefox requires the exact controller `frame-src` addition `http://app.localhost:4173/sw.js`; broad `'self'`, wildcards, query/encoded/suffix forms, and direct framing remain denied.

No `allow-same-origin`, publisher DOM realm, arbitrary network, network renderer fallback, QuickJS, or CSP weakening was introduced.

## Honest remaining risks

- Response-CSP-only opacity and classic Blob Worker behavior must stay in the pinned/future-browser compatibility matrix.
- Local tests are not an independent review or deployed Cloudflare evidence.
- The current DO is not the Phase 3 signed/encrypted production relay. It lacks envelope/context/signature validation, recovery, rotation/revocation, checkpoints, full quotas, and sagas.
- A ticket tried against a different room DO cannot consume the issuing room's ticket row; Phase 3 needs an explicit protocol interpretation/design.
- Nominal fallback forecast is 28,800 requests/day; worst-case minimum jitter is 36,000/day until the later hard project budget exists.
- Phase 1's production package verifier and Phase 2's usable personal app flow do not exist yet.
- No interviews, willingness-to-pay evidence, name/license clearance, deployment, external accounts, public release, or fundraising claim has been made.

## Decision needed before Phase 1

The founder should either accept ADR-0005's two architecture amendments and authorize Candidate U as the normative local path, or hold/pivot. Continuing Phase 1 while pretending the original browser architecture still applies would create two incompatible specifications.
