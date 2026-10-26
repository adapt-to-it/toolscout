import type { Register } from 'claude-code'
import { parseLabels } from './labels'
import { installRouting } from './routing/pipeline'

// Sotto questa soglia l'elenco resta com'è: compattarlo non conviene.
const MIN_NAMES = 40
const SAMPLES = 6
const NAME = /^[A-Za-z0-9_.:-]+$/
const MCP = /^mcp__(.+?)__(.+)$/

/** Prende SAMPLES nomi distribuiti lungo l'elenco, per dare un'idea del server. */
function samples(tools: string[]): string[] {
  if (tools.length <= SAMPLES) return tools
  const step = tools.length / SAMPLES
  return Array.from({ length: SAMPLES }, (_, i) => tools[Math.floor(i * step)])
}

/** Sostituisce l'elenco dei nomi con una riga per server MCP; i tool non MCP restano per nome. */
export function compact(text: string, labels: Record<string, string> = {}): string {
  const lines = text.split('\n')
  const names = lines.filter(l => NAME.test(l.trim()))
  if (names.length < MIN_NAMES) return text

  const firstName = lines.findIndex(l => NAME.test(l.trim()))
  const header = lines.slice(0, firstName)
  const rest = lines.slice(firstName).filter(l => !NAME.test(l.trim()))

  const builtin: string[] = []
  const servers = new Map<string, string[]>()
  for (const raw of names) {
    const name = raw.trim()
    const m = MCP.exec(name)
    if (!m) { builtin.push(name); continue }
    const list = servers.get(m[1]) ?? []
    list.push(m[2])
    servers.set(m[1], list)
  }

  const rows = [...servers].map(([server, tools]) => {
    const label = labels[server] ?? server
    return `- mcp__${server}__* — ${label}: ${tools.length} tool (es. ${samples(tools).join(', ')})`
  })

  return [
    ...header,
    ...builtin,
    '',
    `Tool MCP differiti, riassunti per server (${names.length - builtin.length} in tutto). Ogni server ha più tool di quelli citati.`,
    'Per caricarli usa ToolSearch: "+<server> parole chiave" (es. "+rea decompile") o "select:<nome completo>".',
    ...rows,
    ...rest,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const labels = parseLabels(options.server_labels as readonly string[] | string | undefined)
  const key = typeof options.typesafe_api_key === 'string' ? options.typesafe_api_key.trim() : ''
  installRouting(on, { apiKey: key || undefined, labels })

  on('prompt.attachment', { type: 'deferred_tools_delta' }, ($, e, next) =>
    next({ ...e, text: compact(e.text, labels) }),
  ).catch(($, e, next) => next(e))

  on('tool.describe', async ($, e, next) => {
    const out = await next(e)
    return shouldDefer(e.tool, e.isDeferred === true) ? { ...out, isDeferred: true } : out
  }).catch(($, e, next) => next(e))
}

// Tool MCP che restano in primo piano. ccd_turn serve a ogni turno nell'app;
// squadra serve ai junior, che non hanno ToolSearch.
const KEEP = [/^mcp__ccd_turn__/, /^mcp__squadra__/]

/** Un tool MCP caricato per intero passa dietro ToolSearch, salvo quelli in KEEP. */
export function shouldDefer(tool: string, isDeferred: boolean): boolean {
  return !isDeferred && tool.startsWith('mcp__') && !KEEP.some(r => r.test(tool))
}
