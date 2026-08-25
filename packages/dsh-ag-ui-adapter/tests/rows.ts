import type { HostPluginRow } from '../src/types.ts'

/** Shared overlay rows for the specs that spawn a real micro-host. */

export const SPINE_ROW: HostPluginRow = {
  id: 'agent-spine',
  name: '@deepseek-ai/dsh-agent-spine-demo',
  config: {
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: 'You are the deterministic DSH AG-UI adapter test assistant.',
  },
}

export const SCRIPTED_MODEL_ROW: HostPluginRow = {
  id: 'scripted-model',
  name: new URL('./scripted-model.mjs', import.meta.url).href,
}

export const SIGTERM_SHIELD_ROW: HostPluginRow = {
  id: 'sigterm-shield',
  name: new URL('./fixtures/sigterm-shield.mjs', import.meta.url).href,
}

/** An environment whose child Node exits immediately with a usage error. */
export const BROKEN_NODE_ENV = { NODE_OPTIONS: '--definitely-not-a-node-option' } as const
