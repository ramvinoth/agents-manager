/**
 * The first-run goal: a fresh install has no chats, so the Inbox asks the
 * owner what the team should work on and starts one chat titled "CEO" with
 * that goal. The CEO plans the work and sends the first ask to the Inbox.
 * Pure: the screen only wires the result into api.newSession.
 */
export const CEO_TITLE = "CEO"

export const GOAL_EXAMPLES = [
  "Keep my inbox and calendar in order",
  "Research my competitors every week",
  "Build and ship a small app",
] as const

const CEO_PROMPT =
  "You are the CEO of this owner's team. Turn the owner's goal into a short plan, start the work, "
  + "and send the owner your first question through the inbox as soon as you need a decision. "
  + "Ask one thing at a time and keep every message short and plain."

export type FirstGoalStart = { title: string; goal: string; message: string; systemPrompt: string }

export function ceoStart(goalText: string): FirstGoalStart {
  const goal = goalText.trim()
  return { title: CEO_TITLE, goal, message: goal, systemPrompt: CEO_PROMPT }
}
