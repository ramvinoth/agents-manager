# Design: Encrypted secrets store (env-injected, no new MCP dependency)

Status: DESIGN ONLY — no implementation yet. For review.
Decisions locked by user: **reference-only exposure**, **encrypt at rest with a
master key**, **design-first**. Plus a key simplification agreed during design:
**the MCP tool is optional / deferred — env-injection is the interface.**

## 1. Why (and why NOT an MCP tool)

We already inject secrets into every agent run's subprocess environment:
- `viewer/hostenv.py` — `host_env(hid)` → `{KEY: VALUE}` merged into the run env.
- `viewer/providers.py` — provider API key → `ANTHROPIC_AUTH_TOKEN`.
- `viewer/gitops.py` — git token via a credential-helper file.

So an agent can already do `curl -H "Authorization: Bearer $STRIPE_KEY" …` with
**no new tooling** — and, crucially, the raw value never enters the model's
context, the transcript JSONL, the mobile/web chat UI, or push notifications.
That property is the entire security win; a `get_secret()` MCP tool that RETURNS
the value would destroy it (it'd land in the transcript and render in the app —
reopening exactly the exfil hole the S2 fix closed this cycle).

What the store adds over today: (a) **encryption at rest** — today's
`.viewer-*.json` are plaintext 0600, flagged as a download-exposure risk; (b) a
**single management surface** across app/web instead of scattered dialogs; (c) an
**audit trail** of which secret was injected into which run.

**MCP tool: DEFERRED.** Env-injection is the interface. The only thing an MCP tool
would add is (1) discovery — better handled by injecting
`SECRETS_AVAILABLE=STRIPE_KEY,OPENAI_KEY` as a plain env var — and (2) *per-use*
approval gating, which env-injection can't do (once in the env, it's available for
the whole run). If per-use approval is later wanted, add a reference-only MCP tool
(`list_secrets`, `use_secret(name)->"$NAME"` placeholder, NEVER the value) behind
the existing permission-MCP gate. Not needed for v1.

## 2. Storage & crypto (encrypt-at-rest with a master key)

### 2a. Backend abstraction (future-proof for the OSS→SaaS direction)

The store is defined by a small INTERFACE so the file-vs-DB choice is a swappable
backend, NOT baked into the crypto, the env-injection hook, or the UI:

    class SecretStore(Protocol):
        def list_names(self, scope_filter=None) -> list[dict]   # names + meta, NEVER values
        def get_blob(self, name) -> dict | None                 # {ciphertext, nonce, scope, created}
        def put_blob(self, name, blob) -> None
        def delete(self, name) -> None
        def all_blobs(self, host, session_id) -> dict[str, dict] # in-scope, for injection

Crypto (§2c) and the env-injection hook (§3) operate ONLY on ciphertext blobs, so
they don't care where the blob lives. Two backends:

- **FileStore (v1, OSS / single-owner box):** the right call today —
  - No DB round-trip on the run-start hot path (files read synchronously at
    subprocess spawn, same as hostenv.py/providers.py already do).
  - Secrets are OPERATOR-scoped (the box's SSH/API creds), not per-end-user — maps
    naturally to a config file, same tier as the provider keys it sits beside.
  - Separate backup/blast-radius from the DB: a `pg_dump` never contains live keys.
- **DbStore (later, the private multi-user SaaS wrapper):** the right call there —
  in a multi-user product secrets MUST be per-user + queryable, which is exactly
  what Postgres is for. A `secrets` table (encrypted `blob` column) joined to
  `users`, same tier as `prefs`/`push_tokens`. Swapped in WITHOUT touching crypto,
  injection, or UI.

v1 ships FileStore only. `secret_store()` returns the backend (file today; a
`VIEWER_SECRETS_BACKEND=db` switch later selects DbStore).

### 2b. FileStore on-disk format

File `~/.claude/.viewer-secrets.json`, 0600, created via `os.open(...,0o600)`
(same no-world-readable-window pattern just applied to login/git tokens). Schema:

    {
      "version": 1,
      "secrets": {
        "STRIPE_KEY": {"ciphertext": "<b64>", "nonce": "<b64>",
                       "created": <ts>, "scope": "global|host:<hid>|session:<sid>"},
        ...
      }
    }

### 2c. Crypto (backend-agnostic)

- **Cipher**: AES-256-GCM (via `cryptography` if available; else document a
  `pip install cryptography` prereq — do NOT hand-roll crypto). Per-secret random
  96-bit nonce. GCM tag gives tamper-detection.
- **Master key**: read from env `VIEWER_SECRETS_KEY` (base64 32 bytes) at startup;
  if unset, derive-and-persist one to `~/.claude/.viewer-secrets-key` (0600) so a
  single-owner box works out-of-the-box, with a log line telling the user to move
  it to an env var / OS keychain for a shared box. Master key is NEVER written to
  the secrets file and NEVER leaves the server.
- **Values are write-only over the API** — like the provider `apiKey` field today:
  the app/web can SET a value and LIST names, but GET never returns plaintext.

Retrofit note (separate task, optional): migrate the existing plaintext
`.viewer-providers.json` / `.viewer-hosts.json` to the same encrypted store so
there's one crypto path. Keep out of v1 scope to limit blast radius.

## 3. Server (`viewer/secrets.py`, mirrors providers.py)

`secrets.py` holds the crypto + the public API and delegates persistence to the
`SecretStore` backend (§2a) — it never reads/writes a file or the DB directly:

    _store = secret_store()                   # FileStore v1; DbStore later
    list_names(scope_filter) -> [{name,...}]  # via _store, names/meta only, NEVER values
    set_secret(name, value, scope)            # validate name ^[A-Z_][A-Z0-9_]*$; encrypt → put_blob
    delete_secret(name)                       # _store.delete
    secret_env(host, session_id) -> {NAME: VALUE}  # _store.all_blobs → decrypt in-scope

Routes (`viewer/routes/secrets.py`, auth-gated like everything else):
    GET  /api/secrets            -> {secrets:[{name,scope,created}]}   (no values)
    POST /api/secrets            -> set {name,value,scope}
    POST /api/secrets/delete     -> {name}

Injection hook: in each `start_*_run` env build (engine.py:383/490/575/682/1035),
merge `secrets.secret_env(host, session_id)` alongside the existing
`host_env(hid)`. One helper, called where hostenv already is. Also inject
`SECRETS_AVAILABLE=<comma-names>` so the agent can discover without an MCP tool.
Scope resolution: session-scoped override host-scoped override global.

## 4. App + web UI

Mirror the existing provider-preset editor (SessionProfileScreen already has the
exact pattern: name + write-only secret field + save/delete, value never read
back). A "Secrets" section: list names + scope chips, add/rotate (value input is
`secureTextEntry`, placeholder "leave blank to keep current"), delete. Web gets
the same CRUD. No value is ever fetched to the client.

## 5. Audit

Extend the run-start log: when `secret_env` injects, log
`[secrets] injected N secret(s) into run <sid>: NAME1,NAME2` (names only, never
values) — flushed, same channel as the save-failure logging added this cycle.

## 6. Phasing (proves the security model before native ships)

1. `secrets.py` (crypto + API) + **FileStore backend** + routes + env-injection hook
   + `SECRETS_AVAILABLE`. Test end-to-end: set a secret via curl, start a chat run,
   have the agent `echo $SECRETS_AVAILABLE` and use `$STRIPE_KEY` in a request —
   confirm the raw value appears NOWHERE in the transcript JSONL, `/api/session`
   output, or a pushed notification. This is the make-or-break security test.
2. App + web management UI → one TestFlight build.
3. (SaaS wrapper, later) `DbStore` backend behind the same `SecretStore` interface
   — a `secrets` table joined to `users`. Swaps in via `VIEWER_SECRETS_BACKEND=db`
   with NO change to crypto, injection, routes, or UI.
4. (Optional, later) reference-only MCP tool for per-use approval gating.
5. (Optional, later) migrate existing plaintext stores onto the encrypted path.

## 7. Risks / honest notes

- **`cryptography` dependency** on the viewer host — one `pip install`. If we want
  zero-dep, `hashlib.pbkdf2` + `hmac` + XOR-stream is possible but I would NOT
  hand-roll AEAD; better to take the dep.
- **Master-key handling is the whole ballgame.** A key auto-persisted next to the
  data on a shared box is only as safe as the file perms. The env-var path is the
  real protection; the auto-persist is a single-owner convenience with a warning.
  (In the DbStore/SaaS phase the master key MUST come from env/KMS, never the DB —
  else a DB dump decrypts itself.)
- **File vs DB is a deliberate tier split, not legacy sprawl.** Today the DB holds
  per-END-USER queryable state (users/sessions/prefs/push/pending_*); the JSON
  files hold OPERATOR-scoped single-instance config (hosts/providers/env/tokens)
  read synchronously at subprocess-spawn. Secrets are operator-scoped today → File.
  They become per-user in the SaaS wrapper → DB. The §2a interface is what lets
  that switch happen without a rewrite.
- **Scope creep**: retrofitting hosts/providers onto encryption is tempting but is
  a separate, riskier migration — keep it out of v1.
- Not a blocker for the current release; this is net-new capability, not a fix.

