import crypto from 'node:crypto';


export class FoulPlayError extends Error {
    constructor(message, { status = 503, retryable = true } = {}) {
        super(message);
        this.name = 'FoulPlayError';
        this.status = status;
        this.retryable = retryable;
    }
}

export class FoulPlayClient {
    constructor({
        url = process.env.FOUL_PLAY_URL || '',
        secret = process.env.FOUL_PLAY_SHARED_SECRET || '',
        timeoutMs = Number(process.env.FOUL_PLAY_TIMEOUT_MS || 7000),
        fetchImpl = globalThis.fetch,
    } = {}) {
        this.url = url.replace(/\/$/, '');
        this.secret = secret;
        this.timeoutMs = timeoutMs;
        this.fetch = fetchImpl;
    }

    get configured() {
        return Boolean(this.url && this.secret);
    }

    async decision(payload) {
        if (!this.configured) {
            throw new FoulPlayError('Foul Play is not configured.');
        }

        const body = JSON.stringify(payload);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = crypto
            .createHmac('sha256', this.secret)
            .update(`${timestamp}.${body}`)
            .digest('hex');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response;
        try {
            response = await this.fetch(`${this.url}/v1/decision`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-fp-timestamp': timestamp,
                    'x-fp-signature': signature,
                },
                body,
                signal: controller.signal,
            });
        } catch (error) {
            const message = error?.name === 'AbortError'
                ? 'Foul Play decision timed out.'
                : 'Foul Play could not be reached.';
            throw new FoulPlayError(message);
        } finally {
            clearTimeout(timer);
        }

        let result = null;
        try {
            result = await response.json();
        } catch {
            // The status is still useful when Render returns a non-JSON gateway page.
        }
        if (!response.ok || !result?.ok || typeof result.action !== 'string') {
            const detail = result?.detail;
            const retryable = typeof detail === 'object' ? detail.retryable !== false : response.status >= 500;
            throw new FoulPlayError('Foul Play rejected the decision request.', {
                status: response.status,
                retryable,
            });
        }
        return result;
    }

    async health() {
        if (!this.url) return false;
        try {
            const response = await this.fetch(`${this.url}/health`, { signal: AbortSignal.timeout(5000) });
            return response.ok;
        } catch {
            return false;
        }
    }
}
