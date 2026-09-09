/**
 * AG-UI client companion for the stateful dsh-ag-ui gateway.
 * @module dsh-ag-ui/client
 */

import { HttpAgent } from '@ag-ui/client'
import type { Message, RunAgentInput } from '@ag-ui/client'

function ownsA2UIAction(forwardedProps: RunAgentInput['forwardedProps']): boolean {
  return typeof forwardedProps === 'object'
    && forwardedProps !== null
    && Object.hasOwn(forwardedProps, 'a2uiAction')
}

function admittedRole(message: Message): boolean {
  return message.role === 'user' || message.role === 'tool'
}

/**
 * Keep only messages that can admit work at the stateful gateway. The client
 * retains its complete history; only this run's wire input is narrowed.
 *
 * A2UI middleware appends an assistant/Tool pair after the normal history.
 * The gateway validates that pair at the final two positions, so it is split
 * off before locating the preceding assistant boundary and restored unchanged.
 */
export function prepareDshRunInput(input: RunAgentInput): RunAgentInput {
  const pairStart = ownsA2UIAction(input.forwardedProps)
    ? Math.max(0, input.messages.length - 2)
    : input.messages.length
  const history = input.messages.slice(0, pairStart)
  const lastAssistant = history.findLastIndex(message => message.role === 'assistant')
  const messages = [
    ...history.slice(lastAssistant + 1).filter(admittedRole),
    ...input.messages.slice(pairStart),
  ]
  return { ...input, messages }
}

/** `HttpAgent` whose wire input matches dsh-ag-ui's stateful admission contract. */
export class DshHttpAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    return super.requestInit(prepareDshRunInput(input))
  }
}
