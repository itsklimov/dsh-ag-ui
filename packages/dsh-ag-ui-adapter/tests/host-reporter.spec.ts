import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/host-reporter.ts'

describe('host reporter', () => {
  it('writes the bound address atomically once the host services are active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ag-ui-adapter-reporter-'))
    const readyFile = join(directory, 'ready.json')
    try {
      await apply({ webServer: { host: '127.0.0.1', port: 41234 } }, { readyFile })
      expect(JSON.parse(await readFile(readyFile, 'utf8'))).toEqual({ host: '127.0.0.1', port: 41234 })
      await expect(access(`${readyFile}.staging`)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('replaces an existing readiness file with the newest address', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ag-ui-adapter-reporter-'))
    const readyFile = join(directory, 'ready.json')
    try {
      await apply({ webServer: { host: '127.0.0.1', port: 41_000 } }, { readyFile })
      await apply({ webServer: { host: '127.0.0.1', port: 42_000 } }, { readyFile })
      expect(JSON.parse(await readFile(readyFile, 'utf8'))).toEqual({ host: '127.0.0.1', port: 42_000 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
