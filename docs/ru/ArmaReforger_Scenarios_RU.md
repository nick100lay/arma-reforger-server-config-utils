# Справочник сценариев Arma Reforger (сборка 1.6.0.119)

Готовые строки для поля `game.scenarioId`. Скопировать целиком, вместе с `{GUID}`.

> ### ⚠️ Кодовые имена карт: Cain = Колгуев, Eden = Эверон
>
> **В путях и именах файлов используются исторические кодовые имена карт, а не те,
> что видны в интерфейсе.** Файла «Kolguyev» в игре нет вообще — карта Колгуев лежит
> в `worlds/Cain/`, а её название задано ключом локализации
> `#AR-Editor_Mission_GM_Kolguyev_Name`.
>
> | Кодовое имя (в файлах) | Отображаемое имя |
> |---|---|
> | `Cain` | **Колгуев / Kolguyev** |
> | `Eden` | **Эверон / Everon** |
> | `Arland` | Arland |
>
> Подтверждение — в самих ванильных конфигах: `Missions/27_GM_Cain.conf` ссылается на
> `worlds/CapeMaster/GM_Cain.ent` и называет себя `#AR-Editor_Mission_GM_Kolguyev_Name`,
> а `Missions/23_Campaign.conf` — на `worlds/MP/CTI_Campaign_Eden.ent` с именем
> `#AR-Campaign_ScenarioName_Everon`. Полный разбор — в
> [`ArmaReforger_MissionHeader_RU.md`](ArmaReforger_MissionHeader_RU.md) §2.1.
>
> Поэтому в таблицах ниже сценарии Колгуева подписаны через `Cain` — именно так они
> и называются в `scenarioId`. Карту ищите по отображаемому имени, строку берите отсюда.


**Как получено (воспроизводимо):** GUID извлечены из
`<Dedicated Server>\addons\data\resourceDatabase.rdb`. В этом файле запись ресурса
хранится как `[u32 длина][путь UTF-8][0x00][6 байт][GUID — 8 байт little-endian]`.
Корректность метода проверена сверкой с 8 GUID, опубликованными в вики BI
(`23_Campaign`, `21_GM_Eden`, `22_GM_Arland`, `Tutorial`, `CAH_Castle`, `CAH_Factory`,
`CAH_LeMoule`, `CAH_Morton`) — **все 8 совпали**.

Скрипт извлечения: [`tools/extract-guid-table.ps1`](../../tools/extract-guid-table.ps1).
Его же можно применить к любой другой папке ресурсов (например `worlds/`, `Prefabs/`),
поменяв параметр `-Filter`.

> Эти GUID — идентификаторы ресурсов и не меняются между патчами. Список ниже
> соответствует сборке 1.6.0.119 (проверено на `ArmaReforgerServer.exe` v1.6.0.119,
> engine 192142).
>
> Это свойство было проверено на более новой сборке: в установке **1.8.0.13** все 42 записи
> ниже (38 сценариев и 4 мира) не изменились в `resourceDatabase.rdb`. Воспроизводится
> командой [`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs),
> которая отказывается что-либо сравнивать, пока её собственный парсер не воспроизведёт
> 8 GUID, опубликованных в вики.

## Официальные сценарии

В колонке «Сценарий» слева — как карта называется в интерфейсе, в скобках — кодовое имя,
которое вы увидите в пути к `.conf`.

| Сценарий | `scenarioId` |
|---|---|
| Conflict — Эверон (Eden) | `{ECC61978EDCC2B5A}Missions/23_Campaign.conf` |
| Conflict — Arland | `{C41618FD18E9D714}Missions/23_Campaign_Arland.conf` |
| Conflict — **Колгуев (Cain)** | `{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf` |
| Conflict — Северный Эверон (Eden) | `{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf` |
| Conflict — Южный Эверон (Eden) | `{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf` |
| Conflict — Западный Эверон (Eden) | `{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf` |
| Conflict — Montignac (Eden) | `{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf` |
| Conflict — HQC Arland | `{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf` |
| Conflict — HQC **Колгуев (Cain)** | `{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf` |
| Conflict — HQC Эверон (Eden) | `{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf` |
| Conflict — без ИИ | `{98D1DA94DD085044}Missions/ConflictWithoutAIs.conf` |
| Conflict — East | `{8C8EDD6FAE093FFF}Missions/Conflict_East.conf` |
| Conflict — West | `{23FD7E11B1EEED40}Missions/Conflict_West.conf` |
| Combat Ops — Arland | `{DAA03C6E6099D50F}Missions/24_CombatOps.conf` |
| Combat Ops — Эверон (Everon) | `{DFAC5FABD11F2390}Missions/26_CombatOpsEveron.conf` |
| Combat Ops — **Колгуев (Cain)** | `{CB347F2F10065C9C}Missions/CombatOpsCain.conf` |
| Game Master — Эверон (Eden) | `{59AD59368755F41A}Missions/21_GM_Eden.conf` |
| Game Master — Arland | `{2BBBE828037C6F4B}Missions/22_GM_Arland.conf` |
| Game Master — **Колгуев (Cain)** | `{F45C6C15D31252E6}Missions/27_GM_Cain.conf` |
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

## Одиночные сценарии (в мультиплеере обычно не используются)

| Сценарий | `scenarioId` |
|---|---|
| Scenario 01 — Intro | `{10B8582BAD9F7040}Missions/Scenario01_Intro.conf` |
| Scenario 02 — Steal | `{1D76AF6DC4DF0577}Missions/Scenario02_Steal.conf` |
| Scenario 03 — Villa | `{D1647575BCEA5A05}Missions/Scenario03_Villa.conf` |
| Scenario 04 — Sabotage | `{6D224A109B973DD8}Missions/Scenario04_Sabotage.conf` |
| Scenario 05 — Hill | `{FA2AB0181129CB16}Missions/Scenario05_Hill.conf` |
| SP01 — Regina V2 | `{C47A1A6245A13B26}Missions/SP01_ReginaV2.conf` |
| SP02 — Air Support | `{0648CDB32D6B02B3}Missions/SP02_AirSupport.conf` |
| MpTest | `{83D06A42096F671C}Missions/MpTest/10_MpTest.conf` |

## Свой сценарий (мод)

Для миссии из мода строка выглядит так же, но GUID — из `<ВашаМиссия>.conf.meta`
(поле `Name`). Пример:

```
{GUID из .meta}Missions/MyMission.conf
```

Если `.meta` нет — ресурс не зарегистрирован, и сервер его не найдёт.
См. основной документ, раздел «Проверка и частые ошибки».

## Террейны (для mission header и Workbench)

Эти GUID относятся к конфигам террейна (`*_SMD.conf`), а не к `.ent`-файлам мира — для
`missionHeader`/`World` в Workbench нужен GUID самого `.ent` из его `.meta`.

| Террейн | GUID конфига |
|---|---|
| Эверон (кодовое имя `Eden`) | `{B8754CE1921C0BE2}worlds/Eden/Eden_SMD.conf` |
| Arland | `{DDF31662E0615ED7}worlds/Arland/Arland_SMD.conf` |
| **Колгуев (кодовое имя `Cain`)** | `{FCF0E8D9C8601BEA}worlds/Cain/Cain_SMD.conf` |
| Пустой Колгуев (для подсцены) | `{FCE37F2404664D00}worlds/Cain/EmptyCain_SMD.conf` |

> Пустые миры для подсцены: `worlds/Eden/EmptyEden.ent` — пустой **Эверон**,
> `worlds/Cain/EmptyCain.ent` — пустой **Колгуев**.

