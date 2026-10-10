// The conversation as the 3D window's chat panel shows it, and the messages
// you send back from that panel. The panel reads chat.json beside the frame
// (served to this machine alone, never as a script, so no other site's page
// can read it); what you type there comes back as upload/prompt.json, which
// the server takes from the viewer's own page alone.

/** One row of the panel: something you said, something Claude said, or a tool it used. */
export type ChatItem = { role: 'user' | 'assistant' | 'tool'; text: string; isError?: true; isLive?: true }

/** The rows of the conversation, as `$.session.messages()` gives them. */
export type ChatSource = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; isError?: true }[]
  toolResults?: readonly unknown[]
}

const MAX_ITEMS = 160
const MAX_TEXT = 6000
/** The longest message the panel may send. */
export const MAX_PROMPT = 8000

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/**
 * What you typed, without what the harness wraps around it: system reminders
 * and task notices go, a slash command reads as you typed it.
 */
export const cleanUserText = (text: string): string =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1')
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, '\n$1')
    .trim()

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const base = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** A tool call in one line: the tool and what it worked on. */
export const toolLine = (tool: string, input: Record<string, unknown>): string => {
  const path = str(input.file_path) || str(input.notebook_path)
  const what = path !== ''
    ? base(path)
    : str(input.description) || str(input.command) || str(input.pattern) || str(input.url) || str(input.query) || str(input.skill) || str(input.to)
  return clip(`${tool}${what === '' ? '' : ` · ${what.replace(/\s+/g, ' ').trim()}`}`, 110)
}

/**
 * The conversation's last rows for the panel: your words, Claude's words, and
 * a line for each tool it used, in order; tool results are left out. `live`
 * is what Claude is writing this moment, not yet in the transcript.
 */
export const chatItems = (messages: readonly ChatSource[], live = ''): ChatItem[] => {
  const items: ChatItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const text = cleanUserText(m.text)
      if (text !== '') items.push({ role: 'user', text: clip(text, MAX_TEXT) })
      continue
    }
    const text = m.text.trim()
    if (text !== '') items.push({ role: 'assistant', text: clip(text, MAX_TEXT) })
    for (const use of m.toolUses) items.push({ role: 'tool', text: toolLine(use.tool, use.input), ...(use.isError === true ? { isError: true } : {}) })
  }
  return withLive(items, live)
}

/** The rows with what Claude is writing this moment after them, not yet in the transcript. */
export const withLive = (items: readonly ChatItem[], live: string): ChatItem[] =>
  (live.trim() === '' ? [...items] : [...items, { role: 'assistant' as const, text: clip(live.trim(), MAX_TEXT), isLive: true as const }]).slice(-MAX_ITEMS)

/** A message the panel sent: its id (so it is taken once) and its text; anything else is refused. */
export const promptFromUpload = (raw: string): { id: string; text: string } | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { id, text } = value as Record<string, unknown>
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(id)) return undefined
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_PROMPT) return undefined
  return { id, text: trimmed }
}
