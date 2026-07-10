import assert from 'node:assert/strict';
import test from 'node:test';

import { PvpBattleManager } from '../pvp-battle-manager.js';
import { signToken } from '../tokens.js';


const SECRET = 'pvp-ticket-secret';

function mon(species, moves, level = 50) {
    return { species, moves, level, nature: 'Serious' };
}

function bundle(suffix = '1') {
    const localBattleId = `11111111-1111-4111-8111-${suffix.padStart(12, '0')}`;
    const participants = { p1: `PlayerA${suffix}`, p2: `PlayerB${suffix}` };
    const teams = {
        p1: [mon('Pikachu', ['Tackle'])],
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
    const data = ['5', '6', '7'].map(bundle);
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
