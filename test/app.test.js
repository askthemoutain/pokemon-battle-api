import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createApp } from '../app.js';

const CANONICAL_ORIGIN = 'https://pokemoncovenant.altervista.org';
const WWW_ORIGIN = 'https://www.pokemoncovenant.altervista.org';

function preflight(server, origin) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const request = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/pvp/start',
            method: 'OPTIONS',
            headers: {
                Origin: origin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
                Connection: 'close',
            },
        }, response => {
            response.resume();
            response.once('end', () => resolve({
                status: response.statusCode,
                allowOrigin: response.headers['access-control-allow-origin'],
                allowHeaders: response.headers['access-control-allow-headers'],
            }));
        });
        request.once('error', reject);
        request.end();
    });
}

function postJson(server, path, body) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const payload = JSON.stringify(body);
        const request = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Connection: 'close',
            },
        }, response => {
            let responseBody = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { responseBody += chunk; });
            response.once('end', () => resolve({
                status: response.statusCode,
                body: JSON.parse(responseBody),
            }));
        });
        request.once('error', reject);
        request.end(payload);
    });
}

function getJson(server, path) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const request = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method: 'GET',
            headers: { Connection: 'close' },
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.once('end', () => resolve({
                status: response.statusCode,
                body: JSON.parse(body),
            }));
        });
        request.once('error', reject);
        request.end();
    });
}

test('CORS allows the exact AlterVista www sibling and rejects lookalike origins', async t => {
    const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = `${CANONICAL_ORIGIN},http://gdrcd.test`;

    const manager = {
        trainerAiEnabled: false,
        foulPlayClient: { configured: false },
        records: new Map(),
    };
    const pvpManager = {
        start: async () => ({ success: false, code: 'TICKET_REQUIRED' }),
        getActiveBattleCount: () => 0,
    };
    const server = createApp(manager, pvpManager).listen(0, '127.0.0.1');
    if (previousAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousAllowedOrigins;

    await new Promise((resolve, reject) => {
        if (server.listening) return resolve();
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const canonical = await preflight(server, CANONICAL_ORIGIN);
    assert.equal(canonical.status, 204);
    assert.equal(canonical.allowOrigin, CANONICAL_ORIGIN);
    assert.match(String(canonical.allowHeaders || ''), /content-type/i);

    const www = await preflight(server, WWW_ORIGIN);
    assert.equal(www.status, 204);
    assert.equal(www.allowOrigin, WWW_ORIGIN);
    assert.match(String(www.allowHeaders || ''), /content-type/i);

    const lookalike = await preflight(
        server,
        'https://www.pokemoncovenant.altervista.org.attacker.example',
    );
    assert.equal(lookalike.status, 403);
    assert.equal(lookalike.allowOrigin, undefined);

    for (const rejectedOrigin of ['null', 'http://pokemoncovenant.altervista.org']) {
        const rejected = await preflight(server, rejectedOrigin);
        assert.equal(rejected.status, 403);
        assert.equal(rejected.allowOrigin, undefined);
    }

    const serverToServer = await postJson(server, '/api/pvp/start', {});
    assert.equal(serverToServer.status, 200);
    assert.equal(serverToServer.body.code, 'TICKET_REQUIRED');
});

test('health reports only non-terminal PvP battles', async t => {
    const manager = {
        trainerAiEnabled: false,
        foulPlayClient: { configured: false },
        records: new Map(),
    };
    const pvpManager = {
        records: new Map([['active', {}], ['terminal', {}]]),
        getActiveBattleCount: () => 1,
    };
    const server = createApp(manager, pvpManager).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        if (server.listening) return resolve();
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const response = await getJson(server, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.activePvpBattles, 1);
});

test('production default never enables the local development origin', async t => {
    const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOWED_ORIGINS;
    const manager = {
        trainerAiEnabled: false,
        foulPlayClient: { configured: false },
        records: new Map(),
    };
    const server = createApp(manager).listen(0, '127.0.0.1');
    if (previousAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
    await new Promise((resolve, reject) => {
        if (server.listening) return resolve();
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const localDevelopment = await preflight(server, 'http://gdrcd.test');
    assert.equal(localDevelopment.status, 403);
    assert.equal(localDevelopment.allowOrigin, undefined);
});
