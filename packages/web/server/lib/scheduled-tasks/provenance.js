import { createHash } from 'node:crypto';

const admission = process.env.PEIRCE_ADMISSION_HELPERS ? await import(process.env.PEIRCE_ADMISSION_HELPERS) : null;

// One identity per native scheduler execution/occurrence, not a work ledger.
export const scheduledChildID = (id, label) => `msg_${id.slice(4, 16)}${createHash('sha256').update(`${id}:${label}`).digest('hex').slice(0, 14)}`;

export const scheduledSubmission = (projectID, task, reason, when, actor) => {
  const prefix = ((BigInt(Math.round(when)) * 4096n) & ((1n << 48n) - 1n)).toString(16).padStart(12, '0');
  const id = scheduledChildID(`msg_${prefix}`, `${projectID}:${task.id}:${reason}:${when}`);
  const contributions = [task.metadata?.workspace, actor?.workspace].filter(Boolean);
  const workspace = {
    sender: { id: 'openchamber-scheduler', name: 'Scheduled task', kind: 'automation' },
    source: 'scheduled-task', project: task.metadata?.workspace?.project,
    submissionID: id, taskID: task.id, reason, contributions,
  };
  if (actor?.workspace?.sender) workspace.controlActor = actor.workspace.sender;
  return { id, metadata: { workspace } };
};

export const validateScheduledSubmission = async (directory, submission) => {
  if (admission) await admission.validateScheduled(directory, submission);
};
