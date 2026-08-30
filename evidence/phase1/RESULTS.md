# Phase 1 local technical gate

Date: 2026-08-30 (Asia/Kolkata)

Architecture: Candidate U, accepted by the founder in ADR-0005

Scope: Phase 1 only

## Decision

**PASS — local technical evidence.**

This result means the Phase 1 package/protocol core satisfies its local, reproducible engineering gate on the pinned toolchain. It does not claim MVP completion, deployed behavior, independent security review, market validation, or production readiness. Phase 2 was not started.

## Delivered boundary

- Strict duplicate-key I-JSON and RFC 8785 JCS handling.
- Deterministic, bounded STORE-only ZIP packages with normalized paths and exact byte vectors.
- Ed25519 DSSE-PAE signing and verification, digest/link pinning, and stable failure codes.
- Oxc-based source validation that rejects all import/re-export forms, `importScripts`, and source maps.
- Bounded manifest and deterministic state-schema validation.
- Production Rust/Wasm package verification embedded in the Candidate U renderer and attested before readiness.
- Encrypted CLI identity vault/recovery flows and deterministic package authoring commands.
- Draft 2020-12 protocol schemas, signed-record/package/Automerge vectors, parser seeds, and a deterministic example package.
- Cyclomatic-complexity enforcement without refactoring the accepted Phase 0 security state machines.

## Reproducible build identity

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| Renderer | 1,285,425 | `bec664775eb21291db9226c499856235e38a7a652a0207d8e020313eda2db6ea` |
| Phase 1 verifier Wasm | 893,959 | `e01b3028a65caaa7d1b22ddf0983fd202fc8c81fb46e01ace39cff722261c239` |
| Candidate U factory | 9,992 | `40d1358fa698a70a2c8bb2eecb2dee695ce8e1c425359ce7cb8e4c2b9baec485` |

The Phase 1 Wasm is 42.6% of the 2 MiB decoded-size ceiling. A clean build with Cargo and npm network access disabled produced the identities above.

## Final checks

| Check | Result |
|---|---|
| `SMALLFRAME_CANDIDATE=U npm run check` | PASS |
| Doctor and production build | PASS |
| TypeScript typecheck and lint | PASS; lint covered 60 source files |
| Vitest | PASS; 66/66 tests in 6 files |
| Playwright valid matrix | PASS; 27/27, 9 each in Chromium, Firefox, and WebKit |
| Cyclomatic complexity | PASS; 19 TypeScript files, new-function ceiling 20, frozen Phase 0 baselines unchanged |
| Rust format and Clippy with warnings denied | PASS |
| Rust workspace, all features | PASS; 23 tests |
| Rust core, Wasm-only feature set | PASS; 20 tests |
| Clean offline build | PASS |

The browser matrix includes a canonical signed package verification vector and wrong-pin rejection in every engine. Native vectors also cover byte mutation, signature mutation, alternate signer substitution, wrong DSSE type/key, missing/extra/path/bomb metadata, Unicode normalization, archive bounds, and canonical publication rejection.

## Preserved Candidate U constraints

- Response-CSP sandboxing is normative; the iframe has no `sandbox` attribute.
- Publisher code runs in one classic Blob Worker behind a trusted lexical prelude and private `MessageChannel`.
- The exact Firefox `/sw.js` exception and negative coverage remain.
- No `allow-same-origin`, arbitrary network, publisher DOM/CSS/assets, server-side app code, AI/model dependency, or network renderer fallback was added.

## Residual risk and authorization boundary

Pinned local browser results are not universal browser or independent security proof. The relay remains a Phase 0 spike rather than the later signed/encrypted production protocol. CLI UX and the usable personal-app flow belong to Phase 2. Deployment, publication, spending, external validation, and Phase 2 require a later founder gate.
