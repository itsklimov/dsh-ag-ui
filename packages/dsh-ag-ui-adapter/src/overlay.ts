/**
 * The generated micro-host overlay: the same `cordis.yml` row format the
 * documented Cordis-Loader overlay mechanism reads, composed as plain
 * JSON-serializable rows (JSON is valid YAML) so the adapter needs no YAML
 * emitter. Rows are listed webserver, caller plugins, gateway, readiness
 * reporter; the loader starts them concurrently and cordis service injects
 * gate the actual activation order.
 * @module dsh-ag-ui-adapter/src/overlay
 */

import { randomBytes } from 'node:crypto'
import type { HostPluginRow, ResolvedGatewayOptions } from './types.ts'

/** One serialized loader entry of the generated `cordis.yml`. */
export interface OverlayRow {
  readonly id: string
  readonly name: string
  readonly config?: Readonly<Record<string, unknown>>
}

/** Everything the overlay builder needs besides the caller's own rows. */
export interface OverlayInputs {
  /** Resolved entry of the published `dsh-ag-ui` gateway package. */
  readonly gatewayName: string
  /** Resolved entry of the `@deepseek-ai/dsh-host-webserver` package. */
  readonly webserverName: string
  /** Resolved child-side readiness reporter module. */
  readonly reporterName: string
  /** Path of the readiness file the reporter writes inside the host cwd. */
  readonly readyFile: string
  /** Per-process bearer secret the adapter sends to its own gateway. */
  readonly sharedSecret: string
  /** The caller's gateway row options, after the environment fallback. */
  readonly gateway: ResolvedGatewayOptions
  /** The caller's plugin rows, already resolved to `file:` URLs. */
  readonly plugins: readonly (Omit<HostPluginRow, 'name'> & { readonly name: string })[]
}

/** Generate the per-process gateway bearer secret (64 hex characters). */
export function generateSharedSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The gateway route the overlay registers when the caller does not choose one.
 * The parent builds its run URL from the same constant, so both stay in sync.
 */
export const DEFAULT_GATEWAY_PATH = '/ag-ui'

/** Compose the full micro-host overlay in load order. */
export function overlayRows(inputs: OverlayInputs): OverlayRow[] {
  const gatewayConfig: Record<string, unknown> = {
    provider: inputs.gateway.provider,
    model: inputs.gateway.model,
    sharedSecret: inputs.sharedSecret,
    path: inputs.gateway.path ?? DEFAULT_GATEWAY_PATH,
    ...(inputs.gateway.preset === undefined ? {} : { agentPreset: inputs.gateway.preset }),
    ...inputs.gateway.overrides,
  }
  return [
    { id: 'webserver', name: inputs.webserverName, config: { host: '127.0.0.1', port: 0 } },
    ...inputs.plugins.map((plugin, index) => ({
      id: plugin.id ?? `plugin-${String(index + 1)}`,
      name: plugin.name,
      ...(plugin.config === undefined ? {} : { config: plugin.config }),
    })),
    { id: 'ag-ui', name: inputs.gatewayName, config: gatewayConfig },
    { id: 'adapter-reporter', name: inputs.reporterName, config: { readyFile: inputs.readyFile } },
  ]
}
