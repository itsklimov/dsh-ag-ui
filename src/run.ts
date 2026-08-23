import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { EventEncoder } from '@ag-ui/encoder'
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core'
import { AgUiGatewayError } from './errors.ts'
import { utf8Bytes } from './json.ts'

/** Bounded event history retained for one idempotent run. */
export interface RunRecord {
  readonly digest: string
  readonly events: BaseEvent[]
  state: 'active' | 'completed'
  bytes: number
}

/** Single-consumer async queue accepting synchronous Session projections. */
class EventQueue implements AsyncIterable<BaseEvent> {
  private readonly values: BaseEvent[] = []
  private waiter: PromiseWithResolvers<void> | undefined
  private closed = false

  push(value: BaseEvent): void {
    /* v8 ignore next -- RunController never appends after its terminal close. */
    if (this.closed) return
    this.values.push(value)
    this.waiter?.resolve()
    this.waiter = undefined
  }

  close(): void {
    /* v8 ignore next -- one RunController owns one terminal queue close. */
    if (this.closed) return
    this.closed = true
    this.waiter?.resolve()
    this.waiter = undefined
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BaseEvent> {
    while (!this.closed || this.values.length > 0) {
      const value = this.values.shift()
      if (value !== undefined) {
        yield value
        continue
      }
      this.waiter ??= Promise.withResolvers<void>()
      await this.waiter.promise
    }
  }
}

/** One AG-UI HTTP run, independent from the DSH turn it observes. */
export class RunController {
  private readonly queue = new EventQueue()
  private readonly settled = Promise.withResolvers<void>()
  private terminal = false

  /** DSH turn projected into this HTTP run. */
  turn: number | undefined
  /** DSH inbox message whose claim assigns a normal run's turn. */
  messageId: string | undefined

  constructor(
    readonly generation: number,
    readonly input: RunAgentInput,
    readonly record: RunRecord,
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {}

  /** Resolution after a terminal event has been recorded. */
  get done(): Promise<void> {
    return this.settled.promise
  }

  /** Append the run's required opening event before DSH is driven. */
  start(): void {
    this.append({
      type: EventType.RUN_STARTED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      ...this.input.parentRunId === undefined ? {} : { parentRunId: this.input.parentRunId },
    })
  }

  /**
   * Append one non-terminal event within the retained bounds.
   * @param event - owned AG-UI event projection.
   */
  emit(event: BaseEvent): void {
    if (this.terminal) return
    const bytes = utf8Bytes(JSON.stringify(event))
    if (this.record.events.length + 1 >= this.maxEvents || this.record.bytes + bytes > this.maxBytes) {
      this.error('AG_UI_EVENT_BUFFER_OVERFLOW', 'The AG-UI run exceeded its event buffer.')
      return
    }
    this.append(event, bytes)
  }

  /** Finish the run with a successful AG-UI outcome. */
  success(): void {
    this.finish({
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      outcome: { type: 'success' },
    })
  }

  /**
   * Finish the run with one public AG-UI error.
   * @param code - stable failure category.
   * @param message - client-safe diagnostic.
   */
  error(code: string, message: string): void {
    this.finish({ type: EventType.RUN_ERROR, code, message })
  }

  /**
   * Stream queued events and close after the terminal event.
   * @param response - Node response owning this SSE transport.
   */
  async writeTo(response: ServerResponse): Promise<void> {
    const encoder = new EventEncoder({ accept: 'text/event-stream' })
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': encoder.getContentType(),
      'x-accel-buffering': 'no',
    })
    response.flushHeaders()
    for await (const event of this.queue) {
      if (response.destroyed || response.writableEnded) break
      if (!response.write(encoder.encodeSSE(event))) {
        await Promise.race([once(response, 'drain'), once(response, 'close')])
      }
    }
    if (!response.destroyed && !response.writableEnded) response.end()
  }

  private append(event: BaseEvent, bytes = utf8Bytes(JSON.stringify(event))): void {
    this.record.events.push(event)
    this.record.bytes += bytes
    this.queue.push(event)
  }

  private finish(event: BaseEvent): void {
    if (this.terminal) return
    this.terminal = true
    this.append(event)
    this.record.state = 'completed'
    this.queue.close()
    this.settled.resolve()
  }
}

/**
 * Replay one completed run without driving DSH again.
 * @param response - Node response receiving the replayed SSE events.
 * @param record - completed bounded event record.
 */
export async function replayRun(response: ServerResponse, record: RunRecord): Promise<void> {
  if (record.state !== 'completed') throw new AgUiGatewayError('RUN_IN_PROGRESS', 'The AG-UI run is still active.', 409)
  const encoder = new EventEncoder({ accept: 'text/event-stream' })
  response.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': encoder.getContentType(),
    'x-accel-buffering': 'no',
  })
  response.flushHeaders()
  for (const event of record.events) {
    if (!response.write(encoder.encodeSSE(event))) await Promise.race([once(response, 'drain'), once(response, 'close')])
    if (response.destroyed) return
  }
  response.end()
}
