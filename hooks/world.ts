import type {
  TerrariumArch as Arch,
  TerrariumBeast as Beast,
  TerrariumEvent as Event,
  TerrariumBridge as Bridge,
  TerrariumDistrict as District,
  TerrariumFeature as Feature,
  TerrariumKind as Kind,
  TerrariumKit as Kit,
  TerrariumMood as Mood,
  TerrariumShape as Shape,
  TerrariumSpawn as Spawn,
  TerrariumStreet as Street,
  TerrariumStyle as Style,
  TerrariumWalk as Walk,
  TerrariumWorld as World,
} from '../types'

// Phyllotaxis: each new landmark takes the next seat on a golden-angle
// spiral, so the island grows outward evenly, oldest at its heart.
const GOLDEN = 2.399963229728653
const SPREAD = 0.82
export const MAX_RADIUS = 16
// The settlement keeps to the heart of the island; the wild grows all around it.
const CORE = 10.8
const MAX_FEATURES = 170
const MAX_LANTERNS = 24
const MAX_CHRONICLE = 5
const MAX_EVENTS = 60

export const emptyWorld = (seed: number): World => ({
  seed,
  slots: 0,
  turn: 0,
  nextId: 1,
  features: [],
  lanterns: [],
  mood: { joy: 0.15, storm: 0, wonder: 0.25, haste: 0 },
  tide: 0,
  compactions: 0,
  tools: 0,
  errors: 0,
  chronicle: ['A small island surfaces from a quiet sea.'],
  isSeeded: false,
})

/** How far the settlement reaches from the island's heart. */
export const townRadius = (world: World): number => SPREAD * Math.sqrt(world.slots + 1) + 2.4

/** The island: the town, and as much wilderness as the project's drive has room. */
export const islandRadius = (world: World): number => {
  const free = world.system?.diskFree ?? 0.5
  return Math.max(6.5, Math.min(MAX_RADIUS, townRadius(world) + 1.2 + free * 9))
}

/**
 * Where the sun stands: the session limit's use, from sunrise at none of it
 * to sunset when it runs out; the clock's hour where no limit is reported.
 */
export const sunHour = (world: World, clockHour: number): number => {
  const limit = world.system?.limit
  if (limit === undefined) return clockHour
  return 6 + Math.max(0, Math.min(1, limit / 100)) * 13
}

/** Where the moon stands across its arc, 0 risen to 1 set: the weekly limit's use. */
export const moonArc = (world: World): number | undefined => {
  const week = world.system?.weekLimit
  return week === undefined ? undefined : Math.max(0, Math.min(1, week / 100))
}

// ---------------------------------------------------------------- the creature

/** Anything that crawls across the island: the creature and its spawnlings. */
type Mover = Pick<Beast, 'x' | 'y' | 'fromX' | 'fromY' | 'movedAt'>

/** How long a crawl takes: the farther, the longer. */
export const crawlMs = (b: Mover): number =>
  Math.max(1200, Math.min(9000, Math.hypot(b.x - b.fromX, b.y - b.fromY) * 900))

const ease = (t: number) => {
  const k = Math.max(0, Math.min(1, t))
  return k * k * (3 - 2 * k)
}

/** Where the creature stands at a moment, partway along its crawl. */
export const beastAt = (b: Mover, at: number) => {
  const k = ease((at - b.movedAt) / crawlMs(b))
  return { x: b.fromX + (b.x - b.fromX) * k, y: b.fromY + (b.y - b.fromY) * k, isCrawling: k > 0 && k < 1 }
}

/**
 * How big the creature has grown: its legs lengthen with the time the turn
 * has run, its body swells with the tokens it has eaten, and it sprouts eyes
 * as it feeds. Once its turn is over it stops growing, and sleeps.
 */
export const beastShape = (b: Pick<Beast, 'bornAt' | 'doneAt' | 'tokens'>, now: number) => {
  const seconds = Math.max(0, ((b.doneAt ?? now) - b.bornAt) / 1000)
  return {
    seconds,
    tokens: b.tokens,
    reach: 0.5 + Math.min(2.6, Math.sqrt(seconds) * 0.075),
    body: Math.min(1.25, 0.2 + 0.11 * Math.log1p(b.tokens / 4000)),
    eyes: Math.min(13, 3 + Math.floor(Math.log2(1 + b.tokens / 25000))),
    isAwake: b.doneAt === undefined,
  }
}

const LAIR_MS = 180_000
const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * The middle of the files worked on in the last few minutes, the freshest
 * pulling hardest: the conversation's creature's own, or a spawnling's.
 */
export const lairOf = (world: World, at: number, agent?: string): { x: number; y: number } | undefined => {
  let sx = 0
  let sy = 0
  let sw = 0
  for (const f of world.features) {
    if (f.touchedAt === undefined || f.by !== agent || !/^(file|read):/.test(f.key)) continue
    const age = Math.max(0, at - f.touchedAt)
    if (age > LAIR_MS) continue
    const weight = 1 - (age / LAIR_MS) * 0.7
    sx += (f.x + 0.5) * weight
    sy += (f.y + 0.5) * weight
    sw += weight
  }
  return sw === 0 ? undefined : { x: round2(sx / sw), y: round2(sy / sw) }
}

/**
 * A new turn wakes the creature where it slept (the first one hatches among
 * the latest work), small again: it grows anew with each turn.
 */
const wake = (world: World, turn: number, prompt: string, at: number): Beast => {
  const last = world.beast
  const spot = last === undefined ? lairOf(world, at) ?? { x: 0, y: 0 } : beastAt(last, last.doneAt ?? at)
  const x = round2(spot.x)
  const y = round2(spot.y)
  return { turn, prompt, bornAt: at, x, y, fromX: x, fromY: y, movedAt: at, tokens: 0, ...(last?.model === undefined ? {} : { model: last.model }) }
}

/** The creature sets off for the middle of what it is working on now. */
const crawl = (world: World, at: number): World => {
  const b = world.beast
  if (b === undefined || b.doneAt !== undefined || at <= 0) return world
  const to = lairOf(world, at)
  if (to === undefined || Math.hypot(to.x - b.x, to.y - b.y) < 0.3) return world
  const here = beastAt(b, at)
  return { ...world, beast: { ...b, fromX: round2(here.x), fromY: round2(here.y), x: to.x, y: to.y, movedAt: at } }
}

// ---------------------------------------------------------------- the brood

const MAX_BROOD = 40
/** How long a spawnling that came home is kept in the record, absorbed. */
const HOME_MS = 120_000
/** How long one may sit silent before it is taken for lost (a loop that died, a run in the cloud). */
const LOST_MS = 30 * 60_000
/** The conversation's creature's own violet: a fork wears it. */
const VIOLET = 280

/** The built-in agent types' colors; any other type takes one from its name, clear of the creature's violet. */
const BROOD_HUES: Record<string, number> = {
  explore: 172,
  plan: 222,
  'general-purpose': 36,
  'claude-code-guide': 335,
  'statusline-setup': 96,
}

export const broodHue = (type: string, name?: string): number => {
  const known = BROOD_HUES[type.toLowerCase()]
  if (known !== undefined) return known
  const h = hash(type === 'teammate' && name !== undefined ? name : type) % 360
  return h >= 250 && h <= 310 ? (h + 75) % 360 : h
}

export type Family = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

/** A model's family, by the id the API gives it: the color of a creature's eyes. */
export const familyOf = (model: string | undefined): Family => {
  const m = (model ?? '').toLowerCase()
  return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : m.includes('fable') ? 'fable' : 'other'
}

/** A model as people say it: `claude-haiku-5-5` is Haiku 5.5. */
export const modelName = (model: string | undefined): string => {
  const family = familyOf(model)
  if (family === 'other') return model === undefined || model === '' ? 'an unknown model' : model
  const version = /(\d+)[-.](\d+)/.exec(model ?? '')
  return `${family[0]!.toUpperCase()}${family.slice(1)}${version === null ? '' : ` ${version[1]}.${version[2]}`}`
}

/** How much smaller than the conversation's creature a spawnling is: three fifths, smaller again each level deeper. */
export const spawnScale = (s: Pick<Spawn, 'depth'>): number => 0.6 * 0.75 ** Math.max(0, s.depth - 1)

/**
 * A spawnling's size, by the creature's own rules on its own time and tokens,
 * scaled down, with fewer eyes; given its parent's size, always a little smaller than it.
 */
export const spawnShape = (s: Spawn, now: number, parent?: { body: number; reach: number }) => {
  const grown = beastShape(s, now)
  const k = spawnScale(s)
  const capBody = parent === undefined ? Infinity : Math.max(0.13, parent.body * 0.8)
  const capReach = parent === undefined ? Infinity : Math.max(0.3, parent.reach * 0.85)
  return {
    ...grown,
    reach: Math.min(capReach, grown.reach * k),
    body: Math.min(capBody, Math.max(0.13, grown.body * k)),
    eyes: Math.min(7, 2 + Math.floor(Math.log2(1 + s.tokens / 25000))),
  }
}

/** A spawnling's size beside its parent's, as both stand at a moment. */
export const broodShapes = (world: World, now: number): Map<string, ReturnType<typeof spawnShape>> => {
  const out = new Map<string, ReturnType<typeof spawnShape>>()
  const main = world.beast === undefined ? undefined : beastShape(world.beast, now)
  for (const s of world.brood ?? []) {
    const parent = s.parent === undefined ? main : out.get(s.parent)
    out.set(s.id, spawnShape(s, now, parent))
  }
  return out
}

/** When a spawnling that finished reaches its parent and is absorbed. */
export const homeAt = (s: Spawn): number | undefined =>
  s.outcome === 'done' && s.doneAt !== undefined ? s.movedAt + crawlMs(s) : undefined

const spawnOf = (world: World, id: string | undefined): Spawn | undefined =>
  id === undefined ? undefined : world.brood?.find(s => s.id === id)

/** Where a spawnling's parent stands at a moment: another spawnling, or the conversation's creature. */
const parentAt = (world: World, s: Pick<Spawn, 'parent'>, at: number) => {
  const p = spawnOf(world, s.parent)
  if (p !== undefined) return beastAt(p, at)
  return world.beast === undefined ? undefined : beastAt(world.beast, at)
}

const withSpawn = (world: World, id: string, change: (s: Spawn) => Spawn): World => ({
  ...world,
  brood: (world.brood ?? []).map(s => (s.id === id ? change(s) : s)),
})

/** What a spawnling is called in the chronicle. */
const spawnName = (s: Spawn | undefined): string =>
  s === undefined ? 'a subagent' : s.isTeammate === true && s.name !== undefined ? s.name : s.isFork === true ? 'the fork' : `the ${s.type} spawnling`

const nestLabel = (type: string, n: number, task: string) =>
  `The ${type} nest · ${n} ${n === 1 ? 'spawnling' : 'spawnlings'} hatched here${task === '' ? '' : ` · the last: ${clip(task, 60)}`}`

/** The brood kept small: those long home are let go first, then the oldest that finished, then the oldest. */
const tidy = (brood: readonly Spawn[], at: number): Spawn[] => {
  const kept = brood.filter(s => {
    const home = homeAt(s)
    return home === undefined || at - home < HOME_MS
  })
  while (kept.length > MAX_BROOD) {
    const k = kept.findIndex(s => s.doneAt !== undefined && s.outcome !== 'idle')
    kept.splice(k === -1 ? 0 : k, 1)
  }
  return kept
}

export type Hatch = {
  id: string
  parent?: string
  type: string
  task: string
  model: string
  isFork?: boolean
  isBackground?: boolean
  isTeammate?: boolean
  name?: string
  run?: string
  rank?: number
}

/**
 * A subagent starts: its parent laid it at its type's nest (woven now if the
 * type has none), and it hatches there. `isCounted` adds its eggshell to the
 * nest; an Agent call already did, so a spawn that came from one is not counted twice.
 */
export const onSpawn = (world: World, h: Hatch, at: number, isCounted = true): World => {
  if (spawnOf(world, h.id) !== undefined) return world
  const type = h.type || 'general-purpose'
  const key = `camp:${type}`
  let w = world
  let nest = w.features.find(f => f.kind === 'camp' && f.key === key)
  // An Agent call that found no nest of its own already laid its egg; it is not laid again.
  if (nest === undefined && isCounted) {
    w = plant(w, 'camp', key, nestLabel(type, 1, h.task), {
      born: `A nest is woven for ${type} spawnlings.`,
      grown: n => `An egg is laid in the ${type} nest (${n}).`,
    })
    nest = w.features.find(f => f.kind === 'camp' && f.key === key) ?? w.features.find(f => f.id === w.focus && f.kind === 'camp')
  } else if (isCounted) {
    const found = nest
    w = { ...w, features: w.features.map(f => (f === found ? { ...f, size: f.size + 1, turn: w.turn, label: nestLabel(type, f.size + 1, h.task) } : f)) }
  }
  const parent = spawnOf(w, h.parent)
  const spot = nest !== undefined ? { x: nest.x + 0.5, y: nest.y + 0.5 } : parentAt(w, h, at) ?? { x: 0, y: 0 }
  const x = round2(spot.x)
  const y = round2(spot.y)
  const spawn: Spawn = {
    id: h.id,
    ...(parent === undefined ? {} : { parent: parent.id }),
    depth: parent === undefined ? 1 : parent.depth + 1,
    type,
    task: clip(h.task, 80),
    model: h.model,
    hue: h.isFork === true ? VIOLET : broodHue(type, h.name),
    ...(h.isFork === true ? { isFork: true } : {}),
    ...(h.isBackground === true ? { isBackground: true } : {}),
    ...(h.isTeammate === true ? { isTeammate: true } : {}),
    ...(h.name === undefined || h.name === '' ? {} : { name: h.name }),
    ...(h.run === undefined ? {} : { run: h.run, rank: h.rank ?? 1 }),
    ...(nest === undefined ? {} : { nest: nest.id }),
    bornAt: at,
    x,
    y,
    fromX: x,
    fromY: y,
    movedAt: at,
    tokens: 0,
    calls: 0,
    lastAt: at,
  }
  // A teammate spawned again under its name replaces the one before.
  const before = (w.brood ?? []).filter(s => !(h.isTeammate === true && s.isTeammate === true && s.name === h.name))
  const next: World = { ...w, brood: tidy([...before, spawn], at) }
  if (h.run !== undefined) return (h.rank ?? 1) <= 1 ? say(next, `A workflow swarm hatches at the ${type} nest.`) : next
  if (h.isTeammate === true) return say(next, `${h.name ?? 'A teammate'} joins the team, a ${type} spawnling.`)
  if (h.isFork === true) return say(next, `The creature lays a fork of itself: “${clip(h.task, 40)}”.`)
  return say(next, `A ${type} spawnling hatches${parent === undefined ? '' : ` from ${spawnName(parent)}`}: “${clip(h.task, 40)}”.`)
}

/**
 * A spawnling at work (a model request, a tool call): its record changes, and
 * one asleep wakes, a teammate where it slept, a finished subagent resumed
 * hatching again beside its parent.
 */
const stir = (world: World, id: string, at: number, change: (s: Spawn) => Partial<Spawn>): World => {
  const s = spawnOf(world, id)
  if (s === undefined) return world
  let next: Spawn = { ...s, ...change(s), ...(at > 0 ? { lastAt: at } : {}) }
  if (s.doneAt !== undefined && at > 0) {
    const { doneAt: _done, outcome: _outcome, answer: _answer, ...awake } = next
    const spot = s.outcome === 'done' ? parentAt(world, s, at) ?? beastAt(s, at) : beastAt(s, at)
    const x = round2(spot.x)
    const y = round2(spot.y)
    next = { ...awake, x, y, fromX: x, fromY: y, movedAt: at }
  }
  return withSpawn(world, id, () => next)
}

/** A spawnling sets off for the middle of its own work; a swarm's leave their nest in file. */
const crawlSpawn = (world: World, id: string, at: number): World => {
  const s = spawnOf(world, id)
  if (s === undefined || s.doneAt !== undefined || at <= 0) return world
  const to = lairOf(world, at, id)
  if (to === undefined || Math.hypot(to.x - s.x, to.y - s.y) < 0.3) return world
  const here = beastAt(s, at)
  const queue = s.run !== undefined && s.calls <= 1 ? Math.min(4000, ((s.rank ?? 1) - 1) * 350) : 0
  return withSpawn(world, id, q => ({ ...q, fromX: round2(here.x), fromY: round2(here.y), x: to.x, y: to.y, movedAt: at + queue }))
}

/**
 * A subagent's run ends. With its answer it crawls home to its parent and is
 * absorbed; a teammate dozes where it stands until a message wakes it; one
 * that failed or was stopped curls up where it stands.
 */
export const onAgentDone = (
  world: World,
  id: string,
  how: { reason: string; answer?: number; isAborted?: boolean },
  at: number,
): World => {
  const s = spawnOf(world, id)
  if (s === undefined || s.doneAt !== undefined || at <= 0) return world
  const here = beastAt(s, at)
  const hx = round2(here.x)
  const hy = round2(here.y)
  const stays = (outcome: NonNullable<Spawn['outcome']>) =>
    withSpawn(world, id, q => ({ ...q, doneAt: at, outcome, x: hx, y: hy, fromX: hx, fromY: hy, movedAt: at }))
  const name = spawnName(s)
  const Name = `${name[0]!.toUpperCase()}${name.slice(1)}`
  if (how.reason === 'answer' && s.isTeammate === true) return stays('idle')
  if (how.reason === 'answer') {
    const home = parentAt(world, s, at) ?? here
    const next = withSpawn(world, id, q => ({
      ...q,
      doneAt: at,
      outcome: 'done',
      answer: how.answer ?? 0,
      fromX: hx,
      fromY: hy,
      x: round2(home.x),
      y: round2(home.y),
      movedAt: at,
    }))
    if (s.run !== undefined) {
      const run = (next.brood ?? []).filter(q => q.run === s.run)
      return run.every(q => q.doneAt !== undefined) ? say(next, `The workflow swarm crawls home: ${run.length} ${run.length === 1 ? 'spawnling' : 'spawnlings'}.`) : next
    }
    const shape = spawnShape(s, at)
    return say(next, `${Name} crawls home with its answer after ${span(shape.seconds)}, ${tally(s.tokens)} tokens and ${s.calls} tool ${s.calls === 1 ? 'call' : 'calls'}.`)
  }
  const isStopped = how.isAborted === true || how.reason === 'aborted'
  return say(stays(isStopped ? 'aborted' : 'failed'), isStopped ? `${Name} is stopped, and curls up where it stands.` : `${Name} stumbles (${how.reason}), and curls up where it stands.`)
}

/**
 * The session's agents as the engine lists them: any spawnling still awake
 * whose run the engine says is over (an end this mod missed) finishes now;
 * one silent for half an hour is taken for lost.
 */
export const onAgentList = (world: World, list: readonly { id: string; status: string }[], at: number): World => {
  const status = new Map(list.map(a => [a.id, a.status]))
  let next = world
  for (const s of world.brood ?? []) {
    if (s.doneAt !== undefined || at - s.lastAt < 60_000) continue
    const now = status.get(s.id)
    if (now === 'completed' || (now === 'idle' && s.isTeammate === true)) next = onAgentDone(next, s.id, { reason: 'answer' }, at)
    else if (now === 'failed') next = onAgentDone(next, s.id, { reason: 'error' }, at)
    else if (now === 'killed') next = onAgentDone(next, s.id, { reason: 'aborted' }, at)
    else if (now === undefined && at - s.lastAt > LOST_MS) next = onAgentDone(next, s.id, { reason: 'lost' }, at)
  }
  return next
}

/** A new prompt: the spawnlings that came home or curled up are let go; teammates and those still at work stay. */
const clearBrood = (world: World, at: number): World => {
  if (world.brood === undefined) return world
  const brood = world.brood.filter(s => {
    if (s.doneAt === undefined || s.outcome === 'idle') return true
    const home = homeAt(s)
    return home !== undefined && at - home < 3000
  })
  return { ...world, brood }
}

/** Who a message is for: `main`, or a spawnling by its name, its agent id or its team address. */
const recipientOf = (world: World, to: string): string | undefined => {
  const bare = to.replace(/\s*\[[^\]]*\]\s*$/, '').trim()
  if (bare === 'main') return 'main'
  const found = [...(world.brood ?? [])].reverse().find(s => s.id === bare || s.name === bare || (s.name !== undefined && bare.startsWith(`${s.name}@`)))
  return found?.id
}

/** A message between creatures: a parcel thrown from the sender to the recipient. */
const onMessage = (world: World, input: Record<string, unknown>, from: string | undefined, at: number): World => {
  const to = str(input.to)
  const target = recipientOf(world, to)
  const event: Event = {
    id: world.tools + 1,
    tool: 'SendMessage',
    at,
    ...(from === undefined ? {} : { agent: from }),
    ...(target === undefined ? {} : { to: target }),
  }
  const next: World = { ...world, tools: world.tools + 1, events: [...(world.events ?? []), event].slice(-MAX_EVENTS) }
  const sender = from === undefined ? 'The creature' : spawnName(spawnOf(world, from))
  const whom = target === 'main' ? 'the creature' : target === undefined ? clip(to, 30) || 'someone' : spawnName(spawnOf(world, target))
  const said = from === undefined ? next : stir(next, from, at, s => ({ calls: s.calls + 1 }))
  return say(said, `${sender[0]!.toUpperCase()}${sender.slice(1)} sends word to ${whom}.`)
}

/** What a spawnling is, for its hover label. */
export const spawnText = (s: Spawn, now: number): string => {
  const shape = spawnShape(s, now)
  const who = s.isTeammate === true && s.name !== undefined
    ? `${s.name}, a ${s.type} teammate`
    : s.isFork === true ? 'A fork of its parent' : `A ${s.type} spawnling`
  const state = s.outcome === 'done' ? 'home with its answer'
    : s.outcome === 'failed' ? 'failed, curled up'
    : s.outcome === 'aborted' ? 'stopped, curled up'
    : s.outcome === 'idle' ? 'asleep until a message comes'
    : s.isBackground === true ? 'at work in the background'
    : 'at work while its parent waits'
  return `${who} · “${s.task}” · ${state} · ${modelName(s.model)} eyes · ${span(shape.seconds)} · ${tally(s.tokens)} tokens · ${s.calls} tool ${s.calls === 1 ? 'call' : 'calls'}`
}

/**
 * Worlds from earlier versions: turn towers and side towers are gone, a
 * creature that burst at its turn's end is asleep instead, buildings a
 * compaction greyed out stand restored (compaction only shrinks the context),
 * the eyes your mid-turn words once opened are gone, and the files' houses
 * learn their language's architecture.
 */
export const upgrade = (world: World): World => {
  const old = world as World & { towerId?: number; wake?: unknown }
  const beast = world.beast as (Beast & { diedAt?: number; heard?: unknown }) | undefined
  const hasTowers = world.features.some(f => ['waystone', 'annex'].includes(f.kind as string))
  const hasOldBeast = beast?.diedAt !== undefined || (beast !== undefined && 'heard' in beast)
  const hasFaded = world.features.some(f => 'isFaded' in f)
  const isUnbuilt = (f: Feature) => /^(file|read):/.test(f.key) && f.lang === undefined
  const hasUnbuilt = world.features.some(isUnbuilt)
  if (!hasTowers && old.towerId === undefined && old.wake === undefined && !hasOldBeast && !hasFaded && !hasUnbuilt) return world
  const { towerId: _gone, wake: _wake, ...rest } = old
  const features = world.features
    .filter(f => !['waystone', 'annex'].includes(f.kind as string))
    .map(f => {
      const { isFaded: _faded, ...kept } = f as typeof f & { isFaded?: boolean }
      return isUnbuilt(kept) ? { ...kept, ...vernacular(kept.key.replace(/^(file|read):/, '')) } : kept
    })
  let next: World = { ...rest, features }
  if (beast !== undefined && hasOldBeast) {
    const { diedAt, heard: _heard, ...kept } = beast
    next = { ...next, beast: diedAt === undefined ? kept : { ...kept, doneAt: kept.doneAt ?? diedAt } }
  }
  return next
}

const span = (seconds: number) =>
  seconds < 90 ? `${Math.round(seconds)}s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`

const tally = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`)

export const hash = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const baseName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const clip = (text: string, n: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const EXTENSION_HUES: Record<string, number> = {
  ts: 210, tsx: 200, js: 48, jsx: 190, mjs: 48, py: 55, rs: 18, go: 185,
  md: 30, json: 280, css: 320, scss: 320, html: 12, java: 25, rb: 350,
  sh: 120, ps1: 230, yml: 160, yaml: 160, toml: 140, sql: 260, c: 220, cpp: 220,
}

const hueFor = (key: string): number => {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase()
  return ext !== undefined && EXTENSION_HUES[ext] !== undefined
    ? EXTENSION_HUES[ext]
    : hash(key) % 360
}

const dirOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '').toLowerCase()

export const styleOf = (path: string): Style => {
  const lower = path.toLowerCase()
  if (/(^|[\\/._-])(tests?|spec|__tests__)([\\/._-]|$)/.test(lower)) return 'test'
  const ext = /\.([a-z0-9]+)$/.exec(lower)?.[1] ?? ''
  if (['md', 'mdx', 'txt', 'rst', 'adoc', 'org'].includes(ext)) return 'doc'
  if (['json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'env', 'lock', 'cfg', 'conf', 'xml'].includes(ext)) return 'config'
  if (['html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'vue', 'svelte'].includes(ext)) return 'web'
  if (['csv', 'tsv', 'sql', 'db', 'sqlite', 'parquet', 'ipynb'].includes(ext)) return 'data'
  return 'code'
}

// ---------------------------------------------------------------- the files themselves

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyi: 'py', rs: 'rs', go: 'go', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  java: 'java', kt: 'kt', kts: 'kt', cs: 'cs', swift: 'swift', rb: 'rb', php: 'php', lua: 'lua',
  css: 'css', scss: 'css', sass: 'css', less: 'css', html: 'html', htm: 'html', vue: 'html', svelte: 'html', svg: 'html',
  md: 'md', mdx: 'md', txt: 'md', rst: 'md', adoc: 'md', org: 'md',
  json: 'json', jsonc: 'json', ipynb: 'json', lock: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml', env: 'toml', xml: 'toml',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'sh', psm1: 'sh', bat: 'sh', cmd: 'sh',
  sql: 'sql', csv: 'sql', tsv: 'sql', db: 'sql', sqlite: 'sql', parquet: 'sql',
}

/** Each language's own color, as GitHub shows it (JSON's near-black is brass here, so its domes read): the accent of its roofs and banners. */
const LANG_COLOR: Record<string, string> = {
  ts: '#3178c6', js: '#f1e05a', py: '#3572a5', rs: '#dea584', go: '#00add8', c: '#555555', cpp: '#f34b7d',
  java: '#b07219', kt: '#a97bff', cs: '#178600', swift: '#f05138', rb: '#701516', php: '#4f5d95', lua: '#000080',
  css: '#563d7c', html: '#e34c26', md: '#083fa1', json: '#b8923a', yaml: '#cb171e', toml: '#9c4221',
  sh: '#89e051', sql: '#e38c00',
}

/** Each language builds in its own architecture; tests stand watch whatever their language. */
const ARCH: Record<string, Arch> = {
  ts: 'townhouse', js: 'townhouse', java: 'townhouse', kt: 'townhouse', cs: 'townhouse', swift: 'townhouse',
  rb: 'townhouse', php: 'townhouse', lua: 'townhouse', py: 'cottage', rs: 'fort', go: 'workshop',
  c: 'keep', cpp: 'keep', css: 'painted', html: 'pavilion', md: 'library',
  json: 'vault', yaml: 'vault', toml: 'vault', sh: 'shed', sql: 'silo',
}

const ARCH_NAME: Record<Arch, string> = {
  townhouse: 'townhouse', cottage: 'cottage', fort: 'iron fort', workshop: 'workshop', keep: 'stone keep',
  painted: 'painted house', pavilion: 'pavilion', library: 'library', vault: 'vault', shed: 'tool shed',
  silo: 'silo', watchtower: 'watchtower',
}

// For languages without a color of their own: quiet earth tones.
const QUIET = ['#8a6d5a', '#5a7d8a', '#7a5a8a', '#5a8a6a', '#8a5a5a', '#6a6a8a']

/** A file's language, from its name. */
export const langOf = (path: string): string =>
  LANG_BY_EXT[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'other'

/** A file's language, the architecture it builds in, and its color. */
export const vernacular = (path: string): { lang: string; arch: Arch; accent: string } => {
  const lang = langOf(path)
  const arch: Arch = styleOf(path) === 'test' ? 'watchtower' : ARCH[lang] ?? 'townhouse'
  return { lang, arch, accent: LANG_COLOR[lang] ?? QUIET[hash(path) % QUIET.length]! }
}

/** What a file's building is called. */
export const buildingOf = (path: string): string => ARCH_NAME[vernacular(path).arch]

// What each kind of file has for parts, types and exports, and how many
// parts make a wing.
type Counter = { parts: RegExp[]; blocks: RegExp[]; exports: RegExp[]; perWing: number; words: [string, string, string] }
const CODE_WORDS: [string, string, string] = ['functions', 'types', 'exports']
// Languages that name their functions with a keyword (Kotlin, Swift, Ruby, PHP, Lua).
const KEYWORD: Counter = {
  parts: [/^\s*(?:[\w@]+\s+)*(?:fun|func|def|function)\s+[\w.:]+/gm],
  blocks: [/^\s*(?:[\w@]+\s+)*(?:class|struct|interface|enum|object|protocol|trait|module)\s+[A-Za-z_]\w*/gm],
  exports: [/^\s*(?:public|export|pub)\b/gm],
  perWing: 5,
  words: CODE_WORDS,
}
// The C family (C, C++, Java, C#) and anything unknown: a function is a typed name, its parameters and a body.
const C_STYLE: Counter = {
  parts: [/^\s*(?:[\w<>,*&:[\]]+\s+)+\**[\w:~]+\s*\([^;{}\n]*\)\s*(?:const\s*)?(?:override\s*)?(?:throws\s+[\w, ]+)?\{?\s*$/gm],
  blocks: [/^\s*(?:[\w@]+\s+)*(?:class|struct|interface|enum|object|protocol|trait|module)\s+[A-Za-z_]\w*/gm],
  exports: [/^\s*(?:public|export|pub)\b/gm],
  perWing: 5,
  words: CODE_WORDS,
}
const COUNTERS: Record<string, Counter> = {
  ts: {
    parts: [
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/gm,
      /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)\n]*\)|[\w$]+)\s*(?::[^=\n]+)?=>/gm,
      /^\s+(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*(?!(?:if|for|while|switch|catch|return|function|else)\b)[\w$]+\s*\([^)\n]*\)\s*(?::\s*[^{\n]+)?\{\s*$/gm,
    ],
    blocks: [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type)\s+[A-Z]\w*/gm],
    exports: [/^\s*export\b/gm, /\bmodule\.exports\b|\bexports\.\w+\s*=/g],
    perWing: 5,
    words: CODE_WORDS,
  },
  py: {
    parts: [/^\s*(?:async\s+)?def\s+\w/gm],
    blocks: [/^\s*class\s+\w/gm],
    exports: [/^(?:async\s+)?def\s+[A-Za-z]|^class\s+[A-Za-z]/gm],
    perWing: 5,
    words: CODE_WORDS,
  },
  rs: {
    parts: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+\w/gm],
    blocks: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+\w/gm],
    exports: [/^pub\s/gm],
    perWing: 5,
    words: CODE_WORDS,
  },
  go: {
    parts: [/^func\s/gm],
    blocks: [/^type\s+\w+\s+(?:struct|interface)\b/gm],
    exports: [/^func\s+(?:\([^)]*\)\s*)?[A-Z]|^type\s+[A-Z]/gm],
    perWing: 5,
    words: CODE_WORDS,
  },
  sh: { parts: [/^\s*(?:function\s+[\w.-]+|[\w.-]+\s*\(\)\s*\{)/gim], blocks: [], exports: [], perWing: 3, words: ['functions', '', ''] },
  css: {
    parts: [/\{/g],
    blocks: [/^\s*@(?:media|supports|layer|container)\b/gm],
    exports: [/^\s*--[\w-]+\s*:/gm],
    perWing: 15,
    words: ['rules', 'media blocks', 'custom properties'],
  },
  html: {
    parts: [/<(?:section|article|nav|header|footer|main|aside|form|table)\b/gi],
    blocks: [/<(?:script|style)\b/gi],
    exports: [/\bid\s*=\s*["']/gi],
    perWing: 3,
    words: ['sections', 'scripts and styles', 'ids'],
  },
  md: { parts: [/^#{1,6}\s/gm], blocks: [/^```[^\n]*\n[\s\S]*?^```/gm], exports: [/\]\(/g], perWing: 4, words: ['headings', 'code blocks', 'links'] },
  json: { parts: [/^\s{0,2}"[^"\n]+"\s*:/gm], blocks: [], exports: [], perWing: 8, words: ['keys', '', ''] },
  yaml: { parts: [/^[\w"'-][^:\n]*:/gm], blocks: [], exports: [], perWing: 8, words: ['keys', '', ''] },
  toml: { parts: [/^\s*\[[^\]\n]+\]/gm, /^[\w.-]+\s*=/gm], blocks: [], exports: [], perWing: 8, words: ['settings', '', ''] },
  sql: {
    parts: [/;/g],
    blocks: [/\bcreate\s+table\b/gi],
    exports: [/\bcreate\s+(?:or\s+replace\s+)?(?:view|function|procedure)\b/gi],
    perWing: 5,
    words: ['statements', 'tables', 'views'],
  },
}
COUNTERS.js = COUNTERS.ts!
for (const lang of ['kt', 'swift', 'rb', 'php', 'lua']) COUNTERS[lang] = KEYWORD
const counterOf = (lang: string): Counter => COUNTERS[lang] ?? C_STYLE

const between = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// What a comment looks like in each language: the marks that start a comment
// line, and the marks that open and close a comment block.
type Commenting = { line: string[]; blocks: [string, string][] }
const SLASHES: Commenting = { line: ['//'], blocks: [['/*', '*/']] }
const COMMENTING: Record<string, Commenting> = {
  py: { line: ['#'], blocks: [['"""', '"""'], ["'''", "'''"]] },
  rb: { line: ['#'], blocks: [['=begin', '=end']] },
  lua: { line: ['--'], blocks: [['--[[', ']]']] },
  sh: { line: ['#', 'rem ', '::'], blocks: [['<#', '#>']] },
  css: SLASHES,
  html: { line: [], blocks: [['<!--', '-->']] },
  md: { line: [], blocks: [['<!--', '-->']] },
  yaml: { line: ['#'], blocks: [] },
  toml: { line: ['#', ';'], blocks: [['<!--', '-->']] },
  sql: { line: ['--'], blocks: [['/*', '*/']] },
  json: { line: [], blocks: [] },
}
const TODO = /\bTODO\b/g
const FIXME = /\b(?:FIXME|XXX|HACK)\b/g

/**
 * Its comment lines, and the notes left in its comments: TODOs (work still
 * to do) and FIXMEs (something known broken). A note counts only in a
 * comment, so code that merely names one is left out; in prose, an unticked
 * task box (`- [ ]`) is a TODO too.
 */
const notesOf = (lang: string, rows: string[]): { comments: number; todos: number; fixmes: number } => {
  const c = COMMENTING[lang] ?? SLASHES
  let comments = 0
  let todos = 0
  let fixmes = 0
  let close: string | undefined
  for (const row of rows) {
    const line = row.trim()
    const lower = line.toLowerCase()
    let said: string | undefined
    if (close !== undefined) {
      said = line
      if (line.includes(close)) close = undefined
    } else if (!line.startsWith('#!') && c.line.some(mark => lower.startsWith(mark))) {
      said = line
    } else {
      const block = c.blocks.find(([open]) => line.startsWith(open))
      if (block !== undefined) {
        said = line
        if (!line.slice(block[0].length).includes(block[1])) close = block[1]
      } else {
        // A comment after code on the same line: only its notes count.
        const at = c.line.map(mark => line.indexOf(mark)).filter(k => k > 0).sort((a, b) => a - b)[0]
        if (at !== undefined) {
          const tail = line.slice(at)
          todos += (tail.match(TODO) ?? []).length
          fixmes += (tail.match(FIXME) ?? []).length
        }
      }
    }
    if (said !== undefined) {
      comments++
      todos += (said.match(TODO) ?? []).length
      fixmes += (said.match(FIXME) ?? []).length
    }
    if (lang === 'md' && /^[-*+]\s+\[ \]/.test(line)) todos++
  }
  return { comments, todos, fixmes }
}

/**
 * A file's shape from its text, counted, never kept: how many lines and how
 * wide they run (the 90th percentile), its parts, types and exports, its
 * comments and the notes in them. The building follows: a floor for every
 * doubling of its length, a footprint as wide as its lines, a wing for every
 * few parts, a tower for each type, a pennant for each export (each up to a
 * few), flower boxes on more of its windows the more it explains itself.
 */
export const measure = (path: string, text: string): Shape => {
  const rows = text.split(/\r?\n/)
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
  const lines = text === '' ? 0 : rows.length
  const lengths = rows.map(r => r.trimEnd().length).filter(n => n > 0).sort((a, b) => a - b)
  const width = lengths.length === 0 ? 0 : Math.min(300, lengths[Math.floor((lengths.length - 1) * 0.9)]!)
  const c = counterOf(langOf(path))
  const count = (res: RegExp[]) => res.reduce((n, re) => n + (text.match(re) ?? []).length, 0)
  const isTable = /\.(csv|tsv)$/i.test(path)
  const parts = isTable ? (rows[0] ?? '').split(/[,\t]/).length : count(c.parts)
  const blocks = count(c.blocks)
  const exports = count(c.exports)
  const notes = notesOf(langOf(path), rows)
  // A tenth of its lines in comments starts the flower boxes; two fifths fills every window.
  const share = lines === 0 ? 0 : notes.comments / lines
  return {
    lines,
    width,
    parts,
    blocks,
    exports,
    floors: between(Math.round(Math.log2(1 + lines / 40) * 1.4), 1, 10),
    footprint: Math.round(between(0.38 + width * 0.003, 0.46, 0.7) * 100) / 100,
    wings: Math.min(3, Math.floor(parts / c.perWing)),
    towers: Math.min(3, blocks),
    pennants: Math.min(4, exports),
    ...notes,
    flowers: between(Math.round(((share - 0.1) / 0.3) * 4) / 4, 0, 1),
  }
}

/** A file's shape in words, for its building's label. */
export const shapeText = (path: string, s: Shape): string => {
  const [part, block, exported] = counterOf(langOf(path)).words
  const n = (v: number) => v.toLocaleString('en-US')
  return [
    `${n(s.lines)} lines`,
    s.parts > 0 && part !== '' ? `${n(s.parts)} ${part}` : '',
    s.blocks > 0 && block !== '' ? `${n(s.blocks)} ${block}` : '',
    s.exports > 0 && exported !== '' ? `${n(s.exports)} ${exported}` : '',
    (s.todos ?? 0) > 0 ? `${n(s.todos!)} ${s.todos === 1 ? 'TODO' : 'TODOs'}` : '',
    (s.fixmes ?? 0) > 0 ? `${n(s.fixmes!)} ${s.fixmes === 1 ? 'FIXME' : 'FIXMEs'}` : '',
    (s.comments ?? 0) > 0 && s.lines > 0 ? `${Math.round((s.comments! / s.lines) * 100)}% comments` : '',
  ].filter(Boolean).join(', ')
}

// ---------------------------------------------------------------- history in the walls

const MAX_EDITS = 12

/**
 * Where edits fall in a file, from its text before they are made: each
 * replaced passage's first line as a share of the file (0 the top, 1 the
 * bottom) and how much of the file it spans. An edit whose text is not there
 * (it will fail) falls nowhere.
 */
export const editSpots = (
  text: string,
  edits: readonly { old: string; new: string; isAll?: boolean }[],
): { pos: number; span: number }[] => {
  const lines = Math.max(1, text.split('\n').length)
  const spots: { pos: number; span: number }[] = []
  for (const e of edits) {
    if (e.old === '') continue
    const size = Math.max(e.old.split('\n').length, e.new.split('\n').length)
    let from = 0
    for (let n = 0; n < (e.isAll === true ? 6 : 1); n++) {
      const k = text.indexOf(e.old, from)
      if (k < 0) break
      const line = text.slice(0, k).split('\n').length - 1
      spots.push({ pos: Math.round((line / lines) * 1000) / 1000, span: Math.round(Math.min(1, size / lines) * 1000) / 1000 })
      from = k + e.old.length
    }
  }
  return spots.slice(-MAX_EDITS)
}

/**
 * A file's change went through: each edit leaves a band of its turn's color
 * where it fell (a file written whole over starts its walls afresh), and a
 * building an edit had failed on is mended, its fire out, a patch left on
 * its wall.
 */
export const onEdited = (
  world: World,
  path: string,
  spots: readonly { pos: number; span: number }[],
  at: number,
  isRewrite = false,
): World => {
  const house = world.features.find(f => f.key === `file:${path}` && f.kind === 'house')
  if (house === undefined) return world
  const edits = [
    ...(isRewrite ? [] : house.edits ?? []),
    ...spots.map(s => ({ pos: s.pos, span: s.span, turn: world.turn, at })),
  ].slice(-MAX_EDITS)
  const isMended = house.isWounded === true
  const { isWounded: _wound, isScorched: _fire, edits: _old, ...kept } = house
  const next: Feature = {
    ...kept,
    ...(edits.length > 0 ? { edits } : {}),
    ...(isMended ? { scars: (house.scars ?? 0) + 1 } : house.isScorched === true ? { isScorched: true } : {}),
  }
  const mended: World = { ...world, features: world.features.map(f => (f === house ? next : f)) }
  return isMended ? say(mended, `The ${baseName(path)} ${buildingOf(path)} is patched up where the failed edit hit.`) : mended
}

/**
 * How weathered a building is, 0 to 4, by how long its file has been left
 * alone: fresh for twenty minutes after a change, then faded roofs and moss,
 * ivy climbing, and in the end overgrown, after two and a half hours.
 */
export const weathering = (f: Feature, now: number): number => {
  if (f.touchedAt === undefined || now <= 0) return 0
  const minutes = (now - f.touchedAt) / 60000
  return minutes < 20 ? 0 : minutes < 45 ? 1 : minutes < 90 ? 2 : minutes < 150 ? 3 : 4
}

/** What a building's walls tell of its history, for its label. */
export const historyText = (f: Feature, now: number): string => {
  const edits = f.edits ?? []
  const turns = new Set(edits.map(e => e.turn)).size
  const stage = weathering(f, now)
  return [
    edits.length > 0 ? `${edits.length}${edits.length === MAX_EDITS ? '+' : ''} ${edits.length === 1 ? 'edit' : 'edits'} banded on its walls${turns > 1 ? ` (${turns} prompts)` : ''}` : '',
    stage > 0 && f.touchedAt !== undefined ? `${['', 'weathering', 'mossy', 'ivy-grown', 'overgrown'][stage]}: untouched ${span((now - f.touchedAt) / 1000)}` : '',
    f.isWounded === true ? 'an edit failed here' : '',
    (f.scars ?? 0) > 0 ? `patched after ${f.scars} failed ${f.scars === 1 ? 'edit' : 'edits'}` : '',
  ].filter(Boolean).join(' · ')
}

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()

/** A path as imports name it: lower case, forward slashes, no extension. */
export const basePath = (path: string): string => slashes(path).replace(/\.d\.ts$/, '').replace(/\.[a-z0-9]+$/, '')

const joinPath = (dir: string, rel: string): string => {
  const out: string[] = []
  for (const part of `${dir}/${rel}`.split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

const IMPORTS: Record<string, RegExp[]> = {
  ts: [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  css: [/@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"]+)['"]/g],
  html: [/\b(?:src|href)\s*=\s*['"]([^'"#?]+)['"]/gi],
  md: [/\]\(\s*<?([^)\s#>]+)/g],
  c: [/^\s*#\s*include\s*"([^"]+)"/gm],
  sh: [/(?:^|[\s;&|])(?:source|\.)\s+['"]?([^\s'";&|]+)/gm],
}
IMPORTS.js = IMPORTS.ts!
IMPORTS.cpp = IMPORTS.c!

/**
 * The local files a file imports, from its text: relative imports in
 * JavaScript and TypeScript, Python, Rust modules, C includes, CSS imports,
 * HTML sources and Markdown links. Packages and the web are left out; what
 * is named is matched later against the files on the island.
 */
export const importsOf = (path: string, text: string): string[] => {
  const lang = langOf(path)
  const file = slashes(path)
  const dir = file.replace(/\/[^/]*$/, '')
  const parent = dir.replace(/\/[^/]*$/, '')
  const found = new Set<string>()
  const add = (p: string) => {
    if (found.size < 24) found.add(basePath(p))
  }
  const isLocal = (spec: string) => !/^[a-z][a-z0-9+.-]*:|^\/\/|^@|^~/i.test(spec) && spec !== ''
  for (const re of IMPORTS[lang] ?? []) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]!.trim()
      if (!isLocal(spec)) continue
      // Script imports are relative or nothing; the rest name siblings plainly too.
      if ((lang === 'ts' || lang === 'js') && !/^\.{1,2}\//.test(spec)) continue
      const target = joinPath(dir, spec.replace(/\\/g, '/'))
      add(target)
      if (lang === 'css') add(target.replace(/([^/]+)$/, '_$1'))
    }
  }
  if (lang === 'py') {
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+\(?([\w, *]+)/gm)) {
      let base = dir
      for (let k = 1; k < m[1]!.length; k++) base = base.replace(/\/[^/]*$/, '')
      if (m[2] !== '') add(joinPath(base, m[2]!.replace(/\./g, '/')))
      else for (const name of m[3]!.split(',')) if (/^\w+$/.test(name.trim())) add(joinPath(base, name.trim()))
    }
    for (const m of text.matchAll(/^\s*(?:from\s+([a-zA-Z_][\w.]*)\s+import|import\s+([a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*))/gm)) {
      for (const name of (m[1] ?? m[2] ?? '').split(',')) {
        const rel = name.trim().replace(/\./g, '/')
        if (rel === '') continue
        add(joinPath(dir, rel))
        add(joinPath(parent, rel))
      }
    }
  }
  if (lang === 'rs') {
    const stem = file.replace(/^.*\//, '').replace(/\.rs$/, '')
    for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
      add(joinPath(dir, m[1]!))
      if (!['mod', 'lib', 'main'].includes(stem)) add(joinPath(`${dir}/${stem}`, m[1]!))
    }
    const src = /^(.*\/src)\//.exec(file)?.[1]
    for (const m of text.matchAll(/\buse\s+(crate|super)::([\w:]+)/g)) {
      const root = m[1] === 'crate' ? src : parent
      if (root === undefined) continue
      const segs = m[2]!.split('::')
      add(joinPath(root, segs.join('/')))
      if (segs.length > 1) add(joinPath(root, segs.slice(0, -1).join('/')))
    }
  }
  found.delete(basePath(path))
  return [...found]
}

/** A file was measured: its houses and trees take its shape, and its imports. */
export const onMeasure = (world: World, path: string, shape: Shape, links: string[]): World => {
  const want = slashes(path)
  let changed = false
  const features = world.features.map(f => {
    const m = /^(file|read):(.+)$/.exec(f.key)
    if (m === null || slashes(m[2]!) !== want) return f
    changed = true
    const said = shapeText(path, shape)
    const label = f.kind === 'house' ? `${baseName(path)} · ${buildingOf(path)} · ${said} · ${path}` : `Read ${path} · ${said}`
    const next: Feature = { ...f, ...(f.lang === undefined ? vernacular(path) : {}), shape, label }
    if (links.length > 0) next.links = links
    else delete next.links
    return next
  })
  return changed ? { ...world, features } : world
}

/**
 * The town's streets: every import between two files on the island, once
 * per pair. Between two buildings it is a street; where either file was
 * only read (a tree), a footpath. A file both read and written counts as its
 * building.
 */
export const streetsOf = (world: World): Street[] => {
  const byBase = new Map<string, Feature>()
  const baseOf = new Map<number, string>()
  const put = (b: string, f: Feature) => {
    const had = byBase.get(b)
    if (had === undefined || (had.kind !== 'house' && f.kind === 'house')) byBase.set(b, f)
  }
  for (const f of world.features) {
    const m = /^(file|read):(.+)$/.exec(f.key)
    if (m === null) continue
    const base = basePath(m[2]!)
    baseOf.set(f.id, base)
    put(base, f)
    const index = /^(.*)\/(?:index|__init__|mod)$/.exec(base)
    if (index !== null) put(index[1]!, f)
  }
  const seen = new Set<string>()
  const out: Street[] = []
  for (const f of world.features) {
    const base = baseOf.get(f.id)
    if (base === undefined || byBase.get(base) !== f) continue
    for (const link of f.links ?? []) {
      const g = byBase.get(link)
      if (g === undefined || g.id === f.id) continue
      const key = f.id < g.id ? `${f.id}-${g.id}` : `${g.id}-${f.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ from: f.id, to: g.id, isPath: f.kind !== 'house' || g.kind !== 'house' })
    }
  }
  return out.slice(0, 160)
}

/**
 * A street's way through the town: out of the first file's plot to its
 * corner, along the lines between plots, and in at the other's corner, so
 * streets run between the buildings and meet where they share a way.
 */
export const routeOf = (a: { x: number; y: number }, b: { x: number; y: number }): [number, number][] => {
  const ca: [number, number] = [a.x + (b.x > a.x ? 1 : 0), a.y + (b.y > a.y ? 1 : 0)]
  const cb: [number, number] = [b.x + (a.x > b.x ? 1 : 0), b.y + (a.y > b.y ? 1 : 0)]
  return [[a.x + 0.5, a.y + 0.5], ca, [cb[0], ca[1]], cb, [b.x + 0.5, b.y + 0.5]]
}

// ---------------------------------------------------------------- tests and districts

const pathOf = (f: Feature) => f.key.replace(/^(file|read):/, '')
const isTestHouse = (f: Feature) => f.kind === 'house' && (f.arch === 'watchtower' || f.style === 'test')

/** How many leading folders two paths share. */
const shared = (a: string, b: string): number => {
  const p = a.split('/')
  const q = b.split('/')
  let n = 0
  while (n < p.length && n < q.length && p[n] === q[n]) n++
  return n
}

/** What a test file's name says it tests: `world` for world.test.ts, test_world.py, world_test.go, WorldTests.cs. */
export const subjectStem = (path: string): string =>
  baseName(path)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[._-](?:test|tests|spec|specs)$/i, '')
    .replace(/^(?:test|tests|spec)[._-]/i, '')
    .replace(/([a-z0-9])(?:Tests?|Spec)$/, '$1')
    .toLowerCase()

/** The island's buildings as a test looks for its subject: by path, name, import and folder. */
type Known = { f: Feature; path: string; stem: string; base: string; dir: string }
const knownOf = (world: World): Known[] =>
  world.features
    .filter(f => f.kind === 'house' && !isTestHouse(f))
    .map(f => {
      const path = pathOf(f)
      return { f, path: slashes(path), stem: baseName(path).replace(/\.[a-z0-9]+$/i, '').toLowerCase(), base: basePath(path), dir: slashes(dirOf(path)) }
    })

/**
 * The files a test tests: the one its name names (in the nearest folder),
 * or failing that, up to three of the files it imports.
 */
const subjectsOf = (known: readonly Known[], path: string, links: readonly string[]): Feature[] => {
  const stem = subjectStem(path)
  const dir = slashes(dirOf(path))
  const others = known.filter(k => k.path !== slashes(path))
  const named = others.filter(k => k.stem === stem).sort((a, b) => shared(dir, b.dir) - shared(dir, a.dir))
  if (named.length > 0) return [named[0]!.f]
  const wanted = new Set(links)
  return others
    .filter(k => wanted.has(k.base) || wanted.has(k.base.replace(/\/(?:index|__init__|mod)$/, '')))
    .slice(0, 3)
    .map(k => k.f)
}

/** Each test and the files it tests; bridges span six plots at most, the rest are only named. */
export const bridgesOf = (world: World): Bridge[] => {
  const known = knownOf(world)
  const out: Bridge[] = []
  for (const t of world.features) {
    if (!isTestHouse(t)) continue
    for (const s of subjectsOf(known, pathOf(t), t.links ?? [])) {
      out.push({ test: t.id, subject: s.id, ...(Math.hypot(s.x - t.x, s.y - t.y) > 6 ? { isFar: true } : {}) })
    }
  }
  return out.slice(0, 60)
}

/** What each watchtower tests, for its label: by the test's id. */
export const testsOf = (world: World, bridges: readonly Bridge[] = bridgesOf(world)): Map<number, string> => {
  const byId = new Map(world.features.map(f => [f.id, f]))
  const out = new Map<number, string>()
  for (const b of bridges) {
    const s = byId.get(b.subject)
    if (s === undefined) continue
    const had = out.get(b.test)
    out.set(b.test, `${had === undefined ? 'tests' : `${had},`} ${baseName(pathOf(s))}`)
  }
  return out
}

type Edge = [number, number, number, number]
const edgeKey = (e: Edge): string => (e[0] < e[2] || (e[0] === e[2] && e[1] < e[3]) ? `${e[0]},${e[1]}|${e[2]},${e[3]}` : `${e[2]},${e[3]}|${e[0]},${e[1]}`)

/**
 * The town's districts: each folder with two or more buildings. Its plots
 * are paved in its own stone; where they meet the rest of the town a wall
 * runs along the line between plots (a hedge for a quarter, a folder inside
 * another on the island), left open where a street runs; its gate stands in
 * the stretch of wall nearest the town's heart.
 */
export const districtsOf = (world: World): District[] => {
  const byDir = new Map<string, Feature[]>()
  for (const f of world.features) {
    if (f.kind !== 'house' || f.dir === undefined) continue
    const d = slashes(f.dir)
    byDir.set(d, [...(byDir.get(d) ?? []), f])
  }
  const dirs = [...byDir.keys()].filter(d => byDir.get(d)!.length >= 2)
  const owner = new Map<string, string>()
  for (const d of dirs) for (const f of byDir.get(d)!) owner.set(`${f.x},${f.y}`, d)
  const rank = (d: string) => byDir.get(d)!.length * 1000 + (hash(d) % 1000)
  // Lines a street or footpath runs along stay open.
  const byId = new Map(world.features.map(f => [f.id, f]))
  const open = new Set<string>()
  for (const s of streetsOf(world)) {
    const a = byId.get(s.from)
    const b = byId.get(s.to)
    if (a === undefined || b === undefined) continue
    const r = routeOf(a, b)
    for (const [p, q] of [[r[1], r[2]], [r[2], r[3]]] as const) {
      const dx = Math.sign(q[0] - p[0])
      const dy = Math.sign(q[1] - p[1])
      const steps = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1])
      for (let k = 0; k < steps; k++) open.add(edgeKey([p[0] + dx * k, p[1] + dy * k, p[0] + dx * (k + 1), p[1] + dy * (k + 1)]))
    }
  }
  const sides: [number, number, (x: number, y: number) => Edge][] = [
    [1, 0, (x, y) => [x + 1, y, x + 1, y + 1]],
    [-1, 0, (x, y) => [x, y, x, y + 1]],
    [0, 1, (x, y) => [x, y + 1, x + 1, y + 1]],
    [0, -1, (x, y) => [x, y, x + 1, y]],
  ]
  return dirs.slice(0, 40).map(d => {
    const fs = byDir.get(d)!
    const parent = [...byDir.keys()].filter(o => o !== d && d.startsWith(`${o}/`)).sort((a, b) => b.length - a.length)[0]
      // what it tests, say) is only paved. The gate goes in the largest block.
    const block = new Map<string, number>()
    const sizes: number[] = []
    for (const f of fs) {
      if (block.has(`${f.x},${f.y}`)) continue
      const id = sizes.length
      const todo: Feature[] = [f]
      block.set(`${f.x},${f.y}`, id)
      let n = 0
      while (todo.length > 0) {
        const c = todo.pop()!
        n++
        for (const g of fs) {
          if (!block.has(`${g.x},${g.y}`) && Math.abs(g.x - c.x) + Math.abs(g.y - c.y) === 1) {
            block.set(`${g.x},${g.y}`, id)
            todo.push(g)
          }
        }
      }
      sizes.push(n)
    }
    const largest = sizes.indexOf(Math.max(...sizes))
    const boundary: Edge[] = []
    const gates: Edge[] = []
    for (const f of fs) {
      const id = block.get(`${f.x},${f.y}`)!
      if (sizes[id]! < 2) continue
      for (const [dx, dy, edge] of sides) {
        const other = owner.get(`${f.x + dx},${f.y + dy}`)
        // Between two districts one wall stands: the larger one's.
        if (other === d || (other !== undefined && rank(other) > rank(d))) continue
        boundary.push(edge(f.x, f.y))
        if (id === largest) gates.push(edge(f.x, f.y))
      }
    }
    const away = (e: Edge) => Math.hypot((e[0] + e[2]) / 2, (e[1] + e[3]) / 2)
    const gate = gates.filter(e => !open.has(edgeKey(e))).sort((a, b) => away(a) - away(b))[0]
    const district: District = {
      dir: d,
      name: d.split('/').pop() || d,
      files: fs.length,
      lines: fs.reduce((n, f) => n + (f.shape?.lines ?? 0), 0),
      pave: hash(d) % 4,
      cells: fs.map(f => [f.x, f.y]),
      walls: boundary.filter(e => (gate === undefined || edgeKey(e) !== edgeKey(gate)) && !open.has(edgeKey(e))),
    }
    if (parent !== undefined) district.parent = parent.split('/').pop() || parent
    if (gate !== undefined) district.gate = gate
    return district
  })
}

// ---------------------------------------------------------------- the kit of parts, and the town at work

/** The names programs start from. */
const ENTRY = /^(?:main|index|app|cli|server|program|entry|start|setup|manage|__main__)$/

/**
 * Each building's parts beyond its shape (only those with any): a spire
 * for an entry point; a clock face when two or more files on the island
 * import it, its hands at the hour and minute it last changed; a dormer for
 * each file it imports (up to four); a balcony for every two times Claude
 * read it (up to three); a bay window when its lines run wide (the 90th
 * percentile at 100 characters or more); and in each folder of two or more,
 * the most worked building flies the flag.
 */
export const kitsOf = (world: World): Record<number, Kit> => {
  const reads = new Map<string, number>()
  for (const f of world.features) if (f.kind === 'tree' && f.key.startsWith('read:')) reads.set(slashes(pathOf(f)), f.size)
  const importers = new Map<number, number>()
  for (const s of streetsOf(world)) importers.set(s.to, (importers.get(s.to) ?? 0) + 1)
  const byDir = new Map<string, Feature[]>()
  for (const f of world.features) if (f.kind === 'house' && f.dir !== undefined) byDir.set(f.dir, [...(byDir.get(f.dir) ?? []), f])
  const flagships = new Set<number>()
  for (const fs of byDir.values()) {
    if (fs.length < 2) continue
    const top = fs.reduce((a, b) => (b.size + (b.edits?.length ?? 0) > a.size + (a.edits?.length ?? 0) ? b : a))
    flagships.add(top.id)
  }
  const kits: Record<number, Kit> = {}
  for (const f of world.features) {
    if (f.kind !== 'house') continue
    const path = pathOf(f)
    const stem = baseName(path).replace(/\.[a-z0-9]+$/i, '').toLowerCase()
    const kit: Kit = {}
    if (ENTRY.test(stem) || /(?:^|[\\/])lib\.rs$/i.test(path)) kit.spire = true
    if ((importers.get(f.id) ?? 0) >= 2 && f.touchedAt !== undefined && f.touchedAt > 0) {
      const t = new Date(f.touchedAt)
      kit.clock = [t.getHours() % 12, t.getMinutes()]
    }
    const dormers = Math.min(4, f.links?.length ?? 0)
    if (dormers > 0) kit.dormers = dormers
    const balconies = Math.min(3, Math.floor((reads.get(slashes(path)) ?? 0) / 2))
    if (balconies > 0) kit.balconies = balconies
    if ((f.shape?.width ?? 0) >= 100) kit.bay = true
    if (flagships.has(f.id)) kit.flag = true
    if (Object.keys(kit).length > 0) kits[f.id] = kit
  }
  return kits
}

/**
 * The town's errands: for each two files worked one after the other (within
 * ten minutes, in the last half hour), a townsperson carries the work
 * between them along the streets; newest first, up to ten.
 */
export const walksOf = (world: World, now: number): Walk[] => {
  const files = new Set(world.features.filter(f => /^(file|read):/.test(f.key)).map(f => f.id))
  const recent = (world.events ?? []).filter(e => e.target !== undefined && files.has(e.target) && (now <= 0 || now - e.at < 30 * 60_000))
  const seen = new Set<string>()
  const out: Walk[] = []
  for (let k = recent.length - 1; k > 0 && out.length < 10; k--) {
    const a = recent[k - 1]!
    const b = recent[k]!
    if (a.target === b.target || b.at - a.at > 10 * 60_000) continue
    const key = a.target! < b.target! ? `${a.target}-${b.target}` : `${b.target}-${a.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: a.target!, to: b.target!, at: b.at })
  }
  return out
}

/** The buildings at work this moment: a tool call on them in the last half minute. Their doors stand open, their lights on. */
export const busyOf = (world: World, now: number): number[] => {
  if (now <= 0) return []
  const out = new Set<number>()
  for (const e of world.events ?? []) if (e.target !== undefined && now >= e.at && now - e.at < 30_000) out.add(e.target)
  return [...out]
}

/**
 * Where a new file settles when its folder has no plot yet: beside its
 * nearest kin (its parent folder, a sibling folder, a subfolder), so a
 * folder's quarters gather round its district.
 */
const kinOf = (world: World, dir: string): Feature | undefined => {
  const same = world.features.find(f => f.dir === dir)
  if (same !== undefined || dir.startsWith('grove:')) return same
  const d = slashes(dir)
  const need = Math.max(1, d.split('/').length - 1)
  let best: Feature | undefined
  let most = 0
  for (const f of world.features) {
    if (f.kind !== 'house' || f.dir === undefined) continue
    const n = shared(d, slashes(f.dir))
    if (n >= need && n > most) {
      best = f
      most = n
    }
  }
  return best
}

const isFree = (taken: Set<string>, x: number, y: number) =>
  !taken.has(`${x},${y}`) && Math.hypot(x + 0.5, y + 0.5) < CORE

const nextSeat = (world: World, near?: { x: number; y: number }): { x: number; y: number; slots: number } | undefined => {
  const taken = new Set(world.features.map(f => `${f.x},${f.y}`))
  if (near !== undefined) {
    // A district: siblings settle on the ring around the first of their folder.
    for (const ring of [1, 2]) {
      const cells: [number, number][] = []
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) cells.push([near.x + dx, near.y + dy])
        }
      }
      const free = cells.filter(([x, y]) => isFree(taken, x, y))
      const pick = free[(world.nextId * 7) % Math.max(1, free.length)]
      if (pick !== undefined) return { x: pick[0], y: pick[1], slots: world.slots + 1 }
    }
  }
  for (let k = world.slots; k < world.slots + 40; k++) {
    const r = SPREAD * Math.sqrt(k + 0.6)
    if (r > CORE) return undefined
    const a = k * GOLDEN + (world.seed % 628) / 100
    const x = Math.round(Math.cos(a) * r - 0.5)
    const y = Math.round(Math.sin(a) * r - 0.5)
    if (!taken.has(`${x},${y}`)) return { x, y, slots: k + 1 }
  }
  return undefined
}

/**
 * A free plot on the town's rim, for a nest once the spiral of plots has run
 * out: each agent type keeps a nest of its own however full the town is.
 */
const rimSeat = (world: World, key: string): { x: number; y: number; slots: number } | undefined => {
  const taken = new Set(world.features.map(f => `${f.x},${f.y}`))
  const free: [number, number][] = []
  const reach = Math.ceil(CORE)
  for (let x = -reach; x <= reach; x++) {
    for (let y = -reach; y <= reach; y++) {
      if (Math.hypot(x + 0.5, y + 0.5) > CORE - 2.5 && isFree(taken, x, y)) free.push([x, y])
    }
  }
  const pick = free[hash(key) % Math.max(1, free.length)]
  return pick === undefined ? undefined : { x: pick[0], y: pick[1], slots: world.slots }
}

const say = (world: World, line: string): World => ({
  ...world,
  chronicle: [...world.chronicle, line].slice(-MAX_CHRONICLE),
})

/**
 * Grows the feature under `key` when there is one, else seats a new one;
 * once the island is full, the new thing joins its nearest kin instead.
 */
const plant = (
  world: World,
  kind: Kind,
  key: string,
  label: string,
  lines: { born: string; grown: (size: number) => string },
  extra: Partial<Feature> = {},
  near?: Feature,
): World => {
  const { size: firstSize, ...rest } = extra
  const found = world.features.find(f => f.key === key && f.kind === kind)
  if (found !== undefined) {
    const size = found.size + 1
    return say(
      {
        ...world,
        focus: found.id,
        features: world.features.map(f =>
          f === found ? { ...f, size, label, turn: world.turn, ...rest } : f,
        ),
      },
      lines.grown(size),
    )
  }
  // A test settles beside what it tests; any other file beside its folder, or its folder's kin.
  const sibling = near ?? (extra.dir === undefined ? undefined : kinOf(world, extra.dir))
  const seat = nextSeat(world, sibling) ?? (kind === 'camp' ? rimSeat(world, key) : undefined)
  if (seat === undefined) {
    const kin = world.features.filter(f => f.kind === kind)
    const pick = kin[hash(key) % Math.max(1, kin.length)]
    if (pick === undefined) return say(world, lines.born)
    return say(
      {
        ...world,
        focus: pick.id,
        features: world.features.map(f => (f === pick ? { ...f, size: f.size + 1, turn: world.turn } : f)),
      },
      lines.grown(pick.size + 1),
    )
  }
  const feature: Feature = {
    id: world.nextId,
    kind,
    x: seat.x,
    y: seat.y,
    size: firstSize ?? 1,
    key,
    label,
    turn: world.turn,
    hue: hueFor(key),
    ...rest,
  }
  const features = [...world.features, feature]
  return say(
    {
      ...world,
      slots: seat.slots,
      nextId: world.nextId + 1,
      focus: feature.id,
      features: features.length > MAX_FEATURES ? features.slice(-MAX_FEATURES) : features,
    },
    lines.born,
  )
}

// ---------------------------------------------------------------- mood

const LEXICON: Record<keyof Mood, RegExp[]> = {
  joy: [
    /\b(thanks?|thank you|thx|ty|love|loving|great|awesome|amazing|perfect|nice|cool|beautiful|wonderful|brilliant|excellent|yay|woo+|fantastic|sweet|delight\w*|happy|glad|fun)\b/gi,
    /(:\)|:D|😊|😄|😍|🎉|❤️|🙏|✨|🥳|👍)/g,
  ],
  storm: [
    /\b(wrong|broken|breaks?|fail\w*|error\w*|bug\w*|crash\w*|ugh|annoy\w*|hate|frustrat\w*|stuck|useless|terrible|awful|confus\w*|doesn'?t work|not working|still not|why (isn'?t|won'?t|doesn'?t)|wtf|damn|sigh)\b/gi,
    /(:\(|😠|😡|😤|😩|😞|💀|🤬)/g,
  ],
  wonder: [
    /\b(what if|imagine|wonder\w*|curious|idea\w*|maybe|perhaps|explore|dream\w*|surprise|magic\w*|creative|could we|how about|why not|i don'?t (really )?know)\b/gi,
    /\?/g,
  ],
  haste: [
    /\b(asap|quick\w*|fast|hurry|urgent\w*|now|immediately|deadline|rush)\b/gi,
    /!{2,}/g,
  ],
}

export const readMood = (text: string): Mood => {
  const count = (res: RegExp[]) =>
    res.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0)
  const raw = {
    joy: count(LEXICON.joy),
    storm: count(LEXICON.storm),
    wonder: count(LEXICON.wonder),
    haste: count(LEXICON.haste),
  }
  const squash = (n: number) => 1 - Math.exp(-n * 0.9)
  return {
    joy: squash(raw.joy),
    storm: squash(raw.storm),
    wonder: squash(raw.wonder * 0.8),
    haste: squash(raw.haste),
  }
}

const blend = (a: Mood, b: Mood, t: number): Mood => ({
  joy: a.joy * (1 - t) + b.joy * t,
  storm: a.storm * (1 - t) + b.storm * t,
  wonder: a.wonder * (1 - t) + b.wonder * t,
  haste: a.haste * (1 - t) + b.haste * t,
})

const nudge = (mood: Mood, key: keyof Mood, by: number): Mood => ({
  ...mood,
  [key]: Math.max(0, Math.min(1, mood[key] + by)),
})

export type Weather = 'sunny' | 'stormy' | 'dreamy' | 'windy' | 'calm'

export const weatherOf = (mood: Mood): Weather => {
  const top = (Object.entries(mood) as [keyof Mood, number][]).sort((a, b) => b[1] - a[1])[0]
  if (top === undefined || top[1] < 0.32) return 'calm'
  return ({ joy: 'sunny', storm: 'stormy', wonder: 'dreamy', haste: 'windy' } as const)[top[0]]
}

export const WEATHER_GLYPH: Record<Weather, string> = {
  sunny: '☀ sunny',
  stormy: '⛈ stormy',
  dreamy: '✦ dreamy',
  windy: '≋ windy',
  calm: '☁ calm',
}

const WEATHER_LINE: Record<Weather, string> = {
  sunny: 'The clouds part. Sunlight pours over the hills.',
  stormy: 'Storm clouds gather over the island.',
  dreamy: 'The air shimmers; something curious is in it.',
  windy: 'A brisk wind picks up. Banners snap.',
  calm: 'The weather settles into a soft calm.',
}

const withMood = (world: World, mood: Mood): World => {
  const before = weatherOf(world.mood)
  const after = weatherOf(mood)
  const next = { ...world, mood }
  return before === after ? next : say(next, WEATHER_LINE[after])
}

// ---------------------------------------------------------------- events

const stripReminders = (text: string): string =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, '')
    .trim()

const ideasIn = (text: string): string[] =>
  text
    .split(/(?<=[?.!])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 6 && (/\?$/.test(s) || /\b(what if|idea|maybe|imagine|could we|how about|i wonder)\b/i.test(s)))
    .slice(0, 4)

/**
 * A prompt wakes the creature for its turn. One sent while Claude is still at
 * work joins the turn under way: the creature works on.
 */
export const onPrompt = (world: World, rawText: string, at = 0, isMidTurn = false): World => {
  const text = stripReminders(rawText)
  if (text === '' || text.startsWith('/')) return world
  const alive = world.beast !== undefined && world.beast.doneAt === undefined ? world.beast : undefined
  let next: World
  const turn = isMidTurn && alive !== undefined ? world.turn : world.turn + 1
  if (isMidTurn && alive !== undefined) {
    next = say(at > 0 ? { ...world, heardAt: at } : world, `You speak while it works: “${clip(text, 48)}”`)
  } else {
    next = say(
      { ...(at > 0 ? clearBrood(world, at) : world), turn, isWorking: at > 0, turnStartedAt: at, ...(at > 0 ? { beast: wake(world, turn, clip(text, 110), at) } : {}) },
      at <= 0
        ? `Turn ${turn}: “${clip(text, 56)}”`
        : world.beast === undefined
          ? `Turn ${turn}: a shoggoth hatches for “${clip(text, 48)}”`
          : `Turn ${turn}: the creature wakes for “${clip(text, 48)}”`,
    )
  }
  const ideas = ideasIn(text)
  if (ideas.length > 0) {
    const r = islandRadius(next)
    const lanterns = ideas.map((idea, i) => {
      const a = (hash(idea) % 6283) / 1000
      const d = (0.25 + ((hash(idea + i) % 100) / 100) * 0.6) * r
      return { id: next.nextId + i, text: clip(idea, 120), x: Math.cos(a) * d, y: Math.sin(a) * d, turn }
    })
    next = say(
      {
        ...next,
        nextId: next.nextId + ideas.length,
        lanterns: [...next.lanterns, ...lanterns].slice(-MAX_LANTERNS),
      },
      ideas.length === 1
        ? 'A lantern of thought drifts up into the sky.'
        : `${ideas.length} lanterns of thought drift up into the sky.`,
    )
  }
  return withMood(next, blend(next.mood, readMood(text), 0.55))
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const domainOf = (url: string): string => /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? 'afar'

/**
 * Plants what the tool made, and keeps the call so the creature that made it
 * can reach for it: the conversation's creature, or (`agent`, a subagent's
 * id) a spawnling. Each crawls toward the middle of its own recent work.
 */
export const onTool = (
  world: World,
  tool: string,
  input: Record<string, unknown>,
  agent: string | false,
  at = 0,
): World => {
  const by = agent === false ? undefined : agent
  if (tool === 'SendMessage') return onMessage(world, input, by, at)
  const built = buildFor(world, tool, input, agent !== false)
  const event: Event = { id: built.tools, tool, target: built.focus, at, ...(by === undefined ? {} : { agent: by }) }
  const features = at > 0 && built.focus !== undefined
    ? built.features.map(f => (f.id === built.focus ? touched(f, at, by) : f))
    : built.features
  const next: World = { ...built, features, events: [...(built.events ?? []), event].slice(-MAX_EVENTS) }
  return by === undefined ? crawl(next, at) : crawlSpawn(stir(next, by, at, s => ({ calls: s.calls + 1 })), by, at)
}

/** Worked on just now, and by whom: a subagent, or (no `by`) the conversation's creature. */
const touched = (f: Feature, at: number, by: string | undefined): Feature => {
  const { by: _was, ...rest } = f
  return by === undefined ? { ...rest, touchedAt: at } : { ...rest, touchedAt: at, by }
}

/** How brightly recent work glows: full when fresh, gone after ten minutes. */
export const glowOf = (touchedAt: number | undefined, now: number): number => {
  if (touchedAt === undefined || now <= 0) return 0
  const minutes = (now - touchedAt) / 60000
  return minutes < 0 ? 1 : Math.max(0, 1 - minutes / 10) ** 1.5
}

const buildFor = (
  world: World,
  tool: string,
  input: Record<string, unknown>,
  isSubagent: boolean,
): World => {
  const w: World = { ...world, tools: world.tools + 1, focus: undefined }
  const lift = isSubagent ? { lift: -0.25 } : {}
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path)
  switch (tool) {
    case 'Read': {
      const name = baseName(path || 'a scroll')
      const known = w.features.find(f => f.key === `read:${path}`)?.shape
      return plant(w, 'tree', `read:${path}`, known === undefined ? `Read ${path}` : `Read ${path} · ${shapeText(path, known)}`, {
        born: `A tree takes root where ${name} was read.`,
        grown: n => `The ${name} tree grows taller (${n} reads).`,
      }, { ...lift, dir: `grove:${dirOf(path)}`, ...vernacular(path) })
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const name = baseName(path || 'something')
      const style = styleOf(path)
      const building = buildingOf(path)
      // A file written whole is measured at once; an edited one when it is read back from disk.
      const content = str(input.content)
      const written = tool === 'Write' ? { shape: measure(path, content), links: importsOf(path, content) } : {}
      const shape = written.shape ?? w.features.find(f => f.key === `file:${path}`)?.shape
      const label = `${name} · ${building} · ${shape === undefined ? '' : `${shapeText(path, shape)} · `}${path}`
      const subject = style === 'test'
        ? subjectsOf(knownOf(w), path, written.links ?? [])[0]
        : undefined
      const beside = subject === undefined ? '' : `, beside the ${baseName(pathOf(subject))} it tests`
      return plant(w, 'house', `file:${path}`, label, {
        born: written.shape !== undefined
          ? `A ${building} rises for ${name}, ${written.shape.floors} ${written.shape.floors === 1 ? 'floor' : 'floors'} tall${beside}.`
          : `A ${building} is restored for ${name}${beside}.`,
        grown: n => `The ${name} ${building} is reworked (${n} changes).`,
      }, { ...lift, style, dir: dirOf(path), ...vernacular(path), ...written }, subject)
    }
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command).trim()
      const word = /^[\w.\-/\\]+/.exec(command.replace(/^(cd [^&;|]+(&&|;)\s*)+/, ''))?.[0] ?? 'shell'
      const family = baseName(word).replace(/\.(exe|cmd|bat|ps1)$/i, '')
      return plant(w, 'forge', `forge:${family}`, `${family}: ${clip(command, 90)}`, {
        born: `The ${family} forge is lit.`,
        grown: n => `The ${family} forge roars (${n} runs).`,
      }, lift)
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern)
      return plant(w, 'beacon', `beacon:${w.turn}`, `Searched for ${clip(pattern, 60)}`, {
        born: `A beacon sweeps the land for “${clip(pattern, 30)}”.`,
        grown: n => `The beacon burns brighter (${n} searches).`,
      }, lift)
    }
    case 'WebSearch':
    case 'WebFetch': {
      const from = tool === 'WebFetch' ? domainOf(str(input.url)) : 'the open web'
      return plant(w, 'windmill', `wind:${from}`, `${tool}: ${clip(str(input.url) || str(input.query), 80)}`, {
        born: `A windmill catches a wind from ${from}.`,
        grown: n => `The ${from} windmill spins faster (${n}).`,
      }, lift)
    }
    case 'Agent':
    case 'Task': {
      // The caller lays an egg in its type's nest; the spawnling hatches as the subagent starts.
      const kind = str(input.subagent_type) || 'general-purpose'
      const laid = (w.features.find(f => f.key === `camp:${kind}` && f.kind === 'camp')?.size ?? 0) + 1
      return plant(w, 'camp', `camp:${kind}`, nestLabel(kind, laid, str(input.description)), {
        born: `A nest is woven for ${kind} spawnlings.`,
        grown: n => `An egg is laid in the ${kind} nest (${n}).`,
      }, lift)
    }
    case 'Skill': {
      const skill = str(input.skill) || 'a skill'
      return plant(w, 'shrine', `shrine:${skill}`, `Skill: ${skill}`, {
        born: `A shrine to ${skill} is consecrated.`,
        grown: n => `Pilgrims return to the ${skill} shrine (${n}).`,
      }, lift)
    }
    case 'AskUserQuestion':
      return plant(w, 'signpost', `sign:${w.turn}`, 'A question for you', {
        born: 'A signpost marks a fork in the road.',
        grown: () => 'Another arrow is nailed to the signpost.',
      }, lift)
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return plant(w, 'banner', 'banner:plan', 'The plan', {
        born: 'A banner is raised over the plan.',
        grown: n => `The banner is retied (${n}).`,
      }, lift)
  }
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? 'mcp'
    return plant(w, 'crystal', `crystal:${server}`, `${tool}`, {
      born: `A ${server} crystal surfaces from the ground.`,
      grown: n => `The ${server} crystal grows (${n} facets).`,
    }, lift)
  }
  return plant(w, 'cairn', `cairn:${tool}`, tool, {
    born: `Someone stacks a cairn for ${tool}.`,
    grown: n => `Another stone on the ${tool} cairn (${n}).`,
  }, lift)
}

const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * Scorches what the failed call touched, and marks the call so the sky
 * strikes back; a failed change to a file leaves its building wounded until
 * a later one goes through.
 */
export const onToolError = (world: World, tool: string, at = 0, agent?: string): World => {
  const events = [...(world.events ?? [])]
  let target: number | undefined
  for (let k = events.length - 1; k >= 0; k--) {
    const event = events[k]
    if (event !== undefined && event.tool === tool && event.agent === agent && event.isError !== true) {
      events[k] = { ...event, isError: true, ...(at > 0 ? { failedAt: at } : {}) }
      target = event.target
      break
    }
  }
  const hit = world.features.find(f => f.id === target)
    ?? [...world.features].reverse().find(f => f.turn === world.turn)
  const marked = hit === undefined
    ? world
    : {
        ...world,
        features: world.features.map(f =>
          f === hit ? { ...f, isScorched: true, ...(EDITS.has(tool) && f.kind === 'house' ? { isWounded: true } : {}) } : f,
        ),
      }
  return withMood(
    say({ ...marked, events, errors: world.errors + 1 }, `Smoke rises: ${tool} stumbled.`),
    nudge(marked.mood, 'storm', 0.09),
  )
}

/** The machine's readings and the session limit; the sun's place follows the limit. */
export const onSystem = (world: World, system: NonNullable<World['system']>): World => {
  const before = world.system?.limit
  const after = system.limit
  let next: World = { ...world, system: { ...world.system, ...system } }
  if (after !== undefined && before !== undefined) {
    const marks: [number, string][] = [
      [25, 'The sun climbs: a quarter of the session limit is spent.'],
      [50, 'High noon: half the session limit is spent.'],
      [75, 'The afternoon light slants: three quarters of the session limit is spent.'],
      [100, 'The sun sets: the session limit is reached.'],
    ]
    const crossed = marks.find(([m]) => before < m && after >= m)
    if (crossed !== undefined) next = say(next, crossed[1])
  }
  return next
}

/**
 * Each model request feeds the turn's creature the tokens it took; the share
 * of the request the prompt cache served clears or clouds the lagoon.
 */
export const onStep = (
  world: World,
  tokens: number,
  cacheShare?: number,
  who: { agent?: string; model?: string; at?: number } = {},
): World => {
  // A subagent's request feeds its own spawnling, and names the model its eyes take their color from.
  if (who.agent !== undefined) {
    return stir(world, who.agent, who.at ?? 0, s => ({ tokens: s.tokens + tokens, ...(who.model === undefined || who.model === '' ? {} : { model: who.model }) }))
  }
  const b = world.beast
  return {
    ...world,
    cache: cacheShare === undefined ? world.cache : world.cache === undefined ? cacheShare : world.cache * 0.7 + cacheShare * 0.3,
    beast: b !== undefined && b.doneAt === undefined
      ? { ...b, tokens: b.tokens + tokens, ...(who.model === undefined || who.model === '' ? {} : { model: who.model }) }
      : b,
  }
}

/** The turn is over: the creature curls up asleep where it stands. */
export const onTurnDone = (
  world: World,
  tide: number | undefined,
  isAnswered: boolean,
  durationMs?: number,
  isAborted = false,
  at?: number,
): World => {
  const b = world.beast
  const end = at ?? (world.turnStartedAt !== undefined && durationMs !== undefined ? world.turnStartedAt + durationMs : undefined)
  const sleeps = b !== undefined && b.doneAt === undefined && end !== undefined && end > 0
  let next: World = {
    ...world,
    isWorking: false,
    waiting: undefined,
    activity: { kind: 'idle', at: world.activity?.at ?? 0 },
    beast: sleeps ? { ...b, doneAt: Math.max(b.bornAt, end), ...(isAborted ? { isAborted: true } : {}) } : b,
  }
  if (sleeps) {
    const s = beastShape(b, Math.max(b.bornAt, end))
    next = say(
      next,
      isAborted
        ? `Turn ${b.turn} was cut short after ${span(s.seconds)}; the creature curls up early.`
        : `The creature curls up to sleep after ${span(s.seconds)}, fat on ${tally(s.tokens)} tokens.`,
    )
  }
  if (tide !== undefined) {
    const marks = [50, 75, 90]
    const crossed = marks.find(m => world.tide < m && tide >= m)
    next = { ...next, tide }
    if (crossed !== undefined) next = say(next, `The tide of context rises past ${crossed}%. The shores grow narrow.`)
  }
  const calmer = blend(next.mood, { joy: next.mood.joy, storm: 0, wonder: next.mood.wonder, haste: 0 }, 0.18)
  return withMood(next, isAnswered ? nudge(calmer, 'joy', 0.05) : calmer)
}

export const onCompact = (world: World, tide: number | undefined): World => {
  const next: World = {
    ...world,
    compactions: world.compactions + 1,
    tide: tide ?? Math.max(0, world.tide * 0.25),
  }
  return plant(
    say(next, 'The context is compacted; the tide goes out. A monolith is carved with the summary.'),
    'monolith',
    `monolith:${world.compactions + 1}`,
    `Compaction ${world.compactions + 1}: a summary of everything before`,
    { born: 'A monolith remains, carved with a summary.', grown: () => 'The monolith hums.' },
  )
}

export type HistoryMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; isError?: true }[]
  toolResults?: readonly unknown[]
}

/** Replays a transcript so a session already under way arrives with its island. */
export const replay = (world: World, messages: readonly HistoryMessage[]): World => {
  let next = world
  for (const message of messages) {
    if (message.role === 'user') {
      if ((message.toolResults?.length ?? 0) === 0) next = onPrompt(next, message.text)
      continue
    }
    for (const use of message.toolUses) {
      next = onTool(next, use.tool, use.input, false)
      if (use.isError === true) next = onToolError(next, use.tool)
    }
  }
  return say({ ...next, isSeeded: true }, 'The island remembers everything said so far.')
}

// ---------------------------------------------------------------- Claude at work

/** What Claude is doing this moment: thinking, writing, or at a tool. */
export const onActivity = (world: World, kind: NonNullable<World['activity']>['kind'], at: number): World =>
  world.activity?.kind === kind ? world : { ...world, activity: { ...world.activity, kind, at } }

const MODE_KIND: Record<string, NonNullable<World['activity']>['kind']> = {
  thinking: 'thinking',
  requesting: 'thinking',
  responding: 'writing',
  'tool-input': 'tool',
  'tool-use': 'tool',
}

/** The spinner's own words for what the turn is doing (`Creating notes.md`, `Sauteing`), while it runs. */
export const onSpinner = (world: World, words: string, mode: string, at: number): World => {
  if (world.isWorking !== true) return world
  const verb = clip(words.replace(/[.…\s]+$/, ''), 48)
  const kind = MODE_KIND[mode] ?? world.activity?.kind ?? 'thinking'
  if (verb === '' || (world.activity?.verb === verb && world.activity.kind === kind)) return world
  return { ...world, activity: { kind, at, verb } }
}

/** A question or permission prompt waits on the person; undefined when it is answered. */
export const onWaiting = (world: World, reason: string | undefined, at: number): World => {
  if (reason === undefined) return world.waiting === undefined ? world : { ...world, waiting: undefined }
  const next: World = { ...world, waiting: { reason: clip(reason, 120), at } }
  return world.waiting === undefined ? say(next, 'The bell rings: Claude is waiting on you.') : next
}

/** What the treasury says of the session's tokens: a bill, or on a subscription only what they would have cost. */
export const costText = (world: World): string => {
  const usd = `$${(world.cost ?? 0).toFixed(2)}`
  return world.isFlatRate === true ? `≈${usd} at API prices` : usd
}

/**
 * The session's tokens priced: a treasury opens on the first cent, its coins
 * piling with the rest. On a subscription (`isFlatRate`, the account reports
 * rate limits) the figure is what the tokens would cost at API list prices,
 * not a bill: the plan is a flat fee, so the treasury says so.
 */
export const onCost = (world: World, usd: number | undefined, isFlatRate = false): World => {
  if (usd === undefined || usd <= 0 || (usd === world.cost && isFlatRate === (world.isFlatRate === true))) return world
  const next: World = { ...world, cost: usd, isFlatRate }
  const label = isFlatRate
    ? `The treasury: this session's tokens would cost ${costText(next)}; your plan is a flat fee, so none of it is billed`
    : `The treasury: this session has cost ${costText(next)}`
  return next.features.some(f => f.kind === 'treasury')
    ? { ...next, features: next.features.map(f => (f.kind === 'treasury' ? { ...f, label } : f)) }
    : plant(next, 'treasury', 'treasury', label, {
      born: 'A treasury opens its doors; the first coins clink in.',
      grown: () => 'Coins clink into the treasury.',
    })
}

// ---------------------------------------------------------------- tests

/** Counts from a test run's output, when the command ran tests and said how they went. */
export const parseTests = (command: string, text: string): { passed: number; failed: number } | undefined => {
  if (!/\b(tests?|jest|vitest|pytest|mocha|spec|ava|tap|phpunit|rspec|ctest|unittest)\b/i.test(command)) return undefined
  const last = (re: RegExp): number | undefined => {
    let value: number | undefined
    for (const m of text.matchAll(re)) value = Number(m[1])
    return value
  }
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)]
  if (cargo.length > 0) {
    return {
      passed: cargo.reduce((n, m) => n + Number(m[1]), 0),
      failed: cargo.reduce((n, m) => n + Number(m[2]), 0),
    }
  }
  const passed = last(/(\d+)\s+(?:tests?\s+)?(?:passed|passing|pass)\b/gi) ?? last(/Passed:\s*(\d+)/g)
  const failed = last(/(\d+)\s+(?:tests?\s+)?(?:failed|failing|fail)\b/gi) ?? last(/Failed:\s*(\d+)/g)
  if (passed === undefined && failed === undefined) return undefined
  return { passed: passed ?? 0, failed: failed ?? 0 }
}

export const onTests = (world: World, result: { passed: number; failed: number }, command: string, at: number): World => {
  const wasRed = (world.tests?.failed ?? 0) > 0
  const isGreen = result.failed === 0 && result.passed > 0
  const next: World = {
    ...world,
    tests: { ...result, at, command: clip(command, 80), greenAt: isGreen ? at : world.tests?.greenAt },
  }
  if (isGreen) {
    return say(next, wasRed ? 'Every test passes again. A rainbow arcs over the town.' : `All ${result.passed} tests pass; the watchtowers fly green.`)
  }
  return say(next, `${result.failed} ${result.failed === 1 ? 'test fails' : 'tests fail'}; bugs crawl out of the watchtowers.`)
}

// ---------------------------------------------------------------- git

/** `git status --porcelain=v2 --branch`, read against the repository's top folder. */
export const parseGitStatus = (porcelain: string, top: string) => {
  const root = top.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  let branch: string | undefined
  let ahead = 0
  let behind = 0
  const dirty: string[] = []
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const fields = line.split(' ')
    if (line.startsWith('# branch.head ')) branch = fields[2]
    else if (line.startsWith('# branch.ab ')) {
      ahead = Math.abs(Number(fields[2]) || 0)
      behind = Math.abs(Number(fields[3]) || 0)
    } else if (line.startsWith('1 ')) dirty.push(fields.slice(8).join(' '))
    else if (line.startsWith('2 ')) dirty.push(fields.slice(9).join(' ').split('\t')[0] ?? '')
    else if (line.startsWith('u ')) dirty.push(fields.slice(10).join(' '))
    else if (line.startsWith('? ')) dirty.push(line.slice(2))
  }
  return {
    branch,
    ahead,
    behind,
    dirty: dirty
      .filter(Boolean)
      .slice(0, 300)
      .map(p => `${root}/${p.replace(/\\/g, '/').replace(/^"|"$/g, '').toLowerCase()}`),
  }
}

/** The repository as git reports it; a new HEAD is a commit, and the harbor celebrates. */
export const onGit = (world: World, git: NonNullable<World['git']>, at: number, subject?: string): World => {
  const before = world.git
  const isCommit = before?.head !== undefined && git.head !== undefined && git.head !== before.head
  const commits = (before?.commits ?? 0) + (isCommit ? 1 : 0)
  let next: World = { ...world, git: { ...git, commits } }
  if (isCommit) {
    next = {
      ...next,
      events: [...(next.events ?? []), { id: next.tools * 1000 + commits, tool: 'git-commit', at }].slice(-MAX_EVENTS),
    }
    next = say(next, `A commit: “${clip(subject ?? 'changes', 50)}”. Fireworks over the harbor.`)
  }
  return next
}

/** Whether git says a file this island built is changed and not yet committed. */
export const isDirty = (world: World, f: Feature): boolean => {
  if (world.git?.hasRemote !== true || f.kind !== 'house' || !f.key.startsWith('file:')) return false
  const path = f.key.slice(5).replace(/\\/g, '/').toLowerCase()
  return world.git.dirty.includes(path)
}

// ---------------------------------------------------------------- the machine

export type Reading = Partial<Omit<NonNullable<World['system']>, 'at'>>

const step = (v: number | undefined, by: number) => (v === undefined ? undefined : Math.round(v / by) * by)
type Proc = NonNullable<NonNullable<World['system']>['procs']>[number]
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
/**
 * The busiest programs: each one's share of the CPU, the memory its processes
 * hold (to 10 MB), how many there are, when the oldest started, and which way
 * its share went since the last reading. A reader of an older kind sends only
 * names and shares; what it leaves out is kept from before.
 */
const procsOf = (now: readonly Proc[], before: readonly Proc[] = []): Proc[] =>
  now
    .map(p => {
      const was = before.find(q => q.name === p.name)
      const cpu = step(p.cpu, 0.01) ?? 0
      const mem = step(count(p.mem), 10) ?? was?.mem
      const many = count(p.count) === undefined ? was?.count : Math.round(p.count!)
      const since = count(p.since) ?? was?.since
      return {
        name: p.name,
        cpu,
        ...(mem === undefined ? {} : { mem }),
        ...(many === undefined ? {} : { count: many }),
        ...(since === undefined ? {} : { since }),
        trend: was === undefined ? 0 : Math.round((cpu - was.cpu) * 100) / 100,
      }
    })
    .filter(p => p.cpu >= 0.02)
const flow = (v: number | undefined) => (v === undefined ? undefined : v < 2048 ? 0 : 2 ** Math.round(Math.log2(v)))
const AWAY_SECONDS = 300

/**
 * A reading from the machine. Wobbles are rounded off so the island redraws
 * only for real change: the same world comes back when nothing moved.
 */
export const onReading = (world: World, r: Reading, at: number): World => {
  const prev = world.system ?? { at }
  const gpu = r.gpu
  const system: NonNullable<World['system']> = {
    ...prev,
    cpu: step(r.cpu, 0.05) ?? prev.cpu,
    ram: step(r.ram, 0.02) ?? prev.ram,
    diskFree: r.diskFree ?? prev.diskFree,
    diskFreeGb: r.diskFreeGb ?? prev.diskFreeGb,
    diskRead: flow(r.diskRead) ?? prev.diskRead,
    diskWrite: flow(r.diskWrite) ?? prev.diskWrite,
    netDown: flow(r.netDown) ?? prev.netDown,
    netUp: flow(r.netUp) ?? prev.netUp,
    gpu: gpu === undefined
      ? prev.gpu
      : { load: step(gpu.load, 0.05) ?? 0, temp: step(gpu.temp, 2) ?? 0, mem: step(gpu.mem, 0.02) ?? 0, name: gpu.name },
    procs: r.procs === undefined
      ? prev.procs
      : procsOf(r.procs, prev.procs),
    ports: r.ports ?? prev.ports,
    idle: r.idle === undefined ? prev.idle : r.idle < 60 ? 0 : Math.floor(r.idle / 60) * 60,
    at: prev.at,
  }
  const { at: _a, ...a } = system
  const { at: _b, ...b } = prev
  let next: World = world
  if (JSON.stringify(a) !== JSON.stringify(b)) next = { ...next, system: { ...system, at } }
  const idle = r.idle
  if (idle !== undefined && idle >= AWAY_SECONDS && next.awaySince === undefined) {
    next = say({ ...next, awaySince: at - idle * 1000 }, 'You stepped away. Mist settles over the island; the animals sleep.')
  } else if (idle !== undefined && idle < 30 && next.awaySince !== undefined) {
    const minutes = Math.max(1, Math.round((at - next.awaySince) / 60000))
    next = say(
      {
        ...next,
        awaySince: undefined,
        returnedAt: at,
        events: [...(next.events ?? []), { id: next.tools * 1000 + 999, tool: 'presence-return', at }].slice(-MAX_EVENTS),
      },
      `You are back after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Light breaks over the town.`,
    )
  }
  return next
}

/** Fractions the island draws by: how hard the rivers run, how busy the harbor is. */
export const throughput = (world: World) => {
  const s = world.system
  const scale = (bytes: number | undefined, low: number, high: number) =>
    bytes === undefined || bytes <= low ? 0 : Math.min(1, Math.log10(bytes / low) / Math.log10(high / low))
  return {
    disk: scale((s?.diskRead ?? 0) + (s?.diskWrite ?? 0), 1e5, 5e7),
    down: scale(s?.netDown, 1e4, 2e7),
    up: scale(s?.netUp, 1e4, 1e7),
  }
}
