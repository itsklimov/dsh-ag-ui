# dsh-ag-ui

[English](README.md) | 简体中文

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-ag-ui.svg)](https://www.npmjs.com/package/dsh-ag-ui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个社区维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host 插件，通过 [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui) 暴露 DSH Agent。它提供经过认证的 HTTP/SSE Gateway、AG-UI thread 到 DSH Agent 的绑定、流式文本和 Tool event、浏览器持有的 Tools，以及浏览器返回 Tool result 后继续同一个 DSH turn 的能力。同一套投影核心另有一种嵌入形态：独立的 `dsh-ag-ui-adapter` 包在 AG-UI `AbstractAgent` 背后 spawn 一个私有的环回微型 Host。

> 这是社区项目，不是 DeepSeek 或 AG-UI 官方 package。

## 功能

- 通过 `ctx.agUi` 暴露的标准 Cordis `Service` 插件
- 通过 `ctx.browserTools` 暴露的传输无关 Agent-scoped browser Tool broker
- 可使用 `dsh plugin add` 安装的 DSH Profile Bundle
- 下限式 AG-UI 协议范围（`~0.0.59`）
- 使用可信 tenant/user headers 的 BFF-to-Gateway 认证
- 按 thread 流式上传文件并通过认证 route 下载
- `(tenantId, userId, threadId)` 到 DSH Agent 的进程内绑定
- AG-UI 文本流与 backend Tool result 投影
- 由 `RunAgentInput.tools` 提供的 Agent-scoped browser Tools
- 跨 HTTP runs 的 Frontend Tool Promise park 与 ToolMessage continuation
- 通过 `RunAgentInput.state`、`ag_ui_update_state` 和 `STATE_SNAPSHOT` 实现的双向 shared state
- 后端 Tool 调用以带版本的 `dsh:tool:view` CUSTOM 事件携带 presenter card，live 与冷回放一致
- 独立的 `dsh-ag-ui-cards` React 包渲染全部 card 种类，组件测试基于录制自真实 Gateway 的事件
- 独立的 `dsh-ag-ui-adapter` 嵌入适配包，spawn 环回 DSH 微型 Host 并以 AG-UI `AbstractAgent` 形式提供服务
- 覆盖五项标准 AG-UI feature 的 keyless Dojo-compatible example
- Run 和 message 幂等
- Request、context、Tool schema、event buffer、thread 和 run ledger 上限
- 完整回收 route、Agent、Tool、timer 和 pending call 的 Cordis disposal

## 运行要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- 包含标准 Host services 的 DSH Profile
- 已注册的 DSH model provider 与 model
- 一个经过认证的 Backend-for-Frontend，确保浏览器无法获得 Gateway secret

## 安装

将 bundle 安装到 DSH Profile：

```bash
dsh plugin --profile web add dsh-ag-ui
```

npm 发布前可直接从 GitHub checkout 安装：

```bash
dsh plugin --profile web add github:CaiZongyuan/dsh-ag-ui
```

Bundle 始终挂载轻量的 `browser-tools` row。只有 AG-UI Gateway row 会在全部必需环境变量存在前保持 dormant，因此原生 DSH 集成可以租用 browser-owned Tools，而不必再配置一套 model route 或 Gateway secret。

```bash
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
export DSH_AG_UI_PATH='/ag-ui' # 可选

dsh --profile web
```

Bundle 插入一个始终启用的 `browser-tools` row 和一个按条件启用的 Host-plane `ag-ui` row。前者从不创建 Agent：调用方负责选择已有 Agent 并提供浏览器传输。Package 仍导出 `dsh-ag-ui/invariant`；提供 process-global `invariants` service 的 composition 可以显式加载该可选 companion。默认 web Profile 不提供该 service，因此 installable bundle 不会自动挂载 companion。

## Browser Tool broker

`dsh-ag-ui/browser-tools` 用一个接口隐藏 provider-safe 名称检查、object-rooted schema 校验、精确 Agent scope 注册、目录替换、冲突、取消、超时和租约回收。调用方拥有 Agent 选择与传输：

```ts
const lease = ctx.browserTools.bind(agent, owner, tools, {
  invoke: (call, signal) => browserTransport.invoke(call, signal),
})

lease.update(nextTools)
lease.dispose()
```

浏览器上下文和 Tool result 是能力数据，不是授权。持久化动作仍必须经过服务端身份、资源校验和领域确认流程。

## Profile 配置

环境变量是最短配置路径。Profile 也可以在自己的 `cordis.patch.yml` 中覆盖 bundle row：

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

后应用的 Profile patch 会替换 bundle row 的完整 `config`；请包含 deployment 所需的全部配置值。

## 已声明的交付文件

Harness 的 `present` 声明投影为标准 AG-UI `ACTIVITY_SNAPSHOT`，其
`activityType` 为 `dsh-deliverables`。活动消息的 id 由原生会话和事件序号决定，
历史读取和重启后保持一致。嵌套的 `present` 成功后，即使外层工具失败，声明仍然保留。

活动 `content` 保留原生 `turn`、`callId` 和 `files: [{ path, description? }]`，
并为每个文件添加相对 `url`。受信任的 BFF 必须使用与 Agent 运行相同的认证租户和用户头代理此 URL：

```text
GET /ag-ui/threads/:threadId/deliverables/:eventSeq/files/:fileIndex
```

此路由仅读取已认证线程中的声明，使用该 Session 的原生文件系统和持久化 cwd，
包括提供方允许的绝对路径。通过原生 preset roster 查找隔离的文件系统，仅在该 preset 未提供文件系统时使用 Host 文件系统。Host 必须在该 Agent 作用域提供 `@deepseek-ai/dsh-fs`，
并在需要工具的作用域挂载 `@deepseek-ai/dsh-tool-present`。交付文件不需要附件存储或上传凭据。
响应以附件下载当前文件，并设置 `Cache-Control: no-store`，不会归档最初的字节内容。
文件已删除或不是普通文件时返回 404，提供方拒绝读取时返回 403，超过 `maxFileBytes` 时返回 413。
读取受字节上限约束，并在客户端断开时取消。这些 URL 需要认证，不能用作公开分享链接。

客户端在对话记录中渲染 `dsh-deliverables` 活动。普通文件工具结果和客户端提交的工具消息不会生成交付声明。

## 配置

`provider`、`model` 和 `sharedSecret` 必填。`sharedSecret` 至少包含 16 个 UTF-8 bytes。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `path` | `/ag-ui` | Run 与 file 使用的 Host HTTP route base |
| `provider` | 必填 | 已注册 DSH model provider route |
| `model` | 必填 | Provider 持有的 model ID |
| `workspaceRoot` | `<DSH_HOME>/workspaces` | 按 durable session id 命名的 thread workspace 目录根路径 |
| `agentPreset` | 无 | 组合进每个线程的部署级默认 agent preset id |
| `tenantPresets` | `{}` | 按租户覆盖 `agentPreset` 的 preset id 映射 |
| `selectableAgentPresets` | `{}` | 每个已认证租户可以为空白线程选择的规范 preset id |
| `sharedSecret` | 必填 | 仅与可信 BFF 共享的 bearer secret |
| `tenantHeader` | `x-dsh-tenant-id` | 可信 tenant identity header |
| `userHeader` | `x-dsh-user-id` | 可信 user identity header |
| `allowNonLoopback` | `false` | 显式允许非 loopback Host bind |
| `maxRequestBytes` | `262144` | 最大 request body bytes |
| `maxFileBytes` | `104857600` | 每个上传文件或交付文件下载的最大 bytes |
| `maxIdentityBytes` | `256` | 每个 protocol 或 identity ID 的最大 bytes |
| `maxMessages` | `256` | 每次 request 的最大 message 数量 |
| `maxMessageBytes` | `524288` | Message JSON 最大总 bytes |
| `maxFilesPerMessage` | `8` | 每条 user message 的最大非文本 part 数量 |
| `maxContexts` | `32` | 最大 context entry 数量 |
| `maxContextBytes` | `131072` | Context JSON 最大总 bytes |
| `maxTools` | `32` | 最大 browser Tool 数量 |
| `maxToolBytes` | `131072` | Browser Tool JSON 最大 bytes |
| `maxToolSchemaDepth` | `16` | Browser Tool schema 最大深度 |
| `maxForwardedPropsBytes` | `65536` | `forwardedProps` JSON 最大 bytes |
| `maxStateBytes` | `65536` | State JSON 最大 bytes |
| `maxThreads` | `100` | 最大进程内 live threads |
| `threadIdleMs` | `1800000` | Idle thread lifetime |
| `frontendToolTimeoutMs` | `300000` | Browser Tool result 最大等待时间 |
| `maxRunEvents` | `4096` | 每个 run 最大保留 events |
| `maxRunEventBytes` | `2097152` | 每个 run 最大保留 event bytes |
| `maxRunsPerThread` | `32` | 每个 thread 保留的 run ledger entries 上限，同时也分别限制等待请求的数量 |

`agentPreset` 让每个线程的 agent 从宿主的 agent-presets roster 组合而来（需在本 Gateway 之前挂载 roster 插件）；无法解析的 id 会让 Gateway 激活响亮失败，按租户条目覆盖该租户线程的部署默认值，而恢复的线程保持其持久 session 自己记录的组合。不配置 `agentPreset` 时，线程保持宿主组合不变。

文件路由要求官方 `fileUploads` 和 `attachments` services，`@deepseek-ai/dsh-web-app` 已挂载这两个服务。`POST <path>/threads/<threadId>/files` 流式接收 raw body、`content-length`、可选的 `content-type` 和 percent-encoded `x-file-name`。Harness 负责流式存储、内容哈希、临时文件清理和 staged receipts。响应保留 AG-UI URL source 及 filename/size/sha256 metadata。

客户端更换代理前缀时必须保留返回 URL 的 query。Gateway 为认证 session 的原生文件引用和 receipt 签名。`GET` 校验签名及 principal/thread 映射后调用官方流式 reader。同名上传保留显示名称，但获得不同的 receipt URL。冷恢复后仍可授权下载；轮换 shared secret 会使旧 URL 失效。原生上传接入前的无签名 URL 需要重新上传。

User message 接受有序的 text 和带签名的 thread-file URL parts。图片走官方 image admission，其他文件成为原生 file content parts。Harness 负责 receipt 绑定、成功 admission 后的回收，以及队列投递失败时的回滚。被拒绝的 admission 可以使用仍处于 staged 状态的 receipt 重试。已消费、显式回收或冷启动后尚未发送的 receipt 返回 `FILE_NOT_STAGED`，需要重新上传；Gateway 不会恢复过期授权。`MESSAGES_SNAPSHOT` 保留实际接受的完整 AG-UI parts。异步文件处理后会重新校验 shared-state 和 frontend Tool admission，再发布这些 parts。不接受 inline data parts。

每个 thread 使用 `<workspaceRoot>/<sessionId>` 作为 DSH working directory。目录按 durable session id 命名，客户端 thread id 不会落盘。Host 提供 `workspaceRegistry` 时，Gateway 会为 DSH Web 注册新 workspace。
同一租户需要多个 preset 时，宿主可配置 `selectableAgentPresets: { "tenant-1": ["alpha", "beta"] }` 授予选择权限。run 随后可通过 `forwardedProps: { agentPreset: "beta" }` 请求选择。Gateway 在激活时对照 roster 验证授权列表，并在线程的 run reservation 内调用原生 `agentPresets.select`，在首个 turn 前完成选择。roster 本身不授予权限；BFF 仍需认证租户并授权用户访问应用功能。

选择是可选的。省略该字段会保留当前组合；重复当前生效的规范 id 不做任何更改，重启后也一样。不同且未授权的 id 返回 HTTP 403 `PRESET_NOT_ALLOWED`；首个 turn 开始后请求切换到已授权的其他 id 返回 HTTP 409 `PRESET_LOCKED`。仅同步历史的请求不会选择 preset，因此由历史读取创建的 session 仍可在首个工作 run 中选择。原生 session 日志记录实际组合，并在重启后恢复。Gateway 在 SSE 开始前根据所选组合验证 Tool 名称。若选择成功后该验证拒绝 run 或客户端断开，已记录的选择会保留；用户 turn 不会启动，空白 session 仍可再次选择。

