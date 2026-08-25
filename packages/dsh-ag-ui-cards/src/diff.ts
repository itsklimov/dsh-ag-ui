/**
 * Line diff used by the diff card: turn one file's prior and next text into
 * labelled rows a renderer lists in order.
 * @module dsh-ag-ui-cards/src/diff
 */

/** One row of a rendered diff: unchanged context, a removed line, or an added line. */
export interface DiffRow {
  readonly kind: 'same' | 'del' | 'add'
  /** 1-based line number in the prior text; undefined on an added line. */
  readonly oldLine?: number
  /** 1-based line number in the next text; undefined on a removed line. */
  readonly newLine?: number
  readonly text: string
}

/** Split text into lines without a trailing empty element for a final newline. */
function lines(text: string): string[] {
  if (text === '') return []
  const split = text.split('\n')
  return split.at(-1) === '' ? split.slice(0, -1) : split
}

/**
 * Diff two texts line by line (a longest-common-subsequence walk, sized for
 * card-scale texts). A prior of `null` — a create or an overwrite — is one
 * run of additions.
 */
export function diffRows(oldText: string | null, newText: string): DiffRow[] {
  const before = lines(oldText ?? '')
  const after = lines(newText)
  const rows: DiffRow[] = []

  // lengths[i][j] = LCS length of before[i..] and after[j..]
  const zeros = (): number[] => Array.from({ length: after.length + 1 }, () => 0)
  const lengths: number[][] = Array.from({ length: before.length + 1 }, zeros)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = before[i] === after[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }

  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'same', oldLine: i + 1, newLine: j + 1, text: after[j]! })
      i += 1
      j += 1
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      rows.push({ kind: 'del', oldLine: i + 1, text: before[i]! })
      i += 1
    } else {
      rows.push({ kind: 'add', newLine: j + 1, text: after[j]! })
      j += 1
    }
  }
  while (i < before.length) {
    rows.push({ kind: 'del', oldLine: i + 1, text: before[i]! })
    i += 1
  }
  while (j < after.length) {
    rows.push({ kind: 'add', newLine: j + 1, text: after[j]! })
    j += 1
  }
  return rows
}
