/**
 * Workspace lens: a read-only view of checklists from sibling sessions.
 *
 * Two independent facts drive this module, and keeping them apart is what makes
 * it survive host changes:
 *
 *   1. **Membership comes from disk.** A session lives in
 *      `$DSH_HOME/sessions/<encoded-workspace>/<sessionId>/`. The host's
 *      `storages/workspace.json` was missing a workspace on the machine this was
 *      written on, so it is only consulted for a friendly title/path — never to
 *      decide which sessions belong together.
 *   2. **Content comes from our own store.** Session logs are never decoded;
 *      titles and counts are already in the checklist document.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { countItems } from './model.js'
import { resolveDshHome, type ChecklistStore } from './store.js'

export interface WorkspaceInfo {
  /** Encoded directory name the host uses under `$DSH_HOME/sessions`. */
  key: string
  /** Friendly workspace title, when the host metadata knows it. */
  title?: string
  /** Absolute workspace path, when the host metadata knows it. */
  path?: string
}

export interface WorkspaceListSummary {
  sessionId: string
  title: string
  total: number
  done: number
  /** Last write to that session's checklist file, in epoch milliseconds. */
  updatedAt: number
}

export interface WorkspaceView {
  workspace?: WorkspaceInfo
  checklists: WorkspaceListSummary[]
}

const SESSION_DIR = /^session-/

function sessionsRoot(): string {
  return join(resolveDshHome(), 'sessions')
}

/**
 * Find the workspace directory that contains a session.
 *
 * @param sessionId - the session to locate.
 * @returns the encoded workspace key, or undefined when the session has no dir.
 */
export async function workspaceKeyOf(sessionId: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(sessionsRoot())
  } catch {
    return undefined
  }

  for (const entry of entries) {
    if (!entry.startsWith('--')) continue
    try {
      const info = await stat(join(sessionsRoot(), entry, sessionId))
      if (info.isDirectory()) return entry
    } catch {
      // Not this workspace; keep looking.
    }
  }
  return undefined
}

/** Session ids that share one workspace directory. */
export async function siblingSessionIds(key: string): Promise<string[]> {
  try {
    const entries = await readdir(join(sessionsRoot(), key), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && SESSION_DIR.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

interface HostWorkspaceRecord {
  path?: unknown
  title?: unknown
  sessionIds?: unknown
}

/**
 * Read the host's workspace table.
 *
 * Best effort: any parse problem yields no records, and the lens still works
 * with the encoded directory name.
 */
async function hostWorkspaces(): Promise<HostWorkspaceRecord[]> {
  try {
    const raw = await readFile(join(resolveDshHome(), 'storages', 'workspace.json'), 'utf8')
    const parsed = JSON.parse(raw) as { tables?: { workspaces?: unknown } }
    const table = parsed.tables?.workspaces
    if (table === null || typeof table !== 'object') return []
    return Object.values(table as Record<string, HostWorkspaceRecord>)
      .filter((value): value is HostWorkspaceRecord => value !== null && typeof value === 'object')
  } catch {
    return []
  }
}

/** Describe a workspace by matching host records on session membership. */
async function describeWorkspace(key: string, siblings: readonly string[]): Promise<WorkspaceInfo> {
  const wanted = new Set(siblings)
  const records = await hostWorkspaces()

  const match = records.find((record) => {
    const ids = record.sessionIds
    return Array.isArray(ids) && ids.some((id) => typeof id === 'string' && wanted.has(id))
  })

  return {
    key,
    ...(typeof match?.title === 'string' ? { title: match.title } : {}),
    ...(typeof match?.path === 'string' ? { path: match.path } : {}),
  }
}

/**
 * List the checklists of every *other* session in the caller's workspace.
 *
 * @param store - the checklist store.
 * @param sessionId - the calling session, excluded from the result.
 * @param limit - maximum entries returned, newest first.
 * @returns the workspace description plus one summary per sibling checklist.
 */
export async function listWorkspaceChecklists(
  store: ChecklistStore,
  sessionId: string,
  limit: number,
): Promise<WorkspaceView> {
  const key = await workspaceKeyOf(sessionId)
  if (!key) return { checklists: [] }

  const siblings = (await siblingSessionIds(key)).filter((id) => id !== sessionId)
  const workspace = await describeWorkspace(key, siblings)

  const checklists: WorkspaceListSummary[] = []
  for (const id of siblings) {
    const updatedAt = await store.modifiedAt(id)
    if (updatedAt === undefined) continue // That session never used the plugin.

    const doc = await store.prime(id)
    const first = doc.lists[0]
    if (!first) continue

    const totals = doc.lists.reduce(
      (acc, list) => {
        const counts = countItems(list.items)
        return { total: acc.total + counts.total, done: acc.done + counts.done }
      },
      { total: 0, done: 0 },
    )

    checklists.push({
      sessionId: id,
      title: doc.lists.length === 1 ? first.title : `${first.title} (+${doc.lists.length - 1})`,
      total: totals.total,
      done: totals.done,
      updatedAt,
    })
  }

  checklists.sort((a, b) => b.updatedAt - a.updatedAt)
  return { workspace, checklists: checklists.slice(0, Math.max(1, limit)) }
}
