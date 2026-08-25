import { afterEach, describe, expect, it } from 'vitest'
import { firstValueFrom, from } from 'rxjs'
import { toArray } from 'rxjs/operators'
import { HttpAgent, verifyEvents } from '@ag-ui/client'
import { EventType, type BaseEvent, type Tool, type ToolCallResultEvent } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import AgUiGateway from 'dsh-ag-ui'
import { ScriptedAdapter, textResponse, toolResponse } from './scripted-adapter.ts'
import { mountTestSpine } from './spine.ts'

/**
 * Conformance suite for the five AG-UI feature scenarios. Every scenario runs
 * end-to-end through the official client against a real HTTP server, and its
 * recorded event stream must pass the client's lifecycle validator — the same
 * arbiter any compliant frontend applies.
 */

const SECRET = 'test-only-ag-ui-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'hospital-demo',
  'x-dsh-user-id': 'clinician-1',
}

interface Harness {
  readonly ctx: Context
  readonly url: string
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function mount(script: StreamChunk[][]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestSpine(ctx, 'You assist a clinician with the current consultation draft.')
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
  })
  return { ctx, url: `http://127.0.0.1:${String(ctx.webServer.port)}/ag-ui` }
}

/** Assert a recorded stream satisfies the official lifecycle validator. */
async function expectLifecycleValid(events: BaseEvent[]): Promise<void> {
  const replayed = await firstValueFrom(from([...events]).pipe(verifyEvents(), toArray()))
  expect(replayed).toEqual(events)
}

/** Backend tool whose durable result is a fixed JSON payload. */
function backendTool(name: string, description: string, properties: Record<string, unknown>, required: string[], result: object): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'unexpected' }],
    },
    execute: () => Promise.resolve(JSON.stringify(result)),
  }
}

const BACKEND_TOOL = backendTool(
  'lookup_backend_record',
  'Look up one backend record.',
  { recordId: { type: 'string' } },
  ['recordId'],
  { recordId: 'record-7', status: 'ready' },
)

const RECIPE_TOOL = backendTool(
  'compose_recipe_card',
  'Compose a structured recipe card for the frontend to render.',
  { dish: { type: 'string' }, servings: { type: 'integer' } },
  ['dish', 'servings'],
  { dish: 'Pasta Primavera', servings: 2, steps: ['Boil the pasta', 'Toss with vegetables'] },
)

const DRAFT_TOOL: Tool = {
  name: 'ui_patch_consultation_draft',
  description: 'Patch the current consultation draft.',
  parameters: {
    type: 'object',
    properties: {
      expectedVersion: { type: 'integer' },
      assessment: { type: 'string' },
    },
    required: ['expectedVersion', 'assessment'],
    additionalProperties: false,
  },
}

async function collect(agent: HttpAgent, runId: string, tools: Tool[]): Promise<BaseEvent[]> {
  const events: BaseEvent[] = []
  await agent.runAgent({ runId, tools, context: [], forwardedProps: {} }, {
    onEvent: ({ event }) => { events.push(event) },
  })
  return events
}

describe('AG-UI five-feature conformance', () => {
  it('the lifecycle arbiter rejects an out-of-order stream', async () => {
    const broken = [
      { type: EventType.RUN_STARTED, threadId: 'conformance-arbiter', runId: 'arbiter-run' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'orphan', delta: 'no start event' },
      { type: EventType.RUN_FINISHED, threadId: 'conformance-arbiter', runId: 'arbiter-run' },
    ] as BaseEvent[]
    await expect(expectLifecycleValid(broken)).rejects.toThrow(/No active text message found/)
  })

  it('agentic chat streams one validated text turn', async () => {
    const harness = await mount([textResponse('The consultation draft looks consistent.')])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-chat' })
    agent.addMessage({ id: 'chat-user', role: 'user', content: 'Review my draft.' })
    const events = await collect(agent, 'chat-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'The consultation draft looks consistent.' })
  })

  it('the run-start snapshot reflects the full derived history with ids matching the streamed events', async () => {
    const harness = await mount([
      toolResponse('conformance-history-call', BACKEND_TOOL.name, { recordId: 'record-7' }),
      textResponse('Backend lookup completed.'),
      textResponse('Second answer.'),
    ])
    harness.ctx.tools.register(BACKEND_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-history' })
    agent.addMessage({ id: 'history-user', role: 'user', content: 'Look up record 7.' })
    const first = await collect(agent, 'history-run-1', [])
    const second = await collect(agent, 'history-run-2', [])

    const streamedAssistant = first.find(event => event.type === EventType.TEXT_MESSAGE_START)
    const streamedResult = first.find((event): event is ToolCallResultEvent =>
      event.type === EventType.TOOL_CALL_RESULT)
    const snapshot = second.find(event => event.type === EventType.MESSAGES_SNAPSHOT)
    expect(snapshot?.messages).toEqual([
      { id: 'history-user', role: 'user', content: 'Look up record 7.' },
      {
        id: streamedResult?.messageId,
        role: 'tool',
        toolCallId: 'conformance-history-call',
        content: streamedResult?.content,
      },
      { id: streamedAssistant?.messageId, role: 'assistant', content: 'Backend lookup completed.' },
    ])
    await expectLifecycleValid(second)
  })

  it('backend tool streams a validated call/result pair the client can render', async () => {
    const harness = await mount([
      toolResponse('conformance-backend-call', BACKEND_TOOL.name, { recordId: 'record-7' }),
      textResponse('Backend lookup completed.'),
    ])
    harness.ctx.tools.register(BACKEND_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-backend-tool' })
    agent.addMessage({ id: 'backend-user', role: 'user', content: 'Look up record 7.' })
    const events = await collect(agent, 'backend-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    const result = events.find((event): event is ToolCallResultEvent =>
      event.type === EventType.TOOL_CALL_RESULT)
    expect(result?.content).toContain('"recordId":"record-7"')
    expect(agent.messages.some(message =>
      message.role === 'tool' && message.toolCallId === 'conformance-backend-call')).toBe(true)
  })

  it('shared state updates stream as validated snapshots after the durable tool result', async () => {
    const harness = await mount([
      toolResponse('conformance-state-call', 'ag_ui_update_state', {
        state_updates: { status: 'ready', recipe: { title: 'Pasta Primavera' } },
      }),
      textResponse('The shared state is ready.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-shared-state' })
    agent.setState({ status: 'draft' })
    agent.addMessage({ id: 'state-user', role: 'user', content: 'Finalize the shared state.' })
    const events = await collect(agent, 'state-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    expect(agent.state).toEqual({ status: 'ready', recipe: { title: 'Pasta Primavera' } })
  })

  it('human-in-the-loop frontend tool parks and resumes across two validated runs', async () => {
    const harness = await mount([
      toolResponse('conformance-frontend-call', DRAFT_TOOL.name, {
        expectedVersion: 3,
        assessment: 'Likely viral upper respiratory infection.',
      }),
      textResponse('Draft updated. Please review it before submitting.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-hitl' })
    agent.addMessage({ id: 'hitl-user', role: 'user', content: 'Write the assessment here.' })
    const parkEvents = await collect(agent, 'hitl-run-1', [DRAFT_TOOL])

    expect(parkEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(parkEvents)

    agent.addMessage({
      id: 'hitl-tool-result',
      role: 'tool',
      toolCallId: 'conformance-frontend-call',
      content: JSON.stringify({ status: 'applied', version: 4 }),
    })
    const resumeEvents = await collect(agent, 'hitl-run-2', [DRAFT_TOOL])

    expect(resumeEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(resumeEvents)
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Draft updated. Please review it before submitting.' })
  })

  it('tool-based generative UI returns a structured payload in a validated tool result', async () => {
    const harness = await mount([
      toolResponse('conformance-recipe-call', RECIPE_TOOL.name, { dish: 'Pasta Primavera', servings: 2 }),
      textResponse('Recipe card composed.'),
    ])
    harness.ctx.tools.register(RECIPE_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-generative-ui' })
    agent.addMessage({ id: 'recipe-user', role: 'user', content: 'Compose a recipe card for dinner.' })
    const events = await collect(agent, 'recipe-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    const result = events.find((event): event is ToolCallResultEvent =>
      event.type === EventType.TOOL_CALL_RESULT)
    const payload = JSON.parse(result?.content ?? '{}') as { dish?: string, steps?: string[] }
    expect(payload.dish).toBe('Pasta Primavera')
    expect(payload.steps).toContain('Boil the pasta')
  })
})
