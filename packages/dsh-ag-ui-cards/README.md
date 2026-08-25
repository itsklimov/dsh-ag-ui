# dsh-ag-ui-cards

React renderers for DSH tool view cards — the six card kinds the
[dsh-ag-ui](https://github.com/CaiZongyuan/dsh-ag-ui) gateway projects as
`dsh:tool:view` CUSTOM events beside the standard AG-UI tool events.

> This is a community project. It is not an official DeepSeek or AG-UI package.

## Install

```bash
pnpm add dsh-ag-ui-cards react
```

The package depends on React alone. It carries no DSH runtime, no gateway, and
no gateway plugin — it renders envelopes, whatever produced them.

## What it renders

| Card | Pending (`phase: "call"`) | Completed (`phase: "result"`) |
| --- | --- | --- |
| `generic` | Title, category badge, salient raw input, content blocks, follow-along file locations | Replacement title and reformatted content blocks |
| `terminal` | Command under an optional description and working directory | Captured output and an exit-status pill (`exit 0` / `exit 1` / `SIGKILL`) |
| `diff` | One inline line diff per changed file (a create renders as additions) | The applied change as a line diff |
| `search` | — (search calls stay generic) | Grouped content matches or a flat path list, with a capped indicator |
| `read` | — (read calls stay generic) | A line-numbered code window with a language hint and position footer |
| `web` | — (web calls stay generic) | A citation list with an answer (`kind: "search"`) or a URL with its HTTP status (`kind: "fetch"`) |

A future or unrecognized card kind degrades to its raw JSON under the tool
name, so a newer gateway never breaks an older UI.

## Wiring recipe

Subscribe to the decoded AG-UI event stream, fold the `dsh:tool:view` events
with `collectToolViews`, and render. With the official
[`@ag-ui/client`](https://www.npmjs.com/package/@ag-ui/client) `HttpAgent`
behind your authenticated BFF:

```tsx
import { useEffect, useRef, useState } from 'react'
import { HttpAgent, randomUUID } from '@ag-ui/client'
import { collectToolViews, ToolViewCard, type ToolViewEnvelope } from 'dsh-ag-ui-cards'

const agent = new HttpAgent({ url: '/api/agent', threadId: 'app-thread-1' })

export function ToolCards() {
  const [cards, setCards] = useState<ToolViewEnvelope[]>([])
  const seen = useRef<unknown[]>([])

  useEffect(() => {
    agent.addMessage({ id: randomUUID(), role: 'user', content: 'Search the notes.' })
    void agent.runAgent(
      { runId: randomUUID(), tools: [], context: [], forwardedProps: {} },
      {
        onEvent: ({ event }) => {
          seen.current.push(event)
          setCards(collectToolViews(seen.current))
        },
      },
    )
  }, [])

  return <>{cards.map(envelope => <ToolViewCard key={envelope.callId} envelope={envelope} />)}</>
}
```

How the pieces fit:

- `isToolViewEvent(event)` recognizes a decoded AG-UI event as a
  `dsh:tool:view` carrier — structural and permissive, so any event source
  works, not just `HttpAgent`.
- `collectToolViews(events)` folds a stream into the latest envelope per
  `callId`, in first-appearance order: a pending call holds its slot until its
  result replaces it. Because the gateway re-derives every settled card after
  each `MESSAGES_SNAPSHOT`, one shared fold keeps a reconnected transcript
  correct without deduplication logic.
- A cold replay carries only result envelopes — the pending card is not
  replayed — so a completed card without its own title falls back to the tool
  name. Pass the tool result message alongside when the raw result matters.
- `<ToolViewCard envelope={envelope} className?="stack" />` dispatches on the
  phase and card kind. The kind components (`GenericCard`, `TerminalCard`,
  `DiffCard`, `SearchCard`, `ReadCard`, `WebCard`) and the envelope/card types
  are exported for fine-grained use.

## Theming

The components ship no CSS: unstyled semantic markup with stable `dsh-card*`
class names, plus `data-phase`, `data-call-id`, `data-tool-name`,
`data-kind`, `data-ok`, `data-truncated`, `data-path`, `data-lang`,
`data-cwd`, and per-row `dsh-card__diff-row--same|del|add` hooks. Style the
classes, or read the data attributes for behavior (for example, pulse cards
still in `data-phase="call"`).

## Recorded fixtures

`fixtures/tool-view.events.json` is recorded from the real gateway driving one
tool per card kind, live and on cold replay. The package's component tests
render these recorded events, and the gateway repository re-runs the recording
scenario against the committed file, so the fixture cannot drift from what the
gateway emits.

## Compatibility

- Envelope `version: 1` — the card vocabulary of DSH `dsh-tools` presentation
  types, re-declared here so no DSH package is required.
- React `^18.0.0 || ^19.0.0`.

## Development

```bash
pnpm install
pnpm check
```

from `packages/dsh-ag-ui-cards` runs lint, strict type checking, per-file
coverage component tests, the build, and publint.

## License

[MIT](LICENSE). The card vocabulary mirrors DSH's published presentation
types; see [NOTICE](NOTICE).
