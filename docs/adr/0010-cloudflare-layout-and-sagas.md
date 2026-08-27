# ADR-0010: Cloudflare services have narrow roles and explicit sagas

Status: **accepted design; Phase 0 binding/CAS spike implemented, full layout not claimed**

Date: 2026-08-27

## Decision

- The controller is a separate least-privilege static project with no API/database bindings or runtime HTML rewriting.
- The API Worker validates exact typed configuration at startup, terminates TLS-facing policy, authenticates/rate-limits, and routes room operations.
- One SQLite Durable Object per room serializes configuration, opaque ciphertext CAS, cap hashes, tickets, event transports, lifecycle, recovery lineage, and bounded counters.
- D1 stores publishers, public package metadata, ownership/lifecycle, idempotent operation state, bounded aggregate counters, and operator audit records—never room keys, caps, or plaintext state.
- Private R2 stores canonical signed packages plus encrypted checkpoints/recovery/control backups under content-addressed/private prefixes. No public bucket exists.

D1, R2, and Durable Objects do not share a transaction. Enrollment, publish, room creation, rotation, recovery, revoke, and deletion are explicit idempotent state machines with exact request digests, write-ahead client journals, monotonic authoritative transitions, reconcilers, and orphan cleanup. A mirror never rolls a DO backward to match D1.

## Phase 0 evidence and limits

The local config declares real DO/D1/R2 bindings and fails closed on wildcard/noncanonical origins, non-HTTPS nonlocal deployment, inconsistent local mode, invalid build version, missing/fake binding handles, or origin collision. HSTS/non-sniff/referrer/CORP and exact CORS are centralized. Wrangler packages the Worker locally at 32.50 KiB (8.24 KiB gzip).

The current SQLite DO is intentionally a minimal CAS/ticket/fallback spike. It does not implement the production D1 schema, private package service, request IDs/log allowlist, signatures/envelope lineage, sagas, quotas, checkpoints, rotation/revocation, or deployed retention. Miniflare results cannot establish Cloudflare CPU, hibernation, quota, or logging behavior.
