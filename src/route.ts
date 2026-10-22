/**
 * Read-only HTTP endpoint for the sidebar.
 *
 * Same-origin, GET only, one query parameter. The store validates the session
 * id (it becomes a file name), so a crafted `session` cannot escape the storage
 * directory; anything invalid answers 400 rather than throwing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { findItemById } from './model.js'
import { toPublicState } from './state.js'
import type { ChecklistStore } from './store.js'
import { listWorkspaceChecklists } from './workspace.js'

export const STATE_ROUTE = '/dsh-checklist/state'
export const ITEM_ROUTE = '/dsh-checklist/item'
export const WORKSPACE_ROUTE = '/dsh-checklist/workspace'

/** Longest session id we will even look at; real ones are UUIDs. */
const MAX_SESSION_ID = 200
/** Request body cap for the one write endpoint. */
const MAX_BODY_BYTES = 16 * 1024
/** Item text cap, matching `checklist_edit`. */
const MAX_TEXT = 500

/**
 * Serve the workspace lens: checklists from other sessions in the same workspace.
 *
 * Deliberately separate from the session state route: this data never enters the
 * agent's context unless a tool explicitly asks for it.
 *
 * @param req - the incoming request; must be GET.
 * @param res - the response to write.
 * @param store - the checklist store.
 * @param limit - maximum entries returned, newest first.
 * @param enabled - false when the profile turned the lens off.
 */
export async function serveWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  store: ChecklistStore,
  limit: number,
  enabled: boolean,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!enabled) {
    sendJson(res, 403, { error: 'workspace view is disabled in this profile' })
    return
  }

  let session: string | null
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    session = url.searchParams.get('session')
  } catch {
    sendJson(res, 400, { error: 'malformed request url' })
    return
  }

  if (!session || session.length === 0 || session.length > MAX_SESSION_ID) {
    sendJson(res, 400, { error: 'the session query parameter is required' })
    return
  }

  try {
    sendJson(res, 200, await listWorkspaceChecklists(store, session, limit))
  } catch {
    sendJson(res, 400, { error: 'invalid session id' })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Serve one session's checklist state.
 *
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param store - the session store.
 */
export async function serveState(
  req: IncomingMessage,
  res: ServerResponse,
  store: ChecklistStore,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }

  let session: string | null
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    session = url.searchParams.get('session')
  } catch {
    sendJson(res, 400, { error: 'malformed request url' })
    return
  }

  if (!session) {
    sendJson(res, 400, { error: 'the session query parameter is required' })
    return
  }
  if (session.length > MAX_SESSION_ID) {
    sendJson(res, 400, { error: 'session id is too long' })
    return
  }

  try {
    const doc = await store.prime(session)
    sendJson(res, 200, toPublicState(doc))
  } catch {
    // The store rejects unsafe ids by throwing; never echo the id back.
    sendJson(res, 400, { error: 'invalid session id' })
  }
}

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > limit) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (size === 0) throw new Error('empty body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

type ItemUpdate =
  | { status: 200; item: { id: string; text: string } }
  | { status: 404 }
  | { status: 409 }

/**
 * Apply one text edit from the sidebar.
 *
 * This is the only write path outside the agent, so it is deliberately narrow:
 * one item, by exact id, with an optional `expectedText` guard. When the guard
 * does not match, the answer is 409 rather than a silent overwrite — the client
 * re-reads and the user retries.
 *
 * @param req - the incoming request; must be POST.
 * @param res - the response to write.
 * @param store - the session store.
 */
export async function serveItemUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  store: ChecklistStore,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }

  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { error: 'body must be an object' })
    return
  }

  const { session, itemId, text: nextText, expectedText } = body as Record<string, unknown>

  if (typeof session !== 'string' || session.length === 0 || session.length > MAX_SESSION_ID) {
    sendJson(res, 400, { error: 'session is required' })
    return
  }
  if (typeof itemId !== 'string' || itemId.length === 0) {
    sendJson(res, 400, { error: 'itemId is required' })
    return
  }
  if (typeof nextText !== 'string') {
    sendJson(res, 400, { error: 'text is required' })
    return
  }

  const trimmed = nextText.trim()
  if (trimmed.length === 0) {
    sendJson(res, 400, { error: 'text must not be empty' })
    return
  }
  if (trimmed.length > MAX_TEXT) {
    sendJson(res, 400, { error: `text is longer than ${MAX_TEXT} characters` })
    return
  }

  try {
    const outcome = await store.update(session, (doc): ItemUpdate => {
      const found = findItemById(doc.lists, itemId)
      if (!found) return { status: 404 }
      if (typeof expectedText === 'string' && found.item.text !== expectedText) {
        return { status: 409 }
      }
      found.item.text = trimmed
      return { status: 200, item: { id: found.item.id, text: trimmed } }
    })

    if (outcome.status === 200) sendJson(res, 200, { ok: true, item: outcome.item })
    else if (outcome.status === 409) {
      sendJson(res, 409, { error: 'conflict', detail: 'the item changed since the sidebar read it' })
    } else {
      sendJson(res, 404, { error: 'item not found' })
    }
  } catch {
    sendJson(res, 400, { error: 'invalid session id' })
  }
}
