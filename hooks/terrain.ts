import type { TerrariumWorld as World } from '../types'
import { islandRadius } from './world'

// The island's land, shared by every drawing of it: heights in whole levels,
// a biome per cell, the wild things growing there, rivers and their falls, and
// a volcano once the session's errors have heated the ground.

export const BIOME = {
  seabed: 0,
  beach: 1,
  meadow: 2,
  forest: 3,
  dry: 4,
  rock: 5,
  snow: 6,
  river: 7,
  lava: 8,
  marsh: 9,
} as const

export const DECOR = {
  none: 0,
  pine: 1,
  oak: 2,
  birch: 3,
  bush: 4,
  rock: 5,
  flowers: 6,
  reeds: 7,
  palm: 8,
  snowpine: 9,
  mushroom: 10,
} as const

export const BOTTOM = -2.6

export type Waterfall = { i: number; j: number; ti: number; tj: number; top: number; foot: number }

export type Island = {
  seed: number
  G: number
  R: number
  seaRadius: number
  sea: number
  heat: number
  levels: Int8Array
  biome: Uint8Array
  decor: Uint8Array
  waterfalls: Waterfall[]
  vent: { i: number; j: number } | undefined
  /** Where the harbor's pier meets the land, and the way out to sea. */
  harbor: Coast | undefined
  coast: (angle: number) => Coast | undefined
  inside: (i: number, j: number) => boolean
  index: (i: number, j: number) => number
  level: (i: number, j: number) => number
}

// ---------------------------------------------------------------- noise

export const rand2 = (x: number, y: number, seed: number): number => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

export const noise = (x: number, y: number, seed: number): number => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = smooth(x - xi)
  const v = smooth(y - yi)
  const a = rand2(xi, yi, seed)
  const b = rand2(xi + 1, yi, seed)
  const c = rand2(xi, yi + 1, seed)
  const d = rand2(xi + 1, yi + 1, seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

export const fbm = (x: number, y: number, seed: number) =>
  noise(x, y, seed) * 0.6 + noise(x * 2.1, y * 2.1, seed + 7) * 0.28 + noise(x * 4.3, y * 4.3, seed + 13) * 0.12

const ridged = (x: number, y: number, seed: number) => {
  let sum = 0
  let amp = 0.5
  let freq = 1
  for (let k = 0; k < 3; k++) {
    const n = 1 - Math.abs(noise(x * freq, y * freq, seed + k * 31) * 2 - 1)
    sum += n * n * amp
    amp *= 0.5
    freq *= 2.1
  }
  return sum / 0.875
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** How hot the ground runs: none before the third error, molten by the tenth. */
export const heatOf = (world: World) => Math.max(0, Math.min(1, (world.errors - 2) / 8))

const STEPS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

export const buildIsland = (world: World): Island => {
  const seed = world.seed % 100000
  const R = islandRadius(world)
  const seaRadius = R + 1.5
  const G = Math.ceil(seaRadius) + 1
  const side = G * 2
  const sea = 0.5 + (Math.min(100, world.tide) / 100) * 2.3
  const heat = heatOf(world)
  const index = (i: number, j: number) => (i + G) * side + (j + G)
  const inside = (i: number, j: number) =>
    i >= -G && j >= -G && i < G && j < G && Math.hypot(i + 0.5, j + 0.5) <= seaRadius - 0.5

  // Where the settlement stands: built ground is levelled, and kept clear of wild growth.
  const town = new Uint8Array(side * side)
  const footing = new Uint8Array(side * side)
  for (const f of world.features) {
    if (f.x < -G || f.y < -G || f.x >= G || f.y >= G) continue
    footing[index(f.x, f.y)] = 1
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const i = f.x + dx
        const j = f.y + dy
        if (i >= -G && j >= -G && i < G && j < G && dx * dx + dy * dy <= 4) town[index(i, j)] = 1
      }
    }
  }

  // A volcano wakes where it troubles the town least.
  let vent: { i: number; j: number } | undefined
  if (heat > 0) {
    let best = -1
    for (let k = 0; k < 12; k++) {
      const a = (seed % 628) / 100 + (k * Math.PI * 2) / 12
      const i = Math.floor(Math.cos(a) * R * 0.55)
      const j = Math.floor(Math.sin(a) * R * 0.55)
      const clear = Math.min(99, ...world.features.map(f => Math.hypot(f.x - i, f.y - j)))
      if (clear > best) {
        best = clear
        vent = { i, j }
      }
    }
  }

  const heights = new Float32Array(side * side)
  const levels = new Int8Array(side * side)
  for (let i = -G; i < G; i++) {
    for (let j = -G; j < G; j++) {
      const x = i + 0.5
      const y = j + 0.5
      const dist = Math.hypot(x, y)
      const angle = Math.atan2(y, x)
      const cx = Math.cos(angle)
      const cy = Math.sin(angle)
      const coast = R * (0.74 + 0.38 * fbm(cx * 1.9 + 5, cy * 1.9 + 5, seed) - 0.1 * noise(cx * 4 + 9, cy * 4 + 9, seed + 2))
      const d = dist / coast
      let h = (1 - Math.pow(Math.max(0, d), 1.5)) * 4.6 - Math.max(0, d - 1) * 3
      h += (fbm(x * 0.17, y * 0.17, seed + 3) - 0.5) * 3.4
      const peaks = smoothstep(0.45, 0.72, fbm(x * 0.07 + 20, y * 0.07 + 20, seed + 5))
      h += peaks * ridged(x * 0.13, y * 0.13, seed + 17) * 7.5 * Math.max(0, Math.min(1, 1.15 - d))
      const cliffs = smoothstep(0.55, 0.72, noise(cx * 3 + 30, cy * 3 + 30, seed + 9))
      if (d > 0.8 && d < 1.0) h = Math.max(h, h + (3.4 - h) * cliffs)
      h += 0.6
      if (vent !== undefined) {
        const r = Math.hypot(x - (vent.i + 0.5), y - (vent.j + 0.5))
        if (r < 4.5) h += heat * 7.5 * Math.pow(1 - r / 4.5, 1.25) - (r < 1 ? heat * 2.6 : 0)
      }
      const at = index(i, j)
      if (town[at] === 1) h = h + (Math.max(1.5, Math.min(5.5, h)) - h) * (footing[at] === 1 ? 1 : 0.55)
      heights[at] = h
      levels[at] = Math.max(-4, Math.min(14, Math.round(h)))
    }
  }

  const biome = new Uint8Array(side * side)
  const decor = new Uint8Array(side * side)
  const waterfalls: Waterfall[] = []
  const level = (i: number, j: number) => (i < -G || j < -G || i >= G || j >= G ? -4 : levels[index(i, j)] ?? -4)

  // Rivers: from the high ground, each step to the lowest neighbour, wearing
  // the way down where the land would dam it, until they meet the sea.
  const flow = (fromI: number, fromJ: number, kind: number) => {
    let i = fromI
    let j = fromJ
    const seen = new Set<number>()
    for (let step = 0; step < 90; step++) {
      const here = index(i, j)
      seen.add(here)
      biome[here] = kind
      const current = levels[here] ?? 0
      if (current <= sea) return
      let next: [number, number] | undefined
      let low = 99
      for (const [dx, dy] of STEPS) {
        const ni = i + dx
        const nj = j + dy
        if (!inside(ni, nj)) continue
        const at = index(ni, nj)
        if (seen.has(at) || footing[at] === 1) continue
        const l = (levels[at] ?? 0) + rand2(ni, nj, seed + kind) * 0.5
        if (l < low) {
          low = l
          next = [ni, nj]
        }
      }
      if (next === undefined) return
      const at = index(next[0], next[1])
      const below = Math.min(levels[at] ?? 0, current)
      if (current - below >= 2 && kind === BIOME.river) {
        waterfalls.push({ i, j, ti: next[0], tj: next[1], top: current, foot: below })
      }
      levels[at] = below
      ;[i, j] = next
    }
  }

  if (vent !== undefined && heat > 0.15) flow(vent.i, vent.j, BIOME.lava)
  const sources: [number, number, number][] = []
  for (let i = -G; i < G; i++) {
    for (let j = -G; j < G; j++) {
      const l = level(i, j)
      if (!inside(i, j) || l < 5 || town[index(i, j)] === 1) continue
      sources.push([i, j, l + rand2(i, j, seed + 41)])
    }
  }
  sources.sort((a, b) => b[2] - a[2])
  const springs: [number, number][] = []
  const wanted = 1 + Math.floor(R / 6)
  for (const [i, j] of sources) {
    if (springs.length >= wanted) break
    if (vent !== undefined && Math.hypot(i - vent.i, j - vent.j) < 4) continue
    if (springs.some(([si, sj]) => Math.hypot(si - i, sj - j) < R * 0.6)) continue
    springs.push([i, j])
    flow(i, j, BIOME.river)
  }

  // Biomes and the wild things that grow in them.
  for (let i = -G; i < G; i++) {
    for (let j = -G; j < G; j++) {
      const at = index(i, j)
      if (!inside(i, j)) continue
      const l = levels[at] ?? 0
      if (biome[at] === BIOME.river || biome[at] === BIOME.lava) continue
      if (l <= sea) {
        biome[at] = BIOME.seabed
        continue
      }
      let isShore = false
      let isWet = false
      let steep = 0
      for (const [dx, dy] of STEPS) {
        const n = level(i + dx, j + dy)
        if (n <= sea) isShore = true
        steep = Math.max(steep, l - n)
        for (const [ex, ey] of STEPS) {
          if (biome[index(i + dx + ex, j + dy + ey)] === BIOME.river) isWet = true
        }
      }
      const moisture = fbm(i * 0.11 + 40, j * 0.11 + 40, seed + 11) + (isWet ? 0.16 : 0)
      const above = l - sea
      let b: number = BIOME.meadow
      if (above < 1 && isShore) b = steep >= 3 ? BIOME.rock : BIOME.beach
      else if (l >= 11) b = BIOME.snow
      else if (l >= 8) b = BIOME.rock
      else if (isWet && above < 2 && moisture > 0.5) b = BIOME.marsh
      else if (moisture > 0.58) b = BIOME.forest
      else if (moisture < 0.37) b = BIOME.dry
      biome[at] = b

      if (footing[at] === 1) continue
      let r = rand2(i, j, seed + 77)
      if (town[at] === 1) r = r * 2.6 + 0.12
      let d: number = DECOR.none
      if (b === BIOME.forest) {
        if (r < 0.8) d = l >= 6 ? DECOR.pine : r < 0.28 ? DECOR.birch : r < 0.6 ? DECOR.oak : DECOR.pine
        else if (r < 0.87) d = DECOR.mushroom
      } else if (b === BIOME.meadow) {
        if (r < 0.1) d = DECOR.oak
        else if (r < 0.15) d = DECOR.birch
        else if (r < 0.36) d = DECOR.flowers
        else if (r < 0.44) d = DECOR.bush
        else if (r < 0.47) d = DECOR.rock
      } else if (b === BIOME.dry) {
        if (r < 0.12) d = DECOR.rock
        else if (r < 0.24) d = DECOR.bush
      } else if (b === BIOME.marsh) {
        if (r < 0.55) d = DECOR.reeds
        else if (r < 0.62) d = DECOR.flowers
      } else if (b === BIOME.beach) {
        if (r < 0.11) d = DECOR.palm
        else if (r < 0.17) d = DECOR.rock
      } else if (b === BIOME.rock) {
        if (r < 0.28) d = DECOR.rock
        else if (r < 0.36) d = DECOR.pine
      } else if (b === BIOME.snow) {
        if (r < 0.14) d = DECOR.snowpine
      }
      decor[at] = d
    }
  }

  // The shore along a bearing from the island's heart: the last dry cell before
  // the sea, and which way the water lies. Piers and lighthouses stand there.
  const coast = (angle: number): Coast | undefined => {
    let found: Coast | undefined
    for (let r = 0.5; r < seaRadius; r += 0.35) {
      const i = Math.floor(Math.cos(angle) * r)
      const j = Math.floor(Math.sin(angle) * r)
      if (!inside(i, j)) break
      const at = index(i, j)
      const isDry = (levels[at] ?? 0) > sea && biome[at] !== BIOME.river && biome[at] !== BIOME.lava
      if (!isDry) {
        if (found !== undefined) break
        continue
      }
      if (footing[at] === 1) continue
      const wet = STEPS.find(([dx, dy]) => level(i + dx, j + dy) <= sea)
      if (wet !== undefined) found = { i, j, di: wet[0], dj: wet[1] }
    }
    return found
  }
  const harbor = coast((seed % 360) * (Math.PI / 180) + 2.2) ?? coast((seed % 360) * (Math.PI / 180))

  return {
    seed,
    G,
    R,
    seaRadius,
    sea,
    heat,
    levels,
    biome,
    decor,
    waterfalls,
    vent,
    harbor,
    coast,
    inside,
    index,
    level,
  }
}

export type Coast = { i: number; j: number; di: number; dj: number }
