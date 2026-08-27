# ADR-0004: Candidate T Phase 0 architecture evidence passes with a private Worker channel

Status: **historical bounded PASS; superseded by Candidate U in ADR-0005**

Date: 2026-08-21
Scope: one explicitly authorized Candidate T Phase 0 correction

## Decision

Candidate T was the first passing bounded architecture result. Candidate U now
supersedes it with hardened channel/lifecycle/Wasm/hostile-input evidence. Keep
this record as history; use ADR-0005 for the current decision and specification
hold. Do not report MVP completion, deploy, publish, or treat either local
result as an independent security audit.

Candidate T retains the verified content-addressed Service Worker response and
the response-CSP-only opaque renderer shape. The renderer iframe has no
`sandbox` attribute; the cached response carries the literal `sandbox
allow-scripts` policy. This is the narrower architecture that was actually
controlled by the Service Worker in all three pinned engines. The effective
opaque-origin oracle is `self.origin === "null"`, controller-observed
`MessageEvent.origin === "null"`, denied parent DOM access, and denied storage,
cross-context, and network authorities. `location.origin` is recorded only as
URL diagnostics and is expected to be `http://app.localhost:4173`.

## Security boundary and tradeoff

The renderer creates one classic Blob Worker and one `MessageChannel` immediately
after construction. It transfers only `port2` in one keyed bootstrap message.
The Worker prelude installs the first global listener before publisher code,
checks the trusted event/schema/key/exactly-one-port condition, calls captured
`stopImmediatePropagation`, removes the listener, and keeps the transferred
port only in its lexical closure. All trusted messages then use the private
port with session identity, monotonic sequences, exact schemas, structured
clone/freeze boundaries, and byte limits. Worker-global publisher messages are
ignored by the renderer and cannot cause ready, render, state, or error
transitions. Captured intrinsics remain usable after publisher poisoning.

The tradeoff is deliberate: response-CSP sandboxing is a browser/runtime
compatibility premise that must remain in the pinned-browser validation matrix;
it is not interchangeable with `allow-same-origin`, an iframe same-origin
exception, a Blob-document fallback, or a DOM publisher realm. The private
bootstrap key and port reduce the forgeability exposed by Candidate S, but this
ADR does not claim that a hostile browser, extension, compromised controller
release, or future unsupported browser preserves the boundary.

## Firefox compatibility exception

For Candidate T only, the controller CSP adds exactly:

```text
http://app.localhost:4173/sw.js
```

to `frame-src` after the renderer directory source. No `'self'`, wildcard,
`blob:`, `data:`, query-bearing, redirected, or broader source is allowed.
The exact Service Worker response and its error/query candidates carry
`frame-ancestors 'none'`, JavaScript MIME, `X-Content-Type-Options: nosniff`,
no redirect, and a restrictive CSP whose only connection source is the renderer
path. Direct Service Worker frames, query/encoded/suffix forms, and network
renderer fallback were negative-tested in every engine.

## State and recovery correction

The prelude retains a private frozen clone of the latest accepted state, role,
online flag, and revision. Every app invocation receives a fresh clone/frozen
context. Events no longer expect state in their event message. The controller
sends a successful state snapshot before its result, so the next render uses
the accepted state. The watchdog terminates an infinite event, restarts the
Worker, and renders the last state.

The test server's renderer fault is a per-test unguessable cookie/token and
affects only direct iframe fallback requests (`Sec-Fetch-Dest: iframe`). It
does not disable the Service Worker, cache, controller assets, or browser
network. Canary counters are reset and snapshotted serially; publisher code
cannot access the controller test endpoints under `connect-src 'none'`.

## Evidence

Toolchain: Playwright `1.62.1`; Chromium/Chrome for Testing `151.0.7922.34`
(v1234), Firefox `153.0` (v1538), WebKit `26.5` (v2336).

Final valid command:

```text
SMALLFRAME_CANDIDATE=T npm run test:e2e
```

Result: **18 passed, 0 failed** across all three engines. A traced rerun with
`--trace on` also passed 18/18. The suite proved verified-cache provenance,
effective renderer and Worker opacity, storage/network/cross-context denial,
private-port forgery resistance, valid interaction, state retention, watchdog
restart, persistent-profile offline reopen, exact Firefox compatibility
negatives, and zero HTTP/WebSocket canary and renderer-fallback requests.

Separate three-engine negative runs passed for `missing`, `duplicate`,
`thenable`, `malformed`, `oversized`, `syntax`, `exception`, and `top-level`
fixtures. A one-byte renderer mutation was rejected before execution in all
three engines. The deterministic in-memory tamper vector changed the renderer,
factory, and composite digests for one-byte mutations; it is artifact identity
evidence, not a substitute for the future signed package verifier.

Final valid build identity:

```text
renderer digest: 724102f528539f1e46cc96df0db5b14f1d3af704cb45ff76b4816965b79bb871
renderer bytes: 37,512
renderer bootstrap hash: sha256-wsltyn2AbHVRrfTNg/RJZgDqnnlDMGKIfpfasKvc494=
renderer CSS hash: sha256-0yba3n3V5zo4mSzIvh6CHzhiRHKWz9Ume+msXTSyMhU=
factory digest: 7a6878a1009449592d3b947d4f4dba3923e96abe0da2497b16cfe99f62f3d7f7
factory bytes: 4,649
composite digest: 6d6b1790a4d6f6a75cc809c835d578c125944417878882fefd3831e289582cbc
composite bytes: 15,035
```

The successful trace zips are stored separately under
`evidence/phase0/candidate-t-final/traces/` with their SHA-256 values in the
working evidence log.

## Proposed specification amendment (not applied)

The founder may amend `APEX_MVP_BUILD_SPEC.md` in a separately authorized
decision to:

1. define one classic Blob Worker with a renderer-created private
   `MessageChannel` bootstrap, captured intrinsics, strict schemas, byte
   limits, and no trusted Worker-global output;
2. describe the response-CSP-only opaque renderer as the tested local/browser
   design, rather than claiming two independent sandbox layers;
3. record the exact `/sw.js` Firefox compatibility source and all query,
   encoded, suffix, redirect, error, direct-frame, and network-fallback
   negative controls;
4. require the retained-snapshot/state ordering, server-side offline fault
   injection, serial/randomized canary attribution, and bounded readiness
   failure behavior; and
5. require a deterministic future AST/bundler transformation that signs and
   pins factory/composite bytes before package execution.

No specification edit was made in this task.
