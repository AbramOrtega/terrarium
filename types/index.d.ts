export type TerrariumKind =
  | 'tree'
  | 'house'
  | 'forge'
  | 'beacon'
  | 'windmill'
  | 'camp'
  | 'crystal'
  | 'shrine'
  | 'signpost'
  | 'banner'
  | 'cairn'
  | 'monolith'
  | 'treasury'

/** A file's building: code houses, doc libraries, config vaults, web pavilions, test towers. */
export type TerrariumStyle = 'code' | 'doc' | 'config' | 'web' | 'test' | 'data'

export type TerrariumFeature = {
  id: number
  kind: TerrariumKind
  x: number
  y: number
  size: number
  key: string
  label: string
  turn: number
  hue: number
  isScorched?: boolean
  lift?: number
  style?: TerrariumStyle
  dir?: string
  /** When a tool last worked on it, in the clock's milliseconds: recent work glows. */
  touchedAt?: number
  /** A file's language (`ts`, `py`, `rs`…), the architecture it builds in, and its GitHub color. */
  lang?: string
  arch?: TerrariumArch
  accent?: string
  /** The file as last measured on disk: its size and parts. */
  shape?: TerrariumShape
  /** The local files it imports, as paths without extensions (lower case, forward slashes). */
  links?: string[]
  /** Its file's edits this session, oldest first (the last few): bands of color on its walls. */
  edits?: TerrariumEdit[]
  /** An edit to its file failed and has not yet been made good. */
  isWounded?: boolean
  /** Edits to its file that failed and were later made good: patches on its walls. */
  scars?: number
  /** The subagent that last worked on it (its agent id); absent when the conversation's creature did. */
  by?: string
}

/**
 * One edit to a file: where it fell (0 the first line, 1 the last), how much
 * of the file it spans, the turn (prompt) that made it, and when.
 */
export type TerrariumEdit = { pos: number; span: number; turn: number; at: number }

/** A building's architecture: each language builds in its own. */
export type TerrariumArch =
  | 'townhouse' | 'cottage' | 'fort' | 'workshop' | 'keep' | 'painted'
  | 'pavilion' | 'library' | 'vault' | 'shed' | 'silo' | 'watchtower'

/**
 * A file's shape, counted (never its words): lines, how wide they run, its
 * parts (functions, or headings, rules, keys), its types and its exports;
 * and the building they make: floors, footprint, wings, towers, pennants.
 */
export type TerrariumShape = {
  lines: number
  width: number
  parts: number
  blocks: number
  exports: number
  floors: number
  footprint: number
  wings: number
  towers: number
  pennants: number
  /**
   * Notes left in its comments (TODO; FIXME, XXX or HACK), how many of its
   * lines are comments, and the share of its windows with flower boxes that
   * makes (0 to 1). Missing in shapes measured before they were counted.
   */
  todos?: number
  fixmes?: number
  comments?: number
  flowers?: number
}

/** An import between two files on the island: a street, or a footpath where one is only read. */
export type TerrariumStreet = { from: number; to: number; isPath: boolean }

/**
 * A folder's district: the plots of its files (two or more), paved in its
 * own stone, walled where it meets the rest of the town (hedged when it is a
 * quarter of a folder also on the island), entered by a gate bearing its
 * name in the stretch of wall nearest the town's heart. Edges run along the
 * lines between plots: x1, y1, x2, y2. A line a street runs along is left open.
 */
export type TerrariumDistrict = {
  dir: string
  name: string
  /** The folder it is a quarter of, when that folder is on the island too. */
  parent?: string
  files: number
  lines: number
  /** Its paving: flagstones, cobbles, brick or slate. */
  pave: number
  cells: [number, number][]
  walls: [number, number, number, number][]
  gate?: [number, number, number, number]
}

/** A test and a file it tests, joined by a rope bridge when they stand near enough. */
export type TerrariumBridge = { test: number; subject: number; isFar?: boolean }

/**
 * A building's parts beyond its shape, each for something true of its
 * file: a spire for an entry point (main, index, app, cli, server…); a
 * clock face when two or more files on the island import it, its hands at
 * the hour and minute it last changed; a dormer for each file it imports;
 * a balcony for every two times Claude read it; a bay window when its lines
 * run wide; a flag on the most worked building of its district.
 */
export type TerrariumKit = {
  spire?: boolean
  clock?: [number, number]
  dormers?: number
  balconies?: number
  bay?: boolean
  flag?: boolean
}

/** A townsperson's errand: two files worked one after the other, and when. */
export type TerrariumWalk = { from: number; to: number; at: number }

export type TerrariumLantern = { id: number; text: string; x: number; y: number; turn: number }

export type TerrariumMood = { joy: number; storm: number; wonder: number; haste: number }

/**
 * One tool call, as the turn's creature answers it: a tentacle, a bolt, a
 * strike. A failed call says when it failed, so its tentacle recoils then.
 */
export type TerrariumEvent = {
  id: number
  tool: string
  target?: number
  at: number
  isError?: boolean
  failedAt?: number
  /** The subagent whose call it was (its agent id); absent for the conversation's creature. */
  agent?: string
  /** A message's recipient: a subagent's id, or `main` for the conversation's creature. */
  to?: string
}

/** The machine and the account, as the weather reads them. Fractions are 0 to 1. */
export type TerrariumSystem = {
  ram?: number
  cpu?: number
  diskFree?: number
  diskFreeGb?: number
  limit?: number
  limitKind?: string
  /** The weekly limit, 0 to 100: where the moon stands. */
  weekLimit?: number
  /** Disk and network throughput, bytes a second. */
  diskRead?: number
  diskWrite?: number
  netDown?: number
  netUp?: number
  gpu?: TerrariumGpu
  /** Programs over 2% of the CPU, busiest first. */
  procs?: TerrariumProc[]
  /** Dev servers listening on this machine. */
  ports?: { port: number; name: string }[]
  /** Seconds since the last key or mouse movement. */
  idle?: number
  at: number
}

export type TerrariumGpu = { load: number; temp: number; mem: number; name: string }

/**
 * A busy program, a giant on the island: its share of the CPU (0 to 1), the
 * memory its processes hold (MB), how many processes run under its name, when
 * the oldest of them started (ms; absent when the system will not say), and
 * how its share moved since the last reading.
 */
export type TerrariumProc = { name: string; cpu: number; mem?: number; count?: number; since?: number; trend?: number }

/** The project's repository, when it has a remote. */
export type TerrariumGit = {
  hasRemote: boolean
  host?: string
  branch?: string
  ahead: number
  behind: number
  /** Changed or new files, as absolute paths, lower case with forward slashes. */
  dirty: string[]
  head?: string
  commits: number
  at: number
}

/** The last test run seen in a command's output. */
export type TerrariumTests = { passed: number; failed: number; at: number; command: string; greenAt?: number }

/**
 * The conversation's creature: it wakes small when a turn starts, grows with
 * the time the turn runs (its legs) and the tokens it eats (its body), crawls
 * to the middle of the files it is working on, and curls up asleep when the
 * turn ends.
 * Places are island cells, measured from the island's heart.
 */
export type TerrariumBeast = {
  turn: number
  /** The prompt that woke it. */
  prompt: string
  bornAt: number
  /** Where it is crawling to, where it set off from, and when. */
  x: number
  y: number
  fromX: number
  fromY: number
  movedAt: number
  tokens: number
  /** When its turn ended and it fell asleep; cut short if the turn was interrupted. */
  doneAt?: number
  isAborted?: boolean
  /** The model its turn runs on, as the API names it: the color of its eyes. */
  model?: string
}

/**
 * A subagent's creature, a spawnling: smaller than the conversation's, colored
 * by its agent type, its eyes by its model. Its parent lays it at its type's
 * nest; it grows with its own run time and tokens, crawls to the middle of
 * its own work and reaches for each of its own tool calls. A finished one
 * crawls home to its parent and is absorbed, handing back its answer; one
 * that failed or was stopped curls up where it stands until your next prompt.
 * A teammate stays: asleep between messages, awake while it works.
 */
export type TerrariumSpawn = {
  /** Its agent id, as its loop's events carry it. */
  id: string
  /** The subagent that laid it; absent when the conversation's creature did. */
  parent?: string
  /** 1 laid by the conversation's creature, 2 by one of its spawnlings, and so on. */
  depth: number
  /** Its agent type (`Explore`, `Plan`, `general-purpose`, a plugin's…), the task in a few words, and the model it runs on. */
  type: string
  task: string
  model: string
  hue: number
  /** A fork of its parent: the parent's own color, sharing all it knows. */
  isFork?: boolean
  /** Running in the background: no silk thread back to a parent waiting on it. */
  isBackground?: boolean
  /** A teammate of the session's team, and the name messages reach it by. */
  isTeammate?: boolean
  name?: string
  /** A workflow run it belongs to, and its place in the run: a swarm marching out in file. */
  run?: string
  rank?: number
  /** Its type's nest (a feature id), where it hatched. */
  nest?: number
  bornAt: number
  /** Where it is crawling to, where it set off from, and when (island cells, as the creature's). */
  x: number
  y: number
  fromX: number
  fromY: number
  movedAt: number
  tokens: number
  calls: number
  /** When it last did anything: a model request or a tool call. */
  lastAt: number
  /** When it finished (a teammate: went idle), and how: home with its answer, failed, stopped, or idle. */
  doneAt?: number
  outcome?: 'done' | 'failed' | 'aborted' | 'idle'
  /** How long the answer it carried home runs, in characters. */
  answer?: number
}

/** What Claude is doing this moment, and the spinner's own words for it (`Creating notes.md`, `Sauteing`). */
export type TerrariumActivity = { kind: 'thinking' | 'writing' | 'tool' | 'idle'; at: number; verb?: string }

export type TerrariumWorld = {
  seed: number
  slots: number
  turn: number
  nextId: number
  features: TerrariumFeature[]
  lanterns: TerrariumLantern[]
  mood: TerrariumMood
  tide: number
  compactions: number
  tools: number
  errors: number
  chronicle: string[]
  isSeeded: boolean
  /** The creature: at work on the turn under way, or asleep after the last. */
  beast?: TerrariumBeast
  /** The subagents' creatures, the newest last. */
  brood?: TerrariumSpawn[]
  isWorking?: boolean
  turnStartedAt?: number
  focus?: number
  events?: TerrariumEvent[]
  system?: TerrariumSystem
  activity?: TerrariumActivity
  /** A question or a permission prompt waiting on the person. */
  waiting?: { reason: string; at: number }
  /** When the person last spoke to the creature while it worked: a shiver runs over its skin. */
  heardAt?: number
  git?: TerrariumGit
  tests?: TerrariumTests
  /** The session's tokens priced in US dollars, and how much of each request the prompt cache served. */
  cost?: number
  /** On a subscription: `cost` is what the tokens would cost at API prices, not what is billed. */
  isFlatRate?: boolean
  cache?: number
  /** When the person went quiet at the keyboard, and when they came back. */
  awaySince?: number
  returnedAt?: number
  /** When the session began (a resumed one: its first launch): the age of the turtle's shell. */
  startedAt?: number
}

export type TerrariumView = {
  yaw: number
  isOrbiting: boolean
  isLegendOpen: boolean
  /** The split: a wide dock or a narrow one beside the conversation. */
  isWide: boolean
  /** How close the pane looks: 1 the whole disc on its turtle, more to come down among the houses. */
  zoom?: number
  /** Whether the fullscreen viewer was opened, so its frame is kept current. */
  isLive: boolean
  /** Whether the side pane shows the 3D window's picture while that window is open (on unless turned off). */
  isMirror?: boolean
  /** The photo last asked of the 3D window, by when it was asked. */
  photoAt?: number
  /** Sound effects off, in the pane and the 3D window alike. */
  isMuted?: boolean
  /** The last message sent from the 3D window's chat panel, by its id: each is taken once. */
  promptId?: string
}

declare module 'claude-code' {
  interface PluginState {
    terrarium: { world: TerrariumWorld; view: TerrariumView; pulse: number }
  }
}
