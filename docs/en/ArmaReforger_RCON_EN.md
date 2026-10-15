# Arma Reforger server RCON

Remote administration of the server: configuration, permissions, commands, diagnostics.

**Build verified on:** Arma Reforger 1.6.0.119 (engine 192142).

---

## 1. What it is and what it is not

RCON in Arma Reforger is **Bohemia's own implementation**, not the BattlEye protocol.
This matters, because the game has **two independent remote consoles**, and they are constantly confused:

| | RCON Arma Reforger | RCON BattlEye |
|---|---|---|
| Where it is configured | the `rcon` section in `server.json` | the file `battleye\BEServer_x64.cfg` |
| Enabled by | `rcon.password` | `RConPassword` in that file |
| Role | remote administration of the server | anti-cheat |
| Client | anything compatible with the Bohemia protocol | `BERCon.exe` from the server bundle |

The own implementation is visible right in the code: the server binary has the classes
`RCONProtocol`, `RCONCommunicator`, `RCONCommandHandler`, `RCONServerBase`,
`RCONClientBase`, `RCONConnectedClient`, as well as the separate
`RCONAdminCommand` and `RCONMonitorCommand`.

**Practical conclusion:** `BERCon.exe`, sitting next to the server, has nothing to do with
the `rcon` section in `server.json`. Do not try to connect it to port 19999.

> **The RCON protocol is not confirmed as UDP or TCP.** The official BattlEye specification
> says UDP, the BI wiki for Arma Reforger does not state the protocol, and a widespread
> container image publishes 19999 as TCP. You can only verify it on your own server:
> `ss -lunp | grep 19999` (UDP) and `ss -ltnp | grep 19999` (TCP).
> More — in [`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md) A.5.

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
| `@logout` | `@logout` | **RCON only, since 1.2.1.** De-authenticate the RCON client and free the connection immediately |

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
- **A ban goes through the Bohemia backend**, not into a local file:
  `BackendApi.GetBanServiceApi()` → `CreateBanPlayerId` / `CreateBanIdentityId` /
  `RemoveBans` / `RemoveBanByName` / `RequestServerBanList`. Hence `PENDING` too:
  the answer does not arrive immediately, and meanwhile the engine periodically calls `OnUpdate()`.
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
- Fewer than two arguments → an empty answer of type `PARAMETERS`: in chat this looks like
  "nothing happened", with no error text.
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
| `Processing ban list` | `ban list` | the request went to the backend, the result will come later |
| `Timeout` | `ban …` | the backend did not answer |
| `Failed to create ban.` / `Failed to remove ban.` / `Failed to list bans.` | `ban …` | the backend rejected the request outright |
| `Unknown error.` | `ban …` | `EACODE_ERROR_UNKNOWN` from the backend |

These are **command answers, not log lines**: both in chat and in an RCON client they arrive
in the command's answer field, so looking for them in `console.log` is pointless.

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
[RCON] Client 0 logged out!
[RCON] destroying...
```

### 6.2 Symptom table

| Log line | What happened |
|---|---|
| `[RCON] Client List is full! Dropping connection with %d.%d.%d.%d:%d` | `rcon.maxClients` was reached. Raise the value or disconnect the extra clients |
| `[RCON] %d.%d.%d.%d:%d Authorization DENIED` | **Wrong password** |
| `[RCON] [ID:%d] [CLIENT: %d.%d.%d.%d:%d] Unauthorized Client! Command: %s` | A command was sent **before** authentication |
| `[RCON] [ID:%d] [CLIENT: %d] Mismatched sequence number! Command: %s` | Packet numbering is broken — usually an RCON client bug |
| `[RCON] Unknown protocol command: %s` | The client sent something that is not a protocol command |
| `[RCON] Invalid packet received` | A malformed packet — most often the wrong protocol (for example, TCP instead of UDP or the reverse) |
| `[RCON] message[%i] attempt[%i] TIMEOUT` | The client did not acknowledge a message. The server repeats the send several times |
| `[RCON] Dropped client: #%d` | The client was disconnected — the timeout expired or the attempt count was exceeded |
| `[RCON] output queue exceeded its capacity!` | The outgoing message queue overflowed. Usually means the client is not reading the answers |
| `[RCON] Failed to send message to client. Connection Refused!` | The connection was dropped on the client side |
| `[RCON] Failed to send Message of %d bytes due to System Error: %s - %d` | A system send error, with a code |
| `[RCON] [CLIENT: %d] No Command` | An empty command — the engine uses it as keep-alive |
| `RCONCommandHandler: Executing command {%s}.` | The command reached the game handler |

### 6.3 The 45-second timeout

**An RCON client must regularly acknowledge receipt of messages.** If no messages arrive from
the client for longer than 45 seconds, the server considers it disconnected and frees the
connection. The wiki describes this with reference to `@logout`:

> "If the RCON client is killed without issuing this command, it de-authenticates automatically
> after 45 seconds on connection timeout."

Practical consequence: **a killed RCON client occupies a `maxClients` slot for up to 45 seconds.**
If you often restart your client and hit the limit — either raise
`maxClients`, or close the client properly with the `@logout` command.

---

## 7. Boundaries of reliability

- **The exchange protocol (packet structure) is not documented.** It is known that this is
  Bohemia's own implementation with the notions `RCONPacket`, `RCONInputPacket`,
  `RCONOutputPacket`, and that the log distinguishes *login*, *command* and *message* packets.
  **The exact format has not been recovered** — there is no information about it either in the wiki
  or in the readable sources. Writing your own RCON client from scratch from this document is not possible.
- **TCP or UDP — unconfirmed.** The sources disagree, see §1.
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
| The contents of the `ServerCommands` directory — only `BanCommands.c`; the other commands are absent from the public sources | A listing of the `scripts/Game/Network/ServerCommands/` directory via arexplorer |
| The protocol classes (`RCONProtocol`, `RCONCommunicator`, `RCONCommandHandler`, `RCONAdminCommand`, `RCONMonitorCommand`), the texts of all `[RCON] …` messages, the `[RCON] Init …` messages | Strings of `ArmaReforgerServer.exe` 1.6.0.119 |
| A working config with RCON enabled and the `[RCON] Init` line in the log | `Arma Reforger Server\config.json` and `test\logs\logs_*\console.log` |
