const {
    _getFetch, buildHeaders, parseLookback, flattenStreams,
    fetchWithTimeout, assertOk, assertSuccess, resolveOptions
} = require('./helpers');

module.exports = function (RED) {
    function LokiQueryNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);

        node.defaults = {
            query:      config.query      || '',
            limit:      parseInt(config.limit, 10) || 100,
            direction:  config.direction  || 'backward',
            output:     config.output     || 'lines',
            timeMode:   config.timeMode   || 'lookback',
            lookback:   config.lookback   || '1h',
            rangeStart: config.rangeStart || '',
            rangeEnd:   config.rangeEnd   || '',
        };

        if (!node.server) {
            node.status({ fill: 'red', shape: 'dot', text: 'no server configured' });
            return;
        }

        node.on('input', async function (msg, send, done) {
            const opts = resolveOptions(node.defaults, msg);

            if (!opts.query) {
                node.status({ fill: 'red', shape: 'dot', text: 'no query specified' });
                done(new Error('No LogQL query specified. Set query in node config or msg.lokiOptions.query'));
                return;
            }

            // ── Resolve time range ──────────────────────────────────────────
            let startNs, endNs;
            try {
                if (opts.start !== undefined && opts.end !== undefined) {
                    // Accept BigInt, number, or string — normalise to string
                    startNs = opts.start.toString();
                    endNs   = opts.end.toString();
                } else if (opts.timeMode === 'range' && opts.rangeStart && opts.rangeEnd) {
                    const s = new Date(opts.rangeStart).getTime();
                    const e = new Date(opts.rangeEnd).getTime();
                    if (isNaN(s) || isNaN(e)) throw new Error('Invalid start/end date in node config');
                    if (s >= e) throw new Error('Range start must be before range end');
                    startNs = (BigInt(s) * 1_000_000n).toString();
                    endNs   = (BigInt(e) * 1_000_000n).toString();
                } else {
                    const ms  = parseLookback(opts.lookback || '1h');
                    const now = Date.now();
                    startNs = (BigInt(now - ms) * 1_000_000n).toString();
                    endNs   = (BigInt(now)       * 1_000_000n).toString();
                }
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: 'time range error' });
                done(new Error(`loki-query time range error: ${err.message}`));
                return;
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'querying…' });

            const params = new URLSearchParams({
                query:     opts.query,
                limit:     opts.limit.toString(),
                start:     startNs,
                end:       endNs,
                direction: opts.direction,
            });

            try {
                const fetch    = await _getFetch();
                const headers  = buildHeaders(node.server.credentials);
                const base     = node.server.url.replace(/\/$/, '');
                const endpoint = `${base}/loki/api/v1/query_range?${params}`;

                const response = await fetchWithTimeout(fetch, endpoint, { headers });
                await assertOk(response);
                const json = await response.json();
                assertSuccess(json);

                const results = json.data.result;
                const entries = flattenStreams(results);

                msg.lokiResultType = json.data.resultType;
                msg.lokiRaw        = json;
                msg.count          = entries.length;

                if (opts.output === 'raw') {
                    msg.payload = json;
                    send(msg);
                } else if (opts.output === 'streams') {
                    msg.payload = results;
                    send(msg);
                } else if (opts.output === 'each') {
                    for (const entry of entries) {
                        send({
                            ...msg,
                            payload:       entry.line,
                            lokiTimestamp: entry.timestamp,
                            lokiLabels:    entry.labels,
                            lokiEntry:     entry,
                        });
                    }
                } else {
                    // 'lines' — flat array (default)
                    msg.payload = entries;
                    send(msg);
                }

                node.status({ fill: 'green', shape: 'dot', text: `${entries.length} lines` });
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.message });
                done(err);
            }
        });

        node.on('close', () => node.status({}));
    }

    RED.nodes.registerType('loki-query', LokiQueryNode);
};
