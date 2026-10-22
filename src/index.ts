/**
 * dsh-checklist — session-scoped checklists for DeepSeek Harness.
 *
 * Two contributions:
 *   1. Five tools (`checklist_*`) that let the agent create and update a tree
 *      of items for the current session.
 *   2. A dynamic prompt context that renders a compact digest of that tree on
 *      every assembly, so the model never has to be reminded what is pending.
 *
 * The agent is the only writer. There is no client write path: the session
 * document is the single source of truth.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import: pulls in the `ctx.systemPrompt` augmentation without a
// runtime dependency on the package.
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
// Type-only import: the `ctx.webServer` augmentation.
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { renderDigest } from './digest.js'
import { decideNudge, isChecklistWrite, MUTATING_TOOLS, NUDGE_ROUTE, type TurnActivity } from './gate.js'
import { countState } from './model.js'
import { serveProbe, PROBE_ROUTE } from './probe.js'
import { serveItemUpdate, serveState, ITEM_ROUTE, STATE_ROUTE } from './route.js'
import { ChecklistStore } from './store.js'
import { registerChecklistTools } from './tools.js'

export const name = 'dsh-checklist'
export const inject = ['tools']

export interface Config {
  /** Override the storage root (defaults to `$DSH_HOME/storages/dsh-checklist`). */
  storageRoot?: string
  /** Body-line cap of the injected digest (default 12). */
  maxDigestLines?: number
  /** Per-checklist item cap enforced by `checklist_create` (default 200). */
  maxItemsPerList?: number
  /** Days after which untouched session files are pruned (default 14, 0 disables). */
  pruneDays?: number
  /** Extra templates merged over the built-in ones. */
  templates?: Record<string, string[]>
}

interface ScopeLike {
  id?: unknown
}

interface AssemblyLike {
  scope?: object | undefined
}

interface GateEntry {
  at: string
  sessionId: string
  /** Which observation point produced this entry. */
  source: 'turn-stopping' | 'status'
  nudge: boolean
  reason: string
  doing: number
}

/**
 * Resolve which session this prompt assembly belongs to.
 *
 * An agent's scope key is the Agent object itself (`scopeTarget(agent, agent)`
 * in the agent registry), and `Agent.id` is the shared agent/session id. The
 * initiator lookup is a fallback for assemblies that carry no scope. When
 * neither yields an id, the digest stays empty rather than guessing.
 */
function sessionOfAssembly(ctx: Context, assembly: AssemblyLike | undefined): string | undefined {
  const scope = assembly?.scope as ScopeLike | undefined
  if (scope && typeof scope.id === 'string' && scope.id.length > 0) return scope.id

  const agents = (ctx as unknown as {
    agents?: { currentInitiator?: () => { id?: string } | undefined }
  }).agents
  const initiator = agents?.currentInitiator?.()
  return typeof initiator?.id === 'string' && initiator.id.length > 0 ? initiator.id : undefined
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new ChecklistStore(config.storageRoot)
  const maxLines = config.maxDigestLines ?? 12

  registerChecklistTools(ctx, store, {
    maxItemsPerList: config.maxItemsPerList,
    templates: config.templates,
  })

  // Opportunistic housekeeping: never blocks startup, never fails the plugin.
  if (config.pruneDays !== 0) {
    void store.prune(config.pruneDays ?? 14).catch(() => undefined)
  }

  // --- Turn-end gate (observation mode) ------------------------------------
  // Watches one turn's tool activity and decides, as the turn closes, whether
  // the checklist was left stale. This release only records the decision — the
  // event is not exercised yet — so enabling `steer` is a one-line follow-up
  // once the log shows it fires when it should.
  const activity = new Map<string, TurnActivity>()
  const gateLog: GateEntry[] = []

  const events = ctx as unknown as {
    on(name: string, listener: (...args: unknown[]) => void): () => void
  }

  ctx.effect(() => events.on('tools/result', (exec) => {
    // `tools/result` is emitted as (execution, result); the execution carries
    // the tool name and the calling agent.
    const call = exec as { name?: unknown; agent?: { id?: unknown } } | undefined
    const toolName = call?.name
    const agentId = call?.agent?.id
    if (typeof toolName !== 'string' || typeof agentId !== 'string') return

    const current = activity.get(agentId) ?? { mutated: false, checklistWrite: false }
    if (MUTATING_TOOLS.has(toolName)) current.mutated = true
    if (isChecklistWrite(toolName)) current.checklistWrite = true
    activity.set(agentId, current)
  }))

  const evaluate = (agentId: string, source: 'turn-stopping' | 'status'): void => {
    const current = activity.get(agentId) ?? { mutated: false, checklistWrite: false }
    activity.set(agentId, { mutated: false, checklistWrite: false })

    const doc = store.peek(agentId)
    let doing = 0
    if (doc) for (const list of doc.lists) doing += countState(list.items, 'doing')

    const decision = decideNudge(current, doing)
    // Log every decision while the gate is in observe mode: an empty log must
    // mean "the event never fired", never "the answer was no".
    gateLog.push({
      at: new Date().toISOString(),
      sessionId: agentId,
      source,
      nudge: decision.nudge,
      reason: decision.reason,
      doing,
    })
    if (gateLog.length > 20) gateLog.shift()
  }

  ctx.effect(() => events.on('agent/turn-stopping', (payload) => {
    const event = payload as { agent?: { id?: unknown } }
    if (typeof event.agent?.id === 'string') evaluate(event.agent.id, 'turn-stopping')
  }))

  // Second observation point. `agent/status` → idle also marks a turn end, so
  // keeping both in the log tells us which one the runtime actually delivers —
  // and leaves the gate working if `turn-stopping` turns out not to reach a
  // root listener.
  ctx.effect(() => events.on('agent/status', (payload) => {
    const event = payload as { agent?: { id?: unknown }; status?: unknown }
    if (event.status !== 'idle') return
    if (typeof event.agent?.id === 'string') evaluate(event.agent.id, 'status')
  }))

  let loggedScope = false

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: 'dsh-checklist',
      order: 65,
      text: (assembly) => {
        if (!loggedScope && process.env.DSH_CHECKLIST_DEBUG === '1') {
          loggedScope = true
          const scope = assembly?.scope as object | undefined
          console.error(
            '[dsh-checklist] assembly scope:',
            scope ? `keys=[${Object.keys(scope).join(',')}] id=${String((scope as ScopeLike).id)}` : 'none',
          )
        }

        const sessionId = sessionOfAssembly(ctx, assembly)
        if (!sessionId) return ''

        const cached = store.peek(sessionId)
        if (!cached) {
          // First turn after a restart: warm the cache for the next assembly.
          void store.prime(sessionId).catch(() => undefined)
          return ''
        }
        return renderDigest(cached, { maxLines })
      },
    })
  })

  // Read-only state endpoint consumed by the sidebar tab (phase 2).
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: (req, res) => {
          void serveState(req, res, store)
        },
      }),
      'dsh-checklist: state route',
    )

    // The single write path outside the agent: an item-text edit from the sidebar.
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: ITEM_ROUTE,
        handler: (req, res) => {
          void serveItemUpdate(req, res, store)
        },
      }),
      'dsh-checklist: item route',
    )

    // Diagnostics channel for the browser half; see src/probe.ts.
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: PROBE_ROUTE,
        handler: (req, res) => {
          serveProbe(req, res)
        },
      }),
      'dsh-checklist: client probe route',
    )

    // What the turn-end gate decided, for verification before it steers.
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: NUDGE_ROUTE,
        handler: (req, res) => {
          const body = Buffer.from(
            `${JSON.stringify({ mode: 'observe', entries: gateLog }, null, 2)}\n`,
            'utf8',
          )
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.byteLength),
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }),
      'dsh-checklist: nudge log route',
    )
  })
}
