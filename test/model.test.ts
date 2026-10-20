import { describe, expect, it } from 'vitest'
import {
  buildItems,
  countItems,
  flatten,
  mintId,
  resolveRef,
  toLines,
  type Checklist,
} from '../src/model.ts'

function list(id: string, items: ReturnType<typeof buildItems>): Checklist {
  return { id, title: `list ${id}`, createdAt: '2026-01-01T00:00:00.000Z', items }
}

describe('mintId', () => {
  it('returns the first free suffix', () => {
    expect(mintId('i', new Set())).toBe('i1')
    expect(mintId('i', new Set(['i1', 'i2']))).toBe('i3')
    expect(mintId('i', new Set(['i1', 'i3']))).toBe('i2')
  })
})

describe('buildItems', () => {
  it('builds a flat list when nothing is indented', () => {
    const items = buildItems(['a', 'b'])
    expect(items.map((item) => item.text)).toEqual(['a', 'b'])
    expect(items.every((item) => item.children.length === 0)).toBe(true)
    expect(items.map((item) => item.id)).toEqual(['i1', 'i2'])
  })

  it('nests by indentation and pops back to the right parent', () => {
    const items = buildItems(['deploy', '  staging', '    smoke', '  prod', 'done'])
    expect(items).toHaveLength(2)
    expect(items[0]!.text).toBe('deploy')
    expect(items[0]!.children.map((child) => child.text)).toEqual(['staging', 'prod'])
    expect(items[0]!.children[0]!.children.map((child) => child.text)).toEqual(['smoke'])
    expect(items[1]!.text).toBe('done')
  })

  it('ignores blank lines and trims text', () => {
    const items = buildItems(['  ', '  hello  ', ''])
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('hello')
  })

  it('round-trips through toLines', () => {
    const first = buildItems(['a', '  b', '    c', 'd'])
    const second = buildItems(toLines(first))
    expect(second).toEqual(first)
  })
})

describe('countItems', () => {
  it('counts the whole tree', () => {
    const items = buildItems(['a', '  b', '  c'])
    items[0]!.state = 'done'
    items[0]!.children[0]!.state = 'done'
    expect(countItems(items)).toEqual({ total: 3, done: 2 })
  })
})

describe('flatten', () => {
  it('reports depth per item', () => {
    const flat = flatten(buildItems(['a', '  b']))
    expect(flat.map((entry) => entry.depth)).toEqual([0, 1])
  })
})

describe('resolveRef', () => {
  const lists = [
    list('l1', buildItems(['Migrar DB', 'Deploy staging', '  Smoke tests'])),
    list('l2', buildItems(['Migrar DB'])),
  ]

  it('resolves by exact id', () => {
    const result = resolveRef(lists, 'i2')
    expect(result.kind).toBe('hit')
    if (result.kind !== 'hit') return
    expect(result.hit.item.text).toBe('Deploy staging')
  })

  it('resolves by exact text, case-insensitively', () => {
    const result = resolveRef(lists, 'deploy staging')
    expect(result.kind).toBe('hit')
    if (result.kind !== 'hit') return
    expect(result.hit.list.id).toBe('l1')
  })

  it('resolves nested items by text', () => {
    const result = resolveRef(lists, 'Smoke tests')
    expect(result.kind).toBe('hit')
    if (result.kind !== 'hit') return
    expect(result.hit.item.text).toBe('Smoke tests')
  })

  it('respects the list scope', () => {
    const result = resolveRef(lists, 'Migrar DB', 'l2')
    expect(result.kind).toBe('hit')
    if (result.kind !== 'hit') return
    expect(result.hit.list.id).toBe('l2')
  })

  it('reports ambiguity instead of guessing', () => {
    const result = resolveRef(lists, 'Migrar DB')
    expect(result.kind).toBe('ambiguous')
  })

  it('resolves a unique prefix', () => {
    const result = resolveRef(lists, 'Deploy')
    expect(result.kind).toBe('hit')
  })

  it('misses cleanly', () => {
    expect(resolveRef(lists, 'nope').kind).toBe('miss')
    expect(resolveRef(lists, '   ').kind).toBe('miss')
  })
})
