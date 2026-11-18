// Pipeline di routing: all'avvio della sessione aggiorna il Registry in background,
// a ogni prompt aggiunge il contesto dei tool probabilmente pertinenti, e gestisce
// il comando /toolscout. Le porte ($.model, $.http) le costruisce qui e le passa ai
// moduli di hooks/routing, che non toccano `$`.
import type { On } from 'claude-code'
import { diffGroups, groupTools, isRoutable } from './inventory'
import { classify, createJev } from './jev'
import { generateSpec, refineDefinition } from './generate'
import { calibrate } from './calibrate'
import { CACHE_KEY, DEFAULT_THRESHOLD, REGISTRY_KEY } from './types'
import type { CalibrationReport, GroupSpec, ProbCache, ToolGroup, HttpFetch, ModelPort, Registry, TestCase, ToolLike } from './types'

const ROUTING_COMMAND = 'toolscout'
const GENERATE_PARALLEL = 3
const CLASSIFY_TIMEOUT_MS = 2000
const HAIKU_MAX_TOKENS = 4000
const HEADER = 'Strumenti probabilmente pertinenti (caricali con ToolSearch):'
// Prompt più corti (ok, sì, vai) non si classificano; i più lunghi si troncano.
const MIN_PROMPT_CHARS = 20
const MAX_PROMPT_CHARS = 1000
const ATTEMPT_KEY = 'routing-attempt'

type Usage = { input_tokens: number; output_tokens: number }
type ModelReply =
  | { isAnswered: true; text: string; usage: Usage }
  | { isAnswered: false; reason: string; usage: Usage }

/** Le parti di `$` che questa unità usa. */
interface Ctx {
  model: { complete(req: { model: string; prompt: string; system?: string; maxTokens?: number }): Promise<ModelReply> }
  http: { fetch: HttpFetch }
  env: { get(name: string): Promise<string | undefined> }
  clock: { sleep(ms: number): Promise<void>; now(): Promise<number> }
  process: { run(argv: readonly string[]): Promise<{ exitCode: number | null; stdout: string }> }
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; delete(key: string): Promise<unknown> }
  tool: { list(): Promise<ToolLike[]> }
  command: { register(spec: { name: string; description: string; argumentHint?: string }): Promise<unknown> }
}

// Un solo aggiornamento alla volta, per tutta la sessione.
let running: Promise<void> | null = null
// Al massimo un tentativo di aggiornamento al giorno, riuscito o fallito; /toolscout rigenera lo forza.
const MIN_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Avvolge `$.model.complete` con Haiku; conta i token nel contatore `spent`. */
function modelPort($: Ctx, spent: { tokens: number }): ModelPort {
  return {
    async complete(prompt, system) {
      const r = await $.model.complete({
        model: 'haiku',
        prompt,
        maxTokens: HAIKU_MAX_TOKENS,
        ...(system ? { system } : {}),
      })
      if (!r.isAnswered) throw new Error(`Haiku senza risposta: ${r.reason}`)
      const tokens = r.usage.input_tokens + r.usage.output_tokens
      spent.tokens += tokens
      return { text: r.text, tokens }
    },
  }
}

function httpPort($: Ctx): HttpFetch {
  return (url, init) => $.http.fetch(url, init)
}

/** Impostazioni della mod, lette dal manifest (userConfig). */
export type Settings = { apiKey?: string; labels: Record<string, string> }
let settings: Settings = { labels: {} }

/** Chiave TypeSafe: prima l'impostazione della mod, poi la variabile d'ambiente TYPESAFE_API_KEY. */
async function apiKey($: Ctx): Promise<string | undefined> {
  if (settings.apiKey) return settings.apiKey
  return (await $.env.get('TYPESAFE_API_KEY'))?.trim() || undefined
}

async function loadRegistry($: Ctx): Promise<Registry | null> {
  const v = await $.store.get(REGISTRY_KEY)
  return v && typeof v === 'object' && (v as Registry).version === 1 ? (v as Registry) : null
}

/** Esegue `fn` su ogni elemento con al massimo `n` in parallelo, mantenendo l'ordine. */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** Rigetta se `p` non risponde entro `ms`. Nelle mod non c'è setTimeout: il tempo passa da $.clock. */
function within<T>($: Ctx, p: Promise<T>, ms: number): Promise<T> {
  const limit = $.clock.sleep(ms).then((): never => { throw new Error('timeout') })
  return Promise.race([p, limit])
}

/**
 * All'avvio connettori e server MCP si collegano dopo session.start: il primo elenco è parziale.
 * Rilegge l'elenco ogni 15 s finché due letture consecutive coincidono (massimo 3 minuti).
 */
async function stableTools($: Ctx): Promise<ToolLike[]> {
  let prev = await $.tool.list()
  for (let i = 0; i < 12; i++) {
    await $.clock.sleep(15000)
    const cur = await $.tool.list()
    if (cur.length === prev.length && cur.length > 0) return cur
    prev = cur
  }
  return prev
}

const TWIN_OVERLAP = 0.8

/** Due gruppi sono gemelli quando i nomi dei tool (senza il prefisso del server) coincidono almeno all'80%. */
function isTwin(a: ToolGroup, b: ToolGroup): boolean {
  const names = (g: ToolGroup) => new Set(g.tools.map(t => t.name.replace(/^mcp__.+?__/, '')))
  const x = names(a)
  const y = names(b)
  let common = 0
  for (const n of x) if (y.has(n)) common++
  const union = x.size + y.size - common
  return union > 0 && common / union >= TWIN_OVERLAP
}

/** Genera le spec dei gruppi cambiati, calibra e salva il Registry. */
async function runUpdate($: Ctx, force: boolean): Promise<void> {
  const key = await apiKey($)
  if (!key) return
  const reg = await loadRegistry($)
  const groups = groupTools(await stableTools($), settings.labels)
  // I server esclusi dal routing (ccd_*) escono anche dal Registry: non costano domande Jev.
  const specs: Record<string, GroupSpec> = {}
  for (const [id, s] of Object.entries(reg?.specs ?? {})) if (isRoutable(id)) specs[id] = s
  const { changed } = diffGroups(groups, specs)
  if (reg && changed.length === 0) {
    // Spec create prima della 0.4.0: si aggiunge l'impronta dei nomi, senza chiamate.
    let backfilled = false
    for (const g of groups) {
      const s = specs[g.id]
      if (s && !s.namesHash) { specs[g.id] = { ...s, namesHash: g.namesHash }; backfilled = true }
    }
    if (backfilled) await $.store.set(REGISTRY_KEY, { ...reg, specs })
    return
  }
  if (changed.length === 0) return
  // Il limite vale anche per i tentativi falliti: senza, un errore ripete la taratura a ogni avvio.
  const attempt = await $.store.get(ATTEMPT_KEY)
  const last = Math.max(reg ? Date.parse(reg.updatedAt) : 0, typeof attempt === 'string' ? Date.parse(attempt) : 0)
  if (!force && Date.now() - last < MIN_UPDATE_INTERVAL_MS) return
  await $.store.set(ATTEMPT_KEY, new Date().toISOString())

  const spent = { tokens: 0 }
  const model = modelPort($, spent)
  // Nessuna rimozione automatica: un server assente può essere solo non ancora collegato.
  // I gruppi spariti davvero si tolgono con /routing rigenera.

  // Un gruppo che fallisce si salta: resta com'era e sarà riprovato al prossimo cambio.
  const generated = await mapLimit(changed, GENERATE_PARALLEL, async g => {
    const neighbors = groups.filter(o => o.id !== g.id).map(o => ({ id: o.id, label: o.label, twin: isTwin(g, o) }))
    try {
      return (await generateSpec(model, g, neighbors)).spec
    } catch {
      return null
    }
  })
  for (const s of generated) if (s) specs[s.id] = s

  const list = Object.values(specs)
  let calibrated: GroupSpec[] = list
  let report: CalibrationReport | undefined
  if (list.length > 0) {
    const jev = createJev(httpPort($), key)
    // Migliaia di chiamate: un errore isolato (rete, limite di richieste) non deve annullare la taratura.
    const score = async (ss: GroupSpec[], test: TestCase) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const c = await classify(jev, ss, test.message, test.context, 0)
          return { probs: c.probs, tokens: c.tokens }
        } catch (err) {
          if (attempt >= 4) throw err
          await $.clock.sleep(2000 * attempt)
        }
      }
    }
    // Se il refine fallisce il gruppo tiene la definizione attuale.
    const refine = async (spec: GroupSpec, errors: { test: TestCase; got: string[] }[]) => {
      try {
        return (await refineDefinition(model, spec, errors)).definition
      } catch {
        return spec.definition
      }
    }
    // Prima taratura: tutti i gruppi. Dopo: solo i gruppi rigenerati, più i loro vicini.
    const regenerated = generated.flatMap(g => (g ? [g.id] : []))
    const stored = await $.store.get(CACHE_KEY)
    const cache: ProbCache = stored && typeof stored === 'object' ? (stored as ProbCache) : {}
    const r = await calibrate(score, list, refine, { changed: reg ? regenerated : 'all', cache })
    calibrated = r.specs
    report = r.report
    await $.store.set(CACHE_KEY, r.cache)
  }

  const next: Registry = {
    version: 1,
    specs: Object.fromEntries(calibrated.map(s => [s.id, s])),
    threshold: report?.threshold ?? reg?.threshold ?? DEFAULT_THRESHOLD,
    report,
    haikuTokens: (reg?.haikuTokens ?? 0) + spent.tokens,
    updatedAt: new Date().toISOString(),
  }
  await $.store.set(REGISTRY_KEY, next)
  await $.store.delete('routing-error')
}

/** Avvia l'aggiornamento in background, senza attendere; mai più di uno alla volta. */
function refresh($: Ctx, force = false): void {
  if (running) return
  running = runUpdate($, force)
    .catch(async (err: unknown) => {
      // L'aggiornamento gira in background: l'errore resta nello store, visibile da /routing.
      const message = err instanceof Error ? err.message : String(err)
      await $.store.set('routing-error', { at: new Date().toISOString(), message: message.slice(0, 500) }).catch(() => {})
    })
    .finally(() => { running = null })
}

/** Il contesto da aggiungere al prompt, o null se non serve o il routing è spento. */
/** Testo scritto dall'utente: senza i blocchi che l'app aggiunge (`<system-reminder>`, `<side-sessions-event>` e simili). */
export function userText(raw: string): string {
  return raw
    .replace(/<([a-z][a-z0-9-]*(?:-[a-z0-9]+)*)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function routeContext($: Ctx, text: string): Promise<string | null> {
  const key = await apiKey($)
  if (!key) return null
  const reg = await loadRegistry($)
  const specs = Object.values(reg?.specs ?? {}).filter(s => isRoutable(s.id))
  if (!reg || specs.length === 0) return null
  const jev = createJev(httpPort($), key)
  const { ids } = await within($, classify(jev, specs, text, undefined, reg.threshold), CLASSIFY_TIMEOUT_MS)
  const lines = ids.flatMap(id => (reg.specs[id] ? [`- ${reg.specs[id].catalogLine}`] : []))
  if (lines.length === 0) return null
  return [HEADER, ...lines].join('\n')
}

/** Testo del comando /routing; con "rigenera" svuota il Registry e rilancia l'aggiornamento. */
async function routingReport($: Ctx, arg: string): Promise<string> {
  const key = await apiKey($)
  if (!key) return 'Routing spento: manca la chiave TypeSafe. Impostala nelle opzioni della mod (typesafe_api_key) o in TYPESAFE_API_KEY.'
  if (arg === 'rigenera') {
    if (running) return 'Un aggiornamento è già in corso.'
    await $.store.delete(REGISTRY_KEY)
    refresh($, true)
    return 'Registry svuotato: aggiornamento avviato in background.'
  }
  const reg = await loadRegistry($)
  if (!reg) return 'Nessun Registry: il routing non è ancora calibrato.'
  const r = reg.report
  const failure = (await $.store.get('routing-error')) as { at: string; message: string } | undefined
  return [
    ...(failure ? [`Ultimo aggiornamento fallito (${new Date(failure.at).toLocaleString('it-IT')}): ${failure.message}`] : []),
    `Soglia: ${reg.threshold}`,
    r ? `Holdout: ${r.holdoutExact}/${r.holdoutTotal} esatti` : 'Holdout: non disponibile',
    `Aggiornato: ${new Date(reg.updatedAt).toLocaleString('it-IT')}`,
    `Token Haiku: ${reg.haikuTokens}`,
    `Token Jev (ultima calibrazione): ${r?.jevTokens ?? 0}`,
    r ? `Ultima taratura: ${r.scope?.length ?? 0} gruppi, ${r.questions ?? 0} domande, definizioni accettate ${r.accepted ?? 0}, rifiutate ${r.rejected ?? 0}` : '',
    'Per gruppo (fp / fn):',
    ...(r?.perGroup ?? []).map(g => `- ${settings.labels[g.id] ?? g.id}: ${g.tests} test, fp ${g.fp}, fn ${g.fn}`),
  ].join('\n')
}

export function installRouting(on: On, s: Settings): void {
  settings = s
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    void $.command.register({
      name: ROUTING_COMMAND,
      description: 'Stato del routing dei tool: soglia, holdout, errori per gruppo, token.',
      argumentHint: '[rigenera]',
    }).catch(() => {})
    refresh($)
    return out
  })

  on('prompt.submit', async ($, e, next) => {
    // Un comando slash non si classifica: il suo testo non è una richiesta all'agente.
    if (e.command) return next(e)
    const typed = userText(e.text)
    if (typed.length < MIN_PROMPT_CHARS) return next(e)
    let text: string | null = null
    try {
      text = await routeContext($, typed.slice(0, MAX_PROMPT_CHARS))
    } catch {
      // Se Jev non risponde il messaggio parte senza suggerimenti.
    }
    if (text === null) return next(e)
    return next({ ...e, context: [...(e.context ?? []), text] })
  })

  on('command.run', { command: ROUTING_COMMAND }, async ($, e) => ({
    text: await routingReport($, e.args.trim()),
  }))
}
