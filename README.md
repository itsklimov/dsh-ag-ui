# dsh-ag-ui

English | [简体中文](README.zh.md)

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-ag-ui.svg)](https://www.npmjs.com/package/dsh-ag-ui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host plugin that exposes DSH Agents through the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui). It provides an authenticated HTTP/SSE Gateway, AG-UI thread-to-DSH Agent bindings, streamed text and Tool events, browser-owned Tools, and continuation of the same DSH turn after a browser Tool result returns.

> This is a community project. It is not an official DeepSeek or AG-UI package.

## Features

- Standard Cordis `Service` plugin exposed as `ctx.agUi`
- Installable DSH Profile Bundle through `dsh plugin add`
- Pinned AG-UI `0.0.58` protocol packages
- Authenticated BFF-to-Gateway requests with trusted tenant and user headers
- Process-local `(tenantId, userId, threadId)` bindings to DSH Agents
- AG-UI text streaming and backend Tool result projection
- Agent-scoped browser Tools supplied by `RunAgentInput.tools`
- Frontend Tool Promise parking and ToolMessage continuation across HTTP runs
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

The bundle stays dormant until all required environment variables are present. This prevents an installation from breaking a Profile before the deployment chooses a model route and secret.

```bash
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
export DSH_AG_UI_PATH='/ag-ui' # optional

dsh --profile web
```

The bundle inserts two Host-plane rows:

- `ag-ui` loads the Gateway service.
- `ag-ui-invariant` registers the package invariant companion.

## Profile configuration

Environment variables are the shortest setup path. A Profile can instead override the bundle row in its own `cordis.patch.yml`:

```yaml
- insert:
    - id: ag-ui
      name: dsh-ag-ui
      disabled: false
      config:
        provider: openai
        model: gpt-5.6-sol
        sharedSecret: !!js process.env.DSH_AG_UI_SHARED_SECRET
        path: /ag-ui
        maxThreads: 100
        frontendToolTimeoutMs: 300000

    - id: ag-ui-invariant
      name: dsh-ag-ui/invariant
      disabled: false
```

A later Profile patch replaces the bundle row's complete `config`; include every value that deployment needs.

## Configuration

`provider`, `model`, and `sharedSecret` are required. `sharedSecret` must contain at least 16 UTF-8 bytes.

| Field | Default | Purpose |
| --- | --- | --- |
| `path` | `/ag-ui` | Exact Host HTTP route |
| `provider` | required | Registered DSH model provider route |
| `model` | required | Model ID owned by the provider |
| `sharedSecret` | required | Bearer secret shared only with the trusted BFF |
| `tenantHeader` | `x-dsh-tenant-id` | Trusted tenant identity header |
| `userHeader` | `x-dsh-user-id` | Trusted user identity header |
| `allowNonLoopback` | `false` | Permit a non-loopback Host bind explicitly |
| `maxRequestBytes` | `262144` | Maximum request body bytes |
| `maxIdentityBytes` | `256` | Maximum bytes per protocol or identity ID |
| `maxMessages` | `256` | Maximum message count per request |
| `maxMessageBytes` | `524288` | Maximum combined message JSON bytes |
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
| `maxRunsPerThread` | `32` | Maximum retained run ledger entries per thread |

A non-loopback DSH WebServer requires `allowNonLoopback: true`. Prefer a loopback Gateway behind a same-host authenticated BFF.

## Architecture

```text
Browser
  -> authenticated application BFF
  -> POST /ag-ui with Bearer secret and trusted identity headers
  -> dsh-ag-ui Host Service
  -> DSH Agent / Session / Tool runtime
  -> model provider and backend Tools
```

The Gateway binding key is the exact `(tenantId, userId, threadId)` tuple. A browser-supplied identity, permission, patient ID, resource ID, `context`, or `forwardedProps` value never grants backend authority.

Backend Tools can derive the authenticated thread identity from the Agent:

```ts
const identity = ctx.agUi.identityFor(exec.agent)
if (identity === undefined) {
  throw new Error('This Tool requires an authenticated AG-UI thread.')
}

const { principal, threadId } = identity
```

The application should map this tuple to its server-owned resource authorization state.

## BFF proxy

The browser must not call the private Gateway directly. A BFF should authenticate the user, authorize the application resource, retain the browser request body exactly, and inject trusted identity headers.

```ts
app.post('/api/agent', async (c) => {
  const user = await authenticateApplicationRequest(c.req.raw)
  const body = new Uint8Array(await c.req.raw.arrayBuffer())

  const upstream = await fetch('http://127.0.0.1:3080/ag-ui', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.DSH_AG_UI_SHARED_SECRET}`,
      'content-type': 'application/json',
      'x-dsh-tenant-id': user.tenantId,
      'x-dsh-user-id': user.userId,
    },
    body,
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
})
```

The BFF owns login, sessions, CSRF protection, tenant policy, resource authorization, audit, and rate limits. Do not treat the Gateway bearer secret as end-user authentication.

## Browser client

Install the pinned official client in the frontend application:

```bash
pnpm add @ag-ui/client@0.0.58
```

Send page-specific browser Tools and current context on every run:

```ts
import { HttpAgent, randomUUID } from '@ag-ui/client'

const agent = new HttpAgent({
  url: '/api/agent',
  threadId: 'application-thread-123',
})

agent.addMessage({
  id: randomUUID(),
  role: 'user',
  content: 'Review the current draft.',
})

await agent.runAgent({
  runId: randomUUID(),
  tools: browserTools,
  context: [{
    description: 'Current page state',
    value: JSON.stringify(readPageSnapshot()),
  }],
  forwardedProps: {},
})
```

If the model calls a `ui_*` Tool, the current HTTP run finishes successfully while the DSH Tool Promise remains pending. The browser executes the Tool, appends one standard AG-UI ToolMessage with the same `toolCallId`, and starts another run. The Gateway resolves the original Promise and continues the same DSH turn.

Do not send ordinary browser Tool results through AG-UI `resume[]`; that field is reserved for explicit interrupt/HITL flows.

## HTTP and run semantics

- Requests must be `POST application/json` and match AG-UI `RunAgentInput`.
- A normal run accepts one new text user message.
- A continuation accepts one or more new frontend ToolMessages for one pending DSH turn.
- One DSH turn can cross multiple AG-UI HTTP runs.
- Each run emits one `RUN_STARTED` and exactly one `RUN_FINISHED` or `RUN_ERROR`.
- `runId` is an exact-request idempotency key. Completed identical requests replay retained events without driving DSH again.
- One thread can have only one active HTTP run.
- V1 allows one frontend Tool call per DSH step.

## Client-provided Tools

Browser Tool names must match:

```text
ui_[a-z][a-z0-9_]*
```

Their parameters must use the object-rooted JSON Schema subset enforced by DSH Tools. The Gateway rejects collisions with inherited or global Tools and registers each accepted definition only in the exact Agent's Tool scope.

Backend Tool results are emitted as `TOOL_CALL_RESULT`. Frontend Tool results are not echoed on the AG-UI wire because the browser already added the ToolMessage; DSH still records the real durable `tool/result`.

## Lifecycle

All effects belong to the Cordis plugin fiber. Route removal, idle expiry, timeout, and plugin disposal unregister browser Tools, reject pending calls, cancel active work, dispose Agent handles, and wait for quiescence.

An unexpected HTTP disconnect cancels the Gateway-owned DSH turn. `HttpAgent@0.0.58` does not implement partial SSE reconnect. A frontend Tool handoff is an intentional completed run and does not cancel the parked turn.

## Compatibility

| Component | Supported version |
| --- | --- |
| AG-UI core/client/encoder | `0.0.58` |
| Node.js | `^22.19.0` or `>=24.0.0` |
| DeepSeek Harness | Developer preview packages listed in `peerDependencies` |

DSH is in developer preview and can introduce breaking changes. This package uses exact DSH peer versions until those APIs stabilize.

## Model Experience

### Injected AG-UI context

#### What the model sees

Each non-empty `RunAgentInput.context` becomes one user-role snapshot containing ordered `## <description>` sections. The source is `{ kind: "plugin", plugin: "ag-ui", form: "snapshot", sections }`.

#### Token effect

Conditional and retained. Every accepted normal or continuation run appends its bounded context snapshot to the DSH Session and later model history.

#### KV cache effect

Append-only context preserves earlier reusable history. Changed current context adds a new suffix; provider cache availability is outside this package.

### Client-provided capabilities

#### What the model sees

The current Agent-scoped `ui_*` definitions join the ordinary DSH Tool schema list. Their names, descriptions, and validated parameter schemas come from the authenticated client request; execution remains browser-owned.

#### Token effect

Conditional and replacing. The visible Tool schema list is sent on every model request and changes when the page advertises a different capability set.

#### KV cache effect

An unchanged Tool set preserves the Tool-schema prefix. Adding, removing, or changing a Tool may invalidate provider reuse from that portion onward.

## Known limitations

- Thread and run state is process-local.
- Host restart does not call `agents.resume()` or recover a parked browser Tool.
- Only text user input, assistant text, and string Tool results are adapted.
- One frontend Tool call is allowed per DSH step.
- Partial SSE reconnect is not supported.
- AG-UI interrupt/HITL `resume[]`, multimodal messages, reasoning events, and state event families are not adapted yet.

## Development

```bash
git clone https://github.com/CaiZongyuan/dsh-ag-ui.git
cd dsh-ag-ui
corepack enable
pnpm install
pnpm check
```

`pnpm check` runs lint, strict TypeScript checking, per-file coverage, runtime/type builds, and publint.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and release requirements.

## License

[MIT](LICENSE). Portions are adapted from DeepSeek Harness; see [NOTICE](NOTICE).
