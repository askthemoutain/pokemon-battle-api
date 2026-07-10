import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';

import { BattleInputError, TrainerUnavailableError } from './battle-manager.js';


export function createApp(manager) {
    const app = express();
    const allowedOrigins = (
        process.env.ALLOWED_ORIGINS || 'https://pokemoncovenant.altervista.org,http://gdrcd.test'
    ).split(',').map(origin => origin.trim()).filter(Boolean);

    app.use(cors({
        origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error('Origin not allowed'));
        },
    }));
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
                res.status(error.status).json({ success: false, error: error.message });
                return;
            }
            console.error('[Battle API] Unexpected error:', error);
            res.status(500).json({ success: false, error: 'Internal battle service error.' });
        }
    };

    app.post('/api/battle/start', verifySignature, handle(body => manager.start(body)));
    app.post('/api/battle/action', verifySignature, handle(body => manager.action(body)));
    app.get('/api/health', (req, res) => res.json({
        ok: true,
        trainerAiEnabled: manager.trainerAiEnabled,
        foulPlayConfigured: Boolean(manager.foulPlayClient?.configured),
        activeBattles: manager.records.size,
    }));
    app.get('/', (req, res) => res.status(200).send('Pokemon Battle API is running.'));
    return app;
}
