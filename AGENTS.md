# Smallframe authoring recipe

Smallframe is a constrained local-first web runtime. Target the
`packages/sdk` contract only: one self-contained `app.worker.js`, declarative
view nodes, and the explicit state API. Do not add AI/model dependencies,
arbitrary network, publisher CSS/assets, server-side code, or DOM access to
app packages.

Run `npm run doctor`, `npm run build`, `npm test`, and `npm run test:e2e` before
claiming a phase gate. Treat `APEX_MVP_BUILD_SPEC.md` as normative. Never put
room keys, capability links, private keys, plaintext room state, or invite
URLs in logs, fixtures, snapshots, or committed files.
