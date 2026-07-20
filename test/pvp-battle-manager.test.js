import assert from 'node:assert/strict';
import test from 'node:test';

import { PvpBattleManager } from '../pvp-battle-manager.js';
import { signToken } from '../tokens.js';


const SECRET = 'pvp-ticket-secret';

function mon(species, moves, level = 50) {
    return { species, moves, level, nature: 'Serious' };
}

function bundle(suffix = '1', sharedP1 = '', customTeams = null) {
    const localBattleId = `11111111-1111-4111-8111-${suffix.padStart(12, '0')}`;
    const participants = { p1: sharedP1 || `PlayerA${suffix}`, p2: `PlayerB${suffix}` };
    const teams = customTeams || {
        p1: [mon('Pikachu', ['Thunder Shock'])],
        p2: [mon('Caterpie', ['Tackle'])],
    };
    const exp = Math.floor(Date.now() / 1000) + 300;
    const battleTicket = signToken({
        v: 1,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        localBattleId,
        participants,
        teams,
        exp,
    }, SECRET);
    const sideTicket = side => signToken({
        v: 1,
        kind: 'pvp-side',
        aud: 'pokemon-battle-api',
        localBattleId,
        sub: participants[side],
        side,
        exp: Math.floor(Date.now() / 1000) + (2 * 60 * 60),
    }, SECRET);
    return { localBattleId, participants, teams, battleTicket, sideTicket };
}

function spectatorTicket(data, battleId, viewer = 'Watcher') {
    return signToken({
        v: 1,
        kind: 'pvp-spectator',
        aud: 'pokemon-battle-api',
        localBattleId: data.localBattleId,
        battleId,
        sub: viewer,
        exp: Math.floor(Date.now() / 1000) + (2 * 60 * 60),
    }, SECRET);
}

async function start(manager, data, suffix = '1') {
    return manager.start({
        requestId: `pvp-start-${suffix}`,
        battleTicket: data.battleTicket,
        sideTicket: data.sideTicket('p1'),
    });
}

test('PvP resolves only after both signed sides submit', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('1');
    const started = await start(manager, data);

    const p1Waiting = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-turn-1',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(p1Waiting.state.revision, 1);
    assert.equal(p1Waiting.waitingForOpponent, true);

    const p2State = await manager.state({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
    });
    assert.equal(p2State.state.p2.party[0].moveSlots[0].id, 'tackle');
    assert.equal(p2State.state.p1.party[0].moveSlots, undefined);

    const resolved = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
        actionId: 'p2-turn-1',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.state.revision, 2);
    assert.equal(resolved.waitingForOpponent, false);
    assert.match(resolved.log, /\|move\|p2a: Caterpie\|Tackle/);

    const p1After = await manager.state({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
    });
    assert.equal(p1After.state.revision, 2);
    assert.ok(p1After.state.p1.party[0].hp < p1After.state.p1.party[0].maxhp);

    const replayed = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-turn-1',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.state.revision, 2);
    assert.equal(replayed.waitingForOpponent, false);
    assert.match(replayed.log, /\|move\|p1a: Pikachu\|Thunder Shock/);

    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-turn-2',
        expectedRevision: 2,
        action: 'move 1',
    });
    const lateReplay = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-turn-1',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(lateReplay.replayed, true);
    assert.equal(lateReplay.resolved, true);
    assert.equal(lateReplay.state.revision, 2);
});

test('spectators receive delayed public state without either side private data', async t => {
    let now = Date.now();
    const manager = new PvpBattleManager({ ticketSecret: SECRET, now: () => now });
    t.after(() => manager.close());
    const data = bundle('40');
    const started = await start(manager, data, 'spectator-delay');
    const ticket = spectatorTicket(data, started.battleId);

    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'spectator-p1',
        expectedRevision: 1,
        action: 'move 1',
    });
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
        actionId: 'spectator-p2',
        expectedRevision: 1,
        action: 'move 1',
    });

    const delayed = await manager.spectate({ battleId: started.battleId, spectatorTicket: ticket });
    assert.equal(delayed.delayedByMs, 10000);
    assert.equal(delayed.state.revision, 1);
    assert.equal(delayed.state.perspective, 'spectator');
    assert.equal(delayed.state.canAct, false);
    assert.deepEqual(delayed.state.pendingSides, []);
    assert.equal(delayed.receipt, undefined);

    now += 10001;
    const publicTurn = await manager.spectate({ battleId: started.battleId, spectatorTicket: ticket });
    assert.equal(publicTurn.state.revision, 2);
    assert.match(publicTurn.log, /\|move\|p1a: Pikachu\|Thunder Shock/);
    for (const side of ['p1', 'p2']) {
        const visible = publicTurn.state[side].party[0];
        assert.equal(visible.moveSlots, undefined);
        assert.equal(visible.item, undefined);
        assert.equal(visible.ability, undefined);
    }
});

test('spectator tickets are battle-bound and cannot act as side tickets', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('41');
    const other = bundle('42');
    const started = await start(manager, data, 'spectator-scope');
    const wrong = spectatorTicket(other, started.battleId);
    const ticket = spectatorTicket(data, started.battleId);

    await assert.rejects(
        manager.spectate({ battleId: started.battleId, spectatorTicket: wrong }),
        error => error.status === 401,
    );
    await assert.rejects(
        manager.action({
            battleId: started.battleId,
            sideTicket: ticket,
            actionId: 'spectator-cannot-act',
            expectedRevision: 1,
            action: 'move 1',
        }),
        error => error.status === 401,
    );
});

test('PvP start retry accepts a freshly signed equivalent ticket after a lost bind', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('35');
    const first = await start(manager, data, 'lost-bind');
    const refreshedTicket = signToken({
        v: 1,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        localBattleId: data.localBattleId,
        participants: { p2: data.participants.p2, p1: data.participants.p1 },
        teams: { p2: data.teams.p2, p1: data.teams.p1 },
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: 'fresh-ticket-nonce',
    }, SECRET);
    const replayed = await manager.start({
        requestId: 'pvp-start-lost-bind',
        battleTicket: refreshedTicket,
        sideTicket: data.sideTicket('p1'),
    });

    assert.equal(replayed.battleId, first.battleId);
    assert.equal(replayed.localBattleId, data.localBattleId);

    const anotherRequest = await manager.start({
        requestId: 'pvp-start-lost-bind-new-request',
        battleTicket: refreshedTicket,
        sideTicket: data.sideTicket('p1'),
    });
    assert.equal(anotherRequest.battleId, first.battleId);

    const conflictingTicket = signToken({
        v: 1,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        localBattleId: data.localBattleId,
        participants: data.participants,
        teams: { ...data.teams, p1: [mon('Mewtwo', ['Psychic'])] },
        exp: Math.floor(Date.now() / 1000) + 300,
    }, SECRET);
    await assert.rejects(
        manager.start({
            requestId: 'pvp-start-lost-bind-conflict',
            battleTicket: conflictingTicket,
            sideTicket: data.sideTicket('p1'),
        }),
        error => error.status === 409 && /different signed simulation/i.test(error.message),
    );
});

test('known action replay returns terminal state and receipt', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const teams = {
        p1: [mon('Mewtwo', ['Psychic'], 100)],
        p2: [mon('Caterpie', ['Tackle'], 1)],
    };
    const data = bundle('36', '', teams);
    const started = await start(manager, data, 'terminal-replay');
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'terminal-p1',
        expectedRevision: 1,
        action: 'move 1',
    });
    const ended = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
        actionId: 'terminal-p2',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(ended.state.ended, true);

    const replayed = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'terminal-p1',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.state.ended, true);
    assert.equal(typeof replayed.receipt, 'string');
});

test('PvP rejects wrong side tickets and stale actions', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('2');
    const other = bundle('3');
    const started = await start(manager, data, '2');

    await assert.rejects(
        manager.state({ battleId: started.battleId, sideTicket: other.sideTicket('p1') }),
        error => error.status === 401,
    );
    await assert.rejects(
        manager.action({
            battleId: started.battleId,
            sideTicket: data.sideTicket('p1'),
            actionId: 'stale',
            expectedRevision: 0,
            action: 'move 1',
        }),
        error => error.status === 409,
    );
});

test('PvP rejects invalid canonical team data before simulation', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('34');
    const exp = Math.floor(Date.now() / 1000) + 300;
    const invalidTicket = signToken({
        v: 1,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        localBattleId: data.localBattleId,
        participants: data.participants,
        teams: {
            ...data.teams,
            p1: [mon('Pikachu', ['Definitely Not A Move'])],
        },
        exp,
    }, SECRET);

    await assert.rejects(
        manager.start({
            requestId: 'pvp-invalid-team',
            battleTicket: invalidTicket,
            sideTicket: data.sideTicket('p1'),
        }),
        error => {
            assert.equal(error.status, 400);
            assert.match(error.message, /invalid move/i);
            assert.equal(error.details.code, 'TEAM_INVALID');
            const rejection = JSON.parse(Buffer.from(error.details.rejectionToken.split('.')[0], 'base64url').toString('utf8'));
            assert.equal(rejection.kind, 'pvp-rejection');
            assert.equal(rejection.localBattleId, data.localBattleId);
            return true;
        },
    );
});

test('competitive PvP rejects illegal learnsets, abilities and EV totals independently', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const cases = [
        ['37', { species: 'Pikachu', moves: ['Spore'], ability: 'Static', nature: 'Serious', level: 100, evs: { hp: 1 } }, /learn Spore/i],
        ['38', { species: 'Pikachu', moves: ['Thunder Shock'], ability: 'Wonder Guard', nature: 'Serious', level: 100, evs: { hp: 1 } }, /Wonder Guard/i],
        ['39', { species: 'Pikachu', moves: ['Thunder Shock'], ability: 'Static', nature: 'Serious', level: 100, evs: { hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252 } }, /1512 total EVs/i],
    ];

    for (const [suffix, illegalMon, pattern] of cases) {
        const data = bundle(suffix, '', { p1: [illegalMon], p2: [mon('Caterpie', ['Tackle'])] });
        await assert.rejects(
            start(manager, data, `competitive-invalid-${suffix}`),
            error => error.status === 400
                && error.details?.code === 'TEAM_INVALID'
                && pattern.test(error.message),
        );
    }
});

test('PvP forfeit emits a signed settlement receipt', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('4');
    const started = await start(manager, data, '4');
    const forfeited = await manager.forfeit({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
    });
    assert.equal(forfeited.state.ended, true);
    assert.equal(forfeited.state.winner, data.participants.p1);
    assert.equal(typeof forfeited.receipt, 'string');
    const receipt = JSON.parse(Buffer.from(forfeited.receipt.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(receipt.kind, 'pvp-receipt');
    assert.equal(receipt.state.reason, 'forfeit');
    assert.equal(receipt.state.winner, data.participants.p1);
});

test('a player can claim a signed win after the opponent turn timeout', async t => {
    let now = Date.now();
    const manager = new PvpBattleManager({ ticketSecret: SECRET, now: () => now });
    t.after(() => manager.close());
    const data = bundle('5');
    const started = await start(manager, data, '5');
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-timeout-choice',
        expectedRevision: 1,
        action: 'move 1',
    });
    await assert.rejects(
        manager.claimTimeout({ battleId: started.battleId, sideTicket: data.sideTicket('p1') }),
        error => error.status === 409 && error.details.remainingMs > 0,
    );
    now += 3 * 60 * 1000 + 1;
    const claimed = await manager.claimTimeout({ battleId: started.battleId, sideTicket: data.sideTicket('p1') });
    assert.equal(claimed.state.ended, true);
    assert.equal(claimed.state.reason, 'turn-timeout');
    assert.equal(claimed.state.winner, data.participants.p1);
    assert.equal(typeof claimed.receipt, 'string');
    const replayed = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-timeout-choice',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.state.reason, 'turn-timeout');
    assert.equal(typeof replayed.receipt, 'string');
});

test('polling resolves an abandoned submitted turn without a client claim', async t => {
    let now = Date.now();
    const manager = new PvpBattleManager({ ticketSecret: SECRET, now: () => now });
    t.after(() => manager.close());
    const data = bundle('7');
    const started = await start(manager, data, '7');
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'p1-abandoned-choice',
        expectedRevision: 1,
        action: 'move 1',
    });
    now += 3 * 60 * 1000 + 1;
    const expired = await manager.state({ battleId: started.battleId, sideTicket: data.sideTicket('p1') });
    assert.equal(expired.state.ended, true);
    assert.equal(expired.state.reason, 'turn-timeout');
    assert.equal(expired.state.winner, data.participants.p1);
    assert.equal(typeof expired.receipt, 'string');
});

test('thirty idle minutes end in a signed draw refund', async t => {
    let now = Date.now();
    const manager = new PvpBattleManager({ ticketSecret: SECRET, now: () => now });
    t.after(() => manager.close());
    const data = bundle('8');
    const started = await start(manager, data, '8');
    now += 30 * 60 * 1000 + 1;
    const expired = await manager.state({ battleId: started.battleId, sideTicket: data.sideTicket('p2') });
    assert.equal(expired.state.ended, true);
    assert.equal(expired.state.reason, 'idle-timeout');
    assert.equal(expired.state.winner, '');
    assert.equal(typeof expired.receipt, 'string');
});

test('lost Node state yields signed recovery only after the record disappears', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const active = bundle('6');
    const started = await start(manager, active, '6');
    const existing = await manager.recover({ sideTicket: active.sideTicket('p2') });
    assert.equal(existing.battleId, started.battleId);
    assert.equal(existing.missing, undefined);

    manager.records.delete(started.battleId);
    const missing = await manager.recover({ sideTicket: active.sideTicket('p2') });
    assert.equal(missing.missing, true);
    assert.equal(typeof missing.recoveryToken, 'string');
    const payload = JSON.parse(Buffer.from(missing.recoveryToken.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(payload.kind, 'pvp-recovery');
    assert.equal(payload.localBattleId, active.localBattleId);
    assert.equal(payload.sub, active.participants.p2);
});

test('three PvP battles progress independently', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = ['5', '6', '7'].map(suffix => bundle(suffix));
    const started = await Promise.all(data.map((entry, index) => start(manager, entry, String(index + 5))));
    assert.equal(new Set(started.map(entry => entry.battleId)).size, 3);

    await Promise.all(started.flatMap((battle, index) => [
        manager.action({
            battleId: battle.battleId,
            sideTicket: data[index].sideTicket('p1'),
            actionId: `p1-${index}`,
            expectedRevision: 1,
            action: 'move 1',
        }),
        manager.action({
            battleId: battle.battleId,
            sideTicket: data[index].sideTicket('p2'),
            actionId: `p2-${index}`,
            expectedRevision: 1,
            action: 'move 1',
        }),
    ]));
    const states = await Promise.all(started.map((battle, index) => manager.state({
        battleId: battle.battleId,
        sideTicket: data[index].sideTicket('p1'),
    })));
    assert.deepEqual(states.map(entry => entry.state.revision), [2, 2, 2]);
});

test('one player can progress in three PvP battles independently', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = ['31', '32', '33'].map(suffix => bundle(suffix, 'SharedPlayer'));
    const started = await Promise.all(data.map((entry, index) => start(manager, entry, `shared-${index}`)));

    await Promise.all(started.flatMap((battle, index) => [
        manager.action({
            battleId: battle.battleId,
            sideTicket: data[index].sideTicket('p1'),
            actionId: `shared-p1-${index}`,
            expectedRevision: 1,
            action: 'move 1',
        }),
        manager.action({
            battleId: battle.battleId,
            sideTicket: data[index].sideTicket('p2'),
            actionId: `shared-p2-${index}`,
            expectedRevision: 1,
            action: 'move 1',
        }),
    ]));

    const states = await Promise.all(started.map((battle, index) => manager.state({
        battleId: battle.battleId,
        sideTicket: data[index].sideTicket('p1'),
    })));
    assert.deepEqual(states.map(entry => entry.state.revision), [2, 2, 2]);
    assert.deepEqual(states.map(entry => entry.state.p1.name), ['SharedPlayer', 'SharedPlayer', 'SharedPlayer']);
});

test('PvP exposes only the locked continuation move after Fly preparation', async t => {
    const manager = new PvpBattleManager({ ticketSecret: SECRET });
    t.after(() => manager.close());
    const data = bundle('43', '', {
        p1: [mon('Dragonite', ['Fly', 'Extreme Speed'], 50)],
        p2: [mon('Blissey', ['Soft-Boiled'], 50)],
    });
    const started = await start(manager, data, 'locked-fly');
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'locked-fly-p1',
        expectedRevision: 1,
        action: 'move 1',
    });
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
        actionId: 'locked-fly-p2',
        expectedRevision: 1,
        action: 'move 1',
    });
    const state = await manager.state({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
    });
    assert.equal(state.state.request.forcedMove, true);
    assert.equal(state.state.request.canSwitch, false);
    assert.deepEqual(state.state.p1.party[0].moveSlots.map(move => move.id), ['fly']);
    assert.equal(state.state.p1.party[0].moveSlots[0].index, 1);
});
