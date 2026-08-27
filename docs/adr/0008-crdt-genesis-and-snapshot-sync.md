# ADR-0008: Every shared room has one saved Automerge genesis and snapshot CAS

Status: **accepted design; Phase 3 implementation not claimed**

Date: 2026-08-27

## Decision

The publisher CLI creates one Automerge document exactly once from a local initial-state file or the explicitly public template. It saves, encrypts, signs, and installs those exact bytes as epoch 0/revision 1 in the same Durable Object initialization transaction. A shared room is never exposed at revision 0, and clients never independently rematerialize nested JSON into separate histories.

Every client decrypts and loads the same saved history, then uses its own remembered random actor for later changes. An editor must hold a Web Locks exclusive lock for that room/profile; another same-profile tab is read-only until takeover and state revalidation. Each accepted local batch commits the encrypted document, actor sequence metadata, dirty flag, and relay tuple atomically before UI success.

Sync is optimistic local-first. The client validates/decrypts remote snapshots in a non-DOM Worker, merges them, and sends an encrypted exact-next snapshot with `If-Match`. WebSocket/held-fetch events are hints only; reconnect/focus always converges through conditional state GET. Viewers never PUT.

## Consequences

Pin mutually compatible Rust and browser Automerge versions and require cross-language saved-genesis vectors. P0 uses explicit history limits and export/new-room guidance instead of pretending transparent compaction is safe. The Phase 0 DO byte CAS is necessary infrastructure evidence, not proof of Automerge convergence or hostile-editor parsing.
