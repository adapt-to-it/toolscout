// I connettori claude.ai compaiono nei nomi dei tool come UUID. L'impostazione
// server_labels dà loro un nome leggibile, una voce per riga: "<id server>=<nome>".

/** Legge le voci "<id>=<nome>"; ignora le righe vuote o senza "=". */
export function parseLabels(entries: readonly string[] | string | undefined): Record<string, string> {
  const list = typeof entries === 'string' ? entries.split(/[\n;]/) : entries ?? []
  const out: Record<string, string> = {}
  for (const raw of list) {
    const i = raw.indexOf('=')
    if (i <= 0) continue
    const id = raw.slice(0, i).trim()
    const name = raw.slice(i + 1).trim()
    if (id && name) out[id] = name
  }
  return out
}
