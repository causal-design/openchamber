import { afterEach, expect, test } from 'bun:test';
import { areUpdateChecksDisabled, UPDATE_CHECKS_DISABLED_RESPONSE } from './update-policy.js';

const previous = process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
  else process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = previous;
});

test.each(['1', 'true', ' TRUE ', 'True'])('explicit opt-out %j', (value) => {
  process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = value;
  expect(areUpdateChecksDisabled()).toBe(true);
});

test.each(['', '0', 'false', 'yes', '2'])('keeps default behavior for %j', (value) => {
  process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS = value;
  expect(areUpdateChecksDisabled()).toBe(false);
});

test('missing means enabled checks, and disabled never claims up-to-date', () => {
  delete process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS;
  expect(areUpdateChecksDisabled()).toBe(false);
  expect(UPDATE_CHECKS_DISABLED_RESPONSE.code).toBe('UPDATE_CHECKS_DISABLED');
  expect(UPDATE_CHECKS_DISABLED_RESPONSE).not.toHaveProperty('available');
});
