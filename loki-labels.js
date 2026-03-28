const {
    _getFetch, buildHeaders, parseLookback,
    fetchWithTimeout, assertOk, assertSuccess, resolveOptions
} = require('./helpers');

module.exports = function (RED) {
    function LokiLabelsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);

        node.defaults = {
            mode:      config.mode      || 'labels',
            labelName: config.labelName || '',
            lookback:  config.lookback  || '1h',
        };

        if (!node.server) {
            node.status({ fill: 'red', shape: 'dot', text: 'no server configured' });
            return;
        }

        node.on('input', async function (msg, send, done) {
            const opts   = resolveOptions(node.defaults, msg);
            const base   = node.server.url.replace(/\/$/, '');
            const endMs  = Date.now();
            const startMs = endMs - parseLookback(opts.lookback);
            const params  = new URLSearchParams({
                start: (BigInt(startMs) * 1_000_000n).toString(),
                end:   (BigInt(endMs)   * 1_000_000n).toString(),
            });

            node.status({ fill: 'blue', shape: 'dot', text: 'fetching…' });

            try {
                const fetch   = await _getFetch();
                const headers = buildHeaders(node.server.credentials);

                if (opts.mode === 'labels' || opts.mode === 'both') {
                    const res  = await fetchWithTimeout(fetch, `${base}/loki/api/v1/labels?${params}`, { headers });
                    await assertOk(res);
                    const json = await res.json();
                    assertSuccess(json);

                    if (opts.mode === 'labels') {
                        msg.payload    = json.data;
                        msg.lokiLabels = json.data;
                        node.status({ fill: 'green', shape: 'dot', text: `${json.data.length} labels` });
                        send(msg);
                        done();
                        return;
                    }
                    msg.lokiLabels = json.data;
                }

                if (opts.mode === 'values' || opts.mode === 'both') {
                    let targetLabels;
                    if (opts.mode === 'values' && opts.labelName) {
                        targetLabels = [opts.labelName];
                    } else {
                        if (!msg.lokiLabels) {
                            const res  = await fetchWithTimeout(fetch, `${base}/loki/api/v1/labels?${params}`, { headers });
                            await assertOk(res);
                            const json = await res.json();
                            assertSuccess(json);
                            msg.lokiLabels = json.data;
                        }
                        targetLabels = msg.lokiLabels;
                    }

                    if (!targetLabels || targetLabels.length === 0) {
                        msg.payload         = {};
                        msg.lokiLabelValues = {};
                        node.status({ fill: 'yellow', shape: 'dot', text: 'no labels found' });
                        send(msg);
                        done();
                        return;
                    }

                    const valueMap = {};
                    for (const label of targetLabels) {
                        try {
                            const res  = await fetchWithTimeout(
                                fetch,
                                `${base}/loki/api/v1/label/${encodeURIComponent(label)}/values?${params}`,
                                { headers }
                            );
                            await assertOk(res);
                            const json = await res.json();
                            assertSuccess(json);
                            valueMap[label] = json.data;
                        } catch (err) {
                            node.warn(`loki-labels: could not fetch values for label "${label}": ${err.message}`);
                            valueMap[label] = [];
                        }
                    }

                    msg.payload         = (opts.mode === 'values' && opts.labelName) ? (valueMap[opts.labelName] || []) : valueMap;
                    msg.lokiLabelValues = valueMap;

                    const total = Object.values(valueMap).reduce((a, v) => a + v.length, 0);
                    node.status({ fill: 'green', shape: 'dot', text: `${Object.keys(valueMap).length} labels, ${total} values` });
                    send(msg);
                    done();
                }

            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.message });
                done(err);
            }
        });

        node.on('close', () => node.status({}));
    }

    RED.nodes.registerType('loki-labels', LokiLabelsNode);
};
