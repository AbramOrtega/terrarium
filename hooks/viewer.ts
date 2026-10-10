import type { TerrariumWorld as World } from '../types'
import { buildIsland } from './terrain'
import { bridgesOf, busyOf, districtsOf, hash, kitsOf, streetsOf, walksOf } from './world'

// The fullscreen viewer is a page of its own (viewer/index.html and its
// engine.js, copied to ~/.claude/terrarium). Each frame the mod writes beside
// it carries the whole island; the page draws it in 3D, and reloads itself
// when the engine it was handed is not the one it runs.

export const frameData = (
  world: World,
  version: number,
  stats: string,
  engine: number,
  limitHour: number | null,
  now: number,
  asks: { photo?: number; mirror?: boolean; muted?: boolean } = {},
) => {
  const island = buildIsland(world)
  return {
    version,
    engine,
    now,
    // What the page is asked to do: send its scene for a photo, its picture to the side pane, keep quiet.
    photo: asks.photo ?? 0,
    mirror: asks.mirror ?? false,
    muted: asks.muted ?? false,
    limitHour,
    stats,
    chronicle: world.chronicle,
    island: {
      seed: island.seed,
      G: island.G,
      R: island.R,
      seaRadius: island.seaRadius,
      sea: island.sea,
      heat: island.heat,
      levels: Array.from(island.levels),
      biome: Array.from(island.biome),
      decor: Array.from(island.decor),
      waterfalls: island.waterfalls,
      vent: island.vent ?? null,
      harbor: island.harbor ?? null,
      lighthouses: (world.system?.ports ?? []).flatMap(p => {
        const spot = island.coast(((hash(String(p.port)) % 360) * Math.PI) / 180)
        return spot === undefined ? [] : [{ ...p, ...spot }]
      }),
    },
    // The streets between files that import each other, worked out once for the page.
    streets: streetsOf(world),
    // Folders as districts, and tests joined to what they test.
    districts: districtsOf(world),
    bridges: bridgesOf(world),
    // Each building's kit of parts; the townsfolk's errands; the buildings at work this moment.
    kits: kitsOf(world),
    walks: walksOf(world, now),
    busy: busyOf(world, now),
    world,
  }
}

export const frameScript = (data: ReturnType<typeof frameData>): string =>
  `window.__terrarium && window.__terrarium(${JSON.stringify(data)})\n`

/** The 3D window's key, from 16 random bytes: what its server asks of every request but the page's own code. */
export const viewerKeyOf = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
export const isViewerKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{32}$/.test(key)

/** The server's script with its folder, port and key written where its parameters were. */
export const serverScript = (source: string, root: string, port: number, key: string): string => {
  if (!isViewerKey(key)) throw new Error('the 3D window needs a key')
  const folder = root.replace(/\//g, '\\').replace(/'/g, "''")
  return source.replace(/^param\([^)]*\)/m, () => `$Root = '${folder}'; $Port = ${Math.trunc(port)}; $Key = '${key}'`)
}

const vec = (v: unknown, n: number, fallback: number[]): number[] =>
  Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : fallback
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * The scene the 3D window sent, made fit for Blender: only numbers pass from
 * the page, and the paths (its mesh beside it, the photo's own file) are the mod's.
 */
export const photoScene = (raw: Record<string, unknown>, out: string) => {
  const field = (key: string) => ((raw[key] ?? {}) as Record<string, unknown>)
  const target = vec(field('camera').target, 3, [0, 1, 0])
  return {
    mesh: '../upload/photo-scene.bin',
    stride: 12,
    layout: ['px', 'py', 'pz', 'nx', 'ny', 'nz', 'r', 'g', 'b', 'emissive', 'sway', 'material'],
    out,
    width: 1920,
    height: 1080,
    samples: 96,
    camera: {
      eye: vec(field('camera').eye, 3, [0, 12, 20]),
      target,
      focus: vec(field('camera').focus, 3, target),
      fovY: num(field('camera').fovY, 0.62),
    },
    sun: { dir: vec(field('sun').dir, 3, [0.3, 0.8, 0.5]), color: vec(field('sun').color, 3, [1, 0.95, 0.85]), up: num(field('sun').up, 1) },
    moon: { dir: vec(field('moon').dir, 3, [-0.3, 0.6, -0.5]) },
    night: num(raw.night, 0),
    sky: { zenith: vec(field('sky').zenith, 3, [0.25, 0.45, 0.8]), horizon: vec(field('sky').horizon, 3, [0.7, 0.8, 0.9]) },
    fog: num(raw.fog, 0.0035),
    storm: num(raw.storm, 0),
    sea: {
      level: num(field('sea').level, 0),
      radius: num(field('sea').radius, 14),
      bottom: num(field('sea').bottom, -1.1),
      clarity: num(field('sea').clarity, 0.6),
    },
    // In space: the sun and moon as bodies near the disc, and the dome of air over it (its floor, width, height).
    space: {
      sun: vec(field('space').sun, 3, [10, 20, 10]),
      moon: vec(field('space').moon, 3, [-10, 15, -10]),
      air: vec(field('space').air, 3, [-1.6, 20, 9]),
    },
  }
}
