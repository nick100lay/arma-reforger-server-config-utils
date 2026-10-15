#!/usr/bin/env node
// Validate an Arma Reforger dedicated server config.
//
//   node tools/validate-server-config.mjs <config.json> [--json] [--lenient] [--quiet]
//                                           [--out <report.json>]
//
// Two layers, deliberately kept apart:
//
//   1. schemas/server.schema.json, interpreted here by a small draft-2020-12 subset
//      (type, required, properties, additionalProperties, items, enum, const,
//       minimum/maximum, minLength/maxLength, pattern, minItems/maxItems,
//       uniqueItems, allOf/anyOf/oneOf/not, local $ref). The schema alone decides
//      what is structurally wrong, so there is exactly one source of truth for shapes.
//   2. Checks no JSON Schema can express: scenario GUID lookup against
//      data/scenarios.json, the pre-0.9.8.73 field names, missionHeader class
//      membership against data/mission-header-fields.json, and platform combinations.
//
// SEVERITY POLICY (why not everything is an error)
//   The game does not refuse to start for every wrong value. It clamps a bad port
//   ("[A2S] Invalid port, set to default=17777...") with a log line. Those are reported
//   as WARNING. Values that make the server end by itself are ERROR — that includes
//   game.name, whose length the schema bounds: an empty name or one longer than 100
//   characters is rejected with a message naming the limit, not cropped. Verified by
//   running 1.8.0.13 with tools/probe-config-schema.mjs (guide §5.4 and §9).
//
// Exit code: 0 — no errors, 1 — errors found, 2 — could not read or parse the config.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const opts = {
  json: argv.includes("--json"),
  lenient: argv.includes("--lenient"),
  quiet: argv.includes("--quiet"),
  out: flagValue("--out"),
  help: argv.includes("--help") || argv.includes("-h"),
};
const VALUE_FLAGS = ["--out"];
const file = argv.find((a, i) => !a.startsWith("-") && !VALUE_FLAGS.includes(argv[i - 1]));

if (opts.help || !file) {
  console.log(`usage: node tools/validate-server-config.mjs <config.json> [--json] [--lenient] [--quiet] [--out report.json]

  --json      machine-readable report on stdout
  --out FILE  also write the JSON report to FILE (used by the test suite)
  --lenient   treat unknown keys as warnings (use for a config known to work)
  --quiet     print only the summary line

exit: 0 valid, 1 errors, 2 unreadable/unparsable config`);
  process.exit(opts.help ? 0 : 2);
}

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const schema = readJson("schemas/server.schema.json");
const SCEN = readJson("data/scenarios.json");
const MH = readJson("data/mission-header-fields.json");
const BUILD = readJson("data/build.json");

// ------------------------------------------------------------------ report sink
const findings = [];
const add = (severity, path, message) => findings.push({ severity, path: path || "/", message });

// ------------------------------------------------------------------ JSON Schema
const typeOf = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
};
const typeMatches = (v, want) =>
  want === "number" ? ["number", "integer"].includes(typeOf(v)) : typeOf(v) === want;
const show = (v) => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + "..." : s;
};

/**
 * Field names from before 0.9.8.73. They are gone from the 1.6.0.119 binary entirely.
 * Scoped, because `passwordAdmin` is the CORRECT name inside `game` and only an old one
 * at the root — a scope-blind check would reject every valid config.
 *
 * `dedicatedServerId` and `region` used to be listed here. Running the server on 1.8.0.13 with
 * each key set reached `JSON is Valid`, so the schema accepts them: they are undocumented
 * fields, not obsolete names. Reporting them as errors was a false positive on a valid config.
 * See docs/en/ArmaReforger_ServerConfig_EN.md §5.1 and tools/probe-config-schema.mjs.
 */
const LEGACY_ROOT = {
  gameHostBindAddress: "bindAddress",
  gameHostBindPort: "bindPort",
  gameHostRegisterBindAddress: "publicAddress",
  gameHostRegisterPort: "publicPort",
  passwordAdmin: "game.passwordAdmin",
  playerCountLimit: "game.maxPlayers",
  supportedGameClientTypes: "game.supportedPlatforms",
  a2sQueryEnabled: "the a2s object",
  steamQueryPort: "a2s.port",
};
/**
 * The four names whose absence from the pinned build's binary the documents actually
 * established. For every other old name the claim is only "documented as the previous name",
 * which is what the report says — asserting more than the documents support is exactly the
 * kind of overclaim this repository exists to avoid.
 */
const VERIFIED_ABSENT_LEGACY = new Set([
  "gameHostBindAddress",
  "gameHostBindPort",
  "gameHostRegisterBindAddress",
  "gameHostRegisterPort",
]);
const LEGACY_GAME = {
  playerCountLimit: "maxPlayers",
  supportedGameClientTypes: "supportedPlatforms",
};
/** The replacement for an old name at a given scope ("" = root, "/game" = inside game). */
const legacyAt = (scope, key) => (scope === "/game" ? LEGACY_GAME[key] : scope === "" ? LEGACY_ROOT[key] : undefined);

/** Paths whose out-of-range values the server clamps with a log line instead of refusing. */
const WARN_GRADE = [
  { path: /^\/a2s\/port$/, keywords: ["minimum", "maximum"] },
  { path: /^\/rcon\/port$/, keywords: ["minimum", "maximum"] },
];
/** Per-path hints that turn a raw keyword failure into something actionable. */
const HINTS = [
  [/^\/game\/scenarioId$/, "must look like {16 hex}Missions/Name.conf — never invent the GUID, take the string from data/scenarios.json"],
  [/^\/game\/mods\/\d+\/modId$/, "exactly 16 hex characters, braces stripped — the GUID from addon.gproj, not the project ID"],
  [/^\/rcon\/password$/, "no spaces, at least 3 characters"],
  [/^\/game\/passwordAdmin$/, "no spaces"],
  [/^\/game\/name$/, "1..100 characters — the server rejects an empty name and a name longer than 100 characters, it does not crop one"],
];
const hintFor = (path) => HINTS.find(([re]) => re.test(path))?.[1] ?? null;

function resolveRef(ref) {
  if (!ref.startsWith("#/")) return null;
  let node = schema;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node ?? null;
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function severityFor(path, keyword) {
  const rule = WARN_GRADE.find((r) => r.path.test(path) && r.keywords.includes(keyword));
  return rule ? "warning" : "error";
}

/**
 * Validate `value` against `node`, appending findings at `path`.
 * `depth` guards against a malformed schema causing infinite recursion.
 */
function check(node, value, path, depth = 0) {
  if (node == null || node === true || depth > 40) return;
  if (node === false) return report("false", path, "no value is allowed here");

  if (node.$ref) {
    const target = resolveRef(node.$ref);
    if (!target) return report("$ref", path, `unresolvable $ref ${node.$ref}`);
    check(target, value, path, depth + 1);
    return;
  }

  // --- combinators ---------------------------------------------------------
  if (node.not) {
    const probe = [];
    collect(node.not, value, path, probe);
    if (probe.length === 0) report("not", path, "value matches a forbidden shape");
  }
  if (node.allOf) for (const sub of node.allOf) check(sub, value, path, depth + 1);
  for (const [keyword, need] of [["anyOf", 1], ["oneOf", 1]]) {
    if (!node[keyword]) continue;
    const passed = node[keyword].filter((sub) => {
      const probe = [];
      collect(sub, value, path, probe);
      return probe.length === 0;
    }).length;
    if (passed < need) {
      report(keyword, path, `value ${show(value)} does not match ${keyword === "anyOf" ? "any" : "one"} of the allowed shapes`);
    } else if (keyword === "oneOf" && passed > 1) {
      report("oneOf", path, `value ${show(value)} matches ${passed} mutually exclusive shapes`);
    }
  }

  // --- type ----------------------------------------------------------------
  if (node.type !== undefined) {
    const wanted = Array.isArray(node.type) ? node.type : [node.type];
    if (!wanted.some((w) => typeMatches(value, w))) {
      return report("type", path, `expected ${wanted.join(" or ")}, got ${typeOf(value)} (${show(value)})`);
    }
  }

  // --- value-level keywords (dispatched on the actual kind) ----------------
  const kind = typeOf(value);

  if (kind === "string") {
    if (node.minLength !== undefined && value.length < node.minLength)
      report("minLength", path, `"${value}" is ${value.length} characters, minimum is ${node.minLength}`);
    if (node.maxLength !== undefined && value.length > node.maxLength)
      report("maxLength", path, `"${value}" is ${value.length} characters, maximum is ${node.maxLength}`);
    if (node.pattern && !new RegExp(node.pattern).test(value))
      report("pattern", path, `"${value}" does not match /${node.pattern}/`);
  }

  if (kind === "number" || kind === "integer") {
    if (node.type === "integer" && kind !== "integer")
      report("type", path, `expected an integer, got ${value}`);
    if (node.minimum !== undefined && value < node.minimum)
      report("minimum", path, `${value} is below the minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum)
      report("maximum", path, `${value} is above the maximum ${node.maximum}`);
  }

  if (kind === "array") {
    if (node.minItems !== undefined && value.length < node.minItems)
      report("minItems", path, `${value.length} items, minimum is ${node.minItems}`);
    if (node.maxItems !== undefined && value.length > node.maxItems)
      report("maxItems", path, `${value.length} items, maximum is ${node.maxItems}`);
    if (node.uniqueItems) {
      const seen = new Map();
      value.forEach((v, i) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) report("uniqueItems", `${path}/${i}`, `duplicates the item at index ${seen.get(k)}`);
        else seen.set(k, i);
      });
    }
    if (node.items) value.forEach((v, i) => check(node.items, v, `${path}/${i}`, depth + 1));
  }

  if (kind === "object") {
    for (const key of node.required ?? []) {
      if (!(key in value)) report("required", `${path}/${key}`, "required key is missing");
    }
    const props = node.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      const child = `${path}/${key}`;
      if (props[key]) {
        check(props[key], v, child, depth + 1);
        continue;
      }
      if (node.additionalProperties === false) {
        // A pre-0.9.8.73 field name is reported by checkLegacyKeys() with its replacement,
        // which is far more useful than "unknown key" — do not report it twice.
        if (legacyAt(path, key)) continue;
        const known = Object.keys(props);
        const ci = known.find((k) => k.toLowerCase() === key.toLowerCase());
        const near = known
          .map((k) => [k, levenshtein(k, key)])
          .filter(([, d]) => d <= 2)
          .sort((a, b) => a[1] - b[1])[0];
        const guess = ci ? `did you mean "${ci}"? Key names are case-sensitive` : near ? `did you mean "${near[0]}"?` : null;
        report(
          "additionalProperties",
          child,
          `unknown key${guess ? " — " + guess : ""}`,
          opts.lenient ? "warning" : "error"
        );
      } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
        check(node.additionalProperties, v, child, depth + 1);
      }
    }
  }

  if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) {
    report("const", path, `must be exactly ${show(node.const)}, got ${show(value)}`);
  }
  if (node.enum && !node.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    report("enum", path, `must be one of: ${node.enum.map(show).join(", ")} (got ${show(value)})`);
  }

  function report(keyword, at, message, severity) {
    // The anyOf failure for grass distance is unreadable on its own, and this value has a
    // dedicated rule (section 4 rule 4), so it gets a plain-language message.
    let text = at.endsWith("/gameProperties/serverMinGrassDistance")
      ? `only 0 or 50..150 is allowed; values 1..49 are not (got ${show(value)})`
      : message;
    const hint = hintFor(at);
    if (hint) text += ` — ${hint}`;
    add(severity ?? severityFor(at, keyword), at, text);
  }
}

/** Same as check(), but into a throwaway sink — used to probe anyOf/oneOf/not. */
function collect(node, value, path, sink) {
  const savedLength = findings.length;
  check(node, value, path);
  sink.push(...findings.splice(savedLength));
}

// ------------------------------------------------------------- semantic checks
function checkLegacyKeys(cfg) {
  for (const [scope, obj] of [["", cfg], ["/game", cfg.game]]) {
    if (!obj || typeof obj !== "object") continue;
    for (const key of Object.keys(obj)) {
      const replacement = legacyAt(scope, key);
      if (replacement) {
        add(
          "error",
          `${scope}/${key}`,
          `field name from before 0.9.8.73 — use ${replacement} instead. ` +
            (VERIFIED_ABSENT_LEGACY.has(key)
              ? "Verified against the binary of the pinned build: this string does not occur in it at all"
              : "The old name is not evidence either way — it can survive in unrelated code — but the current name is correct on every build")
        );
      }
    }
  }
}

function checkScenario(cfg) {
  const id = cfg.game?.scenarioId;
  if (typeof id !== "string") return;
  const m = /^\{([0-9A-Fa-f]{16})\}(.+)$/.exec(id);
  // A malformed string is already reported by the schema's pattern check — do not repeat it.
  if (!m) return;
  const guid = m[1].toUpperCase();
  const path = m[2];
  const idx = SCEN.byGuid[guid];
  const rec = typeof idx === "number" ? SCEN.scenarios[idx] : null;

  if (!rec) {
    add(
      "warning",
      "/game/scenarioId",
      `GUID ${guid} is not one of the ${SCEN.counts.total} vanilla scenarios in data/scenarios.json. ` +
        `That is correct only for a mod mission, where the GUID comes from <Mission>.conf.meta (field Name). ` +
        `If you meant a vanilla mission, look the string up rather than typing it`
    );
    return;
  }
  if (rec.path !== path) {
    add(
      "error",
      "/game/scenarioId",
      `GUID ${guid} belongs to "${rec.path}" (${rec.name}), not to "${path}" — the string was assembled from two different scenarios`
    );
  } else {
    add("note", "/game/scenarioId", `resolves to "${rec.name}"${rec.map ? ` (map ${rec.map}` + (rec.mapCodename ? `, codename ${rec.mapCodename}` : "") + ")" : ""}`);
  }
}

function checkMissionHeader(cfg) {
  const mh = cfg.game?.gameProperties?.missionHeader;
  if (!mh || typeof mh !== "object" || Array.isArray(mh)) return;

  const baseKeys = new Set(MH.allowedByClass["SCR_MissionHeader"] ?? []);
  const campaignKeys = new Set(MH.allowedByClass["SCR_MissionHeaderCampaign"] ?? []);
  const nested = new Map(MH.nestedTypes.map((f) => [f.key, f.className]));
  const known = new Set(MH.fields.map((f) => f.key));

  const id = cfg.game?.scenarioId;
  const scenPath = typeof id === "string" ? /^\{[0-9A-Fa-f]{16}\}(.+)$/.exec(id)?.[1] : null;
  const cls = SCEN.scenarioHeaderClasses.find((s) => s.scenarioFile === scenPath)?.className ?? null;

  if (!cls) {
    add(
      "note",
      "/game/gameProperties/missionHeader",
      `the header class of this scenario is not documented (only ${SCEN.scenarioHeaderClasses
        .map((s) => s.className)
        .join(", ")} are), so keys were checked only against the union of documented classes`
    );
  }

  for (const key of Object.keys(mh)) {
    const at = `/game/gameProperties/missionHeader/${key}`;
    if (baseKeys.has(key)) continue;
    if (nested.has(key)) {
      add("warning", at, `this is a nested field of ${nested.get(key)} (inside its array), not a top-level missionHeader key — it will be ignored`);
      continue;
    }
    if (campaignKeys.has(key)) {
      if (cls === "SCR_MissionHeaderCampaign") continue;
      add(
        "warning",
        at,
        cls
          ? `this field belongs to SCR_MissionHeaderCampaign, while this scenario uses ${cls} — it is silently ignored`
          : "this field belongs to SCR_MissionHeaderCampaign (Conflict) — it is silently ignored by any other game mode"
      );
      continue;
    }
    if (!known.has(key)) {
      add("warning", at, "not a documented missionHeader key — check data/mission-header-fields.json before relying on it");
    }
  }
}

const PLATFORMS = ["PLATFORM_PC", "PLATFORM_XBL", "PLATFORM_PSN"];
function checkPlatforms(cfg) {
  const p = cfg.game?.supportedPlatforms;
  if (!Array.isArray(p) || !p.length) return;
  const has = (x) => p.includes(x);
  const modded = Array.isArray(cfg.game?.mods) && cfg.game.mods.length > 0;
  const key = [...p].sort().join("+");
  const vanillaOk = ["PLATFORM_PC", "PLATFORM_PC+PLATFORM_PSN+PLATFORM_XBL"].includes(key);
  const moddedOk = "PLATFORM_PC+PLATFORM_XBL";
  if (has("PLATFORM_PSN") && modded) {
    add("warning", "/game/supportedPlatforms", "PlayStation is never added on a server with mods — remove PLATFORM_PSN");
  } else if (key === moddedOk && !modded) {
    add("error", "/game/supportedPlatforms", "PC + Xbox is valid only on a modded server; a vanilla server accepts PC alone or PC + both consoles");
  } else if (!vanillaOk && !(key === moddedOk && modded)) {
    add("error", "/game/supportedPlatforms", `combination ${key} is not allowed — see the table in section 5.5.1`);
  }
}

const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
function checkOperational(cfg) {
  if (!cfg.game) {
    add("warning", "/game", "no game section — the server would have nothing to load");
  } else if (cfg.game.scenarioId === undefined) {
    add(
      "warning",
      "/game/scenarioId",
      "absent — the server has no scenario to load unless -server is passed, and -server ignores the config"
    );
  }

  const gp = cfg.game?.gameProperties;
  if (gp && gp.fastValidation === false) {
    add(
      "warning",
      "/game/gameProperties/fastValidation",
      "false on a server that clients reach over the internet — BI calls true mandatory here; false is for local development only"
    );
  }

  const pa = cfg.publicAddress;
  if (typeof pa === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(pa) && !/^127\./.test(pa) && pa !== "0.0.0.0") {
    if (isPrivate(pa)) {
      add(
        "warning",
        "/publicAddress",
        `${pa} is a private address — it would be registered with the backend as the public one, and outside players could not reach the server`
      );
    } else {
      add(
        "warning",
        "/publicAddress",
        `a public IP is pinned here — joining from the server's own LAN then breaks unless the router does NAT hairpin (loopback). ` +
          `Leaving publicAddress empty lets the server detect it; do not "fix" this with -bindIP, which overrides both addresses`
      );
    }
  }

  if (cfg.rcon && cfg.rcon.address === "0.0.0.0") {
    add(
      "warning",
      "/rcon/address",
      "RCON on 0.0.0.0 is reachable from anywhere and grants full control (kick, ban, restart, shutdown) behind the password alone — bind 127.0.0.1"
    );
  }

  for (const k of ["bindAddress", "bindPort", "publicAddress", "publicPort"]) {
    if (cfg[k] !== undefined && !(k === "publicAddress" && cfg[k] === "")) {
      add("note", `/${k}`, "generally best omitted — the server auto-detects these; set them only for unusual port forwarding");
    }
  }

  const mods = cfg.game?.mods;
  if (Array.isArray(mods)) {
    const seen = new Map();
    mods.forEach((m, i) => {
      const id = m?.modId;
      if (typeof id !== "string") return;
      if (seen.has(id)) add("warning", `/game/mods/${i}/modId`, `duplicates the modId at index ${seen.get(id)}`);
      else seen.set(id, i);
    });
  }
}

// ------------------------------------------------------------------- run + out
let text;
try {
  text = readFileSync(resolve(file), "utf8");
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(2);
}
let config;
try {
  config = JSON.parse(text);
} catch (e) {
  console.error(`${file} is not valid JSON: ${e.message}`);
  console.error("Syntax-check it first (e.g. `jq .`). Flat JSON only: no comments, no trailing commas, no single quotes.");
  process.exit(2);
}

check(schema, config, "");
checkLegacyKeys(config);
checkScenario(config);
checkMissionHeader(config);
checkPlatforms(config);
checkOperational(config);

const order = { error: 0, warning: 1, note: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
const by = (s) => findings.filter((f) => f.severity === s);
const counts = { error: by("error").length, warning: by("warning").length, note: by("note").length };

const DOCS =
  "docs/en/ArmaReforger_ServerConfig_EN.md §9 (symptom table) and §5 (parameter reference); " +
  "scenario GUIDs: data/scenarios.json; missionHeader keys: data/mission-header-fields.json";

const report = {
  file,
  build: BUILD.build,
  engine: BUILD.engine,
  valid: counts.error === 0,
  counts,
  findings,
  references: DOCS,
};
if (opts.out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2) + "\n");
}

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (!opts.quiet) {
    console.log(`${file} — Arma Reforger ${BUILD.build} (engine ${BUILD.engine})`);
    if (!findings.length) console.log("no findings");
    for (const severity of ["error", "warning", "note"]) {
      const list = by(severity);
      if (!list.length) continue;
      console.log(`\n${severity.toUpperCase()} (${list.length})`);
      for (const f of list) console.log(`  ${f.path}\n      ${f.message}`);
    }
    if (findings.length) console.log(`\nreferences: ${DOCS}`);
  }
  console.log(
    `\n${counts.error === 0 ? "OK" : "INVALID"} — ${counts.error} error(s), ${counts.warning} warning(s), ${counts.note} note(s)` +
      (counts.error === 0 ? " (the game's own check is the log line `JSON is Valid`)" : "")
  );
}

process.exit(counts.error ? 1 : 0);
