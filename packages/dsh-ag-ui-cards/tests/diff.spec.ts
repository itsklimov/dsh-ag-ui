import { describe, expect, it } from 'vitest'
import { diffRows } from '../src/diff.ts'

/** Line diff rows of the diff card. */
describe('diffRows', () => {
  it('renders a create as one run of additions', () => {
    expect(diffRows(null, 'hello\nworld\n')).toEqual([
      { kind: 'add', newLine: 1, text: 'hello' },
      { kind: 'add', newLine: 2, text: 'world' },
    ])
  })

  it('renders equal texts as unchanged rows numbered on both sides', () => {
    expect(diffRows('a\nb', 'a\nb')).toEqual([
      { kind: 'same', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'same', oldLine: 2, newLine: 2, text: 'b' },
    ])
  })

  it('renders an edit as a removal beside its addition', () => {
    expect(diffRows('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'del', oldLine: 2, text: 'b' },
      { kind: 'add', newLine: 2, text: 'x' },
      { kind: 'same', oldLine: 3, newLine: 3, text: 'c' },
    ])
  })

  it('renders a shortened file with trailing removals', () => {
    expect(diffRows('a\nb', 'a')).toEqual([
      { kind: 'same', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'del', oldLine: 2, text: 'b' },
    ])
  })

  it('renders a lengthened file with trailing additions', () => {
    expect(diffRows('a', 'a\nb\n')).toEqual([
      { kind: 'same', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'add', newLine: 2, text: 'b' },
    ])
  })

  it('treats empty texts as no lines', () => {
    expect(diffRows(null, '')).toEqual([])
    expect(diffRows('', '')).toEqual([])
    expect(diffRows('', 'a')).toEqual([{ kind: 'add', newLine: 1, text: 'a' }])
    expect(diffRows('a', '')).toEqual([{ kind: 'del', oldLine: 1, text: 'a' }])
  })
})
