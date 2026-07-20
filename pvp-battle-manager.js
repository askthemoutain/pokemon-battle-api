import crypto from 'node:crypto';
import { Battle, Dex, TeamValidator, extractChannelMessages } from '@pkmn/sim';

import {
    createPvpReceipt,
    createPvpRejectionToken,
    createPvpRecoveryToken,
    verifyPvpBattleTicket,
    verifyPvpSideTicket,
    verifyPvpSpectatorTicket,
} from './tokens.js';


const twoHours = 2 * 60 * 60 * 1000;
const turnTimeout = 3 * 60 * 1000;
const idleMatchTimeout = 30 * 60 * 1000;
const spectatorDelay = 10 * 1000;
const spectatorHistoryLimit = 40;
const pvpFormat = 'gen9nationaldexag';
const clone = value => JSON.parse(JSON.stringify(value));

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

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
    const normalized = team.map(mon => {
        const level = Math.max(1, Math.min(100, Number(mon.level) || 50));
        const species = Dex.species.get(mon.species);
        const evs = Object.fromEntries(Object.entries(mon.evs || {}).map(([stat, value]) => [stat, Number(value) || 0]));
        const evTotal = Object.values(evs).reduce((sum, value) => sum + value, 0);
        if (evTotal <= 510 && (evTotal === 0 || level !== 100) && !Object.values(evs).some(value => value % 4 !== 0)) {
            const marker = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].find(stat => Number(evs[stat] || 0) < 252) || 'hp';
            evs[marker] = Number(evs[marker] || 0) + 1;
        }
        return {
            ...mon,
            name: String(mon.name || mon.species || '').slice(0, 18),
            ability: !mon.ability || mon.ability === '???' ? (species.abilities?.[0] || '') : mon.ability,
            moves: Array.isArray(mon.moves) && mon.moves.length
                ? mon.moves.slice(0, 4).map(move => typeof move === 'string' ? move : move?.name || '')
                : [],
            level,
            evs,
        };
    });
    const problems = TeamValidator.get(pvpFormat).validateTeam(clone(normalized));
    if (problems?.length) {
        throw new PvpInputError(`Invalid PvP team: ${problems[0]}`);
    }
    return normalized;
}

function sideLog(rawLog, channel) {
    if (!rawLog) return '';
    return extractChannelMessages(rawLog, [channel])[channel].join('\n');
}

function conditionIsFainted(condition = '') {
    return condition.includes('fnt') || condition.startsWith('0 ');
}

function isRevivalRequest(request) {
    return Boolean(request?.forceSwitch && request.side?.pokemon?.some(pokemon => pokemon.active && pokemon.reviving));
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
        const fainted = conditionIsFainted(target?.condition);
        const reviving = isRevivalRequest(request);
        if (
            !Number.isInteger(index) ||
            !target ||
            target.active ||
            (reviving ? !fainted : fainted) ||
            (!request.forceSwitch && request.active?.[0]?.trapped)
        ) {
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

function publicConditions(conditions) {
    return Object.fromEntries(Object.keys(conditions || {}).map(id => [id, {}]));
}

function snapshotPokemon(pokemon, side, revealPrivate, requestMoves = null) {
    const slotIndex = side.pokemon.indexOf(pokemon);
    const apparent = pokemon.illusion || pokemon;
    const apparentSpecies = apparent.species?.name || pokemon.species.name;
    const apparentName = apparent.name || apparentSpecies;
    const apparentDetails = apparent.details || pokemon.details;
    const identPrefix = String(pokemon.ident || '').split(':', 1)[0] || side.id;
    const snapshot = {
        slot: pokemon.clientSlot ?? slotIndex + 1,
        name: revealPrivate ? pokemon.name : apparentName,
        species: revealPrivate ? pokemon.species.name : apparentSpecies,
        renderSpecies: apparentSpecies,
        ident: revealPrivate ? pokemon.ident : `${identPrefix}: ${apparentName}`,
        details: revealPrivate ? pokemon.details : apparentDetails,
        level: revealPrivate ? pokemon.level : apparent.level,
        gender: revealPrivate ? pokemon.gender : apparent.gender,
        hp: pokemon.hp,
        maxhp: pokemon.maxhp,
        status: pokemon.status || '',
        fainted: Boolean(pokemon.fainted),
        active: side.active.includes(pokemon),
        types: [...((revealPrivate ? pokemon.types : apparent.types) || [])],
        boosts: { ...(pokemon.boosts || {}) },
        volatiles: publicVolatiles(pokemon),
    };
    if (!revealPrivate) return snapshot;
    snapshot.item = pokemon.item || '';
    snapshot.ability = pokemon.ability || '';
    const sourceMoves = pokemon.moveSlots || [];
    const visibleMoves = Array.isArray(requestMoves) ? requestMoves : sourceMoves;
    snapshot.moveSlots = visibleMoves.map((move, index) => {
        const source = sourceMoves.find(candidate => candidate.id === move.id)
            || (Array.isArray(requestMoves) ? {} : sourceMoves[index])
            || {};
        return {
            move: move.move || source.move,
            id: move.id || source.id,
            pp: move.pp ?? source.pp,
            maxpp: move.maxpp ?? source.maxpp,
            target: move.target || source.target,
            disabled: Boolean(move.disabled ?? source.disabled),
            index: index + 1,
        };
    });
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
        sideConditions: publicConditions(side.sideConditions),
        slotConditions: publicConditions(side.slotConditions?.[active?.position || 0]),
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
    const requestPokemon = request?.side?.pokemon || [];
    const reviving = Boolean(request?.forceSwitch && requestPokemon.some(pokemon => pokemon.active && pokemon.reviving));
    const forcedMove = Boolean(
        !request?.forceSwitch &&
        request?.active?.[0]?.moves?.length === 1 &&
        side.active[0]?.getLockedMove?.()
    );
    const trapped = Boolean(request?.active?.[0]?.trapped);
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
            trapped,
            reviving,
            forcedMove,
            canSwitch: Boolean(request && !request.wait && (request.forceSwitch || !trapped) && !forcedMove),
            canUseBag: false,
            canRun: !ended,
        },
        p1: snapshotSide(record.battle.p1, record.battle.p1.activeRequest, perspective === 'p1'),
        p2: snapshotSide(record.battle.p2, record.battle.p2.activeRequest, perspective === 'p2'),
        field: {
            weather: record.battle.field.weather || '',
            terrain: record.battle.field.terrain || '',
            pseudoWeather: publicConditions(record.battle.field.pseudoWeather),
        },
        pendingSides: Object.keys(record.pendingChoices),
        pendingSince: Object.fromEntries(Object.entries(record.pendingChoices)
            .map(([pendingSide, choice]) => [pendingSide, choice.submittedAt])),
        idleDeadlineAt: record.lastProgressAt + idleMatchTimeout,
        ended,
        winner: record.battle.winner || '',
        reason: record.endedReason || '',
    };
}

function spectatorState(record) {
    const ended = Boolean(record.endedReason || record.battle.ended);
    return {
        schemaVersion: 3,
        revision: record.revision,
        turn: record.battle.turn,
        phase: ended ? 'ended' : 'watching',
        canAct: false,
        perspective: 'spectator',
        request: { forceSwitch: false, wait: true, trapped: false },
        p1: snapshotSide(record.battle.p1, null, false),
        p2: snapshotSide(record.battle.p2, null, false),
        pendingSides: [],
        pendingSince: {},
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
        this.localStarts = new Map();
        this.cleanupTimer = setInterval(() => this.cleanup(), 15 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    close() {
        clearInterval(this.cleanupTimer);
    }

    cleanup() {
        const cutoff = this.now() - twoHours;
        for (const [battleId, record] of this.records) {
            if (record.lastAccess < cutoff) {
                this.records.delete(battleId);
                this.localStarts.delete(record.localBattleId);
            }
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

    _verifySpectator(record, token) {
        let ticket;
        try {
            ticket = verifyPvpSpectatorTicket(token, this.ticketSecret, Math.floor(this.now() / 1000));
        } catch (error) {
            throw new PvpInputError(error.message, 401);
        }
        if (ticket.localBattleId !== record.localBattleId || ticket.battleId !== record.battleId) {
            throw new PvpInputError('PvP spectator ticket does not match this battle.', 401);
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
        const publicLog = sideLog(raw, 0);
        if (publicLog) record.logs.spectator.push(...publicLog.split('\n').filter(Boolean));
    }

    _appendPublicEvent(record, line) {
        record.logs.p1.push(line);
        record.logs.p2.push(line);
        record.logs.spectator.push(line);
    }

    _captureSpectator(record) {
        const snapshot = {
            capturedAt: this.now(),
            state: clone(spectatorState(record)),
            log: record.logs.spectator.join('\n'),
        };
        const previous = record.spectatorHistory.at(-1);
        if (previous?.state?.revision === snapshot.state.revision && previous.log === snapshot.log) return;
        record.spectatorHistory.push(snapshot);
        if (record.spectatorHistory.length > spectatorHistoryLimit) {
            // Preserve the initial state so a burst of turns can never bypass the delay.
            record.spectatorHistory.splice(1, 1);
        }
    }

    _spectatorResponse(record) {
        const cutoff = this.now() - spectatorDelay;
        const eligible = record.spectatorHistory.filter(entry => entry.capturedAt <= cutoff);
        const snapshot = eligible.at(-1) || record.spectatorHistory[0];
        return {
            success: true,
            battleId: record.battleId,
            localBattleId: record.localBattleId,
            delayedByMs: spectatorDelay,
            state: clone(snapshot.state),
            log: snapshot.log,
        };
    }

    _endByClock(record) {
        if (record.battle.ended || record.endedReason) return;
        const pending = Object.entries(record.pendingChoices);
        if (pending.length === 1 && this.now() - pending[0][1].submittedAt >= turnTimeout) {
            const winnerSide = pending[0][0];
            const loserSide = winnerSide === 'p1' ? 'p2' : 'p1';
            record.endedReason = 'turn-timeout';
            record.battle.winner = record.participants[winnerSide];
            record.revision++;
            record.pendingChoices = {};
            this._appendPublicEvent(record, `|covenant|timeout|${loserSide}`);
            this._captureSpectator(record);
            return;
        }
        if (pending.length === 0 && this.now() - record.lastProgressAt >= idleMatchTimeout) {
            record.endedReason = 'idle-timeout';
            record.battle.winner = '';
            record.revision++;
            this._appendPublicEvent(record, '|covenant|idle-timeout|draw');
            this._captureSpectator(record);
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
        const fingerprint = crypto.createHash('sha256').update(canonicalJson({
            localBattleId: ticket.localBattleId,
            participants: ticket.participants,
            teams: ticket.teams,
        })).digest('hex');
        const existing = this.startRequests.get(requestId);
        if (existing && existing.fingerprint !== fingerprint) {
            throw new PvpInputError('requestId was reused with a different PvP battle.', 409);
        }
        if (existing) return this._response(existing.record, 'p1');

        const localExisting = this.localStarts.get(ticket.localBattleId);
        if (localExisting && localExisting.fingerprint !== fingerprint) {
            throw new PvpInputError('This escrow battle already has a different signed simulation.', 409);
        }
        if (localExisting) {
            this.startRequests.set(requestId, localExisting);
            return this._response(localExisting.record, 'p1');
        }

        let p1Team;
        let p2Team;
        try {
            p1Team = safeTeam(ticket.teams.p1);
            p2Team = safeTeam(ticket.teams.p2);
        } catch (error) {
            if (!(error instanceof PvpInputError)) throw error;
            throw new PvpInputError(error.message, 400, {
                code: 'TEAM_INVALID',
                rejectionToken: createPvpRejectionToken(ticket, this.ticketSecret, error.message, Math.floor(this.now() / 1000)),
            });
        }
        const battle = new Battle({ formatid: pvpFormat, strictChoices: false });
        battle.setPlayer('p1', { name: ticket.participants.p1, team: p1Team });
        battle.setPlayer('p2', { name: ticket.participants.p2, team: p2Team });
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
            lastProgressAt: now,
            pendingChoices: {},
            actionFingerprints: new Map(),
            actionResponses: new Map(),
            logs: { p1: [], p2: [], spectator: [] },
            spectatorHistory: [],
            endedReason: '',
        };
        this._drainLogs(record);
        this._captureSpectator(record);
        this.records.set(record.battleId, record);
        const startEntry = { record, fingerprint, createdAt: now };
        this.startRequests.set(requestId, startEntry);
        this.localStarts.set(record.localBattleId, startEntry);
        return this._response(record, 'p1');
    }

    async state(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        record.lastAccess = this.now();
        this._endByClock(record);
        return this._response(record, sideTicket.side);
    }

    async spectate(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        this._verifySpectator(record, payload.spectatorTicket);
        record.lastAccess = this.now();
        this._endByClock(record);
        return this._spectatorResponse(record);
    }

    async action(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        const side = sideTicket.side;
        this._endByClock(record);
        const actionId = String(payload.actionId || '');
        if (!actionId || actionId.length > 100) throw new PvpInputError('A valid actionId is required.');
        const key = `${side}:${actionId}`;
        const fingerprint = String(payload.action || '');
        if (record.actionFingerprints.has(key) && record.actionFingerprints.get(key) !== fingerprint) {
            throw new PvpInputError('actionId was reused with another PvP action.', 409);
        }
        if (record.actionResponses.has(key)) {
            const cached = record.actionResponses.get(key);
            return this._response(record, side, {
                accepted: true,
                replayed: true,
                resolved: Boolean(cached?.resolved)
                    || record.revision > Number(cached?.state?.revision || 0),
            });
        }
        if (record.battle.ended || record.endedReason) throw new PvpInputError('PvP battle already ended.', 409);
        if (Number(payload.expectedRevision) !== record.revision) {
            throw new PvpInputError('PvP state is stale.', 409, { state: currentState(record, side) });
        }
        if (record.pendingChoices[side]) throw new PvpInputError('This side already submitted an action.', 409);

        const simulatorSide = record.battle[side];
        const action = normalizeAction(fingerprint, simulatorSide);
        assertLegalChoice(action, simulatorSide.activeRequest);
        record.actionFingerprints.set(key, fingerprint);
        record.pendingChoices[side] = { action, actionId, key, submittedAt: this.now() };
        record.lastProgressAt = this.now();

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
        record.lastProgressAt = this.now();
        this._drainLogs(record);
        this._captureSpectator(record);
        const response = this._response(record, side, { accepted: true, resolved: true });
        record.actionResponses.set(key, response);
        return response;
    }

    async forfeit(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        this._endByClock(record);
        if (!record.battle.ended && !record.endedReason) {
            const winnerSide = sideTicket.side === 'p1' ? 'p2' : 'p1';
            record.endedReason = 'forfeit';
            record.battle.winner = record.participants[winnerSide];
            record.revision++;
            this._appendPublicEvent(record, `|covenant|forfeit|${sideTicket.side}`);
            this._captureSpectator(record);
        }
        return this._response(record, sideTicket.side, { forfeited: true });
    }

    async claimTimeout(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record) throw new PvpInputError('PvP battle not found or expired.', 404);
        const sideTicket = this._verifySide(record, payload.sideTicket);
        this._endByClock(record);
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
        this._appendPublicEvent(record, `|covenant|timeout|${opponentSide}`);
        this._captureSpectator(record);
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
            this._endByClock(record);
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
