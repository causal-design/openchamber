import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_WS_PATH,
  createTerminalWsControlFrame,
  parseRequestPathname,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';
import { sanitizeTerminalHistoryChunk } from './history.js';
import { consumeTerminalThemeQueries, terminalThemeModeReport } from './theme-response.js';
import { buildTerminalShellLaunch, createTerminalShellResolver, normalizeTerminalShell } from './shells.js';
import { stripAppImageArgv0Leak, stripAppImageLauncherEnv, resolvePosixPtyLaunch } from '../inherited-env.js';
import { shutdownTerminalProcesses } from './shutdown.js';
import { bunVersionRunsBunPty } from './bun-pty-support.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const configuredTerminalContext = process.env.PEIRCE_TERMINAL_CONTEXT_HELPERS
  ? await (await import(process.env.PEIRCE_TERMINAL_CONTEXT_HELPERS)).loadTerminalContext() : null;
const sameCreator = (left, right) => left?.memberID === right?.memberID && left?.accountID === right?.accountID;

const MAX_SESSIONS = 20;
const MAX_HISTORY_BYTES = 512 * 1024;
const HISTORY_SEGMENT_BYTES = 8 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;
const OUTPUT_BATCH_MS = 12;
const MAX_OUTPUT_BATCH_CHARS = 32 * 1024;
const MAX_INPUT_CHARS = 65_536;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const INTERACTIVE_TERMINAL_MODE = 'interactive';
const COMMAND_TERMINAL_MODE = 'command';
// Error code the create/restart routes attach when the requested cwd no longer
// exists. Mirrored by `TERMINAL_CWD_MISSING_CODE` in packages/ui/src/lib/terminalApi.ts.
const TERMINAL_CWD_MISSING_CODE = 'TERMINAL_CWD_MISSING';
const TERMINAL_PURPOSE = Object.freeze({ type: 'terminal' });
const MAX_PURPOSE_ID_CHARS = 128;
const OBJECT_TAG = '[object Object]';
const validateSize = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const isString = (value) => String(value) === value;
const isObjectRecord = (value) => value != null && !Array.isArray(value) && Object.prototype.toString.call(value) === OBJECT_TAG;
const normalizeCreateMode = ({ mode, command }) => {
  const normalizedMode = mode == null ? INTERACTIVE_TERMINAL_MODE : mode;
  if (normalizedMode !== INTERACTIVE_TERMINAL_MODE && normalizedMode !== COMMAND_TERMINAL_MODE) throw new Error('Invalid terminal mode');
  if (normalizedMode === INTERACTIVE_TERMINAL_MODE) {
    if (command != null) throw new Error('Interactive terminal create does not accept a command');
    return { mode: INTERACTIVE_TERMINAL_MODE, command: null };
  }
  if (!isString(command) || !command.trim()) throw new Error('Terminal command is required');
  const trimmedCommand = command.trim();
  if (trimmedCommand.length > MAX_INPUT_CHARS) throw new Error('Terminal command exceeds the input limit');
  return { mode: COMMAND_TERMINAL_MODE, command: trimmedCommand };
};
const normalizePurposeId = (value, errorMessage) => {
  if (!isString(value) || !value.trim()) throw new Error(errorMessage);
  const normalized = value.trim();
  if (normalized.length > MAX_PURPOSE_ID_CHARS) throw new Error(errorMessage);
  return normalized;
};
const normalizeTerminalPurpose = (value) => {
  if (value == null) return TERMINAL_PURPOSE;
  if (!isObjectRecord(value)) throw new Error('Invalid terminal purpose');
  if (value.type === 'terminal') return TERMINAL_PURPOSE;
  if (value.type !== 'project-action') throw new Error('Invalid terminal purpose');
  return {
    type: 'project-action',
    actionId: normalizePurposeId(value.actionId, 'Terminal project action id is required'),
    executionId: normalizePurposeId(value.executionId, 'Terminal execution id is required'),
  };
};
const getSessionPurpose = (session) => session.purpose ?? TERMINAL_PURPOSE;
const isPurposeActionMatch = (left, right) => {
  if (left.type !== right.type) return false;
  return left.type !== 'project-action' || left.actionId === right.actionId;
};
const findRunningActionSession = (sessions, resolvedCwd, purpose, path, creator) => {
  if (purpose.type !== 'project-action') return null;
  for (const session of sessions.values()) {
    if (!sameCreator(session.creator, creator)) continue;
    if (session.status !== 'running') continue;
    if (path.resolve(session.cwd) !== resolvedCwd) continue;
    const sessionPurpose = getSessionPurpose(session);
    if (sessionPurpose.type === 'project-action' && sessionPurpose.actionId === purpose.actionId) return session;
  }
  return null;
};
const findPendingActionCreate = (pendingSessionCreates, resolvedCwd, purpose, creator) => {
  if (purpose.type !== 'project-action') return null;
  for (const pending of pendingSessionCreates.values()) {
    if (!sameCreator(pending.creator, creator)) continue;
    if (pending.cwd !== resolvedCwd) continue;
    if (pending.purpose?.type === 'project-action' && pending.purpose.actionId === purpose.actionId) return pending;
  }
  return null;
};
const newHistory = () => ({ chunks: [], head: 0, offset: 0, bytes: 0, original: [], originalTail: '', originalLast: '' });
const historyText = (history) => history.original
  ? history.original.join('') + history.originalTail
  : Buffer.concat(history.chunks.slice(history.head).map((chunk, index) => chunk.buffer.subarray(index === 0 ? history.offset : 0, chunk.length))).toString('utf8');
const appendHistoryBytes = (history, bytes) => {
  let offset = 0;
  while (offset < bytes.length) {
    let tail = history.chunks.at(-1);
    if (!tail || tail.length === HISTORY_SEGMENT_BYTES) {
      tail = { buffer: Buffer.allocUnsafe(HISTORY_SEGMENT_BYTES), length: 0 };
      history.chunks.push(tail);
    }
    const length = Math.min(bytes.length - offset, HISTORY_SEGMENT_BYTES - tail.length);
    bytes.copy(tail.buffer, tail.length, offset, offset + length);
    tail.length += length;
    offset += length;
  }
  history.bytes += bytes.length;
};
const removeHistoryTail = (history, count) => {
  history.bytes -= count;
  while (count > 0) {
    const tail = history.chunks.at(-1);
    const removed = Math.min(tail.length, count);
    tail.length -= removed;
    count -= removed;
    if (!tail.length) history.chunks.pop();
  }
};
const appendOriginal = (history, text) => {
  let offset = 0;
  while (offset < text.length) {
    const length = Math.min(text.length - offset, HISTORY_SEGMENT_BYTES - history.originalTail.length);
    history.originalTail += text.slice(offset, offset + length);
    offset += length;
    if (history.originalTail.length === HISTORY_SEGMENT_BYTES) {
      history.original.push(history.originalTail);
      history.originalTail = '';
    }
  }
  history.originalLast = text.at(-1);
};
const appendHistory = (history, text) => {
  if (!text) return;
  // Buffer.from encodes an unmatched high surrogate as U+FFFD. Until the first
  // trim, the next chunk can still complete that UTF-16 pair.
  let encoded = text;
  if (history.original && /[\uD800-\uDBFF]/.test(history.originalLast) && /^[\uDC00-\uDFFF]/.test(text)) {
    removeHistoryTail(history, 3);
    encoded = history.originalLast + text;
  }
  const bytes = Buffer.from(encoded);
  if (history.bytes + bytes.length <= MAX_HISTORY_BYTES) {
    appendHistoryBytes(history, bytes);
    if (history.original) appendOriginal(history, text);
    return;
  }

  // A large PTY callback replaces the entire scrollback. Copy only its aligned
  // suffix so a slice cannot keep the callback's much larger buffer alive.
  if (bytes.length >= MAX_HISTORY_BYTES) {
    let start = bytes.length - MAX_HISTORY_BYTES;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    history.chunks = []; history.head = 0; history.offset = 0; history.bytes = 0;
    appendHistoryBytes(history, bytes.subarray(start));
    history.original = null;
    history.originalTail = '';
    return;
  }

  appendHistoryBytes(history, bytes);

  let remove = history.bytes - MAX_HISTORY_BYTES;
  let removed = 0;
  while (remove > 0) {
    const available = history.chunks[history.head].length - history.offset;
    if (remove < available) { history.offset += remove; removed += remove; break; }
    remove -= available;
    removed += available;
    history.head += 1;
    history.offset = 0;
  }
  while (history.head < history.chunks.length) {
    const chunk = history.chunks[history.head];
    if (history.offset === chunk.length) { history.head += 1; history.offset = 0; continue; }
    if ((chunk.buffer[history.offset] & 0xc0) !== 0x80) break;
    history.offset += 1;
    removed += 1;
  }
  history.bytes -= removed;
  history.original = null;
  history.originalTail = '';
  if (history.head > 128) { history.chunks = history.chunks.slice(history.head); history.head = 0; }
};

export async function loadTerminalPtyProvider(bunVersion = globalThis.Bun?.version, importPty = (name) => import(name)) {
  if (bunVersionRunsBunPty(bunVersion)) {
    try { const pty = await importPty('bun-pty'); return { spawn: pty.spawn, backend: 'bun-pty' }; } catch { /* fall through */ }
  }
  const pty = await importPty('node-pty');
  return { spawn: pty.spawn, backend: 'node-pty' };
}

export function createTerminalRuntime({
  app, server, fs, path, uiAuthController, buildAugmentedPath, searchPathFor, isExecutable,
  isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  loadPtyProvider, terminalTerminationGraceMs = TERMINATION_GRACE_MS, shutdownProcesses = shutdownTerminalProcesses,
  environmentRuntime = null,
  broadcastUiEvent = () => {},
  terminalContext = configuredTerminalContext,
  spawnMemberTerminal = null,
  logger = console,
}) {
  const sessions = new Map();
  // Invalidation only: clients read the authoritative list without command text.
  const announceSessionsChanged = () => broadcastUiEvent({ type: 'openchamber:terminal-sessions-changed', properties: {} });
  const pendingSessionCreates = new Map();
  const pendingSessionRestarts = new Map();
  const connections = new Set();
  const pendingTerminations = new Set();
  const remoteTerminations = new WeakMap();
  const runtime = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';
  let ptyProviderPromise = null;
  let shutdownPromise = null;
  let wsServer = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const shellResolver = createTerminalShellResolver({ fs, path, searchPathFor, isExecutable, buildAugmentedPath });
  const authenticate = (req) => {
    if (terminalContext) return terminalContext.authenticate(req);
    if (req.headers?.['x-peirce-terminal-context']) throw Object.assign(new Error('Member terminal runtime unavailable'), { status: 503 });
    return null;
  };
  // Every route authenticates before inspecting the registry, including lists
  // and pending cancellation. Keep this wrapper local to terminal routes.
  const route = (method, url, handler) => app[method](url, (req, res) => {
    let creator;
    try { creator = authenticate(req); }
    catch (error) { return res.status(error.status ?? 401).json({ error: 'Terminal identity unavailable' }); }
    return Promise.resolve(handler(req, res, creator)).catch(error => res.status(500).json(errorBody(error, 'Terminal operation failed')));
  });
  const ownedSession = (id, creator) => {
    const session = sessions.get(id);
    return session && sameCreator(session.creator, creator) ? session : null;
  };
  const checkDirectory = (cwd, creator) => {
    if (creator && (!creator.directory || path.resolve(cwd) !== creator.directory)) throw new Error('Terminal directory mismatch');
  };

  const getPtyProvider = async () => {
    if (!ptyProviderPromise) {
      ptyProviderPromise = (loadPtyProvider ?? loadTerminalPtyProvider)();
    }
    return ptyProviderPromise;
  };

  const spawnPty = async ({ cwd, cols, rows, themeMode, shell, loginShell, mode, command, creator }) => {
    if (creator) {
      if (!spawnMemberTerminal) throw new Error('Member terminal launcher unavailable');
      return spawnMemberTerminal({ cwd, cols, rows, themeMode, shell, loginShell, mode, command, creator });
    }
    const provider = await getPtyProvider();
    const resolvedShell = await shellResolver.resolve(shell);
    // The user's and the project's variables go under the terminal's own TERM
    // settings and the host-private removals below.
    const hostEnv = { ...process.env, PATH: buildAugmentedPath() };
    // Opening a terminal or running a project action is the user's own act,
    // so it may run the project's environment command.
    const inheritedEnv = environmentRuntime ? await environmentRuntime.applyToDirectory(cwd, hostEnv, { refresh: true }) : hostEnv;
    let lastError = null;
    for (const executable of resolvedShell.executables) {
      try {
        const env = { ...inheritedEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: themeMode === 'light' ? '0;15' : '15;0' };
        // The daemon's IPC fd is closed inside the PTY; an inherited NODE_CHANNEL_FD
        // (even an empty one) makes Node CLIs warn about an unparsable IPC channel.
        delete env.NODE_CHANNEL_FD;
        delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
        // AppImage exports ARGV0; zsh would otherwise rewrite argv[0] for every command (#2588).
        stripAppImageArgv0Leak(env);
        // The AppImage launcher also prepends its own directories to PATH, LD_LIBRARY_PATH,
        // GSETTINGS_SCHEMA_DIR and XDG_DATA_DIRS (#4177). Only the desktop app runs from an
        // AppImage, and it spawns through node-pty, which uses this env as given, so these
        // need no `env -u` below.
        stripAppImageLauncherEnv(env);
        const shellLaunch = buildTerminalShellLaunch(executable, { mode, command, loginShell });
        // bun-pty 0.5 gives the child exactly `env`; the POSIX launch is still
        // wrapped with `env -u` for the variables deleted above, so a backend
        // that merges the native OS environ cannot bring them back.
        const launch = resolvePosixPtyLaunch(shellLaunch.executable, shellLaunch.args);
        const options = { name: 'xterm-256color', cwd, cols, rows, env };
        if (process.platform === 'win32') options.useConpty = true;
        return { process: await provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: resolvedShell.id, shellExecutable: executable, loginShell };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('No executable shell found');
  };

  const killProcess = (ptyProcess, force = false) => {
    if (!ptyProcess) return;
    if (process.platform !== 'win32' && Number.isInteger(ptyProcess.pid) && ptyProcess.pid > 0) {
      try { process.kill(-ptyProcess.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
    try { ptyProcess.kill(force ? 'SIGKILL' : undefined); } catch { /* already gone */ }
  };

  const terminateProcess = (ptyProcess, force = false) => {
    if (!ptyProcess) return Promise.resolve();
    if (typeof ptyProcess.terminate === 'function') {
      if (remoteTerminations.has(ptyProcess)) return remoteTerminations.get(ptyProcess);
      const termination = Promise.resolve().then(() => ptyProcess.terminate())
        .finally(() => pendingTerminations.delete(termination));
      remoteTerminations.set(ptyProcess, termination);
      pendingTerminations.add(termination);
      termination.catch(() => {}); // Callers still receive the original rejection.
      return termination;
    }
    if (force) { killProcess(ptyProcess, true); return Promise.resolve(); }
    let termination;
    termination = new Promise((resolve) => {
      let settled = false;
      let disposable = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable?.dispose?.();
        resolve();
      };
      const timeout = setTimeout(() => { killProcess(ptyProcess, true); finish(); }, terminalTerminationGraceMs);
      try { disposable = ptyProcess.onExit(() => finish()); } catch { /* backend is already gone */ }
      killProcess(ptyProcess, false);
    }).finally(() => pendingTerminations.delete(termination));
    pendingTerminations.add(termination);
    return termination;
  };

  const send = (socket, message, frameOptions) => {
    if (socket?.readyState !== 1) return false;
    try {
      const frame = createTerminalWsControlFrame(message, frameOptions);
      if (socket.bufferedAmount + frame.length > MAX_SOCKET_BUFFER_BYTES) {
        socket.terminate();
        return false;
      }
      socket.send(frame, { binary: true });
      return true;
    } catch { return false; }
  };

  const flushOutput = (session) => {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    const output = session.pendingOutput;
    if (!output) return;
    session.pendingOutput = null;
    const raw = output.raw.join('');
    const replay = output.replay.join('');
    publish(session, { t: 'output', d: raw, ...(raw !== replay ? { r: replay } : {}) });
  };

  // Output after a quiet spell goes out at once, so a keystroke echo never
  // waits for the timer. Output that follows within OUTPUT_BATCH_MS joins one
  // frame, and the window stays open while the burst continues.
  const openOutputWindow = (session) => {
    session.outputTimer = setTimeout(() => {
      session.outputTimer = null;
      if (!session.pendingOutput) return;
      flushOutput(session);
      openOutputWindow(session);
    }, OUTPUT_BATCH_MS);
  };

  const discardOutput = (session) => {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    session.pendingOutput = null;
  };

  const closeAttachments = (sessionId, code, message) => {
    for (const connection of connections) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: 'error', v: 3, s: sessionId, code, message, fatal: true });
    }
  };

  const snapshot = (session) => ({
    t: 'snapshot', v: 3, s: session.id, q: session.sequence, history: historyText(session.history),
    // The PTY size the history was drawn for: a client replays history at this
    // size before fitting its own viewport, so shell output wrapped for one
    // width never gets re-laid-out at another.
    cols: session.cols, rows: session.rows,
    status: session.status, exitCode: session.exitCode, signal: session.signal,
    mode: session.mode ?? INTERACTIVE_TERMINAL_MODE, purpose: getSessionPurpose(session),
    runtime, ptyBackend: session.backend,
  });

  const publish = (session, event) => {
    session.sequence += 1;
    const message = { ...event, v: 3, s: session.id, q: session.sequence };
    for (const connection of connections) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment || attachment.generation !== session.generation || !sameCreator(connection.creator, session.creator)) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const drainEvents = (session) => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.eventQueue.length > 0) {
        const event = session.eventQueue.shift();
        if (session.retired || event.process !== session.process) continue;
        if (event.type === 'output') {
          const theme = consumeTerminalThemeQueries(session.pendingThemeControlSequence, event.data, {
            themeMode: session.themeMode,
            background: session.terminalBackground,
            foreground: session.terminalForeground,
            modeEnabled: session.themeModeEnabled,
          }, { respondToPrimaryDeviceAttributes: true });
          session.pendingThemeControlSequence = theme.pending;
          session.themeModeEnabled = theme.modeEnabled;
          for (const response of theme.responses) session.process?.write(response);
          const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, event.data);
          session.pendingHistoryControlSequence = sanitized.pending;
          appendHistory(session.history, sanitized.visible);
          session.lastActivity = Date.now();
          const output = session.pendingOutput ??= { raw: [], replay: [], chars: 0 };
          output.raw.push(event.data); output.replay.push(sanitized.visible); output.chars += event.data.length;
          if (output.chars >= MAX_OUTPUT_BATCH_CHARS) flushOutput(session);
          else if (!session.outputTimer) { flushOutput(session); openOutputWindow(session); }
        } else {
          flushOutput(session);
          session.pendingHistoryControlSequence = '';
          session.pendingThemeControlSequence = '';
          if (event.uncertain) {
            session.closureError = closureUnknown();
            session.status = 'unknown';
            closeAttachments(session.id, session.closureError.code, session.closureError.message);
            continue;
          }
          session.status = 'exited';
          session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
          session.signal = Number.isInteger(event.signal) ? event.signal : null;
          session.process = null;
          publish(session, { t: 'exit', exitCode: session.exitCode, signal: session.signal });
          if (sessions.get(session.id) === session) announceSessionsChanged();
        }
      }
    } finally { session.draining = false; }
  };

  const wire = (session, ptyProcess) => {
    ptyProcess.onData((data) => { session.eventQueue.push({ type: 'output', process: ptyProcess, data }); drainEvents(session); });
    ptyProcess.onExit(({ exitCode, signal, uncertain }) => { session.eventQueue.push({ type: 'exit', process: ptyProcess, exitCode, signal, uncertain }); drainEvents(session); });
  };

  // A working directory that no longer exists (a deleted worktree) is the one
  // rejection the client can recover from by moving the session to its
  // project, so the response names it. Every other rejection stays generic.
  const invalidWorkingDirectory = (code) => Object.assign(new Error('Invalid working directory'), code ? { code } : {});
  const validateCwd = async (cwd) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required');
    let stats;
    try { stats = await fs.promises.stat(cwd); }
    catch (error) { throw invalidWorkingDirectory(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? TERMINAL_CWD_MISSING_CODE : undefined); }
    if (!stats?.isDirectory()) throw invalidWorkingDirectory();
  };
  const errorBody = (error, fallback) => ({ error: error?.message || fallback, ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
  const closureUnknown = (error) => error?.code === 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' ? error
    : Object.assign(new Error('Member terminal closure unknown', { cause: error }), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
  const availableForReplacement = (session) => {
    if (session?.closureError) throw session.closureError;
    if (session?.closing || session?.retired) throw new Error('Terminal is closing');
  };
  const stopRemote = async (session, ptyProcess) => {
    try { await terminateProcess(ptyProcess); }
    catch (error) {
      session.closureError = closureUnknown(error); session.status = 'unknown';
      closeAttachments(session.id, session.closureError.code, session.closureError.message);
      throw session.closureError;
    }
  };
  const reserveUnknownAttempt = (session, attempt, error, process) => {
    // Retain the previous output, but reserve the attempted identity and scope.
    // The old record may already have been retired by cancellation.
    flushOutput(session);
    Object.assign(session, attempt, { process, closureError: error, status: 'unknown', retired: true });
    sessions.set(session.id, session);
    closeAttachments(session.id, error.code, error.message);
  };
  const closeSession = async (session, force, code, message) => {
    // Keep remote IDs reserved through closure, including failed closure.
    if (session.closureError) throw session.closureError;
    const remote = session.remote || typeof session.process?.terminate === 'function';
    const pending = remote && pendingSessionCreates.get(session.id);
    const restart = remote && pendingSessionRestarts.get(session.id);
    if (pending) pending.cancelled = true;
    if (!remote) sessions.delete(session.id);
    session.closing = true; session.retired = true;
    session.status = 'closing';
    announceSessionsChanged();
    flushOutput(session);
    closeAttachments(session.id, code, message);
    // Invalidation precedes this wait. Replacement cleanup owns late handles
    // and never waits for closeSession, so joining it cannot form a cycle.
    if (pending || restart) {
      const results = await Promise.allSettled([...(pending ? [pending.promise] : []), ...(restart ? [restart] : [])]);
      if (session.closureError) throw session.closureError;
      const unknown = results.find(result => result.status === 'rejected' && result.reason?.code === 'MEMBER_TERMINAL_OUTCOME_UNKNOWN');
      if (unknown) throw unknown.reason;
    }
    if (remote) await stopRemote(session, session.process);
    else await terminateProcess(session.process, force);
    if (sessions.get(session.id) === session) { sessions.delete(session.id); announceSessionsChanged(); }
  };

  const applyAppearance = (session, { themeMode, terminalBackground, terminalForeground }) => {
    const previous = [session.themeMode, session.terminalBackground, session.terminalForeground];
    if (themeMode === 'light' || themeMode === 'dark') session.themeMode = themeMode;
    if (typeof terminalBackground === 'string') session.terminalBackground = terminalBackground;
    if (typeof terminalForeground === 'string') session.terminalForeground = terminalForeground;
    const changed = previous[0] !== session.themeMode || previous[1] !== session.terminalBackground || previous[2] !== session.terminalForeground;
    if (changed && session.themeModeEnabled) {
      try { session.process?.write(terminalThemeModeReport(session.themeMode)); } catch { /* process exited */ }
    }
  };

  const startSession = async (session, { cwd, cols, rows, themeMode = 'dark', terminalBackground, terminalForeground, shell, loginShell, mode = INTERACTIVE_TERMINAL_MODE, command = null, purpose = TERMINAL_PURPOSE }, clear = true) => {
    await validateCwd(cwd);
    const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell, mode, command, creator: session.creator });
    if (clear) { discardOutput(session); session.history = newHistory(); session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; }
    session.retired = false;
    session.generation = randomUUID();
    session.cwd = cwd; session.cols = cols; session.rows = rows; session.process = spawned.process;
    session.remote = typeof spawned.process?.terminate === 'function';
    session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.status = 'running'; session.exitCode = null; session.signal = null;
    session.shellExecutable = spawned.shellExecutable;
    session.mode = mode; session.command = mode === COMMAND_TERMINAL_MODE ? command : null;
    session.purpose = purpose;
    session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
    session.lastActivity = Date.now(); session.eventQueue.length = 0;
    wire(session, spawned.process);
    return spawned.process;
  };

  const createSession = async ({ sessionId, cwd, cols = 80, rows = 24, themeMode, terminalBackground, terminalForeground, shell = 'auto', loginShell = false, mode, command, purpose }, creator) => {
    if (shutdownPromise) throw new Error('Terminal runtime is shutting down');
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
    if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
    const normalizedShell = normalizeTerminalShell(shell);
    if (!normalizedShell) throw new Error('Invalid terminal shell');
    const launchMode = normalizeCreateMode({ mode, command });
    const normalizedPurpose = normalizeTerminalPurpose(purpose);
    const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (id.length > 128) throw new Error('Invalid terminal session id');
    if (creator && (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith('ses_'))) throw new Error('Invalid terminal session id');
    const existing = sessions.get(id);
    const pending = pendingSessionCreates.get(id);
    if ((existing && !sameCreator(existing.creator, creator)) || (pending && !sameCreator(pending.creator, creator))) throw new Error('Terminal unavailable');
    availableForReplacement(existing);
    if (pendingSessionRestarts.has(id)) throw new Error('Terminal restart in progress');
    checkDirectory(cwd, creator);
    const resolvedCwd = path.resolve(cwd);
    if (normalizedPurpose.type === 'project-action') {
      for (const session of sessions.values()) {
        if (sameCreator(session.creator, creator) && path.resolve(session.cwd) === resolvedCwd && isPurposeActionMatch(getSessionPurpose(session), normalizedPurpose)) availableForReplacement(session);
      }
    }
    if (existing && path.resolve(existing.cwd) !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
    if (existing?.status === 'running') {
      if (!isPurposeActionMatch(getSessionPurpose(existing), normalizedPurpose)) throw new Error('Terminal session is already running with a different purpose');
      if (normalizedPurpose.type === 'project-action') { applyAppearance(existing, { themeMode, terminalBackground, terminalForeground }); return existing; }
      if ((existing.mode ?? INTERACTIVE_TERMINAL_MODE) !== launchMode.mode) throw new Error('Terminal session is already running with a different mode');
      if (launchMode.mode === COMMAND_TERMINAL_MODE && existing.command !== launchMode.command) throw new Error('Terminal session is already running with a different command');
      applyAppearance(existing, { themeMode, terminalBackground, terminalForeground });
      return existing;
    }
    const runningActionSession = findRunningActionSession(sessions, resolvedCwd, normalizedPurpose, path, creator);
    if (runningActionSession) {
      applyAppearance(runningActionSession, { themeMode, terminalBackground, terminalForeground });
      return runningActionSession;
    }
    if (pending) {
      if (pending.cancelled) throw new Error('Terminal is closing');
      if (pending.cwd !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (!isPurposeActionMatch(pending.purpose, normalizedPurpose)) throw new Error('Terminal session is already being created with a different purpose');
      if (normalizedPurpose.type === 'project-action') return pending.promise;
      if (pending.shell !== normalizedShell) throw new Error('Terminal session is already being created with a different shell');
      if (pending.loginShell !== loginShell) throw new Error('Terminal session is already being created with a different login mode');
      if (pending.mode !== launchMode.mode) throw new Error('Terminal session is already being created with a different mode');
      if (launchMode.mode === COMMAND_TERMINAL_MODE && pending.command !== launchMode.command) throw new Error('Terminal session is already being created with a different command');
      const session = await pending.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    const pendingActionCreate = findPendingActionCreate(pendingSessionCreates, resolvedCwd, normalizedPurpose, creator);
    if (pendingActionCreate) {
      if (pendingActionCreate.cancelled) throw new Error('Terminal is closing');
      const session = await pendingActionCreate.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    const superseded = normalizedPurpose.type === 'project-action'
      ? [...sessions.values()].filter((session) => sameCreator(session.creator, creator) && session.id !== id && session.status === 'exited'
        && path.resolve(session.cwd) === resolvedCwd && isPurposeActionMatch(getSessionPurpose(session), normalizedPurpose))
      : [];
    if (!existing && sessions.size - superseded.length + pendingSessionCreates.size >= MAX_SESSIONS) throw new Error('Maximum terminal sessions reached');
    const pendingEntry = { creator, cwd: resolvedCwd, shell: normalizedShell, loginShell, mode: launchMode.mode, command: launchMode.command, purpose: normalizedPurpose, cancelled: false, promise: null };
    pendingSessionCreates.set(id, pendingEntry);
    const session = { id, creator, sequence: 0, history: newHistory(), pendingHistoryControlSequence: '', pendingThemeControlSequence: '', eventQueue: [], draining: false, createdAt: Date.now() };
    const creation = (async () => {
      const ptyProcess = await startSession(session, { cwd, cols, rows, themeMode, terminalBackground, terminalForeground, shell: normalizedShell, loginShell, mode: launchMode.mode, command: launchMode.command, purpose: normalizedPurpose });
      if (pendingEntry.cancelled) {
        session.retired = true;
        discardOutput(session);
        try { await terminateProcess(ptyProcess, true); }
        catch (error) { throw closureUnknown(error); }
        session.process = null;
        throw new Error('Terminal session was closed during creation');
      }
      for (const previous of superseded) {
        if (sessions.get(previous.id) !== previous || previous.status !== 'exited') continue;
        sessions.delete(previous.id);
        previous.retired = true;
        discardOutput(previous);
        closeAttachments(previous.id, 'SUPERSEDED', 'Terminal replaced by a new action run');
      }
      if (existing) { existing.retired = true; discardOutput(existing); closeAttachments(id, 'SUPERSEDED', 'Terminal replaced'); }
      sessions.set(id, session);
      announceSessionsChanged();
      return session;
    })().catch(error => {
      if (error?.code === 'MEMBER_TERMINAL_OUTCOME_UNKNOWN') {
        reserveUnknownAttempt(existing ?? session, { creator, cwd: resolvedCwd, purpose: normalizedPurpose, mode: launchMode.mode }, error, session.process ?? null);
      }
      throw error;
    });
    pendingEntry.promise = creation;
    try { return await creation; }
    finally { if (pendingSessionCreates.get(id) === pendingEntry) pendingSessionCreates.delete(id); }
  };

  wsServer.on('connection', (socket, req) => {
    const connection = { socket, creator: req.terminalCreator, attachments: new Map() };
    connections.add(connection);
    send(socket, { t: 'hello', v: 3 });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Binary control frame required', fatal: false }); return; }
      const message = readTerminalWsControlFrame(raw);
      if (!message || message.v !== 3 || typeof message.t !== 'string') { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Invalid terminal frame', fatal: false }); return; }
      if (message.t === 'ping') { send(socket, { t: 'pong', v: 3 }); return; }
      if (message.t === 'hello') return;
      const id = typeof message.s === 'string' ? message.s : '';
      if (!id) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Session id required', fatal: false }); return; }
      const session = ownedSession(id, connection.creator);
      if (!session) { send(socket, { t: 'error', v: 3, s: id, code: 'SESSION_NOT_FOUND', message: 'Terminal session not found', fatal: true }); return; }
      if (message.t === 'detach') { connection.attachments.delete(id); return; }
      if (session.closureError || session.retired) {
        send(socket, { t: 'error', v: 3, s: id, code: session.closureError?.code ?? 'CLOSED', message: session.closureError?.message ?? 'Terminal is closing', fatal: true });
        return;
      }
      if (message.t === 'attach') {
        const attachment = { generation: session.generation, initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        flushOutput(session);
        const initial = snapshot(session);
        // `z: 1` is a client that can gunzip: history compresses five to ten
        // times, and neither this socket nor the relay tunnel compresses frames.
        send(socket, initial, { gzip: message.z === 1 });
        for (const event of attachment.pending) if (event.q > initial.q) send(socket, event);
        attachment.pending.length = 0; attachment.initializing = false;
        return;
      }
      if (message.t === 'write') {
        if (typeof message.d !== 'string' || !message.d || message.d.length > MAX_INPUT_CHARS) { send(socket, { t: 'error', v: 3, s: id, code: 'BAD_INPUT', message: 'Invalid terminal input', fatal: false }); return; }
        if (session.status !== 'running' || !session.process) { send(socket, { t: 'error', v: 3, s: id, code: 'NOT_RUNNING', message: 'Terminal is not running', fatal: false }); return; }
        try { session.process.write(message.d); session.lastActivity = Date.now(); } catch { send(socket, { t: 'error', v: 3, s: id, code: 'WRITE_FAILED', message: 'Failed to write to terminal', fatal: false }); }
      }
    });
    const cleanup = () => { clearInterval(heartbeat); connection.attachments.clear(); connections.delete(connection); };
    socket.on('close', cleanup); socket.on('error', () => {});
  });

  const upgradeHandler = (req, socket, head) => {
    if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) return;
    try { req.terminalCreator = authenticate(req); }
    catch { rejectWebSocketUpgrade(socket, 401, 'Terminal identity unavailable'); return; }
    const logUpgradeFailure = (error) => {
      logger.warn?.(`[terminal] websocket upgrade failed: ${error?.message || error}`);
    };
    const accept = () => {
      if (!wsServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
      try {
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch (error) {
        // handleUpgrade only throws once it has taken the socket: either the
        // handshake already wrote its 101 (a second upgrade of the same socket,
        // or a throw from the connection callback), so the connection is no
        // longer HTTP. Writing a status line here would append an HTTP response
        // to a switched-protocol socket; drop it and log why instead.
        logUpgradeFailure(error);
        socket.destroy();
      }
    };
    const checkOrigin = () => {
      try {
        const result = isRequestOriginAllowed(req);
        if (!(result instanceof Promise)) {
          if (result) accept();
          else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        void result.then((allowed) => {
          if (allowed) accept();
          else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
        }).catch((error) => { logUpgradeFailure(error); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
      } catch (error) { logUpgradeFailure(error); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    };
    if (isOpaqueOriginRequest(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
    if (!uiAuthController?.enabled) {
      void isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed).then((allowed) => {
        if (allowed) accept();
        else rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      }).catch((error) => { logUpgradeFailure(error); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
      return;
    }
    try {
      const result = uiAuthController.ensureSessionToken(req, null);
      if (!(result instanceof Promise)) {
        if (result) checkOrigin();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
        return;
      }
      void result.then((sessionToken) => {
        if (sessionToken) checkOrigin();
        else rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
      }).catch((error) => { logUpgradeFailure(error); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); });
    } catch (error) { logUpgradeFailure(error); rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
  };
  server.on('upgrade', upgradeHandler);

  route('get', '/api/terminal/shells', async (_req, res, creator) => {
    try {
      if (creator) return res.json([{ id: 'bash', name: 'Bash', supportsLogin: false }]);
      const shells = await shellResolver.list();
      res.json(shells.map(({ id, name, supportsLogin }) => ({ id, name, supportsLogin })));
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list terminal shells' });
    }
  });
  route('get', '/api/terminal/sessions', (req, res, creator) => {
    const rawCwd = typeof req.query?.cwd === 'string' ? req.query.cwd.trim() : '';
    const cwdFilter = rawCwd ? path.resolve(rawCwd) : null;
    const list = [];
    for (const session of sessions.values()) {
      if (!sameCreator(session.creator, creator)) continue;
      if (cwdFilter && path.resolve(session.cwd) !== cwdFilter) continue;
      list.push({
        sessionId: session.id,
        cwd: session.cwd,
        status: session.status,
        createdAt: Number.isInteger(session.createdAt) ? session.createdAt : null,
        mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
        purpose: getSessionPurpose(session),
      });
    }
    const pending = [...pendingSessionCreates].filter(([, entry]) => sameCreator(entry.creator, creator)
      && (!cwdFilter || entry.cwd === cwdFilter)).map(([sessionId, entry]) => ({ sessionId, cwd: entry.cwd }));
    res.json({ sessions: list, ...(creator ? { pending } : {}) });
  });
  route('post', '/api/terminal/touch', (req, res, creator) => {
    const rawIds = Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [];
    if (creator && rawIds.some(id => typeof id !== 'string' || !ownedSession(id, creator))) return res.status(404).json({ error: 'Terminal session not found' });
    const now = Date.now();
    let touched = 0;
    for (const id of rawIds) {
      if (typeof id !== 'string') continue;
      const session = ownedSession(id, creator);
      if (!session) continue;
      session.lastActivity = now;
      touched += 1;
    }
    res.json({ touched });
  });
  route('post', '/api/terminal/create', async (req, res, creator) => {
    try {
      const session = await createSession(req.body ?? {}, creator);
      res.json({
        sessionId: session.id,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        mode: session.mode ?? INTERACTIVE_TERMINAL_MODE,
        purpose: getSessionPurpose(session),
      });
    }
    catch (error) { res.status(error?.message === 'Maximum terminal sessions reached' ? 429 : 400).json(errorBody(error, 'Failed to create terminal session')); }
  });
  route('post', '/api/terminal/:sessionId/resize', (req, res, creator) => {
    const session = ownedSession(req.params.sessionId, creator);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const { cols, rows } = req.body ?? {};
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) return res.status(400).json({ error: 'Invalid terminal dimensions' });
    try { if (session.status === 'running') session.process?.resize(cols, rows); session.cols = cols; session.rows = rows; res.json({ success: true, cols, rows }); }
    catch (error) { res.status(500).json({ error: error?.message || 'Failed to resize terminal' }); }
  });
  route('post', '/api/terminal/:sessionId/appearance', (req, res, creator) => {
    const session = ownedSession(req.params.sessionId, creator);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    applyAppearance(session, req.body ?? {});
    res.json({ success: true });
  });
  route('post', '/api/terminal/:sessionId/restart', async (req, res, creator) => {
    const session = ownedSession(req.params.sessionId, creator);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    if (pendingSessionCreates.has(session.id)) return res.status(400).json({ error: 'Terminal creation in progress' });
    if ((session.mode ?? INTERACTIVE_TERMINAL_MODE) === COMMAND_TERMINAL_MODE) return res.status(400).json({ error: 'Command-mode terminal sessions cannot be restarted' });
    const cwd = req.body?.cwd ?? session.cwd;
    const cols = req.body?.cols ?? session.cols;
    const rows = req.body?.rows ?? session.rows;
    const themeMode = req.body?.themeMode ?? session.themeMode;
    const terminalBackground = req.body?.terminalBackground ?? session.terminalBackground;
    const terminalForeground = req.body?.terminalForeground ?? session.terminalForeground;
    const shell = req.body?.shell ?? 'auto';
    const loginShell = req.body?.loginShell ?? false;
    const previousRestart = pendingSessionRestarts.get(session.id) ?? Promise.resolve();
    const restart = previousRestart.catch(() => {}).then(async () => {
      checkDirectory(cwd, creator);
      await validateCwd(cwd);
      if (shutdownPromise || sessions.get(session.id) !== session) throw new Error('Terminal session was closed during restart');
      availableForReplacement(session);
      if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
      if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
      const normalizedShell = normalizeTerminalShell(shell);
      if (!normalizedShell) throw new Error('Invalid terminal shell');
      const oldProcess = session.process;
      const remote = session.remote || typeof oldProcess?.terminate === 'function';
      if (remote) {
        session.closing = true; session.status = 'closing';
        try { await stopRemote(session, oldProcess); }
        finally { session.closing = false; }
        if (shutdownPromise || session.retired || sessions.get(session.id) !== session) throw new Error('Terminal session was closed during restart');
        session.process = null; session.status = 'exited';
      }
      let spawned;
      try { spawned = await spawnPty({ cwd, cols, rows, themeMode, shell: normalizedShell, loginShell, creator }); }
      catch (error) {
        if (error?.code === 'MEMBER_TERMINAL_OUTCOME_UNKNOWN') reserveUnknownAttempt(session, { cwd: path.resolve(cwd) }, error, null);
        throw error;
      }
      if (shutdownPromise || session.retired || sessions.get(session.id) !== session) {
        try { await terminateProcess(spawned.process, true); }
        catch (error) {
          reserveUnknownAttempt(session, { cwd: path.resolve(cwd) }, closureUnknown(error), spawned.process);
          throw session.closureError;
        }
        throw new Error('Terminal session was closed during restart');
      }
      flushOutput(session);
      // Restart stays with the creator. Existing attachments explicitly receive
      // the restart transition before they can observe this generation.
      session.generation = randomUUID();
      for (const connection of connections) {
        const attachment = connection.attachments.get(session.id);
        if (attachment && sameCreator(connection.creator, session.creator)) attachment.generation = session.generation;
      }
      session.process = spawned.process; session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.cwd = cwd; session.cols = cols; session.rows = rows;
      session.remote = typeof spawned.process?.terminate === 'function';
      session.shellExecutable = spawned.shellExecutable;
      session.history = newHistory(); session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; session.status = 'running'; session.exitCode = null; session.signal = null; session.eventQueue.length = 0;
      session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
      wire(session, spawned.process); if (!remote) void terminateProcess(oldProcess); publish(session, { t: 'restarted', history: '' });
      announceSessionsChanged();
    });
    pendingSessionRestarts.set(session.id, restart);
    try {
      await restart;
      res.json({ sessionId: session.id, cols, rows, status: session.status });
    } catch (error) { res.status(400).json(errorBody(error, 'Failed to restart terminal')); }
    finally { if (pendingSessionRestarts.get(session.id) === restart) pendingSessionRestarts.delete(session.id); }
  });
  route('delete', '/api/terminal/:sessionId', async (req, res, creator) => {
    const session = ownedSession(req.params.sessionId, creator);
    const pending = pendingSessionCreates.get(req.params.sessionId);
    if (pending && sameCreator(pending.creator, creator)) pending.cancelled = true;
    if (!session) {
      if (!pending || !sameCreator(pending.creator, creator)) return res.status(404).json({ error: 'Terminal session not found' });
      try { await pending.promise; }
      catch (error) {
        if (error?.message !== 'Terminal session was closed during creation') throw error;
      }
      return res.json({ success: true });
    }
    await closeSession(session, false, 'CLOSED', 'Terminal closed');
    res.json({ success: true });
  });
  route('post', '/api/terminal/force-kill', async (req, res, creator) => {
    const { sessionId, cwd } = req.body ?? {}; let killedCount = 0;
    if ((!sessionId && !cwd) || (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId))
      || (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd)))
      || ['sessionId', 'cwd'].some(key => req.query?.[key] !== undefined && req.query[key] !== req.body?.[key])) return res.status(400).json({ error: 'Explicit terminal selection required' });
    const selected = sessionId && (ownedSession(sessionId, creator) ?? pendingSessionCreates.get(sessionId));
    if (sessionId && (!selected || !sameCreator(selected.creator, creator) || (cwd && path.resolve(selected.cwd) !== path.resolve(cwd)))) return res.status(404).json({ error: 'Terminal session not found' });
    const killedSessionIds = [];
    const pending = [...pendingSessionCreates].filter(([id, entry]) => sameCreator(entry.creator, creator)
      && (sessionId ? id === sessionId : path.resolve(entry.cwd) === path.resolve(cwd)));
    for (const [, entry] of pending) entry.cancelled = true;
    const closures = [];
    for (const [id, session] of sessions) {
      if (!sameCreator(session.creator, creator)) continue;
      if ((sessionId && id !== sessionId) || (!sessionId && cwd && path.resolve(session.cwd) !== path.resolve(cwd))) continue;
      closures.push(closeSession(session, true, 'KILLED', 'Terminal was killed').then(() => { killedSessionIds.push(id); killedCount += 1; }));
    }
    const results = await Promise.allSettled([...closures, ...pending.map(([, entry]) => entry.promise)]);
    const failed = results.find(result => result.status === 'rejected' && result.reason?.message !== 'Terminal session was closed during creation');
    if (failed) throw failed.reason;
    res.json({ success: true, killedCount, killedSessionIds });
    if (killedCount > 0) announceSessionsChanged();
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const attached = [...connections].some((connection) => connection.attachments.has(id));
      if (!attached && !session.closing && !session.closureError && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        void closeSession(session, true, 'IDLE_TIMEOUT', 'Terminal expired after being idle')
          .catch(error => logger.warn?.('Terminal idle closure failed:', error.code ?? error.message));
      }
    }
  }, 5 * 60 * 1000);

  const stop = async () => {
    server.off('upgrade', upgradeHandler); clearInterval(idleSweep);
    for (const session of sessions.values()) { session.retired = true; discardOutput(session); }
    for (const client of wsServer?.clients ?? []) client.terminate();
    for (const pending of pendingSessionCreates.values()) pending.cancelled = true;
    await Promise.allSettled([
      ...[...pendingSessionCreates.values()].map((pending) => pending.promise),
      ...pendingSessionRestarts.values(),
    ]);
    const closureErrors = [...sessions.values()].map(session => session.closureError).filter(Boolean);
    const terminals = [...sessions.values()]
      .filter(session => session.process)
      .map(session => ({ process: session.process, shellExecutable: session.shellExecutable }));
    const hadSessions = sessions.size > 0;
    const results = await Promise.allSettled([shutdownProcesses(terminals), ...pendingTerminations]);
    if (wsServer) {
      for (const client of wsServer.clients) client.terminate();
      let timeout;
      try {
        await Promise.race([
          new Promise((resolve) => wsServer.close(resolve)),
          new Promise((resolve) => { timeout = setTimeout(resolve, 1000); }),
        ]);
      } finally { clearTimeout(timeout); wsServer = null; }
    }
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (closureErrors.length) throw closureErrors[0];
    sessions.clear();
    if (hadSessions) announceSessionsChanged();
  };
  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = stop();
    return shutdownPromise;
  };
  return { shutdown };
}
