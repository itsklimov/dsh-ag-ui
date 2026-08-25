import { describe, expect, it } from 'vitest'
import { resolveAdapterOptions } from '../src/config.ts'
import { IDLE_SHUTDOWN_ENV, MODEL_ENV, PRESET_ENV, PROVIDER_ENV, READY_TIMEOUT_ENV } from '../src/config.ts'

/** Option resolution is pure: fixed options over a fixed environment. */

const ENV = {
  [PROVIDER_ENV]: 'env-provider',
  [MODEL_ENV]: 'env-model',
  [PRESET_ENV]: 'env-preset',
  [READY_TIMEOUT_ENV]: '11111',
  [IDLE_SHUTDOWN_ENV]: '22222',
} as const

describe('resolveAdapterOptions', () => {
  it('lets explicit options win over the environment', () => {
    const resolved = resolveAdapterOptions(ENV, {
      gateway: {
        provider: 'opt-provider',
        model: 'opt-model',
        preset: 'opt-preset',
        path: '/internal',
        overrides: { maxRunEvents: 64 },
      },
      readyTimeoutMs: 1000,
      idleShutdownMs: 2000,
    })
    expect(resolved.gateway).toMatchObject({
      provider: 'opt-provider',
      model: 'opt-model',
      preset: 'opt-preset',
      path: '/internal',
      overrides: { maxRunEvents: 64 },
    })
    expect(resolved.readyTimeoutMs).toBe(1000)
    expect(resolved.idleShutdownMs).toBe(2000)
  })

  it('falls back to the environment for every field', () => {
    const resolved = resolveAdapterOptions(ENV, {})
    expect(resolved.gateway).toEqual({ provider: 'env-provider', model: 'env-model', preset: 'env-preset' })
    expect(resolved.readyTimeoutMs).toBe(11111)
    expect(resolved.idleShutdownMs).toBe(22222)
  })

  it('requires a provider and a model from one of the two sources', () => {
    expect(() => resolveAdapterOptions({}, {})).toThrow(PROVIDER_ENV)
    expect(() => resolveAdapterOptions({ [PROVIDER_ENV]: 'env-provider' }, {})).toThrow(MODEL_ENV)
  })

  it('rejects malformed timeout variables by name', () => {
    for (const name of [READY_TIMEOUT_ENV, IDLE_SHUTDOWN_ENV]) {
      for (const raw of ['abc', '0', '-5', '1.5']) {
        expect(() => resolveAdapterOptions({ ...ENV, [name]: raw }, {})).toThrow(name)
      }
    }
  })

  it('treats an empty environment string as unset', () => {
    const resolved = resolveAdapterOptions({ ...ENV, [IDLE_SHUTDOWN_ENV]: '' }, {})
    expect(resolved.idleShutdownMs).toBeUndefined()
  })
})
