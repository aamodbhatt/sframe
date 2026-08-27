# ADR-0007: Shared state uses a signed, context-bound ciphertext envelope

Status: **accepted design; Phase 3 implementation not claimed**

Date: 2026-08-27

## Decision

Each room gets an independent random 32-byte master key, independent 32-byte viewer/editor capabilities, and an Ed25519 room-writer keypair distinct from the publisher identity. The relay receives capability hashes and the writer public key, never raw capabilities, the room key, writer private seed, or plaintext state.

State snapshots use the versioned, canonical envelope defined in the normative specification: every encryption has a fresh 16-byte salt; HKDF derives a one-use key from the room key plus room/epoch/revision context; a zero nonce is safe only because that key is one-use. AES-256-GCM authenticates the padded saved document with complete room/package/epoch/revision/predecessor context, and the writer signs the exact digest/context. The relay verifies bounds, context, exact-next lineage, signature, and digest but never decrypts, decompresses, or parses Automerge bytes.

Capabilities travel only in `Authorization: SF-Cap` over HTTPS. Invite secrets live in the URL fragment, are synchronously scrubbed before any asynchronous/network action, and are persisted only after explicit approval under a non-extractable device key. The web-delivered controller remains able to access decrypted state; this is not protection from controller-origin compromise.

## Consequences

Ciphertext confidentiality does not hide traffic, package/schema metadata, sizes, epoch/revision, or Cloudflare metadata. Lost room/writer keys are not server-recoverable. Phase 0 stores arbitrary opaque bytes only to prove CAS mechanics; it does not claim envelope/signature conformance.
