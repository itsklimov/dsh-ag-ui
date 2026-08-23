import { createHash } from 'node:crypto'
import { AgUiGatewayError } from './errors.ts'

/**
 * Measure one string as UTF-8.
 * @param value - string to measure.
 * @returns encoded byte length.
 */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Hash exact accepted request bytes for run idempotency.
 * @param body - complete bounded HTTP body.
 * @returns lowercase SHA-256 hex digest.
 */
export function requestDigest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * Measure one JSON value and reject non-serializable input.
 * @param value - parsed boundary value.
 * @param field - field name used in the public diagnostic.
 * @returns UTF-8 byte length of its JSON representation.
 */
export function jsonBytes(value: unknown, field: string): number {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new AgUiGatewayError('INVALID_AGUI_INPUT', `${field} must be JSON-serializable.`, 400, error)
  }
  return utf8Bytes(encoded)
}

/**
 * Measure object/array nesting and reject cyclic input.
 * @param value - parsed boundary value.
 * @returns maximum container depth, with a scalar root at zero.
 */
export function jsonDepth(value: unknown): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let maximum = 0
  while (stack.length > 0) {
    const current = stack.pop()
    /* v8 ignore next -- the non-empty loop guard proves pop returns one frame. */
    if (current === undefined) break
    maximum = Math.max(maximum, current.depth)
    if (current.value === null || typeof current.value !== 'object') continue
    if (seen.has(current.value)) {
      throw new AgUiGatewayError('INVALID_AGUI_INPUT', 'AG-UI input must not contain cyclic values.')
    }
    seen.add(current.value)
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 })
  }
  return maximum
}

/**
 * Digest one accepted AG-UI message value.
 * @param value - parsed lossless JSON message.
 * @returns lowercase SHA-256 hex digest of its JSON representation.
 */
export function valueDigest(value: unknown): string {
  const encoded = JSON.stringify(value)
  return createHash('sha256').update(encoded).digest('hex')
}
