import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildItems } from '../src/model.ts'
import { ChecklistStore } from '../src/store.ts'

let root: string
let store: ChecklistStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-checklist-'))
  store = new ChecklistStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ChecklistStore', () => {
  it('starts with an empty document', async () => {
    const doc = await store.prime('session-a')
    expect(doc.lists).toEqual([])
    expect(doc.sessionId).toBe('session-a')
  })

  it('persists an update and reads it back from a cold store', async () => {
    await store.update('session-a', (doc) => {
      doc.lists.push({
        id: 'l1',
        title: 'Release',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: buildItems(['a', 'b']),
      })
    })

    const cold = new ChecklistStore(root)
    const doc = await cold.prime('session-a')
    expect(doc.lists).toHaveLength(1)
    expect(doc.lists[0]!.title).toBe('Release')
    expect(doc.lists[0]!.items[1]!.text).toBe('b')
  })

  it('does not corrupt the cache when a mutation throws', async () => {
    await store.update('session-a', (doc) => {
      doc.lists.push({ id: 'l1', title: 'T', createdAt: '', items: buildItems(['x']) })
    })

    await expect(store.update('session-a', () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    expect(store.peek('session-a')?.lists).toHaveLength(1)
  })

  it('serializes concurrent updates for one session', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update('session-a', (doc) => {
          doc.lists.push({
            id: `l${index + 1}`,
            title: `list ${index}`,
            createdAt: '',
            items: buildItems(['x']),
          })
        })),
    )

    const doc = await store.prime('session-a')
    expect(doc.lists).toHaveLength(10)
  })

  it('keeps sessions isolated', async () => {
    await store.update('session-a', (doc) => {
      doc.lists.push({ id: 'l1', title: 'A', createdAt: '', items: buildItems(['a']) })
    })
    expect((await store.prime('session-b')).lists).toHaveLength(0)
  })

  it('rejects unsafe session ids', async () => {
    await expect(store.prime('../../etc/passwd')).rejects.toThrow(/unsafe session id/)
  })

  it('recovers from a corrupt document', async () => {
    await store.update('session-a', (doc) => {
      doc.lists.push({ id: 'l1', title: 'A', createdAt: '', items: buildItems(['a']) })
    })
    await writeFile(join(root, 'sessions', 'session-a.json'), '{ not json', 'utf8')

    const cold = new ChecklistStore(root)
    expect((await cold.prime('session-a')).lists).toEqual([])
  })

  it('round-trips templates', async () => {
    await store.writeTemplates({ release: ['a', '  b'] })
    expect(await store.readTemplates()).toEqual({ release: ['a', '  b'] })

    const raw = JSON.parse(await readFile(join(root, 'templates.json'), 'utf8')) as unknown
    expect(raw).toEqual({ release: ['a', '  b'] })
  })

  it('ignores malformed templates', async () => {
    await writeFile(join(root, 'templates.json'), JSON.stringify({ good: ['a'], bad: [1, 2] }), 'utf8')
    expect(await store.readTemplates()).toEqual({ good: ['a'] })
  })
})
