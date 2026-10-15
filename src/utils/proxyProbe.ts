export type ProbeProtocol = 'openai' | 'anthropic' | 'gemini';

interface ProbeProtocolSpec {
    path: (model: string) => string;
    template: (model: string) => unknown;
    headers: (apiKey: string) => Record<string, string>;
}

export const PROBE_PROTOCOLS: Record<ProbeProtocol, ProbeProtocolSpec> = {
    openai: {
        path: () => '/v1/chat/completions',
        template: (model) => ({ model, messages: [{ role: 'user', content: 'ping' }], stream: false }),
        headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    },
    anthropic: {
        path: () => '/v1/messages',
        template: (model) => ({ model, messages: [{ role: 'user', content: 'ping' }], stream: false }),
        headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
    },
    gemini: {
        path: (model) => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        template: () => ({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
        headers: (apiKey) => ({ 'x-goog-api-key': apiKey }),
    },
};

export interface ProbeResult {
    status: number;
    ttftMs: number | null;
    totalMs: number;
    account: string | null;
    mappedModel: string | null;
    body: string;
}

/** Thrown when the request body is not valid JSON; no request is sent. */
export class ProbeInputError extends Error {}

function post(baseUrl: string, apiKey: string, protocol: ProbeProtocol, model: string, body: unknown, signal?: AbortSignal) {
    const spec = PROBE_PROTOCOLS[protocol];
    return fetch(baseUrl.replace(/\/+$/, '') + spec.path(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...spec.headers(apiKey) },
        body: JSON.stringify(body),
        signal,
    });
}

export async function sendProbe(
    baseUrl: string, apiKey: string, protocol: ProbeProtocol, model: string, bodyText: string, signal?: AbortSignal,
): Promise<ProbeResult> {
    let body: unknown;
    try {
        body = JSON.parse(bodyText);
    } catch (e) {
        throw new ProbeInputError(e instanceof Error ? e.message : String(e));
    }
    const start = performance.now();
    const res = await post(baseUrl, apiKey, protocol, model, body, signal);
    let ttftMs: number | null = null;
    let text = '';
    if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttftMs === null) ttftMs = Math.round(performance.now() - start);
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    }
    return {
        status: res.status,
        ttftMs,
        totalMs: Math.round(performance.now() - start),
        account: res.headers.get('X-Account-Email'),
        mappedModel: res.headers.get('X-Mapped-Model'),
        body: text,
    };
}

export type PingState = 'ok' | 'fail' | 'limited' | 'skipped';

export interface PingResult {
    state: PingState;
    status: number;
    ms: number;
    message: string;
}

export async function pingModel(baseUrl: string, apiKey: string, model: string, signal?: AbortSignal): Promise<PingResult> {
    if (/-image/i.test(model)) return { state: 'skipped', status: 0, ms: 0, message: '' };
    const start = performance.now();
    let status = 0;
    let text = '';
    try {
        // No max_tokens: thinking models would otherwise spend the budget and return empty content.
        const res = await post(baseUrl, apiKey, 'openai', model, {
            model, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], stream: false,
        }, signal);
        status = res.status;
        text = await res.text();
    } catch (e) {
        if (signal?.aborted) throw e;
        return { state: 'fail', status: 0, ms: Math.round(performance.now() - start), message: e instanceof Error ? e.message : String(e) };
    }
    const ms = Math.round(performance.now() - start);
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    const content = json?.choices?.[0]?.message?.content;
    // Retired models still answer 200 with a "no longer available, switch to …" text, so only the
    // requested "pong" counts as a working model; any other reply is shown as the failure reason.
    if (status >= 200 && status < 300 && typeof content === 'string' && /\bpong\b/i.test(content)) {
        return { state: 'ok', status, ms, message: '' };
    }
    const upstream = json?.error?.message;
    const message = typeof upstream === 'string' && upstream ? upstream
        : typeof content === 'string' && content.trim() ? content.trim().slice(0, 300)
        : text.slice(0, 300);
    return { state: status === 429 ? 'limited' : 'fail', status, ms, message };
}
