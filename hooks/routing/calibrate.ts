// Calibrazione di soglia e definizioni sul banco di prova.
// I test si dividono in taratura (scelta della soglia, correzione delle definizioni)
// e holdout (indice % 3 === 2 dentro ogni spec, mai usato per correggere).
// Le probabilità vivono in una cache per cella (spec, definizione, test): una cella misurata non si richiede più.
// Il modulo importa da './types' solo con import type: le costanti sono copiate qui.
import type { Calibrate, CalibrationReport, GroupScore, GroupSpec, ProbCache, TestCase } from './types'

// Copie di THRESHOLDS e DEFAULT_THRESHOLD di types.ts.
const THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8]
const DEFAULT_THRESHOLD = 0.6
// Probabilità oltre cui un gruppo è vicino a un gruppo cambiato.
const NEIGHBOR_PROB = 0.3
const CONCURRENCY = 4
const EPS = 1e-9

type Score = Parameters<Calibrate>[0]
type Refine = Parameters<Calibrate>[2]
type Probs = Record<string, number>
type Errors = { test: TestCase; got: string[] }[]
interface Item { group: string; holdout: boolean; test: TestCase }
interface Run { questions: number; tokens: number }

function copySpec(spec: GroupSpec): GroupSpec {
  return { ...spec, tests: spec.tests.map(t => ({ ...t, expected: [...t.expected] })) }
}

// FNV-1a 32 bit sulle unità UTF-16 di `s`, in esadecimale a 8 cifre. Stesso schema di hash in inventory.ts.
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Chiave della cella nel ProbCache: `${testKey}|${specId}|${defKey}` (vedi ProbCache in types.ts).
function cellKey(spec: GroupSpec, test: TestCase): string {
  const testKey = fnv1a((test.context ?? '') + '\n' + test.message)
  const defKey = fnv1a(spec.definition)
  return `${testKey}|${spec.id}|${defKey}`
}

// Probabilità di tutte le spec date per un test, lette dalla cache (il fill le ha già misurate).
function probsOf(cells: ProbCache, test: TestCase, specs: GroupSpec[]): Probs {
  const out: Probs = {}
  for (const s of specs) {
    const p = cells[cellKey(s, test)]
    if (p === undefined) throw new Error(`cella mancante per ${s.id}`)
    out[s.id] = p
  }
  return out
}

// Pool di test: expected ripulito dagli id che non sono gruppi delle spec.
function buildItems(specs: GroupSpec[]): { cal: Item[]; hold: Item[] } {
  const known = new Set(specs.map(s => s.id))
  const cal: Item[] = []
  const hold: Item[] = []
  for (const spec of specs) {
    spec.tests.forEach((t, i) => {
      const test: TestCase = { ...t, expected: t.expected.filter(id => known.has(id)) }
      const item: Item = { group: spec.id, holdout: i % 3 === 2, test }
      if (item.holdout) hold.push(item)
      else cal.push(item)
    })
  }
  return { cal, hold }
}

// Misura le celle mancanti: una domanda per coppia test-spec non in cache; al massimo CONCURRENCY test in parallelo.
// Il test senza celle mancanti non chiama score.
async function fill(score: Score, cells: ProbCache, tests: TestCase[], specs: GroupSpec[], run: Run): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tests.length) {
      const test = tests[next++]
      const missing = specs.filter(s => cells[cellKey(s, test)] === undefined)
      if (missing.length === 0) continue
      const r = await score(missing, test)
      run.questions += missing.length
      run.tokens += r.tokens
      for (const s of missing) {
        const p = r.probs[s.id]
        if (p === undefined) throw new Error(`score senza probabilità per ${s.id}`)
        cells[cellKey(s, test)] = p
      }
    }
  }
  const lanes = Math.min(CONCURRENCY, tests.length)
  await Promise.all(Array.from({ length: lanes }, () => worker()))
}

function idsAt(probs: Probs, threshold: number): string[] {
  return Object.keys(probs).filter(id => probs[id] >= threshold)
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

// Soglia con più test esatti; a pari merito la più vicina a DEFAULT_THRESHOLD (la più bassa se ancora pari).
function pickThreshold(items: Item[], cells: ProbCache, specs: GroupSpec[]): number {
  const probs = items.map(it => probsOf(cells, it.test, specs))
  let best = THRESHOLDS[0]
  let bestExact = -1
  for (const thr of THRESHOLDS) {
    const exact = items.filter((it, i) => sameSet(idsAt(probs[i], thr), it.test.expected)).length
    const closer = Math.abs(thr - DEFAULT_THRESHOLD) < Math.abs(best - DEFAULT_THRESHOLD) - EPS
    if (exact > bestExact || (exact === bestExact && closer)) {
      best = thr
      bestExact = exact
    }
  }
  return best
}

// Falsi positivi e negativi (tra gli id dati) di un test alla soglia data.
function judge(test: TestCase, probs: Probs, threshold: number, ids: string[]): { got: string[]; fp: string[]; fn: string[] } {
  const got = idsAt(probs, threshold)
  const g = new Set(got)
  const e = new Set(test.expected)
  return {
    got,
    fp: ids.filter(id => g.has(id) && !e.has(id)),
    fn: ids.filter(id => !g.has(id) && e.has(id)),
  }
}

// Errori per spec: ogni test in cui la spec è falso positivo o falso negativo.
function errorsOf(specs: GroupSpec[], items: Item[], cells: ProbCache, threshold: number): Record<string, Errors> {
  const ids = specs.map(s => s.id)
  const errors: Record<string, Errors> = {}
  for (const id of ids) errors[id] = []
  for (const it of items) {
    const j = judge(it.test, probsOf(cells, it.test, specs), threshold, ids)
    for (const id of [...j.fp, ...j.fn]) errors[id].push({ test: it.test, got: j.got })
  }
  return errors
}

// Gruppi da tarare: tutti con 'all'; altrimenti i cambiati, quelli negli expected dei loro test
// e quelli con probabilità >= NEIGHBOR_PROB sui loro test (cache già riempita).
function scopeOf(changed: string[] | 'all', specs: GroupSpec[], items: Item[], cells: ProbCache): string[] {
  if (changed === 'all') return specs.map(s => s.id)
  const near = new Set(changed)
  for (const it of items) {
    if (!changed.includes(it.group)) continue
    for (const id of it.test.expected) near.add(id)
    const probs = probsOf(cells, it.test, specs)
    for (const s of specs) if (probs[s.id] >= NEIGHBOR_PROB) near.add(s.id)
  }
  return specs.map(s => s.id).filter(id => near.has(id))
}

// Test da rimisurare per una nuova definizione di `spec`: i test del gruppo, quelli che lo attendono,
// quelli in cui sbaglia e quelli in cui la definizione attuale ha probabilità >= NEIGHBOR_PROB.
function relevantTests(spec: GroupSpec, items: Item[], errs: Errors, cells: ProbCache): Set<TestCase> {
  const out = new Set<TestCase>(errs.map(e => e.test))
  for (const it of items) {
    const near = (cells[cellKey(spec, it.test)] ?? 1) >= NEIGHBOR_PROB
    if (it.group === spec.id || it.test.expected.includes(spec.id) || near) out.add(it.test)
  }
  return out
}

export const calibrate: Calibrate =async (score, specs, refine, { changed, cache, maxRounds = 3 }) => {
  let current = specs.map(copySpec)
  const { cal, hold } = buildItems(current)
  const all = [...cal, ...hold]
  const tests = all.map(it => it.test)
  // Copia di lavoro: la cache in ingresso non viene modificata.
  const cells: ProbCache = { ...cache }
  const run: Run = { questions: 0, tokens: 0 }
  let accepted = 0
  let rejected = 0
  let rounds = 0

  // Primo fill: tutti i test per tutte le spec (le celle in cache non costano).
  await fill(score, cells, tests, current, run)
  const scope = scopeOf(changed, current, all, cells)
  let threshold = pickThreshold(cal, cells, current)

  while (rounds < maxRounds) {
    rounds++
    let roundAccepted = 0
    for (const id of scope) {
      const s = current.find(x => x.id === id)
      if (!s) continue
      const errs = errorsOf(current, cal, cells, threshold)[id]
      if (errs.length === 0) continue
      const definition = await refine(copySpec(s), errs)
      const trial = current.map(x => (x.id === id ? { ...x, definition } : x))
      const candidate = trial.find(x => x.id === id)!
      // Prova mirata: si rimisurano solo i test pertinenti al gruppo. Gli altri ereditano
      // la probabilità della definizione attuale, già sotto NEIGHBOR_PROB.
      const relevant = relevantTests(s, all, errs, cells)
      for (const it of all) {
        if (!relevant.has(it.test)) cells[cellKey(candidate, it.test)] = cells[cellKey(s, it.test)]
      }
      await fill(score, cells, [...relevant], trial, run)
      if (errorsOf(trial, cal, cells, threshold)[id].length < errs.length) {
        current = trial
        accepted++
        roundAccepted++
      } else {
        rejected++
      }
    }
    threshold = pickThreshold(cal, cells, current)
    if (roundAccepted === 0) break
  }

  const holdoutExact = hold.filter(it => sameSet(idsAt(probsOf(cells, it.test, current), threshold), it.test.expected)).length

  // perGroup: su tutto il pool (taratura e holdout) con spec e soglia finali.
  // tests conta i test del gruppo; fp e fn contano gli errori della spec su tutto il pool.
  const ids = current.map(s => s.id)
  const perGroup: GroupScore[] = current.map(s => ({ id: s.id, tests: 0, fp: 0, fn: 0 }))
  for (const it of all) {
    const j = judge(it.test, probsOf(cells, it.test, current), threshold, ids)
    current.forEach((s, k) => {
      if (it.group === s.id) perGroup[k].tests++
      if (j.fp.includes(s.id)) perGroup[k].fp++
      if (j.fn.includes(s.id)) perGroup[k].fn++
    })
  }

  // Cache in uscita: solo le celle delle definizioni finali.
  const out: ProbCache = {}
  for (const it of all) {
    for (const s of current) {
      const k = cellKey(s, it.test)
      out[k] = cells[k]
    }
  }

  const report: CalibrationReport = {
    threshold,
    holdoutExact,
    holdoutTotal: hold.length,
    perGroup,
    rounds,
    jevTokens: run.tokens,
    questions: run.questions,
    scope,
    accepted,
    rejected,
  }
  return { specs: current, report, cache: out }
}
