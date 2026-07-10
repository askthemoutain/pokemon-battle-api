import crypto from 'node:crypto';
import { Battle, Dex, extractChannelMessages } from '@pkmn/sim';

import { createAbortToken, createBattleReceipt, verifyBattleTicket, verifyTrainerTicket } from './tokens.js';


const clone = value => JSON.parse(JSON.stringify(value));
const twoHours = 2 * 60 * 60 * 1000;

const speciesId = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export class BattleInputError extends Error {
    constructor(message, status = 400, details = null) {
        super(message);
        this.name = 'BattleInputError';
        this.status = status;
        this.details = details;
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

function levelUpMoves(speciesName, level) {
    const learned = new Map();
    let species = Dex.species.get(speciesName);
    while (species?.exists) {
        const learnset = Dex.mod('gen9').data.Learnsets?.[speciesId(species.name)]?.learnset || {};
        for (const [move, sources] of Object.entries(learnset)) {
            for (const source of sources) {
                const match = source.match(/^9L(\d+)$/);
                if (!match) continue;
                const learnedAt = Number(match[1]) || 1;
                if (learnedAt <= level && (!learned.has(move) || learned.get(move) < learnedAt)) {
                    learned.set(move, learnedAt);
                }
            }
        }
        species = species.prevo ? Dex.species.get(species.prevo) : null;
    }
    const moves = [...learned.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(-4)
        .map(([move]) => move);
    return moves.length ? moves : ['tackle'];
}

function canonicalWildTeam(opponents) {
    return opponents.map(opponent => {
        const level = Math.max(1, Math.min(100, Number(opponent.level) || 1));
        return {
            species: opponent.species,
            level,
            shiny: Boolean(opponent.shiny),
            nature: 'Serious',
            ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
            evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
            moves: levelUpMoves(opponent.species, level),
        };
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

function publicVolatiles(pokemon) {
    return Object.fromEntries(Object.entries(pokemon.volatiles || {}).map(([id, value]) => {
        const move = value?.move?.id || value?.move?.name || value?.move;
        return [id, move ? { move } : {}];
    }));
}

function snapshotPokemon(pokemon, side, { revealPrivate = false, requestMoves = null } = {}) {
    const slotIndex = side.pokemon.indexOf(pokemon);
    const snapshot = {
        slot: pokemon.clientSlot ?? (slotIndex >= 0 ? slotIndex + 1 : null),
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

    const requestById = new Map((requestMoves || []).map(move => [move.id, move]));
    snapshot.item = pokemon.item || '';
    snapshot.ability = pokemon.ability || '';
    snapshot.baseAbility = pokemon.baseAbility || '';
    snapshot.pokeball = pokemon.pokeball || 'pokeball';
    snapshot.storedStats = { ...(pokemon.storedStats || {}) };
    snapshot.baseStats = { ...(pokemon.baseStoredStats || pokemon.storedStats || {}) };
    snapshot.evs = { ...(pokemon.set?.evs || {}) };
    snapshot.ivs = { ...(pokemon.set?.ivs || {}) };
    snapshot.nature = pokemon.set?.nature || '';
    snapshot.moveSlots = (pokemon.moveSlots || []).map((move, index) => {
        const requested = requestById.get(move.id) || requestMoves?.[index];
        return {
            move: requested?.move || move.move,
            id: requested?.id || move.id,
            pp: requested?.pp ?? move.pp,
            maxpp: requested?.maxpp ?? move.maxpp,
            target: requested?.target || move.target,
            disabled: Boolean(requested?.disabled ?? move.disabled),
        };
    });
    return snapshot;
}

function snapshotSide(side, request, revealPrivate) {
    const activePokemon = side.active[0] || null;
    const activeRequestMoves = revealPrivate ? request?.active?.[0]?.moves || null : null;
    const party = [...side.pokemon]
        .sort((a, b) => (a.clientSlot || 0) - (b.clientSlot || 0))
        .map(pokemon => snapshotPokemon(pokemon, side, {
            revealPrivate,
            requestMoves: pokemon === activePokemon ? activeRequestMoves : null,
        }));
    return {
        name: side.name,
        activeSlot: activePokemon?.clientSlot || null,
        party,
    };
}

function currentState(record) {
    const { battle } = record;
    const request = battle.p1.activeRequest;
    const ended = Boolean(record.endedReason || battle.ended);
    const phase = ended
        ? 'ended'
        : request?.forceSwitch
            ? 'switch'
            : (!request || request.wait)
                ? 'waiting'
                : 'move';
    const p1 = snapshotSide(battle.p1, request, true);
    const p2 = snapshotSide(battle.p2, battle.p2.activeRequest, false);
    const p1Active = p1.party.find(pokemon => pokemon.slot === p1.activeSlot) || null;
    const p2Active = p2.party.find(pokemon => pokemon.slot === p2.activeSlot) || null;
    const outcome = record.endedReason || (
        battle.ended
            ? (battle.winner === battle.p1.name ? 'win' : battle.winner ? 'loss' : 'tie')
            : null
    );

    return {
        schemaVersion: 2,
        revision: record.revision,
        turn: battle.turn,
        phase,
        canAct: phase === 'move' || phase === 'switch',
        request: {
            forceSwitch: Boolean(request?.forceSwitch),
            wait: Boolean(request?.wait),
            trapped: Boolean(request?.active?.[0]?.trapped),
        },
        p1,
        p2,
        // Compatibility aliases for clients deployed before schema v2.
        p1Active,
        p2Active,
        ended,
        winner: battle.winner,
        outcome,
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

function randomChoice(request, random = Math.random) {
    if (request?.forceSwitch) {
        const candidates = request.side.pokemon
            .map((pokemon, index) => ({ pokemon, index: index + 1 }))
            .filter(({ pokemon }) => !pokemon.active && !conditionIsFainted(pokemon.condition));
        if (!candidates.length) return null;
        return `switch ${candidates[Math.floor(random() * candidates.length)].index}`;
    }
    if (request?.active) {
        const candidates = request.active[0].moves
            .map((move, index) => ({ move, index: index + 1 }))
            .filter(({ move }) => !move.disabled && move.pp !== 0);
        if (!candidates.length) return 'move 1';
        return `move ${candidates[Math.floor(random() * candidates.length)].index}`;
    }
    return null;
}

function addTemporarySplashChoice(battle) {
    const pokemon = battle.p1.active[0];
    const requestMoves = battle.p1.activeRequest?.active?.[0]?.moves;
    if (!pokemon || !requestMoves) {
        throw new BattleInputError('A turn cannot be consumed in the current phase.');
    }

    const existingIndex = pokemon.moveSlots.findIndex(move => move.id === 'splash');
    if (existingIndex >= 0) {
        const originalPp = pokemon.moveSlots[existingIndex].pp;
        return {
            choice: `move ${existingIndex + 1}`,
            cleanup: () => {
                pokemon.moveSlots[existingIndex].pp = originalPp;
                const requested = battle.p1.activeRequest?.active?.[0]?.moves
                    ?.find(move => move.id === 'splash');
                if (requested) requested.pp = originalPp;
            },
        };
    }

    const splash = {
        move: 'Splash',
        id: 'splash',
        pp: 40,
        maxpp: 40,
        target: 'self',
        disabled: false,
        disabledSource: '',
        used: false,
    };
    pokemon.moveSlots.push({ ...splash });
    pokemon.baseMoveSlots.push({ ...splash });
    requestMoves.push({ ...splash });
    const choice = `move ${pokemon.moveSlots.length}`;

    return {
        choice,
        cleanup: () => {
            const removeSplash = moves => {
                const index = moves?.findIndex(move => move.id === 'splash');
                if (index >= 0) moves.splice(index, 1);
            };
            removeSplash(pokemon.moveSlots);
            removeSplash(pokemon.baseMoveSlots);
            removeSplash(battle.p1.activeRequest?.active?.[0]?.moves);
        },
    };
}

export class BattleManager {
    constructor({
        foulPlayClient,
        trainerTicketSecret = process.env.TRAINER_TICKET_SECRET || '',
        trainerAiEnabled = process.env.TRAINER_AI_ENABLED === '1',
        searchBudgetMs = Number(process.env.FOUL_PLAY_SEARCH_BUDGET_MS || 2000),
        abortAfterMs = Number(process.env.TRAINER_AI_ABORT_AFTER_MS || 120000),
        now = () => Date.now(),
        random = Math.random,
    } = {}) {
        this.foulPlayClient = foulPlayClient;
        this.trainerTicketSecret = trainerTicketSecret;
        this.trainerAiEnabled = trainerAiEnabled;
        this.searchBudgetMs = Math.max(100, Math.min(searchBudgetMs, 2000));
        this.abortAfterMs = abortAfterMs;
        this.now = now;
        this.random = random;
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
        const p1Team = ticketPayload?.kind === 'battle'
            ? sanitizeTeam(ticketPayload.players || [])
            : sanitizeTeam(payload.p1.team);
        battle.setPlayer('p1', {
            name: ticketPayload?.sub || payload.p1.name || 'Player',
            team: p1Team,
        });
        const p2Team = ticketPayload?.kind === 'battle' && encounterType === 'wild'
            ? canonicalWildTeam(ticketPayload.opponents || [])
            : sanitizeTeam(payload.p2.team);
        battle.setPlayer('p2', {
            name: payload.p2.name || (encounterType === 'trainer' ? 'Trainer' : 'Wild Pokemon'),
            team: p2Team,
        });
        battle.p1.pokemon.forEach((pokemon, index) => { pokemon.clientSlot = index + 1; });
        battle.p2.pokemon.forEach((pokemon, index) => { pokemon.clientSlot = index + 1; });
        applyP1State(battle, ticketPayload?.kind === 'battle' ? ticketPayload.playerState : payload.p1State);

        const battleId = crypto.randomUUID();
        const createdAt = this.now();
        const record = {
            battleId,
            battle,
            encounterType,
            subject: ticketPayload?.sub || '',
            localBattleId: ticketPayload?.localBattleId || '',
            testMode: Boolean(ticketPayload?.testMode),
            initialP2Request: clone(battle.p2.activeRequest),
            p2ProtocolHistory: '',
            createdAt,
            lastAccess: createdAt,
            started: false,
            startResponse: null,
            aiUnavailableSince: null,
            revision: 0,
            endedReason: null,
            escapeAttempts: 0,
            participatedSlots: new Set([1]),
            actionResponses: new Map(),
            actionPromises: new Map(),
            actionFingerprints: new Map(),
            resolvingActionId: null,
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
        if (payload.battleTicket) {
            try {
                ticketPayload = verifyBattleTicket(payload.battleTicket, this.trainerTicketSecret);
            } catch (error) {
                throw new BattleInputError(error.message, 401);
            }
            if (ticketPayload.encounterType !== encounterType) {
                throw new BattleInputError('Battle ticket encounter type does not match.', 401);
            }
            const expectedOpponents = ticketPayload.opponents || [];
            const suppliedOpponents = payload.p2.team || [];
            if (expectedOpponents.length !== suppliedOpponents.length || expectedOpponents.some((expected, index) => (
                speciesId(expected.species) !== speciesId(suppliedOpponents[index]?.species) ||
                Number(expected.level) !== Number(suppliedOpponents[index]?.level)
            ))) {
                throw new BattleInputError('Opponent team does not match the signed battle ticket.', 401);
            }
        } else if (encounterType === 'trainer') {
            if (!this.trainerAiEnabled) {
                throw new BattleInputError('Trainer AI is not enabled.', 503);
            }
            try {
                ticketPayload = verifyTrainerTicket(payload.trainerTicket, this.trainerTicketSecret);
            } catch (error) {
                throw new BattleInputError(error.message, 401);
            }
        }
        if (encounterType === 'trainer' && !this.trainerAiEnabled) {
            throw new BattleInputError('Trainer AI is not enabled.', 503);
        }
        if (this.trainerTicketSecret && !ticketPayload) {
            throw new BattleInputError('A signed battle ticket is required.', 401);
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
        record.revision = 1;
        record.lastAccess = this.now();
        record.startResponse = this._withReceipt(record, {
            success: true,
            battleId: record.battleId,
            log,
            state: currentState(record),
            trainer: record.encounterType === 'trainer',
            testMode: record.testMode,
        });
        return record.startResponse;
    }

    _withReceipt(record, response) {
        if (!record.subject || !record.localBattleId || !this.trainerTicketSecret) return response;
        record.publicState = response.state || currentState(record);
        return {
            ...response,
            receipt: createBattleReceipt(record, this.trainerTicketSecret, Math.floor(this.now() / 1000)),
        };
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
        const fingerprint = String(payload.action || '');
        const previousFingerprint = record.actionFingerprints.get(actionId);
        if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
            throw new BattleInputError('actionId was reused with a different action.', 409, {
                state: currentState(record),
            });
        }
        if (previousFingerprint === undefined) record.actionFingerprints.set(actionId, fingerprint);
        if (record.actionResponses.has(actionId)) return record.actionResponses.get(actionId);
        if (record.actionPromises.has(actionId)) return record.actionPromises.get(actionId);
        if (record.endedReason || record.battle.ended) {
            throw new BattleInputError('Battle has already ended.', 409, { state: currentState(record) });
        }
        if (
            payload.expectedRevision !== undefined &&
            Number(payload.expectedRevision) !== record.revision
        ) {
            throw new BattleInputError('Battle state is stale.', 409, { state: currentState(record) });
        }
        if (record.pendingAction && record.pendingAction.actionId !== actionId) {
            throw new BattleInputError('A previous trainer action is still being resolved.', 409, {
                state: currentState(record),
            });
        }
        if (record.resolvingActionId && record.resolvingActionId !== actionId) {
            throw new BattleInputError('A previous trainer action is still being resolved.', 409, {
                state: currentState(record),
            });
        }

        record.resolvingActionId = actionId;
        const promise = this._executeAction(record, actionId, payload.action);
        record.actionPromises.set(actionId, promise);
        try {
            return await promise;
        } finally {
            record.actionPromises.delete(actionId);
            if (record.resolvingActionId === actionId) record.resolvingActionId = null;
        }
    }

    async state(payload) {
        const record = this.records.get(payload?.battleId);
        if (!record || !record.started) {
            throw new BattleInputError('Battle not found or expired.', 404);
        }
        record.lastAccess = this.now();
        return this._withReceipt(record, {
            success: true,
            battleId: record.battleId,
            state: currentState(record),
            trainer: record.encounterType === 'trainer',
            testMode: record.testMode,
        });
    }

    _runEscapes(record) {
        const p1 = record.battle.p1.active[0];
        const p2 = record.battle.p2.active[0];
        if (!p1 || !p2) throw new BattleInputError('Run is unavailable in the current phase.');

        const playerSpeed = p1.speed;
        const opponentSpeed = p2.speed % 256 || 1;
        record.escapeAttempts++;
        const threshold = playerSpeed >= opponentSpeed
            ? 256
            : Math.floor((playerSpeed * 128) / opponentSpeed) + (30 * record.escapeAttempts);
        return Math.floor(this.random() * 256) < threshold;
    }

    _escapedResponse(record, actionId) {
        record.endedReason = 'escaped';
        record.revision++;
        const response = this._withReceipt(record, {
            success: true,
            escaped: true,
            log: '|covenant|escaped',
            state: currentState(record),
            trainer: false,
            testMode: record.testMode,
        });
        record.actionResponses.set(actionId, response);
        return response;
    }

    async _executeAction(record, actionId, playerAction) {
        if (!record.pendingAction) {
            const p1Request = clone(record.battle.p1.activeRequest);
            const normalizedPlayerAction = normalizePlayerAction(playerAction, record.battle.p1);
            const specialAction = ['capture', 'run'].includes(normalizedPlayerAction)
                ? normalizedPlayerAction
                : null;
            if (specialAction) {
                if (record.encounterType !== 'wild') {
                    throw new BattleInputError('That action is only available in wild battles.');
                }
                if (!p1Request?.active || p1Request.forceSwitch || p1Request.wait) {
                    throw new BattleInputError('That action is unavailable in the current phase.');
                }
                if (specialAction === 'run' && this._runEscapes(record)) {
                    return this._escapedResponse(record, actionId);
                }
            } else {
                assertLegalChoice(normalizedPlayerAction, p1Request);
            }

            let p2Choice = null;
            const p2Request = record.battle.p2.activeRequest;
            if (p2Request && !p2Request.wait) {
                p2Choice = record.encounterType === 'trainer'
                    ? await this._trainerChoice(record)
                    : randomChoice(p2Request, this.random);
            }
            record.pendingAction = {
                actionId,
                playerAction: normalizedPlayerAction,
                specialAction,
                specialLog: specialAction === 'capture'
                    ? '|covenant|capturefailed'
                    : specialAction === 'run'
                        ? '|covenant|runfailed'
                        : '',
                p2Choice,
                applied: false,
            };
        }

        const pending = record.pendingAction;
        if (!pending.applied) {
            const temporaryChoice = pending.specialAction
                ? addTemporarySplashChoice(record.battle)
                : null;
            const p1Choice = temporaryChoice?.choice || pending.playerAction;
            try {
                if (!record.battle.choose('p1', p1Choice)) {
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
            } finally {
                temporaryChoice?.cleanup();
            }
            pending.applied = true;
        }

        await this._resolveP2ForcedSwitch(record);
        const activePlayer = record.battle.p1.active[0];
        if (activePlayer?.clientSlot) record.participatedSlots.add(activePlayer.clientSlot);
        const battleLog = this._drainLogs(record);
        const log = [pending.specialLog, battleLog].filter(Boolean).join('\n');
        record.revision++;
        const response = this._withReceipt(record, {
            success: true,
            ...(pending.specialAction === 'run' ? { escaped: false } : {}),
            log,
            state: currentState(record),
            trainer: record.encounterType === 'trainer',
            testMode: record.testMode,
        });
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
                : randomChoice(record.battle.p2.activeRequest, this.random);
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
