# `missionHeader` in the Arma Reforger server config — full breakdown

This is a supplement to the [main guide](ArmaReforger_ServerConfig_EN.md), section §5.5.2.
It describes what the wiki does not have: **exactly which keys `missionHeader` accepts**,
what types they have, what their defaults are and what they do.

The wiki says exactly one phrase about this field — "overrides the
scenario's `SCR_MissionHeaderCampaign`" — and gives neither a list of keys nor types.
So everything below is assembled from the class sources and verified against real
configs of vanilla scenarios.

**Build verified on:** Arma Reforger 1.8.0.13 (engine 192142) — the build whose `data007.pak` carries
the class sources this document is built from, whose executable supplies the `Server Config
MissionHeader:` error strings, and on which both working examples (§5.1, §5.3) reached
`JSON is Valid`.

Everything here comes from **the installed 1.8.0.13 build**: the field declarations, defaults and
enumerations are read out of `scripts/Game/Mission/SCR_MissionHeader*.c` and
`SCR_CampaignMilitaryBaseComponent.c` in its `data007.pak` (§8), the rank containers and the vanilla
`World` GUIDs from its archives (§2.1, §3.3), the error strings from its executable. **arexplorer
1.7.0.54** is no longer needed for any claim in this document — it was the only source before the
installed scripts could be read, and §3.4 was rebuilt from the archive when the class turned out to
be in it. Nothing here was measured as behaviour — it is source, strings and schema acceptance.

---

## 1. What this is mechanically

`missionHeader` is **not a separate format**. It is the very same object that sits
in the scenario file `Missions/<Name>.conf`, only written as JSON inside `server.json`.

The engine does this: reads `Missions/<Name>.conf` → gets the mission header object →
if `server.json` has a `missionHeader`, it **layers its fields on top of** the ones read.
Fields not specified in the JSON stay as they are in the scenario's `.conf`.

Two practical consequences follow:

1. **Key names in JSON are class field names, not the string names from `.conf`.**
   In `.conf` you write `World`, `SystemsConfig`, `m_sName`. In JSON — only fields of the
   script class: `m_sName`, `m_iPlayerCount`, `m_bRandomStartingDaytime`, etc.
   `World` and `SystemsConfig` are **not carried over** into `missionHeader` — they are set by
   the scenario itself.
2. **`missionHeader` can only change, not add.** If the field is not in the header class
   of your scenario, it will be ignored.

Verification that the field took effect is only possible by in-game behavior and by the log. Unknown
or wrongly typed parameters **do not crash the server**, they land in the log:

```
Server Config MissionHeader: Parameter '%s' is not supported type!
Server Config MissionHeader: Item on index %d in parameter '%s' is invalid type!
```

---

## 2. Header class hierarchy

The header class is determined by which scenario you run. Fields are inherited.

```
MissionHeader                                  (the engine's base: methods only, no fields)
└── SCR_MissionHeader                          ← Game Master, Training, Capture & Hold
    ├── SCR_MissionHeaderCampaign              ← every Conflict scenario (23_Campaign*, Conflict_*)
    └── SCR_MissionHeaderScenarioFramework
        └── SCR_MissionHeaderCombatOps         ← Combat Ops (24_CombatOps, 26_CombatOpsEveron, CombatOpsCain)
            └── SCR_MissionHeaderSequence      ← the Omega story scenarios (Scenario01–05)
```

The `:` parents above are the declarations themselves, read out of the installed 1.8.0.13 archive:
`SCR_MissionHeaderCampaign : SCR_MissionHeader`, `SCR_MissionHeaderScenarioFramework :
SCR_MissionHeader`, `SCR_MissionHeaderCombatOps : SCR_MissionHeaderScenarioFramework`,
`SCR_MissionHeaderSequence : SCR_MissionHeaderCombatOps`.

What matters practically is this: **every Conflict scenario uses `SCR_MissionHeaderCampaign`**, while
Game Master uses the bare `SCR_MissionHeader`. Therefore the same campaign key in `missionHeader`
will work on Conflict and be silently ignored on Game Master.

The vanilla configs confirm the binding — each line is the first line of the file named:

| Scenario file | Class on the first line |
|---|---|
| `Missions/23_Campaign.conf` | `SCR_MissionHeaderCampaign` |
| `Missions/ConflictWithoutAIs.conf` | `SCR_MissionHeaderCampaign` |
| `Missions/21_GM_Eden.conf` | `SCR_MissionHeader` |
| `Missions/CAH_Morton.conf` | `SCR_MissionHeader` |
| `Missions/24_CombatOps.conf` | `SCR_MissionHeaderCombatOps` |
| `Missions/Scenario01_Intro.conf` | `SCR_MissionHeaderSequence` |

> Capture & Hold is a game mode *string* (`m_sGameMode "Capture & Hold"`), not a header class: every
> `CAH_*.conf` declares the bare `SCR_MissionHeader`, so none of the campaign fields exist there.

> **Corrected against 1.8.0.13.** This section used to put `SCR_MissionHeaderSequence` under both
> branches, list "Conflict (without AIs)" as a plain `SCR_MissionHeader` scenario, and name
> `SCR_MissionHeaderCombatOps` as the class of `CAH_Morton.conf`. The declarations and the `.conf`
> files say otherwise: the sequence header derives from the Combat Ops header, `ConflictWithoutAIs`,
> `Conflict_East` and `Conflict_West` all declare `SCR_MissionHeaderCampaign`, and every
> `CAH_*.conf` declares the bare `SCR_MissionHeader`.

### 2.1 ⚠️ Map codenames: Cain = Kolguyev, Eden = Everon

**Map names in paths and file names do not match what these maps are called
in the UI.** The internal codenames are historical, from older versions of the game; the menu
and the labels use the new ones. This regularly causes confusion when picking a scenario:
there is no "Kolguyev" file in the game at all, and the scenario you need lives in `..._Cain.conf`.

| Codename (in paths and files) | Display name (in the UI) |
|---|---|
| **`Cain`** | **Kolguyev** |
| **`Eden`** | **Everon** |
| `Arland` | Arland (matches) |

The correspondence is confirmed by the vanilla configs themselves — in one file the world sits
at the codename path, while the name is set by a localization key with the new name:

| Scenario file | World (`World`) | Name (`m_sName`) |
|---|---|---|
| `Missions/27_GM_Cain.conf` | `{6228BD33933C8F81}worlds/GameMaster/GM_Cain.ent` | `#AR-Editor_Mission_GM_Kolguyev_Name` |
| `Missions/23_Campaign.conf` | `{9DF143A76F5C6460}worlds/MP/CTI_Campaign_Eden.ent` | `#AR-Campaign_ScenarioName_Everon` |
| `Missions/23_Campaign_Cain.conf` | `{5D71F496D28056E0}worlds/MP/CTI_Campaign_Cain.ent` | `Conflict - Kolguyev` |
| `Missions/23_Campaign_Arland.conf` | `{DC924A8DDECC73AD}worlds/MP/CTI_Campaign_Arland.ent` | `#AR-MainMenu_ConflictArland_Name` |

> These `World` values were re-read with [`tools/pak.mjs`](../../tools/pak.mjs) from the installed
> **1.8.0.13** archive, and each was confirmed independently against `resourceDatabase.rdb`,
> which maps the same path to the same GUID.
>
> **What was published here before was wrong, and the reason matters.** The table used to give
> `{F2F3CFB83D44833C}worlds/CapeMaster/GM_Cain.ent` for `27_GM_Cain.conf`,
> `{DC924A8DDECC73AD}worlds/MP/CTI_Campaign_Eden.ent` for `23_Campaign.conf`,
> `{5D71F496D28056E0}worlds/MP/CTI_Campaign_Arland.ent` for `23_Campaign_Arland.conf`, and
> called `23_Campaign_Cain.conf` unreadable. Those GUIDs are **the ones of the entry stored
> after the file being read**: the reader of the time measured entry offsets from the DATA chunk
> body instead of from the start of the file, so every extract began 56 bytes too late, the lost
> head was prepended from the neighbour's first bytes, and the result was a plausible file whose
> `World` line was stitched together from two different files
> (`{77C41EA429B6AC35}worlds/GameMaster/GM_Eden.ent` in §6 is the same artifact: that GUID
> belongs to `GM_Arland.ent`). `23_Campaign_Cain.conf` happened to be followed by a *compressed*
> entry, so there was no text to stitch in and the file was reported as unreadable at all.

Additionally: in `resourceDatabase.rdb` the Kolguyev terrain resources sit entirely under
`worlds/Cain/` (`Cain.ent`, `Cain.smap`, `Cain.smd`, `Cain.topo`, `Cain_SMD.conf`,
`EmptyCain.ent`). There is not a single occurrence of the word "Kolguyev" in the paths.

**What follows from this practically:**

- If you are looking for a scenario for Kolguyev — look at files with `Cain`, do not search for "Kolguyev".
  In the scenario table ([`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md))
  such a row reads `Conflict — Kolguyev (Cain)`: the display name, with the codename the GUID
  reference uses kept in parentheses.
- **`EmptyEden.ent` is an empty Everon**, `EmptyCain.ent` is an empty Kolguyev.
  Useful when creating a world sub-scene.
- In `game.scenarioId` and in paths the **codename** is always used. You do not specify the
  display name in any way — it is taken from the localization key in the `.conf` itself.

---

## 3. `SCR_MissionHeaderCampaign` — fields

The full list with the original default values and descriptions from the attributes.
`-1` in a description means "do not override, use the scenario value" —
this is a standard trick of this class.

**Base fields (inherited from `SCR_MissionHeader`):**

| Key | Type | Default | Description |
|---|---|---|---|
| `m_sName` | string | `""` | Mission name. Usually a string table key, for example `#AR-Campaign_ScenarioName_Everon`. |
| `m_sAuthor` | string | `""` | Mission author. |
| `m_sPath` | string | `""` | Path to the mission. |
| `m_sDescription` | string | `""` | Brief description of the mission's purpose. |
| `m_sDetails` | string | `""` | Detailed description of the mission (for example, rules). |
| `m_sIcon` | ResourceName | `{6CFADAEE9287D1D2}UI/Textures/WorldSelection/Default.edds` | Mission icon in the menu. |
| `m_sLoadingScreen` | ResourceName | `{C58FCC06AF13075B}UI/Textures/MissionLoadingScreens/placeholder_1.edds` | Mission loading screen. |
| `m_sPreviewImage` | ResourceName | `{C58FCC06AF13075B}UI/Textures/MissionLoadingScreens/placeholder_1.edds` | Mission preview. |
| `m_sGameMode` | string | `"Sandbox"` | Mission game mode. |
| `m_iPlayerCount` | int | `1` | Number of players for the mission. `IsMultiplayer()` depends on exactly this: the method returns `m_iPlayerCount > 1`. |
| `m_eSaveTypes` | `ESaveGameType` | `15` | Flags of allowed save types. If all types are off — the persistence system is disabled entirely. |
| `m_eEditableGameFlags` | `EGameFlags` | `0` | Which game flags are **allowed** to be changed. |
| `m_eDefaultGameFlags` | `EGameFlags` | `0` | Game flags **by default**. |
| `m_bShowInScenarioMenu` | bool | `1` | Show the scenario in the scenario menu. |
| `m_sBriefingConfig` | ResourceName | `""` | Briefing screen config (`.conf`). |
| `m_bOverrideScenarioTimeAndWeather` | bool | `0` | If the scenario allows it — its time of day and weather are taken from this header. **Requires `SCR_TimeAndWeatherHandlerComponent` on the game mode entity.** |
| `m_iStartingHours` | int | `8` | Starting hour of the day. Slider, range `0 23 1`. |
| `m_iStartingMinutes` | int | `0` | Starting minutes. Slider, range `0 59 1`. |
| `m_bRandomStartingDaytime` | bool | `0` | Random starting time of day. |
| `m_fDayTimeAcceleration` | float | `1` | Daytime acceleration (1 = 100 %, 2 = 200 %). Slider `0.1 12 0.1`. |
| `m_fNightTimeAcceleration` | float | `1` | Nighttime acceleration. Slider `0.1 12 0.1`. |
| `m_bRandomStartingWeather` | bool | `0` | Random starting weather. |
| `m_bRandomWeatherChanges` | bool | `0` | Weather can change as the game goes on. |
| `m_fXpMultiplier` | float | `1` | Multiplier for experience gained (if enabled in the game mode; 1 is standard). |
| `m_bMapMarkerEnableDeleteByAnyone` | bool | `""` (treated as false) | Can map markers be deleted by anyone, or only by the player who placed them, within the faction. |
| `m_iMapMarkerLimitPerPlayer` | int | `10` | How many map markers one player can have at a time. |
| `m_aFactionLimits` | array of `SCR_FactionLimit` | empty | Player limits per faction. |
| `m_bIsArmavisionAllowedInMP` | bool | `0` | Whether Armavision is allowed for players without elevated permissions in multiplayer. |
| `m_bLoadOnStart` | bool | — | (no description in the attributes) |
| `m_sOwner` | string | — | (no description in the attributes) |

**Fields of the campaign itself (`SCR_MissionHeaderCampaign`):**

| Key | Type | Default | Description |
|---|---|---|---|
| `m_iControlPointsCap` | int | `-1` | How many control points a faction must hold to win. `-1` means **the world's value**, the game mode entity's `m_iControlPointsThreshold` (vanilla Conflict: `5` on Eden and Cain, `3` on Montignac, `2` on Arland) — not that field's class default. A round with fewer control points than this number cannot be won; see §3.4.8. |
| `m_fVictoryTimeout` | float | `-1` | How many seconds the faction must hold the points (override, `-1` — default). |
| `m_iStartingHQSupplies` | int | `-1` | Starting supply stock of the main HQ (override, `-1` — default). |
| `m_iMinimumBaseSupplies` | int | `-1` | Minimum starting supply stock at small bases. |
| `m_iMaximumBaseSupplies` | int | `-1` | Maximum starting supply stock at small bases. |
| `m_bCustomBaseWhitelist` | bool | `0` | Use the custom base list as a whitelist instead of a blacklist. |
| `m_bIgnoreMinimumVehicleRank` | bool | `0` | Disable rank requirements for spawning vehicles. |
| `m_fSupplyOffloadAssistanceReward` | float | `-1` | Share of experience given to players for unloading supplies they did not load themselves. Range `-1 inf`. |
| `m_aCampaignCustomBaseList` | array of `SCR_CampaignCustomBase` | empty | Custom base list. Broken down in §3.4. |
| `m_bCommanderRoleEnabled` | bool | `0` | A player can voluntarily take the commander role. |
| `m_bEstablishingBasesEnabled` | bool | `0` | Players can build bases. If off — the game starts with already existing FOBs. |
| `m_bSuppliesAutoRegenerationEnabled` | bool | `1` | FOBs automatically regenerate supplies. |
| `m_bSpawnRandomCaches` | bool | `0` | Random caches spawn on the map. |
| `m_iContestingCharactersNeeded` | int | `3` | How many characters a base needs before it starts contesting. `-1` disables contesting entirely. |
| `m_bRandomSpawnpointsEnabled` | bool | `0` | Randomized spawn points are allowed. |
| `m_bINDFORCanSpawnOnBases` | bool | `1` | INDFOR players can spawn on bases at the start of the game. |
| `m_bINDFORCanSpawnOnDistantBases` | bool | `0` | INDFOR players can spawn on distant bases at the start of the game. |
| `m_eStartingRank` | `SCR_ECharacterRank` | `1` (`PRIVATE`) | The rank at which all players start the match. Dropdown over `SCR_ECharacterRank`; numeric values are in §3.2. |

### 3.0 ⚠️ Default values depend on the game mode

**The "Default" column in all tables of this document is the value of the class attribute,
not what actually applies on your server.** Do not rely on it as
"current behavior": it can differ for three independent reasons.

**1. Different scenarios use different header classes.** The set of fields and their defaults
are determined by the class, and the class is set by the scenario (see §2). `SCR_MissionHeaderCampaign`
**inherits** `SCR_MissionHeader` and merely adds its own fields, so some fields
are not available in all modes:

| Field | Declared in | Attribute default |
|---|---|---|
| `m_iPlayerCount` | `SCR_MissionHeader` (base) | `"1"` |
| `m_iStartingHours` | `SCR_MissionHeader` (base) | `"8"` |
| `m_iStartingHQSupplies` | only `SCR_MissionHeaderCampaign` | `"-1"` |
| `m_eStartingRank` | only `SCR_MissionHeaderCampaign` | `SCR_ECharacterRank.PRIVATE` (that is, `1`) |
| `m_bCommanderRoleEnabled` | only `SCR_MissionHeaderCampaign` | `"0"` |

That is, a "default" without specifying the mode is an incomplete quantity: on Game Master the fields
`m_iStartingHQSupplies`, `m_eStartingRank` and the whole supply block simply do not exist,
and any key from there will be silently ignored.

**2. The scenario sets its own values on top of the class defaults.** An attribute default is
merely what is substituted if the field is not set at all. In the real `.conf`
of a scenario the fields are filled with concrete values, and those override the defaults.
A clear example from the vanilla `Missions/23_Campaign.conf`:
`m_eEditableGameFlags 6` and `m_eDefaultGameFlags 6`, whereas the attribute default is
`0` (§6). The same with `m_iPlayerCount`: the attribute says `1`, while the scenario sets `64`.

**3. The same class can behave differently in different modes.**
Part of the logic is enabled not by the value of a field but by the mode. For example
`ApplyHeaderSettings()` from §3.4 is called only for campaign bases: in Game Master
there are no campaign military bases as such, and the whole `m_aCampaignCustomBaseList`
list is meaningless there.

**What follows from this practically.** The defaults from the tables are good for one thing:
understanding *what will happen if the field is not specified*. If you need to know the current
value — look at the `.conf` of the specific scenario, not at this document.
And conversely: if a field is specified in `missionHeader`, it overrides both the class default
and the value from the scenario.

### 3.1 Nested types

**`EGameFlags`** — a bitmask (`scripts/Game/game.c`):

| Member | Value | Meaning |
|---|---|---|
| `Metabolism` | 1 | Metabolism system |
| `SpawnVehicles` | 2 | Vehicle spawning |
| `SpawnAI` | 4 | AI spawning |

The value `m_eDefaultGameFlags 6` = `2 | 4` = `SpawnVehicles + SpawnAI`.
This is exactly what is set in `Missions/23_Campaign.conf`.
The flags are applied in `ArmaReforgerScripted.OnMissionSet()`:
`m_eDefaultGameFlags` is taken and passed to `SetGameFlags(...)`.

**`ESaveGameType`** — a bitmask of save types:

| Member | Meaning |
|---|---|
| `MANUAL` | Save on the player's initiative |
| `AUTO` | Automatic (usually periodic) |
| `SCRIPTED` | On a script event (for example, checkpoints) |
| `SHUTDOWN` | Exit to the main menu / graceful shutdown |

The default value in `SCR_MissionHeader` is `15`, that is, all four types.
It is applied in `OnMissionSet()` as well: `GetSaveGameManager().SetEnabledSaveTypes(...)`.

**`SCR_FactionLimit`** — an element of the `m_aFactionLimits` array:

| Key | Type | Default | Description |
|---|---|---|---|
| `m_sFactionKey` | FactionKey | `""` | Faction key or ID; in vanilla — `US`, `USSR`, `FIA`. |
| `m_iFactionLimit` | int | `-1` | Player limit for the faction; `-1` — no limit. Slider `-1 inf`. |

In JSON it looks like this:

```json
"m_aFactionLimits": [
  { "m_sFactionKey": "US", "m_iFactionLimit": 32 },
  { "m_sFactionKey": "USSR", "m_iFactionLimit": 32 },
  { "m_sFactionKey": "FIA", "m_iFactionLimit": 32 }
]
```

The keys are not fixed by the header. They must match the factions the scenario's faction
manager registers — the `Configs/Factions/*.conf` files instantiated by the world's
`.../FactionManager*.et` prefab (for example
`Prefabs/MP/Campaign/CampaignFactionManager.et` pulls in `US_Campaign.conf`,
`USSR_Campaign.conf` and `FIA_Campaign.conf`) — so a mod faction brings its own key.

For `FIA` vanilla itself uses this entry as an on/off switch. In
`Missions/23_Campaign_Montignac.conf` (Conflict — Montignac) and
`Missions/23_Campaign_Western.conf` (Conflict — Western Everon) the header carries exactly
one limit:

```
m_aFactionLimits {
 SCR_FactionLimit "{693688C8C127D685}" {
  m_sFactionKey "FIA"
  m_iFactionLimit 0
 }
}
```

In `missionHeader` that is `{ "m_sFactionKey": "FIA", "m_iFactionLimit": 0 }`. Since only
`-1` means "no limit" (see the table above), `0` leaves the faction without players — which
is how those two scenarios keep `FIA` out. Both `.conf` files were extracted from
`data007.pak`.

A faction that is **not** listed is not limited at all — the same as `-1`. The map is built only
from the entries that are present: `GetFactionLimitMap()` inserts each listed key and skips an
entry whose `m_sFactionKey` is empty, so a faction with no entry has no limit to apply. Vanilla
leans on exactly that: in the two scenarios above `US` and `USSR` are absent from the array while
it is those two that are played there, and the one faction vanilla wants out is the one it names.
The keys are not validated against anything either, so a typo stays in the map, matches no faction
and does nothing. The method also `Print`s each key while it builds the map, so the server log
shows exactly the entries the header contributed — `string m_sFactionKey = 'FIA'` in the
single-entry case. What the game does when a listed faction is full was not traced — see §8.

### 3.2 `SCR_ECharacterRank` — numeric values

The enum is declared **at the end** of `scripts/Game/Ranks/SCR_RankInfo.c` (not in a separate file —
which is why it is not in the resource list either). The members have no explicit values,
so the numbering is sequential from zero:

> **The numbers below are a property of the language, not of the game mode, and in that they are reliable.**
> The values `0..19` are the same in any mode; only *which ranks are
> defined* for the faction and *which rank players start at* changes. Details are in §3.0
> and §3.3.

| Value | Member | Note |
|---:|---|---|
| 0 | `RENEGADE` | Penalty rank. Marked `m_bIsRenegade 1`; the logic of `SCR_CharacterRankComponent.SpecialRankHandling()` at this rank moves the player into the "hidden" faction RNGD, and on return — back to INDFOR. |
| 1 | `PRIVATE` | **Default value** (`m_eStartingRank` = `SCR_ECharacterRank.PRIVATE`, `SCR_CharacterRankComponent.m_iRank` defvalue `"1"`). |
| 2 | `CORPORAL` | |
| 3 | `SERGEANT` | |
| 4 | `LIEUTENANT` | |
| 5 | `CAPTAIN` | |
| 6 | `MAJOR` | This is exactly the value that was set in the verified working server config. |
| 7 | `COLONEL` | |
| 8 | `GENERAL` | |
| 9 | `CUSTOM1` | Free ranks for mods and custom factions. |
| 10 | `CUSTOM2` | |
| 11 | `CUSTOM3` | |
| 12 | `CUSTOM4` | |
| 13 | `CUSTOM5` | |
| 14 | `CUSTOM6` | |
| 15 | `CUSTOM7` | |
| 16 | `CUSTOM8` | |
| 17 | `CUSTOM9` | |
| 18 | `CUSTOM10` | **Maximum allowed value** for replication. |
| 19 | `INVALID` | Sentinel. **Must not be used as `m_eStartingRank`.** |

**Proof that the numbering is exactly this.** In
`SCR_CharacterRankComponent.RplSave()` / `RplLoad()` there is:

```c
writer.WriteIntRange(m_iRank, 0, SCR_ECharacterRank.INVALID - 1);
reader.ReadIntRange(m_iRank, 0, SCR_ECharacterRank.INVALID - 1);
```

The network range `0..INVALID-1` only makes sense if `INVALID` is the last member,
that is 19, and there are exactly 19 meaningful values (0–18). This matches the number of members above.

Additionally the default value checks out: `SCR_CharacterRankComponent.m_iRank`
is declared as `[Attribute(defvalue: "1", ...)]`, and in the comment on the field
`SCR_CharacterRankComponent.GetCharacterRank` the default is called `PRIVATE`.
`1` → `PRIVATE` ✓.

> **Practical recommendation: use numbers.** The verified working config
> contained `"m_eStartingRank": 6`, and the server passed schema validation. Symbolic names
> (`"MAJOR"`) are used in scenario `.conf` files (for example,
> `m_iRank RENEGADE` in `Configs/Ranks/NonCombatantRanks.conf`), but for the JSON field
> `missionHeader` this variant was **not tested**.

### 3.3 Important caveat: the rank must exist on the faction

`SCR_ECharacterRank` is only an identifier. The name, insignia and experience threshold
are set **separately for each faction** via the `SCR_RankContainer` config
(`Configs/Ranks/*.conf`), which contains an array of `SCR_RankInfo`.

> **This is the main source of divergence between the defaults of different modes** (see §3.0).
> The same number means a different rank in different factions and modes. Vanilla
> contains at least three different containers: `Configs/Ranks/BaseMilitaryRanks.conf`
> (military), `FIAMilitaryRanks.conf` (FIA) and `NonCombatantRanks.conf` (non-combatants).
> In the last one, for example, the value `1` is described not as `PRIVATE` but as
> `#AR-Rank_Volunteer` — a different name, a different insignia (`AR_Rank_OR-2`)
> and a different experience threshold (`-100`). So "default `1` = PRIVATE" is true only
> for those factions where the rank container defines `1` as exactly `PRIVATE`.

Fields of a single `SCR_RankInfo` (the base class, from
`scripts/Game/Ranks/SCR_RankInfo.c` in the pak):

| Field | Type | Default | Description |
|---|---|---|---|
| `m_iRank` | `SCR_ECharacterRank` | `1` | Rank ID from the table in §3.2. Omitted in a config entry it means `PRIVATE` (value `1`). |
| `m_bIsRenegade` | bool | `0` | Whether the rank counts as hostile to its own. |
| `m_iRequiredXP` | int | `100` | How much experience is needed for promotion to this rank. |
| `m_sRankName` | string | `""` | Rank name (usually a localization key). |
| `m_sRankNameUpper` | string | `""` | Name in uppercase. |
| `m_sRankNameShort` | string | `""` | Short name. |
| `m_sInsignia` | string | `""` | Name of the insignia quad in `MilitaryIcons.imageset`. |

All three vanilla containers use the subclass **`SCR_RankInfoCampaign`**, which adds four
fields (defined in `scripts/Game/GameMode/FactionManager/SCR_CampaignFactionManager.c`,
not in the `Ranks/` folder):

| Field | Type | Default | Description |
|---|---|---|---|
| `m_iRequestCD` | int | `10` | Seconds a player of this rank must wait between requests. The getter `GetRankRequestCooldown()` returns it in **milliseconds** (`m_iRequestCD * 1000`). |
| `m_iRadioRespawnCooldown` | int | `30` | Respawn timer when deploying on this unit while it carries a radio. |
| `m_iFastTravelCooldown` | int | `300` | Fast-travel cooldown. |
| `m_eRadioMsg` | `SCR_ERadioMsg` | `0` | Radio message sent on reaching this rank. |

The three containers, read in full from the installed **1.8.0.13** archive. The rank names
are localization keys; the IDs are from §3.2. **`m_iRequiredXP` is the threshold at which the
rank is granted**, and a container does not have to define every rank:

`Configs/Ranks/BaseMilitaryRanks.conf` (2496 B) — military ranks:

| `m_iRank` | Name key | `m_iRequiredXP` | `m_iRequestCD` / `m_iRadioRespawnCooldown` / `m_iFastTravelCooldown` |
|---|---|---:|---|
| `RENEGADE` (`m_bIsRenegade 1`) | `#AR-Rank_Renegade` | `-51` | 1200 / 600 / 3600 |
| *(absent → `PRIVATE`)* | `#AR-Rank_WestPrivate` | `-50` | 600 / 45 / 600 |
| `CORPORAL` | `#AR-Rank_WestCorporal` | `150` | 600 / 42 / 540 |
| `SERGEANT` | `#AR-Rank_WestSergeant` | `600` | 450 / 39 / 480 |
| `LIEUTENANT` | `#AR-Rank_WestLieutenant` | `1200` | 300 / 36 / 480 |
| `CAPTAIN` | `#AR-Rank_WestCaptain` | `2100` | 150 / 33 / 360 |
| `MAJOR` | `#AR-Rank_WestMajor` | `3300` | 5 / — / — |

`Configs/Ranks/FIAMilitaryRanks.conf` (1210 B) — the FIA, four ranks only:

| `m_iRank` | Name key | `m_iRequiredXP` | Cooldowns |
|---|---|---:|---|
| `RENEGADE` (`m_bIsRenegade 1`) | `#AR-Rank_Renegade` | `-21` | 1200 / 600 / 3600 |
| *(absent → `PRIVATE`)* | `#AR-Rank_Volunteer` | `-20` | 600 / 45 / 600 |
| `CORPORAL` | `#AR-Rank_Partisan` | `550` | 450 / 39 / 480 |
| `MAJOR` | `#AR-Rank_WestCaptain` | `1100` | 150 / — / 350 |

> In the FIA container the `MAJOR` entry is named `#AR-Rank_WestCaptain` — the *Western*
> captain — and carries the insignia `AR_Rank_OF-5`. That is vanilla's own text, not a
> transcription error here. So an FIA player promoted to `MAJOR` is shown the Western
> captain's name.

`Configs/Ranks/NonCombatantRanks.conf` (518 B) — two ranks, no insignia names beyond the
renegade one:

| `m_iRank` | Name key | `m_iRequiredXP` | Cooldowns |
|---|---|---:|---|
| `RENEGADE` (`m_bIsRenegade 1`) | `#AR-Rank_Renegade` | `-101` | 1200 / 600 / 3600 |
| *(absent → `PRIVATE`)* | `#AR-Rank_Volunteer` | `-100` | 600 / 45 / 600 |

Two things follow from reading these three files in full:

1. **A negative `m_iRequiredXP` is normal.** For `RENEGADE` it is `-51`, `-21` or `-101`
   depending on the container, and the rank below it sits at one point more. That is how a
   rank ends up "below" any rank that can be reached by earning experience:
   `SCR_RankContainer.GetRankByXP()` picks the rank with the highest `m_iRequiredXP`
   that does not exceed the current experience.
2. **A container may omit ranks, and an omitted `m_iRank` means `PRIVATE`.** The FIA defines
   only four — `RENEGADE`, `PRIVATE`, `CORPORAL` and `MAJOR`; `SERGEANT`, `LIEUTENANT`,
   `CAPTAIN`, `COLONEL`, `GENERAL` and the ten `CUSTOM*` values are not defined there at all,
   so the effective ceiling on the FIA ladder is `MAJOR`. Only the containers above are shipped
   by vanilla — a mod that adds ranks has to ship its own `SCR_RankContainer`.

If the given `m_eStartingRank` is not defined in the rank container of your faction,
the code does not crash: `SCR_RankContainer.GetNextRank()` / `GetPreviousRank()` can look up the
nearest defined rank. But the player will see a rank other than the one you set.

### 3.4 `m_aCampaignCustomBaseList` — custom base list

The list **filters the bases the world already contains and, in whitelist mode, rewrites their
campaign flags.** It creates no base, moves none and renames none. It is read exactly once, at
start, by `SCR_GameModeCampaign.InitalBaseSetup()`, which is the only place in the vanilla scripts
that reads either of the two fields — verified on 1.8.0.13 with
[`tools/cscript.mjs`](../../tools/cscript.mjs) `refs InitalBaseSetup`: the symbol occurs in
`scripts/Game/GameMode/SCR_GameModeCampaign.c` and nowhere else, at line 615 (the definition) and
line 604 (the call from `Start()`, before any base is initialized).

#### 3.4.1 An entry: class `SCR_CampaignCustomBase`

The class is declared at the end of
`scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c` (line 2956 in 1.8.0.13) with
five `[Attribute]` fields — the defaults below are those attributes, not an inference:

| Key | Type | Default | What it does |
|---|---|---|---|
| `m_sBaseName` | string | `""` | **The base to match.** The attribute's description is "Base entity name as set up in World Editor" — see §3.4.2 for what that means and what it does *not*. |
| `m_bIsControlPoint` | bool | `0` | Whether the base counts as a control point. Victory depends on it: `SCR_CampaignMilitaryBaseManager.EvaluateControlPoints()` collects control points by exactly this flag. |
| `m_bCanBeHQ` | bool | `0` | Whether the base can be chosen as the faction's main base (HQ). |
| `m_bDisableWhenUnusedAsHQ` | bool | `1` | Whether to shut the base down when the faction moves its HQ elsewhere (§3.4.6). |
| `m_fRadioRange` | float, meters | `-1` | Radius of the base's own radio transceiver. The attribute says "Use -1 for default base setting", and the code treats a negative value as "do not touch" (§3.4.5). |

There are five fields and no others. **`m_bIsSupplyHub`, `m_eType` and the base's radius cannot be
changed through this list** — the class simply has no field for them.

#### 3.4.2 Matching uses the *entity name*

`InitalBaseSetup()` builds a plain array of the entries' `m_sBaseName` values and compares each base
of the world against it (lines 622–668, abridged — the comments are this document's):

```c
bool whitelist = false;
array<string> customBaseList = {};

SCR_MissionHeaderCampaign header = SCR_MissionHeaderCampaign.Cast(GetGame().GetMissionHeader());
if (header)
{
    whitelist = header.m_bCustomBaseWhitelist;
    foreach (SCR_CampaignCustomBase customBase : header.m_aCampaignCustomBaseList)
        customBaseList.Insert(customBase.GetBaseName());            // m_sBaseName of the entry
}

array<SCR_CampaignMilitaryBaseComponent> candidatesForHQ = {};
array<SCR_CampaignMilitaryBaseComponent> controlPoints = {};

foreach (SCR_MilitaryBaseComponent base : bases)                    // every base in the world
{
    SCR_CampaignMilitaryBaseComponent campaignBase = SCR_CampaignMilitaryBaseComponent.Cast(base);
    if (!campaignBase)
        continue;

    if (header)
    {
        const string baseName = campaignBase.GetOwner().GetName();   // the ENTITY's name
        const int listIndex = customBaseList.Find(baseName);         // first match wins

        if (listIndex != -1)
        {
            if (!whitelist)
                continue;                                            // blacklist: skip the base
        }
        else if (whitelist)
        {
            continue;                                                // whitelist: skip the base
        }

        if (whitelist && listIndex != -1)
            campaignBase.ApplyHeaderSettings(header.m_aCampaignCustomBaseList[listIndex]);
    }

    if (!campaignBase.CanBeHQ())
        campaignBase.Initialize();
    if (campaignBase.CanBeHQ())
        candidatesForHQ.Insert(campaignBase);
    if (campaignBase.IsControlPoint())
        controlPoints.Insert(campaignBase);
}
```

Four facts about the match, all of them from those lines:

1. **It is the entity name, not the display name.** The right-hand side is
   `GetOwner().GetName()`, the name the entity has in the World Editor — `TownBaseMeaux`,
   `MajorBaseMorton`, `StartingPos07`. The name the map shows ("Meaux", "Coastal Base Morton") is the
   component's separate, localized `m_sBaseName` string and plays no part in matching. Writing the
   display name into an entry therefore matches nothing, and nothing is logged when it happens.
2. **`array<string>.Find()` returns the first match**, so two entries with the same name mean the
   first one wins and the second is dead.
3. **A name that matches no base changes nothing**, silently — there is no log line for a list that
   misses. The only message this code writes is the HQ complaint of §3.4.4.
4. **The comparison is a plain string equality search.** Whether it is case-sensitive in this build
   was not established; every vanilla list uses the exact spelling of its world file, so copy the
   spelling rather than testing it.

The catalogue of every base in the vanilla worlds — entity name and display name in the same row —
is [the bases document](ArmaReforger_VanillaBases_EN.md), which is what these entries have to match.

#### 3.4.3 Whitelist and blacklist: what each one really does

`m_bCustomBaseWhitelist` decides the meaning of the whole array:

| `m_bCustomBaseWhitelist` | A base whose name **is** in the list | A base whose name is **not** in it |
|---|---|---|
| `false` (the default) — **blacklist** | **Skipped**: never initialized, not an HQ candidate, not a control point. **Its entry's other four fields are not read at all** — the `ApplyHeaderSettings()` call is behind `if (whitelist && …)` | Kept, with the flags the world gives it |
| `true` — **whitelist** | Kept, and **all four fields are copied out of the entry** over the base's own values | **Skipped**, exactly as a blacklisted base |

Two consequences follow that the attribute description ("use the custom base list as a whitelist
instead of a blacklist") does not suggest:

- **In blacklist mode an entry is only a name.** Setting `m_bIsControlPoint` or `m_fRadioRange` on a
  blacklisted base does nothing whatsoever, because the settings are applied only in whitelist mode.
  A blacklist is a list of bases to remove, and that is all it can be.
- **In whitelist mode an entry replaces, it does not merge.** All three booleans are assigned
  unconditionally, so a base whitelisted with a name only loses every flag the world gave it: it
  becomes a non-control-point that cannot be an HQ, with the radio range left alone (see §3.4.5).
  Whatever you want a whitelisted base to keep, write it in the entry.
- **The list decides how many control points exist, not how many are needed to win.** The number
  needed is `m_iControlPointsCap`, and at its default `-1` it stays whatever the world's game mode
  entity sets. A whitelist that keeps fewer control points than that number produces a round nobody
  can win; a blacklist that removes control points can do the same. See §3.4.8.

"Skipped" means skipped by this loop, which is the only loop that initializes bases at start: the
base stays registered with the base manager but is never initialized and never becomes a faction's
HQ or a control point. In practice it is inert for that round.

#### 3.4.4 At least two HQ candidates are required

Immediately after the loop (lines 680–684):

```c
if (candidatesForHQ.Count() < 2)
{
    Print("Not enough suitable starting locations found in current setup. Check 'Can Be HQ' attributes in SCR_CampaignMilitaryBaseComponent!", LogLevel.ERROR);
    return;
}
```

`return` exits `InitalBaseSetup()` before `SelectHQs()`, before any supply is set and before any base
is initialized — the world then starts with **no faction HQ at all**, and the only trace is that
error line. The set counted here is the bases that are left after filtering *and* that have
`m_bCanBeHQ` true *at that moment*, which in whitelist mode means the value your entries set.

So a whitelist needs **at least two entries with `m_bCanBeHQ: true`**. An empty array with
`m_bCustomBaseWhitelist: true` leaves zero candidates and hits the same branch. Every whitelist
vanilla ships marks two bases `m_bCanBeHQ 1` and `m_bDisableWhenUnusedAsHQ 0` for exactly this
reason; two shipped scenario files forget it and break the rule, which
[the bases document](ArmaReforger_VanillaBases_EN.md) §4.3 shows in full.

#### 3.4.5 What the copied flags do

```c
// SCR_CampaignMilitaryBaseComponent.ApplyHeaderSettings(), lines 664-693
void ApplyHeaderSettings(notnull SCR_CampaignCustomBase settings)
{
    m_bCanBeHQ               = settings.GetCanBeHQ();
    m_bDisableWhenUnusedAsHQ = settings.GetDisableWhenUnusedAsHQ();
    m_bIsControlPoint        = settings.IsControlPoint();

    SCR_CoverageRadioComponent coverageComp =
        SCR_CoverageRadioComponent.Cast(GetOwner().FindComponent(SCR_CoverageRadioComponent));
    if (coverageComp)
        coverageComp.SetIsSource(m_bCanBeHQ);        // an HQ-capable base is a radio source

    float radioRange = settings.GetRadioRange();
    if (radioRange < 0)
        return;                                       // negative radius = leave the radio alone

    BaseRadioComponent radio = BaseRadioComponent.Cast(GetOwner().FindComponent(BaseRadioComponent));
    if (!radio)
        return;

    BaseTransceiver transceiver = radio.GetTransceiver(0);
    if (!transceiver)
        return;

    m_fRadioRangeDefault = radioRange;
    transceiver.SetRange(radioRange);
    RecalculateRadioRange();
}
```

What follows from it practically:

1. **`m_sBaseName` is not used here.** It was needed only to find the base; the base's own display
   name is never rewritten by the list.
2. **`m_bCanBeHQ` controls more than the choice of HQ.** It also makes the base a *source* of radio
   coverage (`SetIsSource`), which is why a former HQ that keeps the flag keeps the coverage.
3. **`m_fRadioRange` sets only the base radius.** `RecalculateRadioRange()` afterwards raises it to
   the largest radius among the antennas built at the base (`SCR_EServicePointType.RADIO_ANTENNA`), so
   an antenna can increase the range but not reduce it below what you set.
4. **A negative `m_fRadioRange` still applies the three booleans** — the early `return` sits after
   their assignment. `-1` therefore means "flags yes, radio untouched", which is the usual choice.
5. **The radio is only reached if the base has the components.** A base without
   `BaseRadioComponent` or without transceiver 0 silently keeps its range; the flags are applied
   first, so this never blocks them.

#### 3.4.6 `m_bDisableWhenUnusedAsHQ`

The flag is read in `SetAsHQ()` (lines 1015–1035): when a base becomes the main one, the previous
main base of the same faction is checked, and if it has the flag — it is disabled.

```c
if (m_bIsHQ)
{
    SCR_CampaignFaction faction = GetCampaignFaction();
    SCR_CampaignMilitaryBaseComponent previousHQ = faction.GetMainBase();
    SCR_CampaignMilitaryBaseComponent enemyHQ = …GetEnemyFaction(faction).GetMainBase();
    if (previousHQ && previousHQ != this && previousHQ != enemyHQ)
    {
        if (previousHQ.GetDisableWhenUnusedAsHQ())
            previousHQ.Disable();
    }
}
```

`Disable()` cuts power to the radio component, removes the starting vehicles, removes the faction
binding and deletes the built base composition. So `false` here means "keep the former main base
alive", and `true` (the default) — "shut it down". Note that the enemy HQ is never disabled by this
path, whatever its flag says.

#### 3.4.7 Where the list does nothing

| Situation | Why nothing happens |
|---|---|
| The scenario's `.conf` does not start with `SCR_MissionHeaderCampaign` (or a subclass) — Game Master, Training, all Capture & Hold scenarios | The two keys exist on `SCR_MissionHeaderCampaign` only. `InitalBaseSetup()` reads them through `SCR_MissionHeaderCampaign.Cast()`, and when the cast fails the whole `if (header)` block is skipped: no filtering, no settings, no message. |
| The scenario's game mode is not `SCR_GameModeCampaign` — Combat Ops worlds instantiate `SCR_BaseGameMode`, Game Master uses `SCR_GameModeEditor` | `InitalBaseSetup()` is only ever called from `SCR_GameModeCampaign.Start()`; no other class references it. |
| The world has no bases — Combat Ops, Game Master, Capture & Hold, Training, the single-player scenarios | There is nothing to match; the 32 worlds of those scenarios were read and none carries the component — [the bases document](ArmaReforger_VanillaBases_EN.md) §1. |
| The name belongs to a base with no entity name | `GetName()` is the empty string for it, so no entry but `""` can match. 29 of the 168 vanilla bases are in that state. |
| A typo in `m_sBaseName` | `Find()` returns `-1`, the entry is simply never applied. No log line, no warning. |

#### 3.4.8 Examples

A **blacklist** — the small change most servers actually want: take the four coastal/town bases out
of the round and touch nothing else. In blacklist mode the entries need nothing but names.

```json
"missionHeader": {
  "m_bCustomBaseWhitelist": false,
  "m_aCampaignCustomBaseList": [
    { "m_sBaseName": "MajorBaseMorton" },
    { "m_sBaseName": "MajorBaseLamentin" },
    { "m_sBaseName": "TownBaseMeaux" }
  ]
}
```

A **whitelist** — a small round on Everon: two movable HQs, one control point, one ordinary base.
Every flag the bases should keep is written out, because the entries replace them. All four names are
rows of the Everon catalogue in [the bases document](ArmaReforger_VanillaBases_EN.md) §3.1, and the
two-HQ rule of §3.4.4 is satisfied by the first two entries. **`m_iControlPointsCap: 1` is part of
the example, not decoration:** the whitelist leaves exactly one control point in the round, while the
Everon world asks for five — the note after the example shows why that combination has no winner.

```json
"missionHeader": {
  "m_bCustomBaseWhitelist": true,
  "m_iControlPointsCap": 1,
  "m_aCampaignCustomBaseList": [
    {
      "m_sBaseName": "MainBaseNorth",
      "m_bCanBeHQ": true,
      "m_bDisableWhenUnusedAsHQ": false,
      "m_fRadioRange": 2000
    },
    {
      "m_sBaseName": "MainBaseSouth",
      "m_bCanBeHQ": true,
      "m_bDisableWhenUnusedAsHQ": false,
      "m_fRadioRange": 2000
    },
    {
      "m_sBaseName": "MilitaryHospital",
      "m_bIsControlPoint": true
    },
    {
      "m_sBaseName": "TownBaseMeaux",
      "m_fRadioRange": -1
    }
  ]
}
```

> Both examples are shaped after the lists vanilla itself ships — same key names, same
> `m_fRadioRange 2000` on the HQs — and their names were checked against the installed world in the
> bases catalogue. They have not been run on a server from this repository; the names are what is
> verified, not the resulting game.

> **Why the whitelist needs the cap.** `SCR_CampaignMilitaryBaseManager.EvaluateControlPoints()`
> starts a faction's victory timer only when `controlPointsHeld >= m_Campaign.GetControlPointTreshold()`
> (`SCR_CampaignMilitaryBaseManager.c:843` in 1.8.0.13). Holding *every* control point of a round
> that has fewer of them than the threshold never satisfies that comparison: `SetVictoryTimestamp` is
> never set and the round has no winner — no message, no error. The threshold is not the header
> default: `SCR_GameModeCampaign` only overwrites `m_iControlPointsThreshold` when
> `m_iControlPointsCap != -1` (`SCR_GameModeCampaign.c:1892`), so at `-1` the value on the game mode
> entity in the world stands — measured in 1.8.0.13, Vanilla Eden and Cain set `5`, Montignac `3`,
> Arland `2`, and the prefab all of them are built from,
> `Prefabs/MP/Modes/Conflict/GameMode_Campaign.et`, itself carries `4`. So the value in force is
> whatever the world and its prefab chain say, never a fixed number. The whitelist above leaves one
> control point (the two `MainBase*` entries no longer carry `m_bIsControlPoint`), so
> `m_iControlPointsCap: 1` is what makes it winnable; with `-1` the world's `5` stays and nobody can
> win.
>
> **A blacklist lowers the count just as surely.** The blacklist above removes `MajorBaseMorton` and
> `MajorBaseLamentin`, which are both control points in Vanilla Eden: 7 become 5, exactly the
> threshold, so the default still works — but remove one more control point and the round becomes
> unwinnable too. Whatever the mode, set `m_iControlPointsCap` to the number of control points that
> actually survive the list.

---

## 4. What is carried over into `missionHeader` and what is not

| Field from the scenario `.conf` | Can it be set in `missionHeader` | Why |
|---|---|---|
| `World` | **no** | This is a property of the engine class `MissionHeader`, read-only from script. The world is determined by the scenario itself. |
| `SystemsConfig` | **no** | Same — it is read by the method `GetWorldSystemsConfig()`. |
| `m_sName`, `m_sAuthor`, `m_sDescription`, `m_sDetails` | yes | Ordinary string attributes. |
| `m_sIcon`, `m_sLoadingScreen`, `m_sPreviewImage`, `m_sBriefingConfig` | yes | `ResourceName`; in JSON — a string with a GUID-qualified path. |
| `m_sGameMode` | yes | String. |
| `m_iPlayerCount` | yes | int. |
| `m_eEditableGameFlags`, `m_eDefaultGameFlags` | yes | int bitmask. |
| `m_eSaveTypes` | yes | int bitmask. |
| all `m_b*` | yes | bool. In JSON — `true`/`false`, in `.conf` — `1`/`0`. |
| all `m_i*`, `m_f*` | yes | int / float. |
| `m_aFactionLimits` | yes | Array of objects. |
| `m_aCampaignCustomBaseList` | yes | Array of objects. |

> **Important about boolean values.** In scenario `.conf` files boolean fields are written as `0`/`1`
> (`m_bSpawnRandomCaches 1`). In `server.json` this is JSON, so write `true`/`false`.
> If the log shows `Parameter 'm_bSpawnRandomCaches' is not supported type!` —
> the type did not match.

---

## 5. Working examples

### 5.1 Full `missionHeader` for Conflict

Verified on a real dedicated server (build 1.8.0.13) — the config passes
schema validation (`JSON is Valid`).

```json
"gameProperties": {
  "missionHeader": {
    "m_iStartingHQSupplies": 10000,
    "m_bRandomStartingDaytime": false,
    "m_iStartingHours": 1,
    "m_iStartingMinutes": 0,
    "m_bOverrideScenarioTimeAndWeather": true,
    "m_fXpMultiplier": 20.0,
    "m_eStartingRank": 6
  }
}
```

### 5.2 Minimal meaningful set

If you just want to pin the time of day and boost experience, this is enough:

```json
"missionHeader": {
  "m_iStartingHours": 12,
  "m_iStartingMinutes": 30,
  "m_bOverrideScenarioTimeAndWeather": true,
  "m_fXpMultiplier": 2.0
}
```

> `m_bOverrideScenarioTimeAndWeather` is not decorative here. Its default is `0`, and at `0` the
> time and weather come from the scenario, so `m_iStartingHours`/`m_iStartingMinutes` change
> nothing — silently, because a `missionHeader` writes to the log only on error (§7). The override
> additionally needs `SCR_TimeAndWeatherHandlerComponent` on the game mode entity (field table, §3).

### 5.3 Full example with all campaign keys

```json
"missionHeader": {
  "m_sName": "Conflict — Everon (custom)",
  "m_sAuthor": "My Community",
  "m_sDescription": "Capturing points with double XP",
  "m_iPlayerCount": 48,
  "m_eSaveTypes": 15,
  "m_eEditableGameFlags": 6,
  "m_eDefaultGameFlags": 6,
  "m_iStartingHours": 9,
  "m_iStartingMinutes": 0,
  "m_bOverrideScenarioTimeAndWeather": true,
  "m_bRandomStartingDaytime": false,
  "m_fDayTimeAcceleration": 2.0,
  "m_fNightTimeAcceleration": 4.0,
  "m_bRandomStartingWeather": true,
  "m_bRandomWeatherChanges": true,
  "m_fXpMultiplier": 3.0,
  "m_iMapMarkerLimitPerPlayer": 20,
  "m_iControlPointsCap": 5,
  "m_fVictoryTimeout": 300.0,
  "m_iStartingHQSupplies": 15000,
  "m_iMinimumBaseSupplies": 500,
  "m_iMaximumBaseSupplies": 3000,
  "m_bCustomBaseWhitelist": false,
  "m_aCampaignCustomBaseList": [
    {
      "m_sBaseName": "Morton",
      "m_bIsControlPoint": true,
      "m_bCanBeHQ": true,
      "m_bDisableWhenUnusedAsHQ": true,
      "m_fRadioRange": 3000
    }
  ],
  "m_bIgnoreMinimumVehicleRank": true,
  "m_bCommanderRoleEnabled": true,
  "m_bEstablishingBasesEnabled": true,
  "m_bSuppliesAutoRegenerationEnabled": true,
  "m_bSpawnRandomCaches": true,
  "m_iContestingCharactersNeeded": 3,
  "m_bRandomSpawnpointsEnabled": true,
  "m_bINDFORCanSpawnOnBases": true,
  "m_bINDFORCanSpawnOnDistantBases": false,
  "m_eStartingRank": 2,
  "m_aFactionLimits": [
    { "m_sFactionKey": "US", "m_iFactionLimit": 24 },
    { "m_sFactionKey": "USSR", "m_iFactionLimit": 24 }
  ]
}
```

> `m_eStartingRank: 2` here is `CORPORAL` (see §3.2). Values above `18`
> (`CUSTOM10`) must not be used: the network range is limited to `INVALID-1`.
> Set a number from `0` to `18`; `1` is `PRIVATE`, that is, vanilla behavior.

### 5.4 For Game Master (`SCR_MissionHeader`)

Only the base fields are available here — everything that relates to the campaign
(`m_iStartingHQSupplies`, `m_bCommanderRoleEnabled`, `m_eStartingRank`, etc.)
will be ignored. A sensible set:

```json
"missionHeader": {
  "m_sName": "#AR-Editor_Mission_GM_Eden_Name",
  "m_iStartingHours": 10,
  "m_iStartingMinutes": 0,
  "m_bOverrideScenarioTimeAndWeather": true,
  "m_bRandomStartingWeather": true,
  "m_fXpMultiplier": 1.0
}
```

---

## 6. What this looks like in the scenario file itself

For comparison — real vanilla `.conf` files extracted from `data007.pak`.
These are exactly the values that `missionHeader` overrides.

`Missions/23_Campaign.conf` (abridged, class `SCR_MissionHeaderCampaign`):

```
SCR_MissionHeaderCampaign {
 World "{9DF143A76F5C6460}worlds/MP/CTI_Campaign_Eden.ent"
 SystemsConfig "{7C9E720397CC6ACD}Configs/Systems/ConflictSystems.conf"
 m_sName "#AR-Campaign_ScenarioName_Everon"
 m_sAuthor "#AR-Author_BI"
 m_sDescription "#AR-Campaign_GamemodeDesc"
 m_sDetails "#AR-Campaign_Hint_Signal_Text"
 m_sIcon "{62897631F4A6C7F3}UI/Textures/MissionLoadingScreens/Reforger_ConflictArt_UI.edds"
 m_sLoadingScreen "{62897631F4A6C7F3}UI/Textures/MissionLoadingScreens/Reforger_ConflictArt_UI.edds"
 m_sPreviewImage "{818C80AD02C1007B}UI/Textures/MissionLoadingScreens/Reforger_ConflictIcon_UI.edds"
 m_sGameMode "#AR-Scenario_GameMode_Campaign"
 m_iPlayerCount 64
 m_eEditableGameFlags 6
 m_eDefaultGameFlags 6
 m_bSpawnRandomCaches 1
 m_bRandomSpawnpointsEnabled 1
}
```

`Missions/21_GM_Eden.conf` (class `SCR_MissionHeader`):

```
SCR_MissionHeader {
 World "{BEF094A5F7F3211B}worlds/GameMaster/GM_Eden.ent"
 SystemsConfig "{8DDC2A311929D52F}Configs/Systems/GameMasterSystems.conf"
 m_sName "#AR-Editor_Mission_GM_Eden_Name"
 m_sAuthor "#AR-Author_BI"
 m_sDescription "#AR-Editor_Mission_GM_Eden_Description"
 m_sIcon "{93E6EEDBCD12CA2F}UI/Textures/MissionLoadingScreens/GM_Eden.edds"
 m_sLoadingScreen "{93E6EEDBCD12CA2F}UI/Textures/MissionLoadingScreens/GM_Eden.edds"
 m_sPreviewImage "{5D519EE07DA1E306}UI/Textures/MissionThumbnails/GM_Eden.edds"
 m_sGameMode "#AR-Scenario_GameMode_GameMaster"
 m_iPlayerCount 64
}
```

Note: strings of the form `#AR-...` are localization table keys,
not literal text. In `missionHeader` you can write plain text as well.

---

## 7. Verification

1. Build the config and start the server.
2. Make sure the log contains `BACKEND : JSON is Valid`.
3. Search `console.log` for lines `Server Config MissionHeader:` — if they are present,
   the corresponding parameter was dropped, and its name will be in the text.
4. Check the behavior in game (time of day, starting rank, faction limits).
   `missionHeader` does not print any confirmation of application to the log — only errors.

---

## 8. Sources and boundaries of reliability

| What | From where |
|---|---|
| Fields of `SCR_MissionHeaderCampaign` and their attributes (default values, descriptions, slider ranges) | `scripts/Game/Mission/SCR_MissionHeaderCampaign.c`, read out of `addons/data/data007.pak` of the installed 1.8.0.13 build with [`tools/pak.mjs`](../../tools/pak.mjs) — the list was cross-checked against Arma Reforger Explorer 1.7.0.54, which is where it came from before this build was available |
| Fields of `SCR_MissionHeader` and the methods `IsMultiplayer()` / `GetFactionLimitMap()` | `scripts/Game/Mission/SCR_MissionHeader.c`, same archive and reader |
| Composition of the base class `MissionHeader` and the fact that `World`/`SystemsConfig` are read-only | `scripts/Game/generated/Mission/MissionHeader.c` (the file was pulled straight out of `data007.pak`, it reads without compression) |
| `EGameFlags` (`Metabolism=1`, `SpawnVehicles=2`, `SpawnAI=4`), the application of flags and save types in `OnMissionSet()` | `scripts/Game/game.c`, lines 16–22 and 258–273 |
| `ESaveGameType` (`MANUAL`, `AUTO`, `SCRIPTED`, `SHUTDOWN`) | `scripts/Game/generated/Plugins/Persistence/SaveGame/ESaveGameType.c` |
| Structure of `SCR_FactionLimit` (`m_sFactionKey`, `m_iFactionLimit`) | `scripts/Game/Mission/SCR_FactionLimit.c` |
| **Numeric values of `SCR_ECharacterRank`** (20 members, `INVALID = 19`) | The enum declaration at the end of `scripts/Game/Ranks/SCR_RankInfo.c` in the 1.8.0.13 archive. Confirmed by two independent checks: the replication range `0..INVALID-1` in `SCR_CharacterRankComponent.RplSave/RplLoad` and the default `defvalue: "1"` = `PRIVATE` |
| Fields of `SCR_RankInfo`, the logic of `SCR_RankContainer` (`GetRankByXP`, `GetNextRank`, `GetPreviousRank`) | Sources `scripts/Game/Ranks/SCR_RankInfo.c` and `scripts/Game/Ranks/SCR_RankContainer.c` |
| Fields of `SCR_CampaignCustomBase` (names, types, attribute defaults, the "Base entity name as set up in World Editor" description, getters) | `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`, lines 2956–3009 of the installed 1.8.0.13 archive, read with [`tools/cscript.mjs`](../../tools/cscript.mjs). This replaces the Bohemia API documentation used before this build: the class is in the archive, so its defaults are no longer inferred from the component it is copied into |
| Behaviour of `ApplyHeaderSettings`, `SetAsHQ`, `Disable`, `RecalculateRadioRange` | `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`, lines 664–693, 1015–1035 and the surrounding methods, same archive |
| The matching loop, the whitelist/blacklist branches and the two-HQ requirement | `scripts/Game/GameMode/SCR_GameModeCampaign.c`, `InitalBaseSetup()`, lines 615–734, same archive; `refs InitalBaseSetup` shows it is called from one place only |
| Default values of `m_bIsControlPoint` (`"0"`), `m_bCanBeHQ` (`"0"`), `m_bDisableWhenUnusedAsHQ` (`"1"`), `m_fRadioRange` (`"-1"`) | The `[Attribute]` decorators of the same fields in `SCR_CampaignMilitaryBaseComponent.c` (lines 39–58) and in `SCR_CampaignCustomBase` (lines 2959–2972) |
| Which base each `m_sBaseName` refers to, per world | [the bases catalogue](ArmaReforger_VanillaBases_EN.md) and [`tools/ebin.mjs`](../../tools/ebin.mjs) |
| Real values in scenarios | `Missions/23_Campaign.conf`, `Missions/21_GM_Eden.conf`, extracted from `data007.pak` with `tools/pak.mjs` (the `World` GUIDs re-read from the installed 1.8.0.13 archive and cross-checked against `resourceDatabase.rdb`, see §2.1) |
| The vanilla `m_sFactionKey` for FIA (`"FIA"`) and the fact that vanilla closes that faction with `m_iFactionLimit 0` | `Missions/23_Campaign_Montignac.conf` and `Missions/23_Campaign_Western.conf`, read in full from `data007.pak` with `tools/pak.mjs` — header line included. Cross-check that the key belongs to a registered faction: `Prefabs/MP/Campaign/CampaignFactionManager.et` instantiates `Configs/Factions/FIA_Campaign.conf`. **The reading of `0` as "no players" is deduced from `-1` being "no limit"** — it was not verified by running the server |
| What happens to a faction that is absent from `m_aFactionLimits` — no limit, the same as `-1` | The body of `GetFactionLimitMap()` in `scripts/Game/Mission/SCR_MissionHeader.c` (only the listed keys are inserted, an empty key is skipped) and vanilla's own array contents in `Missions/23_Campaign_Montignac.conf` / `23_Campaign_Western.conf`, where `US` and `USSR` are absent although they are the playable sides there. The consumer is `SCR_FactionManager.EOnInit()`, whose `SetPlayerLimit()` call is gated on `playerTotalLimit >= 0`. The step from "no entry" to "no limit" is still a **reading of the code and of that usage, not behaviour observed in game**. The meaning of `0` and `-1` is also stated by the third-party guide [Arma Reforger Conflict server settings](https://loafhosts.com/guides/arma-reforger-conflict-server-settings) (checked on 1.8.0.13) |
| Example format of a rank config, the experience thresholds of all three vanilla containers, and the fields of `SCR_RankInfoCampaign` | `Configs/Ranks/BaseMilitaryRanks.conf`, `FIAMilitaryRanks.conf`, `NonCombatantRanks.conf` and `scripts/Game/GameMode/FactionManager/SCR_CampaignFactionManager.c`, read from the installed 1.8.0.13 archive with `tools/pak.mjs` (see §3.3) |
| Confirmation of the field names of `m_aCampaignCustomBaseList` and of the fact that `m_fRadioRange` is in meters | Third-party guide [Arma Reforger Conflict server settings](https://loafhosts.com/guides/arma-reforger-conflict-server-settings) (checked on 1.8.0.13). Used only as a cross-check; everything else in §3.4 is from the code |
| Format of the errors `Server Config MissionHeader: ...` | Strings of `ArmaReforgerServer.exe` build 1.8.0.13 |

### What this document does not contain

- **Fields of `SCR_MissionHeaderCombatOps` and `SCR_MissionHeaderScenarioFramework`.**
  The second adds scenario framework fields (`m_iMaxNumberOfTasks`, `m_aTaskTypesAvailable`,
  `m_aDebugAreas`, `m_iDynamicDespawn`, `m_iUpdateRate`, `m_aFactionAliases` and others), and the
  first is its subclass, not its sibling. They relate to specific Combat Ops scenarios and were not
  analyzed here.
- **Behaviour, as opposed to data, of the base list.** §3.4 explains what the code does with
  `m_aCampaignCustomBaseList`; nothing here was watched on a running server — no list has been
  applied to a live Conflict round from this repository. The names it has to match are in
  [the bases catalogue](ArmaReforger_VanillaBases_EN.md), and those are derived mechanically.
- **Who consumes `GetFactionLimitMap()`, and what the game does once a listed faction is full.**
  Now answered from the source, which *is* readable: `scripts/Game/GameMode/FactionManager/SCR_FactionManager.c`.
  In `EOnInit()`, server side, the manager builds two maps — `missionHeader.GetFactionLimitMap()`
  and `GetFactionLimitMapCLI()` — and for each faction takes

  ```c
  playerMissionLimit = missionFactionLimitMap.Get(scriptedFactionKey);   // absent -> -1
  if (cliFactionLimitMap.Contains(scriptedFactionKey))
      playerTotalLimit = playerMissionLimit >= 0
          ? Math.Min(playerMissionLimit, cliFactionLimitMap.Get(scriptedFactionKey))
          : cliFactionLimitMap.Get(scriptedFactionKey);
  if (playerTotalLimit < 0 && playerMissionLimit >= 0)
      playerTotalLimit = playerMissionLimit;
  if (playerTotalLimit >= 0)
      scriptedFaction.SetPlayerLimit(playerTotalLimit);
  ```

  So the header's limit and the `-playerLimits` command-line limit are **combined by minimum**
  (the stricter of the two wins) and `SetPlayerLimit()` is called **only when the result is at
  least 0** — which is the code-level confirmation that `-1`/absent means "no call, no limit"
  and `0` means "a limit of zero". The in-game refusal at a full faction was still never
  observed, so §3.1 rests on the method bodies, on how vanilla itself fills the array, and on
  the third-party guide.

### How to obtain what is missing

Everything inside a `pak` is readable — this document's earlier claim that compressed `.c` and
`.conf` entries are encrypted came from a reader that measured offsets from the wrong base and
failed with `incorrect header check` on every compressed entry (see §2.1). Use
[`tools/pak.mjs`](../../tools/pak.mjs), which reads both storage forms and verifies its own
choice of offset base:

```
node tools/pak.mjs list  <path to data007.pak> "Missions/.*\.conf$"
node tools/pak.mjs cat   <path to data007.pak> scripts/Game/Ranks/SCR_RankInfo.c
node tools/pak.mjs get   <path to data007.pak> Missions/23_Campaign.conf out.conf
node tools/pak.mjs find  <path to data007.pak> "GetFactionLimitMap"
node tools/pak.mjs verify <path to data007.pak>
```

`find` is the one that answers "who calls this": it decompresses entries in place and prints the
surrounding text, which is how the `SCR_FactionManager` caller above was located.

Arma Reforger Explorer (`https://arexplorer.zeroy.com/`) is still worth knowing as a **second
source**: it is a different build and a different extraction path, so it is a cross-check rather
than a necessity. Its pages truncate when fetched directly; the two-step form is a page of the form

```
https://arexplorer.zeroy.com/_<file_name_in_lowercase_with_underscores>_8c_source.html
```

run through `https://www.w3.org/services/html2txt?url=<URL-in-urlencode>&nonums=on`.
For files with an ambiguous name (for example `game.c`, which exists in several
modules) the form with a path is used: `_game_2game_8c_source.html`. It carries `.c` and `.h`
only — no `.conf` and no `.layout` — and is pinned to an older build than the installed game,
so a class it does not have may still exist in the `pak`.
