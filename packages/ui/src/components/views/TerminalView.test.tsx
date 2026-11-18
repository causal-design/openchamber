import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { CreateTerminalOptions, ResizeTerminalPayload, RestartTerminalOptions, TerminalAPI, TerminalHandlers } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { noteSpaceCreationRequest, resetSpaceCreationRequests } from '@/lib/spaces/space-creation-requests';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';

let effectiveDirectory = '/repo';
const openContextPreviewCalls: Array<[string, string]> = [];
const createSessionCalls: Array<{ cwd: string }> = [];
const createSessionOptions: CreateTerminalOptions[] = [];
const resizeCalls: ResizeTerminalPayload[] = [];
const inputCalls: Array<{ sessionId: string; input: string; directory?: string | null }> = [];
const restartCalls: Array<{ sessionId: string; options: RestartTerminalOptions }> = [];
let createFailure: Error | null = null;
let pendingCreate: Promise<void> | null = null;
let pendingRestart: Promise<void> | null = null;
const connectCalls: string[] = [];
const closeCalls: string[] = [];
const ensureDirectoryCalls: string[] = [];
const openContextPreview = (directory: string, url: string) => {
  openContextPreviewCalls.push([directory, url]);
};
const createSession = async (options: CreateTerminalOptions) => {
  const { cwd } = options;
  createSessionCalls.push({ cwd });
  createSessionOptions.push(options);
  if (pendingCreate) await pendingCreate;
  if (createFailure) throw createFailure;
  return { sessionId: 'unused', cols: 80, rows: 24, status: 'running' as const };
};
let connectBehavior: (sessionId: string, handlers: TerminalHandlers) => { close: () => void } = () => ({ close: () => undefined });
const restartSession = async (sessionId: string, options: RestartTerminalOptions) => {
  restartCalls.push({ sessionId, options });
  if (pendingRestart) await pendingRestart;
  return { sessionId, cols: options.cols ?? 80, rows: options.rows ?? 24, status: 'running' as const };
};
const terminalRuntime: TerminalAPI = {
  createSession,
  sendInput: async (sessionId: string, input: string, directory?: string | null) => { inputCalls.push({ sessionId, input, directory }); },
  resize: async (payload: ResizeTerminalPayload) => { resizeCalls.push(payload); },
  restartSession,
  close: async (sessionId: string) => { closeCalls.push(sessionId); },
  updateAppearance: async () => undefined,
  connect: (sessionId: string, handlers: TerminalHandlers) => {
    connectCalls.push(sessionId);
    return connectBehavior(sessionId, handlers);
  },
};
const runtimeApis = {
  runtime: { platform: 'web' as const },
  terminal: terminalRuntime,
};
const i18n = { t: (key: string, values?: { message?: string }) => values?.message ? `${key}: ${values.message}` : key };
let resizeViewport: ((cols: number, rows: number) => void) | null = null;
type ViewportCallbacks = {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onProvisionalSize: (cols: number, rows: number) => void;
};
const viewportCallbacks = new Map<string, ViewportCallbacks>();
type ViewportGrid = { cols: number; rows: number };
const viewportGrids = new Map<string, ViewportGrid>();
const viewportSurfaces = new Map<string, { fit: (cols: number, rows: number) => void; flushResize: () => void; deliveries: () => number }>();
let autoFitViewport = true;
let deferViewportResize = false;
let flushViewportOnDispose = false;
let deviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };
const pasteClipboardCalls: string[] = [];

// The two fields the view reads: a selected session, or an open draft and what it waits for.
type SessionUiState = {
  currentSessionId: string | null;
  newSessionDraft: { open: boolean; pendingWorktreeRequestId: string | null } | null;
};

const sessionUiState: SessionUiState = {
  currentSessionId: 'session-1',
  newSessionDraft: null,
};

const useSessionUIStoreMock = <T,>(selector: (state: typeof sessionUiState) => T): T => selector(sessionUiState);

const uiState = {
  terminalFontSize: 14,
  terminalShell: 'zsh',
  terminalLoginShells: ['zsh'],
  showTerminalQuickKeysOnDesktop: false,
  terminalCloseOnExit: true,
  openContextPreview,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: useSessionUIStoreMock }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => effectiveDirectory }));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => runtimeApis,
}));
mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({
    currentTheme: {
      metadata: { variant: 'dark' },
      colors: {
        surface: {
          background: '#000',
          muted: '#111',
          elevatedForeground: '#fff',
        },
        syntax: {
          base: { foreground: '#fff' },
          function: '#7dd3fc',
          keyword: '#c084fc',
          type: '#67e8f9',
          comment: '#6b7280',
        },
        interactive: {
          cursor: '#fff',
          selection: '#334155',
          selectionForeground: '#fff',
        },
        status: {
          error: '#f87171',
          success: '#4ade80',
          warning: '#fbbf24',
        },
      },
    },
  }),
}));
mock.module('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => ({ monoFont: 'geist-mono' }) }));
mock.module('@/lib/device', () => ({
  useDeviceInfo: () => deviceInfo,
  // Dialogs ask whether to lay out as a tablet; these tests run on a phone or a desktop.
  useTabletLayout: () => ({ enabled: false, roomyForPanels: false }),
}));
mock.module('@/stores/useUIStore', () => ({ useUIStore: useUiStoreMock }));
mock.module('@/stores/useInlineCommentDraftStore', () => ({ useInlineCommentDraftStore: () => ({ addDraft: () => undefined }) }));
mock.module('@/components/terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef(function TerminalViewportMock(
    { sessionKey, chunks, isVisible, ...callbacks }: { sessionKey: string; chunks: unknown[]; isVisible: boolean } & ViewportCallbacks,
    ref: React.ForwardedRef<{ focus: () => void; fit: () => void; getSelection: () => null; pasteClipboard: () => Promise<void> }>,
  ) {
    const { onResize } = callbacks;
    resizeViewport = onResize;
    viewportCallbacks.set(sessionKey, callbacks);
    const callbacksRef = React.useRef(callbacks);
    callbacksRef.current = callbacks;
    const notifiedGridRef = React.useRef<ViewportGrid | null>(null);
    const pendingGridRef = React.useRef<ViewportGrid | null>(null);
    const deliveriesRef = React.useRef(0);
    const flushResize = React.useCallback(() => {
      const grid = pendingGridRef.current;
      pendingGridRef.current = null;
      if (!grid) return;
      deliveriesRef.current++;
      callbacksRef.current.onResize(grid.cols, grid.rows);
    }, []);
    const fit = React.useCallback(() => {
      const grid = viewportGrids.get(sessionKey) ?? { cols: 100, rows: 30 };
      const notified = notifiedGridRef.current;
      // Ghostty marks a grid notified before its delayed callback. Fitting an
      // unchanged grid, including after showing the tab, does not notify again.
      if (notified?.cols === grid.cols && notified.rows === grid.rows) return;
      notifiedGridRef.current = grid;
      pendingGridRef.current = grid;
      if (!deferViewportResize) flushResize();
    }, [sessionKey, flushResize]);
    viewportSurfaces.set(sessionKey, {
      fit: (cols, rows) => { viewportGrids.set(sessionKey, { cols, rows }); fit(); },
      flushResize,
      deliveries: () => deliveriesRef.current,
    });
    React.useImperativeHandle(ref, () => ({
      focus: () => undefined,
      fit: () => { if (autoFitViewport) fit(); },
      getSelection: () => null,
      pasteClipboard: async () => { pasteClipboardCalls.push(sessionKey); },
    }), [sessionKey, fit]);
    // A real surface reports its fitted grid once it is visible; a visible tab
    // spawns its shell only after that report.
    React.useEffect(() => {
      if (isVisible && autoFitViewport) fit();
    }, [isVisible, fit]);
    React.useEffect(() => () => {
      if (flushViewportOnDispose) {
        flushResize();
        callbacksRef.current.onInput('disposal callback');
      }
    }, [flushResize]);

    return React.createElement('div', {
      'data-terminal-viewport': 'true',
      'data-session-key': sessionKey,
      'data-visible': String(isVisible),
      'data-chunk-count': String(chunks.length),
    });
  }),
}));
mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));
mock.module('@/components/ui/sortable-tabs-strip', () => ({
  SortableTabsStrip: ({ items, onClose }: { items: Array<{ id: string; label: string; icon?: React.ReactNode }>; onClose?: (id: string) => void }) => React.createElement(
    'div',
    { 'data-tabs-strip': 'terminal' },
    items.map((item) => React.createElement(
      'div',
      { key: item.id, 'data-tab-id': item.id },
      item.icon,
      React.createElement('span', { 'data-tab-label': item.id }, item.label),
      React.createElement('button', { type: 'button', 'data-tab-close': item.id, onClick: () => onClose?.(item.id) }),
    )),
  ),
}));
mock.module('@/lib/i18n', () => ({ useI18n: () => i18n, isRightToLeft: () => false }));

const { TerminalView } = await import('./TerminalView');

const ensureDirectorySpy = (directory: string) => {
  ensureDirectoryCalls.push(directory);
  useTerminalStore.setState((state) => {
    if (state.sessions.get(directory)) return state;

    const tab = {
      id: `spy-tab-${directory}`,
      terminalSessionId: null,
      lifecycle: 'idle' as const,
      purpose: { type: 'terminal' as const },
      label: 'Terminal',
      iconKey: null,
      isConnecting: false,
      createdAt: Date.now(),
      previewUrl: null,
      previewAutoOpened: false,
      previewUrlLocked: false,
    };

    const sessions = new Map(state.sessions);
    sessions.set(directory, { tabs: [tab], activeTabId: tab.id });
    return { sessions };
  });
};

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const bufferEntryKey = (directory: string, tabId: string) => `${directory}\u0000${tabId}`;
const readBufferContent = (directory: string, tabId: string) => useTerminalStore.getState().getBuffer(directory, tabId).chunks.map((chunk) => chunk.data).join('');

describe('TerminalView project action tab indicator', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    effectiveDirectory = '/repo';
    openContextPreviewCalls.length = 0;
    createSessionCalls.length = 0;
    createSessionOptions.length = 0;
    resizeCalls.length = 0;
    inputCalls.length = 0;
    restartCalls.length = 0;
    viewportCallbacks.clear();
    viewportGrids.clear();
    viewportSurfaces.clear();
    autoFitViewport = true;
    deferViewportResize = false;
    flushViewportOnDispose = false;
    createFailure = null;
    pendingCreate = null;
    pendingRestart = null;
    terminalRuntime.restartSession = restartSession;
    connectCalls.length = 0;
    closeCalls.length = 0;
    uiState.terminalCloseOnExit = true;
    ensureDirectoryCalls.length = 0;
    connectBehavior = () => ({ close: () => undefined });
    deviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };
    pasteClipboardCalls.length = 0;
    resizeViewport = null;
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      KeyboardEvent: windowInstance.KeyboardEvent,
      MouseEvent: windowInstance.MouseEvent,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    useTerminalStore.getState().clearAll();
    useTerminalStore.setState({ ensureDirectory: ensureDirectorySpy });
    useTerminalStore.getState().ensureDirectory('/repo');

    const interactiveTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo', interactiveTabId, 'Interactive');

    const runningActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabLabel('/repo', runningActionTabId, 'Build');
    useTerminalStore.getState().setTabIconKey('/repo', runningActionTabId, 'build');
    useTerminalStore.getState().setTabPurpose('/repo', runningActionTabId, { type: 'project-action', actionId: 'build', executionId: 'exec-running' });
    useTerminalStore.getState().setTabLifecycle('/repo', runningActionTabId, 'running');

    const exitedActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabLabel('/repo', exitedActionTabId, 'Deploy');
    useTerminalStore.getState().setTabIconKey('/repo', exitedActionTabId, 'play');
    useTerminalStore.getState().setTabPurpose('/repo', exitedActionTabId, { type: 'project-action', actionId: 'deploy', executionId: 'exec-exited' });
    useTerminalStore.getState().setTabLifecycle('/repo', exitedActionTabId, 'exited');
    ensureDirectoryCalls.length = 0;
  });

  afterEach(async () => {
    try {
      await act(async () => root?.unmount());
    } finally {
      useTerminalStore.getState().clearAll();
      sessionUiState.currentSessionId = 'session-1';
      sessionUiState.newSessionDraft = null;
      resetSpaceCreationRequests();
      useSpacesStore.getState().resetForRuntimeSwitch();
      host?.remove();
      await windowInstance?.happyDOM.close();
    }
  });

  test('a missing recovered interactive terminal never invokes creation', async () => {
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    useTerminalStore.getState().setTabSessionId('/repo', tab.id, 'previous-shell');
    useTerminalStore.getState().setActiveTab('/repo', tab.id);
    connectBehavior = (_id, handlers) => {
      queueMicrotask(() => handlers.onError?.(Object.assign(new Error('Terminal session not found'), { code: 'SESSION_NOT_FOUND' }), true));
      return { close() {} };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    expect(createSessionCalls).toEqual([]);
    expect(host.textContent).toContain('terminalView.error.sessionEnded');
  });

  const bindOnlyMemberTab = (action = false) => {
    const store = useTerminalStore.getState();
    store.clearAll();
    store.ensureDirectory('/repo');
    const tab = store.getDirectoryState('/repo')!.tabs[0]!;
    if (action) store.setTabPurpose('/repo', tab.id, { type: 'project-action', actionId: 'build', executionId: 'prior-run' });
    store.setTabSessionId('/repo', tab.id, 'prior-member-session');
    return tab.id;
  };

  const flushFittedEffects = async () => {
    await flushEffects();
    await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
    await flushEffects();
  };

  test('a delayed inactive viewport resize and input cannot reach the newly active tab', async () => {
    const first = bindOnlyMemberTab();
    const store = useTerminalStore.getState();
    const second = store.createTab('/repo');
    store.setTabSessionId('/repo', second, 'peer-session');
    store.setActiveTab('/repo', first);
    autoFitViewport = false;
    await act(async () => root.render(<TerminalView visible />));
    const fromFirst = viewportCallbacks.get(`/repo::${first}`)!;
    await act(async () => fromFirst.onResize(91, 27));
    await act(async () => store.setActiveTab('/repo', second));
    const fromSecond = viewportCallbacks.get(`/repo::${second}`)!;
    await act(async () => fromSecond.onResize(122, 42));
    resizeCalls.length = 0;
    await act(async () => {
      fromFirst.onResize(77, 19);
      fromFirst.onProvisionalSize(66, 18);
      fromFirst.onInput('stale input');
    });
    expect(resizeCalls).toEqual([]);
    expect(inputCalls).toEqual([]);
    await act(async () => fromSecond.onInput('peer input'));
    expect(inputCalls).toEqual([{ sessionId: 'peer-session', input: 'peer input', directory: '/repo' }]);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.click());
    expect(restartCalls[0]?.options).toMatchObject({ cwd: '/repo', cols: 122, rows: 42 });
    await act(async () => store.setActiveTab('/repo', first));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.click());
    expect(restartCalls[1]?.options).toMatchObject({ cwd: '/repo', cols: 77, rows: 19 });
  });

  test('A-B-A replays A first fit after its only unchanged-grid notification arrived while inactive', async () => {
    const first = bindOnlyMemberTab();
    const store = useTerminalStore.getState();
    store.setTabSessionId('/repo', first, null);
    store.setTabLifecycle('/repo', first, 'idle');
    const second = store.createTab('/repo');
    store.setTabSessionId('/repo', second, 'peer-session');
    store.setActiveTab('/repo', first);
    deferViewportResize = true;
    viewportGrids.set(`/repo::${first}`, { cols: 96, rows: 28 });
    viewportGrids.set(`/repo::${second}`, { cols: 122, rows: 42 });
    await act(async () => root.render(<TerminalView visible />));
    const firstSurface = viewportSurfaces.get(`/repo::${first}`)!;
    expect(firstSurface.deliveries()).toBe(0);
    await act(async () => store.setActiveTab('/repo', second));
    await act(async () => viewportSurfaces.get(`/repo::${second}`)!.flushResize());
    resizeCalls.length = 0;
    await act(async () => firstSurface.flushResize());
    expect(firstSurface.deliveries()).toBe(1);
    expect(createSessionCalls).toEqual([]);
    expect(resizeCalls).toEqual([]);
    await act(async () => store.setActiveTab('/repo', first));
    await act(async () => firstSurface.flushResize());
    expect(firstSurface.deliveries()).toBe(1);
    expect(createSessionOptions).toHaveLength(1);
    expect(createSessionOptions[0]).toMatchObject({ cwd: '/repo', sessionId: first, cols: 96, rows: 28 });
    expect(connectCalls[connectCalls.length - 1]).toBe('unused');
  });

  test('A-B-A applies an existing A changed grid on return without another surface notification', async () => {
    const first = bindOnlyMemberTab();
    const store = useTerminalStore.getState();
    const second = store.createTab('/repo');
    store.setTabSessionId('/repo', second, 'peer-session');
    store.setActiveTab('/repo', first);
    await act(async () => root.render(<TerminalView visible />));
    const firstSurface = viewportSurfaces.get(`/repo::${first}`)!;
    expect(firstSurface.deliveries()).toBe(1);
    deferViewportResize = true;
    firstSurface.fit(91, 27);
    await act(async () => store.setActiveTab('/repo', second));
    resizeCalls.length = 0;
    await act(async () => firstSurface.flushResize());
    expect(resizeCalls).toEqual([]);
    expect(firstSurface.deliveries()).toBe(2);
    await act(async () => store.setActiveTab('/repo', first));
    await act(async () => firstSurface.flushResize());
    expect(firstSurface.deliveries()).toBe(2);
    expect(resizeCalls).toEqual([{ sessionId: 'prior-member-session', cols: 91, rows: 27, directory: '/repo' }]);
    expect(createSessionCalls).toEqual([]);
  });

  test('disposed and previous-directory viewport callbacks cannot reach a peer with the same tab ID', async () => {
    const tabId = bindOnlyMemberTab();
    autoFitViewport = false;
    useTerminalStore.setState(state => {
      const tab = state.getDirectoryState('/repo')!.tabs[0]!;
      const sessions = new Map(state.sessions);
      sessions.set('/other', { tabs: [{ ...tab, terminalSessionId: 'other-session' }], activeTabId: tabId });
      return { sessions };
    });
    await act(async () => root.render(<TerminalView visible directory="/repo" />));
    const previous = viewportCallbacks.get(`/repo::${tabId}`)!;
    deferViewportResize = true;
    viewportSurfaces.get(`/repo::${tabId}`)!.fit(73, 17);
    flushViewportOnDispose = true;
    await act(async () => root.render(<TerminalView visible directory="/other" />));
    resizeCalls.length = 0;
    await act(async () => {
      previous.onResize(77, 19);
      previous.onInput('old directory');
    });
    expect(resizeCalls).toEqual([]);
    expect(inputCalls).toEqual([]);
    const disposed = viewportCallbacks.get(`/other::${tabId}`)!;
    viewportSurfaces.get(`/other::${tabId}`)!.fit(71, 17);
    await act(async () => root.unmount());
    await act(async () => {
      disposed.onResize(71, 17);
      disposed.onInput('disposed');
    });
    expect(resizeCalls).toEqual([]);
    expect(inputCalls).toEqual([]);
    // Leave teardown a live root to unmount.
    root = createRoot(host);
  });

  test('a fresh visible tab waits for its own first fitted grid and creates only once', async () => {
    const store = useTerminalStore.getState();
    const first = store.getDirectoryState('/repo')!.tabs[0]!.id;
    store.setActiveTab('/repo', first);
    autoFitViewport = false;
    await act(async () => root.render(<TerminalView visible />));
    const firstViewport = viewportCallbacks.get(`/repo::${first}`)!;
    await act(async () => firstViewport.onProvisionalSize(130, 50));
    expect(createSessionCalls).toEqual([]);
    await act(async () => firstViewport.onResize(96, 28));
    expect(createSessionOptions).toHaveLength(1);
    expect(createSessionOptions[0]).toMatchObject({ cwd: '/repo', sessionId: first, cols: 96, rows: 28 });
    expect(connectCalls).toEqual(['unused']);
    let second = '';
    await act(async () => { second = store.createTab('/repo'); store.setActiveTab('/repo', second); });
    await act(async () => firstViewport.onResize(70, 20));
    expect(createSessionOptions).toHaveLength(1);
    const secondViewport = viewportCallbacks.get(`/repo::${second}`)!;
    await act(async () => secondViewport.onResize(112, 36));
    expect(createSessionOptions).toHaveLength(2);
    expect(createSessionOptions[1]).toMatchObject({ cwd: '/repo', sessionId: second, cols: 112, rows: 36 });
  });

  test('first fit remains single-flight in Strict Mode and uses the owning tab latest grid when create resolves', async () => {
    const store = useTerminalStore.getState();
    const tabId = store.getDirectoryState('/repo')!.tabs[0]!.id;
    store.setActiveTab('/repo', tabId);
    let finishCreate = () => {};
    pendingCreate = new Promise(resolve => { finishCreate = resolve; });
    try {
      await act(async () => root.render(<React.StrictMode><TerminalView visible /></React.StrictMode>));
      expect(createSessionOptions).toHaveLength(1);
      await act(async () => viewportCallbacks.get(`/repo::${tabId}`)!.onResize(106, 34));
      expect(createSessionOptions).toHaveLength(1);
      resizeCalls.length = 0;
      await act(async () => finishCreate());
      expect(resizeCalls.find(call => call.cols === 106 && call.rows === 34)).toEqual({ sessionId: 'unused', cols: 106, rows: 34, directory: '/repo' });
      expect(connectCalls).toEqual(['unused']);
    } finally {
      finishCreate();
    }
  });

  test('hidden creation uses its own fallback and reconnect attaches without creating again', async () => {
    const store = useTerminalStore.getState();
    const first = store.getDirectoryState('/repo')!.tabs[0]!.id;
    store.setActiveTab('/repo', first);
    autoFitViewport = false;
    await act(async () => root.render(<TerminalView visible />));
    await act(async () => viewportCallbacks.get(`/repo::${first}`)!.onResize(120, 44));
    await act(async () => root.render(<TerminalView visible={false} />));
    let second = '';
    await act(async () => { second = store.createTab('/repo'); store.setActiveTab('/repo', second); });
    expect(createSessionOptions[1]).toMatchObject({ sessionId: second, cols: 80, rows: 24 });
    resizeCalls.length = 0;
    const hiddenViewport = viewportCallbacks.get(`/repo::${second}`)!;
    await act(async () => { hiddenViewport.onResize(60, 18); hiddenViewport.onInput('hidden'); });
    expect(resizeCalls).toEqual([]);
    expect(inputCalls).toEqual([]);
    await act(async () => root.render(<TerminalView visible />));
    expect(resizeCalls).toEqual([{ sessionId: 'unused', cols: 60, rows: 18, directory: '/repo' }]);
    resizeCalls.length = 0;
    await act(async () => viewportCallbacks.get(`/repo::${second}`)!.onResize(110, 35));
    expect(resizeCalls).toEqual([{ sessionId: 'unused', cols: 110, rows: 35, directory: '/repo' }]);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<TerminalView visible />));
    expect(createSessionOptions).toHaveLength(2);
    expect(connectCalls.every(id => id === 'unused')).toBe(true);
  });

  test('restart completion after switching tabs stays bound to the original tab', async () => {
    const first = bindOnlyMemberTab();
    const store = useTerminalStore.getState();
    const second = store.createTab('/repo');
    store.setTabSessionId('/repo', second, 'peer-session');
    store.setActiveTab('/repo', first);
    let finishRestart = () => {};
    pendingRestart = new Promise(resolve => { finishRestart = resolve; });
    try {
      await act(async () => root.render(<TerminalView visible />));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.click());
      await act(async () => store.setActiveTab('/repo', second));
      const connectsBeforeCompletion = connectCalls.length;
      await act(async () => finishRestart());
      expect(store.getDirectoryState('/repo')!.tabs.find(tab => tab.id === first)?.terminalSessionId).toBe('prior-member-session');
      expect(store.getActiveTab('/repo')?.terminalSessionId).toBe('peer-session');
      expect(connectCalls).toHaveLength(connectsBeforeCompletion);
      expect(restartCalls.map(call => call.sessionId)).toEqual(['prior-member-session']);
    } finally {
      finishRestart();
    }
  });

  test('the restart handler rechecks lifecycle even before a previously enabled control rerenders', async () => {
    const tabId = bindOnlyMemberTab();
    await act(async () => root.render(<TerminalView visible />));
    const restart = host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!;
    expect(restart.disabled).toBe(false);
    await act(async () => {
      useTerminalStore.getState().setTabLifecycle('/repo', tabId, 'unavailable');
      restart.click();
    });
    expect(restartCalls).toEqual([]);
    expect(createSessionCalls).toEqual([]);
    expect(restart.disabled).toBe(true);
  });

  test('a runtime without restart support disables restart for bound sessions', async () => {
    bindOnlyMemberTab();
    terminalRuntime.restartSession = undefined;
    await act(async () => root.render(<TerminalView visible />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.disabled).toBe(true);
  });

  test('a cleared ID permits fresh launch only for an exited plain tab', async () => {
    const tabId = bindOnlyMemberTab();
    const store = useTerminalStore.getState();
    store.setTabSessionId('/repo', tabId, null);
    autoFitViewport = false;
    for (const lifecycle of ['idle', 'starting', 'recovering', 'unavailable', 'running', 'stopping'] as const) {
      await act(async () => {
        store.setTabLifecycle('/repo', tabId, lifecycle);
        root.render(<TerminalView visible />);
      });
      expect(host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.disabled).toBe(true);
    }
    await act(async () => {
      store.setTabPurpose('/repo', tabId, { type: 'project-action', actionId: 'build', executionId: 'ended' });
      store.setTabLifecycle('/repo', tabId, 'exited');
    });
    expect(host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.disabled).toBe(true);
    expect(createSessionCalls).toEqual([]);
  });

  test('a failed explicit fresh restart remains unavailable and does not retry on resize', async () => {
    const tabId = bindOnlyMemberTab();
    useTerminalStore.getState().setTabSessionId('/repo', tabId, null);
    createFailure = new Error('Launcher unavailable');
    await act(async () => root.render(<TerminalView visible />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.click());
    await act(async () => viewportCallbacks.get(`/repo::${tabId}`)!.onResize(110, 40));
    expect(createSessionCalls).toHaveLength(1);
    expect(host.textContent).toContain('Launcher unavailable');
    expect(useTerminalStore.getState().getActiveTab('/repo')?.lifecycle).toBe('unavailable');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!.disabled).toBe(true);
  });

  for (const code of ['SESSION_NOT_FOUND', 'MEMBER_TERMINAL_OUTCOME_UNKNOWN']) {
    test(`Restart and Hard Restart are disabled after ${code} without reconstructing`, async () => {
      const tabId = bindOnlyMemberTab();
      deviceInfo = { isMobile: true, isTablet: false, hasTouchOnlyPointer: true };
      connectBehavior = (_id, handlers) => {
        queueMicrotask(() => handlers.onError?.(Object.assign(new Error(code), { code }), true));
        return { close() {} };
      };
      await act(async () => root.render(<TerminalView visible />));
      const restart = host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.restart"]')!;
      const hardRestart = host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.hardRestartTitle"]')!;
      expect(restart.disabled).toBe(true);
      expect(hardRestart.disabled).toBe(true);
      await act(async () => { restart.click(); hardRestart.click(); });
      expect(createSessionCalls).toEqual([]);
      expect(restartCalls).toEqual([]);
      expect(useTerminalStore.getState().getActiveTab('/repo')?.id).toBe(tabId);
    });
  }

  for (const hard of [false, true]) {
    test(`explicit ${hard ? 'Hard Restart' : 'Restart'} launches a known exited plain tab with a cleared ID`, async () => {
      const tabId = bindOnlyMemberTab();
      deviceInfo = { isMobile: true, isTablet: false, hasTouchOnlyPointer: true };
      connectBehavior = (_id, handlers) => {
        queueMicrotask(() => handlers.onError?.(Object.assign(new Error('Terminal was killed'), { code: 'KILLED' }), true));
        return { close() {} };
      };
      uiState.terminalCloseOnExit = false;
      await act(async () => root.render(<TerminalView visible />));
      expect(useTerminalStore.getState().getActiveTab('/repo')).toMatchObject({ terminalSessionId: null, lifecycle: 'exited' });
      expect(createSessionCalls).toEqual([]);
      connectBehavior = () => ({ close() {} });
      const selector = hard ? '[aria-label="terminalView.actions.hardRestartTitle"]' : '[aria-label="terminalView.actions.restart"]';
      const button = host.querySelector<HTMLButtonElement>(selector)!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(createSessionOptions).toHaveLength(1);
      expect(createSessionOptions[0]).toMatchObject({ cwd: '/repo', sessionId: tabId, cols: 100, rows: 30 });
      expect(restartCalls).toEqual([]);
      expect(useTerminalStore.getState().getActiveTab('/repo')?.terminalSessionId).toBe('unused');
    });
  }

  for (const action of [false, true]) for (const callback of [false, true]) {
    test(`known member ${action ? 'action' : 'shell'} exit cannot manufacture launch intent, callback: ${callback}`, async () => {
      const tabId = bindOnlyMemberTab(action);
      let stream: TerminalHandlers | undefined;
      let closed = 0;
      createFailure = Object.assign(new Error('Member terminal control connection lost'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
      connectBehavior = (id, handlers) => {
        if (id === 'prior-member-session') {
          stream = handlers;
          queueMicrotask(() => handlers.onEvent({ type: 'snapshot', sequence: 1, data: 'prior output', status: 'running', ptyBackend: 'member-systemd' }));
        }
        return { close() {} };
      };
      await act(async () => root.render(React.createElement(TerminalView, { visible: true, ...(callback ? { onLastTabClosed: () => { closed++; } } : {}) })));
      await flushFittedEffects();
      expect(stream).toBeDefined();
      await act(async () => stream!.onEvent({ type: 'exit', sequence: 2, exitCode: 0 }));
      await flushFittedEffects();
      expect(createSessionCalls).toEqual([]);
      expect(closeCalls).toEqual(['prior-member-session']);
      expect(closed).toBe(callback ? 1 : 0);
      const tabs = useTerminalStore.getState().getDirectoryState('/repo')!.tabs;
      expect(tabs.some(tab => tab.id === tabId)).toBe(false);
      expect(tabs[0]!.lifecycle).toBe('unavailable');
      createFailure = null;
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="contextTooltips.terminalBrowser.terminal.newTab"]')!.click());
      await flushFittedEffects();
      expect(createSessionCalls).toEqual([{ cwd: '/repo' }]);
    });
  }

  for (const cached of [false, true]) {
    test(`an exited member snapshot after hydration cannot manufacture launch intent, cached: ${cached}`, async () => {
      const tabId = bindOnlyMemberTab();
      const options = useTerminalStore.persist.getOptions();
      useTerminalStore.setState(options.merge!(options.partialize!(useTerminalStore.getState()), useTerminalStore.getState()));
      createFailure = new Error('Member terminal control connection lost');
      connectBehavior = (id, handlers) => {
        if (id === 'prior-member-session') {
          const emit = () => handlers.onEvent({ type: 'snapshot', sequence: 4, data: 'retained output', status: 'exited', ptyBackend: 'member-systemd' });
          if (cached) emit();
          else queueMicrotask(emit);
        }
        return { close() {} };
      };
      await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
      await flushFittedEffects();
      expect(createSessionCalls).toEqual([]);
      expect(connectCalls.every(id => id === 'prior-member-session')).toBe(true);
      expect(closeCalls).toEqual(['prior-member-session']);
      expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.some(tab => tab.id === tabId)).toBe(false);
      await act(async () => root.unmount());
      root = createRoot(host);
      useTerminalStore.setState(options.merge!(options.partialize!(useTerminalStore.getState()), useTerminalStore.getState()));
      connectBehavior = (_id, handlers) => {
        queueMicrotask(() => handlers.onError?.(Object.assign(new Error('Terminal session not found'), { code: 'SESSION_NOT_FOUND' }), true));
        return { close() {} };
      };
      await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
      await flushFittedEffects();
      expect(createSessionCalls).toEqual([]);
    });
  }

  test('unknown member control error retains binding through resize, remount and hydration without creating', async () => {
    const tabId = bindOnlyMemberTab();
    connectBehavior = (_id, handlers) => {
      queueMicrotask(() => handlers.onError?.(Object.assign(new Error('Member terminal control connection lost'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' }), true));
      return { close() {} };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushFittedEffects();
    const tab = () => useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(entry => entry.id === tabId)!;
    expect(tab().terminalSessionId).toBe('prior-member-session');
    expect(tab().lifecycle).toBe('unavailable');
    expect(host.textContent).toContain('Member terminal control connection lost');
    await act(async () => resizeViewport?.(110, 40));
    await act(async () => root.unmount());
    root = createRoot(host);
    const options = useTerminalStore.persist.getOptions();
    useTerminalStore.setState(options.merge!(options.partialize!(useTerminalStore.getState()), useTerminalStore.getState()));
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushFittedEffects();
    expect(tab().terminalSessionId).toBe('prior-member-session');
    expect(tab().lifecycle).toBe('unavailable');
    expect(connectCalls.every(id => id === 'prior-member-session')).toBe(true);
    expect(createSessionCalls).toEqual([]);
  });

  test('member exit with close-on-exit off retains output without creating', async () => {
    const tabId = bindOnlyMemberTab();
    uiState.terminalCloseOnExit = false;
    connectBehavior = (_id, handlers) => {
      queueMicrotask(() => {
        handlers.onEvent({ type: 'snapshot', sequence: 1, data: 'member output', status: 'running', ptyBackend: 'member-systemd' });
        handlers.onEvent({ type: 'exit', sequence: 2, exitCode: 0 });
      });
      return { close() {} };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushFittedEffects();
    expect(closeCalls).toEqual([]);
    expect(readBufferContent('/repo', tabId)).toContain('member output');
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.lifecycle).toBe('exited');
    expect(createSessionCalls).toEqual([]);
  });

  test('a force-killed member action cannot launch a fallback after a metadata-light restarted snapshot', async () => {
    const tabId = bindOnlyMemberTab(true);
    let stream: TerminalHandlers | undefined;
    connectBehavior = (_id, handlers) => {
      stream = handlers;
      queueMicrotask(() => handlers.onEvent({ type: 'snapshot', sequence: 1, data: '', status: 'running', ptyBackend: 'member-systemd' }));
      return { close() {} };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushFittedEffects();
    await act(async () => {
      stream!.onEvent({ type: 'snapshot', sequence: 2, data: '', status: 'running' });
      // The action owner can clear its session before the view sees KILLED.
      useTerminalStore.getState().setTabSessionId('/repo', tabId, null);
      stream!.onError?.(Object.assign(new Error('Terminal was killed'), { code: 'KILLED' }), true);
    });
    await flushFittedEffects();
    expect(closeCalls).toEqual([]);
    expect(createSessionCalls).toEqual([]);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.lifecycle).toBe('unavailable');
  });

  test('ordinary local exit keeps the existing idle last-tab fallback and automatic launch', async () => {
    bindOnlyMemberTab();
    connectBehavior = (id, handlers) => {
      if (id === 'prior-member-session') queueMicrotask(() => {
        handlers.onEvent({ type: 'snapshot', sequence: 1, data: '', status: 'running', ptyBackend: 'node-pty' });
        handlers.onEvent({ type: 'exit', sequence: 2, exitCode: 0 });
      });
      return { close() {} };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushFittedEffects();
    expect(closeCalls).toEqual(['prior-member-session']);
    expect(createSessionCalls).toEqual([{ cwd: '/repo' }]);
  });

  test('a failed fresh launch retains its cause and never retries creation automatically', async () => {
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    useTerminalStore.getState().setActiveTab('/repo', tab.id);
    createFailure = new Error('Member terminal launcher unavailable');
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
    expect(createSessionCalls).toHaveLength(1);
    expect(host.textContent).toContain('Member terminal launcher unavailable');
  });

  for (const survives of [false, true]) test(`reload ${survives ? 'reattaches a surviving' : 'does not reconstruct a missing'} shell`, async () => {
    const store = useTerminalStore.getState();
    const tab = store.getDirectoryState('/repo')!.tabs[0]!;
    store.setTabSessionId('/repo', tab.id, 'before-reload');
    store.setActiveTab('/repo', tab.id);
    const options = useTerminalStore.persist.getOptions();
    useTerminalStore.setState(options.merge!(options.partialize!(useTerminalStore.getState()), useTerminalStore.getState()));
    connectBehavior = (_id, handlers) => {
      queueMicrotask(() => {
        if (survives) handlers.onEvent({ type: 'snapshot', sequence: 7, data: 'surviving output', status: 'running' });
        else handlers.onError?.(Object.assign(new Error('Terminal session not found'), { code: 'SESSION_NOT_FOUND' }), true);
      });
      return { close() {} };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    expect(connectCalls.length).toBeGreaterThan(0);
    expect(connectCalls.every(id => id === 'before-reload')).toBe(true);
    expect(createSessionCalls).toEqual([]);
    if (survives) expect(readBufferContent('/repo', tab.id)).toBe('surviving output');
    else {
      expect(host.textContent).toContain('terminalView.error.sessionEnded');
      connectBehavior = () => ({ close() {} });
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="contextTooltips.terminalBrowser.terminal.newTab"]')!.click());
      await flushEffects();
      // Tab switches fit the selected viewport on the next animation frame.
      await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
      expect(createSessionCalls).toEqual([{ cwd: '/repo' }]);
    }
  });

  test('a draft waiting for a new space opens no shell until the space runs, then opens it in the space', async () => {
    const space: SpaceEntry = {
      id: 'a1b2c3d4e5f6', name: 'Fix login', placeId: 'docker', machine: null,
      projectDirectory: '/repo', projectFolder: { path: '/repo', found: null }, directory: '/spaces/a1b2c3d4e5f6/repo',
      state: 'preparing', stoppedIdle: false, step: 'creating', failure: null, network: { mode: 'allowlist', domains: [] },
      grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null,
    };
    // The draft stays on the project's folder while its chip names the space.
    sessionUiState.currentSessionId = null;
    sessionUiState.newSessionDraft = { open: true, pendingWorktreeRequestId: 'worktree_space' };
    noteSpaceCreationRequest('worktree_space', space.id);
    useSpacesStore.getState().addJourneyEntry(space);

    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    expect(host.textContent).toContain('spaces.draft.preparing');
    expect(createSessionCalls).toEqual([]);

    await act(async () => useSpacesStore.getState().addJourneyEntry({ ...space, state: 'running', step: null }));
    await flushEffects();
    expect(ensureDirectoryCalls).toEqual(['/spaces/a1b2c3d4e5f6/repo']);
    expect(host.querySelector('[data-terminal-viewport]')?.getAttribute('data-session-key')?.startsWith('/spaces/a1b2c3d4e5f6/repo::')).toBe(true);

    // What the panel hands to the draft stays on the draft's folder.
    const tabId = useTerminalStore.getState().getDirectoryState('/spaces/a1b2c3d4e5f6/repo')!.tabs[0]!.id;
    await act(async () => useTerminalStore.getState().setTabPreviewUrl('/spaces/a1b2c3d4e5f6/repo', tabId, 'https://preview.example.test'));
    host.querySelector<HTMLElement>('[aria-label="terminalView.preview.openTitle"]')?.click();
    expect(openContextPreviewCalls).toEqual([['/repo', 'https://preview.example.test']]);
  });

  test('closing the last tab closes the surface instead of only replacing the tab', async () => {
    effectiveDirectory = '/solo';
    useTerminalStore.getState().ensureDirectory('/solo');
    let lastTabClosedCalls = 0;
    const onLastTabClosed = () => { lastTabClosedCalls += 1; };

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false, onLastTabClosed }));
    });
    const [onlyTab] = useTerminalStore.getState().getDirectoryState('/solo')!.tabs;
    await act(async () => {
      host.querySelector<HTMLElement>(`[data-tab-close="${onlyTab!.id}"]`)?.click();
    });
    await flushEffects();

    expect(lastTabClosedCalls).toBe(1);
  });

  test('closing one of several tabs keeps the surface open', async () => {
    let lastTabClosedCalls = 0;
    const onLastTabClosed = () => { lastTabClosedCalls += 1; };

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false, onLastTabClosed }));
    });
    const [firstTab] = useTerminalStore.getState().getDirectoryState('/repo')!.tabs;
    await act(async () => {
      host.querySelector<HTMLElement>(`[data-tab-close="${firstTab!.id}"]`)?.click();
    });
    await flushEffects();

    expect(lastTabClosedCalls).toBe(0);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs).toHaveLength(2);
  });

  const exitActiveTab = async (label: string) => {
    const store = useTerminalStore.getState();
    const tab = store.getDirectoryState('/repo')!.tabs.find((entry) => entry.label === label)!;
    store.setTabSessionId('/repo', tab.id, `srv-${label}`);
    store.setActiveTab('/repo', tab.id);
    connectBehavior = (_sessionId, handlers) => {
      void Promise.resolve().then(() => handlers.onEvent({ type: 'exit', exitCode: 0 }));
      return { close: () => undefined };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    return tab.id;
  };

  test('a shell that exits closes its tab and releases the server session', async () => {
    const tabId = await exitActiveTab('Interactive');

    expect(closeCalls).toEqual(['srv-Interactive']);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.some((tab) => tab.id === tabId)).toBe(false);
  });

  test('a shell that exits keeps its tab when closing on exit is off', async () => {
    uiState.terminalCloseOnExit = false;
    const tabId = await exitActiveTab('Interactive');

    expect(closeCalls).toEqual([]);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find((tab) => tab.id === tabId)?.lifecycle).toBe('exited');
  });

  test('a project action that exits closes its tab too', async () => {
    const tabId = await exitActiveTab('Build');

    expect(closeCalls).toEqual(['srv-Build']);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.some((tab) => tab.id === tabId)).toBe(false);
  });

  test('a project action the server force-kills on stop closes its tab without a second close', async () => {
    const store = useTerminalStore.getState();
    const tab = store.getDirectoryState('/repo')!.tabs.find((entry) => entry.label === 'Build')!;
    store.setTabSessionId('/repo', tab.id, 'srv-Build');
    store.setActiveTab('/repo', tab.id);
    connectBehavior = (_sessionId, handlers) => {
      void Promise.resolve().then(() => {
        // The action runner's own subscription sees the message first and clears the session.
        useTerminalStore.getState().setTabSessionId('/repo', tab.id, null);
        handlers.onError?.(Object.assign(new Error('Terminal was killed'), { code: 'KILLED' }), true);
      });
      return { close: () => undefined };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();

    expect(closeCalls).toEqual([]);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.some((entry) => entry.id === tab.id)).toBe(false);
    expect(host.textContent).not.toContain('terminalView.error.connectionFailed');
  });

  test('a project action that exits keeps its output when closing on exit is off', async () => {
    uiState.terminalCloseOnExit = false;
    const tabId = await exitActiveTab('Build');

    expect(closeCalls).toEqual([]);
    expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find((tab) => tab.id === tabId)?.lifecycle).toBe('exited');
    expect(readBufferContent('/repo', tabId)).toContain('terminalView.stream.processExitedMessage');
  });

  test('shows the shared spinner while a project action starts, runs or stops, and its own icon otherwise', async () => {
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false }));
    });

    const tabs = Array.from(host.querySelectorAll('[data-tab-id]'));
    expect(tabs).toHaveLength(3);

    const tab = (label: string) => tabs.find((entry) => entry.querySelector('[data-tab-label]')?.textContent === label);

    expect(tab('Interactive')?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('terminal');
    expect(tab('Build')?.querySelector('[data-spinner]')).not.toBeNull();
    expect(tab('Deploy')?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('play');
    expect(host.querySelectorAll('.animate-spin').length).toBe(0);

    const buildTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find((entry) => entry.label === 'Build')!.id;
    await act(async () => {
      useTerminalStore.getState().setTabLifecycle('/repo', buildTabId, 'stopping');
    });

    expect(host.querySelectorAll('[data-spinner]').length).toBe(1);
  });

  test('offers Paste next to Copy only on touch terminals and pastes into the active tab', async () => {
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false }));
    });
    expect(host.querySelector('[aria-label="terminalView.actions.copySelection"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="terminalView.actions.paste"]')).toBeNull();

    deviceInfo = { isMobile: true, isTablet: false, hasTouchOnlyPointer: true };
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    await flushEffects();
    const paste = host.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.paste"]');
    expect(paste?.parentElement?.previousElementSibling?.querySelector('[aria-label="terminalView.actions.copySelection"]')).not.toBeNull();
    expect(paste?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('clipboard');

    const activeTabId = useTerminalStore.getState().getDirectoryState('/repo')!.activeTabId;
    await act(async () => { paste?.click(); });
    expect(pasteClipboardCalls).toEqual([`/repo::${activeTabId}`]);
  });

  test('uses the explicit terminal directory for terminal tabs and session creation while preview ownership stays on the host directory', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    const repoTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo', repoTabId, 'Repo Terminal');
    useTerminalStore.getState().setTabPreviewUrl('/repo', repoTabId, 'https://preview.example.test');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Repo Terminal');
    expect(tabLabels).not.toContain('Worktree Terminal');
    expect(createSessionCalls.length).toBe(1);
    expect(createSessionCalls[0]?.cwd).toBe('/repo');

    const previewButton = host.querySelector<HTMLElement>('[aria-label="terminalView.preview.openTitle"]');
    expect(previewButton).not.toBeNull();
    previewButton?.click();
    expect(openContextPreviewCalls).toEqual([['/repo-worktree', 'https://preview.example.test']]);
  });

  test('keeps the existing context-directory behavior when no explicit terminal directory is provided', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Worktree Terminal');
    expect(createSessionCalls.length).toBe(1);
    expect(createSessionCalls[0]?.cwd).toBe('/repo-worktree');
  });

  test('treats an explicit terminal target with no terminal state as an inert reveal', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/missing-repo' }));
    });

    expect(ensureDirectoryCalls).not.toContain('/missing-repo');
    expect(createSessionCalls.length).toBe(0);
    expect(host.querySelector('[data-tabs-strip="terminal"]')).toBeNull();
    expect(host.querySelector('[data-terminal-viewport="true"]')).toBeNull();
  });

  test('includes the terminal directory in the viewport identity key', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');

    useTerminalStore.setState((state) => {
      const repoTab = state.sessions.get('/repo')!.tabs[0]!;
      const sessions = new Map(state.sessions);
      sessions.set('/repo-worktree', {
        tabs: [{ ...repoTab, label: 'Mirrored Terminal' }],
        activeTabId: repoTab.id,
      });
      return { sessions };
    });

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    const contextKey = host.querySelector('[data-terminal-viewport="true"]')!.getAttribute('data-session-key');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });
    const targetKey = host.querySelector('[data-terminal-viewport="true"]')!.getAttribute('data-session-key');

    expect(contextKey).not.toBe(targetKey);
    expect(contextKey).toContain('/repo-worktree');
    expect(targetKey).toContain('/repo');
  });

  test('replacing an exited action does not show a connection failure', async () => {
    const store = useTerminalStore.getState();
    const actionTab = store.getDirectoryState('/repo')?.tabs.find(tab => tab.label === 'Build');
    if (!actionTab) throw new Error('action tab missing');
    store.setTabSessionId('/repo', actionTab.id, 'srv-build');
    store.setActiveTab('/repo', actionTab.id);
    connectBehavior = (_sessionId, handlers) => {
      void Promise.resolve().then(() => {
        handlers.onError?.(Object.assign(new Error('Terminal replaced by a new action run'), { code: 'SUPERSEDED' }), true);
      });
      return { close: () => undefined };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    expect(host.textContent).not.toContain('terminalView.error.connectionFailed');
    expect(store.getActiveTab('/repo')?.terminalSessionId).toBeNull();
    expect(store.getActiveTab('/repo')?.lifecycle).toBe('exited');
  });

  test('a terminal that keeps failing to reconnect shows the error and Try again until it is back', async () => {
    const store = useTerminalStore.getState();
    const tab = store.getDirectoryState('/repo')!.tabs.find((entry) => entry.label === 'Interactive')!;
    store.setTabSessionId('/repo', tab.id, 'srv-Interactive');
    store.setActiveTab('/repo', tab.id);
    let handlers: TerminalHandlers | null = null;
    connectBehavior = (_sessionId, next) => {
      // A later subscription replays the snapshot another holder of the session cached.
      if (handlers) next.onEvent({ type: 'snapshot', sequence: 0, data: '', status: 'running' });
      handlers = next;
      return { close: () => undefined };
    };
    await act(async () => root.render(React.createElement(TerminalView, { visible: true })));
    await flushEffects();
    const emit = async (attempt: number) => act(async () => handlers!.onEvent({ type: 'reconnecting', attempt, maxAttempts: Number.POSITIVE_INFINITY }));
    const tryAgainButton = () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'terminalView.actions.tryAgain');

    // A short outage recovers within a few attempts and shows nothing.
    for (let attempt = 1; attempt <= 4; attempt += 1) await emit(attempt);
    expect(host.textContent).not.toContain('terminalView.error.cannotConnect');

    await emit(5);
    expect(host.textContent).toContain('terminalView.error.cannotConnect');
    expect(tryAgainButton()).toBeDefined();

    await act(async () => tryAgainButton()!.click());
    expect(connectCalls).toEqual(['srv-Interactive', 'srv-Interactive']);
    expect(host.textContent).toContain('terminalView.error.cannotConnect');
    // The retry dials once and fails: its count starts over, and the error stays.
    await act(async () => handlers!.onError?.(new Error('Terminal WebSocket closed'), false));
    await emit(1);
    expect(host.textContent).toContain('terminalView.error.cannotConnect');

    await act(async () => handlers!.onEvent({ type: 'snapshot', sequence: 1, data: '$ ', status: 'running' }));
    expect(host.textContent).not.toContain('terminalView.error.cannotConnect');
  });

  test('would fail if revisit attach skipped the active running project-action snapshot restore', async () => {
    const state = useTerminalStore.getState().getDirectoryState('/repo');
    const actionTab = state?.tabs.find((tab) => tab.label === 'Build');
    expect(actionTab).toBeDefined();
    if (!actionTab) throw new Error('action tab missing');

    useTerminalStore.getState().setTabSessionId('/repo', actionTab.id, 'srv-build', { expectedExecutionId: 'exec-running' });
    useTerminalStore.getState().setActiveTab('/repo', actionTab.id);

    const snapshotData = 'snapshot history\nfinal line\n';
    let replaceCount = 0;
    const unsubscribe = useTerminalStore.subscribe((nextState, previousState) => {
      const next = nextState.buffers.get(bufferEntryKey('/repo', actionTab.id));
      const previous = previousState.buffers.get(bufferEntryKey('/repo', actionTab.id));
      const nextContent = next?.chunks.map((chunk) => chunk.data).join('') ?? '';
      const previousContent = previous?.chunks.map((chunk) => chunk.data).join('') ?? '';
      if (nextContent === snapshotData && previousContent !== snapshotData && next?.lastSequence === 7) {
        replaceCount += 1;
      }
    });
    connectBehavior = (_sessionId, handlers) => {
      void Promise.resolve().then(() => {
        handlers.onEvent({ type: 'snapshot', data: snapshotData, sequence: 7, status: 'running', cols: 94, rows: 56 });
      });
      return { close: () => undefined };
    };

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    await flushEffects();
    unsubscribe();

    expect(connectCalls).toEqual(['srv-build']);
    expect(createSessionCalls.length).toBe(0);
    expect(readBufferContent('/repo', actionTab.id)).toBe(snapshotData);
    expect(useTerminalStore.getState().getBuffer('/repo', actionTab.id).lastSequence).toBe(7);
    expect(useTerminalStore.getState().getBuffer('/repo', actionTab.id).chunks[0]?.size).toEqual({ cols: 94, rows: 56 });
    expect(replaceCount).toBe(1);
  });

  test('would fail if retained parent action targets rendered worktree tabs or attached the wrong session', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    const repoState = useTerminalStore.getState().getDirectoryState('/repo');
    const repoActionTab = repoState?.tabs.find((tab) => tab.label === 'Build');
    expect(repoActionTab).toBeDefined();
    if (!repoActionTab) throw new Error('repo action tab missing');

    useTerminalStore.getState().setTabLabel('/repo', repoActionTab.id, 'Repo Build');
    useTerminalStore.getState().setTabSessionId('/repo', repoActionTab.id, 'srv-parent-build', { expectedExecutionId: 'exec-running' });
    useTerminalStore.getState().setActiveTab('/repo', repoActionTab.id);

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });
    await flushEffects();

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Repo Build');
    expect(tabLabels).toContain('Interactive');
    expect(tabLabels).not.toContain('Worktree Terminal');
    expect(connectCalls).toEqual(['srv-parent-build']);
    expect(createSessionCalls.length).toBe(0);
  });
});
