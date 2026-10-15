#!/usr/bin/env node
// Ask the game itself whether a server config is accepted, by launching the dedicated server
// with it and reading the verdict out of the log.
//
//   node tools/probe-config-schema.mjs <config.json> [--server-dir <dir>] [--profile <dir>]
//                                      [--timeout <seconds>] [--json] [--quiet]
//
// WHY THIS EXISTS. Everything else in this repository reasons about the config from the
// outside: the guide, the schema, string searches in the executable. None of that is proof.
// The game's own log is, and on a schema violation it does not merely say "invalid" — it names
// the offending key and the schema reference that rejected it:
//
//   BACKEND      : JSON Schema Validation:
//    BACKEND      : additionalProperties error:
//     BACKEND   (E): Param "#/game/totallyMadeUpKey" is not allowed and must be removed.
//     BACKEND   (E): Reference in schema: "#/properties/game"
//     BACKEND   (E): JSON is invalid!
//    BACKEND   (E): There are errors in server config!
//   ENGINE    (E): Error while initializing game.
//   ENGINE    (E): Unable to initialize the game
//
// Three failure paths exist, each with its own message. The guide's error table conflated them
// and attributed the wrong one to a schema violation until this tool was used to separate them
// on 1.8.0.13:
//   * the file parses but fails the schema -> the detailed block above
//   * the file is not valid JSON at all    -> "JSON parse error: <reason> (Line: N | Char: M)"
//   * the file cannot be read or is absent -> "Unable to open server config file: <path>"
// All three also write "There are errors in server config!". None of them wrote the
// "Server Config file is Invalid - cannot start server!" that the wiki quotes: that string is
// present in the executable, but it was not emitted on any observed path.
//
// THE ENVIRONMENT MATTERS. Launching the server requires an unrestricted environment. Under a
// sandbox that forbids creating named pipes (the DSH file sandbox does), the engine hangs right
// after creating its log files and never writes a line, so this tool would report a timeout.
// If you see that, the environment is the problem, not the config.
//
// Exit codes: 0 accepted, 1 rejected, 2 could not run, 3 timed out.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const VALUE_FLAGS = ["--server-dir", "--profile", "--timeout"];
const configArg = argv.find((a, i) => !a.startsWith("-") && !VALUE_FLAGS.includes(argv[i - 1]));
const opts = {
  json: argv.includes("--json"),
  quiet: argv.includes("--quiet"),
  help: argv.includes("--help") || argv.includes("-h"),
  serverDir: flagValue("--server-dir") ?? process.env.ARMA_REFORGER_SERVER_DIR,
  profile: flagValue("--profile"),
  timeout: Number(flagValue("--timeout") ?? 120),
};

if (opts.help || !configArg) {
  console.log(`usage: node tools/probe-config-schema.mjs <config.json> [--server-dir <dir>]
                                           [--profile <dir>] [--timeout <seconds>] [--json]

  --server-dir DIR   Arma Reforger dedicated server directory (or ARMA_REFORGER_SERVER_DIR)
  --profile DIR      where the server writes its logs. Default: a fresh directory in the temp dir
  --timeout SEC      how long to wait for a verdict (default 120)

exit: 0 accepted, 1 rejected, 2 could not run, 3 timed out`);
  process.exit(opts.help ? 0 : 2);
}

const DEFAULT_DIRS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Server",
  "C:\\Program Files\\Steam\\steamapps\\common\\Arma Reforger Server",
];
const serverDir = opts.serverDir ?? DEFAULT_DIRS.find((d) => existsSync(d));
if (!serverDir) {
  console.error("no Arma Reforger dedicated server found — pass --server-dir or set ARMA_REFORGER_SERVER_DIR");
  process.exit(2);
}
const exe = join(serverDir, "ArmaReforgerServer.exe");
const configPath = resolve(configArg);
if (!existsSync(exe) || !existsSync(configPath)) {
  console.error(`missing: ${existsSync(exe) ? "" : exe + " "}${existsSync(configPath) ? "" : configPath}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const profileDir = opts.profile ? resolve(opts.profile) : join(tmpdir(), `arma-config-probe-${stamp}`);
mkdirSync(profileDir, { recursive: true });

const started = Date.now();
// stdio is "ignore" deliberately: a piped child fails in environments that forbid named pipes,
// and the log file is a better channel anyway.
const child = spawn(
  exe,
  ["-config", configPath, "-profile", profileDir, "-maxFPS", "30", "-disableCrashReporter", "-keepNumOfLogs", "2"],
  { cwd: serverDir, stdio: "ignore", windowsHide: true }
);

/** Newest logs_* directory: <profile>/logs/logs_<stamp> (docs, Profile section 2). */
function newestLogDir() {
  const out = [];
  for (const root of [join(profileDir, "logs"), profileDir]) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith("logs_")) out.push(join(root, e.name));
    }
  }
  out.sort();
  return out.length ? out[out.length - 1] : null;
}

// The failure markers this build actually writes. The wiki-quoted
// "Server Config file is Invalid - cannot start server!" is in the executable but was NOT
// written in any observed failure mode; it is kept here only so that an older build, which
// may still emit it, is recognised as a rejection rather than timing out.
const VERDICTS = [
  ["accepted", /JSON is Valid/],
  [
    "rejected",
    /JSON is invalid|JSON parse error|Server Config file is Invalid|Failed to load server config|Unable to open server config file|There are errors in server config|Unable to initialize the game/i,
  ],
];

let verdict = "timeout";
let marker = "";
let logDir = null;
let text = "";
let exitedAt = null;

while (Date.now() - started < opts.timeout * 1000) {
  const dir = newestLogDir();
  if (dir) logDir = dir;
  if (logDir) {
    try {
      text = readFileSync(join(logDir, "console.log"), "utf8");
    } catch {
      /* the file may not exist yet */
    }
    for (const [name, re] of VERDICTS) {
      const m = re.exec(text);
      if (m) {
        verdict = name;
        marker = m[0];
        break;
      }
    }
  }
  if (verdict !== "timeout") break;

  // An invalid config makes the server end by itself. Keep reading for a moment in case the
  // log flushes late, then stop rather than waiting out the whole timeout.
  if (child.exitCode !== null) {
    exitedAt = exitedAt ?? Date.now();
    if (Date.now() - exitedAt > 3000) {
      verdict = "unknown";
      break;
    }
  } else {
    exitedAt = null;
  }
  await new Promise((r) => setTimeout(r, 500));
}

const exitedOnItsOwn = child.exitCode !== null;
if (!exitedOnItsOwn) {
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

/** The lines that carry the verdict, and the reason when the game gives one. */
const decisive = text
  .split(/\r?\n/)
  .filter((l) =>
    /JSON Schema Validation|JSON is Valid|JSON is invalid|JSON parse error|Server Config file is Invalid|additionalProperties|Pattern Description|Param "|Reference in schema|errors in server config|Failed to load server config|Unable to open server config|Error while initializing|Unable to initialize/i.test(
      l
    )
  )
  .map((l) => l.trimEnd());

const report = {
  config: configPath,
  serverDir,
  profileDir,
  logDir,
  verdict,
  marker,
  seconds: Math.round((Date.now() - started) / 1000),
  exitedOnItsOwn,
  decisive,
};
if (opts.json) console.log(JSON.stringify(report, null, 2));
else if (!opts.quiet) {
  console.log(`config:  ${configPath}`);
  console.log(`verdict: ${verdict}${marker ? `  ("${marker}")` : ""}  after ${report.seconds}s`);
  console.log(`logs:    ${logDir ?? "(none written)"}`);
  for (const l of decisive) console.log(`  ${l}`);
  if (verdict === "timeout") {
    console.log(
      "\nA timeout usually means the environment, not the config: the engine hangs before writing\n" +
        "anything when it cannot create named pipes. Re-run outside a sandbox."
    );
  } else if (verdict === "unknown") {
    console.log("\nThe server ended without writing any message this tool recognises — read the log above.");
  }
}

process.exit({ accepted: 0, rejected: 1, timeout: 3, unknown: 4 }[verdict] ?? 2);
