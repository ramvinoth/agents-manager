------------------------------ MODULE Maintenance ------------------------------
(* The hourly maintenance restart window: orchestrator/maintenance.py.
   One action per step the real code takes between yield points; the oracle
   (tests/unit/test_maintenance_oracle.py) replays every edge of TLC's state
   graph against the real module, so this spec has to stay the code's twin.

   Fixed = FALSE models the code before 2026-11-10, Fixed = TRUE the code now.
   The three invariants at the bottom are what TLC found broken in the old shape. *)
EXTENDS Integers, FiniteSets

CONSTANTS N,         \* restart requests in play
          MaxEdits,  \* code edits on disk (agents commit while the window runs)
          MaxHour,   \* hours modelled; each opens one window
          MaxEpoch,  \* process boots modelled
          Fixed

Reqs == 1..N
PCs  == {"idle", "snap", "check", "verify", "mark", "pending", "exit"}

VARIABLES
  status,      \* request row status (Postgres restart_requests)
  filedEpoch,  \* boot epoch the request was filed in (created_at vs BOOT_TIME)
  disk,        \* code version on disk
  loaded,      \* code version the running process imported
  checked,     \* code version the last preflight saw
  up,          \* the server process is alive
  booting,     \* finish_after_boot has not completed yet
  finIds,      \* requests finish_after_boot read and will close (it sleeps first)
  finKind,     \* "none" | "window" | "outside" | "read" (read, nothing to close)
  finChecked,  \* preflighted version recorded in the pending record it read
  pc,          \* where the run_window thread is; "idle" = the lock is free
  ids,         \* the requests that window snapshotted
  pending,     \* settings maintenance_pending: [on, ids, checked]
  hour, lastKey,
  epoch,
  audit        \* the last maintenance_restart audit entry finish wrote

vars == <<status, filedEpoch, disk, loaded, checked, up, booting, finIds, finKind,
          finChecked, pc, ids, pending, hour, lastKey, epoch, audit>>

Queued == {r \in Reqs : status[r] = "queued"}
Set(f, S, v) == [r \in Reqs |-> IF r \in S THEN v ELSE f[r]]
NoPending == [on |-> FALSE, ids |-> {}, checked |-> 0]

Init ==
  /\ status = [r \in Reqs |-> "unfiled"]
  /\ filedEpoch = [r \in Reqs |-> 0]
  /\ disk = 0 /\ loaded = 0 /\ checked = 0
  /\ up = TRUE /\ booting = FALSE
  /\ finIds = {} /\ finKind = "none" /\ finChecked = 0
  /\ pc = "idle" /\ ids = {}
  /\ pending = NoPending
  /\ hour = 0 /\ lastKey = -1
  /\ epoch = 0
  /\ audit = [outcome |-> "none", loaded |-> 0, checked |-> 0]

\* ---- the world ---------------------------------------------------------
Edit == disk < MaxEdits /\ disk' = disk + 1
        /\ UNCHANGED <<status, filedEpoch, loaded, checked, up, booting, finIds, finKind,
                       finChecked, pc, ids, pending, hour, lastKey, epoch, audit>>

File(r) == up /\ status[r] = "unfiled"
           /\ status' = [status EXCEPT ![r] = "queued"]
           /\ filedEpoch' = [filedEpoch EXCEPT ![r] = epoch]
           /\ UNCHANGED <<disk, loaded, checked, up, booting, finIds, finKind, finChecked,
                          pc, ids, pending, hour, lastKey, epoch, audit>>

NewHour == hour < MaxHour /\ hour' = hour + 1
           /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, up, booting, finIds,
                          finKind, finChecked, pc, ids, pending, lastKey, epoch, audit>>

\* Any death: a crash, a reboot, the owner's kickstart. Threads die with it.
Crash == up /\ up' = FALSE /\ pc' = "idle" /\ booting' = FALSE
         /\ finIds' = {} /\ finKind' = "none"
         /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, finChecked, ids, pending,
                        hour, lastKey, epoch, audit>>

Boot == ~up /\ epoch < MaxEpoch
        /\ up' = TRUE /\ epoch' = epoch + 1 /\ loaded' = disk /\ booting' = TRUE
        /\ UNCHANGED <<status, filedEpoch, disk, checked, finIds, finKind, finChecked, pc,
                       ids, pending, hour, lastKey, audit>>

\* ---- finish_after_boot (its own thread, concurrent with the scheduler) ----
FinishRead ==
  /\ booting /\ finKind = "none"
  /\ IF pending.on
       \* Fixed: also close requests filed before this boot -- their code is loaded too
       THEN /\ finIds' = pending.ids \cup (IF Fixed THEN {r \in Queued : filedEpoch[r] < epoch} ELSE {})
            /\ finKind' = "window" /\ finChecked' = pending.checked
            \* Fixed: the record is cleared only once the rows are closed (FinishWrite)
            /\ pending' = (IF Fixed THEN pending ELSE NoPending)
       ELSE LET stale == {r \in Queued : filedEpoch[r] < epoch} IN
            /\ finIds' = stale /\ finKind' = (IF stale = {} THEN "read" ELSE "outside")
            /\ UNCHANGED <<finChecked, pending>>
  /\ booting' = (finKind' \in {"window", "outside"})    \* nothing to close: done now
  /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, up, pc, ids, hour, lastKey,
                 epoch, audit>>

FinishWrite ==
  /\ booting /\ finKind \in {"window", "outside"}
  /\ status' = Set(status, finIds, "done")
  /\ audit' = [outcome |-> IF finKind = "outside" THEN "outside"
                           ELSE IF Fixed /\ loaded # finChecked THEN "unpreflighted"
                           ELSE "restarted",
               loaded |-> loaded, checked |-> finChecked]
  /\ pending' = (IF Fixed /\ finKind = "window" THEN NoPending ELSE pending)
  /\ booting' = FALSE /\ finIds' = {} /\ finKind' = "none"
  /\ UNCHANGED <<filedEpoch, disk, loaded, checked, up, finChecked, pc, ids, hour,
                 lastKey, epoch>>

\* ---- tick + run_window (one thread, holds the lock while pc # "idle") ----
\* Fixed: finish_after_boot holds the same lock, so no window opens mid-boot.
Tick == up /\ pc = "idle" /\ lastKey # hour /\ (Fixed => ~booting)
        /\ lastKey' = hour
        /\ pc' = (IF Queued # {} THEN "snap" ELSE "idle")
        /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, up, booting, finIds,
                       finKind, finChecked, ids, pending, hour, epoch, audit>>

\* The thread re-reads the queue: a boot may have closed it since the tick.
Snap == up /\ pc = "snap" /\ ids' = Queued /\ pc' = (IF Queued = {} THEN "idle" ELSE "check")
        /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, up, booting, finIds,
                       finKind, finChecked, pending, hour, lastKey, epoch, audit>>

CheckFail == up /\ pc = "check" /\ checked' = disk
             /\ status' = Set(status, ids, "failed") /\ pc' = "idle"
             /\ UNCHANGED <<filedEpoch, disk, loaded, up, booting, finIds, finKind,
                            finChecked, ids, pending, hour, lastKey, epoch, audit>>

CheckPass == up /\ pc = "check" /\ checked' = disk
             /\ pc' = (IF Fixed THEN "verify" ELSE "mark")
             /\ UNCHANGED <<status, filedEpoch, disk, loaded, up, booting, finIds, finKind,
                            finChecked, ids, pending, hour, lastKey, epoch, audit>>

\* Fixed: the code moved during the preflight -> preflight again. The code gives
\* up (fails the requests) after 3 tries; MaxEdits < 3 keeps that branch out of the model.
Verify == up /\ pc = "verify"
          /\ pc' = (IF disk = checked THEN "pending" ELSE "check")
          /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, up, booting, finIds,
                         finKind, finChecked, ids, pending, hour, lastKey, epoch, audit>>

\* Old order: mark -> pending -> exit.  Fixed: pending -> mark -> exit.
WritePending == up /\ pc = "pending"
                /\ pending' = [on |-> TRUE, ids |-> ids, checked |-> checked]
                /\ pc' = (IF Fixed THEN "mark" ELSE "exit")
                /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, up, booting, finIds,
                               finKind, finChecked, ids, hour, lastKey, epoch, audit>>

Mark == up /\ pc = "mark"
        /\ status' = Set(status, ids, "restarting")
        /\ pc' = (IF Fixed THEN "exit" ELSE "pending")
        /\ UNCHANGED <<filedEpoch, disk, loaded, checked, up, booting, finIds, finKind,
                       finChecked, ids, pending, hour, lastKey, epoch, audit>>

Exit == up /\ pc = "exit" /\ up' = FALSE /\ pc' = "idle" /\ booting' = FALSE
        /\ finIds' = {} /\ finKind' = "none"
        /\ UNCHANGED <<status, filedEpoch, disk, loaded, checked, finChecked, ids, pending,
                       hour, lastKey, epoch, audit>>

Next == \/ Edit \/ NewHour \/ Crash \/ Boot \/ \E r \in Reqs : File(r)
        \/ FinishRead \/ FinishWrite
        \/ Tick \/ Snap \/ CheckFail \/ CheckPass \/ Verify \/ WritePending \/ Mark \/ Exit

Spec == Init /\ [][Next]_vars

\* ---- what must hold ----------------------------------------------------
TypeOK == pc \in PCs /\ status \in [Reqs -> {"unfiled", "queued", "restarting", "done", "failed"}]

\* 1. A request never sits in "restarting" once nothing is restarting it:
\*    no window in flight and boot finished. (Old: a death between marking the
\*    rows and writing the pending record stranded them forever.)
NoStrandedRestart ==
  (up /\ ~booting /\ pc = "idle") => \A r \in Reqs : status[r] # "restarting"

\* 2. The audit never says "restarted" (= the preflighted code is live) when the
\*    process booted other code. (Old: an edit landing mid-preflight booted unchecked.)
HonestAudit == audit.outcome = "restarted" => audit.loaded = audit.checked

\* 3. A window never restarts for a request that is already live (filed before
\*    this boot). (Old: a boot inside :50-:59 raced finish_after_boot's 5 s sleep.)
NoRedundantRestart ==
  pc \in {"check", "verify", "mark", "pending", "exit"} => \A r \in ids : filedEpoch[r] = epoch
=============================================================================
