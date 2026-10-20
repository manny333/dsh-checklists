/**
 * The compact checklist view injected into the model context every turn.
 *
 * This is the piece that removes the "ask me for the checklist again" loop:
 * the digest is re-evaluated per assembly, so the model always sees current
 * progress without anyone restating it.
 *
 * The rendering is deliberately small and stable — pending items first, a
 * per-list line budget, and a hard total cap. A checklist that eats the context
 * window would be self-defeating.
 */

import { countItems, flatten, type ItemState, type SessionDoc } from './model.js'

const GLYPH: Record<ItemState, string> = {
  done: '[x]',
  doing: '[~]',
  todo: '[ ]',
  blocked: '[!]',
}

/** Absolute cap per checklist, whatever the shared budget allows. */
const PER_LIST_CAP = 8
/** Deepest nesting the digest renders. */
const MAX_DEPTH = 2

export interface DigestOptions {
  /** Hard cap on rendered body lines (header and rule excluded). Default 12. */
  maxLines?: number
  /** Behavioral line shown last. */
  rule?: string
}

const DEFAULT_RULE = 'Mark each item with checklist_check as soon as you finish it.'

/**
 * Render the session's checklists as a compact prompt block.
 *
 * Each checklist gets an equal share of the line budget. Giving the first list
 * the whole budget starved the rest: with two lists the second showed a single
 * line, and a third never appeared at all.
 *
 * @param doc - the session document, or undefined when nothing is cached.
 * @param options - line budget and rule text.
 * @returns the digest, or `''` when the session has no checklists.
 */
export function renderDigest(doc: SessionDoc | undefined, options: DigestOptions = {}): string {
  if (!doc || doc.lists.length === 0) return ''

  const maxLines = Math.max(4, options.maxLines ?? 12)
  const rule = options.rule ?? DEFAULT_RULE
  const body: string[] = []

  const listCount = Math.max(1, doc.lists.length)
  // One title line per list, the rest split evenly. Never below 3 lines, or a
  // list would render its title and nothing else.
  const lineBudget = Math.max(3, Math.floor(maxLines / listCount))

  for (const list of doc.lists) {
    const { total, done } = countItems(list.items)
    body.push(`${list.title} · ${done}/${total}`)

    const all = flatten(list.items).filter((entry) => entry.depth <= MAX_DEPTH)
    // Pending first: truncation must never hide unfinished work.
    const ordered = [
      ...all.filter((entry) => entry.item.state !== 'done'),
      ...all.filter((entry) => entry.item.state === 'done'),
    ]

    const room = Math.max(1, Math.min(PER_LIST_CAP, lineBudget - 1))
    if (ordered.length > room) {
      // Reserve one of the slots for the elision notice, so every list costs
      // exactly the same number of lines and the total cap still holds.
      const keep = Math.max(0, room - 1)
      for (const entry of ordered.slice(0, keep)) {
        body.push(`  ${'  '.repeat(entry.depth)}${GLYPH[entry.item.state]} ${entry.item.text}`)
      }
      body.push(`  … ${ordered.length - keep} more (use checklist_list)`)
    } else {
      for (const entry of ordered) {
        body.push(`  ${'  '.repeat(entry.depth)}${GLYPH[entry.item.state]} ${entry.item.text}`)
      }
    }
  }

  if (body.length > maxLines) {
    const hidden = body.length - maxLines
    body.length = maxLines
    body.push(`(+${hidden} more lines — checklist_list for the full tree)`)
  }

  return ['## Session checklist', ...body, rule].join('\n')
}
