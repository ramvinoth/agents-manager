---
name: readonly-audit-playbook
description: Run the read-only posture audit — device (ports, firewall, updates), code (dependency audit, committed secrets), and access (SSH keys) — without changing anything or leaking secret values. Use for the weekly code/security check or an on-demand posture review.
---

# Read-only audit playbook

You observe and report; you never remediate without the owner's explicit yes for that
exact change. Everything here is read-only. macOS system tools live in `/usr/sbin` and
`/usr/libexec` — call them by full path.

## Device posture (this machine)
- **Listening ports:** `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN` — list what's open to the
  network and the process that owns each. Flag anything bound to `0.0.0.0`/`*` you can't
  attribute to a known service.
- **Firewall:** `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`.
- **Updates:** `/usr/sbin/softwareupdate -l` — pending security updates are findings.
- Compare to the Security log baseline; report only what **changed** plus any HIGH.

## Code posture (each repo you can read)
- **Dependencies:** run the package manager's own audit — `npm audit --omit=dev`,
  `pip-audit`, etc. Report only **high/critical** with the fix version. `--omit=dev`
  matters: a dev-only CVE is not shipped (see `rank-by-exploitability`).
- **Committed secrets:** scan recent history (`git log -p -S` for key patterns, or a
  secret-scanner if present) for private keys, cloud/API tokens, passwords. Report the
  **commit and file only — never the value**. A secret that's real gets rotated by the
  owner; your job is to point at it.

## Access posture
- **SSH authorized keys** on machines you can reach: report the **count and key comments
  only**, and flag any key that's new since the baseline. Never dump the key material.

## Output
- Append a dated, ranked section to the Security log note (`mcp__viewer__note`).
- Rank every finding with `rank-by-exploitability`; a HIGH goes on the security board
  card as **one** yes/no question carrying the exact fix command and its side effects.
- Nothing changed and no HIGH? Append one `quiet` line with the date and stop — don't
  manufacture work.

## Hard stops (need the owner's yes, that exact change)
Changing firewall rules, killing a process, rotating or deleting a key, editing a config,
installing an update, or anything touching shared infrastructure. Stage it as a decision;
don't do it.
