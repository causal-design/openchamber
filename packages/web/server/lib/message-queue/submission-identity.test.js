import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createMessageQueueRuntime, parseQueuedItemInput } from './runtime.js';

const submissionID = 'msg_19dc2744f002vWF6MRk9iS970t';
const sessionID = 'ses_identity_test';
const directory = '/repo';
const admissionIDs = [
  submissionID,
  'msg_19dc2744f00240d5773ea54107',
  'msg_19dc2744f002c89ee6e1f39aa0',
  'msg_19dc2744f002e316b5f6ff7e6e',
  'msg_19dc2744f002a183b35a3f4714',
  'msg_19dc2744f002572b8508842c8a',
  'msg_19dc2744f002e5ef30101e57fa',
];
const input = () => ({
  submissionID,
  metadata: { workspace: { sender: { id: 'bob', kind: 'human' }, project: 'A', submissionID } },
  content: 'follow up', text: 'follow up',
  sendConfig: { providerID: 'openai', modelID: 'chosen', agent: 'build', variant: 'high' },
  context: [
    { kind: 'context', instructions: 'read this', text: 'captured', metadata: { keep: true } },
    { kind: 'instruction', text: 'standing instruction' },
  ],
  goal: { tokenBudget: 1000 },
});

describe('queued submission identity', () => {
  it.each(['msg_bad', 'msg_ABCDEFGHIJKLsuffix', '', null, 42])('keeps malformed submission %j outside the queue', (id) => {
    expect(() => parseQueuedItemInput({ ...input(), submissionID: id })).toThrow('invalid submission ID');
  });

  it('retains exact child IDs across lost acknowledgement, restart and forced retry', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submission-identity-'));
    const runtimes = [];
    onTestFinished(async () => {
      for (const runtime of runtimes) runtime.stop();
      for (const runtime of runtimes) await runtime.flush();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    let goal;
    let goalSaves = 0;
    let loseAck = true;
    let completed = false;
    const sent = [];
    const lookups = [];
    const createRuntime = () => {
      const runtime = createMessageQueueRuntime({
        dataDir, dispatchQuietMs: 60_000,
        buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
        getOpenCodeAuthHeaders: () => ({}),
        persistSessionGoal: async (_session, _directory, value) => { goal = value; goalSaves += 1; },
        readSessionGoal: async () => goal,
        fetchImpl: async (url, init = {}) => {
          if (init.method !== 'POST') {
            const pathname = new URL(url).pathname;
            lookups.push(pathname);
            if (pathname === `/api/session/${sessionID}`) return Response.json({ data: { id: sessionID } });
            if (completed && pathname.endsWith('/inbox')) return Response.json({ data: [] });
            if (completed && pathname === '/api/experimental/session-operation/msg_19dc2744f002572b8508842c8a') {
              return Response.json({ data: { sessionID } });
            }
            return new Response(null, { status: 404 });
          }
          const route = new URL(url).pathname.split('/').at(-1);
          const body = JSON.parse(init.body);
          sent.push({ route, body });
          if (route === 'prompt' && loseAck) {
            loseAck = false;
            throw new Error('lost acknowledgement');
          }
          return Response.json({ data: { id: body.id ?? 'selection' } });
        },
      });
      runtimes.push(runtime);
      return runtime;
    };
    const first = createRuntime();
    await first.enqueue(sessionID, directory, input());
    expect(first.sessionSnapshot(sessionID).items[0].admissionIDs).toEqual(admissionIDs);
    await expect(first.forceSend(sessionID, submissionID)).rejects.toThrow('lost acknowledgement');
    expect(first.sessionSnapshot(sessionID).items).toHaveLength(1);
    first.stop();
    await first.flush();

    const second = createRuntime();
    await second.load();
    expect(second.sessionSnapshot(sessionID).items[0].admissionIDs).toEqual(admissionIDs);
    const repeat = await second.enqueue(sessionID, directory, input());
    expect(repeat.itemId).toBe(submissionID);
    expect(second.sessionSnapshot(sessionID).items).toHaveLength(1);
    await second.forceSend(sessionID, submissionID, { id: 'alice', kind: 'human' });
    expect(second.sessionSnapshot(sessionID).items).toEqual([]);
    expect(goal.id).toBe('msg_19dc2744f00282c25a5bbba802');
    expect(goalSaves).toBe(1);
    const messages = sent.filter(({ route }) => route === 'synthetic' || route === 'prompt');
    const ids = [...admissionIDs.slice(1, 4), admissionIDs[6], submissionID];
    expect(messages.map(({ body }) => body.id)).toEqual([...ids, ...ids]);
    expect(messages[1].body.metadata).toMatchObject({ keep: true, workspace: { sender: { id: 'bob' } } });
    expect(messages[3].body.metadata.workspace).toMatchObject({ sender: { kind: 'automation' }, contributions: [input().metadata.workspace] });
    expect(messages[9].body.metadata.workspace.controlActor).toEqual({ id: 'alice', kind: 'human' });
    expect(sent.filter(({ route }) => route === 'model').map(({ body }) => body)).toEqual([
      { model: { providerID: 'openai', id: 'chosen', variant: 'high' } },
      { model: { providerID: 'openai', id: 'chosen', variant: 'high' } },
    ]);
    expect(sent.filter(({ route }) => route === 'agent').map(({ body }) => body)).toEqual([{ agent: 'build' }, { agent: 'build' }]);
    completed = true;
    const sentCount = sent.length;
    await second.forceSend(sessionID, submissionID);
    expect(lookups.at(-1)).toBe('/api/experimental/session-operation/msg_19dc2744f002572b8508842c8a');
    expect(sent).toHaveLength(sentCount);
  });
});
