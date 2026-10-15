#!/usr/bin/env node
// Check an installed Arma Reforger dedicated server against what these documents claim.
//
//   node tools/verify-against-install.mjs [--server-dir <dir>] [--json] [--out report.json] [--quiet]
//
// This is the runnable form of the "after a game update" procedure in CONTRIBUTING.md. It
// answers the one question the documents cannot answer about themselves: does the build that
// is actually installed still agree with them?
//
//   1. the build version, read from the executable, against the pin in data/build.json;
//   2. every scenario and terrain GUID in data/scenarios.json, against the GUIDs extracted
//      from the installed resourceDatabase.rdb;
//   3. the names data/startup-params.json calls absent, and the pre-0.9.8.73 field names,
//      against the strings in the executable.
//
// SELF-VALIDATION. The RDB record layout is an empirically derived assumption, so the parser
// is checked against the 8 GUIDs published on the BI wiki before its results are used. If that
// self-check fails, the tool stops and says so (exit 3) instead of reporting a GUID that
// differs merely because the layout changed.
//
// The GUIDs are resource identifiers and are documented as surviving patches; this tool is
// what tests that claim. The startup-parameter and field-name claims are build-specific and
// are expected to drift.
//
// Exit: 0 everything agrees, 1 drift found, 2 no usable install, 3 the RDB self-check failed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  quiet: argv.includes("--quiet"),
  out: flagValue("--out"),
  help: argv.includes("--help") || argv.includes("-h"),
};

const DEFAULT_DIRS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Server",
  "C:\\Program Files\\Steam\\steamapps\\common\\Arma Reforger Server",
];
const serverDir =
  flagValue("--server-dir") ?? process.env.ARMA_REFORGER_SERVER_DIR ?? DEFAULT_DIRS.find((d) => existsSync(d));

if (opts.help || !serverDir) {
  console.log(`usage: node tools/verify-against-install.mjs [--server-dir <dir>] [--json] [--out report.json] [--quiet]

  --server-dir DIR   Arma Reforger dedicated server directory. Without it, ARMA_REFORGER_SERVER_DIR
                     is used, then the usual Steam paths${serverDir ? "" : " (none of which exist here)"}
  --json             machine-readable report on stdout
  --out FILE         also write the JSON report to FILE
  --quiet            print only the summary

exit: 0 agrees, 1 drift, 2 no usable install, 3 RDB self-check failed`);
  process.exit(opts.help ? 0 : 2);
}

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const pin = readJson("data/build.json");
const SCEN = readJson("data/scenarios.json");
const PARAMS = readJson("data/startup-params.json");

const findings = [];
const add = (level, area, subject, message) => findings.push({ level, area, subject, message });

const probeList = (target, path) => {
  if (!existsSync(path)) {
    console.error(`not found: ${path}`);
    process.exit(2);
  }
  return path;
};

// ------------------------------------------------------- 1. installed build
const exePath = probeList("exe", join(serverDir, "ArmaReforgerServer.exe"));
const exe = readFileSync(exePath);
const exeText = exe.toString("latin1");
const exeLower = exeText.toLowerCase();

const version = /Arma Reforger (\d+\.\d+\.\d+\.\d+)/.exec(exeText)?.[1] ?? null;
if (!version) {
  add("error", "build", "installed build", "could not read a version string from the executable");
} else if (version === pin.build) {
  add("ok", "build", "installed build", `${version} — the same build the documents were verified against`);
} else {
  const cmp = (a, b) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const rel = cmp(version, pin.build) > 0 ? "newer" : "older";
  add(
    "warning",
    "build",
    "installed build",
    `${version} is ${rel} than the documented ${pin.build}. Version-specific claims (absent startup parameters, field names) are re-checked below; everything else in the documents remains a statement about ${pin.build}`
  );
}

// ------------------------------------------- 2. GUIDs against the installed RDB
const rdbPath = join(serverDir, "addons", "data", "resourceDatabase.rdb");
if (!existsSync(rdbPath)) {
  add("warning", "guids", "resourceDatabase.rdb", `not found at ${rdbPath} — GUIDs not verified`);
} else {
  // Latin-1 makes one byte one character, so string offsets are byte offsets.
  const rdb = readFileSync(rdbPath);
  const latin = rdb.toString("latin1");

  /** Extract {GUID}path entries for a path prefix, using the layout from extract-guid-table.ps1. */
  function extract(prefix, extension) {
    const out = new Map();
    let pos = 0;
    for (;;) {
      const i = latin.indexOf(prefix, pos);
      if (i < 0) break;
      const end = latin.indexOf("\0", i);
      if (end < 0) break;
      const path = latin.slice(i, end);
      pos = i + 1;
      if (!/^[A-Za-z0-9_\-/. ]+$/.test(path) || path.includes("//")) continue;
      if (extension && !path.endsWith(extension)) continue;
      const g = end + 7; // 6 unknown bytes, then the GUID
      if (g + 8 > rdb.length) continue;
      const guid = Buffer.from(rdb.subarray(g, g + 8)).reverse().toString("hex").toUpperCase();
      if (!/^[0-9A-F]{16}$/.test(guid) || guid === "0000000000000000") continue;
      if (!out.has(path)) out.set(path, guid);
    }
    return out;
  }

  const table = new Map([...extract("Missions/", ".conf"), ...extract("worlds/", ".conf")]);

  // Self-check: the 8 GUIDs published on the BI wiki.
  const WIKI = {
    "Missions/23_Campaign.conf": "ECC61978EDCC2B5A",
    "Missions/21_GM_Eden.conf": "59AD59368755F41A",
    "Missions/22_GM_Arland.conf": "2BBBE828037C6F4B",
    "Missions/Tutorial.conf": "002AF7323E0129AF",
    "Missions/CAH_Castle.conf": "F1A1BEA67132113E",
    "Missions/CAH_Factory.conf": "9405201CBD22A30C",
    "Missions/CAH_LeMoule.conf": "7C491B1FCC0FF0E1",
    "Missions/CAH_Morton.conf": "2B4183DF23E88249",
  };
  const selfFail = Object.entries(WIKI).filter(([p, g]) => table.get(p) !== g);
  if (selfFail.length) {
    console.error(
      `RDB self-check FAILED for ${selfFail.length}/${Object.keys(WIKI).length} known GUIDs: ` +
        selfFail.map(([p]) => p).join(", ")
    );
    console.error("The record layout in extract-guid-table.ps1 no longer matches this build's");
    console.error("resourceDatabase.rdb, so its GUIDs cannot be compared. Do not trust them.");
    process.exit(3);
  }
  add("ok", "guids", "RDB parser", `self-check passed: all ${Object.keys(WIKI).length} published wiki GUIDs matched`);

  let same = 0;
  const changed = [];
  const missing = [];
  for (const s of [...SCEN.scenarios, ...SCEN.terrains]) {
    const found = table.get(s.path);
    if (found === undefined) missing.push(s.path);
    else if (found === s.guid) same++;
    else changed.push(`${s.path}: document ${s.guid}, installed ${found}`);
  }
  if (changed.length) add("error", "guids", "scenarioId GUIDs changed", changed.join("; "));
  if (missing.length) {
    add(
      "warning",
      "guids",
      "resource not found in this install",
      `${missing.length} of ${SCEN.counts.total + SCEN.counts.terrains}: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}`
    );
  }
  if (!changed.length) {
    add("ok", "guids", "scenarioId GUIDs", `${same} of ${SCEN.counts.total + SCEN.counts.terrains} confirmed unchanged against the installed RDB`);
  }
}

// ------------------------------- 3. names the documents call absent / obsolete
const LEGACY_NAMES = [
  "gameHostBindAddress",
  "gameHostBindPort",
  "gameHostRegisterBindAddress",
  "gameHostRegisterPort",
  "passwordAdmin", // legacy only at the root; still valid inside game
  "playerCountLimit",
  "supportedGameClientTypes",
  "a2sQueryEnabled",
  "steamQueryPort",
];
// If these are not found, the probe method itself is unreliable on this build.
const CONTROLS = ["maxFPS", "bindIP", "maxPlayers", "fastValidation", "scenarioId"];

const present = (name) => exeLower.includes(name.toLowerCase());
const missingControls = CONTROLS.filter((c) => !present(c));
if (missingControls.length) {
  add(
    "warning",
    "params",
    "probe method",
    `control names not found in the executable: ${missingControls.join(", ")} — the string-search method is unreliable on this build, treat the results below as inconclusive`
  );
} else {
  add("ok", "params", "probe method", `controls found (${CONTROLS.join(", ")}), so the string search works on this build`);
}

const names = [...new Set([...PARAMS.absentNames, ...PARAMS.acceptedButNotInBinary])];
const nowPresent = names.filter((n) => present(n));
if (nowPresent.length) {
  add(
    "warning",
    "params",
    "now present in this build",
    `${nowPresent.join(", ")} — data/startup-params.json marks these absent; on this build the names exist, so the parameter may work. The documents describe ${pin.build} and would need re-verification for this build`
  );
}
add(
  nowPresent.length ? "warning" : "ok",
  "params",
  "still absent",
  `${names.length - nowPresent.length} of ${names.length} names the documents call absent are still absent from this executable`
);

const legacyPresent = LEGACY_NAMES.filter((n) => present(n));
// dedicatedServerId and region are documented as appearing in backend code, not the config schema.
if (legacyPresent.length) {
  add(
    "warning",
    "fields",
    "pre-0.9.8.73 names found in the executable",
    `${legacyPresent.join(", ")} — a bare substring can belong to unrelated code (the documents note that dedicatedServerId and region occur in backend code). A hit is not proof that the old field name still works in server.json`
  );
} else {
  add("ok", "fields", "pre-0.9.8.73 field names", "none of the obsolete names occur in the executable — the documents' warning still holds on this build");
}

// ------------------------------------------------------------------- report
const order = { error: 0, warning: 1, ok: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);
const counts = {
  error: findings.filter((f) => f.level === "error").length,
  warning: findings.filter((f) => f.level === "warning").length,
  ok: findings.filter((f) => f.level === "ok").length,
};

const report = {
  serverDir,
  installedBuild: version,
  documentedBuild: pin.build,
  agrees: counts.error === 0,
  counts,
  findings,
};

if (opts.out) writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2) + "\n");
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (!opts.quiet) {
    console.log(`installed: ${version ?? "unknown"} at ${serverDir}`);
    console.log(`documented: ${pin.build} (engine ${pin.engine})\n`);
    for (const level of ["error", "warning", "ok"]) {
      for (const f of findings.filter((x) => x.level === level)) {
        console.log(`${level.toUpperCase().padEnd(7)} ${f.subject}\n        ${f.message}`);
      }
    }
  }
  console.log(
    `\n${counts.error === 0 ? "AGREES" : "DRIFT"} — ${counts.error} error(s), ${counts.warning} warning(s), ${counts.ok} check(s) passed`
  );
}

process.exit(counts.error ? 1 : 0);
