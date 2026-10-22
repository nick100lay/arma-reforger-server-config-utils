# Arma Reforger kick and disconnect reasons

What a player is told when a session ends, where that reason comes from, and what each one means.

**Build verified on:** Arma Reforger 1.8.0.13 (engine 192142) — the enums and the dialog presets are
read out of this build's own archives (`addons/core/data.pak`, `addons/data/data007.pak`), the texts
out of its localization table, and the numbering and the dialog behaviour out of this build's client
log. §9 names the source of every claim and what was not established.

---

## 0. Read this first

Three mistakes account for almost every misreading of a kick:

1. **A reason is a pair, not a word.** Every end of a session carries a `KickCauseCode`, which is a
   **group** plus a **reason** — `PLAYER_MANAGER` + `KICK`, `REPLICATION` + `SHUTDOWN`. `SHUTDOWN`
   alone is not a group and `PLAYER_KICK` is not a reason; the dialog tag the two produce is
   `GROUP_REASON` (`PLAYER_MANAGER_KICK`), and that is the string to search for.
2. **The reason says how the session ended, not why the player was thrown out.** A player who
   leaves voluntarily, a server that is shut down and a player the game drops all produce a reason.
   All twenty kick lines in the client log measured here (§9.2) arrive *after* the game has already
   returned to the main menu.
3. **The number in the log is not the enum's position in the script file.** For the `REPLICATION`
   group the shipped `RplError.c` lists `SYSTEM_FAILURE` first, yet the log says `reason=1`; for
   `PLAYER_MANAGER` the numbering matches the file (`KICK` is 0, `BAN` is 3). Use the name in
   quotes, and treat the number as a second opinion (§9.3).

## 1. Anatomy of a kick code

`KickCauseCode` is an opaque 64-bit handle — `scripts/GameLib/generated/KickCauseCode.c` calls it
"opaque code representing various reasons for ending gameplay … it consists of two parts: category
and reason", and each system is meant to publish its own list of reasons. `[binary]`

The server and the client exchange it over the replication channel: the executable carries
`RplConnection::Rpc_DisconnectReason_O sent kickCode=0x%08X` and
`Attempting to disconnect a player once the connection is already being severed. identity=0x%08X
kickCode=0x%08X`. `[binary]`

The names in this document are the ones `typename.EnumToString` prints on the client — the same
names the enums declare:

| Group number | Enum | Declared in |
|---|---|---|
| 0 | `RplKickCauseGroup.NONE` | `scripts/Core/generated/RplKickCauseGroup.c` |
| 1 | `RplKickCauseGroup.REPLICATION` | the same file |
| 2 | `KickCauseGroup.BATTLEYE_INIT` | `scripts/GameLib/generated/KickCauseGroup.c` |
| 3 | `KickCauseGroup.BATTLEYE` | the same file |
| 4 | `KickCauseGroup.DATA` | the same file |
| 5 | `KickCauseGroup2.PLATFORM` | `scripts/Game/generated/GameStateTransitions/KickCauseGroup2.c` |
| 6 | `KickCauseGroup2.PLAYER_MANAGER` | the same file |

`KickCauseGroup: RplKickCauseGroup` extends the engine's own enum, and `KickCauseGroup2` extends the
result again; the numbers follow the declaration order, `0` meaning "no group". Numbers 1, 3, 4 and 6
are confirmed by the logs measured here and by public reports (§9.2); 2 and 5 are the remaining two
slots and were not observed. `[binary]` `[practice]`

Each group carries a list of reasons, declared in the generated files the reason enum names:

| Group | Reason enum | File |
|---|---|---|
| `REPLICATION` | `RplError` | `scripts/Core/generated/Replication/RplError.c` |
| `BATTLEYE_INIT` | `BattlEyeInitError` | `scripts/GameLib/generated/BattlEyeInitError.c` |
| `BATTLEYE` | `BattlEyeKickReason` | `scripts/GameLib/generated/BattlEyeKickReason.c` |
| `DATA` | `DataError` | `scripts/GameLib/generated/DataError.c` |
| `PLATFORM` | `PlatformKickReason` | `scripts/Game/generated/GameStateTransitions/PlatformKickReason.c` |
| `PLAYER_MANAGER` | `PlayerManagerKickReason` | `scripts/Game/generated/Network/PlayerManagerKickReason.c` |
| `PLAYER_MANAGER` | `SCR_PlayerManagerKickReason` (extension) | `scripts/GameCode/Online/SCR_PlayerManagerKickReason.c` |

The link between a group and its enum is the `[KickCauseGroupLink("…")]` attribute on the enum, and
the engine validates it. A mod that gets this wrong meets one of four strings at load time, all of
them `[binary]` and all of them present in the 1.8.0.13 executable:

```text
Duplicate reason value %u for variable '%s' in enum assigned to KickCauseGroup '%s'.
Enum '%s' has KickCauseGroupLink("%s") but no matching KickCauseGroup value exists.
Multiple enums assigned to KickCauseGroup '%s': '%s'.
KickCauseGroup is missing assigned enum to group '%s'.
```

A mod may therefore add its own reasons to an existing group and have them display correctly — the
group and reason travel as numbers, and the client resolves the name from *its* copy of the enum,
which is why a reason the client's build does not know displays as `<unknown>`.

## 2. `REPLICATION` — the group almost every unexplained drop lands in

This is the transport's own group: it says the replication layer ended the session, and its reasons
are the most useful part of this document because they are what a player sees when "the server just
kicked me". The second column is the number printed in the log on 1.8.0.13; §9.3 explains why it is
not the file's order.

| No. | Reason | Why it happens | Source |
|---|---|---|---|
| 1 | `SYSTEM_FAILURE` | The replication system hit an internal error — the catch-all, with no further detail in the log | `[practice]` |
| 2 | `DISCONNECTION` | The session was closed deliberately by one of the two sides | `[binary]` |
| 3 | `CONNECTION_FAILURE` | The connection could not be established, or was lost | `[binary]` |
| 4 | `TIMEOUT` | The server stopped hearing from the client and gave up. The room this build registers with the backend declares `rplTimeoutS` of 10 s (`[practice]`, [BackendAPI](ArmaReforger_BackendAPI_EN.md) §4); that the two numbers are the same was not measured | `[practice]` |
| 5 | `FLOODED` | The client sent more traffic than the server accepts on a connection | `[binary]` |
| 6 | `STALLED` | Replication stopped making progress without the connection closing: the client is too slow, frozen, or still loading | `[practice]` |
| 7 | `SERVICE_FAILURE` | A network service on the server side failed | `[binary]` |
| 8 | `JIP_ERROR` | Join-in-progress failed — the state transfer into an already running game | `[binary]` |
| 9 | `SHUTDOWN` | The server is going away: mission end, `#restart` or `shutdown` over RCON, a stopped process, `-autoshutdown` ([StartupParams](ArmaReforger_StartupParams_EN.md)) | `[practice]` |
| 10 | `CREATION_FAILURE` | The server could not create the player or the session | `[binary]` |
| 11 | `SERVER_UNREACHABLE` | The server could not be reached from outside — the classic self-hosted case behind NAT, and what the threads about "reason 11" describe | `[binary]` |
| 12 | `SERVER_FULL` | No free slot: `playerCountLimit` reached, or the queue refused | `[binary]` |
| 13 | `PROTOCOL_MISMATCH` | The two sides speak different network protocol versions | `[binary]` |

Where the explanation is not written in the code, it is read from the name; the log carries no
detail beyond the number, so "the client was frozen" for `STALLED` is an inference, not a
measurement.

`SHUTDOWN` is worth singling out because it is the one reason that is **never the player's fault**:
the server decided to end every session at once. Two consequences are in the code. The client no
longer offers to carry the player's body across it —
`SCR_ReconnectComponent.HandlePlayerDisconnect` returns `false` for `RplError.SHUTDOWN`
(`scripts/Game/GameMode/Components/SCR_ReconnectComponent.c`), so after a restart the player starts
from scratch rather than reconnecting. And the notification the other players receive is *not* sent:
the sender only announces a kick when a non-empty dialog message exists for the cause or a timeout is
attached (`SCR_NotificationSenderComponent`). `[binary]` `[practice]`

## 3. `DATA` — the client and the server disagree about content

`DATA` is not a network error: the session is ended because the two sides cannot be running the same
game. On a modded server this is the group to suspect first.

| No. | Reason | Why it happens |
|---|---|---|
| 0 | `VERSION_MISMATCH` | The client's game version is not one the server supports |
| 1 | `RDB_MISMATCH` | The resource database differs in a significant way |
| 2 | `SCRIPT_MISMATCH` | The scripts differ — a script mod, or a different build of one |
| 3 | `WORLD_LOAD_ERROR` | The world could not be loaded |
| 4 | `WORLD_LOAD_INCONSISTENCY` | The replicated parts of the world do not match |
| 5 | `ADDON_LOAD_ERROR` | An addon failed to load |
| 6 | `IS_DEV_BINARY_MISMATCH` | A developer binary tried to connect to a non-developer one |
| 7 | `ADDON_LOAD_MISMATCH` | The addon set or its load order differs between client and server |

All names and comments are `[binary]`; the comments in `DataError.c` are the source of the
explanations above.

The practical trap is in §4: `ADDON_LOAD_MISMATCH` — the most common one in practice — has **no
dialog preset of its own**, so the player is shown the generic "internal error" text and the reason
is visible only in the detail line and the log.

## 4. `BATTLEYE_INIT` and `BATTLEYE`

The anti-cheat reports through two groups because its failures are of two different kinds.

`BATTLEYE_INIT` — the client could not bring BattlEye up at all:

| No. | Reason | Why it happens |
|---|---|---|
| 0 | `LOAD_ERROR` | The BattlEye service is not installed or failed to load |
| 1 | `UNSUPPORTED_VERSION` | The installed service version is not supported |
| 2 | `OTHER_ERROR` | Anything else during initialisation |

`BATTLEYE` — BattlEye itself ended the session; the reasons are the ones its own messages use:

| No. | Reason | Why it happens |
|---|---|---|
| 0 | `UNKNOWN` | Reason not known |
| 1 | `CLIENT_NOT_RESPONDING` | The client stopped acknowledging the server's packets |
| 2 | `QUERY_TIMEOUT` | The client did not answer the master server's scan queries |
| 3 | `GAME_RESTART_REQUIRED` | The BE service (protection) is not enabled — a restart is required |
| 4 | `BAD_SERVICE_VERSION` | Unsupported BE service version |
| 5 | `DISALLOWED_PROGRAM` | A blocked program is running next to the game, which is not necessarily cheating |
| 6 | `CORRUPTED_MEMORY` | The integrity check failed |
| 7 | `CORRUPTED_DATA` | The game's integrity was violated |
| 8 | `WINAPI_FAILURE` | A critical Windows API call failed |
| 9 | `GLOBAL_BAN` | Banned by BattlEye globally |
| 10 | `ADMIN_BAN` | Banned by the server administrator through BattlEye |
| 11 | `ADMIN_KICK` | Kicked by the server administrator through BattlEye |
| 12 | `INVALID_SERVER_CONFIG` | The server's own BE configuration is unusable (missing GameID or master port) |

`[binary]` — names and comments out of `BattlEyeKickReason.c`; the executable writes the BE verdicts
as `BattlEye Server: Kick player identity=0x%08X, reason='%s'` and
`BattlEye Server: Disconnect player identity=0x%08X`.

These reasons exist only while `game.gameProperties.battlEye` is on, which is the default
(`[wiki]`, [ServerConfig](ArmaReforger_ServerConfig_EN.md) §5.5). With it off, no `BATTLEYE` or
`BATTLEYE_INIT` reason can be produced.

## 5. `PLATFORM` — the account, not the server

| No. | Reason | Why it happens |
|---|---|---|
| 0 | `ACTIVE_USER_LOST` | The user who started the game is no longer the active one |
| 1 | `NO_MP_PRIVILEGE` | The account is not allowed to play multiplayer |
| 2 | `NO_CROSSPLAY_PRIVILEGE` | The account is not allowed cross-platform multiplayer |
| 3 | `USER_SIGNED_OUT` | The user signed out of the platform's online service |

`[binary]`. Nothing on the server can cause these, and an administrator cannot fix them: they are
the platform's verdict about the account.

## 6. `PLAYER_MANAGER` — a human or the game's own rules decided

This is the only group that is a decision rather than a failure, and the only one where the numbers
match the script file exactly.

| No. | Reason | Who produces it |
|---|---|---|
| 0 | `KICK` | The `kick` command — RCON, or the admin chat command (`BanCommands.c`: `KickCommand` → `PlayerManagerKickReason.KICK`). Also what the automatic friendly-fire punishment ends in |
| 1 | `KICK_VOTED` | A successful vote kick (`SCR_VotingKick.c`), with a 300-second timeout |
| 2 | `DUPLICATE_PLAYER_IDENTITY` | The same identity connected twice — the engine logs `Another connected player with the same identity found. Dropping this connection request and disconnecting the client` |
| 3 | `BAN` | `ban create` over RCON, or a permanent ban. The one reason this repository has already observed on a live server: the ban probe recorded `reason=3` ([Profile](ArmaReforger_Profile_EN.md) §5.7) |
| 4 | `TEMP_BAN` | A ban with a timeout |
| 5 | `FRIENDLY_FIRE` | A reason a human can select; the automatic punishment path replaces it with `KICK` or `TEMP_BAN` before disconnecting |
| 6 | `DISRUPTIVE_BEHAVIOUR` | The same, for disruptive behaviour |
| 10 | `KICKED_BY_GM` | Game Master kick (`SCR_KickPlayerContextAction`, which lets the GM pick the reason and the timeout) |
| 11 | `BANNED_BY_GM` | Game Master ban — the context action's timeout of `-1` means "until the server process restarts" |

Reasons 0–4 are the engine's `PlayerManagerKickReason`; 5, 6, 10 and 11 are the game's extension
`SCR_PlayerManagerKickReason`, which explicitly skips 7–9. `[binary]`

Three routes reach this group without an administrator typing anything:

- **Voting.** `Configs/Voting/Kick.conf` starts a vote at a threshold of 45 % with 45 % minimum
  participation; `Auto_Kick.conf` at 30 %/30 %. A successful vote kick carries a 300-second timeout
  (`PLAYER_VOTE_KICK_DURATION`), so the player is refused for five minutes, not forever.
- **Friendly fire.** `SCR_DataCollectorCrimesModule` accumulates a criminal score and calls
  `ExecutePunishment(…, KICK or TEMP_BAN, …)` when the configured threshold is crossed — the dialog
  therefore shows the ordinary kick or ban text, not the friendly-fire one.
- **A duplicate login.** Two machines on one identity is enough.

## 7. What the player actually sees

The client builds a tag, `group + "_" + reason`, and looks it up in
`Configs/ServerBrowser/KickDialogs.conf`. If the tag is missing it falls back to the group alone,
and if that is missing too, to `DEFAULT_ERROR`; a group the client does not recognise starts at
`DEFAULT_ERROR` directly (`game.c`, `OnKickedFromGame`). `[binary]`

That chain means the visible text is often less specific than the reason. Presets exist for these
tags:

| Group | Tags with their own preset | Falls back to the group text |
|---|---|---|
| `REPLICATION` | `SYSTEM_FAILURE`, `DISCONNECTION`, `CONNECTION_FAILURE`, `TIMEOUT`, `FLOODED`, `STALLED`, `JIP_ERROR`, `CREATION_FAILURE` | `SERVICE_FAILURE`, `SHUTDOWN`, `SERVER_UNREACHABLE`, `SERVER_FULL`, `PROTOCOL_MISMATCH` |
| `DATA` | `VERSION_MISMATCH`, `RDB_MISMATCH`, `SCRIPT_MISMATCH`, `WORLD_LOAD_ERROR` | `WORLD_LOAD_INCONSISTENCY`, `ADDON_LOAD_ERROR`, `IS_DEV_BINARY_MISMATCH`, `ADDON_LOAD_MISMATCH` |
| `BATTLEYE_INIT` | `LOAD_ERROR`, `UNSUPPORTED_VERSION` | `OTHER_ERROR` |
| `BATTLEYE` | `BAD_SERVICE_VERSION` | every other reason, including `ADMIN_KICK` and `ADMIN_BAN` |
| `PLATFORM` | `NO_MP_PRIVILEGE`, `USER_SIGNED_OUT` | `ACTIVE_USER_LOST`, `NO_CROSSPLAY_PRIVILEGE` |
| `PLAYER_MANAGER` | `KICK`, `KICK_VOTED`, `BAN`, `TEMP_BAN`, `FRIENDLY_FIRE`, `DISRUPTIVE_BEHAVIOUR`, `KICKED_BY_GM`, `BANNED_BY_GM` | `DUPLICATE_PLAYER_IDENTITY` |

The group text is the generic one — English "Internal error has occurred.", Russian "Произошла
ошибка." — which is why a shutdown or an addon mismatch reads as an internal error. `[binary]`

Two more things are visible, and both are easy to misread:

- **The detail line.** `game.c` composes `Kick cause code: group=%1 '%2', reason=%3 '%4'` and hands
  it to the dialog as its error detail, so the exact pair is available under the dialog's details —
  and at `LogLevel.NORMAL` in the client's `console.log`.
- **The text can be wrong for the reason.** `PLAYER_MANAGER_KICK` is bound to
  `#AR-KickDialog_PM_Kicked` — "Voted out of the game." / "Выгнан из игры путем голосования." — so a
  plain administrator kick tells the player they were voted out. `KICKED_BY_GM` is the one with the
  accurate text ("Kicked by Game Master."), and `DUPLICATE_PLAYER_IDENTITY` inherits the same
  vote-kick text from the group. `[binary]`

The dialog offers a reconnect for the transport reasons and refuses it where reconnecting would be
pointless or wrong: `m_bCanBeReconnected` defaults to `true` and the presets for `REPLICATION`,
`BATTLEYE*`, `DATA` and `PLAYER_MANAGER` set it to `0`. Where it is offered, the auto-rejoin timer is
10 seconds and `SCR_KickDialogs.MAX_AUTO_REJOINS` allows three attempts before the button is
disabled. `[binary]`

Other players in the session get a notification, `%1 was kicked. Reason: %2` /
`"%1 был выгнан. Причина: %2"`, built from the same preset — but only if the preset carries a
non-empty message or a ban timeout is attached, and the notification distinguishes a kick
(`PLAYER_KICKED`), a temporary ban (`PLAYER_BANNED`) and a permanent one
(`PLAYER_BANNED_NO_DURATION`). A shutdown therefore produces no "kicked" notification at all.
`[binary]`

## 8. Where to read the reason

| What | Where | Example |
|---|---|---|
| The exact pair, on the client | `console.log` in the profile, two consecutive lines | `Kicked from game. group=1 reason=9` then `Kick cause code: group=1 'REPLICATION', reason=9 'SHUTDOWN'` |
| The exact pair, on the server | the server's `console.log` | `ServerImpl event: disconnected (identity=0x…, slots=1/8), group=6, reason=0` |
| The anti-cheat's own words | the server's log | `BattlEye Server: Kick player identity=0x…, reason='…'` |
| Who kicked | the server's log, written by the command | `Kick <name>[<id>]` for `kick`, then the player is disconnected |
| The dialog tag that was used, or missed | the client's `console.log` | `[SCR_ConfigurableDialogUi] Preset was not found: … REPLICATION_SHUTDOWN` |

`[practice]` `[binary]` — the first and fifth lines are from the log of this build; the format
strings are in the executable.

The reason is also sent to the backend when the player is removed from the room: the
`rooms/removePlayer` call carries `removeEvent` with the same `group` and `reason` numbers
([BackendAPI](ArmaReforger_BackendAPI_EN.md) §4), which is why the numbers appear in captures of
that API even when no dialog was shown.

## 9. How it was obtained, and what it does not establish

Everything was read out of the installed build with the readers in this repository — no archive was
extracted by hand:

```bash
node tools/pak.mjs cat "<client>/addons/core/data.pak" scripts/Core/generated/Replication/RplError.c
node tools/pak.mjs cat "<client>/addons/data/data007.pak" Configs/ServerBrowser/KickDialogs.conf
node tools/loc.mjs get "<client>/addons/data/data007.pak:Language/localization.ru_ru.conf" AR-KickDialog_PM_Kicked
node tools/pak.mjs find "<client>/addons/data/data007.pak" "KickCauseGroupLink" --path-regex "\.c$"
```

The numbering was checked against the client log of this build on the machine it was written on:
20 lines with a cause code, all of them `REPLICATION`. §9.2 lists them.

### 9.1 What is established

- The complete group list, the complete reason list of every group, and every `KickCauseGroupLink`
  attribute — read from the archives of 1.8.0.13. `[binary]`
- The dialog resolution chain, the preset table, the texts in both languages, the reconnect flags,
  the notification rules and the reconnect exclusion for `SHUTDOWN` — read from the same archives.
  `[binary]`
- The numbering of `REPLICATION` reasons 1, 4, 6 and 9, and of `PLAYER_MANAGER` reason 3 — from
  logs of this build. `[practice]`

### 9.2 Observed codes, and why "kicked" in a log is not always a kick

The twenty lines were, without exception, of this shape:

```text
19:01:49.864 DEFAULT   (E): Kicked from game. group=1 reason=9
19:01:49.864 SCRIPT       : string strDetail = 'Kick cause code: group=1 'REPLICATION', reason=9 'SHUTDOWN''
```

and in every one of them the line arrived **after** `Entered main menu.` — the client had already
left the session. Four distinct codes occurred: `1 SYSTEM_FAILURE`, `4 TIMEOUT`, `6 STALLED`,
`9 SHUTDOWN`. So a cause code in a log answers "how did the session end", and only the group tells
you whether anybody was punished.

Public reports agree with the numbering and supply the groups this machine did not produce: the
pair `group=6 'PLAYER_MANAGER', reason=0 'KICK'` and `group=3 'BATTLEYE', reason=0 'UNKNOWN'` appear
in [a Steam troubleshooting thread](https://steamcommunity.com/app/1874880/discussions/1/841754670748837625/),
`group=4 'DATA'` in [a Bohemia feedback ticket](https://feedback.bistudio.com/T180153), and
`reason=9 'SHUTDOWN'` next to the unresolved `reason=11` in
[another thread](https://steamcommunity.com/app/1874880/discussions/1/840610464762369435/). They are
the source for numbers 3, 4 and 6 in §1, and they were not produced on this machine.

### 9.3 What is not established

- **Why the `REPLICATION` numbers are shifted by one** relative to `RplError.c` while
  `PLAYER_MANAGER` is not. The shift is measured on four values; the cause is not known. The name in
  quotes is resolved by the same build and is the reliable half of the line.
- **Group numbers 2 and 5** were not observed in a log. They are the two remaining slots, which is
  the declaration order, not a measurement.
- **Reasons never seen on this machine** — `FLOODED`, `SERVICE_FAILURE`, `JIP_ERROR`,
  `SERVER_FULL`, `PROTOCOL_MISMATCH`, every `DATA` reason, every `BATTLEYE` reason, every `PLATFORM`
  reason, `DUPLICATE_PLAYER_IDENTITY` — are documented from the code, their comments and their
  names, not from an observed kick.
- **The 10-second `rplTimeoutS`** is what the room declares to the backend; that it is the same
  number as the reconnect-and-timeout behaviour of the replication layer was not measured, and the
  log says nothing about the elapsed time.
- **Whether a mod can define a new group** (rather than a reason in an existing one) is not
  established: the engine validates the link, and the four validation strings above are all this
  document can say about what it accepts.
- Public reports of `group=1 reason=11` fit `SERVER_UNREACHABLE` under the shift above, and the
  fixes those threads describe are network fixes, but no log with the resolved name was available to
  confirm it.
