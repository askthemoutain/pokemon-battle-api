import crypto from 'node:crypto';


const encode = value => Buffer.from(value).toString('base64url');

export function signToken(payload, secret) {
    if (!secret) throw new Error('Token secret is not configured.');
    const encodedPayload = encode(JSON.stringify(payload));
    const signature = crypto
        .createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64url');
    return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token, secret) {
    if (!secret) throw new Error('Token secret is not configured.');
    if (typeof token !== 'string') throw new Error('Battle ticket is missing.');

    const [encodedPayload, sentSignature, extra] = token.split('.');
    if (!encodedPayload || !sentSignature || extra !== undefined) {
        throw new Error('Battle ticket is malformed.');
    }
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64url');
    const sent = Buffer.from(sentSignature);
    const expected = Buffer.from(expectedSignature);
    if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
        throw new Error('Battle ticket signature is invalid.');
    }
    try {
        return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        throw new Error('Battle ticket payload is invalid.');
    }
}

function assertFresh(payload, nowSeconds) {
    return Number.isInteger(payload?.exp) && payload.exp >= nowSeconds;
}

export function verifyTrainerTicket(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const payload = verifySignedToken(token, secret);

    if (
        payload.v !== 1 ||
        payload.kind !== 'trainer' ||
        payload.aud !== 'pokemon-battle-api' ||
        !Number.isInteger(payload.exp) ||
        payload.exp < nowSeconds
    ) {
        throw new Error('Trainer ticket is expired or invalid.');
    }
    return payload;
}

export function verifyBattleTicket(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const payload = verifySignedToken(token, secret);
    if (
        payload.v !== 1 ||
        payload.kind !== 'battle' ||
        payload.aud !== 'pokemon-battle-api' ||
        !['wild', 'trainer'].includes(payload.encounterType) ||
        !payload.localBattleId ||
        !payload.sub ||
        !Array.isArray(payload.players) || !payload.players.length ||
        !Number.isInteger(payload.exp) ||
        payload.exp < nowSeconds
    ) {
        throw new Error('Battle ticket is expired or invalid.');
    }
    return payload;
}

export function verifyPvpBattleTicket(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const payload = verifySignedToken(token, secret);
    if (
        payload.v !== 1 ||
        payload.kind !== 'pvp-battle' ||
        payload.aud !== 'pokemon-battle-api' ||
        !payload.localBattleId ||
        !payload.participants?.p1 ||
        !payload.participants?.p2 ||
        !Array.isArray(payload.teams?.p1) || !payload.teams.p1.length ||
        !Array.isArray(payload.teams?.p2) || !payload.teams.p2.length ||
        !assertFresh(payload, nowSeconds)
    ) {
        throw new Error('PvP battle ticket is expired or invalid.');
    }
    return payload;
}

export function verifyPvpSideTicket(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const payload = verifySignedToken(token, secret);
    if (
        payload.v !== 1 ||
        payload.kind !== 'pvp-side' ||
        payload.aud !== 'pokemon-battle-api' ||
        !payload.localBattleId ||
        !['p1', 'p2'].includes(payload.side) ||
        !payload.sub ||
        !assertFresh(payload, nowSeconds)
    ) {
        throw new Error('PvP side ticket is expired or invalid.');
    }
    return payload;
}

export function createPvpReceipt(record, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    return signToken({
        v: 1,
        kind: 'pvp-receipt',
        aud: 'pokemon-covenant-php',
        localBattleId: record.localBattleId,
        battleId: record.battleId,
        revision: record.revision,
        participants: record.participants,
        state: {
            ended: Boolean(record.battle.ended || record.endedReason),
            winner: record.battle.winner || '',
            reason: record.endedReason || (record.battle.ended ? 'battle' : ''),
            turn: record.battle.turn,
        },
        iat: nowSeconds,
        exp: nowSeconds + (2 * 60 * 60),
    }, secret);
}

export function createPvpRecoveryToken(sideTicket, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    return signToken({
        v: 1,
        kind: 'pvp-recovery',
        aud: 'pokemon-covenant-php',
        localBattleId: sideTicket.localBattleId,
        sub: sideTicket.sub,
        side: sideTicket.side,
        reason: 'node-state-lost',
        iat: nowSeconds,
        exp: nowSeconds + 5 * 60,
    }, secret);
}

export function createBattleReceipt(record, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const state = record.publicState;
    const opponents = record.battle.p2.pokemon.map((pokemon, index) => ({
        slot: pokemon.clientSlot ?? index + 1,
        species: pokemon.species.name,
        level: pokemon.level,
        hp: pokemon.hp,
        maxhp: pokemon.maxhp,
        status: pokemon.status || '',
        fainted: Boolean(pokemon.fainted),
        shiny: Boolean(pokemon.set?.shiny),
        moves: (pokemon.set?.moves || pokemon.moveSlots?.map(move => move.move) || []).slice(0, 4),
    }));
    return signToken({
        v: 1,
        kind: 'battle-receipt',
        aud: 'pokemon-covenant-php',
        sub: record.subject,
        localBattleId: record.localBattleId,
        battleId: record.battleId,
        encounterType: record.encounterType,
        testMode: record.testMode,
        revision: record.revision,
        state,
        opponents,
        participants: [...(record.participatedSlots || [])].sort((a, b) => a - b),
        iat: nowSeconds,
        exp: nowSeconds + (2 * 60 * 60),
    }, secret);
}

export function createAbortToken(battleId, testMode, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    return signToken({
        v: 1,
        kind: 'trainer-ai-abort',
        aud: 'pokemon-covenant-php',
        battleId,
        testMode: Boolean(testMode),
        iat: nowSeconds,
        exp: nowSeconds + 5 * 60,
    }, secret);
}
