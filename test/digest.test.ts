import { describe, expect, it } from 'vitest'
import { renderDigest } from '../src/digest.ts'
import { buildItems, type SessionDoc } from '../src/model.ts'

function doc(lists: Array<{ title: string; lines: string[] }>): SessionDoc {
  return {
    version: 1,
    sessionId: 's1',
    lists: lists.map((entry, index) => ({
      id: `l${index + 1}`,
      title: entry.title,
      createdAt: '2026-01-01T00:00:00.000Z',
      items: buildItems(entry.lines),
    })),
  }
}

describe('renderDigest', () => {
  it('renders nothing without checklists', () => {
    expect(renderDigest(undefined)).toBe('')
    expect(renderDigest(doc([]))).toBe('')
  })

  it('renders counts, glyphs and the rule', () => {
    const session = doc([{ title: 'Release', lines: ['Migrar DB', 'Deploy'] }])
    session.lists[0]!.items[0]!.state = 'done'

    const out = renderDigest(session)
    expect(out).toContain('## Session checklist')
    expect(out).toContain('Release · 1/2')
    expect(out).toContain('[x] Migrar DB')
    expect(out).toContain('[ ] Deploy')
    expect(out.trimEnd().endsWith('Mark each item with checklist_check as soon as you finish it.')).toBe(true)
  })

  it('shows pending items before done ones', () => {
    const session = doc([{ title: 'T', lines: ['a', 'b'] }])
    session.lists[0]!.items[0]!.state = 'done'
    const out = renderDigest(session)
    expect(out.indexOf('[ ] b')).toBeLessThan(out.indexOf('[x] a'))
  })

  it('caps the number of lines', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `item ${index}`)
    const out = renderDigest(doc([{ title: 'Big', lines }]), { maxLines: 6 })
    const body = out.split('\n')
    // header + capped body + elision + rule
    expect(body.length).toBeLessThanOrEqual(9)
    expect(out).toContain('checklist_list')
  })

  it('caps items per list', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `item ${index}`)
    const out = renderDigest(doc([{ title: 'Big', lines }]), { maxLines: 100 })
    expect(out).toContain('more (use checklist_list)')
  })

  it('does not render deeper than two levels', () => {
    const session = doc([{ title: 'T', lines: ['a', '  b', '    c', '      d'] }])
    const out = renderDigest(session, { maxLines: 100 })
    expect(out).toContain('[ ] c')
    expect(out).not.toContain('d')
  })

  it('marks blocked and in-progress items distinctly', () => {
    const session = doc([{ title: 'T', lines: ['a', 'b'] }])
    session.lists[0]!.items[0]!.state = 'blocked'
    session.lists[0]!.items[1]!.state = 'doing'
    const out = renderDigest(session)
    expect(out).toContain('[!] a')
    expect(out).toContain('[~] b')
  })
})
