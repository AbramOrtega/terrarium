import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TerrariumSystem, TerrariumView, TerrariumWorld } from '../types'
import { renderRaster } from './render-raster'
import { mirrorSvg, renderSvg } from './render-svg'
import { frameData, frameScript, isViewerKey, photoScene, serverScript, viewerKeyOf } from './viewer'
import { type ChatItem, chatItems, promptFromUpload, withLive } from './chat'
import {
  editSpots,
  emptyWorld,
  hash,
  importsOf,
  measure,
  onActivity,
  onAgentDone,
  onAgentList,
  onEdited,
  onMeasure,
  onCompact,
  costText,
  onCost,
  onGit,
  onPrompt,
  onReading,
  onStep,
  onSpinner,
  onSpawn,
  onSystem,
  onTests,
  onTool,
  onToolError,
  onTurnDone,
  onWaiting,
  parseGitStatus,
  parseTests,
  type Reading,
  replay,
  upgrade,
  sunHour,
  WEATHER_GLYPH,
  weatherOf,
} from './world'

const PANE = 'terrarium'
const TITLE = 'Terrarium'
const NARROW = 72
const WIDE = 140

const world = atom({ plugin: 'terrarium', key: 'world' } as const, emptyWorld(0))
const view = atom({ plugin: 'terrarium', key: 'view' } as const, {
  yaw: 35,
  isOrbiting: false,
  isLegendOpen: false,
  isWide: false,
  isLive: false,
} satisfies TerrariumView)
// A heartbeat while Claude works, so the turn's creature is redrawn as it grows.
const pulse = atom({ plugin: 'terrarium', key: 'pulse' } as const, 0)

const LEGEND = [
  '🕷 The creature: your first prompt hatches it; each one after wakes it, small again. Its legs grow with the time the turn runs, its body with the tokens it eats, and it sprouts eyes on its face as it feeds. It crawls to the middle of the files it is working on, turns to face where its tentacles reach, and curls up asleep when the turn ends.',
  '🫧 In 3D its body is a heap of lobes that churn as fast as it eats, squeezing around buildings and climbing their roofs. Mouths chew while Claude writes; it boils while it thinks; between calls it tastes the air toward what it touched last; waiting on you it turns to watch you; asleep it peeks at the file it worked on most; your ideas rise out of it as lanterns; and it shivers when you speak to it mid-turn.',
  '🐣 Spawnlings: each subagent is a smaller creature of its own, laid by its parent at its type’s nest and hatching there. Its colour is its agent type (Explore teal, Plan cobalt, general-purpose amber, any other type a colour of its own; a fork wears its parent’s violet), its eyes the model it runs on (Opus lime, Sonnet gold, Haiku ice blue, Fable rose). It grows by the same rules on its own time and tokens, crawls to the middle of its own work and reaches for each of its own tool calls. A silk thread ties it to a parent that waits on it; one in the background roams free. Done, it crawls home and is absorbed, handing back its answer (the parent’s veins flash); failed or stopped, it curls up where it stands until your next prompt. Teammates keep their name: asleep between messages, and a message flies between creatures as a parcel. A workflow’s swarm marches out of its nest in file.',
  '⚡ Each tool call: a tentacle reaches out to what it works on, in its own way. A read drinks it in (green, swallowing). Writing a file pours gold into it from above. An edit picks at it with quick pincers, sparks flying. A shell command coils around the forge, embers rising. A search holds an eye over it, sweeping a beam. A subagent is laid as an egg in its nest; a skill blooms; an MCP call crackles. A failed call snatches its tentacle back, red. Lightning shoots up for the web.',
  '⌂ Buildings: files written or edited, each language in its own architecture and colour: TypeScript and JavaScript townhouses, Python cottages, Rust iron forts, Go workshops, C and C++ stone keeps, CSS painted houses, HTML pavilions, Markdown libraries, JSON, YAML and TOML vaults, shell-script tool sheds, SQL silos; tests are watchtowers. Measured from the file itself: a floor for every doubling of its lines, a footprint as wide as its lines run, a wing for every few functions, a corner tower for each type or class, a pennant for each export (hover one for the counts). A folder makes a district; recently edited files glow, and their chimneys smoke.',
  '🧱 History in the walls: each edit paints a band where it fell in the file (the top of the file at the top floor), as thick as the passage it changed, in the color of the prompt that made it, so one prompt’s edits match across town. A file left alone weathers: roofs fade, moss gathers, ivy climbs. A crane on the roof: TODOs still to do. Boarded windows: FIXMEs. Flower boxes: a file that explains itself in comments. A patch on the wall: an edit that failed there and was later made good.',
  '🛣 Streets: files that import each other are joined by stone streets along the lines between plots, wider where several imports share the way; a file only read is reached by a dirt footpath. A file three or more others import stands on a paved square with lamps.',
  '🔔 Parts: a spire on an entry point (main, index, app, cli, server…); a clock face on a file two or more others import, its hands at the time it last changed; a dormer for each file it imports; a balcony for every two times Claude read it; a bay window when its lines run wide; a flag on the most worked building of each folder. 🚪 While Claude works on a file its door stands open on a lit room. 🚶 Townsfolk carry work between files worked one after the other in the last half hour, along the streets. Up close you see every detail; far off, the small parts are left out so the 3D window stays smooth, and in the pane the buildings worked last stay a step finer.',
  '🏰 Districts: each folder with two or more buildings, paved in its own stone (flagstones, cobbles, brick or slate), walled where it meets the rest of the town, open where a street runs, and entered by a gate bearing its name. A folder inside another on the island is a quarter: hedged instead of walled, and settled beside its parent. 🌉 A test stands beside the file it tests (by name, or else what it imports), joined to it by a rope bridge hung with the last test run’s colors.',
  '♣ Trees: files read. ▲ Forges: shell commands. † Beacons: searches. × Windmills: the web. ◍ Nests: subagents, one per agent type, an eggshell for each that hatched. ◊ Crystals: MCP servers. Π Shrines: skills.',
  'Wilderness: as large as the free space on the project’s drive. Forests, rivers, waterfalls, peaks; deer and rabbits multiply with the conversation.',
  'Bugs: failed tool calls, around the scorched ground they came from. A volcano wakes once errors pile up.',
  '🐢 The island is a disc of rock on a turtle swimming through space, and the turtle carries the conversation: it holds its breath and swims hard while Claude thinks or writes, paddles while tools run, breathes out stardust and glides when the turn ends, then folds its flippers; it opens its beak and calls at each new prompt, draws its head in while you are away, and tilts its head to watch you when Claude waits on you. Its shell weathers with the session’s age, and each plate gains a growth ring for each compaction. The sea pours over the rim all round, its spray thicker as the context fills; roots hang under the rock below each tree.',
  'Sun: the session limit, a small sun circling the disc: rising at the eastern rim at none used, setting at the western rim when it runs out, then gone round beneath, lighting the turtle’s belly (the clock where no limit is reported). Moon: the weekly limit.',
  'Clouds: CPU use. Waves: RAM use. Rain: context fill past 70% (a storm near the top). Tide: context fill; a compaction lets the tide out and leaves a monolith (your buildings stay as they are).',
  'Weather: the mood of your words. Lanterns: your questions and ideas (hover one).',
  '✦ Over the creature: the spinner’s own words for what Claude is doing, a violet swirl while it thinks, pages fluttering while it writes. 💤 Asleep, eyes shut, tentacles limp: the turn is done (pale z’s), or Claude is waiting on you (amber z’s).',
  '⚓ The harbor (projects with a git remote): scaffolding on uncommitted files, fireworks on a commit, ships at the pier to push, ships offshore to pull, the branch on its flag.',
  '✓ Watchtowers fly green or red with the last test run; failures add bugs; going green brings a rainbow. ¤ The treasury’s coins: what this session’s tokens are worth at API prices. On a subscription that is not a bill (your plan is a flat fee); hover the treasury. The lagoon’s clarity: how much the prompt cache serves.',
  '≈ Rivers and waterfalls run with disk activity. ⛵ Ships sail in with downloads and out with uploads. 🔥 Forges glow with GPU load; crystals fill with GPU memory.',
  '👣 Giants: each program over 2% of the CPU, named, as big as its load. In 3D each is dressed as what it is (Claude, browser, editor, runtime, build tool, shell, system, media), round with its memory, bearded with its hours, trailed by its other processes; it rises when busy and sinks when quiet, rests, strides or stomps with its load, and goes where it belongs (its lighthouse, the creature, the forge, the file being edited). 🗼 Lighthouses on the coast: dev servers listening on this machine. 💤 Away from the keyboard: mist settles and the animals sleep.',
  '✧ The creature’s veins pulse with how fast it eats tokens. Light ripples on the seabed when the prompt cache serves well. Cloud shadows sweep the land as the CPU works. The spray off the rim thickens as the context fills. A commit sends a shooting star. Grass lies flat where its feet came down.',
  '🔊 Sounds: a thud for each footstep, a squelch as a tentacle reaches and a slurp letting go; sips for reads, glugs for new files, taps for edits, sonar pings for searches, chimes for skills and MCP, pops as spawnlings hatch; a spawnling’s voice is pitched by its model (Haiku highest, Fable lowest), it ticks with each of its tool calls and cracks when it fails, and its parent gulps it home, louder and deeper the longer its answer; a growl on waking and a sigh falling asleep, zaps, cracks, sizzles, thunder, fireworks; rain, sea, wind and crickets beneath; in 3D the turtle calls at each prompt, its flippers sweep as it swims, and the rim’s fall roars louder as the context fills. 🔊/🔇 (or M in the 3D window) turns them off.',
  '📷 /terrarium photo (or the 📷 button) renders a postcard of the island in Blender. While the 3D window is open, the pane shows its picture (🪞 switches back to the drawing).',
]

const statsLine = (w: TerrariumWorld): string => {
  const s = w.system
  const parts = [
    `Turn ${w.turn}`,
    `${w.features.length} landmarks`,
    `${w.tools} tool calls`,
    WEATHER_GLYPH[weatherOf(w.mood)],
    `tide ${Math.round(w.tide)}%`,
  ]
  if (w.waiting !== undefined) parts.unshift('🔔 waiting on you')
  if (w.cost !== undefined) parts.push(costText(w))
  if (w.tests !== undefined) parts.push(`tests ${w.tests.passed}✓ ${w.tests.failed}✗`)
  if (w.git?.hasRemote === true) {
    const sync = `${w.git.ahead > 0 ? ` ↑${w.git.ahead}` : ''}${w.git.behind > 0 ? ` ↓${w.git.behind}` : ''}`
    parts.push(`⎇ ${w.git.branch ?? '?'}${sync}${w.git.dirty.length > 0 ? ` · ${w.git.dirty.length} uncommitted` : ''}`)
  }
  if (s?.limit !== undefined) parts.push(`limit ${Math.round(s.limit)}%`)
  if (s?.cpu !== undefined) parts.push(`cpu ${Math.round(s.cpu * 100)}%`)
  if (s?.ram !== undefined) parts.push(`ram ${Math.round(s.ram * 100)}%`)
  if (s?.gpu !== undefined) parts.push(`gpu ${Math.round(s.gpu.load * 100)}% ${Math.round(s.gpu.temp)}°C`)
  if (s?.diskFreeGb !== undefined) parts.push(`${Math.round(s.diskFreeGb)} GB free`)
  if (w.awaySince !== undefined) parts.push('💤 away')
  return parts.join(' · ')
}

const safely = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // The island is a mirror: nothing it fails at may touch the conversation.
  }
}

const hourNow = async ($: EngineInterface): Promise<number> => {
  const d = new Date(await $.clock.now())
  return d.getHours() + d.getMinutes() / 60
}

const openPane = ($: EngineInterface, isWide: boolean) =>
  $.ui.open({ id: PANE, title: TITLE, columns: isWide ? WIDE : NARROW })

const liveDir = async ($: EngineInterface): Promise<string | undefined> => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : `${home.replace(/\\/g, '/')}/.claude/terrarium`
}

// ---------------------------------------------------------------- the machine

const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

/** The session limit, the weekly one, and the bill, as the session reports them. */
const refreshAccount = async ($: EngineInterface): Promise<void> => {
  const usage = await $.session.usage()
  const at = await $.clock.now()
  const limit = usage.rateLimits.find(r => r.kind === 'five_hour') ?? usage.rateLimits.find(r => r.kind !== 'seven_day')
  const week = usage.rateLimits.find(r => r.kind === 'seven_day')
  const system: TerrariumSystem = { at }
  if (limit !== undefined) {
    system.limit = limit.percentUsed
    system.limitKind = limit.kind
  }
  if (week !== undefined) system.weekLimit = week.percentUsed
  // Rate limits are reported only on a subscription: the dollars are then API prices, not a bill.
  await update($, world, w => {
    const next = onCost(onSystem(w, system), usage.cost?.usd, usage.rateLimits.length > 0)
    // The session's age: how weathered the turtle's shell is.
    return next.startedAt === usage.startedAt ? next : { ...next, startedAt: usage.startedAt }
  })
}

/** The session's agents as the engine lists them: a spawnling whose end went unseen finishes now. */
const refreshAgents = async ($: EngineInterface): Promise<void> => {
  if ((await read($, world)).brood?.some(s => s.doneAt === undefined) !== true) return
  const list = await $.agent.list()
  const at = await $.clock.now()
  await update($, world, w => onAgentList(w, list, at))
}

// A module variable is enough here: a reload stops the reader with the module.
let isSampling = false

/**
 * The machine's reader, for the module's life: one PowerShell process that
 * prints a JSON reading every few seconds (scripts/sample.ps1), each folded
 * into the island only when it changes something.
 */
const startSampler = async ($: EngineInterface): Promise<void> => {
  if (isSampling || !(await isWindows($))) return
  const cwd = await $.session.cwd()
  const drive = /^([a-zA-Z]):/.exec(cwd)?.[1] ?? 'C'
  const source = await $.fs.read(`${$.plugin.root}/scripts/sample.ps1`)
  const script = source.replace(/^param\([^)]*\)/m, `$Drive = '${drive}'; $Every = 4`)
  isSampling = true
  void (async () => {
    let buffer = ''
    try {
      const sampler = $.process.spawn({ argv: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)] })
      for await (const piece of sampler) {
        if (piece.stream !== 'stdout') continue
        buffer += piece.text
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('{')) continue
          await safely(async () => {
            const reading = JSON.parse(line) as Reading
            const at = await $.clock.now()
            const current = await read($, world)
            if (onReading(current, reading, at) !== current) await update($, world, w => onReading(w, reading, at))
          })
        }
      }
    } catch {
      // the reader could not start or stopped: the island keeps its last readings
    }
    isSampling = false
  })()
}

/** Elsewhere than Windows: memory, load and the drive, read in one shot. */
const samplePosix = async ($: EngineInterface): Promise<void> => {
  const run = await $.process.run(
    ['sh', '-c', 'df -kP . | tail -1; cat /proc/meminfo 2>/dev/null | head -3; cat /proc/loadavg 2>/dev/null; getconf _NPROCESSORS_ONLN'],
    { timeoutMs: 20000 },
  )
  const lines = run.stdout.split('\n')
  const df = (lines[0] ?? '').trim().split(/\s+/)
  const used = Number(df[2])
  const avail = Number(df[3])
  const reading: Reading = {}
  if (used + avail > 0) {
    reading.diskFree = avail / (used + avail)
    reading.diskFreeGb = (avail * 1024) / 1e9
  }
  const mem = (name: string) => Number(/(\d+)/.exec(lines.find(l => l.startsWith(name)) ?? '')?.[1])
  const total = mem('MemTotal')
  const available = mem('MemAvailable')
  if (total > 0 && available >= 0) reading.ram = 1 - available / total
  const load = Number(lines.find(l => /^\d+\.\d+ \d+\.\d+/.test(l))?.split(' ')[0])
  const cores = Number(lines[lines.length - 1] || lines[lines.length - 2])
  if (load >= 0 && cores > 0) reading.cpu = Math.min(1, load / cores)
  const at = await $.clock.now()
  await update($, world, w => onReading(w, reading, at))
}

// ---------------------------------------------------------------- the repository

// undefined until asked; null when the folder is not in a repository.
let gitTop: string | null | undefined
let gitAskedAt = 0

/** Git's view of the project, shown only when the repository has a remote. */
const refreshGit = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  if (gitTop === undefined || (gitTop === null && now - gitAskedAt > 120000)) {
    gitAskedAt = now
    const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 10000 })
    gitTop = top.exitCode === 0 ? top.stdout.trim() : null
  }
  if (gitTop === null || gitTop === undefined) return
  const remotes = await $.process.run(['git', '-C', gitTop, 'remote', '-v'], { timeoutMs: 10000 })
  const remote = remotes.stdout.split('\n').find(line => line.includes('(fetch)'))
  const current = await read($, world)
  if (remote === undefined) {
    if (current.git?.hasRemote !== false) {
      await update($, world, w => ({ ...w, git: { hasRemote: false, ahead: 0, behind: 0, dirty: [], commits: 0, at: now } }))
    }
    return
  }
  const host = /@([^:/]+)[:/]/.exec(remote)?.[1] ?? /:\/\/(?:[^@/]+@)?([^/:]+)/.exec(remote)?.[1]
  const status = await $.process.run(['git', '-C', gitTop, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 10000 })
  const log = await $.process.run(['git', '-C', gitTop, 'log', '-1', '--format=%H%x09%s'], { timeoutMs: 10000 })
  const [head, subject] = log.stdout.trim().split('\t')
  const parsed = parseGitStatus(status.stdout, gitTop)
  const git = { hasRemote: true, host, ...parsed, head: head || undefined, commits: current.git?.commits ?? 0, at: now }
  const same = (a: unknown) => JSON.stringify({ ...(a as object), at: 0, commits: 0 })
  if (same(current.git) === same(git)) return
  if (current.git?.head !== undefined && git.head !== undefined && git.head !== current.git.head) await safely(() => sound($, 'firework', 0.5))
  await update($, world, w => onGit(w, git, now, subject))
}

// ---------------------------------------------------------------- the fullscreen window

// A module variable is enough here: a reload rewrites the frame once, harmlessly.
let lastFrame = -1
let engineHash = 0
let ticks = 0
const deliveredMidTurn = new Set<string>()
// The spinner's words, as last drawn. A drawing may not write state, so they
// wait here until the heartbeat carries them onto the island.
let spinner: { words: string; mode: string } | undefined
let spinnerShown = ''
// The Agent calls seen, by their tool_use ids: a spawn from one already has its egg in the nest.
const agentCalls = new Set<string>()
// The 3D window's chat panel: the transcript's rows (read again once something
// was said or done), what Claude is writing this moment, the panel's file as
// last written, and the last message the panel sent.
let chatDirty = true
let chatBase: ChatItem[] = []
let chatStream = ''
let chatWritten = ''
let promptSeen = 0

/** The conversation for the 3D window's chat panel, rewritten when it changes. */
const writeChat = async ($: EngineInterface): Promise<void> => {
  const dir = await liveDir($)
  if (dir === undefined) return
  if (chatDirty) {
    chatDirty = false
    chatBase = chatItems(await $.session.messages())
  }
  const w = await read($, world)
  const v = await read($, view)
  const body = JSON.stringify({
    items: withLive(chatBase, chatStream),
    isWorking: w.isWorking === true,
    verb: w.activity?.verb ?? '',
    waiting: w.waiting?.reason ?? '',
    taken: v.promptId ?? '',
  })
  if (body === chatWritten) return
  chatWritten = body
  await $.fs.write(`${dir}/chat.json`, body)
}

/**
 * A message typed in the 3D window's chat panel: the viewer's own page left
 * it (the server takes it from that page alone); it is submitted once, as
 * your own words, and waits its turn if Claude is at work.
 */
const pollPrompt = async ($: EngineInterface): Promise<void> => {
  const dir = await liveDir($)
  if (dir === undefined) return
  const file = `${dir}/upload/prompt.json`
  if (!(await $.fs.exists(file))) return
  const { mtimeMs } = await $.fs.stat(file)
  if (mtimeMs === promptSeen) return
  promptSeen = mtimeMs
  const sent = promptFromUpload(await $.fs.read(file))
  if (sent === undefined || (await read($, view)).promptId === sent.id) return
  await update($, view, v => ({ ...v, promptId: sent.id }))
  chatDirty = true
  void $.prompt.submit({ text: sent.text, asUser: true }).catch(() => undefined)
}

// The viewer's files as last installed. A reload of the mod follows only its
// hooks, so an edit to the viewer alone is taken up here: once its files
// change, they are installed again and the open 3D window reloads itself.
let viewerStamp = ''
const viewerStampNow = async ($: EngineInterface): Promise<string> =>
  (await Promise.all(['index.html', 'engine.js'].map(async f => (await $.fs.stat(`${$.plugin.root}/viewer/${f}`)).mtimeMs))).join('|')
const refreshViewer = async ($: EngineInterface): Promise<void> => {
  if (!(await read($, view)).isLive) return
  const dir = await liveDir($)
  if (dir === undefined || (await viewerStampNow($)) === viewerStamp) return
  await installViewer($, dir)
}

const installViewer = async ($: EngineInterface, dir: string): Promise<void> => {
  viewerStamp = await viewerStampNow($)
  const page = await $.fs.read(`${$.plugin.root}/viewer/index.html`)
  const engine = await $.fs.read(`${$.plugin.root}/viewer/engine.js`)
  engineHash = hash(engine)
  await $.fs.write(`${dir}/index.html`, page)
  await $.fs.write(`${dir}/engine.js`, engine)
  await safely(() => installSounds($, dir))
}

/** The mod's sound effects, handed to the 3D window as one script of base64 clips. */
const installSounds = async ($: EngineInterface, dir: string): Promise<void> => {
  const folder = `${$.plugin.root}/sounds`
  const clips: Record<string, string> = {}
  for (const entry of await $.fs.list(folder)) {
    if (!entry.name.endsWith('.wav')) continue
    const { base64 } = await $.fs.read(`${folder}/${entry.name}`, { as: 'bytes' })
    clips[entry.name.slice(0, -4)] = base64
  }
  await $.fs.write(`${dir}/sounds.js`, `window.__sounds = ${JSON.stringify(clips)}\n`)
}

const writeFrame = async ($: EngineInterface, isForced: boolean): Promise<void> => {
  const v = await read($, view)
  if (!v.isLive && !isForced) return
  const w = await read($, world)
  const now = await $.clock.now()
  const s = w.system
  const asks = { photo: v.photoAt ?? 0, mirror: v.isMirror !== false, muted: v.isMuted === true }
  const signature = hash(`${JSON.stringify(w)}|${engineHash}|${asks.photo}|${asks.mirror}|${asks.muted}`)
  if (signature === lastFrame && !isForced) return
  lastFrame = signature
  const dir = await liveDir($)
  if (dir === undefined) return
  const limitHour = s?.limit === undefined ? null : sunHour(w, 12)
  await $.fs.write(`${dir}/frame.js`, frameScript(frameData(w, signature, statsLine(w), engineHash, limitHour, now, asks)))
}

// ---------------------------------------------------------------- the 3D window's picture, in the side pane

type Mirror = { at: number; jpeg: string; labels: [number, number, string][] }
// What the 3D window last sent (a module variable: a reload simply waits for the next).
let mirror: Mirror | undefined
let mirrorSeen = 0

/** The picture the 3D window sends every few seconds, checked whole before it is shown. */
const pollMirror = async ($: EngineInterface): Promise<void> => {
  const v = await read($, view)
  if (!v.isLive || v.isMirror === false) return
  const dir = await liveDir($)
  if (dir === undefined) return
  const file = `${dir}/upload/mirror.json`
  if (!(await $.fs.exists(file))) return
  const { mtimeMs } = await $.fs.stat(file)
  if (mtimeMs === mirrorSeen) return
  mirrorSeen = mtimeMs
  const raw = JSON.parse(await $.fs.read(file)) as Partial<Mirror>
  if (typeof raw.at !== 'number' || typeof raw.jpeg !== 'string' || raw.jpeg.length > 110_000 || !/^[A-Za-z0-9+/=]+$/.test(raw.jpeg)) return
  const labels = (Array.isArray(raw.labels) ? raw.labels : [])
    .filter((l): l is [number, number, string] => Array.isArray(l) && typeof l[0] === 'number' && typeof l[1] === 'number' && typeof l[2] === 'string')
    .slice(0, 90)
    .map(([x, y, text]) => [Math.round(x), Math.round(y), text.slice(0, 100)] as [number, number, string])
  mirror = { at: raw.at, jpeg: raw.jpeg, labels }
  await update($, pulse, n => n + 1)
}

// ---------------------------------------------------------------- measuring files

/** The tools whose file is measured once they are done with it. */
const MEASURED = new Set(['Read', 'Write', 'Edit', 'MultiEdit'])

// Files the backlog has tried, measured or not (gone, too big, not text): not tried again this session.
const tried = new Set<string>()

/**
 * Measures a file Claude has read or changed, on this machine: its lines,
 * parts and imports are counted, and only the counts are kept, never the text.
 */
const measureFile = async ($: EngineInterface, path: string): Promise<void> => {
  try {
    if (/\.(ipynb|png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|exe|dll|so|wasm|bin|mp3|wav|ogg|mp4|mov|woff2?|ttf|otf)$/i.test(path)) throw new Error('not text')
    const { kind, size } = await $.fs.stat(path)
    if (kind !== 'file' || size > 3_000_000) throw new Error('not measurable')
    const text = await $.fs.read(path)
    const shape = measure(path, text)
    const links = importsOf(path, text)
    await update($, world, w => onMeasure(w, path, shape, links))
  } catch {
    // Unmeasured, it keeps the shape it had.
  }
}

/**
 * Where a change will fall in its file, read from the file before it is
 * made (only positions are kept): each edit's place and size, or, for a
 * file written whole, whether it was there already.
 */
const editsAhead = async (
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ spots: { pos: number; span: number }[]; isRewrite: boolean }> => {
  const none = { spots: [], isRewrite: false }
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (path === '' || !['Write', 'Edit', 'MultiEdit'].includes(tool)) return none
  try {
    const { kind, size } = await $.fs.stat(path)
    if (kind !== 'file') return none
    if (tool === 'Write') return { spots: [], isRewrite: true }
    if (size > 3_000_000) return none
    const text = await $.fs.read(path)
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const asked = tool === 'Edit' ? [input] : Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    return {
      spots: editSpots(text, asked.map(e => ({ old: str(e.old_string), new: str(e.new_string), isAll: e.replace_all === true }))),
      isRewrite: false,
    }
  } catch {
    // A new file, or one that can't be read: no bands.
    return none
  }
}

/** The island's files from before measuring began (or before their notes were counted), measured a few at a time. */
const measureBacklog = async ($: EngineInterface): Promise<void> => {
  const w = await read($, world)
  const waiting = w.features
    .filter(f => (f.shape === undefined || f.shape.todos === undefined) && /^(file|read):/.test(f.key))
    .map(f => f.key.replace(/^(file|read):/, ''))
    .filter(path => !tried.has(path))
    .slice(0, 3)
  for (const path of waiting) {
    tried.add(path)
    await measureFile($, path)
  }
}

// ---------------------------------------------------------------- sound

// Whether this surface can play clips at all: the first refusal (a terminal with
// no player) ends the trying for the module's life.
let canPlay = true

/**
 * The sound of a tentacle taking hold, by what the call does there: a sip for
 * a read, a glug pouring out a new file, taps picking at an edit, a sonar
 * ping for a search, a sizzle at the forge, a zap for the web.
 */
const toolSound = (tool: string): string => {
  if (tool === 'Read') return 'sip'
  if (tool === 'Write') return 'glug'
  if (['Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'tap'
  if (tool === 'Bash' || tool === 'PowerShell') return 'sizzle'
  if (tool === 'Grep' || tool === 'Glob') return 'sonar'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'zap'
  if (tool === 'Agent' || tool === 'Task') return 'pop'
  if (tool === 'Skill' || tool.startsWith('mcp__')) return 'chime'
  return 'squelch'
}

/**
 * A sound effect from the pane, for the moments it shows: a tentacle taking
 * hold, the creature waking and sleeping. Quiet when muted, and while the 3D
 * window is open in view, which plays its own, in step with its motion.
 */
const sound = async ($: EngineInterface, name: string, gain = 0.6): Promise<void> => {
  if (!canPlay) return
  const v = await read($, view)
  if (v.isMuted === true) return
  if (v.isLive && mirror !== undefined && (await $.clock.now()) - mirror.at < 15_000) return
  void $.audio.play({ asset: `sounds/${name}.wav` }, { gain }).catch(() => {
    canPlay = false
  })
}

let soundSeen = 0

/** The 3D window's own sound switch, read back so the pane's says the same. */
const pollSound = async ($: EngineInterface): Promise<void> => {
  const dir = await liveDir($)
  if (dir === undefined) return
  const file = `${dir}/upload/sound.json`
  if (!(await $.fs.exists(file))) return
  const { mtimeMs } = await $.fs.stat(file)
  if (mtimeMs === soundSeen) return
  const isFirst = soundSeen === 0
  soundSeen = mtimeMs
  if (isFirst) return
  const raw = JSON.parse(await $.fs.read(file)) as { muted?: unknown }
  if (typeof raw.muted === 'boolean') await update($, view, v => ({ ...v, isMuted: raw.muted === true }))
}

// ---------------------------------------------------------------- photos

/** Blender, where this machine keeps it: BLENDER if set, else the newest install. */
const findBlender = async ($: EngineInterface): Promise<string | undefined> => {
  const named = await $.env.get('BLENDER')
  if (named !== undefined && (await $.fs.exists(named))) return named
  if (await isWindows($)) {
    const base = 'C:/Program Files/Blender Foundation'
    if (!(await $.fs.exists(base))) return undefined
    const installs = (await $.fs.list(base))
      .filter(e => e.kind === 'directory' && /^blender/i.test(e.name))
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const name of installs) {
      const exe = `${base}/${name}/blender.exe`
      if (await $.fs.exists(exe)) return exe
    }
    return undefined
  }
  for (const exe of ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender']) {
    if (await $.fs.exists(exe)) return exe
  }
  return undefined
}

// A photo asked for and not yet sent by the 3D window, and whether Blender is busy.
let photo: { id: number; blender: string } | undefined
let isRendering = false

const openFile = async ($: EngineInterface, path: string): Promise<void> => {
  const argv = (await isWindows($))
    ? ['explorer.exe', path.replace(/\//g, '\\')]
    : [((await $.env.get('HOME')) ?? '').startsWith('/Users/') ? 'open' : 'xdg-open', path]
  await $.process.run(argv, { timeoutMs: 10000 })
}

/** Asks the 3D window (opening it if need be) for its scene, for Blender to render. */
const takePhoto = async ($: EngineInterface): Promise<string> => {
  if (isRendering || photo !== undefined) return '📷 A photo is already on its way.'
  const blender = await findBlender($)
  if (blender === undefined) return 'Blender is not installed where the terrarium can find it. Install it, or set BLENDER to its path.'
  if (!(await read($, view)).isLive) await openFullscreen($)
  const id = await $.clock.now()
  photo = { id, blender }
  await update($, view, v => ({ ...v, photoAt: id }))
  await safely(() => writeFrame($, true))
  return '📷 Taking a photo: the 3D window sends its scene to Blender, which renders it in a minute or two and opens it.'
}

/** Once the 3D window has sent its scene: a clean copy for Blender, and Blender to render it. */
const pollPhoto = async ($: EngineInterface): Promise<void> => {
  if (photo === undefined || isRendering) return
  const dir = await liveDir($)
  if (dir === undefined) return
  const now = await $.clock.now()
  const sent = `${dir}/upload/photo-scene.json`
  const raw = (await $.fs.exists(sent)) ? (JSON.parse(await $.fs.read(sent)) as Record<string, unknown>) : undefined
  if (raw?.id !== photo.id) {
    if (now - photo.id > 90_000) {
      photo = undefined
      $.ui.toast('📷 The 3D window did not send its scene. Bring it to the front and try /terrarium photo again.')
    }
    return
  }
  const { blender } = photo
  photo = undefined
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const scene = photoScene(raw, `${dir}/photos/terrarium-${stamp}.png`)
  const scenePath = `${dir}/photos/scene.json`
  await $.fs.write(scenePath, JSON.stringify(scene))
  isRendering = true
  $.ui.toast('📷 Blender is rendering the island…')
  void (async () => {
    let log = ''
    try {
      const run = $.process.spawn({ argv: [blender, '-b', '--factory-startup', '-P', `${$.plugin.root}/scripts/photo.py`, '--', scenePath] })
      for await (const piece of run) log = (log + piece.text).slice(-8000)
    } catch {
      log += '\nPHOTO_FAILED Blender could not start\n'
    }
    isRendering = false
    const done = /PHOTO_DONE ([^\r\n]+)/.exec(log)?.[1]?.trim()
    const failed = /PHOTO_FAILED ([^\r\n]+)/.exec(log)?.[1]?.trim()
    if (done !== undefined) {
      $.ui.toast(`📷 The photo is ready: ${done}`)
      await safely(() => openFile($, done))
    } else {
      $.ui.toast(`📷 The photo did not render${failed === undefined ? '' : `: ${failed}`}.`)
    }
  })()
}

// The viewer is served from this machine to this machine, so every browser,
// the app's own pane included, runs it as a live page rather than a file.
const PORT = 47615
const VIEWER_URL = `http://localhost:${PORT}/`
let isServing = false

/** A PowerShell script handed over whole, so no quoting or execution policy comes between. */
const encodePowerShell = (script: string): string => {
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return bytes.toBase64()
}

/** The 3D window's key: made once a session and kept across reloads, so a window left open stays served. */
const viewerKey = async ($: EngineInterface): Promise<string> => {
  const known = (await read($, view)).viewerKey
  if (isViewerKey(known)) return known
  const fresh = viewerKeyOf(crypto.getRandomValues(new Uint8Array(16)))
  await update($, view, v => (isViewerKey(v.viewerKey) ? v : { ...v, viewerKey: fresh }))
  const kept = (await read($, view)).viewerKey
  return isViewerKey(kept) ? kept : fresh
}

/** Starts the viewer's server for the module's life (a reload stops it); false where it cannot. */
const startServer = async ($: EngineInterface, dir: string): Promise<boolean> => {
  if (isServing) return true
  if ((await $.env.get('OS')) !== 'Windows_NT') return false
  const source = await $.fs.read(`${$.plugin.root}/scripts/serve.ps1`)
  const script = serverScript(source, dir, PORT, await viewerKey($))
  isServing = true
  void (async () => {
    try {
      const server = $.process.spawn({ argv: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)] })
      for await (const piece of server) void piece
    } catch {
      // it could not start: the next open tries again
    }
    isServing = false
  })()
  return true
}

/** The server, up and answering before a browser is pointed at it. */
const ensureServer = async ($: EngineInterface, dir: string): Promise<boolean> => {
  const wasServing = isServing
  if (!(await startServer($, dir))) return false
  if (!wasServing) await $.clock.sleep(1500)
  return isServing
}

const openFullscreen = async ($: EngineInterface): Promise<string> => {
  const dir = await liveDir($)
  if (dir === undefined) return 'There is no home folder to keep the viewer in.'
  await installViewer($, dir)
  await update($, view, v => ({ ...v, isLive: true }))
  await writeFrame($, true)
  const isServed = await ensureServer($, dir)
  const page = isServed ? `${VIEWER_URL}?k=${await viewerKey($)}` : `${dir}/index.html`
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (await $.env.get('HOME')) ?? ''
  const argv = isWindows
    ? ['explorer.exe', isServed ? page : page.replace(/\//g, '\\')]
    : [home.startsWith('/Users/') ? 'open' : 'xdg-open', page]
  try {
    await $.process.run(argv)
  } catch {
    return `Open ${page} in a browser to see the island in 3D.`
  }
  return `The island opened in 3D at ${isServed ? VIEWER_URL : page}; press F there for fullscreen. It follows the conversation live.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await safely(() =>
      $.command.register({
        name: 'terrarium',
        description: 'Show the island this conversation is building',
        argumentHint: '[full | photo | wide | narrow | hide | save | reset]',
      }),
    )
    // Islands from earlier versions lose their towers; a burst creature sleeps instead.
    await safely(() => update($, world, w => upgrade(w)))
    await safely(async () => {
      const w = await read($, world)
      if (w.isSeeded) return
      const messages = await $.session.messages()
      const seed = (hash(`${e.cwd}|${await $.clock.now()}`) % 99991) + 1
      await update($, world, current => (current.isSeeded ? current : replay(emptyWorld(seed), messages)))
      const usage = await $.session.usage()
      const percent = usage.context.percent
      if (percent !== undefined) await update($, world, current => ({ ...current, tide: percent }))
    })
    // A viewer left open across a reload keeps its server and its engine current.
    await safely(async () => {
      if (!(await read($, view)).isLive) return
      const dir = await liveDir($)
      if (dir === undefined) return
      await installViewer($, dir)
      await startServer($, dir)
    })
    await safely(() => startSampler($))
    $.clock.after(600, async () => {
      await safely(() => refreshAccount($))
      await safely(() => refreshGit($))
      if (!(await isWindows($))) await safely(() => samplePosix($))
    })
    $.clock.every(20000, async () => {
      await safely(() => refreshAccount($))
      await safely(() => refreshAgents($))
      if (!(await isWindows($))) await safely(() => samplePosix($))
    })
    $.clock.every(15000, () => safely(() => refreshGit($)))
    $.clock.every(4000, () => safely(() => refreshViewer($)))
    $.clock.every(1200, async () => {
      const v = await read($, view)
      if (v.isOrbiting) await update($, view, x => ({ ...x, yaw: (x.yaw + 5) % 360 }))
      const said = spinner
      if (said !== undefined && `${said.words}|${said.mode}` !== spinnerShown) {
        spinnerShown = `${said.words}|${said.mode}`
        const at = await $.clock.now()
        await safely(() => update($, world, w => onSpinner(w, said.words, said.mode, at)))
      }
      if (v.isLive) await safely(() => writeFrame($, false))
      if (v.isLive) await safely(() => pollMirror($))
      if (v.isLive) await safely(() => pollSound($))
      // The chat panel: messages typed there go in; the conversation comes out.
      if (v.isLive) await safely(() => pollPrompt($))
      if (v.isLive) await safely(() => writeChat($))
      if (v.isLive) await safely(() => pollPrompt($))
      if (v.isLive) await safely(() => writeChat($))
      await safely(() => pollPhoto($))
      if (ticks % 2 === 0) await safely(() => measureBacklog($))
      ticks += 1
      if (ticks % 3 === 0 && (await read($, world)).isWorking === true) await update($, pulse, n => n + 1)
    })
    await safely(async () => {
      const surfaces = await $.session.surfaces()
      if (surfaces.some(surface => surface !== 'terminal')) await openPane($, (await read($, view)).isWide)
    })
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'terminal') await safely(async () => openPane($, (await read($, view)).isWide))
    return next(e)
  })

  // A prompt typed while Claude works is folded into the running turn: a spire where the creature stands.
  on('prompt.submit', async ($, e, next) => {
    // Typed by you: at the prompt, over Remote Control, or in the 3D window's chat panel.
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || (e.origin.kind === 'plugin' && e.origin.name === 'terrarium' && e.origin.asUser === true)
    chatDirty = true
    if (isPerson) {
      const at = await $.clock.now()
      await safely(() => update($, world, w => onWaiting(w, undefined, at)))
    }
    if (isPerson && e.turnId !== undefined && e.text.trim() !== '') {
      deliveredMidTurn.add(e.text.trim())
      const at = await $.clock.now()
      await safely(() => update($, world, w => onPrompt(w, e.text, at, w.isWorking === true)))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    chatDirty = true
    const text = e.text.trim()
    if (deliveredMidTurn.delete(text)) return next(e)
    if (text !== '') {
      const at = await $.clock.now()
      await safely(() => update($, world, w => onActivity(onWaiting(onPrompt(w, text, at, false), undefined, at), 'thinking', at)))
      await safely(() => sound($, 'growl', 0.7))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    const isQuestion = tool === 'AskUserQuestion'
    const at = await $.clock.now()
    if (tool === 'Agent' || tool === 'Task') {
      agentCalls.add(e.tool_use_id)
      if (agentCalls.size > 200) agentCalls.delete(agentCalls.values().next().value as string)
    }
    await safely(() =>
      update($, world, w => {
        const built = onTool(w, tool, input, e.agentId ?? false, at)
        const busy = isMain ? onActivity(built, 'tool', at) : built
        return isQuestion ? onWaiting(busy, 'A question for you', at) : busy
      }),
    )
    await safely(() => sound($, toolSound(tool), 0.5))
    const ahead = await editsAhead($, tool, input)
    const ran = await next(e)
    const done = await $.clock.now()
    if (isMain) chatDirty = true
    // Answered: whatever it waited on (a question, a permission prompt) is over.
    await safely(() => update($, world, w => onWaiting(w, undefined, done)))
    if (ran.deny !== undefined || ran.isError === true) {
      await safely(() => update($, world, w => onToolError(w, tool, done, e.agentId)))
      await safely(() => sound($, 'crack', 0.7))
    } else if (MEASURED.has(tool)) {
      const path = typeof input.file_path === 'string' ? input.file_path : ''
      if (path !== '' && tool !== 'Read') await safely(() => update($, world, w => onEdited(w, path, ahead.spots, done, ahead.isRewrite)))
      if (path !== '') await measureFile($, path)
    }
    if (tool === 'Bash' || tool === 'PowerShell') {
      const command = typeof input.command === 'string' ? input.command : ''
      const tests = parseTests(command, ran.text ?? '')
      if (tests !== undefined) await safely(() => update($, world, w => onTests(w, tests, command, done)))
      if (/\bgit\b/.test(command)) await safely(() => refreshGit($))
    }
    return ran
  })

  // A permission prompt or a dialog waits on the person: the bell rings.
  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/i.test(e.notification_type)) {
      const at = await $.clock.now()
      await safely(() => update($, world, w => onWaiting(w, e.message, at)))
    }
    return next(e)
  })

  // Each model request of the main loop: what Claude is doing as it streams
  // (thinking, writing, reaching for a tool), then what it cost.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    const isMain = e.agentId === undefined
    let last = ''
    // What Claude writes, as it writes it: the chat panel shows it before the transcript holds it.
    if (isMain) chatStream = ''
    for await (const chunk of stream) {
      if (isMain && chunk.kind === 'text') chatStream += chunk.text
      if (isMain && (chunk.kind === 'thinking' || chunk.kind === 'text' || chunk.kind === 'tool') && chunk.kind !== last) {
        last = chunk.kind
        const kind = chunk.kind === 'text' ? 'writing' : chunk.kind
        const at = await $.clock.now()
        await safely(() => update($, world, w => onActivity(w, kind, at)))
      }
      yield chunk
    }
    const result = await stream.result
    if (isMain) {
      chatStream = ''
      chatDirty = true
    }
    const usage = result.usage
    if (usage !== null) {
      const input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      const tokens = input + usage.output_tokens
      const share = input > 0 ? usage.cache_read_input_tokens / input : undefined
      const at = await $.clock.now()
      // The conversation's own requests feed the creature and the lagoon; a subagent's feed its spawnling.
      await safely(() => update($, world, w => (isMain
        ? onStep(w, tokens, share, { model: e.model })
        : onStep(w, tokens, undefined, { agent: e.agentId, model: e.model, at }))))
    }
    return result
  })

  // A subagent starts: it hatches from its type's nest, a spawnling of the creature (or of the subagent that laid it).
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.deny === undefined ? result.agentId : undefined
    if (id !== undefined) {
      const at = await $.clock.now()
      const isCounted = e.workflow !== undefined || !agentCalls.has(e.tool_use_id)
      await safely(() =>
        update($, world, w =>
          onSpawn(w, {
            id,
            ...(e.parentAgentId === undefined ? {} : { parent: e.parentAgentId }),
            type: e.fork ? 'fork' : e.subagentType,
            task: e.description,
            model: result.model,
            isFork: e.fork,
            isBackground: e.background,
            ...(e.isTeammate === true ? { isTeammate: true } : {}),
            ...(e.name === undefined ? {} : { name: e.name }),
            ...(e.workflow === undefined ? {} : { run: e.workflow.runId, rank: e.workflow.agentIndex }),
          }, at, isCounted),
        ),
      )
      await safely(() => sound($, 'pop', 0.5))
    }
    return result
  })

  // The spinner says what the turn is doing in its own words; the creature wears them.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.component === 'Spinner') spinner = { words: e.props.message ?? e.props.word, mode: e.props.mode }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    chatDirty = true
    // A subagent's run is over: home with its answer and absorbed, or curled up where it stands.
    const agent = e.agentId
    if (agent !== undefined) {
      const at = await $.clock.now()
      await safely(() => update($, world, w => onAgentDone(w, agent, { reason: e.reason, answer: e.answer.length, isAborted: e.isAborted }, at)))
      // Gulped home, louder the longer its answer; a crack when it failed. A teammate only dozes off.
      const isTeammate = (await read($, world)).brood?.some(s => s.id === agent && s.isTeammate === true) === true
      const big = Math.min(1, Math.log10(1 + e.answer.length / 200) / 2.5)
      if (e.reason !== 'answer') await safely(() => sound($, 'crack', 0.4))
      else if (!isTeammate) await safely(() => sound($, 'slurp', 0.3 + 0.4 * big))
    }
    if (agent === undefined) {
      spinner = undefined
      spinnerShown = ''
      const at = await $.clock.now()
      await safely(async () => {
        const usage = await $.session.usage()
        await update($, world, w => onTurnDone(w, usage.context.percent, e.reason === 'answer', e.durationMs, e.isAborted, at))
      })
      await safely(() => sound($, 'sigh', 0.5))
      await safely(() => refreshAccount($))
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      await safely(() => update($, world, w => onCompact(w, undefined)))
    }
    return result
  })

  on('command.run', { command: 'terrarium' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'full' || arg === 'fullscreen' || arg === '3d') {
      return { text: await openFullscreen($) }
    }
    if (arg === 'photo') {
      return { text: await takePhoto($) }
    }
    if (arg === 'wide' || arg === 'narrow') {
      await update($, view, v => ({ ...v, isWide: arg === 'wide' }))
      await openPane($, arg === 'wide')
      return { text: `The terrarium is docked ${arg}.` }
    }
    if (arg === 'hide') {
      await $.ui.close({ id: PANE })
      return { text: 'The terrarium is tucked away; the conversation has the whole window. /terrarium brings it back.' }
    }
    if (arg === 'save') {
      const now = await $.clock.now()
      const name = `terrarium-${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.svg`
      const w = await read($, world)
      await $.fs.write(name, renderSvg(w, await read($, view), { hour: sunHour(w, await hourNow($)), now }))
      return { text: `A postcard of the island was saved as ${name}.` }
    }
    if (arg === 'reset') {
      const seed = (hash(String(await $.clock.now())) % 99991) + 1
      await update($, world, w => ({ ...emptyWorld(seed), isSeeded: true, system: w.system }))
      return { text: 'The sea takes the old island; a new one surfaces.' }
    }
    const placed = await openPane($, (await read($, view)).isWide)
    return {
      text: placed.isPlaced
        ? 'The terrarium is open beside the conversation. /terrarium full opens it in 3D in its own window.'
        : `The terrarium is waiting for room: ${placed.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const w = await read($, world)
    const v = await read($, view)
    await read($, pulse)
    const stats = statsLine(w)
    const lines = w.chronicle.slice(-3)

    const toggleWide = async () => {
      await update($, view, x => ({ ...x, isWide: !x.isWide }))
      await openPane($, (await read($, view)).isWide)
    }
    const goFull = async () => {
      $.ui.toast(await openFullscreen($))
    }

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      const map = renderRaster(w, e.props.bodyColumns)
      return (
        <Box flexDirection="column">
          <Text bold>{stats}</Text>
          <Raster key="map" columns={map.columns} rows={map.rows} cells={map.cells} />
          {lines.map((line, k) => (
            <Text dimColor={k < lines.length - 1}>{line}</Text>
          ))}
          <Box gap={1}>
            <Button key="full" label="3D in a window" onPress={goFull} />
          </Box>
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    // With the 3D window open and in view, the pane shows its picture; else the drawing.
    const shown = v.isLive && v.isMirror !== false && mirror !== undefined && now - mirror.at < 15_000 ? mirror : undefined
    const svg = shown !== undefined ? mirrorSvg(shown) : renderSvg(w, v, { hour: sunHour(w, await hourNow($)), now })
    const takeIt = async () => {
      $.ui.toast(await takePhoto($))
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Svg source={svg} alt={`An island built from this conversation. ${stats}`} isInteractive />
        <Text bold>{stats}</Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="ccw" label="⟲" onPress={() => update($, view, x => ({ ...x, yaw: (x.yaw + 330) % 360 }))} />
          <Button key="cw" label="⟳" onPress={() => update($, view, x => ({ ...x, yaw: (x.yaw + 30) % 360 }))} />
          <Button
            key="orbit"
            label={v.isOrbiting ? '■ Stop orbit' : '▶ Orbit'}
            onPress={() => update($, view, x => ({ ...x, isOrbiting: !x.isOrbiting }))}
          />
          <Button
            key="zoom"
            label={`🔍 ×${(v.zoom ?? 1) === 1 ? '1.6' : (v.zoom ?? 1) < 2 ? '2.4' : '1'}`}
            onPress={() => update($, view, x => ({ ...x, zoom: (x.zoom ?? 1) === 1 ? 1.6 : (x.zoom ?? 1) < 2 ? 2.4 : 1 }))}
          />
          <Button key="wide" label={v.isWide ? '◨ Narrow' : '◧ Wide'} onPress={toggleWide} />
          <Button key="full" label="⛶ 3D window" variant="primary" onPress={goFull} />
          {v.isLive && (
            <Button
              key="mirror"
              label={v.isMirror === false ? '🪞 Mirror 3D' : '🪞 Drawing'}
              onPress={() => update($, view, x => ({ ...x, isMirror: x.isMirror === false }))}
            />
          )}
          <Button key="photo" label="📷 Photo" onPress={takeIt} />
          <Button
            key="sound"
            label={v.isMuted === true ? '🔇 Muted' : '🔊 Sound'}
            onPress={() => update($, view, x => ({ ...x, isMuted: x.isMuted !== true }))}
          />
          <Button
            key="legend"
            label={v.isLegendOpen ? 'Hide legend' : 'Legend'}
            onPress={() => update($, view, x => ({ ...x, isLegendOpen: !x.isLegendOpen }))}
          />
        </Box>
        <Box flexDirection="column">
          {lines.map((line, k) => (
            <Text dimColor={k < lines.length - 1}>{line}</Text>
          ))}
        </Box>
        {v.isLegendOpen && (
          <Box flexDirection="column">
            {LEGEND.map(line => (
              <Text dimColor>{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
