import crypto from 'node:crypto';
import { Battle, extractChannelMessages } from '@pkmn/sim';

import {
    createPvpReceipt,
    createPvpRecoveryToken,
    verifyPvpBattleTicket,
    verifyPvpSideTicket,
} from './tokens.js';


const twoHours = 2 * 60 * 60 * 1000;
const turnTimeout = 3 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));

export class PvpInputError extends Error {
    constructor(message, status = 400, details = null) {
        super(message);
        this.name = 'PvpInputError';
        this.status = status;
        this.details = details;
    }
}

function safeTeam(team) {
    if (!Array.isArray(team) || !team.length || team.length > 6) {
        throw new PvpInputError('A valid PvP team is required.');
    }
    return team.map(mon => ({
        ...mon,
        moves: Array.isArray(mon.moves) && mon.moves.length
            ? mon.moves.slice(0, 4).map(move => typeof move === 'string' ? move : move?.name || 'Tackle')
            : ['Tackle'],
        level: Math.max(1, Math.min(100, Number(mon.level) || 50)),
    }));
}

function sideLog(rawLog, channel) {
    if (!rawLog) return '';
    return extractChannelMessages(rawLog, [channel])[channel].join('\n');
}

function conditionIsFainted(condition = '') {
    return condition.includes('fnt') || condition.startsWith('0 ');
}

function normalizeAction(action, side) {
    const match = typeof action === 'string' && action.trim().match(/^switch\s+(\d+)$/i);
    if (!match) return action;
    const clientSlot = Number(match[1]);
    const simulatorSlot = side.pokemon.findIndex(pokemon => pokemon.clientSlot === clientSlot);
    return simulatorSlot >= 0 ? `switch ${simulatorSlot + 1}` : action;
}

function assertLegalChoice(action, request) {
    if (typeof action !== 'string' || !request || request.wait) {
        throw new PvpInputError('A legal PvP action is required.');
    }
    if (/\b(tera|dynamax|mega|zmove)\b/i.test(action)) {
        throw new PvpInputError('That battle mechanic is disabled.');
    }
    const [kind, rawIndex] = action.trim().split(/\s+/, 2);
    const index = Number(rawIndex);
    const pokemon = request.side?.pokemon || [];
    if (kind === 'switch') {
        const target = pokemon[index - 1];
        if (!Number.isInteger(index) || !target || target.active || conditionIsFainted(target.condition)) {
            throw new PvpInputError('Invalid switch target.');
        }
        return;
    }
    if (kind === 'move' && !request.forceSwitch) {
        const move = request.active?.[0]?.moves?.[index - 1];
        if (!Number.isInteger(index) || !move || move.disabled || move.pp === 0) {
            throw new PvpInputError('Invalid or disabled move.');
        }
        return;
    }
    throw new PvpInputError('Action does not match the current PvP request.');
}

function publicVolatiles(pokemon) {
    return Object.fromEntries(Object.entries(pokemon.volatiles || {}).map(([id, value]) => {
        const move = value?.move?.id || value?.move?.name || value?.move;
        return [id, move ? { move } : {}];
    }));
}

function snapshotPokemon(pokemon, side, revealPrivate, requestMoves = null) {
    const slotIndex = side.pokemon.indexOf(pokemon);
    const snapshot = {
        slot: pokemon.clientSlot ?? slotIndex + 1,
        name: pokemon.name,
        species: pokemon.species.name,
        ident: pokemon.ident,
        details: pokemon.details,
        level: pokemon.level,
        gender: pokemon.gender,
        hp: pokemon.hp,
        maxhp: pokemon.maxhp,
        status: pokemon.status || '',
        fainted: Boolean(pokemon.fainted),
        active: side.active.includes(pokemon),
        types: [...(pokemon.types || [])],
        boosts: { ...(pokemon.boosts || {}) },
        volatiles: publicVolatiles(pokemon),
    };
    if (!revealPrivate) return snapshot;
    const requested = new Map((requestMoves || []).map(move => [move.id, move]));
    snapshot.item = pokemon.item || '';
    snapshot.ability = pokemon.ability || '';
    snapshot.moveSlots = (pokemon.moveSlots || []).map((move, index) => ({
        move: requested.get(move.id)?.move || move.move,
        id: move.id,
        pp: requested.get(move.id)?.pp ?? move.pp,
        maxpp: requested.get(move.id)?.maxpp ?? move.maxpp,
        target: requested.get(move.id)?.target || move.target,
        disabled: Boolean(requested.get(move.id)?.disabled ?? move.disabled),
        index: index + 1,
    }));
    return snapshot;
}

function snapshotSide(side, request, revealPrivate) {
    const active = side.active[0] || null;
    const requestMoves = revealPrivate ? request?.active?.[0]?.moves || null : null;
    const party = [...side.pokemon]
        .sort((a, b) => (a.clientSlot || 0) - (b.clientSlot || 0))
        .map(pokemon => snapshotPokemon(pokemon, side, revealPrivate, pokemon === active ? requestMoves : null));
    return {
        name: side.name,
        activeSlot: active?.clientSlot || null,
        party,
    };
}

function currentState(record, perspective) {
    const side = record.battle[perspective];
    const request = side.activeRequest;
    const ended = Boolean(record.endedReason || record.battle.ended);
    const phase = ended
        ? 'ended'
        : request?.forceSwitch
            ? 'switch'
            : (!request || request.wait)
                ? 'waiting'
                : 'move';
    return {
        schemaVersion: 3,
        revision: record.revision,
        turn: record.battle.turn,
        phase,
        canAct: !ended && !request?.wait && Boolean(request),
        perspective,
        request: {
            forceSwitch: Boolean(request?.forceSwitch),
            wait: Boolean(request?.wait),
            trapped: Boolean(request?.active?.[0]?.trapped),
        },
        p1: snapshotSide(record.battle.p1, record.battle.p1.activeRequest, perspective === 'p1'),
        p2: snapshotSide(record.battle.p2, record.battle.p2.activeRequest, perspective === 'p2'),
        pendingSides: Object.keys(record.pendingChoices),
        pendingSince: Object.fromEntries(Object.entries(record.pendingChoices)
            .map(([pendingSide, choice]) => [pendingSide, choice.submittedAt])),
        ended,
        winner: record.battle.winner || '',
        reason: record.endedReason || '',
    };
}

export class PvpBattleManager {
    constructor({
        ticketSecret = process.env.TRAINER_TICKET_SECRET || '',
        now = () => Date.now(),
    } = {}) {
        this.ticketSecret = ticketSecret;
        this.now = now;
        this.records = new Map();
        this.startRequests = new Map();
        this.cleanupTimer = setInterval(() => this.cleanup(), 15 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    close() {
        clearInterval(this.cleanupTimer);
    }

    cleanup() {
        const cutoff = this.now() - twoHours;
        for (const [battleId, record] of this.records) {
            if (record.lastAccess < cutoff) this.records.delete(battleId);
        }
        for (const [requestId, entry] of this.startRequests) {
            if (entry.createdAt < cutoff) this.startRequests.delete(requestId);
        }
    }

    getRecord(battleId) {
        return this.records.get(battleId);
    }

    _verifySide(record, token) {
        let ticket;
        try {
            ticket = verifyPvpSideTicket(token, this.ticketSecret, Math.floor(this.now() / 1000));
        } catch (error) {
            throw new PvpInputError(error.message, 401);
        }
        if (ticket.localBattleId !== record.localBattleId || record.participants[ticket.side] !== ticket.sub) {
            throw new PvpInputError('PvP side ticket does not match this battle.', 401);
        }
        return ticket;
    }

    _drainLogs(record) {
        const raw = record.battle.log.join('\n');
        record.battle.log = [];
        for (const side of ['p1', 'p2']) {
            const visible = sideLog(raw, side === 'p1' ? 1 : 2);
            if (visible) record.logs[side].push(...visible.split('\n').filter(Boolean));
        }
    }

    _response(record, side, extra = {}) {
        const response = {
            success: true,
            battleId: record.battleId,
            localBattleId: record.localBattleId,
            state: currentState(record, side),
            log: record.logs[side].join('\n'),
            waitingForOpponent: Object.keys(record.pendingChoices).length > 0,
            ...extra,
        };
        if (record.battle.ended || record.endedReason) {
            response.receipt = createPvpReceipt(record, this.ticketSecret, Math.floor(this.now() / 1000));
        }
        return response;
    }

    async start(payload) {
        if (!this.ticketSecret) throw new PvpInputError('PvP ticket secret is not configured.', 503);
        let ticket;
        let sideTicket;
        try {
            ticket = verifyPvpBattleTicket(payload?.battleTicket, this.ticketSecret, Math.floor(this.now() / 1000));
            sideTicket = verifyPvpSideTicket(payload?.sideTicket, this.ticketSecret, Math.floor(this.now() / 1000));
        } catch (error) {
            throw new PvpInputError(error.message, 401);
        }
        if (
            sideTicket.side !== 'p1' ||
            sideTicket.sub !== ticket.participants.p1 ||
            sideTicket.localBattleId !== ticket.localBattleId
        ) {
            throw new PvpInputError('Only P1 can create the signed PvP simulation.', 401);
        }
        const requestId = String(payload.requestId || '');
        if (!requestId || requestId.length > 100) throw new PvpInputError('A valid requestId is required.');
        const fingerprint = crypto.createHash('sha256').update(payload.battleTicket).digest('hex');
        const existing = this.startRequests.get(requestId);
        if (existing && existing.fingerprint !== fingerprint) {
            throw new PvpInputError('requestId was reused with a different PvP battle.', 409);
        }
        if (existing) return this._response(existing.record, 'p1');

        const battle = new Battle({ formatid: 'gen9customgame', strictChoices: false });
        battle.setPlayer('p1', { name: ticket.participants.p1, team: safeTeam(ticket.teams.p1) });
        battle.setPlayer('p2', { name: ticket.participants.p2, team: safeTeam(ticket.teams.p2) });
        battle.p1.pokemon.forEach((pokemon, index) => { pokemon.clientSlot = index + 1; });
        battle.p2.pokemon.forEach((pokemon, index) => { pokemon.clientSlot = index + 1; });
        if (!battle.choose('p1', 'team 1') || !battle.choose('p2', 'team 1')) {
            throw new PvpInputError('PvP leads could not be selected.');
        }

        const now = this.now();
        const record = {
            battleId: crypto.randomUUID(),
            localBattleId: ticket.localBattleId,
            participants: clone(ticket.participants),
            battle,
            revision: 1,
            createdAt: now,
            lastAccess: now,
            pendingChoices: {},
            actionFingerprints: new Map(),
            actionResponses: new Map(),
            logs: { p1: [], p2: [] },
            endedReason: '',
        };
        this._drainLogs(record);
        this.records.set(record.battleId, record);
        this.startRequests.set(requestId, { record, fingerprint, createdAt: now });
        return this._response(record, 'p1');
    }

    async state(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        record.lastAccess = this.now();
        return this._response(record, sideTicket.side);
    }

    async action(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        if (record.battle.ended || record.endedReason) throw new PvpInputError('PvP battle already ended.', 409);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        const side = sideTicket.side;
        const actionId = String(payload.actionId || '');
        if (!actionId || actionId.length > 100) throw new PvpInputError('A valid actionId is required.');
        const key = `${side}:${actionId}`;
        const fingerprint = String(payload.action || '');
        if (record.actionFingerprints.has(key) && record.actionFingerprints.get(key) !== fingerprint) {
            throw new PvpInputError('actionId was reused with another PvP action.', 409);
        }
        if (record.actionResponses.has(key)) return record.actionResponses.get(key);
        if (Number(payload.expectedRevision) !== record.revision) {
            throw new PvpInputError('PvP state is stale.', 409, { state: currentState(record, side) });
        }
        if (record.pendingChoices[side]) throw new PvpInputError('This side already submitted an action.', 409);

        const simulatorSide = record.battle[side];
        const action = normalizeAction(fingerprint, simulatorSide);
        assertLegalChoice(action, simulatorSide.activeRequest);
        record.actionFingerprints.set(key, fingerprint);
        record.pendingChoices[side] = { action, actionId, key, submittedAt: this.now() };

        const requiredSides = ['p1', 'p2'].filter(candidate => {
            const request = record.battle[candidate].activeRequest;
            return request && !request.wait;
        });
        const ready = requiredSides.every(candidate => record.pendingChoices[candidate]);
        if (!ready) {
            const waiting = this._response(record, side, { accepted: true });
            record.actionResponses.set(key, waiting);
            return waiting;
        }

        for (const candidate of requiredSides) {
            const pending = record.pendingChoices[candidate];
            if (!record.battle.choose(candidate, pending.action)) {
                record.pendingChoices = {};
                throw new PvpInputError(`The ${candidate} action was rejected by the simulator.`);
            }
        }
        record.pendingChoices = {};
        record.revision++;
        record.lastAccess = this.now();
        this._drainLogs(record);
        const response = this._response(record, side, { accepted: true, resolved: true });
        record.actionResponses.set(key, response);
        return response;
    }

    async forfeit(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        if (!record.battle.ended && !record.endedReason) {
            const winnerSide = sideTicket.side === 'p1' ? 'p2' : 'p1';
            record.endedReason = 'forfeit';
            record.battle.winner = record.participants[winnerSide];
            record.revision++;
            record.logs.p1.push(`|covenant|forfeit|${sideTicket.side}`);
            record.logs.p2.push(`|covenant|forfeit|${sideTicket.side}`);
        }
        return this._response(record, sideTicket.side, { forfeited: true });
    }

    async claimTimeout(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        if (record.battle.ended || record.endedReason) return this._response(record, sideTicket.side);
        const ownChoice = record.pendingChoices[sideTicket.side];
        const opponentSide = sideTicket.side === 'p1' ? 'p2' : 'p1';
        const opponentRequest = record.battle[opponentSide].activeRequest;
        if (!ownChoice || !opponentRequest || opponentRequest.wait || record.pendingChoices[opponentSide]) {
            throw new PvpInputError('The opponent is not currently timing out.', 409);
        }
        const remainingMs = turnTimeout - (this.now() - ownChoice.submittedAt);
        if (remainingMs > 0) {
            throw new PvpInputError('The opponent turn timeout has not elapsed.', 409, { remainingMs });
        }
        record.endedReason = 'turn-timeout';
        record.battle.winner = record.participants[sideTicket.side];
        record.revision++;
        record.pendingChoices = {};
        record.logs.p1.push(`|covenant|timeout|${opponentSide}`);
        record.logs.p2.push(`|covenant|timeout|${opponentSide}`);
        return this._response(record, sideTicket.side, { timeoutClaimed: true });
    }

    async recover(payload) {
        let sideTicket;
        try {
            sideTicket = verifyPvpSideTicket(payload?.sideTicket, this.ticketSecret, Math.floor(this.now() / 1000));
        } catch (error) {
            throw new PvpInputError(error.message, 401);
        }
        const record = [...this.records.values()].find(candidate => candidate.localBattleId === sideTicket.localBattleId);
        if (record) {
            this._verifySide(record, payload.sideTicket);
            return this._response(record, sideTicket.side, { recovered: true });
        }
        return {
            success: true,
            missing: true,
            localBattleId: sideTicket.localBattleId,
            recoveryToken: createPvpRecoveryToken(sideTicket, this.ticketSecret, Math.floor(this.now() / 1000)),
        };
    }
}
