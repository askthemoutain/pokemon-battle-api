import crypto from 'node:crypto';
import { Battle, extractChannelMessages } from '@pkmn/sim';

import { createAbortToken, verifyTrainerTicket } from './tokens.js';


const clone = value => JSON.parse(JSON.stringify(value));
const twoHours = 2 * 60 * 60 * 1000;

export class BattleInputError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'BattleInputError';
        this.status = status;
    }
}

export class TrainerUnavailableError extends Error {
    constructor(details) {
        super('Trainer AI is temporarily unavailable.');
        this.name = 'TrainerUnavailableError';
        this.status = 503;
        this.details = details;
    }
}

function sanitizeTeam(team) {
    if (!Array.isArray(team) || !team.length) {
        throw new BattleInputError('A non-empty team is required.');
    }
    return team.map(mon => {
        const safeMon = { ...mon };
        if (!Array.isArray(safeMon.moves) || !safeMon.moves.length) {
            safeMon.moves = ['Tackle'];
        }
        safeMon.moves = safeMon.moves.map(move => (
            typeof move === 'string' ? move : move?.name || move?.id || 'tackle'
        ));
        return safeMon;
    });
}

function applyP1State(battle, p1State) {
    if (!p1State || typeof p1State !== 'object') return;
    battle.p1.pokemon.forEach(mon => {
        const key = mon.name || mon.species.name;
        const searchKeys = [key, mon.species.name, key.toLowerCase(), mon.species.name.toLowerCase()];
        const matchedKey = searchKeys.find(candidate => p1State[candidate]);
        if (!matchedKey) return;

        const state = p1State[matchedKey];
        if (state.hp !== undefined) {
            mon.hp = Math.max(0, Math.min(Number(state.hp), mon.maxhp));
            if (mon.hp === 0) mon.faint();
        }
        if (state.status && state.status !== 'fnt') mon.setStatus(state.status);
    });
}

function sideLog(rawLog, channel) {
    if (!rawLog) return '';
    return extractChannelMessages(rawLog, [channel])[channel].join('\n');
}

function currentState(battle) {
    const active = side => {
        const pokemon = side.active[0];
        if (!pokemon) return null;
        const slotIndex = side.pokemon.indexOf(pokemon);
        return {
            hp: pokemon.hp,
            maxhp: pokemon.maxhp,
            fainted: pokemon.fainted,
            name: pokemon.name,
            species: pokemon.species.name,
            ident: pokemon.ident,
            slot: pokemon.clientSlot ?? (slotIndex >= 0 ? slotIndex + 1 : null),
        };
    };
    return {
        p1Active: active(battle.p1),
        p2Active: active(battle.p2),
        ended: battle.ended,
        winner: battle.winner,
    };
}

function normalizePlayerAction(action, side) {
    const match = typeof action === 'string' && action.trim().match(/^switch\s+(\d+)$/i);
    if (!match) return action;

    const clientSlot = Number(match[1]);
    const simulatorSlot = side.pokemon.findIndex(pokemon => pokemon.clientSlot === clientSlot);
    return simulatorSlot >= 0 ? `switch ${simulatorSlot + 1}` : action;
}

function requestType(request) {
    if (request?.teamPreview) return 'team';
    if (request?.forceSwitch) return 'switch';
    return 'move';
}

function conditionIsFainted(condition = '') {
    return condition.includes('fnt') || condition.startsWith('0 ');
}

function assertLegalChoice(action, request) {
    if (typeof action !== 'string' || !request) {
        throw new BattleInputError('A legal battle action is required.');
    }
    if (/\b(tera|dynamax|mega|zmove)\b/i.test(action)) {
        throw new BattleInputError('That battle mechanic is disabled.');
    }

    const [kind, rawIndex] = action.trim().split(/\s+/, 2);
    const index = Number(rawIndex);
    const pokemon = request.side?.pokemon || [];
    if (kind === 'team' && request.teamPreview) {
        if (!Number.isInteger(index) || index < 1 || index > pokemon.length) {
            throw new BattleInputError('Invalid team lead.');
        }
        return;
    }
    if (kind === 'switch') {
        const target = pokemon[index - 1];
        if (!Number.isInteger(index) || !target || target.active || conditionIsFainted(target.condition)) {
            throw new BattleInputError('Invalid switch target.');
        }
        return;
    }
    if (kind === 'move' && !request.forceSwitch) {
        const move = request.active?.[0]?.moves?.[index - 1];
        if (!Number.isInteger(index) || !move || move.disabled || move.pp === 0) {
            throw new BattleInputError('Invalid or disabled move.');
        }
        return;
    }
    throw new BattleInputError('Action does not match the current battle request.');
}

function randomChoice(request) {
    if (request?.forceSwitch) {
        const candidates = request.side.pokemon
            .map((pokemon, index) => ({ pokemon, index: index + 1 }))
            .filter(({ pokemon }) => !pokemon.active && !conditionIsFainted(pokemon.condition));
        if (!candidates.length) return null;
        return `switch ${candidates[Math.floor(Math.random() * candidates.length)].index}`;
    }
    if (request?.active) {
        const candidates = request.active[0].moves
            .map((move, index) => ({ move, index: index + 1 }))
            .filter(({ move }) => !move.disabled && move.pp !== 0);
        if (!candidates.length) return 'move 1';
        return `move ${candidates[Math.floor(Math.random() * candidates.length)].index}`;
    }
    return null;
}

export class BattleManager {
    constructor({
        foulPlayClient,
        trainerTicketSecret = process.env.TRAINER_TICKET_SECRET || '',
        trainerAiEnabled = process.env.TRAINER_AI_ENABLED === '1',
        searchBudgetMs = Number(process.env.FOUL_PLAY_SEARCH_BUDGET_MS || 2000),
        abortAfterMs = Number(process.env.TRAINER_AI_ABORT_AFTER_MS || 120000),
        now = () => Date.now(),
    } = {}) {
        this.foulPlayClient = foulPlayClient;
        this.trainerTicketSecret = trainerTicketSecret;
        this.trainerAiEnabled = trainerAiEnabled;
        this.searchBudgetMs = Math.max(100, Math.min(searchBudgetMs, 2000));
        this.abortAfterMs = abortAfterMs;
        this.now = now;
        this.records = new Map();
        this.startRequests = new Map();

        this.cleanupTimer = setInterval(() => this.cleanup(), 15 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }

    close() {
        clearInterval(this.cleanupTimer);
    }

    getRecord(battleId) {
        return this.records.get(battleId);
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

    _fingerprint(payload, encounterType) {
        return crypto.createHash('sha256').update(JSON.stringify({
            encounterType,
            p1: payload.p1,
            p2: payload.p2,
            p1State: payload.p1State || {},
        })).digest('hex');
    }

    _createRecord(payload, encounterType, ticketPayload) {
        const battle = new Battle({
            formatid: 'gen9customgame',
            debug: process.env.BATTLE_DEBUG === '1',
            strictChoices: false,
        });
        battle.setPlayer('p1', {
            name: payload.p1.name || 'Player',
            team: sanitizeTeam(payload.p1.team),
        });
        battle.setPlayer('p2', {
            name: payload.p2.name || (encounterType === 'trainer' ? 'Trainer' : 'Wild Pokemon'),
            team: sanitizeTeam(payload.p2.team),
        });
        battle.p1.pokemon.forEach((pokemon, index) => { pokemon.clientSlot = index + 1; });
        battle.p2.pokemon.forEach((pokemon, index) => { pokemon.clientSlot = index + 1; });
        applyP1State(battle, payload.p1State);

        const battleId = crypto.randomUUID();
        const createdAt = this.now();
        const record = {
            battleId,
            battle,
            encounterType,
            testMode: Boolean(ticketPayload?.testMode),
            initialP2Request: clone(battle.p2.activeRequest),
            p2ProtocolHistory: '',
            createdAt,
            lastAccess: createdAt,
            started: false,
            startResponse: null,
            aiUnavailableSince: null,
            actionResponses: new Map(),
            actionPromises: new Map(),
            pendingAction: null,
        };
        this.records.set(battleId, record);
        return record;
    }

    async start(payload) {
        if (!payload?.p1 || !payload?.p2) {
            throw new BattleInputError('Missing p1 or p2 team configurations.');
        }
        const encounterType = payload.encounterType === 'trainer' ? 'trainer' : 'wild';
        let ticketPayload = null;
        if (encounterType === 'trainer') {
            if (!this.trainerAiEnabled) {
                throw new BattleInputError('Trainer AI is not enabled.', 503);
            }
            try {
                ticketPayload = verifyTrainerTicket(payload.trainerTicket, this.trainerTicketSecret);
            } catch (error) {
                throw new BattleInputError(error.message, 401);
            }
        }

        const requestId = payload.requestId || (encounterType === 'wild' ? crypto.randomUUID() : '');
        if (!requestId || requestId.length > 100) {
            throw new BattleInputError('A valid requestId is required.');
        }
        const fingerprint = this._fingerprint(payload, encounterType);
        let entry = this.startRequests.get(requestId);
        if (entry && entry.fingerprint !== fingerprint) {
            throw new BattleInputError('requestId was reused with a different battle.', 409);
        }
        if (!entry) {
            const record = this._createRecord(payload, encounterType, ticketPayload);
            entry = { record, fingerprint, promise: null, createdAt: this.now() };
            this.startRequests.set(requestId, entry);
        }
        if (entry.record.startResponse) return entry.record.startResponse;
        if (entry.promise) return entry.promise;

        entry.promise = this._completeStart(entry.record);
        try {
            return await entry.promise;
        } finally {
            entry.promise = null;
        }
    }

    async _completeStart(record) {
        let p2Choice = 'team 1';
        if (record.encounterType === 'trainer') {
            p2Choice = await this._trainerChoice(record);
        }
        assertLegalChoice(p2Choice, record.battle.p2.activeRequest);
        if (!record.battle.choose('p1', 'team 1')) {
            throw new BattleInputError('The player lead could not be selected.');
        }
        if (!record.battle.choose('p2', p2Choice)) {
            record.battle.p1.clearChoice();
            throw new BattleInputError('The opponent lead could not be selected.');
        }

        const log = this._drainLogs(record);
        record.started = true;
        record.lastAccess = this.now();
        record.startResponse = {
            success: true,
            battleId: record.battleId,
            log,
            state: currentState(record.battle),
            trainer: record.encounterType === 'trainer',
            testMode: record.testMode,
        };
        return record.startResponse;
    }

    _p2Transcript(record) {
        const pendingRaw = record.battle.log.join('\n');
        return [record.p2ProtocolHistory, sideLog(pendingRaw, 2)].filter(Boolean).join('\n');
    }

    _drainLogs(record) {
        const raw = record.battle.log.join('\n');
        record.battle.log = [];
        const p2 = sideLog(raw, 2);
        if (p2) {
            record.p2ProtocolHistory = [record.p2ProtocolHistory, p2].filter(Boolean).join('\n');
        }
        return sideLog(raw, 1);
    }

    _unavailable(record) {
        if (record.aiUnavailableSince === null) record.aiUnavailableSince = this.now();
        const waitedMs = Math.max(0, this.now() - record.aiUnavailableSince);
        const abortAvailable = waitedMs >= this.abortAfterMs;
        return new TrainerUnavailableError({
            success: false,
            retryable: true,
            code: 'TRAINER_AI_UNAVAILABLE',
            battleId: record.battleId,
            waitedMs,
            abortAvailable,
            abortToken: abortAvailable
                ? createAbortToken(record.battleId, record.testMode, this.trainerTicketSecret)
                : null,
        });
    }

    async _trainerChoice(record) {
        const request = clone(record.battle.p2.activeRequest);
        try {
            const result = await this.foulPlayClient.decision({
                schemaVersion: 1,
                battleId: record.battleId,
                format: 'gen9customgame',
                aiSide: 'p2',
                requestType: requestType(request),
                initialRequest: record.initialP2Request,
                activeRequest: request,
                transcript: this._p2Transcript(record),
                searchBudgetMs: this.searchBudgetMs,
            });
            assertLegalChoice(result.action, request);
            record.aiUnavailableSince = null;
            return result.action;
        } catch (error) {
            console.error('[Trainer AI] Decision failed:', error.message);
            throw this._unavailable(record);
        }
    }

    async action(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record || !record.started) {
            throw new BattleInputError('Battle not found or expired.', 404);
        }
        const actionId = payload.actionId || (record.encounterType === 'wild' ? crypto.randomUUID() : '');
        if (!actionId || actionId.length > 100) {
            throw new BattleInputError('A valid actionId is required.');
        }
        record.lastAccess = this.now();
        if (record.actionResponses.has(actionId)) return record.actionResponses.get(actionId);
        if (record.actionPromises.has(actionId)) return record.actionPromises.get(actionId);
        if (record.pendingAction && record.pendingAction.actionId !== actionId) {
            throw new BattleInputError('A previous trainer action is still being resolved.', 409);
        }

        const promise = this._executeAction(record, actionId, payload.action);
        record.actionPromises.set(actionId, promise);
        try {
            return await promise;
        } finally {
            record.actionPromises.delete(actionId);
        }
    }

    async _executeAction(record, actionId, playerAction) {
        if (!record.pendingAction) {
            const p1Request = clone(record.battle.p1.activeRequest);
            const normalizedPlayerAction = normalizePlayerAction(playerAction, record.battle.p1);
            assertLegalChoice(normalizedPlayerAction, p1Request);

            let p2Choice = null;
            const p2Request = record.battle.p2.activeRequest;
            if (p2Request && !p2Request.wait) {
                p2Choice = record.encounterType === 'trainer'
                    ? await this._trainerChoice(record)
                    : randomChoice(p2Request);
            }
            record.pendingAction = {
                actionId,
                playerAction: normalizedPlayerAction,
                p2Choice,
                applied: false,
            };
        }

        const pending = record.pendingAction;
        if (!pending.applied) {
            if (!record.battle.choose('p1', pending.playerAction)) {
                record.battle.p1.clearChoice();
                record.pendingAction = null;
                throw new BattleInputError('The player action was rejected by the simulator.');
            }
            if (pending.p2Choice && !record.battle.choose('p2', pending.p2Choice)) {
                record.battle.p1.clearChoice();
                record.battle.p2.clearChoice();
                record.pendingAction = null;
                throw new BattleInputError('The opponent action was rejected by the simulator.');
            }
            pending.applied = true;
        }

        await this._resolveP2ForcedSwitch(record);
        const log = this._drainLogs(record);
        const response = {
            success: true,
            log,
            state: currentState(record.battle),
            trainer: record.encounterType === 'trainer',
            testMode: record.testMode,
        };
        record.pendingAction = null;
        record.actionResponses.set(actionId, response);
        return response;
    }

    async _resolveP2ForcedSwitch(record) {
        let safety = 0;
        while (
            !record.battle.ended &&
            record.battle.p2.activeRequest?.forceSwitch &&
            record.battle.p1.activeRequest?.wait
        ) {
            if (++safety > 6) throw new Error('Too many consecutive forced switches.');
            const choice = record.encounterType === 'trainer'
                ? await this._trainerChoice(record)
                : randomChoice(record.battle.p2.activeRequest);
            if (!choice || !record.battle.choose('p2', choice)) {
                throw new BattleInputError('The opponent forced switch was rejected.');
            }
        }
    }
}

export const internals = {
    assertLegalChoice,
    sideLog,
};
