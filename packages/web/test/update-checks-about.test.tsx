import { afterAll, afterEach, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createUpdateChecksWindow } from '@/hooks/update-checks-window.fixture';

const fixture = vi.hoisted(() => ({ disabled: true, mobile: false, requests: [] as string[] }));
vi.mock('@/lib/updatePolicy', () => ({
  get UPDATE_CHECKS_DISABLED() { return fixture.disabled; },
  assertUpdateChecksEnabled: () => { if (fixture.disabled) throw new Error('UPDATE_CHECKS_DISABLED'); },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: async (url: string) => {
  const pathname = url.split('?')[0];
  fixture.requests.push(pathname);
  if (pathname === '/api/system/info') return Response.json({ openchamberVersion: '2.6.0', runtime: 'web' });
  if (pathname === '/api/opencode/version') return Response.json({ version: '2.2.5-u29.1' });
  if (pathname === '/api/opencode/upgrade-status') return fixture.disabled
    ? Response.json({ code: 'UPDATE_CHECKS_DISABLED' }, { status: 403 })
    : Response.json({ currentVersion: '2.2.5-u29.1', latestVersion: '2.2.6', available: true, upgrade: { supported: true } });
  throw new Error(`Unexpected About request: ${pathname}`);
} }));
vi.mock('@/stores/useUpdateStore', () => ({ useUpdateStore: (select: (state: object) => unknown) => select({
  info: null, checking: false, available: false, error: null, downloading: false,
  downloaded: false, installing: false, progress: null, runtimeType: 'web',
  checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), restartToUpdate: vi.fn(),
}), checkConnectedServerForUpdates: vi.fn() }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile }) }));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => false }));
vi.mock('@/hooks/useDesktopRemoteHostActive', () => ({ useDesktopRemoteHostActive: () => false }));
vi.mock('@/lib/desktopNative', () => ({ getDesktopAppVersion: async () => null }));
vi.mock('@/lib/desktop', () => ({ getDesktopUpdateChannel: async () => 'stable', setDesktopUpdateChannel: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ loadDesktopSettings: async () => ({ serverUpdateChannel: 'stable' }), updateDesktopSettings: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }));
vi.mock('@/stores/useAgentsStore', () => ({ reloadOpenCodeConfiguration: vi.fn() }));
vi.mock('@/lib/debug', () => ({ debugUtils: { buildDiagnosticsReport: async () => 'fixture', copyTextToClipboard: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: { version?: string }) => `${key} ${params?.version ?? ''}` }),
  getCurrentIntlLocale: () => 'en-GB',
}));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('@/components/ui/AboutLogo', () => ({ AboutLogo: () => null }));
vi.mock('@/components/ui/UpdateDialog', () => ({ UpdateDialog: () => null }));
vi.mock('@/components/sections/openchamber/InstanceServiceUrls', () => ({ InstanceServiceUrls: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsFieldRow: ({ children, label }: { children: React.ReactNode; label: string }) => <div>{label}{children}</div>,
  SettingsChipGroup: () => null,
  SETTINGS_BRAND_TITLE_CLASS: '',
}));

const browser = createUpdateChecksWindow();
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { AboutSettings } = await import('@/components/sections/openchamber/AboutSettings');
const { AboutDialog } = await import('@/components/ui/AboutDialog');
let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; });
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it.each([
  ['settings desktop', false, false], ['settings mobile', false, true], ['dialog', true, false],
] as const)('%s displays the connected version with release checking disabled', async (_name, dialog, mobile) => {
  fixture.disabled = true;
  fixture.mobile = mobile;
  fixture.requests = [];
  const host = document.createElement('div');
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(dialog ? <AboutDialog open onOpenChange={() => {}} /> : <AboutSettings />));
  expect(host.textContent).toContain('2.2.5-u29.1');
  expect(fixture.requests).toContain('/api/opencode/version');
  expect(fixture.requests.filter((path) => /upgrade|update-check|update-install|install-v2/.test(path))).toEqual([]);
  expect(host.textContent).not.toContain('2.2.6');
  expect(host.textContent).not.toContain('actions.checkForUpdates');
});

it.each([['settings', false], ['dialog', true]] as const)('%s retains default-enabled release status and actual version', async (_name, dialog) => {
  fixture.disabled = false;
  fixture.mobile = false;
  fixture.requests = [];
  const host = document.createElement('div');
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(dialog ? <AboutDialog open onOpenChange={() => {}} /> : <AboutSettings />));
  expect(host.textContent).toContain('2.2.5-u29.1');
  expect(fixture.requests).toContain('/api/opencode/upgrade-status');
  expect(fixture.requests).not.toContain('/api/opencode/version');
  if (!dialog) expect(host.textContent).toContain('2.2.6');
});
