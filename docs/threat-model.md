# Threat model evidence (Phase 0)

## Protected boundary

Publisher app code is hostile. It must not obtain controller DOM authority, room keys/capabilities, browser persistence, direct network access, navigation authority, trusted ports, or the ability to forge controller state transitions. The trusted controller, minimal same-origin Service Worker, pinned renderer bootstrap, build system, and browser engine remain in the trusted computing base.

Candidate U tests publisher attempts to use fetch, WebSocket, storage, Service Workers, nested/shared workers, parent DOM, cross-context messaging, global-message forgery, intrinsic poisoning, duplicate/reentrant registration, accessors/symbols/sparse arrays, oversized messages, non-finite values, Wasm, infinite CPU loops, and malformed lifecycle traffic. Exact channel sessions/sequences/schemas, private lexical ports, declarative view validation, CSP, Worker termination, and controller-side state ownership contain the tested attacks. One-byte renderer mutation is rejected before execution.

The local relay assumes room capabilities are 32 random bytes and stores only their SHA-256 hashes. State is treated as opaque bytes intended to carry caller-produced ciphertext; the spike does not encrypt it or validate an encrypted envelope. The Phase 0 spike bounds request bodies, uses SQLite transactions for exact ETag CAS, binds tickets to room/origin/role/expiry, consumes a found ticket before contextual failure, and removes silent sockets from server transport accounting at room expiry. Exact CORS keeps normal browser conflicts observable without reflecting attacker origins.

## Explicit exclusions and residual risk

- Browser, OS, extension, controller-release, dependency, or publisher-signing-key compromise is not contained by this browser proof.
- Arbitrary publisher memory exhaustion is excluded; bounded infinite-event recovery is tested.
- Response-CSP-only opaque sandboxing and the single classic Blob Worker are tested compatibility premises, not web-platform guarantees for untested future engines.
- Miniflare is a simulator. Hibernation/eviction, close-frame delivery, CPU/quota behavior, platform logging/redaction, and real staging headers remain unproved.
- The Phase 0 Durable Object is a narrow spike. Production envelope signatures, exact-next lineage, rotation/revocation, recovery, backups, quotas, and cross-service sagas are not implemented.
- The fallback model is 28,800 requests/day at nominal ten-minute polling but 36,000/day if every ±20% jitter sample selects eight minutes. The later hard server/project budget is required before beta.
- A ticket presented to a different room DO cannot consume the issuing DO's row; “single-use on any wrong-room attempt” needs a protocol interpretation or redesign before Phase 3.
- Local green evidence is not an independent security review and says nothing about whether users will buy the product.
