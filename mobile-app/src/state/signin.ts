/**
 * Finishing a sign-in, shared by every way a phone gets a token: the password
 * form (LoginScreen) and a scanned pairing QR (pairFromLink). One place stores
 * the token on the active server and registers the device for push, so the two
 * paths can't drift.
 */
import { Alert } from "react-native"
import Constants from "expo-constants"
import { api } from "../api/client"
import { registerForPush } from "../lib/notify"
import { parsePairLink } from "../lib/pairLink"
import { activeServerId, addServer, setToken, switchServer } from "./config"

export async function completeSignIn(token: string, username?: string): Promise<void> {
  // Record the username with the token so actor labels ("you") render
  // client-side on cards and threads without a round trip.
  await setToken(token, username)
  // Register this device for background push now that we're authenticated,
  // declaring which build it runs (version + native build number from the
  // embedded Info.plist) so the server can see what is on the device.
  registerForPush((tok) =>
    api.pushRegister(tok, "ios", { version: Constants.expoConfig?.version ?? null, build: Constants.ios?.buildNumber ?? null }),
  ).catch(() => {})
}

function confirm(title: string, message: string, ok: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: ok, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  )
}

/**
 * Handle a scanned `agents://pair?...` link: confirm the server with the person
 * (a link from anywhere could point at a look-alike server), add + switch to it,
 * and redeem the one-time code for a token. Returns true when signed in; false
 * when it isn't a pairing link, was cancelled, or failed (the failure is shown).
 */
export async function pairFromLink(raw: string): Promise<boolean> {
  const link = parsePairLink(raw)
  if (!link) return false
  const where = link.url || "your Manager through the Manager relay (end-to-end encrypted)"
  const ok = await confirm("Connect this phone?", `Sign in to ${where}\n\nOnly continue if you just scanned this from your own Manager.`, "Connect")
  if (!ok) return false
  // A failed redeem must not strand the phone on a server it has no token for
  // (the screen underneath may be Home on the previous server), so switch back.
  const previous = activeServerId()
  try {
    const entry = await addServer(link.url || "", undefined, link.relay)
    await switchServer(entry.id)
    const res = await api.pairRedeem(link.code)
    await completeSignIn(res.token, res.user?.username)
    return true
  } catch (e) {
    if (previous && previous !== activeServerId()) await switchServer(previous).catch(() => {})
    Alert.alert("Couldn't connect", (e as Error).message)
    return false
  }
}
