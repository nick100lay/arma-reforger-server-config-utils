# Arma Reforger server profile

What is in the profile directory, why it is needed, what can and cannot be changed in it,
and what is worth taking from it during a migration.

**Build verified on:** Arma Reforger 1.8.0.13 (engine 192142).
All the structures below come from a running dedicated server, not from documentation:
Bohemia gives practically no documentation for this directory.
Most of them were re-checked on this build: §3 `ownerToken.bin`, §5.6 and §5.7 — where a player's
identity and the bans are actually kept — the session save's form, the settings files and the log
layout. §5's `m_aStats` mapping and the save's inner format are the exception: they were read from a
1.6.0.119 run and not re-read here, and §10 says so where it matters.

---

## 1. What a profile is and where it lives

**A profile is a directory with the data of a specific installation, separate from the game files.**
Logs, saves, custom engine settings and the server owner token are written there.
The game data (`.pak`, addons) is stored separately and is not touched by the profile.

The directory is set by a startup parameter:

```
-profile <directory>
```

If the parameter is not set, the profile is created **next to the executable**.
In the wiki the profile path for the game is described as
`Documents/My Games/ArmaReforger/profile/addons` — that is, on the client the profile
lives in the user's documents, not next to the game.

### Three different profiles

It is important to understand that there are several profiles and they are **not interchangeable**:

| What | Directory (typically) | Purpose |
|---|---|---|
| **Client** | `Documents\My Games\ArmaReforger\profile` | game: settings, mod cache, single-player saves |
| **Workbench** | `Documents\My Games\ArmaReforgerWorkbench\profile` | editor: project list, module settings, `NetAPI_Enabled` |
| **Dedicated server** | next to `ArmaReforgerServer.exe`, set with `-profile` | logs, session saves, `ownerToken.bin` |

They must not be mixed: Workbench looks for its settings in its own profile, the server in its own.
If the server has no `-profile` set, it will create a profile next to the `.exe`, and that
leads to logs being looked for somewhere other than where you expect.

### What is visible in the server profile

```
<profile>/
├── logs/
│   ├── CrashReports.log
│   ├── logs_<date>_<time>/            ← a directory per launch
│   │   ├── console.log
│   │   ├── error.log
│   │   ├── script.log
│   │   └── .backend/                  ← logs of exchange with the Bohemia backend
│   └── ...
├── profile/
│   ├── ownerToken.bin                 ← server owner token
│   └── .save/
│       ├── game/                      ← session saves (world state)
│       ├── playersave/                ← player data
│       └── settings/                  ← engine settings
├── addons/
│   └── saves/                         ← created, but remained empty in the verification
└── resourceDatabase.rdb               ← does not always appear
```

Note the double nesting: **the profile contains a `profile` subdirectory**.
This is not a typo. That is why the path to saves looks like
`<profile>/profile/.save/...`, and to logs — `<profile>/logs/...`.

---

## 2. Logs

### A directory per launch

Logs are not overwritten: on every server start a new directory
`logs_<YYYY-MM-DD>_<HH-MM-SS>` is created. Inside it:

| File | What is inside |
|---|---|
| `console.log` | The main log. This is also where the `CLI Params:` line with the accepted parameters, the addon list, `JSON is Valid`, the RPL server start and the backend registration are |
| `error.log` | Errors and warnings only. Convenient for a quick check: in the verified sessions it was 40+ KB against 50+ KB for `console.log` |
| `script.log` | Compilation of script modules: `Module: Game; loaded Nx files; Mx classes`, as well as compilation errors |
| `.backend/` | Logs of exchange with the Bohemia backend |

**Practical conclusion:** when troubleshooting a problem, open `error.log`, not `console.log` —
there is an order of magnitude less noise there. But `script.log` is needed separately:
information about script compilation is only in it.

### How many logs are kept

The number of log directories is limited by the startup parameter **`-keepNumOfLogs`**
(**10** by default — the value from the wiki). The verified server had `9999`,
meaning the limit was effectively removed, and directories for various dates accumulated.

**About `.backend/`: this may be sensitive.** It holds the details of the exchange
with the backend, including the server registration. Before handing such a directory
to anyone for troubleshooting, check whether it contains identifiers of your server.

---

## 3. `ownerToken.bin` — the server owner token

A file about **0.5 KB** in size, located in `<profile>/profile/ownerToken.bin`.

**It is a signed token issued to this profile by the Bohemia backend — not a local setting and
not something the server generates for itself.** The API behind it is broken down in
[ArmaReforger_BackendAPI_EN.md](ArmaReforger_BackendAPI_EN.md); this section is about the file.

### 3.1 What the file is

It is plain ASCII text — a **JWT** of three dot-separated parts, `header.payload.signature`,
with the algorithm **`RS512`** (an RSA signature). The payload is **not** encrypted, only signed,
so anyone holding the file can read it:

```text
{"alg":"RS512"}.{"iat":1792083748,"serverId":"624cdf85-087f-4d08-8cf7-07c55f102e25",
"serverType":"CommunitySelfHosted","ownerType":"Anonymous"}.<342-character signature>
```

The claims, as read from five real files:

| Claim | What it holds |
|---|---|
| `iat` | Issued-at, a Unix timestamp — **the moment the token was minted** |
| `serverId` | UUID of the server this token owns. **A different value in every profile** |
| `serverType` | `CommunitySelfHosted` in all five files |
| `ownerType` | `Anonymous` on a dedicated server, `GameIdentity` in the game client's profile |
| `ownerId` | Present only with `ownerType: GameIdentity` — the owner's Game Identity id |

The five files read on this machine, with the file's own creation time next to the `iat` claim:

| Profile | `ownerType` | `ownerId` | Created | `iat` |
|---|---|---|---|---|
| `Documents\My Games\ArmaReforger\profile` (client) | `GameIdentity` | yes | 2026-08-17 23:07:50 | 23:07:50 |
| `Documents\My Games\ArmaReforgerServer\profile` | `Anonymous` | no | 2026-01-05 20:18:24 | 20:18:26 |
| `Documents\My Games\test\profile` | `Anonymous` | no | 2026-04-20 13:15:32 | 13:15:33 |
| `Arma Reforger Server\test\profile` | `Anonymous` | no | 2026-04-20 18:19:44 | 18:19:45 |
| `out\ban-probe\profile\profile` (probe runs) | `Anonymous` | no | 2026-10-15 20:02:26 | 20:02:28 |

**The `iat` matches the file's creation time to the second in all five** — the token is written
at the moment it is issued, once per profile, and never refreshed in place. Each profile carries
its own `serverId`, so the token is tied to **one server installation**, not to an account.

### 3.2 Where it comes from, and what proves it

**The token arrives in the answer to the server's own registration call, and the server writes it
to disk at once.** Captured live on 1.8.0.13 (see below): the dedicated server posts its
configuration to

```text
POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer
```

and the `200` answer carries two members:

```text
{"dsConfig":{"providerServerId":"d53ef442-…","dedicatedServerId":"8b6aca5a-…", …},
 "ownerToken":"eyJhbGciOiJSUzUxMiJ9.…"}
```

The server then writes that string, unchanged, to `$profile:ownerToken.bin`: in the captured run
the file appeared at `05:11:48`, its `serverId` is exactly the `providerServerId` from the same
response, and the very next call — `POST …/lobby/rooms/register` — sends **the same JWT back as
`accessToken`**. The owner token is therefore also the session credential for the lobby.

What supports the attribution, in decreasing order of strength:

- **It is signed by the backend.** The signature is RSA (`RS512`) over the first two parts.
  Neither the game nor the server ships that private key, so a token with a valid signature can
  only have been produced by Bohemia's online service.
- **The exchange was captured.** A TLS-terminating proxy in front of the server showed the
  request and the response above, byte for byte, in a run that reached
  `Server registered with address:` and a `Direct Join Code`.
- **The binary agrees on the shape.** `ArmaReforgerServer.exe` **1.8.0.13** carries
  `dedicatedServers/registerUnmanagedServer` (`DSUnmanagedRegisterS2S`), the field name
  `ownerToken` beside `dsConfig`, and `OwnerTokenExpand@ServerConfiguration`; the write path
  `$profile:ownerToken.bin` is a string in the same build.
- **A profile that never reached the backend has no token.** A server whose backend requests all
  failed at the TLS layer wrote no `ownerToken.bin` at all (45 s uptime, requests retried every
  ~6 s), while a profile from a run that did reach the backend has one.

**`dedicatedServers/createOwnerToken` is *not* the call the dedicated server uses.** The path and
the classes `LobbyApiCreateServerOwnerToken` / `LobbyApiResponseCreateServerOwnerToken` are in the
same binary, but no request to it was seen in any captured run. The client's own token — the one
with `ownerType: GameIdentity` and an `ownerId` — is the likely product of that other route, which
was not captured; **which endpoint issues the client's token is not established here.**

**Consequence of losing it: a lost token cannot be restored by copying files around.** On a fresh
profile the server registers again and gets a token for a **new `serverId`**, which is not the same
server as far as the backend is concerned. What exactly the owner loses when that happens — and
whether the previous `serverId` can be reclaimed — was **not** established here.

### 3.3 What it is for

| Use | Evidence |
|---|---|
| **RCON and chat `#login` without a password** — "the owner from `ownerToken.bin` logs in without a password" | BI wiki, [Server Management](https://community.bistudio.com/wiki/Arma_Reforger:Server_Management), and [`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md) §4.3 |
| **The in-game owner check** `BackendApi.IsServerOwner(int iPlayerId)` | The published `BackendApi` member list; see the backend document |
| **Proof of ownership towards the backend, and the lobby session credential** — the token arrives in the registration answer and is sent back as `accessToken` on the next call | Captured live: `POST …/lobby/dedicatedServers/registerUnmanagedServer` → `{"dsConfig":…,"ownerToken":"…"}`, then `POST …/lobby/rooms/register` with `"accessToken":<the same JWT>` |

**There is no `ownerToken` field in `server.json`.** The config schema does have root-level
`serverId` and `ownerType` ([§5.1 of the config guide](ArmaReforger_ServerConfig_EN.md)), the
same two names as two of the claims, and both are filled in by the backend. Whether the server
takes the values it reports back from this token was **not** verified, and the guide's advice
stands: do not write either key yourself.

Practically:

> **Make a backup of `ownerToken.bin` and keep it separately from the server.**
> This is the smallest and the most unrecoverable file in the entire installation.

**And do not hand the same file to a second server.** The token is the server's identity in the
backend, not a licence: one token maps to one room, and a room has one owner at a time. Two servers
carrying the same token collide — the later registration takes the room, the earlier server is told
`404 DedicatedServerNotFound` on its next heartbeat and logs `DS Room/ Server not exist anymore,
shutting down...`, and if both start in the same instant the loser fails with a backend `500` before it
ever serves. Two servers need two profiles; copying this file across does not clone a server, it makes
the two fight over one room. The measurements are in
[Backend API §3.2](ArmaReforger_BackendAPI_EN.md).
>
> **Do not publish it.** Anyone holding it can read the `serverId`, and it is the server's
> ownership credential — a log or a profile directory handed to a stranger should not contain it.

---

## 4. Session saves

### Directory structure

```
<profile>/profile/.save/game/
└── <scenario GUID>-<scenario name>/
    └── playthrough000/
        ├── savepoint000/
        │   ├── meta-info.json
        │   └── WorldState/
        │       └── <UUID>.blob
        ├── savepoint001/
        └── ...
```

Everything in this structure is **readable and meaningful**:

- **`<GUID>-<Name>`** — the directory per scenario. In the verification it was
  `BB5345C22DD2B655-23-Campaign-HQC-Cain`, which corresponds exactly to the scenario
  `{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf` from
  [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md).
  That is, **the save directory shows which scenario was played**.
- **`playthrough000`, `playthrough001`…** — a playthrough. The count starts at zero.
  A new playthrough appears when the scenario is started again.
- **`savepoint000`…** — save points inside the playthrough, in order.
- **`WorldState/<UUID>.blob`** — the world state itself.

> **The world-state file changed form on 1.8.0.13.** A clean shutdown of this build wrote
> `savepoint000/WorldState/<uuid>.blob` of about **31 KB**. The earlier 1.6.0.119 verification wrote
> `<UUID>.json`, about **6 MB** per save point (6264–6278 KB), so a playthrough of one scenario came
> to ~25 MB. If you are sizing disk space, check which form your build writes rather than trusting
> either number: the `.blob` is opaque here, its inner format was not read.

### `meta-info.json` — the save's ID card

This is the key file: the UUID for the `-loadSessionSave` parameter is taken from it.
A real example in full — read from the 1.6.0.119 verification, the only save whose `meta-info.json`
was read in full, and unchanged in shape on this build as far as the fields below go:

```json
{
    "m_Id": "d6881554-1080-44ba-b24d-a1ac57cfe8d5",
    "m_eType": 0,
    "m_iSavedAtUnix": 1776804368,
    "m_iSavePointNr": 0,
    "m_sSavePointDisplayName": "1776804368",
    "m_rMissionResource": "BB5345C22DD2B655",
    "m_iPlaythroughNr": 0,
    "m_sPlaythroughDisplayName": "",
    "m_iStartedUnix": 0,
    "m_iPlaytimeSeconds": 620,
    "m_sGameVersion": "1.6.0.119",
    "m_aUsedAddons": []
}
```

| Field | Meaning |
|---|---|
| `m_Id` | **The save UUID.** This is the value for `-loadSessionSave <UUID>` |
| `m_eType` | Save type. `0` corresponds to `MANUAL` from the `ESaveGameType` enum (`MANUAL`, `AUTO`, `SCRIPTED`, `SHUTDOWN`). **The correspondence is verified for the value 0; for the other types the conclusion is drawn from the enum order and is unconfirmed** |
| `m_iSavedAtUnix` | Save time, Unix time |
| `m_iSavePointNr` | Save point number |
| `m_sSavePointDisplayName` | Display name of the point |
| `m_rMissionResource` | Scenario resource GUID — matches the GUID in the save path |
| `m_iPlaythroughNr` | Playthrough number |
| `m_sPlaythroughDisplayName` | Playthrough name |
| `m_iPlaytimeSeconds` | Playtime, seconds |
| `m_sGameVersion` | **The game version that made the save** |
| `m_aUsedAddons` | **The list of addons active at the moment of saving** |

### Two fields worth knowing separately

**`m_sGameVersion`.** In the example — `1.6.0.119`, because that is the build that wrote this file.
The field carries the version of the build that made the save, so a save written by this build says
`1.8.0.13`. If the save version differs from the current build, the behavior on load is not
guaranteed. The field lets you check this before loading, not after.

**`m_aUsedAddons`.** In the example the list is empty, because the server ran without mods.
This is **the list of addons with which the save was made**. It stands to reason that on loading
the session the same addons must be available: if a mod was removed or updated
incompatibly, the world state may fail to reconcile. Check this field if the save
does not load.

### How to load a save

Startup parameter (see [`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md)):

```
-loadSessionSave                       # the latest save of the current scenario
-loadSessionSave <UUID from m_Id>      # a specific save
```

Without a value the server looks for the latest save for the current scenario. With a value
it takes a specific one, and the UUID must be looked up in the `meta-info.json` of the
required save point.

### What happens on a scenario change

The save directory is tied to the **scenario** (by its GUID in the directory name). Therefore
saves of another scenario will not be picked up and will not get in the way: they are stored
separately. But neither can you "transfer" progress to another scenario by changing `scenarioId`.

> **Important about the config fields.** The `server.json` schema has the fields `loadSessionSave`,
> `keepSessionSave`, `saveRetention` and `autoSaveInterval` (see the main document, §5.7).
> They are **not publicly documented**, and were not used on the verified server.
> If you want to control saves — start with the startup parameter `-loadSessionSave`:
> it is described in the wiki. Consider the other fields unverified.

---

## 5. Player data

```
<profile>/profile/.save/playersave/PlayerData.<UUID>.json
```

One file per player, the name contains their UUID. In the verification the size was tiny —
**0.2 KB**, and the content was a single array of numbers (below **abbreviated**, the real file
contains all 39 values on one line without spaces):

```text
{"m_aStats":[0.0,10000.0,191.20201110839845,0.0, ... ,1.0,0.0,0.0]}
```

This is **not an inventory**, but the player's career statistics. Analyzed below — contrary to my
first assumption, the position mapping exists and is recovered exactly.

### 5.1 How `m_aStats` is structured

`m_aStats` is an `array<float>` in the `SCR_PlayerData` class, and **it is indexed by the
ordinal of the `SCR_EDataStats` enum**. This is visible right in the code:

```enforce
void AddStat(SCR_EDataStats stat, float amount = 1, bool temp = true)
{
    ...
    m_aStats[stat] = m_aStats[stat] + amount;   // enum as index
}

float GetStat(SCR_EDataStats stat, bool newStat = true)
{
    if (newStat)
        return m_aStats[stat];
    return m_aPreviousStats[stat];
}
```

Two consequences follow from this:

- **there are no field names in the JSON and there cannot be** — only positions;
- **the array size equals the number of enum members**, and this is checked by the code:
  in `BackendDataReady()` there is the comparison `m_aStats.Count() != SCR_EDataStats.GetVariableCount()`,
  and on a mismatch the profile is **overwritten with an empty one** with the warning
  `We will override their profile with a new one, which will erase their old profile`.
  That is, you must not add or remove values by hand — the size has to match.

The enum starts at zero (there are no explicit values), therefore **ordinal = array index**.

### 5.2 The full mapping: all 39 positions

The `SCR_EDataStats` enum is declared at the end of `SCR_PlayerData.c` (line 918),
and this is the **declaration order**, that is, it is also the order in the array:

| # | Member | What it is |
|---:|---|---|
| 0 | `RANK` | Player rank |
| 1 | `LEVEL_EXPERIENCE` | Experience points (XP) |
| 2 | `SESSION_DURATION` | Total duration of sessions |
| 3 | `SPPOINTS0` | Infantry specialization points |
| 4 | `SPPOINTS1` | Logistics specialization points |
| 5 | `SPPOINTS2` | Medical specialization points |
| 6 | `WARCRIMES` | War crime points |
| 7 | `DISTANCE_WALKED` | Distance walked on foot |
| 8 | `KILLS` | Enemy players killed |
| 9 | `AI_KILLS` | Enemy AI killed |
| 10 | `SHOTS` | Shots fired |
| 11 | `GRENADES_THROWN` | Grenades thrown |
| 12 | `FRIENDLY_KILLS` | Friendlies killed (players) |
| 13 | `FRIENDLY_AI_KILLS` | Friendlies killed (AI) |
| 14 | `DEATHS` | Deaths |
| 15 | `DISTANCE_DRIVEN` | Distance driven at the wheel |
| 16 | `POINTS_AS_DRIVER_OF_PLAYERS` | Points for transporting players |
| 17 | `PLAYERS_DIED_IN_VEHICLE` | Players who died in a vehicle driven by the player |
| 18 | `ROADKILLS` | Enemy players run over with a vehicle |
| 19 | `FRIENDLY_ROADKILLS` | Friendly players run over with a vehicle |
| 20 | `AI_ROADKILLS` | Enemy AI run over with a vehicle |
| 21 | `FRIENDLY_AI_ROADKILLS` | Friendly AI run over with a vehicle |
| 22 | `DISTANCE_AS_OCCUPANT` | Distance ridden as a passenger |
| 23 | `BANDAGE_SELF` | Bandages applied to self |
| 24 | `BANDAGE_FRIENDLIES` | Bandages applied to friendlies |
| 25 | `TOURNIQUET_SELF` | Tourniquets applied to self |
| 26 | `TOURNIQUET_FRIENDLIES` | Tourniquets applied to friendlies |
| 27 | `SALINE_SELF` | Saline applied to self |
| 28 | `SALINE_FRIENDLIES` | Saline applied to friendlies |
| 29 | `MORPHINE_SELF` | Morphine applied to self |
| 30 | `MORPHINE_FRIENDLIES` | Morphine applied to friendlies |
| 31 | `WARCRIME_HARMING_FRIENDLIES` | Harming friendlies |
| 32 | `CRIME_ACCELERATION` | Kick/ban acceleration |
| 33 | `KICK_SESSION_DURATION` | Session duration at the moment of the last kick |
| 34 | `KICK_STREAK` | How many times in a row the player was kicked within a short time |
| 35 | `LIGHTBAN_SESSION_DURATION` | Session duration at the moment of the last light ban |
| 36 | `LIGHTBAN_STREAK` | How many times in a row a light ban occurred |
| 37 | `HEAVYBAN_SESSION_DURATION` | Session duration at the moment of the last heavy ban |
| 38 | `HEAVYBAN_STREAK` | How many times in a row a heavy ban occurred |

Total **39 members (indices 0–38)**, which exactly matches the array length
in the verified files — 39 values. This is an independent convergence: the list was taken from
arexplorer 1.7.0.54 — older than this build — and the array length from a 1.6.0.119 run.

**Verification of the order against the code.** The position of `CRIME_ACCELERATION` must be exactly 32:
in `LoadEmptyProfile()` it is filled with the value of `GetMinAcceleration()`, and in the verified
files index 32 equals `1.0` — exactly what `m_fAccelerationMin` returns
(see §5.3). If the ban block sat somewhere else in the enum, this position
would not match.

> **Be careful with versions.** The list was taken from arexplorer 1.7.0.54, where the game is newer
> than the verified build. The number of members matched, but **the composition could differ**: the block
> `KICK_*` / `LIGHTBAN_*` / `HEAVYBAN_*` (indices 33–38) looks like it was added later.
> Positions 0–32 are confirmed by the code and the data, while the last six are worth re-verifying
> on your own build.
>
> **The reliable check is the array length:** it must equal the number of `SCR_EDataStats` members
> in your game version. On a mismatch the engine itself will overwrite the profile
> (see §5.1).

### 5.3 Verification against real data

Two files from the same server are an excellent test, because the positions are easy to identify:

| Index | Field | Player 1 | Player 2 |
|---:|---|---:|---:|
| 0 | `RANK` | 0.0 | 0.0 |
| 1 | `LEVEL_EXPERIENCE` | **10000.0** | **10000.0** |
| 2 | `SESSION_DURATION` | **191.202** | **87.744** |
| 7 | `DISTANCE_WALKED` | **108.987** | **39.187** |
| 32 | `CRIME_ACCELERATION` | **1.0** | **1.0** |
| the rest | — | 0.0 | 0.0 |

Why this confirms the analysis:

1. **Index 1 = exactly `10000.0` for both.** In the code `LoadEmptyProfile()` puts
   exactly `m_Configs.XP_NEEDED_FOR_LEVEL` into the `LEVEL_EXPERIENCE` position, and
   `XP_NEEDED_FOR_LEVEL` in `SCR_PlayerDataConfigs` is declared as **`10000`**.
   The match is exact.
2. **Index 32 = exactly `1.0` for both** — this is `CRIME_ACCELERATION`, and
   `LoadEmptyProfile()` puts `m_Configs.GetMinAcceleration()` there, which
   returns `m_fAccelerationMin`, and in `SetDefault()` it is set to **`1.0`**.
3. **The session duration is recognizable by its size.** For player 1 `m_iPlaytimeSeconds`
   in the same server's `meta-info.json` equals **620**, while `SESSION_DURATION` equals
   `191.2`. That is, it is an accumulated value, not the total time on the server —
   which agrees with `CalculateSessionDuration()`, where the tick
   difference is added to the value.
4. **The ratios look like walking speeds.** `108.987 / 191.202 = 0.57` m/s and
   `39.187 / 87.744 = 0.45` m/s — plausible average speeds allowing for
   standing around, combat and looting.
5. **All the other positions are zero** — the server was a test one, the players had only just joined.

### 5.4 What else is known about this array

- **There are two copies of the stats:** `m_aStats` (current) and `m_aPreviousStats`
  (a snapshot at the start of the session). The difference between them is what the player earned
  during the session; specializations, war crimes and experience are computed from it.
- **The rank is not stored separately, it is computed.** In `CalculateStatsChange()`:
  `m_aStats[RANK] = m_aStats[LEVEL_EXPERIENCE] * XP_NEEDED_FOR_RANK_DIVIDER`,
  where the divider equals `0.00001`. That is, rank is derived from experience.
- **The experience ceiling** is `MAX_EXP = 1000000`; once it is reached, experience and session duration
  stop growing.
- **War crimes reduce experience:** with `WARCRIMES > 0` the experience earned during the session
  is multiplied by `1 - WARCRIMES_PUNISHMENT`, where the punishment equals `0.25`.
- **Part of the stats does not make it into the file.** Time with a gamepad and a keyboard
  (`m_iSecondsAsController`, `m_iSecondsAsKeyboard`) is explicitly marked in the code as
  "temporal stats single-session based that are only tracked for analytic purposes
  and not stored in the backend storage" — that is, these are session data, and they are not in
  `playersave`.

### 5.5 Can the file be edited by hand

Technically yes, but there are three limitations because of which I do not advise it:

1. **The array size must match** the number of enum members — otherwise the engine
   will consider the profile incomplete and **overwrite it with an empty one**, erasing the old data.
2. **The profile also lives in the Bohemia backend.** The file is only a local copy;
   the value `m_bIsEmptyProfile` and the requests `PlayerCharacterGet` /
   `PlayerCharacterUpdateS2S` indicate that the truth is stored on the service side.
   An edit of the local file may simply be overwritten.
3. **Rank and specializations are derived** — they cannot be set directly, they are
   recomputed from experience and accumulated points.

If you still need to reset a player's stats — it is more reliable to delete their file
`PlayerData.<UUID>.json` with the server stopped than to edit the numbers.

### 5.6 Where a player's data lives, and what the file name means

Data about one and the same player is kept in three places, and only one of them is a file:

| Where | What is there | Who owns it |
|---|---|---|
| **The Bohemia backend** | The authoritative career record, and the ban list of this server. The server reads and writes both over the online API | Bohemia. The server is a client of it |
| **The profile** | A local copy of the career record (`PlayerData.<identityId>.json`) and the session saves of §4. Bans leave nothing here at all (§5.7) | The server writes it, but it is not the source of truth |
| **The logs** | The player's name and identity id at every join, and the audit lines | Plain text, a directory per launch (§2) |

**The UUID in the file name is the player's `identityId`, not their `playerId`.** The two
identifiers are constantly confused and they are not interchangeable:

| Identifier | What it is | Where it shows up |
|---|---|---|
| `playerId` | A small number handed to the connection. It lives only as long as the session, and the next player who joins can get the same one | `#players`, `#id`, `#kick <playerId>`, `PlayerId=1` in the log |
| `identityId` | The player's Bohemia account id — a UUID, one per game-platform combination, created on the first connection | The `PlayerData.<identityId>.json` file name, `#ban create <identityId>`, `game.admins` |

That these are the same person is visible in a single profile. In one run of a verified server
the log carries both lines below, and the UUID in them is the UUID of the file that the same
profile holds:

```text
BACKEND : Authenticated player: rplIdentity=0x00000000 identityId=<UUID> name=<name>
NETWORK : ### Updating player: PlayerId=1, Name=<name>, rplIdentity=0x00000000, IdentityId=<UUID>
```

```
<profile>/profile/.save/playersave/PlayerData.<UUID>.json
```

**Practical consequence.** When a player has already left and you need to ban them, the log is
where their identity id is: `#ban create` accepts a `playerId` only while the player is
connected, and an `identityId` at any time (see
[`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md) §4.4). The script API converts
`playerId` → `identityId` (`BackendApi.GetPlayerIdentityId(int)`) and offers **no** reverse
conversion, so an offline player can only be unbanned by identity or by name.

**The local file is a cache of a backend object, not the record.** `SCR_PlayerData` reads it
with `BackendApi.PlayerCharacterGet(...)` and writes it back with
`BackendApi.PlayerCharacterUpdateS2S(...)` (`SCR_PlayerData.c`, lines 227 and 306).
`SCR_PlayerData.c` contains no file I/O at all — it only talks to the backend — so the local
copy is produced by the engine, not by this script. What §5.5 says about hand-editing follows
from that: the file can be overwritten by whichever side is considered newer.

Two more engine paths in the profile root are visible in the binary but did not appear in any
profile on the machine used for verification — listed here so that nobody hunts for them:

| Path | String next to it in the binary | Status |
|---|---|---|
| `$profile:ArmaReforgerOnline.bin` | `cloud-saves-ar` | Not created, neither by the server nor by the client |
| `$profile:stats-<...>.csv` | `StatsApiRecord :: Script Var Type for "%s" is not supported!` | Not created |

### 5.7 Bans: what is stored where
**A ban is not a file on the server.** Three separate mechanisms exist, and only one of them
leaves anything in the profile:

| Kind | Who creates it | Where the record lives | What is left in the profile |
|---|---|---|---|
| **Admin ban** — `#ban create`, from RCON or from chat | An administrator | The Bohemia backend, **per server** (`BanServiceApi`) — the only copy that exists | Nothing on disk, see below |
| **Heavy ban** from the automatic crime system | The server itself | The backend — this is the branch the code describes as "heavy ban (requires backendapi ban)" | The player's own counters at indices 33–38 of `m_aStats` (§5.2) |
| **Light ban or kick** from the same system | The server itself | Not the backend ban list: a kick with a reconnection timeout, `PlayerManager.KickPlayer(id, reason, timeout)`, with the reason `TEMP_BAN` — "Temporary banned AKA kick with timeout" | The same counters |

The commands themselves — syntax, permissions, answer texts and why `#ban list` answers with
`PENDING` — are dissected in [`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md) §4.4. Here
only the storage matters.

**The backend is the authority, and the list belongs to one server.** The pipeline behind the
command is `BackendApi.GetBanServiceApi()` → `CreateBanPlayerId` / `CreateBanIdentityId` /
`RemoveBans` / `RemoveBanByName` / `RequestServerBanList`, and the last of those asks for the
active bans **of this server** ("players banned on local server"), over the lobby endpoints
`rooms/createBan`, `rooms/removeBans` and `rooms/listActiveBans`. Banning a player on one
server therefore does not ban them on another.

One record of that list is `OnlineBanListData`, and its own comments describe the fields:

| Field | Type | Meaning |
|---|---|---|
| `identityId` | string | Identity ID of player |
| `bannedName` | string | Name of player when he was banned |
| `currentName` | string | Current name of player |
| `reason` | string | Reason of ban |
| `createdAt` | int | Timestamp of when ban was created |
| `expiresAt` | int | Timestamp of when ban will expire (**0 if never — permanent ban**) |

`bannedName` next to `currentName` is worth noticing: the list keeps both the name the player
had when they were banned and the name they use now, so a rename does not hide a ban.

**The only candidate for a ban on disk — and what the experiment showed.** The engine's binary
carries a whole local-ban family: the class `LocalBanDataCache` (with `LocalBanData`,
`BaseBanData` and `OnlineBanRequestData` beside it), the log line
`Local Ban transaction finished. result=%u`, and the file name `bans.json` sitting next to a
container name `serverData`. The JSON keys beside those strings are `bans`, `targetId`,
`bannedName`, `currentName` and `expiresAt` — the same records as `OnlineBanListData`, without
`reason` and `createdAt`. `serverData` is a **storage container name rather than a path**: the
platform log names its containers the same way (`Save data from container 'settings' have been
loaded`, `'sessions'`), so *if* that cache is ever written it would land beside `settings` and
`playersave` under `.save/`.

**None of it produced a file.** On a real server (1.8.0.13, non-public, RCON on
127.0.0.1:19999, `-logFS` on, fresh profile) all of the following were done, and after every one
of them the profile held no `bans.json` and no `serverData`, while `filesystem.log` — which
records every single file-system access — had not one line mentioning either name:

| What was done | Result |
|---|---|
| A player joined and was banned over RCON (`ban create 1 0 <reason>`) | `Player '<name>' banned!`, the player was disconnected with `reason=3` (`PlayerManagerKickReason.BAN`); **no local file** |
| The ban list was fetched from the backend (`ban list 1`) | `Total bans: 1 \| Page: 1/1` with the record; **no local file** |
| The server was restarted with that non-empty list, so the list is fetched at startup | The server registered and started normally; **no local file** |
| The ban was removed (`ban remove <identityId>`) and the list re-read | `Ban removed!`, then `Server has no bans to list.`; **no local file** |
| The server was shut down cleanly over RCON (`shutdown`) | `[PERSISTENCE] Save (SHUTDOWN) started` / `Save completed successfully`; **no local file** |

The plausible remaining home for that code is the **offline path**, and on this build that path
is not reachable either: a dedicated server started with `-noBackend` accepts the parameter
(`Backend Services are disabled.`) but **destroys its own game instance about 17 seconds into
the world load** (`Game destroyed`) — tried with two scenarios (Conflict — Everon and Combat Ops
— Everon). With no session there is nobody to ban and no way to reach a local fallback.

The practical answer for an administrator is therefore: **do not go looking for a ban list
file.** The list is on the Bohemia side, per server, and this document cannot point at any file
that holds it. The names above are recorded so that they are not mistaken for a description of
reality — and so that anybody who does meet a `bans.json` (a listen server, a later build, a mod)
knows where it came from.

**Two more things the binary knows about bans.** `GLOBAL_BAN` and `ADMIN_BAN` appear next to
the join-time error codes `EACODE_ERROR_PLAYER_IS_BANNED`, `EACODE_ERROR_DS_USER_JOIN_BAN`,
`EACODE_ERROR_P2P_USER_JOIN_BAN` and `EACODE_ERROR_USER_IS_BANNED_FROM_SHARED_GAME`, so the
engine distinguishes a Bohemia-side global ban from the server's own admin ban. Which API issues
a global ban was not established.

**Mods are a separate matter.** A moderation mod keeps its own list in its own file in the
profile. The Server Admin Tools mod, for example, holds its whole configuration — bans, admins,
Game Masters — in `profile/ServerAdminTools_Config.json`, and those bans have nothing to do with
the ones `#ban` creates. When somebody goes looking for "the ban list file", this is usually the
file they find, and it is not the game's.

**What sets the automatic system off** is a set of thresholds, not a list of names: the settings
item `SCR_BanSettings` carries `m_fScoreThreshold`, `m_fScoreDecreasePerMinute`,
`m_fScoreMultiplier`, `m_fAccelerationMin` / `m_fAccelerationMax`, `m_fBanEvaluationLight`,
`m_fBanEvaluationHeavy`, `m_fCrimePtFriendKill` and `m_fCrimePtTeamKill` — the criminal score
that `SCR_PlayerData` accumulates in `m_fCriminalScore` is compared against them. That score is
**not** part of `m_aStats` (only `m_aStats` is registered for serialisation), so it never reaches
the file: on disk the punishment leaves the counters of §5.2 and nothing else. Where the settings
item itself is configured was not established; `server.json` has no ban section at all.

---

## 6. Engine settings in the profile

```
<profile>/profile/.save/settings/
├── ReforgerEngineSettings.conf
└── ReforgerGameSettings.conf
```

**`ReforgerEngineSettings.conf`** (~2.7 KB) — the engine settings, and they are read
at startup: the log shows `Loading custom engine user config` and
`Engine user settings config loaded`. The content for a dedicated server is almost empty —
only the input sections and the language are filled in:

```
EngineUserSettings {
 GraphicsQualitySettings GraphicsQualitySettings { }
 GrassMaterialSettings GrassMaterialSettings { }
 InputDeviceUserSettings InputDeviceUserSettings {
  GamepadProfile InputProfileGamepad "{6928F4DF2B184D08}" { ... }
  JoystickProfile InputProfileJoystick "{6928F4DF2B183EDE}" { ... }
 }
 ...
 UserInterfaceSettings UserInterfaceSettings {
  LanguageCode "en_us"
  SystemLanguageCode "en_us"
 }
 VideoUserSettings VideoUserSettings {
  WindowPosX 640
  WindowPosY 360
 }
}
```

The one useful thing here is **`LanguageCode`** — the language of the server messages in the log.
In the verification it was `en_us`. Graphics, `WindowPosX/WindowPosY` and gamepad profiles
make no sense for a headless server, but the engine writes them anyway.

**`ReforgerGameSettings.conf`** was **empty (0 KB)** in the verification, although the log has
the line `Game user settings config loaded`. That is, the file is created, but it is not
filled in on a dedicated server.

> These files are generated by the engine. **Edit them only when necessary and with the server
> stopped** — on shutdown it may overwrite the values with its own.

---

## 7. What does not go into the profile

Useful to know, so as not to look for the wrong thing there:

| What is absent | Where it actually is |
|---|---|
| **Server passwords and settings** | Only in `server.json` (`-config`). They are not in the profile |
| **The administrator list** | In `game.admins` of the config |
| **The ban list** | In the Bohemia backend, per server — it is not a file at all, and no flow tested produced one in the profile (§5.7) |
| **Write permissions on the profile** | The server needs them: logs, saves, settings — everything is written here |
| **The mods themselves** | In the addon directories, not in the profile |
| **`console.log` logs in the profile root** | They are always in `logs/logs_<date>_<time>/` |

Separately: the `<profile>/addons/saves/` directory **was empty** in the verification. It is created,
but what is written into it is not established. In the strings of the server binary the path
`addons/saves/` is present next to `addons/` and `news/`.

---

## 8. The Workbench profile — useful details

Since we are on the subject of profiles, here is what is in the Workbench profile
(`Documents\My Games\ArmaReforgerWorkbench\profile`):

| File | What it is |
|---|---|
| **`wbSettingsDump.ini`** | ~394 KB, about 3900 lines. **All** Workbench settings, including the key **`NetAPI_Enabled=1`** (a line in the `[General]` section) |
| `resourceDatabase.rdb` | Workbench resource cache |
| `.projectList_app<ID>_user<SteamID>.conf` | The list of opened projects. This is exactly where the paths to all your addons live |
| `export.json` | Export of map data (GeoJSON with points) |
| `DbgUIState.bin` | State of the debug windows |
| `.save/app<ID>_user<SteamID>/settings/` | `ReforgerEngineSettings.conf` and `ReforgerGameSettings.conf` for Workbench |

**`.projectList_...conf`** is convenient in that it shows **all** the projects that Workbench
has opened, including forgotten and other people's ones. Useful when Workbench compiles extra
addons and something conflicts.

---

## 9. Backup and migration

**Must be saved:**

1. **`ownerToken.bin`** — without it you can lose the server owner permissions.
2. **`server.json`** (it is outside the profile, in the server directory) — the whole configuration.
3. **`profile/.save/game/`** — session saves, if they are needed. Mind the weight: ~6 MB
   per save point.

**Not in the backup:** the ban list. It belongs to one server on the Bohemia side (§5.7), so a
copy of the profile neither carries bans to another server nor restores them on this one.

**Can be left out:**

- `logs/` — this is history, it is not needed for operation. Unless you keep it for troubleshooting.
- `profile/.save/settings/` — the engine will recreate it.
- `resourceDatabase.rdb` — will be rebuilt, via `-createDB` if necessary.

**When migrating to another machine:**

- preserve the **path case** on Linux (§ see the document about startup): the profile path
  and the save directory names are case-sensitive;
- check the permissions: the server must be able to write into the profile directory;
- after the move, look at `console.log` — it will have `Addon dirs:` and the line
  `CLI Params:`, which show that the server picked up the right profile.

---

## 10. Boundaries of reliability

- **The directory structure and file contents come from a running server**, not from documentation.
  Bohemia barely describes this directory. The directory layout, the settings files, the log layout,
  `ownerToken.bin` (§3), the identity and ban storage (§5.6, §5.7) and the session save's current
  form were re-checked on **1.8.0.13**; the `m_aStats` mapping (§5) and the inner format of the
  world-state file were read from a **1.6.0.119** run and are not re-read here.
- **`ownerToken.bin` is a backend-issued JWT, and both the file and the issuing exchange are
  evidence** (§3): five profiles on this machine hold one, each with a valid-looking `RS512`
  signature and an `iat` equal to the file's creation time, and a captured run shows the token
  arriving as the `ownerToken` member of the registration response and being written straight to
  disk. **What the owner loses with the file was not verified**: no test removed a working token
  from a registered server. **The client's token is a different route** — `ownerType:
  GameIdentity`, with an `ownerId`, issued by an endpoint this pass never saw; the
  `dedicatedServers/createOwnerToken` path that the binary carries was called by none of the
  captured dedicated-server runs.
- **The `m_eType` = `MANUAL` correspondence** is verified only for the value `0`.
- **The `SCR_EDataStats` enum** (39 members) was taken via arexplorer 1.7.0.54, which is **older**
  than this build, and it was not re-read out of the 1.8.0.13 archive. The number of members matched
  the array length (39), and positions 1, 2, 7 and 32 are confirmed by the code and the data. **The
  composition of the last six members (indices 33–38) — the ban block — was not verified on a
  running server of either build.**
- **The content of `addons/saves/`** is not established: in the verification the directory was empty.
- **The fields `loadSessionSave`, `keepSessionSave`, `saveRetention`, `autoSaveInterval`
  in `server.json`** are not publicly documented; they were not used in the verification.
- The `.backend/` directory **was empty** in the verified sessions, so its content
  is described only from the strings of the binary (`$logs:.backend/`).
- **The local ban cache does not appear in practice.** The names `serverData` and `bans.json`,
  and the classes `LocalBanDataCache` / `LocalBanData` / `BaseBanData`, are strings and symbols of
  `ArmaReforgerServer.exe` **1.8.0.13** — the pinned build. A live experiment on it (join, ban over
  RCON, list fetch, restart with a non-empty list, unban, clean shutdown) produced no such file and
  not one file-system access to either name (§5.7). The code path is therefore unreached in every
  flow tested, and its container, its schema and its trigger remain unknown.
- **A dedicated server cannot run without the backend on this build.** `-noBackend` is accepted
  (`Backend Services are disabled.`), but the game instance is destroyed about 17 seconds into the
  world load — with both scenarios tried. Anything that needs an offline dedicated server,
  including the local ban list above, could not be exercised.
- **The session save is a `.blob` on 1.8.0.13.** The probe's shutdown save landed as
  `playthrough000/savepoint000/WorldState/<uuid>.blob` (~31 KB); the 1.6.0.119 verification wrote
  `<UUID>.json` (~6 MB, §4). §4 describes both forms and leaves the `.blob`'s inner format
  unread.
- **The identity id is the UUID in the file name** is verified on this machine by matching the
  `identityId` of a join in `console.log` against the `PlayerData.<UUID>.json` that the same
  profile holds — not by reading the engine's file-naming code.
- **The ban block in `m_aStats` (indices 33–38)** is `0.0` in every verified file: those members
  are never written on a server where nobody was ever kicked or banned, and their names still
  come from arexplorer 1.7.0.54.
- **The light/heavy ban split** is taken from the doc comment of
  `SCR_DataCollectorCrimesModule.RequestBanIfNecessary` — "heavy ban (requires backendapi ban),
  light ban or kick (duration difference)" — and from `PlayerManagerKickReason.TEMP_BAN`,
  "Temporary banned AKA kick with timeout". The ban placed over RCON in §5.7's experiment is the
  ordinary backend ban; neither the light nor the heavy variant was exercised, so that split is
  code, not observation.
- **`GLOBAL_BAN` and `ADMIN_BAN`** are strings in the same block as the join-time ban error codes
  (`EACODE_ERROR_PLAYER_IS_BANNED` and the rest); which of them means what was not established.
- **`$profile:ArmaReforgerOnline.bin` and `$profile:stats-<...>.csv`** are strings only — neither
  appeared in any profile on the machine, for the server or for the client.

### Sources

| What | From where |
|---|---|
| Profile structure, contents of `meta-info.json`, `PlayerData`, settings, file sizes | Running dedicated servers: `Arma Reforger Server\test\profile\` and `test\logs\` (1.6.0.119 and 1.8.0.13 runs) |
| The presence of `ownerToken.bin`, the paths `addons/saves/`, `serverConfigs/`, `$logs:.backend/` in the server build | Strings of `ArmaReforgerServer.exe` 1.8.0.13, block around `0x1A47E00` |
| §3 — the JWT structure of `ownerToken.bin`, the `iat`/`serverId`/`serverType`/`ownerType`/`ownerId` claims, and the creation time = `iat` correspondence | The five `ownerToken.bin` files on this machine (`Documents\My Games\ArmaReforger\profile`, `Documents\My Games\ArmaReforgerServer\profile`, `Documents\My Games\test\profile`, `Arma Reforger Server\test\profile`, `out\ban-probe\profile\profile`), decoded as JWT; the algorithm and claims are read from the files themselves |
| §3 — the issuer: the token arriving as `ownerToken` in the answer to `POST …/lobby/dedicatedServers/registerUnmanagedServer`, its `serverId` being that response's `dsConfig.providerServerId`, and the same JWT being replayed as `accessToken` on `POST …/lobby/rooms/register` | A dedicated server **1.8.0.13** run through a TLS-terminating proxy on this machine: fresh profile, non-public config, the full exchange written to `out/mitm-capture.jsonl`; the token file appeared at `05:11:48` and the run reached `Server registered with address: 127.0.0.1:2005` |
| §3 — the endpoint names and classes the binary carries (`dedicatedServers/registerUnmanagedServer`, `DSUnmanagedRegisterS2S`, `ownerToken`, `dsConfig`, `OwnerTokenExpand@ServerConfiguration`, `dedicatedServers/createOwnerToken`) | Strings and RTTI names of `ArmaReforgerServer.exe` **1.8.0.13** (blocks around `0x1A94478`, `0x1ACBEC0`, `0x20618xx`) |
| §3 — the negative result: a profile whose backend requests never got through holds no `ownerToken.bin` | A dedicated server **1.8.0.13** run for this investigation: `-profile` in an empty directory under `out\backend-probe`, 45 s uptime, `-backendLog 1`, every request failing with `Curl error=SSL peer certificate or SSH remote key was not OK` |
| `-keepNumOfLogs` default 10, `LanguageCode`, default profile path | BI Wiki "Arma Reforger: Startup Parameters" |
| The correspondence of the GUID `BB5345C22DD2B655` to the scenario `23_Campaign_HQC_Cain` | [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md) |
| The `ESaveGameType` enum (`MANUAL`, `AUTO`, `SCRIPTED`, `SHUTDOWN`) | `scripts/Game/generated/Plugins/Persistence/SaveGame/ESaveGameType.c` |
| The `SCR_EDataStats` enum (39 members in declaration order), the logic of `AddStat` / `GetStat` / `LoadEmptyProfile` / `CalculateStatsChange`, the constants `XP_NEEDED_FOR_LEVEL = 10000` and `m_fAccelerationMin = 1.0` | The sources `scripts/Game/DataCollection/PlayerData/SCR_PlayerData.c` (the enum is at line 918) and `SCR_PlayerDataConfigs.c` via arexplorer |
| The array length 39, the values of indices 1, 2, 7, 32 | The `PlayerData.<UUID>.json` files of two players from the profiles `Arma Reforger Server\test` and `ArmaReforgerServer` |
| The three storage tiers of §5.6, the `identityId` = file-name correspondence, the two log lines that carry `identityId`, and the absence of any ban artefact in the profiles | `console.log` and `profile/.save/playersave/` of the two verified profiles on this machine (`Arma Reforger Server\test`, `Documents\My Games\ArmaReforgerServer`) |
| `BackendApi.GetPlayerIdentityId`, `BackendAuthenticatorApi.GetIdentityId`, and the log text `%1 (playerID = %2 \| UUID = %3)` of `GetPlayerLogInfo` | `scripts/Game/Utilities/SCR_PlayerIdentityUtils.c` via arexplorer 1.7.0.54, and the published BI API member pages |
| The backend calls behind the career record (`PlayerData`, `PlayerCharacterGet`, `PlayerCharacterUpdateS2S`) and the `RegV("m_aStats")` key | `scripts/Game/DataCollection/PlayerData/SCR_PlayerData.c` (lines 101, 210, 227, 306) via arexplorer 1.7.0.54 |
| The six fields of `OnlineBanListData`, the `BanServiceApi` methods, and the per-server scope of `RequestServerBanList` | `scripts/GameLib/generated/online/OnlineBanListData.c` and `BanServiceApi.c` via arexplorer, and the published BI API member pages |
| `LocalBanDataCache`, `LocalBanData`, `BaseBanData`, `OnlineBanRequestData`, `bans.json`, `serverData`, `Local Ban transaction finished. result=%u`, the JSON keys beside them, `GLOBAL_BAN` / `ADMIN_BAN`, the join-time ban error codes | Strings of `ArmaReforgerServer.exe` **1.8.0.13** (blocks around `0x1A4CBxx`, `0x1A59xxx`, `0x1A93xxx`) |
| The negative result of §5.7 — no `bans.json`, no `serverData`, no file-system access to either name after a real ban, a list fetch, a restart with a non-empty list, an unban and a clean shutdown; the `reason=3` disconnect line; the behaviour of `-noBackend`; the `.blob` session save | A dedicated server **1.8.0.13** run for this investigation: non-public config, `-profile` in an empty directory, `-logFS`, a player joined from the same machine and banned over RCON |
| `SCR_DataCollectorCrimesModule.RequestBanIfNecessary`, `PlayerManagerKickReason` (`BAN`, `TEMP_BAN`), `PlayerManager.KickPlayer(id, reason, timeout)` and the fields of `SCR_BanSettings` | The published BI API member pages (`interfacePlayerManager-members.html`, `interfaceSCR__BanSettings.html`) and `scripts/Game/generated/Network/PlayerManagerKickReason.c` via arexplorer |
| The startup file inventory in §5.7 — a fresh profile, `-logFS`, two writes, no ban artefacts | A dedicated server **1.8.0.13** launched for this investigation with `-profile` in an empty directory, a local non-public config, `-logFS` and `-disableCrashReporter` |
| The Server Admin Tools mod keeping its bans in `ServerAdminTools_Config.json` | Loafhosts, «Share one ban list across Arma Reforger servers» — https://loafhosts.com/guides/arma-reforger-shared-ban-list/ |
| `wbSettingsDump.ini`, `NetAPI_Enabled`, `.projectList_*` | The Workbench profile: `Documents\My Games\ArmaReforgerWorkbench\profile\` |
