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
//   shell                          interactive session: type commands, read answers, see the status
//
// Options
//   --host <ip>       default 127.0.0.1
//   --port <n>        default 19999
//   --password <pw>   or the RCON_PASSWORD environment variable
//   --quiet-ms <ms>   stop waiting after this much silence (default 1500)
//   --timeout <ms>    hard cap on one exchange (default 20000)
//   --no-logout       do not send @logout on the way out (leaves the slot busy for 45 s)
//   --logout-wait <ms> how long to wait for the @logout acknowledgement (default 800)
//   --keep-alive <ms> shell only: idle keep-alive interval, 0 disables (default 20000)
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
//     0x01 | seq [| response]    server -> client   the command was accepted
//     0x02 | seq | text          server -> client   a console message, must be acknowledged
//     0x02 | seq                 client -> server   that acknowledgement
//     0x01 | seq                 client -> server   empty command, the keep-alive
//
// Findings this tool encodes, so that nobody has to rediscover them:
//   * the server does NOT check the CRC of what it receives. Four logins differing only in how the
//     checksum was computed — over the payload alone and over 0xFF|payload, each little- and
//     big-endian — were all authorized. What the server sends is crc32(0xFF|payload), LE, so that
//     is what this tool sends.
//   * the 7-byte header is mandatory: the same login sent as a bare payload got no answer at all.
//     `probe` exists to re-establish both facts on a different build, where either may have moved.
//   * **the sequence number is checked, and a mismatch is silent.** A command sent with a wrong
//     `seq` — the first command of a session must be 0 — is acknowledged with `0x01|seq` and then
//     ignored outright: no game command runs, no message comes back, and the server writes no log
//     line at all. An acknowledgement is therefore not a success signal.
//   * **`@logout` is a protocol command, and it frees the slot at once.** `0x01|seq|@logout` makes
//     the server log `[RCON] [CLIENT: n] Received Protocol Command: @logout` followed by
//     `[RCON] Client n logged out!`, and the next client is authorized as `#0` with
//     `Connected clients: [1/n]` — no 45-second wait. The BattlEye specification has no logout
//     packet, so this is Bohemia's own addition, and it is what this tool sends before closing;
//     see §6.3 of docs/en/ArmaReforger_RCON_EN.md.
//
// Documented in docs/en/ArmaReforger_RCON_EN.md (RU mirror in docs/ru/).
//
// SAFETY. RCON is full control over the server, and the subcommands here are not read-only:
// `ban create`, `ban remove`, `kick`, `restart`, `shutdown` and anything typed into `shell` change
// state or disconnect people. Ask before running those against somebody else's server. The
// password is taken from RCON_PASSWORD when the flag is absent, so it does not have to appear in
// the command line.
//
// Exit codes: 0 ok, 2 usage — a missing subcommand or argument, checked by the client itself in the
//               shell as well as on the command line, so nothing is sent — 3 login refused,
//             4 no answer from the server, which includes an acknowledgement with no message at all
//               (an unknown protocol command such as `@foo` behaves that way: the server acks the
//               packet and does nothing with it, so counting packets would call it a success),
//             5 the server answered with a failure ("Failed to create ban.", "Player not found",
//               "invalid parameters '<cmd>'", "missing permission '<cmd>'", "unknown command",
//               and the help screen a bare `ban` answers with when it goes out through `cmd`),
//             130 interrupted.
//             `shell` exits with the status of the last command it ran, or 0 if it ran none.
// Ctrl-C is a clean exit rather than a kill: @logout goes out first, so the slot is free, and then
// the process ends with 130. In `shell` that is what .exit does too, and typing the @logout protocol
// command by hand leaves the shell as well — the session is over either way, and a client that stays
// open on it can only collect silence. A second Ctrl-C ends the process at once.
import dgram from "node:dgram";
import readline from "node:readline";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const hex = (b) => b.toString("hex").replace(/(..)(?=.)/g, "$1 ").trim();
const printable = (b) => b.toString("latin1").replace(/[^\x20-\x7e]/g, ".");

// ------------------------------------------------------------------------------------ result
// Answers that mean the command did not do what was asked. Deliberately not listed: the empty
// ban list (`Server has no bans to list.`) and the ambiguous-name hint
// (`Multiple users found! …`) — both are normal answers, and the guide says so.
//
// The first four are the engine's own routing answers, and they arrive *after* `Processing
// Command: …`, which is why an acknowledgement plus a "Processing" note is still not a success.
// They are the four failure kinds of `EServerCmdResultType` as an RCON client sees them, and the
// binary carries the literals in one table next to `RCONCommandHandler: Executing command {%s}.`:
// `missing permission`, `unknown command`, `the server is busy`, `invalid parameters`, composed
// with the command text by the format `%s '%s'`. Observed live on 1.8.0.13: `missing permission
// 'kick 1'` (a `monitor` server), `unknown command 'nonsense'`, and `invalid parameters 'kick'`
// for `kick` with no argument — the last one is why an answer-less command is not automatically a
// success. `the server is busy` was not reproduced (it needs a BUSY result type) and is listed
// from the binary alone.
const FAILURES = [
  /^missing permission/i,
  /^unknown command/i,
  /^invalid parameters/i,
  /^the server is busy/i,
  /^Failed to (create|remove|list) ban/,
  /^Timeout$/,
  /^Unknown error\./,
  /^Not Valid /,
  /^Player not found/,
  /^User not found!/,
  /^Command is supported only on Dedicated Servers/,
];

// A bare `#ban` is answered with the command's own help screen. It is a real answer, but nothing
// was banned and no subcommand was given, so it is reported as a missing-parameter failure — with
// a summary of its own instead of the multi-line help as the error text. Only the *answer* decides
// this: `ban list` and friends answer with their results, not with this.
const BAN_HELP = /^Help for ban command\./;
const BAN_HELP_ERROR = "missing parameters: 'ban' needs a subcommand (create | remove | list)";

// The one place that turns a command's messages into a verdict: the engine's routing answers, the
// ban help screen, and the answers of the commands themselves.
function classifyAnswer(messages) {
  const lines = messages.map((m) => m.trim());
  if (lines.some((m) => BAN_HELP.test(m))) return BAN_HELP_ERROR;
  return lines.find((m) => FAILURES.some((re) => re.test(m))) ?? null;
}

const LOGOUT_COMMAND = "@logout";
// Why a run may end without a logout: the server is going away, so there is nobody to answer one.
const SHUTDOWN_REASON = "the server is shutting down";
// Commands observed answering with nothing but their `Processing Command:` note. Waiting for a
// second message from them buys nothing and costs the whole timeout (twenty seconds of a shell that
// looks hung), so the second wait is skipped for these two.
const ANSWERS_ONLY_PROCESSING = /^(restart|shutdown)$/i;

// ------------------------------------------------------------------ parsing answers into tables
// Two answers carry a list, and both are printed as a table instead of the raw message (the raw
// messages are still kept, and the parsed values sit next to them in JSON as `players` and `bans`):
//
//   players    "Players on server: [Player#] ; [Player UID] ; [Player Name]"
//              "1 ; 0ac6169c-15e4-4b5d-8073-08e602583069 ; kolya_500"
//   ban list   "Total bans: 1 | Page: 1/1"
//              "- Identity Id | Banned name"
//              "- 0ac6169c-15e4-4b5d-8073-08e602583069 | kolya_500"
//
// Both were taken off the wire on 1.8.0.13 (§4.6 of the RCON document); the ban list arrives as one
// message with embedded newlines, which is why every check here works line by line.
const PLAYERS_HEADER = /^Players on server:/i;
const PLAYER_ROW = /^\d+\s*;/;
const BANS_HEADER = /^Total bans:\s*(\d+)\s*\|\s*Page:\s*(\d+)\s*\/\s*(\d+)/i;
const BAN_ROW = /^-\s*(.+?)\s*\|\s*(.*)$/;
const BAN_COLUMNS = /^-\s*Identity Id\s*\|/i;

const linesOf = (message) => message.split("\n").map((line) => line.trim()).filter(Boolean);

// True for a message that is nothing but part of such a listing: that is what the table replaces.
function isPlayerListing(message) {
  const lines = linesOf(message);
  return lines.length > 0 && lines.every((line) => PLAYERS_HEADER.test(line) || PLAYER_ROW.test(line));
}

function isBanListing(message) {
  const lines = linesOf(message);
  return lines.length > 0 && lines.every((line) => BANS_HEADER.test(line) || /^-\s/.test(line));
}

function parsePlayers(messages) {
  let sawHeader = false;
  const players = [];
  for (const message of messages) {
    for (const line of linesOf(message)) {
      if (PLAYERS_HEADER.test(line)) {
        sawHeader = true;
        continue;
      }
      const parts = line.split(";").map((s) => s.trim());
      if (parts.length === 3 && /^\d+$/.test(parts[0])) {
        players.push({ playerId: Number(parts[0]), uid: parts[1], name: parts[2] });
      }
    }
  }
  return sawHeader ? players : null;
}

function parseBans(messages) {
  let header = null;
  const entries = [];
  for (const message of messages) {
    for (const line of linesOf(message)) {
      const head = BANS_HEADER.exec(line);
      if (head) {
        header = { total: Number(head[1]), page: Number(head[2]), pages: Number(head[3]) };
        continue;
      }
      const row = BAN_ROW.exec(line);
      if (row && !BAN_COLUMNS.test(line)) entries.push({ identityId: row[1], name: row[2] });
    }
  }
  return header ? { ...header, entries } : null;
}

function renderTable(rows, columns) {
  const cells = rows.map((row) => columns.map((column) => String(row[column] ?? "")));
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((row) => row[i].length)));
  const rule = (left, middle, right) => left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right;
  const row = (values) => `│ ${values.map((v, i) => v.padEnd(widths[i])).join(" │ ")} │`;
  return [rule("┌", "┬", "┐"), row(columns), rule("├", "┼", "┤"), ...cells.map(row), rule("└", "┴", "┘")];
}

function playersTable(players) {
  const rows = players.length ? players : [{ playerId: "-", uid: "-", name: "(nobody connected)" }];
  return renderTable(rows, ["playerId", "uid", "name"]);
}

function bansTable(bans) {
  return [`Total bans: ${bans.total} | Page: ${bans.page}/${bans.pages}`, ...renderTable(bans.entries, ["identityId", "name"])];
}

// Print one answer. The table stands in for the messages it was parsed from, where the first of them
// was; everything else — `Processing Command: …`, errors, the session's own notes — is printed as it
// arrived. A parsed answer that arrived with no matching message still gets its table.
function printAnswer(messages, parsed, write) {
  let shownPlayers = false;
  let shownBans = false;
  for (const message of messages) {
    if (parsed.players && isPlayerListing(message)) {
      if (!shownPlayers) {
        shownPlayers = true;
        playersTable(parsed.players).forEach(write);
      }
      continue;
    }
    if (parsed.bans && isBanListing(message)) {
      if (!shownBans) {
        shownBans = true;
        bansTable(parsed.bans).forEach(write);
      }
      continue;
    }
    write(message);
  }
  if (parsed.players && !shownPlayers) playersTable(parsed.players).forEach(write);
  if (parsed.bans && !shownBans) bansTable(parsed.bans).forEach(write);
}

// --------------------------------------------------------------------------------------- Rcon
class Rcon {
  constructor(opts) {
    this.opts = opts;
    this.seq = 0;
    this.messages = [];
    this.packets = 0;
    this.ack = null;
    this.loggedIn = false;
    this.denied = false;
    this.clientId = null;
    this.loggedOut = false;
    this.logoutAck = null;
    this.noLogoutReason = null;
    this.aborted = false;
    this.lastPacketAt = 0;
    this.lastRequestAt = 0;
    this.keepAliveTimer = null;
    this.socket = null;
  }

  packet(payload, framing = FRAMING_DEFAULT) {
    return (FRAMINGS[framing] ?? FRAMINGS[FRAMING_DEFAULT]).build(payload);
  }

  send(payload) {
    this.socket.send(this.packet(payload), this.opts.port, this.opts.host);
    if (this.opts.raw) console.error(`-> ${hex(payload)}  ${printable(payload)}`);
  }

  command(text) {
    const seq = this.seq & 0xff;
    this.ack = null; // a stale acknowledgement must not be read as this command's
    this.send(Buffer.concat([Buffer.from([0x01, seq]), Buffer.from(text, "ascii")]));
    this.seq = (this.seq + 1) & 0xff;
    this.lastRequestAt = Date.now();
    return seq;
  }

  // The specification's keep-alive: an empty 2-byte command packet, needed at least every 45 s.
  keepAlive() {
    const seq = this.seq & 0xff;
    this.send(Buffer.from([0x01, seq]));
    this.seq = (this.seq + 1) & 0xff;
    this.lastRequestAt = Date.now();
    return seq;
  }

  onPacket(msg) {
    const packet = parsePacket(msg);
    this.packets += 1;
    this.lastPacketAt = Date.now();
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

  async connect() {
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg) => this.onPacket(msg));
    // Keep socket errors instead of letting them become an uncaught 'error' event, and keep them as
    // the likeliest explanation for a login nobody answers: a host that does not resolve, a port
    // nothing is listening on.
    this.socket.on("error", (err) => {
      this.socketError = err;
    });
    await new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, "127.0.0.1", resolve);
    });
  }

  async login() {
    const since = this.packets;
    this.send(Buffer.concat([Buffer.from([0x00]), Buffer.from(this.opts.password, "ascii")]));
    await this.settle(since);
    if (!this.loggedIn) {
      if (this.denied) {
        throw Object.assign(new Error("login refused — wrong rcon.password?"), { code: 3 });
      }
      const transport = this.socketError
        ? `. The socket reported: ${this.socketError.message} — that is a local transport problem, not` +
          " a statement about the server"
        : ". Nothing came back at all, which has four causes worth telling apart before doubting" +
          " anything: RCON is off (is rcon.password set? is [RCON] Init in console.log?), the port" +
          " or protocol is wrong (the transport is UDP), the client list is full — this build drops" +
          " such packets with `[RCON] Client List is full! Dropping connection with <ip>:<port>`" +
          " and answers nothing for 45 s — or the framing differs on this build. `probe` tells" +
          " the first three from the last.";
      throw Object.assign(new Error(`no answer to the login${transport}`), { code: 4 });
    }
  }

  // Run one command and collect only the answer that belongs to it.
  async exec(text) {
    const since = this.packets;
    const from = this.messages.length;
    const started = Date.now();
    const seq = this.command(text);
    await this.settle(since);
    // A backend-backed answer arrives in two steps: a "Processing …" note, then the real answer.
    // The second wait must not use the short grace for "nothing came back at all" — that is the
    // normal state here, and the backend round trip can outlast it.
    const lastMessage = () => (this.messages[this.messages.length - 1] ?? "").trim();
    if (
      !ANSWERS_ONLY_PROCESSING.test(text.trim()) &&
      /^Processing (Command|ban list)/.test(lastMessage()) &&
      this.messages.length === from + 1
    ) {
      await this.settleQuiet(this.packets);
    }
    const messages = this.messages.slice(from);
    // "No answer" is judged by the messages, not by the packets. The server acknowledges every
    // command packet with `0x01|seq` even when it does nothing with it — an unknown protocol
    // command such as `@foo` gets that acknowledgement and nothing else — so counting packets
    // would call an acknowledged no-op a success. A command that answers only with its
    // `Processing Command: …` note (that is `#restart`) still has one message and stays ok.
    const silent = messages.length === 0;
    const failure = classifyAnswer(messages);
    // The answers that carry a list, parsed for the table and for JSON.
    const players = text.trim().toLowerCase() === "players" ? parsePlayers(messages) : null;
    const bans = /^ban list\b/i.test(text.trim()) ? parseBans(messages) : null;
    // The command *is* the logout: the session is over, so the caller's own logout would be a
    // second one sent by an unauthenticated client, and the server would only ignore it.
    if (/^@logout$/i.test(text.trim())) {
      this.loggedOut = true;
      this.noLogoutReason = "the command itself was @logout";
    }
    return {
      command: text,
      seq,
      ack: this.ack && this.ack.seq === seq ? this.ack : null,
      messages,
      ...(players ? { players } : {}),
      ...(bans ? { bans } : {}),
      ms: Date.now() - started,
      status: silent ? "no answer" : failure ? "failed" : "ok",
      error: failure,
      exitCode: silent ? 4 : failure ? 5 : 0,
    };
  }

  // `@logout` — the protocol command that frees this client's slot immediately instead of leaving
  // the server to time it out after 45 seconds. Returns what happened, never throws.
  async logout() {
    if (this.opts.noLogout || this.noLogoutReason || !this.loggedIn || this.loggedOut || !this.socket) {
      const reason = this.noLogoutReason
        ?? (this.opts.noLogout ? "--no-logout" : !this.loggedIn ? "not logged in" : "already logged out");
      return { sent: false, reason };
    }
    const seq = this.command(LOGOUT_COMMAND);
    this.loggedOut = true;
    this.logoutAck = await this.waitForAck(seq, this.opts.logoutWait);
    if (!this.logoutAck) await sleep(150);
    return { sent: true, seq, ack: this.logoutAck, acknowledged: Boolean(this.logoutAck) };
  }

  async waitForAck(seq, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.ack && this.ack.seq === seq) return this.ack;
      if (Date.now() >= deadline) return null;
      await sleep(50);
    }
  }

  startKeepAlive() {
    if (!this.opts.keepAliveMs) return;
    const tick = Math.max(1000, Math.min(this.opts.keepAliveMs, 5000));
    this.keepAliveTimer = setInterval(() => {
      if (this.busy || !this.loggedIn || this.loggedOut) return;
      if (Date.now() - this.lastRequestAt < this.opts.keepAliveMs) return;
      this.keepAlive();
    }, tick);
    this.keepAliveTimer.unref?.();
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  close() {
    this.stopKeepAlive();
    if (this.socket) this.socket.close();
    this.socket = null;
  }

  async run(commands) {
    await this.connect();
    await this.login();
    const results = [];
    for (const text of commands) results.push(await this.exec(text));
    // `shutdown` ends the server: there is nobody left to acknowledge a logout, and the slot goes
    // away with the process. Only when it was actually accepted — a refusal leaves the server up.
    if (results.some((r) => /^shutdown$/i.test(r.command.trim()) && r.status === "ok")) {
      this.noLogoutReason = SHUTDOWN_REASON;
    }
    const logout = await this.logout();
    this.close();
    return { results, logout };
  }

  // Wait until the server has been silent for quiet-ms, but never longer than timeout.
  // `since` is the packet counter from before the request: it is what separates "the server
  // answered this" from "the server said nothing at all". Without it, one command's silence is
  // masked by the previous command's packets.
  async settle(since) {
    const started = Date.now();
    this.lastPacketAt = Date.now();
    for (;;) {
      await sleep(100);
      if (this.aborted) return "aborted";
      const now = Date.now();
      if (now - started > this.opts.timeout) return "timeout";
      if (this.packets > since && now - this.lastPacketAt >= this.opts.quietMs) return "quiet";
      if (this.packets === since && now - started > Math.min(2000, this.opts.timeout)) return "silent";
    }
  }

  // The same wait without the "nothing came back" shortcut: for a second step that is expected to
  // arrive late, where silence means "the backend is slow", not "the server is not answering".
  // `aborted` is what lets an interrupt (Ctrl-C in the shell) end such a wait at once instead of
  // leaving the user staring at a frozen prompt for the rest of the timeout.
  async settleQuiet(since) {
    const started = Date.now();
    this.lastPacketAt = Date.now();
    for (;;) {
      await sleep(100);
      if (this.aborted) return "aborted";
      const now = Date.now();
      if (now - started > this.opts.timeout) return "timeout";
      if (this.packets > since && now - this.lastPacketAt >= this.opts.quietMs) return "quiet";
    }
  }
}

// --------------------------------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const VALUE_FLAGS = ["--host", "--port", "--password", "--quiet-ms", "--timeout", "--framings", "--logout-wait", "--keep-alive"];

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
    logoutWait: Number(flagValue("--logout-wait") ?? 800),
    keepAliveMs: Number(flagValue("--keep-alive") ?? 20000),
    // Empty means "every framing"; a plain .split(",") would turn that into [0] and test nothing.
    framings: (flagValue("--framings") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number),
    json: argv.includes("--json"),
    raw: argv.includes("--raw"),
    noLogout: argv.includes("--no-logout"),
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
  shell                             interactive session (see below)

options
  --host <ip>        default 127.0.0.1
  --port <n>         default 19999 (rcon.port in server.json)
  --password <pw>    or the RCON_PASSWORD environment variable
  --quiet-ms <ms>    stop waiting after this much silence (default 1500)
  --timeout <ms>     hard cap on one exchange (default 20000)
  --logout-wait <ms> how long to wait for the @logout acknowledgement (default 800)
  --no-logout        do not send @logout; the server then keeps the slot for 45 s
  --keep-alive <ms>  shell only: idle keep-alive interval, 0 disables (default 20000)
  --framings <list>  probe only: which framings to try, e.g. --framings 1 or --framings 1,5
  --json             machine-readable result on stdout
  --raw              dump every packet as hex and ascii to stderr
  --help

examples
  node tools/rcon.mjs players --password secret
  node tools/rcon.mjs ban list 1 --json --password secret
  node tools/rcon.mjs ban create 1 3600 "teamkilling" --password secret
  node tools/rcon.mjs shell --password secret
  node tools/rcon.mjs probe --framings 1 --password secret

every run ends with @logout, so the client's slot is released immediately instead of being held
for the 45-second timeout; pass --no-logout to keep the old behaviour.

Ctrl-C is a clean exit: @logout is sent first — so the slot is free — and the process ends with
130. In \`shell\` that is the same as .exit, which is also what the @logout protocol command typed
by hand does; a second Ctrl-C leaves at once.

The grammar of \`ban\` and \`kick\` is checked by the client, in the shell as well as on the command
line: a missing subcommand or argument is a usage error (2) and no packet is sent. \`cmd <text>\`
skips that check and shows what the server itself answers.

exit codes: 0 ok, 2 usage (including a bare \`ban\` or \`kick\`), 3 login refused, 4 no answer — which
            includes an acknowledgement with no message at all, such as an unknown protocol command
            — 5 the server reported a failure ("Player not found", "invalid parameters '<cmd>'",
            "missing permission '<cmd>'", "unknown command", and the help screen a bare 'ban'
            answers with when it is sent through \`cmd\`) — 130 after an interrupt`;

function buildCommands(opts) {
  const [a, b, ...tail] = opts.args;
  switch (opts.sub) {
    case "players":
      return ["players"];
    case "ban":
      // No arity checks here: `usageError` below is the single place that knows the grammar, and it
      // is applied to whatever this builds. `cmd` is the raw escape hatch and skips it.
      if (a === "list") return [`ban list ${b ?? 1}`];
      if (a === "create") return [`ban create ${b ?? ""} ${tail[0] ?? ""} ${tail.slice(1).join(" ")}`.trim()];
      if (a === "remove") return [`ban remove ${b ?? ""}`.trim()];
      return [`ban ${a ?? ""}`.trim()];
    case "kick":
      return [`kick ${a ?? ""}`.trim()];
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

const BAN_GRAMMAR = "list [page] | create <id|name> <seconds> [reason] | remove <id|name>";

// The grammar the client checks itself, before a packet goes out. The same function serves the
// command line and the shell, so `kick` with no argument is the same mistake in both — a usage
// error (exit 2) — instead of a usage error in one place and the server's answer in the other.
// What the *server* answers for the same text, when it is sent through `cmd`, is a different
// question and is classified where the answer is read.
function usageError(text) {
  const words = text.trim().split(/\s+/);
  const [command, sub] = words;
  if (command === "kick" && words.length < 2) return "kick needs <playerId>";
  if (command !== "ban") return null;
  if (words.length < 2) return `ban needs a subcommand: ${BAN_GRAMMAR}`;
  if (!["list", "create", "remove"].includes(sub)) return `unknown ban subcommand '${sub}': ${BAN_GRAMMAR}`;
  if (sub === "create" && words.length < 4) return "ban create needs <id|name> <seconds> [reason]";
  if (sub === "remove" && words.length < 3) return "ban remove needs <identityId|name>";
  return null;
}

// -------------------------------------------------------------------------------------- probe
// One framing, one client, and — this is what makes `probe` usable on a server whose
// rcon.maxClients is small — the client logs out again before the next framing is tried.
async function probeFraming(opts, id) {
  const framing = FRAMINGS[id];
  const socket = dgram.createSocket("udp4");
  const seen = [];
  // A socket error (a host that does not resolve, a port the socket refuses) is reported per
  // framing rather than left to become an uncaught 'error' event.
  const errors = [];
  socket.on("error", (err) => errors.push(err));
  socket.on("message", (msg) => {
    const packet = parsePacket(msg);
    seen.push(packet);
    // Acknowledge every message: an unacknowledged one is retried and then the client is dropped.
    if (packet.type === 0x02) socket.send(framing.build(Buffer.from([0x02, packet.seq ?? 0])), opts.port, opts.host);
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const localPort = socket.address().port;

  socket.send(framing.build(Buffer.concat([Buffer.from([0x00]), Buffer.from(opts.password, "ascii")])), opts.port, opts.host);
  await sleep(900);

  const answer = seen.find((p) => p.type === 0x00) ?? null;
  const authorized = Boolean(answer) && answer.body[1] === 0x01;
  const denied = Boolean(answer) && answer.body[1] !== 0x01;
  const messages = seen.filter((p) => p.type === 0x02).map((p) => p.text);
  const clientId = messages.map((m) => /Client ID: #(\d+)/.exec(m)?.[1]).find(Boolean) ?? null;

  // Give the slot back, with the framing this tool trusts rather than the one under test: a bare
  // payload is not a packet the server acts on, so framing 5 could never log anything out.
  let logoutAcked = false;
  if (authorized) {
    const seq = 0;
    const before = seen.length;
    socket.send(
      FRAMINGS[FRAMING_DEFAULT].build(Buffer.concat([Buffer.from([0x01, seq]), Buffer.from(LOGOUT_COMMAND, "ascii")])),
      opts.port,
      opts.host
    );
    await sleep(400);
    logoutAcked = seen.slice(before).some((p) => p.type === 0x01 && p.seq === seq);
  }
  socket.close();
  return {
    framing: Number(id),
    name: framing.name,
    localPort,
    answered: Boolean(answer),
    authorized,
    denied,
    noAnswer: !answer,
    clientId,
    messages,
    logoutAcked,
    error: errors[0]?.message ?? null,
  };
}

async function probe(opts) {
  const wanted = opts.framings.length ? opts.framings : Object.keys(FRAMINGS).map(Number);
  const unknown = wanted.filter((id) => !FRAMINGS[id]);
  if (unknown.length) {
    console.error(`error: unknown framing(s) ${unknown.join(", ")}; known: ${Object.keys(FRAMINGS).join(", ")}`);
    process.exit(2);
  }
  const results = [];
  for (const id of wanted) results.push(await probeFraming(opts, id));

  const authorized = results.filter((r) => r.authorized);
  const denied = results.filter((r) => r.denied);
  const silent = results.filter((r) => r.noAnswer);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          host: opts.host,
          port: opts.port,
          framings: results,
          authorized: authorized.map((r) => r.framing),
          denied: denied.map((r) => r.framing),
          unanswered: silent.map((r) => r.framing),
        },
        null,
        2
      )
    );
    return denied.length && !authorized.length ? 3 : authorized.length ? 0 : 4;
  }

  console.log(`probe of ${opts.host}:${opts.port}, login payload 00|"${opts.password}"\n`);
  for (const r of results) {
    const verdict = r.authorized
      ? `AUTHORIZED${r.clientId ? ` as client #${r.clientId}` : ""}${r.logoutAcked ? ", then logged out" : ""}`
      : r.denied
        ? "answered, DENIED"
        : "no answer";
    console.log(`  framing ${r.framing}  localPort ${r.localPort}  ${verdict}`);
    console.log(`    ${r.name}`);
    for (const m of r.messages) console.log(`    <- ${JSON.stringify(m)}`);
  }

  console.log("");
  if (authorized.length && !denied.length) {
    console.log(
      `${authorized.length} of ${results.length} framings authorized: ${authorized.map((r) => r.framing).join(", ")}. ` +
        (authorized.length > 1
          ? "The 7-byte header is expected and its CRC is not verified."
          : `Only framing ${authorized[0].framing} is accepted — use it.`)
    );
    if (silent.length) {
      console.log(
        `Framing(s) ${silent.map((r) => r.framing).join(", ")} were not answered. Since a framing this build does not\n` +
          "act on is silent — framing 5, the bare payload, is the control that is expected to be —\n" +
          "that is only worth chasing if it is a framing the server used to accept."
      );
    }
  } else if (authorized.length && denied.length) {
    console.log(
      `Mixed result: framings ${authorized.map((r) => r.framing).join(", ")} authorized, ` +
        `${denied.map((r) => r.framing).join(", ")} DENIED. An explicit denial means the bytes reached\n` +
        "the login handler and the password was wrong, so the accepted ones are the surprise — check\n" +
        "that the password did not change between the two logins."
    );
  } else if (denied.length) {
    console.log(
      `The server EXPLICITLY DENIED the login on framing(s) ${denied.map((r) => r.framing).join(", ")}:\n` +
        "the payload reached the login handler and the password did not match. Look for\n" +
        "`[RCON] <ip>:<port> Authorization DENIED` in console.log and check rcon.password."
    );
  } else if (results.every((r) => r.error)) {
    console.log(
      `None of the framings could even be sent: ${results[0].error}\n` +
        "That is a local transport problem — a host that does not resolve, or a port the socket\n" +
        "refuses — not a statement about RCON itself."
    );
  } else {
    console.log(
      "No framing was answered at all, and none was refused either — so this says nothing about the\n" +
        "password. Check, in this order:\n" +
        "  1. `[RCON] Init, Ip address=... and Port=...` in console.log — RCON is off without it;\n" +
        "  2. the port, and that you are sending UDP (there is no TCP listener on it);\n" +
        "  3. `[RCON] Client List is full! Dropping connection with <ip>:<port>` in console.log —\n" +
        "     rcon.maxClients is reached and this build drops packets *before* parsing them, which\n" +
        "     looks exactly like a wrong framing. Stale clients hold a slot for 45 s; wait, or raise\n" +
        "     rcon.maxClients. This tool sends @logout on the way out, so it no longer leaves one\n" +
        "     behind itself;\n" +
        "  4. only then the framing, which is what `probe --framings 1` isolates."
    );
  }
  return denied.length && !authorized.length ? 3 : authorized.length ? 0 : 4;
}

// -------------------------------------------------------------------------------------- shell
const SHELL_HELP = `local commands (everything else goes to the server, without a leading '#')
  .help              this text
  .raw               toggle the hex/ascii dump of every packet
  .json              toggle JSON output: one object per command on stdout, notes on stderr
  .reconnect         open a fresh RCON session (login again, new client id)
  .keepalive <ms>    idle keep-alive interval, 0 disables (the server drops a silent client in 45 s)
  .exit | .quit | .q leave, sending @logout so the slot is free at once
  @logout            the protocol command itself: it ends the session, so the shell leaves with it
  Ctrl-C             the same as .exit: @logout, then exit 130 (a second Ctrl-C leaves at once)

server commands, as rcon.permission in server.json allows
  players                          player list: playerId ; identity id ; name
  ban list [page]                  the ban list (25 per page over RCON)
  ban create <id|name> <sec> [reason]
  ban remove <id|name>
  kick <playerId>
  restart | shutdown
  <anything else>                  sent verbatim

the grammar of ban and kick is checked here, as on the command line: a missing subcommand or
argument is "--- done: usage error (exit 2)" and nothing is sent. Send it through "cmd <text>" to
see the server's own answer instead.

every command ends with a "--- done:" line carrying its status and exit code, which is what tells
you the output above it is complete; with JSON output each command prints one JSON object instead.`;

async function shell(opts) {
  const rcon = new Rcon(opts);
  // The login is the one step that is expected to fail from the outside — a wrong password, RCON
  // off, the wrong port — and it fails the same way here as it does for the one-shot subcommands:
  // a line on stderr and the exit code, not a stack trace. This is why the banner comes after it.
  try {
    await rcon.connect();
    await rcon.login();
  } catch (err) {
    rcon.close();
    console.error(`error: ${err.message}`);
    return err.code ?? 4;
  }
  rcon.startKeepAlive();

  const interactive = Boolean(process.stdin.isTTY);
  // With --json (or after `.json`), stdout carries the JSON objects and nothing else: the banner,
  // the notes and the prompt go to stderr, so `shell --json` can be piped into a parser.
  const human = () => (opts.json ? process.stderr : process.stdout);
  const write = (line = "") => human().write(`${line}\n`);

  write(`Arma Reforger RCON shell — ${opts.host}:${opts.port}${rcon.clientId !== null ? `, client #${rcon.clientId}` : ""}`);
  write(`Commands are limited by rcon.permission in server.json; "players" works with monitor, the rest needs admin.`);
  write(`.help for the local commands, .exit to leave (this sends @logout and frees the slot at once).`);
  write(`Ctrl-C and the @logout command leave the same way.`);

  // terminal:true only on a real terminal: it is what turns on line editing and makes Ctrl-C
  // arrive as the interface's own 'SIGINT' event instead of the process signal. With piped input
  // the process-level handler below is the one that fires.
  const rl = readline.createInterface({ input: process.stdin, output: interactive ? process.stdout : human(), terminal: interactive });
  if (interactive) rl.setPrompt("rcon> ");
  // After the interface is closed there is nothing to prompt on, and calling prompt() then throws
  // ERR_USE_AFTER_CLOSE. That is exactly what happened when Ctrl-C arrived while a command was in
  // flight: the interrupt closed the interface, the command finished, and the loop asked for the
  // next line of a closed readline.
  const prompt = () => {
    if (interactive && !rl.closed) rl.prompt();
  };
  prompt();

  let lastExit = 0;
  let exitCode = 0;
  let preLogout = null;
  let finishPromise = null;

  // One way out, wherever it is called from: Ctrl-C, .exit, @logout typed as a command, a shutdown
  // the server accepted, or the end of the input. The slot is given back before the process ends,
  // and the answer is printed either way. `alreadyLoggedOut` is the result of a logout the caller
  // has performed itself — the protocol command typed by hand — because asking for it twice would
  // only report "already".
  //
  // The work is done in a single shared promise: an interrupt can call finish() while a command is
  // still in flight, and the loop that ends afterwards must wait for that same logout rather than
  // start a second one or exit before it is reported.
  const finish = (code, note, alreadyLoggedOut = null) => {
    if (finishPromise) return finishPromise;
    exitCode = code;
    finishPromise = (async () => {
      if (note) write(note);
      rcon.stopKeepAlive();
      // Stop whatever exchange is in flight: a wait that is still running would otherwise hold the
      // prompt for the rest of its timeout before this shutdown could be reported.
      rcon.aborted = true;
      const logout = alreadyLoggedOut ?? (await rcon.logout());
      rcon.close();
      if (logout.sent) {
        write(
          logout.acknowledged
            ? `--- shell: @logout acknowledged (seq ${logout.seq}); the slot is free at once ` +
                `(the server logs "[RCON] Client ${rcon.clientId} logged out!")`
            : `--- shell: @logout sent but not acknowledged; on a build that ignores it the slot stays busy for 45 s ` +
                `(check for "[RCON] Client ${rcon.clientId} logged out!" in console.log)`
        );
      } else if (logout.reason === SHUTDOWN_REASON) {
        write(`--- shell: no @logout — ${logout.reason}, so there is nobody left to answer one`);
      } else {
        write(`--- shell: no @logout (${logout.reason}); expect the slot to stay busy for 45 s`);
      }
      if (!rl.closed) rl.close();
      return exitCode;
    })();
    return finishPromise;
  };

  // Both paths are needed and they do not collide: on a terminal, readline has the keyboard in raw
  // mode and emits its own 'SIGINT'; when stdin is not a terminal, Ctrl-C reaches the process as a
  // real signal instead. The handlers are once-only, so a second Ctrl-C ends the process at once.
  const interrupted = () => {
    finish(130, "\n--- shell: interrupted (Ctrl-C); logging out before leaving");
  };
  rl.on("SIGINT", interrupted);
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  outer: for await (const raw of rl) {
    const text = raw.trim();
    if (!text) {
      prompt();
      continue;
    }
    if (!interactive) write(`> ${text}`);

    // The protocol command typed by hand. It ends the session the moment the server processes it,
    // so the shell ends with it rather than staying open on a de-authenticated client — where the
    // next command would only be answered with silence.
    if (/^@logout$/i.test(text)) {
      preLogout = await rcon.logout();
      break outer;
    }

    if (text.startsWith(".")) {
      const [name, value] = text.split(/\s+/, 2);
      switch (name) {
        case ".help":
        case ".h":
          write(SHELL_HELP);
          break;
        case ".exit":
        case ".quit":
        case ".q":
          break outer;
        case ".raw":
          opts.raw = !opts.raw;
          write(`--- shell: packet dump ${opts.raw ? "on" : "off"}`);
          break;
        case ".json":
          opts.json = !opts.json;
          write(
            `--- shell: JSON output ${opts.json ? "on" : "off"}` +
              (opts.json ? " — one object per command on stdout, everything else on stderr" : "")
          );
          break;
        case ".keepalive": {
          const ms = Number(value);
          if (!Number.isFinite(ms) || ms < 0) write("--- shell: .keepalive needs a number of milliseconds (0 disables)");
          else {
            rcon.stopKeepAlive();
            opts.keepAliveMs = ms;
            rcon.startKeepAlive();
            write(`--- shell: keep-alive ${ms ? `${ms} ms` : "off"}`);
          }
          break;
        }
        case ".reconnect": {
          // Log the old session out first: opening a second one while the first still holds its
          // slot is exactly how a client exhausts rcon.maxClients.
          rcon.stopKeepAlive();
          const previous = await rcon.logout();
          rcon.close();
          rcon.loggedIn = false;
          rcon.denied = false;
          rcon.loggedOut = false;
          rcon.seq = 0;
          await rcon.connect();
          try {
            await rcon.login();
            rcon.startKeepAlive();
            write(
              `--- shell: connected again as client #${rcon.clientId}` +
                (previous.sent ? " (the previous session was logged out)" : ` (previous session: ${previous.reason})`)
            );
          } catch (err) {
            write(`--- shell: ${err.message}`);
            await finish(err.code ?? 4);
            break outer;
          }
          break;
        }
        default:
          write(`--- shell: unknown local command ${name}; .help lists them`);
      }
      prompt();
      continue;
    }

    // The same grammar check the command line uses. Nothing is sent: the mistake is the caller's,
    // so it is a usage error (exit 2), not the server's answer (exit 5) — which is what the same
    // text would produce if it went out through `cmd`.
    const usage = usageError(text);
    if (usage) {
      lastExit = 2;
      if (opts.json) {
        console.log(
          JSON.stringify({
            host: opts.host,
            port: opts.port,
            clientId: rcon.clientId,
            command: text,
            seq: null,
            ack: null,
            messages: [],
            ms: 0,
            status: "usage error",
            error: usage,
            exitCode: 2,
          })
        );
      } else {
        write(`--- done: usage error (exit 2): ${usage} (nothing was sent)`);
      }
      prompt();
      continue;
    }

    rcon.busy = true;
    let res;
    try {
      res = await rcon.exec(text);
    } finally {
      rcon.busy = false;
    }
    // An interrupt can land while a command is in flight; finish() has already run or is running,
    // and there is nothing left to report.
    if (finishPromise) break outer;
    lastExit = res.exitCode;

    // `shutdown` takes the server with it, so the session ends here — the same conclusion the one
    // shot path reaches, and for the same reason: there is nobody left to answer a logout. The
    // command's own status line is still printed first, below.
    const leavesWithServer = /^shutdown$/i.test(text) && res.status === "ok";

    if (opts.json) {
      console.log(JSON.stringify({ host: opts.host, port: opts.port, clientId: rcon.clientId, ...res }));
    } else {
      printAnswer(res.messages, res, write);
      const detail = `${res.messages.length} message${res.messages.length === 1 ? "" : "s"}, ${(res.ms / 1000).toFixed(1)} s`;
      // No message at all means no answer: the server acknowledges every command packet, so an
      // acknowledgement on its own (`@foo`) is not an answer, and the two cases are told apart by
      // whether anything came back at all.
      const silentHint = res.ack
        ? " — the server acknowledged it but sent no answer; an unknown protocol command looks like this"
        : " — nothing came back at all; the session may have been dropped by the 45-second rule, .reconnect logs in again";
      write(
        res.status === "ok"
          ? `--- done: ok (exit 0), ${detail}`
          : res.status === "failed"
            ? `--- done: FAILED (exit 5): ${res.error} — ${detail}`
            : `--- done: no answer (exit 4), ${detail}${silentHint}`
      );
    }
    if (leavesWithServer) {
      rcon.noLogoutReason = SHUTDOWN_REASON;
      break outer;
    }
    prompt();
  }

  // The await matters: if an interrupt started the shared shutdown, this waits for it and returns
  // its code (130) rather than the status of the last command that happened to run.
  return await finish(exitCode || lastExit, null, preLogout);
}

// --------------------------------------------------------------------------------------- main
// Ctrl-C during a one-shot run: log out (waiting briefly for the acknowledgement, so the slot is
// really free) and then leave. A second Ctrl-C is not caught and ends the process at once.
function installInterruptHandler(rcon) {
  const onSignal = async () => {
    const logout = await rcon.logout();
    rcon.close();
    const note = logout.sent
      ? logout.acknowledged
        ? "@logout acknowledged; the slot is free at once"
        : "@logout sent but not acknowledged; the slot may stay busy for 45 s"
      : `no @logout (${logout.reason})`;
    console.error(`interrupted: ${note}`);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

// Anything that escapes a subcommand is reported as a line, never as a stack trace: a CLI that
// prints `Error: … at …` and exits 1 has told the caller much less than a message and a code.
async function reportFailures(task, fallbackCode) {
  try {
    return await task();
  } catch (err) {
    console.error(`error: ${err.message}`);
    return err.code ?? fallbackCode;
  }
}

const opts = parseArgs();
if (opts.help || !opts.sub) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}
if (!opts.password && opts.sub !== "probe") {
  console.error("error: no password. Pass --password <pw> or set RCON_PASSWORD (rcon.password in server.json).");
  process.exit(2);
}
for (const [name, value, min, max] of [
  ["--port", opts.port, 1, 65535],
  ["--timeout", opts.timeout, 1],
  ["--quiet-ms", opts.quietMs, 0],
  ["--logout-wait", opts.logoutWait, 0],
  ["--keep-alive", opts.keepAliveMs, 0],
]) {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    console.error(`error: ${name} needs a number ${max !== undefined ? `between ${min} and ${max}` : `of at least ${min}`}`);
    process.exit(2);
  }
}

if (opts.sub === "probe") process.exit(await reportFailures(() => probe(opts), 4));
if (opts.sub === "shell") process.exit(await reportFailures(() => shell(opts), 4));

const commands = buildCommands(opts);
if (commands.error) {
  console.error(`error: ${commands.error}\n\n${USAGE}`);
  process.exit(2);
}
// The structured subcommands are checked here, exactly as the shell checks what is typed into it.
// `cmd` is exempt on purpose: it is the way to send something the client's grammar does not know.
if (opts.sub !== "cmd") {
  const usage = commands.map((command) => usageError(command)).find(Boolean);
  if (usage) {
    console.error(`error: ${usage}\n\n${USAGE}`);
    process.exit(2);
  }
}

const rcon = new Rcon(opts);
installInterruptHandler(rcon);
let results = [];
let logout = { sent: false, reason: "not attempted" };
try {
  ({ results, logout } = await rcon.run(commands));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(err.code ?? 4);
}

const failure = results.map((r) => r.error).find(Boolean) ?? null;
const silent = results.find((r) => r.status === "no answer") ?? null;
let exitCode = 0;
if (!rcon.loggedIn) exitCode = rcon.denied ? 3 : 4;
else if (failure) exitCode = 5;
else if (silent) exitCode = 4;

// The parsed lists, if this run produced any: they go into the JSON next to the raw `messages`,
// and they are what the human output renders as a table.
const parsedPlayers = results.find((r) => r.players)?.players ?? null;
const parsedBans = results.find((r) => r.bans)?.bans ?? null;

const logoutNote = logout.sent
  ? logout.acknowledged
    ? `@logout acknowledged (seq ${logout.seq}); the slot is free at once`
    : "@logout sent but not acknowledged; on a build that ignores it the slot stays busy for 45 s"
  : `not sent (${logout.reason})`;

const result = {
  host: opts.host,
  port: opts.port,
  command: commands.join(" && "),
  loggedIn: rcon.loggedIn,
  clientId: rcon.clientId,
  ack: results[results.length - 1]?.ack ?? null,
  messages: rcon.messages,
  commands: results,
  success: !failure && !silent,
  players: parsedPlayers ?? undefined,
  bans: parsedBans ?? undefined,
  loggedOut: Boolean(logout.sent && logout.acknowledged),
  logout: logout.sent ? { seq: logout.seq, acknowledged: Boolean(logout.acknowledged) } : null,
  error: failure ?? null,
};

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${opts.host}:${opts.port}  login: ${rcon.loggedIn ? `ok, client #${rcon.clientId}` : "FAILED"}`);
  console.log(`command: ${result.command}`);
  if (result.ack) console.log(`ack: seq=${result.ack.seq}${result.ack.response ? `  ${JSON.stringify(result.ack.response)}` : ""}`);
  // The whole session's messages, with each parsed list rendered as a table where its messages
  // were — so the table is not something appended after the logout note.
  printAnswer(rcon.messages, { players: parsedPlayers, bans: parsedBans }, (line) => console.log(line));
  console.log(`logout: ${logoutNote}`);
  if (failure) console.error(`the server reported a failure: ${failure.trim()}`);
  else if (silent) {
    console.error(
      silent.ack
        ? "no answer to the command: the server acknowledged it but sent no message (an unknown protocol command looks like this)"
        : "no answer to the command: nothing came back at all"
    );
  }
}

process.exit(exitCode);
