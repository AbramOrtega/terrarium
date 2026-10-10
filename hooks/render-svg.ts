import type {
  TerrariumArch as Arch,
  TerrariumBeast as Beast,
  TerrariumBridge as Bridge,
  TerrariumDistrict as District,
  TerrariumEdit as Edit,
  TerrariumEvent as Event,
  TerrariumFeature as Feature,
  TerrariumKit as Kit,
  TerrariumShape as ShapeOf,
  TerrariumSpawn as Spawn,
  TerrariumView as View,
  TerrariumWalk as Walk,
  TerrariumWorld as World,
} from '../types'
import { BIOME, BOTTOM, buildIsland, DECOR, type Island, noise, rand2 } from './terrain'
import { beastAt, beastShape, broodHue, broodShapes, bridgesOf, familyOf, type Family, homeAt, spawnText, busyOf, crawlMs, districtsOf, glowOf, hash, historyText, isDirty, kitsOf, moonArc, routeOf, streetsOf, testsOf, throughput, walksOf, weathering } from './world'

export const WIDTH = 760
export const HEIGHT = 540
const BUDGET = 126_000
const EFFECT_SECONDS = 5

// How much a drawing may spend: 3 is everything; each step down drops fine
// work (decimals, the seabed, windows, wild growth, small tooltips).
let detail = 3
const n0 = (v: number) => Math.round(v)
const n1 = (v: number) => (detail >= 3 ? Math.round(v * 10) / 10 : Math.round(v))

// ---------------------------------------------------------------- color

type Phase = 'night' | 'dawn' | 'day' | 'dusk'

export const phaseOf = (hour: number): Phase =>
  hour < 5 || hour >= 20.5 ? 'night' : hour < 7.5 ? 'dawn' : hour < 17 ? 'day' : 'dusk'

const SKY: Record<Phase, [string, string]> = {
  night: ['#070b1f', '#1e2a55'],
  dawn: ['#6f8fd6', '#f7b48d'],
  day: ['#7fbcf5', '#dff0ff'],
  dusk: ['#2e2a5e', '#f08a5d'],
}

const TINT: Record<Phase, [number, number, number]> = {
  night: [0.42, 0.5, 0.78],
  dawn: [1.02, 0.9, 0.86],
  day: [1, 1, 1],
  dusk: [1.0, 0.8, 0.72],
}

const hex = (c: string): [number, number, number] => {
  const s = c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c
  const n = parseInt(s.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (r: number, g: number, b: number) => {
  const k = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${k(r)}${k(g)}${k(b)}`
}

// Three hex digits: fewer colors, so neighbouring faces share a fill and merge.
const toShort = (r: number, g: number, b: number) => {
  const k = (v: number) => Math.max(0, Math.min(15, Math.round(v / 17))).toString(16)
  return `#${k(r)}${k(g)}${k(b)}`
}

const mixHex = (a: string, b: string, t: number): string => {
  const [ar, ag, ab] = hex(a)
  const [br, bg, bb] = hex(b)
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
}

const hsl = (h: number, s: number, l: number): string => {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))
  }
  return toHex(f(0), f(8), f(4))
}

type Tone = (color: string, light?: number, haze?: number) => string

const makeTone = (phase: Phase, storm: number, hazeColor: string, isShort: boolean): Tone => {
  const cache = new Map<string, string>()
  const [tr, tg, tb] = TINT[phase]
  const gray = storm * 0.45
  const dim = 1 - storm * 0.22
  const [hr, hg, hb] = hex(hazeColor)
  return (color, light = 1, haze = 0) => {
    const id = `${color}${light}${haze}`
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const [r, g, b] = hex(color)
    const y = 0.3 * r + 0.59 * g + 0.11 * b
    const mix = (v: number, t: number, h: number) => ((v * (1 - gray) + y * gray) * t * light * dim) * (1 - haze) + h * haze
    const out = (isShort ? toShort : toHex)(mix(r, tr, hr), mix(g, tg, hg), mix(b, tb, hb))
    cache.set(id, out)
    return out
  }
}

const esc = (text: string) =>
  text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// ---------------------------------------------------------------- scene

type Pt = [number, number]

type Scene = {
  world: World
  island: Island
  sea: number
  S: number
  Z: number
  c: number
  s: number
  ox: number
  oy: number
  tone: Tone
  flat: Tone
  phase: Phase
  isNight: boolean
  now: number
  features: Map<string, Feature>
  tops: Map<number, Pt>
  /** Buildings' walls, for bridges to tie on: centre x, y, ground, height, half-width. */
  anchors: Map<number, [number, number, number, number, number]>
  /** Tests and what they test, worked out once a drawing; and each watchtower's "tests …". */
  bridges: Bridge[]
  tested: Map<number, string>
  /** Each building's kit of parts; the buildings at work; the townsfolk's errands; the recent work drawn in finer detail. */
  kits: Record<number, Kit>
  busy: Set<number>
  walks: Walk[]
  near: Set<number>
}

const proj = (sc: Scene, x: number, y: number, z: number): Pt => [
  sc.ox + (x * sc.c - y * sc.s) * sc.S,
  sc.oy + (x * sc.s + y * sc.c) * sc.S * 0.5 - z * sc.Z,
]

const depth = (sc: Scene, x: number, y: number) => x * sc.s + y * sc.c

/** A closed shape in relative steps: the cheapest way to spell a polygon. */
const rel = (points: Pt[], round = n0): string => {
  const first = points[0]
  if (first === undefined) return ''
  let px = round(first[0])
  let py = round(first[1])
  let d = `M${px} ${py}l`
  for (let k = 1; k < points.length; k++) {
    const p = points[k]!
    const x = round(p[0])
    const y = round(p[1])
    d += `${k > 1 ? ' ' : ''}${n1(x - px)} ${n1(y - py)}`
    px = x
    py = y
  }
  return `${d}z`.replace(/ -/g, '-')
}

const shape = (points: Pt[], fill: string, extra = '') => `<path d="${rel(points, n1)}" fill="${fill}"${extra}/>`

// Light falls from the world's north-west, so turning the camera turns the shadows.
const LIGHT: Pt = [-0.62, -0.78]
const lightOf = (nx: number, ny: number) => 0.6 + 0.32 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1])

const GROUND: Record<number, string> = {
  [BIOME.seabed]: '#b9b08a',
  [BIOME.beach]: '#e4d29c',
  [BIOME.meadow]: '#8cc265',
  [BIOME.forest]: '#4f8b41',
  [BIOME.dry]: '#bcb46d',
  [BIOME.rock]: '#8e877c',
  [BIOME.snow]: '#eef3f6',
  [BIOME.river]: '#4a9cc4',
  [BIOME.lava]: '#ff6a22',
  [BIOME.marsh]: '#6f9a5a',
}

/** The painter's queue: consecutive faces of one fill share one element. */
class Layer {
  out: string[] = []
  private fill = ''
  private d = ''
  face(d: string, fill: string) {
    if (fill === this.fill) {
      this.d += d
      return
    }
    this.flush()
    this.fill = fill
    this.d = d
  }
  raw(s: string) {
    this.flush()
    this.out.push(s)
  }
  flush() {
    if (this.d !== '') this.out.push(`<path d="${this.d}" fill="${this.fill}"/>`)
    this.fill = ''
    this.d = ''
  }
  text() {
    this.flush()
    return this.out.join('')
  }
}

// ---------------------------------------------------------------- structures

const box = (
  sc: Scene, cx: number, cy: number, ax: number, ay: number, z0: number, z1: number,
  wall: string, top: string | undefined, out: string[],
) => {
  const faces: { d: number; s: string }[] = []
  const sides: [number, number, number, number, number, number][] = [
    [cx + ax, cy - ay, cx + ax, cy + ay, 1, 0],
    [cx - ax, cy + ay, cx - ax, cy - ay, -1, 0],
    [cx + ax, cy + ay, cx - ax, cy + ay, 0, 1],
    [cx - ax, cy - ay, cx + ax, cy - ay, 0, -1],
  ]
  for (const [x1, y1, x2, y2, nx, ny] of sides) {
    if (nx * sc.s + ny * sc.c <= 0) continue
    faces.push({
      d: depth(sc, (x1 + x2) / 2, (y1 + y2) / 2),
      s: shape(
        [proj(sc, x1, y1, z1), proj(sc, x2, y2, z1), proj(sc, x2, y2, z0), proj(sc, x1, y1, z0)],
        sc.tone(wall, lightOf(nx, ny)),
      ),
    })
  }
  faces.sort((a, b) => a.d - b.d).forEach(f => out.push(f.s))
  if (top !== undefined) {
    out.push(shape(
      [proj(sc, cx - ax, cy - ay, z1), proj(sc, cx + ax, cy - ay, z1), proj(sc, cx + ax, cy + ay, z1), proj(sc, cx - ax, cy + ay, z1)],
      sc.tone(top, 1.05),
    ))
  }
}

const pyramid = (
  sc: Scene, cx: number, cy: number, a: number, z0: number, z1: number, color: string, out: string[], stripe?: string,
) => {
  const apex = proj(sc, cx, cy, z1)
  const corners: [number, number, number, number, number, number][] = [
    [cx + a, cy - a, cx + a, cy + a, 1, 0],
    [cx - a, cy + a, cx - a, cy - a, -1, 0],
    [cx + a, cy + a, cx - a, cy + a, 0, 1],
    [cx - a, cy - a, cx + a, cy - a, 0, -1],
  ]
  corners
    .map(([x1, y1, x2, y2, nx, ny], k) => ({
      d: depth(sc, (x1 + x2) / 2, (y1 + y2) / 2),
      s: shape(
        [proj(sc, x1, y1, z0), proj(sc, x2, y2, z0), apex],
        sc.tone(stripe !== undefined && k % 2 === 1 ? stripe : color, lightOf(nx, ny) + 0.08),
      ),
    }))
    .sort((p, q) => p.d - q.d)
    .forEach(f => out.push(f.s))
}

const dome = (sc: Scene, cx: number, cy: number, a: number, z: number, color: string, out: string[]) => {
  const [x, y] = proj(sc, cx, cy, z)
  const rx = a * sc.S * 1.05
  out.push(`<path d="M${n1(x - rx)} ${n1(y)}A${n1(rx)} ${n1(rx * 0.85)} 0 0 1 ${n1(x + rx)} ${n1(y)}Z" fill="${sc.tone(color, 1.05)}"/>`)
  out.push(`<ellipse cx="${n1(x - rx * 0.3)}" cy="${n1(y - rx * 0.5)}" rx="${n1(rx * 0.25)}" ry="${n1(rx * 0.15)}" fill="#fff" opacity=".35"/>`)
}

/**
 * Windows on the faces in view. With its file's shape: FIXMEs board some up,
 * spread over the building, and comments put flower boxes under others.
 */
const windows = (sc: Scene, cx: number, cy: number, a: number, z0: number, floors: number, floorH: number, out: string[], isLit = false, sh?: ShapeOf) => {
  const lit = isLit || sc.isNight || sc.phase === 'dusk'
  const fill = lit ? '#ffd77a' : sc.tone('#3d4b5c')
  const r = Math.max(0.8, sc.S * 0.045)
  const shown = Math.min(floors, detail >= 3 ? 4 : detail === 2 ? 2 : 0)
  const faces = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).filter(([nx, ny]) => nx * sc.s + ny * sc.c > 0.15)
  const boards = detail >= 2 ? Math.min(sh?.fixmes ?? 0, 4, faces.length * shown) : 0
  const every = boards > 0 ? Math.floor((faces.length * shown) / boards) : 0
  const flowers = detail >= 2 ? sh?.flowers ?? 0 : 0
  let planks = ''
  let blooms = ''
  let boxes = ''
  let boarded = 0
  let i = 0
  for (const [nx, ny] of faces) {
    for (let k = 0; k < shown; k++, i++) {
      const [x, y] = proj(sc, cx + nx * a * 1.01, cy + ny * a * 1.01, z0 + (k + 0.55) * floorH)
      if (boarded < boards && i % every === 0) {
        boarded++
        planks += `M${n1(x - r)} ${n1(y - r * 1.3)}h${n1(r * 2)}v${n1(r * 2.4)}h${n1(-r * 2)}zm0 0l${n1(r * 2)} ${n1(r * 2.4)}m0 ${n1(-r * 2.4)}l${n1(-r * 2)} ${n1(r * 2.4)}`
        continue
      }
      out.push(`<rect x="${n1(x - r)}" y="${n1(y - r * 1.3)}" width="${n1(r * 2)}" height="${n1(r * 2.4)}" fill="${fill}"${lit && (k + cx) % 3 !== 1 ? ' class="pl"' : ''}/>`)
      if (flowers > 0 && (i * 0.618 + cx * 0.13) % 1 < flowers) {
        blooms += `M${n1(x - r * 1.3)} ${n1(y + r * 0.9)}h${n1(r * 2.6)}v${n1(r * 0.5)}h${n1(-r * 2.6)}z`
        boxes += `M${n1(x - r * 1.3)} ${n1(y + r * 1.4)}h${n1(r * 2.6)}v${n1(r * 0.6)}h${n1(-r * 2.6)}z`
      }
    }
  }
  if (planks !== '') out.push(`<path d="${planks}" fill="${sc.tone('#8a6a48')}" stroke="${sc.tone('#4a3424')}" stroke-width=".7"/>`)
  if (blooms !== '') out.push(`<path d="${blooms}" fill="${sc.tone('#e0506e')}"/><path d="${boxes}" fill="${sc.tone('#7a5235')}"/>`)
}

/**
 * Each edit a band of its prompt's color on the faces in view, where it fell
 * in the file (its first line at the top), as thick as the passage it
 * changed; the newest strongest, the last few as room allows.
 */
const editBands = (sc: Scene, cx: number, cy: number, a: number, z0: number, hgt: number, edits: readonly Edit[], wall: string, out: string[]) => {
  const room = [0, 1, 2, 4][detail]!
  const shown = room === 0 ? [] : edits.slice(-room)
  const w = a * 1.01
  // The faces in view, wrapped as one strip round the corner nearest the eye.
  const [sx, sy] = nearCorner(sc)
  const ring: Pt[] = [[cx + sx * w, cy - sy * w], [cx + sx * w, cy + sy * w], [cx - sx * w, cy + sy * w]]
  const light = (lightOf(sx, 0) + lightOf(0, sy)) / 2
  shown.forEach((b, q) => {
    const rank = edits.length - shown.length + q
    const th = Math.min(hgt, Math.max(0.12, Math.min(1, b.span) * hgt))
    const lo = z0 + Math.max(0, Math.min(hgt - th, (1 - b.pos) * hgt - th))
    const color = mixHex(wall, hsl((b.turn * 137.508 + 20) % 360, 0.62, 0.56), 0.25 + 0.3 * (edits.length > 1 ? rank / (edits.length - 1) : 1))
    out.push(shape([...ring.map(([x, y]) => proj(sc, x, y, lo + th)), ...[...ring].reverse().map(([x, y]) => proj(sc, x, y, lo))], sc.tone(color, light)))
  })
}

/** The corner of a block nearest the eye, and the faces either side of it. */
const nearCorner = (sc: Scene): Pt =>
  ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as Pt[]).sort((p, q) => depth(sc, q[0], q[1]) - depth(sc, p[0], p[1]))[0]!

/**
 * A file left alone: moss along its eaves, and from the second stage ivy
 * climbing the corner nearest the eye, higher the longer it waits.
 */
const overgrowth = (sc: Scene, cx: number, cy: number, a: number, z0: number, hgt: number, stage: number, out: string[]) => {
  if (stage === 0 || detail < 2) return
  const u = sc.S
  const [sx, sy] = nearCorner(sc)
  const corner = proj(sc, cx + sx * a, cy + sy * a, z0 + hgt)
  const left = proj(sc, cx + sx * a, cy - sy * a, z0 + hgt)
  const right = proj(sc, cx - sx * a, cy + sy * a, z0 + hgt)
  if (detail >= 3) out.push(`<path d="M${pt(left)}L${pt(corner)}L${pt(right)}" class="iv" stroke="${sc.tone('#5d7a3a')}" stroke-width="${n1(u * 0.07)}"/>`)
  if (stage < 2) return
  const [bx, by] = proj(sc, cx + sx * a, cy + sy * a, z0)
  const rise = (by - corner[1]) * Math.min(1, (stage - 1) / 3)
  let d = ''
  for (const side of [-1, 1]) {
    d += `M${n1(bx + side * u * 0.04)} ${n1(by)}`
    for (let k = 1; k <= 5; k++) d += `L${n1(bx + side * u * (0.03 + 0.05 * ((k * 7 + side) % 3)))} ${n1(by - (rise * k) / 5)}`
  }
  out.push(`<path d="${d}" class="iv" stroke="${sc.tone('#4f7d36')}" stroke-width="${n1(u * 0.09)}"/>`)
}

/** A patch on the most-seen wall for each failed edit later made good. */
const patches = (sc: Scene, cx: number, cy: number, a: number, z0: number, hgt: number, scars: number, wall: string, out: string[]) => {
  const n = Math.min(3, scars, detail >= 2 ? 3 : detail === 1 ? 1 : 0)
  if (n === 0) return
  const [nx, ny] = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as Pt[]).sort((p, q) => (q[0] * sc.s + q[1] * sc.c) - (p[0] * sc.s + p[1] * sc.c))[0]!
  const tx = -ny
  const ty = nx
  let d = ''
  for (let q = 0; q < n; q++) {
    const along = -a * 0.55
    const lo = z0 + Math.max(0.05, Math.min(hgt - 0.25, hgt * [0.3, 0.62, 0.85][q]!))
    const px = cx + nx * a * 1.02 + tx * along
    const py = cy + ny * a * 1.02 + ty * along
    d += rel([proj(sc, px - tx * 0.07, py - ty * 0.07, lo + 0.2), proj(sc, px + tx * 0.07, py + ty * 0.07, lo + 0.2), proj(sc, px + tx * 0.07, py + ty * 0.07, lo), proj(sc, px - tx * 0.07, py - ty * 0.07, lo)], n1)
  }
  out.push(`<path d="${d}" fill="${sc.tone(mixHex(wall, '#7a6550', 0.6), lightOf(nx, ny))}" stroke="${sc.tone('#4a3a2c')}" stroke-width=".6"/>`)
}

/** A crane at the back of the plot while its file holds TODOs, a crate on the hook for each (up to three). */
const crane = (sc: Scene, cx: number, cy: number, z0: number, top: number, todos: number, out: string[]) => {
  if (todos === 0 || detail < 2) return
  const u = sc.S
  const [sx, sy] = nearCorner(sc)
  const mx = cx - sx * 0.42
  const my = cy - sy * 0.42
  const zTop = top + 0.8
  const base = proj(sc, mx, my, z0)
  const head = proj(sc, mx, my, zTop)
  const back = proj(sc, mx - (cx - mx) * 0.25, my - (cy - my) * 0.25, zTop)
  const tip = proj(sc, mx + (cx - mx) * 1.1, my + (cy - my) * 1.1, zTop)
  const hook = tip[1] + u * 0.25
  out.push(`<path d="M${pt(base)}L${pt(head)}M${pt(back)}L${pt(tip)}M${pt(tip)}V${n1(hook)}" fill="none" stroke="${sc.tone('#e2b33a')}" stroke-width="${n1(Math.max(1, u * 0.05))}"/>`)
  let crates = ''
  for (let q = 0; q < Math.min(3, todos); q++) crates += `M${n1(tip[0] - u * 0.07)} ${n1(hook + q * u * 0.1)}h${n1(u * 0.14)}v${n1(u * 0.09)}h${n1(-u * 0.14)}z`
  out.push(`<path d="${crates}" fill="${sc.tone('#9a7048')}"/>`)
}

/** How tall a floor is (in terrace levels) and what the walls are, in each language's architecture. */
const PANE_LOOK: Record<Arch, { fh: number; wall: string }> = {
  townhouse: { fh: 0.55, wall: '#f1e6d2' },
  cottage: { fh: 0.5, wall: '#f3ead6' },
  fort: { fh: 0.5, wall: '#6e625a' },
  workshop: { fh: 0.45, wall: '#d6cfc2' },
  keep: { fh: 0.6, wall: '#a39e94' },
  painted: { fh: 0.55, wall: '#f1e6d2' },
  pavilion: { fh: 0.5, wall: '#fbf3e6' },
  library: { fh: 0.62, wall: '#e9dfc9' },
  vault: { fh: 0.45, wall: '#c9d3dc' },
  shed: { fh: 0.4, wall: '#9a7652' },
  silo: { fh: 0.45, wall: '#d7c39a' },
  watchtower: { fh: 0.8, wall: '#a39e96' },
}

/** Islands from before languages were known: by the old file styles. */
const ARCH_OF_STYLE: Record<string, Arch> = { code: 'townhouse', doc: 'library', config: 'vault', web: 'pavilion', test: 'watchtower', data: 'silo' }

/** Battlements around a flat roof: an iron fort's or a stone keep's. */
const crenels = (sc: Scene, cx: number, cy: number, a: number, z: number, color: string, out: string[]) => {
  // All round at full detail; the four corners when the drawing runs short of room; none below that.
  if (detail < 2) return
  const merlons: Pt[] = []
  for (const s of [-1, 1]) {
    for (const k of detail >= 3 ? [-1, 0, 1] : [-1, 1]) {
      merlons.push([cx + k * a * 0.8, cy + s * a * 0.9])
      if (k !== 0 && detail >= 3) merlons.push([cx + s * a * 0.9, cy + k * a * 0.8])
    }
  }
  merlons
    .sort((p, q) => depth(sc, p[0], p[1]) - depth(sc, q[0], q[1]))
    .forEach(([x, y]) => box(sc, x, y, 0.045, 0.045, z, z + 0.3, color, undefined, out))
}

/**
 * The streets on the ground, gathered cell by cell so they paint in turn with
 * the land: each stretch along a line between plots goes with the cell in
 * front of it, at the higher ground beside it; the lane in to a building and
 * the square under a much-imported one go with the building's own cell.
 */
const streetMarks = (sc: Scene): Map<string, string[]> => {
  const marks = new Map<string, string[]>()
  // The streets are kept at every level of detail, fewer as the drawing runs short of room.
  const streets = streetsOf(sc.world).slice(0, [40, 80, 160, 160][detail])
  if (streets.length === 0) return marks
  const byId = new Map(sc.world.features.map(f => [f.id, f]))
  const levelAt = (i: number, j: number) => (sc.island.inside(i, j) ? Math.max(sc.island.level(i, j), sc.sea) : sc.sea)
  const lines = new Map<string, Map<string, Set<string>>>()
  const draw = (cell: string, style: string, d: string) => {
    const at = lines.get(cell) ?? new Map<string, Set<string>>()
    at.set(style, (at.get(style) ?? new Set<string>()).add(d))
    lines.set(cell, at)
  }
  const edges = new Map<string, { u: Pt; v: Pt; n: number; isPath: boolean }>()
  const imported = new Map<number, number>()
  for (const s of streets) {
    const a = byId.get(s.from)
    const b = byId.get(s.to)
    if (a === undefined || b === undefined) continue
    imported.set(b.id, (imported.get(b.id) ?? 0) + 1)
    const r = routeOf(a, b)
    for (const [f, center, corner] of [[a, r[0], r[1]], [b, r[4], r[3]]] as const) {
      const z = levelAt(f.x, f.y)
      const p = proj(sc, corner[0], corner[1], z)
      const q = proj(sc, (corner[0] + center[0]) / 2, (corner[1] + center[1]) / 2, z)
      draw(`${f.x},${f.y}`, s.isPath ? 'p' : 's1', `M${n0(p[0])} ${n0(p[1])}L${n0(q[0])} ${n0(q[1])}`)
    }
    for (const [p, q] of [[r[1], r[2]], [r[2], r[3]]] as const) {
      const steps = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1])
      const dx = Math.sign(q[0] - p[0])
      const dy = Math.sign(q[1] - p[1])
      for (let k = 0; k < steps; k++) {
        const u: Pt = [p[0] + dx * k, p[1] + dy * k]
        const v: Pt = [u[0] + dx, u[1] + dy]
        const key = u[0] < v[0] || (u[0] === v[0] && u[1] < v[1]) ? `${u}|${v}` : `${v}|${u}`
        const had = edges.get(key)
        edges.set(key, { u, v, n: (had?.n ?? 0) + 1, isPath: (had?.isPath ?? true) && s.isPath })
      }
    }
  }
  for (const { u, v, n, isPath } of edges.values()) {
    // The two plots the stretch runs between: it paints with the nearer, at the higher ground.
    const along = u[1] === v[1]
    const x = Math.min(u[0], v[0])
    const y = Math.min(u[1], v[1])
    const sides: Pt[] = along ? [[x, y - 1], [x, y]] : [[x - 1, y], [x, y]]
    const z = Math.max(levelAt(sides[0]![0], sides[0]![1]), levelAt(sides[1]![0], sides[1]![1]))
    const front = depth(sc, sides[0]![0] + 0.5, sides[0]![1] + 0.5) > depth(sc, sides[1]![0] + 0.5, sides[1]![1] + 0.5) ? sides[0]! : sides[1]!
    const p = proj(sc, u[0], u[1], z)
    const q = proj(sc, v[0], v[1], z)
    draw(`${front[0]},${front[1]}`, isPath ? 'p' : `s${Math.min(4, n)}`, `M${n0(p[0])} ${n0(p[1])}L${n0(q[0])} ${n0(q[1])}`)
  }
  const stone = sc.flat('#cbbfa7')
  const dirt = sc.flat('#a88a62')
  for (const [cell, styles] of lines) {
    const out: string[] = []
    for (const [style, ds] of styles) {
      const d = [...ds].join('')
      out.push(style === 'p'
        ? `<path d="${d}" stroke="${dirt}" stroke-width="${n1(sc.S * 0.07)}" stroke-dasharray="3 2" fill="none"/>`
        : `<path d="${d}" stroke="${stone}" stroke-width="${n1(sc.S * (0.12 + 0.04 * (Number(style.slice(1)) - 1)))}" stroke-linecap="round" fill="none"/>`)
    }
    marks.set(cell, out)
  }
  // A square under a file three or more others import.
  for (const [id, n] of imported) {
    const f = byId.get(id)
    if (f === undefined || n < 3) continue
    const [px, py] = proj(sc, f.x + 0.5, f.y + 0.5, levelAt(f.x, f.y))
    const name = f.key.replace(/^(file|read):/, '').split(/[\\/]/).pop() ?? ''
    const cell = `${f.x},${f.y}`
    marks.set(cell, [`<ellipse cx="${n1(px)}" cy="${n1(py)}" rx="${n1(sc.S * 0.62)}" ry="${n1(sc.S * 0.31)}" fill="${stone}"><title>${esc(`${name}: a square, imported by ${n} files on the island`)}</title></ellipse>`, ...(marks.get(cell) ?? [])])
  }
  return marks
}

/** The face of a block most turned to the eye, and the way along it. */
const faceToEye = (sc: Scene): { n: Pt; t: Pt } => {
  const n = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as Pt[]).sort((p, q) => (q[0] * sc.s + q[1] * sc.c) - (p[0] * sc.s + p[1] * sc.c))[0]!
  return { n, t: [-n[1], n[0]] }
}

/**
 * A building's kit of parts (world.ts kitsOf), drawn small: a spire on an
 * entry point, a clock face showing when it last changed, a dormer for each
 * file it imports, balconies for its reads, a bay window for wide lines, and
 * the folder's flag on its most worked building. Returns the new top.
 */
const kitParts = (
  sc: Scene, kit: Kit, f: Feature, cx: number, cy: number, a: number, z: number, hgt: number,
  roofTop: number, wall: string, accent: string, lit: boolean, out: string[],
): number => {
  if (detail < 2) return roofTop
  const u = sc.S
  const t = sc.tone
  let top = roofTop
  const { n: [nx, ny], t: [tx, ty] } = faceToEye(sc)
  const onFace = (along: number, up: number, out2 = 1.02): Pt => proj(sc, cx + nx * a * out2 + tx * along, cy + ny * a * out2 + ty * along, z + up)
  if (kit.spire === true) {
    const [bx, by] = proj(sc, cx, cy, roofTop - 0.2)
    const [, ay] = proj(sc, cx, cy, roofTop + 1.3)
    out.push(`<path d="M${n1(bx - u * 0.05)} ${n1(by)}L${n1(bx)} ${n1(ay)}L${n1(bx + u * 0.05)} ${n1(by)}Z" fill="${t(accent, 0.8)}"/><circle cx="${n1(bx)}" cy="${n1(ay)}" r="${n1(Math.max(0.8, u * 0.025))}" fill="#e3c26b"/>`)
    top = Math.max(top, roofTop + 1.4)
  }
  if (kit.clock !== undefined) {
    const [hr, mn] = kit.clock
    const [kx, ky] = onFace(a * 0.5, Math.max(0.25, hgt - 0.3))
    const r = Math.max(1.4, u * 0.065)
    const hand = (turn: number, len: number) => `M${n1(kx)} ${n1(ky)}l${n1(Math.sin(turn * Math.PI * 2) * len)} ${n1(-Math.cos(turn * Math.PI * 2) * len)}`
    out.push(`<circle cx="${n1(kx)}" cy="${n1(ky)}" r="${n1(r)}" fill="${t('#f4ecd8')}" stroke="${t('#3a3330')}" stroke-width=".6"/><path d="${hand((hr + mn / 60) / 12, r * 0.55)}${hand(mn / 60, r * 0.85)}" stroke="#222" stroke-width=".6"/>`)
  }
  if ((kit.dormers ?? 0) > 0) {
    let d = ''
    const w = Math.max(1.2, u * 0.05)
    for (let q = 0; q < kit.dormers!; q++) {
      const [px, py] = proj(sc, cx + (q - (kit.dormers! - 1) / 2) * a * 0.55, cy + a * 0.3, z + hgt + 0.3)
      d += `M${n1(px - w)} ${n1(py - w)}h${n1(w * 2)}v${n1(w * 2)}h${n1(-w * 2)}z`
    }
    out.push(`<path d="${d}" fill="${lit ? '#ffd77a' : t('#3d4b5c')}" stroke="${t(wall)}" stroke-width="1"/>`)
  }
  if ((kit.balconies ?? 0) > 0) {
    let d = ''
    for (let q = 0; q < kit.balconies!; q++) {
      const up = hgt - 0.55 * (q + 1)
      if (up < 0.4) break
      const p = onFace(-a * 0.4, up, 1.12)
      const r = onFace(a * 0.4, up, 1.12)
      d += `M${pt(p)}L${pt(r)}`
    }
    if (d !== '') out.push(`<path d="${d}" stroke="${t('#3a3a3a')}" stroke-width="${n1(Math.max(1, u * 0.04))}" fill="none"/>`)
  }
  if (kit.bay === true) {
    const lo = Math.min(hgt - 0.4, 0.55)
    out.push(shape([onFace(-a * 0.3, lo + 0.4, 1.15), onFace(a * 0.3, lo + 0.4, 1.15), onFace(a * 0.3, lo, 1.15), onFace(-a * 0.3, lo, 1.15)], lit ? '#ffd77a' : t(wall, 0.9), ` stroke="${t(accent)}" stroke-width=".8"`))
  }
  if (kit.flag === true) {
    const [sx, sy] = nearCorner(sc)
    const [fx, fy] = proj(sc, cx + sx * a, cy + sy * a, z + hgt)
    const [, fty] = proj(sc, cx + sx * a, cy + sy * a, z + hgt + 1.3)
    out.push(`<path d="M${n1(fx)} ${n1(fy)}V${n1(fty)}" stroke="${t('#5b4636')}" stroke-width=".8"/><rect x="${n1(fx)}" y="${n1(fty)}" width="${n1(u * 0.26)}" height="${n1(u * 0.15)}" fill="${hsl(hash(f.dir ?? '') % 360, 0.65, 0.5)}"/>`)
    top = Math.max(top, z + hgt + 1.4)
  }
  return top
}

/** A building at work this moment: its doorway lit, a pool of light before it. */
const doorway = (sc: Scene, cx: number, cy: number, a: number, z: number, out: string[]) => {
  if (detail < 1) return
  const { n: [nx, ny], t: [tx, ty] } = faceToEye(sc)
  const at = (along: number, up: number, o = 1.02): Pt => proj(sc, cx + nx * a * o + tx * along, cy + ny * a * o + ty * along, z + up)
  const [gx, gy] = proj(sc, cx + nx * (a + 0.25), cy + ny * (a + 0.25), z)
  out.push(`<ellipse cx="${n1(gx)}" cy="${n1(gy)}" rx="${n1(sc.S * 0.3)}" ry="${n1(sc.S * 0.14)}" fill="url(#hot)" opacity=".8"/>`)
  out.push(shape([at(-0.07, 0.42), at(0.07, 0.42), at(0.07, 0), at(-0.07, 0)], '#ffcf73', ' class="pl"'))
}

/**
 * Townsfolk carrying work between files worked one after the other (world.ts
 * walksOf): each walks the streets from one door to the other and back.
 */
const townsfolk = (sc: Scene, out: string[]) => {
  if (detail < 1) return
  const byId = new Map(sc.world.features.map(f => [f.id, f]))
  const levelAt = (x: number, y: number) => {
    let z = sc.sea
    for (const [dx, dy] of [[-0.02, -0.02], [0.02, -0.02], [-0.02, 0.02], [0.02, 0.02]]) {
      const i = Math.floor(x + dx)
      const j = Math.floor(y + dy)
      if (sc.island.inside(i, j)) z = Math.max(z, sc.island.level(i, j))
    }
    return z
  }
  const colors = ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#f79646', '#4bacc6']
  sc.walks.forEach((w, q) => {
    const a = byId.get(w.from)
    const b = byId.get(w.to)
    if (a === undefined || b === undefined) return
    const r = routeOf(a, b)
    const pts: Pt[] = [[(r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2], r[1], r[2], r[3], [(r[4][0] + r[3][0]) / 2, (r[4][1] + r[3][1]) / 2]]
    let length = 0
    for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1])
    if (length < 0.05) return
    const path = pts.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${pt(proj(sc, x, y, levelAt(x, y) + 0.15))}`).join('')
    const dur = ((length * 2) / 0.3).toFixed(1)
    out.push(`<circle r="${n1(Math.max(1.3, sc.S * 0.05))}" fill="${colors[(a.id * 7 + b.id) % colors.length]}" stroke="#fffaf0" stroke-width=".5"><animateMotion dur="${dur}s" begin="-${(q * 1.7).toFixed(1)}s" repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;.5;1" calcMode="linear" path="${path}"/></circle>`)
  })
}

/** Each district's paving, as world.ts districtsOf numbers them: flagstones, cobbles, brick, slate. */
const PAVE_PANE = ['#cbbfa6', '#a7a299', '#b0735c', '#7f8a94']

/**
 * The districts on the ground, gathered cell by cell like the streets: each
 * plot's paving; each stretch of wall or hedge, and the gate, with the plot
 * in front of its line; and the names, kept apart to float over everything.
 */
const districtMarks = (sc: Scene, districts: readonly District[]) => {
  const paving = new Map<string, number>()
  const marks = new Map<string, string[]>()
  const names: string[] = []
  const levelAt = (i: number, j: number) => (sc.island.inside(i, j) ? Math.max(sc.island.level(i, j), sc.sea) : sc.sea)
  // The line's two plots: it stands at the higher ground, and paints with the nearer.
  const lineOf = (e: readonly number[]) => {
    const x = Math.min(e[0]!, e[2]!)
    const y = Math.min(e[1]!, e[3]!)
    const sides: Pt[] = e[1] === e[3] ? [[x, y - 1], [x, y]] : [[x - 1, y], [x, y]]
    const z = Math.max(levelAt(sides[0]![0], sides[0]![1]), levelAt(sides[1]![0], sides[1]![1]))
    const front = depth(sc, sides[0]![0] + 0.5, sides[0]![1] + 0.5) > depth(sc, sides[1]![0] + 0.5, sides[1]![1] + 0.5) ? sides[0]! : sides[1]!
    return { z, cell: `${front[0]},${front[1]}` }
  }
  for (const d of districts) {
    for (const [x, y] of d.cells) paving.set(`${x},${y}`, d.pave)
    const isHedge = d.parent !== undefined
    const h = isHedge ? 0.35 : 0.45
    const sheets = new Map<string, { fill: string; top: string }>()
    if (detail >= 1) {
      for (const e of d.walls) {
        const { z, cell } = lineOf(e)
        const a = proj(sc, e[0], e[1], z)
        const b = proj(sc, e[2], e[3], z)
        const at = proj(sc, e[0], e[1], z + h)
        const bt = proj(sc, e[2], e[3], z + h)
        const had = sheets.get(cell) ?? { fill: '', top: '' }
        sheets.set(cell, { fill: had.fill + rel([a, b, bt, at], n1), top: `${had.top}M${pt(at)}L${pt(bt)}` })
      }
    }
    const wallColor = sc.tone(isHedge ? '#3e6e35' : '#9d9486', 0.82)
    const topColor = sc.tone(isHedge ? '#56994a' : '#cfc8bb')
    for (const [cell, s] of sheets) {
      marks.set(cell, [...(marks.get(cell) ?? []), `<path d="${s.fill}" fill="${wallColor}"/><path d="${s.top}" stroke="${topColor}" stroke-width="${n1(sc.S * (isHedge ? 0.09 : 0.05))}" stroke-linecap="round" fill="none"/>`])
    }
    const about = `${d.name}/ · ${d.parent !== undefined ? `a quarter of ${d.parent}/` : 'a district'} · ${d.files} files${d.lines > 0 ? `, ${d.lines.toLocaleString('en-US')} lines` : ''}`
    let label: Pt
    if (d.gate !== undefined) {
      const e = d.gate
      const { z, cell } = lineOf(e)
      const ex = (e[2] - e[0]) * 0.1
      const ey = (e[3] - e[1]) * 0.1
      const a = proj(sc, e[0] + ex, e[1] + ey, z)
      const b = proj(sc, e[2] - ex, e[3] - ey, z)
      const at = proj(sc, e[0] + ex, e[1] + ey, z + 0.75)
      const bt = proj(sc, e[2] - ex, e[3] - ey, z + 0.75)
      label = proj(sc, (e[0] + e[2]) / 2, (e[1] + e[3]) / 2, z + 1.15)
      if (detail >= 1) {
        const gate = `<path d="M${pt(a)}L${pt(at)}M${pt(b)}L${pt(bt)}M${pt(at)}L${pt(bt)}" stroke="${wallColor}" stroke-width="${n1(sc.S * 0.08)}" fill="none"/>`
        marks.set(cell, [...(marks.get(cell) ?? []), detail >= 2 ? `<g><title>${esc(about)}</title>${gate}</g>` : gate])
      }
    } else {
      const [cx, cy] = d.cells.reduce<Pt>((s, c) => [s[0] + c[0] + 0.5, s[1] + c[1] + 0.5], [0, 0]).map(v => v / d.cells.length) as Pt
      label = proj(sc, cx, cy, levelAt(d.cells[0]![0], d.cells[0]![1]) + 2.4)
    }
    names.push(`<text x="${n0(label[0])}" y="${n0(label[1])}" class="dn">${detail >= 2 ? `<title>${esc(about)}</title>` : ''}${esc(d.name)}/</text>`)
  }
  return { paving, marks, names }
}

/**
 * Rope bridges from each test's watchtower to what it tests, hung over the
 * town: planks along a sagging rope, a hand rope above in the last test
 * run's colors.
 */
const bridgeMarks = (sc: Scene, out: string[]) => {
  if (detail < 1) return
  const u = sc.S
  const byId = new Map(sc.world.features.map(f => [f.id, f]))
  for (const b of sc.bridges) {
    const A = sc.anchors.get(b.test)
    const B = sc.anchors.get(b.subject)
    const test = byId.get(b.test)
    const subject = byId.get(b.subject)
    if (b.isFar === true || A === undefined || B === undefined || test === undefined || subject === undefined) continue
    const len = Math.hypot(B[0] - A[0], B[1] - A[1])
    if (len < 0.05) continue
    const dx = (B[0] - A[0]) / len
    const dy = (B[1] - A[1]) / len
    const p = proj(sc, A[0] + dx * A[4], A[1] + dy * A[4], A[2] + A[3])
    const q = proj(sc, B[0] - dx * B[4], B[1] - dy * B[4], B[2] + Math.max(0.4, B[3] * 0.8))
    const c: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + u * (0.2 + 0.08 * len)]
    const lift = u * 0.16
    const deck = `M${pt(p)}Q${pt(c)} ${pt(q)}`
    const rope = `M${n1(p[0])} ${n1(p[1] - lift)}Q${n1(c[0])} ${n1(c[1] - lift)} ${n1(q[0])} ${n1(q[1] - lift)}`
    const name = (f: Feature) => f.key.replace(/^(file|read):/, '').split(/[\\/]/).pop() ?? ''
    const body = `<path d="${deck}" stroke="${sc.tone('#8a6a48')}" stroke-width="${n1(u * 0.09)}" stroke-dasharray="${n1(u * 0.035)} ${n1(u * 0.025)}" fill="none"/><path d="${rope}" stroke="${testFlag(sc.world, test)}" stroke-width="1" stroke-dasharray="2 1.5" fill="none"/>`
    out.push(detail >= 2 ? `<g class="f"><title>${esc(`A rope bridge: ${name(test)} tests ${name(subject)}`)}</title>${body}</g>` : body)
  }
}

const smoke = (x: number, y: number, u: number, count: number, out: string[], color = '#d9d4cf') => {
  for (let k = 0; k < count; k++) {
    out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${n1(u * 0.13)}" fill="${color}" class="sm" style="animation-delay:-${(k * 1.07).toFixed(2)}s"/>`)
  }
}

const flame = (x: number, y: number, u: number, out: string[]) => {
  out.push(`<circle cx="${n1(x)}" cy="${n1(y - u * 0.06)}" r="${n1(u * 0.22)}" fill="url(#glow)" class="pl"/>`)
  out.push(`<path d="M${n1(x - u * 0.07)} ${n1(y)}Q${n1(x)} ${n1(y - u * 0.3)} ${n1(x + u * 0.07)} ${n1(y)}Z" fill="#ff9a3c" class="fk"/>`)
}

const duration = (seconds: number) =>
  seconds < 90 ? `${Math.round(seconds)}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`

const tokenCount = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`)

const drawFeature = (sc: Scene, f: Feature, z: number, out: string[]) => {
  const cx = f.x + 0.5
  const cy = f.y + 0.5
  const [x, y] = proj(sc, cx, cy, z)
  const u = sc.S
  const t = sc.tone
  const size = Math.min(f.size, 9)
  const h = hash(f.key)
  const glow = glowOf(f.touchedAt, sc.now)
  const history = f.kind === 'house' ? [sc.tested.get(f.id) ?? '', historyText(f, sc.now)].filter(Boolean).join(' · ') : ''
  const label = `${f.label}${f.size > 1 ? ` (×${f.size})` : ''}${f.isScorched === true ? ' · scorched by an error' : ''}${history === '' ? '' : ` · ${history}`}`
  const hasTitle = detail > 1 || (detail === 1 && f.kind === 'house')
  out.push(`<g class="f">${hasTitle ? `<title>${esc(label)}</title>` : ''}`)
  if (f.isScorched === true) {
    out.push(`<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(u * 0.42)}" ry="${n1(u * 0.2)}" fill="#2b211c" opacity=".55"/>`)
  }
  if (glow > 0.05) {
    out.push(`<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(u * 0.6)}" ry="${n1(u * 0.3)}" fill="url(#hot)" opacity="${(glow * 0.9).toFixed(2)}"/>`)
  }
  let top = z + 1
  switch (f.kind) {
    case 'tree': {
      const count = size >= 5 ? 3 : size >= 3 ? 2 : 1
      for (let k = count - 1; k >= 0; k--) {
        const dx = k === 0 ? 0 : (k === 1 ? -0.22 : 0.24) * u
        const dy = k === 0 ? 0 : -0.08 * u * k
        const scale = (k === 0 ? 1 : 0.7) * (0.75 + 0.12 * Math.min(size, 6))
        const tx = x + dx
        const ty = y + dy
        const th = u * 1.1 * scale
        out.push(`<rect x="${n1(tx - u * 0.035)}" y="${n1(ty - th * 0.28)}" width="${n1(u * 0.07)}" height="${n1(th * 0.28)}" fill="${t('#6b4a2f')}"/>`)
        if ((h + k) % 3 !== 0) {
          for (let layer = 0; layer < 3; layer++) {
            const ly = ty - th * (0.22 + layer * 0.24)
            const w = u * 0.34 * scale * (1 - layer * 0.22)
            out.push(`<path d="M${n1(tx - w)} ${n1(ly)}L${n1(tx)} ${n1(ly - th * 0.36)}L${n1(tx + w)} ${n1(ly)}Z" fill="${t(layer === 1 ? '#3f8a4c' : '#2f6e3d')}"/>`)
          }
        } else {
          const leaf = hsl(80 + (h % 50), 0.45, 0.42)
          out.push(`<circle cx="${n1(tx)}" cy="${n1(ty - th * 0.55)}" r="${n1(u * 0.3 * scale)}" fill="${t(leaf)}"/>`)
          out.push(`<circle cx="${n1(tx - u * 0.08 * scale)}" cy="${n1(ty - th * 0.64)}" r="${n1(u * 0.16 * scale)}" fill="${t(leaf, 1.2)}"/>`)
        }
      }
      top = z + 2.4
      break
    }
    case 'house': {
      // Architecture by language, shape by the file itself (world.ts measure):
      // a floor for every doubling of its length, a footprint as wide as its
      // lines run, a wing for every few functions, a tower for each type, a
      // pennant for each export.
      const sh = f.shape
      const arch: Arch = f.arch ?? ARCH_OF_STYLE[f.style ?? 'code'] ?? 'townhouse'
      // A file left alone weathers: its roof fades toward lichen grey.
      const stage = weathering(f, sc.now)
      const aged = (c: string) => (stage > 0 ? mixHex(c, '#8f9384', 0.11 * stage) : c)
      const accent = aged(f.accent ?? hsl(f.hue, 0.55, 0.47))
      const look = PANE_LOOK[arch]
      const floors = Math.min(sh?.floors ?? size, 12)
      const wings = detail >= 1 ? Math.min(3, sh?.wings ?? 0) : 0
      const a = Math.min(sh?.footprint ?? 0.56, wings > 0 ? 0.56 : 0.7) / 2
      const fh = look.fh
      const hgt = arch === 'shed' ? 0.7 + floors * 0.2 : floors * fh
      const wall = arch === 'painted' ? t(accent, 1.45) : look.wall
      const lit = glow > 0.3
      const isCastle = arch === 'fort' || arch === 'keep'
      // A roof in the manner of its architecture over a block of half-width w at z0; k shrinks it for a wing.
      const roof = (px: number, py: number, w: number, z0: number, k: number, into: string[]): number => {
        switch (arch) {
          case 'cottage': case 'vault': case 'silo':
            dome(sc, px, py, w * 0.95, z0, accent, into)
            return z0 + 0.8 * k
          case 'fort': case 'keep':
            crenels(sc, px, py, w, z0, isCastle ? t(look.wall, 0.8) : accent, into)
            return z0 + 0.3
          case 'workshop':
            for (let q = 0; q < 3; q++) pyramid(sc, px - w + (q + 0.5) * (2 * w) / 3, py, w / 3, z0, z0 + 0.5 * k, q % 2 === 1 ? t(accent, 0.8) : accent, into)
            return z0 + 0.5 * k
          case 'shed': {
            const back = proj(sc, px - w, py - w, z0 + 0.45 * k)
            const back2 = proj(sc, px + w, py - w, z0 + 0.45 * k)
            const front = proj(sc, px + w, py + w + 0.05, z0)
            const front2 = proj(sc, px - w, py + w + 0.05, z0)
            into.push(shape([back, back2, front, front2], t(accent)))
            return z0 + 0.45 * k
          }
          case 'library':
            pyramid(sc, px, py, w + 0.05, z0, z0 + 1.5 * k, accent, into)
            return z0 + 1.5 * k
          case 'pavilion':
            pyramid(sc, px, py, w + 0.07, z0, z0 + k, accent, into, '#fbf3e6')
            return z0 + k
          case 'painted':
            pyramid(sc, px, py, w + 0.06, z0, z0 + 0.9 * k, aged('#8c5a44'), into)
            return z0 + 0.9 * k
          default:
            pyramid(sc, px, py, w + 0.06, z0, z0 + 0.9 * k, accent, into)
            return z0 + 0.9 * k
        }
      }
      if (arch === 'watchtower') {
        const tw = Math.min(a, 0.25) * 0.75
        const th = floors * fh + 0.6
        crane(sc, cx, cy, z, z + th + 0.6, sh?.todos ?? 0, out)
        box(sc, cx, cy, tw, tw, z, z + th, look.wall, '#8e8981', out)
        sc.anchors.set(f.id, [cx, cy, z, th, tw])
        editBands(sc, cx, cy, tw, z, th, f.edits ?? [], look.wall, out)
        patches(sc, cx, cy, tw, z, th, f.scars ?? 0, look.wall, out)
        windows(sc, cx, cy, tw, z, floors, fh, out, lit, sh)
        overgrowth(sc, cx, cy, tw, z, th, stage, out)
        const [px, py] = proj(sc, cx, cy, z + th)
        out.push(`<line x1="${n1(px)}" y1="${n1(py)}" x2="${n1(px)}" y2="${n1(py - u * 0.55)}" stroke="${t('#5b5650')}" stroke-width="1"/>`)
        out.push(`<path d="M${n1(px)} ${n1(py - u * 0.55)}l${n1(u * 0.28)} ${n1(u * 0.08)}l${n1(-u * 0.28)} ${n1(u * 0.09)}Z" fill="${testFlag(sc.world, f)}"/>`)
        top = z + th + 1
      } else {
        // The body, its wings and its towers, painted back to front.
        const body = arch === 'library' ? a * 0.75 : a
        sc.anchors.set(f.id, [cx, cy, z, hgt, body])
        const parts: { d: number; draw: (into: string[]) => void }[] = []
        let roofTop = z + hgt
        parts.push({
          d: depth(sc, cx, cy),
          draw: into => {
            box(sc, cx, cy, body, body, z, z + hgt, wall, arch === 'fort' || arch === 'keep' ? t(look.wall, 0.85) : undefined, into)
            editBands(sc, cx, cy, body, z, hgt, f.edits ?? [], wall, into)
            patches(sc, cx, cy, body, z, hgt, f.scars ?? 0, wall, into)
            windows(sc, cx, cy, body, z, arch === 'shed' ? 1 : floors, arch === 'shed' ? hgt : fh, into, lit, sh)
            roofTop = roof(cx, cy, body, z + hgt, 1, into)
            overgrowth(sc, cx, cy, body, z, hgt, stage, into)
            if (arch === 'painted' && detail >= 2) {
              const [ax, ay] = proj(sc, cx, cy + body + 0.04, z + 0.45)
              into.push(`<path d="M${n1(ax - u * 0.14)} ${n1(ay)}h${n1(u * 0.28)}l${n1(u * 0.03)} ${n1(u * 0.07)}h${n1(-u * 0.34)}Z" fill="${accent}" stroke="#fffaf0" stroke-width=".8" stroke-dasharray="2 2"/>`)
            }
          },
        })
        const wingH = Math.max(fh, hgt * 0.55)
        const spots: [number, number, number, number][] = [[body + 0.065, 0, 0.065, body * 0.6], [-(body + 0.065), 0, 0.065, body * 0.6], [0, -(body + 0.065), body * 0.6, 0.065]]
        for (let q = 0; q < wings; q++) {
          const [ox, oy, ax, ay] = spots[q]!
          parts.push({
            d: depth(sc, cx + ox, cy + oy),
            draw: into => {
              box(sc, cx + ox, cy + oy, ax, ay, z, z + wingH, t(wall, 0.94), isCastle ? t(look.wall, 0.85) : undefined, into)
              if (isCastle) crenels(sc, cx + ox, cy + oy, Math.min(ax, ay), z + wingH, t(look.wall, 0.8), into)
              else pyramid(sc, cx + ox, cy + oy, Math.max(ax, ay) * 0.75, z + wingH, z + wingH + 0.5, accent, into)
            },
          })
        }
        const towers = detail >= 1 ? Math.min(3, sh?.towers ?? 0) : 0
        const corners: Pt[] = [[-1, -1], [1, -1], [-1, 1]]
        for (let q = 0; q < towers; q++) {
          const [sx, sy] = corners[q]!
          const tx = cx + sx * (body - 0.03)
          const ty = cy + sy * (body - 0.03)
          const th = z + hgt + fh * 1.3
          parts.push({
            d: depth(sc, tx, ty) + 0.01,
            draw: into => {
              box(sc, tx, ty, 0.07, 0.07, z, th, t(wall, 0.9), isCastle ? t(look.wall, 0.8) : undefined, into)
              if (!isCastle) pyramid(sc, tx, ty, 0.1, th, th + 0.7, accent, into)
              roofTop = Math.max(roofTop, th + (isCastle ? 0.1 : 0.7))
            },
          })
        }
        // A crane for its TODOs stands behind it, so it goes first.
        crane(sc, cx, cy, z, z + hgt + (arch === 'library' ? 1.5 : 0.9), sh?.todos ?? 0, out)
        parts.sort((p, q) => p.d - q.d).forEach(p => p.draw(out))
        // Pennants: one for each thing it exports, flown from the roof.
        const pennants = detail >= 2 ? Math.min(4, sh?.pennants ?? 0) : 0
        for (let q = 0; q < pennants; q++) {
          const [px, py] = proj(sc, cx + (q - (pennants - 1) / 2) * body * 0.5, cy, z + hgt + (arch === 'library' ? 1.2 : 0.6))
          out.push(`<path d="M${n1(px)} ${n1(py)}v${n1(-u * 0.32)}l${n1(u * 0.16)} ${n1(u * 0.05)}l${n1(-u * 0.16)} ${n1(u * 0.05)}" fill="${q % 2 === 1 ? '#fffaf0' : accent}" stroke="${t('#5b4636')}" stroke-width=".6"/>`)
        }
        top = Math.max(roofTop, z + hgt + 0.6 + (pennants > 0 ? 0.9 : 0)) + 0.3
        const kit = sc.kits[f.id]
        if (kit !== undefined) top = Math.max(top, kitParts(sc, kit, f, cx, cy, body, z, hgt, roofTop, wall, accent, lit, out))
        if (sc.busy.has(f.id)) doorway(sc, cx, cy, body, z, out)
      }
      if (glow > 0.05) {
        const [hx, hy] = proj(sc, cx, cy, (z + top) / 2)
        out.push(`<circle cx="${n1(hx)}" cy="${n1(hy)}" r="${n1(u * 0.9)}" fill="url(#hot)" opacity="${(glow * 0.75).toFixed(2)}" class="pl" style="mix-blend-mode:screen"/>`)
      }
      if (isDirty(sc.world, f)) scaffold(sc, cx, cy, 0.36, z, top - 0.6, out)
      if (f.isScorched === true) {
        const [fx, fy] = proj(sc, cx, cy, top)
        smoke(fx, fy, u, 2, out, '#555')
      }
      break
    }
    case 'treasury': {
      box(sc, cx, cy, 0.34, 0.3, z, z + 0.9, '#d8cba8', undefined, out)
      dome(sc, cx, cy, 0.3, z + 0.9, '#e3c26b', out)
      const coins = Math.min(12, Math.round(Math.log2((sc.world.cost ?? 0) * 10 + 1) * 2))
      for (let k = 0; k < coins; k++) {
        const [kx, ky] = proj(sc, cx + 0.42 + (k % 3) * 0.08, cy + 0.3, z)
        out.push(`<ellipse cx="${n1(kx)}" cy="${n1(ky - Math.floor(k / 3) * u * 0.06)}" rx="${n1(Math.max(1.4, u * 0.07))}" ry="${n1(Math.max(0.8, u * 0.035))}" fill="#f2c94c" stroke="#a87b1a" stroke-width=".5"/>`)
      }
      top = z + 2
      break
    }
    case 'forge': {
      box(sc, cx, cy, 0.32, 0.28, z, z + 0.9, '#776d64', '#5e554e', out)
      const chimney = 1.4 + Math.min(size, 6) * 0.25
      box(sc, cx + 0.16, cy - 0.12, 0.07, 0.07, z + 0.9, z + chimney, '#5a514a', '#3a332e', out)
      const [sx, sy] = proj(sc, cx + 0.16, cy - 0.12, z + chimney)
      smoke(sx, sy, u, detail >= 3 ? Math.min(1 + Math.floor(size / 3), 3) : 1, out, f.isScorched === true ? '#4a4440' : '#d9d4cf')
      const [dx, dy] = proj(sc, cx, cy, z + 0.25)
      const gpu = sc.world.system?.gpu
      out.push(`<circle cx="${n1(dx)}" cy="${n1(dy)}" r="${n1(u * (0.2 + (gpu?.load ?? 0.3) * 0.3))}" fill="url(#glow)" opacity="${(0.55 + (gpu?.load ?? 0.3) * 0.45).toFixed(2)}" class="fk"/>`)
      if ((gpu?.temp ?? 0) > 60 && detail >= 2) out.push(`<path d="M${n1(sx - u * 0.1)} ${n1(sy - u * 0.2)}q${n1(u * 0.1)} ${n1(-u * 0.15)} 0 ${n1(-u * 0.3)}t0 ${n1(-u * 0.3)}" fill="none" stroke="#ffd0a0" stroke-opacity=".5" class="hz"><title>Heat haze: the GPU runs at ${Math.round(gpu?.temp ?? 0)}°C</title></path>`)
      if (f.isScorched === true) flame(dx + u * 0.2, dy - u * 0.35, u, out)
      top = z + chimney
      break
    }
    case 'beacon': {
      const tp = z + 1.5 + Math.min(size, 6) * 0.25
      box(sc, cx, cy, 0.1, 0.1, z, tp, '#d8d2c4', '#bfb8aa', out)
      const [bx, by] = proj(sc, cx, cy, tp)
      out.push(`<circle cx="${n1(bx)}" cy="${n1(by - u * 0.12)}" r="${n1(u * (0.45 + size * 0.05))}" fill="url(#beam)" class="pl"/>`)
      out.push(`<circle cx="${n1(bx)}" cy="${n1(by - u * 0.12)}" r="${n1(u * 0.09)}" fill="#fff6d8"/>`)
      top = tp + 0.3
      break
    }
    case 'windmill': {
      box(sc, cx, cy, 0.2, 0.2, z, z + 1.7, '#efe7da', undefined, out)
      pyramid(sc, cx, cy, 0.25, z + 1.7, z + 2.4, '#9b5d45', out)
      const [hx, hy] = proj(sc, cx, cy, z + 1.75)
      const L = u * 0.75
      const blades = [0, 90, 180, 270]
        .map(a => `<path d="M${n1(hx)} ${n1(hy)}l${n1(L)} ${n1(-u * 0.06)}l0 ${n1(u * 0.16)}Z" fill="${t('#f6f1e8')}" transform="rotate(${a} ${n1(hx)} ${n1(hy)})"/>`)
        .join('')
      const dur = Math.max(1.2, 6 - size * 0.6 - sc.world.mood.haste * 3).toFixed(1)
      out.push(`<g>${blades}<animateTransform attributeName="transform" type="rotate" from="0 ${n1(hx)} ${n1(hy)}" to="360 ${n1(hx)} ${n1(hy)}" dur="${dur}s" repeatCount="indefinite"/></g>`)
      out.push(`<circle cx="${n1(hx)}" cy="${n1(hy)}" r="${n1(u * 0.06)}" fill="${t('#5a3b2e')}"/>`)
      top = z + 2.4
      break
    }
    case 'camp': {
      // A nest of its agent type: woven twigs, a lining in the type's color,
      // and an empty eggshell for every spawnling that hatched here.
      const hue = broodHue(f.key.replace(/^camp:/, ''))
      out.push(`<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(u * 0.36)}" ry="${n1(u * 0.18)}" fill="${t('#4a3220')}" stroke="${t('#8a6a43')}" stroke-width="${n1(u * 0.06)}" stroke-dasharray="${n1(u * 0.09)} ${n1(u * 0.04)}"/>`)
      out.push(`<ellipse cx="${n1(x)}" cy="${n1(y - u * 0.02)}" rx="${n1(u * 0.24)}" ry="${n1(u * 0.11)}" fill="${t(hsl(hue, 0.3, 0.7))}"/>`)
      const shells = Math.min(size, detail >= 2 ? 8 : 3)
      for (let k = 0; k < shells; k++) {
        const a = k * 2.39996
        const r = k < 4 ? 0.06 + k * 0.04 : 0.44 + (k % 2) * 0.06
        const ex = x + Math.cos(a) * r * u
        const ey = y + Math.sin(a) * r * u * 0.5 - (k < 4 ? u * 0.04 : 0)
        out.push(`<path d="M${n1(ex - u * 0.06)} ${n1(ey)}a${n1(u * 0.06)} ${n1(u * 0.05)} 0 0 0 ${n1(u * 0.12)} 0l${n1(-u * 0.03)} ${n1(-u * 0.02)}l${n1(-u * 0.03)} ${n1(u * 0.015)}l${n1(-u * 0.03)} ${n1(-u * 0.02)}z" fill="${t(hsl(hue, 0.25, 0.9))}"/>`)
      }
      top = z + 0.8
      break
    }
    case 'crystal': {
      const color = hsl(f.hue, 0.75, 0.68)
      const shards: [number, number, number][] = [[-0.16, 0.8, -12], [0.14, 0.62, 14], [0, 1.1, 0]]
      out.push(`<circle cx="${n1(x)}" cy="${n1(y - u * 0.4)}" r="${n1(u * 0.6)}" fill="url(#glow2)" class="pl"/>`)
      for (const [dx, hgt, tilt] of shards.slice(0, Math.min(3, 1 + Math.floor(size / 2)))) {
        const hh = u * hgt * (0.8 + Math.min(size, 6) * 0.1)
        const bx = x + dx * u
        out.push(`<path d="M${n1(bx - u * 0.08)} ${n1(y)}L${n1(bx - u * 0.09)} ${n1(y - hh * 0.75)}L${n1(bx)} ${n1(y - hh)}L${n1(bx + u * 0.09)} ${n1(y - hh * 0.75)}L${n1(bx + u * 0.08)} ${n1(y)}Z" fill="${color}" fill-opacity="${(0.45 + (sc.world.system?.gpu?.mem ?? 0.4) * 0.55).toFixed(2)}" stroke="#fff" stroke-opacity=".5" stroke-width=".6" transform="rotate(${tilt} ${n1(bx)} ${n1(y)})"/>`)
      }
      top = z + 2.2
      break
    }
    case 'shrine': {
      out.push(`<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(u * 0.4)}" ry="${n1(u * 0.19)}" fill="none" stroke="#c9a0ff" stroke-width="1.2" class="pl"/>`)
      box(sc, cx, cy, 0.12, 0.12, z, z + 1.5 + size * 0.1, '#4b4560', undefined, out)
      pyramid(sc, cx, cy, 0.12, z + 1.5 + size * 0.1, z + 1.9 + size * 0.1, '#e3c26b', out)
      const [rx, ry] = proj(sc, cx, cy, z + 1.0)
      out.push(`<circle cx="${n1(rx)}" cy="${n1(ry)}" r="${n1(u * 0.05)}" fill="#d9b8ff" class="pl"/>`)
      top = z + 2 + size * 0.1
      break
    }
    case 'signpost': {
      out.push(`<line x1="${n1(x)}" y1="${n1(y)}" x2="${n1(x)}" y2="${n1(y - u * 0.8)}" stroke="${t('#6b4a2f')}" stroke-width="${n1(u * 0.05)}"/>`)
      out.push(`<path d="M${n1(x)} ${n1(y - u * 0.75)}h${n1(u * 0.36)}l${n1(u * 0.08)} ${n1(u * 0.06)}l${n1(-u * 0.08)} ${n1(u * 0.06)}h${n1(-u * 0.36)}Z" fill="${t('#c89b62')}"/>`)
      out.push(`<path d="M${n1(x)} ${n1(y - u * 0.52)}h${n1(-u * 0.32)}l${n1(-u * 0.08)} ${n1(u * 0.06)}l${n1(u * 0.08)} ${n1(u * 0.06)}h${n1(u * 0.32)}Z" fill="${t('#b98a55')}"/>`)
      top = z + 1.8
      break
    }
    case 'banner': {
      const tp = y - u * (1.2 + Math.min(size, 6) * 0.08)
      const w = u * 0.5
      const dur = Math.max(0.6, 2.2 - sc.world.mood.haste * 1.4).toFixed(1)
      out.push(`<line x1="${n1(x)}" y1="${n1(y)}" x2="${n1(x)}" y2="${n1(tp)}" stroke="${t('#5b4636')}" stroke-width="1.4"/>`)
      const a = `M${n1(x)} ${n1(tp)}Q${n1(x + w * 0.5)} ${n1(tp - u * 0.08)} ${n1(x + w)} ${n1(tp + u * 0.02)}L${n1(x + w)} ${n1(tp + u * 0.3)}Q${n1(x + w * 0.5)} ${n1(tp + u * 0.22)} ${n1(x)} ${n1(tp + u * 0.3)}Z`
      const b = `M${n1(x)} ${n1(tp)}Q${n1(x + w * 0.5)} ${n1(tp + u * 0.1)} ${n1(x + w)} ${n1(tp - u * 0.02)}L${n1(x + w)} ${n1(tp + u * 0.26)}Q${n1(x + w * 0.5)} ${n1(tp + u * 0.38)} ${n1(x)} ${n1(tp + u * 0.3)}Z`
      out.push(`<path d="${a}" fill="${t('#d97757')}"><animate attributeName="d" values="${a};${b};${a}" dur="${dur}s" repeatCount="indefinite"/></path>`)
      top = z + 3
      break
    }
    case 'cairn': {
      const stones = Math.min(2 + size, 6)
      for (let k = 0; k < stones; k++) {
        const w = u * (0.24 - k * 0.025)
        out.push(`<ellipse cx="${n1(x + ((h >> k) % 3 - 1) * u * 0.02)}" cy="${n1(y - u * 0.08 - k * u * 0.13)}" rx="${n1(w)}" ry="${n1(w * 0.55)}" fill="${t(k % 2 === 0 ? '#9a958c' : '#b4afa6')}"/>`)
      }
      top = z + 1.4
      break
    }
    case 'monolith': {
      box(sc, cx, cy, 0.1, 0.28, z, z + 2.8, '#2b2b36', '#3a3a48', out)
      const [mx, my] = proj(sc, cx, cy, z + 1.6)
      out.push(`<circle cx="${n1(mx)}" cy="${n1(my)}" r="${n1(u * 0.5)}" fill="url(#glow2)" class="pl"/>`)
      top = z + 2.8
      break
    }
  }
  sc.tops.set(f.id, proj(sc, cx, cy, top))
  out.push('</g>')
}

/** Watchtowers fly the last test run's colors; before any run, their own scorch decides. */
const testFlag = (world: World, f: Feature) => {
  const tests = world.tests
  if (tests !== undefined) return tests.failed > 0 ? '#d9534f' : '#5cb85c'
  return f.isScorched === true ? '#d9534f' : '#5cb85c'
}

/** Scaffolding around a building whose file git has not yet seen committed. */
const scaffold = (sc: Scene, cx: number, cy: number, a: number, z0: number, z1: number, out: string[]) => {
  const corners: Pt[] = [[cx - a, cy - a], [cx + a, cy - a], [cx + a, cy + a], [cx - a, cy + a]]
  const near = corners.map(([x, y]) => ({ x, y, d: depth(sc, x, y) })).sort((p, q) => q.d - p.d).slice(0, 3)
  const parts: string[] = []
  for (const c of near) {
    const [bx, by] = proj(sc, c.x, c.y, z0)
    const [tx, ty] = proj(sc, c.x, c.y, z1)
    parts.push(`M${n0(bx)} ${n0(by)}L${n0(tx)} ${n0(ty)}`)
  }
  for (let level = z0 + 0.5; level < z1; level += 0.7) {
    const pts = near.map(c => proj(sc, c.x, c.y, level))
    parts.push(`M${pts.map(([x, y]) => `${n0(x)} ${n0(y)}`).join('L')}`)
  }
  out.push(`<path d="${parts.join('')}" fill="none" stroke="${sc.tone('#b5895a')}" stroke-width="1.1"><title>Uncommitted: git has not seen this file committed</title></path>`)
}

// ---------------------------------------------------------------- the wild

/** Wild growth: drawn once in <defs> at this drawing's scale, then placed by <use>. */
const decorDefs = (sc: Scene): string => {
  const u = sc.S
  const t = sc.tone
  const p = (pts: Pt[], fill: string) => `<path d="${rel(pts, n1)}" fill="${fill}"/>`
  const conifer = (id: string, snow: boolean) => {
    const th = u * 1.05
    const layers = [0, 1, 2].map(layer => {
      const ly = -th * (0.2 + layer * 0.25)
      const w = u * 0.3 * (1 - layer * 0.24)
      return p([[-w, ly], [0, ly - th * 0.36], [w, ly]], t(snow && layer === 2 ? '#eef3f6' : layer === 1 ? '#3b7f46' : '#2c6638'))
    })
    return `<g id="${id}"><rect x="${n1(-u * 0.03)}" y="${n1(-th * 0.25)}" width="${n1(u * 0.06)}" height="${n1(th * 0.25)}" fill="${t('#5b3d27')}"/>${layers.join('')}</g>`
  }
  const round = (id: string, leaf: string, trunk = '#6b4a2f', tall = 1) =>
    `<g id="${id}"><rect x="${n1(-u * 0.035)}" y="${n1(-u * 0.4 * tall)}" width="${n1(u * 0.07)}" height="${n1(u * 0.4 * tall)}" fill="${t(trunk)}"/><circle cy="${n1(-u * 0.62 * tall)}" r="${n1(u * 0.3)}" fill="${t(leaf)}"/><circle cx="${n1(-u * 0.09)}" cy="${n1(-u * 0.72 * tall)}" r="${n1(u * 0.15)}" fill="${t(leaf, 1.2)}"/></g>`
  return [
    conifer('dp', false),
    conifer('ds', true),
    round('do', '#5a9e3e'),
    round('da', '#d9822b'),
    round('db', '#9cc95d', '#efeae0', 1.3),
    `<g id="dh"><ellipse rx="${n1(u * 0.24)}" ry="${n1(u * 0.15)}" cy="${n1(-u * 0.1)}" fill="${t('#4f8a3a')}"/><circle cx="${n1(u * 0.06)}" cy="${n1(-u * 0.14)}" r="${n1(u * 0.04)}" fill="${t('#d6455b')}"/></g>`,
    `<g id="dr"><ellipse rx="${n1(u * 0.22)}" ry="${n1(u * 0.13)}" cy="${n1(-u * 0.06)}" fill="${t('#8d877e')}"/><ellipse cx="${n1(-u * 0.05)}" cy="${n1(-u * 0.1)}" rx="${n1(u * 0.1)}" ry="${n1(u * 0.05)}" fill="${t('#a8a399')}"/></g>`,
    `<g id="df">${[[-0.12, '#f4d35e'], [0.02, '#ee6c8b'], [0.13, '#ffffff'], [-0.04, '#b28cff']].map(([dx, c], k) => `<circle cx="${n1(u * Number(dx))}" cy="${n1(-u * (0.06 + (k % 2) * 0.05))}" r="${n1(Math.max(1, u * 0.045))}" fill="${t(String(c))}"/>`).join('')}</g>`,
    `<g id="dq" stroke="${t('#7f9a52')}" stroke-width="${n1(Math.max(0.8, u * 0.03))}">${[-0.12, -0.04, 0.05, 0.13].map((dx, k) => `<line x1="${n1(u * dx)}" x2="${n1(u * (dx + 0.03))}" y2="${n1(-u * (0.38 + (k % 2) * 0.12))}"/>`).join('')}</g>`,
    `<g id="dm"><path d="M0 0q${n1(u * 0.05)} ${n1(-u * 0.6)} ${n1(u * 0.16)} ${n1(-u * 0.9)}" stroke="${t('#8a6a45')}" stroke-width="${n1(u * 0.06)}" fill="none"/>${[-60, -20, 20, 60, 100].map(a => `<path d="M${n1(u * 0.16)} ${n1(-u * 0.9)}l${n1(Math.cos((a * Math.PI) / 180 - 1.2) * u * 0.42)} ${n1(Math.sin((a * Math.PI) / 180 - 1.2) * u * 0.42 + u * 0.18)}" stroke="${t('#4f9a3c')}" stroke-width="${n1(u * 0.07)}" stroke-linecap="round"/>`).join('')}</g>`,
    `<g id="du"><rect x="${n1(-u * 0.025)}" y="${n1(-u * 0.12)}" width="${n1(u * 0.05)}" height="${n1(u * 0.12)}" fill="${t('#f1e9da')}"/><ellipse cy="${n1(-u * 0.13)}" rx="${n1(u * 0.09)}" ry="${n1(u * 0.06)}" fill="${t('#d8342c')}"/></g>`,
  ].join('')
}

const DECOR_ID: Record<number, string> = {
  [DECOR.pine]: 'dp',
  [DECOR.snowpine]: 'ds',
  [DECOR.oak]: 'do',
  [DECOR.birch]: 'db',
  [DECOR.bush]: 'dh',
  [DECOR.rock]: 'dr',
  [DECOR.flowers]: 'df',
  [DECOR.reeds]: 'dq',
  [DECOR.palm]: 'dm',
  [DECOR.mushroom]: 'du',
}

// ---------------------------------------------------------------- the disc and the turtle

// As the 3D window draws them (viewer/engine.js): the island a disc of rock
// whose sea spills over the rim, on the back of a turtle swimming through
// space. Heights in levels. On the page it always swims toward the left, a
// little toward you, so its head shows beside the disc.
const LH = 0.42
const turtleOf = (sc: Scene) => {
  const Rs = sc.island.seaRadius
  const fx = -sc.c + 0.5 * sc.s
  const fy = sc.s + 0.5 * sc.c
  const k = Math.hypot(fx, fy)
  const foot = BOTTOM - 0.55 / LH
  const top = foot - (Rs * 0.105) / LH
  const H = (Rs * 0.3) / LH
  return { Rs, f: [fx / k, fy / k] as Pt, r: [fy / k, -fx / k] as Pt, L: Rs * 0.74, W: Rs * 0.64, H, top, base: top - H, foot, sag: (Rs * 0.12) / LH }
}
type Turtle = ReturnType<typeof turtleOf>
// A point in the turtle's frame (a along it, b to its right, z in levels), on the page.
const onTurtle = (sc: Scene, t: Turtle, a: number, b: number, z: number): Pt =>
  proj(sc, t.f[0] * a + t.r[0] * b, t.f[1] * a + t.r[1] * b, z)
const turtleDepth = (sc: Scene, t: Turtle, a: number, b: number) => depth(sc, t.f[0] * a + t.r[0] * b, t.f[1] * a + t.r[1] * b)

/** What the turtle is doing, by the data: its words, and how its flippers beat (seconds a stroke, 0 for still). */
const turtleState = (world: World, now: number) => {
  const b = world.beast
  const isDone = b === undefined || b.doneAt !== undefined
  const act = world.activity?.kind
  if (world.awaySince !== undefined) return { text: 'asleep in its shell', beat: 0, fold: true, isIn: true, isUp: false }
  if (world.waiting !== undefined && !isDone) return { text: 'watching you', beat: 6, fold: false, isIn: false, isUp: true }
  if (!isDone && (act === 'writing' || act === 'thinking')) return { text: 'swimming hard', beat: 1.8, fold: false, isIn: false, isUp: false }
  if (!isDone) return { text: 'paddling while tools run', beat: 3.6, fold: false, isIn: false, isUp: false }
  if (b !== undefined && b.doneAt !== undefined && now - b.doneAt < 60000) return { text: 'gliding', beat: 0, fold: false, isIn: false, isUp: false }
  return { text: 'drifting, flippers folded', beat: 0, fold: true, isIn: false, isUp: false }
}

/** Space dust streaming past, as fast as the turtle swims. */
const dustLayer = (sc: Scene, t: Turtle, beat: number, out: string[]) => {
  if (detail < 2) return
  const [x0, y0] = proj(sc, 0, 0, 0)
  const [x1, y1] = proj(sc, -t.f[0] * 60, -t.f[1] * 60, 0)
  const dur = beat > 0 ? beat * 4 : 22
  let d = ''
  for (let k = 0; k < 18; k++) {
    const x = rand2(k, 61, sc.world.seed) * WIDTH * 1.4 - WIDTH * 0.2
    const y = rand2(k, 62, sc.world.seed) * HEIGHT
    d += `M${n0(x)} ${n0(y)}l${n1((x0 - x1) * 0.012)} ${n1((y0 - y1) * 0.012)}`
  }
  out.push(`<path d="${d}" stroke="#c9d6ff" stroke-opacity=".45" stroke-linecap="round"><animateTransform attributeName="transform" type="translate" values="0 0;${n0(x1 - x0)} ${n0(y1 - y0)}" dur="${dur}s" repeatCount="indefinite"/></path>`)
}

/** The turtle under the disc: its far limbs, its shell, its near limbs and head. */
const turtleLayer = (sc: Scene, out: string[]) => {
  const w = sc.world
  const t = turtleOf(sc)
  const st = turtleState(w, sc.now)
  const hours = w.startedAt !== undefined ? Math.max(0, (sc.now - w.startedAt) / 3.6e6) : 0
  const age = Math.min(1, hours / 8)
  const label = esc(`The turtle carries the conversation: ${st.text}${w.startedAt !== undefined ? ` · out ${duration(hours * 3600)} (its shell weathers with the session)` : ''}${w.compactions > 0 ? ` · ${w.compactions} ${w.compactions === 1 ? 'compaction' : 'compactions'} (a growth ring each)` : ''}`)
  dustLayer(sc, t, st.beat, out)
  const hide = '#7f8a5f'
  const hideDark = '#5a6346'
  // Flippers: an ellipse from the shoulder, beating about it while it swims, laid back along the shell when folded.
  const limb = (a: number, b: number, side: number, len: number, wid: number, sweep: number, phase: number) => {
    const sw = st.fold ? -1.2 : sweep
    const dir: Pt = [t.r[0] * side * Math.cos(sw) + t.f[0] * Math.sin(sw), t.r[1] * side * Math.cos(sw) + t.f[1] * Math.sin(sw)]
    const ox = t.f[0] * a + t.r[0] * b
    const oy = t.f[1] * a + t.r[1] * b
    const z = t.base + t.H * 0.1
    const [sx, sy] = proj(sc, ox, oy, z)
    const [ex, ey] = proj(sc, ox + dir[0] * len, oy + dir[1] * len, z - 0.6)
    const ang = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI
    const rx = Math.hypot(ex - sx, ey - sy) / 2
    const beat = st.beat > 0 ? `<animateTransform attributeName="transform" type="rotate" values="-14 ${n0(sx)} ${n0(sy)};14 ${n0(sx)} ${n0(sy)};-14 ${n0(sx)} ${n0(sy)}" dur="${st.beat}s" begin="-${(phase * st.beat).toFixed(1)}s" repeatCount="indefinite"/>` : ''
    return { d: depth(sc, ox, oy), svg: `<g>${beat}<ellipse cx="${n1((sx + ex) / 2)}" cy="${n1((sy + ey) / 2)}" rx="${n1(rx)}" ry="${n1(wid * sc.S * 0.5)}" transform="rotate(${n0(ang)} ${n1((sx + ex) / 2)} ${n1((sy + ey) / 2)})" fill="${hide}" stroke="${hideDark}" stroke-width="1"/></g>` }
  }
  const limbs = [
    limb(t.L * 0.52, t.W * 0.8, 1, t.Rs * 0.62, t.Rs * 0.2, 0.25, 0),
    limb(t.L * 0.52, -t.W * 0.8, -1, t.Rs * 0.62, t.Rs * 0.2, 0.25, 0),
    limb(-t.L * 0.62, t.W * 0.62, 1, t.Rs * 0.36, t.Rs * 0.15, -0.5, 0.3),
    limb(-t.L * 0.62, -t.W * 0.62, -1, t.Rs * 0.36, t.Rs * 0.15, -0.5, 0.3),
  ]
  // The head, out on its neck (raised to look at you when you are waited on), or drawn in.
  const reach = st.isIn ? 0.02 : 0.3
  const lift = st.isUp ? 1.6 : 0
  const [nx, ny] = onTurtle(sc, t, t.L * 0.86, 0, t.base + t.H * 0.22)
  const [hx, hy] = onTurtle(sc, t, t.L * 0.86 + t.Rs * reach, 0, t.base + t.H * 0.22 + lift)
  const hr = t.Rs * 0.13 * sc.S
  const eye = (k: number) => {
    const ex = hx + k * hr * 0.55
    const ey = hy - hr * 0.2
    return st.isIn ? `<path d="M${n1(ex - 2.5)} ${n1(ey)}h5" stroke="#120d08" stroke-width="1.2"/>` : `<circle cx="${n1(ex)}" cy="${n1(ey)}" r="2.6" fill="#120d08"/><circle cx="${n1(ex - 0.8)}" cy="${n1(ey - 0.9)}" r=".8" fill="#fff"/>`
  }
  // A horn beak at the front of the head, hooked down a little.
  const hd = Math.hypot(hx - nx, hy - ny) || 1
  const [dx, dy] = [(hx - nx) / hd, (hy - ny) / hd]
  const beak = st.isIn || detail < 1 ? '' : `<path d="M${n1(hx + dx * hr * 0.55 - dy * hr * 0.42)} ${n1(hy + dy * hr * 0.55 + dx * hr * 0.42)}L${n1(hx + dx * hr * 1.22)} ${n1(hy + dy * hr * 1.22 + hr * 0.18)}L${n1(hx + dx * hr * 0.55 + dy * hr * 0.42)} ${n1(hy + dy * hr * 0.55 - dx * hr * 0.42)}Z" fill="#4a3c26"/>`
  const head = {
    d: turtleDepth(sc, t, t.L, 0),
    svg: `<g><title>${label}</title><path d="M${n1(nx)} ${n1(ny)}L${n1(hx)} ${n1(hy)}" stroke="${hide}" stroke-width="${n1(t.Rs * 0.15 * sc.S)}" stroke-linecap="round"/><ellipse cx="${n1(hx)}" cy="${n1(hy)}" rx="${n1(hr)}" ry="${n1(hr * 0.72)}" fill="${hide}" stroke="${hideDark}" stroke-width="1"/>${beak}${eye(-1)}${eye(1)}</g>`,
  }
  // The shell: its rim and dome, paler with the hours, a crater for each third of an hour (a few shown), a ring for each compaction.
  const rim: Pt[] = []
  const dome: Pt[] = []
  const around = detail >= 2 ? 28 : 16
  for (let k = 0; k < around; k++) {
    const a = (k / around) * Math.PI * 2
    rim.push(onTurtle(sc, t, Math.cos(a) * t.L, Math.sin(a) * t.W, t.base))
    dome.push(onTurtle(sc, t, Math.cos(a) * t.L * 0.72, Math.sin(a) * t.W * 0.72, t.base + t.H * 0.7))
  }
  const shell = mixHex('#5e5a2e', '#a49b86', age * 0.5)
  const [cx, cy] = onTurtle(sc, t, 0, 0, t.base + t.H * 0.45)
  let rings = ''
  for (let k = 1; k <= Math.min(detail >= 1 ? 4 : 0, w.compactions); k++) rings += `<ellipse cx="${n1(cx)}" cy="${n1(cy)}" rx="${n1(t.W * sc.S * (0.2 + k * 0.14))}" ry="${n1(t.W * sc.S * (0.1 + k * 0.07))}" fill="none" stroke="#d8cfa8" stroke-opacity=".5"/>`
  let craters = ''
  for (let k = 0; k < Math.min(detail >= 2 ? 8 : 0, Math.floor(hours * 3)); k++) {
    const [x, y] = onTurtle(sc, t, (rand2(k, 1, 404) - 0.5) * t.L * 1.4, (rand2(k, 2, 404) - 0.5) * t.W * 1.4, t.base + t.H * 0.5)
    craters += `<circle cx="${n1(x)}" cy="${n1(y)}" r="${n1(1.5 + rand2(k, 3, 404) * 2)}" fill="#3a3320" opacity=".45"/>`
  }
  let plates = ''
  if (detail >= 2) {
    for (const u of [0.64, 0.32, 0, -0.32, -0.62]) {
      const [x, y] = onTurtle(sc, t, u * t.L * 0.8, 0, t.base + t.H * (0.75 + 0.25 * Math.sqrt(1 - u * u)))
      plates += `<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(t.W * sc.S * 0.16)}" ry="${n1(t.W * sc.S * 0.09)}" fill="none" stroke="#2c2614" stroke-opacity=".6"/>`
    }
  }
  // And the plates down each side, where there is room to spare.
  if (detail >= 3) {
    for (const u of [0.44, 0.13, -0.18, -0.47]) {
      for (const v of [0.5, -0.5]) {
        const [x, y] = onTurtle(sc, t, u * t.L * 0.8, v * t.W * 0.8, t.base + t.H * 0.75)
        plates += `<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(t.W * sc.S * 0.15)}" ry="${n1(t.W * sc.S * 0.08)}" fill="none" stroke="#2c2614" stroke-opacity=".45"/>`
      }
    }
  }
  const shellSvg = `<g>${detail >= 2 ? `<title>${label}</title>` : ''}${detail >= 1 ? `<path d="${rel(rim)}Z" fill="#2c2614"/>` : ''}<path d="${rel(rim)}Z" fill="${shell}" transform="translate(0 -3)"/><path d="${rel(dome)}Z" fill="${mixHex(shell, '#7a6a36', 0.5)}"/>${plates}${rings}${craters}</g>`
  const all = [...limbs, head].sort((p, q) => p.d - q.d)
  const back = all.filter(p => p.d < turtleDepth(sc, t, 0, 0))
  const front = all.filter(p => p.d >= turtleDepth(sc, t, 0, 0))
  // The sun gone round beneath the disc lights its belly.
  if (sc.isNight) {
    const [bx, by] = onTurtle(sc, t, 0, 0, t.base - 3)
    out.push(`<ellipse cx="${n0(bx)}" cy="${n0(by)}" rx="${n0(t.W * sc.S * 1.1)}" ry="${n0(t.W * sc.S * 0.45)}" fill="url(#sun)" opacity=".3"><title>The sun has gone round beneath the disc: the session limit is spent, or (with none reported) it is night</title></ellipse>`)
  }
  out.push(...back.map(p => p.svg), shellSvg, ...front.map(p => p.svg))
}

/** The disc: its rock rim and the rock hanging under it, and the sea pouring over the rim. */
const discLayer = (sc: Scene, px: number, pyTop: number, pyFoot: number, rx: number, ry: number, back: string[], falls: string[]) => {
  const t = turtleOf(sc)
  const sag = t.sag * sc.Z
  back.push(`<path d="M${n1(px - rx)} ${n1(pyFoot)}A${n1(rx)} ${n1(ry)} 0 0 0 ${n1(px + rx)} ${n1(pyFoot)}A${n1(rx)} ${n1(ry + sag)} 0 0 1 ${n1(px - rx)} ${n1(pyFoot)}Z" fill="url(#under)"/>`)
  let stones = ''
  for (let k = 0; k < 7; k++) {
    const a = 0.25 + (k / 6) * 2.64
    const x = px - Math.cos(a) * rx * 0.95
    const y = pyFoot + Math.sin(a) * (ry + sag * 0.6)
    const l = 6 + rand2(k, 5, sc.world.seed) * 12
    stones += `M${n1(x - 3)} ${n1(y)}l3 ${n1(l)} 3 ${n1(-l)}Z`
  }
  if (detail >= 1) back.push(`<path d="${stones}" fill="#3f3934"/>`)
  back.push(`<path d="M${n1(px - rx)} ${n1(pyTop)}A${n1(rx)} ${n1(ry)} 0 0 0 ${n1(px + rx)} ${n1(pyTop)}L${n1(px + rx)} ${n1(pyFoot)}A${n1(rx)} ${n1(ry)} 0 0 1 ${n1(px - rx)} ${n1(pyFoot)}Z" fill="url(#rock)"/>`)
  // The sea over the rim: a see-through sheet falling and fading, streaks running down it, spray below as thick as the context is full.
  const fall = (2.6 / LH) * sc.Z
  const spray = Math.max(0, Math.min(1, sc.world.tide / 100))
  const note = esc(`The sea pours over the rim; its spray is as thick as the context is full (${Math.round(sc.world.tide)}%)`)
  if (detail === 0) {
    falls.push(`<path d="M${n1(px - rx)} ${n1(pyTop)}A${n1(rx)} ${n1(ry)} 0 0 0 ${n1(px + rx)} ${n1(pyTop)}l${n1(rx * 0.04)} ${n1(fall * 0.6)}A${n1(rx * 1.04)} ${n1(ry * 1.04)} 0 0 1 ${n1(px - rx * 1.04)} ${n1(pyTop + fall * 0.6)}Z" fill="#e8f6ff" opacity=".25"><title>${note}</title></path>`)
    return
  }
  falls.push(`<linearGradient id="fallg" gradientUnits="userSpaceOnUse" x1="0" y1="${n0(pyTop)}" x2="0" y2="${n0(pyTop + ry + fall)}"><stop offset="0" stop-color="#e8f6ff" stop-opacity=".6"/><stop offset="1" stop-color="#e8f6ff" stop-opacity="0"/></linearGradient>`)
  falls.push(`<path d="M${n1(px - rx)} ${n1(pyTop)}A${n1(rx)} ${n1(ry)} 0 0 0 ${n1(px + rx)} ${n1(pyTop)}l${n1(rx * 0.04)} ${n1(fall)}A${n1(rx * 1.04)} ${n1(ry * 1.04)} 0 0 1 ${n1(px - rx * 1.04)} ${n1(pyTop + fall)}Z" fill="url(#fallg)" opacity=".55"><title>${note}</title></path>`)
  let streaks = ''
  const lanes = [8, 12, 18, 26][detail]!
  for (let k = 0; k < lanes; k++) {
    const a = ((k + 0.5) / lanes) * Math.PI
    const x = px - Math.cos(a) * rx
    const y = pyTop + Math.sin(a) * ry
    streaks += `M${n1(x)} ${n1(y)}l${n1(-Math.cos(a) * rx * 0.04)} ${n1(fall * (0.6 + rand2(k, 8, sc.world.seed) * 0.4))}`
  }
  falls.push(`<path d="${streaks}" stroke="url(#fallg)" stroke-width="2" stroke-dasharray="7 5" class="wf" fill="none"/>`)
  const puffs = detail >= 2 ? 6 : 2
  for (let k = 0; k < puffs; k++) {
    const a = ((k + 0.5) / puffs) * Math.PI
    falls.push(`<ellipse cx="${n0(px - Math.cos(a) * rx * 1.05)}" cy="${n0(pyTop + Math.sin(a) * ry + fall * 0.95)}" rx="${n0(10 + spray * 16)}" ry="${n0(5 + spray * 7)}" fill="#e8f2ff" opacity="${(0.08 + spray * 0.25).toFixed(2)}" class="bb" style="animation-delay:-${k}s"/>`)
  }
}

// ---------------------------------------------------------------- sky and weather

const sunPlace = (hour: number): Pt => {
  const t = Math.max(0, Math.min(1, (hour - 6) / 13))
  return [70 + t * 620, 300 - Math.sin(t * Math.PI) * 240]
}

const skyLayer = (sc: Scene, hour: number, out: string[], front: string[]) => {
  const { mood } = sc.world
  const seed = sc.world.seed
  const cpu = sc.world.system?.cpu ?? 0.25
  // Space: dark all round, the Milky Way across it and the stars, by day too (fainter).
  out.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>`)
  const faint = sc.isNight ? 1 : 0.6
  if (detail >= 1) out.push(`<path d="M-30 430Q260 60 800 110" fill="none" stroke="#c9d2ff" stroke-width="70" opacity="${(0.11 * faint).toFixed(2)}" filter="url(#soft)"/><path d="M-30 430Q260 60 800 110" fill="none" stroke="#fff0d8" stroke-width="18" opacity="${(0.08 * faint).toFixed(2)}" filter="url(#soft)"/>`)
  {
    for (let k = 0; k < [0, 20, 46, 46][detail]!; k++) {
      const x = rand2(k, 1, seed) * WIDTH
      const y = rand2(k, 2, seed) * HEIGHT
      out.push(`<circle cx="${n0(x)}" cy="${n0(y)}" r="${(0.5 + rand2(k, 3, seed) * 1.1).toFixed(1)}" fill="#fff" class="tw" style="animation-delay:-${(rand2(k, 4, seed) * 3).toFixed(1)}s"/>`)
    }
  }
  // The moon rides the weekly limit as the sun rides the session's: risen at
  // none of it, set when it runs out; pale by day, bright by night.
  const arc = moonArc(sc.world)
  if (arc !== undefined || sc.isNight) {
    const [mx, my] = arc === undefined ? [640, 78] : sunPlace(6 + arc * 13)
    const lit = sc.isNight ? 1 : 0.5
    const note = arc === undefined ? 'The moon' : `The moon follows the weekly limit: ${Math.round((sc.world.system?.weekLimit ?? 0))}% used`
    out.push(`<g opacity="${lit}"><title>${note}</title><circle cx="${n0(mx)}" cy="${n0(my)}" r="34" fill="url(#sun)" opacity="${sc.isNight ? 0.35 : 0.15}"/><circle cx="${n0(mx)}" cy="${n0(my)}" r="16" fill="#f3f0e2"/><circle cx="${n0(mx + 7)}" cy="${n0(my - 4)}" r="14" fill="url(#sky)" opacity=".85"/></g>`)
  }
  if (!sc.isNight) {
    const [sx, sy] = sunPlace(hour)
    out.push(`<circle cx="${n0(sx)}" cy="${n0(sy)}" r="44" fill="url(#sun)" opacity="${(0.9 - mood.storm * 0.8).toFixed(2)}"/><circle cx="${n0(sx)}" cy="${n0(sy)}" r="14" fill="#fff6dc" opacity="${(1 - mood.storm * 0.85).toFixed(2)}"><title>The sun follows the session limit: ${sc.world.system?.limit !== undefined ? `${Math.round(sc.world.system.limit)}% used` : 'none reported, so the clock'}</title></circle>`)
  }
  const greenAt = sc.world.tests?.greenAt
  const isGreen = greenAt !== undefined && sc.now - greenAt < 180000 && (sc.world.tests?.failed ?? 1) === 0
  if (((mood.joy > 0.42 && mood.storm < 0.5) || isGreen) && !sc.isNight) {
    const colors = ['#ff6b6b', '#ffb347', '#fff275', '#7ddc7d', '#6bb8ff', '#a98bff']
    const op = Math.max(isGreen ? 0.45 : 0, Math.min(0.55, (mood.joy - 0.35) * 1.2)).toFixed(2)
    colors.forEach((c, k) => {
      const r = 330 - k * 9
      out.push(`<path d="M${380 - r} 380A${r} ${r} 0 0 1 ${380 + r} 380" fill="none" stroke="${c}" stroke-width="9" opacity="${op}"/>`)
    })
  }
  if (mood.wonder > 0.4 && (sc.isNight || sc.phase === 'dusk')) {
    for (let k = 0; k < 3; k++) {
      const y = 70 + k * 34
      out.push(`<path d="M-20 ${y + 30}C150 ${y - 30} 300 ${y + 60} 420 ${y}S650 ${y - 20} 790 ${y + 40}L790 ${y + 90}C640 ${y + 40} 470 ${y + 100} 300 ${y + 60}S80 ${y + 30} -20 ${y + 80}Z" fill="url(#aurora${k % 2})" class="au" opacity="${(0.25 + mood.wonder * 0.3).toFixed(2)}" style="animation-delay:-${k * 2}s"/>`)
    }
  }
  // Clouds: the CPU's load. Rain or a stormy mood darkens them; urgency speeds them up.
  const clouds = Math.round(cpu * 11 + rainOf(sc.world) * 3)
  const grey = mood.storm > 0.4 || rainOf(sc.world) > 0.3
  const speed = 1 + mood.haste * 3
  for (let k = 0; k < clouds; k++) {
    const isFront = k % 3 === 2
    const y = 20 + rand2(k, 9, seed) * 160 + (isFront ? 60 : 0)
    const s = 0.7 + rand2(k, 10, seed) * 0.9 + cpu * 0.4
    const fill = grey ? (k % 2 === 0 ? '#6f7480' : '#8a8f9a') : '#ffffff'
    const op = grey ? 0.92 : sc.isNight ? 0.25 : 0.85
    const dur = ((70 + rand2(k, 11, seed) * 70) / speed).toFixed(0)
    const puffs = `<ellipse rx="${n0(60 * s)}" ry="${n0(20 * s)}"/><ellipse cx="${n0(-28 * s)}" cy="${n0(-10 * s)}" rx="${n0(30 * s)}" ry="${n0(22 * s)}"/><ellipse cx="${n0(18 * s)}" cy="${n0(-18 * s)}" rx="${n0(34 * s)}" ry="${n0(26 * s)}"/>`
    ;(isFront ? front : out).push(`<g transform="translate(0 ${n0(y)})"><g class="cl" fill="${fill}" opacity="${op}" style="animation-duration:${dur}s;animation-delay:-${(rand2(k, 12, seed) * Number(dur)).toFixed(0)}s">${puffs}</g></g>`)
  }
}

/** Rain: the context window. Dry below 70% full, a drizzle past it, a storm near the top. */
export const rainOf = (world: World): number => Math.max(0, Math.min(1, (world.tide - 70) / 25))

const weatherFront = (sc: Scene, front: string[]) => {
  const { mood } = sc.world
  const seed = sc.world.seed
  const rain = rainOf(sc.world)
  if (rain > 0) {
    const drops = Math.round((detail >= 2 ? 12 : 8) + rain * (detail >= 2 ? 110 : 50))
    const slant = 4 + rain * 10
    const lines: string[] = []
    for (let k = 0; k < drops; k++) {
      const x = n0(rand2(k, 20, seed) * (WIDTH + 80))
      const y = n0(rand2(k, 21, seed) * HEIGHT)
      lines.push(`<line x1="${x}" y1="${y - HEIGHT}" x2="${n0(x - slant)}" y2="${n0(y - HEIGHT + 8 + rain * 10)}" class="rn" style="animation-delay:-${rand2(k, 22, seed).toFixed(2)}s"/>`)
    }
    front.push(`<g stroke="#c9d6e8" stroke-width="${(0.8 + rain * 0.6).toFixed(1)}" opacity="${(0.3 + rain * 0.4).toFixed(2)}"><title>Rain: the context window is ${Math.round(sc.world.tide)}% full</title>${lines.join('')}</g>`)
  }
  const dark = Math.max(rain * 0.32, mood.storm * 0.2)
  if (dark > 0.02) front.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#1a1f2b" opacity="${dark.toFixed(2)}"/>`)
  if (rain > 0.7 || mood.storm > 0.62) front.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#eef4ff" class="fl"/>`)
  if (mood.haste > 0.4) {
    for (let k = 0; k < 9; k++) {
      const y = n0(60 + rand2(k, 30, seed) * 360)
      front.push(`<line x1="0" y1="${y}" x2="${n0(40 + rand2(k, 31, seed) * 60)}" y2="${y}" stroke="#fff" stroke-opacity=".5" stroke-linecap="round" class="gs" style="animation-delay:-${(rand2(k, 32, seed) * 1.6).toFixed(2)}s"/>`)
    }
  }
  if (mood.wonder > 0.3) {
    const count = Math.round(6 + mood.wonder * 14)
    const color = sc.isNight || sc.phase === 'dusk' ? '#e8ff8a' : '#ffffff'
    for (let k = 0; k < count; k++) {
      const a = rand2(k, 40, seed) * Math.PI * 2
      const d = rand2(k, 41, seed) * sc.island.R
      const [x, y] = proj(sc, Math.cos(a) * d, Math.sin(a) * d, 3 + rand2(k, 42, seed) * 5)
      front.push(`<circle cx="${n0(x)}" cy="${n0(y)}" r="1.6" fill="${color}" class="tw bb" style="animation-delay:-${(rand2(k, 43, seed) * 4).toFixed(1)}s"/>`)
    }
  }
}

// ---------------------------------------------------------------- tool calls

const TOOL_COLOR: Record<string, string> = {
  read: '#8ff0b0',
  write: '#ffb84a',
  edit: '#ffd27a',
  bash: '#ff9a4a',
  search: '#7fe3ff',
  web: '#cfe6ff',
  agent: '#c39bff',
  skill: '#ff9ad8',
  mcp: '#7ff7e3',
  other: '#ffffff',
}

const toolKind = (tool: string): string => {
  if (tool === 'Read') return 'read'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edit'
  if (tool === 'Bash' || tool === 'PowerShell') return 'bash'
  if (tool === 'Grep' || tool === 'Glob') return 'search'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (tool === 'Agent' || tool === 'Task') return 'agent'
  if (tool === 'Skill') return 'skill'
  if (tool.startsWith('mcp__')) return 'mcp'
  return 'other'
}

const bolt = (from: Pt, to: Pt, seed: number, jag: number): string => {
  const steps = 7
  let d = `M${n0(from[0])} ${n0(from[1])}`
  for (let k = 1; k <= steps; k++) {
    const t = k / steps
    const x = from[0] + (to[0] - from[0]) * t + (k < steps ? (rand2(seed, k, 5) - 0.5) * jag : 0)
    const y = from[1] + (to[1] - from[1]) * t + (k < steps ? (rand2(seed, k, 6) - 0.5) * jag * 0.4 : 0)
    d += `L${n0(x)} ${n0(y)}`
  }
  return d
}

/** Fades in, holds, fades out over the effect's life, begun `age` seconds ago. */
const life = (age: number, dur = EFFECT_SECONDS) =>
  `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.06;.55;1" dur="${dur}s" begin="-${age.toFixed(2)}s" fill="freeze"/>`

// ---------------------------------------------------------------- the creature

const TENTACLE_SECONDS = 24
/** One unit of height in the 3D view, in terrace levels. */
const LEVELS = 1 / 0.42
const EASE = 'calcMode="spline" keyTimes="0;1" keySplines=".45 0 .55 1"'

type Shape = ReturnType<typeof beastShape>

/** The ground under a point of the island, in terrace levels; where it is sea, the creature wades. */
const groundAt = (sc: Scene, x: number, y: number) => Math.max(sc.island.level(Math.floor(x), Math.floor(y)), sc.sea)

/** A step across the island and up (in the 3D view's units), as the screen sees it. */
const off = (sc: Scene, dx: number, dy: number, up: number): Pt => [
  (dx * sc.c - dy * sc.s) * sc.S,
  (dx * sc.s + dy * sc.c) * sc.S * 0.5 - up * LEVELS * sc.Z,
]

/** How high the body rides: on long legs over whatever it straddles; slumped low while it sleeps. */
const liftOf = (s: Shape, isAsleep = false) => (s.reach * 0.62 + s.body * 0.55) * (isAsleep ? 0.45 : 1)

/** Asleep: its turn is done, or Claude is waiting on you (a question, a permission). */
const asleep = (sc: Scene, b: Beast) => b.doneAt !== undefined || sc.world.waiting !== undefined

const pt = (p: Pt) => `${n1(p[0])} ${n1(p[1])}`

/** A closed, lumpy blob around an ellipse. */
const blob = (cx: number, cy: number, rx: number, ry: number, seed: number, salt: number, swell = 1): string => {
  const n = 14
  const ps: Pt[] = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2
    const r = swell * (1 + (rand2(k, salt, seed) - 0.5) * 0.26)
    return [cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]
  })
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  let d = `M${pt(mid(ps[n - 1]!, ps[0]!))}`
  for (let k = 0; k < n; k++) d += `Q${pt(ps[k]!)} ${pt(mid(ps[k]!, ps[(k + 1) % n]!))}`
  return d
}

/**
 * An eye from the defs, blinking now and then, its iris turned by `look`
 * (a step in eye radii) toward whatever it watches; shut, a lid and lashes.
 */
/** Each eye's white and iris in the defs: green the creature's own, amber, and the iris each model lends a creature. */
const IRISES: Record<string, [string, string]> = {
  green: ['ey', 'ei'], opus: ['ey', 'ei'], amber: ['eh', 'ea'],
  sonnet: ['ey', 'eis'], haiku: ['ey', 'eih'], fable: ['ey', 'eif'], other: ['ey', 'eio'],
}

const eye = (kind: 'green' | 'amber' | 'shut' | Family, x: number, y: number, size: number, every: number, delay: number, look: Pt = [0, 0]) => {
  const at = `translate(${n1(x)} ${n1(y)}) scale(${size.toFixed(1)})`
  if (kind === 'shut') return `<use href="#ez" transform="${at}"/>`
  const blink = detail >= 2
    ? `<animateTransform attributeName="transform" type="scale" values="1;1;1 .1;1" keyTimes="0;.94;.97;1" dur="${every.toFixed(1)}s" begin="-${delay.toFixed(1)}s" repeatCount="indefinite" additive="sum"/>`
    : ''
  const [white, iris] = IRISES[kind] ?? ['ey', 'ei']
  const shift = look[0] === 0 && look[1] === 0 ? '' : ` x="${look[0].toFixed(2)}" y="${look[1].toFixed(2)}"`
  return `<g transform="${at}">${blink}<use href="#${white}"/><use href="#${iris}"${shift}/></g>`
}

/** Toward a point, from an eye: a step in eye radii, as far as an iris turns. */
const gazeOf = (from: Pt, to: Pt | undefined): Pt => {
  if (to === undefined) return [0, 0]
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const len = Math.hypot(dx, dy)
  return len < 1 ? [0, 0] : [(dx / len) * 0.34, (dy / len) * 0.3]
}

/**
 * How each tentacle works, by what its call does there (as the 3D window
 * draws it): how thick it is, how far over its target the tip stays (in
 * the 3D view's units), and what it is said to be doing.
 */
const MANNER: Record<string, { thick: number; hover: number; verb: string }> = {
  read: { thick: 0.72, hover: 0, verb: 'drinks in' },
  write: { thick: 1.3, hover: 0.5, verb: 'pours itself into' },
  edit: { thick: 0.9, hover: 0, verb: 'picks at' },
  bash: { thick: 1.1, hover: 0, verb: 'coils round the forge' },
  search: { thick: 0.75, hover: 1, verb: 'sweeps an eye over the land' },
  agent: { thick: 1, hover: 0, verb: 'lays an egg in the nest' },
  skill: { thick: 0.9, hover: 0.3, verb: 'blooms over the shrine' },
  mcp: { thick: 0.95, hover: 0.45, verb: 'sparks against the crystal' },
  other: { thick: 1, hover: 0, verb: 'touches' },
}

const mannerOf = (tool: string): string => (tool === 'Write' ? 'write' : toolKind(tool))

/** When a failed call's tentacle snatched back (an old failure, with no time of its own, soon after the call). */
const failedAt = (e: Event): number | undefined => (e.isError === true ? e.failedAt ?? e.at + 1500 : undefined)

/** What the creature holds: the latest thing each tool call worked on, oldest first; a failed call's, until it has snatched back. */
const grips = (sc: Scene, b: Pick<Beast, 'bornAt'>, agent?: string, most = detail >= 2 ? 8 : 4): Event[] => {
  const latest = new Map<number, Event>()
  for (const e of sc.world.events ?? []) {
    const since = (sc.now - e.at) / 1000
    if (e.agent !== agent || e.target === undefined || e.at < b.bornAt || since < 0 || since > TENTACLE_SECONDS || toolKind(e.tool) === 'web') continue
    latest.delete(e.target)
    const failed = failedAt(e)
    if (failed === undefined || sc.now - failed < 1300) latest.set(e.target, e)
  }
  return [...latest.values()].slice(-most)
}

/** Which way it faces, on the screen: where its tentacles reach (the newest counting most), else the way it crawls, else out at you. */
const facing = (sc: Scene, held: Event[], from: Pt, to: Pt, isCrawling: boolean): Pt => {
  let x = 0
  let y = 0
  held.forEach((e, k) => {
    const top = sc.tops.get(e.target!)
    if (top === undefined) return
    const dx = top[0] - to[0]
    const dy = top[1] - to[1]
    const len = Math.hypot(dx, dy)
    if (len > 1) {
      x += (dx / len) * (1 + k)
      y += (dy / len) * (1 + k)
    }
  })
  if (Math.hypot(x, y) < 0.4 && isCrawling) {
    x = to[0] - from[0]
    y = to[1] - from[1]
  }
  const len = Math.hypot(x, y)
  return len < 0.01 ? [0, 1] : [x / len, y / len]
}

/** The files it is centred among: the last few minutes' work. */
const recentNames = (sc: Scene): string =>
  [...new Set(sc.world.features
    .filter(f => f.touchedAt !== undefined && f.by === undefined && sc.now - f.touchedAt < 180_000 && /^(file|read):/.test(f.key))
    .sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0))
    .map(f => f.key.replace(/^(file|read):/, '').split(/[\\/]/).pop() ?? ''))]
    .filter(Boolean)
    .slice(0, 4)
    .join(', ')

/** What Claude is doing, drawn about the creature's crown: the spinner's own words above it. */
const signs = (sc: Scene, [x, y]: Pt, rx: number, isAsleep: boolean): string[] => {
  const w = sc.world
  const u = sc.S
  const out: string[] = []
  if (isAsleep) {
    // Asleep, eyes shut, z's drifting up: amber when it is you it waits on.
    const isWaiting = w.waiting !== undefined
    const zs = [0, 1, 2]
      .map(k => `<text x="${n0(x + rx * 0.4)}" y="${n0(y)}" font-size="${9 + k * 3}" fill="${isWaiting ? '#ffd27a' : '#d8e4ff'}" stroke="#2a1236" stroke-width="2" paint-order="stroke" font-family="sans-serif" font-weight="700" opacity="0">z<animateMotion path="M0 0q${n0(u * 0.6)} ${n0(-u * 0.8)} ${n0(u * 0.3)} ${n0(-u * 2)}" dur="3s" begin="-${k}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;0" dur="3s" begin="-${k}s" repeatCount="indefinite"/></text>`)
      .join('')
    out.push(`<g><title>${esc(isWaiting ? `Asleep: waiting on you · ${w.waiting?.reason ?? ''}` : 'Asleep: the turn is done')}</title>${zs}</g>`)
    return out
  }
  const verb = w.isWorking === true ? w.activity?.verb : undefined
  if (verb !== undefined && verb !== '') {
    out.push(`<text x="${n0(x)}" y="${n0(y - u * 0.9)}" text-anchor="middle" font-size="11" fill="#f3e8ff" stroke="#1a0d22" stroke-width="3" paint-order="stroke" font-family="sans-serif" font-weight="600">${esc(verb)}…</text>`)
  }
  if (w.isWorking === true && w.activity?.kind === 'thinking') {
    out.push(`<g><title>Claude is thinking</title><ellipse cx="${n0(x)}" cy="${n0(y + rx * 0.7)}" rx="${n0(rx * 1.7 + u * 0.4)}" ry="${n0(rx * 0.65 + u * 0.2)}" fill="none" stroke="#c9a0ff" stroke-width="2" stroke-dasharray="6 9" opacity=".85"><animate attributeName="stroke-dashoffset" from="0" to="-60" dur="2s" repeatCount="indefinite"/></ellipse></g>`)
  } else if (w.isWorking === true && w.activity?.kind === 'writing') {
    const pages: string[] = []
    for (let k = 0; k < 5; k++) {
      const dx = (rand2(k, 90, w.seed) - 0.5) * u * 2.2
      pages.push(`<rect width="4" height="5" fill="#fffaf0" stroke="#d8c9a8" stroke-width=".4" opacity="0"><animateMotion path="M${n0(x)} ${n0(y)}q${n0(dx / 2)} ${n0(-u)} ${n0(dx)} ${n0(-u * 2.6)}" dur="2.4s" begin="-${(k * 0.48).toFixed(2)}s" repeatCount="indefinite" rotate="auto"/><animate attributeName="opacity" values="0;1;1;0" dur="2.4s" begin="-${(k * 0.48).toFixed(2)}s" repeatCount="indefinite"/></rect>`)
    }
    out.push(`<g><title>Claude is writing</title>${pages.join('')}</g>`)
  }
  return out
}

/**
 * The turn's creature, drawn about the ground beneath it: eight jointed legs,
 * a dark breathing body, an eye for every so many tokens and an amber one
 * for each thing you said while it worked. It crawls from where it was.
 */
const creature = (sc: Scene, b: Beast, s: Shape, waitOn?: Pt): string => {
  const u = sc.S
  const seed = sc.world.seed + b.turn * 7919
  const isAsleep = asleep(sc, b)
  const lift = liftOf(s, isAsleep)
  const [fx, fy] = proj(sc, b.fromX, b.fromY, groundAt(sc, b.fromX, b.fromY))
  const [tx, ty] = proj(sc, b.x, b.y, groundAt(sc, b.x, b.y))
  const age = (sc.now - b.movedAt) / 1000
  const crawl = crawlMs(b) / 1000
  const isCrawling = age < crawl && Math.hypot(tx - fx, ty - fy) > 1
  const heading = Math.atan2(b.y - b.fromY, b.x - b.fromX)
  const [bx, by] = off(sc, 0, 0, lift)
  const rx = s.body * u * 1.05
  const ry = s.body * u * 0.92
  const parts: string[] = []
  parts.push(`<ellipse rx="${n1((s.body + s.reach) * u)}" ry="${n1((s.body + s.reach) * u * 0.45)}" fill="#000" opacity=".22"/>`)
  parts.push(`<circle cx="${n1(bx)}" cy="${n1(by)}" r="${n1(rx * 2 + u * 0.5)}" fill="url(#glow2)" opacity=".55" class="pl"/>`)
  if (sc.now - b.bornAt < 3000) {
    const born = `begin="-${((sc.now - b.bornAt) / 1000).toFixed(2)}s" fill="freeze"`
    parts.push(`<ellipse rx="0" ry="0" fill="none" stroke="#d9b8ff" stroke-width="2"><animate attributeName="rx" values="0;${n1(u * 2.4)}" dur="1.2s" ${born}/><animate attributeName="ry" values="0;${n1(u * 1.2)}" dur="1.2s" ${born}/><animate attributeName="opacity" values="1;0" dur="1.2s" ${born}/></ellipse>`)
  }
  // Eight legs, jointed high like a spider's; those behind the body first.
  const legW = Math.max(1.3, u * (0.04 + s.body * 0.07))
  const legs = Array.from({ length: 8 }, (_, k) => {
    const a = heading + ((k + 0.5) / 8) * Math.PI * 2 + (rand2(k, 3, seed) - 0.5) * 0.3
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const pose = (phase: number) => {
      const up = phase === k % 2 ? 1 : 0
      const fwd = phase < 0 ? 0 : (up === 1 ? 0.3 : -0.1) * s.reach
      const gx = Math.cos(heading) * fwd
      const gy = Math.sin(heading) * fwd
      const root = off(sc, ca * s.body * 0.7, sa * s.body * 0.7, lift - s.body * 0.2)
      const knee = off(sc, ca * (s.body + s.reach * 0.55) + gx * 0.5, sa * (s.body + s.reach * 0.55) + gy * 0.5, lift + s.reach * (isAsleep ? 0.18 : 0.45 + up * 0.15))
      const sprawl = isAsleep ? 1.35 : 1.1
      const foot = off(sc, ca * (s.body + s.reach * sprawl) + gx, sa * (s.body + s.reach * sprawl) + gy, up * s.reach * 0.25)
      return `M${pt(root)}L${pt(knee)}L${pt(foot)}`
    }
    const walk = isCrawling
      ? `<animate attributeName="d" values="${pose(0)};${pose(1)};${pose(0)}" dur=".8s" begin="-${age.toFixed(2)}s" repeatDur="${crawl.toFixed(2)}s"/>`
      : ''
    return { depth: ca * sc.s + sa * sc.c, s: `<path d="${pose(-1)}">${walk}</path>` }
  }).sort((p, q) => p.depth - q.depth)
  const legGroup = (list: typeof legs) =>
    `<g fill="none" stroke="#1d0f26" stroke-width="${n1(legW)}" stroke-linejoin="round" stroke-linecap="round">${list.map(l => l.s).join('')}</g>`
  parts.push(legGroup(legs.filter(l => l.depth < 0)))
  // Tendrils hang from its belly and sway.
  if (detail >= 2) {
    const tendrils: string[] = []
    for (let k = 0; k < 5; k++) {
      const x0 = bx + (k - 2) * rx * 0.32
      const y0 = by + ry * 0.55
      const len = ry * (1.1 + rand2(k, 5, seed) * 0.8)
      const sway = rx * 0.35
      const a = `M${n1(x0)} ${n1(y0)}q${n1(sway)} ${n1(len * 0.5)} 0 ${n1(len)}`
      const c = `M${n1(x0)} ${n1(y0)}q${n1(-sway)} ${n1(len * 0.5)} 0 ${n1(len)}`
      tendrils.push(`<path d="${a}"><animate attributeName="d" values="${a};${c};${a}" dur="${(2.2 + k * 0.3).toFixed(1)}s" repeatCount="indefinite"/></path>`)
    }
    parts.push(`<g fill="none" stroke="#2c1538" stroke-width="${n1(Math.max(1, legW * 0.8))}" stroke-linecap="round">${tendrils.join('')}</g>`)
  }
  // The body: dark, lumpy, breathing, with an oily sheen.
  const b0 = blob(bx, by, rx, ry, seed, 7)
  const b1 = blob(bx, by, rx, ry, seed, 8, 1.06)
  parts.push(`<path d="${b0}" fill="url(#shog)" stroke="#b98aff" stroke-opacity=".35" stroke-width="1"><animate attributeName="d" values="${b0};${b1};${b0}" dur="${isAsleep ? 5 : 2.6}s" repeatCount="indefinite"/></path>`)
  parts.push(`<ellipse cx="${n1(bx - rx * 0.3)}" cy="${n1(by - ry * 0.45)}" rx="${n1(rx * 0.35)}" ry="${n1(ry * 0.16)}" fill="#c8f0ff" opacity=".18"/>`)
  // Eyes: it sprouts more as it feeds, each blinking in its own time, all
  // turned toward what its newest tentacle holds. Most crowd its face, on
  // the side it turns to (where its tentacles reach), the biggest in the
  // middle and spiralling out smaller; every fifth looks out behind. Turned
  // away from you, its face is only glimpsed over its back.
  const held = isAsleep ? [] : grips(sc, b)
  // Holding nothing, its eyes stay on a child it waits on.
  const top = held.length === 0 ? waitOn : sc.tops.get(held.at(-1)!.target!)
  const watch: Pt | undefined = top === undefined ? undefined : [top[0] - tx, top[1] - ty]
  const face = facing(sc, held, [fx, fy + by], [tx, ty + by], isCrawling)
  const glimpsed = face[1] < -0.35 ? 0.7 : 1
  const onFace = s.eyes - Math.floor(s.eyes / 5)
  const middle: Pt = [bx + face[0] * rx * 0.42, by + face[1] * ry * 0.38 - ry * 0.08]
  for (let k = 0; k < s.eyes; k++) {
    let at: Pt
    let size: number
    if (k % 5 === 4) {
      const a = (rand2(k, 11, seed) - 0.5) * 1.6
      at = [bx - (face[0] * Math.cos(a) - face[1] * Math.sin(a)) * rx * 0.7, by - (face[0] * Math.sin(a) + face[1] * Math.cos(a)) * ry * 0.55 - ry * 0.1]
      size = s.body * u * 0.09
    } else {
      const j = k - Math.floor((k + 1) / 5)
      const rho = 0.5 * Math.sqrt(j / Math.max(1, onFace))
      const phi = j * 2.39996 + rand2(k, 11, seed) * 0.4
      at = [middle[0] + Math.cos(phi) * rho * rx, middle[1] + Math.sin(phi) * rho * ry * 0.8]
      size = s.body * u * (j === 0 ? 0.2 : 0.15 - 0.05 * Math.sqrt(j / onFace)) * glimpsed
    }
    // Kept on the body.
    const out = ((at[0] - bx) / rx) ** 2 + ((at[1] - by) / ry) ** 2
    if (out > 0.75) at = [bx + (at[0] - bx) * Math.sqrt(0.75 / out), by + (at[1] - by) * Math.sqrt(0.75 / out)]
    parts.push(eye(isAsleep ? 'shut' : b.model === undefined ? 'green' : familyOf(b.model), at[0], at[1], Math.max(1.1, size * (0.85 + rand2(k, 13, seed) * 0.3)), 3 + rand2(k, 14, seed) * 4, rand2(k, 15, seed) * 6, gazeOf(at, watch)))
  }
  parts.push(legGroup(legs.filter(l => l.depth >= 0)))
  parts.push(...signs(sc, [bx, by - ry], rx, isAsleep))
  const names = recentNames(sc)
  const title = `Turn ${b.turn}'s creature, ${s.isAwake ? 'woken' : 'asleep after'} “${b.prompt}” · ${s.isAwake ? 'working' : 'worked'} ${duration(s.seconds)} · ${tokenCount(s.tokens)} tokens · ${s.eyes} eyes${names === '' ? '' : ` · in the middle of ${names}`}`
  const motion = isCrawling
    ? `<animateMotion path="M${n1(fx)} ${n1(fy)}L${n1(tx)} ${n1(ty)}" dur="${crawl.toFixed(2)}s" begin="-${age.toFixed(2)}s" fill="freeze" ${EASE} keyPoints="0;1"/>`
    : ''
  return `<g class="f"${isCrawling ? '' : ` transform="translate(${n1(tx)} ${n1(ty)})"`}><title>${esc(title)}</title>${motion}${parts.join('')}</g>`
}

/**
 * What a tentacle's tip does at its work, drawn about the tip: a mouth
 * sucking up motes for a read, gold pouring down into a new file, pincers
 * picking at an edit, a coil round the forge with embers, an eye sweeping a
 * beam over a search, scouts budding down it to a camp, petals over a
 * shrine, sparks to a crystal.
 */
const tipWork = (kind: string, tip: Pt, top: Pt, d: string, width: number, u: number, seed: number): string => {
  const color = TOOL_COLOR[kind] ?? '#ffffff'
  const [x, y] = tip
  const rise = (from: Pt, by: number, dur: number, k: number, r: number, fill: string) =>
    `<circle cx="${n1(from[0])}" cy="${n1(from[1])}" r="${n1(r)}" fill="${fill}" opacity="0"><animateMotion path="M0 0l${n1((rand2(seed, k, 31) - 0.5) * u * 0.4)} ${n1(by)}" dur="${dur}s" begin="-${((k * dur) / 3).toFixed(2)}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;0" dur="${dur}s" begin="-${((k * dur) / 3).toFixed(2)}s" repeatCount="indefinite"/></circle>`
  const parts: string[] = []
  switch (kind) {
    case 'read':
      parts.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${n1(width * 0.9)}" fill="#0d2a17" stroke="${color}" stroke-width="1.2"><animate attributeName="r" values="${n1(width * 0.6)};${n1(width * 1.1)};${n1(width * 0.6)}" dur="1.4s" repeatCount="indefinite"/></circle>`)
      for (let k = 0; k < 3; k++) parts.push(rise([x, y + u * 0.6], -u * 0.6, 1.2, k, 1.4, color))
      break
    case 'write':
      parts.push(`<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(width * 1.2)}" ry="${n1(width * 0.6)}" fill="#3a2410" stroke="${color}" stroke-width="1"/>`)
      for (let k = 0; k < 3; k++) parts.push(rise([x, y], top[1] - y, 0.8, k, 1.7, color))
      break
    case 'edit':
      parts.push(`<g transform="translate(${n1(x)} ${n1(y)})"><path d="M0 0l${n1(-u * 0.12)} ${n1(u * 0.2)}M0 0l${n1(u * 0.12)} ${n1(u * 0.2)}" stroke="#1d0f26" stroke-width="${n1(width * 0.45)}" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="-18;18;-18" dur=".25s" repeatCount="indefinite"/></path></g>`)
      for (let k = 0; k < 3; k++) parts.push(rise([x, y + u * 0.1], -u * 0.35, 0.4, k, 1.1, '#fff1b0'))
      break
    case 'bash':
      for (const dy of [0, u * 0.18]) parts.push(`<ellipse cx="${n1(top[0])}" cy="${n1(top[1] + dy)}" rx="${n1(u * 0.32)}" ry="${n1(u * 0.13)}" fill="none" stroke="#1d0f26" stroke-width="${n1(width * 0.7)}"/><ellipse cx="${n1(top[0])}" cy="${n1(top[1] + dy)}" rx="${n1(u * 0.32)}" ry="${n1(u * 0.13)}" fill="none" stroke="#ff8a3a" stroke-width="${n1(width * 0.25)}" pathLength="1" stroke-dasharray=".2 .3"><animate attributeName="stroke-dashoffset" values="0;1" dur="1.2s" repeatCount="indefinite"/></ellipse>`)
      for (let k = 0; k < 3; k++) parts.push(rise([top[0], top[1]], -u * 1.1, 1, k, 1.3, '#ffb347'))
      break
    case 'search':
      parts.push(`<g><path d="M${n1(x)} ${n1(y)}L${n1(top[0] - u * 0.5)} ${n1(top[1] + u * 0.3)}L${n1(top[0] + u * 0.5)} ${n1(top[1] + u * 0.3)}Z" fill="${color}" opacity=".16"/><animateTransform attributeName="transform" type="rotate" values="-16 ${n1(x)} ${n1(y)};16 ${n1(x)} ${n1(y)};-16 ${n1(x)} ${n1(y)}" dur="3s" repeatCount="indefinite"/></g>`)
      parts.push(eye('green', x, y, Math.max(1.6, width * 0.7), 4, seed % 4, [0, 0.3]))
      break
    case 'agent':
      for (let k = 0; k < 2; k++) parts.push(`<circle r="${n1(width * 0.55)}" fill="#8a5cc8" stroke="#2a1236" stroke-width=".6"><animateMotion path="${d}" dur="1.6s" begin="-${(k * 0.8).toFixed(1)}s" repeatCount="indefinite"/></circle>`)
      break
    case 'skill': {
      const petals = Array.from({ length: 5 }, (_, k) => `<ellipse cx="${n1(u * 0.11)}" rx="${n1(u * 0.12)}" ry="${n1(u * 0.05)}" fill="${color}" transform="rotate(${k * 72})"/>`).join('')
      parts.push(`<g transform="translate(${n1(x)} ${n1(y)})"><g opacity=".9">${petals}<animateTransform attributeName="transform" type="rotate" values="0;360" dur="9s" repeatCount="indefinite"/></g></g>`)
      break
    }
    case 'mcp':
      parts.push(`<path d="${bolt(tip, top, seed, u * 0.3)}" fill="none" stroke="${color}" stroke-width="1.4"><animate attributeName="opacity" values="1;0;1;.3;1" dur=".4s" repeatCount="indefinite"/></path>`)
      break
  }
  return parts.join('')
}

/**
 * Tentacles: up out of its back, over, and down onto what each tool call
 * works on, clear of the ground between, each at work in the way of its call
 * (MANNER). It holds a while, then lets go; a failed call snatches back, red.
 */
type Crawler = Pick<Beast, 'x' | 'y' | 'fromX' | 'fromY' | 'movedAt' | 'bornAt'>

const tentacles = (sc: Scene, b: Crawler, s: Shape, agent?: string, leg = '#1d0f26', vein = '#7a4f96', most?: number): string[] => {
  const u = sc.S
  const lift = liftOf(s)
  const rootOf = (x: number, y: number): Pt => {
    const [gx, gy] = proj(sc, x, y, groundAt(sc, x, y))
    const [ox, oy] = off(sc, 0, 0, lift + s.body * 0.5)
    return [gx + ox, gy + oy]
  }
  const from = rootOf(b.fromX, b.fromY)
  const to = rootOf(b.x, b.y)
  const age = (sc.now - b.movedAt) / 1000
  const crawl = crawlMs(b) / 1000
  const width = Math.max(1.6, u * (0.05 + s.body * 0.09))
  const out: string[] = []
  for (const e of grips(sc, b, agent, most)) {
    const top = sc.tops.get(e.target!)
    if (top === undefined) continue
    const kind = mannerOf(e.tool)
    const M = MANNER[kind] ?? MANNER.other!
    const color = TOOL_COLOR[kind] ?? '#ffffff'
    const thick = width * M.thick
    // Over the thing for a spout, an eye or a spark; onto it for the rest.
    const tip: Pt = [top[0], top[1] + off(sc, 0, 0, M.hover)[1]]
    const since = (sc.now - e.at) / 1000
    const failed = failedAt(e)
    const wob = (rand2(e.id, 1, 9) - 0.5) * u * 0.6
    const path = (r: Pt) => {
      const across = tip[0] - r[0]
      const peak = Math.min(r[1], tip[1]) - u * 1.3 - Math.abs(across) * 0.3
      return `M${pt(r)}C${n1(r[0] + across * 0.15 + wob)} ${n1(peak)} ${n1(r[0] + across * 0.85 - wob)} ${n1(peak)} ${pt(tip)}`
    }
    const d = path(to)
    const follow = age < crawl ? `<animate attributeName="d" values="${path(from)};${d}" dur="${crawl.toFixed(2)}s" begin="-${age.toFixed(2)}s" fill="freeze" ${EASE}/>` : ''
    // Out in half a second; back as its time runs out, or at once (and quicker) when its call failed.
    const back = failed === undefined ? `${(TENTACLE_SECONDS - 1.2 - since).toFixed(2)}s" dur="1.2s` : `${((failed - sc.now) / 1000).toFixed(2)}s" dur=".9s`
    const reach = `<animate attributeName="stroke-dashoffset" values="1;0" dur=".5s" begin="-${since.toFixed(2)}s" fill="freeze"/><animate attributeName="stroke-dashoffset" values="0;1" begin="${back}" fill="freeze"/>`
    const strand = (stroke: string, w: number) => `<path d="${d}" stroke="${stroke}" stroke-width="${n1(w)}" pathLength="1" stroke-dasharray="1 1">${follow}${reach}</path>`
    // A pulse runs along it: up into the body for a read, down into the work for the rest.
    const working = `<animate attributeName="opacity" values="0;.9;.9;0" keyTimes="0;.03;.93;1" dur="${TENTACLE_SECONDS}s" begin="-${since.toFixed(2)}s" fill="freeze"/>`
    const pulse = detail >= 2 && failed === undefined
      ? `<path d="${d}" stroke="${color}" stroke-width="${n1(thick * 0.5)}" pathLength="1" stroke-dasharray=".06 .94" opacity="0">${follow}<animate attributeName="stroke-dashoffset" values="${kind === 'read' ? '0;1' : '1;0'}" dur=".9s" repeatCount="indefinite"/>${working}</path>`
      : ''
    const work = detail >= 2 && failed === undefined && age >= crawl
      ? `<g opacity="0">${tipWork(kind, tip, top, d, thick, u, e.id)}${working}</g>`
      : ''
    const thing = sc.world.features.find(f => f.id === e.target)
    const name = thing === undefined ? e.tool : /^(file|read):/.test(thing.key) ? thing.key.replace(/^(file|read):/, '').split(/[\\/]/).pop() ?? '' : `· ${thing.label}`
    const title = `A tentacle ${M.verb} ${name.length > 60 ? `${name.slice(0, 59)}…` : name}${failed === undefined ? '' : ' · the call failed'}`
    out.push(`<g fill="none" stroke-linecap="round"><title>${esc(title)}</title>${strand(failed === undefined ? leg : '#4a0d0d', thick)}${detail >= 2 ? strand(failed === undefined ? vein : '#d24a3a', thick * 0.4) : ''}${pulse}${work}</g>`)
  }
  return out
}

// ---------------------------------------------------------------- the brood

/** How many spawnlings the pane draws at once; the rest are counted beside their nest. */
const BROOD_SHOWN = 6
const ABSORB_SECONDS = 1.6
const PARCEL_SECONDS = 1.6

/** A spawnling's skin: its type's hue (a fork, the creature's own violet), grey and reddened when it failed or was stopped. */
const broodSkin = (s: Spawn) => {
  const hurt = s.outcome === 'failed' || s.outcome === 'aborted'
  if (s.isFork === true && !hurt) return { light: '#7d4b98', mid: '#3b1a4c', dark: '#12071a', leg: '#1d0f26', vein: '#7a4f96' }
  const hue = hurt ? 5 : s.hue
  const sat = hurt ? 0.2 : 0.55
  return { light: hsl(hue, sat, 0.7), mid: hsl(hue, sat, 0.45), dark: hsl(hue, sat, 0.15), leg: hsl(hue, sat * 0.8, 0.15), vein: hsl(hue, sat, 0.55) }
}

/** Where a spawnling is headed at the moment of drawing: home with its answer, to where its parent stands. */
const spawnTrip = (s: Spawn, parent: { x: number; y: number } | undefined): Spawn =>
  homeAt(s) !== undefined && parent !== undefined ? { ...s, x: parent.x, y: parent.y } : s

/** The ones drawn: those at work first (the newest), then those crawling home, then those asleep. */
const shownBrood = (sc: Scene): { shown: Spawn[]; hidden: Spawn[] } => {
  const live = (sc.world.brood ?? []).filter(s => {
    const home = homeAt(s)
    return home === undefined || sc.now - home < ABSORB_SECONDS * 1000
  })
  const rank = (s: Spawn) => (s.doneAt === undefined ? 0 : homeAt(s) !== undefined ? 1 : 2)
  const ordered = [...live].sort((a, b) => rank(a) - rank(b) || b.bornAt - a.bornAt)
  return { shown: ordered.slice(0, BROOD_SHOWN), hidden: ordered.slice(BROOD_SHOWN) }
}

/**
 * A spawnling, drawn plainer than the creature: eight legs, a body in its
 * type's color, its biggest eyes in its model's color; asleep, eyes shut;
 * home with its answer, it shrinks into its parent.
 */
const spawnling = (sc: Scene, s: Spawn, sh: Shape, trip: Spawn, k: number): string => {
  const u = sc.S
  const home = homeAt(s)
  const isAsleep = s.doneAt !== undefined && home === undefined
  const lift = liftOf(sh, isAsleep)
  const [fx, fy] = proj(sc, trip.fromX, trip.fromY, groundAt(sc, trip.fromX, trip.fromY))
  const [tx, ty] = proj(sc, trip.x, trip.y, groundAt(sc, trip.x, trip.y))
  const age = (sc.now - trip.movedAt) / 1000
  const crawl = crawlMs(trip) / 1000
  const isCrawling = age >= 0 && age < crawl && Math.hypot(tx - fx, ty - fy) > 1
  const [ax, ay] = age < 0 ? [fx, fy] : [tx, ty]
  const heading = Math.atan2(trip.y - trip.fromY, trip.x - trip.fromX)
  const skin = broodSkin(s)
  const seed = hash(s.id)
  const [bx, by] = off(sc, 0, 0, lift)
  const rx = sh.body * u * 1.05
  const ry = sh.body * u * 0.92
  const parts: string[] = []
  parts.push(`<radialGradient id="sg${k}" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="${skin.light}"/><stop offset=".5" stop-color="${skin.mid}"/><stop offset="1" stop-color="${skin.dark}"/></radialGradient>`)
  parts.push(`<ellipse rx="${n1((sh.body + sh.reach) * u)}" ry="${n1((sh.body + sh.reach) * u * 0.45)}" fill="#000" opacity=".2"/>`)
  if (sc.now - s.bornAt < 3000) {
    const born = `begin="-${((sc.now - s.bornAt) / 1000).toFixed(2)}s" fill="freeze"`
    parts.push(`<ellipse rx="0" ry="0" fill="none" stroke="${skin.light}" stroke-width="1.6"><animate attributeName="rx" values="0;${n1(u * 1.4)}" dur="1s" ${born}/><animate attributeName="ry" values="0;${n1(u * 0.7)}" dur="1s" ${born}/><animate attributeName="opacity" values="1;0" dur="1s" ${born}/></ellipse>`)
  }
  // Eight legs in one stroke, jointed high; sprawled flat asleep.
  let legs = ''
  for (let q = 0; q < 8; q++) {
    const a = heading + ((q + 0.5) / 8) * Math.PI * 2 + (rand2(q, 3, seed) - 0.5) * 0.3
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const spread = sh.body + sh.reach * (isAsleep ? 1.35 : 1.1)
    const root = off(sc, ca * sh.body * 0.7, sa * sh.body * 0.7, lift - sh.body * 0.2)
    const knee = off(sc, ca * (sh.body + sh.reach * 0.55), sa * (sh.body + sh.reach * 0.55), lift + sh.reach * (isAsleep ? 0.18 : 0.45))
    const foot = off(sc, ca * spread, sa * spread, 0)
    legs += `M${pt(root)}L${pt(knee)}L${pt(foot)}`
  }
  parts.push(`<path d="${legs}" fill="none" stroke="${skin.leg}" stroke-width="${n1(Math.max(1, u * (0.03 + sh.body * 0.07)))}" stroke-linejoin="round" stroke-linecap="round"/>`)
  const b0 = blob(bx, by, rx, ry, seed, 7)
  const breathe = detail >= 3 ? `<animate attributeName="d" values="${b0};${blob(bx, by, rx, ry, seed, 8, 1.06)};${b0}" dur="${isAsleep ? 5 : 2.4}s" repeatCount="indefinite"/>` : ''
  parts.push(`<path d="${b0}" fill="url(#sg${k})" stroke="${skin.light}" stroke-opacity=".4" stroke-width=".8">${breathe}</path>`)
  // Its biggest eyes, on the side it heads, in its model's color.
  const eyes = Math.min(sh.eyes, detail >= 2 ? 3 : 1)
  const face: Pt = [Math.cos(heading) * rx * 0.35, Math.sin(heading) * ry * 0.25 - ry * 0.1]
  for (let q = 0; q < eyes; q++) {
    const phi = q * 2.39996 + rand2(q, 11, seed) * 0.4
    const rho = q === 0 ? 0 : 0.42
    const at: Pt = [bx + face[0] + Math.cos(phi) * rho * rx, by + face[1] + Math.sin(phi) * rho * ry * 0.8]
    parts.push(eye(isAsleep ? 'shut' : familyOf(s.model), at[0], at[1], Math.max(1, sh.body * u * (q === 0 ? 0.22 : 0.15)), 3 + rand2(q, 14, seed) * 4, rand2(q, 15, seed) * 6))
  }
  if (isAsleep) {
    parts.push(`<text x="${n0(bx + rx * 0.5)}" y="${n0(by - ry)}" font-size="8" fill="${s.outcome === 'idle' ? '#d8e4ff' : '#ffb4a8'}" font-family="sans-serif" font-weight="700" opacity="0">z<animateMotion path="M0 0l${n0(u * 0.3)} ${n0(-u * 1.2)}" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;0" dur="3s" repeatCount="indefinite"/></text>`)
  }
  if (s.isTeammate === true && s.name !== undefined) {
    parts.push(`<text x="${n0(bx)}" y="${n0(by - ry - u * 0.35)}" text-anchor="middle" font-size="8" fill="#f3ecff" stroke="#120a1a" stroke-width="2" paint-order="stroke" font-family="sans-serif" font-weight="700">${esc(s.name)}</text>`)
  }
  // Home with its answer: it sinks into its parent.
  const sink = home === undefined
    ? ''
    : `<animateTransform attributeName="transform" type="scale" values="1;0" begin="${((home - sc.now) / 1000).toFixed(2)}s" dur="${ABSORB_SECONDS}s" fill="freeze"/>`
  const motion = isCrawling
    ? `<animateMotion path="M${n1(fx)} ${n1(fy)}L${n1(tx)} ${n1(ty)}" dur="${crawl.toFixed(2)}s" begin="-${age.toFixed(2)}s" fill="freeze" ${EASE} keyPoints="0;1"/>`
    : ''
  return `<g class="f"${isCrawling ? '' : ` transform="translate(${n1(ax)} ${n1(ay)})"`}><title>${esc(spawnText(s, sc.now))}</title>${motion}<g>${sink}${parts.join('')}</g></g>`
}

/** A crown over a creature: where its lightning starts, its messages land, its silk is tied. */
const crownOf = (sc: Scene, at: { x: number; y: number }, sh: Shape, isAsleep: boolean): Pt => {
  const [gx, gy] = proj(sc, at.x, at.y, groundAt(sc, at.x, at.y))
  const [ox, oy] = off(sc, 0, 0, liftOf(sh, isAsleep) + sh.body * 0.9)
  return [gx + ox, gy + oy]
}

/**
 * The brood and its threads: each spawnling shown, its tentacles while it
 * works, a silk thread to a parent waiting on it, a count of those not shown
 * beside their nest, and messages thrown between creatures.
 */
const broodWork = (sc: Scene, out: string[], crowns: Map<string, Pt>, mainCrown: Pt | undefined) => {
  const w = sc.world
  const shapes = broodShapes(w, sc.now)
  const { shown, hidden } = shownBrood(sc)
  const places = new Map<string, { x: number; y: number }>()
  const mainAt = w.beast === undefined ? undefined : beastAt(w.beast, sc.now)
  for (const s of w.brood ?? []) places.set(s.id, beastAt(s, sc.now))
  shown.forEach((s, k) => {
    const sh = shapes.get(s.id)
    const here = places.get(s.id)
    if (sh === undefined || here === undefined) return
    const parent = s.parent === undefined ? mainAt : places.get(s.parent)
    const trip = spawnTrip(s, parent)
    const isAsleep = s.doneAt !== undefined && homeAt(s) === undefined
    crowns.set(s.id, crownOf(sc, here, sh, isAsleep))
    const skin = broodSkin(s)
    if (s.doneAt === undefined) out.push(...tentacles(sc, trip, sh, s.id, skin.leg, skin.vein, detail >= 2 ? 3 : 1))
    out.push(spawnling(sc, s, sh, trip, k))
  })
  // Silk from each parent that waits on its child.
  for (const s of shown) {
    if (s.isBackground === true || s.doneAt !== undefined) continue
    const from = s.parent === undefined ? mainCrown : crowns.get(s.parent)
    const to = crowns.get(s.id)
    if (from === undefined || to === undefined) continue
    const sag = 6 + Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.18
    out.push(`<path d="M${pt(from)}Q${n1((from[0] + to[0]) / 2)} ${n1((from[1] + to[1]) / 2 + sag)} ${pt(to)}" fill="none" stroke="#ece8f4" stroke-width=".7" opacity=".7"><title>A silk thread: its parent waits on this spawnling</title></path>`)
  }
  // Too many to draw: a count beside the nest most of the rest came from.
  if (hidden.length > 0) {
    const nests = new Map<number, number>()
    for (const s of hidden) if (s.nest !== undefined) nests.set(s.nest, (nests.get(s.nest) ?? 0) + 1)
    const nest = [...nests.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const at = (nest === undefined ? undefined : sc.tops.get(nest)) ?? mainCrown
    if (at !== undefined) out.push(`<text x="${n0(at[0])}" y="${n0(at[1] - 8)}" text-anchor="middle" font-size="9" fill="#fff" stroke="#000a" stroke-width="2.4" paint-order="stroke" font-family="sans-serif" font-weight="700">+${hidden.length}<title>${hidden.length} more ${hidden.length === 1 ? 'spawnling' : 'spawnlings'} not drawn</title></text>`)
  }
  // Messages: a parcel tossed from the sender over to the recipient.
  for (const e of w.events ?? []) {
    if (e.tool !== 'SendMessage' || e.at <= 0) continue
    const age = (sc.now - e.at) / 1000
    if (age < 0 || age > PARCEL_SECONDS) continue
    const a = e.agent === undefined ? mainCrown : crowns.get(e.agent)
    const b = e.to === 'main' ? mainCrown : e.to === undefined ? undefined : crowns.get(e.to)
    if (a === undefined || b === undefined) continue
    const peak = Math.min(a[1], b[1]) - 20 - Math.abs(b[0] - a[0]) * 0.25
    out.push(`<rect x="-2.5" y="-2" width="5" height="4" rx=".8" fill="#f1e3c0" stroke="#c0392b" stroke-width=".7"><title>A message between creatures</title><animateMotion path="M${pt(a)}Q${n1((a[0] + b[0]) / 2)} ${n1(peak)} ${pt(b)}" dur="${PARCEL_SECONDS}s" begin="-${age.toFixed(2)}s" fill="freeze" rotate="auto"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;.95;1" dur="${PARCEL_SECONDS}s" begin="-${age.toFixed(2)}s" fill="freeze"/></rect>`)
  }
}

/** The creature and everything it does: tentacles and lightning while it works. */
const beastWork = (sc: Scene, out: string[]) => {
  const w = sc.world
  const b = w.beast
  let crown: Pt | undefined
  // The spawnlings' crowns, for their lightning, their silk and their messages.
  const crowns = new Map<string, Pt>()
  if (b !== undefined) {
    const s = beastShape(b, sc.now)
    crown = crownOf(sc, beastAt(b, sc.now), s, asleep(sc, b))
    // Its eyes stay on a child it waits on, when its tentacles hold nothing.
    const child = [...(w.brood ?? [])].reverse().find(q => q.parent === undefined && q.isBackground !== true && q.doneAt === undefined)
    const waitOn = child === undefined ? undefined : proj(sc, beastAt(child, sc.now).x, beastAt(child, sc.now).y, groundAt(sc, child.x, child.y))
    // Asleep, its tentacles go limp.
    if (!asleep(sc, b)) out.push(...tentacles(sc, b, s))
    out.push(creature(sc, b, s, waitOn))
  }
  broodWork(sc, out, crowns, crown)
  for (const event of (w.events ?? []).slice(-30).filter(e => sc.now - e.at < EFFECT_SECONDS * 1000 && e.at > 0 && e.tool !== 'SendMessage')) {
    const age = (sc.now - event.at) / 1000
    const from = event.agent === undefined ? crown : crowns.get(event.agent)
    if (event.tool === 'git-commit') out.push(fireworks(sc, harborPoint(sc) ?? crown ?? [WIDTH / 2, HEIGHT / 3], age, event.id))
    else if (event.tool === 'presence-return') {
      const c = crown ?? proj(sc, 0, 0, sc.sea + 3)
      out.push(`<g opacity="0"><circle cx="${n0(c[0])}" cy="${n0(c[1])}" r="${n0(sc.S * 4)}" fill="url(#tower)"/>${life(age)}<title>Welcome back</title></g>`)
    } else out.push(effect(sc, event, from, age))
  }
}

/** Bursts of colored sparks over the harbor: a commit. */
const fireworks = (sc: Scene, at: Pt, age: number, seed: number): string => {
  const parts: string[] = []
  for (let b = 0; b < 3; b++) {
    const cx = at[0] + (rand2(seed, b, 11) - 0.5) * 80
    const cy = at[1] - 50 - rand2(seed, b, 12) * 50
    const color = ['#ff6b6b', '#ffd93d', '#6bcBff', '#c39bff', '#7dff9e'][(seed + b) % 5]
    const rays = Array.from({ length: 10 }, (_, k) => {
      const a = (k / 10) * Math.PI * 2
      return `M${n0(cx)} ${n0(cy)}l${n0(Math.cos(a) * 16)} ${n0(Math.sin(a) * 16)}`
    }).join('')
    parts.push(`<path d="${rays}" stroke="${color}" stroke-width="1.8" stroke-linecap="round" opacity="0"><animate attributeName="opacity" values="0;1;0" dur="1.5s" begin="${(b * 0.4 - age).toFixed(2)}s" repeatCount="3"/></path>`)
  }
  return `<g><title>A commit</title>${parts.join('')}</g>`
}

/** Where the pier meets the sea, in the drawing's coordinates. */
const harborPoint = (sc: Scene): Pt | undefined => {
  const h = sc.island.harbor
  if (h === undefined) return undefined
  return proj(sc, h.i + 0.5 + h.di * 1.5, h.j + 0.5 + h.dj * 1.5, sc.sea + 0.3)
}

const effect = (sc: Scene, event: Event, crown: Pt | undefined, age: number): string => {
  const kind = toolKind(event.tool)
  const color = TOOL_COLOR[kind] ?? '#ffffff'
  const target = event.target === undefined ? undefined : sc.tops.get(event.target)
  const parts: string[] = []
  if (event.isError === true && target !== undefined) {
    const d = bolt([target[0] + 30, 0], target, event.id, 46)
    parts.push(`<path d="${d}" fill="none" stroke="#ff5a4a" stroke-opacity=".45" stroke-width="7"/><path d="${d}" fill="none" stroke="#ffe0dc" stroke-width="1.8"/>`)
    parts.push(`<circle cx="${n0(target[0])}" cy="${n0(target[1])}" r="${n0(sc.S * 0.9)}" fill="url(#red)"/>`)
  } else if (kind === 'web' && crown !== undefined) {
    // The web: lightning shoots up from the creature.
    const d = bolt(crown, [crown[0] + (rand2(event.id, 1, 3) - 0.5) * 120, 0], event.id, 40)
    parts.push(`<path d="${d}" fill="none" stroke="#9fd0ff" stroke-opacity=".5" stroke-width="7"/><path d="${d}" fill="none" stroke="#ffffff" stroke-width="1.8"/>`)
    parts.push(`<circle cx="${n0(crown[0])}" cy="${n0(crown[1])}" r="${n0(sc.S * 1.4)}" fill="url(#tower)"/>`)
  } else if (target !== undefined) {
    // Where a tentacle grips: a ring of the tool's color spreads.
    parts.push(`<ellipse cx="${n0(target[0])}" cy="${n0(target[1])}" rx="${n0(sc.S * 0.5)}" ry="${n0(sc.S * 0.25)}" fill="none" stroke="${color}" stroke-width="1.6"><animate attributeName="rx" from="${n0(sc.S * 0.2)}" to="${n0(sc.S * 1.4)}" dur="1.2s" begin="-${(age % 1.2).toFixed(2)}s" repeatCount="indefinite"/></ellipse>`)
    if (kind === 'bash') {
      for (let k = 0; k < 6; k++) {
        const a = rand2(event.id, k, 9) * Math.PI * 2
        parts.push(`<circle cx="${n0(target[0] + Math.cos(a) * sc.S * 0.5)}" cy="${n0(target[1] + Math.sin(a) * sc.S * 0.4 - 4)}" r="1.4" fill="#ffb347"/>`)
      }
    }
  } else if (crown !== undefined) {
    parts.push(`<circle cx="${n0(crown[0])}" cy="${n0(crown[1])}" r="${n0(sc.S * 1.1)}" fill="url(#tower)"/>`)
  }
  if (parts.length === 0) return ''
  return `<g opacity="0">${parts.join('')}${life(age)}<title>${esc(`${event.tool}${event.isError === true ? ' failed' : ''}`)}</title></g>`
}

// ---------------------------------------------------------------- creatures

const creatures = (sc: Scene, land: [number, number, number][], out: Map<string, string[]>) => {
  const w = sc.world
  const seed = sc.world.seed
  const pickLand = (k: number, salt: number, prefer?: (b: number) => boolean) => {
    const pool = prefer === undefined ? land : land.filter(c => prefer(c[2]))
    const from = pool.length > 0 ? pool : land
    return from[Math.floor(rand2(k, salt, seed) * from.length)]
  }
  const put = (i: number, j: number, s: string) => {
    const key = `${i},${j}`
    out.set(key, [...(out.get(key) ?? []), s])
  }
  // While you are away from the keyboard the animals sleep where they stand.
  const isAway = w.awaySince !== undefined
  const walker = (cell: [number, number, number] | undefined, k: number, draw: (x: number, y: number) => string, label: string, dur: number, reach = 0.35, sleeps = true) => {
    if (cell === undefined) return
    const [i, j] = cell
    const z = sc.island.level(i, j)
    const a = rand2(k, 77, seed) * Math.PI * 2
    const [x0, y0] = proj(sc, i + 0.5, j + 0.5, z)
    if (isAway && sleeps) {
      put(i, j, `<g transform="translate(${n1(x0)} ${n1(y0)})"><title>${label} (asleep: you are away)</title>${draw(0, 0)}<text x="4" y="${n1(-sc.S * 0.5)}" font-size="7" fill="#e8f0ff" class="pl" font-family="sans-serif">z</text></g>`)
      return
    }
    const [x1, y1] = proj(sc, i + 0.5 + Math.cos(a) * reach, j + 0.5 + Math.sin(a) * reach, z)
    const path = `M0 0L${n1(x1 - x0)} ${n1(y1 - y0)}L0 0`
    put(i, j, `<g transform="translate(${n1(x0)} ${n1(y0)})"><g><title>${label}</title>${draw(0, 0)}<animateMotion path="${path}" dur="${dur}s" keyPoints="0;0;.5;.5;1" keyTimes="0;.3;.5;.8;1" calcMode="linear" repeatCount="indefinite" begin="-${(rand2(k, 78, seed) * dur).toFixed(1)}s"/></g></g>`)
  }
  const u = sc.S
  const t = sc.tone
  // Giants: each program over 2% of the CPU, named and as big as its load.
  for (const [k, p] of (w.system?.procs ?? []).slice(0, 5).entries()) {
    const h = hash(p.name)
    const tall = u * (1.1 + Math.sqrt(p.cpu) * 3.4)
    const skin = hsl(h % 360, 0.35, 0.55)
    const swing = (side: number) => `<animateTransform attributeName="transform" type="rotate" values="${side * 18} 0 ${n1(-tall * 0.45)};${-side * 18} 0 ${n1(-tall * 0.45)};${side * 18} 0 ${n1(-tall * 0.45)}" dur="1.4s" repeatCount="indefinite"/>`
    walker(pickLand(h, 5, b => b === BIOME.meadow || b === BIOME.rock || b === BIOME.dry), h, () =>
      `<g stroke="${t(skin, 0.7)}" stroke-width="${n1(Math.max(1.5, tall * 0.07))}" stroke-linecap="round"><line y1="${n1(-tall * 0.45)}" x2="${n1(-tall * 0.08)}">${swing(1)}</line><line y1="${n1(-tall * 0.45)}" x2="${n1(tall * 0.08)}">${swing(-1)}</line></g><rect x="${n1(-tall * 0.13)}" y="${n1(-tall * 0.82)}" width="${n1(tall * 0.26)}" height="${n1(tall * 0.4)}" rx="${n1(tall * 0.06)}" fill="${t(skin)}"/><circle cy="${n1(-tall * 0.92)}" r="${n1(tall * 0.11)}" fill="${t(skin, 1.1)}"/><circle cx="${n1(tall * 0.04)}" cy="${n1(-tall * 0.94)}" r="${n1(Math.max(0.6, tall * 0.02))}" fill="#111"/>`,
    `${esc(p.name)}: a giant at ${Math.round(p.cpu * 100)}% of the CPU`, 10 + k * 2, 1.1, false)
  }
  lighthouses(sc, put)
  const rabbits = Math.min(8, 2 + w.turn)
  for (let k = 0; k < rabbits; k++) {
    walker(pickLand(k, 1, b => b === BIOME.meadow || b === BIOME.dry), k, () =>
      `<ellipse cy="${n1(-u * 0.08)}" rx="${n1(u * 0.09)}" ry="${n1(u * 0.07)}" fill="${t(k % 3 === 0 ? '#f2efe8' : '#a98a6a')}"/><ellipse cx="${n1(u * 0.06)}" cy="${n1(-u * 0.2)}" rx="${n1(u * 0.02)}" ry="${n1(u * 0.06)}" fill="${t('#a98a6a')}"/>`,
    'A rabbit: the wild multiplies as the conversation grows', 6 + k)
  }
  const deer = Math.min(5, 1 + Math.floor(w.turn / 2))
  for (let k = 0; k < deer; k++) {
    walker(pickLand(k, 2, b => b === BIOME.forest || b === BIOME.meadow), k + 20, () =>
      `<rect x="${n1(-u * 0.14)}" y="${n1(-u * 0.32)}" width="${n1(u * 0.28)}" height="${n1(u * 0.14)}" rx="${n1(u * 0.06)}" fill="${t('#9c6b43')}"/><path d="M${n1(-u * 0.1)} ${n1(-u * 0.18)}v${n1(u * 0.18)}M${n1(u * 0.1)} ${n1(-u * 0.18)}v${n1(u * 0.18)}" stroke="${t('#5b3d27')}" stroke-width="${n1(u * 0.04)}"/><circle cx="${n1(u * 0.16)}" cy="${n1(-u * 0.4)}" r="${n1(u * 0.06)}" fill="${t('#9c6b43')}"/>${k % 2 === 0 ? `<path d="M${n1(u * 0.15)} ${n1(-u * 0.45)}l${n1(-u * 0.04)} ${n1(-u * 0.12)}m${n1(u * 0.06)} ${n1(u * 0.12)}l${n1(u * 0.05)} ${n1(-u * 0.11)}" stroke="${t('#d9c7a8')}" stroke-width="1"/>` : ''}`,
    'A deer: the wild multiplies as the conversation grows', 9 + k * 2)
  }
  // Bugs: the failed calls, circling the ground they scorched; failing tests
  // send more out from the watchtowers.
  const scorched = w.features.filter(f => f.isScorched === true)
  const towers = w.features.filter(f => f.style === 'test')
  const failing = w.tests?.failed ?? 0
  for (let k = 0; k < Math.min(10, w.errors + failing); k++) {
    const f = k < w.errors ? scorched[k % Math.max(1, scorched.length)] : towers[k % Math.max(1, towers.length)] ?? scorched[0]
    if (f === undefined) break
    const z = sc.island.level(f.x, f.y)
    const [x0, y0] = proj(sc, f.x + 0.5, f.y + 0.5, z)
    const r = u * (0.35 + (k % 3) * 0.12)
    const path = `M${n1(r)} 0A${n1(r)} ${n1(r * 0.5)} 0 1 1 ${n1(-r)} 0A${n1(r)} ${n1(r * 0.5)} 0 1 1 ${n1(r)} 0`
    put(f.x, f.y, `<g transform="translate(${n1(x0)} ${n1(y0)})"><g><title>A bug: ${w.errors} tool ${w.errors === 1 ? 'call' : 'calls'} failed this session</title><ellipse rx="${n1(Math.max(1.6, u * 0.07))}" ry="${n1(Math.max(1.1, u * 0.045))}" fill="#b3261e" stroke="#111" stroke-width=".6"/><animateMotion path="${path}" dur="${(3 + k).toFixed(1)}s" rotate="auto" repeatCount="indefinite" begin="-${k}s"/></g></g>`)
  }
}

const ship = (u: number, sail: string, hull = '#6b4a33') =>
  `<path d="M${n1(-u * 0.32)} 0l${n1(u * 0.08)} ${n1(u * 0.12)}h${n1(u * 0.48)}l${n1(u * 0.08)} ${n1(-u * 0.12)}z" fill="${hull}"/><path d="M0 0v${n1(-u * 0.55)}l${n1(u * 0.3)} ${n1(u * 0.45)}z" fill="${sail}"/>`

/**
 * The harbor: a pier at the shore. With a git remote, the branch flies on its
 * flag, commits to push wait at the pier, commits to pull ride offshore. Ships
 * sail in with what the network downloads and out with what it uploads.
 */
const harborLife = (sc: Scene, out: string[]) => {
  const h = sc.island.harbor
  if (h === undefined) return
  const w = sc.world
  const u = sc.S
  const sea = sc.sea + 0.12
  const px = -h.dj
  const py = h.di
  const at = (t: number, side: number, z = sea): Pt => proj(sc, h.i + 0.5 + h.di * t + px * side, h.j + 0.5 + h.dj * t + py * side, z)
  const deck = [at(0.2, -0.17), at(2.4, -0.17), at(2.4, 0.17), at(0.2, 0.17)]
  out.push(`<g><title>The harbor${w.git?.hasRemote === true ? ` · ${w.git.host ?? 'remote'} · branch ${w.git.branch ?? '?'}` : ''}</title><path d="M${deck.map(([x, y]) => `${n0(x)} ${n0(y)}`).join('L')}z" fill="${sc.tone('#8a6a45')}"/>${[0.5, 1.2, 1.9]
    .map(t => {
      const [x0, y0] = at(t, 0.17)
      return `<line x1="${n0(x0)}" y1="${n0(y0)}" x2="${n0(x0)}" y2="${n0(y0 + u * 0.3)}" stroke="${sc.tone('#5b3d27')}" stroke-width="1.4"/>`
    })
    .join('')}</g>`)
  const end = at(2.4, 0)
  if (w.git?.hasRemote === true) {
    const [fx, fy] = at(2.3, 0.1, sea + 0.1)
    const branch = esc(w.git.branch ?? '?')
    out.push(`<g><title>Branch ${branch}${w.git.ahead > 0 ? ` · ${w.git.ahead} to push` : ''}${w.git.behind > 0 ? ` · ${w.git.behind} to pull` : ''}</title><line x1="${n0(fx)}" y1="${n0(fy)}" x2="${n0(fx)}" y2="${n0(fy - u * 1.4)}" stroke="#5b4636" stroke-width="1.2"/><path d="M${n0(fx)} ${n0(fy - u * 1.4)}l${n0(u * 0.6)} ${n0(u * 0.15)}l${n0(-u * 0.6)} ${n0(u * 0.15)}z" fill="#d97757"/><text x="${n0(fx + 3)}" y="${n0(fy - u * 1.5)}" font-size="${Math.max(7, n0(u * 0.32))}" fill="#fff8ee" stroke="#00000066" stroke-width=".3" font-family="sans-serif">${branch}</text></g>`)
    for (let k = 0; k < Math.min(4, w.git.ahead); k++) {
      const [sx, sy] = at(0.9 + k * 0.5, k % 2 === 0 ? 0.45 : -0.45)
      out.push(`<g transform="translate(${n0(sx)} ${n0(sy)})"><title>A commit waiting to be pushed</title>${ship(u, '#f6f1e8')}<rect x="${n1(-u * 0.12)}" y="${n1(-u * 0.12)}" width="${n1(u * 0.14)}" height="${n1(u * 0.1)}" fill="#c89b62"/></g>`)
    }
    for (let k = 0; k < Math.min(4, w.git.behind); k++) {
      const [sx, sy] = at(3.6 + k * 0.7, (k % 2 === 0 ? 1 : -1) * (0.6 + k * 0.2))
      out.push(`<g transform="translate(${n0(sx)} ${n0(sy)})"><title>A commit to pull, waiting offshore</title>${ship(u, '#9fc4e8')}</g>`)
    }
  }
  // Network traffic: ships sail in with downloads, out with uploads.
  const flow = throughput(w)
  const rim = sc.island.seaRadius - 0.8 - Math.hypot(h.i + 0.5 + h.di * 2.4, h.j + 0.5 + h.dj * 2.4)
  const far = at(2.4 + Math.max(1, rim), 0)
  for (const [rate, inbound] of [[flow.down, true], [flow.up, false]] as const) {
    const count = Math.ceil(rate * 4)
    const dur = (14 - rate * 9).toFixed(1)
    const [a, b] = inbound ? [far, end] : [end, far]
    for (let k = 0; k < count; k++) {
      out.push(`<g><title>${inbound ? 'Downloads sailing in' : 'Uploads sailing out'}</title>${ship(u * 0.8, inbound ? '#ffe9b0' : '#c9f0d6', '#4a3a2c')}<animateMotion path="M${n0(a[0])} ${n0(a[1])}L${n0(b[0])} ${n0(b[1])}" dur="${dur}s" begin="-${((k * Number(dur)) / count).toFixed(1)}s" repeatCount="indefinite"/></g>`)
    }
  }
}

/** Lighthouses on the shore: dev servers listening on this machine. */
const lighthouses = (sc: Scene, put: (i: number, j: number, s: string) => void) => {
  const u = sc.S
  for (const p of sc.world.system?.ports ?? []) {
    const spot = sc.island.coast(((hash(String(p.port)) % 360) * Math.PI) / 180)
    if (spot === undefined) continue
    const z = sc.island.level(spot.i, spot.j)
    const parts: string[] = []
    box(sc, spot.i + 0.5, spot.j + 0.5, 0.14, 0.14, z, z + 2.2, '#f4f1ea', undefined, parts)
    for (const band of [0.6, 1.4]) box(sc, spot.i + 0.5, spot.j + 0.5, 0.145, 0.145, z + band, z + band + 0.3, '#c0392b', undefined, parts)
    const [lx, ly] = proj(sc, spot.i + 0.5, spot.j + 0.5, z + 2.4)
    parts.push(`<circle cx="${n0(lx)}" cy="${n0(ly)}" r="${n0(u * 0.16)}" fill="#fff3c4"/><path d="M${n0(lx)} ${n0(ly)}l${n0(u * 3)} ${n0(-u * 0.5)}v${n0(u)}z" fill="url(#beam)" opacity=".7"><animateTransform attributeName="transform" type="rotate" from="0 ${n0(lx)} ${n0(ly)}" to="360 ${n0(lx)} ${n0(ly)}" dur="5s" repeatCount="indefinite"/></path>`)
    put(spot.i, spot.j, `<g><title>${esc(p.name)} listening on :${p.port}</title>${parts.join('')}</g>`)
  }
}

const seaLife = (sc: Scene, out: string[]) => {
  const w = sc.world
  const seed = w.seed
  const isl = sc.island
  const u = sc.S
  // Fish leap in the near half of the sea; the fuller the context, the more.
  const fish = detail >= 1 ? Math.min(7, 2 + Math.floor(w.tide / 15)) : 0
  for (let k = 0; k < fish; k++) {
    const a = Math.PI * (0.15 + rand2(k, 60, seed) * 0.7) - Math.atan2(sc.s, sc.c) + Math.PI / 2
    const r = isl.R * 0.95 + rand2(k, 61, seed) * (isl.seaRadius - isl.R * 0.95 - 0.6)
    const wx = Math.cos(a) * r
    const wy = Math.sin(a) * r
    if (depth(sc, wx, wy) < 0) continue
    const [x, y] = proj(sc, wx, wy, isl.sea)
    const hop = u * 1.2
    const dur = 4 + rand2(k, 62, seed) * 4
    out.push(`<g opacity="0"><title>A fish: the sea fills with them as the context fills</title><ellipse rx="${n1(Math.max(2, u * 0.12))}" ry="${n1(Math.max(1, u * 0.05))}" fill="${hsl([20, 200, 45, 330][k % 4]!, 0.7, 0.55)}"/><animateMotion path="M${n1(x - hop / 2)} ${n1(y)}Q${n1(x)} ${n1(y - hop * 1.4)} ${n1(x + hop / 2)} ${n1(y)}" dur="${dur.toFixed(1)}s" keyPoints="0;0;1;1" keyTimes="0;.7;.9;1" rotate="auto" repeatCount="indefinite" begin="-${(rand2(k, 63, seed) * dur).toFixed(1)}s"/><animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;.69;.7;.9;.91;1" dur="${dur.toFixed(1)}s" repeatCount="indefinite" begin="-${(rand2(k, 63, seed) * dur).toFixed(1)}s"/></g>`)
  }
  // A sea serpent surfaces when the context grows crowded.
  if (w.tide >= 65) {
    const r = (isl.R * 0.95 + isl.seaRadius) / 2
    const pts: Pt[] = []
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI - Math.atan2(sc.s, sc.c) + Math.PI / 2 - Math.PI / 2 + Math.PI
      pts.push(proj(sc, Math.cos(a) * r, Math.sin(a) * r, isl.sea))
    }
    const path = `M${pts.map(([x, y]) => `${n0(x)} ${n0(y)}`).join('L')}`
    for (let k = 0; k < 6; k++) {
      const s = u * (0.34 - k * 0.035)
      out.push(`<g><title>The sea serpent: the context is crowded (tide ${Math.round(w.tide)}%)</title><path d="M${n1(-s)} 0A${n1(s)} ${n1(s)} 0 0 1 ${n1(s)} 0Z" fill="${k % 2 ? '#1f7a6a' : '#2a9a84'}"/>${k === 0 ? `<circle cx="${n1(s * 0.4)}" cy="${n1(-s * 0.55)}" r="${n1(Math.max(1, s * 0.15))}" fill="#ffe066"/>` : ''}<animateMotion path="${path}" dur="40s" repeatCount="indefinite" begin="-${(k * 0.9).toFixed(1)}s"/></g>`)
    }
  }
  // Birds wheel above; at night they are bats.
  const birds = detail >= 1 ? Math.min(12, 3 + 2 * w.features.filter(f => f.kind === 'windmill').length + Math.floor(w.lanterns.length / 2)) : 0
  for (let k = 0; k < birds; k++) {
    const cy = 60 + rand2(k, 70, seed) * 160
    const rx = 200 + rand2(k, 71, seed) * 160
    const ry = 30 + rand2(k, 72, seed) * 40
    const dur = (30 + rand2(k, 73, seed) * 30).toFixed(0)
    const c = sc.isNight ? '#2b2230' : '#f4f4f2'
    const wing = 'M-6 0q3-4 6 0q3-4 6 0'
    const up = 'M-6-3q3 1 6 3q3-2 6-3'
    out.push(`<g><title>${sc.isNight ? 'A bat, out for the night' : 'A seabird: the web and your ideas bring them'}</title><path d="${wing}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"><animate attributeName="d" values="${wing};${up};${wing}" dur="${sc.isNight ? '.3' : '.6'}s" repeatCount="indefinite"/></path><animateMotion path="M${380 - rx} ${n0(cy)}A${n0(rx)} ${n0(ry)} 0 1 1 ${380 + rx} ${n0(cy)}A${n0(rx)} ${n0(ry)} 0 1 1 ${380 - rx} ${n0(cy)}" dur="${dur}s" repeatCount="indefinite" begin="-${(rand2(k, 74, seed) * Number(dur)).toFixed(0)}s"/></g>`)
  }
  // Butterflies when you are glad.
  if (w.mood.joy > 0.3 && !sc.isNight && w.mood.storm < 0.5) {
    for (let k = 0; k < Math.round(w.mood.joy * 8); k++) {
      const a = rand2(k, 80, seed) * Math.PI * 2
      const d = rand2(k, 81, seed) * isl.R * 0.8
      const [x, y] = proj(sc, Math.cos(a) * d, Math.sin(a) * d, 4)
      const c = hsl([45, 330, 200, 280, 20][k % 5]!, 0.8, 0.62)
      out.push(`<g><path d="M0 0l-3-3v5zM0 0l3-3v5z" fill="${c}"><animateTransform attributeName="transform" type="scale" values="1 1;.2 1;1 1" dur=".25s" repeatCount="indefinite"/></path><animateMotion path="M${n0(x)} ${n0(y)}c20-20 40 10 20 25s-35-5-20-25" dur="${(5 + k).toFixed(0)}s" repeatCount="indefinite"/></g>`)
    }
  }
}

// ---------------------------------------------------------------- the whole picture

const STYLE = [
  '.f:hover{filter:brightness(1.25) drop-shadow(0 0 3px #fff)}',
  '.t>path{stroke:#0000001a;stroke-width:.5}',
  '@keyframes drift{from{transform:translateX(-260px)}to{transform:translateX(1020px)}}',
  '.cl{animation:drift linear infinite}',
  '@keyframes smoke{0%{transform:translate(0,0) scale(.5);opacity:0}15%{opacity:.45}100%{transform:translate(7px,-26px) scale(1.5);opacity:0}}',
  '.sm{animation:smoke 3.2s ease-out infinite;transform-box:fill-box;transform-origin:center}',
  '@keyframes tw{0%,100%{opacity:.15}50%{opacity:1}}',
  '.tw{animation:tw 3s ease-in-out infinite}',
  '@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
  '.bb{animation:bob 4s ease-in-out infinite}',
  '.tw.bb{animation:tw 3s ease-in-out infinite,bob 5s ease-in-out infinite}',
  `@keyframes fall{from{transform:translate(0,0)}to{transform:translate(-40px,${HEIGHT + 40}px)}}`,
  '.rn{animation:fall .7s linear infinite}',
  '@keyframes flash{0%,88%,92%,95%,100%{opacity:0}89%{opacity:.6}93%{opacity:.35}}',
  '.fl{animation:flash 8s infinite}',
  '@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.95}}',
  '.pl{animation:pulse 2.6s ease-in-out infinite}',
  '@keyframes flick{0%,100%{opacity:1}50%{opacity:.6}}',
  '.fk{animation:flick .4s steps(2) infinite}',
  '@keyframes wave{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(10px) scaleY(1.2)}}',
  '.au{animation:wave 8s ease-in-out infinite;transform-box:fill-box;transform-origin:center}',
  '@keyframes gust{from{transform:translateX(-160px)}to{transform:translateX(960px)}}',
  '.gs{animation:gust 1.5s linear infinite}',
  '@keyframes shim{0%,100%{opacity:.08}50%{opacity:.5}}',
  '.sh{animation:shim 4s ease-in-out infinite}',
  '@keyframes flow{to{stroke-dashoffset:-14}}',
  '.fw{animation:flow .9s linear infinite}',
  '@keyframes lava{0%,100%{opacity:1}50%{opacity:.7}}',
  '.lv{animation:lava 2.2s ease-in-out infinite}',
  '@keyframes fallw{to{stroke-dashoffset:-12}}',
  '.wf{animation:fallw .5s linear infinite}',
  '@keyframes haze{0%,100%{transform:translateX(0);opacity:.2}50%{transform:translateX(3px);opacity:.6}}',
  '.hz{animation:haze 1.6s ease-in-out infinite}',
  '.iv{fill:none;stroke-linecap:round;stroke-dasharray:1.3 2.2}',
  '.dn{font:700 9px sans-serif;fill:#fff;text-anchor:middle;paint-order:stroke;stroke:#000a;stroke-width:2.4px;letter-spacing:.05em}',
].join('')

const defs = (phase: Phase): string => {
  const [top, bottom] = SKY[phase]
  return `<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#03050c"/><stop offset="1" stop-color="#0b1024"/></linearGradient>
<radialGradient id="air"><stop offset="0" stop-color="${bottom}" stop-opacity=".55"/><stop offset=".55" stop-color="${top}" stop-opacity=".3"/><stop offset="1" stop-color="${top}" stop-opacity="0"/></radialGradient>
<radialGradient id="sun"><stop offset="0" stop-color="#fff3c4" stop-opacity=".9"/><stop offset="1" stop-color="#fff3c4" stop-opacity="0"/></radialGradient>
<radialGradient id="glow"><stop offset="0" stop-color="#ffb347" stop-opacity=".95"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2"><stop offset="0" stop-color="#d9b8ff" stop-opacity=".8"/><stop offset="1" stop-color="#8a5cff" stop-opacity="0"/></radialGradient>
<radialGradient id="beam"><stop offset="0" stop-color="#fff6c8" stop-opacity=".95"/><stop offset="1" stop-color="#ffe17a" stop-opacity="0"/></radialGradient>
<radialGradient id="tower"><stop offset="0" stop-color="#fff2cc" stop-opacity=".95"/><stop offset=".35" stop-color="#ffc861" stop-opacity=".45"/><stop offset="1" stop-color="#ff9a3c" stop-opacity="0"/></radialGradient>
<radialGradient id="hot"><stop offset="0" stop-color="#fff0c0" stop-opacity=".9"/><stop offset=".5" stop-color="#ffcf6a" stop-opacity=".35"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
<radialGradient id="red"><stop offset="0" stop-color="#ffd0c8" stop-opacity=".9"/><stop offset="1" stop-color="#ff3b2f" stop-opacity="0"/></radialGradient>
<radialGradient id="lan"><stop offset="0" stop-color="#ffd27a" stop-opacity=".9"/><stop offset="1" stop-color="#ff9a3c" stop-opacity="0"/></radialGradient>
<linearGradient id="beamv" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff2cc"/><stop offset="1" stop-color="#ffc861" stop-opacity="0"/></linearGradient>
<linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fa7c9"/><stop offset="1" stop-color="#145a7a"/></linearGradient>
<linearGradient id="rock" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f4842"/><stop offset=".3" stop-color="#7c5f45"/><stop offset=".55" stop-color="#8f7a62"/><stop offset=".8" stop-color="#6f655b"/><stop offset="1" stop-color="#5f5852"/></linearGradient>
<linearGradient id="under" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5f5852"/><stop offset="1" stop-color="#2a2622"/></linearGradient>
<linearGradient id="aurora0" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4dffb0" stop-opacity="0"/><stop offset=".5" stop-color="#4dffb0"/><stop offset="1" stop-color="#7a5cff" stop-opacity="0"/></linearGradient>
<linearGradient id="aurora1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b06bff" stop-opacity="0"/><stop offset=".5" stop-color="#6bd6ff"/><stop offset="1" stop-color="#4dffb0" stop-opacity="0"/></linearGradient>
<radialGradient id="vig" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".42"/></radialGradient>
<filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
<radialGradient id="shadow"><stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<radialGradient id="shog" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="#7d4b98"/><stop offset=".5" stop-color="#3b1a4c"/><stop offset="1" stop-color="#12071a"/></radialGradient>
<ellipse id="ey" rx="1" ry=".8" fill="#efe9cf"/>
<g id="ei"><circle r=".6" fill="#b8ff3a"/><ellipse rx=".14" ry=".52" fill="#0b0610"/><circle cx="-.28" cy="-.28" r=".18" fill="#fff"/></g>
<g id="eis"><circle r=".6" fill="#ffc43a"/><use href="#ep"/></g>
<g id="eih"><circle r=".6" fill="#8fe6ff"/><use href="#ep"/></g>
<g id="eif"><circle r=".6" fill="#ff7ad1"/><use href="#ep"/></g>
<g id="eio"><circle r=".6" fill="#e8e2ff"/><use href="#ep"/></g>
<g id="ep"><ellipse rx=".14" ry=".52" fill="#0b0610"/><circle cx="-.28" cy="-.28" r=".18" fill="#fff"/></g>
<g id="eh"><circle r="1.7" fill="url(#lan)"/><ellipse rx="1" ry=".8" fill="#fff4dc"/></g>
<g id="ea"><circle r=".62" fill="#ffb340"/><ellipse rx=".15" ry=".54" fill="#2a1200"/><circle cx="-.28" cy="-.28" r=".18" fill="#fff"/></g>
<g id="ez"><ellipse rx="1" ry=".5" fill="#2b1438"/><path d="M-.9 0q.9.6 1.8 0" fill="none" stroke="#d9c2f0" stroke-width=".2"/></g>`
}

export type RenderOptions = { hour: number; now?: number }

/**
 * The 3D window's own picture, sent while it is open: the image, and over it
 * an invisible spot for each thing, so hovering still says what it is.
 */
export const mirrorSvg = (m: { jpeg: string; labels: [number, number, string][] }): string => {
  const badge = '<g><rect x="8" y="8" width="104" height="20" rx="6" fill="#0b0f1cc4"/><text x="16" y="22" font-size="11" fill="#ffe3c2" font-family="sans-serif">● live from 3D</text></g>'
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}"><image href="data:image/jpeg;base64,${m.jpeg}" width="${WIDTH}" height="${HEIGHT}"/>`
  let spots = ''
  for (const [x, y, text] of m.labels) {
    const spot = `<circle cx="${x}" cy="${y}" r="11" fill="#fff" fill-opacity="0"><title>${esc(text)}</title></circle>`
    if (open.length + spots.length + spot.length + badge.length + 6 > BUDGET) break
    spots += spot
  }
  return `${open}${spots}${badge}</svg>`
}

/** The richest drawing that fits the surface's limit on an SVG's size. */
export const renderSvg = (world: World, view: View, options: RenderOptions): string => {
  const island = buildIsland(world)
  let svg = ''
  for (const level of [3, 2, 1, 0]) {
    detail = level
    svg = paint(world, island, view, options)
    if (svg.length <= BUDGET) break
  }
  detail = 3
  return svg
}

const paint = (world: World, island: Island, view: View, { hour, now = 0 }: RenderOptions): string => {
  const phase = phaseOf(hour)
  const { R, seaRadius, sea, G } = island
  const yaw = (view.yaw * Math.PI) / 180
  // A little smaller than the width, and above the middle: the turtle swims beneath.
  const S = ((WIDTH * 0.4) / seaRadius) * (view.zoom ?? 1)
  const haze = SKY[phase][1]
  const sc: Scene = {
    world,
    island,
    sea,
    S,
    Z: S * 0.36,
    c: Math.cos(yaw),
    s: Math.sin(yaw),
    ox: WIDTH / 2,
    oy: HEIGHT * 0.42,
    tone: makeTone(phase, world.mood.storm, haze, false),
    flat: makeTone(phase, world.mood.storm, haze, true),
    phase,
    isNight: phase === 'night',
    now,
    features: new Map(world.features.map(f => [`${f.x},${f.y}`, f])),
    tops: new Map(),
    anchors: new Map(),
    bridges: [],
    tested: new Map(),
    kits: kitsOf(world),
    busy: new Set(busyOf(world, now)),
    walks: walksOf(world, now),
    // Detail by distance from the work: the dozen buildings worked last stay a step finer.
    near: new Set(world.features.filter(f => glowOf(f.touchedAt, now) > 0).sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0)).slice(0, 12).map(f => f.id)),
  }
  sc.bridges = bridgesOf(world)
  sc.tested = testsOf(world, sc.bridges)

  const back: string[] = []
  const front: string[] = []
  skyLayer(sc, hour, back, front)

  // The disc on the turtle's back, in its glow of air: the turtle beneath, the
  // rock of the rim, the sea's face you see the seabed through.
  const bottom = BOTTOM
  const [px, pyTop] = proj(sc, 0, 0, sea)
  const pyFoot = proj(sc, 0, 0, turtleOf(sc).foot)[1]
  const rx = seaRadius * S
  const ry = seaRadius * S * 0.5
  const seaPath = `M${n1(px - rx)} ${n1(pyTop)}A${n1(rx)} ${n1(ry)} 0 1 0 ${n1(px + rx)} ${n1(pyTop)}A${n1(rx)} ${n1(ry)} 0 1 0 ${n1(px - rx)} ${n1(pyTop)}Z`
  back.push(`<ellipse cx="${n1(px)}" cy="${n1(pyTop - ry * 0.35)}" rx="${n1(rx * 1.5)}" ry="${n1(ry * 2)}" fill="url(#air)"/>`)
  turtleLayer(sc, back)
  const rimFalls: string[] = []
  discLayer(sc, px, pyTop, pyFoot, rx, ry, back, rimFalls)
  back.push(`<clipPath id="tankclip"><path d="${seaPath}"/></clipPath>`)

  // Every cell, back to front.
  const cells: { i: number; j: number; d: number; level: number }[] = []
  const land: [number, number, number][] = []
  for (let i = -G; i < G; i++) {
    for (let j = -G; j < G; j++) {
      if (!island.inside(i, j)) continue
      const level = Math.max(island.level(i, j), bottom)
      cells.push({ i, j, d: depth(sc, i + 0.5, j + 0.5), level })
      const b = island.biome[island.index(i, j)] ?? 0
      if (level > sea + 0.3 && b !== BIOME.river && b !== BIOME.lava && b !== BIOME.seabed && !sc.features.has(`${i},${j}`)) land.push([i, j, b])
    }
  }
  cells.sort((a, b) => a.d - b.d)
  const critters = new Map<string, string[]>()
  if (detail >= 1) creatures(sc, land, critters)

  const marks = streetMarks(sc)
  const districts = districtMarks(sc, districtsOf(world))
  const under = new Layer()
  under.raw(`<path d="${seaPath}" fill="#0d3c57"/>`)
  const ground = new Layer()
  const falls = new Map(island.waterfalls.map(f => [`${f.i},${f.j}`, f]))

  for (const cell of cells) {
    const { i, j, level } = cell
    const at = island.index(i, j)
    const b = island.biome[at] ?? 0
    const feature = sc.features.get(`${i},${j}`)
    const corners: [number, number][] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]
    const v = 0.9 + 0.2 * noise(i * 0.7, j * 0.7, island.seed + 21)
    if (level <= sea) {
      if (detail >= 2 || level > sea - 1.5) {
        under.face(rel(corners.map(([x, y]) => proj(sc, x, y, level))), sc.flat(GROUND[BIOME.seabed]!, v))
      }
      if (feature !== undefined) {
        const sunk: string[] = []
        drawFeature(sc, feature, level, sunk)
        under.raw(`<g opacity=".6">${sunk.join('')}</g>`)
      }
      continue
    }
    const hazeK = Math.max(0, Math.min(0.35, (-cell.d / (seaRadius * 2) + 0.15) * 0.6))
    // Walls toward the camera, down to the lower neighbour or the sea.
    const edges: [number, number, number, number, number, number][] = [
      [i + 1, j, i + 1, j + 1, 1, 0],
      [i, j + 1, i, j, -1, 0],
      [i + 1, j + 1, i, j + 1, 0, 1],
      [i, j, i + 1, j, 0, -1],
    ]
    for (const [x1, y1, x2, y2, nx, ny] of edges) {
      if (nx * sc.s + ny * sc.c <= 0) continue
      const neighbour = island.inside(i + nx, j + ny) ? Math.max(island.level(i + nx, j + ny), bottom) : bottom
      const low = Math.max(neighbour, sea)
      if (low >= level) continue
      const wall = b === BIOME.beach ? '#cdb27f' : b === BIOME.lava ? '#3a2218' : level - low > 2.5 ? '#8a7d6e' : '#a4835f'
      ground.face(
        rel([proj(sc, x1, y1, level), proj(sc, x2, y2, level), proj(sc, x2, y2, low), proj(sc, x1, y1, low)]),
        sc.flat(wall, lightOf(nx, ny), hazeK),
      )
      if (neighbour <= sea && detail >= 2) {
        const [a1, b1] = proj(sc, x1, y1, sea)
        const [a2, b2] = proj(sc, x2, y2, sea)
        ground.raw(`<path d="M${n0(a1)} ${n0(b1)}L${n0(a2)} ${n0(b2)}" stroke="#eaf8ff" stroke-width="1.6" stroke-linecap="round" class="sh"/>`)
      }
      const fall = falls.get(`${i},${j}`)
      if (fall !== undefined && fall.ti === i + nx && fall.tj === j + ny) {
        const foot = Math.max(fall.foot, sea)
        const [a1, b1] = proj(sc, x1 + (x2 - x1) * 0.25, y1 + (y2 - y1) * 0.25, level)
        const [a2, b2] = proj(sc, x1 + (x2 - x1) * 0.75, y1 + (y2 - y1) * 0.75, level)
        const drop = (level - foot) * sc.Z
        ground.raw(`<g><title>A waterfall</title><path d="M${n0(a1)} ${n0(b1)}L${n0(a2)} ${n0(b2)}l0 ${n0(drop)}L${n0(a1)} ${n0(b1 + drop)}Z" fill="#cfefff" opacity=".85"/><path d="M${n0((a1 + a2) / 2)} ${n0((b1 + b2) / 2)}v${n0(drop)}" stroke="#fff" stroke-width="2" stroke-dasharray="4 4" class="wf" style="animation-duration:${(0.9 - throughput(world).disk * 0.7).toFixed(2)}s"/></g>`)
      }
    }
    const fill = b === BIOME.river || b === BIOME.lava
      ? sc.flat(GROUND[b]!, v)
      : sc.flat(GROUND[b] ?? GROUND[BIOME.meadow]!, v * (1 - 0.05 * aoOf(island, i, j, level)), hazeK)
    const top = rel(corners.map(([x, y]) => proj(sc, x, y, level)))
    if (b === BIOME.lava) ground.raw(`<path d="${top}" fill="${fill}" class="lv"/>`)
    else ground.face(top, fill)
    if (b === BIOME.river && detail >= 2 && ((i + j) % 2 === 0 || throughput(world).disk > 0.3)) {
      const [rx0, ry0] = proj(sc, i + 0.5, j + 0.5, level)
      ground.raw(`<ellipse cx="${n0(rx0)}" cy="${n0(ry0)}" rx="${n0(S * 0.25)}" ry="${n0(S * 0.06)}" fill="none" stroke="#e8fbff" stroke-width=".8" class="sh"/>`)
    }
    // A district's plot is paved in its own stone; its joints show up close.
    const paved = districts.paving.get(`${i},${j}`)
    if (paved !== undefined) {
      const k = 0.04
      ground.face(rel(([[i + k, j + k], [i + 1 - k, j + k], [i + 1 - k, j + 1 - k], [i + k, j + 1 - k]] as Pt[]).map(([x, y]) => proj(sc, x, y, level))), sc.flat(PAVE_PANE[paved]!, v))
      if (detail >= 3) {
        let joints = ''
        for (const t of [1 / 3, 2 / 3]) {
          joints += `M${pt(proj(sc, i + k, j + t, level))}L${pt(proj(sc, i + 1 - k, j + t, level))}`
          if (paved !== 2) joints += `M${pt(proj(sc, i + t, j + k, level))}L${pt(proj(sc, i + t, j + 1 - k, level))}`
        }
        ground.raw(`<path d="${joints}" stroke="${sc.flat(PAVE_PANE[paved]!, 0.7)}" stroke-width=".6" fill="none"/>`)
      }
    }
    const street = marks.get(`${i},${j}`)
    if (street !== undefined) ground.raw(street.join(''))
    const walls = districts.marks.get(`${i},${j}`)
    if (walls !== undefined) ground.raw(walls.join(''))
    const d = island.decor[at] ?? 0
    if (d !== 0 && detail >= 1 && feature === undefined) {
      const id = DECOR_ID[d]
      if (id !== undefined) {
        const jx = (rand2(i, j, island.seed + 101) - 0.5) * 0.4
        const jy = (rand2(j, i, island.seed + 103) - 0.5) * 0.4
        const [dx, dy] = proj(sc, i + 0.5 + jx, j + 0.5 + jy, level)
        ground.raw(`<use href="#${id}" x="${n0(dx)}" y="${n0(dy)}"/>`)
      }
    }
    if (feature !== undefined) {
      const out: string[] = []
      const kept = detail
      if (sc.near.has(feature.id)) detail = Math.min(3, detail + 1)
      drawFeature(sc, feature, level, out)
      detail = kept
      ground.raw(out.join(''))
    }
    const here = critters.get(`${i},${j}`)
    if (here !== undefined) ground.raw(here.join(''))
  }
  if (island.vent !== undefined) {
    const [vx, vy] = proj(sc, island.vent.i + 0.5, island.vent.j + 0.5, island.level(island.vent.i, island.vent.j))
    const plume: string[] = []
    smoke(vx, vy, S * (1.5 + island.heat), 4, plume, '#3a3534')
    ground.raw(`<g><title>A volcano: errors have heated the ground (${world.errors})</title><circle cx="${n0(vx)}" cy="${n0(vy)}" r="${n0(S * 1.2)}" fill="url(#glow)" class="pl"/>${plume.join('')}</g>`)
  }

  // The sea's face: translucent, its waves as tall as the machine's memory is full.
  const ram = world.system?.ram ?? 0.4
  const seaFace: string[] = []
  seaFace.push(`<ellipse cx="${n1(px)}" cy="${n1(pyTop)}" rx="${n1(rx)}" ry="${n1(ry)}" fill="url(#water)" opacity="${(0.72 - (world.cache ?? 0.6) * 0.25).toFixed(2)}"><title>The lagoon: the prompt cache served ${Math.round((world.cache ?? 0) * 100)}% of the last requests</title></ellipse>`)
  if ((world.cache ?? 0.6) < 0.5) seaFace.push(`<ellipse cx="${n1(px)}" cy="${n1(pyTop)}" rx="${n1(rx)}" ry="${n1(ry)}" fill="#6b7a4a" opacity="${((0.5 - (world.cache ?? 0.6)) * 0.6).toFixed(2)}"/>`)
  const waves = Math.round((detail >= 2 ? 10 : 5) + ram * 14)
  const swell = (1 + ram * 7).toFixed(1)
  for (let k = 0; k < waves; k++) {
    const a = rand2(k, 50, world.seed) * Math.PI * 2
    const d = (0.55 + rand2(k, 51, world.seed) * 0.4) * seaRadius
    const [wx, wy] = proj(sc, Math.cos(a) * d, Math.sin(a) * d, sea)
    const wl = S * (0.6 + ram * 0.9)
    const crest = `M${n0(wx - wl)} ${n0(wy)}q${n0(wl / 2)} ${n1(-Number(swell))} ${n0(wl)} 0t${n0(wl)} 0`
    seaFace.push(`<path d="${crest}" fill="none" stroke="#e8fbff" stroke-width="${(1 + ram).toFixed(1)}" stroke-linecap="round" class="sh" style="animation-delay:-${(k * 0.6).toFixed(1)}s"><animateTransform attributeName="transform" type="translate" values="0 0;0 ${swell};0 0" dur="${(3 - ram).toFixed(1)}s" repeatCount="indefinite" begin="-${(k * 0.37).toFixed(1)}s"/></path>`)
  }

  // Over the town: the rope bridges, and the districts' names.
  const aloft: string[] = []
  bridgeMarks(sc, aloft)
  townsfolk(sc, aloft)
  aloft.push(...districts.names)

  const overlay: string[] = []
  beastWork(sc, overlay)

  // Ideas: lanterns drifting over the island, each holding the question that lit it.
  for (const lantern of world.lanterns) {
    const lx = Math.max(-R, Math.min(R, lantern.x))
    const ly = Math.max(-R, Math.min(R, lantern.y))
    const z = 7 + (lantern.id % 4) * 1.3
    const [x, y] = proj(sc, lx, ly, z)
    const delay = ((lantern.id * 0.77) % 4).toFixed(2)
    overlay.push(`<g class="bb f" style="animation-delay:-${delay}s"><title>${esc(`Idea · turn ${lantern.turn}: ${lantern.text}`)}</title><circle cx="${n1(x)}" cy="${n1(y)}" r="11" fill="url(#lan)" class="pl"/><rect x="${n1(x - 3.5)}" y="${n1(y - 5)}" width="7" height="9" rx="2.5" fill="#ffcf7a" stroke="#c0622d" stroke-width=".6"/></g>`)
  }
  seaLife(sc, overlay)
  const surface: string[] = []
  harborLife(sc, surface)
  if (world.awaySince !== undefined) {
    for (let k = 0; k < 5; k++) {
      const [mx, my] = proj(sc, (rand2(k, 95, world.seed) - 0.5) * R, (rand2(k, 96, world.seed) - 0.5) * R, sea + 1.5)
      front.push(`<ellipse cx="${n0(mx)}" cy="${n0(my)}" rx="${n0(S * 4)}" ry="${n0(S * 0.9)}" fill="#f2f5fa" opacity=".42" class="bb" style="animation-duration:${7 + k}s"><title>Mist: you have been away ${Math.max(1, Math.round((now - world.awaySince) / 60000))} min</title></ellipse>`)
    }
  }
  weatherFront(sc, front)
  // The finish: a warm wash at dawn and dusk, a cool one at night, and a vignette.
  if (phase === 'dawn' || phase === 'dusk') front.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#ff9a3c" opacity=".07"/>`)
  if (phase === 'night') front.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#1d2c6b" opacity=".1"/>`)
  front.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#vig)"/>`)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`,
    `<style>${STYLE}</style>`,
    defs(phase),
    detail >= 1 ? decorDefs(sc) : '',
    '</defs>',
    back.join(''),
    `<g clip-path="url(#tankclip)">${under.text()}</g>`,
    rimFalls.join(''),
    seaFace.join(''),
    surface.join(''),
    `<g class="t">${ground.text()}</g>`,
    aloft.join(''),
    overlay.join(''),
    front.join(''),
    '</svg>',
  ].join('')
}

const aoOf = (island: Island, i: number, j: number, level: number): number => {
  let n = 0
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if ((dx !== 0 || dy !== 0) && island.level(i + dx, j + dy) > level) n++
    }
  }
  return n
}
