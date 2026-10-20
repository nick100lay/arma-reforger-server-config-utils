# Базы в ванильных режимах — полный каталог

Этот документ отвечает на один вопрос: **какую именно строку писать в `m_sBaseName`** и что этой
базе можно сделать. Это каталог всех баз, которые есть в ванильных мирах Conflict: имя сущности,
локализованное отображаемое имя, тип и четыре кампанийных флага.

Сами поля заголовка миссии — как список сопоставляется с базами, что делают blacklist и whitelist,
какой класс заголовка их принимает — разобраны в
[разборе `missionHeader`](ArmaReforger_MissionHeader_RU.md#34-ma-campaigncustombaselist--список-пользовательских-баз),
§3.4. Здесь это объяснение не повторяется: здесь лежат имена, с которыми то объяснение велит
сопоставлять.

**Сборка, на которой проверено:** Arma Reforger 1.8.0.13 (engine 192142) — миры прочитаны из
`worlds001.pak`, префабы и значения класса по умолчанию из `data007.pak`, отображаемые имена из
`Language/localization.*.conf`, всё из установленной сборки. Команды перечислены в §6, а
[`tools/verify-bases.mjs`](../../tools/verify-bases.mjs) заново выводит каждую таблицу ниже из этой
установки и падает, когда они расходятся.

---

## 0. Прочитать первым

Три вещи решают, сработает ли список баз вообще.

1. **Имя — это имя сущности, а не отображаемое имя.** Значение `m_sBaseName` сравнивается с именем
   *сущности* базы в мире — `TownBaseMeaux`, `MajorBaseMorton`, `StartingPos07` — и никогда с тем,
   что показывает карта («Мо», «Береговая база в Мортоне», «Главная оперативная база»). В каждой
   таблице ниже это две разные колонки: отображаемое имя локализовано, имя сущности — нет.
2. **Базы есть только у семейства Conflict.** Из 32 разных миров, которые загружают ванильные
   сценарии, `SCR_CampaignMilitaryBaseComponent` есть ровно в 7 — это семь миров Conflict
   `worlds/MP/CTI_Campaign_*.ent`, и больше нигде (§1). В Combat Ops, Game Master, Capture & Hold,
   Training и во всех шести одиночных сценариях список баз не совпадёт ни с чем, и режим об этом не
   сообщит.
3. **Запись whitelist заменяет флаги базы, а не дополняет их.** Для каждой базы из списка игра
   копирует все четыре поля из вашей записи, поэтому не указанное поле становится значением класса
   по умолчанию (`m_bIsControlPoint` false, `m_bCanBeHQ` false, `m_bDisableWhenUnusedAsHQ` true,
   `m_fRadioRange` -1), а не тем, что было в мире. Чтобы сохранить ванильные значения, переносите
   колонки таблицы. Код, который это делает, процитирован в разборе `missionHeader`, §3.4.

Третий пункт и есть тот, что кусается: whitelist из десяти баз с одними именами превращает каждую
из них в базу без контроля и без возможности стать штабом, а режим, в whitelist которого осталось
меньше двух баз, способных быть штабом, стартует вообще без главной базы — см. §4.3, где именно это
делают два ванильных сценария.

---

## 1. В каких ванильных режимах есть базы

| Семейство режимов | Ванильные сценарии | Мир | Баз | Из них с именем | Без имени |
|---|---|---|---:|---:|---:|
| Conflict — Everon | `23_Campaign`, `23_Campaign_NorthCentral`, `23_Campaign_SWCoast`, `ConflictWithoutAIs`, `Conflict_East`, `Conflict_West` | `worlds/MP/CTI_Campaign_Eden.ent` | 64 | 64 | 0 |
| Conflict — Arland | `23_Campaign_Arland` | `worlds/MP/CTI_Campaign_Arland.ent` | 9 | 9 | 0 |
| Conflict — Kolguyev | `23_Campaign_Cain`, `23_Campaign_HQC_Cain` | `worlds/MP/CTI_Campaign_Cain.ent` | 26 | 12 | 14 |
| Conflict — западный Everon | `23_Campaign_Western` | `worlds/MP/CTI_Campaign_WesternEveron.ent` | 13 | 4 | 9 |
| Conflict — Montignac | `23_Campaign_Montignac` | `worlds/MP/CTI_Campaign_Montignac.ent` | 10 | 10 | 0 |
| Conflict: HQ Commander — Everon | `23_Campaign_HQC_Everon` | `worlds/MP/CTI_Campaign_HQC_Eden.ent` | 35 | 35 | 0 |
| Conflict: HQ Commander — Arland | `23_Campaign_HQC_Arland` | `worlds/MP/CTI_Campaign_HQC_Arland.ent` | 11 | 5 | 6 |
| Combat Ops | `24_CombatOps`, `26_CombatOpsEveron`, `CombatOpsCain`, `SP01_ReginaV2`, `SP02_AirSupport` | `worlds/MP/Coop_CombatOps_*.ent`, `worlds/SP/SP0*` | **0** | — | — |
| Game Master | `21_GM_Eden`, `22_GM_Arland`, `27_GM_Cain` | `worlds/GameMaster/GM_*.ent` | **0** | — | — |
| Capture & Hold | `CAH_Briars_Coast`, `CAH_Castle`, `CAH_Concrete_Plant`, `CAH_Factory`, `CAH_Factory - FIA`, `CAH_Forest`, `CAH_Forest - FIA`, `CAH_LeMoule`, `CAH_Military_Base`, `CAH_Morton` | `worlds/CaptureAndHold/CAH_*.ent` | **0** | — | — |
| Training | `Tutorial` | `worlds/SP/Tutorial/Tutorial.ent` | **0** | — | — |
| Одиночная кампания | `Scenario01`–`Scenario05` | `worlds/SP/Story/Scenario0*` | **0** | — | — |
| Тестовый мультиплеер | `10_MpTest` | `worlds/MP/MpTest/MpTest.ent` | **0** | — | — |

Нулевые строки — это измерение, а не предположение: для каждого из 32 миров, которые называют эти
сценарии, мир был прочитан целиком, и каждая сущность проверена на `SCR_CampaignMilitaryBaseComponent`
— и в её собственном блоке переопределений, **и в любом месте цепочки префабов**. Метод тот же, что
у каталога (§6). В Capture & Hold есть свои точки захвата, но они принадлежат системе этого режима,
а не `SCR_CampaignMilitaryBaseComponent`, и `m_aCampaignCustomBaseList` до них не достаёт.

Два следствия стоит сказать прямо:

- **Список, написанный для одного мира, не переносится на другой.** Одно и то же место в разных
  мирах называется по-разному: `SmallBaseRichemont` на Everon — это *Morton Valley*, а мир HQ
  Commander называет свой Richemont `CP_Regina`. И два мира HQ Commander — это отдельные миры на том
  же ландшафте, с другим набором баз.
- **`23_Campaign_NorthCentral` и `23_Campaign_SWCoast` наследуют `World` из `23_Campaign.conf`**,
  поэтому идут на мире Everon и берут whitelist из 64 баз §3.1. Сценарий, который наследует, строку
  `World` не повторяет.

---

## 2. Как читать таблицы

| Колонка | Что означает |
|---|---|
| **Имя сущности** | Значение `GetOwner().GetName()` для сущности базы — **строка, которой должен быть равен `m_sBaseName`.** |
| **Отображаемое имя** | То, что показывают карта и уведомления о захвате: текст по локализационному ключу из поля `m_sBaseName` компонента. В этом документе это русский текст, в английском документе — английский; как получить любой из остальных одиннадцати языков, сказано в §2.3. |
| **Тип** | `SCR_ECampaignBaseType`: `BASE`, `RELAY` или `SOURCE_BASE`. `RELAY` — ретрансляционная вышка; в ванили используются только `BASE` и `RELAY`. |
| **Точка контроля** | `m_bIsControlPoint` — база идёт в зачёт победы. |
| **Склад снабжения** | `m_bIsSupplyHub` — снабжение считается так же, как на штабе. **Через список баз не задаётся**: поля для него в `SCR_CampaignCustomBase` нет. |
| **Может быть штабом** | `m_bCanBeHQ` — базу можно выбрать главной базой фракции. После списка должно остаться минимум две такие базы, иначе у режима нет штаба. |
| **Отключать, когда не штаб** | `m_bDisableWhenUnusedAsHQ` — когда фракция переносит штаб в другое место, эта база выключается. |

### 2.1 Откуда берётся значение

Файл мира хранит **только то, что отличается от префаба**, поэтому флаг, о котором мир молчит, — не
«выключен», а такой, каким его задаёт цепочка префабов, начинающаяся со значений класса
(`m_bIsControlPoint 0`, `m_bCanBeHQ 0`, `m_bDisableWhenUnusedAsHQ 1`, `m_bIsSupplyHub 0`,
`m_eType BASE`). В таблицах приведено **действующее** значение: значение класса, затем каждый префаб
цепочки от корня вниз, затем переопределение самого мира. Поэтому, например, все базы `CP_*` на
Колгуеве — точки контроля, хотя файл мира нигде этот флаг не задаёт: его задаёт префаб
`ConflictControlPoint.et`.

### 2.2 Базы без имени сущности

У 29 из 168 баз **пустое имя сущности**: редактор мира их не назвал. Это настоящие базы — они
регистрируются, могут быть точками контроля, показывают на карте отображаемое имя — но
`GetOwner().GetName()` для них возвращает пустую строку, поэтому список баз не может адресовать их
по одной, а whitelist их молча выбрасывает. Они приведены второй таблицей в каждом мире, с префабом
и позицией в мире: иначе каталог был бы неполным, а позиция — это то, по чему такую базу узнают в
Workbench.

### 2.3 Отображаемые имена на другом языке

Отображаемое имя — это локализационный ключ (`m_sBaseName`, например `#AR-MapLocation_Figari`),
который разрешается через `Language/localization.<lang>.conf`. Кроме английского поставлются
двенадцать языков, и ключ во всех один и тот же:

```
node tools/loc.mjs get "<install>/addons/data/data007.pak:Language/localization.de_de.conf" "#AR-MapLocation_Figari"
```

Языки: `cs_cz`, `de_de`, `en_us`, `es_es`, `fr_fr`, `it_it`, `ja_jp`, `ko_kr`, `pl_pl`, `pt_br`,
`ru_ru`, `uk_ua` и `zh_cn`. Чего это **не** меняет: значение, которое вы пишете в `m_sBaseName`, —
это имя сущности, оно никогда не локализуется, и переименование отображаемого имени на
сопоставление не влияет.

---

## 3. Каталог

Числа по мирам: баз / с именем / без имени.

### 3.1 `worlds/MP/CTI_Campaign_Eden.ent` — Everon — 64 / 64 / 0

Используют `{ECC61978EDCC2B5A}Missions/23_Campaign.conf` (Conflict - Everon),
`{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf`,
`{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf` (оба наследуют мир),
`{98D1DA94DD085044}Missions/ConflictWithoutAIs.conf`,
`{8C8EDD6FAE093FFF}Missions/Conflict_East.conf` и
`{23FD7E11B1EEED40}Missions/Conflict_West.conf`.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `MainBaseNorth` | Сент-Филипп | `BASE` | да | да | нет | да |
| `MainBaseSouth` | Сент-Пьерр | `BASE` | да | да | нет | да |
| `MajorBaseChotain` | Береговая база в Шотене | `BASE` | да | да | нет | да |
| `MajorBaseLamentin` | Береговая база в Ламантине | `BASE` | да | да | нет | да |
| `MajorBaseMorton` | Береговая база в Мортоне | `BASE` | да | да | нет | да |
| `MilitaryBaseAirfield` | Авиабаза в Сент-Филипп | `BASE` | нет | нет | нет | да |
| `MilitaryBaseLevie` | Военная база в Леви | `BASE` | да | да | нет | да |
| `MilitaryBaseVilleneuf` | Холм Крестных мук | `BASE` | нет | нет | нет | да |
| `MilitaryHospital` | Военный госпиталь | `BASE` | да | да | нет | да |
| `Relay15` | Башня в Ентре-Дё | `RELAY` | нет | нет | нет | да |
| `Relay4` | Башня в Регине | `RELAY` | нет | нет | нет | да |
| `SmallBaseAndresBeacon` | Обзорный пункт Андре | `BASE` | нет | нет | нет | да |
| `SmallBaseBlackLake` | Черное озеро | `BASE` | нет | нет | нет | да |
| `SmallBaseGoatbay` | Камурак | `BASE` | нет | нет | нет | да |
| `SmallBaseHornbeamValley` | Грабовая долина | `BASE` | нет | нет | нет | да |
| `SmallBaseLake` | Сосновое озеро | `BASE` | нет | нет | нет | да |
| `SmallBaseMaidensBay` | Военный склад | `BASE` | нет | нет | нет | да |
| `SmallBaseMine` | Карьер | `BASE` | нет | нет | нет | да |
| `SmallBasePennantsPass` | Перевал Пеннант | `BASE` | нет | нет | нет | да |
| `SmallBaseRichemont` | Долина Мортон | `BASE` | нет | нет | нет | да |
| `SmallBaseShepherds` | Старый лес | `BASE` | нет | нет | нет | да |
| `SmallBaseSimonsWood` | Лес Симона | `BASE` | нет | нет | нет | да |
| `SmallBaseTillersFind` | Находка фермера | `BASE` | нет | нет | нет | да |
| `StartingPos01` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos02` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos03` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos04` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos05` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos06` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos07` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos08` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos09` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos10` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos11` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos12` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos13` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos14` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos15` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos16` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos17` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos18` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos19` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos20` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos21` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos23` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos24` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos25` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos26` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `TownBaseChotain` | Шотен | `BASE` | нет | нет | нет | да |
| `TownBaseDuras` | Дюррас | `BASE` | нет | нет | нет | да |
| `TownBaseEntre_Deux` | Ентре-Дё | `BASE` | нет | нет | нет | да |
| `TownBaseFigari` | Фигари | `BASE` | нет | нет | нет | да |
| `TownBaseGravette` | Граветт | `BASE` | нет | нет | нет | да |
| `TownBaseKermovan` | Кермован | `BASE` | нет | нет | нет | да |
| `TownBaseLaruns` | Ларун | `BASE` | нет | нет | нет | да |
| `TownBaseLe_Moule` | Ле-Муль | `BASE` | нет | нет | нет | да |
| `TownBaseLevie` | Леви | `BASE` | нет | нет | нет | да |
| `TownBaseMeaux` | Мо | `BASE` | нет | нет | нет | да |
| `TownBaseMontignac` | Монтиньяк | `BASE` | нет | нет | нет | да |
| `TownBaseProvins` | Провин | `BASE` | нет | нет | нет | да |
| `TownBaseRegina` | Регина | `BASE` | нет | нет | нет | да |
| `TownBaseTyrone` | Тирон | `BASE` | нет | нет | нет | да |
| `TownBaseVernon` | Вернон | `BASE` | нет | нет | нет | да |
| `TownBaseVileneuf` | Вильнёв | `BASE` | нет | нет | нет | да |

### 3.2 `worlds/MP/CTI_Campaign_Arland.ent` — Arland — 9 / 9 / 0

Использует `{C41618FD18E9D714}Missions/23_Campaign_Arland.conf`.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `AirportNorth` | Аэродромная база | `BASE` | нет | нет | нет | да |
| `ArlevilleBase` | Арлевиль | `BASE` | нет | нет | нет | да |
| `BeauregardBase` | Борегар | `BASE` | да | да | нет | да |
| `Farm` | Ферма | `BASE` | нет | нет | нет | да |
| `HQEast` | Главная оперативная база | `BASE` | нет | нет | да | нет |
| `HQWest` | Главная оперативная база | `BASE` | нет | нет | да | нет |
| `MilitarySouth` | Военный полигон | `BASE` | да | да | нет | да |
| `MossHill` | Заросший холм | `BASE` | нет | нет | нет | да |
| `Tower` | Сигнальный холм | `RELAY` | нет | нет | нет | да |

### 3.3 `worlds/MP/CTI_Campaign_Cain.ent` — Колгуев — 26 / 12 / 14

Используют `{9C6054B42A044DEC}Missions/23_Campaign_Cain.conf` и
`{BB5345C22DD2B655}Missions/23_Campaign_HQC_Cain.conf`. В пути стоит `Cain`, а карта —
Колгуев; почему так, см. §2.1 разбора `missionHeader`.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `Base_MilitaryHQ` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `CP_Crossroad` | Северный перекресток | `BASE` | да | нет | нет | нет |
| `CP_Gorshkovo` | Горшково | `BASE` | да | нет | нет | нет |
| `CP_Kamensk` | Каменск | `BASE` | да | нет | нет | нет |
| `CP_Mine` | Шахта «Красный октябрь» | `BASE` | да | нет | нет | нет |
| `CP_Mineraly` | Минералы | `BASE` | да | нет | нет | нет |
| `CP_Ugoldar` | Угольдар | `BASE` | да | нет | нет | нет |
| `CP_Villa` | Вилла | `BASE` | да | нет | нет | нет |
| `HQ_EastCoast` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `HQ_NE` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `HQ_SW` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `HQ_W` | Главная оперативная база | `BASE` | нет | нет | да | да |

**Базы без имени сущности** — приведены потому, что список полный, а не потому, что их можно использовать:

| Отображаемое имя | Префаб | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб | X | Z |
|---|---|---:|---:|---:|---:|---:|---:|
| База | `ConflictSourceBase_T2Harbor.et` | нет | нет | нет | нет | 1642 | 7386 |
| База | `ConflictSourceBase_Airfield.et` | нет | нет | нет | нет | 2646 | 5367 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 3743 | 3726 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 4356 | 8144 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 6046 | 8444 |
| База | `ConflictSourceBase_T1Harbor.et` | нет | нет | нет | нет | 6817 | 3491 |
| База | `ConflictSourceBase_T2Harbor.et` | нет | нет | нет | нет | 7554 | 4186 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 8583 | 10186 |
| База | `ConflictSourceBase_T2Harbor.et` | нет | нет | нет | нет | 8802 | 7395 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 10054 | 10860 |
| База | `ConflictSourceBase_T2Harbor.et` | нет | нет | нет | нет | 11838 | 10974 |
| База | `ConflictSourceBase_T1Harbor.et` | нет | нет | нет | нет | 12121 | 10520 |
| Башня связи БАРС | `ConflictRelayRadio.et` | нет | нет | нет | да | 6860 | 6781 |
| Ретранслятор на вершине горы | `ConflictRelayRadio.et` | нет | нет | нет | да | 5056 | 6328 |

### 3.4 `worlds/MP/CTI_Campaign_WesternEveron.ent` — западный Everon — 13 / 4 / 9

Использует `{94992A3D7CE4FF8A}Missions/23_Campaign_Western.conf`. У девяти из тринадцати баз нет
имени сущности — это самый наглядный пример мира, в котором список баз не может сказать то, что
хочет: whitelist здесь может назвать только четыре базы из тринадцати.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `Briars` | Дикие поля | `BASE` | нет | нет | нет | да |
| `HQNorth` | Береговая база в Ламантине | `BASE` | нет | нет | да | нет |
| `HQSouth` | Береговая база в Мортоне | `BASE` | нет | нет | да | нет |
| `LongHill` | Длинный холм | `BASE` | нет | нет | нет | да |

**Базы без имени сущности** — приведены потому, что список полный, а не потому, что их можно использовать:

| Отображаемое имя | Префаб | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб | X | Z |
|---|---|---:|---:|---:|---:|---:|---:|
| Вильнёв | `ConflictMilitaryBase.et` | нет | нет | нет | да | 2930 | 5939 |
| Волчий холм | `ConflictMilitaryBase.et` | нет | нет | нет | да | 4129 | 4048 |
| Долина Мортон | `ConflictMilitaryBase.et` | нет | нет | нет | да | 4627 | 4750 |
| Кервель | `ConflictMilitaryBase.et` | нет | нет | нет | да | 2625 | 4892 |
| Ле-Муль | `ConflictMilitaryBase.et` | да | нет | нет | да | 2595 | 5385 |
| Ришмон | `ConflictMilitaryBase.et` | да | нет | нет | да | 3802 | 5006 |
| Сосновое озеро | `ConflictMilitaryBase.et` | нет | нет | нет | да | 4203 | 5533 |
| Старый лес | `ConflictMilitaryBase.et` | нет | нет | нет | да | 3300 | 4463 |
| Холм Крестных мук | `ConflictMilitaryBase.et` | да | нет | нет | да | 3504 | 5819 |

### 3.5 `worlds/MP/CTI_Campaign_Montignac.ent` — Montignac — 10 / 10 / 0

Использует `{FDE33AFE2ED7875B}Missions/23_Campaign_Montignac.conf`.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `Cemetery` | Кладбище | `BASE` | да | нет | нет | да |
| `EntreDeux` | Ентре-Дё | `BASE` | нет | нет | нет | да |
| `Farm` | Ферма | `BASE` | нет | нет | нет | да |
| `FieldBase` | Сосновое озеро | `BASE` | нет | нет | нет | да |
| `FootballField` | Сельскохозяйственный комплекс | `BASE` | да | нет | нет | да |
| `HQEast` | Военная база Бенак | `BASE` | нет | нет | да | нет |
| `HQWest` | Военная база в Вильнёве | `BASE` | нет | нет | да | нет |
| `Industrial` | Промышленный объект | `BASE` | да | нет | нет | да |
| `Lacourt` | Лакур | `BASE` | нет | нет | нет | да |
| `TillersFind` | Находка фермера | `BASE` | нет | нет | нет | да |

### 3.6 `worlds/MP/CTI_Campaign_HQC_Eden.ent` — Everon, HQ Commander — 35 / 35 / 0

Использует `{0220741028718E7F}Missions/23_Campaign_HQC_Everon.conf`. Это **не** мир Conflict на
Everon: это отдельный мир со своим, меньшим набором баз, поэтому список, перенесённый из §3.1,
называет базы, которых здесь нет.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `CP_CalvaryHill` | Холм Крестных мук | `BASE` | да | нет | нет | нет |
| `CP_LevieMilitaryBase` | Военная база в Леви | `BASE` | да | нет | нет | нет |
| `CP_MontignacTown` | Монтиньяк | `BASE` | да | нет | нет | нет |
| `CP_PowerPlant` | Электростанция | `BASE` | да | нет | нет | нет |
| `CP_ProvinsTransformerStation` | Трансформаторная станция | `BASE` | да | нет | нет | нет |
| `CP_Regina` | Регина | `BASE` | да | нет | нет | нет |
| `CP_SaulesIsland` | Иль-о'Соль | `BASE` | да | нет | нет | нет |
| `Relay15` | Башня в Ентре-Дё | `RELAY` | нет | нет | нет | да |
| `Relay4` | Башня в Регине | `RELAY` | нет | нет | нет | да |
| `SP_A_EveronAirport` | База | `BASE` | нет | нет | нет | нет |
| `SP_T1H_StPhillipe` | База | `BASE` | нет | нет | нет | нет |
| `SP_T1H_StPierre` | База | `BASE` | нет | нет | нет | нет |
| `SP_T2H_FishermansBay` | База | `BASE` | нет | нет | нет | нет |
| `SP_T2H_Lamentin` | База | `BASE` | нет | нет | нет | нет |
| `SP_T2H_Meaux` | База | `BASE` | нет | нет | нет | нет |
| `SP_T2H_MilitaryHospital` | База | `BASE` | нет | нет | нет | нет |
| `SP_T2H_Morton` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_GoatBay` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_Gravette` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_HalcyonStrait` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_Kermovan` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_Lancre` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_Laruns` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_LeBosc` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_Perelle` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_SpaniardsBay` | База | `BASE` | нет | нет | нет | нет |
| `SP_T3H_Thollevast` | База | `BASE` | нет | нет | нет | нет |
| `StartingPos05` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos07` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos09` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos12` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos14` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos15` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos19` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `StartingPos21` | Главная оперативная база | `BASE` | нет | нет | да | да |

### 3.7 `worlds/MP/CTI_Campaign_HQC_Arland.ent` — Arland, HQ Commander — 11 / 5 / 6

Использует `{68D1240A11492545}Missions/23_Campaign_HQC_Arland.conf`, и это снова другой мир, не
тот, что в §3.2.

| Имя сущности | Отображаемое имя | Тип | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб |
|---|---|---|---:|---:|---:|---:|
| `BeauregardBase` | Борегар | `BASE` | да | нет | нет | нет |
| `GullIsland` | Остров чаек | `BASE` | да | нет | нет | нет |
| `HQEast` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `HQWest` | Главная оперативная база | `BASE` | нет | нет | да | да |
| `Tower` | Сигнальный холм | `RELAY` | нет | нет | нет | да |

**Базы без имени сущности** — приведены потому, что список полный, а не потому, что их можно использовать:

| Отображаемое имя | Префаб | Точка контроля | Склад снабжения | Может быть штабом | Отключать, когда не штаб | X | Z |
|---|---|---:|---:|---:|---:|---:|---:|
| База | `ConflictSourceBase_Airfield.et` | нет | нет | нет | нет | 1372 | 2934 |
| База | `ConflictSourceBase_T2Harbor.et` | нет | нет | нет | нет | 1493 | 1848 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 1673 | 902 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 2398 | 3268 |
| База | `ConflictSourceBase_T2Harbor.et` | нет | нет | нет | нет | 3170 | 1168 |
| База | `ConflictSourceBase_T3Harbor.et` | нет | нет | нет | нет | 3558 | 1540 |

---

## 4. Списки, которые поставляет сама ваниль

В четырёх сценариях есть `m_aCampaignCustomBaseList`, и во всех четырёх стоит
`m_bCustomBaseWhitelist 1`. Это рабочие примеры, с которых стоит копировать.

### 4.1 Что у них общего

- **Каждая запись во всех четырёх списках называет существующую базу** мира этого сценария — 31
  запись, 31 попадание, ни опечаток, ни остатков (§6 это проверяет).
- **Два сценария, в которые играют, помечают по две базы штабами.** Северный и южный Everon ставят
  `m_bCanBeHQ 1` и `m_bDisableWhenUnusedAsHQ 0` двум базам и задают этим двум `m_fRadioRange 2000`.
  Это минимум, который нужен whitelist, чтобы режим работал: два переносимых штаба.
  `Conflict_East` и `Conflict_West` не помечают ни одной — см. §4.3.
- **Все остальные записи — это один `m_sBaseName`.** Всё, о чём запись молчит, становится значением
  класса по умолчанию: не точка контроля, не штаб, отключается, когда не штаб, — кроме одной-двух
  записей, которые явно ставят `m_bIsControlPoint 1`.

### 4.2 Эти четыре списка

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

### 4.3 Ловушка: `Conflict_East` и `Conflict_West`

Эти два файла сценариев перечисляют по шесть баз, и **ни одна запись не задаёт `m_bCanBeHQ`**.
Поскольку запись whitelist заменяет флаги, все шесть баз остаются неспособными быть штабом, а все
остальные базы мира whitelist исключает. Кандидатов в главную базу у кампании не остаётся:

```
Not enough suitable starting locations found in current setup. Check 'Can Be HQ' attributes in SCR_CampaignMilitaryBaseComponent!
```

и `InitalBaseSetup()` выходит до инициализации любой базы — ни штаба, ни стартового снабжения, ни
позывных. Это чтение поставленных файлов вместе с кодом, а не наблюдение на запущенном сервере:
проверено, что файлы не задают `m_bCanBeHQ` (они процитированы выше целиком), что
`ApplyHeaderSettings()` присваивает все три булевых поля безусловно и что `InitalBaseSetup()`
требует двух кандидатов. Если пишете whitelist — считайте записи с `m_bCanBeHQ 1`; работающее
число — два.

---

## 5. Как написать список, который совпадёт

Значение берётся из колонки **Имя сущности**, дословно. Несколько практических замечаний — все они
следствия §3.4 разбора `missionHeader`, а не новые утверждения:

- `m_sBaseName` — обычное поле типа `string`. У класса стоит
  `[BaseContainerProps(), SCR_BaseContainerCustomTitleResourceName("m_sBaseName", true)]`, из-за чего
  Workbench *показывает* поле как имя ресурса; полем `ResourceName` оно не является, и GUID в него
  писать не нужно.
- Имя, которое ни с чем не совпало, не меняет ничего — молча. Строки в логе о промахе списка нет;
  единственная диагностика, которую игра пишет, — жалоба на два штаба из §4.3.
- Сравнение — это `array<string>.Find()` по собранному списку: обычный поиск равенства, побеждает
  первое совпадение. **Чувствительно ли это сравнение к регистру в данной сборке, не установлено** —
  все ванильные списки используют ровно то написание, что в файле мира, поэтому копируйте написание
  из таблицы, а не проверяйте этот вопрос на практике.
- В режиме **blacklist** (`m_bCustomBaseWhitelist false`, значение по умолчанию) записи
  пропускаются, а их настройки не применяются вообще; флаги в таблицах — это тогда ровно то, с чем
  работает режим. В режиме **whitelist** записи — единственные используемые базы, и их флаги
  применяются.

Чтобы сверить имя с установленной игрой, а не верить этому документу, прочитайте список баз одного
мира напрямую:

```
node tools/ebin.mjs entities "<install>/addons/data/worlds001.pak:worlds/MP/CTI_Campaign_Eden.ent" \
  --filter SCR_CampaignMilitaryBaseComponent --limit 0 --rdb "<install>/addons/data/resourceDatabase.rdb"
```

Строки `instance of … "Имя"` — это имена сущностей. Сущность, у которой имени в этой строке нет, —
одна из §2.2.

---

## 6. Как это получено (воспроизводимо)

Четыре читателя из этого репозитория, запущенные на установленной сборке 1.8.0.13:

| Шаг | Команда |
|---|---|
| Какой мир у сценария, с учётом наследования `.conf` | `node tools/pak.mjs cat "<install>/addons/data/data007.pak" Missions/23_Campaign.conf`, затем строка `World`; `.conf`, начинающийся с `Class : "{GUID}Missions/Other.conf"`, её наследует |
| Базы мира, с именами сущностей и переопределениями мира | `node tools/ebin.mjs entities "<install>/addons/data/worlds001.pak:worlds/MP/CTI_Campaign_Eden.ent" --filter SCR_CampaignMilitaryBaseComponent --limit 0 --rdb "<install>/addons/data/resourceDatabase.rdb"` |
| Префаб каждой базы и флаги, которые он наследует | `node tools/etconf.mjs chain "<install>/addons/data/data007.pak:Prefabs/Systems/MilitaryBase/ConflictControlPoint.et" --rdb "<install>/addons/data/resourceDatabase.rdb"`, затем `node tools/etconf.mjs get <источник> components/SCR_CampaignMilitaryBaseComponent/<поле>` по каждому полю |
| Текст, в который разрешается ключ `m_sBaseName` | `node tools/loc.mjs get "<install>/addons/data/data007.pak:Language/localization.ru_ru.conf" "#AR-MapLocation_Figari"` |
| Значения класса, которые префаб не переопределяет | `node tools/cscript.mjs cat "<install>/addons/data/data007.pak:scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c" 39-61` |

Две вещи в этом методе стоит знать, потому что ошибка в любой из них меняет ответ:

- **Мир перечисляет только переопределённые компоненты.** У сущности, поставленной из префаба базы
  без изменения флагов, блока `SCR_CampaignMilitaryBaseComponent` в мире нет вообще. Перечисление
  миров поиском по имени компонента находит 64 базы на Everon и 10 на Колгуеве; разрешение цепочки
  префабов находит 64 и **26**. Восемь префабов `ConflictSourceBase_*` на Колгуеве наследуют
  компонент от `ConflictBase_Base.et` двумя шагами выше по цепочке.
- **Неразвёрнутая группа префабов — это не одна сущность.** Участники группы записаны голыми
  блоками, префаб несёт заголовок группы. Если считать заголовки сущностями, Everon вырастает на
  две, а Колгуев на шесть.

[`tools/verify-bases.mjs`](../../tools/verify-bases.mjs) автоматизирует весь вывод, разбирает
таблицы этого документа и печатает сравнение по мирам; при расхождении он выходит с ненулевым кодом.
Последний прогон на 1.8.0.13: 7/7 миров, 168/168 баз, 0 расхождений.

---

## 7. Границы достоверности

- **Что движок делает с пустым именем сущности, не наблюдалось.** Утверждение, что такую базу нельзя
  назвать в списке, следует из того, что сравнение идёт с `GetName()`. Заполняет ли движок имя при
  загрузке — а тогда они были бы адресуемы именем, которого этот документ знать не может — здесь не
  установлено. Считайте их неадресуемыми и проверяйте в Workbench.
- **Чувствительность сравнения к регистру неизвестна** (§5).
- **Поведение режима после whitelist** — снабжение, радио, победа — описано в разборе
  `missionHeader` по коду; ничего в этом документе не наблюдалось на запущенном сервере. Что здесь
  механическое — это данные: имена сущностей, префабы, флаги и их локализация.
- **Моды двигают и добавляют базы.** Мод может переставить базу, переименовать сущность или
  поставить свой мир. Таблицы описывают только ванильную установку; для модового мира читайте этот
  мир командой из §6.
- **В `SCR_CampaignCustomBase` нет поля для `m_bIsSupplyHub`** и нет для `m_eType`, поэтому колонки
  «Склад снабжения» и «Тип» — это сведения, а не настройки.

---

## 8. Источники

| Что | Откуда |
|---|---|
| Семь миров, их базы, имена сущностей, GUID префабов и переопределения мира | `addons/data/worlds001.pak` установленного клиента 1.8.0.13, прочитано [`tools/ebin.mjs`](../../tools/ebin.mjs) |
| Цепочки префабов и значения, которые хранит каждый префаб | `addons/data/data007.pak`, прочитано [`tools/etconf.mjs`](../../tools/etconf.mjs) через `resourceDatabase.rdb` |
| Значения класса по умолчанию для кампанийных полей компонента | `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`, строки 39–58, там же |
| Отображаемые имена на английском и русском | `Language/localization.en_us.conf` и `ru_ru.conf` там же, прочитано [`tools/loc.mjs`](../../tools/loc.mjs) |
| Какой сценарий на каком мире и какие наследуют мир | `Missions/*.conf` там же, прочитано [`tools/pak.mjs`](../../tools/pak.mjs); GUID сценариев — из [`data/scenarios.json`](../../data/scenarios.json) |
| Четыре поставляемых списка баз | `Missions/23_Campaign_NorthCentral.conf`, `23_Campaign_SWCoast.conf`, `Conflict_East.conf`, `Conflict_West.conf`, процитированы из архива |
| Что список делает с именами и требование двух штабов | `scripts/Game/GameMode/SCR_GameModeCampaign.c` строки 615–684 и `SCR_CampaignMilitaryBaseComponent.c` строки 664–693, разобрано в [разборе `missionHeader`](ArmaReforger_MissionHeader_RU.md#34-ma-campaigncustombaselist--список-пользовательских-баз) |
