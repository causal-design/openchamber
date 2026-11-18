// Read at use time: an administrator's opt-out wins over client parameters.
export const areUpdateChecksDisabled = () => ['1', 'true'].includes(
  (process.env.OPENCHAMBER_DISABLE_UPDATE_CHECKS ?? '').trim().toLowerCase(),
);

export const UPDATE_CHECKS_DISABLED_RESPONSE = Object.freeze({
  code: 'UPDATE_CHECKS_DISABLED',
  error: 'Update checks and installation are disabled for this deployment.',
});
