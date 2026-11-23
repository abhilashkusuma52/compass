import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'compass',
  component: 'Pane',
  requestId: 'compass',
  props: {
    title: 'Compass',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TOOL = 'mcp__compass__update'

function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }))
}

test('Claude fills the map and the pane draws it on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    goal: 'Ship login on mobile',
    branches: [
      { id: 'a', title: 'Fix token bug', status: 'done' },
      { id: 'b', title: 'Phone test', status: 'working' },
    ],
    steps: [
      { id: 's1', label: 'Run the tests', tool: 'Bash', match: 'npm test' },
      { id: 's2', label: 'Push to main', tool: 'Bash', match: 'git push origin main' },
    ],
  } as never)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Ship login/ }))?.text).toBe(
      '◎ Ship login on mobile',
    )
    expect((await ui.find({ key: 'b-b' }))?.text).toContain('Phone test')
    expect(await ui.find({ key: 'approve-s1' })).toBeDefined()
    expect(await ui.find({ key: 'approve-s2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Compass maps the goal and the work so far from the conversation', async ($, on) => {
  engine(on)
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'Here it is: {"goal": "Plan SEO and GEO", "branches": [{"id": "kw", "title": "Keyword research", "status": "done", "kind": "stem"}, {"title": "Mobile app tips", "status": "done", "kind": "side"}, {"title": "Write blog posts", "status": "working", "kind": "stem"}]}',
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Claude already put the same work on the map under other words.
  await $.tool.call({
    tool: TOOL,
    branches: [{ id: 'kw', title: 'Research keywords', status: 'working' }],
  } as never)
  await $.command.run({ command: 'compass', args: 'map' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Plan SEO/ }))?.text).toBe('◎ Plan SEO and GEO')
  expect((await ui.find({ key: 'b-kw' }))?.text).toContain('✓ Keyword research')
  expect(await ui.find({ type: 'Button', text: /Research keywords/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', text: /Mobile app tips/ }))?.text).toContain('└─')
  expect(await ui.find({ type: 'Button', text: /Write blog posts/ })).toBeDefined()
  await ui.unmount()
})

test('a new id for the same work updates the item instead of doubling it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    branches: [
      { id: 'i1', title: 'Build and test Compass', status: 'working' },
      { id: 'f1', title: 'Fix login bug', status: 'working' },
    ],
  } as never)
  await $.tool.call({
    tool: TOOL,
    branches: [
      { id: 'i2', title: 'Test and build the Compass mod', status: 'done' },
      { id: 'f2', title: 'Fix signup bug', status: 'todo' },
    ],
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'b-i1' }))?.text).toContain('✓')
  expect(await ui.find({ key: 'b-i2' })).toBeUndefined()
  // Different work that shares words stays apart.
  expect((await ui.find({ key: 'b-f1' }))?.text).toContain('Fix login bug')
  expect((await ui.find({ key: 'b-f2' }))?.text).toContain('Fix signup bug')
  await ui.unmount()
})

test('a selected item tags the next message so Claude knows the branch', async ($, on) => {
  engine(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    branches: [
      { id: 'a', title: 'Fix token bug', status: 'done', kind: 'stem' },
      { id: 'm', title: 'Mobile app tips', status: 'done', kind: 'side' },
    ],
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-m' })
  expect(await ui.find({ key: 'clear-m' })).toBeDefined()
  await $.prompt.submit({ text: 'what about testing?' } as never)
  await ui.press({ key: 'clear-m' })
  await $.prompt.submit({ text: 'and now?' } as never)
  await ui.unmount()

  expect(seen[0]?.join(' ')).toContain('side branch "Mobile app tips"')
  expect(seen[1]?.some(c => c.includes('[Compass]')) ?? false).toBe(false)
})

test('the map keeps building after each reply, from what was said since', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const asked: string[] = []
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Now add dark mode to settings', toolUses: [], uuid: 'u1' },
      { role: 'assistant', text: 'Dark mode added.', toolUses: [{ tool: 'Edit' }], uuid: 'u2' },
    ],
  }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '{"goal": "Ship login on mobile", "branches": [{"id": "a", "title": "Fix token bug", "status": "done", "kind": "stem"}, {"title": "Dark mode in settings", "status": "done", "kind": "side"}]}',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
  })
  on('turn.complete', () => ({ text: 'Dark mode added.' }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    goal: 'Ship login on mobile',
    branches: [{ id: 'a', title: 'Fix token bug', status: 'working' }],
  } as never)

  await $.turn.complete({ answer: 'Dark mode added.', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await clock.advance(1_000)

  expect(asked.join(' | ')).toContain('Person: Now add dark mode to settings')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'b-a' }))?.text).toContain('✓ Fix token bug')
  expect((await ui.find({ type: 'Button', text: /Dark mode/ }))?.text).toContain('└─')
  await ui.unmount()
})

const BAND = {
  plugin: 'compass',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { bodyColumns: 80, hasSurvey: false, view: {} },
} as never

test('the band shows in a new session before the first prompt, and Off works from it', async ($, on) => {
  engine(on)
  on('ui.close', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toContain('after the first reply')
  await ui.press({ key: 'off' })
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toBe('◎ Compass is off in this session')
  await ui.press({ key: 'on' })
  expect(await ui.find({ key: 'off' })).toBeDefined()
  await ui.unmount()
})

test('a scheduled run starts with Compass off; the person can turn it on', async ($, on) => {
  engine(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('ui.close', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    branches: [{ id: 'a', title: 'Fix token bug', status: 'working' }],
  } as never)

  await $.prompt.submit({ text: 'run the nightly check', origin: { kind: 'scheduled-trigger' } } as never)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /◎/ }))?.text).toBe('◎ Compass is off in this session')
  await ui.press({ key: 'on' })
  expect(await ui.find({ key: 'off' })).toBeDefined()
  await ui.unmount()

  // A person's own session stays on.
  expect(seen.length).toBe(1)
})

test('More asks once and returns at once, even while Claude is busy', async ($, on) => {
  engine(on)
  let submitted = 0
  // Stands for a busy session: the submit only resolves when the turn starts.
  on('prompt.submit', () => {
    submitted += 1
    return new Promise(() => undefined)
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, goal: 'Ship login' } as never)

  const ui = await $.ui.mount({
    plugin: 'compass',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { bodyColumns: 80, hasSurvey: false, view: {} },
  } as never)
  await ui.press({ key: 'more' })
  await ui.press({ key: 'more' })
  await ui.unmount()

  expect(submitted).toBe(1)
})

test('an approved step skips the prompt; chained and risky commands still ask', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    steps: [{ id: 's1', label: 'Run the tests', tool: 'Bash', match: 'npm test' }],
  } as never)

  const before = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
  expect(before.decision).toBe('ask')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'approve-s1' })
  await ui.unmount()

  const plain = await $.tool.check({ tool: 'Bash', input: { command: 'npm test -- --watch=false' } })
  expect(plain.decision).toBe('allow')
  const chained = await $.tool.check({ tool: 'Bash', input: { command: 'npm test && rm -rf /' } })
  expect(chained.decision).toBe('ask')
  const other = await $.tool.check({ tool: 'Bash', input: { command: 'npm testing' } })
  expect(other.decision).toBe('ask')
})

test('work asked with an item selected nests under that item', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    branches: [
      { id: 'a', title: 'Fix ribbon button', status: 'done', kind: 'stem' },
      { id: 'm', title: 'Mobile app tips', status: 'done', kind: 'side' },
      { id: 'z', title: 'Default off for schedules', status: 'done', kind: 'stem' },
    ],
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b-m' })
  await $.prompt.submit({ text: 'why not Stripe instead of in-app payments?' } as never)
  await $.tool.call({
    tool: TOOL,
    branches: [{ id: 's', title: 'Stripe versus in-app payments', status: 'done', kind: 'side' }],
  } as never)

  const child = await ui.find({ key: 'b-s' })
  expect(child?.text).toContain('└─')
  expect(child?.text?.indexOf('└─')).toBeGreaterThan(
    (await ui.find({ key: 'b-m' }))?.text?.indexOf('└─') ?? 99,
  )
  await ui.unmount()
})
