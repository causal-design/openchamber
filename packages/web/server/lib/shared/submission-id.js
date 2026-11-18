import { createHash } from 'node:crypto';

// Callers own validation. The scheduler also seeds IDs with only a time prefix.
export const childID = (id, label) => `msg_${id.slice(4, 16)}${createHash('sha256').update(`${id}:${label}`).digest('hex').slice(0, 14)}`;
