import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { FoulPlayClient } from '../foul-play-client.js';


test('Foul Play client signs the exact JSON body', async () => {
    let captured;
    const client = new FoulPlayClient({
        url: 'https://ai.example',
        secret: 'ai-secret',
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true, action: 'move 2' }),
            };
        },
    });
    const payload = { battleId: 'battle-1', transcript: '|start' };
    const result = await client.decision(payload);

    const timestamp = captured.options.headers['x-fp-timestamp'];
    const expected = crypto
        .createHmac('sha256', 'ai-secret')
        .update(`${timestamp}.${captured.options.body}`)
        .digest('hex');
    assert.equal(captured.url, 'https://ai.example/v1/decision');
    assert.equal(captured.options.headers['x-fp-signature'], expected);
    assert.equal(result.action, 'move 2');
});
