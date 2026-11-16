--------------------------- MODULE DeliverySchedule ---------------------------
(*
  Revision-bound delivery dispatch with bounded transient retry and agent gates.

  A state transition corresponds to one durable operation between yield points:
  schedule mutation, reminder materialization/claim, dispatch outcome, or lease
  recovery. A delivery is only an advisory accepted for dispatch: it never
  changes delivery-schedule truth. Fixed = FALSE preserves the old unsafe order
  where stale rows and closed agent gates can dispatch; Fixed = TRUE models the
  repository/scheduler contract.
*)
EXTENDS Integers

CONSTANTS Fixed, MaxRevision, MaxAttempts

ScheduleStates == {"none", "planned", "completed", "cancelled", "archived"}
ReminderStates == {"none", "pending", "claimed", "delivered", "suppressed", "cancelled", "failed"}
Recipients == {"none", "owner", "agent"}
Terminal == {"completed", "cancelled", "archived"}

VARIABLES scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
          attempts, crashed, automation, harmanMode, wakeCount, badDelivery, badWake

vars == <<scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
          attempts, crashed, automation, harmanMode, wakeCount, badDelivery, badWake>>

Init ==
  /\ scheduleStatus = "none"
  /\ revision = 0
  /\ reminderStatus = "none"
  /\ reminderRevision = 0
  /\ recipient = "none"
  /\ attempts = 0
  /\ crashed = FALSE
  /\ automation = TRUE
  /\ harmanMode = TRUE
  /\ wakeCount = 0
  /\ badDelivery = FALSE
  /\ badWake = FALSE

Create ==
  /\ scheduleStatus = "none"
  /\ scheduleStatus' = "planned"
  /\ revision' = 1
  /\ reminderStatus' = "none"
  /\ reminderRevision' = 0
  /\ recipient' = "none"
  /\ attempts' = 0
  /\ UNCHANGED <<crashed, automation, harmanMode, wakeCount, badDelivery, badWake>>

GenerateOwner ==
  /\ ~crashed /\ scheduleStatus = "planned" /\ reminderStatus = "none"
  /\ reminderStatus' = "pending"
  /\ reminderRevision' = revision
  /\ recipient' = "owner"
  /\ UNCHANGED <<scheduleStatus, revision, attempts, crashed, automation, harmanMode,
                wakeCount, badDelivery, badWake>>

GenerateAgent ==
  /\ ~crashed /\ scheduleStatus = "planned" /\ reminderStatus = "none"
  /\ reminderStatus' = "pending"
  /\ reminderRevision' = revision
  /\ recipient' = "agent"
  /\ UNCHANGED <<scheduleStatus, revision, attempts, crashed, automation, harmanMode,
                wakeCount, badDelivery, badWake>>

Reschedule ==
  /\ ~crashed /\ scheduleStatus = "planned" /\ reminderStatus # "delivered"
  /\ revision < MaxRevision
  /\ revision' = revision + 1
  /\ reminderStatus' = IF Fixed /\ reminderStatus \in {"pending", "claimed"}
                        THEN "cancelled" ELSE reminderStatus
  /\ UNCHANGED <<scheduleStatus, reminderRevision, recipient, attempts, crashed,
                automation, harmanMode, wakeCount, badDelivery, badWake>>

Complete ==
  /\ ~crashed /\ scheduleStatus = "planned"
  /\ scheduleStatus' = "completed"
  /\ reminderStatus' = IF Fixed /\ reminderStatus \in {"pending", "claimed"}
                        THEN "cancelled" ELSE reminderStatus
  /\ UNCHANGED <<revision, reminderRevision, recipient, attempts, crashed,
                automation, harmanMode, wakeCount, badDelivery, badWake>>

Claim ==
  /\ ~crashed /\ reminderStatus = "pending" /\ attempts < MaxAttempts
  /\ reminderStatus' = "claimed"
  /\ attempts' = attempts + 1
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, recipient, crashed,
                automation, harmanMode, wakeCount, badDelivery, badWake>>

TransientFailure ==
  /\ ~crashed /\ reminderStatus = "claimed"
  /\ reminderStatus' = IF attempts >= MaxAttempts THEN "failed" ELSE "pending"
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, recipient, attempts,
                crashed, automation, harmanMode, wakeCount, badDelivery, badWake>>

SuppressAgent ==
  /\ ~crashed /\ reminderStatus = "claimed" /\ recipient = "agent"
  /\ ~(automation /\ harmanMode)
  /\ reminderStatus' = "suppressed"
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, recipient, attempts,
                crashed, automation, harmanMode, wakeCount, badDelivery, badWake>>

Deliver ==
  /\ ~crashed /\ reminderStatus = "claimed"
  /\ IF Fixed THEN /\ reminderRevision = revision /\ scheduleStatus \notin Terminal
                  /\ (recipient # "agent" \/ (automation /\ harmanMode))
     ELSE TRUE
  /\ reminderStatus' = "delivered"
  /\ wakeCount' = IF recipient = "agent" THEN wakeCount + 1 ELSE wakeCount
  /\ badDelivery' = IF (reminderRevision # revision) \/ (scheduleStatus \in Terminal)
                     THEN TRUE ELSE badDelivery
  /\ badWake' = IF recipient = "agent" /\ ~(automation /\ harmanMode)
                THEN TRUE ELSE badWake
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, recipient, attempts,
                crashed, automation, harmanMode>>

Crash ==
  /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED <<scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
                attempts, automation, harmanMode, wakeCount, badDelivery, badWake>>

RecoverClaim ==
  /\ crashed
  /\ crashed' = FALSE
  /\ reminderStatus' = IF reminderStatus = "claimed"
                         THEN IF Fixed /\ (reminderRevision # revision \/ scheduleStatus \in Terminal)
                              THEN "cancelled" ELSE "pending"
                         ELSE reminderStatus
  /\ UNCHANGED <<scheduleStatus, revision, reminderRevision, recipient, attempts,
                automation, harmanMode, wakeCount, badDelivery, badWake>>

DisableAutomation ==
  /\ automation
  /\ automation' = FALSE
  /\ UNCHANGED <<scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
                attempts, crashed, harmanMode, wakeCount, badDelivery, badWake>>

EnableAutomation ==
  /\ ~automation
  /\ automation' = TRUE
  /\ UNCHANGED <<scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
                attempts, crashed, harmanMode, wakeCount, badDelivery, badWake>>

DisableHarmanMode ==
  /\ harmanMode
  /\ harmanMode' = FALSE
  /\ UNCHANGED <<scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
                attempts, crashed, automation, wakeCount, badDelivery, badWake>>

EnableHarmanMode ==
  /\ ~harmanMode
  /\ harmanMode' = TRUE
  /\ UNCHANGED <<scheduleStatus, revision, reminderStatus, reminderRevision, recipient,
                attempts, crashed, automation, wakeCount, badDelivery, badWake>>

Next == Create \/ GenerateOwner \/ GenerateAgent \/ Reschedule \/ Complete \/ Claim \/
        TransientFailure \/ SuppressAgent \/ Deliver \/ Crash \/ RecoverClaim \/
        DisableAutomation \/ EnableAutomation \/ DisableHarmanMode \/ EnableHarmanMode
Spec == Init /\ [][Next]_vars

TypeOK == /\ scheduleStatus \in ScheduleStates
          /\ reminderStatus \in ReminderStates
          /\ recipient \in Recipients
          /\ revision \in Nat
          /\ reminderRevision \in Nat
          /\ attempts \in Nat
          /\ crashed \in BOOLEAN
          /\ automation \in BOOLEAN
          /\ harmanMode \in BOOLEAN
          /\ wakeCount \in Nat
          /\ badDelivery \in BOOLEAN
          /\ badWake \in BOOLEAN

NoStaleOrTerminalDelivery == ~badDelivery
NoAgentWakeWithClosedGate == ~badWake
AtMostOneCoalescedWake == wakeCount <= 1
=============================================================================
