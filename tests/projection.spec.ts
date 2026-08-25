import { describe, expect, it } from 'vitest'
import { EventType } from '@ag-ui/core'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjection, STATE_TOOL_NAME, type ToolCallLifecycle } from '../src/projection.ts'

function backendLifecycle(projection: SessionProjection, callId: string): ToolCallLifecycle & { kind: 'backend' } {
  const lifecycle = projection.lifecycleOf(callId)
  if (lifecycle?.kind !== 'backend') throw new Error(`expected a backend lifecycle for ${callId}`)
  return lifecycle
}

/** Unit tests for the pure session-event → AG-UI wire-event projection. */

const sessionId = SessionId('ag-ui-projection-test')
const messageId = 'ag-ui:ag-ui-projection-test:1:1:assistant'

function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data } as unknown as SessionEvent
}

function textMessage(text: string): SessionEvent {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'scripted', model: 'scripted' },
    }),
  })
}

function toolCall(callId: string, name: string): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId: CallId(callId), name, arguments: '{"x":1}' })
}

/** One assistant message announcing several tool calls in a single step. */
function assistantToolAnnouncement(turn: number, count: number): SessionEvent {
  return event('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: Array.from({ length: count }, (_, index) => ({
        type: 'tool-call',
        id: CallId(`announced-${String(index)}`),
        name: 'ui_action',
        arguments: '{}',
      })),
      source: { provider: 'scripted', model: 'scripted' },
    }),
  })
}

function toolResult(callId: string, isError = false): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      isError,
      content: [{ type: 'text', text: `result of ${callId}` }],
    }),
  })
}

describe('SessionProjection text', () => {
  it('opens one message across deltas and closes it at the assembled message', () => {
    const projection = new SessionProjection(sessionId)
    const first = projection.project(event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello ' },
    }), 1)
    const second = projection.project(event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'world' },
    }), 1)
    const closed = projection.project(textMessage('hello world'), 1)

    expect([...first.events, ...second.events, ...closed.events]).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'hello ' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'world' },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ])
    expect(first.outcome).toBeUndefined()
  })

  it('projects an assembled-only message as one start/content/end triple', () => {
    const projection = new SessionProjection(sessionId)
    const step = projection.project(textMessage('assembled only'), 1)
    expect(step.events).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'assembled only' },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ])
  })

  it('emits nothing for a text-less step and ignores non-text chunks', () => {
    const projection = new SessionProjection(sessionId)
    const empty = projection.project(textMessage(''), 1)
    const ignored = projection.project(event('assistant/chunk', {
      turn: 1, step: 2, chunk: { type: 'block-start', index: 0, blockType: 'text' },
    }), 1)
    expect(empty.events).toEqual([])
    expect(ignored.events).toEqual([])
  })
})

describe('SessionProjection tool calls', () => {
  it('projects a backend call start/args/end triple and its durable result', () => {
    const projection = new SessionProjection(sessionId)
    const call = projection.project(toolCall('call-1', 'backend_tool'), 1)
    expect(call.events.map(item => item.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ])
    expect(call.events[0]).toMatchObject({
      toolCallId: 'call-1',
      toolCallName: 'backend_tool',
      parentMessageId: messageId,
    })

    const result = projection.project(toolResult('call-1'), 1)
    expect(result.events).toEqual([{
      type: EventType.TOOL_CALL_RESULT,
      messageId: 'ag-ui:ag-ui-projection-test:call-1:result',
      toolCallId: 'call-1',
      content: 'result of call-1',
      role: 'tool',
    }])
    expect(projection.consumeServerResult('call-1')).toBe(true)
    expect(projection.consumeServerResult('call-1')).toBe(false)
  })

  it('records the reserved state call without wire events', () => {
    const projection = new SessionProjection(sessionId)
    const call = projection.project(toolCall('state-call', STATE_TOOL_NAME), 1)
    expect(call.events).toEqual([])
    expect(projection.lifecycleOf('state-call')).toMatchObject({ kind: 'state', turn: 1, step: 1 })
  })

  it('stays silent for a parked frontend call result but records its id', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(toolCall('frontend-call', 'ui_action'), 1)
    projection.markParked('frontend-call', backendLifecycle(projection, 'frontend-call'))
    expect(projection.project(toolResult('frontend-call'), 1).events).toEqual([])
    expect(projection.consumeServerResult('frontend-call')).toBe(true)
  })
})

describe('SessionProjection shared state', () => {
  it('commits a changed state update after its durable result', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(toolCall('state-call', STATE_TOOL_NAME), 1)
    projection.sharedState = { count: 1 }
    projection.stageCommit('state-call', { value: { count: 2 }, changed: true })
    const step = projection.project(toolResult('state-call'), 1)
    expect(step.events).toEqual([{ type: EventType.STATE_SNAPSHOT, snapshot: { count: 2 } }])
    expect(projection.sharedState).toEqual({ count: 2 })
  })

  it('ignores commits staged for missing or non-state calls', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(toolCall('backend-call', 'backend_tool'), 1)
    projection.stageCommit('backend-call', { value: { count: 9 }, changed: true })
    projection.stageCommit('missing-call', { value: { count: 9 }, changed: true })
    expect(projection.lifecycleOf('backend-call')).toMatchObject({ kind: 'backend' })
    expect(projection.project(toolResult('backend-call'), 1).events).toEqual([
      expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: 'backend-call' }),
    ])
  })

  it('skips unchanged and failed state results', () => {    const projection = new SessionProjection(sessionId)
    projection.sharedState = { count: 1 }
    projection.project(toolCall('state-unchanged', STATE_TOOL_NAME), 1)
    projection.stageCommit('state-unchanged', { value: { count: 1 }, changed: false })
    expect(projection.project(toolResult('state-unchanged'), 1).events).toEqual([])

    projection.project(toolCall('state-failed', STATE_TOOL_NAME), 1)
    projection.stageCommit('state-failed', { value: { count: 3 }, changed: true })
    expect(projection.project(toolResult('state-failed', true), 1).events).toEqual([])
    expect(projection.sharedState).toEqual({ count: 1 })
  })
})

describe('SessionProjection history snapshot', () => {
  it('derives the full history, skipping injected context, unmapped ids, and empty text', () => {
    const projection = new SessionProjection(sessionId)
    const events = [
      event('user/message', {
        id: 'sys-1',
        source: { kind: 'system' },
        content: [{ type: 'text', text: 'injected context' }],
      }),
      event('user/message', {
        id: 'user-1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      }),
      event('user/message', {
        id: 'user-unknown',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'from a cold session' }],
      }),
      textMessage(''),
      textMessage('hello back'),
      toolResult('call-1'),
    ]
    expect(projection.messagesSnapshot(events, id => (id === 'user-1' ? 'client-user-1' : undefined))).toEqual([
      { id: 'client-user-1', role: 'user', content: 'hello' },
      { id: messageId, role: 'assistant', content: 'hello back' },
      { id: 'ag-ui:ag-ui-projection-test:call-1:result', role: 'tool', toolCallId: 'call-1', content: 'result of call-1' },
    ])
  })
})

/** Scheduling view where every announced tool would still start while parked. */
const parallel = (): boolean => true

describe('SessionProjection run outcomes', () => {
  it('maps every turn-end reason to its AG-UI run outcome', () => {
    const cases = [
      [{ kind: 'completed' }, { kind: 'success' }],
      [{ kind: 'max-tokens' }, { kind: 'success' }],
      [{ kind: 'error', error: { code: 'MODEL_FAILED', message: 'model failed' } },
        { kind: 'error', code: 'MODEL_FAILED', message: 'model failed' }],
      [{ kind: 'aborted' }, { kind: 'error', code: 'AGENT_ABORTED', message: 'The DSH turn was aborted.' }],
      [{ kind: 'blocked' }, { kind: 'error', code: 'AGENT_BLOCKED', message: 'The DSH turn was blocked before completion.' }],
      [{ kind: 'interrupted' }, { kind: 'error', code: 'AGENT_INTERRUPTED', message: 'The stored DSH turn was interrupted.' }],
      [{ kind: 'extension-reason' }, { kind: 'error', code: 'AGENT_EXECUTION_ERROR', message: 'The DSH turn ended with an unsupported reason.' }],
    ] as const
    for (const [reason, outcome] of cases) {
      const projection = new SessionProjection(sessionId)
      expect(projection.project(event('turn/end', { turn: 1, reason }), 1).outcome).toEqual(outcome)
    }
  })

  it('ignores events outside the active turn and releases step slots at step end', () => {
    const projection = new SessionProjection(sessionId)
    const nextTurnCall = event('tool/call', {
      turn: 2, step: 1, callId: CallId('other-turn'), name: 'backend_tool', arguments: '{}',
    })
    expect(projection.project(nextTurnCall, 1).events).toEqual([])
    expect(projection.project(nextTurnCall, undefined).events).toEqual([])
    expect(projection.lifecycleOf('other-turn')).toBeUndefined()
  })

  it('settles a park immediately when the step announced no further calls', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(toolCall('park-1', 'ui_action'), 1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    projection.markParked('park-1', backendLifecycle(projection, 'park-1'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)
  })

  it('holds the park settle until every announced call streamed', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(assistantToolAnnouncement(1, 2), 1)

    projection.project(toolCall('park-1', 'ui_action'), 1)
    projection.markParked('park-1', backendLifecycle(projection, 'park-1'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    // an exclusive follow-up call would never start behind the parked call
    expect(projection.parkSettleReady(1, 1, () => false)).toBe(true)

    projection.project(toolCall('server-1', 'backend_tool'), 1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)

    projection.markAwaitingResult('park-1')
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    projection.project(toolResult('server-1'), 1)
    projection.project(event('step/end', { turn: 1, step: 1 }), 1)
  })

  it('ignores awaiting marks on calls that never parked', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(toolCall('server-2', 'backend_tool'), 1)
    projection.markAwaitingResult('server-2')
    projection.markAwaitingResult('missing-call')
    expect(projection.lifecycleOf('server-2')).toMatchObject({ kind: 'backend', turn: 1 })
  })

  it('settles once every announced call streamed or parked', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(assistantToolAnnouncement(1, 2), 1)
    projection.project(toolCall('park-1', 'ui_action'), 1)
    projection.markParked('park-1', backendLifecycle(projection, 'park-1'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    projection.project(toolCall('park-2', 'ui_action'), 1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)
    projection.markParked('park-2', backendLifecycle(projection, 'park-2'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)
  })

  it('clears step progress for one finished turn only', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(assistantToolAnnouncement(1, 1), 1)
    projection.project(toolCall('turn-1-park', 'ui_action'), 1)
    projection.markParked('turn-1-park', backendLifecycle(projection, 'turn-1-park'))
    projection.project(assistantToolAnnouncement(2, 1), 2)
    projection.project(event('tool/call', {
      turn: 2, step: 1, callId: CallId('turn-2-park'), name: 'ui_action', arguments: '{}',
    }), 2)
    projection.markParked('turn-2-park', backendLifecycle(projection, 'turn-2-park'))
    projection.clearTurn(1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    expect(projection.parkSettleReady(2, 1, parallel)).toBe(true)
  })

  it('clears call lifecycles only for the finished turn', () => {
    const projection = new SessionProjection(sessionId)
    projection.project(toolCall('turn-1-call', 'backend_tool'), 1)
    projection.project(event('tool/call', {
      turn: 2, step: 1, callId: CallId('turn-2-call'), name: 'backend_tool', arguments: '{}',
    }), 2)
    projection.clearTurn(1)
    expect(projection.lifecycleOf('turn-1-call')).toBeUndefined()
    expect(projection.lifecycleOf('turn-2-call')).toMatchObject({ kind: 'backend', turn: 2 })
  })
})
