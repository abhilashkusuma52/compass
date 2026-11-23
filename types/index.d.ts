export type BranchStatus = 'todo' | 'working' | 'done' | 'parked'

/** stem: a step on the way to the goal. side: a topic that forked off it. */
export type BranchKind = 'stem' | 'side'

export type Branch = {
  id: string
  title: string
  status: BranchStatus
  /** Absent reads as stem. */
  kind?: BranchKind
  /** The item this one grew out of (a follow-up asked with that item selected). */
  parentId?: string
  agentId?: string
}

/** Bash: a command prefix. Edit: a file or folder path. decision: a question Claude would stop to ask. */
export type StepTool = 'Bash' | 'Edit' | 'decision'

export type Step = {
  id: string
  label: string
  tool: StepTool
  match: string
  isRisky: boolean
  isApproved: boolean
}

declare module 'claude-code' {
  interface PluginState {
    compass: {
      goal: string | null
      branches: Shaped<Branch[]>
      focus: string | null
      steps: Shaped<Step[]>
      isOff: boolean
      /** Who sent the session's first prompt: the person, or a scheduled task. */
      startedBy: 'person' | 'schedule' | null
      /** The item selected when the person last wrote; new work goes under it. */
      askedUnder: string | null
      log: Shaped<string[]>
      /** The person set the goal themselves; automatic mapping leaves it alone. */
      isGoalPinned: boolean
    }
  }
}
