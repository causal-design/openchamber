import { afterAll, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createUpdateChecksWindow } from '@/hooks/update-checks-window.fixture';

const calls = vi.hoisted(() => ({
  check: vi.fn(async () => null),
  status: vi.fn(async () => ({ availableVersion: '2.2.6', supported: true })),
  dismiss: vi.fn(),
  notice: vi.fn(),
  switched: null as null | ((event: { runtimeKey: string }) => void),
}));
vi.mock('@/lib/updatePolicy', () => ({ UPDATE_CHECKS_DISABLED: true }));
vi.mock('@/stores/useUpdateStore', () => ({ useUpdateStore: (select: (state: object) => unknown) => select({ checkForUpdates: calls.check }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign(
  (select: (state: object) => unknown) => select({ showOpenCodeUpdateNotifications: true }),
  { getState: () => ({ showOpenCodeUpdateNotifications: true }) },
) }));
vi.mock('@/components/update/openCodeUpgrade', () => ({ fetchOpenCodeUpgradeStatus: calls.status, runOpenCodeUpgrade: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { dismiss: calls.dismiss, info: calls.notice } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('@/stores/useAgentsStore', () => ({ reloadOpenCodeConfiguration: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn() }));
vi.mock('@/stores/utils/safeStorage', () => ({ getDeferredSafeStorage: () => ({ getItem: () => null }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'fixture',
  subscribeRuntimeEndpointChanged: (fn: typeof calls.switched) => { calls.switched = fn; return () => { calls.switched = null; }; },
}));

const browser = createUpdateChecksWindow();
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { useUpdatePolling } = await import('@/hooks/useUpdatePolling');
const { OpenCodeUpdateToast } = await import('@/components/update/OpenCodeUpdateToast');
const container = document.createElement('div');
const root = createRoot(container);

afterAll(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  Object.assign(browser, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it('creates no check timers or update subscriptions and dismisses a stale notice', async () => {
  vi.useFakeTimers();
  Object.assign(browser, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  function Fixture() { useUpdatePolling(); return <OpenCodeUpdateToast />; }
  await act(async () => root.render(<Fixture />));
  expect(vi.getTimerCount()).toBe(0);
  expect(calls.switched).toBeNull();
  await act(async () => {
    browser.dispatchEvent(new browser.CustomEvent('openchamber:opencode-update-available', { detail: { version: '2.2.6' } }));
    browser.dispatchEvent(new browser.Event('focus'));
    browser.document.dispatchEvent(new browser.Event('visibilitychange'));
    calls.switched?.({ runtimeKey: 'fixture' });
    await vi.advanceTimersByTimeAsync(3_700_000);
  });
  expect(calls.check).not.toHaveBeenCalled();
  expect(calls.status).not.toHaveBeenCalled();
  expect(calls.notice).not.toHaveBeenCalled();
  expect(calls.dismiss).toHaveBeenCalledWith('opencode-update-available');
});
