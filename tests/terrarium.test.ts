import { expect, mock, test } from 'claude-code/testing'

import { mirrorSvg, renderSvg } from '../hooks/render-svg'
import { chatItems, promptFromUpload } from '../hooks/chat'
import { frameData, photoScene } from '../hooks/viewer'
import { beastAt, beastShape, broodHue, familyOf, homeAt, modelName, onAgentDone, onAgentList, onSpawn, spawnShape, spawnText, bridgesOf, busyOf, kitsOf, walksOf, costText, crawlMs, districtsOf, subjectStem, testsOf, editSpots, emptyWorld, historyText, importsOf, measure, onEdited, onMeasure, weathering, routeOf, streetsOf, vernacular, onCompact, glowOf, isDirty, islandRadius, moonArc, onActivity, onCost, onGit, onPrompt, onReading, onSpinner, onStep, onSystem, onTests, onTool, onToolError, onTurnDone, onWaiting, parseGitStatus, parseTests, readMood, styleOf, sunHour, throughput, weatherOf, upgrade } from '../hooks/world'

const VIEW = { yaw: 35, isOrbiting: false, isLegendOpen: false, isWide: false, isLive: false }

const PANE_PROPS = {
  title: 'Terrarium',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

test('files become buildings shaped by their kind, tall as they are long', () => {
  let w = emptyWorld(7)
  w = onTool(w, 'Write', { file_path: 'C:/proj/docs/guide.md', content: 'line\n'.repeat(150) }, false)
  const library = w.features.find(f => f.key === 'file:C:/proj/docs/guide.md')
  expect(library?.kind).toBe('house')
  expect(library?.style).toBe('doc')
  expect(library?.arch).toBe('library')
  expect(library?.shape?.lines).toBe(150)
  expect(library?.label).toContain('guide.md · library · 150 lines')

  w = onTool(w, 'Edit', { file_path: 'C:/proj/docs/guide.md', old_string: 'a', new_string: 'b' }, false)
  const edited = w.features.find(f => f.key === 'file:C:/proj/docs/guide.md')
  expect(edited?.size).toBe(2)
  expect(edited?.shape?.lines).toBe(150)
  expect(w.chronicle.at(-1)).toContain('is reworked (2 changes)')

  expect(styleOf('src/app.test.ts')).toBe('test')
  expect(styleOf('package.json')).toBe('config')
  expect(styleOf('site/index.html')).toBe('web')
  expect(styleOf('src/main.rs')).toBe('code')
})

test('a file is measured, never kept: its lines, parts, types and exports shape its building', () => {
  const source = [
    "import { a } from './world.js'",
    "import type { T } from '../types'",
    "import fs from 'node:fs'",
    'export const one = (x: number) => x + 1',
    'export function two() {',
    '  return 2',
    '}',
    'export class Three {',
    '  four(y: string): string {',
    '    if (y) {',
    '      return y',
    '    }',
    '  }',
    '}',
    ...Array.from({ length: 200 }, (_, k) => `const v${k} = ${k} // a fairly ordinary line of code here`),
  ].join('\n')
  const s = measure('C:/p/hooks/register.ts', source)
  expect(s.lines).toBe(214)
  expect(s.parts).toBe(3)
  expect(s.blocks).toBe(1)
  expect(s.exports).toBe(3)
  expect(s.towers).toBe(1)
  expect(s.pennants).toBe(3)
  expect(s.floors).toBeGreaterThan(measure('C:/p/a.ts', 'const a = 1\n').floors)
  expect(measure('C:/p/a.ts', 'x'.repeat(200)).footprint).toBeGreaterThan(measure('C:/p/b.ts', 'x').footprint)
  expect(importsOf('C:/p/hooks/register.ts', source).sort()).toEqual(['c:/p/hooks/world', 'c:/p/types'])
  expect(importsOf('/srv/app/pkg/mod.py', 'from .util import x\nfrom . import helpers, other\nimport os')).toContain('/srv/app/pkg/util')
  expect(importsOf('/srv/app/pkg/mod.py', 'from . import helpers, other')).toEqual(['/srv/app/pkg/helpers', '/srv/app/pkg/other'])
  expect(importsOf('C:/docs/a.md', 'See [b](./b.md), [web](https://x.org) and [top](#top).')).toEqual(['c:/docs/b'])
  expect(vernacular('C:/p/src/lib.rs').arch).toBe('fort')
  expect(vernacular('C:/p/src/app.test.ts').arch).toBe('watchtower')
  expect(vernacular('C:/p/run.ps1')).toEqual({ lang: 'sh', arch: 'shed', accent: '#89e051' })
})

test('files that import each other are joined by streets; a file only read, by a footpath', () => {
  let w = emptyWorld(4)
  w = onTool(w, 'Write', { file_path: 'C:/p/hooks/register.ts', content: "import { a } from './world'\nimport { b } from '../types/index.js'\n" }, false)
  w = onTool(w, 'Write', { file_path: 'C:/p/hooks/world.ts', content: 'export const a = 1\n' }, false)
  w = onTool(w, 'Read', { file_path: 'C:/p/types/index.ts' }, false)
  const streets = streetsOf(w)
  const id = (key: string) => w.features.find(f => f.key === key)!.id
  expect(streets).toContainEqual({ from: id('file:C:/p/hooks/register.ts'), to: id('file:C:/p/hooks/world.ts'), isPath: false })
  expect(streets).toContainEqual({ from: id('file:C:/p/hooks/register.ts'), to: id('read:C:/p/types/index.ts'), isPath: true })
  // Measured from disk later, a file takes its new shape and imports.
  const measured = onMeasure(w, 'c:\\p\\hooks\\world.ts', measure('C:/p/hooks/world.ts', "import './register'\nexport const a = 1\n"), ['c:/p/hooks/register'])
  const house = measured.features.find(f => f.key === 'file:C:/p/hooks/world.ts')!
  expect(house.shape?.lines).toBe(2)
  expect(house.label).toContain('2 lines')
  expect(streetsOf(measured).length).toBe(2)
  const route = routeOf({ x: 0, y: 0 }, { x: 3, y: -2 })
  expect(route[0]).toEqual([0.5, 0.5])
  expect(route.at(-1)).toEqual([3.5, -1.5])
  expect(route.slice(1, -1).every(([x, y]) => Number.isInteger(x) && Number.isInteger(y))).toBe(true)
})

test('a town of importing files paints its streets, squares and architecture within the pane', () => {
  let w = emptyWorld(12)
  const langs = ['ts', 'py', 'js', 'rs', 'go', 'ts', 'c', 'css', 'tsx', 'html', 'md', 'mjs', 'json', 'sh', 'ts', 'sql', 'test.ts']
  for (let k = 0; k < 90; k++) {
    const ext = langs[k % langs.length]!
    // Script files import the two before them, and the hub, f1.
    const imports = [1, 2].filter(d => k - d >= 0).map(d => `import { x${d} } from './f${k - d}'`).concat(k > 3 ? ["import { hub } from './f1.js'"] : []).join('\n')
    const body = Array.from({ length: 20 + k * 4 }, (_, q) => `export function g${q}() { return ${q} }`).join('\n')
    w = onTool(w, 'Write', { file_path: `C:/town/src/f${k}.${ext}`, content: `${imports}\n${body}\nexport class K${k} {}\n` }, false, 1_000 + k)
  }
  w = onTool(w, 'Read', { file_path: 'C:/town/src/f0.ts' }, false, 2_000)
  expect(streetsOf(w).length).toBeGreaterThan(20)
  for (const yaw of [0, 35, 200]) {
    const svg = renderSvg(w, { ...VIEW, yaw }, { hour: 12, now: 3_000 })
    expect(svg.length).toBeLessThan(131072)
    expect(svg).toContain('a square, imported by')
    expect(svg).toMatch(/stroke="#[0-9a-f]{3,6}" stroke-width="[\d.]+" stroke-linecap="round" fill="none"/)
  }
  expect(w.features.filter(f => f.kind === 'house').map(f => f.arch)).toEqual(expect.arrayContaining(['townhouse', 'fort', 'workshop', 'keep', 'painted', 'library', 'vault', 'shed', 'silo', 'watchtower']))
})

test('notes and comments are counted from the comments alone', () => {
  const ts = [
    '// Draws the town. TODO: districts',
    'const re = /TODO|FIXME/ // FIXME: too loose',
    '/*',
    ' * HACK: the second pass',
    ' */',
    "const label = 'TODO later'",
    'export const f = () => 1',
    'export const g = () => 2',
    'export const h = () => 3',
    'export const k = () => 4',
  ].join('\n')
  const s = measure('C:/p/town.ts', ts)
  expect(s.todos).toBe(1)
  expect(s.fixmes).toBe(2)
  expect(s.comments).toBe(4)
  expect(s.flowers).toBe(1)
  const py = measure('C:/p/a.py', '#!/usr/bin/env python\n"""A module."""\n# TODO: more\ndef f():\n    return 1\n')
  expect([py.comments, py.todos]).toEqual([2, 1])
  expect(measure('C:/p/plan.md', '# Plan\n- [ ] walls\n- [x] streets\n- [ ] weather\n').todos).toBe(2)
  expect(measure('C:/p/q.ts', 'export const a = 1\n'.repeat(20)).flowers).toBe(0)
})

test('each edit bands its building where it fell, in its prompt’s color, and a rewrite starts afresh', () => {
  const text = Array.from({ length: 100 }, (_, k) => `line ${k}`).join('\n')
  expect(editSpots(text, [{ old: 'line 50\nline 51', new: 'a\nb\nc\nd' }])).toEqual([{ pos: 0.5, span: 0.04 }])
  expect(editSpots(text, [{ old: 'nowhere', new: 'x' }])).toEqual([])
  expect(editSpots('ab ab ab', [{ old: 'ab', new: 'c', isAll: true }]).length).toBe(3)
  let w = onPrompt(emptyWorld(4), 'shape the walls', 1, false)
  w = onTool(w, 'Write', { file_path: 'C:/p/walls.ts', content: text }, false, 10)
  w = onEdited(w, 'C:/p/walls.ts', [], 10)
  w = onTool(w, 'Edit', { file_path: 'C:/p/walls.ts', old_string: 'line 50', new_string: 'x' }, false, 20)
  w = onEdited(w, 'C:/p/walls.ts', [{ pos: 0.5, span: 0.01 }], 20)
  w = onPrompt(w, 'and the top', 30, false)
  w = onEdited(w, 'C:/p/walls.ts', [{ pos: 0, span: 0.1 }, { pos: 0.9, span: 0.1 }], 40)
  const house = () => w.features.find(f => f.key === 'file:C:/p/walls.ts')!
  expect(house().edits?.map(e => [e.pos, e.turn])).toEqual([[0.5, 1], [0, 2], [0.9, 2]])
  expect(historyText(house(), 50)).toContain('3 edits banded on its walls (2 prompts)')
  for (let k = 0; k < 20; k++) w = onEdited(w, 'C:/p/walls.ts', [{ pos: k / 20, span: 0.05 }], 60 + k)
  expect(house().edits?.length).toBe(12)
  w = onEdited(w, 'C:/p/walls.ts', [], 100, true)
  expect(house().edits).toBeUndefined()
})

test('a failed edit wounds its building; the next good one patches it', () => {
  let w = onTool(emptyWorld(5), 'Write', { file_path: 'C:/p/a.rs', content: 'fn main() {}\n' }, false, 1)
  w = onTool(w, 'Edit', { file_path: 'C:/p/a.rs', old_string: 'nope', new_string: 'x' }, false, 2)
  w = onToolError(w, 'Edit', 3)
  const fort = () => w.features.find(f => f.key === 'file:C:/p/a.rs')!
  expect(fort().isWounded).toBe(true)
  expect(fort().isScorched).toBe(true)
  expect(historyText(fort(), 4)).toContain('an edit failed here')
  w = onTool(w, 'Edit', { file_path: 'C:/p/a.rs', old_string: 'main', new_string: 'start' }, false, 5)
  w = onEdited(w, 'C:/p/a.rs', [{ pos: 0, span: 1 }], 6)
  expect(fort().isWounded).toBeUndefined()
  expect(fort().isScorched).toBeUndefined()
  expect(fort().scars).toBe(1)
  expect(w.chronicle.at(-1)).toContain('patched up')
  expect(historyText(fort(), 7)).toContain('patched after 1 failed edit')
  // A failed command scorches its forge, and wounds nothing.
  w = onToolError(onTool(w, 'Bash', { command: 'cargo build' }, false, 8), 'Bash', 9)
  expect(w.features.find(f => f.kind === 'forge')?.isWounded).toBeUndefined()
})

test('a building left alone weathers, and work makes it new', () => {
  const MIN = 60_000
  let w = onTool(emptyWorld(6), 'Write', { file_path: 'C:/p/old.py', content: 'x = 1\n' }, false, 1)
  const house = () => w.features.find(f => f.key === 'file:C:/p/old.py')!
  expect([10, 30, 60, 120, 200].map(m => weathering(house(), 1 + m * MIN))).toEqual([0, 1, 2, 3, 4])
  expect(historyText(house(), 1 + 200 * MIN)).toContain('overgrown: untouched 3.3 h')
  w = onTool(w, 'Edit', { file_path: 'C:/p/old.py', old_string: 'x', new_string: 'y' }, false, 200 * MIN)
  expect(weathering(house(), 201 * MIN)).toBe(0)
})

test('a town with a long history still fits the pane', () => {
  const langs = ['ts', 'py', 'rs', 'go', 'c', 'css', 'html', 'md', 'json', 'sh', 'sql', 'test.ts']
  const notes = '// TODO: a\n// TODO: b\n// FIXME: c\n// HACK: d\n// why this is so\n'.repeat(3)
  const town = (count: number) => {
    let w = emptyWorld(13)
    for (let k = 0; k < count; k++) {
      if (k % 9 === 0) w = onPrompt(w, `turn ${k}`, k * 1_000, false)
      const path = `C:/old/src/f${k}.${langs[k % langs.length]}`
      w = onTool(w, 'Write', { file_path: path, content: `${notes}${'export function g() { return 1 }\n'.repeat(40 + k * 3)}` }, false, 1_000 + k)
      w = onEdited(w, path, Array.from({ length: 12 }, (_, q) => ({ pos: q / 12, span: 0.05 + (q % 3) * 0.1 })), 1_000 + k)
      if (k % 3 === 0) w = onEdited(onToolError(onTool(w, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }, false, 1_000 + k), 'Edit', 1_001 + k), path, [], 1_002 + k)
    }
    return w
  }
  const later = 4 * 3_600_000
  const dense = town(90)
  expect(dense.features.filter(f => (f.scars ?? 0) > 0).length).toBe(30)
  const mid = town(24)
  for (const yaw of [0, 35, 200]) {
    expect(renderSvg(dense, { ...VIEW, yaw }, { hour: 12, now: later }).length).toBeLessThan(131072)
    const svg = renderSvg(mid, { ...VIEW, yaw }, { hour: 12, now: later })
    expect(svg.length).toBeLessThan(131072)
    expect(svg).toContain('patched after 1 failed edit')
    expect(svg).toContain('12+ edits banded on its walls')
    expect(svg).toContain('overgrown: untouched')
  }
  // In a smaller town every detail shows: cranes, boarded windows, flower boxes, ivy.
  let small = emptyWorld(14)
  for (let k = 0; k < 6; k++) {
    const path = `C:/old/f${k}.ts`
    small = onTool(small, 'Write', { file_path: path, content: notes + 'export const a = 1\n'.repeat(30) }, false, 1)
    small = onEdited(small, path, [{ pos: 0.2, span: 0.2 }], 1)
  }
  const svg = renderSvg(small, VIEW, { hour: 12, now: later })
  expect(svg).toMatch(/V[\d.-]+" fill="none"/)
  expect(svg).toMatch(/fill="#[0-9a-f]{3,6}" stroke="#[0-9a-f]{3,6}" stroke-width=".7"/)
  expect(svg).toContain('stroke-dasharray')
})

test('a test settles beside the file it tests, joined by a rope bridge', () => {
  expect(['world.test.ts', 'test_world.py', 'world_test.go', 'WorldTests.cs', 'world.spec.js'].map(subjectStem)).toEqual(['world', 'world', 'world', 'world', 'world'])
  let w = emptyWorld(8)
  for (let k = 0; k < 12; k++) w = onTool(w, 'Write', { file_path: `C:/p/src/m${k}.ts`, content: 'export const a = 1\n' }, false, k + 1)
  w = onTool(w, 'Write', { file_path: 'C:/p/other/far.ts', content: 'x\n' }, false, 20)
  w = onTool(w, 'Write', { file_path: 'C:/p/src/m3.test.ts', content: "import { a } from './m3'\n" }, false, 30)
  const subject = w.features.find(f => f.key === 'file:C:/p/src/m3.ts')!
  const test = w.features.find(f => f.key === 'file:C:/p/src/m3.test.ts')!
  expect(Math.max(Math.abs(test.x - subject.x), Math.abs(test.y - subject.y))).toBeLessThanOrEqual(2)
  expect(w.chronicle.at(-1)).toContain('beside the m3.ts it tests')
  expect(bridgesOf(w)).toEqual([{ test: test.id, subject: subject.id }])
  expect(testsOf(w).get(test.id)).toBe('tests m3.ts')
  expect(renderSvg(w, VIEW, { hour: 12, now: 100 })).toContain('A rope bridge: m3.test.ts tests m3.ts')
  // A test named for nothing on the island is tied to what it imports.
  w = onTool(w, 'Write', { file_path: 'C:/p/tests/suite.test.ts', content: "import { a } from '../src/m1'\nimport { b } from '../src/m2'\n" }, false, 40)
  const suite = w.features.find(f => f.key === 'file:C:/p/tests/suite.test.ts')!
  expect(bridgesOf(w).filter(b => b.test === suite.id).length).toBe(2)
})

test('folders become districts: paved, walled, open where streets run, a gate nearest the heart', () => {
  let w = emptyWorld(9)
  for (let k = 0; k < 5; k++) w = onTool(w, 'Write', { file_path: `C:/p/src/a${k}.ts`, content: k > 0 ? `import { x } from './a${k - 1}'\n` : 'x\n' }, false, k + 1)
  for (let k = 0; k < 4; k++) w = onTool(w, 'Write', { file_path: `C:/p/src/ui/b${k}.css`, content: 'a{}\n' }, false, 10 + k)
  w = onTool(w, 'Write', { file_path: 'C:/p/docs/one.md', content: '# one\n' }, false, 20)
  const districts = districtsOf(w)
  expect(districts.map(d => d.name).sort()).toEqual(['src', 'ui'])
  const src = districts.find(d => d.name === 'src')!
  const ui = districts.find(d => d.name === 'ui')!
  expect(src.parent).toBeUndefined()
  expect(ui.parent).toBe('src')
  expect(src.cells.length).toBe(5)
  expect(src.walls.length).toBeGreaterThan(0)
  expect(src.gate).toBeDefined()
  // A quarter settles beside its parent.
  const near = (a: number[], b: number[]) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!))
  expect(Math.min(...ui.cells.flatMap(c => src.cells.map(s => near(c, s))))).toBeLessThanOrEqual(2)
  // No line is walled twice, and no wall stands where a street runs or in the gate.
  const key = (e: number[]) => [[e[0], e[1]], [e[2], e[3]]].map(p => p.join(',')).sort().join('|')
  const all = districts.flatMap(d => d.walls.map(key))
  expect(new Set(all).size).toBe(all.length)
  expect(all).not.toContain(key(src.gate!))
  const routes = streetsOf(w).map(s => routeOf(w.features.find(f => f.id === s.from)!, w.features.find(f => f.id === s.to)!))
  for (const r of routes) {
    for (const [p, q] of [[r[1], r[2]], [r[2], r[3]]] as const) {
      if (Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) === 1) expect(all).not.toContain(key([...p, ...q]))
    }
  }
  for (const yaw of [0, 35, 200]) {
    const svg = renderSvg(w, { ...VIEW, yaw }, { hour: 12, now: 100 })
    expect(svg).toContain('class="dn"')
    expect(svg).toContain('ui/ · a quarter of src/ · 4 files')
  }
})

test('a town of districts and bridges fits the pane', () => {
  let w = emptyWorld(10)
  for (let k = 0; k < 80; k++) {
    const dir = ['src', 'src/ui', 'src/core', 'lib', 'docs', 'tests', 'scripts', 'src/core/deep'][k % 8]
    const path = dir === 'tests' ? `C:/p/tests/m${k - 6}.test.ts` : `C:/p/${dir}/m${k}.ts`
    w = onTool(w, 'Write', { file_path: path, content: k > 2 ? `import { x } from './m${k - 8}'\n` : 'x\n' }, false, k + 1)
  }
  expect(districtsOf(w).length).toBeGreaterThan(5)
  expect(bridgesOf(w).length).toBeGreaterThan(3)
  for (const yaw of [0, 35, 200]) {
    const svg = renderSvg(w, { ...VIEW, yaw }, { hour: 12, now: 100 })
    expect(svg.length).toBeLessThan(131072)
  }
  const frame = frameData(w, 1, '', 1, null, 100)
  expect(frame.districts.length).toBe(districtsOf(w).length)
  expect(frame.bridges.length).toBe(bridgesOf(w).length)
})

test('each building’s kit of parts is chosen by what is true of its file', () => {
  const at = new Date(2026, 9, 10, 15, 42).getTime()
  let w = emptyWorld(11)
  w = onTool(w, 'Write', { file_path: 'C:/k/src/world.ts', content: 'export const a = 1\n' }, false, at)
  w = onTool(w, 'Write', { file_path: 'C:/k/src/main.ts', content: "import { a } from './world'\nimport { b } from './wide'\n" }, false, at + 1)
  w = onTool(w, 'Write', { file_path: 'C:/k/src/view.ts', content: "import { a } from './world'\n" }, false, at + 2)
  w = onTool(w, 'Write', { file_path: 'C:/k/src/wide.ts', content: `export const s = '${'x'.repeat(120)}'\n` }, false, at + 3)
  for (let k = 0; k < 4; k++) w = onTool(w, 'Read', { file_path: 'C:/k/src/view.ts' }, false, at + 10 + k)
  for (let k = 0; k < 3; k++) w = onTool(w, 'Edit', { file_path: 'C:/k/src/wide.ts', old_string: 'x', new_string: 'y' }, false, at + 20 + k)
  const id = (name: string) => w.features.find(f => f.key === `file:C:/k/src/${name}`)!.id
  const kits = kitsOf(w)
  expect(kits[id('main.ts')]).toEqual({ spire: true, dormers: 2 })
  expect(kits[id('world.ts')]).toEqual({ clock: [3, 42] })
  expect(kits[id('view.ts')]).toEqual({ dormers: 1, balconies: 2 })
  expect(kits[id('wide.ts')]).toEqual({ bay: true, flag: true })
})

test('townsfolk carry work between files worked one after the other; doors open at work', () => {
  const T = 1_760_000_000_000
  let w = emptyWorld(12)
  for (const [k, name] of ['a', 'b', 'a', 'c', 'c'].entries()) w = onTool(w, 'Edit', { file_path: `C:/f/${name}.ts`, old_string: 'x', new_string: 'y' }, false, T + k * 60_000)
  const id = (name: string) => w.features.find(f => f.key === `file:C:/f/${name}.ts`)!.id
  const walks = walksOf(w, T + 5 * 60_000)
  expect(walks.map(x => [x.from, x.to])).toEqual([[id('a'), id('c')], [id('b'), id('a')]])
  expect(walksOf(w, T + 40 * 60_000)).toEqual([])
  expect(busyOf(w, T + 4 * 60_000 + 10_000)).toEqual([id('c')])
  expect(busyOf(w, T + 6 * 60_000)).toEqual([])
  const svg = renderSvg(w, VIEW, { hour: 12, now: T + 4 * 60_000 + 10_000 })
  expect(svg).toContain('<animateMotion')
  expect(svg).toContain('fill="#ffcf73" class="pl"')
  const frame = frameData(w, 1, '', 1, null, T + 4 * 60_000 + 10_000)
  expect(frame.walks.length).toBe(2)
  expect(frame.busy).toEqual([id('c')])
})

test('files of one folder settle into a district', () => {
  let w = emptyWorld(3)
  for (let k = 0; k < 6; k++) w = onTool(w, 'Read', { file_path: `C:/elsewhere/n${k}.txt` }, false)
  w = onTool(w, 'Write', { file_path: 'C:/proj/src/a.ts', content: 'x' }, false)
  w = onTool(w, 'Write', { file_path: 'C:/proj/src/b.ts', content: 'y' }, false)
  const a = w.features.find(f => f.key === 'file:C:/proj/src/a.ts')
  const b = w.features.find(f => f.key === 'file:C:/proj/src/b.ts')
  expect(a).toBeDefined()
  expect(b).toBeDefined()
  expect(Math.max(Math.abs(a!.x - b!.x), Math.abs(a!.y - b!.y))).toBeLessThanOrEqual(2)
})

test('the weather follows the words and the errors', () => {
  expect(weatherOf(readMood('thanks, this is awesome and beautiful!'))).toBe('sunny')
  expect(weatherOf(readMood('ugh, it is still broken and the build failed again'))).toBe('stormy')
  expect(weatherOf(readMood('what if the island had caves? I wonder how deep?'))).toBe('dreamy')
  let w = onPrompt(emptyWorld(1), 'What if the islands had windmills? Maybe lighthouses too.')
  expect(w.lanterns.length).toBe(2)
  expect(w.turn).toBe(1)
  for (let k = 0; k < 8; k++) w = onToolError(onTool(w, 'Bash', { command: 'npm test' }, false), 'Bash')
  expect(w.mood.storm).toBeGreaterThan(0.45)
})

test('a crowded island still fits in one drawing', () => {
  let w = emptyWorld(42)
  const tools = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'WebFetch', 'Agent', 'Skill', 'mcp__docs__search', 'TodoWrite']
  for (let k = 0; k < 400; k++) {
    if (k % 12 === 0) w = onPrompt(w, `Turn ${k}: could we try something new? thanks!`)
    const tool = tools[k % tools.length]!
    w = onTool(w, tool, {
      file_path: `C:/proj/dir${k % 9}/file${k}.${['ts', 'md', 'json', 'css', 'test.ts'][k % 5]}`,
      content: 'x\n'.repeat(k % 300),
      command: `${['git', 'npm', 'ls', 'node'][k % 4]} run ${k}`,
      pattern: `p${k}`,
      url: `https://site${k % 5}.example/page`,
      subagent_type: k % 2 === 0 ? 'Explore' : 'Plan',
      skill: `skill${k % 3}`,
    }, false)
  }
  // A creature in full cry: grown fat, eyes for everything said, tentacles out.
  const T = 5_000_000
  w = onPrompt(w, 'and now, everything at once?', T, false)
  for (let k = 0; k < 12; k++) w = onTool(w, tools[k % tools.length]!, { file_path: `C:/proj/dir${k % 9}/file${k}.ts`, content: 'x', command: 'npm test' }, false, T + 1_000 * k)
  for (let k = 0; k < 8; k++) w = onPrompt(w, `oh and ${k}`, T + 500 * k, true)
  w = onSpinner(onStep(w, 4_000_000), 'Editing file11.ts', 'tool-use', T + 12_000)
  w = { ...w, tide: 90 }
  for (const hour of [3, 7, 12, 19]) {
    for (const yaw of [0, 35, 90, 200]) {
      const svg = renderSvg(w, { ...VIEW, yaw }, { hour, now: T + 14_000 })
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.length).toBeLessThan(131072)
    }
  }
})

test('the pane draws the island on every surface and turns it', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))

  await $.turn.start({ text: 'Build me a lighthouse? thanks!', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/README.md', content: 'hello\n'.repeat(90) })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  const desktop = await $.ui.mount({
    plugin: 'terrarium', surface: 'desktop', component: 'Pane', requestId: 'terrarium', props: PANE_PROPS,
  })
  const picture = await desktop.find({ type: 'Svg' })
  expect(picture).toBeDefined()
  expect(String(picture?.props.source)).toContain('<svg')
  expect((await desktop.find({ text: /Turn 1/ }))?.text).toContain('2 landmarks')
  await desktop.press({ key: 'cw' })
  await desktop.press({ key: 'legend' })
  expect(await desktop.find({ text: /Forges: shell commands/ })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({
    plugin: 'terrarium', surface: 'terminal', component: 'Pane', requestId: 'terrarium', props: PANE_PROPS,
  })
  expect(await terminal.find({ type: 'Raster' })).toBeDefined()
  await terminal.unmount()
})

test('the creature wakes small each turn, grows with time and tokens, and sleeps when the turn ends', () => {
  let w = onPrompt(emptyWorld(5), 'first, a quick one', 1_000, false)
  expect(w.beast?.turn).toBe(1)
  expect(w.features.length).toBe(0)
  const newborn = beastShape(w.beast!, 1_000)
  w = onStep(onStep(w, 400_000), 600_000)
  expect(w.beast?.tokens).toBe(1_000_000)
  const grown = beastShape(w.beast!, 601_000)
  expect(grown.reach).toBeGreaterThan(newborn.reach)
  expect(grown.body).toBeGreaterThan(newborn.body)
  expect(grown.eyes).toBeGreaterThan(newborn.eyes)
  w = onTurnDone(w, 20, true, 30_000, false, 31_000)
  expect(w.beast?.doneAt).toBe(31_000)
  expect(beastShape(w.beast!, 900_000).isAwake).toBe(false)
  expect(beastShape(w.beast!, 900_000).seconds).toBe(30)
  expect(w.chronicle.some(line => line.includes('curls up to sleep after 30s'))).toBe(true)
  const slept = renderSvg(w, VIEW, { hour: 12, now: 40_000 })
  expect(slept).toContain('Asleep: the turn is done')
  expect(slept).toContain('href="#ez"')
  const where = { x: w.beast!.x, y: w.beast!.y }
  w = onPrompt(w, 'second', 100_000, false)
  expect(w.beast?.turn).toBe(2)
  expect(w.beast?.doneAt).toBeUndefined()
  expect(w.beast?.tokens).toBe(0)
  expect({ x: w.beast!.x, y: w.beast!.y }).toEqual(where)
  expect(w.chronicle.some(line => line.includes('the creature wakes'))).toBe(true)
})

test('the creature crawls to the middle of the files it is working on', () => {
  let w = onPrompt(emptyWorld(9), 'build the thing', 1_000, false)
  for (let k = 0; k < 8; k++) w = onTool(w, 'Read', { file_path: `C:/q/n${k}.md` }, false, 1_500 + k)
  w = onTool(w, 'Write', { file_path: 'C:/p/a/one.ts', content: 'x' }, false, 2_000)
  w = onTool(w, 'Edit', { file_path: 'C:/p/a/one.ts' }, false, 3_000)
  const xs = w.features.map(f => f.x + 0.5)
  const ys = w.features.map(f => f.y + 0.5)
  const b = w.beast!
  expect(b.movedAt).toBeGreaterThan(1_000)
  expect(b.x).toBeGreaterThanOrEqual(Math.min(...xs))
  expect(b.x).toBeLessThanOrEqual(Math.max(...xs))
  expect(b.y).toBeGreaterThanOrEqual(Math.min(...ys))
  expect(b.y).toBeLessThanOrEqual(Math.max(...ys))
  expect(beastAt(b, b.movedAt + crawlMs(b) / 2).isCrawling).toBe(true)
  const there = beastAt(b, b.movedAt + crawlMs(b) + 1)
  expect(Math.abs(there.x - b.x) + Math.abs(there.y - b.y)).toBeLessThan(0.001)
  // Its eyes turn toward what its newest tentacle holds; with nothing held, they look out.
  expect(renderSvg(w, VIEW, { hour: 12, now: 4_000 })).toMatch(/href="#ei" x="/)
  expect(renderSvg(w, VIEW, { hour: 12, now: 60_000 })).not.toMatch(/href="#ei" x="/)
})

test('words sent mid-turn join the turn under way, and open no eyes', () => {
  let w = onPrompt(emptyWorld(9), 'build the thing', 1_000, false)
  const before = w.beast
  w = onPrompt(w, 'oh and make it blue', 2_000, true)
  expect(w.turn).toBe(1)
  expect(w.beast).toEqual(before)
  expect(w.features.length).toBe(0)
  expect(w.chronicle.at(-1)).toContain('You speak while it works')
  expect(renderSvg(w, VIEW, { hour: 12, now: 2_500 })).not.toContain('You said, while it worked')
  // It heard you: the 3D creature shivers once, from this moment.
  expect(w.heardAt).toBe(2_000)
  expect(onPrompt(w, 'a new turn', 9_000, false).heardAt).toBe(2_000)
})

test('each tentacle works in the way of its call, and a failed one snatches back', () => {
  let w = onPrompt(emptyWorld(6), 'go', 1_000, false)
  w = onTool(w, 'Read', { file_path: 'C:/p/notes.md' }, false, 2_000)
  w = onTool(w, 'Write', { file_path: 'C:/p/new.ts', content: 'x' }, false, 2_100)
  w = onTool(w, 'Bash', { command: 'npm run build' }, false, 2_200)
  w = onTool(w, 'Grep', { pattern: 'todo' }, false, 2_300)
  w = onTool(w, 'Edit', { file_path: 'C:/p/old.ts' }, false, 2_400)
  const svg = renderSvg(w, VIEW, { hour: 12, now: 5_000 })
  for (const said of ['drinks in notes.md', 'pours itself into new.ts', 'coils round the forge · npm', 'sweeps an eye over the land · Searched for todo', 'picks at old.ts']) expect(svg).toContain(`A tentacle ${said}`)
  w = onToolError(w, 'Edit', 5_200)
  expect(w.events?.at(-1)?.failedAt).toBe(5_200)
  expect(renderSvg(w, VIEW, { hour: 12, now: 5_600 })).toContain('picks at old.ts · the call failed')
  expect(renderSvg(w, VIEW, { hour: 12, now: 7_000 })).not.toContain('picks at old.ts')
  expect(renderSvg(w, VIEW, { hour: 12, now: 7_000 })).toContain('drinks in notes.md')
})

test('islands from earlier versions lose their towers, and a burst creature sleeps', () => {
  const house = { id: 3, kind: 'house', x: 1, y: 1, size: 1, key: 'file:a.ts', label: 'a', turn: 1, hue: 0 }
  const old = { ...emptyWorld(1), towerId: 1, features: [{ ...house, id: 1, kind: 'waystone', key: 'turn-1' }, { ...house, id: 2, kind: 'annex', key: 'annex-2' }, { ...house, isFaded: true }] }
  const w = upgrade(old as never)
  expect(w.features.map(f => f.kind)).toEqual(['house'])
  expect('isFaded' in w.features[0]!).toBe(false)
  // A compaction shrinks the context, not the files: nothing fades.
  const compacted = onCompact(w, 10)
  expect(compacted.features.find(f => f.kind === 'house')).toEqual(w.features[0])
  expect(compacted.features.some(f => f.kind === 'monolith')).toBe(true)
  expect('towerId' in w).toBe(false)
  const fresh = emptyWorld(2)
  expect(upgrade(fresh)).toBe(fresh)
  // The turtle's wake was taken away again: a world that kept one lets it go.
  expect('wake' in upgrade({ ...fresh, wake: [{ turn: 1 }] } as never)).toBe(false)
  const burst = { ...fresh, beast: { turn: 1, prompt: 'go', bornAt: 1, x: 0, y: 0, fromX: 0, fromY: 0, movedAt: 1, tokens: 5, diedAt: 9 } }
  const woke = upgrade(burst as never)
  expect(woke.beast?.doneAt).toBe(9)
  expect('diedAt' in woke.beast!).toBe(false)
  // The eyes your mid-turn words once opened are gone.
  const heard = upgrade({ ...fresh, beast: { ...burst.beast, diedAt: undefined, doneAt: 9, heard: [{ text: 'hi', at: 2 }] } } as never)
  expect('heard' in heard.beast!).toBe(false)
  expect(heard.beast?.doneAt).toBe(9)
})

test('the creature wears the spinner’s words, and sleeps while it waits on you', () => {
  let w = onPrompt(emptyWorld(4), 'go', 1_000, false)
  w = onSpinner(w, 'Creating notes.md…', 'tool-use', 1_100)
  expect(w.activity).toEqual({ kind: 'tool', at: 1_100, verb: 'Creating notes.md' })
  expect(onSpinner(w, 'Creating notes.md', 'tool-use', 1_200)).toBe(w)
  expect(renderSvg(w, VIEW, { hour: 12, now: 1_500 })).toContain('Creating notes.md…')
  const sleepy = renderSvg(onWaiting(w, 'Claude needs your permission to use Bash', 1_600), VIEW, { hour: 12, now: 1_700 })
  expect(sleepy).toContain('Asleep: waiting on you')
  expect(sleepy).toContain('href="#ez"')
  const done = onTurnDone(w, 10, true, 1_000, false, 2_000)
  expect(onSpinner(done, 'Baking', 'thinking', 2_100)).toBe(done)
})

test('tool calls leave events the creature answers, and failures mark theirs', () => {
  let w = onPrompt(emptyWorld(2), 'go', 1_000, false)
  w = onTool(w, 'Edit', { file_path: 'C:/p/a.ts' }, false, 5_000)
  w = onTool(w, 'WebFetch', { url: 'https://example.com/x' }, false, 6_000)
  w = onToolError(w, 'WebFetch')
  const events = w.events ?? []
  expect(events.length).toBe(2)
  expect(events[0]?.target).toBe(w.features.find(f => f.kind === 'house')?.id)
  expect(events[1]?.isError).toBe(true)
  expect(w.features.find(f => f.kind === 'house')?.touchedAt).toBe(5_000)
  expect(glowOf(5_000, 5_000 + 60_000)).toBeGreaterThan(0.7)
  expect(glowOf(5_000, 5_000 + 11 * 60_000)).toBe(0)
})

test('the sky keeps the limits and the land keeps the disk', () => {
  const base = emptyWorld(1)
  expect(sunHour(base, 14.5)).toBe(14.5)
  const morning = onSystem(base, { at: 1, limit: 0, weekLimit: 100 })
  expect(sunHour(morning, 14.5)).toBe(6)
  expect(moonArc(morning)).toBe(1)
  expect(sunHour(onSystem(base, { at: 1, limit: 100 }), 3)).toBe(19)
  const roomy = islandRadius(onSystem(base, { at: 1, diskFree: 0.9 }))
  const cramped = islandRadius(onSystem(base, { at: 1, diskFree: 0.05 }))
  expect(roomy).toBeGreaterThan(cramped + 5)
})

test('test runs are read from the commands that ran them', () => {
  expect(parseTests('npx jest', 'Tests:       2 failed, 40 passed, 42 total')).toEqual({ passed: 40, failed: 2 })
  expect(parseTests('pytest -q', '===== 3 failed, 10 passed in 1.2s =====')).toEqual({ passed: 10, failed: 3 })
  expect(parseTests('cargo test', 'test result: ok. 12 passed; 0 failed; 0 ignored\ntest result: ok. 3 passed; 1 failed;')).toEqual({ passed: 15, failed: 1 })
  expect(parseTests('claude plugin test .', ' 9 pass\n 0 fail\nRan 9 tests')).toEqual({ passed: 9, failed: 0 })
  expect(parseTests('ls -la', '3 passed')).toBeUndefined()
  let w = onTests(emptyWorld(1), { passed: 9, failed: 2 }, 'npm test', 1_000)
  expect(w.tests?.greenAt).toBeUndefined()
  w = onTests(w, { passed: 11, failed: 0 }, 'npm test', 2_000)
  expect(w.tests?.greenAt).toBe(2_000)
  expect(w.chronicle.at(-1)).toContain('rainbow')
})

test('git is read for a repository with a remote, and a new HEAD is a commit', () => {
  const porcelain = [
    '# branch.oid abc',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 docs/new name.md\tdocs/old.md',
    '? notes/todo.txt',
  ].join('\n')
  const parsed = parseGitStatus(porcelain, 'C:\\Proj')
  expect(parsed.branch).toBe('main')
  expect(parsed.ahead).toBe(2)
  expect(parsed.behind).toBe(1)
  expect(parsed.dirty).toEqual(['c:/proj/src/app.ts', 'c:/proj/docs/new name.md', 'c:/proj/notes/todo.txt'])
  let w = onTool(emptyWorld(3), 'Edit', { file_path: 'C:\\Proj\\src\\app.ts' }, false, 1)
  w = onGit(w, { hasRemote: true, host: 'github.com', ...parsed, head: 'h1', commits: 0, at: 1 }, 1)
  expect(isDirty(w, w.features[0]!)).toBe(true)
  w = onGit(w, { hasRemote: true, ...parsed, dirty: [], head: 'h2', commits: 0, at: 2 }, 2, 'ship it')
  expect(w.git?.commits).toBe(1)
  expect(w.events?.at(-1)?.tool).toBe('git-commit')
  expect(isDirty(w, w.features[0]!)).toBe(false)
  const local = onGit(emptyWorld(3), { hasRemote: false, ahead: 0, behind: 0, dirty: ['c:/proj/src/app.ts'], commits: 0, at: 1 }, 1)
  expect(isDirty(onTool(local, 'Edit', { file_path: 'C:/Proj/src/app.ts' }, false, 1), local.features[0] ?? { kind: 'house', key: 'file:C:/Proj/src/app.ts' } as never)).toBe(false)
})

test('the machine is read without redrawing for every wobble, and away is noticed', () => {
  const at = 1_000_000
  let w = onReading(emptyWorld(1), { cpu: 0.31, ram: 0.455, diskRead: 3e6, netDown: 5e5, procs: [{ name: 'msedge', cpu: 0.12 }, { name: 'tiny', cpu: 0.005 }] }, at)
  expect(Math.abs((w.system?.cpu ?? 0) - 0.3)).toBeLessThan(0.001)
  expect(w.system?.procs?.map(p => p.name)).toEqual(['msedge'])
  expect(onReading(w, { cpu: 0.305, ram: 0.462 }, at + 4000)).toBe(w)
  expect(throughput(w).disk).toBeGreaterThan(0.3)
  expect(throughput(w).down).toBeGreaterThan(0.2)
  w = onReading(w, { idle: 400 }, at + 8000)
  expect(w.awaySince).toBe(at + 8000 - 400_000)
  w = onReading(w, { idle: 2 }, at + 60_000)
  expect(w.awaySince).toBeUndefined()
  expect(w.events?.at(-1)?.tool).toBe('presence-return')
})

test('each giant carries its program: memory, how many, since when, and which way its load goes', () => {
  const at = 2_000_000
  let w = onReading(emptyWorld(1), { procs: [{ name: 'chrome', cpu: 0.14, mem: 1234.4, count: 30, since: 1_700_000_000_000 }, { name: 'System', cpu: 0.03, mem: 5, count: 1 }] }, at)
  expect(w.system?.procs).toEqual([
    { name: 'chrome', cpu: 0.14, mem: 1230, count: 30, since: 1_700_000_000_000, trend: 0 },
    { name: 'System', cpu: 0.03, mem: 10, count: 1, trend: 0 },
  ])
  // Busier now; an older reader that sends only names and shares keeps what it leaves out.
  w = onReading(w, { procs: [{ name: 'chrome', cpu: 0.2 }] }, at + 8000)
  expect(w.system?.procs).toEqual([{ name: 'chrome', cpu: 0.2, mem: 1230, count: 30, since: 1_700_000_000_000, trend: 0.06 }])
  w = onReading(w, { procs: [{ name: 'chrome', cpu: 0.15, mem: -4, count: Number.NaN }] }, at + 16_000)
  expect(w.system?.procs?.[0]).toMatchObject({ mem: 1230, count: 30, trend: -0.05 })
})

test('waiting, thinking, cost, cache and interruption all leave their mark', () => {
  let w = onPrompt(emptyWorld(4), 'go', 1_000, false)
  w = onActivity(w, 'thinking', 1_100)
  expect(onActivity(w, 'thinking', 1_200)).toBe(w)
  w = onWaiting(w, 'Claude needs your permission to use Bash', 1_300)
  expect(w.waiting?.reason).toContain('permission')
  w = onWaiting(w, undefined, 1_400)
  expect(w.waiting).toBeUndefined()
  w = onCost(w, 0.42)
  expect(w.features.some(f => f.kind === 'treasury')).toBe(true)
  expect(costText(onCost(w, 0.5))).toBe('$0.50')
  // On a subscription the dollars are API prices, not a bill.
  const plan = onCost(w, 250, true)
  expect(costText(plan)).toBe('≈$250.00 at API prices')
  expect(plan.features.find(f => f.kind === 'treasury')?.label).toContain('flat fee')
  w = onStep(w, 1000, 0.9)
  w = onStep(w, 1000, 0.1)
  expect(Math.abs((w.cache ?? 0) - 0.66)).toBeLessThan(0.001)
  w = onTurnDone(w, 30, false, 5_000, true)
  expect(w.beast?.isAborted).toBe(true)
  expect(w.beast?.doneAt).toBe(6_000)
})

test('every new sign fits the pane at once', () => {
  let w = onPrompt(emptyWorld(8), 'build it all', 1_000, false)
  for (let k = 0; k < 30; k++) w = onTool(w, k % 2 ? 'Edit' : 'Write', { file_path: `C:/p/src/f${k}.ts`, content: 'x\n'.repeat(80) }, false, 1_000 + k)
  w = onGit(w, { hasRemote: true, host: 'github.com', branch: 'feature/island', ahead: 3, behind: 2, dirty: w.features.map(f => f.key.slice(5).toLowerCase()), head: 'a', commits: 0, at: 1 }, 1)
  w = onReading(w, { cpu: 0.6, ram: 0.8, diskRead: 2e7, diskWrite: 1e7, netDown: 5e6, netUp: 1e6, gpu: { load: 0.9, temp: 72, mem: 0.7, name: 'GTX' }, procs: [{ name: 'chrome', cpu: 0.3 }, { name: 'node', cpu: 0.1 }, { name: 'code', cpu: 0.05 }], ports: [{ port: 3000, name: 'node' }, { port: 8000, name: 'python' }], idle: 0 }, 2_000)
  w = onTests(onCost(w, 3.2), { passed: 40, failed: 3 }, 'npm test', 3_000)
  for (let k = 0; k < 8; k++) w = onPrompt(w, `and another thing, number ${k}`, 3_100 + k, true)
  w = onStep(w, 3_000_000)
  w = onSpinner(onActivity(w, 'writing', 4_000), 'Editing render-svg.ts', 'responding', 4_000)
  const waiting = onWaiting(w, 'A question for you', 4_000)
  for (const yaw of [0, 120, 240]) {
    for (const shown of [w, waiting]) {
      const svg = renderSvg({ ...shown, tide: 80 }, { ...VIEW, yaw }, { hour: 12, now: 4_500 })
      expect(svg.length).toBeLessThan(131072)
      expect(svg).toContain('listening on :3000')
      expect(svg).toContain('a giant at')
      expect(svg).toContain(shown === waiting ? 'Asleep: waiting on you' : 'A tentacle picks at')
    }
  }
  const asleep = renderSvg(onTurnDone(w, 80, true, 3_000, false, 4_200), VIEW, { hour: 12, now: 4_500 })
  expect(asleep).toContain('Asleep: the turn is done')
  expect(asleep).not.toContain('A tentacle on')
  expect(asleep.length).toBeLessThan(131072)
})

test('the pane can show the 3D window’s picture, its hover spots kept and its size bounded', () => {
  const jpeg = 'A'.repeat(100_000)
  const labels = Array.from({ length: 90 }, (_, k): [number, number, string] => [k * 8, k * 5, `House <${k}> & “quotes”`])
  const svg = mirrorSvg({ jpeg, labels })
  expect(svg.length).toBeLessThanOrEqual(131072)
  expect(svg).toContain('data:image/jpeg;base64,AAAA')
  expect(svg).toContain('House &lt;0&gt; &amp;')
  expect(svg).not.toContain('<0>')
  expect(svg).toContain('live from 3D')
  const asked = frameData(emptyWorld(1), 1, 'stats', 1, null, 1, { photo: 42, mirror: true })
  expect(asked.photo).toBe(42)
  expect(asked.mirror).toBe(true)
  expect(frameData(emptyWorld(1), 1, 'stats', 1, null, 1).photo).toBe(0)
})

test('a scene sent for a photo passes only numbers; its paths stay the mod’s own', () => {
  const sent = {
    id: 7, out: 'C:/Windows/evil.png', mesh: '../../secret.bin',
    camera: { eye: [1, 2, 3], target: [0, 1, 0], focus: ['x', 1, 2], fovY: 0.7 },
    sun: { dir: [0, 1, 0], color: [1, 1, 1], up: 0.5 }, night: 'dark', sea: { level: 0.3, radius: 12, bottom: -1, clarity: 0.9 },
  }
  const scene = photoScene(sent, 'C:/home/.claude/terrarium/photos/a.png')
  expect(scene.out).toBe('C:/home/.claude/terrarium/photos/a.png')
  expect(scene.mesh).toBe('../upload/photo-scene.bin')
  expect(scene.camera.eye).toEqual([1, 2, 3])
  expect(scene.camera.focus).toEqual([0, 1, 0])
  expect(scene.night).toBe(0)
  expect(scene.sea.clarity).toBe(0.9)
})

// ---------------------------------------------------------------- the brood

const hatchExplore = (at = 2_000) => {
  let w = onPrompt(emptyWorld(11), 'look around', 1_000, false)
  w = onTool(w, 'Write', { file_path: 'C:/p/src/main.ts', content: 'x\n' }, false, 1_200)
  w = onTool(w, 'Agent', { subagent_type: 'Explore', description: 'Find the handlers', prompt: 'go' }, false, at - 100)
  return onSpawn(w, { id: 'a1', type: 'Explore', task: 'Find the handlers', model: 'claude-haiku-5-5', isBackground: false }, at, false)
}

test('a subagent hatches at its type’s nest, colored by its type, its eyes by its model', () => {
  const w = hatchExplore()
  const nest = w.features.find(f => f.kind === 'camp')!
  expect(nest.key).toBe('camp:Explore')
  expect(nest.size).toBe(1)
  expect(nest.label).toContain('The Explore nest · 1 spawnling hatched here · the last: Find the handlers')
  const s = w.brood![0]!
  expect(s).toMatchObject({ id: 'a1', type: 'Explore', depth: 1, hue: 172, nest: nest.id, x: nest.x + 0.5, y: nest.y + 0.5, calls: 0, tokens: 0 })
  expect(w.chronicle.at(-1)).toContain('A Explore spawnling hatches: “Find the handlers”')
  expect(familyOf(s.model)).toBe('haiku')
  expect(modelName(s.model)).toBe('Haiku 5.5')
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf(undefined)).toBe('other')
  // A spawn the mod saw no Agent call for lays its own egg; the same agent twice hatches once.
  const again = onSpawn(w, { id: 'a2', type: 'Explore', task: 'More', model: 'claude-sonnet-5-5' }, 3_000)
  expect(again.features.find(f => f.kind === 'camp')?.size).toBe(2)
  expect(onSpawn(again, { id: 'a2', type: 'Explore', task: 'More', model: 'x' }, 3_100)).toBe(again)
  // Other types take a color from their name, clear of the creature's violet; a fork wears the violet.
  for (const type of ['my-plugin:reviewer', 'lab:runner', 'x', 'teammate']) {
    const hue = broodHue(type, 'ada')
    expect(hue >= 250 && hue <= 310).toBe(false)
  }
  const fork = onSpawn(w, { id: 'f1', type: 'fork', task: 'Try it the other way', model: 'claude-opus-5-5', isFork: true }, 3_000)
  expect(fork.brood?.at(-1)?.hue).toBe(280)
  expect(fork.chronicle.at(-1)).toContain('lays a fork of itself')
})

test('a spawnling works on its own: its calls, its tokens, its crawl; the creature stays put', () => {
  let w = hatchExplore()
  const beastBefore = w.beast!
  w = onTool(w, 'Read', { file_path: 'C:/p/src/handlers.ts' }, 'a1', 2_500)
  w = onTool(w, 'Grep', { pattern: 'onClick' }, 'a1', 2_600)
  w = onStep(w, 50_000, undefined, { agent: 'a1', model: 'claude-haiku-5-5', at: 2_700 })
  const s = w.brood![0]!
  expect(s.calls).toBe(2)
  expect(s.tokens).toBe(50_000)
  expect(s.lastAt).toBe(2_700)
  expect(w.events?.at(-1)?.agent).toBe('a1')
  const tree = w.features.find(f => f.key === 'read:C:/p/src/handlers.ts')!
  expect(tree.by).toBe('a1')
  expect({ x: s.x, y: s.y }).toEqual({ x: tree.x + 0.5, y: tree.y + 0.5 })
  expect(w.beast?.x).toBe(beastBefore.x)
  expect(w.beast?.tokens).toBe(beastBefore.tokens)
  // The creature's own next call takes the file back.
  w = onTool(w, 'Edit', { file_path: 'C:/p/src/handlers.ts' }, false, 2_800)
  expect(w.features.find(f => f.key === 'file:C:/p/src/handlers.ts')?.by).toBeUndefined()
  // A spawnling is smaller than the creature at the same tokens, and smaller again a level deeper.
  const grown = spawnShape(s, 60_000)
  const big = beastShape({ bornAt: s.bornAt, tokens: s.tokens }, 60_000)
  expect(grown.body).toBeLessThan(big.body)
  expect(grown.reach).toBeLessThan(big.reach)
  const child = onSpawn(w, { id: 'a3', parent: 'a1', type: 'Plan', task: 'Plan it', model: 'claude-sonnet-5-5' }, 3_000)
  const deep = child.brood!.at(-1)!
  expect(deep.depth).toBe(2)
  expect(deep.parent).toBe('a1')
  expect(spawnShape({ ...deep, tokens: s.tokens, bornAt: s.bornAt }, 60_000).body).toBeLessThan(grown.body)
  expect(child.chronicle.at(-1)).toContain('from the Explore spawnling')
  // A failed call marks its own creature's event, not another's.
  const failed = onToolError(onTool(w, 'Grep', { pattern: 'x' }, false, 3_100), 'Grep', 3_200, 'a1')
  expect(failed.events?.find(e => e.agent === 'a1' && e.tool === 'Grep')?.isError).toBe(true)
  expect(failed.events?.at(-1)?.isError).toBeUndefined()
})

test('done, a spawnling crawls home and is absorbed; failed, it curls up until the next prompt', () => {
  let w = hatchExplore()
  w = onTool(w, 'Read', { file_path: 'C:/p/src/far.ts' }, 'a1', 2_500)
  w = onSpawn(w, { id: 'b1', type: 'Plan', task: 'Plan', model: 'claude-sonnet-5-5', isBackground: true }, 2_600)
  const home = beastAt(w.beast!, 9_000)
  w = onAgentDone(w, 'a1', { reason: 'answer', answer: 1_234 }, 9_000)
  const s = w.brood!.find(q => q.id === 'a1')!
  expect(s).toMatchObject({ outcome: 'done', doneAt: 9_000, answer: 1_234, movedAt: 9_000 })
  expect({ x: s.x, y: s.y }).toEqual({ x: Math.round(home.x * 100) / 100, y: Math.round(home.y * 100) / 100 })
  expect(homeAt(s)).toBe(9_000 + crawlMs(s))
  expect(w.chronicle.at(-1)).toContain('The Explore spawnling crawls home with its answer after 7s, 0 tokens and 1 tool call')
  expect(spawnText(s, 10_000)).toContain('home with its answer · Haiku 5.5 eyes')
  expect(onAgentDone(w, 'a1', { reason: 'answer' }, 9_500)).toBe(w)
  w = onAgentDone(w, 'b1', { reason: 'aborted', isAborted: true }, 9_100)
  expect(w.brood!.find(q => q.id === 'b1')).toMatchObject({ outcome: 'aborted', doneAt: 9_100 })
  expect(w.chronicle.at(-1)).toContain('The Plan spawnling is stopped, and curls up where it stands')
  // The next prompt lets both go; one still at work stays.
  w = onSpawn(w, { id: 'c1', type: 'general-purpose', task: 'Still going', model: 'claude-opus-5-5', isBackground: true }, 9_200)
  w = onPrompt(w, 'next thing', 60_000, false)
  expect(w.brood?.map(q => q.id)).toEqual(['c1'])
  expect(w.brood?.[0]?.hue).toBe(36)
})

test('teammates doze between messages and wake to them; a message is thrown between creatures', () => {
  let w = onPrompt(emptyWorld(12), 'build a team', 1_000, false)
  w = onSpawn(w, { id: 't1', type: 'reviewer', task: 'Review', model: 'claude-sonnet-5-5', isTeammate: true, name: 'ada', isBackground: true }, 2_000)
  expect(w.chronicle.at(-1)).toContain('ada joins the team, a reviewer spawnling')
  w = onAgentDone(w, 't1', { reason: 'answer', answer: 10 }, 5_000)
  expect(w.brood?.[0]).toMatchObject({ outcome: 'idle', doneAt: 5_000 })
  const before = w.features.length
  w = onTool(w, 'SendMessage', { to: 'ada', message: 'look at this' }, false, 6_000)
  expect(w.features.length).toBe(before)
  expect(w.events?.at(-1)).toMatchObject({ tool: 'SendMessage', to: 't1', at: 6_000 })
  expect(w.chronicle.at(-1)).toBe('The creature sends word to ada.')
  w = onStep(w, 2_000, undefined, { agent: 't1', at: 6_500 })
  expect(w.brood?.[0]?.doneAt).toBeUndefined()
  expect(w.brood?.[0]?.outcome).toBeUndefined()
  w = onTool(w, 'SendMessage', { to: 'main', message: 'done' }, 't1', 7_000)
  expect(w.events?.at(-1)).toMatchObject({ agent: 't1', to: 'main' })
  expect(w.chronicle.at(-1)).toBe('Ada sends word to the creature.')
  // A teammate stays across prompts; spawned again under its name, it replaces the one before.
  w = onPrompt(w, 'more', 8_000, false)
  expect(w.brood?.length).toBe(1)
  w = onSpawn(w, { id: 't2', type: 'reviewer', task: 'Review again', model: 'claude-sonnet-5-5', isTeammate: true, name: 'ada' }, 9_000)
  expect(w.brood?.map(q => q.id)).toEqual(['t2'])
})

test('a workflow swarm marches out of its nest in file and comes home together', () => {
  let w = onPrompt(emptyWorld(13), 'run the workflow', 1_000, false)
  for (let k = 1; k <= 3; k++) w = onSpawn(w, { id: `w${k}`, type: 'general-purpose', task: `Part ${k}`, model: 'claude-sonnet-5-5', run: 'wf_1', rank: k, isBackground: true }, 2_000)
  expect(w.features.find(f => f.kind === 'camp')?.size).toBe(3)
  expect(w.chronicle.filter(l => l.includes('workflow swarm hatches')).length).toBe(1)
  for (let k = 1; k <= 3; k++) w = onTool(w, 'Read', { file_path: `C:/p/part${k}.md` }, `w${k}`, 3_000)
  expect(w.brood?.map(s => s.movedAt)).toEqual([3_000, 3_350, 3_700])
  for (let k = 1; k <= 3; k++) w = onAgentDone(w, `w${k}`, { reason: 'answer' }, 9_000 + k)
  expect(w.chronicle.at(-1)).toBe('The workflow swarm crawls home: 3 spawnlings.')
})

test('a spawnling whose end went unseen finishes when the engine lists it done', () => {
  let w = hatchExplore()
  w = onSpawn(w, { id: 'z', type: 'Plan', task: 'Lost', model: 'm' }, 2_000)
  const list = [{ id: 'a1', status: 'completed' }, { id: 'z', status: 'running' }]
  expect(onAgentList(w, list, 30_000)).toBe(w)
  w = onAgentList(w, list, 70_000)
  expect(w.brood?.find(s => s.id === 'a1')?.outcome).toBe('done')
  expect(w.brood?.find(s => s.id === 'z')?.doneAt).toBeUndefined()
  w = onAgentList(w, [], 2_000 + 31 * 60_000)
  expect(w.brood?.find(s => s.id === 'z')?.outcome).toBe('failed')
})

test('the pane draws the brood: colored, eyed by model, tied by silk, sinking home, and counted past six', () => {
  let w = hatchExplore()
  w = onTool(w, 'Read', { file_path: 'C:/p/src/handlers.ts' }, 'a1', 2_500)
  w = onSpawn(w, { id: 't1', type: 'reviewer', task: 'Review', model: 'claude-sonnet-5-5', isTeammate: true, name: 'ada', isBackground: true }, 2_600)
  w = onSpawn(w, { id: 'g1', type: 'general-purpose', task: 'Write it', model: 'claude-opus-5-5', isBackground: true }, 2_700)
  w = onAgentDone(w, 'g1', { reason: 'answer', answer: 500 }, 3_000)
  w = onTool(w, 'SendMessage', { to: 'ada', message: 'hi' }, false, 3_100)
  const svg = renderSvg(w, VIEW, { hour: 12, now: 3_500 })
  expect(svg).toContain('A Explore spawnling · “Find the handlers” · at work while its parent waits · Haiku 5.5 eyes')
  expect(svg).toContain('href="#eih"')
  expect(svg).toContain('href="#eis"')
  expect(svg).toContain('id="sg0"')
  expect(svg).toContain('A silk thread: its parent waits on this spawnling')
  expect(svg).toContain('>ada</text>')
  expect(svg).toContain('type="scale" values="1;0"')
  expect(svg).toContain('A message between creatures')
  expect(svg).toContain('A tentacle drinks in handlers.ts')
  expect(svg).toContain('The Explore nest')
  // The creature does not reach for its spawnling's work.
  expect(svg.match(/A tentacle drinks in handlers\.ts/g)?.length).toBe(1)
  // Past six, the rest are counted.
  let crowd = w
  for (let k = 0; k < 8; k++) crowd = onSpawn(crowd, { id: `c${k}`, type: 'Plan', task: `Part ${k}`, model: 'claude-haiku-5-5', isBackground: true }, 3_200 + k)
  const busy = renderSvg(crowd, VIEW, { hour: 12, now: 3_500 })
  expect(busy).toContain('more spawnlings not drawn')
  expect(busy.length).toBeLessThan(131072)
  expect(frameData(crowd, 1, 'stats', 1, null, 3_500).world.brood?.length).toBe(crowd.brood?.length)
})

test('in a full town each agent type still weaves its own nest, and each egg is laid once', () => {
  let w = onPrompt({ ...emptyWorld(14), slots: 400 }, 'go', 1_000, false)
  w = onTool(w, 'Agent', { subagent_type: 'general-purpose', description: 'One', prompt: 'x' }, false, 1_100)
  w = onSpawn(w, { id: 'g', type: 'general-purpose', task: 'One', model: 'claude-haiku-5-5' }, 1_200, false)
  w = onTool(w, 'Agent', { subagent_type: 'Explore', description: 'Two', prompt: 'x' }, false, 1_300)
  w = onSpawn(w, { id: 'e', type: 'Explore', task: 'Two', model: 'claude-opus-5-5' }, 1_400, false)
  const nests = w.features.filter(f => f.kind === 'camp')
  expect(nests.map(f => [f.key, f.size])).toEqual([['camp:general-purpose', 1], ['camp:Explore', 1]])
  expect(new Set(nests.map(f => `${f.x},${f.y}`)).size).toBe(2)
  expect(w.brood?.map(s => s.nest)).toEqual(nests.map(f => f.id))
})

test('the chat panel shows what was said and done, and takes back only a well-formed message', () => {
  const items = chatItems([
    { role: 'user', text: '<system-reminder>secret context</system-reminder>make it blue', toolUses: [] },
    { role: 'assistant', text: 'On it.', toolUses: [{ tool: 'Read', input: { file_path: 'C:/p/src/app.ts' } }, { tool: 'Bash', input: { command: 'npm   test' }, isError: true }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{}] },
    { role: 'user', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [] },
  ], 'Writing the **answer**')
  expect(items).toEqual([
    { role: 'user', text: 'make it blue' },
    { role: 'assistant', text: 'On it.' },
    { role: 'tool', text: 'Read · app.ts' },
    { role: 'tool', text: 'Bash · npm test', isError: true },
    { role: 'user', text: '/compact' },
    { role: 'assistant', text: 'Writing the **answer**', isLive: true },
  ])
  expect(chatItems(Array.from({ length: 400 }, (_, k) => ({ role: 'user' as const, text: `m${k}`, toolUses: [] }))).length).toBe(160)
  expect(promptFromUpload(JSON.stringify({ id: 'abc-123', text: '  hello there  ' }))).toEqual({ id: 'abc-123', text: 'hello there' })
  for (const bad of ['nope', '{}', JSON.stringify({ id: 'x', text: 'hi' }), JSON.stringify({ id: 'abc-123', text: '   ' }), JSON.stringify({ id: 'abc-123', text: 'x'.repeat(8001) }), JSON.stringify({ id: '../../etc', text: 'hi' }), JSON.stringify({ id: 'abc-123', text: 42 })]) {
    expect(promptFromUpload(bad)).toBeUndefined()
  }
})
