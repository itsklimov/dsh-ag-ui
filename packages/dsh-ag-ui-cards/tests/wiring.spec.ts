import { describe, expect, it } from 'vitest'
import { collectToolViews, isToolViewEvent } from '../src/collect.ts'
import { TOOL_VIEW_NAME, type ToolViewEnvelope } from '../src/types.ts'
import fixture from '../fixtures/tool-view.events.json'

/** Recognizing and folding `dsh:tool:view` events from a recorded stream. */
describe('isToolViewEvent', () => {
  it('accepts the recorded gateway events', () => {
    const events: unknown[] = fixture.runs[0]
    const customs = events.filter(isToolViewEvent)
    expect(customs).toHaveLength(16)
    expect(customs[0]).toMatchObject({ type: 'CUSTOM', name: TOOL_VIEW_NAME })
  })

  it('rejects values without the envelope fields a renderer needs', () => {
    const valid = { type: 'CUSTOM', name: TOOL_VIEW_NAME, value: { version: 1, callId: 'c', toolName: 't', phase: 'call', card: { card: 'generic' } } }
    const broken = (patch: Record<string, unknown>): unknown => ({ ...valid, ...patch })
    const rejections: unknown[] = [
      null,
      'event',
      [],
      { type: 'RUN_STARTED' },
      { type: 'CUSTOM', name: 'other:name' },
      { type: 'CUSTOM', name: TOOL_VIEW_NAME, value: null },
      broken({ value: { version: 1, callId: 'c', toolName: 't', phase: 'call', card: 'generic' } }),
      broken({ value: { version: '1', callId: 'c', toolName: 't', phase: 'call', card: {} } }),
      broken({ value: { version: 1, callId: 7, toolName: 't', phase: 'call', card: {} } }),
      broken({ value: { version: 1, callId: 'c', phase: 'call', card: {} } }),
      broken({ value: { version: 1, callId: 'c', toolName: 't', phase: 'running', card: {} } }),
      broken({ value: { version: 1, callId: 'c', toolName: 't', phase: 'call', card: [] } }),
    ]
    for (const value of rejections) expect(isToolViewEvent(value)).toBe(false)
  })
})

/** Folding an event stream into the latest envelope per call. */
describe('collectToolViews', () => {
  it('keeps the latest envelope per call, in first-appearance order', () => {
    const live = collectToolViews(fixture.runs[0] as unknown[])
    expect(live.map(envelope => [envelope.callId, envelope.phase])).toEqual([
      ['cards-call-1', 'result'],
      ['cards-call-2', 'result'],
      ['cards-call-3', 'result'],
      ['cards-call-4', 'result'],
      ['cards-call-5', 'result'],
      ['cards-call-6', 'result'],
      ['cards-call-7', 'result'],
      ['cards-call-8', 'result'],
    ])
  })

  it('holds a pending call until its result replaces it', () => {
    const wrap = (envelope: ToolViewEnvelope): unknown => ({ type: 'CUSTOM', name: TOOL_VIEW_NAME, value: envelope })
    const call = (callId: string): ToolViewEnvelope => ({ version: 1, callId, toolName: 't', phase: 'call', card: { card: 'generic', title: callId } })
    const result = (callId: string): ToolViewEnvelope => ({ version: 1, callId, toolName: 't', phase: 'result', card: { card: 'generic' } })
    expect(collectToolViews([{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_END' }])).toEqual([])
    expect(collectToolViews([wrap(call('a')), wrap(call('b')), wrap(result('a'))])).toEqual([result('a'), call('b')])
  })

  it('derives the settled cards from a cold replay alone', () => {
    const cold = collectToolViews(fixture.runs[1] as unknown[])
    const live = collectToolViews(fixture.runs[0] as unknown[])
    expect(cold).toEqual(live)
    // replaying the whole transcript changes nothing
    expect(collectToolViews([...fixture.runs[0], ...fixture.runs[1]] as unknown[])).toEqual(live)
  })
})
