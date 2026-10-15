# Arma Reforger server profile

What is in the profile directory, why it is needed, what can and cannot be changed in it,
and what is worth taking from it during a migration.

**Build verified on:** Arma Reforger 1.6.0.119 (engine 192142).
All the structures below come from a running dedicated server, not from documentation:
Bohemia gives practically no documentation for this directory.

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

What is known about it:

- **The server really does use it.** The string `ownerToken.bin` was found in the strings of
  `ArmaReforgerServer.exe` — in the same block as other backend entities:
  `addons/saves/`, `serverConfigs/`, `config`, `gameConfig`, `userName`,
  `noBackend`, `backendLog`, `backendDS`, `backendEnv`. So it is not a client artifact.
- **It exists on both the client and Workbench** — a file with the same name lies in the
  `ArmaReforger` and `ArmaReforgerServer` profiles. So the token is tied to the
  installation/account, not to a specific server.

**What this means practically.** The token confirms ownership of the server. Having lost it,
you will most likely lose administrative access to your server (owner permissions in the
backend), even if all the other files are in place. Therefore:

> **Make a backup of `ownerToken.bin` and keep it separately from the server.**
> This is the smallest and the most unrecoverable file in the entire installation.
>
> **Do not publish it.** These are credentials, not a setting.

Note: there is no `ownerToken` field in the config. The config has `ownerType`
(and `serverId`), but those are different things — they belong to the `server.json` schema.

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
        │       └── <UUID>.json
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
- **`WorldState/<UUID>.json`** — the world state itself.

> **About the size.** One `WorldState` in the verification took **about 6 MB** (6264–6278 KB),
> and that is across four save points — already ~25 MB for one playthrough of one scenario.
> With autosaves on a public server with several scenarios the directory grows
> fast and unnoticed. **Take this into account when planning disk space** and do not keep
> saves on a small system partition.

### `meta-info.json` — the save's ID card

This is the key file: the UUID for the `-loadSessionSave` parameter is taken from it.
A real example in full:

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

**`m_sGameVersion`.** In the example — `1.6.0.119`. If the save version differs
from the current build, the behavior on load is not guaranteed. The field lets you
check this before loading, not after.

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
arexplorer (a newer game), and the array length from build 1.6.0.119.

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

- **The directory structure and file contents come from a running server 1.6.0.119**,
  not from documentation. Bohemia barely describes this directory.
- **The purpose of `ownerToken.bin` is inferred** from the fact that its name is present in the strings
  of the server binary together with other backend entities, and from the presence of the file in all
  three profiles. **There is no direct description in the documentation.** The recommendation to make
  a backup is justified, but the exact consequences of losing it were not verified.
- **The `m_eType` = `MANUAL` correspondence** is verified only for the value `0`.
- **The `SCR_EDataStats` enum** (39 members) was taken via arexplorer 1.7.0.54, where
  the game is **newer** than the verified build 1.6.0.119. The number of members matched the array
  length (39), and positions 1, 2, 7 and 32 are confirmed by the code and the data. **The composition
  of the last six members (indices 33–38) — the ban block — was not verified on build 1.6.0.119.**
- **The content of `addons/saves/`** is not established: in the verification the directory was empty.
- **The fields `loadSessionSave`, `keepSessionSave`, `saveRetention`, `autoSaveInterval`
  in `server.json`** are not publicly documented; they were not used in the verification.
- The `.backend/` directory **was empty** in the verified sessions, so its content
  is described only from the strings of the binary (`$logs:.backend/`).

### Sources

| What | From where |
|---|---|
| Profile structure, contents of `meta-info.json`, `PlayerData`, settings, file sizes | A running dedicated server: `Arma Reforger Server\test\profile\` and `test\logs\` |
| The presence of `ownerToken.bin`, the paths `addons/saves/`, `serverConfigs/`, `$logs:.backend/` in the server build | Strings of `ArmaReforgerServer.exe` 1.6.0.119, block around `0x1A47E00` |
| `-keepNumOfLogs` default 10, `LanguageCode`, default profile path | BI Wiki "Arma Reforger: Startup Parameters" |
| The correspondence of the GUID `BB5345C22DD2B655` to the scenario `23_Campaign_HQC_Cain` | [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md) |
| The `ESaveGameType` enum (`MANUAL`, `AUTO`, `SCRIPTED`, `SHUTDOWN`) | `scripts/Game/generated/Plugins/Persistence/SaveGame/ESaveGameType.c` |
| The `SCR_EDataStats` enum (39 members in declaration order), the logic of `AddStat` / `GetStat` / `LoadEmptyProfile` / `CalculateStatsChange`, the constants `XP_NEEDED_FOR_LEVEL = 10000` and `m_fAccelerationMin = 1.0` | The sources `scripts/Game/DataCollection/PlayerData/SCR_PlayerData.c` (the enum is at line 918) and `SCR_PlayerDataConfigs.c` via arexplorer |
| The array length 39, the values of indices 1, 2, 7, 32 | The `PlayerData.<UUID>.json` files of two players from the profiles `Arma Reforger Server\test` and `ArmaReforgerServer` |
| `wbSettingsDump.ini`, `NetAPI_Enabled`, `.projectList_*` | The Workbench profile: `Documents\My Games\ArmaReforgerWorkbench\profile\` |
