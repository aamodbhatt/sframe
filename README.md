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
| Shared rooms | Signed encrypted genesis, authenticated invitations, real SQLite Durable Object relay under Miniflare, concurrent offline edits, CAS sync and viewer enforcement | Signed recovery, history-gap disclosure, complete device forgetting, viewer persistence and actor sequence validation |
| Parsing and durability | Bounded incoming state, strict UTF-8/duplicate-key checks, schema/document limits, atomic editor consent and durable remote/acknowledgement promotion | Relay request-body deadlines, complete hard-limit/conflict/fuzz matrix |
| Release readiness | Pinned tools, automated gates and three-browser tests | Restore the 2 MiB renderer budget, release artifact notices, operational evidence and external validation |

The shared-room bootstrap and publisher signer are explicitly test-only. The tests run the actual relay implementation locally; they do not demonstrate deployed Cloudflare behavior or production publisher onboarding.

Candidate U remains the accepted architecture: an opaque renderer created by response CSP, one classic Blob **app Worker** with a trusted lexical prelude and private `MessageChannel`, and the exact Firefox `/sw.js` compatibility exception. The trusted controller separately owns the Wasm state-validation Worker. App packages target only [`packages/sdk`](packages/sdk/src/index.ts): one self-contained `app.worker.js`, declarative views and the explicit state API. They receive no DOM access, arbitrary networking, AI dependencies, publisher assets/CSS or server code.

Shared invitations bind the verified publisher/package, room path, capability, writer key, expiry and relay context before approval. Decrypted Automerge documents and merged candidates are checked for structural/history limits and against the signed JSON Schema before acceptance. Remembered room secrets and documents are wrapped with a non-extractable device key; that does not protect against compromised same-origin code or a copied browser profile.

Recent repairs make rejected writes remain rejected: personal edits/imports persist before acknowledgement; shared remote state and relay acknowledgements persist before promotion; approval and initial state commit atomically. Wire envelopes now use the specified outer `revision` field and reject legacy/ambiguous names. Incompatible legacy relay heads fail closed without automatic migration or deletion.

The renderer currently measures **2,876,517 bytes**, above the normative 2 MiB target. A temporary 4 MiB local ceiling remains a recorded deviation, not completion of the budget requirement.

## Verification evidence

As reviewed on **2026-09-17**, checkpoint [`6dae574`](https://github.com/aamodbhatt/sframe/commit/6dae57452b81b80031ca4c9d93d0c20f6fe6859b) passed all nine required gates locally: **227 unit/integration tests, 30 Rust tests and 168 browser tests** across Chromium, Firefox and WebKit.

Its [GitHub CI run](https://github.com/aamodbhatt/sframe/actions/runs/34751897118) finished with **167 browser passes and one Firefox navigation timeout**; earlier gates passed. The preceding [wire-format](https://github.com/aamodbhatt/sframe/actions/runs/34751305832) and [strict relay JSON](https://github.com/aamodbhatt/sframe/actions/runs/34751588638) checkpoints have successful CI. The intermittent navigation cause remains unresolved. See [current CI](https://github.com/aamodbhatt/sframe/actions/workflows/ci.yml) for subsequent results; these are dated observations, not a permanent green-status claim.

The subsequent workspace-pointer and Apache-2.0 checkpoint passed all nine gates locally, confirmed on **2026-09-18**: **227 unit/integration, 30 Rust and 177 browser tests**. Concurrent opens select one durable workspace identity; aborted or throwing pointer writes reject and permit retry. This does not resolve the earlier CI navigation cause.

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

The next engineering priorities are reliable CI navigation, relay body-read deadlines, persistent missed-history warnings, signed recovery, complete local secret deletion and remaining replica/multi-tab correctness. Production publishing and release readiness follow those foundations. These are open work items, not completed phases.

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
