/**
 * Shared helpers for node-red-contrib-loki nodes.
 */

/**
 * Returns a fetch implementation.
 * Uses native fetch on Node 18+, falls back to node-fetch if available.
 */
async function _getFetch() {
    if (typeof globalThis.fetch === 'function') return globalThis.fetch;
    try {
        const nf = await import('node-fetch');
        return nf.default || nf;
    } catch (_) {
        throw new Error('fetch unavailable — upgrade to Node.js 18+ or install node-fetch');
    }
}

/**
 * Build HTTP headers, adding Basic Auth if credentials are configured.
 */
function buildHeaders(credentials) {
    const headers = { 'Content-Type': 'application/json' };
    if (credentials && credentials.username) {
        const b64 = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
        headers['Authorization'] = `Basic ${b64}`;
    }
    return headers;
}

/**
 * Parse a duration string (e.g. "15m", "1h", "7d") into milliseconds.
 * Defaults to 1 hour if the string is invalid.
 */
function parseLookback(str) {
    const match = String(str).match(/^(\d+)(m|h|d|w)$/i);
    if (!match) return 3_600_000;
    const n = parseInt(match[1], 10);
    return n * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2].toLowerCase()];
}

/**
 * Flatten Loki stream results into a sorted array of {timestamp, line, labels}.
 */
function flattenStreams(results) {
    const entries = [];
    for (const stream of results) {
        const labels = stream.stream || {};
        for (const [ts, line] of (stream.values || [])) {
            entries.push({ timestamp: ts, line, labels });
        }
    }
    entries.sort((a, b) => (BigInt(a.timestamp) < BigInt(b.timestamp) ? -1 : 1));
    return entries;
}

/**
 * Fetch with a timeout. Rejects with a friendly error if the request hangs.
 */
async function fetchWithTimeout(fetchFn, url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchFn(url, { ...options, signal: controller.signal });
        return response;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s — is Loki reachable?`);
        }
        if (err.code === 'ECONNREFUSED') {
            throw new Error(`Connection refused — is Loki running at the configured URL?`);
        }
        if (err.code === 'ENOTFOUND') {
            throw new Error(`Host not found — check the Loki URL in the server config`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Assert an HTTP response is OK, throwing a friendly error if not.
 */
async function assertOk(res) {
    if (!res.ok) {
        const body = await res.text().catch(() => '(no response body)');
        throw new Error(`HTTP ${res.status} from Loki: ${body}`);
    }
}

/**
 * Assert a Loki JSON response has status "success".
 */
function assertSuccess(json) {
    if (json.status !== 'success') {
        throw new Error(`Loki error: ${json.error || JSON.stringify(json)}`);
    }
}

/**
 * Resolve mustache-style {{property}} templates in a string against a message.
 * Supports dot notation: {{payload.app}}, {{topic}}, {{labels.env}} etc.
 * Unresolved tokens are left as empty string.
 */
function resolveMustache(template, msg) {
    if (!template || typeof template !== 'string') return template;
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
        const parts = path.trim().split('.');
        let val = msg;
        for (const part of parts) {
            if (val == null) return '';
            val = val[part];
        }
        return val != null ? String(val) : '';
    });
}

/**
 * Merge msg.lokiOptions (if present) over node config defaults.
 * Returns a plain object with resolved values.
 * Field names in lokiOptions match node config names exactly.
 */
function resolveOptions(nodeDefaults, msg) {
    const opts = Object.assign({}, nodeDefaults);
    const overrides = (msg && msg.lokiOptions) ? msg.lokiOptions : {};
    for (const key of Object.keys(overrides)) {
        if (overrides[key] !== undefined && overrides[key] !== null) {
            opts[key] = overrides[key];
        }
    }
    // Resolve mustache in string fields
    const stringFields = ['query', 'lookback', 'labelName'];
    for (const field of stringFields) {
        if (opts[field]) opts[field] = resolveMustache(opts[field], msg);
    }
    return opts;
}

module.exports = {
    _getFetch,
    buildHeaders,
    parseLookback,
    flattenStreams,
    fetchWithTimeout,
    assertOk,
    assertSuccess,
    resolveMustache,
    resolveOptions,
};
