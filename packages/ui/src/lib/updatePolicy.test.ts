import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

for (const value of ['1', 'true', ' TRUE ', '', '0', 'false']) {
  test(`bundle flag ${JSON.stringify(value)} has the server flag semantics`, () => {
    const helper = new URL('./updatePolicy.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['-e', `import { UPDATE_CHECKS_DISABLED, assertUpdateChecksEnabled } from ${JSON.stringify(helper)}; let refused=false; try { assertUpdateChecksEnabled() } catch { refused=true } console.log(JSON.stringify({disabled:UPDATE_CHECKS_DISABLED,refused}));`], {
      env: { ...process.env, VITE_OPENCHAMBER_DISABLE_UPDATE_CHECKS: value },
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    const disabled = ['1', 'true'].includes(value.trim().toLowerCase());
    expect(JSON.parse(child.stdout)).toEqual({ disabled, refused: disabled });
  });
}
