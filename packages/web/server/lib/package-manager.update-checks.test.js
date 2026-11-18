import { afterAll, expect, mock, test } from 'bun:test';

const spawn = mock(() => ({ status: 1, stdout: '', stderr: '' }));
const registry = mock(() => ({ url: 'https://registry.example.test/package', headers: {} }));
mock.module('child_process', () => ({ spawnSync: spawn }));
mock.module('./enterprise-mode.js', () => ({ isEnterpriseMode: () => false }));
mock.module('./changelog/update-notes.js', () => ({ fetchUpdateNotes: async () => undefined }));
mock.module('./opencode/npm-registry-config.js', () => ({ resolveNpmRegistryRequest: registry }));
const { checkForUpdates } = await import('./package-manager.js');
const previous = process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
const previousData = process.env.OPENCHAMBER_DATA_DIR;
const previousFetch = globalThis.fetch;
const fetch = mock(async () => Response.json({
  latestVersion: '9.9.9', updateAvailable: true, 'dist-tags': { latest: '9.9.9' },
}));
globalThis.fetch = fetch;
process.env.OPENCHAMBER_DATA_DIR = '/nonexistent/openchamber-update-check-fixture';
afterAll(() => {
  globalThis.fetch = previousFetch;
  if (previous === undefined) delete process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
  else process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = previous;
  if (previousData === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousData;
});

test('stops the actual shared CLI/web lookup before package-manager, feed, registry or notes', async () => {
  process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = '1';
  await expect(checkForUpdates({ currentVersion: '2.6.0', reportUsage: false }))
    .rejects.toMatchObject({ code: 'UPDATE_CHECKS_DISABLED' });
  expect(spawn).not.toHaveBeenCalled();
  expect(registry).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test('the same recorder sees default-enabled production lookups', async () => {
  process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = 'false';
  const result = await checkForUpdates({ currentVersion: '2.6.0', reportUsage: false });
  expect(result.available).toBe(true);
  expect(fetch).toHaveBeenCalled();
  expect(registry).toHaveBeenCalled();
});
