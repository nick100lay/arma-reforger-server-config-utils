# Arma Reforger scenario reference

**Build verified on:** Arma Reforger 1.8.0.13 (engine 192142). All 42 entries were confirmed
against the installed build's `resourceDatabase.rdb` — the note under the codename box below gives
the command. The names in the last two columns of the scenario tables were read from the same
install: `m_sName` out of each mission header, resolved through its English string table.

Ready-made strings for the `game.scenarioId` field. Copy them whole, together with the `{GUID}`.

> ### ⚠️ Map codenames: Cain = Kolguyev, Eden = Everon
>
> **Paths and file names use the maps' historical codenames, not the ones
> shown in the UI.** There is no "Kolguyev" file in the game at all — the Kolguyev map lives
> in `worlds/Cain/`, and its name is set by the localization key
> `#AR-Editor_Mission_GM_Kolguyev_Name`.
>
> | Codename (in files) | Display name |
> |---|---|
> | `Cain` | **Kolguyev** |
> | `Eden` | **Everon** |
> | `Arland` | Arland |
>
> Confirmation is in the vanilla configs themselves: `Missions/27_GM_Cain.conf` references
> `worlds/GameMaster/GM_Cain.ent` and calls itself `#AR-Editor_Mission_GM_Kolguyev_Name`,
> while `Missions/23_Campaign.conf` references `worlds/MP/CTI_Campaign_Eden.ent` by the name
> `#AR-Campaign_ScenarioName_Everon`. Full breakdown — in
> [`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md) §2.1.
>
> That is why in the tables below Kolguyev scenarios are labelled with `Cain` — that is exactly how
> they are called in `scenarioId`. Look the map up by display name, take the string from here.


**How it was obtained (reproducible):** the GUIDs were extracted from
`<Dedicated Server>\addons\data\resourceDatabase.rdb`. In that file a resource entry is stored as
`[u32 path length, its NUL counted][UTF-8 path][0x00][6 bytes][GUID — 8 bytes little-endian]`, so
the GUID begins 7 bytes after the path's terminator. The method was verified against 8 GUIDs
published in the BI wiki (`23_Campaign`, `21_GM_Eden`, `22_GM_Arland`, `Tutorial`, `CAH_Castle`,
`CAH_Factory`, `CAH_LeMoule`, `CAH_Morton`) — **all 8 matched** — and
[`tools/rdb.mjs`](../../tools/rdb.mjs) repeats that self-check on demand:

```bash
npm run rdb -- verify "<Dedicated Server>/addons/data/resourceDatabase.rdb"
```

`get` turns a GUID into a path and `guid` turns a path into the GUID a `scenarioId` needs.
Both walk the records by their declared length, so a candidate that is not a resource is not
reported as one.

The name columns are read from the same install, with the two readers this repository already
has — the mission header text with `etconf`, the string table with `loc`:

```bash
npm run etconf -- get "<Dedicated Server>/addons/data/data002.pak:Missions/23_Campaign.conf" m_sName
npm run loc -- get "<Dedicated Server>/addons/data/data002.pak:Language/localization.en_us.conf" "#AR-Campaign_ScenarioName_Everon"
```

That prints `m_sName = "#AR-Campaign_ScenarioName_Everon"` and then `Conflict - Everon`.
`node tools/verify-against-install.mjs` does it for all 38 headers at once: it re-reads `m_sName`,
resolves every key through the installed `en_us` table and compares both with
[`data/scenarios.json`](../../data/scenarios.json). The dedicated server's `data002.pak` and the
client's `data007.pak` hold the same 38 headers, and reading them from either gave identical names.

> These GUIDs are resource identifiers and do not change between patches. The list below was read
> from the `resourceDatabase.rdb` of build 1.8.0.13 (`ArmaReforgerServer.exe` v1.8.0.13,
> engine 192142), and **all 42 entries** (38 scenarios and 4 terrains) were re-confirmed against
> that same database. Reproduce it with
> [`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs), which refuses to
> compare anything until its own parser has reproduced the 8 GUIDs published on the wiki.

## Official scenarios

The "Scenario" column is this document's own label for the mission; the codename in parentheses
is what you will see in the path to the `.conf`. The last two columns are the game's answer: the
value `m_sName` holds in the mission header, and that value resolved through the language table
(`Language/localization.en_us.conf` here, `ru_ru` in the Russian document), which is what the
scenario is called in the game.

A hyphen in "In game" is the game's own text and not a typo for the dash the labels use:
`#AR-Campaign_ScenarioName_Everon` resolves to `Conflict - Everon`, quoted here as it is.

| Scenario | `scenarioId` | Name (`m_sName`) | In game |
|---|---|---|---|
| Conflict — Everon (Eden) | `{ECC61978EDCC2B5A}Missions/23_Campaign.conf` | `#AR-Campaign_ScenarioName_Everon` | Conflict - Everon |
| Conflict — Arland | `{C41618FD18E9D714}Missions/23_Campaign_Arland.conf` | `#AR-MainMenu_ConflictArland_Name` | Conflict - Arland |
| Conflict — **Kolguyev (Cain)** | `{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf` | *(literal name)* | Conflict - Kolguyev |
| Conflict — Northern Everon (Eden) | `{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf` | `#AR-Campaign_SmallScenarioName_NorthCentral` | Conflict - Northern Everon |
| Conflict — Southern Everon (Eden) | `{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf` | `#AR-Campaign_SmallScenarioName_SWCoast` | Conflict - Southern Everon |
| Conflict — Western Everon (Eden) | `{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf` | `#AR-Campaign_SmallScenarioName_WestCoast` | Conflict - Western Everon |
| Conflict — Montignac (Eden) | `{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf` | `#AR-Campaign_SmallScenarioName_Montignac` | Conflict - Montignac |
| Conflict — HQC Arland | `{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf` | `#AR-Campaign_HQC_ScenarioName_Arland` | Conflict: HQ Commander - Arland |
| Conflict — HQC **Kolguyev (Cain)** | `{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf` | `#AR-Campaign_HQC_ScenarioName_Cain` | Conflict: HQ Commander - Kolguyev |
| Conflict — HQC Everon (Eden) | `{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf` | `#AR-Campaign_HQC_ScenarioName_Everon` | Conflict: HQ Commander - Everon |
| Conflict — no AI | `{98D1DA94DD085044}Missions/ConflictWithoutAIs.conf` | `#AR-Campaign_GamemodeName` | Conflict |
| Conflict — East | `{8C8EDD6FAE093FFF}Missions/Conflict_East.conf` | `#AR-Campaign_GamemodeName` | Conflict |
| Conflict — West | `{23FD7E11B1EEED40}Missions/Conflict_West.conf` | `#AR-Campaign_GamemodeName` | Conflict |
| Combat Ops — Arland | `{DAA03C6E6099D50F}Missions/24_CombatOps.conf` | `#AR-CombatScenarioArland_Name` | Combat Ops - Arland |
| Combat Ops — Everon | `{DFAC5FABD11F2390}Missions/26_CombatOpsEveron.conf` | `#AR-CombatScenarioEveron_Name` | Combat Ops - Everon |
| Combat Ops — **Kolguyev (Cain)** | `{CB347F2F10065C9C}Missions/CombatOpsCain.conf` | `#AR-COK_Name` | Combat Ops - Kolguyev |
| Game Master — Everon (Eden) | `{59AD59368755F41A}Missions/21_GM_Eden.conf` | `#AR-Editor_Mission_GM_Eden_Name` | Game Master - Everon |
| Game Master — Arland | `{2BBBE828037C6F4B}Missions/22_GM_Arland.conf` | `#AR-Editor_Mission_GM_Arland_Name` | Game Master - Arland |
| Game Master — **Kolguyev (Cain)** | `{F45C6C15D31252E6}Missions/27_GM_Cain.conf` | `#AR-Editor_Mission_GM_Kolguyev_Name` | Game Master - Kolguyev |
| Capture & Hold: Briars | `{3F2E005F43DBD2F8}Missions/CAH_Briars_Coast.conf` | `#AR-CAH-Scenario_Name_The_Briars` | Capture & Hold - Briars |
| Capture & Hold: Montfort Castle | `{F1A1BEA67132113E}Missions/CAH_Castle.conf` | `#AR-CAH-Scenario_Name_Montfort_Castle` | Capture & Hold - Montfort Castle |
| Capture & Hold: Concrete Plant | `{589945FB9FA7B97D}Missions/CAH_Concrete_Plant.conf` | `#AR-CAH-Scenario_Name_Concrete_Plant` | Capture & Hold - Concrete Plant |
| Capture & Hold: Almara Factory | `{9405201CBD22A30C}Missions/CAH_Factory.conf` | `#AR-CAH-Scenario_Name_Almara_Factory` | Capture & Hold - Almara Factory |
| Capture & Hold: Almara Factory (FIA) | `{465564323DED44EC}Missions/CAH_Factory - FIA.conf` | `#AR-CAH-Scenario_Name_Almara_Factory` | Capture & Hold - Almara Factory |
| Capture & Hold: Simon's Wood | `{1CD06B409C6FAE56}Missions/CAH_Forest.conf` | `#AR-CAH-Scenario_Name_Simons_Wood` | Capture & Hold - Simon's Wood |
| Capture & Hold: Simon's Wood (FIA) | `{654ADBC0BBB7DFBF}Missions/CAH_Forest - FIA.conf` | `#AR-CAH-Scenario_Name_Simons_Wood` | Capture & Hold - Simon's Wood |
| Capture & Hold: Le Moule | `{7C491B1FCC0FF0E1}Missions/CAH_LeMoule.conf` | `#AR-CAH-Scenario_Name_Le_Moule` | Capture & Hold - Le Moule |
| Capture & Hold: Camp Blake | `{6EA2E454519E5869}Missions/CAH_Military_Base.conf` | `#AR-CAH-Scenario_Name_Camp_Blake` | Capture & Hold - Camp Blake |
| Capture & Hold: Morton | `{2B4183DF23E88249}Missions/CAH_Morton.conf` | `#AR-CAH-Scenario_Name_Morton` | Capture & Hold - Morton |
| Training | `{002AF7323E0129AF}Missions/Tutorial.conf` | `#AR-Tutorial_Name` | Training |

> **Three missions are called the same thing, and two pairs share a name.** `ConflictWithoutAIs.conf`,
> `Conflict_East.conf` and `Conflict_West.conf` all carry `#AR-Campaign_GamemodeName`, which
> resolves to **`Conflict`**: in a list they are indistinguishable by name, and "no AI", "East" and
> "West" are this document's labels, not the game's. In the same way `CAH_Factory.conf` and
> `CAH_Factory - FIA.conf` both carry `#AR-CAH-Scenario_Name_Almara_Factory`, and `CAH_Forest.conf`
> and `CAH_Forest - FIA.conf` both carry `#AR-CAH-Scenario_Name_Simons_Wood` — the files differ, the
> name does not.
>
> **`Conflict - Kolguyev` is a literal name, not a key.** `23_Campaign_Cain.conf` holds
> `m_sName "Conflict - Kolguyev"` with no `#`, so there is nothing to look up and nothing to
> translate: the Russian game shows the same English text. Its Name column says *(literal name)*
> for that reason, rather than repeating the value the next column already shows.

## Single-player scenarios (not normally used in multiplayer)

| Scenario | `scenarioId` | Name (`m_sName`) | In game |
|---|---|---|---|
| Scenario 01 — Intro | `{10B8582BAD9F7040}Missions/Scenario01_Intro.conf` | `#AR-KS01_Name_Medium` | Omega 01: Over The Hills And Far Away |
| Scenario 02 — Steal | `{1D76AF6DC4DF0577}Missions/Scenario02_Steal.conf` | `#AR-KS02_Name_Medium` | Omega 02: Radio Check |
| Scenario 03 — Villa | `{D1647575BCEA5A05}Missions/Scenario03_Villa.conf` | `#AR-KS03_Name_Medium` | Omega 03: Light In The Dark |
| Scenario 04 — Sabotage | `{6D224A109B973DD8}Missions/Scenario04_Sabotage.conf` | `#AR-KS04_Name_Medium` | Omega 04: Red Silence |
| Scenario 05 — Hill | `{FA2AB0181129CB16}Missions/Scenario05_Hill.conf` | `#AR-KS05_Name_Medium` | Omega 05: Cliffhanger |
| SP01 — Regina V2 | `{C47A1A6245A13B26}Missions/SP01_ReginaV2.conf` | `#AR-SP01_Name` | Elimination |
| SP02 — Air Support | `{0648CDB32D6B02B3}Missions/SP02_AirSupport.conf` | `#AR-SP02_Name` | Air Support |
| MpTest | `{83D06A42096F671C}Missions/MpTest/10_MpTest.conf` | *(literal name)* | Multiplayer Test |

> **The five story missions are not called "Scenario 01–05" in the game.** Their headers carry
> `#AR-KS01_Name_Medium` … `#AR-KS05_Name_Medium`, which resolve to **`Omega 01: Over The Hills And
> Far Away`** … **`Omega 05: Cliffhanger`**; the file names, and the labels above, are the
> developers' names for them. `SP01_ReginaV2.conf` calls itself **`Elimination`** (`#AR-SP01_Name`
> — "Regina V2" is only the file name), and `10_MpTest.conf` holds the literal `Multiplayer Test`,
> untranslated for the same reason as `Conflict - Kolguyev` above.

## Your own scenario (a mod)

For a mission from a mod the string looks the same, but the GUID comes from `<YourMission>.conf.meta`
(the `Name` field). Example:

```
{GUID from .meta}Missions/MyMission.conf
```

If there is no `.meta`, the resource is not registered, and the server will not find it.
See the main document, section "Verification and common errors".

## Terrains (for mission header and Workbench)

These GUIDs belong to terrain configs (`*_SMD.conf`), not to the world `.ent` files — for
`missionHeader`/`World` in Workbench you need the GUID of the `.ent` itself from its `.meta`.
The `*_SMD.conf` files carry no name to quote — each one is a `ShoreMapConfig`, a block of
terrain-shading and shore settings — so this table has no "In game" column.

| Terrain | Config GUID |
|---|---|
| Everon (codename `Eden`) | `{B8754CE1921C0BE2}worlds/Eden/Eden_SMD.conf` |
| Arland | `{DDF31662E0615ED7}worlds/Arland/Arland_SMD.conf` |
| **Kolguyev (codename `Cain`)** | `{FCF0E8D9C8601BEA}worlds/Cain/Cain_SMD.conf` |
| Empty Kolguyev (for a sub-scene) | `{FCE37F2404664D00}worlds/Cain/EmptyCain_SMD.conf` |

> Empty worlds for a sub-scene: `worlds/Eden/EmptyEden.ent` — empty **Everon**,
> `worlds/Cain/EmptyCain.ent` — empty **Kolguyev**.

