// Test suite for tools/server-status.mjs (readiness and port evidence for a launched server).
//
//   node tests/server-status-tests.mjs
//
// The samples are the lines build 1.8.0.13 actually wrote on this machine, with the paths
// sanitised; the failure sample is the block from the run that rejected
// `serverMinGrassDistance: 0` (see the ServerConfig guide's trap table). The CLI is exercised
// against a fabricated profile+log with --no-sockets --no-a2s, so the suite needs neither a
// running server nor an operating-system socket table, and works in a sandbox.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLog,
  expectedPorts,
  parseNetstatUdp,
  parseSsUdp,
  socketMatches,
  buildA2sInfo,
  parseA2sReply,
} from "../tools/server-status.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "server-status.mjs");
const tmp = join(root, "tests", ".tmp-server-status");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

const READY_LOG = `---------------------------------------------
Log C:\\srv\\profile\\logs\\logs_2026-10-17_04-51-39\\console.log started at 2026-10-17 04:51:39 (2026-10-17 01:51:39 UTC)

2026-10-17 04:51:39.165 ENGINE       : CLI Params: -config C:\\srv\\config.json -profile C:\\srv\\profile -maxFPS 60 -logTime datetime -logLevel normal 
2026-10-17 04:51:39.166  ENGINE       : dir: './addons'
2026-10-17 04:51:40.732 BACKEND      : Loading dedicated server config.
2026-10-17 04:51:40.732  BACKEND      : Server config loaded.
2026-10-17 04:51:40.732 BACKEND      : JSON Schema Validation:
2026-10-17 04:51:40.732   BACKEND      : JSON is Valid
2026-10-17 04:51:42.198  WORLD        : WORLD        : Entities load 'worlds/CaptureAndHold/CAH_Morton.ent'
2026-10-17 04:51:56.155 NETWORK      : Starting RPL server, listening on address 0.0.0.0:2001, fastValidation=true
2026-10-17 04:51:57.571 BACKEND      : Server registered with address: 203.0.113.10:2001
2026-10-17 04:51:57.571 BACKEND      : Direct Join Code: 0340196985
2026-10-17 04:51:57.571 BACKEND      : Ping Site: frankfurt
2026-10-17 04:51:57.791 BACKEND      : [RCON] Init, Ip address=127.0.0.1 and Port=19999
`;

// The verbatim shape of a rejection, from the probe run on 1.8.0.13: the schema names the key,
// the minimum it enforces, and the branch that rejected it, then the engine gives up.
const REJECTED_LOG = `2026-10-17 04:50:16.958 BACKEND      : Loading dedicated server config.
2026-10-17 04:50:16.958  BACKEND      : Server config loaded.
2026-10-17 04:50:16.958 BACKEND      : JSON Schema Validation:
2026-10-17 04:50:16.958   BACKEND      : minimum error:
2026-10-17 04:50:16.959    BACKEND   (E): Param "#/game/gameProperties/serverMinGrassDistance" is bellow the minimum limit of value/length. The minimum allowed is 50.
2026-10-17 04:50:16.959    BACKEND   (E): Reference in schema: "#/properties/game/properties/gameProperties/properties/serverMinGrassDistance"
2026-10-17 04:50:16.959   BACKEND   (E): JSON is invalid!
2026-10-17 04:50:16.959  BACKEND   (E): There are errors in server config!
2026-10-17 04:50:16.959 ENGINE    (E): Error while initializing game.
2026-10-17 04:50:17.135 ENGINE    (E): Unable to initialize the game
`;

// --- parseLog ---------------------------------------------------------------

const ready = parseLog(READY_LOG);
check("ready log: state", ready.state === "ready", ready.state);
check("ready log: JSON is Valid", ready.configValid === true);
check("ready log: no config error", ready.configError === null);
check("ready log: CLI Params", ready.cliParams?.includes("-maxFPS 60") === true, ready.cliParams);
check("ready log: addon dirs seen", ready.addonDirs === true);
check("ready log: world", ready.world === "worlds/CaptureAndHold/CAH_Morton.ent", ready.world);
check(
  "ready log: RPL endpoint",
  ready.rpl?.address === "0.0.0.0" && ready.rpl?.port === 2001 && ready.rpl?.fastValidation === true,
  JSON.stringify(ready.rpl)
);
check(
  "ready log: registration",
  ready.registered?.address === "203.0.113.10" && ready.registered?.port === 2001,
  JSON.stringify(ready.registered)
);
check("ready log: join code", ready.joinCode === "0340196985", ready.joinCode);
check("ready log: ping site", ready.pingSite === "frankfurt", ready.pingSite);
check("ready log: rcon", ready.rcon?.address === "127.0.0.1" && ready.rcon?.port === 19999, JSON.stringify(ready.rcon));
check("ready log: nothing fatal", ready.fatal.length === 0, JSON.stringify(ready.fatal));

const rejected = parseLog(REJECTED_LOG);
check("rejected log: state", rejected.state === "failed", rejected.state);
check(
  "rejected log: names the key",
  rejected.configError?.includes("#/game/gameProperties/serverMinGrassDistance") === true,
  rejected.configError
);
check(
  "rejected log: fatal carries the schema line and the give-up line",
  rejected.fatal.length === 2 && rejected.fatal[0].includes("serverMinGrassDistance") && rejected.fatal[1] === "Unable to initialize the game",
  JSON.stringify(rejected.fatal)
);

const rconFailed = parseLog(READY_LOG + `2026-10-17 04:51:57.800 BACKEND      : [RCON] Init failed... Missing password or password length < 3 characters !!!\n`);
check("rcon failure: still ready", rconFailed.state === "ready", rconFailed.state);
check("rcon failure: recorded", rconFailed.rconError?.includes("Missing password") === true, rconFailed.rconError);

// A config that passed but a start that never got past the backend: the shape of a sandboxed run.
const acceptedOnly = READY_LOG.split("\n")
  .slice(0, READY_LOG.split("\n").findIndex((l) => l.includes("JSON is Valid")) + 1)
  .join("\n");
const tls = parseLog(acceptedOnly + `\n2026-10-17 04:51:41.000 BACKEND   (E): [RestApi] Curl error=SSL peer certificate or SSH remote key was not OK\n`);
check("TLS failure: flagged", tls.tlsFailure === true);
check("TLS failure: not ready", tls.state === "starting", tls.state);

const missing = parseLog(`2026-10-17 04:50:16.000 ENGINE (E): Can't find '58D0FB3206B6F859' game addon! Check setup guidelines!\n`);
check("missing game addon: guid", missing.missingAddon === "58D0FB3206B6F859", missing.missingAddon);
check("missing game addon: failed", missing.state === "failed", missing.state);

check("empty log: state new", parseLog("").state === "new");

// --- expectedPorts ----------------------------------------------------------

const full = expectedPorts({
  bindAddress: "0.0.0.0",
  bindPort: 2401,
  a2s: { address: "0.0.0.0", port: 17778 },
  rcon: { address: "127.0.0.1", port: 2402 },
});
check(
  "expectedPorts: three roles",
  full.map((p) => p.role).join(",") === "game,a2s,rcon",
  JSON.stringify(full.map((p) => p.role))
);
check("expectedPorts: values", full[0].port === 2401 && full[1].port === 17778 && full[2].port === 2402);

const defaults = expectedPorts({});
check(
  "expectedPorts: defaults are the server's own",
  defaults.length === 1 && defaults[0].port === 2001 && defaults[0].address === "",
  JSON.stringify(defaults)
);
check(
  "expectedPorts: an absent rcon section adds no port",
  expectedPorts({ a2s: { address: "0.0.0.0" } }).every((p) => p.role !== "rcon")
);
check(
  "expectedPorts: an invalid port falls back to the default",
  expectedPorts({ bindPort: 70000, a2s: { port: "x" } })[0].port === 2001 &&
    expectedPorts({ a2s: { port: "x" } })[1].port === 17777
);

// --- socket tables ----------------------------------------------------------

const winRows = parseNetstatUdp(`Active Connections

  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:2001           *:*                                    28968
  UDP    0.0.0.0:17777          *:*                                    28968
  UDP    127.0.0.1:19999        *:*                                    28968
  UDP    [::]:5353              *:*                                    1234
`);
check("netstat: rows parsed", winRows.length === 4, String(winRows.length));
check(
  "netstat: first endpoint",
  winRows[0].address === "0.0.0.0" && winRows[0].port === 2001 && winRows[0].pid === 28968,
  JSON.stringify(winRows[0])
);
check("netstat: IPv6 address kept", winRows[3].address === "[::]" && winRows[3].port === 5353);

const ssRows = parseSsUdp(`State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
UNCONN 0      0            0.0.0.0:2001       0.0.0.0:*    users:(("ArmaReforgerServer",pid=28968,fd=13))
UNCONN 0      0          127.0.0.1:19999      0.0.0.0:*    users:(("ArmaReforgerServer",pid=28968,fd=15))
UNCONN 0      0                  *:17777            *:*    users:(("*",pid=1,fd=1))
`);
check("ss: rows parsed", ssRows.length === 3, String(ssRows.length));
check(
  "ss: process name and pid",
  ssRows[0].process === "ArmaReforgerServer" && ssRows[0].pid === 28968,
  JSON.stringify(ssRows[0])
);
check("ss: wildcard address", ssRows[2].address === "*" && ssRows[2].port === 17777);

const netstatLinux = parseSsUdp(
  `Active Internet connections (only servers)\nudp        0      0 0.0.0.0:2001            0.0.0.0:*                           28968/ArmaReforgerServer\n`
);
check(
  "netstat (Linux) fallback",
  netstatLinux.length === 1 && netstatLinux[0].port === 2001 && netstatLinux[0].process === "ArmaReforgerServer",
  JSON.stringify(netstatLinux[0])
);

check("match: exact", socketMatches({ address: "127.0.0.1", port: 19999 }, { address: "127.0.0.1", port: 19999 }) === true);
check("match: wildcard expected", socketMatches({ address: "", port: 2001 }, { address: "0.0.0.0", port: 2001 }) === true);
check("match: wildcard socket", socketMatches({ address: "0.0.0.0", port: 2001 }, { address: "*", port: 2001 }) === true);
check("match: port differs", socketMatches({ address: "", port: 2001 }, { address: "0.0.0.0", port: 2002 }) === false);
// A wildcard socket accepts every local address, so it matches a pinned expectation — which is
// why the report has a separate "bound on ALL interfaces" finding rather than calling it missing.
check("match: wildcard socket matches a pinned address", socketMatches({ address: "127.0.0.1", port: 19999 }, { address: "0.0.0.0", port: 19999 }) === true);
check("match: two pinned addresses differ", socketMatches({ address: "127.0.0.1", port: 19999 }, { address: "192.168.0.5", port: 19999 }) === false);

// --- A2S --------------------------------------------------------------------

const info = buildA2sInfo();
check("A2S request: header and type", info.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])) && info[4] === 0x54);
check("A2S request: name is NUL terminated", info.toString("ascii", 5) === "Source Engine Query\0");
check("A2S request: challenge appended", buildA2sInfo(Buffer.from([1, 2, 3, 4])).length === info.length + 4);

const challenge = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), Buffer.from([9, 8, 7, 6])]);
const challengeReply = parseA2sReply(challenge);
check(
  "A2S challenge reply",
  challengeReply.type === "challenge" && challengeReply.challenge.equals(Buffer.from([9, 8, 7, 6])),
  JSON.stringify(challengeReply)
);

/** A real A2S_INFO body, the fields in the order the server sent them on 1.8.0.13. */
const infoBody = (() => {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]), Buffer.from([17])];
  const cstr = (s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
  parts.push(cstr("Launch Test"), cstr("#AR-CAH-Scenario_Name_Morton"), cstr(""), cstr("Arma Reforger"));
  const rest = Buffer.alloc(10);
  rest.writeUInt16LE(0, 0); // app id (A2S carries a 16-bit field; the observed reply is not asserted on)
  rest[2] = 0; // players
  rest[3] = 8; // max players
  parts.push(rest);
  return Buffer.concat(parts);
})();
const infoReply = parseA2sReply(infoBody);
check(
  "A2S info reply",
  infoReply.type === "info" &&
    infoReply.name === "Launch Test" &&
    infoReply.map === "#AR-CAH-Scenario_Name_Morton" &&
    infoReply.players === 0 &&
    infoReply.maxPlayers === 8,
  JSON.stringify(infoReply)
);
check("A2S: garbage is not a reply", parseA2sReply(Buffer.from("hello")).type === "unknown");
check("A2S: truncated info does not throw", parseA2sReply(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17, 0x4c])).type === "info");

// --- CLI --------------------------------------------------------------------

if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
const profile = join(tmp, "profile");
const logDir = join(profile, "logs", "logs_2026-10-17_04-51-39");
mkdirSync(logDir, { recursive: true });
const config = join(tmp, "config.json");
writeFileSync(
  config,
  JSON.stringify({
    a2s: { address: "0.0.0.0", port: 17777 },
    rcon: { address: "127.0.0.1", port: 19999, password: "123", permission: "monitor" },
    game: { maxPlayers: 8 },
  })
);

/** Run the tool with stdout on a file and the report written by --out to another. */
function runTool(args) {
  const outPath = join(tmp, "report.json");
  const stdoutPath = join(tmp, "stdout.txt");
  const fd = openSync(stdoutPath, "w");
  const proc = spawnSync(process.execPath, [tool, ...args, "--out", outPath], { stdio: ["ignore", fd, "ignore"] });
  closeSync(fd);
  return { status: proc.status, report: existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null };
}

writeFileSync(join(logDir, "console.log"), READY_LOG);
const okRun = runTool(["--profile", profile, "--config", config, "--no-sockets", "--no-a2s"]);
check("CLI ready: exit 0", okRun.status === 0, String(okRun.status));
check("CLI ready: state", okRun.report?.state === "ready", okRun.report?.state);
check("CLI ready: seconds to registration", okRun.report?.secondsToReady === 18, String(okRun.report?.secondsToReady));
check("CLI ready: three expected ports", okRun.report?.ports?.length === 3, JSON.stringify(okRun.report?.ports?.map((p) => p.role)));
check("CLI ready: sockets not claimed", okRun.report?.ports?.every((p) => p.bound === null) === true);
check("CLI ready: join code", okRun.report?.joinCode === "0340196985");

writeFileSync(join(logDir, "console.log"), REJECTED_LOG);
const failedRun = runTool(["--profile", profile, "--config", config, "--no-sockets", "--no-a2s"]);
check("CLI rejected: exit 1", failedRun.status === 1, String(failedRun.status));
check("CLI rejected: state failed", failedRun.report?.state === "failed", failedRun.report?.state);
check("CLI rejected: the key is in the report", failedRun.report?.configError?.includes("serverMinGrassDistance") === true);

writeFileSync(join(logDir, "console.log"), "2026-10-17 04:51:39.165 ENGINE : CLI Params: -config x -profile y\n");
const usageRun = spawnSync(process.execPath, [tool, "--no-sockets", "--no-a2s"], { stdio: "ignore" });
check("CLI: --profile is required", usageRun.status === 2, String(usageRun.status));

// --wait must catch a log that becomes ready after the tool has started looking.
const waitLogDir = join(tmp, "wait", "logs", "logs_2026-10-17_05-00-00");
mkdirSync(waitLogDir, { recursive: true });
const waitLog = join(waitLogDir, "console.log");
writeFileSync(waitLog, "2026-10-17 05:00:00.000 ENGINE : CLI Params: -config x -profile y\n");
execFileWait();

function execFileWait() {
  const outPath = join(tmp, "wait-report.json");
  const stdoutPath = join(tmp, "wait-stdout.txt");
  const fd = openSync(stdoutPath, "w");
  const args = [tool, "--profile", join(tmp, "wait"), "--config", config, "--no-sockets", "--no-a2s", "--wait", "8", "--out", outPath];
  const child = spawn(process.execPath, args, { stdio: ["ignore", fd, "ignore"] });
  closeSync(fd);
  const timer = setTimeout(() => writeFileSync(waitLog, READY_LOG), 1200);
  child.on("exit", (code) => {
    clearTimeout(timer);
    let report = null;
    try {
      report = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      /* reported below */
    }
    check("CLI --wait: catches a late registration", code === 0 && report?.state === "ready", `exit ${code}, state ${report?.state}`);
    rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"}`);
    process.exit(failures ? 1 : 0);
  });
}
