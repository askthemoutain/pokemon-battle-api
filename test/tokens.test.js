import assert from 'node:assert/strict';
import test from 'node:test';

import { signToken, verifyTrainerTicket } from '../tokens.js';


test('trainer tickets are signed, scoped, and expiring', () => {
    const payload = {
        v: 1,
        kind: 'trainer',
        aud: 'pokemon-battle-api',
        exp: 1300,
        testMode: true,
    };
    const token = signToken(payload, 'shared-secret');
    assert.deepEqual(verifyTrainerTicket(token, 'shared-secret', 1000), payload);
    assert.throws(() => verifyTrainerTicket(token, 'wrong-secret', 1000), /signature/);
    assert.throws(() => verifyTrainerTicket(token, 'shared-secret', 1400), /expired/);
});
