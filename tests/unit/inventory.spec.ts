import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTools, diffGroups, hash } from '../../hooks/routing/inventory.ts'
import type { ToolLike, ToolGroup, GroupSpec } from '../../hooks/routing/types.ts'

const tool = (name: string, description = `descrizione di ${name}`, mcp = true): ToolLike =>
  ({ name, description, mcp })

const spec = (id: string, specHash: string): GroupSpec =>
  ({ id, hash: specHash, catalogLine: '', definition: '', tests: [] })

test('hash è FNV-1a 32 bit in esadecimale', () => {
  assert.equal(hash(''), '811c9dc5')
  assert.equal(hash('a'), 'e40c292c')
  assert.equal(hash('a'), hash('a'))
  assert.notEqual(hash('a'), hash('b'))
})

test('groupTools tiene solo i tool MCP e raggruppa per server', () => {
  const groups = groupTools([
    tool('mcp__gmail__send'),
    tool('mcp__gmail__search'),
    tool('mcp__calendar__list'),
    tool('Bash', 'shell', false),
    tool('mcp__finto', 'nome senza tool', true),
    tool('mcp__ccd_turn__x'),
    tool('mcp__squadra__y'),
  ], { gmail: 'Posta' })

  assert.deepEqual(groups.map((g) => g.id), ['calendar', 'gmail'])
  assert.equal(groups[0].label, 'calendar')
  assert.equal(groups[1].label, 'Posta')
  assert.deepEqual(groups[1].tools.map((t) => t.name), ['mcp__gmail__search', 'mcp__gmail__send'])
})

test('group.hash non dipende dall ordine di input e cambia con le descrizioni', () => {
  const a = groupTools([tool('mcp__gmail__send', 'x'), tool('mcp__gmail__search', 'y')], {})
  const b = groupTools([tool('mcp__gmail__search', 'y'), tool('mcp__gmail__send', 'x')], {})
  const c = groupTools([tool('mcp__gmail__send', 'x2'), tool('mcp__gmail__search', 'y')], {})
  assert.equal(a[0].hash, b[0].hash)
  assert.notEqual(a[0].hash, c[0].hash)
})

test('diffGroups segnala gruppi nuovi o cambiati e spec senza gruppo', () => {
  const groups: ToolGroup[] = [
    { id: 'calendar', label: 'calendar', tools: [], hash: 'h1' },
    { id: 'gmail', label: 'gmail', tools: [], hash: 'h2' },
    { id: 'drive', label: 'drive', tools: [], hash: 'h3' },
  ]
  const specs = {
    gmail: spec('gmail', 'vecchio'),
    drive: spec('drive', 'h3'),
    notion: spec('notion', 'h4'),
  }
  const result = diffGroups(groups, specs)
  assert.deepEqual(result.changed.map((g) => g.id), ['calendar', 'gmail'])
  assert.deepEqual(result.removed, ['notion'])
})
