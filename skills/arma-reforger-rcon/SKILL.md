---
name: arma-reforger-rcon
description: Configure, secure and operate the Arma Reforger dedicated server RCON - the rcon block in server.json, the two independent permission systems (ERCONPermissions for RCON and EPlayerRole for chat), the full # command list with the exact answers the server returns, and log-based diagnostics. Use when enabling RCON or debugging why it refuses to start, when choosing between monitor and admin, when a command works over RCON but not in game chat, when BERCon.exe is mistaken for the Bohemia RCON, when bans hang in PENDING or time out, or when a killed client keeps a maxClients slot busy.
---

# Using the Arma Reforger RCON

## 0. Before you touch anything

Three rules that prevent almost every failure:

1. **RCON is not BattlEye RCON.** Arma Reforger ships Bohemia's own remote console,
   configured in the `rcon` block of `server.json` and reached on port 19999.
   `BERCon.exe`, which sits next to the server binary, belongs to **BattlEye** and is
   configured in `battleye\BEServer_x64.cfg` (keys `RConPort`, `RConPassword`).
   Never point `BERCon.exe` at 19999, and never expect `rcon.password` to change
   BattlEye's settings.
2. **Do not write an RCON client from scratch.** The wire protocol is undocumented, and
   whether it runs over UDP or TCP is **unconfirmed** — the BattlEye spec says UDP, the BI
   wiki leaves the protocol cell empty, and a widely used container image publishes 19999
   as TCP. Use an existing client and verify the protocol on the host:
   `ss -lunp | grep 19999` (UDP) and `ss -ltnp | grep 19999` (TCP).
3. **RCON is full control over the server** — kick, ban, scenario restart, shutdown —
   protected by the password alone. On an internet-facing server bind `rcon.address` to
   `127.0.0.1` and connect through an SSH tunnel.

## 1. What counts as an admin

Two unrelated permission systems exist, and each command checks both separately:

- `ERCONPermissions` — for the RCON path: `PERMISSIONS_NONE`, `PERMISSIONS_MONITOR`,
  `PERMISSIONS_ADMIN`. Three values, no finer granularity.
- `EPlayerRole` — for the chat path: `NONE`, `ADMINISTRATOR`, `SESSION_ADMINISTRATOR`,
  `GAME_MASTER`.

An RCON client does not "log in": it authenticates with the password from the config when
it connects. `#login` and `#logout` are chat commands and are unavailable over RCON; the
single RCON-side counterpart is `@logout`.

## 2. Configuration

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

| Key | Type | Default | Notes |
|---|---|---|---|
| `address` | string | — | Socket bind address; marked **required** by the wiki. `127.0.0.1` for local access |
| `port` | number 1..65535 | 19999 | Out-of-range is not fatal: `[RCON] Invalid port, set to default=19999...` |
| `password` | string | — | **Required for RCON to start.** No spaces, at least 3 characters |
| `maxClients` | number 1..16 | 16 | Simultaneous RCON clients |
| `permission` | string | — | `"admin"` — anything; `"monitor"` — read-only (`#players` only) |
| `blacklist` | array | `[]` | Commands excluded from execution |
| `whitelist` | array | `[]` | If set, only the listed commands are allowed |

The whole `rcon` block is optional — a server without it simply has no remote console.

Startup parameters override the file: `-rconPort <port>`, `-rconPassword <string>`, and
`-rconIpAdress <IP>` — note the **typo in the engine itself**: `Adress`, no `d`.

Verify that it came up — this line must be in `console.log`:

```
BACKEND : [RCON] Init, Ip address=127.0.0.1 and Port=19999
```

Failure lines, all from `ArmaReforgerServer.exe` of build 1.6.0.119:

| Log line | Cause |
|---|---|
| `[RCON] Init failed... Missing password or password length < 3 characters !!!` | No password, or shorter than 3 characters |
| `[RCON] Init failed... RCON is now turned off.` | Consequence of the previous line — RCON is disabled |
| `[RCON] Invalid port, set to default=19999...` | `rcon.port` out of range; **not fatal** |
| `[RCON] run failed, net socket invalid` | Socket did not open — usually the port is taken or `address` is wrong |

## 3. Permission matrix

| Command | RCON `admin` | RCON `monitor` | Chat: logged admin | Chat: voted admin | Chat: player |
|---|:---:|:---:|:---:|:---:|:---:|
| `#players` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `#kick <playerId>` | ✔ | — | ✔ | — | — |
| `#ban …` | ✔ | — | ✔ | — | — |
| `#restart` | ✔ | — | ✔ | — | — |
| `#shutdown` | ✔ | — | ✔ | — | — |
| `#login` | — | — | — | — | ✔ (chat only) |
| `#logout` | — | — | ✔ | ✔ | — |
| `#roles` | — | — | ✔ | ✔ | ✔ |
| `#id` | — | — | ✔ | ✔ | ✔ |
| `@logout` | ✔ | ✔ | — | — | — |

Practical reading:

- **`#players` is the only command `monitor` may run.** That is exactly what monitoring
  needs: the player list, with no way to change anything.
- **`#restart`, `#shutdown`, `#kick`, `#ban` all require `admin`** — and, in chat, a
  *logged-in* administrator; a voted-in admin cannot use them.
- **`#login`, `#logout`, `#roles`, `#id` do not exist over RCON.** They are chat commands.
- A command can work over RCON and be refused in chat, and vice versa — the two checks are
  independent (`RequiredRCONPermission()` vs `RequiredChatPermission()`).

## 4. Commands

| Command | Syntax | What it does |
|---|---|---|
| `#players` | `#players` | Player list with each `playerId` |
| `#kick` | `#kick <playerId>` | Eject a player; they may rejoin |
| `#ban create` | `#ban create <playerId\|identityId\|"name"> <seconds> <reason>` | Ban. `0` seconds = permanent; the reason is optional |
| `#ban remove` | `#ban remove <identityId\|name>` | Lift a ban |
| `#restart` | `#restart` | Restart the current scenario, **keeping clients connected** |
| `#shutdown` | `#shutdown` | Shut the server down, disconnecting everyone |
| `@logout` | `@logout` | RCON only, since 1.2.1: de-authenticate and free the connection immediately |

Details that are only visible in the source (`BanCommands.c`):

- `#ban` **works on dedicated servers only** — the first check in the handler returns
  `Command is supported only on Dedicated Servers`. `#kick` has no such check.
- The identifier type is detected by format: 36 characters with dashes at 8, 13, 18, 23 →
  `identityId`; digits only → `playerId`; anything else → a player name.
- **`playerId` only works for a connected player.** For someone who already left, use
  `identityId` — `#ban list` prints it.
- Names with spaces must be quoted: `#ban create "Name with spaces" 3600 reason`.
- Negative durations are refused; the default reason is `No reason provided`.
- `#ban remove` by name tries an exact match first, then a `STARTS_WITH` match, logging
  `Retrying unban of user with user name: '%1'`.
- Ban list page size is a constant in code, not a setting: **25 per page over RCON,
  10 per page in chat** (`playerId == 0` means RCON).
- Bans go through Bohemia's backend (`BackendApi.GetBanServiceApi()` →
  `CreateBanPlayerId` / `CreateBanIdentityId` / `RemoveBans` / `RemoveBanByName` /
  `RequestServerBanList`), which is why these commands answer asynchronously
  (`EServerCmdResultType.PENDING` + `OnUpdate()`) and why an offline server cannot list
  or lift bans.

## 5. What the server answers

These are command answers, not log lines — do not grep `console.log` for them.

| Answer | Command | When |
|---|---|---|
| `Not Valid Player ID` | `#kick`, `#ban` | Identifier less than 1 |
| `Player not found` | `#kick`, `#ban create` | No connected player with that `playerId` |
| `Not Valid time value in seconds` | `#ban create` | Negative duration |
| `Not Valid page number` | `#ban list` | Page number below 1 |
| `Page not found!` | `#ban list` | Page beyond the page count |
| `Server has no bans to list.` | `#ban list` | No bans recorded |
| `Multiple users found! Please use a unique identifier.` | `#ban create` / `#ban remove` by name | The name matches several players (a hint, not an error) |
| `User not found!` | `#ban remove` | No ban matched, exactly or by prefix |
| `Player '<name>' kicked!` | `#kick` | Success |
| `Player '<name>' banned!` | `#ban create` | Success; the player is also kicked with reason `BAN` |
| `Ban removed!` | `#ban remove` | Success |
| `Command is supported only on Dedicated Servers` | `#ban` | Server is not dedicated |
| `Processing ban list` | `#ban list` | The request went to the backend, the answer comes later |
| `Timeout` | `#ban …` | The backend did not answer |
| `Failed to create ban.` / `Failed to remove ban.` / `Failed to list bans.` | `#ban …` | The backend rejected the call outright |
| `Unknown error.` | `#ban …` | `EACODE_ERROR_UNKNOWN` from the backend |

An empty answer with result type `PARAMETERS` means too few arguments — `#kick` with fewer
than two arguments behaves this way and prints nothing.

## 6. Diagnostics

Healthy lifecycle in the log:

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

| Log line | What happened |
|---|---|
| `[RCON] Client List is full! Dropping connection with %d.%d.%d.%d:%d` | `rcon.maxClients` reached |
| `[RCON] %d.%d.%d.%d:%d Authorization DENIED` | **Wrong password** |
| `[RCON] [ID:%d] [CLIENT: ...] Unauthorized Client! Command: %s` | A command was sent **before** authentication |
| `[RCON] [ID:%d] [CLIENT: %d] Mismatched sequence number! Command: %s` | Packet numbering broken — usually a client bug |
| `[RCON] Unknown protocol command: %s` | The client sent something that is not a protocol command |
| `[RCON] Invalid packet received` | Malformed packet — typically the wrong protocol (TCP instead of UDP, or the reverse) |
| `[RCON] message[%i] attempt[%i] TIMEOUT` | The client did not acknowledge a message; the server retries |
| `[RCON] Dropped client: #%d` | Client dropped — timeout or retry limit exceeded |
| `[RCON] output queue exceeded its capacity!` | Outgoing queue full — the client is not reading its answers |
| `[RCON] Failed to send message to client. Connection Refused!` | The connection was closed on the client side |
| `[RCON] [CLIENT: %d] No Command` | Empty command — the engine uses it as keep-alive |
| `RCONCommandHandler: Executing command {%s}.` | The command reached the game handler |

**The 45-second rule.** An RCON client must acknowledge messages. After 45 seconds of
silence the server considers it gone and frees the connection — so **a killed client keeps
its `maxClients` slot for 45 seconds**. Raise `maxClients` or close clients properly with
`@logout`.

## 7. Boundaries of reliability

- The **packet format is not documented**. `RCONPacket`, `RCONInputPacket`,
  `RCONOutputPacket`, and the distinction between *login*, *command* and *message* packets
  are visible in logs, but the exact layout is not recovered anywhere. Do not build a
  client from this document.
- **UDP or TCP is unconfirmed** — see §0.
- The **command list and the permission matrix** come from the BI wiki page
  "Server Management" (revision `oldid=370483`, 2024-12-18), which is **older than build
  1.6.0.119**. Commands added later are missing from it.
- **Only `BanCommand` and `KickCommand` exist in public sources**
  (`scripts/Game/Network/ServerCommands/BanCommands.c` is the only file in that
  directory). `#login`, `#logout`, `#roles`, `#id`, `#players`, `#restart` and
  `#shutdown` are engine-side and appear in no public script mirror — their syntax and
  permissions are wiki-only and must be confirmed on a live server.
- Statements about code (`ERCONPermissions`, `EPlayerRole`, `EServerCmdResultType`,
  the `ScrServerCommand` shape, ban and kick logic, all answer strings) were checked
  through Arma Reforger Explorer 1.7.0.54, where the game is **newer** than 1.6.0.119.
- Log strings come from `ArmaReforgerServer.exe` 1.6.0.119, so they match that build.
- `maxClients` default 16 and range 1..16 come from the wiki.

## 8. Verification checklist

Before reporting an RCON result:

- [ ] Is `[RCON] Init` present in the log, with the expected address and port?
- [ ] Was the protocol claim checked on the host (`ss -lunp` / `ss -ltnp`), or explicitly
      marked as unconfirmed?
- [ ] If a command failed: did you quote the exact answer from §5 rather than paraphrase it?
- [ ] If the client is `BERCon.exe`: did you say plainly that it will not work here?
- [ ] If a ban or unban was involved: is the server dedicated and is the backend reachable?

## 9. Reference documents in this workspace

All documents live in `docs/en/`, and these skills use their terminology; the Russian

- [ArmaReforger_RCON_EN.md](../../docs/en/ArmaReforger_RCON_EN.md) — the full treatment: config
  keys, permission enums, per-command breakdown from source, the answer table (its §4.6),
  and log-based diagnostics.
- [ArmaReforger_ServerConfig_EN.md](../../docs/en/ArmaReforger_ServerConfig_EN.md) — the `rcon`
  block in context of the whole `server.json`, §5.3, plus the admin keys `passwordAdmin`
  and `admins` in §5.4 that chat commands depend on.
- [ArmaReforger_StartupParams_EN.md](../../docs/en/ArmaReforger_StartupParams_EN.md) — the
  `-rcon*` parameters, and Appendix A.5 on Linux, where the RCON protocol is unverified.
- [ArmaReforger_Profile_EN.md](../../docs/en/ArmaReforger_Profile_EN.md) — the profile directory,
  where `console.log` with the `[RCON]` lines lives.
- [ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md) — what `#restart`
  restarts, and the GUID table a `scenarioId` needs.
- [`tools/probe-keys.ps1`](../../tools/probe-keys.ps1) — check whether `rcon` keys still
  exist after a game update.
- [`tools/validate-skills-and-links.mjs`](../../tools/validate-skills-and-links.mjs) and
  [`tools/validate-doc-json.mjs`](../../tools/validate-doc-json.mjs) — run after editing
  any document or skill here.

Source tags used in the guides: `[wiki]` = BI wiki, `[binary]` = string found in
