import { EventType, type BaseEvent, type Message as AgUiMessage } from '@ag-ui/core'
import type { ContentBlock, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { type SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'

/** Reserved model-facing Tool that shallow-merges shared application state. */
export const STATE_TOOL_NAME = 'ag_ui_update_state'

/** Where a tool call sits inside its DSH session. */
export interface ToolCallPosition {
  readonly turn: number
  readonly step: number
  readonly name: string
}

/** State-tool outcome staged by the thread binding until its durable result. */
export interface PendingStateCommit {
  readonly value: unknown
  readonly changed: boolean
}

export type ToolCallLifecycle =
  | ({ readonly kind: 'backend' } & ToolCallPosition)
  | ({ readonly kind: 'frontend'; readonly parked: true } & ToolCallPosition)
  | ({ readonly kind: 'awaiting' } & ToolCallPosition)
  | ({ readonly kind: 'state'; commit?: PendingStateCommit } & ToolCallPosition)

/** How the active AG-UI run should settle after a translated event. */
export type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

/** Pure translation result for one session event. */
export interface ProjectionStep {
  readonly events: BaseEvent[]
  readonly outcome?: RunOutcome
}

interface TextProjection {
  readonly messageId: string
  started: boolean
}

/** Which calls a step's assistant message announced, and how many streamed. */
interface StepToolProgress {
  readonly announced: readonly string[]
  streamed: number
}

const EMPTY_STEP: ProjectionStep = { events: [] }

/**
 * Pure translation of one DSH session's events into AG-UI wire events: events
 * in, events out — no I/O, timers, or agent handles. The owning thread binding
 * feeds every session event through {@link SessionProjection.project} and
 * applies the returned events and run outcome to its active run controller.
 */
export class SessionProjection {
  private readonly text = new Map<string, TextProjection>()
  private readonly toolCallLifecycles = new Map<string, ToolCallLifecycle>()
  private readonly stepProgress = new Map<string, StepToolProgress>()
  private readonly serverResultCallIds = new Set<string>()

  /** Shared application state carried between runs; committed by state-tool results. */
  sharedState: unknown

  constructor(private readonly sessionId: SessionId) {}

  /**
   * Translate one session event against the active run's DSH turn.
   * @param event - durable session event of any kind.
   * @param activeTurn - turn the active run observes, or undefined while idle.
   */
  project(event: SessionEvent, activeTurn: number | undefined): ProjectionStep {
    if (event.type === 'step/end') {
      this.stepProgress.delete(`${String(event.data.turn)}:${String(event.data.step)}`)
      return EMPTY_STEP
    }
    if (activeTurn === undefined || !eventBelongsToTurn(event, activeTurn)) return EMPTY_STEP

    switch (event.type) {
      case 'assistant/chunk': {
        if (event.data.chunk.type !== 'text-delta') return EMPTY_STEP
        const projection = this.textProjection(event.data.turn, event.data.step)
        if (!projection.started) {
          projection.started = true
          return {
            events: [
              { type: EventType.TEXT_MESSAGE_START, messageId: projection.messageId, role: 'assistant' },
              { type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: event.data.chunk.text },
            ],
          }
        }
        return { events: [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: event.data.chunk.text }] }
      }
      case 'assistant/message': {
        const announced = announcedToolNames(event.data.message.content)
        if (announced.length > 0) {
          this.stepProgress.set(`${String(event.data.turn)}:${String(event.data.step)}`, {
            announced,
            streamed: 0,
          })
        }
        const projection = this.textProjection(event.data.turn, event.data.step)
        if (!projection.started) {
          const text = joinText(event.data.message.content)
          if (text !== '') {
            projection.started = true
            return {
              events: [
                { type: EventType.TEXT_MESSAGE_START, messageId: projection.messageId, role: 'assistant' },
                { type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: text },
                { type: EventType.TEXT_MESSAGE_END, messageId: projection.messageId },
              ],
            }
          }
        }
        if (projection.started) return { events: [{ type: EventType.TEXT_MESSAGE_END, messageId: projection.messageId }] }
        return EMPTY_STEP
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        const progress = this.stepProgress.get(`${String(event.data.turn)}:${String(event.data.step)}`)
        if (progress !== undefined) progress.streamed += 1
        this.toolCallLifecycles.set(callId, {
          kind: event.data.name === STATE_TOOL_NAME ? 'state' : 'backend',
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
        })
        if (event.data.name === STATE_TOOL_NAME) return EMPTY_STEP
        return {
          events: [
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: callId,
              toolCallName: event.data.name,
              parentMessageId: assistantMessageId(this.sessionId, event.data.turn, event.data.step),
            },
            { type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: event.data.arguments },
            { type: EventType.TOOL_CALL_END, toolCallId: callId },
          ],
        }
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        const lifecycle = this.toolCallLifecycles.get(callId)
        this.toolCallLifecycles.delete(callId)
        if (lifecycle?.kind === 'state') {
          const commit = lifecycle.commit
          if (commit !== undefined && !block.isError && commit.changed) {
            this.sharedState = structuredClone(commit.value)
            return { events: [{ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(commit.value) }] }
          }
          return EMPTY_STEP
        }
        this.serverResultCallIds.add(callId)
        if (lifecycle?.kind === 'frontend' || lifecycle?.kind === 'awaiting') return EMPTY_STEP
        return {
          events: [{
            type: EventType.TOOL_CALL_RESULT,
            messageId: resultMessageId(this.sessionId, callId),
            toolCallId: callId,
            content: renderToolResult(block),
            role: 'tool',
          }],
        }
      }
      case 'turn/end': {
        this.clearTurn(event.data.turn)
        return { events: [], outcome: turnOutcome(event.data.reason) }
      }
      default:
        return EMPTY_STEP
    }
  }

  /** Live lifecycle of one tool call, for parking and state-commit validation. */
  lifecycleOf(callId: string): ToolCallLifecycle | undefined {
    return this.toolCallLifecycles.get(callId)
  }

  /** Transition one validated backend call of this session to parked. */
  markParked(callId: string, lifecycle: ToolCallLifecycle & { kind: 'backend' }): void {
    this.toolCallLifecycles.set(callId, { ...lifecycle, kind: 'frontend', parked: true })
  }

  /** Record the client's answer to a parked call; its durable result is pending. */
  markAwaitingResult(callId: string): void {
    const lifecycle = this.toolCallLifecycles.get(callId)
    if (lifecycle?.kind === 'frontend') {
      this.toolCallLifecycles.set(callId, {
        kind: 'awaiting',
        turn: lifecycle.turn,
        step: lifecycle.step,
        name: lifecycle.name,
      })
    }
  }

  /**
   * Whether a run observing this step may finish after a park: a call is
   * parked, no answered call still awaits its durable result, and no further
   * announced call would start while the park holds the scheduler pool.
   * Un-resulted server calls do not block: DSH commits results in model
   * order, so a call after a parked one cannot commit until the parked call
   * resolves, and its result reaches the client through a later run instead.
   * Steps without an announcement settle at the first park.
   * @param startsWhileParked - whether one announced call would still start.
   */
  parkSettleReady(turn: number, step: number, startsWhileParked: (name: string) => boolean): boolean {
    let parked = false
    for (const lifecycle of this.toolCallLifecycles.values()) {
      if (lifecycle.turn !== turn || lifecycle.step !== step) continue
      if (lifecycle.kind === 'awaiting') return false
      if (lifecycle.kind === 'frontend') parked = true
    }
    if (!parked) return false
    const progress = this.stepProgress.get(`${String(turn)}:${String(step)}`)
    if (progress === undefined) return true
    const next = progress.announced[progress.streamed]
    return next === undefined || !startsWhileParked(next)
  }

  /** Attach a prepared shared-state commit to its live state call. */
  stageCommit(callId: string, commit: PendingStateCommit): void {
    const lifecycle = this.toolCallLifecycles.get(callId)
    if (lifecycle?.kind === 'state') this.toolCallLifecycles.set(callId, { ...lifecycle, commit })
  }

  /** Consume one recorded backend result id so a re-sent ToolMessage is accepted. */
  consumeServerResult(callId: string): boolean {
    return this.serverResultCallIds.delete(callId)
  }

  /** Drop call bookkeeping for one finished turn. */
  clearTurn(turn: number): void {
    for (const [callId, lifecycle] of this.toolCallLifecycles) {
      if (lifecycle.turn === turn) this.toolCallLifecycles.delete(callId)
    }
    for (const key of this.stepProgress.keys()) {
      if (key.startsWith(`${String(turn)}:`)) this.stepProgress.delete(key)
    }
  }

  /**
   * Derive the full AG-UI message history from the durable session log, with
   * ids identical to the streaming projections: user messages keep the ids the
   * client sent, assistant messages use the step identity, tool results use the
   * call identity.
   * @param events - the session's durable event log, in order.
   * @param userMessageId - durable user message id to the client's AG-UI id; unmapped messages (injected context, foreign sessions) are skipped.
   */
  messagesSnapshot(events: readonly SessionEvent[], userMessageId: (durableId: string) => string | undefined): AgUiMessage[] {
    const messages: AgUiMessage[] = []
    for (const event of events) {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') continue
        const id = userMessageId(String(event.data.id))
        if (id === undefined) continue
        messages.push({ id, role: 'user', content: joinText(event.data.content) })
      } else if (event.type === 'assistant/message') {
        const text = joinText(event.data.message.content)
        if (text === '') continue
        messages.push({
          id: assistantMessageId(this.sessionId, event.data.turn, event.data.step),
          role: 'assistant',
          content: text,
        })
      } else if (event.type === 'tool/result') {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        messages.push({
          id: resultMessageId(this.sessionId, callId),
          role: 'tool',
          toolCallId: callId,
          content: renderToolResult(block),
        })
      }
    }
    return messages
  }

  private textProjection(turn: number, step: number): TextProjection {
    const key = `${String(turn)}:${String(step)}`
    let projection = this.text.get(key)
    if (projection === undefined) {
      projection = { messageId: assistantMessageId(this.sessionId, turn, step), started: false }
      this.text.set(key, projection)
    }
    return projection
  }
}

/** Whether a durable event carries the selected turn. */
function eventBelongsToTurn(event: SessionEvent, turn: number): boolean {
  if (!('turn' in event.data)) return false
  return event.data.turn === turn
}

/** Deterministic AG-UI assistant message identity for one DSH step. */
function assistantMessageId(sessionId: SessionId, turn: number, step: number): string {
  return `ag-ui:${String(sessionId)}:${String(turn)}:${String(step)}:assistant`
}

/** Deterministic AG-UI tool-result message identity for one DSH tool call. */
function resultMessageId(sessionId: SessionId, callId: string): string {
  return `ag-ui:${String(sessionId)}:${callId}:result`
}

/** Names of the tool calls one assistant message announced, in model order. */
function announcedToolNames(content: readonly ContentBlock[]): string[] {
  return content.filter(block => block.type === 'tool-call').map(block => block.name)
}

/** Concatenate the text blocks of one message's content. */
function joinText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Map one DSH turn-end reason onto the AG-UI run outcome. */
function turnOutcome(reason: TurnEndReason): RunOutcome {
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
      return { kind: 'success' }
    case 'error':
      return { kind: 'error', code: reason.error.code, message: reason.error.message }
    case 'aborted':
      return { kind: 'error', code: 'AGENT_ABORTED', message: 'The DSH turn was aborted.' }
    case 'blocked':
      return { kind: 'error', code: 'AGENT_BLOCKED', message: 'The DSH turn was blocked before completion.' }
    case 'interrupted':
      return { kind: 'error', code: 'AGENT_INTERRUPTED', message: 'The stored DSH turn was interrupted.' }
    default:
      return { kind: 'error', code: 'AGENT_EXECUTION_ERROR', message: 'The DSH turn ended with an unsupported reason.' }
  }
}

/** Flatten DSH model-facing Tool content into the AG-UI string result field. */
function renderToolResult(block: ToolResultBlock): string {
  const text: string[] = []
  for (const content of block.content) {
    if (content.type === 'text') text.push(content.text)
    else if (content.type === 'reasoning') text.push(content.text)
    else if (content.type === 'image') text.push('[image result]')
    else if (content.type === 'tool-call') text.push(`[nested tool call: ${content.name}]`)
    else text.push(renderToolResult(content))
  }
  return text.join('\n')
}
