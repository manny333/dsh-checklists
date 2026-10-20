/**
 * Pure data model for session-scoped checklists.
 *
 * Nothing in this module imports a DSH package: the tree shape, the id
 * allocation, and the reference resolver are unit-testable without a running
 * harness.
 */

export type ItemState = 'todo' | 'doing' | 'done' | 'blocked'

export const ITEM_STATES: readonly ItemState[] = ['todo', 'doing', 'done', 'blocked']

export interface ChecklistItem {
  id: string
  text: string
  state: ItemState
  children: ChecklistItem[]
}

export interface Checklist {
  id: string
  title: string
  createdAt: string
  items: ChecklistItem[]
}

export interface SessionDoc {
  version: 1
  sessionId: string
  lists: Checklist[]
}

export function emptyDoc(sessionId: string): SessionDoc {
  return { version: 1, sessionId, lists: [] }
}

/** Mint the next `<prefix>N` identifier that is not already in `used`. */
export function mintId(prefix: string, used: ReadonlySet<string>): string {
  let n = 1
  while (used.has(`${prefix}${n}`)) n += 1
  return `${prefix}${n}`
}

/**
 * Build an item tree from plain lines.
 *
 * A line indented with two leading spaces per level nests under the previous
 * shallower line. This is the format the model writes, and the format
 * {@link toLines} round-trips.
 *
 * @param lines - item texts, optionally indented.
 * @param used - id set to extend; pass the ids already present when appending
 *   to an existing checklist, or ids will collide.
 * @returns the root items, with ids assigned depth-first.
 */
export function buildItems(
  lines: readonly string[],
  used: Set<string> = new Set<string>(),
): ChecklistItem[] {
  const roots: ChecklistItem[] = []
  const stack: Array<{ indent: number; node: ChecklistItem }> = []

  for (const raw of lines) {
    const text = raw.trim()
    if (text.length === 0) continue
    const indent = raw.length - raw.trimStart().length

    const node: ChecklistItem = { id: mintId('i', used), text, state: 'todo', children: [] }
    used.add(node.id)

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)

    stack.push({ indent, node })
  }

  return roots
}

/** Render an item tree back to indented lines (inverse of {@link buildItems}). */
export function toLines(items: readonly ChecklistItem[], depth = 0): string[] {
  const out: string[] = []
  for (const item of items) {
    out.push(`${'  '.repeat(depth)}${item.text}`)
    out.push(...toLines(item.children, depth + 1))
  }
  return out
}

export interface FlatItem {
  item: ChecklistItem
  depth: number
}

/** Depth-first flattening, carrying each item's nesting depth. */
export function flatten(items: readonly ChecklistItem[], depth = 0): FlatItem[] {
  const out: FlatItem[] = []
  for (const item of items) {
    out.push({ item, depth })
    out.push(...flatten(item.children, depth + 1))
  }
  return out
}

export interface ItemCounts {
  total: number
  done: number
}

export function countItems(items: readonly ChecklistItem[]): ItemCounts {
  let total = 0
  let done = 0
  for (const item of items) {
    total += 1
    if (item.state === 'done') done += 1
    const nested = countItems(item.children)
    total += nested.total
    done += nested.done
  }
  return { total, done }
}

export interface RefHit {
  list: Checklist
  item: ChecklistItem
}

export type RefResult =
  | { kind: 'hit'; hit: RefHit }
  | { kind: 'ambiguous'; candidates: RefHit[] }
  | { kind: 'miss' }

/**
 * Resolve one model-supplied reference against the session's checklists.
 *
 * Resolution order: exact id, exact case-insensitive text, unique
 * case-insensitive prefix. Ambiguity is surfaced rather than guessed: the
 * model can then pass a list id or the full text.
 *
 * @param lists - the session's checklists.
 * @param ref - a model-supplied item id, text, or prefix.
 * @param listId - optional checklist id to search within.
 * @returns the hit, the ambiguity, or a miss.
 */
export function resolveRef(
  lists: readonly Checklist[],
  ref: string,
  listId?: string,
): RefResult {
  const needles = ref.trim().toLowerCase()
  if (needles.length === 0) return { kind: 'miss' }

  const scoped = listId ? lists.filter((list) => list.id === listId) : lists
  const entries: RefHit[] = []
  for (const list of scoped) {
    for (const { item } of flatten(list.items)) entries.push({ list, item })
  }

  const byId = entries.find((entry) => entry.item.id.toLowerCase() === needles)
  if (byId) return { kind: 'hit', hit: byId }

  const exact = entries.filter((entry) => entry.item.text.toLowerCase() === needles)
  if (exact.length === 1) return { kind: 'hit', hit: exact[0]! }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact }

  const prefixed = entries.filter((entry) => entry.item.text.toLowerCase().startsWith(needles))
  if (prefixed.length === 1) return { kind: 'hit', hit: prefixed[0]! }
  if (prefixed.length > 1) return { kind: 'ambiguous', candidates: prefixed }

  return { kind: 'miss' }
}

/** Whether a value is a valid item state. */
export function isItemState(value: unknown): value is ItemState {
  return typeof value === 'string' && (ITEM_STATES as readonly string[]).includes(value)
}

/**
 * Find a checklist by id or by exact case-insensitive title.
 *
 * Ids are what the tools hand out, but a model that just created "Release 2.3"
 * will often pass the title back; accepting both avoids a pointless round trip.
 *
 * @param lists - the session's checklists.
 * @param ref - a checklist id or its exact title.
 * @returns the matching checklist, or `undefined`.
 */
export function findList(lists: readonly Checklist[], ref: string): Checklist | undefined {
  const needle = ref.trim().toLowerCase()
  if (needle.length === 0) return undefined
  return lists.find(
    (list) => list.id.toLowerCase() === needle || list.title.toLowerCase() === needle,
  )
}

/** Find one item by exact id across every list. */
export function findItemById(
  lists: readonly Checklist[],
  id: string,
): { list: Checklist; item: ChecklistItem } | undefined {
  for (const list of lists) {
    for (const { item } of flatten(list.items)) {
      if (item.id === id) return { list, item }
    }
  }
  return undefined
}

export type RenameCheck =
  | { kind: 'ok'; list: Checklist; from: string; to: string }
  | { kind: 'empty' }
  | { kind: 'missing'; available: string[] }
  | { kind: 'duplicate'; existing: string }

/**
 * Validate a checklist rename before applying it.
 *
 * Titles are how the user reads the sidebar and how `findList` resolves a
 * reference, so a rename must never create a second list with the same title.
 * Renaming a list to its own title (any case) is a no-op, not a conflict.
 *
 * @param lists - the session's checklists.
 * @param ref - checklist id or exact title.
 * @param nextTitle - the requested new title.
 * @returns the resolved list, or the reason the rename cannot proceed.
 */
export function checkRename(
  lists: readonly Checklist[],
  ref: string,
  nextTitle: string,
): RenameCheck {
  const to = nextTitle.trim()
  if (to.length === 0) return { kind: 'empty' }

  const list = findList(lists, ref)
  if (!list) {
    return { kind: 'missing', available: lists.map((entry) => `${entry.id} (${entry.title})`) }
  }

  const lower = to.toLowerCase()
  if (list.title.trim().toLowerCase() === lower) {
    return { kind: 'ok', list, from: list.title, to }
  }

  const clash = lists.find(
    (entry) => entry !== list && entry.title.trim().toLowerCase() === lower,
  )
  if (clash) return { kind: 'duplicate', existing: clash.title }

  return { kind: 'ok', list, from: list.title, to }
}

export interface NextItem {
  list: Checklist
  item: ChecklistItem
  /** Ancestor texts, outermost first; empty for a top-level item. */
  path: string[]
}

export interface NextResult {
  next?: NextItem
  /** Items that are not done, across the searched scope. */
  remaining: number
  /** Items currently blocked (their subtrees are skipped). */
  blocked: number
}

/**
 * The next item to work on, in depth-first order.
 *
 * Rules, in the order they are applied:
 * - A `done` subtree is skipped entirely.
 * - A `blocked` subtree is skipped (and counted).
 * - An item with open children is a container: descend and return its first
 *   actionable leaf. A section header is never "the next thing to do".
 * - A leaf is returned as-is.
 *
 * @param lists - the checklists to search.
 * @param listId - optional checklist id to scope the search.
 * @returns the next item (if any) plus the remaining and blocked counts.
 */
export function nextItem(lists: readonly Checklist[], listId?: string): NextResult {
  const scope = listId ? lists.filter((list) => list.id === listId) : lists

  let remaining = 0
  let blocked = 0
  for (const list of scope) {
    for (const { item } of flatten(list.items)) {
      if (item.state === 'blocked') blocked += 1
      else if (item.state !== 'done') remaining += 1
    }
  }

  for (const list of scope) {
    const found = firstOpen(list.items, [])
    if (found) return { next: { list, item: found.item, path: found.path }, remaining, blocked }
  }

  return { remaining, blocked }
}

function firstOpen(
  items: readonly ChecklistItem[],
  ancestors: string[],
): { item: ChecklistItem; path: string[] } | undefined {
  for (const item of items) {
    if (item.state === 'done' || item.state === 'blocked') continue
    const child = firstOpen(item.children, [...ancestors, item.text])
    if (child) return child
    return { item, path: ancestors }
  }
  return undefined
}
