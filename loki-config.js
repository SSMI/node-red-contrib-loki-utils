module.exports = function (RED) {
    function LokiConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.url  = config.url  || 'http://localhost:3100';
        this.name = config.name || this.url;
    }

    RED.nodes.registerType('loki-config', LokiConfigNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' },
        },
    });
};
