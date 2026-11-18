import { describe, expect, spyOn, test } from 'bun:test';
import {
  buildRuntimeAuthHeaders,
  clearRuntimeAuthCredentialProvider,
  clearRuntimeUrlAuthToken,
  getRuntimeBearerTokenSync,
  getRuntimeUrlAuthTokenSync,
  acquireRuntimeUrlAuthToken,
  mintGuestFrameUrlAuthToken,
  refreshRuntimeUrlAuthToken,
  refreshLocalRuntimeUrlAuthToken,
  getLocalRuntimeUrlAuthTokenSync,
  setRuntimeAuthCredentialProvider,
  setRuntimeBearerToken,
  setRuntimeExtraHeaders,
} from './runtime-auth';
import { createRuntimeUrlResolver } from './runtime-url';
import * as runtimeTunnel from './relay/runtime-tunnel';

describe('runtime auth headers', () => {
  test('concurrent cookie-auth preparation shares one mint and clearing rejects late responses', async () => {
    const previousFetch = globalThis.fetch;
    let respond!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    try {
      clearRuntimeAuthCredentialProvider();
      globalThis.fetch = async () => {
        calls++;
        return new Promise<Response>(resolve => { respond = resolve; started(); });
      };
      const a = refreshRuntimeUrlAuthToken('https://runtime.example');
      await ready;
      const b = refreshRuntimeUrlAuthToken('https://runtime.example');
      await Promise.resolve();
      expect(calls).toBe(1);
      const rejected = Promise.allSettled([a, b]);
      clearRuntimeUrlAuthToken();
      respond(Response.json({ authenticated: true, disabled: true, authMode: 'cookie' }));
      const results = await rejected;
      expect(results.every(result => result.status === 'rejected' && result.reason.message.includes('stale'))).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('cookie-authenticated assets prepare without a token or a refresh loop', async () => {
    const previousFetch = globalThis.fetch;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let release = () => {};
    let fetchCount = 0;
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { __OPENCHAMBER_API_BASE_URL__: 'https://runtime.example' } });
      clearRuntimeAuthCredentialProvider();
      globalThis.fetch = async (_input, init) => {
        fetchCount++;
        expect(init?.credentials).toBe('include');
        return Response.json({ authenticated: true, disabled: true, authMode: 'cookie' });
      };
      expect(await refreshRuntimeUrlAuthToken('https://runtime.example')).toBe('');
      const scheduledCount = timer.mock.calls.length;
      release = acquireRuntimeUrlAuthToken('https://runtime.example');
      expect(timer.mock.calls.length).toBe(scheduledCount);
      expect(getRuntimeUrlAuthTokenSync()).toBe('');
      expect(await refreshRuntimeUrlAuthToken('https://runtime.example')).toBe('');
      const url = createRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' }).authenticatedAsset('/api/fs/raw', { path: '/repo/book.pdf' });
      expect(new URL(url).searchParams.has('oc_url_token')).toBe(false);
      expect(getRuntimeBearerTokenSync()).toBe('');
      expect(fetchCount).toBe(1);
      release();
      clearRuntimeUrlAuthToken();
      await refreshRuntimeUrlAuthToken('https://runtime.example');
      expect(fetchCount).toBe(2);
      setRuntimeBearerToken('new-runtime');
      await refreshRuntimeUrlAuthToken('https://runtime.example');
      expect(fetchCount).toBe(3);
      setRuntimeExtraHeaders({ 'X-Runtime': 'changed' });
      await refreshRuntimeUrlAuthToken('https://runtime.example');
      expect(fetchCount).toBe(4);
    } finally {
      release();
      timer.mockRestore();
      globalThis.fetch = previousFetch;
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('cookie mode is endpoint scoped and late cookie responses cannot cross a runtime reset', async () => {
    const previousFetch = globalThis.fetch;
    let resolveA!: (response: Response) => void;
    try {
      clearRuntimeAuthCredentialProvider();
      globalThis.fetch = async (input) => String(input).includes('runtime-a')
        ? new Promise<Response>(resolve => { resolveA = resolve; })
        : Response.json({ token: 'token-b', expiresAt: Date.now() + 60_000 });
      const pendingA = refreshRuntimeUrlAuthToken('https://runtime-a.example');
      await Promise.resolve();
      expect(await refreshRuntimeUrlAuthToken('https://runtime-b.example')).toBe('token-b');
      resolveA(Response.json({ authenticated: true, disabled: true, authMode: 'cookie' }));
      await expect(pendingA).rejects.toThrow('stale');
      expect(getRuntimeUrlAuthTokenSync()).toBe('token-b');

      clearRuntimeUrlAuthToken();
      globalThis.fetch = async () => Response.json({ authenticated: true, disabled: true, authMode: 'cookie' });
      await refreshRuntimeUrlAuthToken('https://runtime-a.example');
      globalThis.fetch = async () => Response.json({ token: 'token-b', expiresAt: Date.now() + 60_000 });
      expect(await refreshRuntimeUrlAuthToken('https://runtime-b.example')).toBe('token-b');

      clearRuntimeUrlAuthToken();
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      globalThis.fetch = async () => new Promise<Response>(resolve => { resolveA = resolve; started(); });
      const stale = refreshRuntimeUrlAuthToken('https://runtime-a.example');
      await ready;
      clearRuntimeAuthCredentialProvider();
      resolveA(Response.json({ authenticated: true, disabled: true, authMode: 'cookie' }));
      await expect(stale).rejects.toThrow('stale');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('ambiguous cookie responses and token-only scopes still fail closed', async () => {
    const previousFetch = globalThis.fetch;
    try {
      for (const body of [null, {}, { authenticated: true, disabled: true }, { authMode: 'cookie' },
        { authenticated: false, disabled: true, authMode: 'cookie' },
        { authenticated: true, disabled: true, authMode: 'cookie', token: 'unexpected' }]) {
        clearRuntimeUrlAuthToken();
        globalThis.fetch = async () => Response.json(body);
        await expect(refreshRuntimeUrlAuthToken('https://runtime.example')).rejects.toThrow('invalid');
      }
      globalThis.fetch = async () => Response.json({ authenticated: true, disabled: true, authMode: 'cookie' });
      await expect(mintGuestFrameUrlAuthToken('guest-a')).rejects.toThrow('invalid');
      await expect(refreshLocalRuntimeUrlAuthToken('http://localhost:3001')).rejects.toThrow('invalid');
      clearRuntimeUrlAuthToken();
      globalThis.fetch = async () => new Response(null, { status: 401 });
      await expect(refreshRuntimeUrlAuthToken('https://runtime.example')).rejects.toThrow('(401)');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('relay minting keeps its real token contract and rejects cookie mode', async () => {
    let cookieResponse = false;
    const relay = spyOn(runtimeTunnel, 'getActiveRelayTunnel');
    relay.mockReturnValue({
      fetch: async (route, init) => {
        expect(route).toBe('/auth/url-token');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer relay-client');
        return Response.json(cookieResponse
          ? { authenticated: true, disabled: true, authMode: 'cookie' }
          : { token: 'relay-url-token', expiresAt: Date.now() + 60_000 });
      },
      openWebSocket: () => { throw new Error('No socket expected'); },
      getStatus: () => ({ state: 'connected' }),
      subscribeStatus: () => () => {},
      retry: () => {},
      close: () => {},
    });
    try {
      setRuntimeBearerToken('relay-client');
      expect(await refreshRuntimeUrlAuthToken('https://relay-runtime.example')).toBe('relay-url-token');
      clearRuntimeUrlAuthToken();
      cookieResponse = true;
      await expect(refreshRuntimeUrlAuthToken('https://relay-runtime.example')).rejects.toThrow('invalid');
    } finally {
      relay.mockRestore();
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not add authorization by default', async () => {
    clearRuntimeAuthCredentialProvider();
    const headers = await buildRuntimeAuthHeaders({ Accept: 'application/json' });

    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.has('Authorization')).toBe(false);
  });

  test('adds bearer token when configured', async () => {
    try {
      setRuntimeBearerToken('token-123');
      const headers = await buildRuntimeAuthHeaders();

      expect(headers.get('Authorization')).toBe('Bearer token-123');
    } finally {
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('preserves explicit authorization header', async () => {
    try {
      setRuntimeAuthCredentialProvider(() => ({ type: 'bearer', token: 'runtime-token' }));
      const headers = await buildRuntimeAuthHeaders({ Authorization: 'Bearer explicit-token' });

      expect(headers.get('Authorization')).toBe('Bearer explicit-token');
    } finally {
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('falls back to injected desktop client token', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      clearRuntimeAuthCredentialProvider();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { __OPENCHAMBER_CLIENT_TOKEN__: ' injected-token ' },
      });

      expect(getRuntimeBearerTokenSync()).toBe('injected-token');

      const headers = await buildRuntimeAuthHeaders();
      expect(headers.get('Authorization')).toBe('Bearer injected-token');
    } finally {
      clearRuntimeAuthCredentialProvider();
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('adds runtime extra headers without overriding bearer authorization', async () => {
    try {
      setRuntimeBearerToken('runtime-token');
      setRuntimeExtraHeaders({
        'CF-Access-Client-Id': 'client-id',
        Authorization: 'Bearer proxy-token',
      });

      const headers = await buildRuntimeAuthHeaders();

      expect(headers.get('CF-Access-Client-Id')).toBe('client-id');
      expect(headers.get('Authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('sends runtime extra headers when minting URL auth tokens', async () => {
    const previousFetch = globalThis.fetch;
    let seenUrl = '';
    let seenHeaders = new Headers();
    try {
      clearRuntimeUrlAuthToken();
      setRuntimeBearerToken('runtime-token');
      setRuntimeExtraHeaders({
        'CF-Access-Client-Id': 'client-id',
        Authorization: 'Bearer proxy-token',
      });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ token: 'url-token', expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const token = await refreshRuntimeUrlAuthToken('https://runtime.example');

      expect(token).toBe('url-token');
      expect(seenUrl).toBe('https://runtime.example/auth/url-token');
      expect(seenHeaders.get('CF-Access-Client-Id')).toBe('client-id');
      expect(seenHeaders.get('Authorization')).toBe('Bearer runtime-token');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not remint URL auth token when setting equivalent empty runtime headers', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      clearRuntimeUrlAuthToken();
      setRuntimeBearerToken('runtime-token');
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ token: `url-token-${fetchCount}`, expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const firstToken = await refreshRuntimeUrlAuthToken('https://runtime.example');
      setRuntimeExtraHeaders({});
      const secondToken = await refreshRuntimeUrlAuthToken('https://runtime.example');

      expect(firstToken).toBe('url-token-1');
      expect(secondToken).toBe('url-token-1');
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('keeps a fresh URL token when the server clock is behind this device', async () => {
    const previousFetch = globalThis.fetch;
    try {
      clearRuntimeUrlAuthToken();
      setRuntimeBearerToken('runtime-token');
      // Server clock 90 s behind: its absolute expiry is already past here.
      const mintFromSlowServerClock: typeof fetch = async () => Response.json({
        token: 'fresh-url-token',
        expiresAt: Date.now() - 30_000,
        expiresIn: 60_000,
      });
      globalThis.fetch = mintFromSlowServerClock;

      await refreshRuntimeUrlAuthToken('https://runtime.example');
      const socketUrl = new URL(createRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' }).websocket('/api/terminal/ws'));

      expect(socketUrl.searchParams.get('oc_url_token')).toBe('fresh-url-token');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('never reuses a local URL token for another origin', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      clearRuntimeUrlAuthToken();
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCount += 1;
        const origin = new URL(String(input)).origin;
        return Response.json({ token: `${origin}-token`, expiresAt: Date.now() + 60_000 });
      }) as typeof fetch;

      const a = await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001');
      const b = await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002');

      expect(a).toBe('http://127.0.0.1:3001-token');
      expect(b).toBe('http://127.0.0.1:3002-token');
      expect(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3001')).toBe('');
      expect(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3002')).toBe(b);
      expect(fetchCount).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
    }
  });

  test('rejects a local mint that completes after switching origins', async () => {
    const previousFetch = globalThis.fetch;
    let resolveA!: (response: Response) => void;
    try {
      clearRuntimeUrlAuthToken();
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const origin = new URL(String(input)).origin;
        if (origin.endsWith(':3001')) return new Promise<Response>((resolve) => { resolveA = resolve; });
        return Promise.resolve(Response.json({ token: 'token-b', expiresAt: Date.now() + 60_000 }));
      }) as typeof fetch;

      const requestA = refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001');
      const tokenB = await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002');
      resolveA(Response.json({ token: 'token-a', expiresAt: Date.now() + 60_000 }));

      expect(tokenB).toBe('token-b');
      await expect(requestA).rejects.toThrow('stale');
      expect(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3002')).toBe('token-b');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
    }
  });
});
