# Terminal Subsystem

## Ownership

`runtime.js` owns terminal identity, PTY processes, launch mode, session purpose, ordered output, bounded scrollback, WebSocket attachments, and lifecycle routes. `shutdown.js` owns bounded runtime-wide process cleanup. `shells.js` discovers executable shell families, resolves the persisted shell ID, and builds the per-shell argv for interactive versus command launches. Clients own tab arrangement. Interactive terminals use stable IDs; project actions keep a stable UI tab and allocate a fresh terminal ID for each command execution. Electron uses this same runtime in-process; VS Code returns an explicit unsupported error.

### Member-terminal boundary

Peirce configures `PEIRCE_TERMINAL_CONTEXT_HELPERS` with the installed
`integration/browser/terminal-context.mjs` module. Its loader requires an absolute
`PEIRCE_ROOT` and the service-only admission key. Configuration or key failure
stops startup. Every terminal HTTP request and WebSocket upgrade authenticates
the signed creator context before registry access. The signature binds the
member ID, stable account ID, method, pathname, optional authorized directory,
and a 30-second expiry. The account ID is the verified GitHub identity; native
Unix binding validation belongs to the member launcher.

Pending creates, running sessions and retained exited records have the same
immutable creator pair. Action reuse, supersession and directory cleanup include
that pair. Member listings contain only owned records and an owned `pending`
array for gateway cancellation authorization. Standalone listings keep their
existing response shape. Foreign IDs have the same missing-session response as
unknown IDs for controls and attachment. Input checks ownership even without an
attachment, because project-action Stop sends Ctrl-C without opening the pane.
Output attachments carry a process generation; replacement through create
retires them, while an explicit same-owner restart advances them and emits the
native `restarted` transition.

Member create and restart call the injected `spawnMemberTerminal` before local
provider loading, host environment setup or shell resolution. This callback
receives the authenticated creator and the validated launch options and must
return the native PTY result shape. Without it, member launch fails with
`Member terminal launcher unavailable`. Server startup supplies the installed
`PEIRCE_MEMBER_PTY_HELPERS` adapter in the trusted main process. It obtains
bounded setup data from `environmentRuntime.forMemberTerminal` and waits for
member-side setup success. Member shell discovery lists only Bash with login
mode disabled. Remote lifetime operations await the adapter's `terminate()`;
`kill()` only initiates stop and the adapter exposes no local PID. Unknown exit
events and rejected closure retain an unavailable creator-owned record. That ID
and any matching project action cannot be reused in this runtime. Source wiring
alone does not establish native or installed acceptance.
Requests carrying member context against an unconfigured standalone runtime
are rejected. Header-free standalone clients retain local PTY behavior.

## Protocol

`/api/terminal/ws` is the only terminal data transport. It uses v3 binary JSON control frames and is opened through `openRuntimeWebSocket`, preserving direct, Electron proxy, URL-token authentication, and private-relay routing.

- `attach` registers a connection for one terminal. One socket may attach to many terminals.
- Every attach and reconnect begins with an authoritative `snapshot` containing bounded history, the current sequence, and the PTY `cols`/`rows` the history was drawn for. The client replays the history at that size before fitting its viewport; replaying shell output at another width leaves stray fragments that the shell's own SIGWINCH redraw never clears. An attach sent with `z: 1` gets that snapshot as a `0x02` frame, the same JSON gzipped, when it is 4 KiB or more; every other frame stays `0x01` JSON. The client asks only where `DecompressionStream` exists, applies frames in arrival order while one is being gunzipped, and after a failed gunzip reconnects and attaches without `z`.
- A current socket that closes or errors before its initial `open` invalidates its URL-scoped auth token before retrying, so retries mint a fresh token instead of backing off against a rejected upgrade. Hidden or offline clients wait 60 seconds and wake promptly on visibility/online recovery.
- `output`, `exit`, and `restarted` carry monotonically increasing per-terminal sequences. PTY output arriving within 12 ms is joined into one output frame; reaching 32,768 UTF-16 code units flushes the batch immediately. Output carries the unchanged raw stream plus replay-safe text with terminal query exchanges removed. Pending output flushes before exit, restart, close, force-kill, and attach snapshots, so the snapshot sequence covers its history. A socket is terminated when its next frame would exceed 4 MiB of queued data. Reconnect starts with a fresh snapshot of the latest 512 KiB; output older than that may be unavailable to the disconnected client.
- Attach registers before capturing the snapshot, buffers concurrent events, drops events represented by the snapshot sequence, then enters live delivery.
- `write` always includes the terminal ID; sockets never have mutable single-terminal binding state.
- `detach` removes only that attachment.
- Creation carries the active UI appearance. The PTY sets `COLORFGBG` and answers OSC 10, OSC 11, Mode 2031, and primary-device-attribute queries immediately, including queries emitted before a WebSocket attachment exists. The DA1 fallback prevents Fish from waiting ten seconds for a renderer that cannot observe or answer its startup query. Subscribed TUIs receive a Mode 2031 notification when the appearance changes.

HTTP remains the authenticated command plane for create, resize, appearance updates, restart, close, and force-kill. There is no SSE output or HTTP input compatibility path.

`GET /api/terminal/sessions` enumerates live sessions (optionally filtered by resolved `cwd`) so clients can adopt terminals their local tab projection does not know about — another device, a new browser tab, or cleared storage. Listings include the effective launch mode and the normalized purpose, but never the command text. `POST /api/terminal/touch` refreshes `lastActivity` for the listed session ids; open clients call it periodically so background tabs, which hold no WebSocket attachment, are not idle-reaped while a client still shows them.

## PTY Lifecycle

- IDs are client-provided or generated with `randomUUID()`.
- Create defaults to interactive mode. Command mode requires a non-empty trimmed command no longer than the terminal input limit and launches the shell so the PTY exits when that command exits. Each session also carries a normalized purpose. Omitted purpose means `{ type: 'terminal' }`. Project actions use `{ type: 'project-action', actionId, executionId }`, and the server validates both IDs as non-empty bounded strings. Create responses and attach snapshots echo the effective mode and purpose.
- Concurrent creates for one ID are single-flight only when creator, working directory, shell preference, login mode, launch mode, and session purpose match. Command-mode creates must also match the command text, unless the purpose is a project action that is already running for the same resolved `(creator, cwd, actionId)` tuple. In that case the runtime returns the existing session and its existing execution identity, even when another client of that creator requested a different session ID. Existing IDs cannot be reused for another working directory or another purpose.
- Dimensions are bounded to 1-1000 columns and 1-500 rows; input is capped at 64 KiB.
- A client may create before its renderer has mounted. It derives an initial size from the container and font metrics (falling back to 80x24 when unavailable), then sends a resize once Ghostty reports its final dimensions. This allows shell startup and renderer initialization to overlap.
- PTY children never inherit `NODE_CHANNEL_FD`; daemon IPC descriptors are host-private and invalid after PTY descriptor cleanup, and an inherited value (even empty) makes Node CLIs such as opencode print `Failed to parse IPC channel number` on exit.
- Standalone PTY children get the user's and the project's environment variables from Settings for their working directory (`environmentRuntime.applyToDirectory`, see `../environment`) under the terminal's own `TERM`/`COLORTERM`/`COLORFGBG` and before the host-private removals below, so a project variable cannot bring those back. Standalone project actions run through the terminal and get the same. Member launch bypasses this host-side setup entirely.
- PTY children also strip AppImage `ARGV0` (and other host-private shell vars such as `ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, `BASH_XTRACEFD`). An exported `ARGV0` makes zsh rewrite argv[0] for every external command, which breaks Python venv detection and other argv[0]/$0 consumers while leaving `/proc/self/exe` correct. On POSIX, PTY spawn is wrapped with `env -u ARGV0 -u NODE_CHANNEL_FD` (`resolvePosixPtyLaunch`) because a PTY backend that merges the native OS environ (`bun-pty` did before 0.5) would otherwise reintroduce both after a JS-only delete; with bun-pty 0.5 the child gets exactly the `env` passed, and the wrapper stays as the guard.
- Inside a Linux AppImage (`APPDIR` set), PTY children, the managed OpenCode server and the server's git environment (`buildGitEnv`) also lose what the AppImage launcher added to `PATH`, `LD_LIBRARY_PATH`, `GSETTINGS_SCHEMA_DIR` and `XDG_DATA_DIRS` (`stripAppImageLauncherEnv`): the mount's `usr/lib`, `usr/share` and `usr/sbin`, the mount root, the relative `./share/`, and the empty entries the launcher leaves when a variable was unset. Otherwise user tools load the app's bundled libraries, and an empty `LD_LIBRARY_PATH` entry makes the dynamic linker search the current directory (#4177). The user's own entries and the bundled OpenCode CLI directory stay. No `env -u` is needed: only Electron runs from an AppImage, and its `node-pty` uses the given env as is.
- `GET /api/terminal/shells` reports shell IDs available on the active server using the same augmented PATH provided to spawned PTYs, plus whether each executable has a supported login-mode argument. `auto` preserves environment/platform fallback order; an explicit unavailable shell fails creation instead of silently running a different shell. Login mode is opt-in and uses only built-in arguments for known shells. Interactive shells still launch as before. Command-mode launches reuse the same environment and login support, but switch argv by shell family: POSIX and Fish use interactive `-c`, Nushell uses `-c`, PowerShell uses `-Command`, and cmd uses `/d /s /c`. Preference changes affect new sessions and explicit restarts, not running PTYs.
- PTY data and exit callbacks enter one FIFO queue. The runtime wires those listeners in the same synchronous turn that receives the PTY object. `node-pty` and `bun-pty` both expose the PTY before dispatching registered callbacks. If a backend emitted exit before listener registration, this layer could not recover it, so the wiring stays adjacent to PTY creation.
- Scrollback is retained in 8 KiB byte and UTF-16 segments on the server and capped at 512 KiB with UTF-8-safe trimming. An oversized PTY callback retains only copied suffix segments, so the whole callback allocation can be released. Snapshot assembly happens on attach, not on each PTY callback. Before the first trim, the queue preserves original UTF-16 text, including surrogate pairs split across callbacks. The client also retains byte-counted projection history and assembles its text for a late subscriber. Device-status, device-attribute, cursor-position reply, and color-query exchanges are removed from replay history; live output remains byte-for-byte unchanged.
- Replay parsing scans each new PTY chunk without rescanning carried control text. Incomplete sequences retain copied UTF-16 fragments totaling at most 8,192 code units, including introducers and terminators. Larger sequences are omitted from replay even when they complete in one callback. After overflow, the parser discards payload through BEL, C1 ST, or ESC ST for string controls, or the final byte for CSI and ESC controls. A trailing ESC remains recognizable across callbacks. Process exit, create, and restart clear pending replay and theme-query state.
- Exited sessions remain attachable until explicit close, idle cleanup, or a successful replacement of the same project action. Creating a replacement retires only exited records for the same resolved directory and action, after the new PTY starts. Failed creation preserves the old record and output. These replaced records do not exhaust the terminal capacity limit.
- Deduplicated create responses may describe another client's execution. Cancellation cleanup closes only the terminal ID allocated for the cancelled request; it never closes an adopted peer execution.
- Create and restart validate the working directory with a real `stat` and answer HTTP 400 `Invalid working directory` when it is not a directory. When the path does not exist at all (`ENOENT`/`ENOTDIR`, a worktree deleted outside OpenChamber) the body also carries `code: "TERMINAL_CWD_MISSING"`. The client shows the failure without moving the session. The runtime never substitutes a parent directory on its own.
- Restarts are serialized per terminal. Local providers spawn and wire the replacement before terminating the old process. Remote member handles require proven old closure before spawning a replacement. Both retain the terminal ID and attachment-generation rules. Command-mode sessions reject restart with HTTP 400 instead of silently turning into interactive shells with stale action metadata.
- A restart rechecks session ownership before and after PTY creation. Close, force-kill, idle removal, or shutdown can invalidate it while spawn is pending. A late replacement is terminated instead of being attached to a retired session.
- A delete that arrives while create is still pending leaves a cancellation tombstone. When the PTY arrives, the runtime terminates it immediately, never inserts the session into the live map, and returns a create error while the delete still succeeds.
- Force-kill requires an explicit body selection by `sessionId` or absolute `cwd`; conflicting query selectors are rejected. A member's directory selection includes only that creator's live and pending records. Restart rejects an ID already reserved by a pending create.
- Close uses SIGTERM with bounded SIGKILL escalation. Force-kill and idle cleanup terminate process groups immediately where supported. Removal explicitly sends a fatal scoped closure and evicts client projections even when a PTY backend fails to emit `onExit`; attached terminals are not considered idle.
- Remote close, force-kill, pending cancellation and idle expiry reserve their ID until awaited handle closure. Stop failures remain errors, including cancellation during shutdown. Browser detach only removes attachments and leaves the adapter control connection alive.
- Remote close and force-kill invalidate a pending replacement synchronously, then join its create or restart and any late handle termination before responding. This also applies when an exited record has a same-ID pending create, or a restart has no process while native readiness is pending. The record retains the handle's remote lifetime capability across that interval. Unknown readiness or cancellation rejects closure. Local providers retain their existing immediate removal and late replacement cleanup behavior, independently of creator identity.
- Every unknown create or restart attempt reserves its creator, resolved attempted directory and purpose, even when no process handle was returned or concurrent removal retired the old record. Previous history is preserved. Known-closed setup failure leaves the old exited record reusable. Cancelled pending project actions reserve the same creator/directory/action tuple across fresh terminal IDs until cleanup proves closure; other creators and actions are independent.
- Shutdown is single-flight, rejects new creates, cancels pending creates, and waits for pending creates and restarts before clearing live sessions. A PTY that arrives during shutdown follows the same cancellation cleanup as a pending create that was explicitly closed.
- On POSIX, shutdown disconnects input and gives terminal workloads a shared 20-second SIGTERM grace. Process-table snapshots retain descendant ownership across shell exit and separate job-control groups; PID start times guard against reused PIDs. Linux reads `/proc` directly so minimal containers do not need `ps`. Shells remain open until the workloads exit, then receive SIGHUP. An exec'ed server receives SIGTERM and the full grace even though it occupies the shell PID. Remaining processes receive SIGKILL at the deadline. A process-table failure warns and forces known owned processes closed. Windows retains ConPTY-owned teardown because it has no POSIX signal protocol.
- Shutdown separates remote handles before any local PID census or signal fallback. Every handle is awaited even if another fails. Rejected remote closure and prior unknown outcomes reject the single-flight shutdown promise after socket cleanup; they never become successful empty cleanup.

## Decisions

### Why events and not polling

The runtime broadcasts `openchamber:terminal-sessions-changed` after creation,
exit, restart and removal, including idle cleanup, replacement and shutdown.
The event carries no terminal data or command text. The existing OpenChamber
control broadcaster reaches global WebSocket and control SSE clients, including
relay and mobile clients. Consumers coalesce invalidations into authoritative
list reads and read again on connection and visibility recovery. The old
five-second loop generated idle requests whenever the header was mounted.

### Why the snapshot is gzipped in the frame and not by the socket

A 512 KiB history is a 450 to 620 KiB JSON frame and gzips to 45 to 155 KiB in a few milliseconds. `permessage-deflate` on the socket would cover direct connections only: the relay host reads the terminal socket over loopback and forwards each message encrypted, and encrypted frames do not compress. Gzip inside the frame crosses every transport. Only the snapshot is compressed, on request, so an older client or server keeps exchanging plain frames and live output is never held back.

### Why older Bun uses node-pty

bun-pty 0.6.0 imports successfully on Bun below stable 1.4.0 but throws when spawning. Provider selection checks the Bun version before caching the provider, so older Bun, 1.4.0 prereleases, and Node use node-pty. Early 1.4.0 canaries lack the required FFI buffer_length type. node-pty under Bun spawns a shell that never delivers output, so a server on older Bun has no working terminal. `openchamber serve` therefore starts the server on Bun only when `bun --version` passes the same rule, `bunVersionRunsBunPty` in `bun-pty-support.js`, and on Node otherwise (#6322). The update restart reruns the CLI with the server's own runtime, so a CLI running on such a Bun starts the server with `node` from `PATH`. The bun-pty patch retains up to 512 KiB of UTF-8-safe output until the first data listener attaches; 0.6.0 does not yet include that upstream fix.

### Why the native registry owns creator checks

Gateway-only project checks let colleagues in one project share shell control.
The gateway supplies authenticated identity and current project authorization;
the native registry enforces creator ownership atomically with reservation,
mutation and output delivery, including while launch is pending.

### Why member launch fails without its adapter

Accepting fresh IDs before member execution is wired would enable service-account
shells. The explicit callback keeps member creation closed until the qualified
launcher is integrated and prevents host project setup from running first.

### Why remote replacement waits for closure

The local PTY walker cannot signal a member UID's detached descendants. Only the
launcher's handle-bound systemd stop proves their closure. Starting a replacement
first could replay setup while the old process family remains alive. Unknown
outcomes therefore keep the creator's reservation until owner reconciliation.

### Why close invalidates before joining replacement

Member setup can run before the adapter returns a handle. Close marks the record
retired and cancels its pending create before waiting, so the replacement path
owns termination of any late handle. That path never waits for close. Close joins
its result and retains any unknown outcome without a promise cycle. Cancelled
pending actions remain in the availability gate until that result is known.

### Why replay parsing carries bounded fragments

A growing pending prefix made an unterminated control string copy and rescan all previous output on every callback. Bounded fragments let the parser scan only new input and assemble a retained sequence once at its terminator. UTF-16 copies preserve split surrogate pairs and prevent a short suffix from retaining a larger callback allocation.

### Why overflow waits for the terminator

Resetting the parser at the size limit would expose control payload as printable replay text. Discarding the whole oversized sequence through its terminator preserves the replay boundary while raw live output remains unchanged. The 8,192-code-unit limit bounds parser memory separately from the 512 KiB scrollback limit.

## Security And Relay

The WebSocket path must remain in both `isUrlAuthWebSocketPath` and relay `ALLOWED_WS_PATHS`. The client must use `getRuntimeUrlResolver().websocket()` and `openRuntimeWebSocket`; direct local URLs or raw browser WebSockets break relay and URL-token authentication.

## Verification

Run:

```sh
bun test packages/web/server/lib/terminal/runtime.test.js packages/web/server/lib/terminal/terminal-ws-protocol.test.js
bun run --cwd packages/web test server/lib/terminal/shutdown.test.js
bun test packages/web/server/lib/ui-auth/ui-auth.test.js packages/web/server/lib/relay/cross-compat.test.js
```

The #3389 macOS ARM64 reproduction used real Electron 43.7.0 PTYs and HTTP
servers with signal handlers that took 15 seconds to finish cleanup. On the
baseline, File > Restart and Quit sent SIGKILL to the exec'ed server within
3–4 ms; a foreground child in another process group received SIGHUP and outlived
Electron. After the fix, both workloads completed after SIGTERM before Electron
exited, in bundled and HMR runs. A noncooperative workload was killed after the
shared 20-second deadline.

Packaged test builds 1.24.90 and 1.24.91 exercised the real macOS Squirrel install
with a loopback feed, isolated app identity/profile, and a shared test signing
requirement. Both the normal update and closing the window during cleanup
installed and relaunched N+1 after the terminal workloads finished. The installed
ASAR matched N+1, and OpenCode remained bundled after its own restart. A rejected
signature also reached the installer error handler after the 15-second cleanup.
Linux ARM64 process regressions pass without `ps` installed. Native Windows
ConPTY and Linux Electron installer behavior were not exercised for this fix.
