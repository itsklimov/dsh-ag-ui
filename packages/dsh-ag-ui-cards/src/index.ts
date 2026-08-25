/**
 * React renderers for DSH tool view cards carried by `dsh:tool:view` AG-UI
 * CUSTOM events. Pair with the `dsh-ag-ui` gateway, or any producer of the
 * same envelopes; this package depends on React alone.
 * @module dsh-ag-ui-cards
 */

export { collectToolViews, isToolViewEvent } from './collect.ts'
export {
  DiffCard,
  GenericCard,
  ReadCard,
  SearchCard,
  TerminalCard,
  ToolViewCard,
  WebCard,
} from './components.tsx'
export { diffRows } from './diff.ts'
export type { DiffRow } from './diff.ts'
export { TOOL_VIEW_NAME } from './types.ts'
export type {
  ContentBlock,
  DiffCallView,
  DiffResultView,
  FileDiff,
  FileLocation,
  GenericCallView,
  GenericResultView,
  ReadFileLine,
  ReadResultView,
  SearchFileMatches,
  SearchLineMatch,
  SearchMatchesResultView,
  SearchPathsResultView,
  SearchResultView,
  TerminalCallView,
  TerminalResultView,
  ToolCallKind,
  ToolResultView,
  ToolCallView,
  ToolViewEnvelope,
  ToolViewEvent,
  ToolViewPhase,
  WebFetchResultView,
  WebResultView,
  WebSearchResultView,
  WebSource,
} from './types.ts'
