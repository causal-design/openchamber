import { afterAll, expect, mock, test } from 'bun:test';

const previous = process.env.VITE_OPENCHAMBER_DISABLE_UPDATE_CHECKS;
process.env.VITE_OPENCHAMBER_DISABLE_UPDATE_CHECKS = '1';
afterAll(() => {
  if (previous === undefined) delete process.env.VITE_OPENCHAMBER_DISABLE_UPDATE_CHECKS;
  else process.env.VITE_OPENCHAMBER_DISABLE_UPDATE_CHECKS = previous;
});
let requests = 0;
let nativeCalls = 0;
const fetch = mock(async () => {
  requests += 1;
  return Response.json({ available: true, latestVersion: '9.9.9' });
});
const native = mock(async () => {
  nativeCalls += 1;
  return { available: true, currentVersion: '1.0.0' };
});
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: fetch }));
mock.module('@/lib/device', () => ({ getDeviceInfo: () => ({ deviceType: 'desktop' }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ reportUsage: true }) } }));
mock.module('@/lib/desktop', () => ({
  checkForDesktopUpdates: native,
  downloadDesktopUpdate: native,
  restartToApplyUpdate: native,
  isDesktopLocalOriginActive: () => true,
  isElectronShell: () => true,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => false,
}));
mock.module('@/lib/platform', () => ({ getClientPlatform: () => 'web', isCapacitorApp: () => false }));
mock.module('@/lib/i18n/store', () => ({
  formatMessage: () => '', useI18nStore: { getState: () => ({ dictionary: {} }) },
}));
const { checkConnectedServerForUpdates, useUpdateStore } = await import('./useUpdateStore');
const { fetchOpenCodeUpgradeStatus, runOpenCodeUpgrade } = await import('@/components/update/openCodeUpgrade');
const { installWebUpdate, waitForUpdateApplied } = await import('@/lib/web-update');

test('manual, About, native, and reconnect paths perform no transport or install work', async () => {
  useUpdateStore.setState({ available: true, downloaded: true, runtimeType: 'desktop', info: { available: true, currentVersion: '1.0.0', version: '9.9.9' } });
  await useUpdateStore.getState().downloadUpdate();
  await useUpdateStore.getState().restartToUpdate();
  await useUpdateStore.getState().checkForUpdates();
  expect(useUpdateStore.getState().available).toBe(false);
  expect(useUpdateStore.getState().downloaded).toBe(false);
  expect(useUpdateStore.getState().info).toBeNull();
  await expect(checkConnectedServerForUpdates()).rejects.toThrow('UPDATE_CHECKS_DISABLED');
  await expect(fetchOpenCodeUpgradeStatus()).rejects.toThrow('UPDATE_CHECKS_DISABLED');
  await expect(runOpenCodeUpgrade('fixture')).rejects.toThrow('UPDATE_CHECKS_DISABLED');
  expect(await installWebUpdate(fetch)).toEqual({ success: false, error: 'UPDATE_CHECKS_DISABLED' });
  expect(await waitForUpdateApplied({ owner: 'package-manager' }, undefined, { fetchUpdate: fetch }))
    .toEqual({ status: 'failed', error: 'UPDATE_CHECKS_DISABLED' });
  expect(requests).toBe(0);
  expect(nativeCalls).toBe(0);
});
