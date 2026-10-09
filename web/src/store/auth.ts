/** Viewer account (sign in/up/out) and the Claude CLI login flow on the host. */
import { api } from "../lib/api"
import { SessionParser } from "../lib/parser"
import type { Slice, AuthStatus } from "./types"

let loginTimer: ReturnType<typeof setInterval> | null = null

export interface AuthSlice {
  auth: AuthStatus | null
  serverVersion: string | null
  needsAuth: boolean
  authUser: { id: number; username: string; role?: string } | null
  signupOpen: boolean
  loginActive: boolean
  loginUrl: string
  loginNote: string
  init: () => Promise<void>
  signin: (username: string, password: string) => Promise<string | undefined>
  signup: (username: string, password: string, setupCode: string) => Promise<string | undefined>
  signout: () => Promise<void>
  refreshAuth: () => Promise<void>
  startLogin: () => Promise<void>
  submitLoginCode: (code: string) => Promise<void>
  cancelLogin: () => void
}

export const createAuthSlice: Slice<AuthSlice> = (set, get, rt) => {
  const { stopTimers, bootApp } = rt

  function watchLogin() {
    if (loginTimer) clearInterval(loginTimer)
    loginTimer = setInterval(async () => {
      try {
        const d: any = await api.authLoginPoll()
        if (d.stage === "url" && d.url) {
          set({ loginUrl: d.url, loginNote: d.note || "Open the login page, approve access, then paste the code here." })
        }
        if (d.stage === "done") {
          if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
          await get().refreshAuth()
          set({ loginActive: false, loginUrl: "", loginNote: "" })
        }
        if (d.stage === "error") {
          if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
          set({ loginNote: "Login failed: " + (d.error || "try again") })
        }
      } catch {
        /* keep polling */
      }
    }, 1000)
  }
  return {
    auth: null,
    serverVersion: null,
    needsAuth: false,
    authUser: null,
    signupOpen: false,
    loginActive: false,
    loginUrl: "",
    loginNote: "",
    init: async () => {
      // A 401 mid-session (expired) → drop back to the login screen.
      api.onUnauthorized = () => {
        if (!get().needsAuth) set({ needsAuth: true, authUser: null })
      }
      try {
        const st: any = await api.authState()
        if (st.user) {
          set({ authUser: st.user, needsAuth: false })
        } else {
          set({ needsAuth: true, signupOpen: !!st.signupOpen, authUser: null, loading: false })
          return // logged out — the landing renders; don't load app data
        }
      } catch {
        set({ needsAuth: true, loading: false })
        return
      }
      await bootApp()
    },
    signin: async (username, password) => {
      try {
        const d: any = await api.signin({ username, password })
        if (d.error || !d.user) return d.error || "Sign-in failed"
        set({ needsAuth: false, authUser: d.user, error: null })
        await bootApp()
      } catch (e: any) {
        return e?.message || String(e)
      }
    },
    signup: async (username, password, setupCode) => {
      try {
        const d: any = await api.signup({ username, password, setupCode })
        if (d.error || !d.user) return d.error || "Sign-up failed"
        set({ needsAuth: false, authUser: d.user, signupOpen: false, error: null })
        await bootApp()
      } catch (e: any) {
        return e?.message || String(e)
      }
    },
    signout: async () => {
      stopTimers()
      await api.signout().catch(() => {})
      // Wipe every per-account view so the shell is clean, not stale (LHS
      // sessions, RHS skills/MCP, top-bar host/agent/session all reset).
      set({
        needsAuth: true, authUser: null, error: null,
        currentSessionPath: "", turns: [], droppedFile: null, parser: new SessionParser(),
        sessions: [], hosts: [], agents: [], caps: { skills: [], mcp: [] },
        meta: null, sessionAI: null, git: null, loops: [], fullSummary: null, analysis: null, analysisError: null,
        harman: null, loopControl: null, automationOn: false, systemPreamble: null,
        slashCommands: [], queue: [], chatRunning: false, chatStatus: null,
        panel: null, fsOpen: false, searchOpen: false,
      })
    },
    refreshAuth: async () => {
      try {
        const a = await api.authStatus()
        set({ auth: a })
      } catch {
        /* leave unknown */
      }
    },
    startLogin: async () => {
      set({ loginActive: true, loginUrl: "", loginNote: "Starting login…" })
      try {
        await (await api.authLoginStart()).json()
        watchLogin()
      } catch (e: any) {
        set({ loginNote: "Failed to start login: " + (e?.message || e) })
      }
    },
    submitLoginCode: async (code) => {
      if (!code.trim()) return
      set({ loginNote: "Verifying code…" })
      try {
        const res = await api.authLoginCode({ code: code.trim() })
        const d = await res.json()
        if (d.error) throw new Error(d.error)
      } catch (e: any) {
        set({ loginNote: "Error: " + (e?.message || e) })
      }
    },
    cancelLogin: () => {
      api.authLoginCancel().catch(() => {})
      if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
      set({ loginActive: false, loginUrl: "", loginNote: "" })
    },
  }
}
