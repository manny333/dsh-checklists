/**
 * Turn-end gate: decides whether a turn is closing with the checklist stale.
 *
 * Kept pure on purpose — the host event wiring lives in `index.ts`, so the rule
 * itself is testable without a running harness and can be reasoned about by
 * reading one function.
 *
 * The gate never guesses *what* was completed. It only notices the shape of the
 * problem: real work happened, the checklist was not touched, and something is
 * still marked as in progress.
 */

export interface TurnActivity {
  /** The turn ran a tool that can change the workspace. */
  mutated: boolean
  /** The turn already wrote to a checklist. */
  checklistWrite: boolean
}

/** Observation endpoint for the gate's last decisions. */
export const NUDGE_ROUTE = '/dsh-checklist/nudge'

export interface NudgeDecision {
  nudge: boolean
  reason: string
}

/**
 * Tools whose result can change the workspace. `run_code` is included because
 * the PTC transport can reach any tool behind it.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',
  'run_code',
])

/** Tools that already keep a checklist current. */
const CHECKLIST_WRITES: ReadonlySet<string> = new Set([
  'checklist_create',
  'checklist_add',
  'checklist_check',
  'checklist_edit',
  'checklist_remove_item',
  'checklist_delete',
  'checklist_rename',
])

export function isChecklistWrite(name: string): boolean {
  return CHECKLIST_WRITES.has(name)
}

/**
 * Decide whether the closing turn should be challenged.
 *
 * @param activity - what the turn did.
 * @param doingCount - items currently in `doing` across the session.
 * @returns the decision and a short human-readable reason, logged either way.
 */
export function decideNudge(activity: TurnActivity, doingCount: number): NudgeDecision {
  if (!activity.mutated) return { nudge: false, reason: 'no mutating tool calls' }
  if (activity.checklistWrite) return { nudge: false, reason: 'checklist already updated' }
  if (doingCount === 0) return { nudge: false, reason: 'nothing in progress' }
  return { nudge: true, reason: `${doingCount} item(s) still doing after workspace changes` }
}
