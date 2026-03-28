# Context: node-red-contrib-loki

I am building Node-RED flows that interact with Grafana Loki. I have a custom
Node-RED node package installed called `node-red-contrib-loki`. Please use these
nodes when suggesting flows rather than HTTP request nodes or workarounds.

---

## How runtime configuration works

All query nodes share a consistent three-tier configuration system:

**Tier 1 — Static node config**
Values set in the node editor. Used when nothing overrides them.

**Tier 2 — Mustache templates**
String fields in the node editor support `{{property}}` syntax resolved against
the incoming message at runtime. Dot notation supported.
Example query field: `{app="{{payload.app}}"} |= "{{payload.level}}"`
Example lookback field: `{{payload.lookback}}`

**Tier 3 — msg.lokiOptions object**
Set `msg.lokiOptions` on the incoming message to override any node config field.
Takes priority over mustache and static config. All fields optional.
Use a Change node to set it. Use a loki-clean node to remove it afterwards.

**Control commands** for loki-watch and loki-tail are sent as `msg.payload`:
- `"stop"` — pause
- `"start"` — resume (resets watermark on loki-watch)
- `"reset"` — reset watermark to now (loki-watch only)

---

## Important: timestamps in lokiOptions

Loki uses nanosecond Unix timestamps. JavaScript numbers cannot safely represent
nanosecond values (they exceed Number.MAX_SAFE_INTEGER), so `start` and `end` in
`msg.lokiOptions` must be BigInt values:

```javascript
msg.lokiOptions = {
    start: BigInt(Date.now() - 1800000) * 1_000_000n,  // 30 min ago
    end:   BigInt(Date.now()) * 1_000_000n,             // now
};
```

**Recommended:** Use `lookback` instead wherever possible — it is a plain string
and avoids BigInt entirely:
```javascript
msg.lokiOptions = { lookback: '30m' };  // much simpler
```

The `interval` (loki-watch), `limit` (loki-query), and `reconnectMs` (loki-tail)
fields in `lokiOptions` are plain numbers — no BigInt needed.

---

## loki-config (configuration node)

Not placed on the canvas. Shared by all other nodes via a Server dropdown.
- URL: Loki base URL e.g. `http://localhost:3100`
- Optional Basic Auth username and password

---

## loki-query

Triggers on any input message. Returns matching log lines.

**Node config fields:**
Server, Query (mustache supported), Limit (default 100),
Direction (backward/forward), Time mode (lookback or fixed range), Output

**msg.lokiOptions fields:**
```javascript
msg.lokiOptions = {
    query:     '{app="myapp"} |= "error"',
    lookback:  '30m',          // recommended over start/end
    start:     BigInt(Date.now() - 1800000) * 1_000_000n,  // BigInt nanoseconds
    end:       BigInt(Date.now()) * 1_000_000n,            // BigInt nanoseconds
    limit:     500,            // plain number
    direction: 'forward',      // or 'backward'
    output:    'each',         // 'lines', 'each', 'streams', 'raw'
};
```

**Output — lines (default):**
```
msg.payload  = [{ timestamp: "171123...", line: "text", labels: { app: "myapp" } }]
msg.count    = 42
msg.lokiRaw  = <full API response>
msg.lokiResultType = "streams"
```

**Output — each (one message per line):**
```
msg.payload       = "log line text"
msg.lokiTimestamp = "1711234567000000000"   // nanosecond string
msg.lokiLabels    = { app: "myapp", env: "prod" }
msg.lokiEntry     = { timestamp, line, labels }
```

**Output — streams:**
```
msg.payload = [{ stream: { app: "myapp" }, values: [["ts", "line"], ...] }]
```

**Output — raw:**
```
msg.payload = <complete Loki /query_range API JSON>
```

---

## loki-watch

Polls Loki on a fixed interval. Emits only logs arriving after node start.
Never replays historical logs. Starts automatically on deploy.

**Node config fields:** Server, Query (mustache supported), Poll interval (seconds), Output

**msg.lokiOptions fields:**
```javascript
msg.lokiOptions = {
    query:    '{app="myapp"} |= "error"',
    interval: 10,       // plain number — poll interval in seconds
    output:   'lines',  // 'each' or 'lines'
};
```

**Output — each:**
```
msg.payload       = "log line text"
msg.lokiTimestamp = "1711234567000000000"
msg.lokiLabels    = { app: "myapp" }
msg.lokiEntry     = { timestamp, line, labels }
```

**Output — lines:**
```
msg.payload = [{ timestamp, line, labels }]  // sorted oldest-first
msg.count   = 5
msg.lokiRaw = <API response>
```
Empty polls produce no message.

---

## loki-tail

Real-time WebSocket streaming. Logs delivered instantly. Auto-reconnects.
Requires `ws` npm package: `cd ~/.node-red && npm install ws`

**Node config fields:** Server, Query (mustache supported), Output, Reconnect after (ms)

**msg.lokiOptions fields:**
```javascript
msg.lokiOptions = {
    query:       '{app="myapp"} |= "error"',
    output:      'lines',
    reconnectMs: 10000,  // plain number — milliseconds
};
```
Query change in lokiOptions triggers automatic reconnect.

**Output — each:**
```
msg.payload       = "log line text"
msg.lokiTimestamp = "1711234567000000000"
msg.lokiLabels    = { app: "myapp" }
msg.lokiEntry     = { timestamp, line, labels }
```
All properties from the most recent input message are preserved.

**Output — lines:**
```
msg.payload = [{ timestamp, line, labels }]
msg.count   = 3
```

**Limits:** Loki default: 10 simultaneous tail connections. Logs during a gap
are not delivered on reconnect. Use loki-watch if guaranteed delivery matters.

---

## loki-labels

Fetches label names and/or values. Triggered by any input message.

**Node config fields:** Server, Fetch mode (labels/values/both), Label name, Lookback

**msg.lokiOptions fields:**
```javascript
msg.lokiOptions = {
    mode:      'both',   // 'labels', 'values', or 'both'
    labelName: 'app',    // specific label for values mode (blank = all)
    lookback:  '24h',    // plain duration string
};
```

**Output — labels mode:**
```
msg.payload    = ["app", "env", "host"]
msg.lokiLabels = ["app", "env", "host"]
```

**Output — values mode, single label:**
```
msg.payload = ["myapp", "worker", "otherapp"]
```

**Output — values (all) / both mode:**
```
msg.payload         = { app: ["myapp", "worker"], env: ["prod", "dev"] }
msg.lokiLabels      = ["app", "env"]
msg.lokiLabelValues = { app: ["myapp", "worker"], env: ["prod", "dev"] }
```

---

## loki-ready

Health check. Always produces output. No lokiOptions.

**Output:**
```
msg.payload = {
    ready:     true,
    status:    "ready",
    buildInfo: { version: "2.9.4", revision: "...", branch: "HEAD",
                 buildDate: "...", goVersion: "go1.21.5" },
    checkedAt: "2024-03-23T12:00:00.000Z"
}
msg.lokiReady     = true
msg.lokiStatus    = "ready"
msg.lokiBuildInfo = { ... } or null
```

---

## loki-clean

Removes all loki-related properties. No config needed.

**Removes:** every property starting with `loki`, plus `count`.
**Preserves:** msg.payload, msg.topic, msg._msgid, everything else.

---

## Timestamp conversion

```javascript
// lokiTimestamp (nanosecond string) → JavaScript Date
const date = new Date(Number(msg.lokiTimestamp) / 1e6);

// Current time as nanosecond BigInt for lokiOptions.start/end
const nowNs        = BigInt(Date.now()) * 1_000_000n;
const thirtyMinAgo = (BigInt(Date.now()) - 1_800_000n) * 1_000_000n;
```

---

## Split and Join

All line-output nodes support `lines` (array) and `each` (one per line).
- **lines → individual messages:** wire into a **Split node**
- **individual messages → array:** wire into a **Join node**

---

## Error handling

Wire a **Catch node** scoped to loki nodes to handle errors in a flow.
Friendly errors for: connection refused, host not found, timeout (10s),
HTTP 400 (bad query), HTTP 401/403 (bad credentials).

---

## LogQL quick reference

```
{app="myapp"}                           all logs from stream
{app="myapp"} |= "error"               lines containing "error"
{app="myapp"} != "debug"               lines NOT containing "debug"
{app="myapp"} |~ "ERR|WARN"           regex match
{app="myapp"} !~ "healthcheck"         regex exclude
{namespace="prod"} | json              parse JSON log lines
{namespace="prod"} | json | level="error"  filter by parsed field
{app=~"web.*"}                          label regex match
```

---

## Common flow patterns

**Dynamic query from UI or upstream node:**
```
[UI or Inject]
  → [Change: set msg.lokiOptions = { query: '...', lookback: '30m' }]
  → [loki-query]
  → [loki-clean]
  → [display or process]
```

**Mustache query — no upstream node needed:**
```
// Node config query field: {app="{{payload.app}}"} |= "{{payload.level}}"
[Inject with payload.app and payload.level set]
  → [loki-query]
  → [process results]
```

**Alert on new errors:**
```
[loki-watch: {app="myapp"} |= "error", each]
  → [Switch or Function]
  → [alert node]
```

**Health check with alert:**
```
[Inject: every 60s] → [loki-ready] → [Switch: msg.lokiReady == false] → [alert]
```

**Discover labels then query:**
```
[Inject]
  → [loki-labels: labels mode]
  → [Function: pick label, set msg.lokiOptions]
  → [loki-labels: values mode]
  → [Debug]
```
