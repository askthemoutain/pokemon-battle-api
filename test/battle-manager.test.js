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

function battleTicket(opponents, encounterType = 'wild', options = {}) {
    return signToken({
        v: 1,
        kind: 'battle',
        aud: 'pokemon-battle-api',
        sub: 'Player',
        localBattleId: '11111111-1111-4111-8111-111111111111',
        encounterType,
        opponents,
        players: options.players || [pokemon('Pikachu', ['Thunderbolt', 'Quick Attack'])],
        playerState: options.playerState || {},
        exp: Math.floor(Date.now() / 1000) + 300,
        testMode: false,
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

    const input = payload('wild');
    input.p2.team = [pokemon('Blissey', ['Splash'])];
    const started = await manager.start(input);
    const acted = await manager.action({
        battleId: started.battleId,
        actionId: 'wild-action-1',
        expectedRevision: started.state.revision,
        action: 'move 1',
    });

    assert.equal(started.trainer, false);
    assert.equal(started.state.schemaVersion, 2);
    assert.equal(started.state.revision, 1);
    assert.equal(started.state.turn, 1);
    assert.equal(started.state.phase, 'move');
    assert.equal(started.state.p1.activeSlot, 1);
    assert.equal(started.state.p1.party[0].active, true);
    assert.equal(started.state.p1.party[0].moveSlots[0].move, 'Thunderbolt');
    assert.equal(started.state.p2.party[0].moveSlots, undefined);
    assert.equal(started.state.p2.party[0].item, undefined);
    assert.equal(acted.success, true);
    assert.equal(acted.state.revision, 2);
    assert.equal(acted.state.turn, 2);
    assert.equal(
        acted.state.p1.party[0].moveSlots[0].pp,
        started.state.p1.party[0].moveSlots[0].pp - 1,
    );
    assert.equal(ai.calls.length, 0);
});

test('signed wild ticket fixes opponent identity and server-owned moves', async t => {
    const manager = new BattleManager({
        foulPlayClient: new FakeFoulPlay(),
        trainerTicketSecret: SECRET,
    });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'signed-wild-start';
    input.p1.team = [pokemon('Mewtwo', ['Psystrike'], { level: 100 })];
    input.p2.team = [pokemon('Pikachu', ['Splash'], { level: 12, ivs: { hp: 0 } })];
    input.battleTicket = battleTicket([{ species: 'Pikachu', level: 12, shiny: false }]);

    const started = await manager.start(input);
    const record = manager.getRecord(started.battleId);
    assert.equal(record.battle.p1.pokemon[0].species.name, 'Pikachu');
    assert.equal(record.battle.p2.pokemon[0].level, 12);
    assert.equal(record.battle.p2.pokemon[0].moveSlots.some(move => move.id === 'splash'), false);
    assert.equal(typeof started.receipt, 'string');
    const receipt = JSON.parse(Buffer.from(started.receipt.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(receipt.sub, 'Player');
    assert.equal(receipt.opponents[0].species, 'Pikachu');
    assert.deepEqual(receipt.participants, [1]);
});

test('battle starts with the first healthy Pokemon and never credits an already fainted lead', async t => {
    const manager = new BattleManager({
        foulPlayClient: new FakeFoulPlay(),
        trainerTicketSecret: SECRET,
    });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'healthy-lead-start';
    input.p2.team = [pokemon('Caterpie', ['Tackle'], { level: 5 })];
    input.battleTicket = battleTicket(
        [{ species: 'Caterpie', level: 5, shiny: false }],
        'wild',
        {
            players: [
                pokemon('Pikachu', ['Thunderbolt']),
                pokemon('Eevee', ['Quick Attack']),
            ],
            playerState: {
                Pikachu: { hp: 0, status: 'fnt' },
                Eevee: { hp: 80, status: '' },
            },
        },
    );

    const started = await manager.start(input);
    const receipt = JSON.parse(Buffer.from(started.receipt.split('.')[0], 'base64url').toString('utf8'));

    assert.equal(started.state.p1.activeSlot, 2);
    assert.equal(started.state.p1.party[0].fainted, true);
    assert.equal(started.state.p1.party[1].active, true);
    assert.equal(started.state.request.forceSwitch, false);
    assert.deepEqual(receipt.participants, [2]);
});

test('battle lead selection skips every consecutive fainted Pokemon', async t => {
    const manager = new BattleManager({
        foulPlayClient: new FakeFoulPlay(),
        trainerTicketSecret: SECRET,
    });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'multiple-fainted-leads-start';
    input.p2.team = [pokemon('Caterpie', ['Tackle'], { level: 5 })];
    input.battleTicket = battleTicket(
        [{ species: 'Caterpie', level: 5, shiny: false }],
        'wild',
        {
            players: [
                pokemon('Deino', ['Tackle']),
                pokemon('Doublade', ['Tackle']),
                pokemon('Breloom', ['Mach Punch']),
            ],
            playerState: {
                Deino: { hp: 0, status: 'fnt' },
                // Legacy name keys can be stale after renames/evolutions. Slot state is authoritative.
                Doublade: { hp: 80, status: '' },
                Breloom: { hp: 80, status: '' },
                __slots: {
                    1: { hp: 0, status: 'fnt' },
                    2: { hp: 80, status: 'fnt' },
                    3: { hp: 80, status: '' },
                },
            },
        },
    );

    const started = await manager.start(input);
    const receipt = JSON.parse(Buffer.from(started.receipt.split('.')[0], 'base64url').toString('utf8'));

    assert.equal(started.state.p1.activeSlot, 3);
    assert.equal(started.state.p1.party[0].fainted, true);
    assert.equal(started.state.p1.party[1].fainted, true);
    assert.equal(started.state.p1.party[2].active, true);
    assert.equal(started.state.request.forceSwitch, false);
    assert.deepEqual(receipt.participants, [3]);
});

test('signed wild ticket rejects a different opponent', async t => {
    const manager = new BattleManager({
        foulPlayClient: new FakeFoulPlay(),
        trainerTicketSecret: SECRET,
    });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'forged-wild-start';
    input.p2.team = [pokemon('Mewtwo', ['Splash'], { level: 1 })];
    input.battleTicket = battleTicket([{ species: 'Caterpie', level: 5 }]);
    await assert.rejects(manager.start(input), error => error.status === 401);
});

test('authoritative snapshots carry status and the full bench state', async t => {
    const ai = new FakeFoulPlay();
    const manager = new BattleManager({ foulPlayClient: ai });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'status-snapshot-start';
    input.p1.team = [
        pokemon('Pikachu', ['Splash']),
        pokemon('Rotom-Wash', ['Protect']),
    ];
    input.p2.team = [pokemon('Smeargle', ['Spore'])];

    const started = await manager.start(input);
    const acted = await manager.action({
        battleId: started.battleId,
        actionId: 'status-snapshot-1',
        expectedRevision: 1,
        action: 'move 1',
    });

    assert.equal(acted.state.p1.party.length, 2);
    assert.equal(acted.state.p1.party[0].status, 'slp');
    assert.equal(acted.state.p1.party[1].hp, acted.state.p1.party[1].maxhp);
    assert.equal(acted.state.p1.party[1].active, false);
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
    assert.equal(switchedOut.state.p1.activeSlot, 2);
    assert.equal(switchedOut.state.p1.party[0].active, false);
    assert.equal(switchedOut.state.p1.party[1].active, true);
    assert.equal(switchedBack.state.p1Active.species, 'Garchomp');
    assert.equal(switchedBack.state.p1Active.slot, 1);
    assert.equal(switchedBack.state.p1.activeSlot, 1);
    assert.equal(switchedBack.state.p1.party[0].active, true);
    assert.equal(switchedBack.state.p1.party[1].active, false);
});

test('stale revisions and reused action IDs cannot mutate a battle', async t => {
    const ai = new FakeFoulPlay();
    const manager = new BattleManager({ foulPlayClient: ai });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'revision-start';
    input.p2.team = [pokemon('Blissey', ['Splash'])];
    const started = await manager.start(input);
    const record = manager.getRecord(started.battleId);

    await assert.rejects(
        manager.action({
            battleId: started.battleId,
            actionId: 'stale-action',
            expectedRevision: 0,
            action: 'move 1',
        }),
        error => error.status === 409,
    );
    assert.equal(record.battle.turn, 1);

    const first = await manager.action({
        battleId: started.battleId,
        actionId: 'stable-action-id',
        expectedRevision: 1,
        action: 'move 1',
    });
    await assert.rejects(
        manager.action({
            battleId: started.battleId,
            actionId: 'stable-action-id',
            expectedRevision: 1,
            action: 'move 2',
        }),
        error => error.status === 409,
    );
    assert.equal(first.state.revision, 2);
    assert.equal(record.battle.turn, 2);
    assert.equal((await manager.state({ battleId: started.battleId })).state.revision, 2);
});

test('overlapping trainer action IDs cannot start parallel AI searches', async t => {
    let releaseMove;
    const calls = [];
    const ai = {
        configured: true,
        async decision(request) {
            calls.push(request.requestType);
            if (request.requestType === 'team') return { action: 'team 1' };
            return new Promise(resolve => {
                releaseMove = () => resolve({ action: 'move 1' });
            });
        },
    };
    const manager = new BattleManager({
        foulPlayClient: ai,
        trainerTicketSecret: SECRET,
        trainerAiEnabled: true,
    });
    t.after(() => manager.close());
    const started = await manager.start(payload('trainer'));

    const first = manager.action({
        battleId: started.battleId,
        actionId: 'parallel-action-1',
        expectedRevision: 1,
        action: 'move 1',
    });
    const resolving = await manager.state({ battleId: started.battleId });
    assert.deepEqual(resolving.state.command, {
        phase: 'resolving',
        actionId: 'parallel-action-1',
    });
    await assert.rejects(
        manager.action({
            battleId: started.battleId,
            actionId: 'parallel-action-2',
            expectedRevision: 1,
            action: 'move 1',
        }),
        error => error.status === 409,
    );
    releaseMove();
    const response = await first;

    assert.equal(response.state.revision, 2);
    assert.deepEqual(response.state.command, { phase: 'idle', actionId: '' });
    assert.deepEqual(calls, ['team', 'move']);
});

test('failed capture consumes one authoritative remote turn without changing moves', async t => {
    const ai = new FakeFoulPlay();
    const manager = new BattleManager({ foulPlayClient: ai });
    t.after(() => manager.close());
    const input = payload('wild');
    input.requestId = 'capture-pass-start';
    input.p1.team = [pokemon('Garchomp', ['Protect'])];
    input.p2.team = [pokemon('Blissey', ['Tackle'])];

    const started = await manager.start(input);
    const acted = await manager.action({
        battleId: started.battleId,
        actionId: 'capture-pass-1',
        expectedRevision: 1,
        action: 'capture',
    });

    assert.equal(acted.state.revision, 2);
    assert.equal(acted.state.turn, 2);
    assert.match(acted.log, /\|covenant\|capturefailed/);
    assert.match(acted.log, /\|move\|p1a: Garchomp\|Splash/);
    assert.ok(acted.state.p1.party[0].hp < acted.state.p1.party[0].maxhp);
    assert.deepEqual(acted.state.p1.party[0].moveSlots.map(move => move.id), ['protect']);
});

test('run attempts are resolved by the authoritative server', async t => {
    const ai = new FakeFoulPlay();
    const manager = new BattleManager({ foulPlayClient: ai, random: () => 0.999 });
    t.after(() => manager.close());

    const guaranteed = payload('wild');
    guaranteed.requestId = 'run-success-start';
    guaranteed.p1.team = [pokemon('Regieleki', ['Tackle'])];
    guaranteed.p2.team = [pokemon('Slowpoke', ['Tackle'])];
    const startedFast = await manager.start(guaranteed);
    const escaped = await manager.action({
        battleId: startedFast.battleId,
        actionId: 'run-success-1',
        expectedRevision: 1,
        action: 'run',
    });
    assert.equal(escaped.escaped, true);
    assert.equal(escaped.state.ended, true);
    assert.equal(escaped.state.outcome, 'escaped');
    assert.match(escaped.log, /\|covenant\|escaped/);

    const failedInput = payload('wild');
    failedInput.requestId = 'run-failure-start';
    failedInput.p1.team = [pokemon('Slowpoke', ['Tackle'])];
    failedInput.p2.team = [pokemon('Regieleki', ['Tackle'])];
    const startedSlow = await manager.start(failedInput);
    const failed = await manager.action({
        battleId: startedSlow.battleId,
        actionId: 'run-failure-1',
        expectedRevision: 1,
        action: 'run',
    });
    assert.equal(failed.escaped, false);
    assert.equal(failed.state.turn, 2);
    assert.equal(failed.state.outcome, null);
    assert.match(failed.log, /\|covenant\|runfailed/);
    assert.deepEqual(failed.state.p1.party[0].moveSlots.map(move => move.id), ['tackle']);
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
    assert.equal(first.state.revision, 1);
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
