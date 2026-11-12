# Formal models

`Maintenance.tla` models the hourly restart window (`orchestrator/maintenance.py`):
tick → preflight → record → mark → exit, the next boot's `finish_after_boot`, and
the world around it (agents editing code, filing requests, crashes, reboots).

`Fixed = FALSE` is the code before 2026-11-10, `Fixed = TRUE` the code now.
TLC finds three bugs in the old order, and the fix passes:

| Invariant | Old code's counterexample |
|---|---|
| NoStrandedRestart | death between marking rows "restarting" and writing the pending record strands them forever |
| HonestAudit | an edit during the preflight boots unchecked code, but the audit says "restarted" |
| NoRedundantRestart | a boot inside :50–:59 lets the first tick restart again for requests this boot already made live |

## Run TLC

TLC needs `tla2tools.jar` (github.com/tlaplus/tlaplus releases) and Java 11+.

```bash
J=~/.local/share/tla/tla2tools.jar
cd formal
java -XX:+UseParallelGC -cp $J tlc2.TLC -workers auto -config Original.cfg -metadir /tmp/tlc-o Maintenance.tla  # violation + trace
java -XX:+UseParallelGC -cp $J tlc2.TLC -workers auto -config Fixed.cfg    -metadir /tmp/tlc-f Maintenance.tla  # No error (~32k states)
```

## The oracle (spec ⇄ code)

`tests/unit/test_maintenance_oracle.py` dumps the full state graph and takes random
walks through it. It drives the real module through each step, with its threads parked
at the call that starts each step, and asserts the real state equals the spec state.
A mismatch means the spec no longer describes the code. Update both together.
It skips without java and the jar. `ORACLE_WALKS` and `ORACLE_SEED` tune it.
