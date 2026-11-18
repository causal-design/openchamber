import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { registerOpenChamberRoutes } from './openchamber-routes.js';

const checks = vi.hoisted(() => ({ checkForUpdates: vi.fn(async () => ({ available: false })) }));
vi.mock('../package-manager.js', () => ({ ...checks, isUnmanagedInstall: () => true }));
const previous = process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
const previousRuntime = process.env.OPENCHAMBER_RUNTIME;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (previous === undefined) delete process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
  else process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = previous;
  if (previousRuntime === undefined) delete process.env.OPENCHAMBER_RUNTIME;
  else process.env.OPENCHAMBER_RUNTIME = previousRuntime;
});

describe('pinned deployment update opt-out', () => {
  it('leaves default checks enabled and detects actual lookup calls in the fixture', async () => {
    delete process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
    const fetch = vi.fn(async () => Response.json({ version: '2.2.6' }));
    vi.stubGlobal('fetch', fetch);
    const app = express();
    registerOpenCodeRoutes(app, {
      getOpenCodeUpgradeCapability: () => ({ supported: true }),
      buildOpenCodeUrl: () => 'http://localhost/api/info',
      getOpenCodeAuthHeaders: () => ({}),
    });
    registerOpenChamberRoutes(app, { process });
    await request(app).get('/api/opencode/upgrade-status').expect(200);
    await request(app).get('/api/openchamber/update-check?reportUsage=false').expect(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(checks.checkForUpdates).toHaveBeenCalledOnce();
  });

  it.each(['1', 'true', ' TRUE '])('refuses checks and installs before any updater for %j', async (flag) => {
    process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = flag;
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    const fetch = vi.fn(async () => Response.json({ version: '2.2.6' }));
    vi.stubGlobal('fetch', fetch);
    const upgrade = vi.fn(async () => {});
    const desktop = { check: vi.fn(), install: vi.fn(), restart: vi.fn() };
    const app = express();
    app.use(express.json());
    registerOpenCodeRoutes(app, {
      getOpenCodeUpgradeCapability: () => ({ supported: true }),
      getOpenCodeCompatibility: async () => ({ canInstall: true }),
      installOpenCodeV2: upgrade,
      upgradeOpenCodeCli: upgrade,
      buildOpenCodeUrl: () => 'http://localhost/api/info',
      getOpenCodeAuthHeaders: () => ({}),
    });
    registerOpenChamberRoutes(app, { process, desktopUpdater: desktop });
    for (const route of [
      '/api/opencode/upgrade-status',
      '/api/openchamber/update-check?appType=web&reportUsage=false',
      '/api/openchamber/update-check?appType=desktop-electron&reportUsage=false',
      '/api/openchamber/update-check?appType=mobile-capacitor&reportUsage=false&currentVersion=1.0.0&platform=android',
    ]) {
      const response = await request(app).get(route);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'UPDATE_CHECKS_DISABLED' });
      expect(response.body.available).not.toBe(false);
    }
    for (const route of ['/api/opencode/upgrade', '/api/opencode/install-v2', '/api/openchamber/update-install']) {
      await request(app).post(route).send({}).expect(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(checks.checkForUpdates).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
    expect(desktop.check).not.toHaveBeenCalled();
    expect(desktop.install).not.toHaveBeenCalled();
  });
});
