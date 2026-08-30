# Phase 1 parser seed corpus

These bounded language-neutral seeds exercise duplicate JSON keys, unsafe I-JSON integers, trailing JSON, a truncated ZIP header, and the canonical package vector in `packages/protocol/vectors/canonical-package-v1.zip.b64`. Unit tests require deterministic rejection or verification without a panic. The extended cargo-fuzz harness remains a later hardening gate installed by `npm run bootstrap:extended`.
