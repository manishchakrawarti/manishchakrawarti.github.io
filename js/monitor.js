// Agent M live demo: a browser port of job_monitoring (classifier.py, healer.py, sql_guard.py,
// health.py and the JobMonitor run loop) running against a simulated BigQuery table.
// Same rules and the same SQL as the Python engine. Nothing leaves the page.

/* ---------- Simulated warehouse ---------- */

const PROJECT = "demo-project";
const DATASET = "sales";
const TABLE = "orders";
const TABLE_ID = `${PROJECT}.${DATASET}.${TABLE}`;
const TABLE_REF = `${PROJECT}:${DATASET}.${TABLE}`;   // how BigQuery error messages name it

const BASE_SCHEMA = [
  { name: "order_id", type: "STRING", mode: "REQUIRED" },
  { name: "order_ts", type: "TIMESTAMP", mode: "NULLABLE" },
  { name: "customer_id", type: "STRING", mode: "NULLABLE" },
  { name: "qty", type: "INT64", mode: "NULLABLE" },
  { name: "amount", type: "INT64", mode: "NULLABLE" },
  { name: "region", type: "STRING", mode: "NULLABLE" },
];
const table = { schema: [], partition: "order_ts", clustering: ["region"], changed: new Set() };

function resetTable() {
  table.schema = BASE_SCHEMA.map((f) => ({ ...f }));
  table.changed.clear();
}

class BQError extends Error {
  // Mirrors google.api_core exceptions: str() is "<code> <message>", plus a structured errors list.
  constructor(type, code, message, reason) {
    super(`${code} ${message}`);
    this.type = type;
    this.errors = [{ reason, message }];
  }
}

function getTable(id) {
  if (id.replace(":", ".") !== TABLE_ID) {
    throw new BQError("NotFound", 404, `Not found: Table ${id.replace(".", ":")}`, "notFound");
  }
  return table;
}

const LEGACY = { INT64: "INTEGER", FLOAT64: "FLOAT", BOOL: "BOOLEAN" };   // names used in load errors
const legacy = (t) => LEGACY[t] || t;

/* ---------- classifier.py ---------- */

// [category, transient, healable, regex]: first match wins, order matters.
const RULES = [
  ["TRANSIENT_QUOTA", true, false, /quotaExceeded|rateLimitExceeded|Exceeded rate limits|Quota exceeded/i],
  ["SCHEMA_TYPE_MISMATCH", false, true, /Field (?<field>\w+) has changed type from (?<target_type>\w+) to (?<source_type>\w+)/i],
  ["SCHEMA_TYPE_MISMATCH", false, true, /Query column \d+ has type (?<source_type>\w+) which cannot be inserted into column (?<field>\w+), which has type (?<target_type>\w+)/i],
  ["SCHEMA_TYPE_MISMATCH", false, true, /ArrowInvalid|ArrowTypeError|was truncated converting to|tried to convert to/i],
  ["DATA_PARSE_ERROR", false, true, /Could not parse '(?<value>[^']*)' as (?<target_type>\w+) for field (?<field>\w+)/i],
  ["SCHEMA_MISSING_COLUMN", false, true, /No such field: (?<field>\w+)/i],
  // Load job with a new source column: "Provided Schema does not match Table ... Cannot add fields (field: x)"
  ["SCHEMA_MISSING_COLUMN", false, true, /Cannot add fields \(field: (?<field>\w+)\)/i],
  // Nested fields are dotted (a.b); BigQuery ends the message with '.', which must not be captured.
  ["SCHEMA_REQUIRED_NULL", false, true, /Required field (?<field>\w+(?:\.\w+)*) cannot be null/i],
  ["SCHEMA_REQUIRED_NULL", false, true, /Missing required field: (?<field>\w+(?:\.\w+)*)/i],
  ["TABLE_NOT_FOUND", false, false, /Not found: Table (?<table>[\w\-.:]+)/i],
  ["PERMISSION_DENIED", false, false, /Access Denied|Permission .+ denied/i],
  ["TRANSIENT_NETWORK", true, false, /Connection (?:reset|aborted|refused)|timed out|Deadline Exceeded|backendError|internalError/i],
];

const TYPE_FALLBACK = [
  [["TooManyRequests", "ServiceUnavailable", "InternalServerError", "BadGateway", "GatewayTimeout",
    "DeadlineExceeded", "ConnectionError", "TimeoutError"], "TRANSIENT_NETWORK", true, false],
  [["Forbidden", "PermissionError"], "PERMISSION_DENIED", false, false],
  [["NotFound", "FileNotFoundError"], "NOT_FOUND", false, false],
  [["KeyError", "ValueError", "TypeError"], "CODE_OR_DATA_BUG", false, false],
];

function messageOf(exc) {
  const parts = [exc.message];
  for (const e of exc.errors || []) parts.push(`${e.reason || ""}: ${e.message || ""}`);
  return parts.join(" | ");
}

function classify(exc) {
  const text = messageOf(exc);
  for (const [category, transient, healable, pattern] of RULES) {
    const m = text.match(pattern);
    if (m) {
      const details = Object.fromEntries(Object.entries(m.groups || {}).filter(([, v]) => v));
      return { category, transient, healable, details };
    }
  }
  for (const [types, category, transient, healable] of TYPE_FALLBACK) {
    if (types.includes(exc.type)) return { category, transient, healable, details: {} };
  }
  return { category: "UNKNOWN", transient: false, healable: false, details: {} };
}

/* ---------- healer.py ---------- */

const ALIASES = { INTEGER: "INT64", INT: "INT64", FLOAT: "FLOAT64", BOOLEAN: "BOOL", DECIMAL: "NUMERIC", BIGDECIMAL: "BIGNUMERIC" };

// The only coercions BigQuery's ALTER COLUMN ... SET DATA TYPE does in place.
const WIDENING = {
  INT64: new Set(["NUMERIC", "BIGNUMERIC", "FLOAT64"]),
  NUMERIC: new Set(["BIGNUMERIC", "FLOAT64"]),
};
const widens = (from, to) => Boolean(WIDENING[from]?.has(to));

function norm(t) {
  t = t.toUpperCase();
  return ALIASES[t] || t;
}

const action = (target, column, sql, risk, reason) => ({ target, column, sql, risk, reason, status: "PROPOSED", result: "" });
const pyRepr = (v) => (v == null ? "None" : `'${v}'`);

class Healer {
  constructor({ allowedDatasets, autoApply = true }) {
    this.allowed = allowedDatasets;   // never touch anything outside these
    this.autoApply = autoApply;
  }

  heal(cls, context) {
    const actions = this.propose(cls, context);
    for (const a of actions) if (a.risk === "SAFE" && this.autoApply) this.apply(a);
    return actions;
  }

  propose(cls, context) {
    const target = context.target_table;
    if (!target) return [];
    const d = cls.details;
    const source = Object.fromEntries(Object.entries(context.source_schema || {}).map(([k, v]) => [k, norm(v)]));

    if (cls.category === "DATA_PARSE_ERROR") {
      return [action(target, d.field, "", "ADVISORY",
        `Value ${pyRepr(d.value)} in ${d.field} is not a valid ${d.target_type}. ` +
        "This is bad data, not a schema problem: load with SAFE_CAST and route rows " +
        "that come back NULL to a quarantine table.")];
    }

    if (cls.category === "SCHEMA_REQUIRED_NULL" && d.field) {
      const f = d.field;
      return [action(target, f, `ALTER TABLE \`${target}\` ALTER COLUMN \`${f}\` DROP NOT NULL;`, "NEEDS_APPROVAL",
        `Source sends NULLs for REQUIRED column ${f}; relaxing it changes the table contract.`)];
    }

    // Type mismatch / new column: trust a live schema diff over parsing error text.
    if (Object.keys(source).length) {
      let actions = this.diff(target, source);
      if (d.field) {   // the error named a column -> focus on it
        const focused = actions.filter((a) => (a.column || "").toLowerCase() === d.field.toLowerCase());
        // Other lossless drift in the same source would fail the very next
        // attempt, so fix it in this pass too. Risky changes stay focused.
        if (focused.length) actions = [...focused, ...actions.filter((a) => a.risk === "SAFE" && !focused.includes(a))];
      }
      return actions;
    }

    if (cls.category === "SCHEMA_TYPE_MISMATCH" && d.field && d.source_type && d.target_type) {
      return [this.typeChange(getTable(target), d.field, norm(d.target_type), norm(d.source_type))];
    }
    return [];
  }

  diff(target, source) {
    const t = getTable(target);
    const current = new Map(t.schema.map((f) => [f.name.toLowerCase(), f]));
    const actions = [];
    for (const [col, srcType] of Object.entries(source)) {
      const f = current.get(col.toLowerCase());
      if (!f) {
        actions.push(action(target, col, `ALTER TABLE \`${target}\` ADD COLUMN IF NOT EXISTS \`${col}\` ${srcType};`,
          "SAFE", `New source column ${col} (${srcType})`));
      } else if (!["RECORD", "STRUCT"].includes(f.type) && norm(f.type) !== srcType) {
        actions.push(this.typeChange(t, f.name, norm(f.type), srcType));
      }
    }
    return actions;
  }

  typeChange(t, col, current, desired) {
    const target = TABLE_ID;
    if (widens(current, desired)) {
      return action(target, col, `ALTER TABLE \`${target}\` ALTER COLUMN \`${col}\` SET DATA TYPE ${desired};`,
        "SAFE", `Widen ${col}: ${current} -> ${desired} (lossless, in place)`);
    }
    if (widens(desired, current)) {
      return action(target, col, "", "ADVISORY",
        `Source ${col} is ${desired}, target is wider (${current}); CAST in the job, no DDL needed.`);
    }
    const layoutCols = new Set([...t.clustering, t.partition].filter(Boolean));
    if (layoutCols.has(col)) {
      return action(target, col, "", "BLOCKED",
        `${col} is a partition/cluster column; ${current} -> ${desired} needs a table rebuild.`);
    }
    // Non-coercible change: add new column, backfill, swap. Keeps partitioning,
    // clustering and policies (CREATE OR REPLACE would drop them).
    const tmp = `${col}__v2`;
    const sql = [
      `ALTER TABLE \`${target}\` ADD COLUMN \`${tmp}\` ${desired};`,
      `UPDATE \`${target}\` SET \`${tmp}\` = SAFE_CAST(\`${col}\` AS ${desired}) WHERE TRUE;`,
      `ALTER TABLE \`${target}\` DROP COLUMN \`${col}\`;`,
      `ALTER TABLE \`${target}\` RENAME COLUMN \`${tmp}\` TO \`${col}\`;`,
    ].join("\n");
    return action(target, col, sql, "NEEDS_APPROVAL",
      `${current} -> ${desired} is not an in-place coercion. Migration rewrites the column: ` +
      "full-table UPDATE cost, column moves to the end, REQUIRED mode is lost, " +
      "and values SAFE_CAST can't convert become NULL.");
  }

  apply(a) {
    const dataset = a.target.split(".").at(-2);
    if (!this.allowed.has(dataset)) {
      a.status = "SKIPPED";
      a.result = `dataset '${dataset}' not in allow-list`;
      return;
    }
    try {
      runDDL(a.sql, { dryRun: true });   // validates before touching anything
      runDDL(a.sql);
      a.status = "APPLIED";
      a.result = "ok";
    } catch (exc) {
      a.status = "FAILED";
      a.result = exc.message.slice(0, 2000);
    }
  }
}

/* ---------- A tiny DDL engine for the simulated table ---------- */

const ID = "`?([\\w\\-.:]+)`?";
const COLN = "`?(\\w+)`?";
const DDL = [
  [new RegExp(`^ALTER\\s+TABLE\\s+${ID}\\s+ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${COLN}\\s+(\\w+)$`, "i"),
    (t, [ifne, col, type]) => {
      if (find(t, col)) { if (ifne) return; throw ddlError(`Column already exists: ${col}`); }
      t.schema.push({ name: col, type: norm(type), mode: "NULLABLE" });
      t.changed.add(col.toLowerCase());
    }],
  [new RegExp(`^ALTER\\s+TABLE\\s+${ID}\\s+ALTER\\s+COLUMN\\s+${COLN}\\s+SET\\s+DATA\\s+TYPE\\s+(\\w+)$`, "i"),
    (t, [col, type]) => {
      const f = need(t, col), to = norm(type), from = norm(f.type);
      if (from === to) return;
      if (!widens(from, to)) throw ddlError(`ALTER TABLE ALTER COLUMN SET DATA TYPE requires that the existing column type (${from}) is assignable to the new type (${to})`);
      f.type = to;
      t.changed.add(f.name.toLowerCase());
    }],
  [new RegExp(`^ALTER\\s+TABLE\\s+${ID}\\s+ALTER\\s+COLUMN\\s+${COLN}\\s+DROP\\s+NOT\\s+NULL$`, "i"),
    (t, [col]) => { const f = need(t, col); f.mode = "NULLABLE"; t.changed.add(f.name.toLowerCase()); }],
  [new RegExp(`^ALTER\\s+TABLE\\s+${ID}\\s+DROP\\s+COLUMN\\s+(IF\\s+EXISTS\\s+)?${COLN}$`, "i"),
    (t, [ife, col]) => {
      const f = find(t, col);
      if (!f) { if (ife) return; throw ddlError(`Column not found: ${col}`); }
      if (f.name === t.partition || t.clustering.includes(f.name)) throw ddlError(`Cannot drop partitioning or clustering column ${f.name}`);
      t.schema = t.schema.filter((x) => x !== f);
    }],
  [new RegExp(`^ALTER\\s+TABLE\\s+${ID}\\s+RENAME\\s+COLUMN\\s+${COLN}\\s+TO\\s+${COLN}$`, "i"),
    (t, [from, to]) => {
      const f = need(t, from);
      if (find(t, to)) throw ddlError(`Column already exists: ${to}`);
      f.name = to;
      t.changed.add(to.toLowerCase());
    }],
  [new RegExp(`^UPDATE\\s+${ID}\\s+SET\\s+[\\s\\S]+$`, "i"), () => {}],   // data only, schema unchanged
];

const find = (t, col) => t.schema.find((f) => f.name.toLowerCase() === col.toLowerCase());
const ddlError = (msg) => new BQError("BadRequest", 400, msg, "invalidQuery");
function need(t, col) {
  const f = find(t, col);
  if (!f) throw ddlError(`Column not found: ${col}`);
  return f;
}

function runDDL(sql, { dryRun = false } = {}) {
  // Dry runs work on a copy, so a script that fails halfway changes nothing.
  const work = dryRun ? { ...table, schema: table.schema.map((f) => ({ ...f })), changed: new Set() } : table;
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  if (!statements.length) throw ddlError("No statement to run");
  for (const stmt of statements) {
    const rule = DDL.find(([re]) => re.test(stmt));
    if (!rule) throw ddlError(`This demo only runs ALTER TABLE and UPDATE statements: ${stmt.slice(0, 60)}`);
    const [, target, ...rest] = stmt.match(rule[0]);
    getTable(target);
    rule[1](work, rest);
  }
}

/* ---------- sql_guard.py ---------- */

const G_TABLE = "`(?<table>[\\w\\-]+\\.\\w+\\.\\w+)`";
const G_COL = "`?(?<col>\\w+)`?";
const ADD_COL = new RegExp(`^ALTER\\s+TABLE\\s+${G_TABLE}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${G_COL}\\s+(?<type>\\w+)\\s*;?$`, "i");
const WIDEN = new RegExp(`^ALTER\\s+TABLE\\s+${G_TABLE}\\s+ALTER\\s+COLUMN\\s+${G_COL}\\s+SET\\s+DATA\\s+TYPE\\s+(?<type>\\w+)\\s*;?$`, "i");
const DESTRUCTIVE = /\b(DROP\s+(?:TABLE|SCHEMA|VIEW)|TRUNCATE|DELETE|MERGE|CREATE\s+OR\s+REPLACE|GRANT|REVOKE)\b/i;

function grade(sql, allowedDatasets) {
  const s = (sql || "").trim();
  if (!s) return { risk: "ADVISORY", reason: "no SQL; action is outside the warehouse" };
  if (DESTRUCTIVE.test(s)) return { risk: "BLOCKED", reason: "destructive or data-rewriting statement; human only" };

  const add = s.match(ADD_COL);
  const m = add || s.match(WIDEN);
  if (!m) return { risk: "NEEDS_APPROVAL", reason: "statement is not on the auto-apply allow-list" };

  const tbl = m.groups.table;
  const dataset = tbl.split(".")[1];
  if (!allowedDatasets.has(dataset)) return { risk: "NEEDS_APPROVAL", reason: `dataset '${dataset}' is outside the allow-list` };

  const fields = new Map(getTable(tbl).schema.map((f) => [f.name.toLowerCase(), f]));
  const col = m.groups.col, newType = norm(m.groups.type);

  if (add) {
    if (fields.has(col.toLowerCase())) return { risk: "ADVISORY", reason: `column ${col} already exists` };
    return { risk: "SAFE", reason: `adds nullable column ${col} ${newType}` };
  }
  const f = fields.get(col.toLowerCase());
  if (!f) return { risk: "NEEDS_APPROVAL", reason: `column ${col} not found in ${tbl}` };
  const cur = norm(f.type);
  if (widens(cur, newType)) return { risk: "SAFE", reason: `lossless widening ${col}: ${cur} -> ${newType}` };
  return { risk: "NEEDS_APPROVAL", reason: `${cur} -> ${newType} is not an in-place widening` };
}

/* ---------- health.py ---------- */

// Median duration and rows of the job's last good runs (v_job_runs_latest: last row per run wins).
function baseline(jobName, excludeRunId, runs = 30) {
  const latest = new Map();
  for (const r of db.job_runs) if (r.job_name === jobName && r.run_id !== excludeRunId) latest.set(r.run_id, r);
  const good = [...latest.values()]
    .filter((r) => r.status === "SUCCESS" || r.status === "HEALED")
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, runs);
  const median = (xs) => {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  return { runs: good.length, median_sec: median(good.map((r) => r.duration_sec)), median_rows: median(good.map((r) => r.rows_written)) };
}

function checkRun({ durationSec, rowsWritten, base, slaSeconds = null, slowFactor = 3, drop = 0.5, spike = 3, minHistory = 5, minExtraSec = 60 }) {
  const found = [];
  const n = (x) => Math.round(x).toLocaleString("en-US");
  const secs = (x) => `${x.toFixed(x < 1 ? 2 : x < 10 ? 1 : 0)}s`;
  if (slaSeconds && durationSec > slaSeconds) {
    found.push({ kind: "SLA_MISSED", message: `run took ${secs(durationSec)}, SLA is ${secs(slaSeconds)}` });
  }
  if (!base || base.runs < minHistory) return found;
  if (base.median_sec && durationSec > slowFactor * base.median_sec && durationSec - base.median_sec >= minExtraSec) {
    found.push({ kind: "SLOW_RUN", message: `run took ${secs(durationSec)}, ${(durationSec / base.median_sec).toFixed(1)}x the usual ${secs(base.median_sec)}` });
  }
  const med = base.median_rows;
  if (rowsWritten != null && med) {
    if (rowsWritten === 0) found.push({ kind: "NO_ROWS", message: `no rows written; usually about ${n(med)}` });
    else if (rowsWritten < (1 - drop) * med) found.push({ kind: "ROW_DROP", message: `${n(rowsWritten)} rows written, ${Math.round((1 - rowsWritten / med) * 100)}% below the usual ${n(med)}` });
    else if (rowsWritten > spike * med) found.push({ kind: "ROW_SPIKE", message: `${n(rowsWritten)} rows written, ${(rowsWritten / med).toFixed(1)}x the usual ${n(med)}` });
  }
  return found;
}

/* ---------- Scenarios: what the source sends this time ---------- */

const SOURCE = { order_id: "STRING", order_ts: "TIMESTAMP", customer_id: "STRING", qty: "INT64", amount: "INT64", region: "STRING" };
const quotaError = () => new BQError("Forbidden", 403, `Exceeded rate limits: too many table update operations for this table. For more information, see https://cloud.google.com/bigquery/troubleshooting-errors`, "rateLimitExceeded");
const networkError = () => Object.assign(new Error("('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))"), { type: "ConnectionError" });

const SCENARIOS = [
  { id: "widen", name: "Decimals arrive in amount", blurb: "The source starts sending 19.99 into an INT64 column.",
    source: { ...SOURCE, amount: "FLOAT64" } },
  { id: "newcol", name: "A new source column", blurb: "The upstream team adds discount_pct without telling anyone.",
    source: { ...SOURCE, discount_pct: "FLOAT64" } },
  { id: "multi", name: "Two changes at once", blurb: "Decimals in amount and a new discount_pct column, in the same file.",
    source: { ...SOURCE, amount: "FLOAT64", discount_pct: "FLOAT64" } },
  { id: "quota", name: "Rate limit hit", blurb: "BigQuery throttles table updates twice in a row.",
    transient: [quotaError, quotaError] },
  { id: "network", name: "Network blip", blurb: "The connection drops once mid-load.",
    transient: [networkError] },
  { id: "nulls", name: "NULLs in a required column", blurb: "Some rows arrive without an order_id.",
    nulls: ["order_id"] },
  { id: "retype", name: "qty switches to text", blurb: "The source sends qty as STRING. No in-place fix exists.",
    source: { ...SOURCE, qty: "STRING" } },
  { id: "badvalue", name: "'N/A' in a number field", blurb: "Bad data, not a bad schema.",
    bad: { field: "qty", value: "N/A" } },
  { id: "partition", name: "Partition column changes", blurb: "order_ts arrives as STRING.",
    source: { ...SOURCE, order_ts: "STRING" } },
  { id: "slow", name: "Run takes 6x longer", blurb: "The load succeeds, but a slot shortage makes it crawl.",
    slow: 6 },
  { id: "rowdrop", name: "Most rows go missing", blurb: "The file arrives truncated: 812 rows instead of about 41,000.",
    rows: 812 },
  { id: "perm", name: "Permission removed", blurb: "The job's service account lost write access.",
    permission: true },
  { id: "clean", name: "Healthy run", blurb: "Nothing goes wrong. The baseline." },
];

// A fake load job that fails the way BigQuery does, against the table's current schema.
function loadTable(sc, attempt) {
  const transient = sc.transient?.[attempt - 1];
  if (transient) throw transient();
  if (sc.permission) {
    throw new BQError("Forbidden", 403, `Access Denied: Table ${TABLE_REF}: Permission bigquery.tables.updateData denied on table ${TABLE_REF} (or it may not exist).`, "accessDenied");
  }
  const fields = new Map(table.schema.map((f) => [f.name.toLowerCase(), f]));
  for (const [col, srcType] of Object.entries(sc.source || SOURCE)) {
    const f = fields.get(col.toLowerCase());
    if (!f) throw new BQError("BadRequest", 400, `Provided Schema does not match Table ${TABLE_REF}. Cannot add fields (field: ${col})`, "invalid");
    const cur = norm(f.type);
    if (cur !== srcType && !widens(srcType, cur)) {
      throw new BQError("BadRequest", 400, `Provided Schema does not match Table ${TABLE_REF}. Field ${f.name} has changed type from ${legacy(cur)} to ${legacy(srcType)}`, "invalid");
    }
  }
  for (const col of sc.nulls || []) {
    if (fields.get(col)?.mode === "REQUIRED") throw new BQError("BadRequest", 400, `Required field ${col} cannot be null`, "invalid");
  }
  if (sc.bad) {
    const f = fields.get(sc.bad.field);
    if (f && norm(f.type) !== "STRING") {
      throw new BQError("BadRequest", 400, `Error while reading data, error message: Could not parse '${sc.bad.value}' as ${norm(f.type)} for field ${f.name} (position 3) starting at location 1182 with message 'Unable to parse'`, "invalid");
    }
  }
  return sc.rows ?? 41208 + Math.floor(Math.random() * 900);
}

/* ---------- monitor.py: the run loop ---------- */

const db = { job_runs: [], job_events: [], healing_actions: [] };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pause = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));

// Simulated time: retries and loads take seconds of "job time" but a moment on screen.
const clock = { offset: 0, now() { return new Date(Date.now() + this.offset); }, advance(sec) { this.offset += sec * 1000; } };
const iso = () => clock.now().toISOString();
const hms = (d) => d.toTimeString().slice(0, 8);
const stamp = (d) => (d.toDateString() === clock.now().toDateString() ? "" : `${d.toISOString().slice(5, 10)} `) + hms(d);

// Eight nights of normal runs, so the health check has a history to compare with.
function seedHistory() {
  for (let day = 8; day >= 1; day--) {
    const start = new Date(clock.now().getTime() - day * 86400000);
    start.setHours(2, 14, 7, 0);
    const dur = 22 + Math.random() * 8;
    const rows = 40800 + Math.floor(Math.random() * 1200);
    const run = { run_id: uuid(), job_name: "load_orders", pipeline: "sales_daily", environment: "demo", attempt: 1,
      started_at: start.toISOString(), rows_read: rows, error_category: null, error_message: null, healed: false };
    const end = new Date(start.getTime() + dur * 1000).toISOString();
    db.job_runs.push(
      { ...run, recorded_at: start.toISOString(), status: "RUNNING", ended_at: null, duration_sec: null, rows_written: 0 },
      { ...run, recorded_at: end, status: "SUCCESS", ended_at: end, duration_sec: +dur.toFixed(3), rows_written: rows });
  }
}

class JobMonitor {
  constructor(jobName, { pipeline, params, healer, slaSeconds = null, notifier = null }) {
    Object.assign(this, { jobName, pipeline, params, healer, slaSeconds, notifier });
    this.actions = [];
    this.runId = uuid();
    this.metrics = { rows_read: 0, rows_written: 0 };
    this.context = {};
    this.attempt = 0;
    this.step = null;
    this.failedStep = null;
  }

  async withStep(name, fn) {
    const prev = this.step;
    this.step = name;
    const t = clock.now();
    await this.event("INFO", `step start: ${name}`);
    try {
      const out = await fn();
      await this.event("INFO", `step end: ${name}`, { context: { duration_sec: +((clock.now() - t) / 1000).toFixed(3) } });
      return out;
    } catch (exc) {
      this.failedStep ||= name;   // innermost step wins
      throw exc;
    } finally {
      this.step = prev;
    }
  }

  async event(level, message, { exc = null, category = null, context = null } = {}) {
    const row = {
      event_id: uuid(), run_id: this.runId, job_name: this.jobName, event_ts: iso(), level,
      step: this.step, attempt: this.attempt, message: message.slice(0, 10000),
      exception_type: exc ? exc.type || "Exception" : null,
      error_category: category, context: context ? JSON.stringify(context) : null,
    };
    db.job_events.push(row);
    ui.logEvent(row);
    await pause(level === "INFO" ? 160 : 420);
  }

  async run(fn, { maxRetries = 3, baseDelay = 5, maxHeals = 1 } = {}) {
    this.t0 = clock.now();
    this.startedAt = iso();
    this.writeRun("RUNNING");
    await this.event("INFO", "job started", { context: this.params });
    let heals = 0, healed = false;
    while (true) {
      this.attempt += 1;
      this.failedStep = null;
      try {
        await fn(this);
      } catch (exc) {
        const cls = classify(exc);
        await this.event("ERROR", exc.message, { exc, category: cls.category, context: this.failureContext(exc, cls) });

        if (cls.transient && this.attempt <= maxRetries) {
          const delay = baseDelay * 2 ** (this.attempt - 1) + Math.random();
          await this.event("RETRY", `${cls.category}: retrying in ${delay.toFixed(1)}s`, { category: cls.category, context: { delay_sec: +delay.toFixed(1) } });
          clock.advance(delay);
          await pause(500);
          continue;
        }

        if (cls.healable && this.healer && heals < maxHeals) {
          heals += 1;
          if (await this.heal(cls)) { healed = true; continue; }
        }

        this.writeRun("FAILED", { cls, exc, healed });
        await this.alertFailure(cls, exc);
        return { status: "FAILED", cls };
      }
      const status = healed ? "HEALED" : "SUCCESS";
      this.writeRun(status, { healed });
      await this.event("INFO", `job finished: ${status}`, { context: this.metrics });
      return { status, anomalies: await this.checkHealth() };
    }
  }

  async heal(cls) {
    let actions;
    try {
      clock.advance(2.5);   // schema lookup, dry run, DDL
      actions = this.healer.heal(cls, this.context);
    } catch (exc) {
      await this.event("ERROR", `healer crashed: ${exc.message}`, { exc, category: "HEALER_ERROR" });
      return false;
    }
    for (const a of actions) await this.recordAction(a, cls);
    const applied = actions.some((a) => a.status === "APPLIED");
    const msg = applied ? "fix applied, re-running job"
      : actions.length ? "fix proposed, waiting for approval"
      : "no automatic fix available";
    await this.event("HEAL", msg, { category: cls.category });
    return applied;
  }

  // Flag a good run that was slow, missed its SLA or moved an unusual number of rows.
  async checkHealth() {
    const found = checkRun({
      durationSec: (clock.now() - this.t0) / 1000, rowsWritten: this.metrics.rows_written,
      base: baseline(this.jobName, this.runId), slaSeconds: this.slaSeconds,
    });
    for (const a of found) await this.event("ANOMALY", a.message, { category: a.kind });
    if (found.length) await this.notify({ kind: "ANOMALY", title: "finished, but something looks wrong", details: found.map((a) => a.message) });
    return found;
  }

  async alertFailure(cls, exc) {
    const waiting = this.actions.filter((a) => a.status === "PROPOSED" && a.sql);
    const details = [`${cls.category}: ${exc.message.slice(0, 300)}`, ...waiting.map((a) => `[${a.risk}] ${a.reason}`)];
    if (waiting.length) await this.notify({ kind: "NEEDS_APPROVAL", title: `failed; ${waiting.length} fix(es) waiting for approval`, details });
    else await this.notify({ kind: "FAILED", title: `failed: ${cls.category}`, details });
  }

  async notify(alert) {
    if (!this.notifier) return;
    this.notifier({ ...alert, jobName: this.jobName, runId: this.runId });
    await this.event("NOTIFY", `alert sent: ${alert.title}`, { category: alert.kind });
  }

  async recordAction(a, cls) {
    this.actions.push(a);
    db.healing_actions.push({
      action_id: uuid(), run_id: this.runId, job_name: this.jobName, created_at: iso(),
      error_category: cls.category, target_table: a.target, column_name: a.column,
      proposed_sql: a.sql, risk_level: a.risk, reason: a.reason, status: a.status,
      applied_by: a.status === "APPLIED" ? "auto-healer" : null, result_message: a.result,
    });
    await this.event("HEAL", `[${a.risk}/${a.status}] ${a.reason}`, { category: cls.category, context: { sql: a.sql } });
  }

  failureContext(exc, cls) {
    return { failed_step: this.failedStep, classification: cls.details, job_context: this.context, api_errors: exc.errors || null, metrics: this.metrics };
  }

  writeRun(status, { cls = null, exc = null, healed = false } = {}) {
    const done = status !== "RUNNING";
    db.job_runs.push({
      run_id: this.runId, recorded_at: iso(), job_name: this.jobName, pipeline: this.pipeline,
      environment: "demo", status, attempt: this.attempt, started_at: this.startedAt,
      ended_at: done ? iso() : null, duration_sec: done ? +((clock.now() - this.t0) / 1000).toFixed(3) : null,
      rows_read: this.metrics.rows_read, rows_written: this.metrics.rows_written,
      error_category: cls?.category || null, error_message: exc ? exc.message.slice(0, 10000) : null, healed,
    });
    ui.renderTable();
    ui.setStats(status, this.attempt, done ? (clock.now() - this.t0) / 1000 : null);
  }
}

// The job itself: the same shape as example_job.py.
function makeJob(sc) {
  return async (mon) => {
    await mon.withStep("extract", async () => {
      clock.advance(1.2 + Math.random());
      mon.metrics.rows_read = sc.rows ?? 41208;
    });
    // What the healer needs to reason about a schema failure.
    mon.context.target_table = TABLE_ID;
    mon.context.source_schema = { ...(sc.source || SOURCE) };
    await mon.withStep("load", async () => {
      clock.advance((18 + Math.random() * 10) * (sc.slow || 1));
      mon.metrics.rows_written = loadTable(sc, mon.attempt);
    });
  };
}

/* ---------- UI ---------- */

const $ = (id) => document.getElementById(id);
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const allowedDatasets = () => new Set($("allowed").value.split(",").map((s) => s.trim()).filter(Boolean));
const fmtSec = (s) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);
const PILL = {
  SUCCESS: "p-ok", HEALED: "p-heal", FAILED: "p-fail", RUNNING: "p-wait",
  SAFE: "p-ok", NEEDS_APPROVAL: "p-wait", ADVISORY: "p-dim", BLOCKED: "p-fail",
  APPLIED: "p-ok", PROPOSED: "p-wait", SKIPPED: "p-dim",
};
const pill = (v) => el("span", `pill ${PILL[v] || "p-dim"}`, v);
const awaitsApproval = (a) => a.status === "PROPOSED" && Boolean(a.proposed_sql);

const COLUMNS = {
  job_runs: ["recorded_at", "status", "attempt", "duration_sec", "rows_written", "error_category", "healed", "error_message"],
  job_events: ["event_ts", "level", "step", "attempt", "message", "error_category"],
  healing_actions: ["created_at", "error_category", "column_name", "risk_level", "status", "proposed_sql", "reason", "applied_by"],
};
const WIDE = new Set(["error_message", "message", "proposed_sql", "reason"]);
const LOG_CLASS = { INFO: "i", WARNING: "a", ERROR: "f", RETRY: "a", HEAL: "a", ANOMALY: "f", NOTIFY: "i" };

const ui = {
  tab: "job_runs",
  scenario: SCENARIOS[0],

  init() {
    const list = $("scenarios");
    SCENARIOS.forEach((sc, i) => {
      const label = el("label", "scen");
      const input = el("input");
      Object.assign(input, { type: "radio", name: "scenario", value: sc.id, checked: i === 0 });
      input.addEventListener("change", () => { this.scenario = sc; });
      const text = el("span");
      text.append(el("strong", "", sc.name), el("small", "", sc.blurb));
      label.append(input, text);
      list.append(label);
    });
    $("tableId").textContent = TABLE_ID;
    seedHistory();
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => this.showTab(b.dataset.tab)));
    $("runBtn").addEventListener("click", () => this.run());
    $("resetTable").addEventListener("click", () => { resetTable(); this.renderSchema(); tools.gradeSql(); });
    $("allowed").addEventListener("input", () => tools.gradeSql());
    this.renderSchema();
    this.renderTable();
    this.logLine("", "i", "ready", "pick a scenario and press Run job");
  },

  async run() {
    const btn = $("runBtn");
    btn.disabled = true;
    $("outcome").hidden = true;
    $("slack").hidden = true;
    $("monLog").replaceChildren();
    $("liveTag").textContent = "running";
    $("liveTag").classList.remove("idle");
    const sc = this.scenario;
    const mon = new JobMonitor("load_orders", {
      pipeline: "sales_daily",
      params: { ds: clock.now().toISOString().slice(0, 10), scenario: sc.id },
      healer: new Healer({ allowedDatasets: allowedDatasets(), autoApply: $("autoApply").checked }),
      slaSeconds: (parseFloat($("sla").value) || 0) * 60 || null,
      notifier: $("alerts").checked ? (alert) => this.showAlert(alert) : null,
    });
    try {
      const result = await mon.run(makeJob(sc));
      this.showOutcome(result, mon);
    } catch (err) {
      console.error(err);
      this.logLine(hms(clock.now()), "f", "demo", `something went wrong in the demo: ${err.message}`);
    } finally {
      this.renderSchema();
      tools.gradeSql();
      btn.disabled = false;
      $("liveTag").textContent = "idle";
      $("liveTag").classList.add("idle");
    }
  },

  showOutcome({ status, cls, anomalies = [] }, mon) {
    const actions = db.healing_actions.filter((a) => a.run_id === mon.runId);
    const waiting = actions.filter(awaitsApproval);
    const skipped = actions.filter((a) => a.status === "SKIPPED");
    let text;
    if (status === "SUCCESS") text = mon.attempt > 1
      ? `Succeeded on attempt ${mon.attempt}. The transient error was retried with exponential backoff, and nobody was paged.`
      : "Succeeded first time. One RUNNING row and one SUCCESS row were written to job_runs.";
    else if (status === "HEALED") {
      const n = actions.filter((a) => a.status === "APPLIED").length;
      text = n > 1
        ? `Healed. ${n} safe fixes were dry-run and applied in one pass, and the job re-ran successfully. The changes are logged in healing_actions.`
        : "Healed. The fix passed the safety rules, was dry-run and applied, and the job re-ran successfully. The change is logged in healing_actions.";
    }
    else if (waiting.some((a) => a.risk_level === "NEEDS_APPROVAL")) text = "Failed, with a fix waiting for approval. It changes data or the table contract, so it never runs on its own. Review and approve it in healing_actions, then run the job again.";
    else if (waiting.length) text = "Failed, with a safe fix waiting for approval because auto-apply is off. Approve it in healing_actions, then run the job again.";
    else if (skipped.length) text = "Failed. A safe fix was found but skipped because the dataset is not in the allow-list.";
    else if (actions.length) text = `Failed: ${cls.category}. ${actions[0].reason}`;
    else text = `Failed: ${cls.category}. SQL can't fix this one. In production, the log-analysis agent picks up this run within 15 minutes, investigates with read-only tools and tells a person what to do.`;
    if (anomalies.length) {
      text = `${status === "HEALED" ? "Healed" : "Succeeded"}, but the health check flagged the run against the last ${baseline(mon.jobName, mon.runId).runs} good runs: ` +
        anomalies.map((a) => a.message).join("; ") + ".";
    }
    if (mon.notifier && (status === "FAILED" || anomalies.length)) text += " An alert went to #data-alerts.";
    else if (status === "FAILED" || anomalies.length) text += " Alerts are off, so nobody was told.";
    const out = $("outcome");
    out.textContent = text;
    out.className = `outcome ${anomalies.length ? "anomaly" : status.toLowerCase()}`;
    out.hidden = false;
    if (waiting.length) this.showTab("healing_actions");
  },

  showAlert({ kind, title, details, jobName, runId }) {
    const box = $("slack");
    const icon = { FAILED: "🔴", NEEDS_APPROVAL: "🔵", ANOMALY: "🟡" }[kind] || "";
    const body = el("div", "slack-body");
    const head = el("p");
    head.append(`${icon} `, el("b", "", jobName), `: ${title}`);
    body.append(head, ...details.slice(0, 10).map((d) => el("p", "", `• ${d}`)), el("p", "slack-run", `run_id ${runId}`));
    box.replaceChildren(el("p", "slack-head", "#data-alerts · Agent M"), body);
    box.hidden = false;
  },

  logEvent(row) {
    const extra = row.level === "ERROR" && row.error_category ? `  [${row.error_category}]` : "";
    this.logLine(hms(new Date(row.event_ts)), LOG_CLASS[row.level] || "i", row.level.toLowerCase(), row.message + extra);
    this.renderTable();
  },

  logLine(time, cls, tag, message) {
    const line = el("span", "ln");
    if (time) line.append(el("span", "t", time), " ");
    line.append(el("span", cls, tag.padEnd(7)), " ", el("span", cls === "f" ? "f" : "w", message));
    const log = $("monLog");
    log.append(line);
    log.scrollTop = log.scrollHeight;
  },

  setStats(status, attempts, seconds) {
    $("statStatus").textContent = status.toLowerCase();
    $("statAttempts").textContent = attempts || "—";
    $("statTime").textContent = seconds == null ? "…" : fmtSec(seconds);
  },

  showTab(name) {
    this.tab = name;
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    this.renderTable();
  },

  renderTable() {
    const rows = db[this.tab];
    const cols = COLUMNS[this.tab];
    $("rowCount").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
    const view = $("tableView");
    if (!rows.length) {
      view.replaceChildren(el("p", "empty", "No rows yet. Run the job to write some."));
      return;
    }
    const tbl = el("table");
    const head = el("tr");
    if (this.tab === "healing_actions") head.append(el("th", "", "approval"));
    cols.forEach((c) => head.append(el("th", "", c)));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    for (const row of [...rows].reverse()) {   // newest first
      const tr = el("tr");
      if (this.tab === "healing_actions") {
        const td = el("td");
        if (awaitsApproval(row)) {
          const b = el("button", "copy-btn approve", "Approve & apply");
          b.type = "button";
          b.addEventListener("click", () => this.approve(row));
          td.append(b);
        } else td.textContent = "—";
        tr.append(td);
      }
      for (const c of cols) {
        const v = row[c];
        const td = el("td", WIDE.has(c) ? "mono wide" : /(_at|_ts)$/.test(c) ? "mono" : "");
        if (["status", "risk_level"].includes(c) && v) td.append(pill(v));
        else if (/(_at|_ts)$/.test(c) && v) td.textContent = stamp(new Date(v));
        else td.textContent = v == null || v === "" ? "—" : String(v);
        tr.append(td);
      }
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    view.replaceChildren(tbl);
  },

  approve(row) {
    try {
      runDDL(row.proposed_sql, { dryRun: true });
      runDDL(row.proposed_sql);
      Object.assign(row, { status: "APPLIED", applied_by: "you (approved)", result_message: "ok" });
      this.logLine(hms(clock.now()), "ok", "ok", `approved fix applied to ${row.target_table}. Run the job again.`);
    } catch (exc) {
      Object.assign(row, { status: "FAILED", result_message: exc.message });
      this.logLine(hms(clock.now()), "f", "fail", `fix could not be applied: ${exc.message}`);
    }
    this.renderSchema();
    this.renderTable();
    tools.gradeSql();
  },

  renderSchema() {
    $("schema").replaceChildren(...table.schema.map((f) => {
      const li = el("li", table.changed.has(f.name.toLowerCase()) ? "changed" : "");
      li.append(el("span", "", f.name), el("span", "", f.type + (f.mode === "REQUIRED" ? " · REQUIRED" : "")));
      return li;
    }));
  },
};

/* ---------- Stand-alone tools ---------- */

const CLS_PRESETS = [
  ["Type drift", "BadRequest", `400 Provided Schema does not match Table ${TABLE_REF}. Field amount has changed type from INTEGER to FLOAT`],
  ["Quota", "Forbidden", "403 Exceeded rate limits: too many table update operations for this table."],
  ["Bad value", "BadRequest", "400 Could not parse 'N/A' as INT64 for field qty (position 3) starting at location 1182"],
  ["Permission", "Forbidden", `403 Access Denied: Table ${TABLE_REF}: Permission bigquery.tables.updateData denied`],
  ["Timeout", "TimeoutError", "The read operation timed out"],
  ["Python bug", "KeyError", "'customer_id'"],
];

const SQL_PRESETS = [
  ["Add column", `ALTER TABLE \`${TABLE_ID}\` ADD COLUMN IF NOT EXISTS \`discount_pct\` FLOAT64;`],
  ["Widen", `ALTER TABLE \`${TABLE_ID}\` ALTER COLUMN \`qty\` SET DATA TYPE NUMERIC;`],
  ["Narrow", `ALTER TABLE \`${TABLE_ID}\` ALTER COLUMN \`qty\` SET DATA TYPE STRING;`],
  ["Drop NOT NULL", `ALTER TABLE \`${TABLE_ID}\` ALTER COLUMN \`order_id\` DROP NOT NULL;`],
  ["Rebuild table", `CREATE OR REPLACE TABLE \`${TABLE_ID}\` AS SELECT * FROM \`${TABLE_ID}\`;`],
  ["Other dataset", `ALTER TABLE \`${PROJECT}.finance.gl\` ADD COLUMN \`memo\` STRING;`],
];

const NEXT = {
  transient: "Retry as-is with exponential backoff, up to 3 times.",
  healable: "Hand it to the healer, which diffs schemas and proposes a fix.",
  neither: "Mark the run FAILED. The log-analysis agent investigates it and tells a person what to do.",
};

function setResult(dl, pairs) {
  dl.replaceChildren(...pairs.flatMap(([k, v]) => {
    const dd = el("dd");
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    return [el("dt", "", k), dd];
  }));
}

function presetButtons(container, presets, onPick) {
  container.replaceChildren(...presets.map((p) => {
    const b = el("button", "chip-btn", p[0]);
    b.type = "button";
    b.addEventListener("click", () => onPick(p));
    return b;
  }));
}

const tools = {
  init() {
    presetButtons($("clsPresets"), CLS_PRESETS, ([, type, msg]) => { $("clsType").value = type; $("clsText").value = msg; this.classify(); });
    presetButtons($("sqlPresets"), SQL_PRESETS, ([, sql]) => { $("sqlText").value = sql; this.gradeSql(); });
    $("clsText").addEventListener("input", () => this.classify());
    $("clsType").addEventListener("change", () => this.classify());
    $("sqlText").addEventListener("input", () => this.gradeSql());
    $("clsType").value = CLS_PRESETS[0][1];
    $("clsText").value = CLS_PRESETS[0][2];
    $("sqlText").value = SQL_PRESETS[0][1];
    this.classify();
    this.gradeSql();
  },

  classify() {
    const text = $("clsText").value.trim();
    if (!text) { setResult($("clsResult"), [["category", "—"]]); return; }
    const exc = Object.assign(new Error(text), { type: $("clsType").value });
    const c = classify(exc);
    const details = Object.keys(c.details).length ? JSON.stringify(c.details) : "—";
    setResult($("clsResult"), [
      ["category", pill(c.category)],
      ["transient", c.transient ? "yes" : "no"],
      ["healable", c.healable ? "yes" : "no"],
      ["details", details],
      ["next step", NEXT[c.transient ? "transient" : c.healable ? "healable" : "neither"]],
    ]);
  },

  gradeSql() {
    let v;
    try {
      v = grade($("sqlText").value, allowedDatasets());
    } catch (exc) {
      v = { risk: "ERROR", reason: exc.message };
    }
    setResult($("sqlResult"), [
      ["verdict", pill(v.risk)],
      ["reason", v.reason],
      ["runs alone?", v.risk === "SAFE" ? "Yes, after a dry run." : "No. A person decides."],
    ]);
  },
};

resetTable();
ui.init();
tools.init();
