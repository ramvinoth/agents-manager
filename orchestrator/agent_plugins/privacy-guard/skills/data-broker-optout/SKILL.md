---
name: data-broker-optout
description: Run the people-search / data-broker opt-out playbook — find the owner's listings, capture each site's exact opt-out requirement, and queue them as ONE owner decision, never submitting without a yes. Use for the weekly broker sweep or when the owner asks to clean up their exposure.
---

# Data-broker opt-out playbook

The goal is to remove the owner's listings from people-search sites. You find and stage
the work; the owner authorizes submission. Never submit an opt-out, upload an ID, or pay
a fee without the owner's explicit yes for that exact site.

## 1. Read the log first
`mcp__viewer__note_list` → open the Privacy log. A site marked `removed` or `pending`
last week is not re-listed as new work. Opt-outs take days-to-weeks to take effect, so
re-verify pending ones before treating them as still-listed.

## 2. Find listings (browser, read-only)
Search each major broker for the owner's name + city with the Playwright browser:
TruePeopleSearch, FastPeopleSearch, Spokeo, Whitepages, BeenVerified, Radaris.
- Confirm it's actually the owner (match city / relatives / age), not a namesake.
- If a site blocks automated access (CAPTCHA, login wall), record `blocked` and move on —
  do not fight it or use a paid unblocker.

## 3. Capture the opt-out requirement per site
For each real listing, record what removal actually costs the owner:
- the exact opt-out URL,
- what it demands: email confirmation / phone code / **ID upload** / **payment** / account,
- whether it's self-serve or needs a mailed/emailed request.
ID-upload and paid removals are high-friction — flag them so the owner can decide which
are worth it.

## 4. Stage as ONE decision, not many
Append a dated table to the Privacy log: `site | listed? | opt-out link | requirement | status`.
Then post **one** question on the privacy board card listing the sites found and their
requirements, asking which to proceed with — answerable in one pass. Do not open a
separate card per site (that's the dopamine-draining spam the system exists to avoid).

## 5. On the owner's yes
Submit only the sites they approved, only by the self-serve path. Anything needing an ID
upload, a payment, or the owner's own account login → hand back the exact link and steps;
that's theirs to do, not yours. Update each row's status (`submitted`, `pending`,
`removed`, `needs-owner`). Never store the owner's ID images or card details.
