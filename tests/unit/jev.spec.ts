import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, createJev } from '../../hooks/routing/jev.ts'
import type { GroupSpec, HttpFetch, JevPort } from '../../hooks/routing/types.ts'

interface Sent { url: string; init: { method: string; headers: Record<string, string>; body: string } }

function fakeFetch(status: number, text: string, sent: Sent[]): HttpFetch {
  return async (url, init) => {
    sent.push({ url, init })
    return { status, ok: status >= 200 && status < 300, text }
  }
}

function answers(probs: Record<string, number>, inputTokens = 10): string {
  const answersObj: Record<string, { noul: number }> = {}
  for (const [id, p] of Object.entries(probs)) answersObj[id] = { noul: p }
  return JSON.stringify({ answers: answersObj, usage: { input_tokens: inputTokens } })
}

function spec(id: string, definition: string): GroupSpec {
  return { id, hash: 'h', catalogLine: id, definition, tests: [] }
}

interface NoulCall { state: Record<string, unknown>; questions: Record<string, string> }

function fakeJev(probs: Record<string, number>, calls: NoulCall[]): JevPort {
  return {
    async noul(state, questions) {
      calls.push({ state, questions })
      return { probs, tokens: 42 }
    },
  }
}

test('createJev fa una POST per chiamata con body e header attesi', async () => {
  const sent: Sent[] = []
  const jev = createJev(fakeFetch(200, answers({ seo: 0.93 }, 77), sent), 'KEY123')
  const out = await jev.noul({ messaggio_utente: 'ciao' }, { seo: 'Area SEO' })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(sent[0].init.method, 'POST')
  assert.equal(sent[0].init.headers.Authorization, 'Bearer KEY123')
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json')

  const body = JSON.parse(sent[0].init.body)
  assert.deepEqual(body, {
    model: 'jev-latest',
    state: { messaggio_utente: 'ciao' },
    questions: { seo: { type: 'noul', instructions: 'Area SEO' } },
  })
  assert.deepEqual(out, { probs: { seo: 0.93 }, tokens: 77 })
})

test('createJev con status non ok lancia errore con status e primi 200 caratteri', async () => {
  const sent: Sent[] = []
  const jev = createJev(fakeFetch(503, 'x'.repeat(300), sent), 'K')
  await assert.rejects(
    () => jev.noul({ messaggio_utente: 'ciao' }, { seo: 'Area SEO' }),
    (err: Error) => err.message === `Jev HTTP 503: ${'x'.repeat(200)}`,
  )
})

test('createJev rifiuta una risposta senza noul per una domanda', async () => {
  const sent: Sent[] = []
  const jev = createJev(fakeFetch(200, JSON.stringify({ answers: {} }), sent), 'K')
  await assert.rejects(() => jev.noul({ messaggio_utente: 'ciao' }, { seo: 'Area SEO' }), /senza noul per seo/)
})

test('classify manda contesto_recente solo se presente e costruisce le domande dalla definizione', async () => {
  const calls: NoulCall[] = []
  const jev = fakeJev({ seo: 0.9 }, calls)
  await classify(jev, [spec('seo', 'Area SEO di prova')], 'sì, fallo', 'Assistente: vuoi procedere?', 0.6)
  assert.equal(calls[0].state.contesto_recente, 'Assistente: vuoi procedere?')
  assert.equal(calls[0].state.messaggio_utente, 'sì, fallo')
  assert.equal(
    calls[0].questions.seo,
    'Per rispondere al `messaggio_utente` (letto alla luce del `contesto_recente`, se presente) servono strumenti di questa area? Area: Area SEO di prova',
  )

  const noCtx: NoulCall[] = []
  await classify(fakeJev({ seo: 0.9 }, noCtx), [spec('seo', 'x')], 'ciao', undefined, 0.6)
  assert.equal('contesto_recente' in noCtx[0].state, false)
})

test('classify restituisce gli id sopra soglia in ordine di probabilità decrescente', async () => {
  const calls: NoulCall[] = []
  const jev = fakeJev({ a: 0.7, b: 0.95, c: 0.5, d: 0.6 }, calls)
  const specs = [spec('a', 'A'), spec('b', 'B'), spec('c', 'C'), spec('d', 'D')]
  const out = await classify(jev, specs, 'msg', undefined, 0.6)
  assert.deepEqual(out.ids, ['b', 'a', 'd'])
  assert.deepEqual(out.probs, { a: 0.7, b: 0.95, c: 0.5, d: 0.6 })
  assert.equal(out.tokens, 42)
  assert.equal(calls.length, 1)
})

test('classify con specs vuote non chiama Jev', async () => {
  const jev: JevPort = {
    async noul() { throw new Error('non doveva essere chiamato') },
  }
  const out = await classify(jev, [], 'msg', undefined, 0.6)
  assert.deepEqual(out, { ids: [], probs: {}, tokens: 0 })
})
