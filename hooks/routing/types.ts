// Tipi condivisi della pipeline di routing (Haiku genera, Jev classifica).
// I moduli non toccano `$`: ricevono porte (ModelPort, JevPort, HttpFetch) che
// register.ts costruisce, così i test usano porte finte.
// Gli import tra moduli sono solo `import type`: i test girano con `node --test`.

/** Un tool come lo restituisce `$.tool.list()`. */
export interface ToolLike { name: string; description: string; mcp: boolean }

/** Un gruppo di tool: un server MCP. `id` è il nome del server nel nome del tool. */
export interface ToolGroup {
  id: string
  label: string
  tools: { name: string; description: string }[]
  /** Impronta di nomi e descrizioni: cambia quando cambia il server. */
  hash: string
  /** Impronta dei soli nomi dei tool: decide se il gruppo va rigenerato. */
  namesHash: string
}

/** Un messaggio di prova: il contesto è l'ultimo turno dell'assistente, se serve. */
export interface TestCase { context?: string; message: string; expected: string[] }

/** Quello che Haiku produce per un gruppo. */
export interface GroupSpec {
  id: string
  hash: string
  /** Impronta dei soli nomi; assente nelle spec create prima della 0.4.0. */
  namesHash?: string
  /** Una riga per il catalogo dei tool differiti, max 200 caratteri. */
  catalogLine: string
  /** Area del gruppo per Jev: quando vale e quando NON vale. Max 400 caratteri. */
  definition: string
  tests: TestCase[]
}

export interface GroupScore { id: string; tests: number; fp: number; fn: number }

export interface CalibrationReport {
  threshold: number
  holdoutExact: number
  holdoutTotal: number
  perGroup: GroupScore[]
  rounds: number
  jevTokens: number
  /** Domande Noul inviate a Jev in questa taratura (una per coppia test-gruppo non in cache). */
  questions: number
  /** Gruppi tarati in questa esecuzione: cambiati più vicini, o tutti. */
  scope: string[]
  accepted: number
  rejected: number
}

/**
 * Probabilità già misurate. Chiave: `${testKey}|${specId}|${defKey}`, dove testKey è
 * l'hash di context + "\n" + message e defKey l'hash della definizione (FNV-1a 32 bit, 8 cifre esadecimali).
 * Jev risponde a ogni domanda Noul in modo indipendente: una cella resta valida finché la definizione non cambia.
 */
export type ProbCache = Record<string, number>

export const CACHE_KEY = 'routing-cache'

/** Stato salvato in `$.store` sotto la chiave REGISTRY_KEY. */
export interface Registry {
  version: 1
  specs: Record<string, GroupSpec>
  threshold: number
  report?: CalibrationReport
  haikuTokens: number
  updatedAt: string
}

export const REGISTRY_KEY = 'routing-registry'
export const DEFAULT_THRESHOLD = 0.6
export const THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8]

/** Avvolge `$.model.complete` con model "haiku". Rigetta se non c'è risposta. */
export interface ModelPort {
  complete(prompt: string, system?: string): Promise<{ text: string; tokens: number }>
}

/** Una chiamata Jev con sole domande Noul: id domanda -> testo della domanda. */
export interface JevPort {
  noul(state: Record<string, unknown>, questions: Record<string, string>): Promise<{ probs: Record<string, number>; tokens: number }>
}

/** Avvolge `$.http.fetch`. */
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ status: number; ok: boolean; text: string }>

export interface Classification { ids: string[]; probs: Record<string, number>; tokens: number }

// Firme che ogni modulo esporta.

// inventory.ts
export type GroupTools = (tools: ToolLike[], labels: Record<string, string>) => ToolGroup[]
export type DiffGroups = (groups: ToolGroup[], specs: Record<string, GroupSpec>) => { changed: ToolGroup[]; removed: string[] }

// jev.ts
export type CreateJev = (fetch: HttpFetch, apiKey: string) => JevPort
export type Classify = (jev: JevPort, specs: GroupSpec[], message: string, context: string | undefined, threshold: number) => Promise<Classification>

// generate.ts
/** twin: il vicino ha gli stessi tool di questo gruppo (stesso servizio, altro account o sito). */
export type Neighbor = { id: string; label: string; twin?: boolean }
export type GenerateSpec = (model: ModelPort, group: ToolGroup, neighbors: Neighbor[]) => Promise<{ spec: GroupSpec; tokens: number }>
export type RefineDefinition = (model: ModelPort, spec: GroupSpec, errors: { test: TestCase; got: string[] }[]) => Promise<{ definition: string; tokens: number }>

// calibrate.ts
// `score` chiede a Jev solo le spec passate e restituisce le loro probabilità.
// `changed`: id dei gruppi nuovi o cambiati, oppure 'all' per la prima taratura.
export type Calibrate = (
  score: (specs: GroupSpec[], test: TestCase) => Promise<{ probs: Record<string, number>; tokens: number }>,
  specs: GroupSpec[],
  refine: (spec: GroupSpec, errors: { test: TestCase; got: string[] }[]) => Promise<string>,
  options: { changed: string[] | 'all'; cache: ProbCache; maxRounds?: number },
) => Promise<{ specs: GroupSpec[]; report: CalibrationReport; cache: ProbCache }>
