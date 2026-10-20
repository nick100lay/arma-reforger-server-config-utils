# Bases in the vanilla game modes — the complete catalogue

This document answers one question: **what exact string do you put in `m_sBaseName`**, and what
can that base be made to do. It is a catalogue of every base the vanilla Conflict worlds ship, with
the base's entity name, its localized display name, its type and its four campaign flags.

The two header fields themselves — how the list is matched, what the blacklist and the whitelist
each do, which header class accepts them — are in
[the `missionHeader` breakdown](ArmaReforger_MissionHeader_EN.md#34-ma-campaigncustombaselist--custom-base-list),
§3.4. This document does not repeat that explanation; it supplies the names that explanation tells
you to match.

**Build verified on:** Arma Reforger 1.8.0.13 (engine 192142) — the worlds are read out of
`worlds001.pak`, the prefabs and the class defaults out of `data007.pak`, and the display names out
of `Language/localization.*.conf`, all of the installed build. §6 lists the commands, and
[`tools/verify-bases.mjs`](../../tools/verify-bases.mjs) re-derives every table below from that
install and fails when the two disagree.

---

## 0. Read this first

Three things decide whether a base list does anything at all.

1. **The name is the entity name, not the display name.** The value in `m_sBaseName` is compared
   with the *entity* name of the base in the world — `TownBaseMeaux`, `MajorBaseMorton`,
   `StartingPos07` — and never with what the map shows ("Meaux", "Coastal Base Morton", "Main
   Operating Base"). The two are separate columns in every table below, and the display name is
   localized while the entity name is not.
2. **Only the Conflict family has bases.** Of the 32 distinct worlds the vanilla scenarios load,
   exactly 7 carry an `SCR_CampaignMilitaryBaseComponent` — the seven `worlds/MP/CTI_Campaign_*.ent`
   Conflict worlds, and nothing else (§1). In Combat Ops, Game Master, Capture & Hold, Training and
   the single-player scenarios a base list matches nothing, and the mode will not report that.
3. **A whitelist entry replaces the base's flags, it does not merge with them.** For every base in
   the list the game copies all four fields out of your entry, so a field you leave out becomes the
   class default (`m_bIsControlPoint` false, `m_bCanBeHQ` false, `m_bDisableWhenUnusedAsHQ` true,
   `m_fRadioRange` -1) — *not* what the world had. To keep what vanilla ships, copy the columns of
   the table. The code that does this is quoted in the `missionHeader` document, §3.4.

The third point is the one that bites: a whitelist of ten bases with nothing but a name turns every
one of them into a non-control-point that cannot be an HQ, and a mode whose whitelist leaves fewer
than two bases able to be an HQ starts without any main base at all — see §4.3, where two shipped
vanilla scenarios do exactly that.

---

## 1. Which vanilla modes have bases

| Mode family | Vanilla scenarios | World | Bases | Of them named | Unnamed |
|---|---|---|---:|---:|---:|
| Conflict — Everon | `23_Campaign`, `23_Campaign_NorthCentral`, `23_Campaign_SWCoast`, `ConflictWithoutAIs`, `Conflict_East`, `Conflict_West` | `worlds/MP/CTI_Campaign_Eden.ent` | 64 | 64 | 0 |
| Conflict — Arland | `23_Campaign_Arland` | `worlds/MP/CTI_Campaign_Arland.ent` | 9 | 9 | 0 |
| Conflict — Kolguyev | `23_Campaign_Cain`, `23_Campaign_HQC_Cain` | `worlds/MP/CTI_Campaign_Cain.ent` | 26 | 12 | 14 |
| Conflict — Western Everon | `23_Campaign_Western` | `worlds/MP/CTI_Campaign_WesternEveron.ent` | 13 | 4 | 9 |
| Conflict — Montignac | `23_Campaign_Montignac` | `worlds/MP/CTI_Campaign_Montignac.ent` | 10 | 10 | 0 |
| Conflict: HQ Commander — Everon | `23_Campaign_HQC_Everon` | `worlds/MP/CTI_Campaign_HQC_Eden.ent` | 35 | 35 | 0 |
| Conflict: HQ Commander — Arland | `23_Campaign_HQC_Arland` | `worlds/MP/CTI_Campaign_HQC_Arland.ent` | 11 | 5 | 6 |
| Combat Ops | `24_CombatOps`, `26_CombatOpsEveron`, `CombatOpsCain`, `SP01_ReginaV2`, `SP02_AirSupport` | `worlds/MP/Coop_CombatOps_*.ent`, `worlds/SP/SP0*` | **0** | — | — |
| Game Master | `21_GM_Eden`, `22_GM_Arland`, `27_GM_Cain` | `worlds/GameMaster/GM_*.ent` | **0** | — | — |
| Capture & Hold | `CAH_Briars_Coast`, `CAH_Castle`, `CAH_Concrete_Plant`, `CAH_Factory`, `CAH_Factory - FIA`, `CAH_Forest`, `CAH_Forest - FIA`, `CAH_LeMoule`, `CAH_Military_Base`, `CAH_Morton` | `worlds/CaptureAndHold/CAH_*.ent` | **0** | — | — |
| Training | `Tutorial` | `worlds/SP/Tutorial/Tutorial.ent` | **0** | — | — |
| Single-player campaign | `Scenario01`–`Scenario05` | `worlds/SP/Story/Scenario0*` | **0** | — | — |
| Multiplayer test | `10_MpTest` | `worlds/MP/MpTest/MpTest.ent` | **0** | — | — |

The zero rows are a measurement, not an assumption: for every one of the 32 worlds those scenarios
name, the world was read and every entity checked for an `SCR_CampaignMilitaryBaseComponent` in its
own override block **or anywhere in its prefab chain** — the same method the catalogue uses (§6).
Capture & Hold has capture points of its own, but they belong to that mode's system, not to
`SCR_CampaignMilitaryBaseComponent`, and `m_aCampaignCustomBaseList` cannot reach them.

Two consequences worth stating plainly:

- **A list written for one world does not carry to another.** The same place has a different entity
  name in a different world — Montignac is `TownBaseMontignac` in the Conflict world of §3.1 and
  `CP_MontignacTown` in the HQ Commander world of §3.6, and the display name `Morton Valley` belongs
  to `SmallBaseRichemont` on Everon and to a nameless base on Western Everon — and the two HQ
  Commander worlds are different worlds from the Conflict ones on the same terrain, with their own
  sets of bases.
- **`23_Campaign_NorthCentral` and `23_Campaign_SWCoast` inherit their `World` from
  `23_Campaign.conf`**, so they run on the Everon world and draw their whitelists from the 64 bases
  in §3.1. A scenario `.conf` that inherits does not repeat the `World` line.

---

## 2. How to read the tables

| Column | Meaning |
|---|---|
| **Entity name** | The value of `GetOwner().GetName()` for the base entity — **the string `m_sBaseName` must equal.** |
| **Display name** | What the map and the capture notifications show: the text behind the component's `m_sBaseName` localization key. In this document it is the English text; the Russian document carries the Russian one, and §2.3 says how to get any of the other eleven. |
| **Type** | `SCR_ECampaignBaseType`: `BASE`, `RELAY` or `SOURCE_BASE`. A `RELAY` is the radio-repeater tower; vanilla uses `BASE` and `RELAY` only. |
| **Control point** | `m_bIsControlPoint` — the base counts towards victory. |
| **Supply hub** | `m_bIsSupplyHub` — supply income is handled as it is at an HQ. **Not settable** through the base list: `SCR_CampaignCustomBase` has no field for it. |
| **Can be HQ** | `m_bCanBeHQ` — the base may be chosen as a faction's main base. At least two bases with this flag must survive the list, or the mode has no HQ. |
| **Disable when unused as HQ** | `m_bDisableWhenUnusedAsHQ` — when the faction moves its HQ elsewhere, this base is shut down. |

### 2.1 Where a value comes from

A world file stores **only what differs from the prefab**, so a flag a world does not mention is not
"off" — it is whatever the prefab chain says, and the chain starts at the class defaults
(`m_bIsControlPoint 0`, `m_bCanBeHQ 0`, `m_bDisableWhenUnusedAsHQ 1`, `m_bIsSupplyHub 0`,
`m_eType BASE`). The tables give the **effective** value: class default, then every prefab in the
chain from the root down, then the world's own override. That is why, for example, every
`CP_*` base on Kolguyev is a control point although the world file does not set the flag anywhere —
the `ConflictControlPoint.et` prefab does.

### 2.2 Bases with no entity name

29 of the 168 bases have an **empty entity name**: the world editor never named them. They are real
bases — they are registered, they can be control points, they show a display name on the map — but
`GetOwner().GetName()` returns the empty string for them, so a base list cannot address them
individually and a whitelist silently drops them. They are listed in a second table per world, with
their prefab and their world position, because leaving them out would make the catalogue incomplete
and because the position is how you recognise one in the Workbench.

### 2.3 Display names in another language

The display name is a localization key (`m_sBaseName`, for example `#AR-MapLocation_Figari`) resolved
through `Language/localization.<lang>.conf`. Twelve languages ship beside English; the key is the
same in all of them:

```
node tools/loc.mjs get "<install>/addons/data/data007.pak:Language/localization.de_de.conf" "#AR-MapLocation_Figari"
```

The languages are `cs_cz`, `de_de`, `en_us`, `es_es`, `fr_fr`, `it_it`, `ja_jp`, `ko_kr`, `pl_pl`,
`pt_br`, `ru_ru`, `uk_ua` and `zh_cn`. Note what this does **not** change: the value you write in
`m_sBaseName` is the entity name, which is never localized, and renaming a display name changes
nothing about matching.

---

## 3. The catalogue

Numbers are per world: bases / named / unnamed.

### 3.1 `worlds/MP/CTI_Campaign_Eden.ent` — Everon — 64 / 64 / 0

Used by `{ECC61978EDCC2B5A}Missions/23_Campaign.conf` (Conflict - Everon),
`{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf`,
`{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf` (both inherit the world),
`{98D1DA94DD085044}Missions/ConflictWithoutAIs.conf`,
`{8C8EDD6FAE093FFF}Missions/Conflict_East.conf` and
`{23FD7E11B1EEED40}Missions/Conflict_West.conf`.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `MainBaseNorth` | Saint-Philippe | `BASE` | yes | yes | no | yes |
| `MainBaseSouth` | Saint-Pierre | `BASE` | yes | yes | no | yes |
| `MajorBaseChotain` | Coastal Base Chotain | `BASE` | yes | yes | no | yes |
| `MajorBaseLamentin` | Coastal Base Lamentin | `BASE` | yes | yes | no | yes |
| `MajorBaseMorton` | Coastal Base Morton | `BASE` | yes | yes | no | yes |
| `MilitaryBaseAirfield` | Airbase Saint-Philippe | `BASE` | no | no | no | yes |
| `MilitaryBaseLevie` | Military Base Levie | `BASE` | yes | yes | no | yes |
| `MilitaryBaseVilleneuf` | Calvary Hill | `BASE` | no | no | no | yes |
| `MilitaryHospital` | Military Hospital | `BASE` | yes | yes | no | yes |
| `Relay15` | Tower Entre-Deux | `RELAY` | no | no | no | yes |
| `Relay4` | Tower Régina | `RELAY` | no | no | no | yes |
| `SmallBaseAndresBeacon` | André's Beacon | `BASE` | no | no | no | yes |
| `SmallBaseBlackLake` | Black Lake | `BASE` | no | no | no | yes |
| `SmallBaseGoatbay` | Camurac | `BASE` | no | no | no | yes |
| `SmallBaseHornbeamValley` | Hornbeam Valley | `BASE` | no | no | no | yes |
| `SmallBaseLake` | Pinewood Lake | `BASE` | no | no | no | yes |
| `SmallBaseMaidensBay` | Military Depot | `BASE` | no | no | no | yes |
| `SmallBaseMine` | Quarry | `BASE` | no | no | no | yes |
| `SmallBasePennantsPass` | Pennants Pass | `BASE` | no | no | no | yes |
| `SmallBaseRichemont` | Morton Valley | `BASE` | no | no | no | yes |
| `SmallBaseShepherds` | Old Wood | `BASE` | no | no | no | yes |
| `SmallBaseSimonsWood` | Simon's Wood | `BASE` | no | no | no | yes |
| `SmallBaseTillersFind` | Tiller's Find | `BASE` | no | no | no | yes |
| `StartingPos01` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos02` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos03` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos04` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos05` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos06` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos07` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos08` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos09` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos10` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos11` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos12` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos13` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos14` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos15` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos16` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos17` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos18` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos19` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos20` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos21` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos23` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos24` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos25` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos26` | Main Operating Base | `BASE` | no | no | yes | yes |
| `TownBaseChotain` | Chotain | `BASE` | no | no | no | yes |
| `TownBaseDuras` | Durras | `BASE` | no | no | no | yes |
| `TownBaseEntre_Deux` | Entre-Deux | `BASE` | no | no | no | yes |
| `TownBaseFigari` | Figari | `BASE` | no | no | no | yes |
| `TownBaseGravette` | Gravette | `BASE` | no | no | no | yes |
| `TownBaseKermovan` | Kermovan | `BASE` | no | no | no | yes |
| `TownBaseLaruns` | Laruns | `BASE` | no | no | no | yes |
| `TownBaseLe_Moule` | Le Moule | `BASE` | no | no | no | yes |
| `TownBaseLevie` | Levie | `BASE` | no | no | no | yes |
| `TownBaseMeaux` | Meaux | `BASE` | no | no | no | yes |
| `TownBaseMontignac` | Montignac | `BASE` | no | no | no | yes |
| `TownBaseProvins` | Provins | `BASE` | no | no | no | yes |
| `TownBaseRegina` | Régina | `BASE` | no | no | no | yes |
| `TownBaseTyrone` | Tyrone | `BASE` | no | no | no | yes |
| `TownBaseVernon` | Vernon | `BASE` | no | no | no | yes |
| `TownBaseVileneuf` | Villeneuve | `BASE` | no | no | no | yes |

### 3.2 `worlds/MP/CTI_Campaign_Arland.ent` — Arland — 9 / 9 / 0

Used by `{C41618FD18E9D714}Missions/23_Campaign_Arland.conf`.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `AirportNorth` | Airport Base | `BASE` | no | no | no | yes |
| `ArlevilleBase` | Arleville | `BASE` | no | no | no | yes |
| `BeauregardBase` | Beauregard | `BASE` | yes | yes | no | yes |
| `Farm` | Farm | `BASE` | no | no | no | yes |
| `HQEast` | Main Operating Base | `BASE` | no | no | yes | no |
| `HQWest` | Main Operating Base | `BASE` | no | no | yes | no |
| `MilitarySouth` | Military Training Area | `BASE` | yes | yes | no | yes |
| `MossHill` | Moss Hill | `BASE` | no | no | no | yes |
| `Tower` | Signal Hill | `RELAY` | no | no | no | yes |

### 3.3 `worlds/MP/CTI_Campaign_Cain.ent` — Kolguyev — 26 / 12 / 14

Used by `{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf` and
`{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf`. The path says `Cain` and the map is
Kolguyev — see §2.1 of the `missionHeader` document for why.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `Base_MilitaryHQ` | Main Operating Base | `BASE` | no | no | yes | yes |
| `CP_Crossroad` | Northern Crossroad | `BASE` | yes | no | no | no |
| `CP_Gorshkovo` | Gorshkovo | `BASE` | yes | no | no | no |
| `CP_Kamensk` | Kamensk | `BASE` | yes | no | no | no |
| `CP_Mine` | Krasny Oktyabr Mine | `BASE` | yes | no | no | no |
| `CP_Mineraly` | Mineraly | `BASE` | yes | no | no | no |
| `CP_Ugoldar` | Ugoldar | `BASE` | yes | no | no | no |
| `CP_Villa` | Villa | `BASE` | yes | no | no | no |
| `HQ_EastCoast` | Main Operating Base | `BASE` | no | no | yes | yes |
| `HQ_NE` | Main Operating Base | `BASE` | no | no | yes | yes |
| `HQ_SW` | Main Operating Base | `BASE` | no | no | yes | yes |
| `HQ_W` | Main Operating Base | `BASE` | no | no | yes | yes |

**Bases with no entity name** — listed here because the catalogue is complete, not because they can be used:

| Display name | Prefab | Control point | Supply hub | Can be HQ | Disable when unused as HQ | X | Z |
|---|---|---:|---:|---:|---:|---:|---:|
| BARS Communication Tower | `ConflictRelayRadio.et` | no | no | no | yes | 6860 | 6781 |
| Base | `ConflictSourceBase_T2Harbor.et` | no | no | no | no | 1642 | 7386 |
| Base | `ConflictSourceBase_Airfield.et` | no | no | no | no | 2646 | 5367 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 3743 | 3726 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 4356 | 8144 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 6046 | 8444 |
| Base | `ConflictSourceBase_T1Harbor.et` | no | no | no | no | 6817 | 3491 |
| Base | `ConflictSourceBase_T2Harbor.et` | no | no | no | no | 7554 | 4186 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 8583 | 10186 |
| Base | `ConflictSourceBase_T2Harbor.et` | no | no | no | no | 8802 | 7395 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 10054 | 10860 |
| Base | `ConflictSourceBase_T2Harbor.et` | no | no | no | no | 11838 | 10974 |
| Base | `ConflictSourceBase_T1Harbor.et` | no | no | no | no | 12121 | 10520 |
| Mountain Peak Relay | `ConflictRelayRadio.et` | no | no | no | yes | 5056 | 6328 |

### 3.4 `worlds/MP/CTI_Campaign_WesternEveron.ent` — Western Everon — 13 / 4 / 9

Used by `{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf`. Nine of its thirteen bases have no
entity name, which is why this world is the clearest example of a base list that cannot say what it
means: a whitelist here can only name four of the thirteen.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `Briars` | The Briars | `BASE` | no | no | no | yes |
| `HQNorth` | Coastal Base Lamentin | `BASE` | no | no | yes | no |
| `HQSouth` | Coastal Base Morton | `BASE` | no | no | yes | no |
| `LongHill` | Long Hill | `BASE` | no | no | no | yes |

**Bases with no entity name** — listed here because the catalogue is complete, not because they can be used:

| Display name | Prefab | Control point | Supply hub | Can be HQ | Disable when unused as HQ | X | Z |
|---|---|---:|---:|---:|---:|---:|---:|
| Calvary Hill | `ConflictMilitaryBase.et` | yes | no | no | yes | 3504 | 5819 |
| Kervel | `ConflictMilitaryBase.et` | no | no | no | yes | 2625 | 4892 |
| Le Moule | `ConflictMilitaryBase.et` | yes | no | no | yes | 2595 | 5385 |
| Morton Valley | `ConflictMilitaryBase.et` | no | no | no | yes | 4627 | 4750 |
| Old Wood | `ConflictMilitaryBase.et` | no | no | no | yes | 3300 | 4463 |
| Pinewood Lake | `ConflictMilitaryBase.et` | no | no | no | yes | 4203 | 5533 |
| Richemont | `ConflictMilitaryBase.et` | yes | no | no | yes | 3802 | 5006 |
| Villeneuve | `ConflictMilitaryBase.et` | no | no | no | yes | 2930 | 5939 |
| Wolf Hill | `ConflictMilitaryBase.et` | no | no | no | yes | 4129 | 4048 |

### 3.5 `worlds/MP/CTI_Campaign_Montignac.ent` — Montignac — 10 / 10 / 0

Used by `{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf`.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `Cemetery` | Cemetery | `BASE` | yes | no | no | yes |
| `EntreDeux` | Entre-Deux | `BASE` | no | no | no | yes |
| `Farm` | Farm | `BASE` | no | no | no | yes |
| `FieldBase` | Pinewood Lake | `BASE` | no | no | no | yes |
| `FootballField` | Farm Complex | `BASE` | yes | no | no | yes |
| `HQEast` | Military Base Bénac | `BASE` | no | no | yes | no |
| `HQWest` | Military Base Villeneuve | `BASE` | no | no | yes | no |
| `Industrial` | Industrial Compound | `BASE` | yes | no | no | yes |
| `Lacourt` | Lacourt | `BASE` | no | no | no | yes |
| `TillersFind` | Tiller's Find | `BASE` | no | no | no | yes |

### 3.6 `worlds/MP/CTI_Campaign_HQC_Eden.ent` — Everon, HQ Commander — 35 / 35 / 0

Used by `{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf`. This is **not** the Conflict
world on Everon: it is a separate world with its own, smaller set of bases, so a list carried over
from §3.1 names bases that do not exist here.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `CP_CalvaryHill` | Calvary Hill | `BASE` | yes | no | no | no |
| `CP_LevieMilitaryBase` | Military Base Levie | `BASE` | yes | no | no | no |
| `CP_MontignacTown` | Montignac | `BASE` | yes | no | no | no |
| `CP_PowerPlant` | Power Plant | `BASE` | yes | no | no | no |
| `CP_ProvinsTransformerStation` | Transformer Station | `BASE` | yes | no | no | no |
| `CP_Regina` | Régina | `BASE` | yes | no | no | no |
| `CP_SaulesIsland` | Île-aux-Saules | `BASE` | yes | no | no | no |
| `Relay15` | Tower Entre-Deux | `RELAY` | no | no | no | yes |
| `Relay4` | Tower Régina | `RELAY` | no | no | no | yes |
| `SP_A_EveronAirport` | Base | `BASE` | no | no | no | no |
| `SP_T1H_StPhillipe` | Base | `BASE` | no | no | no | no |
| `SP_T1H_StPierre` | Base | `BASE` | no | no | no | no |
| `SP_T2H_FishermansBay` | Base | `BASE` | no | no | no | no |
| `SP_T2H_Lamentin` | Base | `BASE` | no | no | no | no |
| `SP_T2H_Meaux` | Base | `BASE` | no | no | no | no |
| `SP_T2H_MilitaryHospital` | Base | `BASE` | no | no | no | no |
| `SP_T2H_Morton` | Base | `BASE` | no | no | no | no |
| `SP_T3H_GoatBay` | Base | `BASE` | no | no | no | no |
| `SP_T3H_Gravette` | Base | `BASE` | no | no | no | no |
| `SP_T3H_HalcyonStrait` | Base | `BASE` | no | no | no | no |
| `SP_T3H_Kermovan` | Base | `BASE` | no | no | no | no |
| `SP_T3H_Lancre` | Base | `BASE` | no | no | no | no |
| `SP_T3H_Laruns` | Base | `BASE` | no | no | no | no |
| `SP_T3H_LeBosc` | Base | `BASE` | no | no | no | no |
| `SP_T3H_Perelle` | Base | `BASE` | no | no | no | no |
| `SP_T3H_SpaniardsBay` | Base | `BASE` | no | no | no | no |
| `SP_T3H_Thollevast` | Base | `BASE` | no | no | no | no |
| `StartingPos05` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos07` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos09` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos12` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos14` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos15` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos19` | Main Operating Base | `BASE` | no | no | yes | yes |
| `StartingPos21` | Main Operating Base | `BASE` | no | no | yes | yes |

### 3.7 `worlds/MP/CTI_Campaign_HQC_Arland.ent` — Arland, HQ Commander — 11 / 5 / 6

Used by `{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf`, and again a different world from
§3.2.

| Entity name | Display name | Type | Control point | Supply hub | Can be HQ | Disable when unused as HQ |
|---|---|---|---:|---:|---:|---:|
| `BeauregardBase` | Beauregard | `BASE` | yes | no | no | no |
| `GullIsland` | Gull Island | `BASE` | yes | no | no | no |
| `HQEast` | Main Operating Base | `BASE` | no | no | yes | yes |
| `HQWest` | Main Operating Base | `BASE` | no | no | yes | yes |
| `Tower` | Signal Hill | `RELAY` | no | no | no | yes |

**Bases with no entity name** — listed here because the catalogue is complete, not because they can be used:

| Display name | Prefab | Control point | Supply hub | Can be HQ | Disable when unused as HQ | X | Z |
|---|---|---:|---:|---:|---:|---:|---:|
| Base | `ConflictSourceBase_Airfield.et` | no | no | no | no | 1372 | 2934 |
| Base | `ConflictSourceBase_T2Harbor.et` | no | no | no | no | 1493 | 1848 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 1673 | 902 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 2398 | 3268 |
| Base | `ConflictSourceBase_T2Harbor.et` | no | no | no | no | 3170 | 1168 |
| Base | `ConflictSourceBase_T3Harbor.et` | no | no | no | no | 3558 | 1540 |

---

## 4. The lists vanilla itself ships

Four scenarios ship an `m_aCampaignCustomBaseList`, and all four set `m_bCustomBaseWhitelist 1`. They
are the working examples to copy from.

### 4.1 What they have in common

- **Every entry in all four lists names a base that exists** in the scenario's world — 31 entries,
  31 hits, no typos and no leftovers (§6 checks this).
- **The two scenarios that are meant to be played mark two HQ bases each.** Northern and Southern
  Everon both set `m_bCanBeHQ 1` and `m_bDisableWhenUnusedAsHQ 0` on two bases and give those two
  `m_fRadioRange 2000`. That is the minimum a whitelist needs to keep the mode working: two movable
  HQs. `Conflict_East` and `Conflict_West` mark none — §4.3.
- **Every other entry is a single `m_sBaseName`.** Everything it does not say is therefore the class
  default: not a control point, not an HQ, disabled when unused — except for the one or two entries
  that set `m_bIsControlPoint 1` explicitly.

### 4.2 The four lists

### Conflict - Northern Everon — `{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf`

| `m_sBaseName` | `m_bIsControlPoint` | `m_bCanBeHQ` | `m_bDisableWhenUnusedAsHQ` | `m_fRadioRange` |
|---|---:|---:|---:|---:|
| `MainBaseNorth` | — | 1 | — | 2000 |
| `MajorBaseMorton` | — | 1 | — | 2000 |
| `TownBaseMeaux` | — | — | — | — |
| `TownBaseTyrone` | — | — | — | — |
| `SmallBaseHornbeamValley` | 1 | — | — | — |
| `MilitaryHospital` | — | — | — | — |
| `SmallBaseRichemont` | — | — | — | — |
| `TownBaseFigari` | — | — | — | — |
| `TownBaseProvins` | — | — | — | — |
| `SmallBaseLake` | 1 | — | — | — |

### Conflict - Southern Everon — `{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf`

| `m_sBaseName` | `m_bIsControlPoint` | `m_bCanBeHQ` | `m_bDisableWhenUnusedAsHQ` | `m_fRadioRange` |
|---|---:|---:|---:|---:|
| `MajorBaseMorton` | — | 1 | — | 2000 |
| `MainBaseSouth` | — | 1 | — | 2000 |
| `TownBaseDuras` | — | — | — | — |
| `SmallBasePennantsPass` | 1 | — | — | — |
| `TownBaseRegina` | — | — | — | — |
| `SmallBaseGoatbay` | — | — | — | — |
| `Relay4` | — | — | — | — |
| `MilitaryBaseLevie` | 1 | — | — | — |
| `TownBaseLevie` | — | — | — | — |

### Conflict — `{8C8EDD6FAE093FFF}Missions/Conflict_East.conf`

| `m_sBaseName` | `m_bIsControlPoint` | `m_bCanBeHQ` | `m_bDisableWhenUnusedAsHQ` | `m_fRadioRange` |
|---|---:|---:|---:|---:|
| `MajorBaseChotain` | — | — | — | — |
| `MajorBaseMorton` | — | — | — | — |
| `TownBaseFigari` | 1 | — | — | — |
| `SmallBaseRichemont` | — | — | — | — |
| `SmallBaseSimonsWood` | — | — | — | — |
| `TownBaseChotain` | 1 | — | — | — |

### Conflict — `{23FD7E11B1EEED40}Missions/Conflict_West.conf`

| `m_sBaseName` | `m_bIsControlPoint` | `m_bCanBeHQ` | `m_bDisableWhenUnusedAsHQ` | `m_fRadioRange` |
|---|---:|---:|---:|---:|
| `MajorBaseLamentin` | — | — | — | — |
| `MajorBaseMorton` | — | — | — | — |
| `SmallBaseRichemont` | 1 | — | — | — |
| `SmallBaseShepherds` | — | — | — | — |
| `TownBaseLe_Moule` | 1 | — | — | — |
| `MilitaryBaseVilleneuf` | — | — | — | — |

### 4.3 The trap: `Conflict_East` and `Conflict_West`

Those two scenario files list six bases each, and **not one entry sets `m_bCanBeHQ`**. Because a
whitelist entry replaces the flags, all six bases end up unable to be an HQ, and every other base in
the world is excluded by the whitelist. The campaign then has no candidate for a main base:

```
Not enough suitable starting locations found in current setup. Check 'Can Be HQ' attributes in SCR_CampaignMilitaryBaseComponent!
```

and `InitalBaseSetup()` returns before any base is initialized — no HQ, no starting supplies, no
callsigns. This is a reading of the shipped files against the code, not something observed on a
running server: what was verified is that the files set no `m_bCanBeHQ` (they are quoted in full
above), that `ApplyHeaderSettings()` assigns all three booleans unconditionally, and that
`InitalBaseSetup()` requires two candidates. If you write a whitelist, count the `m_bCanBeHQ 1`
entries — two is the number that works.

---

## 5. Writing a list that matches

The value to use is the **Entity name** column, verbatim. A few practical points, all of which are
consequences of §3.4 of the `missionHeader` document rather than new claims:

- `m_sBaseName` is a plain `string` field. The class carries
  `[BaseContainerProps(), SCR_BaseContainerCustomTitleResourceName("m_sBaseName", true)]`, which
  makes the Workbench *display* the field like a resource name; the field is not a `ResourceName`
  and no GUID belongs in it.
- A name that matches nothing changes nothing, silently. There is no log line for a base list that
  misses — the only diagnostic the game writes is the two-HQ complaint of §4.3.
- The comparison is `array<string>.Find()` on the built list: a plain equality search, first match
  wins. **Whether that comparison is case-sensitive in this build was not established** — every
  vanilla list uses exactly the spelling of the world file, so copy the spelling from the table
  instead of testing the question.
- In **blacklist** mode (`m_bCustomBaseWhitelist false`, the default) entries are skipped and their
  settings are not applied at all; the flags in the tables are then exactly what the mode uses. In
  **whitelist** mode entries are the only bases used *and* their flags are applied.

To confirm a name against the installed game instead of trusting this document, read the base list
of one world directly:

```
node tools/ebin.mjs entities "<install>/addons/data/worlds001.pak:worlds/MP/CTI_Campaign_Eden.ent" \
  --filter SCR_CampaignMilitaryBaseComponent --limit 0 --rdb "<install>/addons/data/resourceDatabase.rdb"
```

The `instance of … "Name"` lines are the entity names. An entity whose name is missing on that line
is one of §2.2.

---

## 6. How it was obtained (reproducible)

Four readers from this repository, run against the installed 1.8.0.13 build:

| Step | Command |
|---|---|
| Which world each scenario runs, following `.conf` inheritance | `node tools/pak.mjs cat "<install>/addons/data/data007.pak" Missions/23_Campaign.conf`, then read the `World` line; a `.conf` that begins `Class : "{GUID}Missions/Other.conf"` inherits it |
| The bases in a world, with their entity names and their world overrides | `node tools/ebin.mjs entities "<install>/addons/data/worlds001.pak:worlds/MP/CTI_Campaign_Eden.ent" --filter SCR_CampaignMilitaryBaseComponent --limit 0 --rdb "<install>/addons/data/resourceDatabase.rdb"` |
| Each base's prefab and the flags that prefab inherits | `node tools/etconf.mjs chain "<install>/addons/data/data007.pak:Prefabs/Systems/MilitaryBase/ConflictControlPoint.et" --rdb "<install>/addons/data/resourceDatabase.rdb"`, then `node tools/etconf.mjs get <source> components/SCR_CampaignMilitaryBaseComponent/<field>` for each field |
| The display name a `m_sBaseName` key resolves to | `node tools/loc.mjs get "<install>/addons/data/data007.pak:Language/localization.en_us.conf" "#AR-MapLocation_Figari"` |
| The class defaults a prefab does not override | `node tools/cscript.mjs cat "<install>/addons/data/data007.pak:scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c" 39-61` |

Two things about that method are worth knowing, because getting either wrong changes the answer:

- **A world lists only overridden components.** An entity placed from a base prefab without changing
  its flags has no `SCR_CampaignMilitaryBaseComponent` block in the world at all. Enumerating the
  worlds by grepping for the component name finds 64 bases on Everon and 10 on Kolguyev; resolving
  the prefab chain finds 64 and **26**. The eight `ConflictSourceBase_*` prefabs on Kolguyev inherit
  the component from `ConflictBase_Base.et` two steps up their chain.
- **An unexpanded prefab group is not one entity.** Members of a group are written as bare blocks;
  the group header carries the prefab. Counting headers as entities inflates Everon by two and
  Kolguyev by six.

[`tools/verify-bases.mjs`](../../tools/verify-bases.mjs) automates the whole derivation, parses the
tables of this document and prints a per-world comparison; it exits non-zero when a row disagrees
with the install. Last run against 1.8.0.13: 7/7 worlds, 168/168 bases, 0 differences.

---

## 7. Boundaries of reliability

- **What the engine does with an empty entity name was not observed.** The claim is that such a base
  cannot be named in a list, which follows from the comparison being against `GetName()`. Whether
  the engine fills a name in on load — which would make them addressable by a name this document
  cannot know — is not established here. Treat them as unaddressable and check in the Workbench.
- **Case sensitivity of the match is unknown** (§5).
- **Behaviour of the mode after a whitelist** — supplies, radio, victory — is described in the
  `missionHeader` document from the code; nothing in this document was observed on a running server.
  What *is* mechanical here is the data: entity names, prefabs, flags and their localization.
- **Mods move and add bases.** An addon can re-place a base, rename an entity or ship its own world.
  The tables describe the vanilla install only; for a modded world, read that world with the command
  in §6.
- **`SCR_CampaignCustomBase` has no field for `m_bIsSupplyHub`** and none for `m_eType`, so the
  "Supply hub" and "Type" columns are information, not settings.

---

## 8. Sources

| What | From where |
|---|---|
| The seven worlds, their bases, entity names, prefab GUIDs and world overrides | `addons/data/worlds001.pak` of the installed 1.8.0.13 client, read with [`tools/ebin.mjs`](../../tools/ebin.mjs) |
| The prefab chains and the values each prefab stores | `addons/data/data007.pak`, read with [`tools/etconf.mjs`](../../tools/etconf.mjs) through `resourceDatabase.rdb` |
| The class defaults of the component's campaign fields | `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`, lines 39–58, in the same archive |
| Display names in English and Russian | `Language/localization.en_us.conf` and `ru_ru.conf` in the same archive, read with [`tools/loc.mjs`](../../tools/loc.mjs) |
| Which scenarios use which world, and which of them inherit it | `Missions/*.conf` in the same archive, read with [`tools/pak.mjs`](../../tools/pak.mjs); the scenario GUIDs are the ones in [`data/scenarios.json`](../../data/scenarios.json) |
| The four shipped base lists | `Missions/23_Campaign_NorthCentral.conf`, `23_Campaign_SWCoast.conf`, `Conflict_East.conf`, `Conflict_West.conf`, quoted from the archive |
| What a list does with the names, and the two-HQ requirement | `scripts/Game/GameMode/SCR_GameModeCampaign.c` lines 615–684 and `SCR_CampaignMilitaryBaseComponent.c` lines 664–693, analysed in [the `missionHeader` document](ArmaReforger_MissionHeader_EN.md#34-ma-campaigncustombaselist--custom-base-list) |
