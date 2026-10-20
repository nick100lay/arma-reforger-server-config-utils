# Справочник сценариев Arma Reforger

**Сборка, на которой проверено:** Arma Reforger 1.8.0.13 (engine 192142). Все 42 записи сверены
с установленной сборкой по её `resourceDatabase.rdb` — команда для повторения приведена в
примечании под таблицей кодовых имён ниже. Имена в двух последних колонках таблиц сценариев
прочитаны оттуда же: `m_sName` из заголовка миссии, разрешённый через русскую таблицу строк.

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
> `worlds/GameMaster/GM_Cain.ent` и называет себя `#AR-Editor_Mission_GM_Kolguyev_Name`,
> а `Missions/23_Campaign.conf` — на `worlds/MP/CTI_Campaign_Eden.ent` с именем
> `#AR-Campaign_ScenarioName_Everon`. Полный разбор — в
> [`ArmaReforger_MissionHeader_RU.md`](ArmaReforger_MissionHeader_RU.md) §2.1.
>
> Поэтому в таблицах ниже сценарии Колгуева подписаны через `Cain` — именно так они
> и называются в `scenarioId`. Карту ищите по отображаемому имени, строку берите отсюда.


**Как получено (воспроизводимо):** GUID извлечены из
`<Dedicated Server>\addons\data\resourceDatabase.rdb`. В этом файле запись ресурса хранится как
`[u32 длина пути, включая его NUL][путь UTF-8][0x00][6 байт][GUID — 8 байт little-endian]`, то
есть GUID начинается через 7 байт после терминатора пути. Корректность метода проверена сверкой
с 8 GUID, опубликованными в вики BI (`23_Campaign`, `21_GM_Eden`, `22_GM_Arland`, `Tutorial`,
`CAH_Castle`, `CAH_Factory`, `CAH_LeMoule`, `CAH_Morton`) — **все 8 совпали**, — и
[`tools/rdb.mjs`](../../tools/rdb.mjs) повторяет эту самопроверку по запросу:

```bash
npm run rdb -- verify "<Dedicated Server>/addons/data/resourceDatabase.rdb"
```

`get` превращает GUID в путь, а `guid` — путь в GUID, который нужен для `scenarioId`.
Оба идут по записям с их объявленной длиной, поэтому кандидат, который не является ресурсом,
за ресурс не выдаётся.

Колонки с именами читаются из той же установки двумя штатными читателями этого репозитория —
текст заголовка миссии через `etconf`, таблицу строк через `loc`:

```bash
npm run etconf -- get "<Dedicated Server>/addons/data/data002.pak:Missions/23_Campaign.conf" m_sName
npm run loc -- get "<Dedicated Server>/addons/data/data002.pak:Language/localization.ru_ru.conf" "#AR-Campaign_ScenarioName_Everon"
```

Первая команда печатает `m_sName = "#AR-Campaign_ScenarioName_Everon"`, вторая — `Conflict — Эверон`.
[`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs) делает это сразу для
всех 38 заголовков: перечитывает `m_sName`, разрешает каждый ключ через установленную таблицу
`en_us` и сверяет обе колонки с [`data/scenarios.json`](../../data/scenarios.json). В
`data002.pak` выделенного сервера и в `data007.pak` клиента лежат одни и те же 38 заголовков —
чтение из любого дало одинаковые имена.

> Эти GUID — идентификаторы ресурсов и не меняются между патчами. Список ниже прочитан из
> `resourceDatabase.rdb` сборки 1.8.0.13 (`ArmaReforgerServer.exe` v1.8.0.13, engine 192142),
> и **все 42 записи** (38 сценариев и 4 мира) сверены с этой же базой. Воспроизводится
> командой [`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs),
> которая отказывается что-либо сравнивать, пока её собственный парсер не воспроизведёт
> 8 GUID, опубликованных в вики.

## Официальные сценарии

Колонка «Сценарий» — название, принятое в этом документе; кодовое имя в скобках — то, что вы
увидите в пути к `.conf`. Две последние колонки — ответ самой игры: значение `m_sName` в заголовке
миссии и оно же, разрешённое через таблицу строк (`Language/localization.ru_ru.conf` здесь,
`en_us` — в английском документе). Именно так сценарий и называется в игре.

Дефис в колонке «В игре» — это текст игры, а не опечатка вместо тире из названий:
`#AR-Campaign_ScenarioName_Everon` в английской таблице даёт `Conflict - Everon`, и оно
процитировано как есть.

| Сценарий | `scenarioId` | Имя (`m_sName`) | В игре |
|---|---|---|---|
| Conflict — Эверон (Eden) | `{ECC61978EDCC2B5A}Missions/23_Campaign.conf` | `#AR-Campaign_ScenarioName_Everon` | Conflict — Эверон |
| Conflict — Arland | `{C41618FD18E9D714}Missions/23_Campaign_Arland.conf` | `#AR-MainMenu_ConflictArland_Name` | Conflict — Арланд |
| Conflict — **Колгуев (Cain)** | `{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf` | *(литеральное имя)* | Conflict - Kolguyev |
| Conflict — Северный Эверон (Eden) | `{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf` | `#AR-Campaign_SmallScenarioName_NorthCentral` | Conflict — Северный Эверон |
| Conflict — Южный Эверон (Eden) | `{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf` | `#AR-Campaign_SmallScenarioName_SWCoast` | Conflict — Южный Эверон |
| Conflict — Западный Эверон (Eden) | `{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf` | `#AR-Campaign_SmallScenarioName_WestCoast` | Conflict — Западный Эверон |
| Conflict — Montignac (Eden) | `{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf` | `#AR-Campaign_SmallScenarioName_Montignac` | Conflict — Монтиньяк |
| Conflict — HQC Arland | `{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf` | `#AR-Campaign_HQC_ScenarioName_Arland` | Conflict: Командующий — Арланд |
| Conflict — HQC **Колгуев (Cain)** | `{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf` | `#AR-Campaign_HQC_ScenarioName_Cain` | Conflict: Командующий — Колгуев |
| Conflict — HQC Эверон (Eden) | `{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf` | `#AR-Campaign_HQC_ScenarioName_Everon` | Conflict: Командующий — Эверон |
| Conflict — без ИИ | `{98D1DA94DD085044}Missions/ConflictWithoutAIs.conf` | `#AR-Campaign_GamemodeName` | Conflict |
| Conflict — East | `{8C8EDD6FAE093FFF}Missions/Conflict_East.conf` | `#AR-Campaign_GamemodeName` | Conflict |
| Conflict — West | `{23FD7E11B1EEED40}Missions/Conflict_West.conf` | `#AR-Campaign_GamemodeName` | Conflict |
| Combat Ops — Arland | `{DAA03C6E6099D50F}Missions/24_CombatOps.conf` | `#AR-CombatScenarioArland_Name` | Combat Ops — Арланд |
| Combat Ops — Эверон (Everon) | `{DFAC5FABD11F2390}Missions/26_CombatOpsEveron.conf` | `#AR-CombatScenarioEveron_Name` | Combat Ops — Эверон |
| Combat Ops — **Колгуев (Cain)** | `{CB347F2F10065C9C}Missions/CombatOpsCain.conf` | `#AR-COK_Name` | Combat Ops — Колгуев |
| Game Master — Эверон (Eden) | `{59AD59368755F41A}Missions/21_GM_Eden.conf` | `#AR-Editor_Mission_GM_Eden_Name` | Game Master — Эверон |
| Game Master — Arland | `{2BBBE828037C6F4B}Missions/22_GM_Arland.conf` | `#AR-Editor_Mission_GM_Arland_Name` | Game Master — Арланд |
| Game Master — **Колгуев (Cain)** | `{F45C6C15D31252E6}Missions/27_GM_Cain.conf` | `#AR-Editor_Mission_GM_Kolguyev_Name` | Game Master — Колгуев |
| Capture & Hold: Briars | `{3F2E005F43DBD2F8}Missions/CAH_Briars_Coast.conf` | `#AR-CAH-Scenario_Name_The_Briars` | Capture & Hold — Дикие поля |
| Capture & Hold: Montfort Castle | `{F1A1BEA67132113E}Missions/CAH_Castle.conf` | `#AR-CAH-Scenario_Name_Montfort_Castle` | Capture & Hold — Замок Монфорт |
| Capture & Hold: Concrete Plant | `{589945FB9FA7B97D}Missions/CAH_Concrete_Plant.conf` | `#AR-CAH-Scenario_Name_Concrete_Plant` | Capture & Hold — Бетонный завод |
| Capture & Hold: Almara Factory | `{9405201CBD22A30C}Missions/CAH_Factory.conf` | `#AR-CAH-Scenario_Name_Almara_Factory` | Capture & Hold — Завод Almara |
| Capture & Hold: Almara Factory (FIA) | `{465564323DED44EC}Missions/CAH_Factory - FIA.conf` | `#AR-CAH-Scenario_Name_Almara_Factory` | Capture & Hold — Завод Almara |
| Capture & Hold: Simon's Wood | `{1CD06B409C6FAE56}Missions/CAH_Forest.conf` | `#AR-CAH-Scenario_Name_Simons_Wood` | Capture & Hold — Лес Саймона |
| Capture & Hold: Simon's Wood (FIA) | `{654ADBC0BBB7DFBF}Missions/CAH_Forest - FIA.conf` | `#AR-CAH-Scenario_Name_Simons_Wood` | Capture & Hold — Лес Саймона |
| Capture & Hold: Le Moule | `{7C491B1FCC0FF0E1}Missions/CAH_LeMoule.conf` | `#AR-CAH-Scenario_Name_Le_Moule` | Capture & Hold — Ле—Муль |
| Capture & Hold: Camp Blake | `{6EA2E454519E5869}Missions/CAH_Military_Base.conf` | `#AR-CAH-Scenario_Name_Camp_Blake` | Capture & Hold — Лагерь Блейк |
| Capture & Hold: Morton | `{2B4183DF23E88249}Missions/CAH_Morton.conf` | `#AR-CAH-Scenario_Name_Morton` | Capture & Hold — Мортон |
| Training | `{002AF7323E0129AF}Missions/Tutorial.conf` | `#AR-Tutorial_Name` | Обучение |

> **Три миссии называются одинаково, а ещё две пары делят одно имя.** `ConflictWithoutAIs.conf`,
> `Conflict_East.conf` и `Conflict_West.conf` несут один и тот же `#AR-Campaign_GamemodeName`,
> который разрешается в **`Conflict`**: в списке их не отличить по имени, а «без ИИ», «East» и
> «West» — подписи этого документа, а не игры. Так же `CAH_Factory.conf` и `CAH_Factory - FIA.conf`
> несут общий `#AR-CAH-Scenario_Name_Almara_Factory`, а `CAH_Forest.conf` и `CAH_Forest - FIA.conf`
> — общий `#AR-CAH-Scenario_Name_Simons_Wood`: файлы разные, имя одно.
>
> **`Conflict - Kolguyev` — литеральное имя, а не ключ.** В `23_Campaign_Cain.conf` записано
> `m_sName "Conflict - Kolguyev"` без `#`, поэтому искать в таблице нечего и переводить нечего:
> в русской игре будет тот же английский текст. Поэтому в колонке «Имя» стоит *(литеральное имя)*,
> а не повтор значения, которое и так видно в соседней колонке.

## Одиночные сценарии (в мультиплеере обычно не используются)

| Сценарий | `scenarioId` | Имя (`m_sName`) | В игре |
|---|---|---|---|
| Scenario 01 — Intro | `{10B8582BAD9F7040}Missions/Scenario01_Intro.conf` | `#AR-KS01_Name_Medium` | «Омега» 01: Там, за туманами... |
| Scenario 02 — Steal | `{1D76AF6DC4DF0577}Missions/Scenario02_Steal.conf` | `#AR-KS02_Name_Medium` | «Омега» 02: Радиоразведка |
| Scenario 03 — Villa | `{D1647575BCEA5A05}Missions/Scenario03_Villa.conf` | `#AR-KS03_Name_Medium` | «Омега» 03: Свет во тьме |
| Scenario 04 — Sabotage | `{6D224A109B973DD8}Missions/Scenario04_Sabotage.conf` | `#AR-KS04_Name_Medium` | «Омега» 04: Красная тишина |
| Scenario 05 — Hill | `{FA2AB0181129CB16}Missions/Scenario05_Hill.conf` | `#AR-KS05_Name_Medium` | «Омега» 05: Скалистая развязка |
| SP01 — Regina V2 | `{C47A1A6245A13B26}Missions/SP01_ReginaV2.conf` | `#AR-SP01_Name` | Ликвидация |
| SP02 — Air Support | `{0648CDB32D6B02B3}Missions/SP02_AirSupport.conf` | `#AR-SP02_Name` | Поддержка с воздуха |
| MpTest | `{83D06A42096F671C}Missions/MpTest/10_MpTest.conf` | *(литеральное имя)* | Multiplayer Test |

> **Пять сюжетных миссий в игре называются не «Scenario 01–05».** В их заголовках стоят
> `#AR-KS01_Name_Medium` … `#AR-KS05_Name_Medium`, которые дают **«Омега» 01: Там, за
> туманами...** … **«Омега» 05: Скалистая развязка**; имена файлов и подписи выше — названия
> разработчиков. `SP01_ReginaV2.conf` называет себя **«Ликвидация»** (`#AR-SP01_Name` — «Regina V2»
> есть только в имени файла), а в `10_MpTest.conf` лежит литеральное `Multiplayer Test`, которое
> не переводится по той же причине, что и `Conflict - Kolguyev` выше.

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
В `*_SMD.conf` нет никакого имени — каждый из них `ShoreMapConfig`, блок настроек рельефа и
береговой линии, — поэтому колонки «В игре» в этой таблице нет.

| Террейн | GUID конфига |
|---|---|
| Эверон (кодовое имя `Eden`) | `{B8754CE1921C0BE2}worlds/Eden/Eden_SMD.conf` |
| Arland | `{DDF31662E0615ED7}worlds/Arland/Arland_SMD.conf` |
| **Колгуев (кодовое имя `Cain`)** | `{FCF0E8D9C8601BEA}worlds/Cain/Cain_SMD.conf` |
| Пустой Колгуев (для подсцены) | `{FCE37F2404664D00}worlds/Cain/EmptyCain_SMD.conf` |

> Пустые миры для подсцены: `worlds/Eden/EmptyEden.ent` — пустой **Эверон**,
> `worlds/Cain/EmptyCain.ent` — пустой **Колгуев**.

