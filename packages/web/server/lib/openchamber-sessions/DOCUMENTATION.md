# Session dispatch

## Ownership

The session service owns native creation, prompt dispatch, fork inheritance,
selection, archive restoration and partial identity reporting. The control service
owns action validation and result registration. The workspace admission adapter
checks direct native invocations and task/project association. Git worktree
operations remain in the existing Git owner.

## Invariants

Without a workspace adapter, dispatch retains ordinary native behavior. With one,
create/send/fork receive their verified association through internal service
options. Model parameters and HTTP JSON cannot construct that object.

Send verifies the actual native target. Fork uses a stable fresh session ID and
verifies project, local canonical directory, source session and exact native
boundary. An omitted boundary selects the native through-history boundary; retries
retain the saved fork. Copied native session metadata and histories stay intact.
They cannot authenticate the fresh fork's dispatch prompt.

Current signed prompt IDs use native first-wins admission. The owner rechecks
current authority immediately before admission and verifies the saved prompt and
target afterward. Lost prompt or fork acknowledgements reconcile only verified
native facts. Failure preserves retained native sessions and useful history.
An uncertain fork acknowledgement/readback returns the expected session ID and
directory with `session-association-unverified`, so the caller can inspect or retry
that retained identity without claiming successful association.

For a verified text-prompt dispatch, result registration recovers the idle before
the stable native submission. A completed first-wins prompt can outlive a failed
initial registration; using the retry's latest idle would exclude its answer.
Inbox-first readback preserves the captured baseline while the input is pending.
Otherwise, native paginated history supplies the preceding idle or confirms none.
Recovery read failures remain failures. The existing result owner preserves any
already persisted registration and requires no additional state. Command dispatch
uses its native operation-start marker for that command's preceding boundary.
The text-prompt recovery algorithm is unchanged.

Managed commands authenticate the native operation's deterministic internal start
and completion records against the signed initiating workspace. The completion
workspace is checked as the exact native producer transformation, not as a new
signature. Replays read that original operation before catalog reclassification
or command effects. An unfinished operation remains uncertain.

Command completion is separate from a model answer. Ordinary templates and Goal
kickoff/resume retain native model input. Pause and clear have none. A template
child is bound by the existing native operation-owner lookup plus its parent,
project, directory and original root prompt. Its parent's proof is never resealed
for the child. Goal continuations belong to the authorized task and carry ordinary
requester context and an automation label. They need no fresh human proof.
Create, send and fork share these verified admission and replay capabilities.
Create retains its original signed association and forwards the same command
verification to dispatch. Its fresh command result uses an explicit empty idle
baseline, including after an initial registration failure.

Goal resume transforms the workspace into automation and keeps the existing goal
ID. The completed command's native root input ID binds that synthetic to its task;
matching its metadata to the initiating human proof would misreport a real resume
as having no input. Result delivery uses the resumed input's own answer window.

## Decisions

### Why dispatch authority lives on the current prompt

A retained session can receive independent requests. Its original creation cannot
authorize those sends, and native fork metadata is copied history. The existing
prompt metadata and pending-result source tuple bind each new operation without
another attribution store, tool or completion ledger.

Human ingress remains authenticated by the workspace gateway. Dispatch metadata
identifies automation and the requester where available. Historical contributor
membership does not veto a task result or continuation; removal uses owner-run
shutdown and pending-work inspection. Copied/imported output is never a new human
publication request. Goal briefings do not copy or reseal a human admission proof.

### Why commands use native operation records

Native commands can admit a synthetic, create a child, or complete without input.
Their existing internal operation records establish completion and replay without
changing those effects. User-only admission would report failure after the effect;
accepting arbitrary synthetic input would lose its initiating source.
