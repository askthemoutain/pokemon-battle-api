import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';

import { BattleInputError, TrainerUnavailableError } from './battle-manager.js';
import { PvpInputError } from './pvp-battle-manager.js';

const CANONICAL_GAME_ORIGIN = 'https://pokemoncovenant.altervista.org';
const WWW_GAME_ORIGIN = 'https://www.pokemoncovenant.altervista.org';

class CorsOriginError extends Error {}


export function createApp(manager, pvpManager = null) {
    const app = express();
    const allowedOrigins = new Set((
        process.env.ALLOWED_ORIGINS || CANONICAL_GAME_ORIGIN
    ).split(',').map(origin => origin.trim()).filter(Boolean));
    // AlterVista serves the same game on both hostnames. Grant the exact www
    // sibling only when the production canonical origin is already allowlisted;
    // unrelated/custom allowlists remain unchanged and fail closed.
    if (allowedOrigins.has(CANONICAL_GAME_ORIGIN)) {
        allowedOrigins.add(WWW_GAME_ORIGIN);
    }

    app.use(cors({
        origin(origin, callback) {
            if (!origin || allowedOrigins.has(origin)) return callback(null, true);
            return callback(new CorsOriginError('Origin not allowed'));
        },
    }));
    app.use((error, req, res, next) => {
        if (error instanceof CorsOriginError) {
            return res.status(403).json({ success: false, error: 'Origin not allowed.' });
        }
        return next(error);
    });
    app.use(express.json({ limit: '1mb' }));

    const requireSignature = process.env.REQUIRE_BATTLE_API_SIGNATURE === '1';
    const sharedSecret = process.env.BATTLE_API_SHARED_SECRET || '';
    const verifySignature = (req, res, next) => {
        if (!requireSignature) return next();
        if (!sharedSecret) {
            return res.status(500).json({ success: false, error: 'Signature secret not configured.' });
        }

        const sent = req.get('x-battle-signature') || '';
        const payload = JSON.stringify(req.body || {});
        const expected = crypto.createHmac('sha256', sharedSecret).update(payload).digest('hex');
        const sentBuffer = Buffer.from(sent, 'hex');
        const expectedBuffer = Buffer.from(expected, 'hex');
        if (
            sentBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(sentBuffer, expectedBuffer)
        ) {
            return res.status(401).json({ success: false, error: 'Invalid signature.' });
        }
        return next();
    };

    const handle = handler => async (req, res) => {
        try {
            const result = await handler(req.body);
            res.json(result);
        } catch (error) {
            if (error instanceof TrainerUnavailableError) {
                res.status(error.status).json(error.details);
                return;
            }
            if (error instanceof BattleInputError) {
                res.status(error.status).json({
                    success: false,
                    error: error.message,
                    ...(error.details || {}),
                });
                return;
            }
            if (error instanceof PvpInputError) {
                res.status(error.status).json({
                    success: false,
                    error: error.message,
                    ...(error.details || {}),
                });
                return;
            }
            console.error('[Battle API] Unexpected error:', error);
            res.status(500).json({ success: false, error: 'Internal battle service error.' });
        }
    };

    app.post('/api/battle/start', verifySignature, handle(body => manager.start(body)));
    app.post('/api/battle/action', verifySignature, handle(body => manager.action(body)));
    app.post('/api/battle/state', verifySignature, handle(body => manager.state(body)));
    if (pvpManager) {
        app.post('/api/pvp/start', verifySignature, handle(body => pvpManager.start(body)));
        app.post('/api/pvp/action', verifySignature, handle(body => pvpManager.action(body)));
        app.post('/api/pvp/state', verifySignature, handle(body => pvpManager.state(body)));
        app.post('/api/pvp/spectate', verifySignature, handle(body => pvpManager.spectate(body)));
        app.post('/api/pvp/forfeit', verifySignature, handle(body => pvpManager.forfeit(body)));
        app.post('/api/pvp/timeout', verifySignature, handle(body => pvpManager.claimTimeout(body)));
        app.post('/api/pvp/recover', verifySignature, handle(body => pvpManager.recover(body)));
    }
    app.get('/api/health', (req, res) => res.json({
        ok: true,
        revision: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '',
        trainerAiEnabled: manager.trainerAiEnabled,
        foulPlayConfigured: Boolean(manager.foulPlayClient?.configured),
        activeBattles: manager.records.size,
        activePvpBattles: pvpManager ? pvpManager.getActiveBattleCount() : 0,
    }));
    app.get('/', (req, res) => res.status(200).send('Pokemon Battle API is running.'));
    return app;
}
