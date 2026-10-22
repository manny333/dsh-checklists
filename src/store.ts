/**
 * Durable per-session checklist storage.
 *
 * Layout under the DSH home directory:
 *
 *   $DSH_HOME/storages/dsh-checklist/
 *   ├─ sessions/<sessionId>.json   one document per session
 *   └─ templates.json              reusable, cross-session templates
 *
 * The store keeps an in-process cache because the system-prompt digest is
 * rendered synchronously, while disk access is not. Writes are serialized per
 * session and land atomically (temp file + rename), so two concurrent tool
 * calls cannot interleave into a torn document.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emptyDoc, type SessionDoc } from './model.js'

/** Conservative allowlist: a session id becomes a file name. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/

/** Resolve the DSH home directory (env override wins). */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export class ChecklistStore {
  readonly root: string

  private readonly cache = new Map<string, SessionDoc>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly inflight = new Map<string, Promise<SessionDoc>>()

  constructor(root?: string) {
    this.root = root ?? join(resolveDshHome(), 'storages', 'dsh-checklist')
  }

  /** The synchronous view used by the prompt digest; `undefined` until primed. */
  peek(sessionId: string): SessionDoc | undefined {
    return this.cache.get(sessionId)
  }

  /**
   * Last modification time of one session's checklist file.
   *
   * @param sessionId - the session to inspect.
   * @returns epoch milliseconds, or undefined when that session has no file.
   */
  async modifiedAt(sessionId: string): Promise<number | undefined> {
    try {
      const info = await stat(this.fileFor(sessionId))
      // Rounded: mtimeMs is a float, and the lens output declares it integer.
      return Math.round(info.mtimeMs)
    } catch {
      return undefined
    }
  }

  /** Load one session (cache first, then disk). */
  async prime(sessionId: string): Promise<SessionDoc> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached

    const running = this.inflight.get(sessionId)
    if (running) return running

    const load = this.read(sessionId).then(
      (doc) => {
        this.cache.set(sessionId, doc)
        this.inflight.delete(sessionId)
        return doc
      },
      (error: unknown) => {
        this.inflight.delete(sessionId)
        throw error
      },
    )
    this.inflight.set(sessionId, load)
    return load
  }

  /**
   * Apply one mutation to a session and persist it.
   *
   * The mutator receives a fresh clone, so a throw leaves the cached document
   * untouched. Calls for one session are serialized.
   */
  async update<T>(sessionId: string, mutate: (doc: SessionDoc) => T | Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const run = previous.then(async () => {
      const current = await this.prime(sessionId)
      const draft = structuredClone(current)
      const result = await mutate(draft)
      await this.write(draft)
      return result
    })
    this.chains.set(sessionId, run.then(() => undefined, () => undefined))
    return run
  }

  async readTemplates(): Promise<Record<string, string[]>> {
    try {
      const raw = await readFile(this.templatesFile(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, string[]> = {}
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isStringArray(value)) out[name] = value
      }
      return out
    } catch {
      return {}
    }
  }

  async writeTemplates(templates: Record<string, string[]>): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const file = this.templatesFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(templates, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /** Delete session files untouched for `maxAgeDays`. Returns the count removed. */
  async prune(maxAgeDays: number): Promise<number> {
    const dir = join(this.root, 'sessions')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }

    const cutoff = Date.now() - maxAgeDays * 86_400_000
    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.mtimeMs >= cutoff) continue
        await unlink(path)
        removed += 1
      } catch {
        // Raced with another process; nothing to do.
      }
    }
    return removed
  }

  private templatesFile(): string {
    return join(this.root, 'templates.json')
  }

  private fileFor(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) {
      throw new Error(`checklist: refusing unsafe session id ${JSON.stringify(sessionId)}`)
    }
    return join(this.root, 'sessions', `${sessionId}.json`)
  }

  private async read(sessionId: string): Promise<SessionDoc> {
    const file = this.fileFor(sessionId)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDoc(sessionId)
      throw error
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as SessionDoc).version === 1 &&
        (parsed as SessionDoc).sessionId === sessionId &&
        Array.isArray((parsed as SessionDoc).lists)
      ) {
        return parsed as SessionDoc
      }
    } catch {
      // Corrupt document: start clean rather than failing every turn.
    }

    return emptyDoc(sessionId)
  }

  private async write(doc: SessionDoc): Promise<void> {
    const file = this.fileFor(doc.sessionId)
    await mkdir(join(this.root, 'sessions'), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    this.cache.set(doc.sessionId, doc)
  }
}
