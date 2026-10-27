import { api } from "../api/client"
import type { StartingChat } from "./session"

// Manager: an orchestrator session created in the home
// directory so it can see and coordinate every project on the machine. This is
// the mobile twin of web/src/components/ManagerDialog.tsx — same character and
// bootstrap, so a Manager started from either client is the same agent.
export const MANAGER_TITLE = "Manager"

const DEFAULT_CHARACTER = `You are Manager, the orchestrator agent for this machine, running from the home directory with access to every project.

Your duties:
1. Coordinate the sub-projects under the home directory (e.g. ~/projects, ~/Documents/projects).
2. Report the status of agent work sessions. Transcripts are JSONL files under ~/.claude/projects/<project-dir>/<session-id>.jsonl — read the tails of recently modified ones to summarize what each session is doing, its outcome, and any blockers.
3. Propose concrete next actions per project when asked.

Keep reports concise and structured: one section per project, with status, last activity, and blockers.`

const BOOTSTRAP =
  "You are online as Manager. Confirm briefly, then list the project directories you can see under your home directory with a one-line note for each."

/**
 * Start the Manager session on `host` and return what the Thread
 * needs to open it at once (it resolves the transcript itself).
 *
 * cwd "~" is expanded to the home dir server-side so Manager can reach every
 * project. The title travels with `starting` and is saved once the transcript
 * exists, because the server's new-session handler doesn't persist it for Claude.
 */
export async function createManager(host: string): Promise<{ path?: string; starting: StartingChat }> {
  const res = await api.newSession({
    message: BOOTSTRAP,
    cwd: "~",
    host,
    agent: "claude",
    title: MANAGER_TITLE,
    systemPrompt: DEFAULT_CHARACTER,
  })
  return { path: res.path, starting: { session: res.session, message: BOOTSTRAP } }
}
