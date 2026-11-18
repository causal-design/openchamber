# Dispatch Results

## Purpose

Delivers the result of a session an agent dispatched with `returnResult` back
into the session that dispatched it, and wakes that session. The agent's
`session.create`, `session.send` or `session.fork` call returns at once; when
the dispatched session's turn ends, its final answer arrives as a synthetic
message and the agent continues on its own. This is OpenCode 2's background
subagent report (core `session/subagent-completion.ts`) for primary sessions
the user can also follow and talk to.

It replaces the agent tool's blocking `wait`: a blocked tool call held the
agent's whole turn open for up to ten minutes. The CLI keeps `--wait`, since a
terminal has no session to deliver into.

## Files

- `runtime.js` — `createDispatchResultsRuntime(...)`: pending entries,
  persistence, the delivery loop, event handling; plus the pure
  `readDispatchOutcome` and `buildDispatchResultMessage`. Workflow runs
  (`../workflows`) reuse `readDispatchOutcome` to tell when an agent's turn
  ended, and `createMessageId` and `escapeAttribute` for their report.
  Auto-review (`../auto-review`) reads each step's end with
  `readDispatchOutcome(..., { withText: true })`, which takes the text from
  the newest reply of the turn that has any, and mints its ids with
  `createMessageId`.
- `runtime.test.js` — delivery, waiting on running sessions and subagents,
  archived and deleted parents, a deleted dispatched session, idempotent
  retries, one result for several sends into one run, unknown versus idle,
  restart, a corrupt file.

Wiring: created in `server/index.js` after the message queue, handed to the
control service as `dispatchResults`, stopped by
`opencode/shutdown-runtime.js`. The control service registers an entry after a
dispatch whose prompt landed (`promptDispatched: true`); the calling session
comes from the agent tool (`contextSessionId`).

## Entry and persistence

`{ id, parentSessionId, sessionId, dispatchedAt, afterIdleId?, messageId?, source? }` in
`<data-dir>/dispatch-results.json`, written atomically through a serialized
write chain, owner-readable only. A new `register` resolves once the entry is on
disk, so a restart right after the tool answers still delivers; when the write
fails it rejects and drops the entry, and the tool tells the agent no result is
coming. A failed write leaves the chain running for the next one. A missing file
is nothing pending; a file that is not JSON or has no `entries` array is moved
aside as `dispatch-results.json.corrupt-<timestamp>`; a failed read keeps writes off
until a load succeeds; one malformed entry is dropped alone. At most 200
entries, oldest dropped with a warning.

Timers, retry counts and the in-flight guard are memory only: after a restart
`start()` re-arms every watched session from a fresh tick.
`stop()` closes timer admission synchronously and returns a promise joining the
load, in-flight managed registrations, delivery ticks and queued writes. Shutdown
and fixtures await it before flushing writes or removing owned data.

### Why state changes share the write chain

Registration insertion, message-ID minting and delivery removal run inside the
existing serialized write owner. Each operation changes memory, captures its
snapshot and completes its write or failure rollback before the next operation
starts. Capturing snapshots when writes are queued can persist an entry whose
initial write later rejects. Queuing only snapshot capture can also include a
later registration before its own write succeeds.

A failed initial write removes the new entry and rejects its callers. A failed
message-ID write removes the unsaved ID and prevents delivery. Successful native
delivery followed by failed removal persistence still leaves the entry removed
in memory and recoverable from the older disk snapshot. Managed recovery verifies
the original native result before completing removal.

Parent deletion removes visible entries synchronously and repeats that removal in
write order, covering registrations queued before the event. Its write waits for
successful hydration so unrelated saved entries survive an event during startup.
A failed deletion write retains the in-memory removal for the next snapshot.
Delivery skips an entry removed while waiting to persist its message ID.

## Workspace result attribution

When `PEIRCE_ADMISSION_HELPERS` is configured, the existing result record also
keeps `source: { sessionID, messageID, callID, submissionID }`. The control service
copies this identity-only reference from the internally verified current dispatch.
The record stores no login, human-attribution snapshot or separate history.
The workspace adapter is an explicit dependency, defaulting to that configured
module. Servers without it retain ordinary result delivery.

Before admitting a managed result, the adapter checks the saved helper association,
native ID, local canonical location, project and parent operation. It re-reads the
original direct invocation, requires its `returnResult` request, and reuses helper
association readback. The record's source and parent must match that association.
Path changes, foreign bindings and uncertain reads retain the pending entry.

Results and Goal continuations belong to the authorized task. Result metadata
contains the automation sender, ordinary requester context where available, project
and result binding. There is no signed aggregate human proof or recursive
current-membership check of historical contributors. Later human messages retain
their own identity in native history. Automatic input can continue the task and
delegate again; it cannot establish a new human publication request. Human ingress
remains authenticated separately. Removal uses the owner's shutdown and pending-work
inspection procedure.

### Why result attribution uses the saved helper and existing record

Create's native session metadata and send/fork's current prompt metadata authenticate
their own parent invocation and canonical scope. The result record owns the retry identity and destination.
Reading those facts at delivery avoids another attribution store.
Later sends can share the same parent/helper pair, so that pair alone cannot
identify the dispatch that registered an entry. Capturing its source reference in
the existing record prevents an unbound later dispatch from borrowing the helper's
earlier creation authority. A missing source is never inferred from matching IDs.

### Why managed delivery reads back native admission

Native first-wins storage can acknowledge a retry while retaining earlier metadata,
or reject an ID used for another type/session. A managed delivery checks the saved
synthetic in history or inbox against the task binding and automation label before
removing its entry. A genuine earlier result after a lost acknowledgement retains
its original metadata and text. A conflicting task binding or uncertain read leaves
history and the pending entry intact. Metadata is ordinary shared attribution; it
does not authenticate the producer of arbitrary imported or synthetic output.
Readback also rereads the actual parent and helper sessions. It checks their IDs,
native projects and local locations, then reuses saved-helper verification and
original-invocation authorization. Canonical path reads precede the final current
project-scope check. A move or operation mismatch keeps the pending record even when the
POST already admitted its first-wins content. These separate HTTP reads do not
make admission and session moves atomic and never rewrite native history.

Managed registration requires the verified current invocation source.
Unbound registrations report `not-scheduled`; older unbound records
and records with unreadable source attribution remain pending for inspection.
They are never inferred from plain metadata. A deleted helper whose saved binding
cannot be read likewise stays pending. No-adapter registration, retries, deleted
session reporting and delivered-result reconciliation retain their prior behavior.
An authoritative parent-deletion event still removes entries for that parent.

### Why managed retries reuse the original registration

The exact parent/helper/source tuple identifies one logical result. A repeat
registration keeps the existing pending record ID, message ID, first dispatch time
and idle baseline. It does not reset failure/settle accounting or an existing timer.
Concurrent registrations for that tuple join one in-flight promise through native
lookup and persistence. A failed first write rejects all joined callers and releases
the claim; retry can then persist one record. The in-flight map holds no completion
history or authority cache. Different source tuples remain separate even when the
parent/helper pair matches. Unbound or malformed stored sources are never inferred
from that pair and cannot capture another registration.

After pending deletion, native inbox/history is the completion record. Registration
reads the inbox before paginated history so promotion cannot move an existing
result past both reads. It considers matching task-bound automatic results, then
invokes the existing source derivation and native readback verifier. The original
record/message IDs and metadata are preserved, including legacy random IDs and
older signed records. A matching native result returns the original registration
ID without adding pending work or posting another result. Delivery uses the same
lookup, so a lost acknowledgement or a restored duplicate pending record can reconcile
without a second admission. The first native text, attribution and resume decision
are never rewritten.

Pending matching reconciles identity only and grants no delivery authority. The
actual callback still checks its original invocation and task scope. Incomplete
result-shaped context supplies no prior success. A conflicting binding, failed
native read or incomplete pagination is uncertainty,
not an empty history that permits a replacement registration. A later valid match
can reconcile despite an earlier invalid claim for the same tuple; otherwise the
verification failure is returned. Source-mismatched claims remain unrelated context.

No completion ledger or persisted format is added. The control service already
passes the full source tuple and keeps its existing callback result contract.
Servers without the workspace adapter keep independent registration IDs per call
and their existing delivery behavior.

Managed send/fork commands use their native internal operation records to reconcile
the exact dispatch and replay command effects. The start retains the saved workspace;
completion matches the native transformation and deterministic IDs. This check is
limited to the dispatched command. Later commands, child notifications and Goal
continuations need no individual human proof to coexist with its result. Command
completion is separate from an idle or model final answer.

For a command template's new child, the existing native operation-owner lookup
binds the root input ID to the actual child. The original command target, signed
source, native parent, project and directory are rechecked at registration and
delivery. Only that root input uses the command's producer proof; later child
admissions retain their native attribution. The original signature stays bound to
the command target. The existing result record watches the child with its empty
initial idle baseline and retains the initiating source tuple. Native child jobs
and notifications are unchanged. Commands without native model input do
not register an answer promise.

For a verified managed dispatch, source derivation supplies native history from
its consumed input through its first idle as an ephemeral answer window.
The existing outcome reader selects its idle and answer from that window. An earlier execution
can end while a command prepares input; that earlier idle cannot complete the
new command. A later command cannot replace the earlier answer. History reads stop
at that first idle without scanning subsequent contributors. No idle after the input
leaves the result pending. This does not
change the stored baseline or add history to the result record. The public
outcome-reader API and no-adapter path are unchanged.

## When the turn is over

Event-driven like `../message-queue`: `session.status` idle for a watched
session arms a 500 ms quiet timer, busy clears it, a hub reconnect and startup
re-arm everything. `register` arms once too, because a short turn can end
before its entry exists. The tick then asks OpenCode, and unknown is never
"over":

1. `/api/session/active` lists it → running; its next idle event re-arms.
2. A subagent of it runs → not over: the session runs again on the subagent's
   result. Rechecked after 5 s (`../opencode/session-activity.js`).
3. The newest page of its records (`order: desc`, 50): OpenCode appends an
   `idle` record with `outcome` (`succeeded`, `failed`, `interrupted`) when a
   run ends. The dispatch route reads the newest one before the prompt goes
   out (`afterIdleId`, null when the session has none); a newer idle record
   ends the dispatched turn, and the answer is the newest assistant reply
   between the two. Matching by record order keeps OpenChamber's clock out of
   it, so a remote OpenCode whose clock lags still matches; only an entry
   stored without the baseline compares `time.created` with `dispatchedAt`.
   No newer record yet → not over; three 2 s rechecks cover a record trailing
   its event, then events take over. A `session.send` into a session that is
   already running can end on that running turn when OpenCode steers the
   prompt into it; that turn's answer then includes the prompt's work.
4. The session itself answers 404 → it was deleted; reported as stopped.

A failed read retries with backoff (2 s doubling to 60 s).

### Why delivery refusal is isolated per record

The session's observation and retry timer are shared across its result records.
An unbound legacy record or malformed source may refuse permanently; later eligible
records still get an attempt using that observation. Refusal preserves the record
and persisted message ID. Any failed delivery advances the shared retry count once
for that tick, even when another record succeeds. ID-mint and removal persistence
failures still abort the batch through the existing failure path. A storage failure
does not become a successful delivery or permit sending with an unsaved ID.

## Delivery

`POST /api/session/:parent/synthetic` with
`{ id, text, description, metadata, delivery: 'steer', resume }`:

- `text`: `<openchamber-session sessionID="…" state="…" title="…">answer</openchamber-session>`,
  the answer cut at 50 000 characters with a pointer to `session.messages`.
  A failure or stop says so ("The session failed: …", "stopped before it
  finished") and keeps any last reply; an empty completed answer says it had
  no text, never silence.
- `metadata`: `{ source: 'openchamber-session', sessionID, state, title? }`,
  `state` one of `completed`, `error`, `cancelled`. The UI reads it in
  `packages/ui/src/lib/opencode/dispatched-session.ts` and renders a compact
  "Session finished: <title>" row that opens to the answer.
- `delivery: 'steer'`: a parent that is busy reads it at its next step, the
  way OpenCode delivers a subagent report; an idle one is woken by `resume`.
  A parent waiting on a page or a secret card reads it right after the user's
  answer, and the chat shows the row only then (`../openchamber-control/`,
  *Why a background message waits behind a page*).
- `resume: false` for an archived parent: the answer is recorded, nothing
  runs behind the user's back. A failed archive lookup counts as not archived
  and wakes the parent: the agent asked for this result.
- `id`: minted in OpenCode's `msg_` format at the first attempt and persisted
  before it; when that write fails the attempt waits for the next retry. OpenCode refuses a second admission of the same id (409), so a
  retry after a crash or a lost response cannot deliver twice; 409 counts as
   delivered on a no-adapter server. Managed delivery requires task-bound native
  readback as described above. On a no-adapter server, 404 means the parent is gone
  and the entry is dropped. A deleted
  parent's entries also go on its `session.deleted` event.

## One result per run and parent

Every entry ready in a tick reads the same newest run, so entries of one
parent that are still without an id share one minted id and one delivery,
then all go. A parent that sends several prompts into a running session hears
back once, with the run that took them all. Another parent watching the same
session gets its own result. An entry that already holds an id from an earlier
attempt keeps it and delivers alone.

### Why one shared result and not one receipt per send

The prompts steer into one run, which produces one answer; a receipt per send
put the same answer into the parent's context once per prompt (eight times in
#6109).

### Why an entry with an id is never grouped

Its id may already have landed with an earlier run whose response was lost.
Grouping a newer entry under that id would make OpenCode answer 409 for the
newer run, and its result would be dropped as delivered.

## Runtime parity

Web and desktop with a managed OpenCode: active (the agent tool exists only
there). VS Code and external OpenCode: the agent tool is not injected, so no
entry is ever registered. Mobile clients see the delivered message through the
server they are connected to.
