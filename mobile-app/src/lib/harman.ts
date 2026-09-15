import { api } from "../api/client"
import { resolveSessionPath } from "./session"

// Harman (Harness Manager): an orchestrator session created in the home
// directory so it can see and coordinate every project on the machine. This is
// the mobile twin of web/src/components/HarmanDialog.tsx — same character and
// bootstrap, so a Harman started from either client is the same agent.
export const HARMAN_TITLE = "Harman"

const DEFAULT_CHARACTER = `You are Harman (Harness Manager), the orchestrator agent for this machine, running from the home directory with access to every project.

Your duties:
1. Coordinate the sub-projects under the home directory (e.g. ~/projects, ~/Documents/projects).
2. Report the status of agent work sessions. Transcripts are JSONL files under ~/.claude/projects/<project-dir>/<session-id>.jsonl — read the tails of recently modified ones to summarize what each session is doing, its outcome, and any blockers.
3. Propose concrete next actions per project when asked.

Keep reports concise and structured: one section per project, with status, last activity, and blockers.`

const BOOTSTRAP =
  "You are online as Harman. Confirm briefly, then list the project directories you can see under your home directory with a one-line note for each."

/**
 * Create the Harman orchestrator session on `host` and return its transcript
 * path, or null if the session started but its transcript never resolved.
 *
 * cwd "~" is expanded to the home dir server-side so Harman can reach every
 * project. The title is saved via renameSession because the server's
 * new-session handler doesn't persist it for Claude (same as NewChatScreen).
 */
export async function createHarman(host: string): Promise<string | null> {
  const res = await api.newSession({
    message: BOOTSTRAP,
    cwd: "~",
    host,
    agent: "claude",
    title: HARMAN_TITLE,
    systemPrompt: DEFAULT_CHARACTER,
  })
  const path = res.path ?? (await resolveSessionPath(res.session, host))
  if (!path) return null
  api.renameSession({ session: path, title: HARMAN_TITLE, host }).catch(() => {})
  return path
}
