import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { collectToolViews, isToolViewEvent } from '../src/collect.ts'
import { ToolViewCard } from '../src/components.tsx'
import type { ToolViewEnvelope } from '../src/types.ts'
import fixture from '../fixtures/tool-view.events.json'

/** The six card renderers, against envelopes recorded from the real gateway. */

afterEach(cleanup)

const live = collectToolViews(fixture.runs[0] as unknown[])
const cold = collectToolViews(fixture.runs[1] as unknown[])
const calls = (fixture.runs[0] as unknown[])
  .filter(event => isToolViewEvent(event) && event.value.phase === 'call')
  .map(event => event.value)

function renderCard(envelope: ToolViewEnvelope): HTMLElement {
  const { container } = render(<ToolViewCard envelope={envelope} />)
  return container.firstElementChild as HTMLElement
}

function envelope(phase: 'call' | 'result', card: ToolViewEnvelope['card'], toolName = 'edge_tool'): ToolViewEnvelope {
  return { version: 1, callId: 'edge-1', toolName, phase, card }
}

describe('recorded cards', () => {
  it('renders the generic call with its kind, raw input, and follow-along location', () => {
    const card = renderCard(calls[0]!)
    expect(card.className).toBe('dsh-card dsh-card--generic')
    expect(card.getAttribute('data-phase')).toBe('call')
    expect(card.getAttribute('data-call-id')).toBe('cards-call-1')
    expect(card.querySelector('.dsh-card__title')?.textContent).toBe('Checking notes.md')
    expect(card.querySelector('.dsh-card__kind')?.getAttribute('data-kind')).toBe('read')
    expect(card.querySelector('.dsh-card__input')?.textContent).toContain('"path": "notes.md"')
    expect(card.querySelector('.dsh-card__location')?.textContent).toBe('notes.md:3')
  })

  it('renders the generic result with its replacement title and content blocks', () => {
    const card = renderCard(live[0]!)
    expect(card.getAttribute('data-phase')).toBe('result')
    expect(card.querySelector('.dsh-card__title')?.textContent).toBe('Checked notes.md')
    expect(card.querySelector('.dsh-card__block--text')?.textContent).toBe('3 headings in 12 lines')
  })

  it('renders the terminal call under its description and working directory', () => {
    const card = renderCard(calls[1]!)
    expect(card.className).toContain('dsh-card--terminal')
    expect(card.querySelector('.dsh-card__title')?.textContent).toBe('pnpm test')
    expect(card.querySelector('.dsh-card__description')?.textContent).toBe('Run the unit suite')
    expect(card.querySelector('.dsh-card__cwd')?.getAttribute('data-cwd')).toBe('/repo')
  })

  it('renders the terminal result with output and a zero-exit pill', () => {
    const card = renderCard(live[1]!)
    expect(card.querySelector('.dsh-card__output')?.textContent).toBe('ok — 148 tests passed')
    const status = card.querySelector('.dsh-card__status')
    expect(status?.textContent).toBe('exit 0')
    expect(status?.getAttribute('data-ok')).toBe('true')
  })

  it('renders a created file as additions and an applied edit as a hunk', () => {
    const create = renderCard(calls[2]!)
    expect(create.querySelectorAll('.dsh-card__diff-row--add')).toHaveLength(2)
    expect(create.querySelectorAll('.dsh-card__diff-row--del')).toHaveLength(0)
    expect(create.querySelector('.dsh-card__location')?.textContent).toBe('greeting.txt')
    const applied = renderCard(live[2]!)
    expect(applied.querySelector('.dsh-card__title')?.textContent).toBe('Wrote greeting.txt')
    expect(applied.querySelector('.dsh-card__diff-row--del')?.textContent).toContain('hello')
    expect(applied.querySelector('.dsh-card__diff-row--add')?.textContent).toContain('hello dsh')
  })

  it('renders the read window with file line numbers, language hint, and position', () => {
    const card = renderCard(live[3]!)
    expect(card.className).toContain('dsh-card--read')
    const code = card.querySelector('.dsh-card__code')
    expect(code?.getAttribute('data-path')).toBe('src/app.ts')
    expect(code?.getAttribute('data-lang')).toBe('ts')
    expect([...card.querySelectorAll('.dsh-card__code-no')].map(no => no.textContent)).toEqual(['3', '4', '5'])
    expect(card.querySelector('.dsh-card__code-text')?.textContent).toBe('export function start() {')
    expect(card.querySelector('.dsh-card__window')?.textContent).toBe('showing 3 of 41 lines from line 3')
  })

  it('renders grouped search matches with a capped indicator', () => {
    const card = renderCard(live[4]!)
    expect(card.querySelector('.dsh-card__match-file-path')?.textContent).toBe('src/tool-view.ts')
    expect([...card.querySelectorAll('.dsh-card__match-no')].map(no => no.textContent)).toEqual(['12', '31'])
    const count = card.querySelector('.dsh-card__count')
    expect(count?.getAttribute('data-truncated')).toBe('true')
    expect(count?.textContent).toBe('showing 2 of 9 matches')
  })

  it('renders a flat path list as a complete result', () => {
    const card = renderCard(live[5]!)
    expect([...card.querySelectorAll('.dsh-card__path')].map(path => path.textContent))
      .toEqual(['vitest.config.ts', 'tsdown.config.ts'])
    expect(card.querySelector('.dsh-card__count')?.textContent).toBe('2 matches')
  })

  it('renders web search citations with an answer, and a bare source by URL', () => {
    const card = renderCard(live[6]!)
    expect(card.querySelector('.dsh-card__answer')?.textContent).toBe('AG-UI is a protocol for agent-user interaction.')
    const sources = card.querySelectorAll('.dsh-card__source')
    expect(sources[0]?.querySelector('.dsh-card__source-url')?.textContent).toBe('AG-UI protocol')
    expect(sources[0]?.querySelector('.dsh-card__source-snippet')?.textContent).toBe('Agent-user interaction protocol')
    expect(sources[0]?.querySelector('.dsh-card__source-date')?.textContent).toBe('2026-01-15')
    expect(sources[1]?.querySelector('.dsh-card__source-url')?.textContent).toBe('https://example.com/agui-guide')
    expect(sources[1]?.querySelector('.dsh-card__source-snippet')?.textContent).toBe('A short guide')
    expect(sources[1]?.querySelector('.dsh-card__source-date')).toBeNull()
    expect(card.querySelector('.dsh-card__truncated')?.textContent).toBe('result truncated')
  })

  it('renders a web fetch summary with a success status and no truncation', () => {
    const card = renderCard(live[7]!)
    expect(card.querySelector('.dsh-card__fetch-url')?.getAttribute('href')).toBe('https://ag-ui.com/')
    const status = card.querySelector('.dsh-card__status')
    expect(status?.textContent).toBe('HTTP 200')
    expect(status?.getAttribute('data-ok')).toBe('true')
    expect(card.querySelector('.dsh-card__truncated')).toBeNull()
  })

  it('renders the cold replay cards identically to the live ones', () => {
    expect(live).toHaveLength(8)
    expect(cold).toHaveLength(8)
    for (const [index, settled] of live.entries()) {
      expect(renderCard(cold[index]!).outerHTML).toBe(renderCard(settled).outerHTML)
    }
  })

  it('wraps the card in an optional layout class', () => {
    const { container } = render(<ToolViewCard envelope={live[0]!} className="stack" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toBe('stack')
    expect(wrapper.querySelector('.dsh-card')).not.toBeNull()
  })
})

describe('edge envelopes', () => {
  it('hides the generic kind badge when absent or other, and renders string raw input as-is', () => {
    const plain = renderCard(envelope('call', { card: 'generic', title: 'Bare call', rawInput: 'job-42' }))
    expect(plain.querySelector('.dsh-card__kind')).toBeNull()
    expect(plain.querySelector('.dsh-card__input')?.textContent).toBe('job-42')
    const other = renderCard(envelope('call', { card: 'generic', title: 'Other call', kind: 'other' }))
    expect(other.querySelector('.dsh-card__kind')).toBeNull()
  })

  it('renders every content block form', () => {
    const card = renderCard(envelope('call', {
      card: 'generic',
      title: 'Blocks',
      content: [
        { type: 'text', text: 'visible' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'image', attachment: { attachmentId: 'img-9', name: 'chart.png' } },
        { type: 'image', attachment: { attachmentId: 'img-7' } },
        { type: 'tool-call', id: 'x', name: 'inner', arguments: '{}' },
        { type: 'text', text: 5 },
        { type: 'image' },
        { type: 'image', attachment: {} },
      ],
    }))
    expect(card.querySelector('.dsh-card__block--text')?.textContent).toBe('visible')
    expect(card.querySelector('.dsh-card__block--reasoning')?.textContent).toBe('thinking')
    expect(card.querySelector('.dsh-card__block--tool-call')?.textContent).toContain('"name": "inner"')
    // a malformed text or image block degrades to its JSON instead of throwing
    const texts = [...card.querySelectorAll('.dsh-card__block--text')].map(block => block.textContent)
    expect(texts).toEqual(['visible', JSON.stringify({ type: 'text', text: 5 }, null, 2)])
    const images = [...card.querySelectorAll('.dsh-card__block--image')].map(block => block.textContent)
    expect(images).toEqual(['[image: chart.png]', '[image: img-7]', JSON.stringify({ type: 'image' }, null, 2), '[image: unknown attachment]'])
  })

  it('falls back to the tool name and the pending card when a result carries nothing', () => {
    const card = renderCard(envelope('result', { card: 'generic' }))
    expect(card.querySelector('.dsh-card__title')?.textContent).toBe('edge_tool')
    expect(card.querySelector('.dsh-card__blocks')).toBeNull()
  })

  it('renders a terminal call with no description or directory, and settles by signal or nothing', () => {
    const bare = renderCard(envelope('call', { card: 'terminal', title: 'npm run build' }))
    expect(bare.querySelector('.dsh-card__description')).toBeNull()
    expect(bare.querySelector('.dsh-card__cwd')).toBeNull()
    const killed = renderCard(envelope('result', { card: 'terminal', signal: 'SIGKILL' }))
    expect(killed.querySelector('.dsh-card__status')?.getAttribute('data-ok')).toBe('false')
    expect(killed.querySelector('.dsh-card__status')?.textContent).toBe('SIGKILL')
    expect(killed.querySelector('.dsh-card__output')).toBeNull()
    const failed = renderCard(envelope('result', { card: 'terminal', output: 'boom', exitCode: 1 }))
    expect(failed.querySelector('.dsh-card__status')?.getAttribute('data-ok')).toBe('false')
    const silent = renderCard(envelope('result', { card: 'terminal' }))
    expect(silent.querySelector('.dsh-card__status')).toBeNull()
  })

  it('renders a diff result by tool name when untitled, and a diff call without locations', () => {
    const result = renderCard(envelope('result', { card: 'diff', diffs: [{ path: 'a.txt', oldText: null, newText: 'new\n' }] }))
    expect(result.querySelector('.dsh-card__title')?.textContent).toBe('edge_tool')
    const call = renderCard(envelope('call', { card: 'diff', title: 'Edit', diffs: [{ path: 'b.txt', oldText: 'x\n', newText: 'y\n' }] }))
    expect(call.querySelector('.dsh-card__locations')).toBeNull()
    expect(call.querySelectorAll('.dsh-card__diff-row--same')).toHaveLength(0)
  })

  it('renders a read window without a language hint, and an empty window at its offset', () => {
    const plain = renderCard(envelope('result', { card: 'read', path: 'notes', offset: 1, lines: [{ number: 1, text: 'only' }], totalLines: 1 }))
    expect(plain.querySelector('.dsh-card__code')?.getAttribute('data-lang')).toBeNull()
    const empty = renderCard(envelope('result', { card: 'read', path: 'big.log', offset: 3, lines: [], totalLines: 10 }))
    expect(empty.querySelector('.dsh-card__window')?.textContent).toBe('showing 0 of 10 lines from line 3')
  })

  it('renders a single untruncated match and an untitled search by tool name', () => {
    const single = renderCard(envelope('result', { card: 'search', shape: 'paths', paths: ['one.ts'], truncated: false, total: 1 }))
    expect(single.querySelector('.dsh-card__count')?.textContent).toBe('1 match')
    const capped = renderCard(envelope('result', { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 5 }))
    expect(capped.querySelector('.dsh-card__count')?.textContent).toBe('showing 2 of 5 matches')
    const untitled = renderCard(envelope('result', {
      card: 'search',
      shape: 'matches',
      files: [{ path: 'one.ts', matches: [{ lineNumber: 2, line: 'hit' }] }],
      truncated: false,
      total: 1,
    }, 'find_tool'))
    expect(untitled.querySelector('.dsh-card__title')?.textContent).toBe('find_tool')
    expect(untitled.querySelector('.dsh-card__count')?.textContent).toBe('1 match')
  })

  it('renders a web search without an answer and a fetch failure', () => {
    const bare = renderCard(envelope('result', { card: 'web', kind: 'search', sources: [{ url: 'https://x.dev/' }], truncated: false }))
    expect(bare.querySelector('.dsh-card__answer')).toBeNull()
    expect(bare.querySelector('.dsh-card__source-url')?.textContent).toBe('https://x.dev/')
    expect(bare.querySelector('.dsh-card__source-snippet')).toBeNull()
    expect(bare.querySelector('.dsh-card__truncated')).toBeNull()
    const missing = renderCard(envelope('result', { card: 'web', kind: 'fetch', url: 'https://x.dev/gone', statusCode: 404, truncated: false }))
    expect(missing.querySelector('.dsh-card__status')?.getAttribute('data-ok')).toBe('false')
  })

  it('degrades an unrecognized card kind to raw JSON in both phases', () => {
    for (const phase of ['call', 'result'] as const) {
      const card = renderCard(envelope(phase, { card: 'holo', beams: 3 } as ToolViewEnvelope['card']))
      expect(card.className).toContain('dsh-card--unknown')
      expect(card.querySelector('.dsh-card__title')?.textContent).toBe('edge_tool')
      expect(card.querySelector('.dsh-card__input')?.textContent).toContain('"beams": 3')
    }
  })
})
