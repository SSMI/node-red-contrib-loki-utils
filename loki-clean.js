module.exports = function (RED) {
    function LokiCleanNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function (msg, send, done) {
            // Remove all properties whose names start with 'loki', plus 'count'
            // which is added by lines/batch output modes
            const removed = [];
            for (const key of Object.keys(msg)) {
                if (key.startsWith('loki') || key === 'count') {
                    delete msg[key];
                    removed.push(key);
                }
            }

            node.status({
                fill:  'green',
                shape: 'dot',
                text:  removed.length > 0
                    ? `removed ${removed.length} prop${removed.length > 1 ? 's' : ''}`
                    : 'nothing to clean',
            });

            send(msg);
            done();
        });

        node.on('close', () => node.status({}));
    }

    RED.nodes.registerType('loki-clean', LokiCleanNode);
};
