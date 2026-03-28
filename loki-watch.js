const {
    _getFetch, buildHeaders, flattenStreams,
    fetchWithTimeout, assertOk, assertSuccess, resolveOptions
} = require('./helpers');

module.exports = function (RED) {
    function LokiWatchNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);

        node.defaults = {
            query:    config.query    || '',
            interval: Math.max(parseInt(config.interval, 10) || 5, 1),
            output:   config.output   || 'each',
        };

        let timer           = null;
        let lastTimestampNs = null;
        let running         = false;
        let currentOpts     = Object.assign({}, node.defaults);

        if (!node.server) {
            node.status({ fill: 'red', shape: 'dot', text: 'no server configured' });
            return;
        }

        function start() {
            lastTimestampNs = (BigInt(Date.now()) * 1_000_000n).toString();
            node.status({ fill: 'green', shape: 'ring', text: 'watching…' });
            schedule();
        }

        function schedule() {
            timer = setTimeout(poll, currentOpts.interval * 1000);
        }

        async function poll() {
            if (running) { schedule(); return; }
            running = true;

            if (!currentOpts.query) {
                node.status({ fill: 'red', shape: 'dot', text: 'no query configured' });
                running = false;
                schedule();
                return;
            }

            try {
                const fetch   = await _getFetch();
                const headers = buildHeaders(node.server.credentials);
                const base    = node.server.url.replace(/\/$/, '');

                const startNs = (BigInt(lastTimestampNs) + 1n).toString();
                const endNs   = (BigInt(Date.now()) * 1_000_000n).toString();

                const params = new URLSearchParams({
                    query:     currentOpts.query,
                    limit:     '1000',
                    start:     startNs,
                    end:       endNs,
                    direction: 'forward',
                });

                const response = await fetchWithTimeout(
                    fetch, `${base}/loki/api/v1/query_range?${params}`, { headers }
                );
                await assertOk(response);
                const json = await response.json();
                assertSuccess(json);

                const entries = flattenStreams(json.data.result || []);

                if (entries.length > 0) {
                    lastTimestampNs = entries[entries.length - 1].timestamp;

                    if (currentOpts.output === 'each') {
                        for (const entry of entries) {
                            node.send({
                                payload:       entry.line,
                                lokiTimestamp: entry.timestamp,
                                lokiLabels:    entry.labels,
                                lokiEntry:     entry,
                            });
                        }
                    } else {
                        node.send({ payload: entries, lokiRaw: json, count: entries.length });
                    }

                    node.status({
                        fill: 'green', shape: 'dot',
                        text: `${entries.length} new @ ${new Date().toLocaleTimeString()}`,
                    });
                } else {
                    node.status({
                        fill: 'green', shape: 'ring',
                        text: `watching… (${new Date().toLocaleTimeString()})`,
                    });
                }
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.message });
                node.error(`loki-watch poll error: ${err.message}`);
            }

            running = false;
            schedule();
        }

        node.on('input', function (msg) {
            if (msg.payload === 'stop')  { stop(); return; }
            if (msg.payload === 'start') { stop(); start(); return; }
            if (msg.payload === 'reset') {
                lastTimestampNs = (BigInt(Date.now()) * 1_000_000n).toString();
                node.status({ fill: 'green', shape: 'ring', text: 'watermark reset' });
                return;
            }

            if (msg.lokiOptions) {
                currentOpts = resolveOptions(node.defaults, msg);
                node.status({ fill: 'green', shape: 'ring', text: 'options updated' });
            }
        });

        function stop() {
            if (timer) { clearTimeout(timer); timer = null; }
            running = false;
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
        }

        node.on('close', function (done) { stop(); done(); });

        start();
    }

    RED.nodes.registerType('loki-watch', LokiWatchNode);
};
