import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSpec, refineDefinition } from '../../hooks/routing/generate.ts'
import type { GroupSpec, ModelPort, TestCase, ToolGroup } from '../../hooks/routing/types.ts'

/** Modello finto: risponde in ordine con i testi preparati e registra i prompt. */
function finto(risposte: string[]): ModelPort & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt)
      const text = risposte.shift()
      if (text === undefined) throw new Error('nessuna risposta preparata')
      return { text, tokens: 10 }
    },
  }
}

const gruppo: ToolGroup = {
  id: 'reaper',
  label: 'REAPER',
  hash: 'h1',
  tools: [{ name: 'reaper__track_add', description: 'Aggiunge una traccia al progetto' }],
}
const vicini = [{ id: 'video', label: 'Video e animazioni' }]

const definizione = {
  catalogLine: 'DAW REAPER: tracce, mix, MIDI',
  definition: 'Serve per audio in REAPER. Non serve per video (vedi video).',
}

const casi: TestCase[] = [
  ...Array.from({ length: 6 }, (_, i) => ({ message: `metti in mix la traccia ${i}`, expected: ['reaper'] })),
  ...Array.from({ length: 4 }, (_, i) => ({ message: `renderizza il video ${i}`, expected: ['video'] })),
  { context: 'Assistente: posso mettere un limiter sul master. Procedo?', message: 'sì, procedi', expected: ['reaper'] },
  { context: 'Assistente: Procedo con il compressore sul basso?', message: 'ok vai', expected: ['reaper'] },
]
const testJson = JSON.stringify({ tests: casi })

test('generateSpec costruisce la spec con hash del gruppo e token sommati', async () => {
  const porta = finto([JSON.stringify(definizione), testJson])
  const { spec, tokens } = await generateSpec(porta, gruppo, vicini)
  assert.equal(spec.id, 'reaper')
  assert.equal(spec.hash, 'h1')
  assert.equal(spec.catalogLine, definizione.catalogLine)
  assert.equal(spec.definition, definizione.definition)
  assert.equal(spec.tests.length, 12)
  assert.deepEqual(spec.tests[0], { message: 'metti in mix la traccia 0', expected: ['reaper'] })
  assert.deepEqual(spec.tests[11].context, casi[11].context)
  assert.equal(tokens, 20)
})

test('estrae il JSON da recinto ```json e da prosa', async () => {
  const porta = finto([
    'Ecco la definizione:\n```json\n' + JSON.stringify(definizione) + '\n```',
    'Ecco i test: ' + testJson + ' fine.',
  ])
  const { spec } = await generateSpec(porta, gruppo, vicini)
  assert.equal(spec.catalogLine, definizione.catalogLine)
  assert.equal(spec.tests.length, 12)
})

test('tronca catalogLine a 200 e definition a 400 caratteri', async () => {
  const lunga = { catalogLine: 'x'.repeat(250), definition: 'y'.repeat(500) }
  const porta = finto([JSON.stringify(lunga), testJson])
  const { spec } = await generateSpec(porta, gruppo, vicini)
  assert.equal(spec.catalogLine.length, 200)
  assert.equal(spec.definition.length, 400)
})

test('la seconda chiamata non riceve la definizione', async () => {
  const porta = finto([JSON.stringify(definizione), testJson])
  await generateSpec(porta, gruppo, vicini)
  assert.equal(porta.prompts.length, 2)
  assert.equal(porta.prompts[1].includes('Serve per audio'), false)
})

test('limita i tool a 60 e le descrizioni a 300 caratteri', async () => {
  const molti: ToolGroup = {
    ...gruppo,
    tools: [
      { name: 'lunga', description: 'a'.repeat(500) },
      ...Array.from({ length: 70 }, (_, i) => ({ name: `t${i}`, description: 'd' })),
    ],
  }
  const porta = finto([JSON.stringify(definizione), testJson])
  await generateSpec(porta, molti, vicini)
  const prompt = porta.prompts[0]
  // 60 tool in tutto: "lunga" più t0..t58.
  assert.equal(prompt.includes('- t58:'), true)
  assert.equal(prompt.includes('- t59:'), false)
  assert.equal(prompt.includes('a'.repeat(300)), true)
  assert.equal(prompt.includes('a'.repeat(301)), false)
})

test('risposta non valida: una sola nuova richiesta con l\'errore, poi successo', async () => {
  const porta = finto(['risposta senza json', JSON.stringify(definizione), testJson])
  const { spec, tokens } = await generateSpec(porta, gruppo, vicini)
  assert.equal(spec.tests.length, 12)
  assert.equal(porta.prompts.length, 3)
  assert.equal(porta.prompts[1].includes('non era un JSON valido'), true)
  assert.equal(tokens, 30)
})

test('risposta non valida due volte: throw dopo una sola nuova richiesta', async () => {
  const porta = finto(['no', 'ancora no'])
  await assert.rejects(generateSpec(porta, gruppo, vicini))
  assert.equal(porta.prompts.length, 2)
})

test('expected con id sconosciuti non passa la validazione', async () => {
  const inventati = JSON.stringify({ tests: [{ message: 'ciao', expected: ['seo'] }] })
  const porta = finto([JSON.stringify(definizione), inventati, inventati])
  await assert.rejects(generateSpec(porta, gruppo, vicini))
})

test('refineDefinition riporta gli errori, tronca a 400 e somma i token', async () => {
  const spec: GroupSpec = {
    id: 'reaper',
    hash: 'h1',
    catalogLine: 'DAW',
    definition: 'vecchia definizione',
    tests: [],
  }
  const errori = [{ test: casi[0], got: ['video'] }]
  const porta = finto([JSON.stringify({ definition: 'n'.repeat(450) })])
  const { definition, tokens } = await refineDefinition(porta, spec, errori)
  assert.equal(definition.length, 400)
  assert.equal(tokens, 10)
  assert.equal(porta.prompts[0].includes('atteso: reaper'), true)
  assert.equal(porta.prompts[0].includes('ottenuto: video'), true)
  assert.equal(porta.prompts[0].includes('vecchia definizione'), true)
})
