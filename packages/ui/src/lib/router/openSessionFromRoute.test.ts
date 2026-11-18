import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import { useBtwStore } from '@/stores/useBtwStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { createProjectIdFromPath } from '@/lib/projectId';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { invalidateSettingsCache, syncDesktopSettings, updateDesktopSettings, type SettingsSyncedDetail } from '@/lib/persistence';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { getRememberedSessionDirectory, useSessionUIStore } from '@/sync/session-ui-store';
import { openSessionFromToast } from '@/sync/session-navigation';

import { openSession, openSessionFromRoute, openSessionLink } from './openSessionFromRoute';

const SESSION_ID = 'ses_linear_open';
const PROJECT_DIR = '/projects/linear-from-url';
const OTHER_DIR = '/projects/linear-from-url-other';
const WORKTREE_DIR = '/projects/linear-from-url-worktrees/feature';

const BTW_PARENT_ID = 'ses_btw_parent';
const BTW_FORK_ID = 'ses_btw_fork';

const buildSession = (id: string, directory: string): Session => ({
  id,
  projectID: 'project',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
});

const buildBtwFork = (parentId: string, directory: string): Session => ({
  ...buildSession(BTW_FORK_ID, directory),
  parentID: parentId,
  metadata: { openchamber: { kind: 'btw', originalSessionID: parentId } },
});

const useSessions = (sessions: Session[]): void => {
  useGlobalSessionsStore.setState({
    activeSessions: sessions,
    archivedSessions: [],
    entityById: new Map(sessions.map((session) => [session.id, session])),
    hasLoaded: true,
    status: 'ready',
  });
};

describe('openSessionFromRoute', () => {
  let fetchGuard: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  test('native jump-list entries ignore unknown sessions and open known sessions', async () => {
    useSessions([buildSession(SESSION_ID, PROJECT_DIR)]);
    useSessionUIStore.getState().setCurrentSession(SESSION_ID, PROJECT_DIR);
    await openSession('ses_unknown', { requireKnownSession: true });
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
    useSessionUIStore.getState().setCurrentSession(null);
    await openSession(SESSION_ID, { requireKnownSession: true });
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
  });

  test('a jump-list lookup does not override a session selected while it waits', async () => {
    const otherId = 'ses_selected_after_jump';
    useSessions([buildSession(SESSION_ID, PROJECT_DIR), buildSession(otherId, OTHER_DIR)]);
    useSessionUIStore.getState().setCurrentSession(null);
    const opening = openSession(SESSION_ID, { requireKnownSession: true });
    useSessionUIStore.getState().setCurrentSession(otherId, OTHER_DIR);
    await opening;
    expect(useSessionUIStore.getState().currentSessionId).toBe(otherId);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(OTHER_DIR);
  });
  beforeEach(() => {
    fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Route/store tests must not contact a runtime');
    });
    useProjectsStore.setState({ projects: [PROJECT_DIR, OTHER_DIR, WORKTREE_DIR].map((path) => ({ id: path, path })) });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
    useSessionUIStore.getState().setCurrentSession(null);
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      entityById: new Map(),
      sessionsByDirectory: new Map(),
      hasLoaded: true,
      status: 'ready',
    });
    useBtwStore.setState({ byParent: {} });
  });

  afterEach(() => {
    fetchGuard.mockRestore();
  });

  for (const bootstrapFirst of [false, true]) {
    test(`keeps the saved session's project and routing directory when bootstrap arrives ${bootstrapFirst ? 'before' : 'after'} route selection`, async () => {
      const directory = `${PROJECT_DIR}/research`;
      const projectId = createProjectIdFromPath(PROJECT_DIR);
      // A failed pointer save leaves the shared snapshot selecting B. The
      // session's own record still owns A's subfolder.
      const settings = {
        projects: [
          { id: createProjectIdFromPath(PROJECT_DIR), path: PROJECT_DIR, label: 'A' },
          { id: createProjectIdFromPath(OTHER_DIR), path: OTHER_DIR, label: 'B' },
        ],
        activeProjectId: createProjectIdFromPath(OTHER_DIR),
      };
      useSessions([buildSession(SESSION_ID, directory)]);
      if (bootstrapFirst) useProjectsStore.getState().synchronizeFromSettings(settings);
      await openSessionFromRoute(SESSION_ID);
      if (!bootstrapFirst) useProjectsStore.getState().synchronizeFromSettings(settings);

      expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory);
      expect(useProjectsStore.getState().activeProjectId).toBe(projectId);
      expect(useProjectsStore.getState().getActiveProject()?.label).toBe('A');
      expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
      expect(opencodeClient.getDirectory()).toBe(directory);

      // Reapplying the same URL need not change the session id or directory.
      await openSessionFromRoute(SESSION_ID);
      expect(useProjectsStore.getState().activeProjectId).toBe(projectId);
      expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
      expect(opencodeClient.getDirectory()).toBe(directory);
    });
  }

  for (const linkedWorktree of [false, true]) {
    test(`keeps the ${linkedWorktree ? 'worktree' : 'project'} session subfolder through settings bootstrap and saved-directory replay after a denied save`, async () => {
      const directory = `${linkedWorktree ? WORKTREE_DIR : PROJECT_DIR}/research`;
      const settings = {
        projects: [PROJECT_DIR, OTHER_DIR].map((path) => ({ id: createProjectIdFromPath(path), path })),
        activeProjectId: createProjectIdFromPath(OTHER_DIR),
        lastDirectory: OTHER_DIR,
      };
      useSessions([buildSession(SESSION_ID, directory)]);
      if (linkedWorktree) useSessionUIStore.setState({ availableWorktreesByProject: new Map([[PROJECT_DIR, [{
        path: WORKTREE_DIR, projectDirectory: PROJECT_DIR, branch: 'feature', label: 'feature',
      }]]]) });
      await openSessionFromRoute(SESSION_ID);
      // Drain selection's deferred local writes before attaching the window.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const storage = getSafeStorage();
      const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      const previousAPIs = getRegisteredRuntimeAPIs();
      const testWindow = Object.assign(new EventTarget(), {
        localStorage: storage,
        location: new URL('https://u47.invalid'),
        setTimeout,
        clearTimeout,
      });
      // Imports intentionally ran without a window, so attach the production
      // settings-event bridge without starting browser bootstrap side effects.
      const onSettings = (event: Event) => {
        if (!(event instanceof CustomEvent)) throw new Error('Expected a settings CustomEvent');
        // SAFETY: This isolated EventTarget receives settings events only from
        // syncDesktopSettings, whose dispatch supplies SettingsSyncedDetail.
        // The instance check above establishes the CustomEvent envelope.
        const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
        useProjectsStore.getState().synchronizeFromSettings(detail.settings, { adoptActiveProject: detail.bootstrap });
      };
      testWindow.addEventListener('openchamber:settings-synced', onSettings);
      const availability = spyOn(opencodeClient, 'getDirectoryAvailability').mockResolvedValue('available');
      const saves: Request[] = [];
      try {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
        // Use the ordinary web settings transport with local responses only.
        registerRuntimeAPIs(null);
        fetchGuard.mockImplementation(async (input, init) => {
          const request = input instanceof Request
            ? new Request(input, init)
            : new Request(new URL(input.toString(), testWindow.location), init);
          if (new URL(request.url).pathname !== '/api/config/settings') throw new Error('Unexpected runtime request');
          if (request.method === 'GET') return Response.json(settings);
          if (request.method !== 'PUT') throw new Error('Unexpected settings method');
          saves.push(request);
          return new Response('Owner-only shared settings', { status: 403 });
        });
        invalidateSettingsCache();
        const save = updateDesktopSettings({ activeProjectId: createProjectIdFromPath(PROJECT_DIR), lastDirectory: directory });
        testWindow.dispatchEvent(new Event('pagehide'));
        expect(await save).toEqual({ ok: false });
        expect(saves).toHaveLength(1);

        // SessionAuthGate awaits these 2 calls in this order.
        await syncDesktopSettings({ bootstrap: true });
        await applyPersistedDirectoryPreferences();

        expect({
          session: useSessionUIStore.getState().currentSessionId,
          sessionDirectory: useSessionUIStore.getState().currentSessionDirectory,
          project: useProjectsStore.getState().getActiveProject()?.path,
          directory: useDirectoryStore.getState().currentDirectory,
          clientDirectory: opencodeClient.getDirectory(),
          savedDirectory: storage.getItem('lastDirectory'),
        }).toEqual({
          session: SESSION_ID, sessionDirectory: directory, project: PROJECT_DIR,
          directory, clientDirectory: directory, savedDirectory: directory,
        });
        expect(settings.lastDirectory).toBe(OTHER_DIR);
        await openSessionFromRoute(SESSION_ID);
        expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
      } finally {
        // Drain failed pending writes while their captured runtime/window still
        // exist, then release mocks and globals on success and assertion failure.
        const drain = updateDesktopSettings({});
        testWindow.dispatchEvent(new Event('pagehide'));
        await drain;
        await new Promise((resolve) => setTimeout(resolve, 0));
        testWindow.removeEventListener('openchamber:settings-synced', onSettings);
        availability.mockRestore();
        registerRuntimeAPIs(previousAPIs);
        invalidateSettingsCache();
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
        else Reflect.deleteProperty(globalThis, 'localStorage');
      }
    });
  }

  test('keeps the linked worktree subfolder while bootstrap reconciles its owning project', async () => {
    const directory = `${WORKTREE_DIR}/research`;
    useSessions([buildSession(SESSION_ID, directory)]);
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([[PROJECT_DIR, [{
      path: WORKTREE_DIR, projectDirectory: PROJECT_DIR, branch: 'feature', label: 'feature',
    }]]]) });
    await openSessionFromRoute(SESSION_ID);

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [PROJECT_DIR, OTHER_DIR].map((path) => ({ id: createProjectIdFromPath(path), path })),
      activeProjectId: createProjectIdFromPath(OTHER_DIR),
    });

    expect(useProjectsStore.getState().activeProjectId).toBe(createProjectIdFromPath(PROJECT_DIR));
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(directory);
    expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
    expect(opencodeClient.getDirectory()).toBe(directory);
  });

  test('repairs bootstrap routing even when the project pointer and registry already match', async () => {
    const settings = {
      projects: [PROJECT_DIR, OTHER_DIR].map((path) => ({ id: createProjectIdFromPath(path), path })),
      activeProjectId: createProjectIdFromPath(PROJECT_DIR),
    };
    useProjectsStore.getState().synchronizeFromSettings(settings);
    useSessions([buildSession(SESSION_ID, PROJECT_DIR)]);
    await openSessionFromRoute(SESSION_ID);
    useDirectoryStore.getState().setDirectory(OTHER_DIR);

    useProjectsStore.getState().synchronizeFromSettings(settings);

    expect(useDirectoryStore.getState().currentDirectory).toBe(PROJECT_DIR);
    expect(opencodeClient.getDirectory()).toBe(PROJECT_DIR);
  });

  test('preserves a deliberate window-local project and directory on a non-bootstrap sync', async () => {
    const settings = {
      projects: [PROJECT_DIR, OTHER_DIR].map((path) => ({ id: createProjectIdFromPath(path), path })),
      activeProjectId: createProjectIdFromPath(PROJECT_DIR),
    };
    useProjectsStore.getState().synchronizeFromSettings(settings);
    useSessions([buildSession(SESSION_ID, PROJECT_DIR)]);
    await openSessionFromRoute(SESSION_ID);
    useProjectsStore.getState().setActiveProject(createProjectIdFromPath(OTHER_DIR));

    useProjectsStore.getState().synchronizeFromSettings(settings, { adoptActiveProject: false });

    expect(useProjectsStore.getState().activeProjectId).toBe(createProjectIdFromPath(OTHER_DIR));
    expect(useDirectoryStore.getState().currentDirectory).toBe(OTHER_DIR);
    expect(opencodeClient.getDirectory()).toBe(OTHER_DIR);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });

  test('still adopts the shared bootstrap choice without changing a fresh draft', () => {
    useSessionUIStore.setState((state) => ({ newSessionDraft: {
      ...state.newSessionDraft,
      draftId: 47,
      open: true,
      target: 'project',
      selectedProjectId: createProjectIdFromPath(PROJECT_DIR),
      directoryOverride: PROJECT_DIR,
    } }));
    const draft = useSessionUIStore.getState().newSessionDraft;
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [PROJECT_DIR, OTHER_DIR].map((path) => ({ id: createProjectIdFromPath(path), path })),
      activeProjectId: createProjectIdFromPath(OTHER_DIR),
    });

    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft).toBe(draft);
    expect(draft.open).toBe(true);
    expect(draft.directoryOverride).toBe(PROJECT_DIR);
    expect(useProjectsStore.getState().activeProjectId).toBe(createProjectIdFromPath(OTHER_DIR));
    expect(useDirectoryStore.getState().currentDirectory).toBe(OTHER_DIR);
    expect(opencodeClient.getDirectory()).toBe(OTHER_DIR);
  });

  test('a delayed route completion cannot undo the newer session selected before bootstrap', async () => {
    const sessions = [buildSession(SESSION_ID, PROJECT_DIR), buildSession('ses_newer_selection', OTHER_DIR)];
    useSessions(sessions);
    useGlobalSessionsStore.setState({ hasLoaded: false });
    let finishLoad!: (value: { activeSessions: Session[]; archivedSessions: Session[] }) => void;
    const pending = new Promise<{ activeSessions: Session[]; archivedSessions: Session[] }>((resolve) => {
      finishLoad = resolve;
    });
    const load = spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(() => pending);
    try {
      const opening = openSessionFromRoute(SESSION_ID);
      useSessionUIStore.getState().setCurrentSession('ses_newer_selection', OTHER_DIR);
      useProjectsStore.getState().synchronizeFromSettings({
        projects: [PROJECT_DIR, OTHER_DIR].map((path) => ({ id: createProjectIdFromPath(path), path })),
        activeProjectId: createProjectIdFromPath(PROJECT_DIR),
      });
      finishLoad({ activeSessions: sessions, archivedSessions: [] });
      await opening;

      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_newer_selection');
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe(OTHER_DIR);
      expect(useProjectsStore.getState().activeProjectId).toBe(createProjectIdFromPath(OTHER_DIR));
      expect(useDirectoryStore.getState().currentDirectory).toBe(OTHER_DIR);
      expect(opencodeClient.getDirectory()).toBe(OTHER_DIR);
    } finally {
      finishLoad({ activeSessions: sessions, archivedSessions: [] });
      load.mockRestore();
    }
  });

  test('selects the routed session once the global list knows its directory', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(SESSION_ID, PROJECT_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });

    await openSessionFromRoute(SESSION_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });

  // Scheduled tasks' "Open session" opens a run's session by id while the
  // project root is active; a session in a linked worktree must open there.
  test('opens a worktree session in its worktree while the project root is active', async () => {
    const rootId = 'ses_linear_root';
    const worktreeId = 'ses_linear_worktree';
    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(rootId, PROJECT_DIR), buildSession(worktreeId, WORKTREE_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });
    useSessionUIStore.getState().setCurrentSession(rootId, PROJECT_DIR);

    await openSessionFromRoute(worktreeId);

    expect(useSessionUIStore.getState().currentSessionId).toBe(worktreeId);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORKTREE_DIR);
    expect(getRememberedSessionDirectory(worktreeId).runtime).toBe(WORKTREE_DIR);
  });

  test('replaces a guessed directory once the global list knows the owner', async () => {
    const id = 'ses_linear_guessed';
    useSessionUIStore.getState().setCurrentSession(id);
    const guessed = useSessionUIStore.getState().currentSessionDirectory;

    useGlobalSessionsStore.setState({
      activeSessions: [buildSession(id, OTHER_DIR)],
      archivedSessions: [],
      hasLoaded: true,
      status: 'ready',
    });

    await openSessionFromRoute(id);

    expect(useSessionUIStore.getState().currentSessionId).toBe(id);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(OTHER_DIR);
    expect(guessed).not.toBe(OTHER_DIR);
  });

  // A /btw fork is a side transcript inside its parent's panel: opening it by
  // id (a completion notification, a push, a toast) must land on the parent.
  test('opens a /btw fork as its parent and expands the parent panel', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);
    useBtwStore.getState().setPanelState(BTW_PARENT_ID, { collapsed: true });
    useSessionUIStore.getState().setCurrentSession(SESSION_ID, OTHER_DIR);

    await openSessionFromRoute(BTW_FORK_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]?.collapsed).toBe(false);
  });

  // A cold launch from a notification may not have the fork record yet: the
  // first selection guesses, and the global list then resolves the parent.
  test('resolves a fork once the global list arrives', async () => {
    useGlobalSessionsStore.setState({
      activeSessions: [
        buildSession(BTW_PARENT_ID, PROJECT_DIR),
        buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
      ],
      archivedSessions: [],
      entityById: new Map(),
      hasLoaded: false,
      status: 'ready',
    });

    await openSessionFromRoute(BTW_FORK_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]?.collapsed).toBe(false);
  });

  test('opens a fork as itself when its parent is gone', async () => {
    useSessions([buildBtwFork(BTW_PARENT_ID, PROJECT_DIR)]);

    await openSessionFromRoute(BTW_FORK_ID);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_FORK_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });

  // The toast's "Open session" reaches this module through the opener it
  // registers, so moving that registration out of the session store must keep
  // the toast path working.
  test('opens a toast target through the opener this module registers', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);

    openSessionFromToast(BTW_FORK_ID, PROJECT_DIR);

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]?.collapsed).toBe(false);
  });

  // A message link names one message inside the transcript that holds it. For
  // a `/btw` answer that transcript is the fork, so the fork opens alone.
  test('keeps a /btw fork when a message link names it', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);

    await openSessionLink(BTW_FORK_ID, 'msg_btw_answer');

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_FORK_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
    expect(useBtwStore.getState().byParent[BTW_PARENT_ID]).toBeUndefined();
  });

  // A desktop notification carries the directory of the session it names, so
  // the parent is selected immediately instead of after the global list loads.
  test('opens a notification target as the parent without waiting for the list', async () => {
    useSessions([
      buildSession(BTW_PARENT_ID, PROJECT_DIR),
      buildBtwFork(BTW_PARENT_ID, PROJECT_DIR),
    ]);

    const opening = openSession(BTW_FORK_ID, { directory: PROJECT_DIR });

    expect(useSessionUIStore.getState().currentSessionId).toBe(BTW_PARENT_ID);
    await opening;
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(PROJECT_DIR);
  });
});
