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
| App authoring | Rust CLI identity, `new`, `validate`, deterministic `pack`, `dev`; tracker, calculator and decision-board examples | Production publisher enrollment, package retrieval and room-creation workflow |
| Package trust and execution | Native/Wasm signature verification, digest pinning, response-CSP sandbox, private channel, watchdog and hostile fixtures | Broader adversarial coverage and independent review |
| Personal workspaces | Approval, local edits, import/export, offline reopen; persistence before acknowledgement; atomic first approval and concurrent workspace identity creation | Coordination between active editing tabs, update/write races and restored revision handling |
| Shared rooms | Signed encrypted genesis, authenticated invitations, real SQLite Durable Object relay under Miniflare, concurrent offline edits, CAS sync, viewer persistence, durable missed-history warnings, local room forgetting, saved actor sequence/head checks and same-profile editor lock handoff | Signed recovery, production package-cache lifecycle and per-room local storage |
| Parsing and durability | Bounded incoming state, relay upload deadlines, strict UTF-8/duplicate-key checks, schema/document limits, atomic editor consent and durable remote/acknowledgement promotion | Complete hard-limit/conflict/fuzz matrix |
| Release readiness | Pinned tools, automated gates and three-browser tests | Restore the 2 MiB renderer budget, release artifact notices, operational evidence and external validation |

The shared-room bootstrap and publisher signer are explicitly test-only. The tests run the actual relay implementation locally; they do not demonstrate deployed Cloudflare behavior or production publisher onboarding.

Candidate U remains the accepted architecture: an opaque renderer created by response CSP, one classic Blob **app Worker** with a trusted lexical prelude and private `MessageChannel`, and the exact Firefox `/sw.js` compatibility exception. The trusted controller separately owns the Wasm state-validation Worker. App packages target only [`packages/sdk`](packages/sdk/src/index.ts): one self-contained `app.worker.js`, declarative views and the explicit state API. They receive no DOM access, arbitrary networking, AI dependencies, publisher assets/CSS or server code.

Shared invitations bind the verified publisher/package, room path, capability, writer key, expiry and relay context before approval. Decrypted Automerge documents and merged candidates are checked for structural/history limits and against the signed JSON Schema before acceptance. Remembered room secrets and documents are wrapped with a non-extractable device key; that does not protect against compromised same-origin code or a copied browser profile.

Recent repairs make rejected writes remain rejected: personal edits/imports persist before acknowledgement; shared remote state and relay acknowledgements persist before promotion; approval and initial state commit atomically. Wire envelopes now use the specified outer `revision` field and reject legacy/ambiguous names. Incompatible legacy relay heads fail closed without automatic migration or deletion.

A remembered room that accepts a signed snapshot after missing revisions records the old and new heads with its last directly verified edge in the encrypted local record. The missed-history warning persists through later direct sync and offline reopen for editors and viewers; local editor and viewer records occupy separate slots. An aborted local write cannot promote the candidate; stale same-profile writes cannot roll back the stored head or erase its warning; exact-next wrong predecessors still block. Older local records with no lineage metadata display an explicit earlier-history warning. This does not prove every intervening edge, global freshness, or signed recovery.

Restored rooms with matching saved approval enter the remembered state before their first remote fetch. An aborted fetch commit retains the prior durable head and warning state; it cannot display a newly accepted history gap before saving it. Reopen regressions cover editors and viewers with an aborted first write followed by a successful sync.

For shared rooms, Forget device removes both local role records, their device keys and remembered approvals in one transaction, then stops same-profile active tabs. A durable generation marker rejects writes from sessions that were open before forgetting. The relay ciphertext remains; reopening with a retained invite requires fresh approval. An aborted deletion reports failure and leaves the records available for retry. Shared storage still uses one origin-wide IndexedDB rather than the spec's per-room database. The current test-only package is embedded in the public controller build; production room-specific package caching is not implemented.

Remembered shared rooms now save the editor actor’s maximum Automerge sequence and sorted document heads alongside the encrypted document. Reopen recomputes both from the validated document and rejects mismatches before approval; older wrapped records gain the metadata in a committed migration before editing. A waiting editor tab remains read-only while another owns the Web Lock. On release it reloads and validates the latest durable document under the storage lock before switching the renderer to editor; a failed read stays read-only, and Forget device stops the queued handoff.

Encrypted rooms now reject the unfinished unsigned `request-repair` path, so an editor capability cannot freeze them without the specified publisher signature and exact head. The local legacy recovery fixture requires an exact `If-Match`, an explicit frozen state, a canonical next epoch and a bounded body. The native repair command requires a canonical `--expected-etag`, sends it as `If-Match`, and reports HTTP rejection as failure. This is a fail-closed boundary while signed publisher repair and signed epoch recovery remain unimplemented; it is not a usable encrypted-room rescue flow.

If an encrypted room is already marked `RECOVERY_REQUIRED` by a trusted restore, an authenticated room member can retrieve the stored signed/encrypted candidate envelope and its tuple in the `503` state response, even with a matching `If-None-Match`. The relay checks the stored envelope digest before returning it and refuses normal writes. The controller does not yet offer the export-first recovery choices or verify a transition chain, and the response has no publisher repair statement until that protocol exists.

Room package retrieval uses `/v1/rooms/:roomId/packages/:digest`, authenticates the capability in that room DO, and requires its immutable pinned digest, including during recovery. Revoked or expired rooms cannot retrieve bytes; responses are `private, no-store`. The old unauthenticated room alias is closed, publisher retrieval requires the package owner's canonical token, and stored bytes are rehashed before serving. Package storage remains an in-memory local prototype; upload signature/ZIP validation, the production publishing saga and controller package-cache lifecycle remain unfinished. Raw legacy rooms without a pinned package context fail closed.

The renderer currently measures **2,887,003 bytes**, above the normative 2 MiB target. A temporary 4 MiB local ceiling remains a recorded deviation, not completion of the budget requirement.

## Verification evidence

At the start of the **2026-09-23** repair, main was [`27dab13`](https://github.com/aamodbhatt/sframe/commit/27dab1305c0768b0db7d3674d5bc36ac25b90c80). Its relay upload deadline repair passed all nine gates locally: **246 unit/integration tests, 30 Rust tests and 177 browser tests** across Chromium, Firefox and WebKit. A stalled upload is rejected after one five-second deadline, cancellation cannot prolong the wait, and an actual encrypted-relay regression checks that the head stays unchanged and a valid retry succeeds.

Its [GitHub CI run](https://github.com/aamodbhatt/sframe/actions/runs/35284687389) finished with **176 browser passes and one Firefox initial-navigation timeout** in the concurrent personal workspace identity test, before its identity assertions ran. The cause remains unresolved. An earlier checkpoint also had a Firefox navigation timeout in a different test; passing local reruns does not establish a fix.

The failed run retained no browser artifact. The skipped-history repair adds secret-free server navigation diagnostics on failure; it does not change navigation assertions, timeouts or retry policy. Its nine focused browser cases pass across Chromium, Firefox and WebKit. This is dated local evidence; see the workflow for later checkpoint results.

The skipped-history checkpoint [`565462c`](https://github.com/aamodbhatt/sframe/commit/565462ca759732d42552ae303fc63729c95983b7) passed all nine local gates (247 unit/integration, 30 Rust, 186 browser), but [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/35773516312) failed after 185 browser passes: one WebKit preapproval test waited for its approval button until the page/context closed. Five focused WebKit reproductions passed; the CI cause remains unknown. The following checkpoint added secret-free shared-page diagnostics for such failures.

The device-forgetting checkpoint [`1a8ed40`](https://github.com/aamodbhatt/sframe/commit/1a8ed40c2bbde78eb3a7d3a4ea447169eadba58c) passed all nine local gates (247 unit/integration, 30 Rust, 192 browser), but [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/35856071437) failed after 191 browser passes. A WebKit editor displayed an in-memory skipped-history warning while its durable head remained at revision 1. A read-only editor lease can skip persistence during reopening; this checkpoint prevents subsequent read-only sync from promoting an unsaved head and makes the reopen test wait for the previous editor lock to release. Its uninterrupted local gates passed (248 unit/integration, 31 Rust, 201 browser). A separate Firefox approval-abort timeout in the first local attempt remains unexplained; a later run was interrupted by Mac sleep and provides no browser verification.

The actor/document checkpoint [`5206a03`](https://github.com/aamodbhatt/sframe/commit/5206a03dffb713a2aa7696600221aa566e7c7368) passed [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/36055244982), including its full browser matrix. The editor lock-handoff checkpoint [`8380743`](https://github.com/aamodbhatt/sframe/commit/83807433107064ae53a7169fc7b0cfd6e2ca7d17) passed all nine local gates (248 unit/integration, 31 Rust, 204 browser), but [CI](https://github.com/aamodbhatt/sframe/actions/runs/36057041658) failed after 202 browser passes. Firefox stalled before initial personal navigation committed even though the server reported a completed response; the cause remains unresolved. WebKit observed a history warning before the reopened room's head was saved. The approval path had left `remembered` false during its first remote fetch; this repair sets it before that fetch for matching saved approval and adds aborted-reopen regressions. Failure-only browser navigation counters supplement the existing server diagnostics without retries or changed deadlines.

The unsigned-repair boundary checkpoint [`ff00392`](https://github.com/aamodbhatt/sframe/commit/ff00392a3bd3f0732ee158d7c2eaf3401090f1a0) passed all nine local gates (248 unit/integration, 32 Rust, 204 browser). [CI](https://github.com/aamodbhatt/sframe/actions/runs/36058312833) failed after 203 browser passes: WebKit's lease test expected revision 1, but the owner had saved revision 3. Its page-route fault did not reliably intercept service worker controlled owner fetches. The test now blocks the owner's runtime fetch directly and retains the revision-1 assertion. The earlier isolated Firefox approval-abort timeout is still unexplained.

The preceding workspace-pointer and Apache-2.0 checkpoint, [`32a51b6`](https://github.com/aamodbhatt/sframe/commit/32a51b651ade155768d73a896e227ce9b7acc88f), passed all nine local gates (227 unit/integration, 30 Rust and 177 browser tests) and [GitHub CI](https://github.com/aamodbhatt/sframe/actions/runs/35284025743). Concurrent opens select one durable workspace identity; aborted or throwing pointer writes reject and permit retry. See [current CI](https://github.com/aamodbhatt/sframe/actions/workflows/ci.yml) for later results.

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

The next engineering priorities are reliable CI navigation, persistent missed-history warnings, signed recovery, complete local secret deletion and remaining replica/multi-tab correctness. Production publishing and release readiness follow those foundations. These are open work items, not completed phases.

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
