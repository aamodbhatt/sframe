# Security boundary (internal)

The current Phase 0 evidence prototype tests a browser authority boundary for local personal
packages. Untrusted app code runs in a dedicated Worker and emits a validated
declarative view tree to a trusted opaque-origin renderer. The controller
service worker verifies and caches the exact renderer response before boot.
The tested Candidate U shape relies on the exact cached response CSP for the
renderer sandbox and on one classic Blob Worker with a private lexical port.
Those compatibility premises must remain in the three-engine gate.

This document does not claim that arbitrary publisher code is trustworthy, that
the browser or web-delivery operator is uncompromised, or that the Phase 0
opaque-byte relay spike implements the signed/encrypted production protocol.
Do not use unscoped terms such as “safe”, “secure”, “zero
knowledge”, or “end-to-end encrypted” in product copy.

Report local findings in the status/ADR records. Do not include secrets,
invite fragments, plaintext state, or private keys in reports.
