import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';
import { createTerminalRuntime } from '../terminal/runtime.js';

const createRuntime = (server, overrides = {}) => {
  const runtime = createGracefulShutdownRuntime({
    process: { exit: vi.fn() },
    shutdownTimeoutMs: 1000,
    getExitOnShutdown: () => false,
    getIsShuttingDown: () => false,
    setIsShuttingDown: vi.fn(),
    syncToHmrState: vi.fn(),
    openCodeWatcherRuntime: { stop: vi.fn() },
    sessionRuntime: { dispose: vi.fn() },
    scheduledTasksRuntime: { stop: vi.fn() },
    getHealthCheckInterval: () => null,
    clearHealthCheckInterval: vi.fn(),
    getTerminalRuntime: () => null,
    setTerminalRuntime: vi.fn(),
    getMessageStreamRuntime: () => null,
    setMessageStreamRuntime: vi.fn(),
    shouldSkipOpenCodeStop: () => true,
    getOpenCodePort: () => null,
    getOpenCodeProcess: () => null,
    setOpenCodeProcess: vi.fn(),
    killProcessOnPort: vi.fn(),
    waitForPortRelease: vi.fn(async () => true),
    getServer: () => server,
    getUiAuthController: () => null,
    setUiAuthController: vi.fn(),
    getActiveTunnelController: () => null,
    setActiveTunnelController: vi.fn(),
    tunnelAuthController: { clearActiveTunnel: vi.fn() },
    beginGuestServiceShutdown: vi.fn(),
    stopAllGuestServices: vi.fn(),
    getGuestSurfaceRuntime: () => null,
    getRealtimeProxyRuntime: () => null,
    getDictationRuntime: () => null,
    getRelayService: () => null,
    getRelayReconcileTimer: () => null,
    ...overrides,
  });
  if (server instanceof http.Server) runtime.trackServerConnections(server);
  return runtime;
};

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

async function memberTerminalFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-coordinator-'));
  const fixture = { root, stop: Promise.withResolvers(), started: Promise.withResolvers() };
  onTestFinished(async () => {
    fixture.stop.resolve();
    fixture.readiness?.resolve();
    try {
      await fixture.shutdown?.catch(() => {});
      await fixture.terminal?.shutdown().catch(() => {});
    } finally {
      fixture.server?.closeAllConnections();
      if (fixture.server?.listening) await new Promise(resolve => fixture.server.close(resolve));
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  fixture.routes = { get: new Map(), post: new Map(), delete: new Map() };
  fixture.server = http.createServer();
  fixture.remote = {
    terminate: vi.fn(() => { fixture.started.resolve(); return fixture.stop.promise; }),
    onData() {}, onExit(fn) { fixture.emitExit = fn; },
    get pid() { throw new Error('Remote handles cannot enter local census'); },
    kill() { throw new Error('kill is not a remote closure receipt'); },
  };
  fixture.spawn = vi.fn(async () => ({ process: fixture.remote, backend: 'member-systemd', shell: 'bash', shellExecutable: '/bin/bash', loginShell: false }));
  fixture.terminal = createTerminalRuntime({
    app: Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (route, handler) => fixture.routes[method].set(route, handler)])),
    server: fixture.server, fs, path,
    terminalContext: { authenticate: () => ({ memberID: 'alice', accountID: '11', directory: root }) },
    spawnMemberTerminal: fixture.spawn,
    buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false,
    isRequestOriginAllowed: () => true, rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30000,
  });
  const created = response();
  await fixture.routes.post.get('/api/terminal/create')({ body: { sessionId: 'member', cwd: root } }, created);
  expect(created.statusCode).toBe(200);
  await new Promise(resolve => fixture.server.listen(0, 'localhost', resolve));
  return fixture;
}

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([['restart', false], ['restart', true], ['create', false], ['create', true]])('propagates no-handle unknown %s replacement through coordinator shutdown (daemon exit: %s)', async (entry, exitProcess) => {
    const f = await memberTerminalFixture();
    const original = Object.assign(new Error('Replacement readiness and cleanup unknown'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
    const entered = Promise.withResolvers();
    f.readiness = Promise.withResolvers();
    f.spawn.mockImplementationOnce(async () => { entered.resolve(); await f.readiness.promise; throw original; });
    const restarted = response();
    if (entry === 'create') f.emitExit({ exitCode: 0 });
    const replacement = entry === 'restart'
      ? f.routes.post.get('/api/terminal/:sessionId/restart')({ params: { sessionId: 'member' }, body: {} }, restarted)
      : f.routes.post.get('/api/terminal/create')({ body: { sessionId: 'member', cwd: f.root } }, restarted);
    f.stop.resolve();
    await entered.promise;
    const exit = vi.fn(), clear = vi.fn(), auth = vi.fn();
    const coordinator = createRuntime(f.server, {
      process: { exit }, getTerminalRuntime: () => f.terminal, setTerminalRuntime: clear,
      getUiAuthController: () => ({ dispose: auth }),
    });
    f.shutdown = coordinator.gracefulShutdown({ exitProcess });
    f.shutdown.catch(() => {});
    f.readiness.resolve();
    await replacement;
    expect(restarted.body.code).toBe(original.code);
    await expect(f.shutdown).rejects.toBe(original);
    expect(clear).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledOnce();
    expect(f.server.listening).toBe(false);
    expect(coordinator.gracefulShutdown({ exitProcess })).toBe(f.shutdown);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.remote.terminate).toHaveBeenCalledTimes(entry === 'restart' ? 1 : 0);
    if (exitProcess) expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    else expect(exit).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves actual remote terminal failure through complete server teardown (daemon exit: %s)', async (exitProcess) => {
    const f = await memberTerminalFixture();
    const original = Object.assign(new Error('Native member closure unknown'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
    let currentTerminal = f.terminal, shuttingDown = false;
    const order = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const record = name => vi.fn(() => { order.push(name); });
    const exit = record('exit');
    const setTerminalRuntime = vi.fn(value => { currentTerminal = value; });
    const stream = vi.fn(async () => { order.push('stream'); throw new Error('Existing best-effort stream failure'); });
    const processClose = vi.fn(async () => { order.push('managed'); });
    const auth = record('auth'), tunnel = record('tunnel');
    f.server.once('close', () => order.push('http'));
    const coordinator = createRuntime(f.server, {
      process: { exit }, getIsShuttingDown: () => shuttingDown,
      setIsShuttingDown: value => { shuttingDown = value; },
      getTerminalRuntime: () => currentTerminal, setTerminalRuntime,
      stopAllGuestServices: async () => { order.push('guests'); throw new Error('Existing best-effort guest failure'); },
      getMessageStreamRuntime: () => ({ close: stream }), setMessageStreamRuntime: vi.fn(),
      shouldSkipOpenCodeStop: () => false, getOpenCodeProcess: () => ({ close: processClose }),
      getUiAuthController: () => ({ dispose: auth }),
      getActiveTunnelController: () => ({ stop: tunnel }),
    });
    f.shutdown = coordinator.gracefulShutdown({ exitProcess });
    f.shutdown.catch(() => {});
    await f.started.promise;
    expect(coordinator.gracefulShutdown({ exitProcess })).toBe(f.shutdown);
    expect(stream).not.toHaveBeenCalled();
    expect(f.server.listening).toBe(true);
    f.stop.reject(original);
    await expect(f.shutdown).rejects.toBe(original);
    expect(order).toEqual(['guests', 'stream', 'managed', 'http', 'auth', 'tunnel', ...(exitProcess ? ['exit'] : [])]);
    expect(f.server.listening).toBe(false);
    expect(currentTerminal).toBe(f.terminal);
    expect(setTerminalRuntime).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith('Graceful shutdown complete');
    if (exitProcess) expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    else expect(exit).not.toHaveBeenCalled();
    const listed = response();
    await f.routes.get.get('/api/terminal/sessions')({ query: {} }, listed);
    expect(listed.body.sessions.map(session => session.sessionId)).toEqual(['member']);
    const retry = response();
    await f.routes.post.get('/api/terminal/create')({ body: { sessionId: 'member', cwd: f.root } }, retry);
    expect(retry.statusCode).toBe(400);
    expect(f.spawn).toHaveBeenCalledOnce();
    const repeated = coordinator.gracefulShutdown({ exitProcess: !exitProcess });
    expect(repeated).toBe(f.shutdown);
    await expect(repeated).rejects.toBe(original);
    expect(f.remote.terminate).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(auth).toHaveBeenCalledOnce();
    expect(tunnel).toHaveBeenCalledOnce();
    if (exitProcess) expect(exit).toHaveBeenCalledOnce();
    else expect(exit).not.toHaveBeenCalled();
  });

  it.each([false, true])('clears a successfully stopped actual terminal runtime (daemon exit: %s)', async (exitProcess) => {
    const f = await memberTerminalFixture();
    let currentTerminal = f.terminal;
    const exit = vi.fn(), setTerminalRuntime = vi.fn(value => { currentTerminal = value; });
    const coordinator = createRuntime(f.server, {
      process: { exit }, getTerminalRuntime: () => currentTerminal, setTerminalRuntime,
    });
    f.shutdown = coordinator.gracefulShutdown({ exitProcess });
    await f.started.promise;
    f.stop.resolve();
    await f.shutdown;
    expect(currentTerminal).toBe(null);
    expect(setTerminalRuntime).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.server.listening).toBe(false);
    if (exitProcess) expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    else expect(exit).not.toHaveBeenCalled();
    expect(coordinator.gracefulShutdown({ exitProcess })).toBe(f.shutdown);
    expect(f.remote.terminate).toHaveBeenCalledOnce();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes an active HTTP stream instead of waiting for the shutdown deadline', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: fixture\n\n');
    });
    const runtime = createRuntime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const request = http.get(`http://127.0.0.1:${server.address().port}`);
    request.on('error', () => {});
    const response = await new Promise((resolve) => request.once('response', resolve));
    response.resume();
    const closed = new Promise((resolve) => response.once('close', resolve));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runtime.gracefulShutdown({ exitProcess: false });
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await closed;
    } finally {
      request.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([false, true])('closes upgraded sockets without the HTTP timeout (handshake completed: %s)', async (completeHandshake) => {
    const server = http.createServer();
    const runtime = createRuntime(server);
    const sockets = new Set();
    server.on('upgrade', (_request, socket) => {
      sockets.add(socket);
      if (completeHandshake) {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      }
      // A listener for another WS route can leave the upgrade unanswered.
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', () => {});
    client.resume();
    const clientClosed = once(client, 'close');
    const upgraded = once(server, 'upgrade');
    client.write('GET /api/global/event/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    await upgraded;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runtime.gracefulShutdown({ exitProcess: false });
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await clientClosed;
      const connections = await new Promise((resolve, reject) => {
        server.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      expect(connections).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('drains processes before closing sockets accepted during cleanup, including after a cleanup failure', async () => {
    const server = http.createServer();
    const cleanupStarted = Promise.withResolvers();
    const finishCleanup = Promise.withResolvers();
    const sockets = new Set();
    const clients = [];
    server.on('upgrade', (_request, socket) => sockets.add(socket));
    const terminalShutdown = vi.fn(async () => {
      expect([...sockets].every((socket) => !socket.destroyed)).toBe(true);
    });
    const processClose = vi.fn(async () => {
      expect(terminalShutdown).toHaveBeenCalledOnce();
      expect([...sockets].every((socket) => !socket.destroyed)).toBe(true);
    });
    const runtime = createRuntime(server, {
      stopAllGuestServices: async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        throw new Error('fixture cleanup failure');
      },
      getTerminalRuntime: () => ({ shutdown: terminalShutdown }),
      shouldSkipOpenCodeStop: () => false,
      getOpenCodeProcess: () => ({ close: processClose }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const shutdown = runtime.gracefulShutdown({ exitProcess: false });
    expect(runtime.gracefulShutdown({ exitProcess: false })).toBe(shutdown);
    await cleanupStarted.promise;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const closed = [];
      for (let index = 0; index < 8; index += 1) {
        const client = net.connect(server.address().port, '127.0.0.1');
        clients.push(client);
        client.resume();
        closed.push(once(client, 'close'));
        const upgraded = once(server, 'upgrade');
        client.write('GET /api/global/event/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        await upgraded;
      }
      expect(sockets.size).toBe(8);
      expect(processClose).not.toHaveBeenCalled();
      finishCleanup.resolve();
      await shutdown;
      expect(processClose).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await Promise.all(closed);
      expect(server.listening).toBe(false);
    } finally {
      finishCleanup.resolve();
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.destroy();
      await shutdown;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('stops guest services during shutdown', async () => {
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };
    const stopAllGuestServices = vi.fn(async () => {});

    const runtime = createRuntime(server, { stopAllGuestServices });
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(stopAllGuestServices).toHaveBeenCalledTimes(1);
  });

  it('continues shutdown when stopping guest services fails', async () => {
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };
    const stopAllGuestServices = vi.fn(async () => {
      throw new Error('guest teardown failed');
    });
    const terminalRuntime = { shutdown: vi.fn(async () => {}) };

    const runtime = createRuntime(server, {
      stopAllGuestServices,
      getTerminalRuntime: () => terminalRuntime,
    });
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(stopAllGuestServices).toHaveBeenCalledTimes(1);
    expect(terminalRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalled();
  });

  it('closes guest admission synchronously and cleans every runtime once across repeated shutdown calls', async () => {
    vi.useFakeTimers();
    const order = [];
    const cleanup = (name) => vi.fn(() => { order.push(name); });
    const viewers = { stop: cleanup('viewers') };
    const proxy = { stop: cleanup('proxy') };
    const dictation = { stop: cleanup('dictation') };
    const relay = { stop: cleanup('relay') };
    const gate = cleanup('gate');
    const guests = cleanup('guests');
    const reconcile = vi.fn();
    const timer = setInterval(reconcile, 100);
    const runtime = createRuntime(null, {
      beginGuestServiceShutdown: gate,
      stopAllGuestServices: guests,
      getGuestSurfaceRuntime: () => viewers,
      getRealtimeProxyRuntime: () => proxy,
      getDictationRuntime: () => dictation,
      getRelayService: () => relay,
      getRelayReconcileTimer: () => timer,
    });
    const first = runtime.gracefulShutdown();
    expect(gate).toHaveBeenCalledTimes(1);
    expect(runtime.gracefulShutdown()).toBe(first);
    await first;
    await runtime.gracefulShutdown();
    expect(order).toEqual(['gate', 'viewers', 'proxy', 'relay', 'dictation', 'guests']);
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates failed viewer and relay cleanup and still drains guests and exits', async () => {
    const stop = vi.fn(() => { throw new Error('stop failed'); });
    const stopAllGuestServices = vi.fn(async () => {});
    const dictation = { stop: vi.fn() };
    const process = { exit: vi.fn() };
    const runtime = createRuntime(null, {
      process,
      getGuestSurfaceRuntime: () => ({ stop }),
      getRelayService: () => ({ stop }),
      getDictationRuntime: () => dictation,
      stopAllGuestServices,
    });
    await runtime.gracefulShutdown({ exitProcess: true });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(dictation.stop).toHaveBeenCalledTimes(1);
    expect(stopAllGuestServices).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
