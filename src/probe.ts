/**
 * Client diagnostics channel.
 *
 * The client half runs in a browser we cannot attach a debugger to from here.
 * This endpoint lets it report its own load/registration stages to the host, so
 * "the tab is not there" can be told apart from "the module never loaded".
 *
 * In-memory and bounded: it answers one question and dies with the process.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const PROBE_ROUTE = '/dsh-checklist/client-probe'

const MAX_REPORTS = 12
const MAX_DETAIL = 500

export interface ProbeReport {
  at: string
  stage: string
  detail: string
}

const reports: ProbeReport[] = []

export function serveProbe(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }

  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  const stage = url.searchParams.get('stage')
  if (stage) {
    reports.push({
      at: new Date().toISOString(),
      stage: stage.slice(0, 80),
      detail: (url.searchParams.get('detail') ?? '').slice(0, MAX_DETAIL),
    })
    if (reports.length > MAX_REPORTS) reports.shift()
  }

  const payload = Buffer.from(`${JSON.stringify({ reports }, null, 2)}\n`, 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}
