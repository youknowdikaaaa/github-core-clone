# github-core-clone

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?ref=andikha-ramadhan)
[![rank](https://make.fun/badge/github-core-clone-01/youknowdikaaaa/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01?ref=andikha-ramadhan)
[![reward](https://make.fun/badge/github-core-clone-01/youknowdikaaaa/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?ref=andikha-ramadhan)

A GitHub-compatible git forge in one Node.js process — an entry for the
[make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01?ref=andikha-ramadhan).

It speaks the protocols real clients speak, with no dependencies, no git
binary, and no network access at runtime:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (advertisement, `ls-refs`, `fetch` with shallow/deepen) plus a v0 fallback,
  and receive-pack v0 with `report-status`, `side-band-64k` and
  `delete-refs`. Full packfile parse/generate (plain objects on write,
  OFS/REF delta resolution on read), refs, and fast-forward enforcement
  (a non-fast-forward push is refused per ref with `non-fast-forward`).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update/delete with sha checks), labels, issues, comments and pull
  requests with squash merge, plus `Link` pagination and
  `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send (viewer, repository, issues, pull requests,
  mutations, `node(id:)` with opaque Relay ids, `__type` introspection,
  operation batching), with unknown fields reported as GraphQL errors.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern era
  (`server/discover`, revision `2026-07-28`) with the legacy `initialize`
  handshake as a fallback, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) acting on the same in-memory store as REST.

Everything is deterministic: ids, commit timestamps and request ids derive
from counters, never from the clock, so two runs fed the same requests leave
byte-identical state.

## Run

```sh
npm start
# node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, and exits when the environment says the trial is done.
`$MAKEFUN_SHOP_TOKEN` is the bearer token it accepts; when unset, any
non-empty bearer token is accepted (local development).

## Layout

- `main.ts` — entry ↔ environment lifecycle (bind, register, poll `/done`).
- `app.ts` — the HTTP server and routing.
- `gitobj.ts` — git objects: SHA-1, pkt-lines, commits/trees/tags, packfiles.
- `store.ts` — the in-memory forge: repositories, objects, refs, issues, PRs.
- `gitproto.ts` — git smart HTTP handlers (info/refs, upload-pack, receive-pack).
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP endpoint and tools.

## Local score

`sdk/run.ts` against a local server, and `grade-local --driver process`
against the sealed practice trial:

- conformance: **120/120** (feature 600, agent 200)
- perf: **189** local / **179** sealed (push 48, clone 41, read 50, write 50)
- total: **989** local / **979** sealed, replay byte-identical
