# Arma Reforger scenario reference

**Build verified on:** Arma Reforger 1.6.0.119 (engine 192142). All 42 entries were re-checked
unchanged on the installed **1.8.0.13** — the note under the codename box below gives the command.

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
[`tools/extract-guid-table.ps1`](../../tools/extract-guid-table.ps1) still extracts the same table
by path prefix (`-Filter`, `-Validate`), but it does not check the length field, so it can carry a
candidate that is not a resource.

> These GUIDs are resource identifiers and do not change between patches. The list below
> corresponds to build 1.6.0.119 (verified against `ArmaReforgerServer.exe` v1.6.0.119,
> engine 192142).
>
> That property was tested on a later build: in the **1.8.0.13** install, all 42 entries below
> (38 scenarios and 4 terrains) are unchanged in `resourceDatabase.rdb`. Reproduce it with
> [`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs), which refuses to
> compare anything until its own parser has reproduced the 8 GUIDs published on the wiki.

## Official scenarios

In the "Scenario" column, the name on the left is what the map is called in the UI, and the
codename in parentheses is what you will see in the path to the `.conf`.

| Scenario | `scenarioId` |
|---|---|
| Conflict — Everon (Eden) | `{ECC61978EDCC2B5A}Missions/23_Campaign.conf` |
| Conflict — Arland | `{C41618FD18E9D714}Missions/23_Campaign_Arland.conf` |
| Conflict — **Kolguyev (Cain)** | `{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf` |
| Conflict — Northern Everon (Eden) | `{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf` |
| Conflict — Southern Everon (Eden) | `{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf` |
| Conflict — Western Everon (Eden) | `{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf` |
| Conflict — Montignac (Eden) | `{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf` |
| Conflict — HQC Arland | `{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf` |
| Conflict — HQC **Kolguyev (Cain)** | `{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf` |
| Conflict — HQC Everon (Eden) | `{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf` |
| Conflict — no AI | `{98D1DA94DD085044}Missions/ConflictWithoutAIs.conf` |
| Conflict — East | `{8C8EDD6FAE093FFF}Missions/Conflict_East.conf` |
| Conflict — West | `{23FD7E11B1EEED40}Missions/Conflict_West.conf` |
| Combat Ops — Arland | `{DAA03C6E6099D50F}Missions/24_CombatOps.conf` |
| Combat Ops — Everon | `{DFAC5FABD11F2390}Missions/26_CombatOpsEveron.conf` |
| Combat Ops — **Kolguyev (Cain)** | `{CB347F2F10065C9C}Missions/CombatOpsCain.conf` |
| Game Master — Everon (Eden) | `{59AD59368755F41A}Missions/21_GM_Eden.conf` |
| Game Master — Arland | `{2BBBE828037C6F4B}Missions/22_GM_Arland.conf` |
| Game Master — **Kolguyev (Cain)** | `{F45C6C15D31252E6}Missions/27_GM_Cain.conf` |
| Capture & Hold: Briars | `{3F2E005F43DBD2F8}Missions/CAH_Briars_Coast.conf` |
| Capture & Hold: Montfort Castle | `{F1A1BEA67132113E}Missions/CAH_Castle.conf` |
| Capture & Hold: Concrete Plant | `{589945FB9FA7B97D}Missions/CAH_Concrete_Plant.conf` |
| Capture & Hold: Almara Factory | `{9405201CBD22A30C}Missions/CAH_Factory.conf` |
| Capture & Hold: Almara Factory (FIA) | `{465564323DED44EC}Missions/CAH_Factory - FIA.conf` |
| Capture & Hold: Simon's Wood | `{1CD06B409C6FAE56}Missions/CAH_Forest.conf` |
| Capture & Hold: Simon's Wood (FIA) | `{654ADBC0BBB7DFBF}Missions/CAH_Forest - FIA.conf` |
| Capture & Hold: Le Moule | `{7C491B1FCC0FF0E1}Missions/CAH_LeMoule.conf` |
| Capture & Hold: Camp Blake | `{6EA2E454519E5869}Missions/CAH_Military_Base.conf` |
| Capture & Hold: Morton | `{2B4183DF23E88249}Missions/CAH_Morton.conf` |
| Training | `{002AF7323E0129AF}Missions/Tutorial.conf` |

## Single-player scenarios (not normally used in multiplayer)

| Scenario | `scenarioId` |
|---|---|
| Scenario 01 — Intro | `{10B8582BAD9F7040}Missions/Scenario01_Intro.conf` |
| Scenario 02 — Steal | `{1D76AF6DC4DF0577}Missions/Scenario02_Steal.conf` |
| Scenario 03 — Villa | `{D1647575BCEA5A05}Missions/Scenario03_Villa.conf` |
| Scenario 04 — Sabotage | `{6D224A109B973DD8}Missions/Scenario04_Sabotage.conf` |
| Scenario 05 — Hill | `{FA2AB0181129CB16}Missions/Scenario05_Hill.conf` |
| SP01 — Regina V2 | `{C47A1A6245A13B26}Missions/SP01_ReginaV2.conf` |
| SP02 — Air Support | `{0648CDB32D6B02B3}Missions/SP02_AirSupport.conf` |
| MpTest | `{83D06A42096F671C}Missions/MpTest/10_MpTest.conf` |

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

| Terrain | Config GUID |
|---|---|
| Everon (codename `Eden`) | `{B8754CE1921C0BE2}worlds/Eden/Eden_SMD.conf` |
| Arland | `{DDF31662E0615ED7}worlds/Arland/Arland_SMD.conf` |
| **Kolguyev (codename `Cain`)** | `{FCF0E8D9C8601BEA}worlds/Cain/Cain_SMD.conf` |
| Empty Kolguyev (for a sub-scene) | `{FCE37F2404664D00}worlds/Cain/EmptyCain_SMD.conf` |

> Empty worlds for a sub-scene: `worlds/Eden/EmptyEden.ent` — empty **Everon**,
> `worlds/Cain/EmptyCain.ent` — empty **Kolguyev**.

