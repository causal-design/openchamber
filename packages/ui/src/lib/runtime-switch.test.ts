import { describe, expect, spyOn, test } from 'bun:test';
import {
  getRuntimeApiBaseUrl,
  getRuntimeKey,
  initializeRuntimeEndpoint,
  isSshForwardedRuntime,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
  switchRuntimeEndpoint,
} from './runtime-switch';
import { acquireRuntimeUrlAuthToken, clearRuntimeAuthCredentialProvider, clearRuntimeUrlAuthToken, getRuntimeUrlAuthTokenSync, refreshRuntimeUrlAuthToken, setRuntimeExtraHeaders } from './runtime-auth';
import { getRuntimeUrlResolver } from './runtime-url';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayDescriptor,
} from './relay/runtime-tunnel';

describe('runtime endpoint switching', () => {
  test('uses the injected SSH forward at boot and replaces it on host switches', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const forwarded = 'http://127.0.0.1:54000';
    try {
      globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });
      const runtimeWindow = { __OPENCHAMBER_API_BASE_URL__: forwarded, dispatchEvent: () => true };
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      initializeRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1' });
      expect(isSshForwardedRuntime()).toBe(false);
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_SSH_FORWARD_API_URL__', { value: forwarded });
      expect(isSshForwardedRuntime()).toBe(true);
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1', sshForwarded: true });
      expect(isSshForwardedRuntime()).toBe(true);
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:local-2' });
      expect(isSshForwardedRuntime()).toBe(false);
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1', sshForwarded: true });
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1', clientToken: 'new-token' });
      expect(isSshForwardedRuntime()).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('exposes a credential-free copy of the active relay descriptor', () => {
    const descriptor = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      grant: 'one-time-secret',
    };

    try {
      activateRelayTunnel(descriptor);
      const exposed = getActiveRelayDescriptor();
      expect(exposed).toEqual({
        relayUrl: descriptor.relayUrl,
        serverId: descriptor.serverId,
        hostEncPubJwk: descriptor.hostEncPubJwk,
      });
      expect(exposed).not.toBe(descriptor);
      expect(exposed?.hostEncPubJwk).not.toBe(descriptor.hostEncPubJwk);
    } finally {
      deactivateRelayTunnel();
    }
  });

  test('notifies listeners before and after mutating the active endpoint', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const events = new EventTarget();
    const runtimeWindow = {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };

    try {
      globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      const observed: Array<[string, string, string]> = [];
      const unsubscribeWillChange = subscribeRuntimeEndpointWillChange((detail) => {
        observed.push(['will-change', getRuntimeKey(), detail.previousRuntimeKey]);
      });
      const unsubscribeChanged = subscribeRuntimeEndpointChanged((detail) => {
        observed.push(['changed', getRuntimeKey(), detail.runtimeKey]);
      });

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' });

      expect(observed).toEqual([
        ['will-change', 'runtime-a', 'runtime-a'],
        ['changed', 'runtime-b', 'runtime-b'],
      ]);
      unsubscribeWillChange();
      unsubscribeChanged();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('does not throw when Electron preload globals are read-only', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const runtimeWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    try {
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => new Response(JSON.stringify({ token: 'url-token', expiresAt: Date.now() + 60_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', {
        configurable: true,
        value: 'http://127.0.0.1:3000',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_CLIENT_TOKEN__', {
        configurable: true,
        value: '',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_RUNTIME_HEADERS__', {
        configurable: true,
        value: {},
        writable: false,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      let thrown: unknown = null;
      try {
        switchRuntimeEndpoint({
          apiBaseUrl: 'https://remote.example',
          clientToken: 'client-token',
          requestHeaders: null,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(getRuntimeApiBaseUrl()).toBe('https://remote.example');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  for (const mode of ['token', 'cookie'] as const) {
    test(`default ${mode} auth follows the active runtime with read-only preload and rejects stale responses`, async () => {
      const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const previousFetch = globalThis.fetch;
      const previousSetTimeout = globalThis.setTimeout;
      const timerHandles: Array<ReturnType<typeof setTimeout>> = [];
      const timers = spyOn(globalThis, 'setTimeout');
      timers.mockImplementation(new Proxy(previousSetTimeout, {
        apply(target, _receiver: unknown, args: Parameters<typeof setTimeout>) {
          const handle = target(...args);
          timerHandles.push(handle);
          return handle;
        },
      }));
      const boot = 'http://127.0.0.1:3000';
      const remote = 'https://remote.example';
      const next = 'https://next.example';
      const runtimeWindow: { dispatchEvent: () => boolean; __OPENCHAMBER_API_BASE_URL__?: string } = { dispatchEvent: () => true };
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', { value: boot, writable: false });
      const requests: string[] = [];
      const payload = (base: string) => mode === 'cookie'
        ? { authenticated: true, disabled: true, authMode: 'cookie' }
        : { token: `${base}-url-token`, expiresAt: Date.now() + 60_000 };
      let release = () => {};
      try {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
        globalThis.fetch = async input => {
          const url = new URL(String(input));
          requests.push(url.origin);
          return Response.json(payload(url.origin));
        };
        switchRuntimeEndpoint({ apiBaseUrl: remote, clientToken: 'synthetic-client' });
        const expected = mode === 'cookie' ? '' : `${remote}-url-token`;
        expect(await refreshRuntimeUrlAuthToken(remote)).toBe(expected);
        expect(await refreshRuntimeUrlAuthToken()).toBe(expected);
        expect(getRuntimeUrlAuthTokenSync()).toBe(expected);
        const scheduledCount = timers.mock.calls.length;
        const handleCount = timerHandles.length;
        release = acquireRuntimeUrlAuthToken();
        if (mode === 'cookie') {
          expect(timers.mock.calls.length).toBe(scheduledCount);
        } else {
          expect(timers.mock.calls.length).toBe(scheduledCount + 1);
          // Drive the scheduled refresh deterministically, without waiting for TTL.
          const timer = timerHandles[handleCount];
          if (timer === undefined) throw new Error('Scheduled timer was not created');
          clearTimeout(timer);
          const callback = timers.mock.calls[scheduledCount][0];
          callback();
          expect(await refreshRuntimeUrlAuthToken()).toBe(expected);
          await Promise.resolve();
        }
        release();
        expect(requests).toEqual(mode === 'cookie' ? [remote] : [remote, remote]);
        const asset = new URL(getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw'));
        expect(asset.origin).toBe(remote);
        expect(asset.searchParams.get('oc_url_token')).toBe(mode === 'cookie' ? null : expected);
        expect(runtimeWindow.__OPENCHAMBER_API_BASE_URL__).toBe(boot);

        clearRuntimeUrlAuthToken();
        let respond!: (response: Response) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        globalThis.fetch = async input => {
          const origin = new URL(String(input)).origin;
          expect([remote, next]).toContain(origin);
          if (origin === next) return Response.json(payload(next));
          return new Promise<Response>(resolve => { respond = resolve; started(); });
        };
        const stale = refreshRuntimeUrlAuthToken();
        const settled = Promise.allSettled([stale]);
        await ready;
        switchRuntimeEndpoint({ apiBaseUrl: next, clientToken: 'synthetic-next-client' });
        expect(await refreshRuntimeUrlAuthToken()).toBe(mode === 'cookie' ? '' : `${next}-url-token`);
        respond(Response.json(payload(remote)));
        const [result] = await settled;
        expect(result.status === 'rejected' && result.reason.message.includes('stale')).toBe(true);
        expect(getRuntimeUrlAuthTokenSync()).toBe(mode === 'cookie' ? '' : `${next}-url-token`);
      } finally {
        release();
        for (const handle of timerHandles) clearTimeout(handle);
        timers.mockRestore();
        globalThis.fetch = previousFetch;
        clearRuntimeAuthCredentialProvider();
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    });
  }
});
