import { describe, expect, it } from 'vitest'
import { generateSharedSecret, overlayRows } from '../src/overlay.ts'
import type { OverlayInputs } from '../src/overlay.ts'

/** The overlay builder is pure: fixed inputs, fixed rows. */

function inputs(overrides: Partial<OverlayInputs> = {}): OverlayInputs {
  return {
    gatewayName: 'file:///gateway.js',
    webserverName: 'file:///webserver.js',
    reporterName: 'file:///reporter.js',
    readyFile: '/run/host/ready.json',
    sharedSecret: 'a'.repeat(64),
    gateway: { provider: 'scripted', model: 'scripted' },
    plugins: [],
    ...overrides,
  }
}

describe('overlayRows', () => {
  it('composes rows webserver, plugins, gateway, reporter with an ephemeral loopback bind', () => {
    const rows = overlayRows(inputs())
    expect(rows.map(row => row.id)).toEqual(['webserver', 'ag-ui', 'adapter-reporter'])
    expect(rows[0]).toEqual({ id: 'webserver', name: 'file:///webserver.js', config: { host: '127.0.0.1', port: 0 } })
  })

  it('places caller plugins between the webserver and the gateway, defaulting their ids', () => {
    const rows = overlayRows(inputs({
      plugins: [
        { id: 'agent-spine', name: 'file:///spine.js', config: { persona: 'Test persona.' } },
        { name: 'file:///model.js' },
      ],
    }))
    expect(rows.map(row => row.id)).toEqual(['webserver', 'agent-spine', 'plugin-2', 'ag-ui', 'adapter-reporter'])
    expect(rows[1]).toEqual({ id: 'agent-spine', name: 'file:///spine.js', config: { persona: 'Test persona.' } })
    expect(rows[2]).toEqual({ id: 'plugin-2', name: 'file:///model.js' })
  })

  it('builds the gateway row from the caller options, the per-process secret, and overrides', () => {
    const rows = overlayRows(inputs({
      sharedSecret: 'f'.repeat(64),
      gateway: { provider: 'openai', model: 'gpt-5.6-sol', path: '/internal/ag-ui', overrides: { maxRunEvents: 64 } },
    }))
    expect(rows[1]).toEqual({
      id: 'ag-ui',
      name: 'file:///gateway.js',
      config: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        sharedSecret: 'f'.repeat(64),
        path: '/internal/ag-ui',
        maxRunEvents: 64,
      },
    })
  })

  it('defaults the gateway path', () => {
    expect(overlayRows(inputs())[1]?.config).toMatchObject({ path: '/ag-ui' })
  })

  it('writes the readiness file path into the reporter row', () => {
    const rows = overlayRows(inputs({ readyFile: '/run/host/ready.json' }))
    expect(rows.at(-1)).toEqual({
      id: 'adapter-reporter',
      name: 'file:///reporter.js',
      config: { readyFile: '/run/host/ready.json' },
    })
  })

  it('keeps every row JSON-serializable for the generated cordis.yml', () => {
    const rows = overlayRows(inputs({
      plugins: [{ id: 'agent-spine', name: 'file:///spine.js', config: { count: 1, nested: { ok: true } } }],
    }))
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows)
  })
})

describe('generateSharedSecret', () => {
  it('produces distinct 64-character hex secrets', () => {
    const secret = generateSharedSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSharedSecret()).not.toBe(secret)
  })
})
