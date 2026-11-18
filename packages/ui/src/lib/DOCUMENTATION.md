# Hosted surface selection

## Ownership

`runtimeSurface.ts` owns the choice between the mobile and desktop app shells in a hosted browser. It stamps the answer on `window` at boot, and every `isMobileSurfaceRuntime()` caller reads that answer. Capacitor, Electron and VS Code have fixed surfaces and skip the heuristic. The live tablet layout inside the mobile shell belongs to `useTabletLayout` in `device.ts`.

## Invariants

- An explicit stamp or `?surface=` override wins over the heuristic, and an override stops the resize watcher.
- Rotating a phone never changes its surface, so it never reloads the document.
- Tablets and fine-pointer touch desktops follow the viewport width: a coarse-pointer tablet is mobile up to 768 CSS px wide, so rotating it can still reload into the other shell.

## Decisions

### Why a phone is recognized by the screen's short side and not by the viewport width

A rotated phone's viewport and `screen.width` both report the long side, so a width check flips during rotation and the resize watcher reloads into the desktop shell. The short side stays the same in both orientations.

### Why the short-side rule stops at 600 CSS px and not at 768

768 would move small tablets to the mobile shell in landscape, where they get the desktop shell today. 600 is the line `useTabletLayout` already uses for tablets, so one constant decides both.

### Why the short-side rule reads only `(pointer: coarse)` and not the wider touch check

`hover: none` and touch points also match touch laptops driven by a mouse. On those the short side would keep the mobile shell at full width, so they stay on the viewport width rule.

# Runtime URL authentication

`runtime-auth.ts` owns runtime HTTP credentials and browser-owned URL auth.
`runtime-url.ts` constructs asset and realtime URLs. Feature code awaits auth
preparation and uses the resolver without adding credentials itself.

## Invariants

- Ordinary URL-token responses require a token and expiry. Relay, guest-frame
  and local realtime-proxy minting continue to require real tokens.
- A direct runtime may explicitly return exactly
  `{ authenticated: true, disabled: true, authMode: 'cookie' }`. Preparation then
  succeeds with an empty token, and URLs carry no auth query parameter.
- Cookie mode belongs to the mint endpoint and current credential generation.
  Endpoint, credential or extra-header changes and explicit clearing retire it
  and reject late responses. Concurrent preparation shares one mint.
- Default auth URLs use the active endpoint getter supplied by `runtime-switch`.
  The injected boot URL is only the pre-switcher fallback; Electron may expose
  it read-only. Scope checks, synchronous cookie reads and scheduling use this
  same resolution without an auth-to-switcher import cycle. Endpoint operations
  register the getter after module initialization.
- Cookie mode stops token-expiry scheduling. The gateway authenticates each
  resource request with its HttpOnly cookie and applies its ordinary scope
  checks. A successful preparation does not grant later resource access.
- Missing, legacy `disabled`-only and malformed responses remain failures.

## Decisions

### Why cookie mode is explicit

An authenticated same-origin gateway can keep upstream credentials private and
authorize browser requests itself. Requiring a fabricated token or expiry would
misrepresent that contract and trigger unnecessary refreshes. An exact response
keeps malformed token responses from silently becoming successful cookie auth.

## Terminal listing and action Stop

`terminalApi.ts` owns listing validation. `TerminalServerSession.status` preserves
the server's `running`, `exited`, `closing` and `unknown` states. Closing and unknown
rows are authoritative reservations, not missing terminals. Per-entry malformed
rows retain the existing skip policy; valid peers remain available. The observer
and `reconcileTerminalSessionAuthority` carry this typed list without filtering
unresolved states. This contract is shared by web, Electron and server-backed
hosted/Capacitor mobile. VS Code keeps its existing unsupported server-list behavior.

`projectActionTerminal.ts` owns the temporary Stop waiter. A live exit, exited
snapshot or known `KILLED` settles it as exited; other fatal errors reject with
the original error. A timeout permits the existing awaited force/close fallback.
Unknown send, wait, force or close errors escape without clear/finalize or a
restore-running fallback. Rejection is observed alongside pending input, so a
missing input acknowledgement cannot hide it. The waiter closes its subscription,
clears its deadline and removes its cancellation listener on every outcome.

### Why Stop failure retains the action binding

The owner, view and Stop waiter can receive the same unknown frame in any order.
Execution guards retain the session/execution and unavailable state through the
Stop continuation. Repeated Stop while stopping or unavailable sends nothing;
an acknowledgement arriving later cannot finalize that uncertainty. No stop
request or command is replayed. The existing scoped force/close success remains
closure authority after the deadline, while ordinary termination failure retains
the existing retryable running behavior.
