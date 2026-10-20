/**
 * The public JSON shape the sidebar reads.
 *
 * Deliberately separate from the stored document: the client gets no `version`
 * field, no future internals, and nothing it could mistake for a write channel.
 */

import { countItems, type Checklist, type ChecklistItem, type SessionDoc } from './model.js'

export interface PublicItem {
  id: string
  text: string
  state: string
  children: PublicItem[]
}

export interface PublicList {
  id: string
  title: string
  createdAt: string
  items: PublicItem[]
}

export interface PublicCounts {
  lists: number
  total: number
  done: number
}

export interface PublicState {
  sessionId: string
  lists: PublicList[]
  counts: PublicCounts
}

function toPublicItem(item: ChecklistItem): PublicItem {
  return {
    id: item.id,
    text: item.text,
    state: item.state,
    children: item.children.map(toPublicItem),
  }
}

function toPublicList(list: Checklist): PublicList {
  return {
    id: list.id,
    title: list.title,
    createdAt: list.createdAt,
    items: list.items.map(toPublicItem),
  }
}

export function toPublicState(doc: SessionDoc): PublicState {
  const counts: PublicCounts = { lists: doc.lists.length, total: 0, done: 0 }
  for (const list of doc.lists) {
    const listCounts = countItems(list.items)
    counts.total += listCounts.total
    counts.done += listCounts.done
  }
  return {
    sessionId: doc.sessionId,
    lists: doc.lists.map(toPublicList),
    counts,
  }
}
