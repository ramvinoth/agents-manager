---
name: attribute-before-alerting
description: Decide whether a security/privacy event (new login, password reset, breach notice, broker listing) is the owner's own action or a real threat BEFORE raising it. Use on every finding during a privacy or security sweep, so the owner only sees alerts that need their judgment.
---

# Attribute before alerting

A new login or reset is usually the owner, not an attacker. Raising every one trains
the owner to ignore you — the opposite of the job. Classify first, alert only on what
survives.

1. **Pull the evidence, not the headline.** Read the full mail (`mcp__viewer__gmail_read`)
   or listing, not just the subject. Note timestamp, location/IP, device, and service.
2. **Match against the owner's own footprint:**
   - Time: does it line up with when the owner is active? A 3am login from another
     country is different from a 2pm one from their city.
   - Device/location: compare to what you've seen before in the log.
   - Correlate: a "password changed" right after a "reset requested" the owner likely
     did themselves is one event, not two threats.
3. **Three buckets:**
   - **Self** — matches the owner's footprint. Log one line, do not alert.
   - **Benign-third-party** — a service's routine notice (newsletter, policy update)
     with no account action. Log, do not alert.
   - **Needs-decision** — unexplained access, a breach exposing a credential in use,
     or a listing the owner didn't place. This is what goes on the board card.
4. **When unsure, ask — don't guess either way.** Post ONE yes/no question on the
   privacy board card: "Did you sign in from <place> at <time>? (If not, I'll walk you
   through locking the account.)" Guessing "self" hides a real breach; guessing "threat"
   cries wolf. The owner's one-tap answer is cheap; a wrong silent call is not.
5. **Never paste the raw personal data** (full address, SSN, card, password) into the
   card or log — refer to it ("the home address on file", "the card ending 41").
6. Label the finding **VERIFIED** (you read the evidence) or **HYPOTHESIS** (inferred).
