// Jev come porta di classificazione: una domanda Noul per gruppo di tool.
// Riceve `fetch` e la chiave come parametri: non tocca `$`.

import type { Classify, CreateJev, HttpFetch, JevPort } from './types'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

// Testo della domanda come nel prototipo: l'area è `spec.definition`.
const INTRO = 'Per rispondere al `messaggio_utente` (letto alla luce del `contesto_recente`, se presente) servono strumenti di questa area? Area: '

interface JevResponse {
  answers?: Record<string, { noul?: unknown }>
  usage?: { input_tokens?: unknown }
}

export const createJev: CreateJev = (fetch: HttpFetch, apiKey: string): JevPort => ({
  async noul(state, questions) {
    const body = JSON.stringify({
      model: 'jev-latest',
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, text]) => [id, { type: 'noul', instructions: text }]),
      ),
    })
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    })
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${res.text.slice(0, 200)}`)

    const out = JSON.parse(res.text) as JevResponse
    const probs: Record<string, number> = {}
    for (const id of Object.keys(questions)) {
      const p = out.answers?.[id]?.noul
      if (typeof p !== 'number') throw new Error(`Jev: risposta senza noul per ${id}`)
      probs[id] = p
    }
    const inTok = out.usage?.input_tokens
    return { probs, tokens: typeof inTok === 'number' ? inTok : 0 }
  },
})

export const classify: Classify = async (jev, specs, message, context, threshold) => {
  if (specs.length === 0) return { ids: [], probs: {}, tokens: 0 }

  const state: Record<string, unknown> = { messaggio_utente: message }
  if (context) state.contesto_recente = context

  const questions: Record<string, string> = {}
  for (const spec of specs) questions[spec.id] = INTRO + spec.definition

  const { probs, tokens } = await jev.noul(state, questions)
  const ids = specs
    .filter((s) => probs[s.id] >= threshold)
    .sort((a, b) => probs[b.id] - probs[a.id])
    .map((s) => s.id)
  return { ids, probs, tokens }
}
