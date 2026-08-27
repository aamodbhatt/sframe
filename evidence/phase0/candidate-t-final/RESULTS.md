# Candidate T final Phase 0 architecture evidence

Status: **PASS for the bounded Candidate T Phase 0 architecture evidence; stop before Phase 1 and Phase 2; awaiting Sol/founder audit.** This is not an MVP-complete claim or an independent security audit.

## Build identity

```text
candidate: T
renderer digest: 724102f528539f1e46cc96df0db5b14f1d3af704cb45ff76b4816965b79bb871
renderer bytes: 37,512
renderer bootstrap hash: sha256-wsltyn2AbHVRrfTNg/RJZgDqnnlDMGKIfpfasKvc494=
renderer CSS hash: sha256-0yba3n3V5zo4mSzIvh6CHzhiRHKWz9Ume+msXTSyMhU=
candidate T factory digest: 7a6878a1009449592d3b947d4f4dba3923e96abe0da2497b16cfe99f62f3d7f7
candidate T factory bytes: 4,649
deterministic composite digest: 6d6b1790a4d6f6a75cc809c835d578c125944417878882fefd3831e289582cbc
deterministic composite bytes: 15,035
```

Pinned matrix: Playwright `1.62.1`; Chromium/Chrome for Testing
`151.0.7922.34` (v1234), Firefox `153.0` (v1538), WebKit `26.5` (v2336).

## Required commands and results

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS — 1 file, 2 tests |
| `npm run lint` | PASS — 25 source files |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | PASS |
| `cargo test --workspace` | PASS — 0 Rust tests |
| `npm run doctor` | PASS |
| `SMALLFRAME_CANDIDATE=T npm run test:e2e` | PASS — 18/18 across Chromium, Firefox, WebKit |
| `SMALLFRAME_CANDIDATE=T npm run test:e2e -- --trace on` | PASS — 18/18; traces preserved below |
| `node scripts/phase0-tamper.mjs` | PASS — one-byte renderer/factory/composite mutations changed digests |

## Browser evidence

- The renderer response is verified and cached by the Service Worker before
  the frame is created. The controller observes renderer handshake origin
  `null`; renderer `self.origin` is `null`, while `location.origin` is recorded
  as the controller URL diagnostic.
- Parent DOM read/mutation, iframe DOM access from the controller,
  `document.domain`, cookies, localStorage, sessionStorage, IndexedDB, Cache
  Storage, OPFS, Service Worker registration authority, credentialed and
  non-credentialed fetch, and cross-context BroadcastChannel exchange were
  tested. SharedWorker and nested Worker attempts were executed and recorded,
  not inferred from property absence.
- The trusted Worker prelude reported `self.origin === "null"`,
  `location.origin === "null"`, a `blob:null/` location, classic Worker kind,
  exactly one Blob URL, no dynamic import, and no `importScripts`.
- Candidate T's hostile factory walked the Worker prototype chain for native
  `postMessage`, forged prelude-ready/render/state/error/sequence messages,
  installed a global listener, dispatched a fake MessageEvent with a fake
  port, and poisoned MessageEvent/MessagePort/global messaging intrinsics.
  The explicit private-port test still booted, rendered, and committed state
  through the real UI; no forged global message became a trusted transition.
- Add decision rendered `Decisions: 1`; the infinite event watchdog terminated
  and restarted the Worker from saved state, rendering `Decisions: 1` again.
- Persistent-profile warm online interaction, server-side renderer fault, and
  reopen passed in all engines. The evidence reported zero renderer fallback
  attempts.
- The exact Firefox-only controller CSP addition was
  `http://app.localhost:4173/sw.js`. Exact, query, encoded, suffix, direct
  frame, and renderer network-fallback negatives passed in every engine.
- Serial per-test canary snapshots reported `http=0`, `ws=0`, and zero renderer
  fallback requests in the valid matrix.

## Negative fixture matrix

Each command below was run with all three pinned projects and passed 3/3:

```text
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=missing npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=duplicate npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=thenable npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=malformed npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=oversized npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=syntax npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=exception npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_FIXTURE=top-level npm run test:e2e -- tests/e2e/candidate-t-negative.spec.ts
```

Every negative fixture left the controller responsive, stopped before app
execution, and recorded zero canary/fallback traffic. The valid matrix covers
the infinite event fixture and clean restart.

The one-byte renderer mutation command also passed 3/3:

```text
SMALLFRAME_CANDIDATE=T SMALLFRAME_T_MUTATE_RENDERER=1 npm run test:e2e -- tests/e2e/candidate-t-tamper.spec.ts
```

The test server recorded one or more mutated renderer fetches per engine and
the controller failed closed before creating an app iframe. The in-memory
tamper vector recorded these final digest pairs:

```text
renderer: 724102f528539f1e46cc96df0db5b14f1d3af704cb45ff76b4816965b79bb871 -> ee8c65e1336369f3806ab6d1ded6fb3b08e3349229cf89dbad83976c4f0f1b86
factory: 7a6878a1009449592d3b947d4f4dba3923e96abe0da2497b16cfe99f62f3d7f7 -> e9654e082bfd5aa3eeda0040d4ac3a4816880a2676c673c00e781b909906cb5a
composite: 6d6b1790a4d6f6a75cc809c835d578c125944417878882fefd3831e289582cbc -> d4d42421c613750efd3604c6c1e70045412ff8101db7ce555838fff3da44f968
```

The factory/composite in-memory check is deterministic artifact-identity
evidence, not the future signed package verifier.

## Preserved successful traces

Successful trace zips from the traced 18/18 run are stored in `traces/`:

- response-provenance-{chromium,firefox,webkit}.trace.zip
- boundary-{chromium,firefox,webkit}.trace.zip
- offline-reopen-{chromium,firefox,webkit}.trace.zip
- watchdog-{chromium,firefox,webkit}.trace.zip
- private-channel-{chromium,firefox,webkit}.trace.zip

Candidate S traces and report remain unchanged under
`evidence/phase0/candidate-s-final/`. ADR-0003 is superseded by ADR-0004 for
the invalid `location.origin` interpretation, but Candidate S remains a
historical non-green result because its Worker channel/state/Firefox/full-
matrix requirements were not satisfied.
