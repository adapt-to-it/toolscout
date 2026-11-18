import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate } from '../../hooks/routing/calibrate.ts'
import type { Calibrate, GroupSpec, ProbCache, TestCase } from '../../hooks/routing/types.ts'

type Score = Parameters<Calibrate>[0]
type Refine = Parameters<Calibrate>[2]

const t = (message: string, expected: string[]): TestCase => ({ message, expected })
const spec = (id: string, tests: TestCase[]): GroupSpec => ({
  id,
  hash: 'h-' + id,
  catalogLine: id,
  definition: 'def-' + id,
  tests,
})
const opts = (changed: string[] | 'all', cache: ProbCache = {}, maxRounds = 3) => ({ changed, cache, maxRounds })

// Probabilità finta: alta per i gruppi attesi, bassa per gli altri.
const oracle = (s: GroupSpec, test: TestCase): number => (test.expected.includes(s.id) ? 0.9 : 0.1)

function fakeScore(probFor: (s: GroupSpec, test: TestCase) => number) {
  const seen: { test: TestCase; ids: string[] }[] = []
  const score: Score = async (specs, test) => {
    seen.push({ test, ids: specs.map(s => s.id) })
    const probs: Record<string, number> = {}
    for (const s of specs) probs[s.id] = probFor(s, test)
    return { probs, tokens: 1 }
  }
  return { score, seen }
}

function fakeRefine(definition: (s: GroupSpec) => string) {
  const calls: { id: string; errors: number }[] = []
  const refine: Refine = async (s, errors) => {
    calls.push({ id: s.id, errors: errors.length })
    return definition(s)
  }
  return { refine, calls }
}

// Due gruppi: A corretto; B sbaglia (falsi positivi) finché la definizione non è 'fixed'.
const twoSpecs = (): GroupSpec[] => [
  spec('A', [t('a0', ['A']), t('a1', ['A'])]),
  spec('B', [t('b0', []), t('b1', [])]),
]
const probB = (s: GroupSpec, test: TestCase): number =>
  s.id === 'B' && s.definition !== 'fixed' ? 0.9 : oracle(s, test)

describe('calibrate', () => {
  test('holdout: indice % 3 === 2 in ogni spec, valutato con la soglia finale', async () => {
    const specs = [spec('A', ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map(m => t(m, ['A'])))]
    const { score, seen } = fakeScore(oracle)
    const { refine, calls } = fakeRefine(() => 'x')
    const out = await calibrate(score, specs, refine, opts('all'))
    assert.equal(out.report.holdoutTotal, 2)
    assert.equal(out.report.holdoutExact, 2)
    assert.equal(calls.length, 0)
    assert.ok(seen.some(x => x.test.message === 'm2'))
    assert.ok(seen.some(x => x.test.message === 'm5'))
    assert.equal(out.report.jevTokens, 6)
    assert.equal(out.report.questions, 6)
    assert.equal(out.report.rounds, 1)
    assert.deepEqual(out.report.scope, ['A'])
  })

  test('gli errori sull holdout non arrivano a refine', async () => {
    const specs = [spec('A', ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map(m => t(m, ['A'])))]
    const { score } = fakeScore((s, test) => (test.message === 'm2' ? 0.1 : oracle(s, test)))
    const { refine, calls } = fakeRefine(() => 'x')
    const out = await calibrate(score, specs, refine, opts('all'))
    assert.equal(calls.length, 0)
    assert.equal(out.report.holdoutExact, 1)
    assert.equal(out.report.holdoutTotal, 2)
  })

  test('sceglie la soglia con più test esatti', async () => {
    const specs = [spec('A', [t('x0', ['A']), t('x1', ['A'])])]
    // 0.45 è esatto solo con soglia 0.4
    const { score } = fakeScore((s, test) => (test.expected.includes(s.id) ? 0.45 : 0.1))
    const out = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts('all'))
    assert.equal(out.report.threshold, 0.4)
    assert.equal(out.report.holdoutTotal, 0)
  })

  test('a pari merito sceglie la soglia più vicina al default', async () => {
    const specs = [spec('A', [t('x0', ['A']), t('x1', ['A'])])]
    const { score } = fakeScore(oracle)
    const out = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts('all'))
    assert.equal(out.report.threshold, 0.6)
  })

  test('corregge le spec con errori e si ferma quando non ne restano', async () => {
    const { score } = fakeScore(probB)
    const { refine, calls } = fakeRefine(() => 'fixed')
    const out = await calibrate(score, twoSpecs(), refine, opts('all'))
    // B è falso positivo su tutti e 4 i test di taratura (anche su quelli di A)
    assert.deepEqual(calls, [{ id: 'B', errors: 4 }])
    assert.equal(out.specs[0].definition, 'def-A')
    assert.equal(out.specs[1].definition, 'fixed')
    assert.equal(out.report.rounds, 2)
    assert.equal(out.report.accepted, 1)
    assert.equal(out.report.rejected, 0)
    // 4 test x 2 spec al primo fill, poi 4 test x 1 spec per la candidata
    assert.equal(out.report.questions, 12)
    assert.equal(out.report.jevTokens, 8)
    assert.equal(out.report.holdoutExact, 0)
  })

  test('si ferma dopo maxRounds', async () => {
    // B sbaglia sui test b0..b(k-1), con k = numero di '#' nella definizione
    const hashes = (s: GroupSpec): number => s.definition.split('#').length - 1
    const probStep = (s: GroupSpec, test: TestCase): number =>
      s.id === 'B' && test.expected.length === 0 && Number(test.message.slice(1)) >= hashes(s) ? 0.9 : oracle(s, test)
    const { score } = fakeScore(probStep)
    const { refine, calls } = fakeRefine(s => s.definition + '#')
    const out = await calibrate(score, twoSpecs(), refine, opts('all', {}, 1))
    assert.equal(calls.length, 1)
    assert.equal(out.report.rounds, 1)
    assert.equal(out.report.accepted, 1)
    assert.equal(out.specs[1].definition, 'def-B#')
  })

  test('una candidata peggiore viene rifiutata e non finisce in cache', async () => {
    // def-B: FP su b0,b1. 'bad': FP su tutti i test (peggio).
    const probWorse = (s: GroupSpec, test: TestCase): number => {
      if (s.id !== 'B') return oracle(s, test)
      if (s.definition === 'bad') return 0.9
      if (s.definition === 'def-B') return test.expected.length === 0 ? 0.9 : 0.1
      return oracle(s, test)
    }
    const { score } = fakeScore(probWorse)
    const { refine, calls } = fakeRefine(() => 'bad')
    const out = await calibrate(score, twoSpecs(), refine, opts('all'))
    assert.equal(calls.length, 1)
    assert.equal(out.report.accepted, 0)
    assert.equal(out.report.rejected, 1)
    assert.equal(out.specs[1].definition, 'def-B')
    assert.ok(Object.keys(out.cache).every(k => !k.includes('"bad"')))
  })

  test('la chiave della cache segue il formato testKey|specId|defKey con FNV-1a', async () => {
    const specs = [spec('A', [t('a0', ['A'])])]
    const { score } = fakeScore(oracle)
    const out = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts('all'))
    const keys = Object.keys(out.cache)
    assert.equal(keys.length, 1)
    assert.match(keys[0], /^[0-9a-f]{8}\|A\|[0-9a-f]{8}$/)
    // FNV-1a 32 bit sulle unità UTF-16 di '\na0' e di 'def-A', come in inventory.ts
    const fnv = (s: string): string => {
      let h = 0x811c9dc5
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(16).padStart(8, '0')
    }
    assert.equal(keys[0], `${fnv('\na0')}|A|${fnv('def-A')}`)
  })

  test('una seconda taratura senza cambi fa zero domande', async () => {
    const first = await calibrate(fakeScore(probB).score, twoSpecs(), fakeRefine(() => 'fixed').refine, opts('all'))
    const { score, seen } = fakeScore(probB)
    const { refine, calls } = fakeRefine(() => 'fixed')
    const second = await calibrate(score, first.specs, refine, opts([], first.cache))
    assert.equal(second.report.questions, 0)
    assert.equal(seen.length, 0)
    assert.equal(calls.length, 0)
    assert.deepEqual(second.report.scope, [])
  })

  test('changed limita lo scope ai cambiati e ai vicini', async () => {
    const specs = [
      spec('A', [t('a0', ['A']), t('a1', ['A'])]),
      spec('B', [t('b0', ['B']), t('b1', ['B'])]),
      spec('C', [t('c0', ['C']), t('c1', ['C'])]),
    ]
    const { score } = fakeScore(oracle)
    const limited = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts(['A']))
    assert.deepEqual(limited.report.scope, ['A'])
    const full = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts('all'))
    assert.deepEqual(full.report.scope, ['A', 'B', 'C'])
  })

  test('changed porta nello scope i vicini con probabilità >= 0.3 sui test dei cambiati', async () => {
    const specs = [
      spec('A', [t('a0', ['A']), t('a1', ['A'])]),
      spec('B', [t('b0', ['B']), t('b1', ['B'])]),
      spec('C', [t('c0', ['C']), t('c1', ['C'])]),
    ]
    const { score } = fakeScore((s, test) => (s.id === 'B' ? 0.9 : oracle(s, test)))
    const out = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts(['A']))
    assert.deepEqual(out.report.scope, ['A', 'B'])
  })

  test('al massimo 4 chiamate score in parallelo', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const score: Score = async (specs, _test) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return { probs: Object.fromEntries(specs.map(s => [s.id, 0.9])), tokens: 1 }
    }
    const specs = [spec('A', Array.from({ length: 10 }, (_, i) => t('m' + i, ['A'])))]
    await calibrate(score, specs, fakeRefine(() => 'x').refine, opts('all'))
    assert.equal(maxInFlight, 4)
  })

  test('gli id assenti dalle spec vengono tolti dagli expected', async () => {
    const specs = [spec('A', [t('a0', ['A', 'X']), t('a1', ['A'])])]
    const { score, seen } = fakeScore(oracle)
    const out = await calibrate(score, specs, fakeRefine(() => 'x').refine, opts('all'))
    assert.ok(seen.every(x => x.test.expected.every(id => id === 'A')))
    assert.equal(out.report.rounds, 1)
  })

  test('non muta le spec né la cache in ingresso e restituisce copie', async () => {
    const input = twoSpecs()
    const before = JSON.stringify(input)
    const cache: ProbCache = {}
    const cacheBefore = JSON.stringify(cache)
    const { score } = fakeScore(probB)
    const { refine } = fakeRefine(() => 'fixed')
    const out = await calibrate(score, input, refine, opts('all', cache))
    assert.equal(JSON.stringify(input), before)
    assert.equal(JSON.stringify(cache), cacheBefore)
    assert.notEqual(out.specs[0], input[0])
    assert.notEqual(out.specs[1].tests, input[1].tests)
  })

  test('la prova di una definizione rimisura solo i test pertinenti al gruppo', async () => {
    // B sbaglia solo su b0; i test di A hanno probabilità bassa per B e non si rimisurano.
    const specs = [
      spec('A', Array.from({ length: 9 }, (_, i) => t('a' + i, ['A']))),
      spec('B', [t('b0', ['B']), t('b1', ['B']), t('b2', ['B'])]),
    ]
    const prob = (s: GroupSpec, test: TestCase): number =>
      s.id === 'B' && test.message === 'b0' && s.definition === 'def-B' ? 0.1 : oracle(s, test)
    const { score, seen } = fakeScore(prob)
    const { refine, calls } = fakeRefine(() => 'fixed')
    const out = await calibrate(score, specs, refine, opts('all'))
    assert.deepEqual(calls, [{ id: 'B', errors: 1 }])
    assert.equal(out.report.accepted, 1)
    const trial = seen.slice(12)
    assert.deepEqual(trial.map(x => x.test.message).sort(), ['b0', 'b1', 'b2'])
    // 12 test x 2 spec al primo fill, poi 3 domande per la candidata invece di 12
    assert.equal(out.report.questions, 27)
    // La cache in uscita copre comunque tutti i test con la definizione finale
    assert.equal(Object.keys(out.cache).length, 24)
  })
})
