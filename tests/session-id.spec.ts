import { describe, expect, it } from 'vitest'
import { durableSessionId } from '../src/session-id.ts'

describe('durable session id derivation', () => {
  const principal = { tenantId: 'hospital-demo', userId: 'clinician-1' }

  it('derives the same id for the same tuple and key', () => {
    expect(durableSessionId(principal, 'encounter-e001', 'secret-value-0123456789'))
      .toBe(durableSessionId(principal, 'encounter-e001', 'secret-value-0123456789'))
  })

  it('differs across tenants, users, threads, and keys', () => {
    const base = durableSessionId(principal, 'encounter-e001', 'secret-value-0123456789')
    expect(durableSessionId({ tenantId: 'other', userId: 'clinician-1' }, 'encounter-e001', 'secret-value-0123456789')).not.toBe(base)
    expect(durableSessionId({ tenantId: 'hospital-demo', userId: 'other' }, 'encounter-e001', 'secret-value-0123456789')).not.toBe(base)
    expect(durableSessionId(principal, 'encounter-e002', 'secret-value-0123456789')).not.toBe(base)
    expect(durableSessionId(principal, 'encounter-e001', 'rotated-secret-0123456')).not.toBe(base)
  })

  it('never embeds the raw identity strings and keeps a namespaced shape', () => {
    const id = String(durableSessionId(principal, 'encounter-e001', 'secret-value-0123456789'))
    expect(id).toMatch(/^ag-ui-[0-9a-f]{40}$/)
    expect(id).not.toContain('hospital-demo')
    expect(id).not.toContain('clinician-1')
    expect(id).not.toContain('encounter-e001')
  })
})
