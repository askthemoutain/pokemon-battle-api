import assert from 'node:assert/strict';
import test from 'node:test';

import { PvpBattleManager } from '../pvp-battle-manager.js';
import { signToken, verifyPvpSideTicket } from '../tokens.js';


const SECRET = 'pvp-ticket-secret';
const makeManager = (options = {}) => new PvpBattleManager({
    ticketSecret: SECRET,
    sessionValidator: async () => true,
    settlementPoster: async () => true,
    ...options,
});

function mon(species, moves, level = 50) {
    return { species, moves, level, nature: 'Serious' };
}

function bundle(suffix = '1', sharedP1 = '', customTeams = null, teamSchema = 2) {
    const localBattleId = `11111111-1111-4111-8111-${suffix.padStart(12, '0')}`;
    const participants = { p1: sharedP1 || `PlayerA${suffix}`, p2: `PlayerB${suffix}` };
    const teams = customTeams || {
        p1: [mon('Pikachu', ['Thunder Shock'])],
        p2: [mon('Caterpie', ['Tackle'])],
    };
    const exp = Math.floor(Date.now() / 1000) + 300;
    const ticketPayload = {
        v: 2,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        serverStart: true,
        localBattleId,
        participants,
        teams,
        exp,
    };
    if (teamSchema !== null) ticketPayload.teamSchema = teamSchema;
    const battleTicket = signToken(ticketPayload, SECRET);
    const data = { localBattleId, participants, teams, teamSchema, battleTicket, sideTicket: null, battleId: '' };
    data.sideTicket = (side, nowSeconds = Math.floor(Date.now() / 1000)) => signToken({
        v: 2,
        kind: 'pvp-side',
        aud: 'pokemon-battle-api',
        localBattleId,
        sub: participants[side],
        side,
        battleId: data.battleId,
        sessionBinding: `session-${suffix}`,
        exp: nowSeconds + 30,
    }, SECRET);
    return data;
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
    const response = await manager.start({
        requestId: `pvp-start-${suffix}`,
        battleTicket: data.battleTicket,
        sideTicket: data.sideTicket('p1'),
    });
    data.battleId = response.battleId;
    return response;
}

test('v2 start emits an exact server-verifiable bind proof', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('81');
    const started = await start(manager, data, 'bind-proof');
    assert.match(started.bindProof, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const proof = JSON.parse(Buffer.from(started.bindProof.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(proof.kind, 'pvp-bind');
    assert.equal(proof.aud, 'pokemon-covenant-php');
    assert.equal(proof.localBattleId, data.localBattleId);
    assert.equal(proof.battleId, started.battleId);
    assert.deepEqual(proof.participants, data.participants);
});

test('legacy PvP bootstrap is disabled by default and only available behind the rollout flag', async t => {
    const data = bundle('86');
    const exp = Math.floor(Date.now() / 1000) + 300;
    const legacyBattleTicket = signToken({
        v: 1, kind: 'pvp-battle', aud: 'pokemon-battle-api',
        localBattleId: data.localBattleId, participants: data.participants, teams: data.teams, exp,
    }, SECRET);
    const legacySideTicket = signToken({
        v: 1, kind: 'pvp-side', aud: 'pokemon-battle-api',
        localBattleId: data.localBattleId, sub: data.participants.p1, side: 'p1', exp,
    }, SECRET);
    const strict = makeManager();
    const phased = makeManager({ allowLegacyV1: true });
    t.after(() => { strict.close(); phased.close(); });
    const payload = {
        requestId: 'legacy-rollout', battleTicket: legacyBattleTicket, sideTicket: legacySideTicket,
    };
    await assert.rejects(strict.start(payload), error => error?.status === 401);
    const started = await phased.start(payload);
    assert.match(started.battleId, /^[a-f0-9-]{36}$/i);
    const state = await phased.state({ battleId: started.battleId, sideTicket: legacySideTicket });
    assert.equal(state.success, true);
});

test('active battle count excludes retained terminal records', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('87');
    const started = await start(manager, data, 'active-count');

    assert.equal(manager.records.size, 1);
    assert.equal(manager.getActiveBattleCount(), 1);

    const record = manager.getRecord(started.battleId);
    record.battle.ended = true;
    assert.equal(manager.getActiveBattleCount(), 0, 'simulator-ended records are terminal');
    record.battle.ended = false;

    await manager.forfeit({ battleId: started.battleId, sideTicket: data.sideTicket('p1') });

    assert.equal(manager.records.size, 1, 'terminal records remain available for replay and cleanup');
    assert.equal(manager.getActiveBattleCount(), 0);
});

test('a replaced or unavailable session cannot mutate PvP state', async t => {
    for (const [suffix, validator, expectedStatus] of [
        ['82', async request => request.action === 'start', 401],
        ['83', async request => {
            if (request.action === 'start') return true;
            throw new Error('offline');
        }, 503],
    ]) {
        const manager = makeManager({ sessionValidator: validator });
        t.after(() => manager.close());
        const data = bundle(suffix);
        const started = await start(manager, data, `session-${suffix}`);
        await assert.rejects(manager.action({
            battleId: started.battleId,
            sideTicket: data.sideTicket('p1'),
            actionId: `blocked-${suffix}`,
            expectedRevision: 1,
            action: 'move 1',
        }), error => error?.status === expectedStatus);
        assert.equal(manager.getRecord(started.battleId).revision, 1);
        assert.deepEqual(manager.getRecord(started.battleId).pendingChoices, {});
    }
});

test('short side tickets expire and recovery requires the exact Node battle', async t => {
    const now = Math.floor(Date.now() / 1000);
    const shortTicket = signToken({
        v: 2, kind: 'pvp-side', aud: 'pokemon-battle-api',
        localBattleId: '11111111-1111-4111-8111-000000000084',
        battleId: '22222222-2222-4222-8222-000000000084',
        sub: 'PlayerA84', side: 'p1', sessionBinding: 'session-84',
        iat: now, exp: now + 30,
    }, SECRET);
    assert.equal(verifyPvpSideTicket(shortTicket, SECRET, now + 30).sub, 'PlayerA84');
    assert.throws(() => verifyPvpSideTicket(shortTicket, SECRET, now + 31), /expired or invalid/);

    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('84');
    const started = await start(manager, data, 'exact-recovery');
    manager.records.delete(started.battleId);
    await assert.rejects(manager.recover({
        battleId: '99999999-9999-4999-8999-999999999999',
        sideTicket: data.sideTicket('p1'),
    }), error => error?.status === 401);
});

test('terminal settlement retries after a transient callback failure', async t => {
    const receipts = [];
    const manager = makeManager({
        settlementPoster: async receipt => {
            receipts.push(receipt);
            return receipts.length > 1;
        },
    });
    t.after(() => manager.close());
    const data = bundle('85');
    const started = await start(manager, data, 'settlement-outbox');
    await manager.forfeit({ battleId: started.battleId, sideTicket: data.sideTicket('p1') });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.ok(receipts.length >= 2);
    assert.equal(manager.settlementOutbox.size, 0);
    assert.equal(manager.settledBattles.has(`${data.localBattleId}:${started.battleId}`), true);
});

test('settlement retry refreshes an expired receipt without changing its terminal outcome', async t => {
    let now = Date.now();
    const receipts = [];
    const verifyReceiptAtCurrentTime = token => {
        const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
        assert.equal(signToken(payload, SECRET), token);
        assert.ok(payload.iat <= Math.floor(now / 1000));
        assert.ok(payload.exp >= Math.floor(now / 1000));
        receipts.push(payload);
        return payload;
    };
    const manager = makeManager({
        now: () => now,
        settlementPoster: async receipt => {
            verifyReceiptAtCurrentTime(receipt);
            return receipts.length > 1;
        },
    });
    t.after(() => manager.close());
    const data = bundle('91');
    const started = await start(manager, data, 'fresh-settlement-retry');
    const firstResponse = await manager.forfeit({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1', Math.floor(now / 1000)),
    });
    assert.equal(firstResponse.settlementPending, true);
    const key = `${data.localBattleId}:${started.battleId}`;
    const entry = manager.settlementOutbox.get(key);
    assert.ok(entry);
    assert.equal(entry.receipt, undefined);
    assert.equal(Object.isFrozen(entry.outcome), true);
    clearTimeout(entry.timer);
    entry.timer = null;

    now += (2 * 60 * 60 * 1000) + 1000;
    assert.ok(receipts[0].exp < Math.floor(now / 1000), 'the first callback receipt must now be stale');
    assert.equal(await manager._deliverSettlement(entry), true);
    assert.equal(receipts.length, 2);
    assert.ok(receipts[1].iat > receipts[0].iat);
    assert.deepEqual(receipts[1].state, receipts[0].state);
    assert.equal(receipts[1].revision, receipts[0].revision);
    assert.deepEqual(receipts[1].participants, receipts[0].participants);

    const replay = await manager.state({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2', Math.floor(now / 1000)),
    });
    const replayReceipt = verifyReceiptAtCurrentTime(replay.receipt);
    assert.deepEqual(replayReceipt.state, receipts[0].state);
    assert.equal(replayReceipt.revision, receipts[0].revision);
});

test('terminal response marks settlement pending when the first authoritative callback fails', async t => {
    const manager = makeManager({ settlementPoster: async () => false });
    t.after(() => manager.close());
    const data = bundle('87');
    const started = await start(manager, data, 'settlement-pending');
    const ended = await manager.forfeit({ battleId: started.battleId, sideTicket: data.sideTicket('p1') });
    assert.equal(ended.state.ended, true);
    assert.equal(ended.settlementPending, true);
    assert.equal(manager.settlementOutbox.size, 1);
});

test('a terminal action awaits its first settlement callback before resolving', async t => {
    let releaseCallback;
    let callbackStarted = false;
    const callbackGate = new Promise(resolve => { releaseCallback = resolve; });
    const manager = makeManager({ settlementPoster: async () => {
        callbackStarted = true;
        await callbackGate;
        return true;
    } });
    t.after(() => manager.close());
    const data = bundle('89', '', {
        p1: [mon('Pikachu', ['Thunderbolt'], 100)],
        p2: [mon('Magikarp', ['Splash'], 1)],
    });
    const started = await start(manager, data, 'terminal-action-awaits');
    await manager.action({
        battleId: started.battleId, sideTicket: data.sideTicket('p1'),
        actionId: 'terminal-p1', expectedRevision: 1, action: 'move 1',
    });
    let resolved = false;
    const terminalPromise = manager.action({
        battleId: started.battleId, sideTicket: data.sideTicket('p2'),
        actionId: 'terminal-p2', expectedRevision: 1, action: 'move 1',
    }).then(result => { resolved = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbackStarted, true);
    assert.equal(resolved, false);
    releaseCallback();
    const terminal = await terminalPromise;
    assert.equal(terminal.state.ended, true);
    assert.equal(terminal.settlementPending, undefined);
});

test('concurrent terminal responses join one authoritative settlement callback', async t => {
    let releaseCallback;
    let callbackCalls = 0;
    const callbackGate = new Promise(resolve => { releaseCallback = resolve; });
    const manager = makeManager({ settlementPoster: async () => {
        callbackCalls++;
        await callbackGate;
        return true;
    } });
    t.after(() => manager.close());
    const data = bundle('90');
    const started = await start(manager, data, 'concurrent-terminal-settlement');
    let forfeitResolved = false;
    const forfeitPromise = manager.forfeit({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
    }).then(result => { forfeitResolved = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbackCalls, 1);

    let stateResolved = false;
    const statePromise = manager.state({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p2'),
    }).then(result => { stateResolved = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(forfeitResolved, false);
    assert.equal(stateResolved, false);
    assert.equal(callbackCalls, 1);

    releaseCallback();
    const [forfeit, state] = await Promise.all([forfeitPromise, statePromise]);
    assert.equal(forfeit.state.ended, true);
    assert.equal(state.state.ended, true);
    assert.equal(forfeit.settlementPending, undefined);
    assert.equal(state.settlementPending, undefined);
    assert.equal(callbackCalls, 1);
});

test('world lease claim is forwarded unchanged to the fail-closed session validator', async t => {
    const requests = [];
    const manager = makeManager({ sessionValidator: async request => { requests.push(request); return true; } });
    t.after(() => manager.close());
    const data = bundle('88');
    const world = {
        roomId: 8,
        routeId: 'pay-field-low-route',
        instanceKey: 'public',
        mapRevision: '5',
        leaseEpoch: 7,
        tabHash: 'a'.repeat(64),
    };
    data.sideTicket = side => signToken({
        v: 2, kind: 'pvp-side', aud: 'pokemon-battle-api', localBattleId: data.localBattleId,
        sub: data.participants[side], side, battleId: data.battleId,
        sessionBinding: 'session-88', world, exp: Math.floor(Date.now() / 1000) + 30,
    }, SECRET);
    const started = await start(manager, data, 'world-claim');
    await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1'),
        actionId: 'world-action',
        expectedRevision: 1,
        action: 'move 1',
    });
    assert.deepEqual(requests.at(-1).world, world);
});

test('a new leader lease resumes while the old tab ticket is rejected immediately', async t => {
    const newWorld = {
        roomId: 8, routeId: 'pay-field-low-route', instanceKey: 'public', mapRevision: '5',
        leaseEpoch: 12, tabHash: 'b'.repeat(64),
    };
    const manager = makeManager({
        sessionValidator: async request => request.action === 'start'
            || (request.world?.leaseEpoch === newWorld.leaseEpoch && request.world?.tabHash === newWorld.tabHash),
    });
    t.after(() => manager.close());
    const data = bundle('90');
    const ticketFor = (side, world) => signToken({
        v: 2, kind: 'pvp-side', aud: 'pokemon-battle-api', localBattleId: data.localBattleId,
        sub: data.participants[side], side, battleId: data.battleId,
        sessionBinding: 'session-90', world, exp: Math.floor(Date.now() / 1000) + 30,
    }, SECRET);
    const startTicket = ticketFor('p1', { ...newWorld, leaseEpoch: 11, tabHash: 'a'.repeat(64) });
    const started = await manager.start({
        requestId: 'lease-rebind-start', battleTicket: data.battleTicket, sideTicket: startTicket,
    });
    data.battleId = started.battleId;
    const oldTicket = ticketFor('p1', { ...newWorld, leaseEpoch: 11, tabHash: 'a'.repeat(64) });
    const newTicket = ticketFor('p1', newWorld);
    await assert.rejects(manager.action({
        battleId: started.battleId, sideTicket: oldTicket,
        actionId: 'old-tab', expectedRevision: 1, action: 'move 1',
    }), error => error?.status === 401);
    const resumed = await manager.action({
        battleId: started.battleId, sideTicket: newTicket,
        actionId: 'new-leader', expectedRevision: 1, action: 'move 1',
    });
    assert.equal(resumed.accepted, true);
});

test('PvP resolves only after both signed sides submit', async t => {
    const manager = makeManager();
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
    const manager = makeManager({ now: () => now });
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

test('opponents and spectators see normalized HP while each player keeps exact own HP', async t => {
    let now = Date.now();
    const manager = makeManager({ now: () => now });
    t.after(() => manager.close());
    const data = bundle('92', '', {
        p1: [mon('Pikachu', ['Thunder Shock'], 50)],
        p2: [mon('Snorlax', ['Tackle'], 50)],
    });
    const started = await start(manager, data, 'normalized-public-hp');
    const record = manager.getRecord(started.battleId);
    const p1Pokemon = record.battle.p1.pokemon[0];
    const p2Pokemon = record.battle.p2.pokemon[0];
    p1Pokemon.hp = Math.max(1, Math.floor(p1Pokemon.maxhp / 3));
    p2Pokemon.hp = Math.max(1, Math.floor(p2Pokemon.maxhp * 0.61));
    record.revision++;
    manager._captureSpectator(record);

    const p1View = await manager.state({ battleId: started.battleId, sideTicket: data.sideTicket('p1') });
    const p2View = await manager.state({ battleId: started.battleId, sideTicket: data.sideTicket('p2') });
    assert.equal(p1View.state.p1.party[0].hp, p1Pokemon.hp);
    assert.equal(p1View.state.p1.party[0].maxhp, p1Pokemon.maxhp);
    assert.equal(p2View.state.p2.party[0].hp, p2Pokemon.hp);
    assert.equal(p2View.state.p2.party[0].maxhp, p2Pokemon.maxhp);
    assert.equal(p1View.state.p2.party[0].maxhp, 100);
    assert.equal(p1View.state.p2.party[0].hp, Math.ceil((p2Pokemon.hp / p2Pokemon.maxhp) * 100));
    assert.equal(p2View.state.p1.party[0].maxhp, 100);
    assert.equal(p2View.state.p1.party[0].hp, Math.ceil((p1Pokemon.hp / p1Pokemon.maxhp) * 100));

    now += 10001;
    const watched = await manager.spectate({
        battleId: started.battleId,
        spectatorTicket: spectatorTicket(data, started.battleId),
    });
    for (const side of ['p1', 'p2']) {
        assert.equal(watched.state[side].party[0].maxhp, 100);
        assert.ok(watched.state[side].party[0].hp >= 1 && watched.state[side].party[0].hp <= 100);
    }
    p1Pokemon.hp = 0;
    p1Pokemon.fainted = true;
    record.revision++;
    manager._captureSpectator(record);
    now += 10001;
    const fainted = await manager.spectate({
        battleId: started.battleId,
        spectatorTicket: spectatorTicket(data, started.battleId),
    });
    assert.equal(fainted.state.p1.party[0].hp, 0);
    assert.equal(fainted.state.p1.party[0].maxhp, 100);
});

test('spectator tickets are battle-bound and cannot act as side tickets', async t => {
    const manager = makeManager();
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
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('35');
    const first = await start(manager, data, 'lost-bind');
    const refreshedTicket = signToken({
        v: 2,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        serverStart: true,
        localBattleId: data.localBattleId,
        participants: { p2: data.participants.p2, p1: data.participants.p1 },
        teams: { p2: data.teams.p2, p1: data.teams.p1 },
        teamSchema: data.teamSchema,
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
        v: 2,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        serverStart: true,
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
    const manager = makeManager();
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
    const manager = makeManager();
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
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('34');
    const exp = Math.floor(Date.now() / 1000) + 300;
    const invalidTicket = signToken({
        v: 2,
        kind: 'pvp-battle',
        aud: 'pokemon-battle-api',
        serverStart: true,
        localBattleId: data.localBattleId,
        participants: data.participants,
        teamSchema: 2,
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
            assert.equal(error.status, 400, error.message);
            assert.match(error.message, /invalid move/i);
            assert.equal(error.details.code, 'TEAM_INVALID');
            const rejection = JSON.parse(Buffer.from(error.details.rejectionToken.split('.')[0], 'base64url').toString('utf8'));
            assert.equal(rejection.kind, 'pvp-rejection');
            assert.equal(rejection.localBattleId, data.localBattleId);
            return true;
        },
    );
});

test('schema 2 empty moves receive a deterministic legal fallback', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('341', '', {
        p1: [mon('Pikachu', [])],
        p2: [mon('Caterpie', ['Tackle'])],
    });
    const started = await start(manager, data, 'schema-2-empty-moves');
    const moves = manager.records.get(started.battleId).battle.p1.pokemon[0].moveSlots.map(slot => slot.id);
    assert.equal(moves.length, 1);
    assert.notEqual(moves[0], 'tackle');
});

test('schema 2 fallback also supports old-generation level-up learnsets', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('346', '', {
        p1: [mon('Butterfree', [], 50)],
        p2: [mon('Caterpie', ['Tackle'])],
    });
    const started = await start(manager, data, 'schema-2-old-gen-fallback');
    const moves = manager.records.get(started.battleId).battle.p1.pokemon[0].moveSlots.map(slot => slot.id);
    assert.equal(moves.length, 1);
});

test('legacy synthetic Tackle is repaired only when illegal for that species', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    for (const [suffix, species, expectedMove] of [
        ['342', 'Pikachu', null],
        ['343', 'Breloom', 'tackle'],
    ]) {
        const data = bundle(suffix, '', {
            p1: [mon(species, ['Tackle'])],
            p2: [mon('Caterpie', ['Tackle'])],
        }, null);
        const started = await start(manager, data, `legacy-tackle-${suffix}`);
        const move = manager.records.get(started.battleId).battle.p1.pokemon[0].moveSlots[0].id;
        if (expectedMove) assert.equal(move, expectedMove);
        else assert.notEqual(move, 'tackle');
    }
});

test('schema 2 never rewrites an explicitly illegal Tackle', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('344', '', {
        p1: [mon('Pikachu', ['Tackle'])],
        p2: [mon('Caterpie', ['Tackle'])],
    });
    await assert.rejects(
        start(manager, data, 'schema-2-explicit-illegal'),
        error => error.status === 400
            && error.details?.code === 'TEAM_INVALID'
            && /can't learn Tackle/i.test(error.message),
    );
});

test('start idempotency fingerprint binds the team schema', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const current = bundle('345');
    const legacy = bundle('345', '', current.teams, null);
    const requestId = 'schema-fingerprint';
    await manager.start({ requestId, battleTicket: current.battleTicket, sideTicket: current.sideTicket('p1') });
    await assert.rejects(
        manager.start({ requestId, battleTicket: legacy.battleTicket, sideTicket: legacy.sideTicket('p1') }),
        error => error.status === 409 && /requestId was reused/i.test(error.message),
    );
});

test('level 50 EV intent marker follows the aggregate EV total', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const data = bundle('347', '', {
        p1: [{
            species: 'Pikachu', moves: ['Thunder Shock'], ability: 'Static', nature: 'Serious', level: 50,
            evs: { hp: 251, atk: 1 },
        }],
        p2: [mon('Caterpie', ['Tackle'])],
    });
    const started = await start(manager, data, 'aggregate-ev-intent');
    const evs = manager.records.get(started.battleId).battle.p1.pokemon[0].set.evs;
    assert.equal(evs.hp, 251, 'the marker must not cross HP from 3 mod 4 to the next stat point');
    assert.equal(evs.atk, 2, 'the next canonical stat with safe headroom receives the marker');
    assert.equal(Object.values(evs).reduce((sum, value) => sum + value, 0), 253);
});

test('a 508 EV level 50 set gets a stat-neutral marker while level 100 stays exact', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const sourceEvs = { hp: 251, atk: 251, def: 6 };
    for (const [suffix, level, expectedTotal] of [
        ['355', 50, 509],
        ['356', 100, 508],
    ]) {
        const data = bundle(suffix, '', {
            p1: [{
                species: 'Pikachu', moves: ['Thunder Shock'], ability: 'Static', nature: 'Serious', level,
                evs: sourceEvs,
            }],
            p2: [mon('Caterpie', ['Tackle'])],
        });
        const started = await start(manager, data, `ev-508-${suffix}`);
        const evs = manager.records.get(started.battleId).battle.p1.pokemon[0].set.evs;
        assert.equal(Object.values(evs).reduce((sum, value) => sum + value, 0), expectedTotal);
        for (const [stat, value] of Object.entries(sourceEvs)) {
            assert.equal(Math.floor(evs[stat] / 4), Math.floor(value / 4), `${stat} must retain its stat contribution`);
        }
        if (level === 50) assert.equal(evs.def, 7, 'the first stat-safe slot receives the marker');
        else assert.deepEqual({ hp: evs.hp, atk: evs.atk, def: evs.def }, sourceEvs);
    }
});

test('EV intent marker respects the 510 budget and level 100 policy', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const cases = [
        ['348', 50, { hp: 252, atk: 252, def: 6 }, 510],
        ['349', 100, { hp: 251, atk: 1 }, 252],
        ['350', 100, {}, 1],
        ['354', 45, { hp: 251, atk: 1 }, 252],
        ['357', 1, {}, 0],
    ];
    for (const [suffix, level, sourceEvs, expectedTotal] of cases) {
        const data = bundle(suffix, '', {
            p1: [{
                species: 'Pikachu', moves: ['Thunder Shock'], ability: 'Static', nature: 'Serious', level,
                evs: sourceEvs,
            }],
            p2: [mon('Caterpie', ['Tackle'])],
        });
        const started = await start(manager, data, `ev-policy-${suffix}`);
        const evs = manager.records.get(started.battleId).battle.p1.pokemon[0].set.evs;
        assert.equal(Object.values(evs).reduce((sum, value) => sum + value, 0), expectedTotal);
        if (suffix === '354') {
            assert.equal(evs.hp, sourceEvs.hp);
            assert.equal(evs.atk, sourceEvs.atk);
        }
    }
});

test('invalid explicit EVs are rejected without receiving an intent marker', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const cases = [
        ['351', { hp: 252, atk: 252, def: 7 }, /511 total EVs/i],
        ['352', { hp: -4, atk: 4 }, /less than 0 (?:EVs|Awakening Values)/i],
        ['353', { hp: 'not-an-ev' }, /integer values for known stats/i],
    ];
    for (const [suffix, evs, pattern] of cases) {
        const data = bundle(suffix, '', {
            p1: [{
                species: 'Pikachu', moves: ['Thunder Shock'], ability: 'Static', nature: 'Serious', level: 50,
                evs,
            }],
            p2: [mon('Caterpie', ['Tackle'])],
        });
        await assert.rejects(
            start(manager, data, `invalid-ev-${suffix}`),
            error => error.status === 400
                && error.details?.code === 'TEAM_INVALID'
                && pattern.test(error.message),
        );
    }
});

test('competitive PvP rejects illegal learnsets, abilities and EV totals independently', async t => {
    const manager = makeManager();
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
    const manager = makeManager();
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
    const manager = makeManager({ now: () => now });
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
    const claimed = await manager.claimTimeout({ battleId: started.battleId, sideTicket: data.sideTicket('p1', Math.floor(now / 1000)) });
    assert.equal(claimed.state.ended, true);
    assert.equal(claimed.state.reason, 'turn-timeout');
    assert.equal(claimed.state.winner, data.participants.p1);
    assert.equal(typeof claimed.receipt, 'string');
    const replayed = await manager.action({
        battleId: started.battleId,
        sideTicket: data.sideTicket('p1', Math.floor(now / 1000)),
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
    const manager = makeManager({ now: () => now });
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
    const expired = await manager.state({ battleId: started.battleId, sideTicket: data.sideTicket('p1', Math.floor(now / 1000)) });
    assert.equal(expired.state.ended, true);
    assert.equal(expired.state.reason, 'turn-timeout');
    assert.equal(expired.state.winner, data.participants.p1);
    assert.equal(typeof expired.receipt, 'string');
});

test('thirty idle minutes end in a signed draw refund', async t => {
    let now = Date.now();
    const manager = makeManager({ now: () => now });
    t.after(() => manager.close());
    const data = bundle('8');
    const started = await start(manager, data, '8');
    now += 30 * 60 * 1000 + 1;
    const expired = await manager.state({ battleId: started.battleId, sideTicket: data.sideTicket('p2', Math.floor(now / 1000)) });
    assert.equal(expired.state.ended, true);
    assert.equal(expired.state.reason, 'idle-timeout');
    assert.equal(expired.state.winner, '');
    assert.equal(typeof expired.receipt, 'string');
});

test('lost Node state yields signed recovery only after the record disappears', async t => {
    const manager = makeManager();
    t.after(() => manager.close());
    const active = bundle('6');
    const started = await start(manager, active, '6');
    const existing = await manager.recover({ battleId: started.battleId, sideTicket: active.sideTicket('p2') });
    assert.equal(existing.battleId, started.battleId);
    assert.equal(existing.missing, undefined);

    manager.records.delete(started.battleId);
    const missing = await manager.recover({ battleId: started.battleId, sideTicket: active.sideTicket('p2') });
    assert.equal(missing.missing, true);
    assert.equal(typeof missing.recoveryToken, 'string');
    const payload = JSON.parse(Buffer.from(missing.recoveryToken.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(payload.kind, 'pvp-recovery');
    assert.equal(payload.localBattleId, active.localBattleId);
    assert.equal(payload.sub, active.participants.p2);
});

test('three PvP battles progress independently', async t => {
    const manager = makeManager();
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
    const manager = makeManager();
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
    const manager = makeManager();
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
