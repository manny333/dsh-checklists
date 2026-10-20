/**
 * Spawn-free smoke test.
 *
 * Vitest needs child processes; some sandboxes (including the one this plugin
 * was authored in) deny `spawn` with EPERM. This script exercises the same
 * behaviours in-process against the compiled `lib/`, so the build can still be
 * verified where a test runner cannot start.
 *
 *   node scripts/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildItems, checkRename, countItems, countState, findItemById, findList, mintId, nextItem, removeItemById, resolveRef, toLines } from '../lib/model.js'
import { decideNudge } from '../lib/gate.js'
import { renderDigest } from '../lib/digest.js'
import { ChecklistStore } from '../lib/store.js'
import { toPublicState } from '../lib/state.js'
import { serveItemUpdate, serveState } from '../lib/route.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const makeList = (id, lines) => ({
  id,
  title: `list ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  items: buildItems(lines),
})

await check('mintId never reuses a freed id below the high-water mark', () => {
  assert.equal(mintId('i', new Set()), 'i1')
  assert.equal(mintId('i', new Set(['i1', 'i3'])), 'i4')
  assert.equal(mintId('i', new Set(['i2'])), 'i3')
})

await check('buildItems nests by indentation', () => {
  const items = buildItems(['deploy', '  staging', '    smoke', '  prod', 'done'])
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].children.map((child) => child.text), ['staging', 'prod'])
  assert.deepEqual(items[0].children[0].children.map((child) => child.text), ['smoke'])
  assert.equal(items[1].text, 'done')
})

await check('toLines round-trips the tree', () => {
  const first = buildItems(['a', '  b', '    c', 'd'])
  assert.deepEqual(buildItems(toLines(first)), first)
})

await check('countItems counts the whole tree', () => {
  const items = buildItems(['a', '  b', '  c'])
  items[0].state = 'done'
  items[0].children[0].state = 'done'
  assert.deepEqual(countItems(items), { total: 3, done: 2 })
})

await check('resolveRef reports ambiguity instead of guessing', () => {
  const lists = [makeList('l1', ['Migrar DB']), makeList('l2', ['Migrar DB'])]
  assert.equal(resolveRef(lists, 'Migrar DB').kind, 'ambiguous')
  assert.equal(resolveRef(lists, 'Migrar DB', 'l2').kind, 'hit')
  assert.equal(resolveRef(lists, 'nope').kind, 'miss')
})

await check('findList resolves by id or exact title', () => {
  const lists = [makeList('l1', ['a']), { ...makeList('l2', ['b']), title: 'Release 2.3' }]
  assert.equal(findList(lists, 'l1').id, 'l1')
  assert.equal(findList(lists, 'release 2.3').id, 'l2')
  assert.equal(findList(lists, 'Release'), undefined)
  assert.equal(findList(lists, '  '), undefined)
})

await check('removeItemById removes a nested item with its subtree', () => {
  const items = buildItems(['a', '  b', '    c', 'd'])
  const removed = removeItemById(items, 'i2')
  assert.equal(removed.text, 'b')
  assert.equal(countItems([removed]).total, 2)
  assert.equal(items.length, 2)
  assert.equal(items[0].children.length, 0)
  assert.equal(removeItemById(items, 'nope'), undefined)
})

await check('resolveRef accepts a list title as the scope', () => {
  const lists = [
    { ...makeList('l1', ['a']), title: 'Release' },
    { ...makeList('l2', ['a']), title: 'QA' },
  ]
  const byId = resolveRef(lists, 'a', 'l2')
  const byTitle = resolveRef(lists, 'a', 'QA')
  assert.equal(byId.kind, 'hit')
  assert.equal(byTitle.kind, 'hit')
  assert.equal(byTitle.hit.list.id, 'l2')
  assert.equal(resolveRef(lists, 'a', 'nope').kind, 'miss')
})

await check('decideNudge only fires when work happened and was not recorded', () => {
  assert.equal(decideNudge({ mutated: false, checklistWrite: false }, 3).nudge, false)
  assert.equal(decideNudge({ mutated: true, checklistWrite: true }, 3).nudge, false)
  assert.equal(decideNudge({ mutated: true, checklistWrite: false }, 0).nudge, false)

  const yes = decideNudge({ mutated: true, checklistWrite: false }, 2)
  assert.equal(yes.nudge, true)
  assert.match(yes.reason, /2 item/)
})

await check('countState counts across the tree', () => {
  const items = buildItems(['a', '  b', '  c'])
  items[0].children[0].state = 'doing'
  items[0].children[1].state = 'doing'
  assert.equal(countState(items, 'doing'), 2)
  assert.equal(countState(items, 'todo'), 1)
})

await check('checkRename rejects empties and collisions, allows a case-only no-op', () => {
  const lists = [
    { ...makeList('l1', ['a']), title: 'Release' },
    { ...makeList('l2', ['b']), title: 'QA' },
  ]
  assert.equal(checkRename(lists, 'l1', '   ').kind, 'empty')
  assert.equal(checkRename(lists, 'nope', 'X').kind, 'missing')
  assert.equal(checkRename(lists, 'l1', 'qa').kind, 'duplicate')
  assert.equal(checkRename(lists, 'l1', 'RELEASE').kind, 'ok')

  const renamed = checkRename(lists, 'Release', 'Release 2.3')
  assert.equal(renamed.kind, 'ok')
  assert.equal(renamed.from, 'Release')
  assert.equal(renamed.to, 'Release 2.3')
})

await check('findItemById finds nested items', () => {
  const lists = [makeList('l1', ['a', '  b'])]
  const nested = lists[0].items[0].children[0]
  assert.equal(findItemById(lists, nested.id).item.text, 'b')
  assert.equal(findItemById(lists, 'nope'), undefined)
})

await check('nextItem descends into container items', () => {
  const lists = [makeList('l1', ['a', '  b', '  c', 'd'])]

  // 'a' has children, so it is a container: the next action is its first leaf.
  assert.equal(nextItem(lists).next.item.text, 'b')
  assert.deepEqual(nextItem(lists).next.path, ['a'])

  // A container's own state does not change that.
  lists[0].items[0].state = 'doing'
  assert.equal(nextItem(lists).next.item.text, 'b')

  // Once the children close, the parent is a leaf and becomes the next action.
  for (const child of lists[0].items[0].children) child.state = 'done'
  assert.equal(nextItem(lists).next.item.text, 'a')

  // A done subtree is skipped entirely.
  lists[0].items[0].state = 'done'
  assert.equal(nextItem(lists).next.item.text, 'd')

  // Blocked leaves are skipped and counted.
  lists[0].items[1].state = 'blocked'
  assert.equal(nextItem(lists).next, undefined)
  assert.equal(nextItem(lists).blocked, 1)
})

await check('digest is empty without checklists', () => {
  assert.equal(renderDigest(undefined), '')
  assert.equal(renderDigest({ version: 1, sessionId: 's', lists: [] }), '')
})

await check('digest shows counts, glyphs and the rule', () => {
  const doc = { version: 1, sessionId: 's', lists: [makeList('l1', ['Migrar DB', 'Deploy'])] }
  doc.lists[0].items[0].state = 'done'
  const out = renderDigest(doc)
  assert.match(out, /Release|list l1 · 1\/2/)
  assert.match(out, /\[x\] Migrar DB/)
  assert.match(out, /\[ \] Deploy/)
  assert.match(out, /checklist_check/)
})

await check('digest shows pending items before done ones', () => {
  const doc = { version: 1, sessionId: 's', lists: [makeList('l1', ['a', 'b'])] }
  doc.lists[0].items[0].state = 'done'
  const out = renderDigest(doc)
  assert.ok(out.indexOf('[ ] b') < out.indexOf('[x] a'))
})

await check('digest respects the line cap', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `item ${index}`)
  const out = renderDigest({ version: 1, sessionId: 's', lists: [makeList('l1', lines)] }, { maxLines: 6 })
  assert.ok(out.split('\n').length <= 9)
  assert.match(out, /checklist_list/)
})

await check('digest shares the line budget across lists', () => {
  const session = {
    version: 1,
    sessionId: 's',
    lists: [
      { id: 'l1', title: 'Grande', createdAt: '', items: buildItems(Array.from({ length: 40 }, (_, i) => `a${i}`)) },
      { id: 'l2', title: 'Segunda', createdAt: '', items: buildItems(['b1', 'b2', 'b3']) },
    ],
  }
  const lines = renderDigest(session, { maxLines: 12 }).split('\n')
  const second = lines.findIndex((line) => line.includes('Segunda · 0/3'))
  assert.ok(second > 0, 'la segunda lista debe aparecer')
  assert.ok(lines.some((line) => line.includes('b1')), 'y mostrar al menos un ítem')
  assert.ok(lines.length <= 14, 'sin pasarse del presupuesto')
})

await check('buildItems extends an existing id set', () => {
  const used = new Set(['i1', 'i2'])
  const items = buildItems(['x', '  y'], used)
  assert.deepEqual(items.map((item) => item.id), ['i3'])
  assert.equal(items[0].children[0].id, 'i4')
})

await check('store round-trips a session across instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checklist-smoke-'))
  try {
    const store = new ChecklistStore(root)
    await store.update('session-a', (doc) => {
      doc.lists.push(makeList('l1', ['a', 'b']))
    })
    const cold = new ChecklistStore(root)
    const doc = await cold.prime('session-a')
    assert.equal(doc.lists.length, 1)
    assert.equal(doc.lists[0].items[1].text, 'b')
    assert.equal(await cold.prime('session-b').then((other) => other.lists.length), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store serializes concurrent updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checklist-smoke-'))
  try {
    const store = new ChecklistStore(root)
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update('session-a', (doc) => {
          doc.lists.push(makeList(`l${index + 1}`, ['x']))
        })),
    )
    assert.equal((await store.prime('session-a')).lists.length, 10)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('store rejects unsafe session ids', async () => {
  const store = new ChecklistStore(join(tmpdir(), 'dsh-checklist-smoke-unused'))
  await assert.rejects(() => store.prime('../../etc/passwd'), /unsafe session id/)
})

await check('public state strips internals and totals the tree', () => {
  const doc = { version: 1, sessionId: 's1', lists: [makeList('l1', ['a', '  b', 'c'])] }
  doc.lists[0].items[0].state = 'done'
  const state = toPublicState(doc)
  assert.equal(state.sessionId, 's1')
  assert.equal(state.version, undefined)
  assert.deepEqual(state.counts, { lists: 1, total: 3, done: 1 })
  assert.equal(state.lists[0].items[0].children[0].text, 'b')
})

function fakeRequest(method, url) {
  return { method, url }
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(payload) {
      this.body = payload ? payload.toString('utf8') : ''
    },
  }
}

await check('state route rejects a missing session', async () => {
  const res = fakeResponse()
  await serveState(fakeRequest('GET', '/dsh-checklist/state'), res, new ChecklistStore(join(tmpdir(), 'dsh-checklist-smoke-unused')))
  assert.equal(res.status, 400)
})

await check('state route rejects unsafe ids without echoing them', async () => {
  const res = fakeResponse()
  await serveState(fakeRequest('GET', '/dsh-checklist/state?session=../../evil'), res, new ChecklistStore(join(tmpdir(), 'dsh-checklist-smoke-unused')))
  assert.equal(res.status, 400)
  assert.ok(!res.body.includes('evil'))
})

await check('state route rejects non-GET', async () => {
  const res = fakeResponse()
  await serveState(fakeRequest('POST', '/dsh-checklist/state?session=s1'), res, new ChecklistStore(join(tmpdir(), 'dsh-checklist-smoke-unused')))
  assert.equal(res.status, 405)
})

await check('state route serves a session document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checklist-smoke-'))
  try {
    const store = new ChecklistStore(root)
    await store.update('session-a', (doc) => {
      doc.lists.push(makeList('l1', ['a', 'b']))
    })
    const res = fakeResponse()
    await serveState(fakeRequest('GET', '/dsh-checklist/state?session=session-a'), res, store)
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    const body = JSON.parse(res.body)
    assert.equal(body.sessionId, 'session-a')
    assert.equal(body.counts.total, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function fakePost(url, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
}

await check('item route edits, refuses conflicts, unknown ids and empty text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checklist-smoke-'))
  try {
    const store = new ChecklistStore(root)
    await store.update('s1', (doc) => {
      doc.lists.push(makeList('l1', ['a', 'b']))
    })
    const itemId = (await store.prime('s1')).lists[0].items[0].id

    let res = fakeResponse()
    await serveItemUpdate(
      fakePost('/dsh-checklist/item', { session: 's1', itemId, text: 'a2', expectedText: 'a' }),
      res,
      store,
    )
    assert.equal(res.status, 200)
    assert.equal((await store.prime('s1')).lists[0].items[0].text, 'a2')

    res = fakeResponse()
    await serveItemUpdate(
      fakePost('/dsh-checklist/item', { session: 's1', itemId, text: 'x', expectedText: 'stale' }),
      res,
      store,
    )
    assert.equal(res.status, 409)

    res = fakeResponse()
    await serveItemUpdate(
      fakePost('/dsh-checklist/item', { session: 's1', itemId: 'nope', text: 'x' }),
      res,
      store,
    )
    assert.equal(res.status, 404)

    res = fakeResponse()
    await serveItemUpdate(
      fakePost('/dsh-checklist/item', { session: 's1', itemId, text: '   ' }),
      res,
      store,
    )
    assert.equal(res.status, 400)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
