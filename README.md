<p align="center">
  <img src="docs/assets/smallframe-mark.svg" width="720" alt="Smallframe — private software, ordinary links">
</p>

<p align="center">
  <strong>Turn a constrained static app into a private, live, offline-capable room.</strong><br>
  Invited people open an ordinary browser link—without an account, messenger install, app-specific backend, or readable state at the relay.
</p>

<p align="center">
  <code>local-first</code> · <code>signed packages</code> · <code>encrypted rooms</code> · <code>declarative UI</code> · <code>Rust + TypeScript + Wasm</code>
</p>

---

Smallframe is an experiment in making tiny collaborative tools portable without giving their code ambient browser authority or giving a sync relay their readable state.

An immutable publisher-signed package is pinned by digest. A trusted controller owns keys, persistence, and privileged effects. App logic runs in a constrained Worker and can only emit schema-validated view nodes and state intents. The implemented shared-room prototype encrypts and signs state in the browser before relay storage.

```text
signed app package ──▶ verified renderer ──▶ constrained app Worker
                              │                         │
                              │ declarative view       │ state intents
                              ▼                         ▼
                       trusted controller ◀──── authorization boundary
                              │
                              └── encrypted snapshots ──▶ untrusted relay
```

## Why this exists

Most “share a tiny tool” choices force at least one uncomfortable trade: recipients create accounts, install a special runtime, trust arbitrary web code, accept an app-specific backend, or surrender readable collaborative state to a service.

Smallframe is testing whether a useful intersection exists:

- normal HTTPS invitations for external guests;
- no recipient account or custom runtime;
- immutable signed code and explicit capability review;
- local-first/offline operation;
- client-encrypted shared state;
- exportable packages and room data.

This is a product and security hypothesis, not a validated market claim.

## Current state

**Working local prototype; Phase 3 encrypted collaboration remains under repair.** Smallframe has an executable personal-app workflow and a shared-room test environment. It is not a completed MVP, production service or independently security-reviewed runtime.

| Area | Implemented and exercised locally | Remaining work |
|---|---|---|
| App authoring | Rust CLI identity, `new`, `validate`, deterministic `pack`, `dev`, and a local CLI→relay publish path; tracker, calculator and decision-board examples | Durable production publisher enrollment, validated package storage, complete operation resumption and room-creation saga |
| Package trust and execution | Native/Wasm signature verification, digest pinning, response-CSP sandbox, private channel, watchdog and hostile fixtures | Broader adversarial coverage and independent review |
| Personal workspaces | Approval, local edits, import/export, offline reopen; persistence before acknowledgement; atomic first approval and concurrent workspace identity creation | Coordination between active editing tabs, update/write races and restored revision handling |
| Shared rooms | Signed encrypted genesis, authenticated invitations, real SQLite Durable Object relay under Miniflare, concurrent offline edits, CAS sync, viewer persistence, durable missed-history warnings, local room forgetting, saved actor sequence/head checks and same-profile editor lock handoff | Signed recovery, production package-cache lifecycle and per-room local storage |
| Parsing and durability | Bounded incoming state, relay upload deadlines, strict UTF-8/duplicate-key checks, schema/document limits, atomic editor consent and durable remote/acknowledgement promotion | Complete hard-limit/conflict/fuzz matrix |
| Release readiness | Pinned tools, automated gates and three-browser tests | Restore the 2 MiB renderer budget, release artifact notices, operational evidence and external validation |

The native CLI now creates a signed package with distinct logical and artifact digests, validates a shared initial state, builds one Automerge genesis, encrypts and signs its revision-1 envelope, and sends it through the local publisher route. A cross-runtime integration test verifies the uploaded package with browser Wasm, parses both role links, retrieves the room-pinned package, and decrypts the stored genesis. Local publisher routes now store enrollment and operation results in D1 and validated package bytes in R2. Room metadata and room-operation results still use the in-memory prototype. Publishing routes return `503` outside local mode. The local secret files are encrypted with the identity unlock key. The exact room request is saved before its first send; `operations status <room-id>` reports local pending/confirmed state, and `operations resume <room-id>` replays the same bytes after an ambiguous creation response. The test simulates a lost local confirmation and changed source package, then proves replay recovers the same room. Status cannot independently establish remote authority, and the durable room saga, full retention and production authority checks remain unfinished. `operations abandon` and `export package` fail closed until implemented. This is a local path, not production onboarding.

Local publisher enrollment and invite creation now reject oversized or stalled bodies, duplicate or extra fields, invalid encodings and non-JSON content types before changing prototype state. Enrollment replay is bound to the exact request bytes; a consumed invite cannot be reissued or used for a different signed operation. Publisher identity, invite consumption, token activation and the exact enrollment result now commit in one local D1 transaction. Exact replay remains available while the token is active, including after 24 hours. Revocation immediately blocks authentication/replay; cleanup retains the revoked mapping for 30 days. This is local storage behavior, with no production onboarding or revocation endpoint.

The native CLI now stores its signed enrollment request, target and client-generated token in an encrypted pending record before sending. `operations status enrollment` reports the local state and `operations resume enrollment` replays the exact bytes after an ambiguous response, without rereading the invite or generating a new token. The local test commits enrollment at the server, drops its confirmation, rejects a corrupted pending digest or signature before sending, refuses unexpected confirmation fields and then resumes the same operation. Invite input comes from a no-echo prompt or owner-only file; there is no built-in invite code. These separate encrypted files are not the unified crash-safe vault, and still need vault locking and aggregate limits.

Candidate U remains the accepted architecture: an opaque renderer created by response CSP, one classic Blob **app Worker** with a trusted lexical prelude and private `MessageChannel`, and the exact Firefox `/sw.js` compatibility exception. The trusted controller separately owns the Wasm state-validation Worker. App packages target only [`packages/sdk`](packages/sdk/src/index.ts): one self-contained `app.worker.js`, declarative views and the explicit state API. They receive no DOM access, arbitrary networking, AI dependencies, publisher assets/CSS or server code.

Shared invitations bind the verified publisher/package, room path, capability, writer key, expiry and relay context before approval. Decrypted Automerge documents and merged candidates are checked for structural/history limits and against the signed JSON Schema before acceptance. Remembered room secrets and documents are wrapped with a non-extractable device key; that does not protect against compromised same-origin code or a copied browser profile.

Recent repairs make rejected writes remain rejected: personal edits/imports persist before acknowledgement; shared remote state and relay acknowledgements persist before promotion; approval and initial state commit atomically. Wire envelopes now use the specified outer `revision` field and reject legacy/ambiguous names. Incompatible legacy relay heads fail closed without automatic migration or deletion.

A remembered room that accepts a signed snapshot after missing revisions records the old and new heads with its last directly verified edge in the encrypted local record. The missed-history warning persists through later direct sync and offline reopen for editors and viewers; local editor and viewer records occupy separate slots. An aborted local write cannot promote the candidate; stale same-profile writes cannot roll back the stored head or erase its warning; exact-next wrong predecessors still block. Older local records with no lineage metadata display an explicit earlier-history warning. This does not prove every intervening edge, global freshness, or signed recovery.

Restored rooms with matching saved approval enter the remembered state before their first remote fetch. An aborted fetch commit retains the prior durable head and warning state; it cannot display a newly accepted history gap before saving it. Reopen regressions cover editors and viewers with an aborted first write followed by a successful sync.

For shared rooms, Forget device removes both local role records, their device keys and remembered approvals in one transaction, then stops same-profile active tabs. A durable generation marker rejects writes from sessions that were open before forgetting. The relay ciphertext remains; reopening with a retained invite requires fresh approval. An aborted deletion reports failure and leaves the records available for retry. Shared storage still uses one origin-wide IndexedDB rather than the spec's per-room database. The current test-only package is embedded in the public controller build; production room-specific package caching is not implemented.

The local publisher checkpoint [`02397cc`](https://github.com/aamodbhatt/sframe/commit/02397ccbbf9db220e765f10cfce65a5f3d418efa) passed all nine local gates (282 unit/integration, 45 Rust and 213 browser tests), but [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/36416817218) failed after 212 browser passes: a waiting editor tab stayed open after another tab completed Forget device. The receiver had depended on a second IndexedDB generation read before clearing in-memory authority. That read could fail or observe the new generation during startup. The follow-up repair stops a same-room tab on the post-commit forget notification; a three-browser regression forces the read to fail and retains the original navigation assertions. Exact-byte room-creation resume passed its own nine-gate check before this repair. The older Firefox initial-navigation event failure remains unresolved.

Remembered shared rooms now save the editor actor’s maximum Automerge sequence and sorted document heads alongside the encrypted document. Reopen recomputes both from the validated document and rejects mismatches before approval; older wrapped records gain the metadata in a committed migration before editing. A waiting editor tab remains read-only while another owns the Web Lock. On release it reloads and validates the latest durable document under the storage lock before switching the renderer to editor; a failed read stays read-only, and Forget device stops the queued handoff.

Encrypted rooms now reject the unfinished unsigned `request-repair` path, so an editor capability cannot freeze them without the specified publisher signature and exact head. The local legacy recovery fixture requires an exact `If-Match`, an explicit frozen state, a canonical next epoch and a bounded body. The native repair command requires a canonical `--expected-etag`, sends it as `If-Match`, and reports HTTP rejection as failure. This is a fail-closed boundary while signed publisher repair and signed epoch recovery remain unimplemented; it is not a usable encrypted-room rescue flow.

The pending native upload journal stores the exact signed archive, credential, destination and operation ID encrypted before transport. `operations status upload:<packageDigest>` validates the saved artifact locally; `operations resume upload:<packageDigest>` verifies it again and replays saved bytes without rebuilding source. Lost confirmations and unexpected response fields retain the pending record. The integration regression covers removed source, corrupted encrypted records, changed destinations and identical bytes/operation IDs across replay. Server-side ZIP validation uses the shared Rust Wasm core; the durable room saga and unified vault remain unfinished. Production publishing stays disabled.

Server upload validation uses a narrow adapter over the same Rust core as native/controller package verification. Before storage it checks the canonical signed ZIP, recomputes logical and artifact digests and binds the signing publisher to the authenticated token. Caller-declared digests must match. Tests repair ZIP CRCs around a forged signature to reach the signature boundary, reject alternate valid signers and ambiguous artifacts, and verify identical replay after a valid upload. This remains a local fixture with D1/R2 bindings.

Local validation measurements exceeded the spec’s 10 ms target at the old maximum: a 789,130-byte signed package took 12–27 ms in a local Worker probe; the Node/V8 simulation averaged 12.1 ms of process CPU and peaked at 25.4 ms. Dense valid syntax at roughly 31 KiB and 15 KiB also exceeded 10 ms in that simulation. Local-beta uploads are therefore temporarily capped at **8,192 bytes**, enforced by the CLI before journaling and by the server before validation; the offline package format/core retains its 1 MiB limit. Signed 8,192-byte padding and 8,191-byte dense-syntax probes peaked at 8.2/8.5 ms of process CPU over 30 iterations each; their maximum elapsed times were 9.4/8.5 ms. This is observed fixture timing, not an exhaustive worst-case bound. `node scripts/benchmark-package-verifier.mjs [--server] <signed-archive>` reports only sizes/timings, separating initialization and self-test from first and repeated requests. These measurements are local simulations, include process/JIT effects, and do not prove Cloudflare’s billed CPU behavior; production publishing remains disabled.

Rust and TypeScript now share a public verification vector for the bounded publisher repair statement. Parsers require the exact fields, fixed canonical encodings, safe integers, exact reason and JCS bytes no larger than 2,048. Verification binds the publisher key ID to the provided Ed25519 key and uses the specified DSSE payload type; malformed records and signatures fail closed. Both recovery verifiers additionally require canonical, non-small-order prime-subgroup public keys and signature points; public malicious-signer vectors exercise cases accepted by the JavaScript library's cofactored equation. The vectors contain no private seed, room key, capability or readable room state. Publisher ownership, exact-head matching, freshness/idempotency, repair persistence and the signed recovery transition flow still require API integration.

The recovery-transition helpers use ADR-0011's complete candidate/highest-observed tuples and exact reason/acknowledgement fields. Rust and TypeScript verify the same public JCS/DSSE vector, require the embedded writer key, enforce `newStateEpoch = max(candidateStateEpoch, highestObservedStateEpoch) + 1` through epoch 16, and allow the zero prior-transition digest only for the first transition.

Bounded native/TypeScript chain helpers verify every detached signature, immutable room/package/writer context, consecutive epoch and SHA-256 predecessor link from a pinned accepted anchor through an explicit target. They reject omissions, duplicates, reordering and conflicts with accepted epoch digests. Public vectors exercise all 16 epochs and genuinely signed invalid-context/fork records. TypeScript snapshots all inputs before awaiting cryptography, rejects accessor/custom-prototype records and copies typed-array inputs including Node Buffers. These helpers validate signed record lineage only. Replacement-envelope binding, rollback/export choices and atomic client/DO imports remain unfinished; encrypted API recovery remains blocked.

If an encrypted room is already marked `RECOVERY_REQUIRED` by a trusted restore, an authenticated room member can retrieve the stored signed/encrypted candidate envelope and its tuple in the `503` state response, even with a matching `If-None-Match`. The relay checks the stored envelope digest before returning it and refuses normal writes. The controller does not yet offer the export-first recovery choices or verify a transition chain, and the response has no publisher repair statement until that protocol exists.

Room package retrieval uses `/v1/rooms/:roomId/packages/:digest`, authenticates the capability in that room DO, and requires its immutable pinned digest, including during recovery. Revoked or expired rooms cannot retrieve bytes; responses are `private, no-store`. The old unauthenticated room alias is closed, publisher retrieval requires the package owner's canonical token, and stored bytes are rehashed against the separate artifact digest before serving. Local uploads have an 8,192-byte/5-second bound. Package storage uses local D1/R2 bindings; the room saga, production publishing authority, complete retention and controller package-cache lifecycle remain unfinished. Raw legacy rooms without a pinned package context fail closed.

The renderer currently measures **2,888,275 bytes**, above the normative 2 MiB target. A temporary 4 MiB local ceiling remains a recorded deviation, not completion of the budget requirement.

The server verifier now exports only package verification and its startup self-test. A separate Cargo profile reduces its Wasm from 2,084,449 to 1,038,291 bytes; the browser verifier remains byte-identical. Both bindings use the same archive verification core, with shared golden/mutation/pin conformance tests. In the local Node/V8 probe, an 8,191-byte dense package measured 6.6 ms startup process CPU and 5.1 ms maximum request process CPU across 30 iterations. Roughly 31 KiB dense syntax and 789 KiB padding still peaked at 19.6/20.4 ms request process CPU, so the 8 KiB admission limit remains. Startup includes a public signed archive self-test. These measurements include process/JIT activity and are not a billed CPU guarantee.

The preceding server-validation checkpoint passed all nine local gates, but [CI run 36928766696](https://github.com/aamodbhatt/sframe/actions/runs/36928766696) failed after 212 browser passes: Firefox timed out during initial personal navigation in the release-update test. The response completed with status 200, but Playwright did not observe the expected commit. Its cause remains unresolved; retries, assertions and navigation deadlines are unchanged.

Local package uploads now require a canonical 128-bit idempotency key. The retained operation binds publisher, route, archive bytes and the covered content-type/digest header values. Publisher, invite and upload rows use explicit foreign keys. D1 records `VALIDATED` before a conditional R2 put; matching head metadata and rehashed object bytes are required before the activation transaction commits package metadata and `D1_ACTIVE`. Changed operation input returns `409 IDEMPOTENCY_MISMATCH`. A bounded local reconciler repairs pending operations whose objects exist; missing or conflicting objects remain pending. Callable cleanup expires completed upload mappings after 24 hours and revoked enrollment mappings after 30 days. The publisher-only local schema still needs the normalized token/app/version migrations and namespace/version uniqueness rules in §10.3. Scheduling, orphan deletion, package/room retention and the durable room saga remain unfinished; these helpers do not enable production publishing. Tests cover a full local runtime restart, competing invite consumption, atomic batch rollback, lost R2 confirmation, interrupted activation, concurrent replay, covered-header conflicts and corrupted storage.

## Verification evidence

At the start of the **2026-09-23** repair, main was [`27dab13`](https://github.com/aamodbhatt/sframe/commit/27dab1305c0768b0db7d3674d5bc36ac25b90c80). Its relay upload deadline repair passed all nine gates locally: **246 unit/integration tests, 30 Rust tests and 177 browser tests** across Chromium, Firefox and WebKit. A stalled upload is rejected after one five-second deadline, cancellation cannot prolong the wait, and an actual encrypted-relay regression checks that the head stays unchanged and a valid retry succeeds.

Its [GitHub CI run](https://github.com/aamodbhatt/sframe/actions/runs/35284687389) finished with **176 browser passes and one Firefox initial-navigation timeout** in the concurrent personal workspace identity test, before its identity assertions ran. The cause remains unresolved. An earlier checkpoint also had a Firefox navigation timeout in a different test; passing local reruns does not establish a fix.

The failed run retained no browser artifact. The skipped-history repair adds secret-free server navigation diagnostics on failure; it does not change navigation assertions, timeouts or retry policy. Its nine focused browser cases pass across Chromium, Firefox and WebKit. This is dated local evidence; see the workflow for later checkpoint results.

The skipped-history checkpoint [`565462c`](https://github.com/aamodbhatt/sframe/commit/565462ca759732d42552ae303fc63729c95983b7) passed all nine local gates (247 unit/integration, 30 Rust, 186 browser), but [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/35773516312) failed after 185 browser passes: one WebKit preapproval test waited for its approval button until the page/context closed. Five focused WebKit reproductions passed; the CI cause remains unknown. The following checkpoint added secret-free shared-page diagnostics for such failures.

The device-forgetting checkpoint [`1a8ed40`](https://github.com/aamodbhatt/sframe/commit/1a8ed40c2bbde78eb3a7d3a4ea447169eadba58c) passed all nine local gates (247 unit/integration, 30 Rust, 192 browser), but [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/35856071437) failed after 191 browser passes. A WebKit editor displayed an in-memory skipped-history warning while its durable head remained at revision 1. A read-only editor lease can skip persistence during reopening; this checkpoint prevents subsequent read-only sync from promoting an unsaved head and makes the reopen test wait for the previous editor lock to release. Its uninterrupted local gates passed (248 unit/integration, 31 Rust, 201 browser). A separate Firefox approval-abort timeout in the first local attempt remains unexplained; a later run was interrupted by Mac sleep and provides no browser verification.

The actor/document checkpoint [`5206a03`](https://github.com/aamodbhatt/sframe/commit/5206a03dffb713a2aa7696600221aa566e7c7368) passed [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/36055244982), including its full browser matrix. The editor lock-handoff checkpoint [`8380743`](https://github.com/aamodbhatt/sframe/commit/83807433107064ae53a7169fc7b0cfd6e2ca7d17) passed all nine local gates (248 unit/integration, 31 Rust, 204 browser), but [CI](https://github.com/aamodbhatt/sframe/actions/runs/36057041658) failed after 202 browser passes. Firefox stalled before initial personal navigation committed even though the server reported a completed response; the cause remains unresolved. WebKit observed a history warning before the reopened room's head was saved. The approval path had left `remembered` false during its first remote fetch; this repair sets it before that fetch for matching saved approval and adds aborted-reopen regressions. Failure-only browser navigation counters supplement the existing server diagnostics without retries or changed deadlines.

The unsigned-repair boundary checkpoint [`ff00392`](https://github.com/aamodbhatt/sframe/commit/ff00392a3bd3f0732ee158d7c2eaf3401090f1a0) passed all nine local gates (248 unit/integration, 32 Rust, 204 browser). [CI](https://github.com/aamodbhatt/sframe/actions/runs/36058312833) failed after 203 browser passes: WebKit's lease test expected revision 1, but the owner had saved revision 3. Its page-route fault did not reliably intercept service worker controlled owner fetches. The test now blocks the owner's runtime fetch directly and retains the revision-1 assertion. The earlier isolated Firefox approval-abort timeout is still unexplained.

The reopened-room checkpoint [`eeb0d8b`](https://github.com/aamodbhatt/sframe/commit/eeb0d8b99dfc97b7cc6912a89a07d14d3c1092a9) passed all nine local gates (249 unit/integration, 32 Rust, 210 browser) and [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/36246017590). Its abort-first-reopen tests fail against the prior approval ordering and pass with the repair. The capability-scoped package checkpoint [`e1073f3`](https://github.com/aamodbhatt/sframe/commit/e1073f36a40cacb9a76b2c1dc00e7c53448e4dde) passed all nine local gates (251 unit/integration, 32 Rust, 210 browser); [its CI](https://github.com/aamodbhatt/sframe/actions/runs/36246546010) failed after 209 browser passes with a Firefox initial-navigation timeout in the Candidate U private-port test, before its security assertions. That test now has failure-only server/browser navigation counters; its cause remains unresolved.

The strict repair-record checkpoint [`0067bdb`](https://github.com/aamodbhatt/sframe/commit/0067bdbf5501d259bd49f58939835508548a5cff) passed all nine local gates (254 unit/integration, 34 Rust, 210 browser). [Its CI](https://github.com/aamodbhatt/sframe/actions/runs/36247254743) passed. The subsequent malicious-signer probe found that `zip215: false` alone did not match native strict verification; the point checks and cross-runtime negative vectors address that difference. These are protocol prerequisites; signed API recovery is not implemented.

The **2026-09-27** recovery-record checkpoint verification passed all nine gates: **260 unit/integration tests, 37 Rust tests and 210 browser tests**. It covers the complete ADR-0011 transition fields, epoch/zero-predecessor bounds and malicious signer points in both runtimes, plus failure-only Candidate U navigation counters. The original Firefox initial-navigation cause remains unresolved; no retries, weaker assertions or increased navigation deadlines were added. Signed API recovery and full transition-chain integration remain unfinished.

The recovery-contract checkpoint [`2a29673`](https://github.com/aamodbhatt/sframe/commit/2a2967321b65c63f8d83ee0fe2d9613342c55893) passed the nine local gates above, but [CI](https://github.com/aamodbhatt/sframe/actions/runs/36269098281) failed after 209 browser passes: Firefox's initial personal navigation timed out before the export test's assertions. That suite had no counters and CI retained no artifact. Forty focused Firefox cases under Node 25 and 210 diagnostic Firefox cases under CI's exact Node 24.20.0 passed locally; neither establishes a cause or fix.

All browser suites now share failure-only navigation counts, stage timings, readiness flags and sanitized server counters. A hash-pinned diagnostic adds only six progress-log statements to Playwright 1.62.1's driver so a failure identifies the awaited stage without emitting URLs, navigation IDs, bodies or secrets. Removing those statements reproduces the original driver byte for byte; source/version drift fails closed. No navigation command, event predicate, return value, timeout or retry policy is changed. Aborted-navigation cases verify the diagnostic payload in all three engines. This is diagnostic coverage while the Firefox CI issue remains open.

The **2026-09-27 navigation diagnostic checkpoint** [`c53957e`](https://github.com/aamodbhatt/sframe/commit/c53957e63e03df91bc594617859f9637e18ed362) passed all nine local gates under CI's Node **24.20.0**: **265 unit/integration, 37 Rust and 213 browser tests**, with no input changes during verification. [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/36272658711) also passed. This establishes diagnostic coverage, not a cause or confirmed fix for the earlier Firefox timeout.

The **2026-09-27 recovery-chain checkpoint** passed all nine local gates under Node **24.20.0**: **274 unit/integration, 42 Rust and 213 browser tests**, with unchanged inputs and matching wall/active run durations. An earlier attempt stopped on a stalled-upload timeout during a confirmed 105-second macOS sleep; the uninterrupted final run retained the original deadlines. The Buffer key-mutation regression also fails against the prior aliasing behavior. Signed record lineage verification is implemented; replacement-envelope checks and atomic recovery integration remain open.

Its [GitHub CI run](https://github.com/aamodbhatt/sframe/actions/runs/36273853911) failed after **212 of 213 browser tests**. Firefox's initial `page.goto('/', waitUntil: 'commit')` timed out before the test assertions. Failure-only counters show one completed HTTP 200 navigation request, a complete controller document with its root host and service-worker control, and no Playwright frame-navigation event delivered to the waiting driver. This narrows the failure to navigation event delivery in that run; it does not establish an upstream root cause or an app fix. No retry, assertion or navigation deadline was changed.

The accepted recovery-chain byte contract is canonical unpadded base64url of SHA-256 over a preceding transition record's exact UTF-8 JCS bytes. The detached signature is verified separately. This freezes content identity for chain links; it does not authorize a recovery or replace the unfinished chain, context, envelope and transaction checks.

The preceding workspace-pointer and Apache-2.0 checkpoint, [`32a51b6`](https://github.com/aamodbhatt/sframe/commit/32a51b651ade155768d73a896e227ce9b7acc88f), passed all nine local gates (227 unit/integration, 30 Rust and 177 browser tests) and [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/35284025743). Concurrent opens select one durable workspace identity; aborted or throwing pointer writes reject and permit retry. See [current CI](https://github.com/aamodbhatt/sframe/actions/workflows/ci.yml) for later results.

The **2026-10-02 enrollment recovery verification** passed the first eight gates (284 unit/integration and 46 Rust tests), then failed the browser gate with **212/213 passes**. A WebKit schema-invalid-state test timed out during invite navigation before its security assertions; diagnostics showed no service-worker control; the old request counters covered only `/`, so their zero values cannot establish whether the room-entry request occurred. The invite helper now preserves only a failure-stage enum, a timeout boolean and the pinned driver's fixed booleans/counts, including ANSI-formatted errors while discarding its secret-bearing error. Navigation commands, deadlines and assertions are unchanged. A second full run also passed its first eight gates and failed the same WebKit case (212/213). Forty isolated WebKit cases and the 44-case ordered shared-room suite passed. A tiny HTML-only probe then reproduced the stall at navigation 64 under Playwright 1.62.1; the display was asleep during the failed runs. Temporary Playwright 1.63.0/WebKit passed all 160 probe navigations. The repository now pins 1.63.0 and its exact driver hash for full regression verification. [Upstream issue #42385](https://github.com/microsoft/playwright/issues/42385) reports the matching display-sleep mechanism and newer-build fix. This does not establish a fix for the distinct earlier Firefox timeout. Request counters now include room-entry paths without retaining room IDs or fragments. No checkpoint has been committed from these failed runs; the new-pin browser run was stopped after repeated WebKit failures and a macOS prompt for the Playwright WebCrypto Keychain item. Its first eight gates passed (285 unit/integration and 46 Rust tests), but it is unverified. Browser tests remain stopped to avoid repeating that prompt; no Keychain item or access permission has been changed. The subsequent upload journal changes require fresh verification.

Run the complete checkpoint gates:

```bash
npm run doctor
npm run build
npm run typecheck
npm run lint
npm run complexity
npm test
cargo test --locked --workspace --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
npm run test:e2e
```

Tests cover malformed packages/envelopes, signature/context substitution, aborted persistence, stale initialization, offline convergence and sandbox escape attempts. Passing them does not establish universal browser isolation, globally fresh relay history, independent security validation or market demand.

## Development with Codex

Codex is used to inspect existing code and CI, reproduce failures, implement bounded repairs, add adversarial regressions and run the verification gates before checkpoints. Examples include fixing persistence-before-acknowledgement ordering, reconciling the signed wire schema and testing atomic approval under aborted IndexedDB transactions. The project runtime and app contract have no AI/model dependency.

The next engineering priorities are durable publisher storage and exact operation resumption, reliable CI navigation, signed recovery, complete local secret deletion and remaining replica/multi-tab correctness. Production publishing and release readiness remain open. Persistent missed-history warnings are already implemented and tested for remembered editor and viewer rooms; they do not prove global freshness.

## Quick start

Requirements are pinned and checked by the repository doctor. The project intentionally needs no Docker, VM, GPU, or local model.

```bash
npm install
npm run bootstrap
npm run doctor
SMALLFRAME_CANDIDATE=U npm run check
```

Create and package a disposable local example without touching the real OS credential store:

```bash
npm run cli -- identity init --test-store /path/to/disposable-store
npm run cli -- new "My Small App" --test-store /path/to/disposable-store
npm run cli -- validate ./my-small-app
npm run cli -- pack ./my-small-app --output ./my-small-app.smallframe \
  --test-store /path/to/disposable-store
```

Recovery export/import accepts an owner-only passphrase file for automation or a no-echo prompt interactively. Output files are create-new and identity recovery bundles are mode `0600` on Unix.

Run the built-in signed Decision Board locally with the Candidate U boundary:

```bash
npm run cli -- dev
```

The command rebuilds exact artifacts and serves only on local loopback at `http://app.localhost:4173/`. It creates no account, room, deployment, or share link. Press `Ctrl-C` to stop.

To run an adapted source directory, initialize a disposable publisher identity and pass the same test store to `dev`:

```bash
npm run cli -- identity init --test-store /path/to/disposable-store
npm run cli -- dev ./examples/decision-board/package --test-store /path/to/disposable-store
```

The source is validated, signed into a temporary package, verified again inside the browser Wasm boundary, and deleted from the temporary directory when the server exits. Validation failures use stable error codes and do not start the runtime.

## Ten-minute adaptation exercise

Smallframe includes three intentionally different constrained apps: a tracker, a calculator, and a decision board. Start a timed, non-overwriting copy with:

```bash
npm run adapt -- start tracker /path/to/my-tracker
```

Edit only `app.worker.js` first—for example change the heading and add one action—then finish:

```bash
npm run adapt -- finish /path/to/my-tracker
```

The harness refreshes the declared file digest, validates the entire source package, reports elapsed seconds, and preserves the session after a rejection so you can fix the stable diagnostic and retry. Once it passes, run the adapted app with the custom-source `dev` command above. Replace `tracker` with `calculator` or `decision-board` to exercise a different state shape.

## Architecture principles

| Principle | Consequence |
|---|---|
| Least authority | App packages get no DOM, arbitrary network, server code, publisher CSS, or ambient privileged effects. |
| Verify exact bytes | Manifests use RFC 8785 JCS; archives have one canonical byte representation; packages, files, publishers, and renderer releases are digest-pinned. |
| Keep secrets out of artifacts | Room keys, capabilities, private keys, invite URLs, plaintext state, and initial-state files do not belong in packages, fixtures, logs, or snapshots. |
| Fail closed | Unknown fields, imports, paths, encodings, capabilities, message transitions, versions, and noncanonical artifacts are rejected. |
| Portable escape | Executable packages and documented state formats remain exportable. |
| Evidence before claims | Local browser matrices are evidence about pinned builds—not proof of universal security or demand. |

## Repository map

```text
apps/                    controller, renderer, and local API evidence
crates/smallframe-core/  canonicalization, schemas, signatures, archives, Wasm
crates/smallframe-cli/   identity and package-authoring commands
packages/protocol/       shared schemas, TypeScript boundaries, golden vectors
packages/sdk/            constrained authoring contract
examples/decision-board/ deterministic example package
fuzz/corpus/             bounded parser regression seeds
```

The normative specification, ADRs, status notes, and evidence reports are intentionally retained in the founder workspace but excluded from the public Git repository. The code and automated checks remain the public, reproducible implementation record.

## Security posture

Please do not treat this repository as a safe place for real secrets or production rooms yet. The accepted architecture deliberately records its browser gaps and residual risks. Never commit room keys, capability links, private keys, plaintext room state, or invite URLs.

The repository is still experimental. Review the implementation boundaries and tests critically, and report suspected vulnerabilities privately to the owner until a formal disclosure process exists.

## License and contribution status

Smallframe's original code and documentation are licensed under **Apache-2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies retain their own licenses; [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) records the dependency review and remaining artifact-specific redistribution work. The root npm package remains `private` to prevent accidental npm publication; that setting does not change the source license.

Contributions should preserve the constrained SDK contract and Candidate U boundary, include adversarial coverage for behavior changes, and pass the checkpoint gates above. Keep secrets and private room data out of issues, pull requests, logs and fixtures. A formal private vulnerability-reporting channel and release governance remain to be established. No program acceptance, sponsorship or independent review is claimed.
