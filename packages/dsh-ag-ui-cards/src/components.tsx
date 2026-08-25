/**
 * React renderers for the six DSH card kinds, driven by `dsh:tool:view`
 * envelopes: pure presentational components, no DSH runtime, unstyled semantic
 * markup with stable class names and data attributes for app-side theming.
 * @module dsh-ag-ui-cards/src/components
 */

import type { ReactElement, ReactNode } from 'react'
import { diffRows } from './diff.ts'
import type {
  ContentBlock,
  DiffCallView,
  DiffResultView,
  FileDiff,
  FileLocation,
  GenericCallView,
  GenericResultView,
  ReadResultView,
  SearchMatchesResultView,
  SearchPathsResultView,
  SearchResultView,
  TerminalCallView,
  TerminalResultView,
  ToolCallKind,
  ToolViewEnvelope,
  WebFetchResultView,
  WebResultView,
  WebSearchResultView,
} from './types.ts'

/** Every kind renderer receives the envelope and its phase's view of that kind. */
interface KindProps<View> {
  readonly envelope: ToolViewEnvelope
  readonly view: View
}

/**
 * Completed-card header: a replacement title, or the tool name when the card
 * keeps its pending title (a cold replay carries no pending envelope).
 */
function resultTitle(envelope: ToolViewEnvelope, replacement: string | undefined): string {
  return replacement ?? envelope.toolName
}

/** The card frame every kind renders inside. */
function CardShell({ envelope, kind, title, badge, children }: {
  readonly envelope: ToolViewEnvelope
  readonly kind: string
  readonly title: string
  readonly badge?: ToolCallKind | undefined
  readonly children?: ReactNode
}): ReactElement {
  return (
    <article
      className={`dsh-card dsh-card--${kind}`}
      data-call-id={envelope.callId}
      data-tool-name={envelope.toolName}
      data-phase={envelope.phase}
    >
      <header className="dsh-card__header">
        <span className="dsh-card__title">{title}</span>
        {badge === undefined || badge === 'other'
          ? null
          : <span className="dsh-card__kind" data-kind={badge}>{badge}</span>}
      </header>
      {children}
    </article>
  )
}

/** Placeholder for one image block; a bridge resolves the attachment itself. */
function imagePlaceholder(block: ContentBlock): ReactNode {
  const attachment = (block as { readonly attachment?: unknown }).attachment
  if (typeof attachment !== 'object' || attachment === null) return JSON.stringify(block, null, 2)
  const named = attachment as { readonly attachmentId?: unknown, readonly name?: unknown }
  const name = typeof named.name === 'string' ? named.name : undefined
  const id = typeof named.attachmentId === 'string' ? named.attachmentId : 'unknown attachment'
  return `[image: ${name ?? id}]`
}

/** Rendered body of one content block: text, an attachment placeholder, or JSON. */
function blockBody(block: ContentBlock): ReactNode {
  // the open fallback arm overlaps the typed arms, so field checks validate rather than narrow
  if (block.type === 'text' || block.type === 'reasoning') {
    return typeof block.text === 'string' ? block.text : JSON.stringify(block, null, 2)
  }
  if (block.type === 'image') return imagePlaceholder(block)
  return JSON.stringify(block, null, 2)
}

function ContentBlocks({ blocks }: { readonly blocks: readonly ContentBlock[] }): ReactElement {
  return (
    <div className="dsh-card__blocks">
      {blocks.map((block, index) => (
        <div key={index} className={`dsh-card__block dsh-card__block--${block.type}`}>{blockBody(block)}</div>
      ))}
    </div>
  )
}

/** The salient pending input: a string as-is, anything else as pretty JSON. */
function RawInput({ value }: { readonly value: unknown }): ReactElement {
  return <pre className="dsh-card__input">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
}

/** Follow-along file locations of one call. */
function Locations({ locations }: { readonly locations: readonly FileLocation[] }): ReactElement {
  return (
    <ul className="dsh-card__locations">
      {locations.map(location => (
        <li key={`${location.path}:${location.line ?? ''}`} className="dsh-card__location">
          {location.line === undefined ? location.path : `${location.path}:${String(location.line)}`}
        </li>
      ))}
    </ul>
  )
}

/** Exit-status pill of a completed terminal call, or undefined when it settled neither way. */
function terminalStatus(view: TerminalResultView): { label: string, ok: boolean } | undefined {
  if (view.exitCode !== undefined) return { label: `exit ${String(view.exitCode)}`, ok: view.exitCode === 0 }
  if (view.signal !== undefined) return { label: view.signal, ok: false }
  return undefined
}

/**
 * The generic card: a titled row for the pending call (category, salient
 * input, extra content, follow-along locations) and its completed state.
 */
export function GenericCard({ envelope, view }: KindProps<GenericCallView | GenericResultView>): ReactElement {
  // the wire invariant pairs a phase with its view shape, so each cast reads as the pairing
  if (envelope.phase === 'call') {
    const call = view as GenericCallView
    return (
      <CardShell envelope={envelope} kind="generic" title={call.title} badge={call.kind}>
        {call.rawInput === undefined ? null : <RawInput value={call.rawInput} />}
        {call.content === undefined ? null : <ContentBlocks blocks={call.content} />}
        {call.locations === undefined ? null : <Locations locations={call.locations} />}
      </CardShell>
    )
  }
  const result = view as GenericResultView
  return (
    <CardShell envelope={envelope} kind="generic" title={resultTitle(envelope, result.title)}>
      {result.content === undefined ? null : <ContentBlocks blocks={result.content} />}
    </CardShell>
  )
}

/**
 * The terminal card: a command under an optional description and working
 * directory while pending, then captured output and an exit-status pill.
 */
export function TerminalCard({ envelope, view }: KindProps<TerminalCallView | TerminalResultView>): ReactElement {
  if (envelope.phase === 'call') {
    const call = view as TerminalCallView
    return (
      <CardShell envelope={envelope} kind="terminal" title={call.title}>
        {call.description === undefined ? null : <p className="dsh-card__description">{call.description}</p>}
        {call.cwd === undefined ? null : <div className="dsh-card__cwd" data-cwd={call.cwd}>{call.cwd}</div>}
      </CardShell>
    )
  }
  const result = view as TerminalResultView
  const status = terminalStatus(result)
  return (
    <CardShell envelope={envelope} kind="terminal" title={resultTitle(envelope, result.title)}>
      {result.output === undefined ? null : <pre className="dsh-card__output">{result.output}</pre>}
      {status === undefined ? null : <span className="dsh-card__status" data-ok={status.ok}>{status.label}</span>}
    </CardShell>
  )
}

/** One file's diff rows, numbered on both sides. */
function FileDiffView({ diff }: { readonly diff: FileDiff }): ReactElement {
  return (
    <section className="dsh-card__file" data-path={diff.path}>
      <span className="dsh-card__file-path">{diff.path}</span>
      <table className="dsh-card__diff">
        <tbody>
          {diffRows(diff.oldText, diff.newText).map(row => (
            <tr key={`${row.oldLine ?? '-'}:${row.newLine ?? '-'}`} className={`dsh-card__diff-row dsh-card__diff-row--${row.kind}`}>
              <td className="dsh-card__diff-no">{row.oldLine === undefined ? '' : String(row.oldLine)}</td>
              <td className="dsh-card__diff-no">{row.newLine === undefined ? '' : String(row.newLine)}</td>
              <td className="dsh-card__diff-text">{row.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** The diff card: one inline line diff per changed file, pending and completed. */
export function DiffCard({ envelope, view }: KindProps<DiffCallView | DiffResultView>): ReactElement {
  if (envelope.phase === 'call') {
    const call = view as DiffCallView
    return (
      <CardShell envelope={envelope} kind="diff" title={call.title}>
        {call.diffs.map(diff => <FileDiffView key={diff.path} diff={diff} />)}
        {call.locations === undefined ? null : <Locations locations={call.locations} />}
      </CardShell>
    )
  }
  const result = view as DiffResultView
  return (
    <CardShell envelope={envelope} kind="diff" title={resultTitle(envelope, result.title)}>
      {result.diffs.map(diff => <FileDiffView key={diff.path} diff={diff} />)}
    </CardShell>
  )
}

/**
 * The read card: a line-numbered code window with an optional language hint
 * for app-side highlighting, and a window position footer.
 */
export function ReadCard({ envelope, view }: KindProps<ReadResultView>): ReactElement {
  return (
    <CardShell envelope={envelope} kind="read" title={resultTitle(envelope, view.title)}>
      <div className="dsh-card__code" data-path={view.path} data-lang={view.lang}>
        {view.lines.map(line => (
          <div key={line.number} className="dsh-card__code-line">
            <span className="dsh-card__code-no">{String(line.number)}</span>
            <span className="dsh-card__code-text">{line.text}</span>
          </div>
        ))}
      </div>
      <span className="dsh-card__window">
        {`showing ${String(view.lines.length)} of ${String(view.totalLines)} lines from line ${String(view.offset)}`}
      </span>
    </CardShell>
  )
}

/** Matched lines grouped by file, each file one open group. */
function SearchMatches({ view }: { readonly view: SearchMatchesResultView }): ReactElement {
  return (
    <div className="dsh-card__matches">
      {view.files.map(file => (
        <details key={file.path} className="dsh-card__match-file" data-path={file.path} open>
          <summary className="dsh-card__match-file-path">{file.path}</summary>
          <ul className="dsh-card__match-lines">
            {file.matches.map(match => (
              <li key={match.lineNumber} className="dsh-card__match-line">
                <span className="dsh-card__match-no">{String(match.lineNumber)}</span>
                <span className="dsh-card__match-text">{match.line}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  )
}

/** A flat path list. */
function SearchPaths({ view }: { readonly view: SearchPathsResultView }): ReactElement {
  return (
    <ol className="dsh-card__paths">
      {view.paths.map(path => <li key={path} className="dsh-card__path">{path}</li>)}
    </ol>
  )
}

/** Retained rows of one search result, for the capped indicator. */
function searchRetained(view: SearchResultView): number {
  return view.shape === 'matches'
    ? view.files.reduce((total, file) => total + file.matches.length, 0)
    : view.paths.length
}

/**
 * The search card: grouped content matches or a flat path list, with a capped
 * indicator so a partial result never reads as complete.
 */
export function SearchCard({ envelope, view }: KindProps<SearchResultView>): ReactElement {
  return (
    <CardShell envelope={envelope} kind="search" title={resultTitle(envelope, view.title)}>
      {view.shape === 'matches' ? <SearchMatches view={view} /> : <SearchPaths view={view} />}
      <span className="dsh-card__count" data-truncated={view.truncated}>
        {view.truncated
          ? `showing ${String(searchRetained(view))} of ${String(view.total)} matches`
          : `${String(view.total)} ${view.total === 1 ? 'match' : 'matches'}`}
      </span>
    </CardShell>
  )
}

/** The structured sources of a completed web search. */
function WebSearch({ view }: { readonly view: WebSearchResultView }): ReactElement {
  return (
    <div className="dsh-card__sources">
      {view.answer === undefined ? null : <p className="dsh-card__answer">{view.answer}</p>}
      <ul className="dsh-card__source-list">
        {view.sources.map(source => (
          <li key={source.url} className="dsh-card__source">
            <a className="dsh-card__source-url" href={source.url}>{source.title ?? source.url}</a>
            {source.snippet === undefined ? null : <p className="dsh-card__source-snippet">{source.snippet}</p>}
            {source.publishedAt === undefined ? null : <time className="dsh-card__source-date">{source.publishedAt}</time>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The retrieval summary of a completed web fetch; the body stays in the tool result. */
function WebFetch({ view }: { readonly view: WebFetchResultView }): ReactElement {
  return (
    <div className="dsh-card__fetch">
      <a className="dsh-card__fetch-url" href={view.url}>{view.url}</a>
      <span className="dsh-card__status" data-ok={view.statusCode >= 200 && view.statusCode < 300}>
        {`HTTP ${String(view.statusCode)}`}
      </span>
    </div>
  )
}

/** The web card: a citation list for a search, or a URL and status for a fetch. */
export function WebCard({ envelope, view }: KindProps<WebResultView>): ReactElement {
  return (
    <CardShell envelope={envelope} kind="web" title={resultTitle(envelope, view.title)}>
      {view.kind === 'search' ? <WebSearch view={view} /> : <WebFetch view={view} />}
      {view.truncated ? <span className="dsh-card__truncated">result truncated</span> : null}
    </CardShell>
  )
}

/** A future or unrecognized card kind, rendered as its raw JSON under the tool name. */
function UnknownCard({ envelope }: { readonly envelope: ToolViewEnvelope }): ReactElement {
  return (
    <CardShell envelope={envelope} kind="unknown" title={envelope.toolName}>
      <pre className="dsh-card__input">{JSON.stringify(envelope.card, null, 2)}</pre>
    </CardShell>
  )
}

/** Dispatch one envelope to its kind renderer; an unrecognized kind degrades to raw JSON. */
function KindCard({ envelope }: { readonly envelope: ToolViewEnvelope }): ReactElement {
  if (envelope.phase === 'call') {
    switch (envelope.card.card) {
      case 'generic': return <GenericCard envelope={envelope} view={envelope.card} />
      case 'terminal': return <TerminalCard envelope={envelope} view={envelope.card} />
      case 'diff': return <DiffCard envelope={envelope} view={envelope.card} />
      default: return <UnknownCard envelope={envelope} />
    }
  }
  switch (envelope.card.card) {
    case 'generic': return <GenericCard envelope={envelope} view={envelope.card} />
    case 'terminal': return <TerminalCard envelope={envelope} view={envelope.card} />
    case 'diff': return <DiffCard envelope={envelope} view={envelope.card} />
    case 'search': return <SearchCard envelope={envelope} view={envelope.card} />
    case 'read': return <ReadCard envelope={envelope} view={envelope.card} />
    case 'web': return <WebCard envelope={envelope} view={envelope.card} />
    default: return <UnknownCard envelope={envelope} />
  }
}

/**
 * Render one `dsh:tool:view` envelope: dispatches on the phase and card kind,
 * with an optional wrapper class for layout.
 */
export function ToolViewCard({ envelope, className }: {
  readonly envelope: ToolViewEnvelope
  readonly className?: string | undefined
}): ReactElement {
  const card = <KindCard envelope={envelope} />
  return className === undefined ? card : <div className={className}>{card}</div>
}
