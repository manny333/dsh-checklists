/**
 * The write surface: five tools the agent uses to keep the checklist current.
 *
 * Only the agent writes. There is no client write path, so the host document is
 * the single source of truth and the sidebar (phase 2) is a read-only mirror.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildItems,
  checkRename,
  countItems,
  findList,
  flatten,
  ITEM_STATES,
  isItemState,
  mintId,
  nextItem,
  removeItemById,
  resolveRef,
  toLines,
  type ItemState,
} from './model.js'
import type { ChecklistStore } from './store.js'
import { listWorkspaceChecklists } from './workspace.js'

export interface ToolsConfig {
  maxItemsPerList?: number
  templates?: Record<string, string[]>
  /** `off` removes the workspace lens entirely; the other modes expose the tool. */
  workspaceView?: 'off' | 'on-demand' | 'always'
  /** Maximum sibling checklists the lens returns. */
  workspaceViewLimit?: number
}

/** Ships with the plugin so a first run has something to instantiate. */
const DEFAULT_TEMPLATES: Record<string, string[]> = {
  release: [
    'Define scope',
    'Implement changes',
    '  Update tests',
    '  Review diff',
    'Deploy to staging',
    '  Smoke tests',
    '  Rollback plan',
    'Deploy to production',
    'Announce release',
  ],
  feature: [
    'Understand the requirement',
    'Design the solution',
    'Implement',
    '  Tests',
    '  Docs',
    'Review and merge',
  ],
  debug: [
    'Reproduce the bug',
    'Isolate the cause',
    'Minimal fix',
    '  Regression test',
    'Verify in staging',
  ],
  review: [
    'Read the diff',
    'Look for risks',
    '  Security',
    '  Performance',
    'Comment',
    'Approve or request changes',
  ],
}

interface RunContextLike {
  agent?: { id: string } | undefined
}

function sessionOf(exec: RunContextLike): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('checklist: this call has no session bound; checklists are per session')
  }
  return id
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function registerChecklistTools(
  ctx: Context,
  store: ChecklistStore,
  config: ToolsConfig = {},
): void {
  const maxItems = config.maxItemsPerList ?? 200

  const allTemplates = async (): Promise<Record<string, string[]>> => ({
    ...DEFAULT_TEMPLATES,
    ...(config.templates ?? {}),
    ...(await store.readTemplates()),
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_create',
    description:
      'Create a named checklist for the CURRENT session. Use it when the user asks to track a multi-step '
      + 'task, or when you are about to plan work that spans several steps and would otherwise be forgotten. '
      + 'Items are plain strings; indent a line with two leading spaces to nest it under the previous item. '
      + 'The checklist is injected into your context as a compact digest every turn, so you never need to '
      + 're-read it unless you want the full tree (checklist_list).',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short checklist title, unique within this session.',
      },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Item texts. Two leading spaces nest under the previous item.',
      },
      template: {
        type: 'string',
        description: 'Optional template name: release, feature, debug, review, or one saved earlier.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { listId: string; title: string; count: number }
        return [{ type: 'text', text: `Checklist "${result.title}" created with ${result.count} items (id ${result.listId}).` }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { title?: unknown; items?: unknown; template?: unknown }
      const sessionId = sessionOf(exec)

      return store.update(sessionId, async (doc) => {
        const title = text(input.title).trim()
        if (title.length === 0) throw new Error('checklist_create: title must not be empty')
        if (doc.lists.some((list) => list.title.toLowerCase() === title.toLowerCase())) {
          throw new Error(
            `checklist_create: a checklist named "${title}" already exists in this session; `
            + 'use checklist_list to read it, or pick another title',
          )
        }

        const templateName = text(input.template).trim()
        let templateLines: string[] | undefined
        if (templateName.length > 0) {
          templateLines = (await allTemplates())[templateName]
          if (!templateLines) {
            const available = Object.keys(await allTemplates()).sort().join(', ')
            throw new Error(`checklist_create: unknown template "${templateName}". Available: ${available}`)
          }
        }

        const explicit = Array.isArray(input.items)
          ? input.items.filter((item): item is string => typeof item === 'string')
          : []

        const items = buildItems([...(templateLines ?? []), ...explicit])
        if (items.length === 0) {
          throw new Error('checklist_create: provide items or a template name')
        }

        const count = countItems(items).total
        if (count > maxItems) {
          throw new Error(`checklist_create: ${count} items exceeds the per-list limit of ${maxItems}`)
        }

        const list = {
          id: mintId('l', new Set(doc.lists.map((entry) => entry.id))),
          title,
          createdAt: new Date().toISOString(),
          items,
        }
        doc.lists.push(list)
        return { listId: list.id, title: list.title, count }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_check',
    description:
      'Set the state of one or more checklist items in the CURRENT session. Match items by id or by their '
      + 'exact text (a unique prefix also works). Call it as soon as you finish, start, or block an item — '
      + 'the digest and the sidebar update without the user asking.',
    parameters: {
      items: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Item ids or exact item texts to update.',
      },
      state: {
        type: 'string',
        required: true,
        enum: [...ITEM_STATES],
        description: 'New state for every matched item.',
      },
      listId: {
        type: 'string',
        description: 'Restrict matching to one checklist id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          updated: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                state: { type: 'string', required: true },
              },
            },
          },
          unresolved: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const result = value as {
          state: string
          updated: Array<{ text: string }>
          unresolved: string[]
        }
        const lines = result.updated.map((entry) => `· ${entry.text} → ${result.state}`)
        if (result.unresolved.length > 0) {
          lines.push(`No match: ${result.unresolved.join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') || 'No changes.' }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { items?: unknown; state?: unknown; listId?: unknown }
      const sessionId = sessionOf(exec)

      const state: ItemState | undefined = isItemState(input.state) ? input.state : undefined
      if (!state) {
        throw new Error(`checklist_check: state must be one of ${ITEM_STATES.join(', ')}`)
      }

      const refs = Array.isArray(input.items)
        ? input.items.filter((entry): entry is string => typeof entry === 'string')
        : []
      if (refs.length === 0) throw new Error('checklist_check: items must contain at least one id or text')

      const listId = text(input.listId).trim() || undefined

      return store.update(sessionId, (doc) => {
        const updated: Array<{ id: string; text: string; state: string }> = []
        const unresolved: string[] = []
        const ambiguous: string[] = []

        for (const ref of refs) {
          const found = resolveRef(doc.lists, ref, listId)
          if (found.kind === 'hit') {
            found.hit.item.state = state
            updated.push({ id: found.hit.item.id, text: found.hit.item.text, state })
          } else if (found.kind === 'ambiguous') {
            ambiguous.push(ref)
          } else {
            unresolved.push(ref)
          }
        }

        if (updated.length === 0) {
          const detail = ambiguous.length > 0 ? ` (ambiguous: ${ambiguous.join(', ')})` : ''
          throw new Error(
            `checklist_check: no item matched ${refs.map((ref) => JSON.stringify(ref)).join(', ')}${detail}. `
            + 'Call checklist_list for exact ids.',
          )
        }

        return { state, updated, unresolved }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_list',
    description:
      'Read the full checklist tree of the CURRENT session, including item ids and states. '
      + 'Use it when the digest is truncated or when you need exact ids to pass to checklist_check.',
    parameters: {
      listId: {
        type: 'string',
        description: 'Only return this checklist id.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { listId?: unknown }
      const sessionId = sessionOf(exec)
      const listId = text(input.listId).trim() || undefined

      const doc = await store.prime(sessionId)
      const lists = listId ? doc.lists.filter((list) => list.id === listId) : doc.lists
      if (lists.length === 0) {
        return JSON.stringify({ sessionId, lists: [], note: 'No checklist exists in this session yet.' }, null, 2)
      }
      return JSON.stringify({ sessionId, lists }, null, 2)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_next',
    description:
      'Return the next checklist item to work on in the CURRENT session, in depth-first order. '
      + 'Skips done subtrees and blocked ones; descends into an in-progress item before closing it. '
      + 'Use it instead of re-reading the whole tree when you need to decide what to do next.',
    parameters: {
      listId: {
        type: 'string',
        description: 'Only search this checklist id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          listId: { type: 'string' },
          listTitle: { type: 'string' },
          itemId: { type: 'string' },
          text: { type: 'string' },
          path: { type: 'array', required: true, items: { type: 'string' } },
          remaining: { type: 'integer', required: true },
          blocked: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as {
          found: boolean
          text?: string
          path?: string[]
          remaining: number
          blocked: number
        }
        if (!result.found) {
          return [{ type: 'text', text: 'Nothing left to do in this session.' }]
        }
        const where = [...(result.path ?? []), result.text ?? ''].join(' › ')
        const extra = result.blocked > 0 ? ` · ${result.blocked} blocked` : ''
        return [{
          type: 'text',
          text: `Next: ${where}  (${result.remaining} remaining${extra})`,
        }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { listId?: unknown }
      const sessionId = sessionOf(exec)
      const listId = text(input.listId).trim() || undefined

      const doc = await store.prime(sessionId)
      const result = nextItem(doc.lists, listId)
      if (!result.next) {
        return { found: false, path: [], remaining: result.remaining, blocked: result.blocked }
      }

      const { list, item, path } = result.next
      return {
        found: true,
        listId: list.id,
        listTitle: list.title,
        itemId: item.id,
        text: item.text,
        path,
        remaining: result.remaining,
        blocked: result.blocked,
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_edit',
    description:
      'Change the TEXT of one checklist item in the CURRENT session. Match it by id or exact text. '
      + 'Use it to fix a typo or reword a step; it does not change the item state (use checklist_check for that).',
    parameters: {
      item: {
        type: 'string',
        required: true,
        description: 'Item id or exact item text.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'New text for the item.',
      },
      listId: {
        type: 'string',
        description: 'Restrict matching to one checklist id.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { from: string; to: string }
        return [{ type: 'text', text: `"${result.from}" → "${result.to}"` }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { item?: unknown; text?: unknown; listId?: unknown }
      const sessionId = sessionOf(exec)

      const ref = text(input.item).trim()
      const next = text(input.text).trim()
      if (ref.length === 0) throw new Error('checklist_edit: item must not be empty')
      if (next.length === 0) throw new Error('checklist_edit: text must not be empty')
      if (next.length > 500) throw new Error('checklist_edit: text is longer than 500 characters')

      const listId = text(input.listId).trim() || undefined

      return store.update(sessionId, (doc) => {
        const found = resolveRef(doc.lists, ref, listId)
        if (found.kind === 'ambiguous') {
          const options = found.candidates
            .map((entry) => `${entry.item.id} (${entry.list.title}: ${entry.item.text})`)
            .join(', ')
          throw new Error(`checklist_edit: "${ref}" is ambiguous; use an id: ${options}`)
        }
        if (found.kind === 'miss') {
          throw new Error(`checklist_edit: no item matched "${ref}". Call checklist_list for exact ids.`)
        }

        const from = found.hit.item.text
        found.hit.item.text = next
        return { id: found.hit.item.id, from, to: next }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_add',
    description:
      'Append one or more items to an EXISTING checklist in the CURRENT session. '
      + 'Items are plain strings; indent a line with two leading spaces to nest it under the previous new item. '
      + 'Use `parent` to attach the new items under an existing item (by id or exact text) instead of the list root.',
    parameters: {
      listId: {
        type: 'string',
        required: true,
        description: 'Checklist id, or its exact title.',
      },
      items: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Item texts to append. Two leading spaces nest under the previous new item.',
      },
      parent: {
        type: 'string',
        description: 'Existing item id or exact text to append under. Omit to append at the list root.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          added: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { title: string; added: number; total: number }
        return [{
          type: 'text',
          text: `Added ${result.added} items to "${result.title}" (total ${result.total}).`,
        }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { listId?: unknown; items?: unknown; parent?: unknown }
      const sessionId = sessionOf(exec)

      const ref = text(input.listId).trim()
      if (ref.length === 0) throw new Error('checklist_add: listId must not be empty')

      const lines = Array.isArray(input.items)
        ? input.items.filter((entry): entry is string => typeof entry === 'string')
        : []
      if (lines.length === 0) throw new Error('checklist_add: items must contain at least one string')

      const parentRef = text(input.parent).trim()

      return store.update(sessionId, (doc) => {
        const list = findList(doc.lists, ref)
        if (!list) {
          const available = doc.lists.map((entry) => `${entry.id} (${entry.title})`).join(', ')
          throw new Error(
            `checklist_add: no checklist "${ref}" in this session. `
            + `Available: ${available.length > 0 ? available : 'none'}`,
          )
        }

        // Ids are per list, so extend the set already in use or the new items
        // would collide with existing ones.
        const used = new Set(flatten(list.items).map((entry) => entry.item.id))
        const fresh = buildItems(lines, used)
        if (fresh.length === 0) throw new Error('checklist_add: items produced no entries')

        const added = countItems(fresh).total
        if (countItems(list.items).total + added > maxItems) {
          throw new Error(`checklist_add: the list would exceed the limit of ${maxItems} items`)
        }

        if (parentRef.length > 0) {
          const found = resolveRef([list], parentRef)
          if (found.kind === 'ambiguous') {
            const options = found.candidates.map((entry) => `${entry.item.id} (${entry.item.text})`).join(', ')
            throw new Error(`checklist_add: parent "${parentRef}" is ambiguous; use an id: ${options}`)
          }
          if (found.kind === 'miss') {
            throw new Error(`checklist_add: no item "${parentRef}" in "${list.title}". Call checklist_list for ids.`)
          }
          found.hit.item.children.push(...fresh)
        } else {
          list.items.push(...fresh)
        }

        return { listId: list.id, title: list.title, added, total: countItems(list.items).total }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_rename',
    description:
      'Rename an existing checklist in the CURRENT session. Titles must be unique within the session. '
      + 'Pass the id from checklist_list, or the exact current title.',
    parameters: {
      listId: {
        type: 'string',
        required: true,
        description: 'Checklist id, or its exact current title.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'New title for the checklist.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listId: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { from: string; to: string }
        return [{ type: 'text', text: `Renamed "${result.from}" → "${result.to}".` }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { listId?: unknown; title?: unknown }
      const sessionId = sessionOf(exec)

      const ref = text(input.listId).trim()
      const nextTitle = text(input.title).trim()
      if (ref.length === 0) throw new Error('checklist_rename: listId must not be empty')
      if (nextTitle.length === 0) throw new Error('checklist_rename: title must not be empty')
      if (nextTitle.length > 120) throw new Error('checklist_rename: title is longer than 120 characters')

      return store.update(sessionId, (doc) => {
        const check = checkRename(doc.lists, ref, nextTitle)

        if (check.kind === 'empty') throw new Error('checklist_rename: title must not be empty')
        if (check.kind === 'missing') {
          const available = check.available.join(', ')
          throw new Error(
            `checklist_rename: no checklist "${ref}" in this session. `
            + `Available: ${available.length > 0 ? available : 'none'}`,
          )
        }
        if (check.kind === 'duplicate') {
          throw new Error(
            `checklist_rename: a checklist titled "${check.existing}" already exists in this session`,
          )
        }

        check.list.title = check.to
        return { listId: check.list.id, from: check.from, to: check.to }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_remove_item',
    description:
      'Remove one item — and everything nested under it — from a checklist in the CURRENT session. '
      + 'Match it by id or exact text. Use it to drop work that no longer applies; '
      + 'to change the item instead, use checklist_edit.',
    parameters: {
      listId: {
        type: 'string',
        required: true,
        description: 'Checklist id, or its exact title.',
      },
      item: {
        type: 'string',
        required: true,
        description: 'Item id or exact item text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listId: { type: 'string', required: true },
          itemId: { type: 'string', required: true },
          text: { type: 'string', required: true },
          removed: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { text: string; removed: number }
        const extra = result.removed > 1 ? ` (+${result.removed - 1} nested)` : ''
        return [{ type: 'text', text: `Removed "${result.text}"${extra}.` }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { listId?: unknown; item?: unknown }
      const sessionId = sessionOf(exec)

      const listRef = text(input.listId).trim()
      const itemRef = text(input.item).trim()
      if (listRef.length === 0) throw new Error('checklist_remove_item: listId must not be empty')
      if (itemRef.length === 0) throw new Error('checklist_remove_item: item must not be empty')

      return store.update(sessionId, (doc) => {
        const list = findList(doc.lists, listRef)
        if (!list) {
          const available = doc.lists.map((entry) => `${entry.id} (${entry.title})`).join(', ')
          throw new Error(
            `checklist_remove_item: no checklist "${listRef}" in this session. `
            + `Available: ${available.length > 0 ? available : 'none'}`,
          )
        }

        const found = resolveRef([list], itemRef)
        if (found.kind === 'ambiguous') {
          const options = found.candidates.map((entry) => `${entry.item.id} (${entry.item.text})`).join(', ')
          throw new Error(`checklist_remove_item: "${itemRef}" is ambiguous; use an id: ${options}`)
        }
        if (found.kind === 'miss') {
          throw new Error(
            `checklist_remove_item: no item "${itemRef}" in "${list.title}". Call checklist_list for ids.`,
          )
        }

        const removed = removeItemById(list.items, found.hit.item.id)
        if (!removed) {
          throw new Error(`checklist_remove_item: item "${itemRef}" disappeared from "${list.title}"`)
        }

        return {
          listId: list.id,
          itemId: removed.id,
          text: removed.text,
          removed: countItems([removed]).total,
        }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_workspace',
    description:
      'List the checklists of OTHER sessions in the same workspace. Read-only; the current session is '
      + 'excluded, and these lists never enter the prompt on their own. Use it when the user asks what '
      + 'is pending in this project across sessions.',
    parameters: {
      limit: {
        type: 'integer',
        description: 'Maximum checklists to return, newest first (default 10).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceTitle: { type: 'string' },
          workspacePath: { type: 'string' },
          checklists: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                total: { type: 'integer', required: true },
                done: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const view = value as {
          workspaceTitle?: string
          checklists: Array<{ title: string; done: number; total: number }>
        }
        if (view.checklists.length === 0) {
          return [{ type: 'text', text: 'No other session in this workspace has a checklist.' }]
        }
        const lines = view.checklists.map((entry) => `· ${entry.title} — ${entry.done}/${entry.total}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      if ((config.workspaceView ?? 'on-demand') === 'off') {
        throw new Error('checklist_workspace: the workspace lens is disabled in this profile')
      }

      const sessionId = sessionOf(exec)
      const input = args as { limit?: unknown }
      const requested = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.trunc(input.limit)
        : undefined
      const limit = Math.min(Math.max(1, requested ?? config.workspaceViewLimit ?? 10), 50)

      const view = await listWorkspaceChecklists(store, sessionId, limit)
      return {
        ...(view.workspace?.title ? { workspaceTitle: view.workspace.title } : {}),
        ...(view.workspace?.path ? { workspacePath: view.workspace.path } : {}),
        checklists: view.checklists,
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_delete',
    description:
      'Delete one checklist from the CURRENT session. The list and its items are gone; there is no archive. '
      + 'Use it to clean up a finished or obsolete checklist, or to replace one (delete, then create). '
      + 'Pass the id from checklist_list, or the exact title.',
    parameters: {
      listId: {
        type: 'string',
        required: true,
        description: 'Checklist id, or its exact title.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          remaining: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { title: string; remaining: number }
        return [{ type: 'text', text: `Deleted checklist "${result.title}". ${result.remaining} left.` }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { listId?: unknown }
      const sessionId = sessionOf(exec)
      const ref = text(input.listId).trim()
      if (ref.length === 0) throw new Error('checklist_delete: listId must not be empty')

      return store.update(sessionId, (doc) => {
        const target = findList(doc.lists, ref)
        if (!target) {
          const available = doc.lists.map((list) => `${list.id} (${list.title})`).join(', ')
          throw new Error(
            `checklist_delete: no checklist "${ref}" in this session. `
            + `Available: ${available.length > 0 ? available : 'none'}`,
          )
        }
        doc.lists.splice(doc.lists.indexOf(target), 1)
        return { listId: target.id, title: target.title, remaining: doc.lists.length }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'checklist_template_save',
    description:
      'Save one checklist of the CURRENT session as a reusable template available to future sessions. '
      + 'Use it when the user says the same checklist will be needed again.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Template name to create or overwrite.',
      },
      listId: {
        type: 'string',
        required: true,
        description: 'Checklist id to copy.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          items: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { name: string; items: number }
        return [{ type: 'text', text: `Template "${result.name}" saved with ${result.items} items.` }]
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const input = args as { name?: unknown; listId?: unknown }
      const sessionId = sessionOf(exec)

      const name = text(input.name).trim()
      if (name.length === 0) throw new Error('checklist_template_save: name must not be empty')

      const listId = text(input.listId).trim()
      const doc = await store.prime(sessionId)
      const list = doc.lists.find((entry) => entry.id === listId)
      if (!list) throw new Error(`checklist_template_save: no checklist with id "${listId}" in this session`)

      const existing = await store.readTemplates()
      await store.writeTemplates({ ...existing, [name]: toLines(list.items) })

      return { name, items: countItems(list.items).total }
    },
  })))
}
