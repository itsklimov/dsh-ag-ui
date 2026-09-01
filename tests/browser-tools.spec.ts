import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  BrowserToolBroker,
  type BrowserToolDescriptor,
} from '../src/browser-tools.ts'
import { mountTestAgentCore } from './agent-core.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const TOOL: BrowserToolDescriptor = {
  name: 'surface_read_context',
  description: 'Read the active application context.',
  parameters: {
    type: 'object',
    properties: { detail: { type: 'string' } },
    required: ['detail'],
    additionalProperties: false,
  },
}

async function mount() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestAgentCore(ctx)
  const handle = await ctx.agents.create({
    sessionId: SessionId('browser-tool-broker-spec'),
  })
  const broker = new BrowserToolBroker(ctx, {
    maxTools: 4,
    toolTimeoutMs: 10_000,
  })
  return { ctx, agent: handle.agent, broker }
}

function execution(
  agent: Awaited<ReturnType<typeof mount>>['agent'],
  signal = new AbortController().signal,
): ToolRunContext {
  const callId = ToolCallId('browser-tool-call')
  return {
    agent,
    arguments: { detail: 'summary' },
    callId,
    rootCallId: callId,
    name: TOOL.name,
    signal,
    token: Symbol('browser-tool-execution') as ToolRunContext['token'],
    concludeTurn() {},
    deferContext() {},
  }
}

function visibleTool(
  ctx: Context,
  agent: Awaited<ReturnType<typeof mount>>['agent'],
  name = TOOL.name,
): ToolDefinition {
  const tool = ctx.tools.get(name, agent)
  if (tool === undefined) throw new Error(`Expected ${name} to be visible`)
  return tool
}

describe('BrowserToolBroker', () => {
  it('registers, invokes, replaces, and releases one Agent-scoped lease', async () => {
    const { ctx, agent, broker } = await mount()
    const calls: unknown[] = []
    const lease = broker.bind(agent, 'surface.ankang-his', [TOOL], {
      invoke: (call) => {
        calls.push(call)
        return Promise.resolve('current context')
      },
    })

    const definition = visibleTool(ctx, agent)
    expect(definition.output.render({}, 'value')).toEqual([
      { type: 'text', text: 'value' },
    ])
    expect(definition.output.render({}, 7)).toEqual([
      { type: 'text', text: '7' },
    ])
    expect(definition.presentCall?.({ detail: 'summary' })).toEqual({
      card: 'generic',
      title: TOOL.description,
      rawInput: { detail: 'summary' },
    })
    expect(definition.isConcurrencySafe?.({})).toBe(true)
    await expect(
      definition.execute(
        { detail: 'summary' },
        execution(agent),
      ),
    ).resolves.toBe('current context')
    expect(calls).toEqual([
      {
        arguments: { detail: 'summary' },
        callId: 'browser-tool-call',
        name: TOOL.name,
      },
    ])

    lease.update([TOOL])
    expect(visibleTool(ctx, agent)).toBe(definition)
    lease.update([{ ...TOOL, description: 'Read the latest context.' }])
    expect(visibleTool(ctx, agent)).not.toBe(definition)
    lease.update([{ ...TOOL, name: 'surface_navigate' }])
    expect(ctx.tools.get(TOOL.name, agent)).toBeUndefined()
    expect(ctx.tools.get('surface_navigate', agent)).toBeDefined()

    lease.dispose()
    lease.dispose()
    expect(ctx.tools.get('surface_navigate', agent)).toBeUndefined()
    expect(() => lease.update([])).toThrow('disposed')
    await expect(
      definition.execute({ detail: 'summary' }, execution(agent)),
    ).rejects.toThrow('no longer active')
  })

  it('rejects invalid catalogs, duplicate owners, collisions, and invalid arguments', async () => {
    const { ctx, agent, broker } = await mount()
    expect(() => broker.bind(agent, 'bad owner', [], { invoke: () => Promise.resolve('') }))
      .toThrow('supported identifier')
    expect(() => broker.bind(agent, 'surface.one', [{ ...TOOL, name: 'bad.name' }], {
      invoke: () => Promise.resolve(''),
    })).toThrow('Invalid browser Tool name')
    expect(() => broker.bind(agent, 'surface.description', [{ ...TOOL, description: ' ' }], {
      invoke: () => Promise.resolve(''),
    })).toThrow('has no description')
    expect(() => broker.bind(agent, 'surface.duplicate', [TOOL, TOOL], {
      invoke: () => Promise.resolve(''),
    })).toThrow('Duplicate browser Tool name')
    expect(() => broker.bind(agent, 'surface.schema', [{
      ...TOOL,
      parameters: { type: 'string' } as never,
    }], {
      invoke: () => Promise.resolve(''),
    })).toThrow()
    expect(() => broker.bind(agent, 'surface.limit', [
      TOOL,
      { ...TOOL, name: 'tool_2' },
      { ...TOOL, name: 'tool_3' },
      { ...TOOL, name: 'tool_4' },
      { ...TOOL, name: 'tool_5' },
    ], {
      invoke: () => Promise.resolve(''),
    })).toThrow('tool limit')

    const lease = broker.bind(agent, 'surface.one', [TOOL], {
      invoke: () => Promise.resolve('ok'),
    })
    expect(() => broker.bind(agent, 'surface.one', [], { invoke: () => Promise.resolve('') }))
      .toThrow('already has a lease')
    await expect(
      visibleTool(ctx, agent).execute({}, execution(agent)),
    ).rejects.toThrow('Invalid browser Tool arguments')
    lease.dispose()

    const disposeGlobal = ctx.tools.register(globalTool(TOOL.name))
    expect(() => broker.bind(agent, 'surface.two', [TOOL], {
      invoke: () => Promise.resolve(''),
    })).toThrow('collides')
    disposeGlobal()
  })

  it('aborts pending browser work when its lease is released', async () => {
    const { ctx, agent, broker } = await mount()
    let observed: AbortSignal | undefined
    const pending = Promise.withResolvers<string>()
    const lease = broker.bind(agent, 'surface.pending', [TOOL], {
      invoke: (_call, signal) => {
        observed = signal
        return pending.promise
      },
    })
    const result = visibleTool(ctx, agent).execute(
      { detail: 'summary' },
      execution(agent),
    )
    await Promise.resolve()

    lease.dispose()
    pending.reject(observed?.reason)
    await expect(result).rejects.toThrow('released')
    expect(observed?.aborted).toBe(true)
  })

  it('propagates caller cancellation and enforces the browser result timeout', async () => {
    vi.useFakeTimers()
    const { ctx, agent, broker } = await mount()
    const lease = broker.bind(agent, 'surface.cancel', [TOOL], {
      invoke: (_call, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }),
    })
    const parent = new AbortController()
    const cancelled = visibleTool(ctx, agent).execute(
      { detail: 'summary' },
      execution(agent, parent.signal),
    )
    parent.abort(new Error('caller stopped'))
    await expect(cancelled).rejects.toThrow('caller stopped')

    const timedOut = visibleTool(ctx, agent).execute(
      { detail: 'summary' },
      execution(agent),
    )
    const timedOutExpectation = expect(timedOut).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await timedOutExpectation
    lease.dispose()
  })

  it('supports independent owners on one Agent and releases active leases with their fiber', async () => {
    const { ctx, agent, broker } = await mount()
    const first = broker.bind(agent, 'surface.first', [TOOL], {
      invoke: () => Promise.resolve('first'),
    })
    broker.bind(agent, 'surface.second', [{ ...TOOL, name: 'surface_second' }], {
      invoke: () => Promise.resolve('second'),
    })
    first.dispose()
    expect(ctx.tools.get('surface_second', agent)).toBeDefined()
  })

  it('applies defaults and rejects non-positive direct configuration', async () => {
    for (const config of [{}, { maxTools: 1 }, { toolTimeoutMs: 1 }]) {
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new BrowserToolBroker(ctx, config)).not.toThrow()
    }
    for (const config of [
      { maxTools: 0, toolTimeoutMs: 1 },
      { maxTools: 1, toolTimeoutMs: 0 },
    ]) {
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new BrowserToolBroker(ctx, config)).toThrow('positive')
    }
  })
})

function globalTool(name: string): ToolDefinition {
  return {
    name,
    description: 'Global Tool.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: () => Promise.resolve('ok'),
  }
}
