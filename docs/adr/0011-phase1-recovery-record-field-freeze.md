# ADR-0011: Phase 1 recovery-transition field freeze

Status: Accepted for the Phase 1 protocol freeze only.

## Context

The normative build specification defines the recovery-transition contents semantically but does not provide the field-by-field JSON specimen supplied for enrollment, room descriptors, releases, envelopes, and poisoned-head repair. Phase 1 must freeze a language-neutral schema before Phase 3 implements encryption and recovery behavior.

## Decision

`recovery-transition-v1.json` is the exact JCS record signed using the specification's recovery-transition DSSE PAE. The signature is detached and is not a field of the record. The record uses the names `candidateStateEpoch`, `candidateRevision`, and `candidateEnvelopeDigest` for the server recovery candidate; `highestObservedStateEpoch`, `highestObservedRevision`, and `highestObservedEnvelopeDigest` for the editor's prior local head; `priorTransitionDigest` for the zero-or-predecessor chain digest; and `newStateEpoch`/`newEnvelopeDigest` for the replacement epoch-1 head. It includes immutable room/package/writer context, `createdAt`, the reason enum, and the explicit `discardedKnownRevisions` acknowledgement.

Semantic validation additionally requires `newStateEpoch = max(candidateStateEpoch, highestObservedStateEpoch) + 1`, revision 1 for the separately supplied new envelope, exact room/package/writer equality across every object, and a zero `priorTransitionDigest` only for the first transition. Those cross-object rules remain handwritten checks rather than misleading JSON Schema assertions.

This ADR does not authorize Phase 3 recovery implementation or make a security claim.
