import { expect, test } from 'claude-code/testing'
import { compact } from '../hooks/register'
import { parseLabels } from '../hooks/labels'

const HEADER = 'The following deferred tools are now available via ToolSearch. Use ToolSearch with query "select:<name>":'
const many = (server: string, n: number) => Array.from({ length: n }, (_, i) => `mcp__${server}__tool_${i}`)

test('un elenco lungo diventa una riga per server', async () => {
  const text = [HEADER, 'CronCreate', 'WebFetch', ...many('rea', 30), ...many('aaaa1111-2222-3333-4444-555566667777', 20)].join('\n')
  const out = compact(text, { 'aaaa1111-2222-3333-4444-555566667777': 'CRM Acme' })
  expect(out.includes(HEADER)).toBe(true)
  expect(out.includes('CronCreate')).toBe(true)
  expect(out.includes('- mcp__rea__* — rea: 30 tool')).toBe(true)
  expect(out.includes('CRM Acme: 20 tool')).toBe(true)
  expect(out.includes('mcp__rea__tool_29')).toBe(false)
  expect(out.length < text.length).toBe(true)
})

test('un elenco corto resta invariato', async () => {
  const text = [HEADER, ...many('rea', 5)].join('\n')
  expect(compact(text)).toBe(text)
})

import { shouldDefer } from '../hooks/register'

test('i tool MCP caricati per intero passano dietro ToolSearch, tranne ccd_turn e squadra', async () => {
  expect(shouldDefer('mcp__Claude_Browser__navigate', false)).toBe(true)
  expect(shouldDefer('mcp__visualize__show_widget', false)).toBe(true)
  expect(shouldDefer('mcp__ccd_turn__wrap_up', false)).toBe(false)
  expect(shouldDefer('mcp__squadra__prova', false)).toBe(false)
  expect(shouldDefer('Bash', false)).toBe(false)
  expect(shouldDefer('mcp__rea__rea', true)).toBe(false)
})

test('le etichette dei server si leggono da righe "<id>=<nome>"', async () => {
  expect(parseLabels(['abc=CRM Acme', 'senza uguale', ' def = Drive ', ''])).toEqual({ abc: 'CRM Acme', def: 'Drive' })
  expect(parseLabels('abc=Uno; def=Due')).toEqual({ abc: 'Uno', def: 'Due' })
  expect(parseLabels(undefined)).toEqual({})
})
