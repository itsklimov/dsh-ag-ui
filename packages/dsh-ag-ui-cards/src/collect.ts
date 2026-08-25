/**
 * Wiring helpers: recognizing `dsh:tool:view` CUSTOM events and folding an
 * event stream into the latest envelope per tool call.
 * @module dsh-ag-ui-cards/src/collect
 */

import { TOOL_VIEW_NAME, type ToolViewEnvelope, type ToolViewEvent } from './types.ts'

/** Whether a value is a plain object (not an array or `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one decoded AG-UI event carries a `dsh:tool:view` envelope. The
 * check is structural and permissive: it confirms the envelope fields a
 * renderer needs, so a future card kind renders through the generic fallback
 * instead of being dropped.
 */
export function isToolViewEvent(event: unknown): event is ToolViewEvent {
  if (!isRecord(event)) return false
  if (event['type'] !== 'CUSTOM' || event['name'] !== TOOL_VIEW_NAME) return false
  const value = event['value']
  if (!isRecord(value)) return false
  return typeof value['version'] === 'number'
    && typeof value['callId'] === 'string'
    && typeof value['toolName'] === 'string'
    && (value['phase'] === 'call' || value['phase'] === 'result')
    && isRecord(value['card'])
}

/**
 * Fold a decoded AG-UI event stream into the latest envelope per tool call,
 * in first-appearance order: a pending call holds its slot until its result
 * replaces it, and a result that arrives alone (a cold replay) stands on its
 * own. Non-`dsh:tool:view` events pass through without effect.
 * @param events - decoded AG-UI events in arrival order.
 * @returns the latest card envelope of every seen tool call.
 */
export function collectToolViews(events: readonly unknown[]): ToolViewEnvelope[] {
  const latest = new Map<string, ToolViewEnvelope>()
  for (const event of events) {
    if (isToolViewEvent(event)) latest.set(event.value.callId, event.value)
  }
  return [...latest.values()]
}
