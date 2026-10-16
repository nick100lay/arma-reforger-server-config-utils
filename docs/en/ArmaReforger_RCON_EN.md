# Arma Reforger server RCON

Remote administration of the server: configuration, permissions, commands, diagnostics.

**Build verified on:** Arma Reforger 1.6.0.119 (engine 192142).

---

## 1. What it is and what it is not

RCON in Arma Reforger is **a separate endpoint from BattlEye's anti-cheat RCON** — a Bohemia
service configured in `server.json`. What kept being confused is not only the endpoint but also
the protocol: as §1.1 shows, the packets *are* the BattlEye ones.
This matters, because the game has **two independent remote consoles**, and they are constantly confused:

| | RCON Arma Reforger | RCON BattlEye |
|---|---|---|
| Where it is configured | the `rcon` section in `server.json` | the file `battleye\BEServer_x64.cfg` |
| Enabled by | `rcon.password` | `RConPassword` in that file |
| Role | remote administration of the server | anti-cheat |
| Port | `rcon.port` (19999 by default) | the game port, per the BattlEye specification |
| Client | anything that speaks BattlEye RCon v2 (§1.1) | `BERCon.exe` from the server bundle |

The own implementation is visible right in the code: the server binary has the classes
`RCONProtocol`, `RCONCommunicator`, `RCONCommandHandler`, `RCONServerBase`,
`RCONClientBase`, `RCONConnectedClient`, as well as the separate
`RCONAdminCommand` and `RCONMonitorCommand`.

### 1.1 The packet format is the BattlEye one

This used to be the gap in this document. It is now recovered, by talking to a running server
(1.8.0.13, non-public, `rcon.permission: "admin"`, on `127.0.0.1:19999`) with a client written
for the experiment. **The packets are BattlEye RCon Protocol v2** — the public
[specification](https://www.battleye.com/downloads/BERConProtocol.txt) fits them exactly:

```text
header, 7 bytes, on every packet in both directions
  'B' 0x42 | 'E' 0x45 | CRC32 of the following bytes, little-endian | 0xFF

payload, right after the header
  0x00 | password            client -> server   log in
  0x00 | 0x01 | 0x00         server -> client   0x01 = logged in, 0x00 = denied
  0x01 | seq | command       client -> server   a command
  0x01 | seq [| response]    server -> client   the command was accepted
  0x02 | seq | text          server -> client   a console message — must be acknowledged
  0x02 | seq                 client -> server   that acknowledgement
  0x01 | seq                 client -> server   an empty command: the keep-alive
  0x01 | seq | @logout       client -> server   a protocol command: free this slot at once
```

`seq` is a per-client counter that starts at **0** with the first command of a session and grows by
one with every command packet, keep-alives included. It is not decoration — see the third finding
below.

"CRC32 of the following bytes" means the checksum covers the `0xFF` **and** the payload. That is
verified against the server's own replies rather than against the specification: the login answer
is `BE 69 DD DE 36 FF 00 01`, the stored value is `0x36DEDD69` read little-endian, and
`crc32(FF 00 01) = 0x36DEDD69`.

Four details from these runs are worth knowing, because each of them has cost a diagnostic run:

- **The server does not check the CRC of what it receives.** Four logins were sent in a row with
  the checksum computed over the payload alone and over `0xFF|payload`, each little-endian and
  big-endian; **all four were authorized** — the server logged `Authorized as Client #0` … `#3`
  for the four source ports. What the server *sends* is always `crc32(FF|payload)`, little-endian.
- **The 7-byte header is mandatory.** The same login sent as a bare payload (`00 | password`) got
  no answer, while the framed one was answered — checked with the client list empty, so this is
  not the "list full" path of §6.3. The server logged **nothing** about the rejected packet: the
  string `[RCON] Invalid packet received`, which the 1.6.0.119 binary carries, was not emitted on
  1.8.0.13. A wrong framing is therefore silent, and only the absence of an answer distinguishes
  it from a server that is not listening at all.
- **The sequence number is checked, and a mismatch is silent.** The same `players` command was
  sent twice to two fresh sessions, once as `01 00` and once as `01 07`. The first was answered
  with the acknowledgement, then `Processing Command: players` and the player list, and the server
  logged `Received Game Command: players`. The second was answered with **`01 07` and nothing
  else**: no game command ran, no message followed, and the server wrote **no log line at all** —
  not even the `[RCON] … Mismatched sequence number! Command: %s` that the binary carries. It also
  did not move the counter: the next packet, `01 00 | @logout` from that same session, was still
  accepted. **An acknowledgement therefore does not mean the command ran** — a client that
  reconnects without resetting its counter, or that increments twice by accident, sees `01|seq`
  come back and a command that did nothing.
- **`@logout` is a protocol command and it frees the slot immediately.** `0x01 | seq | @logout`
  (plain ASCII, no `#`, and `seq` **0** for the first command of a session) makes the server log
  `[RCON] [CLIENT: 0] Received Protocol Command: @logout` and `[RCON] Client 0 logged out!`, and
  the slot is reusable at once: the next client is authorized as `#0` with
  `Connected clients: [1/4]` rather than `[2/4]`. Note the log line — **Received Protocol
  Command**, not *Received Game Command*: `@logout` never reaches the command handler, which is
  how a protocol command is told from a game command in the log. The BattlEye v2 specification
  defines no logout packet, so this is Bohemia's own addition; the wiki has it as "RCON only,
  since 1.2.1", and it behaves that way on 1.8.0.13 — with `permission: "admin"` and, checked
  separately, with `"monitor"`, where a `kick` is refused with `missing permission 'kick 1'` while
  `@logout` still logs out the client and frees the slot. Without it a client that is merely
  *closed* — which a UDP socket does silently — keeps its slot for the whole 45 s of §6.3.

Both framing facts are re-checkable on any build, and on a server whose RCON client list is free —
see the `probe` subcommand below. So are the last two: `probe` logs out between framings and §6.3
shows the log lines to compare.

A real exchange from that run, with the server's answers as they came off the wire:

```text
-> BE … FF | 00 "probe-rcon-1"
<- BE … FF | 00 01                              login accepted
<- BE … FF | 02 00 "Logged In! Client ID: #0"
-> BE … FF | 02 00                              acknowledgement
-> BE … FF | 01 00 "players"
<- BE … FF | 01 00                              command accepted
<- BE … FF | 02 01 "Processing Command: players"
<- BE … FF | 02 02 "Players on server: [Player#] ; [Player UID] ; [Player Name]"
-> BE … FF | 01 01 "@logout"                    seq continues from 0; a protocol command
<- BE … FF | 01 01                              accepted, and the slot is free at once
```

The last two lines are the whole difference between a client that releases its slot and one that
leaves it busy for 45 seconds — the server's own side of the same exchange, from `console.log`:

```text
[RCON] 127.0.0.1:55609 Authorized as Client #0 | Connected clients: [1/4]
[RCON] [CLIENT: 0] Received Protocol Command: @logout
[RCON] Client 0 logged out!
[RCON] 127.0.0.1:51057 Authorized as Client #0 | Connected clients: [1/4]   ← the same slot, at once
```

And the negative control for the sequence rule, the same `players` sent as `01 07`:

```text
-> BE … FF | 01 07 "players"
<- BE … FF | 01 07                              the only answer there is: no command, no message,
                                                no log line on the server side
```

Note the player-list message in the good exchange: `#players` returns the **UID as well** as the
number and the name. That UID is the `identityId` a ban needs (see
[`ArmaReforger_Profile_EN.md`](ArmaReforger_Profile_EN.md) §5.6), so it can be read straight out
of RCON instead of digging through the log.

### 1.2 The client in this repository

The protocol is implemented once, in [`tools/rcon.mjs`](../../tools/rcon.mjs). Use it instead of
writing another client — that is what it exists for:

```bash
node tools/rcon.mjs players --host 127.0.0.1 --port 19999 --password <rcon.password>
node tools/rcon.mjs ban list 1 --json --password <pw>     # 25 per page over RCON
node tools/rcon.mjs ban create 1 3600 "teamkilling" --password <pw>
node tools/rcon.mjs ban remove <identityId> --password <pw>
node tools/rcon.mjs cmd "restart" --password <pw>          # anything else, verbatim
node tools/rcon.mjs probe --password <pw>                  # which framing does this build accept
node tools/rcon.mjs shell --password <pw>                  # interactive session, see below
```

`npm run rcon -- <subcommand>` does the same. The password may come from `RCON_PASSWORD` instead
of the command line. `--json` prints a machine-readable result and nothing else; `--raw` dumps
every packet as hex and ascii to stderr, which is how the exchange above was captured. Exit
codes: `0` ok, `2` usage, `3` login refused, `4` no answer, `5` the server answered with a
failure (`Player not found`, `Failed to create ban.`, `Timeout`, …) — an empty ban list
(`Server has no bans to list.`) is a normal answer and exits `0`.

Two of those codes are worth spelling out, because the same text can produce either one depending
on which path it takes:

- **`2` is the client's own grammar, checked before a packet goes out** — `kick` with no
  `playerId`, `ban` with no subcommand, `ban create` with fewer than two arguments, `ban remove`
  with none, and an unknown `ban` subcommand. Nothing is sent, and both the command line and
  `shell` behave this way, because it is the same function (`usageError`) that checks them.
- **`4` means no answer message came back**, which is not the same as no packet: the server
  acknowledges every command packet with `0x01|seq` even when it does nothing with it. An unknown
  *protocol* command (`@foo`) is exactly that — acknowledged, and then answered with nothing — so it
  is `4`, not `5`. A command that answers only with `Processing Command: …` and nothing else (that
  is `#restart`) has a message and stays `0`.

Whichever subcommand it is, a failure is **one line on stderr and an exit code, never a Node stack
trace** — `shell` included, whose login is the step most likely to fail from the outside: a wrong
password gives `error: login refused — wrong rcon.password?` and `3`, a port nothing is listening on
gives `error: no answer to the login …` and `4`. When the socket itself reports a problem, the
message says so rather than listing the four silent causes: an unresolvable host gives
`error: no answer to the login. The socket reported: getaddrinfo ENOTFOUND <host> — that is a local
transport problem, not a statement about the server`. Out-of-range numbers are refused before
anything is opened (`--port` must be 1..65535, `--timeout` at least 1, the other waits at least 0),
with exit `2` — the socket never sees a value it would throw on.

Two answers carry a list, and in the human output that list is rendered as a **table in place of the
server's own message** — not appended at the end, after the logout note:

```text
Processing Command: players
┌──────────┬──────────────────────────────────────┬─────────────────────┐
│ playerId │ uid                                  │ name                │
├──────────┼──────────────────────────────────────┼─────────────────────┤
│ 1        │ 0ac6169c-15e4-4b5d-8073-08e602583069 │ kolya_500           │
│ 2        │ 5f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d │ Ivan "the" Longname │
└──────────┴──────────────────────────────────────┴─────────────────────┘
```

That is `#players` and `#ban list`, in `shell` exactly as in a one-shot run. For a ban list the
server's own page line stays above the table — `Total bans: 26 | Page: 2/3` — because the page count
is stated nowhere else. Everything else in the answer is printed as it arrived: `Processing Command:
…`, errors, and `Server has no bans to list.`, which is an answer rather than an empty table.

In JSON (`--json`, or `.json` inside the shell) the raw messages are kept and the parsed value is
added **next to** them, both at the top level of the result and inside the `commands[]` entry it came
from:

```json
{
  "messages": ["Processing Command: players", "Players on server: [Player#] ; [Player UID] ; [Player Name]", "1 ; 0ac6169c-15e4-4b5d-8073-08e602583069 ; kolya_500"],
  "players": [{ "playerId": 1, "uid": "0ac6169c-15e4-4b5d-8073-08e602583069", "name": "kolya_500" }]
}
```

`players` is an array of `{ playerId, uid, name }` — empty when nobody is connected — and `bans` is
`{ total, page, pages, entries }`, where `entries` is an array of `{ identityId, name }`.

**Consequence for `BERCon.exe`:** the utility that sits next to the server is configured by
`battleye\BEServer_x64.cfg` and speaks to BattlEye's own port, while the `rcon` section of
`server.json` is a different endpoint on a different port that happens to use the same packet
format. Do not expect one to serve the other: whether a BattlEye client can be pointed at
`rcon.port` was not tried (§7).

> **The RCON transport is UDP.** Verified by running the server (build 1.8.0.13) with a
> non-public config that sets `rcon.address` and `rcon.port`: while it ran, the RCON port was a
> **UDP** endpoint owned by the server process, there was **no TCP listener** on it, and a TCP
> connect to it was refused. The controls behaved as documented — the game port and the A2S port
> were UDP as well — which is what makes the negative result meaningful.
>
> **The transport is UDP and the packets are BattlEye RCon v2** (§1.1). The transport was
> verified as above; the format by a later run of the same build, in which the server answered a
> purpose-written client. The wiki states no protocol at all, and the container image that
> publishes 19999 as TCP is wrong about the transport. Re-check on your own machine with
> `ss -lunp | grep 19999` (Linux) or `Get-NetUDPEndpoint -LocalPort 19999` (Windows);
> `ss -ltnp` should show nothing. More — in
> [`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md) A.5.

**Every run ends with `@logout`**, so the client gives its slot back instead of leaving it to the
45-second timeout** (§1.1, §6.3). `--no-logout` turns that off — useful exactly once, to
reproduce what a client without it does to `rcon.maxClients`: with `maxClients: 4`, four such
runs in a row and the fifth login is dropped with `[RCON] Client List is full!` and no answer at
all. `--logout-wait` (default 800 ms) is how long the client waits for the acknowledgement; a run
that ends with `logout: @logout sent but not acknowledged` is worth checking against console.log,
because a build that does not implement the command will keep the slot for the full 45 s.

### 1.3 The `shell` subcommand

`shell` opens one session and keeps it open, so commands are typed rather than wrapped in a
process each time, and the client's `seq` counter stays in step with the server's:

```text
$ node tools/rcon.mjs shell --password <pw>
Arma Reforger RCON shell — 127.0.0.1:19999, client #0
Commands are limited by rcon.permission in server.json; "players" works with monitor, the rest needs admin.
.help for the local commands, .exit to leave (this sends @logout and frees the slot at once).
rcon> players
Processing Command: players
Players on server: [Player#] ; [Player UID] ; [Player Name]
--- done: ok (exit 0), 2 messages, 1.7 s
rcon> kick 999
Processing Command: kick 999
Player not found
--- done: FAILED (exit 5): Player not found — 2 messages, 2.0 s
rcon> .exit
--- shell: @logout acknowledged (seq 2); the slot is free at once (the server logs "[RCON] Client 0 logged out!")
```

- **Every command ends with a `--- done:` line** carrying its status, its exit code, the number of
  messages and the time it took. That line, not the silence, is what says the output above it is
  complete — the server sends an answer as several `0x02` messages with no terminator of its own.
  `players` and `ban list` are rendered as the tables of §1.2, in place of the messages they were
  parsed from, so the table comes before that line. `--json` (or `.json`) prints one JSON object per
  command instead, with the same fields plus `players` and `bans`, and moves the banner, the notes
  and the prompt to stderr so that stdout stays parseable.
- **Ctrl-C leaves the way `.exit` does**: the client logs out first, prints the result and exits
  `130`. It also does that when it arrives *while a command is waiting for its answer* — the wait is
  abandoned, the logout goes out, and the shell leaves; leaving the loop to finish on its own is
  what used to end in `ERR_USE_AFTER_CLOSE`, because the interface had already been closed and the
  loop still asked it for the next line. The same is true of Ctrl-C during a one-shot run, which
  reports what it managed to send. A *second* Ctrl-C is not caught and ends the process at once —
  the first one has already put `@logout` on the wire, so the slot is released either way.
- **`shutdown` ends the shell too**, because it ends the server: the command's status line is
  printed, and then the client leaves *without* a logout — there is nobody left to answer one, and
  the slot goes away with the process. `restart` is not this: the server stays, so the session does.
  Neither of the two costs a timeout any more: both answer with their `Processing Command:` note and
  nothing else, so the client no longer waits for a second message that was never coming (twenty
  seconds of a shell that looked hung, with `shutdown` still hanging on after the server was gone).
- **Typing the protocol command `@logout` leaves the shell too.** It ends the session the moment
  the server processes it, and a shell that stayed open on a de-authenticated client could only
  collect silence — so it is treated like `.exit`, with the same acknowledgement line. Any other
  `@…` is sent verbatim; the server acknowledges an unknown protocol command and answers nothing
  further, which the status line says out loud.
- **Commands are written without the leading `#`**: `players`, `ban list 1`, `kick 3`, `restart`.
  Local commands start with a dot: `.help`, `.exit` (or `.quit`, `.q`), `.raw` to toggle the packet
  dump, `.json` to toggle the machine-readable output (one JSON object per command on stdout, with
  the notes and the prompt on stderr), `.keepalive <ms>` and `.reconnect`.
- **The grammar of `ban` and `kick` is checked here too**, by the same function the command line
  uses: `ban`, `ban create 1`, `kick` and friends end with `--- done: usage error (exit 2): …
  (nothing was sent)` and no packet leaves the client, which is a different outcome from sending
  the same text and letting the server answer. `cmd <text>` is the way to do the latter.
  It is the same check in both places on purpose: `ban` used to mean "usage error" on the command
  line and "the server said the parameters are wrong" in the shell, which is one behaviour too many.
- **The session survives idling.** The client sends the specification's empty keep-alive command
  (`0x01|seq`) every 20 s, which is well inside the 45 s the server allows — verified by leaving a
  session idle for 80 s and running `players` afterwards, which was answered. `.keepalive 0` turns
  it off, and then a 45-second pause drops the session and the next command reports
  `--- done: no answer (exit 4)`; `.reconnect` logs in again (and logs the old session out first,
  so reconnecting cannot exhaust `rcon.maxClients` either).
- The shell exits with the status of the last command it ran, so `printf 'players\n.exit\n' |
  node tools/rcon.mjs shell` is usable from a script.

### 1.4 What the client does not read as a verdict

Two behaviours are there to protect a diagnostic run, not to be polite: it acknowledges every
`0x02` message, because an unacknowledged message gets the client dropped after five attempts;
and it refuses to read silence as a verdict of its own. A framing that is merely wrong and a
client list that is full both look like "no answer at all", so `probe` separates them explicitly:
an explicit `0x00|0x00` is reported as `DENIED` (which *is* about the password), silence is
reported as silence, with the log line to check and without claiming anything about the password.
It also sends `@logout` after each framing, so the framings no longer pile up in
`rcon.maxClients` — probing a server with `maxClients: 1` works, and reports four authorizations
and one expected silence for five framings.

---

## 2. Configuration

### 2.1 The `rcon` section in the config

```json
"rcon": {
  "address": "127.0.0.1",
  "port": 19999,
  "password": "ChangeMe123",
  "maxClients": 4,
  "permission": "admin",
  "blacklist": [],
  "whitelist": []
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `address` | string | — | The address the RCON socket is bound to. Marked in the wiki as **required**. For local access — `127.0.0.1`. |
| `port` | number 1..65535 | 19999 | RCON port. |
| `password` | string | — | **Required for RCON to start.** No spaces, at least 3 characters. |
| `maxClients` | number 1..16 | 16 | Maximum simultaneous RCON clients. |
| `permission` | string | — | `"admin"` — any commands; `"monitor"` — only commands that do not change state. |
| `blacklist` | array | `[]` | Commands excluded from execution. |
| `whitelist` | array | `[]` | If set, only the listed commands are allowed. |

**Security first.** RCON gives full control over the server: kick, ban,
scenario restart, shutdown. Therefore:

- **never set `address` to `0.0.0.0`** if the server faces the internet — otherwise
  RCON is open to the whole world and protected by the password alone. The example above uses `127.0.0.1`,
  and that is the right choice: connect through an SSH tunnel;
- **a long and random password**, not `123`. The 3-character minimum is a technical
  engine limitation, not a recommendation;
- to watch the server without the right to change anything, use `"permission": "monitor"`.

### 2.2 Startup parameters

The section can be overridden from the command line:

| Parameter | What it sets |
|---|---|
| `-rconPort <port>` | The RCON port |
| `-rconIpAdress <IP>` | The RCON address. **A typo in the engine itself** — it is `Adress`, without the `d` |
| `-rconPassword <string>` | The RCON password |

### 2.3 Verifying that RCON came up

In `console.log` on a successful start:

```
BACKEND : [RCON] Init, Ip address=127.0.0.1 and Port=19999
```

If there are problems — one of the lines below. All of them come from the server binary:

| Log line | Cause |
|---|---|
| `[RCON] Init failed... Missing password or password length < 3 characters !!!` | The password is unset or shorter than 3 characters |
| `[RCON] Init failed... RCON is now turned off.` | A consequence of the previous line — RCON is disabled |
| `[RCON] Invalid port, set to default=19999...` | `rcon.port` is out of range; **not fatal**, the port is replaced with the default one |
| `[RCON] run failed, net socket invalid` | The socket did not come up — most often the port is taken or `address` is wrong |

---

## 3. Permissions

Permissions are described by the `ERCONPermissions` enum — exactly three values,
which matches the `rcon.permission` values in the config:

```enforce
enum ERCONPermissions
{
    PERMISSIONS_NONE,
    PERMISSIONS_MONITOR,
    PERMISSIONS_ADMIN,
}
```

Each command declares the permission it requires with the `RequiredRCONPermission()` method.
For example, the `ban` command:

```enforce
override int RequiredRCONPermission()
{
    return ERCONPermissions.PERMISSIONS_ADMIN;
}
```

Bottom line: **`monitor` can only look, `admin` can do anything**. There is no separate
"kick only" or "ban only" level.

The second, independent set of permissions is for **chat**:

```enforce
enum EPlayerRole
{
    NONE,
    ADMINISTRATOR,
    SESSION_ADMINISTRATOR,
    GAME_MASTER,
}
```

Commands declare it separately with the `RequiredChatPermission()` method. For `ban` and `kick`
it is `ADMINISTRATOR` there — that is, in chat the same commands are available only to a logged-in
administrator.

> **Important:** one and the same command has **two different permission checks** — for RCON
> and for chat. A command can be available over RCON but unavailable in chat, and vice versa.

---

## 4. Commands

### 4.1 Permission matrix

Compiled from the official BI wiki (the "Server Management" page). The columns are who executes
the command, the rows are the command itself.

| Command | Logged-in admin | Voted admin | Player | RCON `admin` | RCON `monitor` |
|---|:---:|:---:|:---:|:---:|:---:|
| `#login` | — | — | ✔ | — | — |
| `#logout` | ✔ | ✔ | — | — | — |
| `#roles` | ✔ | ✔ | ✔ | — | — |
| `#restart` | ✔ | — | — | ✔ | — |
| `#shutdown` | ✔ | — | — | ✔ | — |
| `#kick <playerId>` | ✔ | — | — | ✔ | — |
| `#ban …` | ✔ | — | — | ✔ | — |
| `#id` | ✔ | ✔ | ✔ | — | — |
| `#players` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `@logout` (1.2.1) | — | — | — | ✔ | ✔ |

What follows from this in practice:

- **`#players` is the only command available to `monitor`.** Over RCON this is exactly
  what monitoring needs: the player list with no way to change anything.
- **`#restart`, `#shutdown`, `#kick`, `#ban` require `admin`.**
- **`#login`, `#logout`, `#roles`, `#id` are not available over RCON at all** — they are
  chat commands. `#login`, meanwhile, is available to an ordinary player: it is the one
  meant for logging in as an admin.
- **`@logout` is not a command at all in this sense** — it is a protocol command the RCON layer
  handles itself (§1.1), which is why it appears in the RCON columns only. Verified on 1.8.0.13
  with `permission: "admin"`: it is acknowledged, the server writes `Received Protocol Command:
  @logout` and `Client 0 logged out!`, and the slot is free immediately. **`monitor` may send it
  as well** — checked on the same build, and against the same server's refusal of a game command
  (`kick 1` → `missing permission 'kick 1'`), so the permission really was in force: three
  consecutive `players` runs on a server with `maxClients: 1` were each authorized as client `#0`
  at `[1/1]`, with `@logout` freeing the slot between them.

### 4.2 RCON and chat commands

| Command | Syntax | What it does |
|---|---|---|
| `#players` | `#players` | The list of players in the session with their `playerId` |
| `#kick` | `#kick <playerId>` | Eject a player. They can come back |
| `#ban create` | `#ban create <playerId\|identityId\|"playerName"> <seconds> <reason>` | Ban. `0` in seconds = permanently. The reason is optional |
| `#ban remove` | `#ban remove <identityId>` | Lift a ban |
| `#ban list` | `#ban list [page]` | The ban list. **RCON shows 25 per page, chat shows 10** |
| `#restart` | `#restart` | Restart the current scenario, **without disconnecting clients** |
| `#shutdown` | `#shutdown` | Shut the server down, disconnecting everyone |
| `@logout` | `0x01 \| seq \| @logout` | **RCON only, since 1.2.1.** A protocol command, not a game command: de-authenticate the RCON client and free the connection immediately (§1.1). The `0x01`/`seq` framing is what [`tools/rcon.mjs`](../../tools/rcon.mjs) sends |

### 4.3 Chat-only commands

| Command | Syntax | What it does |
|---|---|---|
| `#login` | `#login [password]` | Log in as an administrator. The password is `game.passwordAdmin`. **Admins from `game.admins` and the owner from `ownerToken.bin` log in without a password** |
| `#logout` | `#logout` | Log out of the administrator |
| `#roles` | `#roles` | Show the roles the player has |
| `#id` | `#id` | Show your own `playerId` |

### 4.4 The `ban` command dissected from source

From `scripts/Game/Network/ServerCommands/BanCommands.c` (line 319) — the help text the
server itself prints if you call `#ban` without a subcommand:

```
Help for ban command.
#ban create <playerId/playerName> <duration> <reason>
#ban create <identityId/playerName> <duration> <reason>
#ban remove <identityId/playerName>
#ban list <page>

- <duration> is in seconds and can be set to 0 for permanent.
- <reason> is optional.
```

Details that are visible only in the code:

- **The identifier type is determined by the format of the string** (the `GetPlayerIdType` method):
  - length 36 and dashes at positions 8, 13, 18, 23 → **`identityId`**;
  - digits only → **`playerId`**;
  - anything else → **a player name**;
- **A name with spaces is quoted:** `#ban create "Name with spaces" 3600`. This
  is parsed by a separate method, `TryParsePlayerNameWithSpaces`.
- **`playerId` works only for a connected player.** If the player has left —
  use `identityId`. The wiki says the same.
- **A negative duration is rejected:** `Not Valid time value in seconds`.
- **If the name matched several players**, the server returns
  `Multiple users found! Please use a unique identifier.` and shows the list —
  this is not an error but a hint.
- **`#ban` works only on a dedicated server.** The check is the first one in the handler:
  `Command is supported only on Dedicated Servers`.

A few more details that are visible only in the code:

- **The default reason** is `No reason provided`. If the reason consists of several
  words, the server itself joins all the remaining arguments with a space — no separate parameter
  is needed for that.
- **A ban is kept by the Bohemia backend, and the server also caches it locally.**
  The call is `BackendApi.GetBanServiceApi()` → `CreateBanPlayerId` / `CreateBanIdentityId` /
  `RemoveBans` / `RemoveBanByName` / `RequestServerBanList`. Hence `PENDING` too:
  the answer does not arrive immediately, and meanwhile the engine periodically calls `OnUpdate()`.
  The backend list is **per server** — `RequestServerBanList` asks for the active bans of
  "players banned on local server" — and next to it the engine keeps a mirror of the same list
  in the profile, the file `bans.json` (class `LocalBanDataCache`). This is the one place where
  a ban touches the disk; see
  [`ArmaReforger_Profile_EN.md`](ArmaReforger_Profile_EN.md) §5.7.
- **`#ban remove` by name searches in two passes**: first an exact match
  (`ESMT_EQUALS`), and on `EACODE_ERROR_NOT_FOUND` a retry by the start of the name
  (`ESMT_STARTS_WITH`) with the log entry `Retrying unban of user with user name: '%1'`.
- **A ban by `identityId` is created without a name**: the name field receives the `identityId`
  itself — the player is offline, and the server cannot find out the nickname.
- **The `#ban list` format** — a header line and one line per ban:

  ```
  Total bans: <N> | Page: <X>/<Y>
  - Identity Id | Banned name
  - <identityId> | <name>
  ```

- **The page limit is chosen by the caller**: `playerId == 0` (RCON) → 25,
  otherwise (chat) → 10. That is, 10 and 25 are not a setting but two constants in the code.
- **An ambiguous name** arrives from the backend as `EACODE_ERROR_MULTIPLE_TARGET_MATCH`;
  the server turns it into the hint `Multiple users found! …` with a list of matches
  by the start of the name.

### 4.5 The `kick` command dissected from source

`KickCommand` lives in the same file `BanCommands.c` (line 567) and is noticeably simpler.

| Property | Value |
|---|---|
| `GetKeyword()` | `kick` |
| `RequiredRCONPermission()` | `PERMISSIONS_ADMIN` |
| `RequiredChatPermission()` | `EPlayerRole.ADMINISTRATOR` |
| `IsServerSide()` | `true`; `OnChatClientExecution` always answers `OK` and does nothing |

- **Only `playerId` is accepted** — names are not supported, unlike `ban`.
- Fewer than two arguments → the result type is `PARAMETERS`. The source shows the command itself
  answering nothing for it, which is why this used to be described here as an empty answer; an RCON
  client does not see emptiness, it sees `invalid parameters '<command>'` sent by the engine after
  `Processing Command: …` (§4.6). `kick 1 2` — extra arguments — is not a parameter error: the
  server ignores them and answers `Player not found`.
- `playerId < 1` → `Not Valid Player ID`; the player is not online → `Player not found`.
- Success → `Player '<name>' kicked!`; the player is kicked with the reason
  `PlayerManagerKickReason.KICK` and can join again.
- **There is no "dedicated server only" check for `kick`** — unlike `ban`, it is not present
  in the code.

### 4.6 What the server answers to commands

The texts are verified against the sources (`BanCommands.c`), not against the wiki. In chat and in RCON these
are literally the same strings.

| Answer | Command | When |
|---|---|---|
| `Not Valid Player ID` | `kick`, `ban` | the identifier is less than 1 |
| `Player not found` | `kick`, `ban create` | there is no player with that `playerId` online |
| `Not Valid time value in seconds` | `ban create` | negative duration |
| `Not Valid page number` | `ban list` | the page number is less than 1 |
| `Page not found!` | `ban list` | the page is greater than the number of pages |
| `Server has no bans to list.` | `ban list` | the ban list is empty |
| `Multiple users found! Please use a unique identifier.` | `ban create` / `ban remove` by name | the name matched several players |
| `User not found!` | `ban remove` | the ban was found neither exactly nor by the start of the name |
| `Player '<name>' kicked!` | `kick` | success |
| `Player '<name>' banned!` | `ban create` | success |
| `Ban removed!` | `ban remove` | success |
| `Command is supported only on Dedicated Servers` | `ban` | the server is not dedicated |
| `missing permission '<command>'` | any | the command needs more than the configured `rcon.permission` — `kick 1`, `ban list 1` and the rest of the admin set on a `monitor` server. **Observed live on 1.8.0.13** (§7), as the English value of the `#AR-ServerCommands_PermissionError` key the binary carries |
| `unknown command '<text>'` | any | the keyword is not a game command at all. Also observed live; note that it arrives *after* `Processing Command: <text>`, so the RCON layer did route the packet |
| `invalid parameters '<command>'` | any | too few arguments — `kick`, `ban create`, `ban create 1`. Also observed live, and it is what the `PARAMETERS` result type looks like to an RCON client (§4.5). `#ban` with no subcommand is not this: it answers with its help screen, and the client in this repository reports that as a missing-parameter failure as well |
| `the server is busy` | any | a `BUSY` result type. From the binary only — see the note below |
| `Processing ban list` | `ban list` | the request went to the backend, the result will come later |
| `Timeout` | `ban …` | the backend did not answer |
| `Failed to create ban.` / `Failed to remove ban.` / `Failed to list bans.` | `ban …` | the backend rejected the request outright |
| `Unknown error.` | `ban …` | `EACODE_ERROR_UNKNOWN` from the backend |

These are **command answers, not log lines**: both in chat and in an RCON client they arrive
in the command's answer field, so looking for them in `console.log` is pointless.

The four routing answers above — `missing permission`, `unknown command`, `the server is busy`,
`invalid parameters` — are the engine's, not a command's, and the binary carries them as one table
of literals right next to `RCONCommandHandler: Executing command {%s}.`, composed with the command
text by the format `%s '%s'`. The other three were also observed on the wire (§7); `the server is
busy` was not, because reproducing it needs a command that returns `BUSY` at the right moment.

**One command answers nothing at all.** `#restart` was observed sending `Processing Command:
restart` and then no further message — and `#shutdown` behaves the same way — so a tool that waits
for an answer spends its whole timeout on it and can only report what its window allowed.
[`tools/rcon.mjs`](../../tools/rcon.mjs) therefore does not wait for a second message from those
two, which is what used to make a shell look hung for twenty seconds. `kick` with too few arguments
is *not* an example of this — that one is answered with `invalid parameters 'kick'`, which is how it
was told apart from a command that legitimately says nothing. An unknown *protocol* command is a
third shape: `@foo` was acknowledged with `0x01|seq` and then answered with no message at all —
which is why [`tools/rcon.mjs`](../../tools/rcon.mjs) decides "no answer" by the messages rather
than by the packets, and reports it as `4` with the difference spelled out: *the server
acknowledged it but sent no answer*.

**A bare `#ban` answers with its own help screen, and the client never lets it get that far.**
`ban`, `ban create 1`, `ban foo`, `ban remove` and `kick` are checked by the client's own grammar
before anything is sent, so they are usage errors (`2`) with a one-line summary — in the shell as
well as on the command line (§1.2, §1.3). The help screen is still reachable, and then it is the
server's answer and is classified as a missing-parameter failure (`5`): send it through
`cmd ban`, which is the path that deliberately skips the client's grammar. Nothing is banned in
either case; the difference is which side decided.

---

## 5. How it works inside

Useful if you are writing your own command for a mod.

A command is a class inheriting `ScrServerCommand` (the base class in
`scripts/Game/generated/ScrServerCommand.c`):

```enforce
class ScrServerCommand
{
    event string GetKeyword();                      // command keyword
    event bool   IsServerSide();                    // whether to pass it to the server
    event int    RequiredRCONPermission();          // permission for RCON
    event int    RequiredChatPermission();          // permission for chat
    event protected ref ScrServerCmdResult OnRCONExecution(array<string> argv);
    event protected ref ScrServerCmdResult OnChatServerExecution(array<string> argv, int playerId);
    event protected ref ScrServerCmdResult OnChatClientExecution(array<string> argv, int playerId);
    event protected ref ScrServerCmdResult OnUpdate();   // post-processing of a PENDING request
}
```

Note the separation: **one and the same command has separate entry points
for RCON and for chat.** In `BanCommand` both lead into the common `HandleCommand(argv, playerId)`,
but that is the author's choice, not a requirement of the architecture.

Not every `0x01` packet reaches this layer at all. The RCON server splits what a client sends into
**protocol commands** and **game commands**, and the log says which it decided: `@logout` produces
`[RCON] [CLIENT: 0] Received Protocol Command: @logout` and is handled by the RCON layer itself,
while `players` produces `[RCON] [CLIENT: 0] Received Game Command: players` and goes on to
`[RCON] Process Command: players` and the command handler above. A text that is neither — an
unknown protocol command — is what `[RCON] Unknown protocol command: %s` in the binary is for.
Practical use: when a command "did nothing", these two lines tell you whether the server ever
routed it, which is a question `0x01|seq` acknowledgements cannot answer (§1.1).

The result of a command is a `ScrServerCmdResult` with a type from `EServerCmdResultType`:

| Type | Meaning |
|---|---|
| `OK` | Success, the answer is ready |
| `UNKNOWN_COMMAND` | There is no command with that keyword |
| `MISSING_PERMISSION` | Not enough permissions or role |
| `PARAMETERS` | An error in the parameters: too few arguments, an invalid id or name |
| `PENDING` | The answer is not ready yet — an asynchronous operation. The engine will call `OnUpdate()` |
| `BUSY` | Busy |
| `ERR` | A general error |

`PENDING` explains why some commands do not answer immediately: for example, `#ban list`
goes to the Bohemia backend for the ban list. Getting the answer takes time, and at that
moment the engine periodically calls `OnUpdate()`.

---

## 6. Diagnostics

### 6.1 Connection lifecycle in the log

The server logs RCON operation in detail — from these lines you can break down almost any
problem:

```
[RCON] run started
[RCON] Login packet received
[RCON] 192.168.1.5:54321 Authorized as Client #0 | Connected clients: [1/4]
[RCON] [CLIENT: 0] Received Game Command: players
[RCON] Process Command: players
[RCON] [ID:0] Sent Message for client: ...
[RCON] [CLIENT: 0] Received Protocol Command: @logout
[RCON] Client 0 logged out!
[RCON] destroying...
```

Note what is *not* there: a client that sends only the empty keep-alive (`0x01|seq`) writes
`[RCON] [ID:0] [CLIENT: 0] No Command` and nothing else, and its session stays authenticated —
the sequence that was verified here was a session left idle for 80 seconds with a keep-alive every
20 seconds, after which `players` was still answered.

### 6.2 Symptom table

| Log line | What happened |
|---|---|
| `[RCON] Client List is full! Dropping connection with %d.%d.%d.%d:%d` | `rcon.maxClients` was reached. Raise the value or disconnect the extra clients |
| `[RCON] %d.%d.%d.%d:%d Authorization DENIED` | **Wrong password** |
| `[RCON] [ID:%d] [CLIENT: %d.%d.%d.%d:%d] Unauthorized Client! Command: %s` | A command was sent **before** authentication |
| `[RCON] [ID:%d] [CLIENT: %d] Mismatched sequence number! Command: %s` | Packet numbering is broken — usually an RCON client bug. **Not emitted on 1.8.0.13**: a command sent with the wrong `seq` produced no log line at all, see §1.1 |
| `[RCON] Unknown protocol command: %s` | The client sent something that is not a protocol command |
| `[RCON] [CLIENT: %d] Received Protocol Command: %s` | The RCON layer handled the command itself (`@logout`) instead of passing it to the game. The line to look for when a command "did nothing": its absence means the packet never reached this layer either |
| `[RCON] Client %d logged out!` | `@logout` was executed; the slot is free at once (§6.3) |
| `[RCON] Invalid packet received` | A malformed packet — most often the wrong protocol (for example, TCP instead of UDP or the reverse). **Not emitted on 1.8.0.13**: there a rejected packet produces no line at all, see §6.3 |
| `[RCON] message[%i] attempt[%i] TIMEOUT` | The client did not acknowledge a message. The server repeats the send several times |
| `[RCON] Dropped client: #%d` | The client was disconnected — the timeout expired or the attempt count was exceeded |
| `[RCON] output queue exceeded its capacity!` | The outgoing message queue overflowed. Usually means the client is not reading the answers |
| `[RCON] Failed to send message to client. Connection Refused!` | The connection was dropped on the client side |
| `[RCON] Failed to send Message of %d bytes due to System Error: %s - %d` | A system send error, with a code |
| `[RCON] [ID:%d] [CLIENT: %d] No Command` | The empty keep-alive command (`0x01|seq`) arrived. Normal, and necessary: it is what holds a session open past 45 s (§6.3) |
| `RCONCommandHandler: Executing command {%s}.` | The command reached the game handler |

### 6.3 The 45-second timeout, and how `@logout` avoids it

**An RCON client must keep talking.** The BattlEye v2 specification puts it as a rule of the
protocol rather than a server setting:

> "An empty 2-byte command packet (without actual command string) has to be sent every 45 seconds
> (or less) to keep the connection/login alive, if there are no other command packets being sent.
> If there are no command packets coming from the client for more than 45 seconds, it will be
> removed from BE RCon's list of authenticated clients."

Measured on 1.8.0.13, that is what happens: four clients authorized at 01:25:40, 01:25:44,
01:25:48 and 01:25:51 were dropped with `[RCON] Dropped client: #0` … `#3` at 01:26:28, 01:26:32,
01:26:36 and 01:26:39 — 45 to 48 seconds later, in the order they had logged in. **A client that is
merely closed holds its `maxClients` slot for the whole of that time**, because closing a UDP
socket tells the server nothing.

**`@logout` is the way out of the wait, and it works** (§1.1): send `0x01 | seq | @logout` and the
server logs `Received Protocol Command: @logout` / `Client 0 logged out!` and frees the slot
immediately. The evidence is in the client count of the next login: with `rcon.maxClients: 4`,
three logins that end in `@logout` each produce `Authorized as Client #0 | Connected clients:
[1/4]`, where the same three logins that are simply closed produce `[1/4]`, `[2/4]`, `[3/4]` and
then `[RCON] Client List is full!` for everything after. With `maxClients: 1`, `@logout` is the
difference between a client that works every time and one whose second run gets no answer at all.

The wiki describes the timeout with reference to `@logout`:

> "If the RCON client is killed without issuing this command, it de-authenticates automatically
> after 45 seconds on connection timeout."

Practical consequence: raise `maxClients` if several clients must coexist, and close a client with
`@logout` — [`tools/rcon.mjs`](../../tools/rcon.mjs) does it on every run, and `--no-logout` is
there to show what the alternative looks like.

**And the full list is checked before the packet is parsed.** On 1.8.0.13, once
`rcon.maxClients` was reached, every further packet — including a well-formed login — was dropped
with `[RCON] Client List is full! Dropping connection with <ip>:<port>` and **no other log line**:
no `Authorization DENIED`, no `Invalid packet received`, nothing about the payload. A client in
that state sees no answer at all, which is indistinguishable from a wrong framing or a wrong
port. If a command that should work goes unanswered, wait out the 45 seconds — or check that log
line first — before concluding anything about the protocol: this exact confusion cost diagnostic
runs during the investigation of §1.1, and it is why `probe` now reports silence as silence
instead of blaming the password.

---

## 7. Boundaries of reliability

- **The exchange protocol** is BattlEye RCon v2, recovered by experiment (§1.1) rather than from
  a document: the server's own log strings (*login packet*, *mismatched sequence number*,
  `message[%i] attempt[%i] TIMEOUT`, the 45-second timeout) pointed at the BattlEye
  specification, and the packets on the wire confirmed it. A wrong framing is **silent** — the
  build logs nothing about a rejected packet — so the protocol can only be re-checked with the
  client list free, using `probe` in [`tools/rcon.mjs`](../../tools/rcon.mjs). `@logout` is no
  longer in this list: the packet it needs is known and was observed working (§1.1, §6.3), under
  `admin` **and** under `monitor`. Still open: whether a BattlEye RCON client interoperates with
  `rcon.port` (not tried) and whether the absent CRC check on incoming packets is deliberate.
- **The transport is UDP** — verified by running the server with the port set and inspecting the
  socket, see §1; the message format is now recovered as well (§1.1), so what is left open is
  interoperability and the details listed in the first bullet.
- **The command list was exercised only in part.** Observed live on 1.8.0.13: `#players`,
  `#ban` (help), `#ban list`, `#ban create` and `#ban remove`, `#shutdown`, the protocol command
  `@logout`, and the empty keep-alive; the four login framings; the sequence-number rule; a
  client dropped by the 45-second timeout; a `monitor` server refusing `kick 1` and `ban list 1`
  with `missing permission '<command>'`; `unknown command '<text>'`; `invalid parameters '<command>'`
  for `kick`, `ban create` and `ban create 1`; `Player not found` for `kick 1 2`, where the extra
  argument is ignored rather than refused; and `#restart` answering nothing. The permission matrix,
  `#login`/`#logout`/`#roles`/`#id`, `#kick` and `#restart` are still as the wiki
  describes them and were not re-tested.
- **The full command list** is taken from the wiki page "Server Management" (revision
  `oldid=370483` of 2024-12-18) — it is **older** than the build being verified, 1.6.0.119.
  Commands added later did not make it in. The permission matrix is from there too.
- **There are exactly two commands in the public sources.** The directory
  `scripts/Game/Network/ServerCommands/` contains a single file, `BanCommands.c`,
  and in it only the classes `BanCommand` and `KickCommand`. The remaining commands
  (`#login`, `#logout`, `#roles`, `#id`, `#players`, `#restart`, `#shutdown`)
  are implemented on the engine side and do not appear in the public source mirror: their
  syntax and permissions are confirmed **by the wiki only**. You can verify them on a live
  server, but not by reading code — which is why §4.3 does not dissect them line by line.
- **Statements about the code** (`ERCONPermissions`, `EPlayerRole`, `EServerCmdResultType`,
  the structure of `ScrServerCommand`, the logic of `ban` and `kick`, the answer texts from §4.6)
  were verified against the sources through Arma Reforger Explorer 1.7.0.54, where the game is
  **newer** than build 1.6.0.119.
- **Log strings** — from the server binary 1.6.0.119, so they apply exactly
  to your build.
- **`maxClients` = 16 by default** and the range **1..16** — from the wiki.
- **A discrepancy in the wiki matrix:** the table marks `#login` as available to a player but
  unavailable to RCON. That is true in meaning (it is a chat command), but note
  that for RCON the `#login` and `#logout` columns are empty **in all columns except `@logout`** —
  that is, an RCON client does not "log in" with these commands, it authenticates with the password
  from the config when it connects.

### Sources

| What | From |
|---|---|
| The permission matrix, the command list and syntax, the 45 s timeout, the rule about `identityId` | BI Wiki "Arma Reforger: Server Management", revision `oldid=370483` of 2024-12-18 (a raw Wayback snapshot; direct access is blocked by Cloudflare) |
| The `rcon` section of the config: fields, ranges, defaults, `required` | BI Wiki "Arma Reforger: Server Config" |
| The description of `ERCONPermissions`, `EPlayerRole`, `EServerCmdResultType`, the base class `ScrServerCommand` | The generated scripts `scripts/GameLib/generated/ERCONPermissions.c`, `EPlayerRole.c`, `EServerCmdResultType.c`, `scripts/Game/generated/ScrServerCommand.c` via arexplorer |
| The logic of the `ban` and `kick` commands, the "dedicated server only" check, identifier formats, parsing names with spaces, the page limits 25/10, the help text and all command answer texts | `scripts/Game/Network/ServerCommands/BanCommands.c` via arexplorer |
| The backend calls behind a ban, the per-server scope of the ban list, the local ban cache (`bans.json`, `LocalBanDataCache`) | Strings of `ArmaReforgerServer.exe` **1.8.0.13** (the installed build, newer than this document's 1.6.0.119 pin); the cache is broken down in [`ArmaReforger_Profile_EN.md`](ArmaReforger_Profile_EN.md) §5.7 |
| The contents of the `ServerCommands` directory — only `BanCommands.c`; the other commands are absent from the public sources | A listing of the `scripts/Game/Network/ServerCommands/` directory via arexplorer |
| The protocol classes (`RCONProtocol`, `RCONCommunicator`, `RCONCommandHandler`, `RCONAdminCommand`, `RCONMonitorCommand`), the texts of all `[RCON] …` messages, the `[RCON] Init …` messages | Strings of `ArmaReforgerServer.exe` 1.6.0.119 |
| The packet format of §1.1, the header, the CRC convention, the fact that the CRC of incoming packets is not checked, the keep-alive and the acknowledgement rule | A dedicated server **1.8.0.13** (non-public, `rcon.address` 127.0.0.1, `rcon.port` 19999, `permission: admin`) and a client written for the experiment, cross-checked against the public BattlEye RCon Protocol v2 specification — https://www.battleye.com/downloads/BERConProtocol.txt |
| The same format re-checked, the silence of a rejected packet, and the "client list full" path being checked before parsing | `probe` of [`tools/rcon.mjs`](../../tools/rcon.mjs) against a server of the same build: four framings authorized with the client list empty, a bare payload unanswered with the list empty, and `[RCON] Client List is full!` for everything sent after `maxClients` was reached |
| The sequence-number rule — `01 00` answered and executed, `01 07` acknowledged and otherwise ignored with no log line, the counter unmoved | The same build: two fresh sessions, the same `players` command sent as `01 00` and as `01 07`, compared on the wire and in `console.log` |
| `@logout` freeing the slot at once — `Received Protocol Command: @logout`, `Client 0 logged out!`, and the next login counted as `[1/4]` rather than `[2/4]`; with `maxClients: 1`, three consecutive `players` runs, a five-framing `probe` and a shell session all authorized as `#0` at `[1/1]`, with no `Client List is full!` line in the log at all | The same build, non-public config, `permission: "admin"`, `[RCON]` lines of `console.log` read against the client count of each following login |
| The 45-second timeout measured — four clients dropped 45–48 s after they logged in, in authorization order | The same run, `[RCON] Dropped client: #0 … #3` against the `Authorized as Client #…` lines |
| The keep-alive holding a session open — 80 s idle with an empty `0x01\|seq` every 20 s, then `players` still answered | The same run, a purpose-written client on the same build |
| `@logout` working under `rcon.permission: "monitor"` — three consecutive `players` runs on `maxClients: 1` each authorized as `#0` at `[1/1]` with `Client 0 logged out!` between them, and no `Client List is full!` line; the same server refusing `kick 1` and `ban list 1` | The same build, non-public config with `permission: "monitor"`; the refusals are what shows the permission was in force |
| The answer texts `missing permission '<command>'` and `unknown command '<text>'` | The same `monitor` run — `kick 1`, `ban list 1` and a nonsense keyword, read off the wire |
| `invalid parameters '<command>'` for a command with too few arguments, `Player not found` for `kick 1 2`, the help text (a success) for a bare `ban`, and `#restart` answering nothing after `Processing Command: restart` | The same build with `permission: "admin"`: `kick`, `ban`, `ban create`, `ban create 1`, `kick 1 2`, `restart` — each command's own answer read off the wire |
| The literal table those answers come from — `missing permission`, `unknown command`, `the server is busy`, `invalid parameters` — and the `%s '%s'` format that inserts the command text | Strings of `ArmaReforgerServer.exe` 1.8.0.13, in one table next to `RCONCommandHandler: Executing command {%s}.`; `the server is busy` is the only one of the four not reproduced live |
| The `shell` output of §1.3, including the `--- done:` status line and the exit codes | [`tools/rcon.mjs shell`](../../tools/rcon.mjs) against the same server, with stdin piped and interactive |
| The live answer texts of `#players` (including its `[Player#] ; [Player UID] ; [Player Name]` header), `#ban`, `#ban list`, `#ban create`, `#ban remove` and `#shutdown` | The same run: a player joined, was banned, the list was read, the ban was removed and the server was shut down over RCON |
| A working config with RCON enabled and the `[RCON] Init` line in the log | `Arma Reforger Server\config.json` and `test\logs\logs_*\console.log` |
