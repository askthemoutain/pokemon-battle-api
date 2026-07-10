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

export function verifyTrainerTicket(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!secret) throw new Error('Trainer ticket secret is not configured.');
    if (typeof token !== 'string') throw new Error('Trainer ticket is missing.');

    const [encodedPayload, sentSignature, extra] = token.split('.');
    if (!encodedPayload || !sentSignature || extra !== undefined) {
        throw new Error('Trainer ticket is malformed.');
    }

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64url');
    const sent = Buffer.from(sentSignature);
    const expected = Buffer.from(expectedSignature);
    if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
        throw new Error('Trainer ticket signature is invalid.');
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        throw new Error('Trainer ticket payload is invalid.');
    }

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
