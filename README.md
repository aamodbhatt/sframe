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

An immutable publisher-signed package is pinned by digest. A trusted controller owns keys, persistence, and privileged effects. App logic runs in a constrained Worker and can only emit schema-validated view nodes and state intents. The eventual shared-room protocol encrypts state in the browser before relay storage.

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

The repository has passed its **local Phase 1 protocol and package-core gate**. Candidate U is the accepted local browser architecture, and Phase 2 personal-runtime implementation is in progress.

Working locally today:

- content-addressed, Service-Worker-cached renderer response;
- response-CSP sandboxing with an opaque renderer origin;
- one classic Blob Worker with a trusted lexical prelude and private `MessageChannel`;
- strict channel/session/sequence schemas, watchdog recovery, and hostile fixtures;
- Rust native/Wasm package verification with JCS, DSSE Ed25519, SHA-256, strict JSON, bounded ZIP parsing, and deterministic STORE archives;
- encrypted CLI identity initialization/export/import with OS credential-store abstraction;
- `new`, `validate`, and deterministic `pack` CLI flows;
- versioned protocol schemas and language-neutral golden vectors;
- Chromium, Firefox, and WebKit local evidence.

Not claimed: a completed MVP, deployed Cloudflare behavior, independent security review, market validation, or production readiness.

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
docs/adr/                local architecture decisions and accepted constraints
evidence/                local reproducible gate reports
fuzz/corpus/             bounded parser regression seeds
```

The normative specification, ADRs, status notes, and evidence reports are intentionally retained in the founder workspace but excluded from the public Git repository. The code and automated checks remain the public, reproducible implementation record.

## Security posture

Please do not treat this repository as a safe place for real secrets or production rooms yet. The accepted architecture deliberately records its browser gaps and residual risks. Never commit room keys, capability links, private keys, plaintext room state, or invite URLs.

The repository is still experimental. Review the implementation boundaries and tests critically, and report suspected vulnerabilities privately to the owner until a formal disclosure process exists.

## License and contribution status

The code is currently `UNLICENSED` while the project is in private design and validation. No permission to copy, distribute, or deploy is granted yet. Contribution and disclosure processes will be defined before any external beta.
