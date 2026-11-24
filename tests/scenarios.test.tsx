import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__compass__update'
const PANE = {
  plugin: 'compass',
  component: 'Pane',
  requestId: 'compass',
  surface: 'desktop',
  props: {
    title: 'Compass',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
const BAND = {
  plugin: 'compass',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { bodyColumns: 80, hasSurvey: false, view: {} },
} as never

function engine(on: Parameters<Parameters<typeof test>[1]>[1], withStore = true) {
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.toast', () => ({ value: undefined }) as never)
  if (withStore) on('store.get', (_, e: any) => ({ value: e?.key === 'defaultOn' ? true : undefined }))
}
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

async function approve($: any, steps: object[], keys: string[]) {
  await $.tool.call({ tool: TOOL, steps } as never)
  const ui = await $.ui.mount(PANE)
  for (const k of keys) await ui.press({ key: k })
  await ui.unmount()
}

// ---------- Approvals ----------

test('A1 approved PowerShell step skips the prompt (Windows shell)', async ($, on) => {
  engine(on)
  await start($)
  await approve($, [{ id: 's1', label: 'Run tests', tool: 'Bash', match: 'npm test' }], ['approve-s1'])
  const ps = await $.tool.check({ tool: 'PowerShell', input: { command: 'npm test' } } as never)
  expect(ps.decision).toBe('allow')
})

test('A2 risky steps never get an Approve button', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: TOOL,
    steps: [
      { id: 'p', label: 'Push', tool: 'Bash', match: 'git push origin x' },
      { id: 'r', label: 'Clean', tool: 'Bash', match: 'rm -rf dist' },
      { id: 'e', label: 'Env', tool: 'Edit', match: '.env.local' },
      { id: 'd', label: 'Deploy to prod?', tool: 'decision' },
      { id: 'short', label: 'Anything', tool: 'Bash', match: 'ls' },
      { id: 'ok', label: 'Lint', tool: 'Bash', match: 'npm run lint' },
    ],
  } as never)
  const ui = await $.ui.mount(PANE)
  for (const k of ['p', 'r', 'e', 'd', 'short']) expect(await ui.find({ key: `approve-${k}` })).toBeUndefined()
  expect(await ui.find({ key: 'approve-ok' })).toBeDefined()
  await ui.unmount()
})

test('A3 approved Edit step allows only files inside that folder', async ($, on) => {
  engine(on)
  await start($)
  await approve($, [{ id: 'e', label: 'Edit src', tool: 'Edit', match: 'C:\\proj\\src' }], ['approve-e'])
  const inside = await $.tool.check({ tool: 'Edit', input: { file_path: 'C:\\proj\\src\\a.ts' } } as never)
  const outside = await $.tool.check({ tool: 'Edit', input: { file_path: 'C:\\proj\\README.md' } } as never)
  const lookalike = await $.tool.check({ tool: 'Edit', input: { file_path: 'C:\\proj\\src2\\a.ts' } } as never)
  expect(inside.decision).toBe('allow')
  expect(outside.decision).toBe('ask')
  expect(lookalike.decision).toBe('ask')
})

test('A4 a short folder name like "src" does not approve every src folder on disk', async ($, on) => {
  engine(on)
  await start($)
  await approve($, [{ id: 'e', label: 'Edit src', tool: 'Edit', match: 'src' }], ['approve-e'])
  const other = await $.tool.check({ tool: 'Write', input: { file_path: 'D:\\other-project\\src\\x.ts' } } as never)
  expect(other.decision).toBe('ask')
})

test('A5 undo takes an approval back; re-sent step with a new match drops approval', async ($, on) => {
  engine(on)
  await start($)
  await approve($, [{ id: 's', label: 'Tests', tool: 'Bash', match: 'npm test' }], ['approve-s', 'approve-s'])
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })).decision).toBe('ask')
  await approve($, [], ['approve-s'])
  await $.tool.call({ tool: TOOL, steps: [{ id: 's', label: 'Tests', tool: 'Bash', match: 'npm run e2e' }] } as never)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'npm run e2e' } })).decision).toBe('ask')
})

test('A6 approval never loosens a deny, and does nothing while Compass is off', async ($, on) => {
  engine(on)
  await start($)
  await approve($, [{ id: 's', label: 'Tests', tool: 'Bash', match: 'npm test' }], ['approve-s'])
  await $.command.run({ command: 'compass', args: 'off' } as never)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })).decision).toBe('ask')
})

test('A7 clearSteps empties Coming up; ran log shows approved runs', async ($, on) => {
  engine(on)
  await start($)
  await approve($, [{ id: 's', label: 'Run tests', tool: 'Bash', match: 'npm test' }], ['approve-s'])
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
  await $.tool.call({ tool: TOOL, clearSteps: true } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'approve-s' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /✓ Run tests/ })).toBeDefined()
  await ui.unmount()
})

// ---------- Map merging ----------

test('M1 different short work with shared words stays apart', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: TOOL,
    branches: [
      { id: 'a', title: 'Run tests', status: 'done' },
      { id: 'b', title: 'Run lint tests', status: 'working' },
      { id: 'c', title: 'Fix bug', status: 'done' },
      { id: 'd', title: 'Fix login bug', status: 'todo' },
    ],
  } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'b-b' })).toBeDefined()
  expect(await ui.find({ key: 'b-d' })).toBeDefined()
  await ui.unmount()
})

test('M2 parent loops and missing parents are dropped, nothing hangs', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: TOOL,
    branches: [
      { id: 'x', title: 'Alpha work', parent: 'y' },
      { id: 'y', title: 'Beta work', parent: 'x' },
      { id: 'z', title: 'Gamma work', parent: 'nowhere' },
      { id: 'self', title: 'Delta work', parent: 'self' },
    ],
  } as never)
  const ui = await $.ui.mount(PANE)
  for (const k of ['x', 'y', 'z', 'self']) expect(await ui.find({ key: `b-${k}` })).toBeDefined()
  await ui.unmount()
})

test('M3 bad input is ignored without crashing', async ($, on) => {
  engine(on)
  await start($)
  const r = await $.tool.call({
    tool: TOOL,
    goal: '   ',
    branches: [{ id: '' }, { title: 'no id' }, null, { id: 'ok', status: 'bogus', kind: 'weird' }],
    steps: [{ id: 'x', tool: 'Rm', label: 'bad' }, { id: 'y', tool: 'Bash' }],
  } as never)
  expect(JSON.stringify(r)).toContain('Compass updated')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'b-ok' }))?.text).toContain('○ ok')
  await ui.unmount()
})

test('M4 a subagent call cannot change the map', async ($, on) => {
  engine(on)
  await start($)
  const r = await $.tool.call({ tool: TOOL, goal: 'Hijacked', agentId: 'sub1' } as never)
  expect(JSON.stringify(r)).toContain('main conversation')
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).not.toContain('Hijacked')
  await ui.unmount()
})

test('M5 more than 30 branches keeps the newest 30', async ($, on) => {
  engine(on)
  await start($)
  const many = Array.from({ length: 35 }, (_, i) => ({ id: `n${i}`, title: `Unique task number ${i} zq${i}` }))
  await $.tool.call({ tool: TOOL, branches: many } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'b-n0' })).toBeUndefined()
  expect(await ui.find({ key: 'b-n34' })).toBeDefined()
  await ui.unmount()
})

// ---------- Live mapping ----------

function live(on: any, reply: string, prompts: string[] = []) {
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'next thing please', toolUses: [], uuid: 'u1' },
      { role: 'assistant', text: 'Done.', toolUses: [], uuid: 'u2' },
    ],
  }))
  on('model.complete', (_: unknown, e: { prompt: string }) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage } }
  })
  on('turn.complete', () => ({ text: 'Done.' }) as never)
}
const endTurn = async ($: any, clock: any) => {
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't' } as never)
  await clock.advance(1_000)
}

test('L1 a goal the person set with /compass goal survives live mapping', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  live(on, '{"goal": "Something else entirely", "branches": []}')
  await start($)
  await $.command.run({ command: 'compass', args: 'goal Ship the payments page' } as never)
  await endTurn($, clock)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toContain('Ship the payments page')
  await ui.unmount()
})

test('L2 an item the person parked stays parked after live mapping', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  live(on, '{"goal": "G", "branches": [{"id": "a", "title": "Write docs", "status": "working", "kind": "stem"}]}')
  await start($)
  await $.tool.call({ tool: TOOL, goal: 'G', branches: [{ id: 'a', title: 'Write docs', status: 'working' }] } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'b-a' })
  await ui.press({ key: 'park-a' })
  await endTurn($, clock)
  expect((await ui.find({ key: 'b-a' }))?.text).toContain('‖')
  await ui.unmount()
})

test('L3 finished and parked items stay on the map when the model leaves them out', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  live(on, '{"goal": "G", "branches": [{"title": "Brand new step", "status": "working"}]}')
  await start($)
  await $.tool.call({
    tool: TOOL,
    goal: 'G',
    branches: [
      { id: 'd', title: 'Finished setup', status: 'done' },
      { id: 'p', title: 'Parked idea', status: 'parked' },
    ],
  } as never)
  await endTurn($, clock)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'b-d' })).toBeDefined()
  expect(await ui.find({ key: 'b-p' })).toBeDefined()
  await ui.unmount()
})

test('L4 live mapping never makes two items with the same id', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const rows: object[] = []
  on('session.messages', () => {
    rows.push({ role: 'user', text: `msg ${rows.length}`, toolUses: [], uuid: `u${rows.length}` })
    return { value: [...rows] }
  })
  const replies = [
    '{"goal": "G", "branches": [{"id": "a"}, {"id": "b"}, {"title": "Xray qq", "status": "working"}]}',
    '{"goal": "G", "branches": [{"title": "Zulu ww", "status": "working"}]}',
    '{"goal": "G", "branches": [{"title": "Papa ee"}, {"title": "Quebec rr"}, {"title": "Romeo tt", "status": "working"}]}',
  ]
  on('model.complete', () => ({ value: { isAnswered: true, text: replies.shift() ?? '{}', usage } }))
  on('turn.complete', () => ({ text: 'ok' }) as never)
  await start($)
  await $.tool.call({
    tool: TOOL,
    goal: 'G',
    branches: [
      { id: 'a', title: 'Alpha aa', status: 'done' },
      { id: 'b', title: 'Bravo bb', status: 'done' },
    ],
  } as never)
  for (let i = 0; i < 3; i++) await endTurn($, clock)
  const ui = await $.ui.mount(PANE)
  const all = await ui.findAll({ type: 'Button', text: /(qq|ww|ee|rr|tt)/ })
  const keys = all.map(r => r.key)
  expect(new Set(keys).size).toBe(keys.length)
  await ui.unmount()
})

test('L6 Map so far works on a reopened old session (nothing to fork yet)', async ($, on) => {
  engine(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }) as never)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Help me plan the launch email', toolUses: [], uuid: 'u1' },
      { role: 'assistant', text: 'Drafted the email.', toolUses: [{ tool: 'Write' }], uuid: 'u2' },
    ],
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"goal": "Plan the launch email", "branches": [{"title": "Draft the email", "status": "done", "kind": "stem"}]}',
      usage,
    },
  }))
  await start($)
  const r = await $.command.run({ command: 'compass', args: 'map' } as never)
  expect(JSON.stringify(r)).toContain('Map redrawn')
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toContain('Plan the launch email')
  await ui.unmount()
})

test('L5 a garbage model answer leaves the map as it was', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  live(on, 'sorry, I cannot {not json')
  await start($)
  await $.tool.call({ tool: TOOL, goal: 'Keep me', branches: [{ id: 'a', title: 'Keep this' }] } as never)
  await endTurn($, clock)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'b-a' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Keep me/ })).toBeDefined()
  await ui.unmount()
})

// ---------- Commands, on/off, notes ----------

test('C1 /compass reset clears goal, branches, steps and selection', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: TOOL,
    goal: 'G',
    branches: [{ id: 'a', title: 'Thing' }],
    steps: [{ id: 's', label: 'Lint', tool: 'Bash', match: 'npm run lint' }],
  } as never)
  await $.command.run({ command: 'compass', args: 'reset' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /No goal yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No branches yet/ })).toBeDefined()
  expect(await ui.find({ key: 'approve-s' })).toBeUndefined()
  await ui.unmount()
})

test('C3 pane taps send [Compass] notes to Claude', async ($, on) => {
  engine(on)
  const session = mock.session(on)
  await start($)
  await $.tool.call({
    tool: TOOL,
    branches: [{ id: 'a', title: 'Write docs', status: 'working' }],
    steps: [{ id: 's', label: 'Lint', tool: 'Bash', match: 'npm run lint' }],
  } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'b-a' })
  await ui.press({ key: 'park-a' })
  await ui.press({ key: 'approve-s' })
  await ui.unmount()
  const notes = session.appended().map(r => JSON.stringify(r.message))
  expect(notes.some(n => n.includes('[Compass] Parked'))).toBe(true)
  expect(notes.some(n => n.includes('[Compass] Approved ahead'))).toBe(true)
})

test('C4 default off: a new session starts with Compass off', async ($, on) => {
  engine(on, false)
  mock.store(on, { defaultOn: false })
  await start($)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toBe('◎ Compass is off in this session')
  await ui.unmount()
})

test('C4b no default set: a new session starts with Compass off', async ($, on) => {
  engine(on, false)
  mock.store(on, {})
  await start($)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toBe('◎ Compass is off in this session')
  await ui.unmount()
})

test('C5 band counts: done/total excludes parked; shows to-approve', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: TOOL,
    goal: 'Ship it',
    branches: [
      { id: 'a', title: 'One thing', status: 'done' },
      { id: 'b', title: 'Two thing', status: 'working' },
      { id: 'c', title: 'Three idea', status: 'parked' },
    ],
    steps: [{ id: 's', label: 'Lint', tool: 'Bash', match: 'npm run lint' }],
  } as never)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toBe('◎ Ship it · 1/2 done · 1 to approve')
  await ui.unmount()
})
