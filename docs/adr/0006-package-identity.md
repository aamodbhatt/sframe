# ADR-0006: Package identity is canonical, signed, and recipient-pinned

Status: **accepted design; Phase 1 implementation not claimed**

Date: 2026-08-27

## Decision

A version-1 package has exactly `smallframe.json`, one self-contained `app.worker.js`, and `signature.dsse.json`. It accepts no imports after bundling, publisher assets, hidden entries, symlinks, traversal, duplicate normalized paths, unknown expanded sizes, or unbounded compression. The total expanded package is at most 1 MiB and the module at most 768 KiB.

The logical identity is SHA-256 over a domain-separated RFC 8785 canonical manifest. Every file hash/size is in that manifest. The publisher signs the canonical manifest through DSSE PAE with Ed25519. Export produces one deterministic `STORE` ZIP; its exact bytes have a separate artifact digest. Upload recomputes and requires the canonical artifact byte-for-byte.

Invite descriptors pin the logical package digest and publisher key ID. A controller must verify the retrieved package digest, DSSE signature, publisher identity, and signed room descriptor before publisher code or plaintext state reaches the renderer. A different valid self-signed package is not a substitute.

## Consequences

Package code, schema, metadata, and `publicTemplate` are public to the relay/recipients. Confidential initial room state is never package content. Unsigned code is limited to explicit loopback/developer personal mode with unhideable chrome and no relay authority. Rust native, Rust Wasm, and TypeScript must share golden positive/negative vectors before the Phase 1 gate.

Candidate U's factory/composite digests are only Phase 0 artifact evidence; they do not satisfy this ADR's production verifier or signature gate.
