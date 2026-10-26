import type { ToolLike, ToolGroup, GroupSpec, GroupTools, DiffGroups } from './types'

// Server MCP che non entrano nel routing: il proprio plugin e il canale di turno.
const EXCLUDED = new Set(['ccd_turn', 'squadra'])

// mcp__<server>__<tool>: il server non contiene `__`, il tool sì.
const MCP_NAME = /^mcp__(.+?)__(.+)$/

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** FNV-1a 32 bit sulle unità UTF-16 di `s`, in esadecimale a 8 cifre. Le mod non hanno TextEncoder. */
export function hash(s: string): string {
  let h = FNV_OFFSET
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Raggruppa i tool MCP per server. Gruppi ordinati per id, tool ordinati per nome. */
export const groupTools: GroupTools = (tools: ToolLike[], labels: Record<string, string>): ToolGroup[] => {
  const byServer = new Map<string, { name: string; description: string }[]>()
  for (const tool of tools) {
    if (!tool.mcp) continue
    const match = MCP_NAME.exec(tool.name)
    if (!match) continue
    const id = match[1]
    if (EXCLUDED.has(id)) continue
    const list = byServer.get(id) ?? []
    list.push({ name: tool.name, description: tool.description })
    byServer.set(id, list)
  }
  return [...byServer.keys()].sort(cmp).map((id) => {
    const list = byServer.get(id)!.sort((a, b) => cmp(a.name, b.name))
    return {
      id,
      label: labels[id] ?? id,
      tools: list,
      // I server interni dell'app (ccd_*) cambiano descrizioni da una sessione all'altra:
      // per loro l'impronta usa solo i nomi, altrimenti si rigenerano a ogni avvio.
      hash: hash(JSON.stringify(list.map((t) => (id.startsWith('ccd_') ? [t.name] : [t.name, t.description])))),
    }
  })
}

/** Gruppi nuovi o cambiati rispetto alle spec salvate, e id delle spec senza gruppo. */
export const diffGroups: DiffGroups = (groups: ToolGroup[], specs: Record<string, GroupSpec>) => {
  const ids = new Set(groups.map((g) => g.id))
  const changed = groups.filter((g) => specs[g.id]?.hash !== g.hash)
  const removed = Object.keys(specs).filter((id) => !ids.has(id))
  return { changed, removed }
}
