import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from '@ag-ui/client'
import { DshAgent } from '../src/agent.ts'
import { SCRIPTED_MODEL_ROW, SPINE_ROW } from './rows.ts'

/**
 * The keyless scripted agentic-chat scenario, end to end through the adapter:
 * a spawned micro-host, the official client pipeline, and session memory
 * across runs inside the child.
 */

const agents: DshAgent[] = []

afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.stop()))
})

function scriptedAgent(): DshAgent {
  const agent = new DshAgent({
    threadId: 'adapter-thread',
    gateway: { provider: 'scripted', model: 'scripted' },
    plugins: [SPINE_ROW, SCRIPTED_MODEL_ROW],
  })
  agents.push(agent)
  return agent
}

function ask(agent: DshAgent, content: string): Promise<void> {
  agent.addMessage({ id: randomUUID(), role: 'user', content })
  return agent.runAgent({ runId: randomUUID(), tools: [], context: [], forwardedProps: {} }).then(() => {})
}

function assistantText(agent: DshAgent): string | undefined {
  return agent.messages.findLast(message => message.role === 'assistant' && typeof message.content === 'string')?.content as string | undefined
}

describe('DshAgent', () => {
  it('streams a keyless scripted agentic chat with session memory through the spawned micro-host', async () => {
    const agent = scriptedAgent()
    await agent.start()

    expect(agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ag-ui$/)
    // starting again is a no-op on the same host
    await agent.start()
    expect(agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ag-ui$/)

    await ask(agent, 'My name is Ada.')
    expect(assistantText(agent)).toBe('Hello Ada.')

    // a second run answers from the durable session inside the same child
    await ask(agent, 'What is my name?')
    expect(assistantText(agent)).toBe('Your name is Ada.')

    // an aborted run leaves the agent usable for the next one, with a caller-owned abort signal
    agent.abortRun()
    agent.addMessage({ id: randomUUID(), role: 'user', content: 'Hello again.' })
    await agent.runAgent({
      runId: randomUUID(),
      tools: [],
      context: [],
      forwardedProps: {},
      abortController: new AbortController(),
    })
    expect(assistantText(agent)).toBe('Hello from the DSH AG-UI adapter.')

    await agent.stop()
  })

  it('refuses to run or expose a URL before the micro-host has started', async () => {
    // a bare config exercises the optional constructor fields at their defaults
    const agent = new DshAgent({ threadId: 'adapter-thread', gateway: { provider: 'scripted', model: 'scripted' } })
    agents.push(agent)
    expect(() => agent.url).toThrow('has not started')
    await expect(ask(agent, 'hello')).rejects.toThrow('has not started')
    await expect(agent.runAgent()).rejects.toThrow('has not started')
  })

  it('cleans up after a failed start and stops cleanly', async () => {
    const agent = new DshAgent({
      threadId: 'adapter-thread',
      // without an agent spine the gateway never activates, so readiness times out
      gateway: { provider: 'scripted', model: 'scripted' },
      plugins: [SCRIPTED_MODEL_ROW],
      readyTimeoutMs: 500,
      env: { DSH_AG_UI_ADAPTER_PROBE: 'fixture' },
    })
    agents.push(agent)
    await expect(agent.start()).rejects.toThrow('did not become ready in time')
    await expect(agent.stop()).resolves.toBeUndefined()
    expect(() => agent.url).toThrow('has not started')
  })
})
