#!/usr/bin/env node
// Talk to a running Arma Reforger dedicated server over its RCON.
//
//   node tools/rcon.mjs <subcommand> [options]
//
// Subcommands
//   probe                          log in with every plausible framing, report which is answered
//   players                        list the players in the session: playerId, identity id, name
//   ban list [page]                the server's ban list (25 per page over RCON, 10 in chat)
//   ban create <id|name> <sec> [reason...]
//   ban remove <id|name>
//   kick <playerId>
//   shutdown | restart             convenience wrappers around `cmd`
//   cmd <text...>                  any other command, verbatim (no leading '#')
//
// Options
//   --host <ip>       default 127.0.0.1
//   --port <n>        default 19999
//   --password <pw>   or the RCON_PASSWORD environment variable
//   --quiet-ms <ms>   stop waiting after this much silence (default 1500)
//   --timeout <ms>    hard cap on the whole exchange (default 20000)
//   --json            machine-readable result on stdout, nothing else
//   --raw             also dump every packet as hex and ascii
//   --help
//
// WHY THIS EXISTS. The wire format used to be this repository's largest open question: the BI
// wiki documents no protocol at all, and the documents here could only say that the transport is
// UDP. It was settled by experiment on 1.8.0.13, and the answer is the BattlEye RCon Protocol v2
// (https://www.battleye.com/downloads/BERConProtocol.txt):
//
//   header, 7 bytes, every packet, both directions
//     'B' 0x42 | 'E' 0x45 | CRC32 of the following bytes, little-endian | 0xFF
//   payload
//     0x00 | password            client -> server   log in
//     0x00 | 0x01 | 0x00         server -> client   0x01 = logged in, 0x00 = denied
//     0x01 | seq | command       client -> server   a command
//     0x01 | seq [| response]    server -> client   accepted; the answer usually follows as 0x02
//     0x02 | seq | text          server -> client   console message, must be acknowledged
//     0x02 | seq                 client -> server   that acknowledgement
//     0x01 | seq                 client -> server   empty command, the keep-alive
//
// Two findings this tool encodes, so that nobody has to rediscover them:
//   * the server does NOT check the CRC of what it receives. Four logins differing only in how the
//     checksum was computed — over the payload alone and over 0xFF|payload, each little- and
//     big-endian — were all authorized. What the server sends is crc32(0xFF|payload), LE, so that
//     is what this tool sends.
//   * the 7-byte header is mandatory: the same login sent as a bare payload got no answer at all.
//     `probe` exists to re-establish both facts on a different build, where either may have moved.
//
// Documented in docs/en/ArmaReforger_RCON_EN.md §1.1 (RU mirror in docs/ru/).
//
// SAFETY. RCON is full control over the server, and the subcommands here are not read-only:
// `ban create`, `ban remove`, `kick`, `restart` and `shutdown` change state or disconnect people.
// Ask before running those against somebody else's server. The password is taken from
// RCON_PASSWORD when the flag is absent, so it does not have to appear in the command line.
//
// Exit codes: 0 ok, 2 usage, 3 login refused, 4 no answer from the server,
//             5 the server answered with a failure ("Failed to create ban." and friends).
import dgram from "node:dgram";

// --------------------------------------------------------------------------- CRC32 (IEEE, zlib)
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Framings worth trying when the question is "what does this build expect".
// 1 is the one this tool uses and the one the server itself emits.
const FRAMINGS = {
  1: { name: "BE + crc32(0xFF|payload) LE + 0xFF", build: (p) => frame(crc32(Buffer.concat([Buffer.from([0xff]), p])), "le", p) },
  2: { name: "BE + crc32(payload) LE + 0xFF", build: (p) => frame(crc32(p), "le", p) },
  3: { name: "BE + crc32(payload) BE + 0xFF", build: (p) => frame(crc32(p), "be", p) },
  4: { name: "BE + crc32(0xFF|payload) BE + 0xFF", build: (p) => frame(crc32(Buffer.concat([Buffer.from([0xff]), p])), "be", p) },
  5: { name: "bare payload, no header", build: (p) => p },
};
const FRAMING_DEFAULT = 1;

function frame(crc, order, payload) {
  const bytes = Buffer.alloc(4);
  if (order === "le") bytes.writeUInt32LE(crc, 0);
  else bytes.writeUInt32BE(crc, 0);
  return Buffer.concat([Buffer.from("BE", "ascii"), bytes, Buffer.from([0xff]), payload]);
}

function parsePacket(buf) {
  const packet = { length: buf.length, hasHeader: false, body: buf, text: "", type: null, seq: null };
  if (buf.length >= 8 && buf[0] === 0x42 && buf[1] === 0x45) {
    packet.hasHeader = true;
    packet.body = buf.subarray(7);
    const body = packet.body;
    packet.crcStored = buf.readUInt32LE(2);
    packet.crcComputed = crc32(Buffer.concat([Buffer.from([0xff]), body]));
    packet.crcMatches = packet.crcStored === packet.crcComputed;
  }
  const body = packet.body;
  if (body.length >= 1) packet.type = body[0];
  if (body.length >= 2) packet.seq = body[1];
  if (body.length > 2) {
    // A response split across packets carries a 0x00|count|index header (BE v2). Never seen from
    // this build, which sends each message as its own 0x02 packet, but cheap to tolerate.
    if (body[2] === 0x00 && body.length >= 5 && body[3] >= 1) {
      packet.chunk = { count: body[3], index: body[4] };
      packet.text = body.subarray(5).toString("latin1");
    } else {
      packet.text = body.subarray(2).toString("latin1");
    }
  }
  return packet;
}

// ------------------------------------------------------------------------------------ result
// Answers that mean the command did not do what was asked. Deliberately not listed: the empty
// ban list (`Server has no bans to list.`) and the ambiguous-name hint
// (`Multiple users found! …`) — both are normal answers, and the guide says so.
const FAILURES = [
  /^Failed to (create|remove|list) ban/,
  /^Timeout$/,
  /^Unknown error\./,
  /^Not Valid /,
  /^Player not found/,
  /^User not found!/,
  /^Command is supported only on Dedicated Servers/,
];

class Rcon {
  constructor(opts) {
    this.opts = opts;
    this.seq = 0;
    this.messages = [];
    this.ack = null;
    this.loggedIn = false;
    this.denied = false;
    this.clientId = null;
    this.lastPacketAt = 0;
    this.sawPacket = false;
    this.socket = null;
  }

  packet(payload, framing = FRAMING_DEFAULT) {
    return (FRAMINGS[framing] ?? FRAMINGS[FRAMING_DEFAULT]).build(payload);
  }

  send(payload) {
    this.socket.send(this.packet(payload), this.opts.port, this.opts.host);
    if (this.opts.raw) console.error(`-> ${hex(payload)}  ${printable(payload)}`);
  }

  login() {
    const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(this.opts.password, "ascii")]);
    this.send(payload);
  }

  command(text) {
    const payload = Buffer.concat([Buffer.from([0x01, this.seq & 0xff]), Buffer.from(text, "ascii")]);
    this.seq = (this.seq + 1) & 0xff;
    this.send(payload);
  }

  onPacket(msg, rinfo) {
    const packet = parsePacket(msg);
    this.lastPacketAt = Date.now();
    this.sawPacket = true;
    if (this.opts.raw) {
      console.error(`<- ${hex(msg).slice(0, 240)}`);
      console.error(`   ${printable(msg).slice(0, 240)}`);
    }
    if (packet.type === 0x00) {
      if (packet.body[1] === 0x01) this.loggedIn = true;
      else this.denied = true;
      return;
    }
    if (packet.type === 0x01) {
      this.ack = { seq: packet.seq, response: packet.text };
      return;
    }
    if (packet.type === 0x02) {
      // Every server message must be acknowledged or the server drops the client.
      this.socket.send(this.packet(Buffer.from([0x02, packet.seq ?? 0])), this.opts.port, this.opts.host);
      if (packet.text) {
        this.messages.push(packet.text);
        const id = /^Logged In! Client ID: #(\d+)/.exec(packet.text);
        if (id) this.clientId = Number(id[1]);
      }
      return;
    }
    if (this.opts.raw) console.error(`   (unknown packet type 0x${(packet.type ?? 0).toString(16)})`);
  }

  async run(commands) {
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg, rinfo) => this.onPacket(msg, rinfo));
    await new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, "127.0.0.1", resolve);
    });

    this.login();
    await this.settle();
    if (!this.loggedIn) {
      const message = this.denied
        ? "login refused — wrong rcon.password?"
        : "no answer to the login";
      const hint = this.denied
        ? ""
        : ". RCON may be off (is rcon.password set?), the port may be wrong, or the client list may be full: a stale client holds its slot for 45 s and rcon.maxClients can be as low as 1";
      throw Object.assign(new Error(message + hint), { code: this.denied ? 3 : 4 });
    }

    for (const text of commands) {
      this.command(text);
      await this.settle();
      if (/^Processing Command:/.test(this.messages[this.messages.length - 1] ?? "")) await this.settle();
    }
    this.socket.close();
  }

  // Wait until the server has been silent for quiet-ms, but never longer than timeout.
  async settle() {
    const started = Date.now();
    this.lastPacketAt = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const now = Date.now();
      if (now - started > this.opts.timeout) return;
      if (this.sawPacket && now - this.lastPacketAt >= this.opts.quietMs) return;
      if (!this.sawPacket && now - started > Math.min(2000, this.opts.timeout)) return;
    }
  }
}

const hex = (b) => b.toString("hex").replace(/(..)(?=.)/g, "$1 ").trim();
const printable = (b) => b.toString("latin1").replace(/[^\x20-\x7e]/g, ".");

// --------------------------------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const VALUE_FLAGS = ["--host", "--port", "--password", "--quiet-ms", "--timeout", "--framings"];

function parseArgs() {
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) continue;
    if (a.startsWith("-")) continue;
    if (VALUE_FLAGS.includes(argv[i - 1])) continue;
    rest.push(a);
  }
  return {
    sub: rest[0] ?? null,
    args: rest.slice(1),
    host: flagValue("--host") ?? "127.0.0.1",
    port: Number(flagValue("--port") ?? 19999),
    password: flagValue("--password") ?? process.env.RCON_PASSWORD ?? "",
    quietMs: Number(flagValue("--quiet-ms") ?? 1500),
    timeout: Number(flagValue("--timeout") ?? 20000),
    framings: (flagValue("--framings") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n)),
    json: argv.includes("--json"),
    raw: argv.includes("--raw"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

const USAGE = `usage: node tools/rcon.mjs <subcommand> [options]

subcommands
  probe                             log in with every plausible framing, report which is answered
  players                           list the players in the session
  ban list [page]                   the server's ban list
  ban create <id|name> <sec> [reason...]
  ban remove <id|name>
  kick <playerId>
  shutdown | restart                shut the server down / restart the scenario
  cmd <text...>                     any other command, verbatim (no leading '#')

options
  --host <ip>      default 127.0.0.1
  --port <n>       default 19999 (rcon.port in server.json)
  --password <pw>  or the RCON_PASSWORD environment variable
  --quiet-ms <ms>  stop waiting after this much silence (default 1500)
  --timeout <ms>   hard cap on the whole exchange (default 20000)
  --framings <list> probe only: which framings to try, e.g. --framings 1 or --framings 1,5
  --json           machine-readable result on stdout
  --raw            dump every packet as hex and ascii to stderr
  --help

examples
  node tools/rcon.mjs players --password secret
  node tools/rcon.mjs ban list 1 --json --password secret
  node tools/rcon.mjs ban create 1 3600 "teamkilling" --password secret
  node tools/rcon.mjs probe --framings 5 --password secret

each probe framing is a separate client, and an RCON server keeps a slot per client for 45 s:
with a low rcon.maxClients, test one framing per run or yourself exhaust the list.

exit codes: 0 ok, 2 usage, 3 login refused, 4 no answer, 5 the server reported a failure`;

function buildCommands(opts) {
  const [a, b, ...tail] = opts.args;
  switch (opts.sub) {
    case "players":
      return ["players"];
    case "ban":
      if (a === "list") return [`ban list ${b ?? 1}`];
      if (a === "create") {
        if (!b || !tail[0]) return { error: "ban create needs <id|name> <seconds> [reason]" };
        return [`ban create ${b} ${tail[0]} ${tail.slice(1).join(" ")}`.trim()];
      }
      if (a === "remove") {
        if (!b) return { error: "ban remove needs <identityId|name>" };
        return [`ban remove ${b}`];
      }
      return [`ban ${a ?? ""}`.trim()];
    case "kick":
      if (!a) return { error: "kick needs <playerId>" };
      return [`kick ${a}`];
    case "shutdown":
      return ["shutdown"];
    case "restart":
      return ["restart"];
    case "cmd":
      return opts.args.length ? [opts.args.join(" ")] : { error: "cmd needs a command" };
    default:
      return { error: `unknown subcommand ${opts.sub ? `'${opts.sub}'` : "(none given)"}` };
  }
}

// -------------------------------------------------------------------------------------- probe
async function probe(opts) {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(opts.password, "ascii")]);
  const wanted = opts.framings.length ? opts.framings : Object.keys(FRAMINGS).map(Number);
  const results = [];
  for (const id of wanted) {
    const framing = FRAMINGS[id];
    if (!framing) continue;
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const localPort = socket.address().port;
    const seen = [];
    socket.on("message", (msg) => seen.push(parsePacket(msg)));
    await new Promise((r) => setTimeout(r, 120));
    socket.send(framing.build(payload), opts.port, opts.host);
    await new Promise((r) => setTimeout(r, 900));
    socket.close();
    const answer = seen.find((p) => p.type === 0x00) ?? null;
    results.push({
      framing: Number(id),
      name: framing.name,
      localPort,
      answered: Boolean(answer),
      accepted: answer ? answer.body[1] === 0x01 : null,
      messages: seen.filter((p) => p.type === 0x02).map((p) => p.text),
    });
  }
  const accepted = results.filter((r) => r.accepted);
  if (opts.json) {
    console.log(JSON.stringify({ host: opts.host, port: opts.port, framings: results }, null, 2));
  } else {
    console.log(`probe of ${opts.host}:${opts.port}, login payload 00|"${opts.password}"\n`);
    for (const r of results) {
      const verdict = r.accepted ? "AUTHORIZED" : r.answered ? "answered, denied" : "no answer";
      console.log(`  framing ${r.framing}  localPort ${r.localPort}  ${verdict}`);
      console.log(`    ${r.name}`);
      for (const m of r.messages) console.log(`    <- ${JSON.stringify(m)}`);
    }
    console.log(
      `\n${accepted.length} of ${results.length} framings authorized. ` +
        (accepted.length > 1
          ? "The 7-byte header is expected and its CRC is not verified."
          : accepted.length === 1
            ? `Only framing ${accepted[0].framing} is accepted — use it.`
            : "Nothing was authorized: is RCON enabled, and is the password right?")
    );
    const silent = results.filter((r) => !r.answered).length;
    if (accepted.length > 0 && silent > 0) {
      console.log(
        `\nNote: ${silent} framing(s) were not answered at all. A framing that is merely wrong is\n` +
          "usually still answered (the server logs `Invalid packet received` and stays quiet), so\n" +
          "silence after a successful login means the RCON client list is full: stale clients keep\n" +
          "their slot for 45 s, and `rcon.maxClients` may be as low as 1. Wait, then probe again —\n" +
          "`probe` itself occupies one slot per framing."
      );
    }
  }
  return accepted.length ? 0 : 4;
}

// ---------------------------------------------------------------------------------------- main
const opts = parseArgs();
if (opts.help || !opts.sub) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}
if (!opts.password && opts.sub !== "probe") {
  console.error("error: no password. Pass --password <pw> or set RCON_PASSWORD (rcon.password in server.json).");
  process.exit(2);
}

if (opts.sub === "probe") process.exit(await probe(opts));

const commands = buildCommands(opts);
if (commands.error) {
  console.error(`error: ${commands.error}\n\n${USAGE}`);
  process.exit(2);
}

const rcon = new Rcon(opts);
let exitCode = 0;
try {
  await rcon.run(commands);
  if (!rcon.sawPacket) exitCode = 4;
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(err.code ?? 4);
}

const failure = rcon.messages.find((m) => FAILURES.some((re) => re.test(m.trim())));
if (!rcon.loggedIn) exitCode = rcon.denied ? 3 : 4;
else if (failure) exitCode = 5;

const players = [];
if (opts.sub === "players") {
  for (const text of rcon.messages) {
    for (const line of text.split("\n")) {
      const parts = line.split(";").map((s) => s.trim());
      if (parts.length === 3 && /^\d+$/.test(parts[0])) players.push({ playerId: Number(parts[0]), uid: parts[1], name: parts[2] });
    }
  }
}

const result = {
  host: opts.host,
  port: opts.port,
  command: commands.join(" && "),
  loggedIn: rcon.loggedIn,
  clientId: rcon.clientId,
  ack: rcon.ack,
  messages: rcon.messages,
  players: opts.sub === "players" ? players : undefined,
  error: failure ?? null,
};

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${opts.host}:${opts.port}  login: ${rcon.loggedIn ? `ok, client #${rcon.clientId}` : "FAILED"}`);
  console.log(`command: ${result.command}`);
  if (rcon.ack) console.log(`ack: seq=${rcon.ack.seq}${rcon.ack.response ? `  ${JSON.stringify(rcon.ack.response)}` : ""}`);
  for (const m of rcon.messages) console.log(m);
  if (opts.sub === "players") {
    console.log("");
    console.table(players.length ? players : [{ playerId: "-", uid: "-", name: "(nobody connected)" }]);
  }
  if (failure) console.error(`the server reported a failure: ${failure.trim()}`);
}

process.exit(exitCode);
