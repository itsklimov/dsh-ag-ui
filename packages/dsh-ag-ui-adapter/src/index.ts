/**
 * dsh-ag-ui-adapter — embed DeepSeek Harness as an AG-UI agent by spawning a
 * loopback micro-host through the published dsh-ag-ui gateway.
 * @module dsh-ag-ui-adapter
 */

export { DshAgent } from './agent.ts'
export type { DshAgentConfig } from './agent.ts'
export type { DshGatewayOptions, HostPluginRow } from './types.ts'
