/**
 * Constructor-option resolution with environment-variable fallback: explicit
 * options win, `DSH_AG_UI_ADAPTER_*` variables fill the gaps, and a required
 * value missing from both sources fails at construction instead of at the
 * first run.
 * @module dsh-ag-ui-adapter/src/config
 */

import type { DshGatewayOptions, ResolvedGatewayOptions } from './types.ts'

/** The environment variables behind each optional constructor field. */
export const PROVIDER_ENV = 'DSH_AG_UI_ADAPTER_PROVIDER'
export const MODEL_ENV = 'DSH_AG_UI_ADAPTER_MODEL'
export const PRESET_ENV = 'DSH_AG_UI_ADAPTER_PRESET'
export const READY_TIMEOUT_ENV = 'DSH_AG_UI_ADAPTER_READY_TIMEOUT_MS'
export const IDLE_SHUTDOWN_ENV = 'DSH_AG_UI_ADAPTER_IDLE_SHUTDOWN_MS'

/** The constructor fields this module resolves; `DshAgentConfig` satisfies it. */
export interface ConfigSource {
  readonly gateway?: DshGatewayOptions | undefined
  readonly readyTimeoutMs?: number | undefined
  readonly idleShutdownMs?: number | undefined
}

/** Everything the agent needs after options and environment are merged. */
export interface ResolvedAdapterOptions {
  readonly gateway: ResolvedGatewayOptions
  readonly readyTimeoutMs: number | undefined
  readonly idleShutdownMs: number | undefined
}

interface EnvLike {
  readonly [name: string]: string | undefined
}

/** Read one variable as a positive integer; unset or empty means absent. */
function positiveIntEnv(env: EnvLike, name: string): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const value = Number.parseInt(raw, 10)
  // the round-trip comparison rejects partial parses such as "1.5" -> 1
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`dsh-ag-ui-adapter: ${name} must be a positive integer, received "${raw}".`)
  }
  return value
}

/** Merge explicit options over the environment fallback. */
export function resolveAdapterOptions(env: EnvLike, config: ConfigSource): ResolvedAdapterOptions {
  const gateway = config.gateway ?? {}
  const provider = gateway.provider ?? env[PROVIDER_ENV]
  if (provider === undefined) {
    throw new Error(`dsh-ag-ui-adapter requires a model provider: set gateway.provider or ${PROVIDER_ENV}.`)
  }
  const model = gateway.model ?? env[MODEL_ENV]
  if (model === undefined) {
    throw new Error(`dsh-ag-ui-adapter requires a model: set gateway.model or ${MODEL_ENV}.`)
  }
  const preset = gateway.preset ?? env[PRESET_ENV]
  return {
    gateway: {
      provider,
      model,
      ...(preset === undefined ? {} : { preset }),
      ...(gateway.path === undefined ? {} : { path: gateway.path }),
      ...(gateway.overrides === undefined ? {} : { overrides: gateway.overrides }),
    },
    readyTimeoutMs: config.readyTimeoutMs ?? positiveIntEnv(env, READY_TIMEOUT_ENV),
    idleShutdownMs: config.idleShutdownMs ?? positiveIntEnv(env, IDLE_SHUTDOWN_ENV),
  }
}
