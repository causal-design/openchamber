// Deployment opt-out, fixed into the bundle so disabled clients schedule no work.
export const UPDATE_CHECKS_DISABLED = ['1', 'true'].includes(
  import.meta.env?.VITE_OPENCHAMBER_DISABLE_UPDATE_CHECKS?.trim().toLowerCase() ?? '',
);

export function assertUpdateChecksEnabled(): void {
  if (UPDATE_CHECKS_DISABLED) throw new Error('UPDATE_CHECKS_DISABLED');
}
