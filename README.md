# node-red-contrib-loki

[![No Maintenance Intended](http://unmaintained.tech/badge.svg)](http://unmaintained.tech/)

Node-RED nodes for [Grafana Loki](https://grafana.com/oss/loki/) log aggregation.

> **Note:** This package was generated with AI assistance and is provided as-is
> without active maintenance. Issues and pull requests are welcome but may not
> be responded to. Use at your own risk in production environments.
> MIT licensed — feel free to fork and maintain your own version.

---

## Nodes

| Node | Description |
|---|---|
| **loki-config** | Shared server configuration (URL + credentials) |
| **loki-query** | On-demand LogQL query |
| **loki-watch** | Polls Loki and triggers on new matching log lines |
| **loki-tail** | Real-time log streaming via WebSocket |
| **loki-labels** | Lists label names and/or their values |
| **loki-ready** | Health check — is Loki up and ready? |
| **loki-clean** | Removes all loki properties from a message |

---

## How runtime configuration works

All query nodes (loki-query, loki-watch, loki-tail, loki-labels) share the same
pattern for runtime configuration:

**1. Static config** — set values in the node editor. Simplest option, no extra
nodes needed.

**2. Mustache templates** — use `{{property}}` in string fields to resolve values
from the incoming message at runtime. No upstream node needed:
```
{app="{{payload.app}}"} |= "{{payload.level}}"
```

**3. msg.lokiOptions** — set a single object on the message to override any node
config value. One Change node to set it, one loki-clean node to remove it:
```javascript
msg.lokiOptions = {
    query:    '{app="myapp"} |= "error"',
    lookback: '30m',
    output:   'lines',
};
```

Control commands for loki-watch and loki-tail are sent as `msg.payload`:
```javascript
msg.payload = "stop";   // pause
msg.payload = "start";  // resume
msg.payload = "reset";  // reset watermark (loki-watch only)
```

---

## Resource and load considerations

### loki-watch (polling)
One HTTP request per poll interval per node. At the default 5 second interval
that is 12 requests per minute. Zero load between polls. Load is linear and
predictable. Tolerant of brief Loki outages.

### loki-tail (WebSocket streaming)
One persistent WebSocket connection per node. Real-time delivery with no polling
delay. However:
- Loki has a default limit of 10 simultaneous tail connections
- More resource intensive on Loki than poll queries
- Logs during a connection gap are not delivered on reconnect

**Rule of thumb:** use loki-tail for sub-second latency with a small number of
watchers. Use loki-watch for everything else.

---

## Installation

### Palette Manager (easiest)
Node-RED → **☰ menu** → **Manage palette** → **Install** → search `node-red-contrib-loki`

### npm
```bash
cd ~/.node-red
npm install node-red-contrib-loki
```

### loki-tail extra requirement
```bash
cd ~/.node-red && npm install ws
```

---

## Setup

1. Drag any loki node onto the canvas and double-click it
2. Click the **pencil icon** next to the Server dropdown
3. Enter your Loki URL, optional credentials, and a name (e.g. `prod-loki`)
4. All loki nodes in all flows share this config node

Multiple config nodes work for multiple environments:
```
[prod-loki]     https://loki.prod.internal
[staging-loki]  http://loki.staging.internal
[local-loki]    http://localhost:3100
```

---

## Working with arrays and individual messages

All line-output nodes support two modes:
- **lines** — one message with an array of all entries
- **each** — one message per log line

Convert between them with built-in Node-RED nodes:
- **lines → individual:** wire into a **Split node**
- **individual → array:** wire into a **Join node**

---

## Example flows

**Alert on new error logs:**
```
[loki-watch: {app="myapp"} |= "error", 10s, each]
  → [Switch: msg.lokiLabels.severity == "critical"]
  → [notification node]
```

**Query with dynamic parameters:**
```
[Inject or UI trigger]
  → [Change: msg.lokiOptions = { query: '{app="myapp"}', lookback: '30m' }]
  → [loki-query]
  → [loki-clean]
  → [next stage]
```

**Health monitoring:**
```
[Inject: every 60s] → [loki-ready] → [Switch: msg.lokiReady == false] → [alert]
```

**Real-time dashboard:**
```
[loki-tail: {namespace="prod"}, each] → [Function: format] → [UI node]
```

---

## Requirements

- Node-RED 2.0+
- Node.js 16+ (18+ recommended)
- Grafana Loki 2.x+
- `ws` npm package (loki-tail only)

---

## License

MIT
