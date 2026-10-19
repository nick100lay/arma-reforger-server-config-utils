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
// SELF-VALIDATION. The RDB record layout is an empirically derived assumption, so the reader
// (tools/rdb.mjs) checks it against the 8 GUIDs published on the BI wiki before its results are
// used. If that self-check fails, the tool stops and says so (exit 3) instead of reporting a GUID
// that differs merely because the layout changed.
//
// The GUIDs are resource identifiers and are documented as surviving patches; this tool is
// what tests that claim. The startup-parameter and field-name claims are build-specific and
// are expected to drift.
//
// Exit: 0 everything agrees, 1 drift found, 2 no usable install, 3 the RDB self-check failed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRdb, reverseRdb, verifyRdb } from "./rdb.mjs";

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
  // One reader for the database. `tools/rdb.mjs` carries the record layout and the same published
  // GUIDs, so a layout change is caught in one place instead of two parsers disagreeing about it.
  //
  // On a **vanilla** install the 8 published pairs must be there: their absence here is not "a mod
  // database" (this tool reads the game's own), it is the layout or the build having changed, so
  // the GUID comparison that follows would be meaningless.
  const db = scanRdb(rdbPath);
  const self = verifyRdb(db);
  if (!self.vanilla) {
    const wrong = self.contradicted.map((f) => `${f.path} is {${f.found}}, published {${f.expected}}`);
    const absent = self.missing.map((f) => f.path);
    console.error(
      `RDB self-check FAILED for ${wrong.length + absent.length}/${self.checks.length} published GUIDs` +
        (wrong.length ? `: ${wrong.join("; ")}` : "") +
        (absent.length ? `${wrong.length ? "; " : ": "}absent: ${absent.join(", ")}` : "")
    );
    console.error("The record layout in tools/rdb.mjs no longer matches this build's");
    console.error("resourceDatabase.rdb, or this is not a vanilla database. Do not trust its GUIDs.");
    process.exit(3);
  }
  add("ok", "guids", "RDB parser", `self-check passed: all ${self.checks.length} published wiki GUIDs matched`);

  const table = reverseRdb(db.map);
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

// The tables and data/startup-params.json spell a parameter as it is typed, dash included
// (`-autoreload`); the executable stores the bare name the parser compares, so the dash has
// to come off before the search or the probe answers "absent" for everything.
const bareName = (name) => name.replace(/^-+/, "").toLowerCase();
const present = (name) => exeLower.includes(bareName(name));

// A Diag executable ships beside the server one, and the tables mark some parameters
// "Diag exe only". Those switches are in ArmaReforgerServerDiag.exe and NOT in the plain
// server binary — on 1.8.0.13 that is the seven `-rpl-*` network switches — so a search of
// ArmaReforgerServer.exe alone calls a silent no-op "verified". Read the Diag build too.
const diagPath = join(serverDir, "ArmaReforgerServerDiag.exe");
const diagLower = existsSync(diagPath) ? readFileSync(diagPath).toString("latin1").toLowerCase() : null;
const presenceIn = (name) => {
  const n = bareName(name);
  if (exeLower.includes(n)) return "server";
  if (diagLower?.includes(n)) return "diag";
  return "neither";
};
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

// Absence from the server binary is not the whole story: `-checkInstance` is absent from
// ArmaReforgerServer.exe and present in the Diag one, which is what the documents say.
const onlyDiagAbsent = names.filter((n) => !present(n) && diagLower?.includes(n.toLowerCase()));
add(
  "ok",
  "params",
  "absent from the server, present in Diag",
  onlyDiagAbsent.length
    ? `${onlyDiagAbsent.join(", ")} — absent from ArmaReforgerServer.exe and found in ArmaReforgerServerDiag.exe; the documents' "absent" holds for the server build`
    : "none of the names the documents call absent is in the Diag executable either"
);

// ---------------------------------- 3b. names the documents call present, and where
// The "present" column is a claim about a build, and until now this tool checked only the
// absent half of it. A parameter the documents list as present but that neither executable
// carries is the strongest form of "gone"; one that only the Diag build carries is a silent
// no-op on a plain server, which is the failure mode the startup-parameter document opens with.
const claimedPresent = PARAMS.params.filter((p) => p.status === "present");
const at = new Map(claimedPresent.map((p) => [p.param, presenceIn(p.param)]));
const inServer = claimedPresent.filter((p) => at.get(p.param) === "server");
const diagOnlyPresent = claimedPresent.filter((p) => at.get(p.param) === "diag");
const nowherePresent = claimedPresent.filter((p) => at.get(p.param) === "neither");
const list = (ps) => ps.map((p) => p.param).join(", ");

if (!nowherePresent.length) {
  add(
    diagOnlyPresent.length ? "warning" : "ok",
    "params",
    "documented present",
    `${inServer.length} of ${claimedPresent.length} names the documents call present are in the server executable` +
      (diagOnlyPresent.length ? `, ${diagOnlyPresent.length} in the Diag executable only` : "") +
      (diagLower ? "" : " (no Diag executable beside the server, so the Diag half was not checked)")
  );
} else if (!diagLower) {
  add(
    "warning",
    "params",
    "not in the server executable",
    `${list(nowherePresent)} — no Diag executable beside the server, so rows marked "Diag exe only" could not be checked; the rest really are absent from ArmaReforgerServer.exe`
  );
} else {
  add(
    "error",
    "params",
    "documented present, in neither executable",
    `${list(nowherePresent)} — the documents list these as present in ${pin.build}; neither ArmaReforgerServer.exe nor ArmaReforgerServerDiag.exe carries the string. Absence of a string is not proof, but a name in neither executable is the strongest form of it`
  );
}
if (diagOnlyPresent.length && diagLower) {
  add(
    "warning",
    "params",
    "Diag build only",
    `${list(diagOnlyPresent)} — in ArmaReforgerServerDiag.exe only: a plain server build ignores these silently. data/startup-params.json marks them diagOnly`
  );
}

const legacyPresent = LEGACY_NAMES.filter((n) => present(n));
/** Names whose status was settled by launching the server: tools/probe-config-schema.mjs. */
const SETTLED = {
  playerCountLimit: "rejected by the schema",
  supportedGameClientTypes: "rejected by the schema",
  passwordAdmin: "still the valid key inside `game`; only the root-level spelling is obsolete",
};
if (legacyPresent.length) {
  add(
    "warning",
    "fields",
    "pre-0.9.8.73 names found in the executable",
    `${legacyPresent.map((n) => (SETTLED[n] ? `${n} (${SETTLED[n]})` : n)).join(", ")} — a bare substring can belong to unrelated code, so a hit is not proof that the old name still works in server.json. Whether the schema accepts a name is settled only by launching the server: tools/probe-config-schema.mjs`
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
