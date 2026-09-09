import { A2UIMiddleware } from '@ag-ui/a2ui-middleware'
import {
  EventType,
  RunAgentInputSchema,
  type HttpAgentFetchFn,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client'
import { describe, expect, it } from 'vitest'
import { DshHttpAgent, prepareDshRunInput } from '../src/client.ts'

const user = (id: string, content: string): Message => ({ id, role: 'user', content })
const assistant = (id: string, content: string): Message => ({ id, role: 'assistant', content })
const tool = (id: string, toolCallId: string, content = '{}'): Message => ({
  id,
  role: 'tool',
  toolCallId,
  content,
})

function input(messages: Message[], forwardedProps: RunAgentInput['forwardedProps'] = {}): RunAgentInput {
  return {
    threadId: 'client-thread',
    runId: 'client-run',
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps,
  }
}

describe('prepareDshRunInput', () => {
  it('keeps new users and frontend Tool results after the last assistant', () => {
    const messages = [
      user('old-user', 'old'),
      assistant('old-assistant', 'done'),
      user('new-user-1', 'one'),
      user('new-user-2', 'two'),
    ]
    const original = input(messages)

    expect(prepareDshRunInput(original).messages).toEqual(messages.slice(2))
    expect(original.messages).toEqual(messages)

    const continuation = [
      ...messages.slice(0, 2),
      {
        id: 'pending-assistant',
        role: 'assistant' as const,
        content: '',
        toolCalls: [{
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'browser_tool', arguments: '{}' },
        }],
      },
      tool('result-1', 'call-1'),
      tool('result-2', 'call-2'),
    ]
    expect(prepareDshRunInput(input(continuation)).messages).toEqual(continuation.slice(-2))
  })

  it('keeps every admissible message when no assistant boundary exists', () => {
    const ignored: Message = {
      id: 'activity-1',
      role: 'activity',
      activityType: 'status',
      content: { status: 'working' },
    }
    const messages = [ignored, user('user-1', 'one'), tool('tool-1', 'call-1')]

    expect(prepareDshRunInput(input(messages)).messages).toEqual(messages.slice(1))
    expect(prepareDshRunInput(input([])).messages).toEqual([])
  })

  it('preserves the exact final A2UI pair and any preceding frontend result', () => {
    const action = {
      a2uiAction: {
        userAction: { name: 'approve', surfaceId: 'review', context: { version: 2 } },
      },
    }
    const pair: Message[] = [
      {
        id: 'action-assistant',
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'action-call',
          type: 'function',
          function: { name: 'log_a2ui_event', arguments: JSON.stringify(action.a2uiAction.userAction) },
        }],
      },
      tool('action-result', 'action-call', 'User performed action'),
    ]
    const pending = tool('pending-result', 'pending-call')
    const messages = [
      user('old-user', 'old'),
      assistant('old-assistant', 'done'),
      {
        id: 'pending-assistant',
        role: 'assistant' as const,
        content: '',
        toolCalls: [{
          id: 'pending-call',
          type: 'function' as const,
          function: { name: 'render_a2ui', arguments: '{}' },
        }],
      },
      pending,
      ...pair,
    ]

    expect(prepareDshRunInput(input(messages, action)).messages).toEqual([pending, ...pair])
  })

  it('passes malformed action tails through for gateway validation', () => {
    const onlyMessage = user('malformed', 'not a synthetic pair')

    expect(prepareDshRunInput(input([onlyMessage], { a2uiAction: null })).messages).toEqual([onlyMessage])
    expect(prepareDshRunInput(input([onlyMessage], null)).messages).toEqual([onlyMessage])
  })
})

describe('DshHttpAgent', () => {
  it('applies the selector after official middleware and survives cloning', async () => {
    const requests: RunAgentInput[] = []
    const upstreamFetch: HttpAgentFetchFn = async (_url, init) => {
      const request = RunAgentInputSchema.parse(JSON.parse(String(init.body)))
      requests.push(request)
      return new Response([
        { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId },
        { type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const fullHistory = [
      user('large-old-user', 'x'.repeat(300_000)),
      assistant('settled-assistant', 'settled'),
    ]
    const agent = new DshHttpAgent({
      url: 'http://gateway.internal/ag-ui',
      fetch: upstreamFetch,
      threadId: 'client-thread',
      initialMessages: fullHistory,
    }).use(new A2UIMiddleware({ injectA2UITool: true })).clone()

    await agent.runAgent({
      runId: 'client-run',
      forwardedProps: {
        a2uiAction: {
          userAction: { name: 'approve', surfaceId: 'review', context: { version: 2 } },
        },
      },
    })

    expect(agent).toBeInstanceOf(DshHttpAgent)
    expect(agent.messages).toEqual(fullHistory)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toHaveLength(2)
    expect(requests[0]?.messages[0]).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ function: { name: 'log_a2ui_event' } }],
    })
    expect(requests[0]?.messages[1]).toMatchObject({ role: 'tool' })
    expect(requests[0]?.tools.map(item => item.name)).toEqual(['render_a2ui'])
  })
})
