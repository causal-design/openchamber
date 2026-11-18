import { describe, expect, it } from 'vitest';
import { scheduledChildID, scheduledSubmission } from './provenance.js';

describe('submission child identity compatibility', () => {
  it.each([
    ['msg_19dc2744f002vWF6MRk9iS970t', 'goal-briefing', 'msg_19dc2744f002e5ef30101e57fa'],
    ['msg_00000000000000000000000000', 'operation-started', 'msg_000000000000c26e816be3fea7'],
    ['msg_ffffffffffffZZZZZZZZZZZZZZ', 'operation-completed', 'msg_ffffffffffff2e0b6a348c047b'],
    // The scheduler seeds an identity with only the time prefix.
    ['msg_19dc2744f002', 'project-A:task-1:scheduled:1770000000000', 'msg_19dc2744f00258a1f3b7815680'],
    ['msg_19dc2744f002vWF6MRk9iS970t', 'queue-context-0', 'msg_19dc2744f00240d5773ea54107'],
    // This derivation does not validate or repair malformed IDs.
    ['msg_bad', 'goal-briefing', 'msg_bad7180bef5f6926b'],
    ['msg_ABCDEFGHIJKLsuffix', 'operation-completed', 'msg_ABCDEFGHIJKLddfa5b30ec94b0'],
    ['', '', 'msg_e7ac0786668e0f'],
  ])('retains the existing result for %j and %j', (id, label, expected) => {
    expect(scheduledChildID(id, label)).toBe(expected);
    expect(scheduledChildID(id, label)).toBe(expected);
  });

  it.each([null, undefined, 42, {}])('does not coerce a non-sliceable input %j', (id) => {
    expect(() => scheduledChildID(id, 'goal-briefing')).toThrow(TypeError);
  });

  it('retains occurrence identity and human contribution lineage', () => {
    const initiator = { sender: { id: 'alice', kind: 'human' }, project: 'project-A' };
    const control = { sender: { id: 'bob', kind: 'human' }, project: 'project-A' };
    const task = { id: 'task-1', metadata: { workspace: initiator } };
    const submission = scheduledSubmission('project-A', task, 'scheduled', 1770000000000, { workspace: control });
    expect(submission).toEqual({
      id: 'msg_c1c38a400000d9e95bb31c08c8',
      metadata: { workspace: {
        sender: { id: 'openchamber-scheduler', name: 'Scheduled task', kind: 'automation' },
        source: 'scheduled-task', project: 'project-A', submissionID: 'msg_c1c38a400000d9e95bb31c08c8',
        taskID: 'task-1', reason: 'scheduled', contributions: [initiator, control], controlActor: control.sender,
      } },
    });
    expect(scheduledSubmission('project-A', task, 'scheduled', 1770000000000, { workspace: control })).toEqual(submission);
    expect(scheduledSubmission('project-A', task, 'manual', 1770000000000).id).not.toBe(submission.id);
    expect(scheduledSubmission('project-A', { id: 'task-1' }, 'scheduled', 1770000000000).metadata.workspace.contributions).toEqual([]);
  });
});
