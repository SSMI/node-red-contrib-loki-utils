const { _getFetch, buildHeaders, fetchWithTimeout } = require('./helpers');

module.exports = function (RED) {
    function LokiReadyNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server    = RED.nodes.getNode(config.server);
        node.buildInfo = config.buildInfo !== false;

        if (!node.server) {
            node.status({ fill: 'red', shape: 'dot', text: 'no server configured' });
            return;
        }

        node.on('input', async function (msg, send, done) {
            const base    = node.server.url.replace(/\/$/, '');
            const headers = buildHeaders(node.server.credentials);

            node.status({ fill: 'blue', shape: 'dot', text: 'checking…' });

            let isReady   = false;
            let readyText = '';
            let buildInfo = null;
            let errorText = null;

            try {
                const fetch = await _getFetch();

                const readyRes = await fetchWithTimeout(fetch, `${base}/ready`, { headers }, 5000);
                readyText = (await readyRes.text()).trim();
                isReady   = readyRes.ok && readyText === 'ready';

                if (node.buildInfo) {
                    try {
                        const buildRes = await fetchWithTimeout(
                            fetch, `${base}/loki/api/v1/status/buildinfo`, { headers }, 5000
                        );
                        if (buildRes.ok) {
                            buildInfo = await buildRes.json();
                        } else {
                            node.warn(`loki-ready: buildinfo returned HTTP ${buildRes.status} — skipping`);
                        }
                    } catch (err) {
                        node.warn(`loki-ready: could not fetch buildinfo: ${err.message}`);
                    }
                }

            } catch (err) {
                isReady   = false;
                errorText = err.message;
            }

            msg.lokiReady     = isReady;
            msg.lokiStatus    = errorText || readyText;
            msg.lokiBuildInfo = buildInfo;
            msg.payload = {
                ready:     isReady,
                status:    errorText || readyText,
                buildInfo: buildInfo,
                checkedAt: new Date().toISOString(),
            };

            if (isReady) {
                const version = buildInfo && buildInfo.version ? ` v${buildInfo.version}` : '';
                node.status({ fill: 'green', shape: 'dot', text: `ready${version}` });
            } else {
                node.status({ fill: 'red', shape: 'dot', text: errorText || readyText || 'not ready' });
            }

            send(msg);
            done();
        });

        node.on('close', () => node.status({}));
    }

    RED.nodes.registerType('loki-ready', LokiReadyNode);
};
