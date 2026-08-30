# Deterministic package source

This directory is the Phase 1 self-contained package example. Its checked-in publisher key is a conspicuous deterministic test fixture, never a production identity. `smallframe pack` replaces the publisher fields and file metadata with the active local identity, signs the exact JCS manifest, and writes a create-new deterministic archive.

Runtime room state and `--initial-state` data must never be added here. Only the intentionally public template is package metadata.
