import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { CreateTerminalOptions, TerminalHandlers, TerminalStreamEvent, TerminalServerSession } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { OpenChamberProjectAction } from '@/lib/openchamberConfig';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import type { ProjectActionsRunner } from './useProjectActionsRunner';

const toastCalls = {
  error: new Array<string>(),
  info: new Array<string>(),
  success: new Array<string>(),
} satisfies { error: string[]; info: string[]; success: string[] };

const openContextPreviewCalls: Array<{ directory: string; url: string }> = [];
const openContextPanelTabCalls: Array<{ directory: string; mode: string; targetDirectory: string | null | undefined }> = [];
const openExternalCalls: string[] = [];
const detectedDevServer: MockedDetectedDevServer = { command: null, previewUrlHint: null };
const mockedDeviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };
let effectiveDirectory = '/repo';
const projectSetupReads: Array<{ id: string; path: string }> = [];

const uiState = {
  terminalFontSize: 14,
  terminalCloseOnExit: true,
  terminalOpenOnProjectAction: true,
  showTerminalQuickKeysOnDesktop: false,
  terminalShell: 'zsh',
  terminalLoginShells: ['zsh'],
  setSettingsPage: () => undefined,
  setSettingsDialogOpen: () => undefined,
  setSettingsProjectsSelectedId: () => undefined,
  openContextPreview: (directory: string, url: string) => {
    openContextPreviewCalls.push({ directory, url });
  },
  openContextPanelTab: (directory: string, options: { mode: string; targetDirectory?: string | null }) => {
    openContextPanelTabCalls.push({ directory, mode: options.mode, targetDirectory: options.targetDirectory });
  },
  openContextSurface: () => undefined,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

const desktopSshState = { instances: [], load: async () => undefined };
const useDesktopSshStoreMock = <T,>(selector: (state: typeof desktopSshState) => T): T => selector(desktopSshState);

type SubscriptionRecord = {
  sessionId: string;
  handlers: TerminalHandlers;
  closed: number;
};

interface MockedActionsState {
  actions: OpenChamberProjectAction[];
}

interface MockedDetectedDevServer {
  command: string | null;
  previewUrlHint: string | null;
  actionId?: string;
}

const createCalls: CreateTerminalOptions[] = [];
const createdSessionId = (index: number): string => {
  const id = createCalls[index]?.sessionId;
  if (!id) throw new Error('missing requested terminal ID');
  return id;
};
const firstSessionId = () => createdSessionId(0);
const secondSessionId = () => createdSessionId(1);
const sendCalls: string[] = [];
const forceKillCalls: string[] = [];
const closeCalls: string[] = [];
const subscriptions: SubscriptionRecord[] = [];
let connectFailure: (Error & { code: string }) | null = null;
let resizeViewport: ((cols: number, rows: number) => void) | null = null;
let listedSessions: TerminalServerSession[] = [];
let listFailure = false;
let rawListingRows: unknown[] | null = null;
const listingStates: Array<string | undefined> = [];
let sessionCounter = 0;
const mockedActionsState: MockedActionsState = {
  actions: [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build' }],
};

const emitToSession = (sessionId: string, event: TerminalStreamEvent) => {
  subscriptions
    .filter((entry) => entry.sessionId === sessionId && entry.closed === 0)
    .forEach((entry) => entry.handlers.onEvent(event));
};

const terminal = {
  listSessions: async () => {
    listingStates.push(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find(tab => tab.purpose.type === 'project-action')?.lifecycle);
    if (listFailure) throw new Error('Session listing unavailable during control loss');
    if (rawListingRows) return listTerminalSessions('/repo');
    return listedSessions;
  },
  createSession: async (options: CreateTerminalOptions) => {
    createCalls.push(options);
    sessionCounter += 1;
    return {
      sessionId: options.sessionId ?? `session-${sessionCounter}`,
      cols: 80,
      rows: 24,
      status: 'running' as const,
      mode: 'command' as const,
      purpose: options.purpose,
    };
  },
  connect: (sessionId: string, handlers: SubscriptionRecord['handlers']) => {
    const record: SubscriptionRecord = { sessionId, handlers, closed: 0 };
    subscriptions.push(record);
    if (connectFailure) {
      const error = connectFailure;
      queueMicrotask(() => { if (!record.closed) handlers.onError?.(error, true); });
    }
    return {
      close: () => {
        record.closed += 1;
      },
    };
  },
  sendInput: async (sessionId: string, input: string) => {
    sendCalls.push(`${sessionId}:${input}`);
    queueMicrotask(() => {
      emitToSession(sessionId, { type: 'exit', sequence: 1, exitCode: 0, signal: null });
    });
  },
  resize: async () => undefined,
  updateAppearance: async () => undefined,
  close: async (sessionId: string) => {
    closeCalls.push(sessionId);
  },
  restartSession: async () => { throw new Error('not used'); },
  forceKill: async ({ sessionId }: { sessionId?: string }) => {
    forceKillCalls.push(sessionId ?? '');
  },
};

// The right-click menu renders inline, so its items are plain buttons.
mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  ContextMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => React.createElement('button', { type: 'button', onClick, className }, children),
  ContextMenuSeparator: () => React.createElement('hr'),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastCalls.error.push(message); },
    info: (message: string) => { toastCalls.info.push(message); },
    success: (message: string) => { toastCalls.success.push(message); },
  },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ terminal, runtime: { isVSCode: false, platform: 'web' } }) }));
const actualDevice = await import('@/lib/device');
mock.module('@/lib/device', () => ({ ...actualDevice, useDeviceInfo: () => mockedDeviceInfo }));
// Modules under test import other desktop helpers too; keep the real ones.
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => false }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: useUiStoreMock }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' }, colors: {
  surface: { background: '#000', muted: '#111', elevatedForeground: '#fff' },
  syntax: { base: { foreground: '#fff', function: '#fff', keyword: '#fff', type: '#fff', comment: '#fff' } },
  interactive: { cursor: '#fff', selection: '#333', selectionForeground: '#fff' },
  status: { error: '#f00', success: '#0f0', warning: '#ff0' },
} } }) }));
const actualSessionUiStore = await import('@/sync/session-ui-store');
mock.module('@/sync/session-ui-store', () => ({ ...actualSessionUiStore, useSessionUIStore: <T,>(selector: (state: { currentSessionId: string; newSessionDraft: null }) => T): T => selector({ currentSessionId: 'selected', newSessionDraft: null }) }));
mock.module('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => ({ monoFont: 'geist-mono' }) }));
mock.module('@/components/terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef(function Viewport({ onResize }: { onResize: (cols: number, rows: number) => void }, ref) {
    resizeViewport = onResize;
    React.useImperativeHandle(ref, () => ({ focus() {}, fit() { onResize(100, 30); }, getSelection: () => null }));
    React.useEffect(() => { onResize(100, 30); }, [onResize]);
    return React.createElement('div', { 'data-terminal-viewport': true });
  }),
}));
mock.module('@/stores/useDesktopSshStore', () => ({ useDesktopSshStore: useDesktopSshStoreMock }));
mock.module('@/lib/url', () => ({ openExternalUrl: async (url: string) => { openExternalCalls.push(url); } }));
const openchamberConfig = await import('@/lib/openchamberConfig');
mock.module('@/lib/openchamberConfig', () => ({
  ...openchamberConfig,
  getProjectActionsState: async () => mockedActionsState,
  getProjectSetup: async (projectRef: { id: string; path: string }) => {
    projectSetupReads.push(projectRef);
    return {
    trust: mockedActionsState.actions.some((action) => action.source === 'shared')
      ? { hash: 'sha256:shared', trusted: false }
      : { hash: null, trusted: true },
    setupWorktree: [],
    setupWorktreeWait: false,
    projectActions: mockedActionsState.actions.map((action) => ({ ...action, source: action.source ?? 'personal' })),
    projectActionsPrimaryId: null,
    draftStarters: [],
    shared: { status: 'missing', path: '.openchamber/project.json', setupWorktree: [], setupWorktreeWait: null, projectActions: mockedActionsState.actions.filter((action) => action.source === 'shared'), draftStarters: [], plansDir: null },
    personal: { setupWorktree: [], setupWorktreeWait: null, setupWorktreeMode: 'append', projectActions: mockedActionsState.actions.filter((action) => action.source !== 'shared'), projectActionsPrimaryId: null, draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null },
    };
  },
  updateProjectSetup: async () => true,
}));
mock.module('@/lib/browser/announcedServers', () => ({ setAnnouncedDevServers: () => undefined }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => effectiveDirectory }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => Response.json({ sessions: rawListingRows ?? listedSessions }) }));
mock.module('@/lib/detectDevServer', () => ({
  detectDevServerCommand: async () => (
    detectedDevServer.command
      ? { command: detectedDevServer.command, previewUrlHint: detectedDevServer.previewUrlHint ?? undefined, actionId: detectedDevServer.actionId }
      : null
  ),
  readPackageJsonScripts: async () => ({}),
}));

const { HeaderProjectAction } = await import('./HeaderProjectControls');
const { ProjectActionsScope } = await import('./ProjectActionsScope');
const { useProjectActionsRunner } = await import('./useProjectActionsRunner');
const { TerminalView } = await import('../views/TerminalView');
const { listTerminalSessions } = await import('@/lib/terminalApi');
const { getSharedTrustConfirmationSnapshot, settleSharedTrustConfirmation } = await import('@/lib/sharedTrustConfirmation');

describe('HeaderProjectAction lifecycle', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;
  const scheduledWindowTimeouts = new Map<ReturnType<Window['setTimeout']>, { delay: number; run: () => void }>();

  const runWindowTimeouts = async (delay: number) => {
    const matching = [...scheduledWindowTimeouts.entries()].filter(([, timeout]) => timeout.delay === delay);
    for (const [id] of matching) scheduledWindowTimeouts.delete(id);
    await act(async () => {
      for (const [, timeout] of matching) timeout.run();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    scheduledWindowTimeouts.clear();
    const originalSetTimeout = windowInstance.setTimeout.bind(windowInstance);
    const originalClearTimeout = windowInstance.clearTimeout.bind(windowInstance);
    windowInstance.setTimeout = (callback, delay = 0, ...args) => {
      const id = originalSetTimeout(() => undefined, 0);
      originalClearTimeout(id);
      scheduledWindowTimeouts.set(id, { delay, run: () => callback(...args) });
      return id;
    };
    windowInstance.clearTimeout = (id) => {
      if (id !== undefined) scheduledWindowTimeouts.delete(id);
    };
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      KeyboardEvent: windowInstance.KeyboardEvent,
      ResizeObserver: class { observe() {} disconnect() {} },
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useTerminalStore.getState().clearAll();
    createCalls.length = 0;
    sendCalls.length = 0;
    forceKillCalls.length = 0;
    closeCalls.length = 0;
    subscriptions.length = 0;
    connectFailure = null;
    resizeViewport = null;
    listedSessions = [];
    listFailure = false;
    rawListingRows = null;
    listingStates.length = 0;
    toastCalls.error.length = 0;
    toastCalls.info.length = 0;
    toastCalls.success.length = 0;
    openContextPreviewCalls.length = 0;
    openContextPanelTabCalls.length = 0;
    openExternalCalls.length = 0;
    detectedDevServer.command = null;
    detectedDevServer.previewUrlHint = null;
    detectedDevServer.actionId = undefined;
    mockedDeviceInfo.isMobile = true;
    effectiveDirectory = '/repo';
    projectSetupReads.length = 0;
    sessionCounter = 0;
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build' }];
    getSafeStorage().clear();
  });

  afterEach(async () => {
    try { await act(async () => root?.unmount()); }
    finally { host?.remove(); scheduledWindowTimeouts.clear(); await windowInstance?.happyDOM.close(); }
  });

  let actionOwner: ProjectActionsRunner;
  const ActionOwnerAndView = ({ showView }: { showView: boolean }) => {
    actionOwner = useProjectActionsRunner({ projectRef: { id: 'project-1', path: '/repo' }, directory: '/repo', allowMobile: true });
    return showView ? React.createElement(TerminalView, { visible: true, directory: '/repo' }) : null;
  };
  const renderOwnerAndView = async (showView: boolean) => {
    await act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(ActionOwnerAndView, { showView })));
      await Promise.resolve();
    });
  };
  const startOwnedAction = async (path: 'watched' | 'launched') => {
    mockedDeviceInfo.isMobile = false;
    if (path === 'watched') {
      const store = useTerminalStore.getState();
      store.ensureDirectory('/repo');
      const id = store.getDirectoryState('/repo')!.tabs[0]!.id;
      store.setTabPurpose('/repo', id, { type: 'project-action', actionId: 'build', executionId: 'watched-execution' });
      store.setTabSessionId('/repo', id, 'watched-session');
    }
    await renderOwnerAndView(false);
    if (path === 'launched') {
      await act(async () => { actionOwner.run(mockedActionsState.actions[0]!); await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
    }
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(entry => entry.purpose.type === 'project-action')!;
    if (!tab?.terminalSessionId || tab.purpose.type !== 'project-action' || !tab.purpose.executionId) throw new Error('Missing owned action');
    const owners = subscriptions.filter(entry => entry.sessionId === tab.terminalSessionId && !entry.closed);
    expect(owners.length).toBeGreaterThan(0);
    listedSessions = [{ sessionId: tab.terminalSessionId, cwd: '/repo', status: 'running', createdAt: 1, mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: tab.purpose.executionId } }];
    return { tabId: tab.id, sessionId: tab.terminalSessionId, executionId: tab.purpose.executionId, owners };
  };

  for (const status of ['unknown', 'closing'] as const) {
    test(`a recovered ${status} action reservation cannot grant a new Run after a successful actual listing`, async () => {
      const owned = await startOwnedAction('watched');
      await act(async () => root.unmount());
      root = createRoot(host);
      const options = useTerminalStore.persist.getOptions();
      useTerminalStore.setState(options.merge!(options.partialize!(useTerminalStore.getState()), useTerminalStore.getState()));
      rawListingRows = [{ sessionId: owned.sessionId, cwd: '/repo', status, createdAt: 1, purpose: { type: 'project-action', actionId: 'build', executionId: owned.executionId } }];
      await renderOwnerAndView(false);
      await act(async () => { actionOwner.run(mockedActionsState.actions[0]!); await Promise.resolve(); });
      const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(entry => entry.id === owned.tabId)!;
      expect(tab).toMatchObject({ terminalSessionId: owned.sessionId, lifecycle: status === 'unknown' ? 'unavailable' : 'stopping', purpose: { executionId: owned.executionId } });
      expect(createCalls).toEqual([]);
    });
  }

  for (const source of ['send', 'force'] as const) {
    test(`Stop preserves a native unknown ${source} rejection even without an owner fatal frame`, async () => {
      const owned = await startOwnedAction('watched');
      const originalSend = terminal.sendInput, originalForce = terminal.forceKill;
      const error = Object.assign(new Error('Native stop outcome unknown'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
      let observed = () => {};
      const operation = new Promise<void>(resolve => { observed = resolve; });
      terminal.sendInput = async (sessionId, input) => {
        sendCalls.push(`${sessionId}:${input}`);
        if (source === 'send') { observed(); throw error; }
      };
      terminal.forceKill = async ({ sessionId }) => { forceKillCalls.push(sessionId ?? ''); observed(); throw error; };
      try {
        await act(async () => { actionOwner.stop(mockedActionsState.actions[0]!); await operation; await Promise.resolve(); });
        const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(entry => entry.id === owned.tabId)!;
        expect(tab).toMatchObject({ terminalSessionId: owned.sessionId, lifecycle: 'unavailable', purpose: { executionId: owned.executionId } });
        expect(toastCalls.error).toContain(error.message);
        expect(sendCalls).toEqual([`${owned.sessionId}:\x03`]);
        expect(forceKillCalls).toEqual(source === 'force' ? [owned.sessionId] : []);
        expect(subscriptions.filter(entry => entry.sessionId === owned.sessionId).every(entry => entry.closed > 0)).toBe(true);
        expect(createCalls).toEqual([]);
      } finally { terminal.sendInput = originalSend; terminal.forceKill = originalForce; }
    });
  }

  for (const path of ['watched', 'launched'] as const) {
    for (const order of ['owner-first', 'view-first']) {
      test(`${path} action unknown fatal retains identity with ${order} shared delivery and hydration`, async () => {
        const owned = await startOwnedAction(path);
        const createsBeforeLoss = createCalls.length;
        await renderOwnerAndView(true);
        const view = subscriptions.find(entry => entry.sessionId === owned.sessionId && !entry.closed && !owned.owners.includes(entry));
        expect(view).toBeDefined();
        await act(async () => emitToSession(owned.sessionId, { type: 'snapshot', sequence: 1, data: '', status: 'running', ptyBackend: 'member-systemd', purpose: { type: 'project-action', actionId: 'build', executionId: owned.executionId } }));
        expect(useTerminalStore.getState().matchesActionExecution('/repo', owned.tabId, owned.executionId)).toBe(true);
        connectFailure = Object.assign(new Error('Member terminal control connection lost'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
        const delivery = order === 'owner-first' ? [...owned.owners, view!] : [view!, ...owned.owners];
        await act(async () => {
          for (const entry of delivery) entry.handlers.onError?.(connectFailure!, true);
        });
        const currentTab = () => useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(entry => entry.id === owned.tabId)!;
        expect(currentTab().terminalSessionId).toBe(owned.sessionId);
        expect(currentTab().purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: owned.executionId });
        expect(currentTab().lifecycle).toBe('unavailable');
        expect(useTerminalStore.getState().matchesActionExecution('/repo', owned.tabId, owned.executionId)).toBe(true);
        expect(toastCalls.error).toContain('Member terminal control connection lost');
        expect(host.textContent).toContain('Member terminal control connection lost');
        rawListingRows = [
          { sessionId: owned.sessionId, cwd: '/repo', status: 'unknown', createdAt: 1, mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: owned.executionId } },
          { sessionId: 'usable-peer', cwd: '/repo', status: 'running', createdAt: 2 },
        ];
        const beforeRefresh = listingStates.length;
        await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
        expect(listingStates.length).toBeGreaterThan(beforeRefresh);
        expect(listingStates[beforeRefresh]).toBe('unavailable');
        expect(currentTab()).toMatchObject({ terminalSessionId: owned.sessionId, lifecycle: 'unavailable', purpose: { executionId: owned.executionId } });
        expect(useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(tab => tab.terminalSessionId === 'usable-peer')?.lifecycle).toBe('running');
        await act(async () => resizeViewport?.(110, 40));
        await act(async () => root.unmount());
        root = createRoot(host);
        await renderOwnerAndView(true);
        expect(currentTab().terminalSessionId).toBe(owned.sessionId);
        expect(currentTab().purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: owned.executionId });
        expect(currentTab().lifecycle).toBe('unavailable');
        expect(host.textContent).toContain('Member terminal control connection lost');
        await act(async () => root.unmount());
        root = createRoot(host);
        const options = useTerminalStore.persist.getOptions();
        useTerminalStore.setState(options.merge!(options.partialize!(useTerminalStore.getState()), useTerminalStore.getState()));
        // Existing persistence resets execution intent, but retains the binding.
        expect(currentTab().terminalSessionId).toBe(owned.sessionId);
        expect(currentTab().purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });
        const beforeRecovery = subscriptions.length;
        await renderOwnerAndView(true);
        await act(async () => resizeViewport?.(120, 40));
        expect(subscriptions.slice(beforeRecovery).length).toBeGreaterThan(0);
        expect(subscriptions.slice(beforeRecovery).every(entry => entry.sessionId === owned.sessionId)).toBe(true);
        expect(currentTab().terminalSessionId).toBe(owned.sessionId);
        expect(currentTab().lifecycle).toBe('unavailable');
        expect(host.textContent).toContain('Member terminal control connection lost');
        expect(createCalls).toHaveLength(createsBeforeLoss);
      });
    }

    for (const order of ['owner-first', 'waiter-first']) {
      test(`${path} Stop unknown with ${order} delivery cannot finalize after pending input settles`, async () => {
        const owned = await startOwnedAction(path);
        rawListingRows = [...listedSessions];
        await renderOwnerAndView(true);
        await act(async () => emitToSession(owned.sessionId, { type: 'snapshot', sequence: 1, data: '', status: 'running', ptyBackend: 'member-systemd', purpose: { type: 'project-action', actionId: 'build', executionId: owned.executionId } }));
        const originalSend = terminal.sendInput;
        let release = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        terminal.sendInput = async (sessionId, input) => { sendCalls.push(`${sessionId}:${input}`); await pending; };
        const createsBefore = createCalls.length;
        const beforeStop = subscriptions.length;
        try {
          await act(async () => { actionOwner.stop(mockedActionsState.actions[0]!); });
          const waiter = subscriptions[beforeStop]!;
          expect(waiter.sessionId).toBe(owned.sessionId);
          expect(sendCalls).toEqual([`${owned.sessionId}:\x03`]);
          const error = Object.assign(new Error('Member terminal control connection lost'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' });
          connectFailure = error;
          const others = subscriptions.filter(entry => entry.sessionId === owned.sessionId && !entry.closed && entry !== waiter);
          const delivery = order === 'owner-first' ? [...others, waiter] : [waiter, ...others];
          await act(async () => { for (const entry of delivery) entry.handlers.onError?.(error, true); });
          expect(waiter.closed).toBe(1);
          await act(async () => { release(); await Promise.resolve(); });
          const current = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(tab => tab.id === owned.tabId)!;
          expect(current).toMatchObject({ terminalSessionId: owned.sessionId, lifecycle: 'unavailable', purpose: { executionId: owned.executionId } });
          expect(host.textContent).toContain(error.message);
          await act(async () => { actionOwner.stop(mockedActionsState.actions[0]!); });
          expect(sendCalls).toEqual([`${owned.sessionId}:\x03`]);
          expect(forceKillCalls).toEqual([]);
          expect(closeCalls).toEqual([]);
          expect(createCalls).toHaveLength(createsBefore);
          expect(waiter.closed).toBe(1);
        } finally { release(); terminal.sendInput = originalSend; }
      });
    }

    test(`${path} action stale unknown fatal cannot overwrite a newer execution`, async () => {
      const owned = await startOwnedAction(path);
      const store = useTerminalStore.getState();
      await act(async () => {
        const next = store.allocateActionExecution('/repo', owned.tabId, 'build');
        store.setTabSessionId('/repo', owned.tabId, 'new-session', { expectedExecutionId: next });
      });
      const before = store.getDirectoryState('/repo')!.tabs.find(tab => tab.id === owned.tabId)!;
      await act(async () => {
        for (const entry of owned.owners) entry.handlers.onError?.(Object.assign(new Error('Old control failure'), { code: 'MEMBER_TERMINAL_OUTCOME_UNKNOWN' }), true);
      });
      expect(store.getDirectoryState('/repo')!.tabs.find(tab => tab.id === owned.tabId)).toEqual(before);
      expect(toastCalls.error).toEqual([]);
    });

    test(`${path} action known KILLED fatal still clears its execution and session`, async () => {
      const owned = await startOwnedAction(path);
      await act(async () => {
        for (const entry of owned.owners) entry.handlers.onError?.(Object.assign(new Error('Terminal was killed'), { code: 'KILLED' }), true);
      });
      const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs.find(entry => entry.id === owned.tabId)!;
      expect(tab.terminalSessionId).toBeNull();
      expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });
      expect(tab.lifecycle).toBe('exited');
      expect(toastCalls.error).toEqual([]);
    });
  }

  const renderButton = async ({
    projectPath = '/repo',
    directory = '/repo',
  }: { projectPath?: string; directory?: string } = {}) => {
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(ProjectActionsScope, {
            projectRef: { id: 'project-1', path: projectPath },
            directory,
            allowMobile: true,
          }, React.createElement(HeaderProjectAction, { buttonClassName: '' })),
        ),
      );
    });
    await act(async () => { await Promise.resolve(); });
  };

  // The run or stop button; the preview globe can stand before it.
  const runButton = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Run "], button[aria-label^="Stop "]');
  const primaryLabel = () => runButton()?.getAttribute('aria-label') ?? '';
  const menuItem = (name: string) => [...host.querySelectorAll('button')]
    .find((button) => button.textContent === name);

  test('the first project action is the default, with auto-discovery last in the menu', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [
      { id: 'dev', name: 'Dev', command: 'bun run dev' },
      { id: 'build', name: 'Build', command: 'echo hello' },
    ];
    await renderButton();

    expect(primaryLabel()).toContain('Dev');
    const items = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(items.slice(-3)).toEqual(['Dev', 'Build', 'Auto-discover dev server']);
  });

  test('auto-discovery is the default when the project has no actions', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [];
    await renderButton();

    expect(primaryLabel()).toContain('Auto-discover dev server');
  });

  test('auto-discovery does not run an untrusted shared dev action when trust is skipped', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [{ id: 'dev', name: 'Dev server', command: 'bun run dev', source: 'shared' }];
    detectedDevServer.command = 'bun run dev';
    detectedDevServer.actionId = 'dev';
    await renderButton();

    await act(async () => {
      menuItem('Auto-discover dev server')?.click();
      await Promise.resolve();
    });

    expect(getSharedTrustConfirmationSnapshot()?.actions).toEqual([
      { id: 'dev', name: 'Dev server', command: 'bun run dev' },
    ]);
    expect(createCalls).toHaveLength(0);

    await act(async () => {
      settleSharedTrustConfirmation('skip');
      await Promise.resolve();
    });
    expect(createCalls).toHaveLength(0);

    await act(async () => {
      menuItem('Auto-discover dev server')?.click();
      await Promise.resolve();
    });
    expect(getSharedTrustConfirmationSnapshot()?.actions).toHaveLength(1);
    await act(async () => {
      settleSharedTrustConfirmation('trust');
      await Promise.resolve();
    });
    const created = createCalls[0];
    if (created?.mode !== 'command') throw new Error('expected command terminal');
    expect(created.command).toBe('bun run dev');
  });

  test('auto-discovery in a worktree session reads the project\'s setup and trust', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [{ id: 'dev', name: 'Dev server', command: 'bun run dev', source: 'shared' }];
    detectedDevServer.command = 'bun run dev';
    detectedDevServer.actionId = 'dev';
    effectiveDirectory = '/worktrees/feature';
    await renderButton({ projectPath: '/repo', directory: '/worktrees/feature' });

    await act(async () => {
      menuItem('Auto-discover dev server')?.click();
      await Promise.resolve();
    });

    // The same config the menu reads, so trust given in one counts in the other.
    expect(projectSetupReads.at(-1)).toEqual({ id: 'project-1', path: '/repo' });
    await act(async () => {
      settleSharedTrustConfirmation('skip');
      await Promise.resolve();
    });
  });

  test('the picked action is still selected after the button mounts again', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [
      { id: 'dev', name: 'Dev', command: 'bun run dev' },
      { id: 'build', name: 'Build', command: 'echo hello' },
    ];
    await renderButton();
    await act(async () => {
      menuItem('Auto-discover dev server')?.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => root.unmount());
    root = createRoot(host);
    await renderButton();

    expect(primaryLabel()).toContain('Auto-discover dev server');
  });

  test('a running action takes the button over the first idle one', async () => {
    mockedDeviceInfo.isMobile = false;
    const originalList = terminal.listSessions;
    Object.assign(terminal, { listSessions: async () => [{
      sessionId: 'peer-run', cwd: '/repo', status: 'running', createdAt: 1, mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'peer-execution' },
    }] });
    try {
      await renderButton();
      await act(async () => { await Promise.resolve(); });
      const primary = runButton();
      expect(primary?.getAttribute('aria-label') ?? '').toContain('Build');
    } finally { terminal.listSessions = originalList; }
  });

  test('adopting a saved URL action does not auto-open a different output URL', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', autoOpenUrl: true, openUrl: 'http://localhost:4000' }];
    const originalList = terminal.listSessions;
    Object.assign(terminal, { listSessions: async () => [{
      sessionId: 'peer-run', cwd: '/repo', status: 'running', createdAt: 1, mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'peer-execution' },
    }] });
    try {
      await renderButton();
      await act(async () => { emitToSession('peer-run', { type: 'snapshot', sequence: 1, status: 'running', data: 'Local: http://localhost:5173/\n' }); });
      expect(openExternalCalls).toEqual([]);
    } finally { terminal.listSessions = originalList; }
  });

  test('a second run keeps its tab and displays fresh output under a new terminal ID', async () => {
    const originalCreate = terminal.createSession;
    Object.assign(terminal, { createSession: async (options: CreateTerminalOptions) => {
      createCalls.push(options);
      return { sessionId: options.sessionId, cols: 80, rows: 24, status: 'running', mode: 'command', purpose: options.purpose };
    } });
    try {
      await renderButton();
      const button = runButton();
      if (!button) throw new Error('missing action button');
      await act(async () => { button.click(); });
      const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
      if (!tab?.terminalSessionId) throw new Error('missing action terminal');
      const originalSessionId = tab.terminalSessionId;
      await act(async () => {
        emitToSession(originalSessionId, { type: 'snapshot', status: 'running', sequence: 5, data: 'old output' });
        emitToSession(originalSessionId, { type: 'exit', sequence: 6 });
      });
      await act(async () => { button.click(); });
      expect(secondSessionId()).not.toBe(firstSessionId());
      await act(async () => {
        emitToSession(secondSessionId(), { type: 'snapshot', status: 'running', sequence: 1, data: 'new output' });
      });
      const buffer = useTerminalStore.getState().getBuffer('/repo', tab.id);
      expect(buffer.chunks.map(chunk => chunk.data).join('')).toBe('new output');
    } finally { terminal.createSession = originalCreate; }
  });

  test('a stale rerun adopts the server run without closing it', async () => {
    await renderButton();
    const button = runButton();
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
    await act(async () => { emitToSession(firstSessionId(), { type: 'exit', sequence: 2 }); });
    const originalList = terminal.listSessions;
    const serverSession = {
      sessionId: firstSessionId(), cwd: '/repo', status: 'running', createdAt: 1,
      mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'other-client-new-run' },
    };
    Object.assign(terminal, { listSessions: async () => [serverSession] });
    try {
      await act(async () => { button.click(); });
      expect(closeCalls).toEqual([]);
      const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
      expect(tab?.purpose).toEqual(serverSession.purpose);
    } finally {
      terminal.listSessions = originalList;
    }
  });

  test('parent action manual URL opens in the current worktree panel', async () => {
    effectiveDirectory = '/repo-worktree';
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', runIn: 'parent', autoOpenUrl: true, openUrl: 'http://localhost:4000' }];
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });
    const button = runButton();
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
    expect(openContextPreviewCalls).toEqual([{ directory: '/repo-worktree', url: 'http://localhost:4000/' }]);
  });

  test('replaced executions cannot be cleared by their still-open old stream', async () => {
    await renderButton();
    const button = runButton();
    if (!button) throw new Error('missing action button');
    await act(async () => { button.click(); });
    await act(async () => {
      useTerminalStore.getState().reconcileServerSessions('/repo', [{
        sessionId: 'other-session', cwd: '/repo', status: 'running', createdAt: 2,
        mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'new-execution' },
      }]);
    });
    await act(async () => { emitToSession(firstSessionId(), { type: 'exit', sequence: 10 }); });
    const tab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(tab?.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: 'new-execution' });
    expect(tab?.lifecycle).toBe('running');
  });

  test('runs, stops, and reruns on the same action tab while cleaning old subscriptions once', async () => {
    await renderButton();

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const firstTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(firstTab?.terminalSessionId).toBe(firstSessionId());
    expect(firstTab?.purpose.type).toBe('project-action');
    const firstExecution = firstTab?.purpose.type === 'project-action' ? firstTab.purpose.executionId : null;
    expect(firstExecution).not.toBeNull();

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const stoppedTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(stoppedTab?.lifecycle).toBe('exited');
    expect(stoppedTab?.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const rerunTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(rerunTab?.id).toBe(firstTab?.id);
    expect(rerunTab?.terminalSessionId).toBe(secondSessionId());
    expect(rerunTab?.lifecycle).toBe('running');
    const secondExecution = rerunTab?.purpose.type === 'project-action' ? rerunTab.purpose.executionId : null;
    expect(secondExecution).not.toBeNull();
    expect(secondExecution).not.toBe(firstExecution);

    expect(createCalls).toHaveLength(2);
    expect(sendCalls).toEqual([`${firstSessionId()}:\x03`]);
    expect(forceKillCalls).toEqual([]);
    expect(closeCalls).toEqual([]);
    expect(subscriptions.map((entry) => entry.closed)).toEqual([1, 1, 0]);
  });

  test('default action runs in the current worktree and stores its tab there', async () => {
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo-worktree');
    expect(useTerminalStore.getState().getDirectoryState('/repo-worktree')?.tabs.some((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === 'build')).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.some((tab) => tab.purpose.type === 'project-action') ?? false).toBe(false);
    expect(openContextPanelTabCalls).toEqual([{ directory: '/repo-worktree', mode: 'terminal', targetDirectory: null }]);
  });

  test('parent action runs in the parent checkout, stores its tab there, and reveals it from the live worktree host', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build', runIn: 'parent' }];
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo');
    expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.some((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === 'build')).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState('/repo-worktree')?.tabs.some((tab) => tab.purpose.type === 'project-action') ?? false).toBe(false);
    expect(openContextPanelTabCalls).toEqual([{ directory: '/repo-worktree', mode: 'terminal', targetDirectory: '/repo' }]);
  });

  test('project action reveal uses the live effective host instead of the sticky action context directory', async () => {
    effectiveDirectory = '/live-host';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo-worktree');
    expect(openContextPanelTabCalls).toEqual([{ directory: '/live-host', mode: 'terminal', targetDirectory: '/repo-worktree' }]);
  });

  test('auto-discover without a preview hint settles on an announced localhost URL in context preview only', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [];
    detectedDevServer.command = 'bun run dev';
    await renderButton();

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const autoDiscoverTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => (
      tab.purpose.type === 'project-action' && tab.purpose.actionId === '__openchamber_auto_discover_preview__'
    ));
    expect(autoDiscoverTab?.terminalSessionId).toBe(firstSessionId());

    await act(async () => {
      emitToSession(firstSessionId(), {
        type: 'data',
        data: 'Ready at http://127.0.0.1:4321\n',
        sequence: 1,
        replayData: undefined,
      });
    });
    await runWindowTimeouts(3_000);

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:4321' }]);
    expect(openExternalCalls).toEqual([]);
    await runWindowTimeouts(15_000);
    expect(openContextPanelTabCalls).toEqual([]);
  });

  test('auto-discover opens its terminal when no preview URL appears before the fallback timeout', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [];
    detectedDevServer.command = 'bun run dev';
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo' });

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openContextPanelTabCalls).toEqual([]);
    effectiveDirectory = '/switched-after-launch';
    await runWindowTimeouts(15_000);
    expect(openContextPanelTabCalls).toEqual([{ directory: '/repo-worktree', mode: 'terminal', targetDirectory: '/repo' }]);
  });

  test('unmount closes active subscriptions and cancels pending preview timeouts', async () => {
    mockedDeviceInfo.isMobile = false;
    mockedActionsState.actions = [];
    detectedDevServer.command = 'bun run dev';
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo' });

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((entry) => entry.closed === 0)).toBe(true);

    await act(async () => {
      root.unmount();
    });

    expect(subscriptions.every((entry) => entry.closed === 1)).toBe(true);

    effectiveDirectory = '/switched-after-unmount';
    await runWindowTimeouts(15_000);
    expect(openContextPanelTabCalls).toEqual([]);
  });

  test('stops watching running subscriptions when their execution directory leaves the watched set', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build', runIn: 'parent' }];
    effectiveDirectory = '/repo-worktree';
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((entry) => entry.closed === 0)).toBe(true);

    await renderButton({ projectPath: '/other-repo', directory: '/other-repo' });

    expect(subscriptions.every((entry) => entry.closed === 1)).toBe(true);
  });

  test('manual action URL does not open a second output-derived URL', async () => {
    mockedActionsState.actions = [{
      id: 'build',
      name: 'Build',
      command: 'echo hello',
      icon: 'build',
      autoOpenUrl: true,
      openUrl: '127.0.0.1:3000',
    }];
    await renderButton();

    const primaryButton = runButton();
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:3000/' }]);
    expect(openExternalCalls).toEqual([]);

    await act(async () => {
      emitToSession(firstSessionId(), {
        type: 'data',
        data: 'Server listening at http://127.0.0.1:4000\n',
        sequence: 1,
        replayData: undefined,
      });
      await Promise.resolve();
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:3000/' }]);
    expect(openExternalCalls).toEqual([]);
  });
});
