import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { firstValueFrom, from } from 'rxjs'
import { toArray } from 'rxjs/operators'
import { HttpAgent, verifyEvents } from '@ag-ui/client'
import { EventType, type BaseEvent, type CustomEvent } from '@ag-ui/core'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import AgUiGateway, { TOOL_VIEW_NAME } from 'dsh-ag-ui'
import { ScriptedAdapter, textResponse, toolCallsResponse } from './scripted-adapter.ts'
import { mountTestSpine } from './spine.ts'

/**
 * The recorded-event fixture contract of `dsh-ag-ui-cards`: one scripted
 * scenario drives every card kind through the real gateway, and the committed
 * JSON stays byte-equivalent to what the gateway emits. Re-record with
 * `UPDATE_TOOL_VIEW_FIXTURES=1 pnpm vitest run tests/tool-view-fixtures.spec.ts`.
 */

const SECRET = 'cards-fixtures-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'cards-tenant',
  'x-dsh-user-id': 'operator-1',
}
const FIXTURE = new URL('../packages/dsh-ag-ui-cards/fixtures/tool-view.events.json', import.meta.url)

/** A compact model-facing output contract shared by the fixture tools. */
function textOutput(render: (value: unknown) => string): ToolDefinition['output'] {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: render(value) }],
  }
}

/** The eight declared presentations one recording exercises, one per card shape. */
const TOOLS: ToolDefinition[] = [
  {
    name: 'notes_check',
    description: 'Check one notes file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: args => ({
      card: 'generic',
      title: 'Checking notes.md',
      kind: 'read',
      rawInput: args,
      locations: [{ path: 'notes.md', line: 3 }],
    }),
    presentResult: () => ({
      card: 'generic',
      title: 'Checked notes.md',
      content: [{ type: 'text', text: '3 headings in 12 lines' }],
    }),
    execute: () => Promise.resolve('3 headings, 12 lines'),
  },
  {
    name: 'suite_run',
    description: 'Run the unit suite.',
    parameters: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: () => ({ card: 'terminal', title: 'pnpm test', description: 'Run the unit suite', cwd: '/repo' }),
    presentResult: () => ({ card: 'terminal', output: 'ok — 148 tests passed', exitCode: 0 }),
    execute: () => Promise.resolve('ok — 148 tests passed'),
  },
  {
    name: 'greeting_write',
    description: 'Write the greeting file.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: () => ({
      card: 'diff',
      title: 'Write greeting.txt',
      diffs: [{ path: 'greeting.txt', oldText: null, newText: 'hello\nworld\n' }],
      locations: [{ path: 'greeting.txt' }],
    }),
    presentResult: () => ({
      card: 'diff',
      title: 'Wrote greeting.txt',
      diffs: [{ path: 'greeting.txt', oldText: 'hello\n', newText: 'hello dsh\n' }],
    }),
    execute: () => Promise.resolve('wrote 1 line'),
  },
  {
    name: 'file_read',
    description: 'Read one file window.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    presentCall: args => ({ card: 'generic', title: 'Reading src/app.ts', kind: 'read', rawInput: args }),
    presentResult: (_args, result) => {
      const meta = result.meta as {
        path: string, offset: number, totalLines: number, lang?: string,
        lines: ReadonlyArray<{ number: number, text: string }>
      }
      return { card: 'read', path: meta.path, offset: meta.offset, lines: meta.lines, totalLines: meta.totalLines, ...(meta.lang === undefined ? {} : { lang: meta.lang }) }
    },
    execute: () => Promise.resolve({
      path: 'src/app.ts',
      offset: 3,
      lines: [
        { number: 3, text: 'export function start() {' },
        { number: 4, text: '  return runtime.boot()' },
        { number: 5, text: '}' },
      ],
      totalLines: 41,
      lang: 'ts',
    }),
  },
  {
    name: 'text_search',
    description: 'Search file content.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: args => ({ card: 'generic', title: 'Searching "dsh:tool:view"', kind: 'search', rawInput: args }),
    presentResult: () => ({
      card: 'search',
      shape: 'matches',
      title: 'Found "dsh:tool:view"',
      files: [{
        path: 'src/tool-view.ts',
        matches: [
          { lineNumber: 12, line: 'export const TOOL_VIEW_NAME' },
          { lineNumber: 31, line: 'export function toolViewCallEnvelope' },
        ],
      }],
      truncated: true,
      total: 9,
    }),
    execute: () => Promise.resolve('9 matches in 1 file'),
  },
  {
    name: 'config_glob',
    description: 'Find files by pattern.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: args => ({ card: 'generic', title: 'Finding *.config.ts', kind: 'search', rawInput: args }),
    presentResult: () => ({
      card: 'search',
      shape: 'paths',
      paths: ['vitest.config.ts', 'tsdown.config.ts'],
      truncated: false,
      total: 2,
    }),
    execute: () => Promise.resolve('2 paths'),
  },
  {
    name: 'web_search',
    description: 'Search the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: args => ({ card: 'generic', title: 'Searching the web for "AG-UI protocol"', kind: 'search', rawInput: args }),
    presentResult: () => ({
      card: 'web',
      kind: 'search',
      title: 'Searched the web',
      sources: [
        { url: 'https://ag-ui.com/', title: 'AG-UI protocol', snippet: 'Agent-user interaction protocol', publishedAt: '2026-01-15' },
        { url: 'https://example.com/agui-guide', snippet: 'A short guide' },
      ],
      answer: 'AG-UI is a protocol for agent-user interaction.',
      truncated: true,
    }),
    execute: () => Promise.resolve('2 sources'),
  },
  {
    name: 'web_fetch',
    description: 'Fetch one URL.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
    output: textOutput(value => typeof value === 'string' ? value : 'unexpected'),
    presentCall: args => ({ card: 'generic', title: 'Fetching https://ag-ui.com/', kind: 'fetch', rawInput: args }),
    presentResult: () => ({ card: 'web', kind: 'fetch', url: 'https://ag-ui.com/', statusCode: 200, truncated: false }),
    execute: () => Promise.resolve('fetched markdown'),
  },
]

/** One scripted backend call per fixture tool, in card-kind order. */
const CALLS = [
  { callId: 'cards-call-1', name: 'notes_check', args: { path: 'notes.md' } },
  { callId: 'cards-call-2', name: 'suite_run', args: { suite: 'unit' } },
  { callId: 'cards-call-3', name: 'greeting_write', args: { text: 'hello dsh' } },
  { callId: 'cards-call-4', name: 'file_read', args: { path: 'src/app.ts' } },
  { callId: 'cards-call-5', name: 'text_search', args: { query: 'dsh:tool:view' } },
  { callId: 'cards-call-6', name: 'config_glob', args: { pattern: '*.config.ts' } },
  { callId: 'cards-call-7', name: 'web_search', args: { query: 'AG-UI protocol' } },
  { callId: 'cards-call-8', name: 'web_fetch', args: { url: 'https://ag-ui.com/' } },
]

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function mount(script: StreamChunk[][]): Promise<string> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestSpine(ctx)
  for (const tool of TOOLS) ctx.tools.register(tool)
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter(script))
  await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    maxRunEvents: 256,
    maxRunEventBytes: 512 * 1024,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
  })
  return `http://127.0.0.1:${String(ctx.webServer.port)}/ag-ui`
}

async function collect(agent: HttpAgent, runId: string): Promise<BaseEvent[]> {
  const events: BaseEvent[] = []
  await agent.runAgent({ runId, tools: [], context: [], forwardedProps: {} }, {
    onEvent: ({ event }) => { events.push(event) },
  })
  return events
}

/** Card envelopes of one recorded stream. */
function envelopes(events: BaseEvent[], phase?: 'call' | 'result'): CustomEvent[] {
  return events.filter((event): event is CustomEvent =>
    event.type === EventType.CUSTOM && event.name === TOOL_VIEW_NAME
    && (phase === undefined || (event.value as { phase?: string }).phase === phase))
}

/** Assert a recorded stream satisfies the official lifecycle validator. */
async function expectLifecycleValid(events: BaseEvent[]): Promise<void> {
  const replayed = await firstValueFrom(from([...events]).pipe(verifyEvents(), toArray()))
  expect(replayed).toEqual(events)
}

describe('tool view card fixtures', () => {
  it('records every card kind live and cold, matching the committed fixture', async () => {
    const url = await mount([
      toolCallsResponse(CALLS),
      textResponse('Every card recorded.'),
      textResponse('Cold replay recorded.'),
    ])
    const agent = new HttpAgent({ url, headers: HEADERS, threadId: 'cards-fixtures' })
    agent.addMessage({ id: 'cards-user-1', role: 'user', content: 'Record every card kind.' })
    const first = await collect(agent, 'cards-run-1')
    agent.addMessage({ id: 'cards-user-2', role: 'user', content: 'Replay cold.' })
    const second = await collect(agent, 'cards-run-2')

    // the live stream carries a call and a result envelope per tool
    expect(envelopes(first, 'call')).toHaveLength(TOOLS.length)
    expect(envelopes(first, 'result')).toHaveLength(TOOLS.length)
    // the cold read re-derives exactly the settled cards, after the snapshot
    const cold = envelopes(second)
    expect(cold).toHaveLength(TOOLS.length)
    expect(cold.every(event => (event.value as { phase: string }).phase === 'result')).toBe(true)
    await expectLifecycleValid(first)
    await expectLifecycleValid(second)

    const recorded = { runs: [first, second] }
    if (process.env.UPDATE_TOOL_VIEW_FIXTURES === '1') {
      await writeFile(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(JSON.parse(await readFile(FIXTURE, 'utf8'))).toEqual(recorded)
  })
})
