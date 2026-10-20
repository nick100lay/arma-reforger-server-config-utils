#!/usr/bin/env node
// Check the base catalogue in docs/en/ArmaReforger_VanillaBases_EN.md against an installed game.
//
//   node tools/verify-bases.mjs [--server-dir <dir>] [--doc <file>] [--json] [--quiet]
//
// WHY THIS EXISTS. The catalogue is 168 rows of derived data: entity names, display names, a type
// and four flags, per world. Hand-writing that is how a table starts lying — one renamed entity in
// a patch and the document is wrong in a way nobody notices, because the wrongness looks like
// data. This tool re-derives every row from the installed archives and compares it with the
// document, so the catalogue is either right or a check fails.
//
// WHAT IT READS. The document's `###` sections that name a `worlds/.../*.ent` in backticks; the
// rows of the tables under them, in the two shapes the document uses:
//
//   | `EntityName` | Display name | `BASE` | yes | no | yes | yes |      a named base
//   | Display name | `Prefab.et` | no | no | no | yes | 6860 | 6781 |    a base with no entity name
//
// and compares each row with the world as the game ships it: the prefab chain of every entity that
// carries an SCR_CampaignMilitaryBaseComponent, overridden by what the world file stores. The class
// defaults of the component are the ones in its source (the `[Attribute]` decorators, lines 39-58 of
// SCR_CampaignMilitaryBaseComponent.c) — read from the archive too, not assumed, and a change there
// is reported as a difference rather than silently accepted.
//
// Exit: 0 the document agrees with the install, 1 a row disagrees, 2 no usable install or document.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openPak, findEntry } from "./pak.mjs";
import { readEbinSource, entities as ebinEntities } from "./ebin.mjs";
import { openRdbFiles } from "./rdb.mjs";
import { readStringTables } from "./loc.mjs";
import { DocumentLoader, componentsOf, lookup, formatValue } from "./etconf.mjs";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const opts = {
  json: argv.includes("--json"),
  quiet: argv.includes("--quiet"),
  help: argv.includes("--help") || argv.includes("-h"),
  doc: flagValue("--doc") ?? join("docs", "en", "ArmaReforger_VanillaBases_EN.md"),
};

const DEFAULT_DIRS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Server",
  "C:\\Program Files\\Steam\\steamapps\\common\\Arma Reforger Server",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger",
  "C:\\Program Files\\Steam\\steamapps\\common\\Arma Reforger",
];
const installDir =
  flagValue("--server-dir") ?? process.env.ARMA_REFORGER_SERVER_DIR ?? DEFAULT_DIRS.find((d) => existsSync(d));

if (opts.help) {
  console.log(`usage: node tools/verify-bases.mjs [--server-dir <dir>] [--doc <file>] [--json] [--quiet]

  --server-dir DIR   Arma Reforger install directory (or ARMA_REFORGER_SERVER_DIR); the
                     dedicated server install carries everything this needs
  --doc FILE         the document to check (default docs/en/ArmaReforger_VanillaBases_EN.md)
  --json             machine-readable report on stdout
  --quiet            print only the summary

exit: 0 agrees, 1 a row disagrees, 2 no usable install or document`);
  process.exit(0);
}

const fail = (message, code = 2) => {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: { code: code === 2 ? "INPUT" : "DRIFT", message } }, null, 2));
  else console.error(`! ${message}`);
  process.exit(code);
};

const dataDir = installDir ? join(installDir, "addons", "data") : null;
if (!dataDir || !existsSync(dataDir)) fail(`no addons/data under ${installDir ?? "(no install found)"} — pass --server-dir`);
const pakPaths = readdirSync(dataDir).filter((n) => n.endsWith(".pak")).map((n) => join(dataDir, n));
const rdbPath = join(dataDir, "resourceDatabase.rdb");
if (!existsSync(rdbPath)) fail(`${rdbPath} is missing — this does not look like an Arma Reforger install`);
if (!existsSync(opts.doc)) fail(`${opts.doc} is missing`);

// ---------------------------------------------------------------- the document
const YES = "yes";
const NO = "no";
const DASH = "\u2014";

function parseDoc(text) {
  const lines = text.split("\n");
  const worlds = [];
  let current = null;
  for (const line of lines) {
    const heading = /^###\s+\S+\s+`(worlds\/[^`]+\.ent)`/.exec(line);
    if (heading) {
      current = { world: heading[1], named: [], unnamed: [] };
      worlds.push(current);
      continue;
    }
    if (/^#{2,3}\s/.test(line) && !heading) {
      if (!/^###\s/.test(line)) current = null;
      continue;
    }
    if (!current || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const named = /^`([^`]+)`$/.exec(cells[0] ?? "");
    if (named && cells.length === 7 && /^`(BASE|RELAY|SOURCE_BASE)`$/.test(cells[2] ?? "")) {
      current.named.push({
        entity: named[1],
        display: cells[1],
        type: cells[2].replace(/`/g, ""),
        cp: cells[3] === YES,
        sh: cells[4] === YES,
        hq: cells[5] === YES,
        dis: cells[6] === YES,
      });
      continue;
    }
    const prefab = /^`([^`]+\.et)`$/.exec(cells[1] ?? "");
    const x = cells[6];
    const z = cells[7];
    if (prefab && cells.length === 8 && (x === DASH || /^\d+$/.test(x)) && (z === DASH || /^\d+$/.test(z))) {
      current.unnamed.push({
        display: cells[0],
        prefab: prefab[1],
        cp: cells[2] === YES,
        sh: cells[3] === YES,
        hq: cells[4] === YES,
        dis: cells[5] === YES,
        x: x === DASH ? null : Number(x),
        z: z === DASH ? null : Number(z),
      });
    }
  }
  return worlds;
}

// ---------------------------------------------------------------- the install
const { merged: rdb } = openRdbFiles([rdbPath]);
const loader = new DocumentLoader({ paks: [dataDir] });

/** The pak holding one world, and the entry name inside it. */
function locateWorld(worldPath) {
  for (const pakPath of pakPaths) {
    const pak = openPak(pakPath);
    let hit = null;
    try {
      hit = findEntry(pak, worldPath);
    } catch {
      hit = null;
    }
    pak.close();
    if (hit) return { pakPath, entry: hit.path };
  }
  return null;
}

/** Where a localization table lives, as a `<pak>:<entry>` source. */
function locateLocalization(name) {
  for (const pakPath of pakPaths) {
    const pak = openPak(pakPath);
    let hit = null;
    try {
      hit = findEntry(pak, `Language/localization.${name}.conf`);
    } catch {
      hit = null;
    }
    pak.close();
    if (hit) return `${pakPath}:${hit.path}`;
  }
  return null;
}

/** The class defaults, as declared by the component's own attributes. */
function readClassDefaults() {
  const wanted = "scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c";
  for (const pakPath of pakPaths) {
    const pak = openPak(pakPath);
    let entry = null;
    try {
      entry = findEntry(pak, wanted);
    } catch {
      entry = null;
    }
    if (!entry) {
      pak.close();
      continue;
    }
    const text = pak.read(entry).toString("utf8");
    pak.close();
    const defaults = {
      m_bIsControlPoint: false,
      m_bCanBeHQ: false,
      m_bDisableWhenUnusedAsHQ: true,
      m_bIsSupplyHub: false,
      m_eType: "BASE",
      m_sBaseName: "#AR-MapSymbol_Installation",
    };
    const attr = (field) => {
      // [Attribute("<def>", ...)] protected bool field;   (the default is the first argument)
      const re = new RegExp(`\\[Attribute\\("([^"]*)"[^\\]]*\\)\\][^;]*?${field}\\s*;`, "s");
      return re.exec(text)?.[1] ?? null;
    };
    for (const key of ["m_bIsControlPoint", "m_bCanBeHQ", "m_bDisableWhenUnusedAsHQ", "m_bIsSupplyHub"]) {
      const value = attr(key);
      if (value === null) return { found: false, reason: `no [Attribute] default for ${key}` };
      defaults[key] = value === "1" || value.toLowerCase() === "true";
    }
    const type = /\[Attribute\(defvalue:\s*"(\d+)"[\s\S]*?protected SCR_ECampaignBaseType m_eType;/.exec(text)?.[1];
    if (type !== undefined) defaults.m_eType = ["BASE", "RELAY", "SOURCE_BASE"][Number(type)] ?? defaults.m_eType;
    defaults.m_sBaseName = attr("m_sBaseName") ?? defaults.m_sBaseName;
    return { found: true, defaults };
  }
  return { found: false, reason: "the component source is not in any archive" };
}

const classInfo = readClassDefaults();
if (!classInfo.found) fail(`cannot read the component's class defaults: ${classInfo.reason}`);
const CLASS_DEFAULTS = classInfo.defaults;
const BOOL_KEYS = ["m_bIsControlPoint", "m_bCanBeHQ", "m_bDisableWhenUnusedAsHQ", "m_bIsSupplyHub"];
const TYPES = ["BASE", "RELAY", "SOURCE_BASE"];

const scalar = (value) => {
  const s = String(formatValue(value));
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
};

const chains = new Map();
function prefabChain(path) {
  if (chains.has(path)) return chains.get(path);
  const chain = [];
  const seen = new Set();
  let next = path;
  while (next && !seen.has(next.toLowerCase())) {
    seen.add(next.toLowerCase());
    const loaded = loader.load(next);
    if (!loaded) break;
    chain.push(loaded);
    next = loaded.doc.parent?.path ?? null;
  }
  chains.set(path, chain);
  return chain;
}

function prefabComponent(path) {
  let found = false;
  const fields = { ...CLASS_DEFAULTS };
  for (const step of [...prefabChain(path)].reverse()) {
    const comp = componentsOf(step.doc).find((c) => c.className === "SCR_CampaignMilitaryBaseComponent");
    if (!comp?.block) continue;
    found = true;
    for (const key of Object.keys(CLASS_DEFAULTS)) {
      const hit = lookup(comp.block, key);
      if (hit.found) fields[key] = scalar(hit.value);
    }
  }
  return found ? fields : null;
}

/** Every base one world ships, in the document's own shape. */
function readWorld(worldPath, tables) {
  const where = locateWorld(worldPath);
  if (!where) fail(`the install has no ${worldPath}`);
  const ebin = readEbinSource(`${where.pakPath}:${where.entry}`, { strict: true });
  const named = [];
  const unnamed = [];
  for (const ent of ebinEntities(ebin, { instances: 1000000 })) {
    if (ent.kind === "group") continue;
    const prefabPath = ent.prefab?.guid ? (rdb.map.get(ent.prefab.guid)?.path ?? null) : null;
    const fromPrefab = prefabPath ? prefabComponent(prefabPath) : null;
    const own = (ent.components ?? []).find((c) => /SCR_CampaignMilitaryBaseComponent/.test(c.className ?? ""));
    if (!fromPrefab && !own) continue;
    const fields = { ...(fromPrefab ?? CLASS_DEFAULTS) };
    for (const f of own ? own.fields : []) {
      if (!(f.name in CLASS_DEFAULTS)) continue;
      fields[f.name] = f.value;
    }
    for (const key of BOOL_KEYS) fields[key] = !!fields[key];
    fields.m_eType = typeof fields.m_eType === "number" ? (TYPES[fields.m_eType] ?? String(fields.m_eType)) : fields.m_eType;
    const row = {
      display: tables.en ? (tables.en.has(String(fields.m_sBaseName).replace(/^#/, "")) ? tables.en.get(String(fields.m_sBaseName).replace(/^#/, "")) : null) : null,
      type: fields.m_eType,
      cp: fields.m_bIsControlPoint,
      sh: fields.m_bIsSupplyHub,
      hq: fields.m_bCanBeHQ,
      dis: fields.m_bDisableWhenUnusedAsHQ,
      prefab: prefabPath ? prefabPath.split("/").pop() : null,
      x: ent.position ? Math.round(ent.position[0]) : null,
      z: ent.position ? Math.round(ent.position[2]) : null,
    };
    if (ent.id) named.push({ entity: ent.id, ...row });
    else unnamed.push(row);
  }
  named.sort((a, b) => a.entity.localeCompare(b.entity));
  return { named, unnamed };
}

const enSource = locateLocalization("en_us");
if (!enSource) fail("no Language/localization.en_us.conf in the archives");
const enParts = readStringTables([enSource]).parts;
const tables = { en: enParts[0]?.table ?? null };

// ---------------------------------------------------------------- compare
const docText = readFileSync(opts.doc, "utf8");
const documented = parseDoc(docText);
if (!documented.length) fail(`${opts.doc}: no "### … \`worlds/…\`.ent\`" section was found`);

const problems = [];
const report = { ok: true, doc: opts.doc, install: installDir, worlds: [], differences: [] };
const flagWord = (v) => (v ? YES : NO);

for (const section of documented) {
  const actual = readWorld(section.world, tables);
  const rows = [];
  const want = new Map(section.named.map((r) => [r.entity, r]));
  const have = new Map(actual.named.map((r) => [r.entity, r]));

  for (const [entity, wantRow] of want) {
    const haveRow = have.get(entity);
    if (!haveRow) {
      problems.push({ world: section.world, entity, field: "row", documented: "present", install: "absent" });
      continue;
    }
    const checks = [
      ["display name", wantRow.display, haveRow.display],
      ["type", wantRow.type, haveRow.type],
      ["m_bIsControlPoint", flagWord(wantRow.cp), flagWord(haveRow.cp)],
      ["m_bIsSupplyHub", flagWord(wantRow.sh), flagWord(haveRow.sh)],
      ["m_bCanBeHQ", flagWord(wantRow.hq), flagWord(haveRow.hq)],
      ["m_bDisableWhenUnusedAsHQ", flagWord(wantRow.dis), flagWord(haveRow.dis)],
    ];
    for (const [field, documented, install] of checks) {
      if (documented !== install) problems.push({ world: section.world, entity, field, documented, install });
    }
  }
  for (const entity of have.keys()) {
    if (!want.has(entity)) problems.push({ world: section.world, entity, field: "row", documented: "absent", install: "present" });
  }

  // unnamed rows: identity is the display name plus the prefab plus the position
  const key = (r) => `${r.display}|${r.prefab}|${r.x}|${r.z}`;
  const wantUnnamed = new Map();
  for (const r of section.unnamed) wantUnnamed.set(key(r), r);
  const haveUnnamed = new Map();
  for (const r of actual.unnamed) haveUnnamed.set(key(r), r);
  for (const [k, wantRow] of wantUnnamed) {
    const haveRow = haveUnnamed.get(k);
    if (!haveRow) {
      problems.push({ world: section.world, entity: "(unnamed)", field: "row", documented: k, install: "absent" });
      continue;
    }
    for (const [field, a, b] of [
      ["m_bIsControlPoint", wantRow.cp, haveRow.cp],
      ["m_bIsSupplyHub", wantRow.sh, haveRow.sh],
      ["m_bCanBeHQ", wantRow.hq, haveRow.hq],
      ["m_bDisableWhenUnusedAsHQ", wantRow.dis, haveRow.dis],
    ]) {
      if (a !== b) problems.push({ world: section.world, entity: "(unnamed)", field, documented: a, install: b });
    }
  }
  for (const k of haveUnnamed.keys()) {
    if (!wantUnnamed.has(k)) problems.push({ world: section.world, entity: "(unnamed)", field: "row", documented: "absent", install: k });
  }

  rows.push({
    world: section.world,
    documented: { named: section.named.length, unnamed: section.unnamed.length },
    install: { named: actual.named.length, unnamed: actual.unnamed.length },
  });
  report.worlds.push(rows[0]);
}

report.differences = problems;
report.ok = problems.length === 0;
const totalDocumented = report.worlds.reduce((n, w) => n + w.documented.named + w.documented.unnamed, 0);
report.bases = totalDocumented;

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (!opts.quiet) {
    for (const w of report.worlds) {
      const agree = w.documented.named === w.install.named && w.documented.unnamed === w.install.unnamed;
      console.log(`${agree ? "ok  " : "DIFF"} ${w.world}: document ${w.documented.named}+${w.documented.unnamed}, install ${w.install.named}+${w.install.unnamed}`);
    }
    for (const p of problems) console.log(`  ! ${p.world} ${p.entity} ${p.field}: document ${p.documented}, install ${p.install}`);
  }
  console.log(
    report.ok
      ? `AGREES — ${report.worlds.length}/${documented.length} worlds, ${totalDocumented}/${totalDocumented} bases, 0 differences`
      : `DRIFT — ${problems.length} difference(s) in ${report.worlds.length} worlds`,
  );
}
process.exit(report.ok ? 0 : 1);
