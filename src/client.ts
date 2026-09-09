/**
 * AG-UI client companion for the stateful dsh-ag-ui gateway.
 * @module dsh-ag-ui/client
 */

import { HttpAgent } from '@ag-ui/client'
import type { Message, RunAgentInput } from '@ag-ui/client'

function admittedRole(message: Message): boolean {
  return message.role === 'user' || message.role === 'tool'
}

/**
 * Keep only messages that can admit work at the stateful gateway. The client
 * retains its complete history; only this run's wire input is narrowed.
 */
export function prepareDshRunInput(input: RunAgentInput): RunAgentInput {
  const lastAssistant = input.messages.findLastIndex(message => message.role === 'assistant')
  return { ...input, messages: input.messages.slice(lastAssistant + 1).filter(admittedRole) }
}

/** `HttpAgent` whose wire input matches dsh-ag-ui's stateful admission contract. */
export class DshHttpAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    return super.requestInit(prepareDshRunInput(input))
  }
}
