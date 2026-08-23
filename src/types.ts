import type { Agent } from '@deepseek-ai/dsh-agent'

/** Authenticated BFF identity that owns an AG-UI thread. */
export interface AgUiPrincipal {
  readonly tenantId: string
  readonly userId: string
}

/** Process-local AG-UI identity associated with one Gateway-owned Agent. */
export interface AgUiThreadIdentity {
  readonly principal: AgUiPrincipal
  readonly threadId: string
}

/** Read-only Gateway lookup used by authenticated backend Tools. */
export interface AgUiAgentLookup {
  /**
   * Resolve an exact live Gateway-owned Agent.
   * @param agent - candidate live Agent.
   * @returns its authenticated thread identity, or undefined when another subsystem owns it.
   */
  identityFor(agent: Agent): AgUiThreadIdentity | undefined
}
