const { buildHeaders, flattenStreams, resolveOptions } = require('./helpers');

module.exports = function (RED) {
    function LokiTailNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);

        node.defaults = {
            query:       config.query       || '',
            output:      config.output      || 'each',
            reconnectMs: Math.max(parseInt(config.reconnectMs, 10) || 5000, 1000),
        };

        let ws          = null;
        let reconnTimer = null;
        let closing     = false;
        let WebSocket   = null;
        let currentOpts = Object.assign({}, node.defaults);
        let lastMsg     = {};

        if (!node.server) {
            node.status({ fill: 'red', shape: 'dot', text: 'no server configured' });
            return;
        }

        try {
            WebSocket = require('ws');
        } catch (_) {
            node.status({ fill: 'red', shape: 'dot', text: 'ws package missing' });
            node.error(
                'loki-tail requires the "ws" npm package. ' +
                'Run: cd ~/.node-red && npm install ws   then restart Node-RED.'
            );
            return;
        }

        function buildWsUrl(query) {
            const base = node.server.url
                .replace(/\/$/, '')
                .replace(/^http/, 'ws');
            const params = new URLSearchParams({
                query,
                start: (BigInt(Date.now()) * 1_000_000n).toString(),
            });
            return `${base}/loki/api/v1/tail?${params}`;
        }

        function connect() {
            if (!currentOpts.query) {
                node.status({ fill: 'red', shape: 'dot', text: 'no query configured' });
                return;
            }

            closing = false;
            node.status({ fill: 'yellow', shape: 'ring', text: 'connecting…' });

            const headers = buildHeaders(node.server.credentials);
            delete headers['Content-Type'];

            try {
                ws = new WebSocket(buildWsUrl(currentOpts.query), { headers });
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: `connect failed: ${err.message}` });
                node.error(`loki-tail failed to create WebSocket: ${err.message}`);
                scheduleReconnect();
                return;
            }

            ws.on('open', () => {
                node.status({ fill: 'green', shape: 'ring', text: 'connected — waiting for logs…' });
            });

            ws.on('message', (data) => {
                let parsed;
                try {
                    parsed = JSON.parse(data.toString());
                } catch (e) {
                    node.warn(`loki-tail received non-JSON message: ${data.toString().slice(0, 100)}`);
                    return;
                }

                if (parsed.droppedEntries && parsed.droppedEntries.length > 0) {
                    node.warn(
                        `loki-tail: Loki dropped ${parsed.droppedEntries.length} entries — ` +
                        `Loki may be under heavy load or the query is too broad`
                    );
                }

                const entries = flattenStreams(parsed.streams || []);
                if (entries.length === 0) return;

                node.status({
                    fill: 'green', shape: 'dot',
                    text: `${entries.length} @ ${new Date().toLocaleTimeString()}`,
                });

                if (currentOpts.output === 'each') {
                    for (const entry of entries) {
                        node.send({
                            ...lastMsg,
                            payload:       entry.line,
                            lokiTimestamp: entry.timestamp,
                            lokiLabels:    entry.labels,
                            lokiEntry:     entry,
                        });
                    }
                } else {
                    node.send({
                        ...lastMsg,
                        payload: entries,
                        count:   entries.length,
                    });
                }
            });

            ws.on('error', (err) => {
                let friendly = err.message;
                if (err.code === 'ECONNREFUSED') friendly = 'Connection refused — is Loki running?';
                if (err.code === 'ENOTFOUND')    friendly = 'Host not found — check Loki URL';
                if (err.message.includes('401')) friendly = 'Unauthorised — check credentials';
                if (err.message.includes('403')) friendly = 'Forbidden — check credentials';
                node.status({ fill: 'red', shape: 'dot', text: friendly });
                node.error(`loki-tail WebSocket error: ${err.message}`);
            });

            ws.on('close', (code) => {
                ws = null;
                if (closing) {
                    node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
                    return;
                }
                node.warn(`loki-tail disconnected (code ${code}) — reconnecting in ${currentOpts.reconnectMs / 1000}s`);
                scheduleReconnect();
            });
        }

        function scheduleReconnect() {
            if (closing) return;
            node.status({ fill: 'yellow', shape: 'ring', text: `reconnecting in ${currentOpts.reconnectMs / 1000}s…` });
            reconnTimer = setTimeout(connect, currentOpts.reconnectMs);
        }

        function disconnect() {
            closing = true;
            if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
            if (ws) { try { ws.close(); } catch (_) {} ws = null; }
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
        }

        node.on('input', function (msg) {
            if (msg.payload === 'stop')  { disconnect(); return; }
            if (msg.payload === 'start') { disconnect(); closing = false; connect(); return; }

            if (msg.lokiOptions) {
                const newOpts     = resolveOptions(node.defaults, msg);
                const queryChanged = newOpts.query !== currentOpts.query;
                currentOpts = newOpts;
                lastMsg     = msg;
                if (queryChanged) { disconnect(); closing = false; connect(); }
                return;
            }

            lastMsg = msg;
        });

        node.on('close', function (done) { disconnect(); done(); });

        connect();
    }

    RED.nodes.registerType('loki-tail', LokiTailNode);
};
