# dsh-ag-ui

English | [简体中文](README.zh.md)

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-ag-ui.svg)](https://www.npmjs.com/package/dsh-ag-ui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host plugin that exposes DSH Agents through the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui). It provides an authenticated HTTP/SSE Gateway, AG-UI thread-to-DSH Agent bindings, streamed text and Tool events, browser-owned Tools, and continuation of the same DSH turn after a browser Tool result returns. The same projection core is also available in an embedding form: the separate `dsh-ag-ui-adapter` package spawns a private loopback micro-host behind an AG-UI `AbstractAgent`.

> This is a community project. It is not an official DeepSeek or AG-UI package.

## Features

- Standard Cordis `Service` plugin exposed as `ctx.agUi`
- Transport-neutral Agent-scoped browser Tool broker exposed as `ctx.browserTools`
- Installable DSH Profile Bundle through `dsh plugin add`
- Floored AG-UI protocol range (`~0.0.59`)
- Authenticated BFF-to-Gateway requests with trusted tenant and user headers
- Streamed per-thread file upload and authenticated download routes
- Process-local `(tenantId, userId, threadId)` bindings to DSH Agents
- AG-UI text streaming and backend Tool result projection
- Agent-scoped browser Tools supplied by `RunAgentInput.tools`
- Frontend Tool Promise parking and ToolMessage continuation across HTTP runs
- Bidirectional shared state through `RunAgentInput.state`, `ag_ui_update_state`, and `STATE_SNAPSHOT`
- Presenter cards for backend Tool calls as versioned `dsh:tool:view` CUSTOM events, live and on cold replay
- React renderers for every card kind in the separate `dsh-ag-ui-cards` package, with component tests against recorded gateway events
- An embedding adapter in the separate `dsh-ag-ui-adapter` package that spawns a loopback DSH micro-host and serves it as an AG-UI `AbstractAgent`
- A keyless Dojo-compatible example for five standard AG-UI features
- Run and message idempotency
- Bounded requests, context, Tool schemas, event buffers, threads, and run ledgers
- Complete Cordis disposal of routes, Agents, Tools, timers, and pending calls

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- A DSH Profile containing the standard Host services
- A registered DSH model provider and model
- An authenticated Backend-for-Frontend that keeps the Gateway secret away from browsers

## Installation

Install the bundle into a DSH Profile:

```bash
dsh plugin --profile web add dsh-ag-ui
```

For the GitHub checkout before an npm release:

```bash
dsh plugin --profile web add github:CaiZongyuan/dsh-ag-ui
```

The bundle always mounts the lightweight `browser-tools` row. The AG-UI Gateway row stays dormant until all required environment variables are present, so native DSH integrations can lease browser-owned Tools without configuring a second model route or Gateway secret.

```bash
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
export DSH_AG_UI_PATH='/ag-ui' # optional

dsh --profile web
```

The bundle inserts an always-on `browser-tools` row and a conditional Host-plane `ag-ui` row. The first never creates an Agent: another integration selects an existing Agent and supplies a browser transport. The package also exports `dsh-ag-ui/invariant`; compositions that provide a process-global `invariants` service may load that optional companion explicitly. The default web Profile does not provide that service, so the installable bundle does not mount the companion automatically.

## Browser Tool broker

`dsh-ag-ui/browser-tools` hides provider-safe name checks, object-rooted schema validation, exact Agent-scope registration, catalog replacement, collisions, cancellation, timeout, and lease teardown behind one interface. A caller owns Agent selection and transport:

```ts
const lease = ctx.browserTools.bind(agent, owner, tools, {
  invoke: (call, signal) => browserTransport.invoke(call, signal),
})

lease.update(nextTools)
lease.dispose()
```

Browser context and Tool results are capability data, not authorization. Durable actions still require server-owned identity, resource checks, and any domain confirmation flow.

## Profile configuration

Environment variables are the shortest setup path. A Profile can instead override the bundle row in its own `cordis.patch.yml`:

```yaml
- id: ag-ui
  disabled: false
  config:
    provider: openai
    model: gpt-5.6-sol
    sharedSecret: !!js process.env.DSH_AG_UI_SHARED_SECRET
    path: /ag-ui
    maxThreads: 100
    frontendToolTimeoutMs: 300000
```

A later Profile patch replaces the bundle row's complete `config`; include every value that deployment needs.

## Presented deliverables

Harness `present` declarations become standard AG-UI `ACTIVITY_SNAPSHOT` events with
`activityType: "dsh-deliverables"`. Their activity messages survive history reads and
restart with the same id, derived from the native session and event sequence. Nested
`present` calls are included even if their enclosing tool later fails.

Activity `content` preserves native `turn`, `callId`, and `files: [{ path, description? }]`,
adding a relative `url` to each file. A trusted BFF must proxy this URL with the same
authenticated tenant and user headers as agent runs:

```text
GET /ag-ui/threads/:threadId/deliverables/:eventSeq/files/:fileIndex
```

The route reads only a declaration from that authenticated thread. It uses the Session's
native filesystem and persisted cwd, including absolute paths the provider permits.
Preset-isolated filesystems are resolved through the native preset roster; the host
filesystem is used only when that preset supplies none.
The host must supply `@deepseek-ai/dsh-fs` in that Agent scope and mount
`@deepseek-ai/dsh-tool-present` where the tool should be available. No attachment store
or upload receipt is needed for a deliverable. The response downloads the current file
as an attachment with `Cache-Control: no-store`; it does not archive the original bytes.
Deleted files and non-regular files return 404, provider access denials return 403,
and files exceeding `maxFileBytes` return 413. Reads are bounded and cancelled when the
client disconnects. The URLs are authenticated references, not public sharing links.

Render `dsh-deliverables` activities in the client's transcript. They do not turn generic
file tool results or client-supplied tool messages into declared deliverables.

## Configuration

`provider`, `model`, and `sharedSecret` are required. `sharedSecret` must contain at least 16 UTF-8 bytes.

| Field | Default | Purpose |
| --- | --- | --- |
| `path` | `/ag-ui` | Base Host HTTP route for runs and files |
| `provider` | required | Registered DSH model provider route |
| `model` | required | Model ID owned by the provider |
| `workspaceRoot` | `<DSH_HOME>/workspaces` | Root for per-thread workspace directories, named by durable session id |
| `agentPreset` | none | Deployment-default agent preset id composed into every thread |
| `tenantPresets` | `{}` | Per-tenant preset ids taking precedence over `agentPreset` |
| `selectableAgentPresets` | `{}` | Canonical preset ids each authenticated tenant may select for a blank thread |
| `sharedSecret` | required | Bearer secret shared only with the trusted BFF |
| `tenantHeader` | `x-dsh-tenant-id` | Trusted tenant identity header |
| `userHeader` | `x-dsh-user-id` | Trusted user identity header |
| `allowNonLoopback` | `false` | Permit a non-loopback Host bind explicitly |
| `maxRequestBytes` | `262144` | Maximum request body bytes |
| `maxFileBytes` | `104857600` | Maximum bytes per uploaded file or deliverable download |
| `maxIdentityBytes` | `256` | Maximum bytes per protocol or identity ID |
| `maxMessages` | `256` | Maximum message count per request |
| `maxMessageBytes` | `524288` | Maximum combined message JSON bytes |
| `maxFilesPerMessage` | `8` | Maximum non-text parts in one user message |
| `maxContexts` | `32` | Maximum context entry count |
| `maxContextBytes` | `131072` | Maximum combined context JSON bytes |
| `maxTools` | `32` | Maximum browser Tool count |
| `maxToolBytes` | `131072` | Maximum browser Tool JSON bytes |
| `maxToolSchemaDepth` | `16` | Maximum browser Tool schema depth |
| `maxForwardedPropsBytes` | `65536` | Maximum `forwardedProps` JSON bytes |
| `maxStateBytes` | `65536` | Maximum state JSON bytes |
| `maxThreads` | `100` | Maximum process-local live threads |
| `threadIdleMs` | `1800000` | Idle thread lifetime |
| `frontendToolTimeoutMs` | `300000` | Maximum browser Tool result wait |
| `maxRunEvents` | `4096` | Maximum events retained per run |
| `maxRunEventBytes` | `2097152` | Maximum retained event bytes per run |
| `maxRunsPerThread` | `32` | Maximum retained run ledger entries and, separately, waiting requests per thread |

`agentPreset` composes each thread's agent from the host's agent-presets roster (mount the roster plugin before this Gateway); an unresolvable id fails Gateway activation loudly, a per-tenant entry overrides the deployment default for that tenant's threads, and a resumed thread keeps the composition its own durable session recorded. Without `agentPreset`, threads keep the host composition unchanged.

File routes require the official `fileUploads` and `attachments` services, already mounted by `@deepseek-ai/dsh-web-app`. `POST <path>/threads/<threadId>/files` streams the raw body with `content-length`, optional `content-type`, and percent-encoded `x-file-name`. Harness owns streamed storage, content hashes, temporary-file cleanup, and staged receipts. The response retains its AG-UI URL source and filename/size/sha256 metadata.

Clients must preserve the returned URL query when changing a proxy prefix. The gateway signs the native file reference and receipt for the authenticated session. `GET` verifies the signature and principal/thread mapping before calling the official streamed reader. Same-name uploads keep their display name and receive distinct receipt URLs. Downloads remain authorized after cold resume; rotating the shared secret invalidates old URLs. Pre-native unsigned upload URLs require a fresh upload.

User messages accept ordered text and signed thread-file URL parts. Images use official image admission; other files become native file content parts. Harness owns receipt binding, successful admission retirement, and rollback when queue delivery fails. Rejected admission can retry its still-staged receipt. A consumed, explicitly retired, or cold unsent receipt returns `FILE_NOT_STAGED` and requires re-upload; the gateway never restores expired authority. `MESSAGES_SNAPSHOT` preserves the exact accepted AG-UI parts. Shared-state and frontend Tool admission are revalidated after asynchronous file processing, before publishing those parts. Inline data parts are not accepted.

Each thread uses `<workspaceRoot>/<sessionId>` as its DSH working directory. The directory is named by the durable session id, so client thread ids stay off disk. When the Host provides `workspaceRegistry`, the Gateway registers new workspaces for DSH Web.
For multiple presets within one tenant, the host can grant selection with `selectableAgentPresets: { "tenant-1": ["alpha", "beta"] }`. A run may then request `forwardedProps: { agentPreset: "beta" }`. The Gateway validates grants against the roster at activation and calls native `agentPresets.select` under the thread's run reservation before its first turn. The roster alone grants no authority, and the BFF must still authenticate the tenant and authorize access to its application features.

Selection is optional. Omitting it preserves the current composition; repeating the effective canonical id is a no-op, including after restart. A different ungranted id fails with HTTP 403 `PRESET_NOT_ALLOWED`; a granted change after the first turn fails with HTTP 409 `PRESET_LOCKED`. A history-only request never selects a preset, so a session created by a history read can still choose one on its first work run. The native session log owns the selected composition and restores it after restart. Tool names are validated against the selected composition before SSE starts. A successful selection remains recorded if that validation rejects the run or its client disconnects; no user turn is started, and the blank session can select again.

