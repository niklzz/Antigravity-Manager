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
