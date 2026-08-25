import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MicroHost } from '../src/host.ts'
import type { MicroHostOptions } from '../src/host.ts'
import { BROKEN_NODE_ENV, SCRIPTED_MODEL_ROW, SIGTERM_SHIELD_ROW, SPINE_ROW } from './rows.ts'

/** The process manager against a real spawned micro-host. */

const SCRIPTED: MicroHostOptions = {
  gateway: { provider: 'scripted', model: 'scripted' },
  plugins: [SPINE_ROW, SCRIPTED_MODEL_ROW],
}

const live: MicroHost[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map(host => host.stop()))
})

describe('MicroHost', () => {
  it('binds an ephemeral loopback port and serves the gateway there until stop', async () => {
    const host = await MicroHost.start(SCRIPTED)
    live.push(host)
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ag-ui$/)
    expect(host.address).not.toBe('127.0.0.1:0')

    // an unauthenticated POST at that exact address proves the real gateway is bound
    const denied = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(denied.status).toBe(401)

    await host.stop()
    await expect(fetch(host.url, { method: 'POST' })).rejects.toThrow()
    await expect(access(join(host.directory, 'cordis.yml'))).rejects.toThrow()
    await host.stop()
  })

  it('reports a child that dies before readiness', async () => {
    await expect(MicroHost.start({ ...SCRIPTED, env: BROKEN_NODE_ENV }))
      .rejects.toThrow('exited before becoming ready')
  })

  it('times out when the composed host can never activate, and kills the child', async () => {
    // without an agent spine (or any plugin row) the gateway waits for the agents service forever
    await expect(MicroHost.start({
      gateway: { provider: 'scripted', model: 'scripted' },
      readyTimeoutMs: 500,
    })).rejects.toThrow('did not become ready in time')
  })

  it('escalates to SIGKILL when the child ignores a graceful stop', async () => {
    const host = await MicroHost.start({
      ...SCRIPTED,
      plugins: [...(SCRIPTED.plugins ?? []), SIGTERM_SHIELD_ROW],
    })
    await host.stop()
    // the shielded child only dies by SIGKILL, and its directory is still removed
    await expect(access(join(host.directory, 'ready.json'))).rejects.toThrow()
  })
})
