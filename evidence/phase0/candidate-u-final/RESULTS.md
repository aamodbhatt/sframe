# Candidate U final Phase 0 evidence

Status: **local technical evidence PASS / specification amendment HOLD**. This is not MVP completion, deployment evidence, an independent security audit, or market validation.

Date: 2026-08-27 (Asia/Kolkata)

Normative spec SHA-256: `4785a7ee793862a48f5e6504dee2828d7a8095cb6b96b42c4dff95a3853af9e1`

## Final valid artifact

```text
candidate: U
renderer SHA-256: 57e167b0e04b716e51a29c6b1362e3e26789893efce441b6f5da79a7148d4007
renderer bytes: 81,092
renderer bootstrap hash: sha256-Dz5dPcBD2Q/W0ifzVjVVWxMW7Gccyjv+UthV1oUEHAI=
renderer CSS hash: sha256-0yba3n3V5zo4mSzIvh6CHzhiRHKWz9Ume+msXTSyMhU=
factory SHA-256: 40d1358fa698a70a2c8bb2eecb2dee695ce8e1c425359ce7cb8e4c2b9baec485
factory bytes: 9,992
composite SHA-256: c85f6ae405086d39d89fc6433b92e62cf779b41d70b128e43097c5241e14d9c2
composite bytes: 33,901
Phase 0 Wasm SHA-256: ea721686a3134105abccd5acb58347456d52433a0421875b9c461e27bf35f20c
Phase 0 Wasm bytes: 135
```

Pinned browser matrix: Playwright 1.62.1; Chromium/Chrome for Testing 151.0.7922.34 (v1234), Firefox 153.0 (v1538), WebKit 26.5 (v2336).

## Browser results

| Evidence | Result |
|---|---:|
| Valid verified-cache/isolation/offline/watchdog/private-port matrix | 24/24 |
| Channel schema/session/sequence/transfer/replay attack matrix | 63/63 |
| Hostile publisher descriptor/result matrix | 48/48 |
| Contained intrinsic-poison/global-forge matrix | 6/6 |
| Wasm compilation denied by exact CSP | 3/3 fail-closed |
| Runtime one-byte renderer mutation | 3/3 rejected before execution |
| Invalid publisher syntax | `APP_SOURCE_SYNTAX_INVALID` at build |

The valid matrix proves response provenance and cache pinning; exact Firefox `/sw.js` compatibility negatives; controller-observed renderer opacity; tested DOM/storage/network/cross-context denial; zero canary HTTP/WebSocket leakage; physical-origin offline renderer reopen; actual Wasm startup; state retention; one bounded watchdog restart; restart-budget exhaustion; and lexical/private-port authority.

The 21 channel fixtures cover ready/init extra fields and ports, oversized init, window-init replay, controller/renderer replay, wrong sessions, extra keys, unknown types, oversized payloads, transferred ports, duplicate ready, Worker inbound/outbound replay, and non-object Worker output. Every invalid transition fail-stopped.

The 16 publisher fixtures cover missing/invalid/duplicate/reentrant/thenable factories, malformed/oversized descriptors, top-level/handler exceptions, hidden/symbol/accessor properties, named/sparse/accessor arrays, and non-finite values. The poison/global-forge fixtures retained correct operation through trusted captured intrinsics and the private channel.

A historical WebKit watchdog run stalled once. The isolated test then passed four times consecutively, and two subsequent complete valid matrices passed 24/24. This is recorded as development flake history, not erased.

## TypeScript, Rust, configuration, and dependency results

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 44 source files |
| `npm test` | PASS — 62/62, five files |
| `npm run test:phase0:do` | PASS — 13/13 |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | PASS |
| `cargo test --workspace --all-features` | PASS — stable Wasm probe test |
| `npm run doctor` | PASS — toolchain, target, browsers, filesystem, four ports |
| `npm audit --package-lock-only` | PASS — 0 advisories |
| `npx wrangler deploy --dry-run --config apps/api/wrangler.jsonc` | PASS — 32.50 KiB / 8.24 KiB gzip |

The audit was cleared with exact pins Vitest 3.2.7, Vite 6.4.3, and AJV 8.20.0. Wrangler reports actual declarations for the `ROOMS` Durable Object, `DB` D1 database, private `PACKAGES` R2 bucket, and exact local origin/environment/build values.

## Durable Object spike

The pinned Miniflare/SQLite spike proves:

- configuration is validated at first Worker request and DO construction;
- local mode is loopback-only; staging/production require HTTPS/WSS;
- required bindings must be own, real-shaped handles; placeholder/inherited values fail;
- exact CORS and exposed ETag/head headers make browser CAS observable;
- state GET honors conditional `If-None-Match` with 304;
- PUT uses a bounded streaming reader and rejects chunked bodies above 512 KiB;
- a transaction reloads the exact current ETag and exactly one competing writer wins;
- capabilities are decoded to 32 bytes, hashed, and compared in fixed time;
- WebSocket tickets are 32 random bytes, stored hash-only, bound to room/role/origin, expire after 30 seconds, and are consumed before same-room contextual/limit failure;
- only `smallframe.v1` is selected; the ticket subprotocol is never echoed;
- held fetch wakes on commit and times out boundedly;
- brief socket flaps do not reset the four-held-fetch budget;
- a room-expiry alarm removes a silent socket from server transport accounting.

## Honest limits and holds

1. The normative spec still requires an iframe `sandbox` attribute plus response CSP and a two-Blob module loader. Candidate U uses response-CSP-only sandboxing and one classic Blob Worker because the normative shape failed in real browsers. ADR-0005 requires explicit founder acceptance; the spec file was not edited.
2. Miniflare is not Cloudflare staging. Hibernation/eviction, browser close-frame delivery, production CPU/quota behavior, platform logging/redaction, and real headers are not proved.
3. The DO is a Phase 0 CAS/ticket spike, not the Phase 3 production relay. Envelope signatures, package/room/writer context, exact-next lineage, rotation/revocation, recovery, checkpoints, project/IP/cap quotas, and cross-service sagas remain absent.
4. A real ticket presented to a different room DO cannot consume the issuing DO's row. The Phase 3 protocol must define whether “single-use even if upgrade fails” means any same-room redeemable attempt or requires a globally routable consumption design.
5. Nominal ten-minute fallback is 28,800 requests/day for 100 rooms × two clients. Worst-case repeated −20% jitter is 36,000/day. The later hard project budget must preserve the 50,000/day forecast.
6. The local proof does not establish demand, distribution, willingness to pay, a moat, public naming/license clearance, or fundraising readiness.

Decision details: `docs/adr/0005-candidate-u-phase0-evidence-and-spec-hold.md`.
