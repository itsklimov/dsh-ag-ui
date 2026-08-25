/**
 * The `dsh:tool:view` wire vocabulary, re-declared so this package renders
 * cards without any DSH runtime dependency. Each type mirrors its DSH
 * presentation counterpart; the AG-UI gateway projects the values verbatim.
 * @module dsh-ag-ui-cards/src/types
 */

/** CUSTOM event name the dsh-ag-ui gateway carries one card envelope in. */
export const TOOL_VIEW_NAME = 'dsh:tool:view'

/** Whether an envelope presents the pending call or its completed result. */
export type ToolViewPhase = 'call' | 'result'

/** Category of a tool call, for icons or treatment; `other` is the default. */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/** A file location a tool reads or modifies, for follow-along highlighting. */
export interface FileLocation {
  readonly path: string
  readonly line?: number
}

/** One file change: prior content (`null` for a create or overwrite) and new content. */
export interface FileDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

/**
 * Content block a card carries. The DSH text and reasoning blocks render as
 * text; an image block references an opaque attachment id a bridge resolves,
 * so it renders as a labelled placeholder; anything else renders as JSON.
 */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: { readonly attachmentId: string; readonly name?: string } }
  | { readonly type: string; readonly [field: string]: unknown }

/** The default pending card: a titled row with a category, salient input, and follow-along locations. */
export interface GenericCallView {
  readonly card: 'generic'
  readonly title: string
  readonly kind?: ToolCallKind
  readonly rawInput?: unknown
  readonly content?: readonly ContentBlock[]
  readonly locations?: readonly FileLocation[]
}

/** A pending shell command: the command as the title, under an optional description and working directory. */
export interface TerminalCallView {
  readonly card: 'terminal'
  readonly title: string
  readonly description?: string
  readonly cwd?: string
}

/** A pending file mutation: one inline diff per changed file. */
export interface DiffCallView {
  readonly card: 'diff'
  readonly title: string
  readonly diffs: readonly FileDiff[]
  readonly locations?: readonly FileLocation[]
}

/** Provider-neutral pending-call presentation; switch on `card`. */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

/** The default completed card: an optional replacement title and reformatted content. */
export interface GenericResultView {
  readonly card: 'generic'
  readonly title?: string
  readonly content?: readonly ContentBlock[]
}

/** The completed state of a terminal call: captured output and exit status. */
export interface TerminalResultView {
  readonly card: 'terminal'
  readonly title?: string
  readonly output?: string
  readonly exitCode?: number
  readonly signal?: string
}

/** A completed file mutation, repeated or refined from the call-time diff. */
export interface DiffResultView {
  readonly card: 'diff'
  readonly title?: string
  readonly diffs: readonly FileDiff[]
}

/** One matched line inside a grouped search result. */
export interface SearchLineMatch {
  readonly lineNumber: number
  readonly line: string
}

/** One file's grouped content matches. */
export interface SearchFileMatches {
  readonly path: string
  readonly matches: readonly SearchLineMatch[]
}

/** A completed content search: matched lines grouped by file. */
export interface SearchMatchesResultView {
  readonly card: 'search'
  readonly shape: 'matches'
  readonly title?: string
  readonly files: readonly SearchFileMatches[]
  readonly truncated: boolean
  readonly total: number
}

/** A completed path search: a flat path list. */
export interface SearchPathsResultView {
  readonly card: 'search'
  readonly shape: 'paths'
  readonly title?: string
  readonly paths: readonly string[]
  readonly truncated: boolean
  readonly total: number
}

/** A completed search, discriminated by `shape`. */
export type SearchResultView = SearchMatchesResultView | SearchPathsResultView

/** One numbered line of a read result, keeping its file line number. */
export interface ReadFileLine {
  readonly number: number
  readonly text: string
}

/** A completed file read: a line-numbered window with an optional language hint. */
export interface ReadResultView {
  readonly card: 'read'
  readonly title?: string
  readonly path: string
  readonly offset: number
  readonly lines: readonly ReadFileLine[]
  readonly totalLines: number
  readonly lang?: string
  readonly content?: readonly ContentBlock[]
}

/** One citeable source of a completed web search. */
export interface WebSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** A completed web search: structured sources and an optional provider answer. */
export interface WebSearchResultView {
  readonly card: 'web'
  readonly kind: 'search'
  readonly title?: string
  readonly sources: readonly WebSource[]
  readonly answer?: string
  readonly truncated: boolean
}

/** A completed web fetch: the final URL, its status, and whether the body was cut. */
export interface WebFetchResultView {
  readonly card: 'web'
  readonly kind: 'fetch'
  readonly title?: string
  readonly url: string
  readonly statusCode: number
  readonly truncated: boolean
}

/** A completed web retrieval, discriminated by `kind`. */
export type WebResultView = WebSearchResultView | WebFetchResultView

/** Provider-neutral completed-call presentation; switch on `card`. */
export type ToolResultView =
  | GenericResultView
  | TerminalResultView
  | DiffResultView
  | SearchResultView
  | ReadResultView
  | WebResultView

/** Versioned wrapper around one card, exactly as the gateway emits it. */
export interface ToolViewEnvelope {
  readonly version: number
  readonly callId: string
  readonly toolName: string
  readonly phase: ToolViewPhase
  readonly card: ToolCallView | ToolResultView
}

/** One AG-UI CUSTOM event carrying a {@link ToolViewEnvelope}. */
export interface ToolViewEvent {
  readonly type: 'CUSTOM'
  readonly name: typeof TOOL_VIEW_NAME
  readonly value: ToolViewEnvelope
}
