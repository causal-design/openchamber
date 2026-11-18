import { describe, expect, test } from 'bun:test';
import type { AssistantFinish, Message, Part } from '@/lib/opencode/model';
import { attachSyntheticContext } from '../attachSyntheticContext';
import { projectTurnRecords } from './projectTurnRecords';
import { buildTurnWindowModel, updateTurnWindowModelIncremental } from './windowTurns';
import type { ChatMessageEntry } from './types';

const entry = (info: Message): ChatMessageEntry => ({ info, parts: [] });

const answer = (id: string, finish: AssistantFinish): ChatMessageEntry => entry({
    id, sessionID: 's', role: 'assistant', time: { created: 2 }, agent: 'build', providerID: 'p', modelID: 'm', finish,
});

function message({ id, role, parentID }: { id: string; role: 'user' | 'assistant' | 'system'; parentID?: string }): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            time: { created: 1 },
        } as Message,
        parts: [] as Part[],
    };
}

describe('windowTurns', () => {
    const precedingOpeners: ChatMessageEntry[] = [
        entry({ id: 'user', sessionID: 's', role: 'user', time: { created: 1 } }),
        entry({ id: 'compaction', sessionID: 's', role: 'compaction', time: { created: 1 }, status: 'completed', reason: 'auto', summary: 'Fixture summary' }),
        entry({
            id: 'earlier-goal', sessionID: 's', role: 'synthetic', time: { created: 1 },
            text: 'Earlier objective', description: 'Earlier goal', metadata: { source: 'goal', goalID: 'earlier-goal' },
        }),
    ];

    for (const opener of precedingOpeners) {
        test(`keeps the Goal opener and reply ownership after ${opener.info.id} with no assistant step`, () => {
            const kickoff = entry({
                id: 'goal', sessionID: 's', role: 'synthetic', time: { created: 3 },
                text: 'Fixture objective', description: 'Native goal kickoff', metadata: { source: 'goal', goalID: 'goal' },
            });
            const reply = answer('reply', 'stop');
            reply.info.time = { created: 4, completed: 5 };
            const before = [opener];
            const withKickoff = [...before, kickoff];
            const messages = [...withKickoff, reply];
            const projection = projectTurnRecords(attachSyntheticContext(messages), { mergeHiddenUserTurns: true });
            const incrementalKickoff = updateTurnWindowModelIncremental(buildTurnWindowModel(before), before, withKickoff);
            const incrementalReply = updateTurnWindowModelIncremental(incrementalKickoff, withKickoff, messages);
            const expectedTurnIds = [opener.info.id, 'goal'];

            expect(projection.turns.map((turn) => turn.turnId)).toEqual(expectedTurnIds);
            expect(buildTurnWindowModel(messages).turnIds).toEqual(expectedTurnIds);
            expect(incrementalReply?.turnIds).toEqual(expectedTurnIds);
            expect(projection.turns[0]?.assistantMessageIds).toEqual([]);
            expect(projection.turns[0]?.waitingNotices).toBeUndefined();
            expect(projection.turns[1]?.assistantMessageIds).toEqual(['reply']);
            expect(projection.indexes.messageToTurnId.get('reply')).toBe('goal');
        });
    }

    test('opens one native Goal turn after an earlier answer in both full and incremental projections', () => {
        const before = [message({ id: 'u1', role: 'user' }), answer('a1', 'stop')];
        const kickoff = entry({
            id: 'goal', sessionID: 's', role: 'synthetic', time: { created: 3 },
            text: 'Fixture objective', description: 'Native goal kickoff', metadata: { source: 'goal', goalID: 'goal' },
        });
        const messages = [...before, kickoff];
        const initial = buildTurnWindowModel(before);
        const incremental = updateTurnWindowModelIncremental(initial, before, messages);
        const withReply = [...messages, answer('a2', 'stop')];

        expect(incremental?.turnIds).toEqual(['u1', 'goal']);
        expect(buildTurnWindowModel(withReply).turnIds).toEqual(['u1', 'goal']);
        expect(projectTurnRecords(attachSyntheticContext(withReply)).turns.map((turn) => turn.turnId)).toEqual(['u1', 'goal']);
    });

    test('does not map assistant messages without a parent to the current turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant' });

        const model = buildTurnWindowModel([user, assistant]);

        expect(model.messageToTurnId.get('u1')).toBe('u1');
        expect(model.messageToTurnId.has('a1')).toBe(false);
    });

    test('incremental update does not map assistant messages without a parent to the current turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant' });
        const base = buildTurnWindowModel([user]);

        const next = updateTurnWindowModelIncremental(base, [user], [user, assistant]);

        expect(next?.messageToTurnId.get('u1')).toBe('u1');
        expect(next?.messageToTurnId.has('a1')).toBe(false);
    });

    test('opens a turn at a notice between two answers, matching the rendered turns', () => {
        const messages: ChatMessageEntry[] = [
            entry({ id: 'u1', sessionID: 's', role: 'user', time: { created: 1 } }),
            answer('a1', 'stop'),
            entry({ id: 'idle1', sessionID: 's', role: 'idle', time: { created: 3 }, outcome: 'succeeded' }),
            entry({ id: 'sys1', sessionID: 's', role: 'system', time: { created: 3 }, text: 'Instructions updated' }),
            answer('a2', 'stop'),
        ];

        const model = buildTurnWindowModel(messages);

        expect(model.turnIds).toEqual(['u1', 'sys1']);
        expect(model.turnMessageStartIndexes).toEqual([0, 3]);
        expect(model.messageToTurnId.get('idle1')).toBe('u1');
        expect(model.turnIds).toEqual(projectTurnRecords(attachSyntheticContext(messages)).turns.map((turn) => turn.turnId));
        // Appending the reply rebuilds, since its turn starts at the notice.
        expect(updateTurnWindowModelIncremental(buildTurnWindowModel(messages.slice(0, 4)), messages.slice(0, 4), messages)).toBeNull();
    });

    test('keeps one turn when the notice sits between steps of one run', () => {
        const model = buildTurnWindowModel([
            entry({ id: 'u1', sessionID: 's', role: 'user', time: { created: 1 } }),
            answer('a1', 'tool-calls'),
            entry({ id: 'sys1', sessionID: 's', role: 'system', time: { created: 3 }, text: 'Instructions updated' }),
            answer('a2', 'stop'),
        ]);

        expect(model.turnIds).toEqual(['u1']);
    });

    test('maps assistant messages to their parent user turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant', parentID: 'u1' });

        const model = buildTurnWindowModel([user, assistant]);

        expect(model.messageToTurnId.get('a1')).toBe('u1');
    });
});
