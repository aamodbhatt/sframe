# ADR-0009: Recovery advances signed epochs and never silently rewrites history

Status: **accepted design; Phase 3 implementation not claimed**

Date: 2026-08-27

## Decision

Normal synchronization never accepts rollback, same-revision mismatch, wrong predecessor, or unexplained epoch change. Suspected poisoned/lost authority first enters `RECOVERY_REQUIRED`, freezing normal writes/events while preserving authenticated metadata, package access, local read, and export.

An editor must export first and explicitly choose the recovery source. It creates a fresh one-change Automerge genesis, then signs both the new epoch-1 envelope and a domain-separated recovery transition linking room, package, writer, prior transition, old/highest observed tuple, new digest, reason, and disclosed loss. The DO accepts only contiguous signed lineage, in one transaction, with a maximum of 16 transitions. A viewer or relay cannot authorize recovery.

Clients persist accepted transition chains before declaring success and reject old-epoch envelopes thereafter. Dirty old-epoch edits require export/manual reconciliation. If no valid state or writer key survives, the system says recovery is impossible; it does not manufacture continuity.

## Consequences

Encrypted R2 checkpoints limit disaster loss but are not automatically trusted as current. Recovery can disclose RPO loss and cannot detect a permanent relay split view for first-time clients. Phase 0 implements none of this; the ADR prevents the later implementation from treating an ETag reset as recovery.
