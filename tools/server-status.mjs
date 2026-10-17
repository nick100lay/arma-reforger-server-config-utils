#!/usr/bin/env node
// Is the dedicated server that was just launched actually up, and are its UDP ports really bound?
//
//   node tools/server-status.mjs --profile <dir> [--config <file>] [--wait <seconds>] [--json]
//                                [--log-dir <dir>] [--out <file>] [--no-sockets] [--no-a2s]
//   node tools/server-status.mjs --a2s-only <host>[:<port>]   (external reachability probe)
//
// WHY THIS EXISTS. "The server is running" is not something to judge by the process still being
// alive: the engine exits on a rejected config within seconds, keeps running while it cannot
// reach the backend, and starts listening on the game port only after the world has loaded
// (~15-20 s into a start). The log states each of those steps, but they are spread over hundreds
// of lines, and the ports have to be checked against the sockets, not against the config. This
// tool reads the log the server itself wrote and asks the operating system which UDP endpoints
// exist, so the answer is evidence rather than a guess.
//
// WHAT IT CANNOT SAY. A bound socket is a fact about this host only. Whether a port on the
// router/firewall is reachable from the internet is a different question and cannot be answered
// from the machine the server runs on — forward the port and probe it from outside.
//
// THE ENVIRONMENT MATTERS FOR THE SERVER, NOT FOR THIS TOOL: with a profile and a log it runs
// anywhere. But a server launched inside a sandbox never reaches the backend (TLS fails) and
// never writes `Server registered with address:` — the report calls that state `listening`, not
// `ready`, and names the likely cause.
//
// Exit codes: 0 ready and every expected port bound; 1 not ready or a port missing; 2 usage.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dgram from "node:dgram";

// The file is both a CLI and a module: the tests import the parsers, and importing must not
// execute the CLI (which would exit 2 for a missing --profile).
const isMain = () => process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// --------------------------------------------------------------------------- arguments
const USAGE = `usage: node tools/server-status.mjs --profile <dir> [options]

  --profile DIR    the directory passed to -profile; the log is <DIR>/logs/logs_*
  --config FILE    the server.json in use. Read for the expected ports; without it only the
                   ports named in the log (game, RCON) are checked, and no A2S probe is made
  --log-dir DIR    read this logs_* directory instead of the newest one under --profile
  --wait SECONDS   poll until the server registers or fails, up to SECONDS (default 0: one look)
  --no-sockets     skip the operating-system socket check (log evidence only)
  --no-a2s         skip the A2S_INFO probe
  --a2s-only H:P    probe A2S at HOST:PORT (default port 17777) and exit; needs no --profile.
                   Use it from a machine OUTSIDE the server's network to prove the router and
                   firewall let UDP through: exit 0 answered, 1 no answer
  --json           machine-readable report on stdout
  --out FILE       write the same JSON report to FILE
  --help

The report separates three questions: did the config pass ("JSON is Valid"), did the server
reach the backend and start replication ("Server registered with address:"), and does the
operating system actually have the expected UDP sockets. A bound socket says nothing about the
router: check reachability from outside the network.

exit: 0 ready, 1 not ready or a port missing, 2 usage`;

function parseCli(argv) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  return {
    profile: flagValue("--profile"),
    config: flagValue("--config"),
    logDir: flagValue("--log-dir"),
    out: flagValue("--out"),
    a2sOnly: flagValue("--a2s-only"),
    wait: Number(flagValue("--wait") ?? 0),
    json: argv.includes("--json"),
    sockets: !argv.includes("--no-sockets"),
    a2s: !argv.includes("--no-a2s"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

// --------------------------------------------------------------------------- log reading
// A directory per launch is created under <profile>/logs (Profile §2); take the newest by name,
// which sorts correctly because the name is logs_<YYYY-MM-DD>_<HH-MM-SS>.
export function newestLogDir(profile) {
  const root = join(profile, "logs");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("logs_"))
    .map((e) => e.name)
    .sort();
  return dirs.length ? join(root, dirs[dirs.length - 1]) : null;
}

// The markers below are the ones build 1.8.0.13 actually writes; the order in the log is
// config -> world -> RPL -> registration -> RCON. `JSON is Valid` is the only proof the schema
// accepted the file, and `Server registered with address:` is the only proof the backend did.
const MARKERS = {
  cli: /CLI Params: (.*)$/m,
  addonDirs: /ENGINE\s*:\s*dir: '\.\/addons'/,
  configLoaded: /Server config loaded\./,
  configValid: /JSON is Valid/,
  rpl: /Starting RPL server, listening on address ([^\s,]+):(\d+), fastValidation=(true|false)/,
  registered: /Server registered with address: ([^\s:]+):(\d+)/,
  joinCode: /Direct Join Code: (\d+)/,
  pingSite: /Ping Site: (\S+)/,
  world: /Entities load '([^']+)'/,
  rcon: /\[RCON\] Init, Ip address=([^\s]+) and Port=(\d+)/,
  rconFailed: /\[RCON\] Init failed\.\.\. (.+)$/m,
  rconRunFailed: /\[RCON\] run failed, (.+)$/m,
  missingAddon: /Can't find '([0-9A-Fa-f]{16})' game addon/,
  tlsFailure: /Curl error=SSL peer certificate|ENV:\[invalid\]|schannel: AcquireCredentialsHandle/,
  backendLost: /DS Room\/ Server not exist anymore, shutting down/,
  unableToInit: /Unable to initialize the game/,
  shutdown: /Game destroyed\./,
};

// The three failure shapes the server has for a config, each with its own first line. All of
// them also write `There are errors in server config!`, which is why that string alone cannot
// tell a schema violation from unparsable JSON (ServerConfig §9).
const CONFIG_ERRORS = [
  /Param "#\/[^"]+" is not allowed and must be removed/,
  /Param "#\/[^"]+" (?:is bellow|has surpassed) the (?:minimum|maximum) limit/,
  /Reference in schema: "#\/properties/,
  /JSON parse error: /,
  /Unable to open server config file: /,
  /Failed to load server config/,
  /There are errors in server config/,
];

/** Pull the decisive lines out of a console.log. Exported for the tests. */
export function parseLog(text) {
  const first = (re) => re.exec(text);
  const configErrorLine = text
    .split(/\r?\n/)
    .find((line) => CONFIG_ERRORS.some((re) => re.test(line)));
  const rpl = first(MARKERS.rpl);
  const registered = first(MARKERS.registered);
  const rcon = first(MARKERS.rcon);
  const rconFailed = first(MARKERS.rconFailed);
  const rconRunFailed = first(MARKERS.rconRunFailed);
  const missingAddon = first(MARKERS.missingAddon);
  const cli = first(MARKERS.cli);

  const result = {
    cliParams: cli ? cli[1].trim() : null,
    addonDirs: MARKERS.addonDirs.test(text),
    configLoaded: MARKERS.configLoaded.test(text),
    configValid: MARKERS.configValid.test(text),
    configError: configErrorLine ? configErrorLine.trim() : null,
    world: first(MARKERS.world)?.[1] ?? null,
    rpl: rpl ? { address: rpl[1], port: Number(rpl[2]), fastValidation: rpl[3] === "true" } : null,
    registered: registered ? { address: registered[1], port: Number(registered[2]) } : null,
    joinCode: first(MARKERS.joinCode)?.[1] ?? null,
    pingSite: first(MARKERS.pingSite)?.[1] ?? null,
    rcon: rcon ? { address: rcon[1], port: Number(rcon[2]) } : null,
    rconError: rconFailed ? rconFailed[1].trim() : rconRunFailed ? `run failed, ${rconRunFailed[1].trim()}` : null,
    missingAddon: missingAddon ? missingAddon[1].toUpperCase() : null,
    tlsFailure: MARKERS.tlsFailure.test(text),
    backendLost: MARKERS.backendLost.test(text),
    unableToInit: MARKERS.unableToInit.test(text),
    destroyed: MARKERS.shutdown.test(text),
  };
  result.fatal = [];
  if (result.configError) result.fatal.push(result.configError);
  if (result.unableToInit) result.fatal.push("Unable to initialize the game");
  if (result.missingAddon) result.fatal.push(`Missing Addon: Can't find '${result.missingAddon}' game addon`);
  if (result.backendLost) result.fatal.push("DS Room/ Server not exist anymore, shutting down");
  result.state = result.fatal.length
    ? "failed"
    : result.registered
      ? "ready"
      : result.rpl
        ? "listening"
        : result.configValid
          ? "starting"
          : "new";
  return result;
}

// --------------------------------------------------------------------------- expected ports
// bindPort and publicPort are the same socket (a startup parameter can override both); the
// defaults are the server's own: 2001, A2S 17777, RCON 19999.
const asPort = (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null);

/** Expected UDP endpoints, from the config the server was given. Exported for the tests. */
export function expectedPorts(config) {
  const ports = [];
  const game = asPort(config?.bindPort) ?? asPort(config?.publicPort) ?? 2001;
  ports.push({ role: "game", address: config?.bindAddress ?? "", port: game, label: "game (RPL)" });
  if (config?.a2s && typeof config.a2s === "object") {
    ports.push({
      role: "a2s",
      address: config.a2s.address ?? "",
      port: asPort(config.a2s.port) ?? 17777,
      label: "A2S/Steam Query",
    });
  }
  if (config?.rcon && typeof config.rcon === "object") {
    ports.push({ role: "rcon", address: config.rcon.address ?? "", port: asPort(config.rcon.port) ?? 19999, label: "RCON" });
  }
  return ports;
}

// --------------------------------------------------------------------------- sockets
// Windows: `netstat -ano -p UDP` — "UDP  0.0.0.0:2001  *:*  28968".
/** Exported for the tests. */
export function parseNetstatUdp(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*UDP\s+(\S+):(\d+)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m) rows.push({ address: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return rows;
}

// Linux: `ss -lunpH` — `UNCONN 0 0 0.0.0.0:2001 0.0.0.0:* users:(("ArmaReforgerServer",pid=1234,fd=12))`,
// and `netstat -lunp` as a fallback — `udp 0 0 0.0.0.0:2001 0.0.0.0:* 1234/ArmaReforgerServer`.
/** Exported for the tests. */
export function parseSsUdp(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    let m = /^\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (m) {
      rows.push({ address: m[1], port: Number(m[2]), pid: Number(m[4]), process: m[3] });
      continue;
    }
    m = /^udp\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+(\d+)\/(\S+)/i.exec(line);
    if (m) rows.push({ address: m[1], port: Number(m[2]), pid: Number(m[3]), process: m[4] });
  }
  return rows;
}

function socketTable() {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0) return null;
    return r.stdout;
  };
  const fail = (why) => ({ rows: null, error: why });
  if (process.platform === "win32") {
    const out = run("netstat", ["-ano", "-p", "UDP"]);
    return out === null ? fail("netstat -ano -p UDP did not run") : { rows: parseNetstatUdp(out), error: null };
  }
  const ss = run("ss", ["-lunpH"]);
  if (ss !== null) return { rows: parseSsUdp(ss), error: null };
  const netstat = run("netstat", ["-lunp"]);
  return netstat === null ? fail("neither ss -lunpH nor netstat -lunp ran") : { rows: parseSsUdp(netstat), error: null };
}

const isWildcard = (address) => address === "" || address === "0.0.0.0" || address === "*" || address === "[::]";
export { isWildcard };

/** Does a socket answer for this expected endpoint? Exported for the tests. */
export function socketMatches(expected, socket) {
  if (expected.port !== socket.port) return false;
  if (isWildcard(expected.address) || isWildcard(socket.address)) return true;
  return expected.address === socket.address;
}

// --------------------------------------------------------------------------- A2S probe
/** "Source Engine Query" with an optional challenge. Exported for the tests. */
export function buildA2sInfo(challenge = null) {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]);
  const query = Buffer.concat([head, Buffer.from("Source Engine Query\0", "ascii")]);
  return challenge ? Buffer.concat([query, challenge]) : query;
}

/** Exported for the tests. Returns a plain object, never throws on a truncated packet. */
export function parseA2sReply(buf) {
  if (!buf || buf.length < 5) return { type: "unknown", reason: "short packet" };
  if (buf.readUInt32LE(0) !== 0xffffffff) return { type: "unknown", reason: "not an A2S reply" };
  const type = buf[4];
  if (type === 0x41) return { type: "challenge", challenge: Buffer.from(buf.subarray(5, 9)) };
  if (type !== 0x49) return { type: "unknown", reason: `unexpected A2S type 0x${type.toString(16)}` };
  let o = 5;
  const cstr = () => {
    const end = buf.indexOf(0, o);
    if (end < 0) throw new Error("truncated string");
    const s = buf.toString("utf8", o, end);
    o = end + 1;
    return s;
  };
  try {
    const reply = { type: "info", protocol: buf[o++] };
    reply.name = cstr();
    reply.map = cstr();
    reply.folder = cstr();
    reply.game = cstr();
    o += 2; // app id
    reply.players = buf[o++];
    reply.maxPlayers = buf[o++];
    reply.bots = buf[o++];
    return reply;
  } catch (e) {
    return { type: "info", truncated: true, reason: e.message };
  }
}

function a2sInfo(host, port, timeoutMs = 2000) {
  return new Promise((settle) => {
    const socket = dgram.createSocket("udp4");
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      settle(value);
    };
    const timer = setTimeout(() => finish({ answered: false, reason: `no reply in ${timeoutMs} ms` }), timeoutMs);
    socket.on("error", (e) => finish({ answered: false, reason: e.code ?? e.message }));
    socket.on("message", (msg) => {
      const reply = parseA2sReply(msg);
      if (reply.type === "challenge" && reply.challenge) {
        socket.send(buildA2sInfo(reply.challenge), port, host);
        return;
      }
      finish({ answered: true, reply });
    });
    socket.bind(0, "0.0.0.0", () => socket.send(buildA2sInfo(), port, host));
  });
}

// --------------------------------------------------------------------------- main
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // One-shot external probe: no profile, no log, no socket table — just "does the server answer
  // a query from here", which is the only way to tell whether the router or firewall is in the way.
  if (opts.a2sOnly) {
    const m = /^([^\s:]+)(?::(\d+))?$/.exec(opts.a2sOnly.trim());
    const port = m && m[2] ? Number(m[2]) : 17777;
    if (!m || port < 1 || port > 65535) {
      console.error(`--a2s-only needs HOST[:PORT] (got '${opts.a2sOnly}')\n\n` + USAGE);
      process.exit(2);
    }
    const host = m[1];
    const probe = await a2sInfo(host, port);
    const report = { host, port, ...probe };
    if (opts.out) writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2) + "\n");
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (probe.answered && probe.reply?.type === "info") {
      console.log(
        `a2s: answered — "${probe.reply.name}", map ${probe.reply.map}, ` +
          `${probe.reply.players}/${probe.reply.maxPlayers} players (${host}:${port})`
      );
    } else {
      console.log(`a2s: no answer from ${host}:${port} (${probe.reason ?? probe.reply?.reason ?? "unknown"})`);
    }
    process.exit(probe.answered && probe.reply?.type === "info" ? 0 : 1);
  }

  if (!opts.profile) {
    console.error("--profile is required (the directory given to -profile)\n\n" + USAGE);
    process.exit(2);
  }

  const profileDir = resolve(opts.profile);
  const configPath = opts.config ? resolve(opts.config) : null;

  let config = null;
  let configProblem = null;
  if (configPath) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (e) {
      configProblem = `${configPath} could not be read as JSON: ${e.message}`;
    }
  }

  let logDir = opts.logDir ? resolve(opts.logDir) : newestLogDir(profileDir);
  const deadline = Date.now() + Math.max(0, opts.wait) * 1000;
  let text = "";
  let parsed = parseLog("");

  for (;;) {
    if (!opts.logDir) {
      const newest = newestLogDir(profileDir);
      if (newest) logDir = newest;
    }
    if (logDir) {
      try {
        text = readFileSync(join(logDir, "console.log"), "utf8");
        parsed = parseLog(text);
      } catch {
        /* the file may not exist yet */
      }
    }
    const settled = parsed.state === "ready" || parsed.state === "failed";
    if (settled || Date.now() >= deadline) break;
    if (!opts.wait) break;
    await sleep(500);
  }

  // How long the server needed, from the first log line to registration: useful as a baseline.
  let secondsToReady = null;
  const startedAt = /started at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(text);
  const registeredAt = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.[^\n]*Server registered with address:/.exec(text);
  if (startedAt && registeredAt) {
    const toMs = (s) => Date.parse(s.replace(" ", "T"));
    const a = toMs(startedAt[1]);
    const b = toMs(registeredAt[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) secondsToReady = Math.round((b - a) / 1000);
  }

  const table = opts.sockets ? socketTable() : { rows: null, error: null };
  const sockets = table.rows;
  const expected = config ? expectedPorts(config) : [];
  const portRows = expected.map((e) => {
    const socket = sockets ? sockets.find((s) => socketMatches(e, s)) ?? null : null;
    // An RCON socket that the config pinned to 127.0.0.1 but that came up on 0.0.0.0 is bound,
    // yet reachable from the network — exactly the mistake this check exists to catch.
    const wider = Boolean(socket) && !isWildcard(e.address) && isWildcard(socket.address);
    return { ...e, socket, bound: sockets ? Boolean(socket) : null, wider };
  });
  const missing = portRows.filter((r) => r.bound === false);
  const tooWide = portRows.filter((r) => r.wider);

  // The A2S port is the one endpoint that can be probed at the application level without a
  // password, and its answer names the server — so it doubles as proof that the port is not just
  // bound but answered. RCON needs the password; the report points at tools/rcon.mjs instead.
  let a2s = null;
  const a2sPort = expected.find((p) => p.role === "a2s");
  if (opts.a2s && config && a2sPort && a2sPort.port) {
    const host = isWildcard(a2sPort.address) ? "127.0.0.1" : a2sPort.address;
    a2s = { host, port: a2sPort.port, ...(await a2sInfo(host, a2sPort.port)) };
  }

  const ready = parsed.state === "ready";
  const allBound = portRows.length > 0 && sockets ? missing.length === 0 : null;

  // Everything that makes the verdict "not ready", in one list, so the exit code, the JSON and
  // the human output cannot disagree with each other.
  const problems = [];
  if (parsed.state === "failed") problems.push("the server failed — see the fatal lines above");
  if (parsed.state === "new") problems.push("no log yet: the server has probably not started, or -profile points elsewhere");
  if (parsed.state === "starting") problems.push("the log has not reached the RPL server yet (the world is still loading)");
  if (parsed.state === "listening") {
    problems.push(
      "the game port is up but the server never registered with the backend: no internet, a TLS/proxy" +
        " problem, or the server was launched inside a sandbox (run it outside one)"
    );
  }
  if (missing.length) problems.push(`UDP port(s) not bound on this host: ${missing.map((m) => `${m.role} ${m.port}`).join(", ")}`);
  for (const r of tooWide) {
    problems.push(
      `${r.role} is bound on every interface (${r.socket.address}:${r.port}) although the config says ${r.address} —` +
        " RCON grants full control and is protected by the password alone"
    );
  }
  if (opts.sockets && table.error) {
    problems.push(
      `the OS socket table could not be read (${table.error}) — the ports were NOT verified; ` +
        "re-run outside a sandbox, or pass --no-sockets for a log-only report"
    );
  }
  if (parsed.rconError) {
    problems.push("RCON is configured but did not start (usually the password: no spaces, at least 3 characters)");
  }
  const exitCode = problems.length === 0 ? 0 : 1;

  const report = {
    profile: profileDir,
    logDir,
    config: configPath,
    state: parsed.state,
    ready,
    secondsToReady,
    configProblem,
    cliParams: parsed.cliParams,
    configValid: parsed.configValid,
    configError: parsed.configError,
    world: parsed.world,
    rpl: parsed.rpl,
    registered: parsed.registered,
    joinCode: parsed.joinCode,
    pingSite: parsed.pingSite,
    rcon: parsed.rcon,
    rconError: parsed.rconError,
    missingAddon: parsed.missingAddon,
    tlsFailure: parsed.tlsFailure,
    fatal: parsed.fatal,
    sockets,
    socketsError: table.error,
    ports: portRows,
    a2s,
    problems,
    exitCode,
  };

  if (opts.out) writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2) + "\n");

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const say = (label, value) => console.log(`${label.padEnd(10)} ${value}`);
    say("profile:", profileDir);
    say("logs:", logDir ?? "(none — the server has not created a log directory yet)");
    if (configPath) say("config:", configPath + (configProblem ? `  (${configProblem})` : ""));
    say("state:", parsed.state + (secondsToReady !== null ? `  (registered ${secondsToReady} s after the log opened)` : ""));
    if (parsed.cliParams) say("command:", parsed.cliParams);
    if (parsed.configError) say("config:", parsed.configError);
    if (parsed.world) say("world:", parsed.world);
    if (parsed.rpl) say("network:", `listening ${parsed.rpl.address}:${parsed.rpl.port} (fastValidation=${parsed.rpl.fastValidation})`);
    if (parsed.registered) {
      say("backend:", `registered as ${parsed.registered.address}:${parsed.registered.port}`);
      if (parsed.joinCode) say("join code:", `${parsed.joinCode}${parsed.pingSite ? `  (ping site ${parsed.pingSite})` : ""}`);
    }
    if (parsed.rcon) say("rcon:", `${parsed.rcon.address}:${parsed.rcon.port}`);
    if (parsed.rconError) say("rcon:", `FAILED — ${parsed.rconError}`);
    for (const line of parsed.fatal) say("fatal:", line);
    if (parsed.missingAddon && parsed.missingAddon !== "58D0FB3206B6F859") {
      say("", "(the missing GUID is not the game itself, so an addon of the scenario or of a mod is absent)");
    }
    if (parsed.missingAddon === "58D0FB3206B6F859") {
      say("", "the working directory was not the server directory — relaunch after cd into it");
    }
    if (parsed.tlsFailure) {
      say("backend:", "TLS failure — a server started inside a sandbox cannot reach the backend; run it outside one");
    }

    if (portRows.length) {
      console.log("\nport   expected              " + (sockets ? "bound                " : "") + "role");
      for (const r of portRows) {
        const expectedText = `${isWildcard(r.address) ? "0.0.0.0" : r.address}:${r.port}`;
        const boundText = sockets
          ? r.bound
            ? `${r.socket.address}:${r.socket.port} (pid ${r.socket.pid})${r.wider ? " ALL INTERFACES" : ""}`
            : "MISSING"
          : table.error
            ? "(socket table unavailable)"
            : "(not checked)";
        console.log(`${r.role.padEnd(6)} ${expectedText.padEnd(21)} ${sockets ? boundText.padEnd(21) : ""} ${r.label}`);
      }
      if (table.error) console.log(`\nsocket table unavailable: ${table.error}`);
    } else if (configPath) {
      console.log("\nno expected ports: this config has no game/a2s/rcon section to check");
    }

    if (a2s) {
      if (a2s.answered && a2s.reply?.type === "info") {
        console.log(
          `a2s:       answered — "${a2s.reply.name}", map ${a2s.reply.map}, ` +
            `${a2s.reply.players}/${a2s.reply.maxPlayers} players` +
            (config?.game?.maxPlayers && a2s.reply.maxPlayers !== config.game.maxPlayers
              ? ` (the config says maxPlayers ${config.game.maxPlayers})`
              : "")
        );
      } else {
        console.log(`a2s:       no answer from ${a2s.host}:${a2s.port} (${a2s.reason ?? a2s.reply?.reason ?? "unknown"})`);
      }
    }

    console.log("");
    if (problems.length === 0) {
      console.log(
        "verdict:   ready — the log shows registration" +
          (sockets ? " and every expected UDP port is bound" : " (the socket check was skipped)")
      );
      console.log("next:      RCON: node tools/rcon.mjs players --password <rcon.password> --port " + (parsed.rcon?.port ?? 19999));
      console.log(
        "           from outside the host: forward " +
          (portRows.filter((r) => r.role !== "rcon").map((r) => `${r.port}/udp`).join(" and ") || "the game port") +
          (parsed.rcon && parsed.rcon.address === "0.0.0.0" ? ` and ${parsed.rcon.port}/udp` : "") +
          " on the router; a bound socket here does not prove the router forwards it"
      );
    } else {
      console.log("verdict:   NOT ready");
      for (const p of problems) console.log(`           - ${p}`);
    }
  }

  process.exit(exitCode);
}

if (isMain()) await main();
