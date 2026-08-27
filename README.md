# Smallframe (internal codename)

Smallframe is an internal Phase 0 evidence prototype for a constrained private small-app
runtime. It is not a public product, package, domain, or security claim.

## Local path

The pinned local path is:

```bash
npm ci
npm run bootstrap
npm run doctor
SMALLFRAME_CANDIDATE=U npm run build
npm test
SMALLFRAME_CANDIDATE=U npm run test:e2e -- tests/e2e/phase0.spec.ts --workers=1
npm run test:phase0:do
```

No Docker, cloud account, paid service, global project binary, or external
telemetry is required. The browser proof uses loopback `app.localhost` and
`api.localhost` origins. The local renderer is verified and cached by the
service worker before a response-CSP-sandboxed frame is created. Candidate U
is the founder-accepted normative local path: the working browser shape omits
the iframe `sandbox` attribute and uses one classic Blob Worker. ADR-0005
records the deviations and authorizes Phase 1 only.

Phase 0 technical evidence is locally green. Phase 1/2 product work, signed
packages, encrypted Automerge rooms, publisher enrollment, and public
deployment are not represented as complete here.

## Status

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exact commands,
gate evidence, failures, and unresolved risks. See the authoritative
[APEX_MVP_BUILD_SPEC.md](APEX_MVP_BUILD_SPEC.md) before changing scope.
