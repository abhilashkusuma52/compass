import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Branch, BranchKind, BranchStatus, Step, StepTool } from '../types'

const PANE = 'compass'
const TOOL = 'mcp__compass__update'

const goal = atom({ plugin: 'compass', key: 'goal' } as const, null)
const branches = atom({ plugin: 'compass', key: 'branches' } as const, [], {
  shape: 'branches-1',
})
const focus = atom({ plugin: 'compass', key: 'focus' } as const, null)
const steps = atom({ plugin: 'compass', key: 'steps' } as const, [], {
  shape: 'steps-1',
})
const isOff = atom({ plugin: 'compass', key: 'isOff' } as const, false)
const startedBy = atom({ plugin: 'compass', key: 'startedBy' } as const, null)
const askedUnder = atom({ plugin: 'compass', key: 'askedUnder' } as const, null)
const log = atom({ plugin: 'compass', key: 'log' } as const, [], {
  shape: 'log-1',
})
const isGoalPinned = atom({ plugin: 'compass', key: 'isGoalPinned' } as const, false)

// Steps that always go to the normal permission prompt, never pre-approved.
const RISKY =
  /git\s+push\b|--force\b|\bpush\s+-f\b|\brm\s+-[a-z]*[rf]|\bRemove-Item\b|\breset\s+--hard|\bclean\s+-[a-z]*f|\bdrop\s+(table|database|schema)\b|\btruncate\b|\bdelete\b|\bdeploy\b|\bpublish\b|\brelease\b|\bmerge\b|\bsudo\b|\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\bpayment|\bstripe\b|\.env\b|secret|credential|password|token/i
// A pre-approved command prefix never covers a chained or redirected command.
const CHAINED = /[;&|`<>\n]|\$\(/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// A "Bash" step covers whichever shell runs it: PowerShell on Windows.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const STATUSES: readonly BranchStatus[] = ['todo', 'working', 'done', 'parked']
const STEP_TOOLS: readonly StepTool[] = ['Bash', 'Edit', 'decision']
const KINDS: readonly BranchKind[] = ['stem', 'side']

const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'for', 'of', 'the', 'to', 'in', 'on', 'all', 'it', 'with'])
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(' ')
      // Numbers stay, even one digit: "Phase 1" and "Phase 2" are different work.
      .filter(w => (w.length > 1 || /\d/.test(w)) && !STOP_WORDS.has(w)),
  )

// Two titles name the same work when most of the words of the longer one are shared,
// so "Run tests" and "Run lint tests" stay apart.
function isSameWork(a: string, b: string): boolean {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return a.toLowerCase() === b.toLowerCase()
  let shared = 0
  for (const w of x) if (y.has(w)) shared += 1

  return shared / Math.max(x.size, y.size) >= 0.75
}

const RULES = `# Compass
The person uses the Compass mod to keep this session on its purpose and to avoid reading long text. In the main conversation only (a subagent ignores this section):
- Goal: Compass drafts the goal and the map of what happened so far by itself. Correct the goal with ${TOOL} (a short \`goal\`, under 8 words) only when the person changes direction.
- Branches: keep \`branches\` current. Each separate piece of work is one branch with a short title, a status (todo, working, done or parked) and a kind: "stem" for a step toward the goal, "side" for a topic unrelated to the goal. Send only the branches that changed; the same id updates one. New branches go at the end, so the map stays in the order things happened.
- Drift: when the person's message starts something unrelated to the goal, add it as a "side" branch and ask in one line: "Side branch: park it or go?" Start it only on "go".
- Coming up: before work that will need the person's approval, call the tool with \`steps\`: tool "Bash" with the exact command prefix as \`match\`, tool "Edit" with the file or folder path, or tool "decision" for a question you would stop to ask. The person can approve them while you work. Send \`clearSteps: true\` when a task's steps are finished.
- Messages that start with [Compass] are the person's taps in the Compass pane; follow them. "Approved ahead" means do that step without asking. "Parked" means don't work on it now. "Got it" means no recap is needed. A context line naming a selected branch means the person's message is about that branch, even if the message doesn't say so.
- Answers: start every reply with at most 3 short lines: what happened, and what's next or what you need. Leave out detail, reasoning and long lists unless the person asks for more. No headings in short replies.`

const TOOL_SPEC = {
  name: 'update',
  description:
    'Update the Compass map the person watches: the session goal, its branches, and the coming steps that need approval. Send only what changed.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The session purpose, under 8 words.' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
            kind: { type: 'string', enum: KINDS },
            parent: { type: 'string', description: 'The id of the item this work grew out of.' },
          },
          required: ['id'],
        },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string', description: 'Short, for the person.' },
            tool: { type: 'string', enum: STEP_TOOLS },
            match: {
              type: 'string',
              description: 'Bash: the exact command prefix. Edit: a file or folder path.',
            },
          },
          required: ['id', 'label', 'tool'],
        },
      },
      clearSteps: { type: 'boolean' },
    },
  },
} as const

type Dollar = EngineInterface
type Loose = Record<string, unknown>

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const normPath = (p: string) =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '').toLowerCase()

function isRiskyStep(tool: StepTool, match: string, label: string): boolean {
  if (tool === 'decision') return RISKY.test(label)
  if (match.length < 3) return true
  if (tool === 'Bash') return RISKY.test(match) || CHAINED.test(match)

  return RISKY.test(match)
}

function matches(step: Step, tool: string, input: unknown): boolean {
  const args = (input ?? {}) as Loose
  if (step.tool === 'Bash' && SHELL_TOOLS.has(tool)) {
    const command = text(args.command)
    if (command === '' || CHAINED.test(command) || RISKY.test(command)) return false

    return command === step.match || command.startsWith(`${step.match} `)
  }
  if (step.tool === 'Edit' && EDIT_TOOLS.has(tool)) {
    const raw = text(args.file_path) || text(args.notebook_path)
    if (raw === '' || RISKY.test(raw)) return false
    const path = `/${normPath(raw)}`
    const want = normPath(step.match)
    if (want === '') return false
    // A bare name ("src", "README.md") names one file, never every folder by that name on disk.
    if (!want.includes('/')) return path.endsWith(`/${want}`)

    return path.endsWith(`/${want}`) || path.includes(`/${want}/`)
  }

  return false
}

function mergeBranches(list: Branch[], incoming: unknown, under: string | null = null): Branch[] {
  if (!Array.isArray(incoming)) return list
  const out = [...list]
  for (const item of incoming as Loose[]) {
    const id = text(item?.id)
    if (id === '') continue
    const status = STATUSES.find(s => s === item.status)
    const kind = KINDS.find(k => k === item.kind)
    const parentId = text(item.parent)
    const title = cut(text(item.title), 60)
    let at = out.findIndex(b => b.id === id)
    // A new id for work already on the map updates that item instead of doubling it.
    if (at < 0 && title !== '') at = out.findIndex(b => isSameWork(b.title, title))
    const old = out[at]
    if (old !== undefined) {
      out[at] = {
        ...old,
        ...(title !== '' ? { title } : {}),
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(parentId !== '' ? { parentId } : {}),
      }
    } else {
      const parent = parentId || under
      out.push({
        id,
        title: title || id,
        status: status ?? 'todo',
        kind: kind ?? 'stem',
        ...(parent ? { parentId: parent } : {}),
      })
    }
  }

  return withValidParents(out.slice(-30))
}

// Drops a parent link that points nowhere, at itself, or round in a loop.
function withValidParents(list: Branch[]): Branch[] {
  const byId = new Map(list.map(b => [b.id, b]))
  return list.map(b => {
    let at = b.parentId
    for (let hops = 0; at !== undefined; hops += 1) {
      if (!byId.has(at) || at === b.id || hops > 10) {
        const { parentId: _gone, ...rest } = b
        return rest
      }
      at = byId.get(at)?.parentId
    }
    return b
  })
}

function mergeSteps(list: Step[], incoming: unknown): Step[] {
  if (!Array.isArray(incoming)) return list
  const out = [...list]
  for (const item of incoming as Loose[]) {
    const id = text(item?.id)
    const tool = STEP_TOOLS.find(t => t === item?.tool)
    const label = text(item?.label)
    if (id === '' || !tool || label === '') continue
    const match = text(item.match)
    const at = out.findIndex(s => s.id === id)
    const old = out[at]
    const isKept = old !== undefined && old.tool === tool && old.match === match
    const step: Step = {
      id,
      label: cut(label, 80),
      tool,
      match,
      isRisky: isRiskyStep(tool, match, label),
      isApproved: isKept ? old.isApproved : false,
    }
    if (old !== undefined) out[at] = step
    else out.push(step)
  }

  return out.slice(-12)
}

async function note($: Dollar, words: string) {
  try {
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: `[Compass] ${words}` }] },
    })
  } catch {
    $.ui.toast('Compass could not reach Claude.')
  }
}

// Orders the map as a tree: roots in the order they happened, each followed by what grew
// out of it. A side root forks off the stem; a child hangs under its parent, one level deeper.
function asTree(list: Branch[]): { b: Branch; lead: string }[] {
  const ids = new Set(list.map(b => b.id))
  const kids = new Map<string, Branch[]>()
  for (const b of list) {
    if (b.parentId === undefined || !ids.has(b.parentId)) continue
    kids.set(b.parentId, [...(kids.get(b.parentId) ?? []), b])
  }
  const roots = list.filter(b => b.parentId === undefined || !ids.has(b.parentId))
  const out: { b: Branch; lead: string }[] = []
  const seen = new Set<string>()
  const walk = (b: Branch, indent: string, isLast: boolean, depth: number) => {
    if (seen.has(b.id)) return
    seen.add(b.id)
    const fork = depth === 0 ? '' : isLast ? '└─ ' : '├─ '
    out.push({ b, lead: `${indent}${fork}` })
    const children = kids.get(b.id) ?? []
    const below = depth === 0 ? indent : `${indent}${isLast ? '   ' : '│  '}`
    children.forEach((c, i) => walk(c, below, i === children.length - 1, depth + 1))
  }
  roots.forEach((b, i) => {
    if (b.kind === 'side') {
      const isLastSide = roots[i + 1]?.kind !== 'side'
      walk(b, '   ', isLastSide, 1)
    } else {
      walk(b, '', true, 0)
    }
  })
  return out
}

const mapPrompt = (existing: Branch[]) => `Compass needs a map of this session. Answer straight away, without thinking it over and without tools, with only this JSON and no other text:
{"goal": "<the purpose the person opened this session for, under 8 words>", "branches": [{"id": "<an id from the list below when it is the same work, else leave out>", "title": "<one piece of work, under 6 words>", "status": "done" | "working" | "todo" | "parked", "kind": "stem" | "side", "parent": "<the id of the item this work grew out of, else leave out>"}]}
List at most 12 branches in the order they happened, each distinct piece of work once: merge items that are the same work even when worded differently. "stem" is a step toward the goal; "side" is a topic unrelated to the goal. "parked" is one the person set aside. Leave out Compass's own notes and the drawing of this map.
${
  existing.length === 0
    ? 'The map is empty so far.'
    : `Items already on the map (id: title):\n${existing.map(b => `${b.id}: ${b.title}`).join('\n')}`
}`

// Lays the map out as the fork drafted it: its order, its kinds, one item per piece of
// work. Items it reused keep their ids (and a subagent link); pending work it left out stays.
function redraw(list: Branch[], listed: Loose[], under: string | null = null): Branch[] {
  const out: Branch[] = []
  const used = new Set<string>()
  listed.slice(0, 15).forEach((item, i) => {
    const title = cut(text(item?.title), 60)
    if (title === '') return
    const status = STATUSES.find(s => s === item?.status) ?? 'done'
    const kind = KINDS.find(k => k === item?.kind) ?? 'stem'
    const parentId = text(item?.parent)
    const old =
      list.find(b => b.id === text(item?.id) && !used.has(b.id)) ??
      list.find(b => !used.has(b.id) && isSameWork(b.title, title))
    if (old !== undefined) {
      used.add(old.id)
      out.push({
        ...old,
        title,
        kind,
        // A subagent's state comes from the agent; a park is the person's, so it stays.
        status: old.agentId !== undefined || old.status === 'parked' ? old.status : status,
        ...(parentId !== '' ? { parentId } : {}),
      })
    } else if (!out.some(b => isSameWork(b.title, title))) {
      // New work asked with an item selected grows out of that item.
      const parent = parentId || under
      out.push({
        id: `auto-${i + 1}-${list.length}`,
        title,
        status,
        kind,
        ...(parent ? { parentId: parent } : {}),
      })
    }
  })
  // Items the model left out stay on the map (done and parked too), in their place.
  const kept = list.filter(b => !used.has(b.id) && !out.some(o => isSameWork(o.title, b.title)))
  const ids = new Set(kept.map(b => b.id))
  const fresh = out.map(b => {
    if (!ids.has(b.id)) return b
    let n = 1
    while (ids.has(`${b.id}-${n}`)) n += 1
    return { ...b, id: `${b.id}-${n}` }
  })
  const merged = [...kept, ...fresh]
  // Keep the order things happened: old items first by their old place, then new ones.
  merged.sort((p, q) => {
    const i = list.findIndex(b => b.id === p.id)
    const j = list.findIndex(b => b.id === q.id)
    return (i < 0 ? Infinity : i) - (j < 0 ? Infinity : j)
  })

  return withValidParents(merged.slice(-30))
}

const MAX_AUTO_TRIES = 3
let isMapping = false
let isMoreQueued = false
let autoTries = 0

// Drafts the goal and the branches so far from the conversation itself, through a
// tool-less fork that reads the session's cached transcript. A refresh replaces the
// drafted branches and the goal; otherwise it only fills a missing goal.
async function autoMap($: Dollar, isRefresh: boolean): Promise<string> {
  if (isMapping) return 'busy'
  if (!isRefresh && (await read($, goal)) !== null) return 'has-goal'
  isMapping = true
  try {
    const prompt = mapPrompt(await read($, branches))
    let answered = await $.model.fork({ prompt })
    // A reopened session has no cached turn to fork until one runs: read the saved
    // conversation instead and ask the small model.
    if (!answered.isAnswered && answered.reason === 'nothing-to-fork') {
      const excerpt = excerptOf((await $.session.messages()) as unknown as Row[])
      if (excerpt === '') return 'nothing-to-map'
      answered = await $.model.complete({
        model: LIVE_MODEL,
        prompt: `${prompt}\n\nThe conversation so far:\n${excerpt}`,
        maxTokens: 1_200,
      })
    }
    if (!answered.isAnswered) return answered.reason
    const found = answered.text.match(/\{[\s\S]*\}/)
    if (!found) return 'no-map'
    const parsed = JSON.parse(found[0]) as Loose
    const newGoal = text(parsed.goal)
    if (newGoal !== '' && !(await read($, isGoalPinned)) && (isRefresh || (await read($, goal)) === null)) {
      await update($, goal, () => cut(newGoal, 80))
    }
    const listed = Array.isArray(parsed.branches) ? (parsed.branches as Loose[]) : []
    if (listed.length > 0) await update($, branches, list => redraw(list, listed))
    await markMapped($).catch(() => undefined)

    return 'mapped'
  } catch {
    return 'failed'
  } finally {
    isMapping = false
  }
}

// Fills a missing map soon, outside the hook that asked, a few tries per load.
async function mapSoon($: Dollar, ms: number) {
  if (autoTries >= MAX_AUTO_TRIES || isMapping) return
  if ((await read($, isOff)) || (await read($, goal)) !== null) return
  $.clock.after(ms, () => {
    autoTries += 1
    void autoMap($, false).then(result => {
      if (result === 'nothing-to-fork' || result === 'nothing-to-map') autoTries -= 1
    })
  })
}

// Live mapping: after each reply, and every couple of minutes during a long turn, a
// small model reads only what was said since the last update and redraws the map.
const LIVE_MODEL = 'haiku'
const LIVE_EVERY_MS = 120_000
const EXCERPT_CHARS = 8_000
const FIRST_LOOK_ROWS = 30
// How many rows the conversation had at the last update; undefined until the first one.
let lastMappedCount: number | undefined
let lastMappedAt = 0
let isTurnRunning = false

type Row = { role: string; text: string; toolUses: { tool: string }[]; agentId?: string }

function excerptOf(rows: Row[]): string {
  const lines = rows
    .filter(r => r.agentId === undefined && !r.text.startsWith('[Compass]'))
    .map(r => {
      const said = cut(r.text.replace(/\s+/g, ' ').trim(), 500)
      const tools = r.toolUses.map(t => t.tool).slice(0, 5)
      if (said === '' && tools.length === 0) return ''

      return `${r.role === 'user' ? 'Person' : 'Claude'}: ${said}${tools.length > 0 ? ` [used ${tools.join(', ')}]` : ''}`
    })
    .filter(l => l !== '')
  const joined = lines.join('\n')

  return joined.length > EXCERPT_CHARS ? `…${joined.slice(-EXCERPT_CHARS)}` : joined
}

const livePrompt = (g: string | null, list: Branch[], excerpt: string, under: Branch | undefined) => `You keep the map of a working session for the Compass pane. Reply with only this JSON, no other text:
{"goal": "<the session purpose, under 8 words>", "branches": [{"id": "<the item's id when it is already on the map, else leave out>", "title": "<under 6 words>", "status": "done" | "working" | "todo" | "parked", "kind": "stem" | "side", "parent": "<the id of the item this work grew out of, else leave out>"}]}
Return the whole map in the order things happened, at most 15 items: keep every item still on it (with its id), update statuses from what was said, and add new pieces of work at the end. "stem" is a step toward the goal; "side" is a topic unrelated to the goal. Merge items that are the same work. Keep the goal unless the person changed direction.

Goal now: ${g ?? '(none yet)'}
Map now:
${list.length === 0 ? '(empty)' : list.map(b => `${b.id} | ${b.kind ?? 'stem'} | ${b.status} | parent ${b.parentId ?? '-'} | ${b.title}`).join('\n')}
${under ? `\nThe person wrote the latest messages with "${under.title}" (${under.id}) selected: new work from them goes under it, "parent": "${under.id}".\n` : ''}
Said since the last update:
${excerpt}`

async function liveMap($: Dollar): Promise<string> {
  if (isMapping) return 'busy'
  if (await read($, isOff)) return 'off'
  isMapping = true
  try {
    const all = (await $.session.messages()) as unknown as Row[]
    // A compaction shortens the list; read on from a recent stretch then.
    const from =
      lastMappedCount === undefined || lastMappedCount > all.length
        ? Math.max(0, all.length - FIRST_LOOK_ROWS)
        : lastMappedCount
    const excerpt = excerptOf(all.slice(from))
    if (excerpt === '') return 'nothing-new'
    const now = await read($, branches)
    const underId = await read($, askedUnder)
    const answered = await $.model.complete({
      model: LIVE_MODEL,
      prompt: livePrompt(await read($, goal), now, excerpt, now.find(b => b.id === underId)),
      maxTokens: 1_200,
    })
    if (!answered.isAnswered) return answered.reason
    const found = answered.text.match(/\{[\s\S]*\}/)
    if (!found) return 'no-map'
    const parsed = JSON.parse(found[0]) as Loose
    const newGoal = text(parsed.goal)
    if (newGoal !== '' && !(await read($, isGoalPinned))) await update($, goal, () => cut(newGoal, 80))
    const listed = Array.isArray(parsed.branches) ? (parsed.branches as Loose[]) : []
    if (listed.length > 0) await update($, branches, list => redraw(list, listed, underId))
    lastMappedCount = all.length
    lastMappedAt = await $.clock.now()

    return 'mapped'
  } catch {
    return 'failed'
  } finally {
    isMapping = false
  }
}

// Notes where the conversation stood when the full map was drawn, so live updates read on from there.
async function markMapped($: Dollar) {
  lastMappedCount = ((await $.session.messages()) as unknown as Row[]).length
  lastMappedAt = await $.clock.now()
}

// Moves each subagent's branch to its agent's current state.
async function syncAgents($: Dollar) {
  const tracked = (await read($, branches)).filter(b => b.agentId !== undefined)
  if (tracked.length === 0) return
  const agents = await $.agent.list()
  const statusOf = (id: string): BranchStatus | undefined => {
    const agent = agents.find(a => a.id === id)
    if (!agent) return undefined
    if (agent.status === 'completed' || agent.status === 'idle') return 'done'
    if (agent.status === 'failed' || agent.status === 'killed') return 'todo'

    return 'working'
  }
  const isChanged = tracked.some(b => {
    const s = statusOf(b.agentId as string)
    return s !== undefined && b.status !== 'parked' && s !== b.status
  })
  if (!isChanged) return
  await update($, branches, list =>
    list.map(b => {
      const s = b.agentId === undefined ? undefined : statusOf(b.agentId)
      return s !== undefined && b.status !== 'parked' ? { ...b, status: s } : b
    }),
  )
}

async function turnOn($: Dollar) {
  await $.tool.register(TOOL_SPEC)
  void $.ui.open({ id: PANE, title: 'Compass' })
}

// Off for this session: the band stays as one quiet row with a way back.
async function switchOff($: Dollar) {
  await update($, isOff, () => true)
  await $.ui.close({ id: PANE })
  await note($, 'Compass is off for this session: ignore the Compass rules.')
}

async function switchOn($: Dollar) {
  await update($, isOff, () => false)
  await turnOn($)
  await note($, `Compass is on. Follow these rules:\n${RULES}`)
  autoTries = 0
  await mapSoon($, 100)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'compass',
      description:
        'Open the Compass map. Also: map, on, off, default on, default off, reset, goal <text>',
    })
    // Compass starts off unless the person ran /compass default on.
    if ((await $.store.get('defaultOn')) !== true) {
      await update($, isOff, () => true)
    }
    if (!(await read($, isOff))) {
      await $.tool.register(TOOL_SPEC)
      if (e.surface === 'desktop') void $.ui.open({ id: PANE, title: 'Compass' })
    }
    // Background subagents finish between turns; check on them every 15s.
    $.clock.every(15_000, () => {
      void syncAgents($).catch(() => undefined)
    })
    // A long turn (a scheduled run, a big task) updates the map as it goes.
    $.clock.every(30_000, () => {
      void (async () => {
        if (!isTurnRunning || (await read($, goal)) === null) return
        if ((await $.clock.now()) - lastMappedAt < LIVE_EVERY_MS) return
        await liveMap($)
      })().catch(() => undefined)
    })
    // A resumed conversation already has a story to map.
    await mapSoon($, 3_000)

    return next(e)
  })

  // The rules ride in the system prompt, fixed for the session.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (await read($, isOff)) return composed

    return {
      sections: [
        ...composed.sections,
        { id: 'compass:rules', text: RULES, scope: 'session' as const },
      ],
    }
  })

  // A message typed while a branch is selected carries a hidden line naming it.
  on('prompt.submit', async ($, e, next) => {
    // A session a scheduled task starts runs without Compass, unless the person turns it on.
    if ((await read($, startedBy)) === null && e.command === undefined && !e.isMeta) {
      const isScheduled = e.origin?.kind === 'scheduled-trigger'
      await update($, startedBy, () => (isScheduled ? 'schedule' : 'person'))
      if (isScheduled) {
        await update($, isOff, () => true)
        void $.ui.close({ id: PANE })
      }
    }
    if (e.command !== undefined || e.isMeta || (await read($, isOff))) return next(e)
    const selectedId = await read($, focus)
    const picked = (await read($, branches)).find(b => b.id === selectedId)
    await update($, askedUnder, () => picked?.id ?? null)
    if (picked === undefined) return next(e)
    const tag = `[Compass] The person selected the ${picked.kind === 'side' ? 'side branch' : 'step'} "${picked.title}" (${picked.status}) in the map: this message is about it.`

    return next({ ...e, context: [...(e.context ?? []), tag] })
  }).catch(($, e, next) => next(e))

  // Claude's own updates to the map.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const args = e as unknown as Loose
    if (text(args.agentId) !== '') {
      return { result: 'Compass is kept by the main conversation; nothing changed.' }
    }
    const newGoal = text(args.goal)
    if (newGoal !== '') await update($, goal, () => cut(newGoal, 80))
    const underId = await read($, askedUnder)
    await update($, branches, list => mergeBranches(list, args.branches, underId))
    if (args.clearSteps === true) await update($, steps, () => [])
    await update($, steps, list => mergeSteps(list, args.steps))

    return { result: 'Compass updated.' }
  })

  // Subagents show up as branches by themselves.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId && !(await read($, isOff))) {
      const agentId = started.agentId
      const title = cut(text(e.description) || e.subagentType, 60)
      await update($, branches, list =>
        mergeBranches(list, [{ id: `agent-${agentId}`, title, status: 'working' }]).map(b =>
          b.id === `agent-${agentId}` ? { ...b, agentId } : b,
        ),
      )
    }

    return started
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await syncAgents($)
    if (e.agentId === undefined) {
      isTurnRunning = false
      if ((await read($, goal)) === null) {
        await mapSoon($, 100)
      } else if (!(await read($, isOff))) {
        $.clock.after(500, () => {
          void liveMap($)
        })
      }
    }

    return next(e)
  })

  // A step the person approved ahead runs without the prompt. Only loosens an "ask".
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.ceiling === 'deny' || e.isCeilingUnread || e.op) {
      return verdict
    }
    if (await read($, isOff)) return verdict
    const hit = (await read($, steps)).find(
      s => s.isApproved && !s.isRisky && matches(s, e.tool, e.input),
    )
    if (!hit) return verdict
    await update($, log, list => [...list, hit.label].slice(-20))

    return { decision: 'allow' as const, reason: `Approved ahead in Compass: ${hit.label}` }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'compass' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    const done = (words: string) => ({ text: words, isTextDisplayOnly: true as const })

    if (word === 'off') {
      await switchOff($)

      return done('Compass is off for this session. /compass on brings it back.')
    }
    if (word === 'on') {
      await switchOn($)

      return done('Compass is on. Mapping the session so far.')
    }
    if (word === 'map') {
      const result = await autoMap($, true)

      return done(
        result === 'mapped'
          ? 'Map redrawn from the conversation so far.'
          : `Couldn't redraw the map (${result}).`,
      )
    }
    if (word === 'default off' || word === 'default on') {
      const isOn = word === 'default on'
      await $.store.set('defaultOn', isOn)

      return done(
        isOn
          ? 'New sessions start with Compass on.'
          : 'New sessions start with Compass off. /compass on turns it on in one.',
      )
    }
    if (word === 'reset') {
      await update($, goal, () => null)
      await update($, branches, () => [])
      await update($, steps, () => [])
      await update($, focus, () => null)
      await update($, log, () => [])
      await update($, isGoalPinned, () => false)
      await update($, askedUnder, () => null)

      return done('Compass map cleared.')
    }
    if (word.startsWith('goal ')) {
      const newGoal = cut(args.slice(5).trim(), 80)
      await update($, goal, () => newGoal)
      await update($, isGoalPinned, () => true)
      await note($,`The person set the session goal: "${newGoal}".`)

      return done(`Goal set: ${newGoal}`)
    }
    if (await read($, isOff)) return done('Compass is off here. /compass on turns it on.')
    await turnOn($)

    return done('Compass map opened.')
  })

  // The band above the prompt: goal, progress, and quick replies.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (await read($, isOff)) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>◎ Compass is off in this session</Text>
          <Button key="on" label="Turn on" onPress={() => switchOn($)} />
        </Box>
      )
    }
    const g = await read($, goal)
    const all = await read($, branches)
    const focusId = await read($, focus)
    const pending = (await read($, steps)).filter(s => !s.isApproved && !s.isRisky).length
    const active = all.filter(b => b.status !== 'parked')
    const doneCount = active.filter(b => b.status === 'done').length
    const focused = all.find(b => b.id === focusId)
    const parts = [
      `◎ ${g ? cut(g, 40) : 'Compass maps this session after the first reply'}`,
      active.length > 0 ? `${doneCount}/${active.length} done` : '',
      pending > 0 ? `${pending} to approve` : '',
    ].filter(p => p !== '')

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{parts.join(' · ')}</Text>
        {focused !== undefined && <Text>▶ Asking about: {cut(focused.title, 28)}</Text>}
        {focused !== undefined && (
          <Button key="clear" label="Clear" onPress={() => update($, focus, () => null)} />
        )}
        <Button key="map" label="Map" onPress={() => turnOn($)} />
        <Button key="off" label="Off" onPress={() => switchOff($)} />
        <Button
          key="got-it"
          label="Got it"
          onPress={async () => {
            await note($, 'Got it: the person read your last answer. No recap needed.')
            $.ui.toast('Sent: got it')
          }}
        />
        <Button
          key="more"
          label="More"
          onPress={() => {
            // Not awaited: while Claude works, submit waits for the turn to start,
            // which ran the press past its budget and invited a second press.
            if (isMoreQueued) {
              $.ui.toast('Already asked; it runs when Claude is free')
              return
            }
            isMoreQueued = true
            void $.prompt
              .submit({ text: 'Explain your last answer in more detail.', asUser: true })
              .catch(() => undefined)
              .finally(() => {
                isMoreQueued = false
              })
            $.ui.toast('Asked for more detail')
          }}
        />
      </Box>
    )
  })

  // The map pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (await read($, isOff)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Compass is off in this session.</Text>
          <Button
            key="turn-on"
            label="Turn on"
            onPress={() => switchOn($)}
          />
        </Box>
      )
    }

    const g = await read($, goal)
    const all = await read($, branches)
    const focusId = await read($, focus)
    const coming = await read($, steps)
    const ran = await read($, log)
    const active = all.filter(b => b.status !== 'parked')
    const doneCount = active.filter(b => b.status === 'done').length

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text>◎ {g ? cut(g, 30) : 'No goal yet'}</Text>
          <Text dimColor>
            {doneCount}/{active.length} done
          </Text>
        </Box>
      )
    }

    const mark = (b: Branch) =>
      b.status === 'done' ? '✓' : b.status === 'working' ? '●' : b.status === 'parked' ? '‖' : '○'

    const setStatus = async (b: Branch, status: BranchStatus, words: string) => {
      await update($, branches, list => list.map(x => (x.id === b.id ? { ...x, status } : x)))
      await note($, words)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>◎ {g ?? 'No goal yet'}</Text>
          {g === null ? (
            <Text dimColor>Mapping after the next reply…</Text>
          ) : (
            <Text dimColor>
              {doneCount} of {active.length} done
            </Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Button
              key="map-so-far"
              label="Map so far"
              onPress={() => {
                $.ui.toast('Redrawing the map…')
                $.clock.after(0, () => {
                  void autoMap($, true).then(result =>
                    $.ui.toast(result === 'mapped' ? 'Map redrawn' : `Couldn't redraw (${result})`),
                  )
                })
              }}
            />
            <Button
              key="set-goal"
              label={g === null ? 'Set goal' : 'Edit goal'}
              onPress={() => $.prompt.fill({ text: '/compass goal ', mode: 'replace' })}
            />
          </Box>
        </Box>

        <Box flexDirection="column">
          {all.length === 0 && <Text dimColor>No branches yet.</Text>}
          {all.length > 0 && <Text dimColor>Tap an item, then type your question about it.</Text>}
          {asTree(all).map(({ b, lead }) => {
            const isSide = b.kind === 'side'
            const isSelected = focusId === b.id
            const pointer = isSelected ? '▶ ' : '  '

            return (
              <Box key={`row-${b.id}`} flexDirection="column">
                <Button
                  key={`b-${b.id}`}
                  plain
                  dimColor={b.status === 'done' && !isSelected}
                  onPress={async () => {
                    const isPicking = (await read($, focus)) !== b.id
                    await update($, focus, () => (isPicking ? b.id : null))
                    $.ui.toast(isPicking ? `Asking about "${cut(b.title, 30)}"` : 'Selection cleared')
                  }}
                >
                  {`${pointer}${lead}${mark(b)} ${b.title}`}
                </Button>
                {isSelected && (
                  <Box flexDirection="row" gap={1} marginLeft={2 + lead.length}>
                    {b.status === 'done' ? (
                      <Button
                        key={`reopen-${b.id}`}
                        label="Reopen"
                        onPress={() => setStatus(b, 'todo', `Reopened: "${b.title}" is not done yet.`)}
                      />
                    ) : (
                      <Button
                        key={`done-${b.id}`}
                        label="Done"
                        onPress={() =>
                          setStatus(b, 'done', `The person approved "${b.title}" as done. Move on.`)
                        }
                      />
                    )}
                    {b.status === 'parked' ? (
                      <Button
                        key={`resume-${b.id}`}
                        label="Resume"
                        onPress={() => setStatus(b, 'todo', `Resumed: "${b.title}" is back on the list.`)}
                      />
                    ) : (
                      <Button
                        key={`park-${b.id}`}
                        label="Park"
                        onPress={() =>
                          setStatus(b, 'parked', `Parked: "${b.title}". Don't work on it now.`)
                        }
                      />
                    )}
                    {b.agentId !== undefined && (
                      <Button
                        key={`view-${b.id}`}
                        label="View"
                        onPress={() => $.ui.view({ agentId: b.agentId as string })}
                      />
                    )}
                    <Button
                      key={`clear-${b.id}`}
                      label="Clear"
                      onPress={() => update($, focus, () => null)}
                    />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>

        {coming.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Coming up · Claude will need you for</Text>
            {coming.map(s => (
              <Box key={`step-${s.id}`} flexDirection="row" gap={1}>
                <Text>{s.label}</Text>
                {s.isRisky ? (
                  <Text dimColor>always asks</Text>
                ) : (
                  <Button
                    key={`approve-${s.id}`}
                    label={s.isApproved ? 'Approved · undo' : 'Approve now'}
                    onPress={async () => {
                      const isApproving = !(await read($, steps)).find(x => x.id === s.id)
                        ?.isApproved
                      await update($, steps, list =>
                        list.map(x => (x.id === s.id ? { ...x, isApproved: isApproving } : x)),
                      )
                      await note(
                        $,
                        isApproving
                          ? `Approved ahead: "${s.label}". When you reach it, do it without asking.`
                          : `Approval taken back: "${s.label}". Ask before doing it.`,
                      )
                    }}
                  />
                )}
              </Box>
            ))}
          </Box>
        )}

        {ran.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Ran on your approval</Text>
            {ran.slice(-5).map((label, i) => (
              <Text key={`ran-${i}`} dimColor>
                ✓ {label}
              </Text>
            ))}
          </Box>
        )}

        <Button
          key="off"
          label="Off for this session"
          onPress={() => switchOff($)}
        />
      </Box>
    )
  })
}
