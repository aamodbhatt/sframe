# ADR-0012: Phase 1 API payload field freeze

Status: Accepted for schema interoperability; endpoint behavior remains gated to later phases.

The build specification enumerates routes and authority rules but leaves several request bodies implicit. The checked-in `api-*-v1.json` files freeze those bodies before API implementation. Room creation contains only public identifiers, hashes, signed public descriptors, limits, and the encrypted genesis envelope—never raw capabilities, the room key, writer private key, or initial plaintext. Rotation likewise contains only replacement hashes/descriptors. Recovery wraps the exact signed transition and encrypted replacement envelope. Operation status binds route, operation ID, and request digest. Reports and metrics use fixed enums and forbid property bags. Revoke has an idempotent operation ID and creation time.

Package upload remains the canonical ZIP body, state PUT remains `state-envelope-v1`, enrollment and poisoned-head repair use their dedicated signed-record schemas, and empty GET bodies do not get fictional JSON schemas. Cross-field identity, signature, role, expiry, epoch, ETag, and idempotency rules are semantic checks in the later API implementation.

This freeze does not authorize network endpoints, deployment, or a security claim.
