# Agents — mobile app

A thin **React Native (Expo)** client for the Agents server. It talks to a
running server over HTTPS/WSS — the server does the SSH, CDP, and orchestration.
There is **no direct-SSH** in this client by design (server-backed only).

> Status: **scaffold**. Screens compile against the real API contracts, but the
> project has not been installed or run on a device yet. The terminal bridge
> (`TerminalScreen.tsx`) in particular needs on-device validation.

## What it does (MVP)

- **Connect** to your server URL (reach a self-hosted box over **Tailscale**).
- **Sign in** — stores the `viewer_session` token in the OS keystore and sends it
  as `Authorization: Bearer <token>`.
- **Hosts** — list local + remote hosts from `/api/hosts`.
- **Drive** — send a prompt to `/api/chat`, poll `/api/chat/status`, interrupt.
- **Terminal** — xterm.js in a WebView over `/api/terminal/ws`.

Deferred (see `../../agents-manager-e2e-saas/docs/mobile-app-architecture.md`):
transcript viewer, browser live-view, file manager, push notifications, direct SSH.

## Requires this repo's backend change

Auth uses a Bearer token, enabled by the server change in `viewer/server.py`
(`_auth_token`) and `viewer/routes/auth.py` (signin/signup return the token when
`wantToken` is set). Both live in this repo, so client and server ship together.

## Run it

```bash
cd mobile-app
npx expo install            # reconcile native dep versions for the SDK
npm start                   # Expo dev server; open in Expo Go or a dev build
```

On first launch: enter your server URL (e.g. `http://<tailnet-ip>:8091`), sign
in, pick a host, drive or open a terminal.

## Notes

- **Terminal auth:** a browser WebSocket can't set headers, so RN owns the socket
  (it *can* send `Authorization`) and bridges bytes to the WebView. xterm loads
  from a CDN in the scaffold — bundle it as an asset before shipping.
- **New sessions:** `DriveScreen` drives an existing session by `path`. Creating
  a session (`/api/new-session`) + a session picker is the next step.
- **TanStack Query** is the intended data layer (per the architecture doc); the
  scaffold uses plain hooks to keep the surface small.
