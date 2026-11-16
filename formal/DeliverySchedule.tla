--------------------------- MODULE DeliverySchedule ---------------------------
(*
  Internal delivery scheduling: durable revision, reminder claim, and crash
  recovery. A state transition corresponds to one durable operation in the
  repository/scheduler boundary. APNs and agent wakes remain outside the model:
  they may carry a committed delivery, but may never alter schedule truth.

  Fixed = FALSE models the unsafe order: an old reminder may be delivered after
  a reschedule. Fixed = TRUE models the repository contract: schedule mutation
  cancels obsolete pending/claimed reminders, and delivery rechecks current
  revision and terminal state while holding the reminder lease.
*)
EXTENDS Integers

CONSTANTS Fixed, MaxRevision

ScheduleStates == {"none", "planned", "completed", "cancelled", "archived"}
ReminderStates == {"none", "pending", "claimed", "delivered", "cancelled"}
Terminal == {"completed", "cancelled", "archived"}

VARIABLES scheduleStatus, revision, reminderStatus, reminderRevision, crashed, badDelivery

vars == <<scheduleStatus, revision, reminderStatus, reminderRevision, crashed, badDelivery>>

Init ==
  /\ scheduleStatus = "none"
  /\ revision = 0
  /\ reminderStatus = "none"
  /\ reminderRevision = 0
  /\ crashed = FALSE
  /\ badDelivery = FALSE

Create ==
  /\ scheduleStatus = "none"
  /\ scheduleStatus' = "planned"
  /\ revision' = 1
  /\ reminderStatus' = "none"
  /\ reminderRevision' = 0
  /\ UNCHANGED <<crashed, badDelivery>>

Generate ==
  /\ ~crashed /\ scheduleStatus = "planned" /\ reminderStatus = "none"
  /\ reminderStatus' = "pending"
  /\ reminderRevision' = revision
  /\ UNCHANGED <<scheduleStatus, revision, crashed, badDelivery>>

Reschedule ==
  /\ ~crashed /\ scheduleStatus = "planned" /\ reminderStatus # "delivered"
  /\ revision < MaxRevision
  /\ revision' = revision + 1
  /\ reminderStatus' = IF Fixed /\ reminderStatus \in {"pending", "claimed"}
                        THEN "cancelled" ELSE reminderStatus
  /\ UNCHANGED <<scheduleStatus, reminderRevision, crashed, badDelivery>>

Complete ==
  /\ ~crashed /\ scheduleStatus = "planned"
  /\ scheduleStatus' = "completed"
  /\ reminderStatus' = IF Fixed /\ reminderStatus \in {"pending", "claimed"}
                        THEN "cancelled" ELSE reminderStatus
  /\ UNCHANGED <<revision, reminderRevision, crashed, badDelivery>>

Claim ==
  /\ ~crashed /\ reminderStatus = "pending"
  /\ reminderStatus' = "claimed"
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, crashed, badDelivery>>

Deliver ==
  /\ ~crashed /\ reminderStatus = "claimed"
  /\ IF Fixed THEN /\ reminderRevision = revision /\ scheduleStatus \notin Terminal ELSE TRUE
  /\ reminderStatus' = "delivered"
  /\ badDelivery' = IF (reminderRevision # revision) \/ (scheduleStatus \in Terminal)
                     THEN TRUE ELSE badDelivery
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, crashed>>

Crash ==
  /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED <<scheduleStatus, revision, reminderStatus, reminderRevision, badDelivery>>

RecoverClaim ==
  /\ crashed
  /\ crashed' = FALSE
  /\ reminderStatus' = IF reminderStatus = "claimed" THEN "pending" ELSE reminderStatus
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, badDelivery>>

Next == Create \/ Generate \/ Reschedule \/ Complete \/ Claim \/ Deliver \/ Crash \/ RecoverClaim
Spec == Init /\ [][Next]_vars

TypeOK == /\ scheduleStatus \in ScheduleStates
          /\ reminderStatus \in ReminderStates
          /\ revision \in Nat
          /\ reminderRevision \in Nat
          /\ crashed \in BOOLEAN
          /\ badDelivery \in BOOLEAN

NoStaleOrTerminalDelivery == ~badDelivery
=============================================================================
