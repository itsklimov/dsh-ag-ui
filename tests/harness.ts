import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import type { HttpAgent, Message, Tool, ToolCall } from '@ag-ui/client'
import type { BaseEvent } from '@ag-ui/core'

/** Shared plumbing for specs that drive a real host through the official client. */

export async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Port reservation returned no TCP address.')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return address.port
}

export async function waitForServer(url: string, child: ChildProcessWithoutNullStreams, stderr: string[], label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited ${String(child.exitCode)}: ${stderr.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Connection refusal means the real WebServer has not bound yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`${label} did not become ready: ${stderr.join('')}`)
}

export async function ask(
  agent: HttpAgent,
  messageId: string,
  runId: string,
  content: string,
  tools: Tool[],
): Promise<BaseEvent[]> {
  agent.addMessage({ id: messageId, role: 'user', content })
  return runAgentEvents(agent, runId, tools)
}

export async function runAgentEvents(agent: HttpAgent, runId: string, tools: Tool[]): Promise<BaseEvent[]> {
  const events: BaseEvent[] = []
  await agent.runAgent({ runId, tools, context: [], forwardedProps: {} }, {
    onEvent: ({ event }) => { events.push(event) },
  })
  return events
}

export function pendingTool(messages: Message[], name: string): ToolCall | undefined {
  const results = new Set(messages
    .filter((message): message is Extract<Message, { role: 'tool' }> => message.role === 'tool')
    .map(message => message.toolCallId))
  return messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    .find(call => call.function.name === name && !results.has(call.id))
}

export function readArgs<T>(call: ToolCall | undefined): T {
  if (call === undefined) throw new Error('The expected frontend Tool call is missing.')
  return JSON.parse(call.function.arguments) as T
}

export function lastAssistantText(messages: Message[]): string | undefined {
  return messages.findLast(message => message.role === 'assistant' && typeof message.content === 'string')?.content as string | undefined
}
