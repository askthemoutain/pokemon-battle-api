import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BattleManager,
    TrainerUnavailableError,
} from '../battle-manager.js';
import { signToken } from '../tokens.js';


const SECRET = 'trainer-ticket-secret';

function ticket(testMode = false) {
    return signToken({
        v: 1,
        kind: 'trainer',
        aud: 'pokemon-battle-api',
        exp: Math.floor(Date.now() / 1000) + 300,
        testMode,
    }, SECRET);
}

function pokemon(species, moves, extras = {}) {
    return {
        species,
        moves,
        level: 50,
        nature: 'Serious',
        ...extras,
    };
}

function payload(encounterType = 'trainer') {
    return {
        requestId: `${encounterType}-start-1`,
        encounterType,
        trainerTicket: encounterType === 'trainer' ? ticket(true) : undefined,
        p1: {
            name: 'Player',
            team: [pokemon('Pikachu', ['Thunderbolt', 'Quick Attack'])],
        },
        p2: {
            name: 'Trainer',
            team: [pokemon('Garchomp', ['Earthquake', 'Dragon Claw'])],
        },
    };
}

class FakeFoulPlay {
    constructor(choices = []) {
        this.configured = true;
        this.choices = [...choices];
        this.calls = [];
    }

    async decision(request) {
        this.calls.push(request);
        const choice = this.choices.shift();
        if (choice instanceof Error) throw choice;
        if (!choice) throw new Error('No fake decision configured.');
        return { ok: true, action: choice, iterations: 1 };
    }
}

test('wild encounters never call Foul Play', async t => {
    const ai = new FakeFoulPlay();
    const manager = new BattleManager({ foulPlayClient: ai });
    t.after(() => manager.close());

    const started = await manager.start(payload('wild'));
    const acted = await manager.action({
        battleId: started.battleId,
        actionId: 'wild-action-1',
        action: 'move 1',
    });

    assert.equal(started.trainer, false);
    assert.equal(acted.success, true);
    assert.equal(ai.calls.length, 0);
});

test('player switch slots stay stable after Showdown reorders the party', async t => {
    const ai = new FakeFoulPlay();
    const manager = new BattleManager({ foulPlayClient: ai });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'stable-switch-start';
    input.p1.team = [
        pokemon('Garchomp', ['Protect']),
        pokemon('Rotom-Wash', ['Protect']),
    ];
    input.p2.team = [pokemon('Blissey', ['Splash'])];

    const started = await manager.start(input);
    const switchedOut = await manager.action({
        battleId: started.battleId,
        actionId: 'stable-switch-1',
        action: 'switch 2',
    });
    const switchedBack = await manager.action({
        battleId: started.battleId,
        actionId: 'stable-switch-2',
        action: 'switch 1',
    });

    assert.equal(switchedOut.state.p1Active.species, 'Rotom-Wash');
    assert.equal(switchedOut.state.p1Active.slot, 2);
    assert.equal(switchedBack.state.p1Active.species, 'Garchomp');
    assert.equal(switchedBack.state.p1Active.slot, 1);
});

test('trainer start is idempotent and sends only p2-private plus public data', async t => {
    const ai = new FakeFoulPlay(['team 1']);
    const manager = new BattleManager({
        foulPlayClient: ai,
        trainerTicketSecret: SECRET,
        trainerAiEnabled: true,
    });
    t.after(() => manager.close());
    const input = payload('trainer');

    const first = await manager.start(input);
    const duplicate = await manager.start(input);

    assert.equal(first.battleId, duplicate.battleId);
    assert.equal(first.state.p1Active.slot, 1);
    assert.equal(first.state.p1Active.species, 'Pikachu');
    assert.equal(first.state.p2Active.slot, 1);
    assert.equal(first.state.p2Active.species, 'Garchomp');
    assert.equal(ai.calls.length, 1);
    assert.equal(ai.calls[0].initialRequest.side.id, 'p2');
    assert.equal(ai.calls[0].activeRequest.side.id, 'p2');
    assert.equal(ai.calls[0].transcript.includes('|split|'), false);
    assert.equal(ai.calls[0].transcript.includes('|request|'), false);
    assert.match(ai.calls[0].transcript, /\|poke\|p1\|Pikachu/);
});

test('AI failure leaves the player turn untouched and eventually signs an abort', async t => {
    const ai = new FakeFoulPlay(['team 1', new Error('offline')]);
    const manager = new BattleManager({
        foulPlayClient: ai,
        trainerTicketSecret: SECRET,
        trainerAiEnabled: true,
        abortAfterMs: 0,
    });
    t.after(() => manager.close());
    const started = await manager.start(payload('trainer'));
    const record = manager.getRecord(started.battleId);
    const before = {
        turn: record.battle.turn,
        p1hp: record.battle.p1.active[0].hp,
        p2hp: record.battle.p2.active[0].hp,
        log: [...record.battle.log],
    };

    await assert.rejects(
        manager.action({ battleId: started.battleId, actionId: 'failed-1', action: 'move 1' }),
        error => {
            assert.ok(error instanceof TrainerUnavailableError);
            assert.equal(error.details.abortAvailable, true);
            assert.equal(typeof error.details.abortToken, 'string');
            return true;
        },
    );

    assert.deepEqual({
        turn: record.battle.turn,
        p1hp: record.battle.p1.active[0].hp,
        p2hp: record.battle.p2.active[0].hp,
        log: [...record.battle.log],
    }, before);
});

test('trainer forced switch is resolved by Foul Play and action retry is idempotent', async t => {
    const ai = new FakeFoulPlay(['team 1', 'move 1', 'switch 2']);
    const manager = new BattleManager({
        foulPlayClient: ai,
        trainerTicketSecret: SECRET,
        trainerAiEnabled: true,
    });
    t.after(() => manager.close());
    const input = {
        requestId: 'forced-start',
        encounterType: 'trainer',
        trainerTicket: ticket(),
        p1: {
            name: 'Player',
            team: [pokemon('Mewtwo', ['Psystrike'], { level: 100, ability: 'Pressure' })],
        },
        p2: {
            name: 'Trainer',
            team: [
                pokemon('Caterpie', ['Tackle'], { level: 1, ability: 'Shield Dust' }),
                pokemon('Weedle', ['Poison Sting'], { level: 1, ability: 'Shield Dust' }),
            ],
        },
    };
    const started = await manager.start(input);
    const action = {
        battleId: started.battleId,
        actionId: 'forced-action-1',
        action: 'move 1',
    };

    const first = await manager.action(action);
    const duplicate = await manager.action(action);

    assert.equal(first.state.p2Active.name, 'Weedle');
    assert.equal(first.state.p2Active.slot, 2);
    assert.equal(first.state.p2Active.species, 'Weedle');
    assert.deepEqual(duplicate, first);
    assert.deepEqual(ai.calls.map(call => call.requestType), ['team', 'move', 'switch']);
});
