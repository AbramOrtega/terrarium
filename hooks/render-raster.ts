import type { TerrariumKind as Kind, TerrariumWorld as World } from '../types'
import { BIOME, buildIsland } from './terrain'

// The terminal draws no SVG: there the island is a map seen from above, two
// cells per tile, each landmark a glyph standing on its ground's color.

const GLYPH: Record<Kind, string> = {
  tree: '♣',
  house: '⌂',
  forge: '≡',
  beacon: '†',
  windmill: '×',
  camp: 'Δ',
  crystal: '◊',
  shrine: 'Π',
  signpost: '┼',
  banner: '¶',
  cairn: '•',
  monolith: '█',
  treasury: '$',
}

const INK: Record<Kind, number> = {
  tree: 0x1f4d2a,
  house: 0xc0532d,
  forge: 0x2b211c,
  beacon: 0xfff6c8,
  windmill: 0xf6f1e8,
  camp: 0x7a3b1f,
  crystal: 0xc9a0ff,
  shrine: 0xe3c26b,
  signpost: 0x6b4a2f,
  banner: 0xd97757,
  cairn: 0x5a5650,
  monolith: 0x15151c,
  treasury: 0xf2c94c,
}

const GROUND: Record<number, number> = {
  [BIOME.beach]: 0xe4d29c,
  [BIOME.meadow]: 0x8cc265,
  [BIOME.forest]: 0x4f8b41,
  [BIOME.dry]: 0xbcb46d,
  [BIOME.rock]: 0x8e877c,
  [BIOME.snow]: 0xeef3f6,
  [BIOME.river]: 0x4a9cc4,
  [BIOME.lava]: 0xff6a22,
  [BIOME.marsh]: 0x6f9a5a,
}

export const renderRaster = (world: World, maxColumns: number) => {
  const island = buildIsland(world)
  const half = Math.min(Math.ceil(island.R + 1.5), Math.floor(maxColumns / 4))
  const columns = half * 4
  const rows = half * 2
  const words = new Uint32Array(columns * rows * 3)
  const byCell = new Map(world.features.map(f => [`${f.x},${f.y}`, f]))
  // The creature: a glyph of its own over whatever it straddles, dimmer asleep.
  const b = world.beast
  const lair = b === undefined ? undefined : `${Math.floor(b.x)},${Math.floor(b.y)}`
  for (let row = 0; row < rows; row++) {
    for (let tile = 0; tile < half * 2; tile++) {
      const i = tile - half
      const j = row - half
      const level = island.level(i, j)
      const isWater = !island.inside(i, j) || level <= island.sea
      const biome = island.biome[island.index(i, j)] ?? 0
      const bg = isWater ? (level <= island.sea - 1.5 ? 0x0f4566 : 0x2a7fa3) : GROUND[biome] ?? 0x8cc265
      const feature = byCell.get(`${i},${j}`)
      for (let k = 0; k < 2; k++) {
        const at = (row * columns + tile * 2 + k) * 3
        const isBeast = lair === `${i},${j}` && k === 0
        const isGlyph = feature !== undefined && k === 0
        words[at] = isBeast ? 0x0416 : isGlyph ? GLYPH[feature.kind].codePointAt(0) ?? 32 : isWater && (i + j + k) % 3 === 0 ? 0x7e : 32
        words[at + 1] = isBeast ? (b?.doneAt === undefined ? 0xc77dff : 0x8a6aa8) : isGlyph ? INK[feature.kind] : 0xbfe9ff
        words[at + 2] = bg
      }
    }
  }
  return { columns, rows, cells: new Uint8Array(words.buffer).toBase64() }
}
