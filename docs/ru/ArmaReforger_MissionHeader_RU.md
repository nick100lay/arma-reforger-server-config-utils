# `missionHeader` в конфиге сервера Arma Reforger — полный разбор

Это дополнение к [основному руководству](ArmaReforger_ServerConfig_RU.md), раздел §5.5.2.
Здесь описано то, чего нет в вики: **какие именно ключи принимает `missionHeader`**,
какие у них типы, значения по умолчанию и что они делают.

Вики про это поле говорит ровно одну фразу — «переопределяет
`SCR_MissionHeaderCampaign` сценария» — и не приводит ни списка ключей, ни типов.
Поэтому всё ниже собрано из исходников классов и проверено на реальных
конфигах ванильных сценариев.

**Сборка, на которой проверено:** Arma Reforger 1.8.0.13 (engine 192142) — сборка, из `data007.pak`
которой взяты исходники классов, из исполняемого файла которой взяты строки ошибок
`Server Config MissionHeader:`, и на которой оба рабочих примера (§5.1, §5.3) дошли до
`JSON is Valid`.

Всё здесь взято из **установленной сборки 1.8.0.13**: объявления полей, значения по умолчанию и
перечисления прочитаны из `scripts/Game/Mission/SCR_MissionHeader*.c` и
`SCR_CampaignMilitaryBaseComponent.c` в её `data007.pak` (§8), контейнеры рангов и ванильные
`World` GUID'ы — из её архивов (§2.1, §3.3), строки ошибок — из её исполняемого файла.
**arexplorer 1.7.0.54** больше не нужен ни для одного утверждения этого документа: он был
единственным источником, пока установленные скрипты нельзя было прочитать, и §3.4 переписан по
архиву, когда выяснилось, что класс лежит в нём. Поведение здесь не измерялось ни на одной сборке —
только исходники, строки и приём схемы.

---

## 1. Что это такое механически

`missionHeader` — это **не отдельный формат**. Это тот же самый объект, что лежит
в файле сценария `Missions/<Имя>.conf`, только записанный в JSON внутри `server.json`.

Движок делает так: читает `Missions/<Имя>.conf` → получает объект mission header →
если в `server.json` есть `missionHeader`, **накладывает его поля поверх** прочитанных.
Не указанные в JSON поля остаются такими, как в `.conf` сценария.

Отсюда два практических следствия:

1. **Имена ключей в JSON — это имена полей класса, а не имена строк из `.conf`.**
   В `.conf` пишется `World`, `SystemsConfig`, `m_sName`. В JSON — только поля
   скриптового класса: `m_sName`, `m_iPlayerCount`, `m_bRandomStartingDaytime` и т. д.
   `World` и `SystemsConfig` в `missionHeader` **не переносятся** — они задаются самим
   сценарием.
2. **`missionHeader` может только менять, но не добавлять.** Если поля нет в классе
   заголовка вашего сценария, оно будет проигнорировано.

Проверка, что поле применилось, — только по поведению в игре и по логу. Неизвестные
или неверно типизированные параметры **не роняют сервер**, а попадают в лог:

```
Server Config MissionHeader: Parameter '%s' is not supported type!
Server Config MissionHeader: Item on index %d in parameter '%s' is invalid type!
```

---

## 2. Иерархия классов заголовков

Класс заголовка определяется тем, какой сценарий вы запускаете. Поля наследуются.

```
MissionHeader                                  (база движка: только методы, полей нет)
└── SCR_MissionHeader                          ← Game Master, Training, Capture & Hold
    ├── SCR_MissionHeaderCampaign              ← все сценарии Conflict (23_Campaign*, Conflict_*)
    └── SCR_MissionHeaderScenarioFramework
        └── SCR_MissionHeaderCombatOps         ← Combat Ops (24_CombatOps, 26_CombatOpsEveron, CombatOpsCain)
            └── SCR_MissionHeaderSequence      ← сюжетные сценарии Omega (Scenario01–05)
```

Родители после `:` — это сами объявления, прочитанные из установленного архива 1.8.0.13:
`SCR_MissionHeaderCampaign : SCR_MissionHeader`, `SCR_MissionHeaderScenarioFramework :
SCR_MissionHeader`, `SCR_MissionHeaderCombatOps : SCR_MissionHeaderScenarioFramework`,
`SCR_MissionHeaderSequence : SCR_MissionHeaderCombatOps`.

Практически важно вот что: **все сценарии Conflict используют `SCR_MissionHeaderCampaign`**,
а Game Master — голый `SCR_MissionHeader`. Поэтому один и тот же кампанийный ключ в
`missionHeader` сработает на Conflict и будет молча проигнорирован на Game Master.

Ванильные конфиги подтверждают привязку — в каждой строке первая строка названного файла:

| Файл сценария | Класс в первой строке |
|---|---|
| `Missions/23_Campaign.conf` | `SCR_MissionHeaderCampaign` |
| `Missions/ConflictWithoutAIs.conf` | `SCR_MissionHeaderCampaign` |
| `Missions/21_GM_Eden.conf` | `SCR_MissionHeader` |
| `Missions/CAH_Morton.conf` | `SCR_MissionHeader` |
| `Missions/24_CombatOps.conf` | `SCR_MissionHeaderCombatOps` |
| `Missions/Scenario01_Intro.conf` | `SCR_MissionHeaderSequence` |

> Capture & Hold — это *строка* игрового режима (`m_sGameMode "Capture & Hold"`), а не класс заголовка:
> все `CAH_*.conf` объявляют голый `SCR_MissionHeader`, поэтому кампанийных полей в них нет.

> **Исправлено по 1.8.0.13.** Раньше в этом разделе `SCR_MissionHeaderSequence` висел под обеими
> ветвями, «Conflict (без AIs)» числился обычным сценарием `SCR_MissionHeader`, а
> `SCR_MissionHeaderCombatOps` был назван классом `CAH_Morton.conf`. И объявления, и файлы `.conf`
> говорят другое: заголовок последовательностей наследует заголовок Combat Ops; `ConflictWithoutAIs`,
> `Conflict_East` и `Conflict_West` объявляют `SCR_MissionHeaderCampaign`; все `CAH_*.conf` объявляют
> голый `SCR_MissionHeader`.

### 2.1 ⚠️ Кодовые имена карт: Cain = Колгуев, Eden = Эверон

**Названия карт в путях и именах файлов не совпадают с тем, как эти карты называются
в интерфейсе.** Внутренние кодовые имена — исторические, от старых версий игры; в меню
и в подписях используются новые. Это регулярно сбивает с толку при выборе сценария:
файла «Kolguyev» в игре нет вообще, а нужный вам сценарий лежит в `..._Cain.conf`.

| Кодовое имя (в путях и файлах) | Отображаемое имя (в интерфейсе) |
|---|---|
| **`Cain`** | **Колгуев** / **Kolguyev** |
| **`Eden`** | **Эверон** / **Everon** |
| `Arland` | Arland (совпадает) |

Соответствие подтверждается самими ванильными конфигами — в одном файле мир лежит
по кодовому пути, а название задано ключом локализации с новым именем:

| Файл сценария | Мир (`World`) | Название (`m_sName`) |
|---|---|---|
| `Missions/27_GM_Cain.conf` | `{6228BD33933C8F81}worlds/GameMaster/GM_Cain.ent` | `#AR-Editor_Mission_GM_Kolguyev_Name` |
| `Missions/23_Campaign.conf` | `{9DF143A76F5C6460}worlds/MP/CTI_Campaign_Eden.ent` | `#AR-Campaign_ScenarioName_Everon` |
| `Missions/23_Campaign_Cain.conf` | `{5D71F496D28056E0}worlds/MP/CTI_Campaign_Cain.ent` | `Conflict - Kolguyev` |
| `Missions/23_Campaign_Arland.conf` | `{DC924A8DDECC73AD}worlds/MP/CTI_Campaign_Arland.ent` | `#AR-MainMenu_ConflictArland_Name` |

> Значения `World` перечитаны инструментом [`tools/pak.mjs`](../../tools/pak.mjs) из
> **установленного** архива 1.8.0.13, и каждое независимо подтверждено по
> `resourceDatabase.rdb`, где тот же путь связан с тем же GUID.
>
> **То, что публиковалось здесь раньше, было неверно — и причина важна.** В таблице стояли
> `{F2F3CFB83D44833C}worlds/CapeMaster/GM_Cain.ent` для `27_GM_Cain.conf`,
> `{DC924A8DDECC73AD}worlds/MP/CTI_Campaign_Eden.ent` для `23_Campaign.conf`,
> `{5D71F496D28056E0}worlds/MP/CTI_Campaign_Arland.ent` для `23_Campaign_Arland.conf`, а
> `23_Campaign_Cain.conf` был объявлен нечитаемым. Эти GUID — **от записи, лежащей в архиве
> следующей за читаемой**: тогдашний читатель отсчитывал смещения записей от тела чанка DATA,
> а не от начала файла, поэтому каждая распаковка начиналась на 56 байт позже, потерянная
> голова подставлялась из первых байтов соседа, и получался правдоподобный файл, строка
> `World` которого сшита из двух разных файлов
> (`{77C41EA429B6AC35}worlds/GameMaster/GM_Eden.ent` в §6 — тот же артефакт: этот GUID
> принадлежит `GM_Arland.ent`). За `23_Campaign_Cain.conf` следовала **сжатая** запись, текста
> для подстановки не было — и файл был объявлен нечитаемым целиком.

Дополнительно: в `resourceDatabase.rdb` ресурсы террейна Колгуева лежат целиком в
`worlds/Cain/` (`Cain.ent`, `Cain.smap`, `Cain.smd`, `Cain.topo`, `Cain_SMD.conf`,
`EmptyCain.ent`). Слова «Kolguyev» в путях нет ни одного.

**Что из этого следует практически:**

- Ищете сценарий для Колгуева — смотрите файлы с `Cain`, не ищите «Kolguyev».
  В таблице сценариев ([`ArmaReforger_Scenarios_RU.md`](ArmaReforger_Scenarios_RU.md))
  такая строка выглядит как «Conflict — Колгуев (Cain)»: отображаемое имя, а кодовое имя
  GUID-ссылки сохранено в скобках.
- **`EmptyEden.ent` — это пустой Эверон**, `EmptyCain.ent` — пустой Колгуев.
  Пригодится при создании подсцены мира.
- В `game.scenarioId` и в путях всегда используется **кодовое** имя. Отображаемое имя
  вы никак не указываете — оно берётся из ключа локализации в самом `.conf`.

---

## 3. `SCR_MissionHeaderCampaign` — поля

Полный список с исходными значениями по умолчанию и описаниями из атрибутов.
`-1` в описании означает «не переопределять, использовать значение сценария» —
это стандартный приём этого класса.

**Базовые поля (унаследованы от `SCR_MissionHeader`):**

| Ключ | Тип | По умолч. | Описание |
|---|---|---|---|
| `m_sName` | string | `""` | Название миссии. Обычно ключ таблицы строк, например `#AR-Campaign_ScenarioName_Everon`. |
| `m_sAuthor` | string | `""` | Автор миссии. |
| `m_sPath` | string | `""` | Путь к миссии. |
| `m_sDescription` | string | `""` | Краткое описание назначения миссии. |
| `m_sDetails` | string | `""` | Подробное описание миссии (например, правила). |
| `m_sIcon` | ResourceName | `{6CFADAEE9287D1D2}UI/Textures/WorldSelection/Default.edds` | Иконка миссии в меню. |
| `m_sLoadingScreen` | ResourceName | `{C58FCC06AF13075B}UI/Textures/MissionLoadingScreens/placeholder_1.edds` | Экран загрузки миссии. |
| `m_sPreviewImage` | ResourceName | `{C58FCC06AF13075B}UI/Textures/MissionLoadingScreens/placeholder_1.edds` | Превью миссии. |
| `m_sGameMode` | string | `"Sandbox"` | Игровой режим миссии. |
| `m_iPlayerCount` | int | `1` | Количество игроков для миссии. Именно от него зависит `IsMultiplayer()`: метод возвращает `m_iPlayerCount > 1`. |
| `m_eSaveTypes` | `ESaveGameType` | `15` | Флаги разрешённых типов сохранений. Если все типы выключены — система персистентности отключается целиком. |
| `m_eEditableGameFlags` | `EGameFlags` | `0` | Какие игровые флаги **разрешено** менять. |
| `m_eDefaultGameFlags` | `EGameFlags` | `0` | Игровые флаги **по умолчанию**. |
| `m_bShowInScenarioMenu` | bool | `1` | Показывать сценарий в меню сценариев. |
| `m_sBriefingConfig` | ResourceName | `""` | Конфиг экрана брифинга (`.conf`). |
| `m_bOverrideScenarioTimeAndWeather` | bool | `0` | Если сценарий это разрешает — его время суток и погода берутся из этого заголовка. **Требует `SCR_TimeAndWeatherHandlerComponent` на сущности игрового режима.** |
| `m_iStartingHours` | int | `8` | Начальный час суток. Ползунок, диапазон `0 23 1`. |
| `m_iStartingMinutes` | int | `0` | Начальные минуты. Ползунок, диапазон `0 59 1`. |
| `m_bRandomStartingDaytime` | bool | `0` | Случайное начальное время суток. |
| `m_fDayTimeAcceleration` | float | `1` | Ускорение времени днём (1 = 100 %, 2 = 200 %). Ползунок `0.1 12 0.1`. |
| `m_fNightTimeAcceleration` | float | `1` | Ускорение времени ночью. Ползунок `0.1 12 0.1`. |
| `m_bRandomStartingWeather` | bool | `0` | Случайная начальная погода. |
| `m_bRandomWeatherChanges` | bool | `0` | Погода может меняться по ходу игры. |
| `m_fXpMultiplier` | float | `1` | Множитель получаемого опыта (если включён в игровом режиме; 1 — стандарт). |
| `m_bMapMarkerEnableDeleteByAnyone` | bool | `""` (трактуется как false) | Могут ли метки на карте удалять все, или только поставивший их игрок в пределах фракции. |
| `m_iMapMarkerLimitPerPlayer` | int | `10` | Сколько меток на карте может быть у одного игрока одновременно. |
| `m_aFactionLimits` | array of `SCR_FactionLimit` | пусто | Лимиты игроков по фракциям. |
| `m_bIsArmavisionAllowedInMP` | bool | `0` | Разрешён ли Armavision игрокам без повышенных прав в мультиплеере. |
| `m_bLoadOnStart` | bool | — | (без описания в атрибутах) |
| `m_sOwner` | string | — | (без описания в атрибутах) |

**Поля собственно кампании (`SCR_MissionHeaderCampaign`):**

| Ключ | Тип | По умолч. | Описание |
|---|---|---|---|
| `m_iControlPointsCap` | int | `-1` | Сколько контрольных точек должна удержать фракция для победы. `-1` означает **значение мира**, то есть `m_iControlPointsThreshold` сущности игрового режима (ванильный Conflict: `5` на Eden и Cain, `3` на Montignac, `2` на Arland), а не умолчание атрибута этого поля. Раунд, в котором контрольных точек меньше этого числа, выиграть нельзя; см. §3.4.8. |
| `m_fVictoryTimeout` | float | `-1` | Сколько секунд фракция должна удерживать точки (переопределение, `-1` — по умолчанию). |
| `m_iStartingHQSupplies` | int | `-1` | Стартовый запас снабжения главного штаба (переопределение, `-1` — по умолчанию). |
| `m_iMinimumBaseSupplies` | int | `-1` | Минимальный стартовый запас снабжения на малых базах. |
| `m_iMaximumBaseSupplies` | int | `-1` | Максимальный стартовый запас снабжения на малых базах. |
| `m_bCustomBaseWhitelist` | bool | `0` | Использовать пользовательский список баз как whitelist вместо blacklist. |
| `m_bIgnoreMinimumVehicleRank` | bool | `0` | Отключить требования по званию для спавна техники. |
| `m_fSupplyOffloadAssistanceReward` | float | `-1` | Доля опыта, выдаваемая игрокам за разгрузку снабжения, которое они не загружали сами. Диапазон `-1 inf`. |
| `m_aCampaignCustomBaseList` | array of `SCR_CampaignCustomBase` | пусто | Пользовательский список баз. Разобран в §3.4. |
| `m_bCommanderRoleEnabled` | bool | `0` | Игрок может добровольно занять роль командира. |
| `m_bEstablishingBasesEnabled` | bool | `0` | Игроки могут строить базы. Если выключено — игра начинается с уже существующими FOB. |
| `m_bSuppliesAutoRegenerationEnabled` | bool | `1` | FOB автоматически восстанавливают снабжение. |
| `m_bSpawnRandomCaches` | bool | `0` | По карте спавнятся случайные тайники. |
| `m_iContestingCharactersNeeded` | int | `3` | Сколько персонажей нужно, чтобы база начала оспариваться. `-1` полностью отключает оспаривание. |
| `m_bRandomSpawnpointsEnabled` | bool | `0` | Разрешены рандомизированные точки спавна. |
| `m_bINDFORCanSpawnOnBases` | bool | `1` | Игроки INDFOR могут спавниться на базах в начале игры. |
| `m_bINDFORCanSpawnOnDistantBases` | bool | `0` | Игроки INDFOR могут спавниться на удалённых базах в начале игры. |
| `m_eStartingRank` | `SCR_ECharacterRank` | `1` (`PRIVATE`) | Звание, с которого все игроки начинают матч. Выпадающий список по `SCR_ECharacterRank`; числовые значения — в §3.2. |

### 3.0 ⚠️ Значения по умолчанию зависят от игрового режима

**Колонка «По умолч.» во всех таблицах этого документа — это значение атрибута класса,
а не то, что реально действует на вашем сервере.** Не полагайтесь на неё как на
«текущее поведение»: оно может отличаться по трём независимым причинам.

**1. Разные сценарии используют разные классы заголовка.** Набор полей и их умолчания
определяются классом, а класс задан сценарием (см. §2). `SCR_MissionHeaderCampaign`
**наследует** `SCR_MissionHeader` и лишь добавляет свои поля, поэтому часть полей
доступна не во всех режимах:

| Поле | Объявлено в | Умолчание атрибута |
|---|---|---|
| `m_iPlayerCount` | `SCR_MissionHeader` (базовый) | `"1"` |
| `m_iStartingHours` | `SCR_MissionHeader` (базовый) | `"8"` |
| `m_iStartingHQSupplies` | только `SCR_MissionHeaderCampaign` | `"-1"` |
| `m_eStartingRank` | только `SCR_MissionHeaderCampaign` | `SCR_ECharacterRank.PRIVATE` (то есть `1`) |
| `m_bCommanderRoleEnabled` | только `SCR_MissionHeaderCampaign` | `"0"` |

То есть «умолчание» без указания режима — величина неполная: на Game Master полей
`m_iStartingHQSupplies`, `m_eStartingRank` и всего блока снабжения просто нет,
и любой ключ оттуда будет молча проигнорирован.

**2. Сценарий задаёт свои значения поверх умолчаний класса.** Умолчание атрибута —
это лишь то, что подставляется, если поле вообще не задано. В реальном `.conf`
сценария поля заполнены конкретными значениями, и они перекрывают умолчания.
Наглядный пример из ванильного `Missions/23_Campaign.conf`:
`m_eEditableGameFlags 6` и `m_eDefaultGameFlags 6`, тогда как умолчание атрибута —
`0` (§6). То же и с `m_iPlayerCount`: атрибут говорит `1`, а сценарий задаёт `64`.

**3. Один и тот же класс может вести себя по-разному в разных режимах.**
Часть логики включается не по значению поля, а по режиму. Например
`ApplyHeaderSettings()` из §3.4 вызывается только для баз кампании: в Game Master
военных баз кампании как таковых нет, и весь список `m_aCampaignCustomBaseList`
там смысла не имеет.

**Что из этого следует практически.** Умолчания из таблиц годятся для одного:
понять, *что произойдёт, если поле не указывать*. Если вам важно знать текущее
значение — смотрите `.conf` конкретного сценария, а не этот документ.
И наоборот: если поле указано в `missionHeader`, оно перекрывает и умолчание класса,
и значение из сценария.

### 3.1 Вложенные типы

**`EGameFlags`** — битовая маска (`scripts/Game/game.c`):

| Член | Значение | Смысл |
|---|---|---|
| `Metabolism` | 1 | Система метаболизма |
| `SpawnVehicles` | 2 | Спавн техники |
| `SpawnAI` | 4 | Спавн ИИ |

Значение `m_eDefaultGameFlags 6` = `2 | 4` = `SpawnVehicles + SpawnAI`.
Именно это стоит в `Missions/23_Campaign.conf`.
Флаги применяются в `ArmaReforgerScripted.OnMissionSet()`:
берётся `m_eDefaultGameFlags` и передаётся в `SetGameFlags(...)`.

**`ESaveGameType`** — битовая маска типов сохранений:

| Член | Смысл |
|---|---|
| `MANUAL` | Сохранение по инициативе игрока |
| `AUTO` | Автоматическое (обычно периодическое) |
| `SCRIPTED` | По событию скрипта (например, чекпойнты) |
| `SHUTDOWN` | Выход в главное меню / корректное завершение |

Значение по умолчанию в `SCR_MissionHeader` — `15`, то есть все четыре типа.
Применяется тоже в `OnMissionSet()`: `GetSaveGameManager().SetEnabledSaveTypes(...)`.

**`SCR_FactionLimit`** — элемент массива `m_aFactionLimits`:

| Ключ | Тип | По умолч. | Описание |
|---|---|---|---|
| `m_sFactionKey` | FactionKey | `""` | Ключ или ID фракции; в ваниле — `US`, `USSR`, `FIA`. |
| `m_iFactionLimit` | int | `-1` | Лимит игроков фракции; `-1` — без ограничения. Ползунок `-1 inf`. |

В JSON это выглядит так:

```json
"m_aFactionLimits": [
  { "m_sFactionKey": "US", "m_iFactionLimit": 32 },
  { "m_sFactionKey": "USSR", "m_iFactionLimit": 32 },
  { "m_sFactionKey": "FIA", "m_iFactionLimit": 32 }
]
```

Ключи задаёт не заголовок. Они должны совпадать с фракциями, которые регистрирует
менеджер фракций сценария — файлы `Configs/Factions/*.conf`, создаваемые префабом мира
`.../FactionManager*.et` (например, `Prefabs/MP/Campaign/CampaignFactionManager.et`
подтягивает `US_Campaign.conf`, `USSR_Campaign.conf` и `FIA_Campaign.conf`), — поэтому
фракция из мода приносит свой ключ.

Для `FIA` ваниль использует эту запись как выключатель. В
`Missions/23_Campaign_Montignac.conf` (Conflict — Montignac) и
`Missions/23_Campaign_Western.conf` (Conflict — Western Everon) в заголовке стоит ровно
один лимит:

```
m_aFactionLimits {
 SCR_FactionLimit "{693688C8C127D685}" {
  m_sFactionKey "FIA"
  m_iFactionLimit 0
 }
}
```

В `missionHeader` это `{ "m_sFactionKey": "FIA", "m_iFactionLimit": 0 }`. Поскольку «без
ограничения» — это только `-1` (см. таблицу выше), `0` оставляет фракцию без игроков;
именно так эти два сценария закрывают `FIA`. Оба файла `.conf` извлечены из
`data007.pak`.

Фракция, которой в массиве **нет**, не ограничена вовсе — это то же самое, что `-1`. Карта
строится только из присутствующих записей: `GetFactionLimitMap()` вставляет каждый указанный
ключ и пропускает запись с пустым `m_sFactionKey`, поэтому у фракции без записи просто нет
лимита, который к ней можно применить. Ваниль на это и опирается: в двух сценариях выше `US`
и `USSR` в массиве отсутствуют, хотя играют там именно за них, а названа та единственная
фракция, которую ваниль убирает. Ключи при этом ни с чем не сверяются, поэтому опечатка просто
остаётся в карте, ни одной фракции не соответствует и ни на что не влияет. Кроме того, метод
печатает каждый ключ, пока строит карту, поэтому в логе сервера видно ровно те записи, которые
дал заголовок, — `string m_sFactionKey = 'FIA'` в случае одной записи. Что именно
происходит, когда указанная фракция заполнена, не прослежено — см. §8.

### 3.2 `SCR_ECharacterRank` — числовые значения

Enum объявлен **в конце** `scripts/Game/Ranks/SCR_RankInfo.c` (не в отдельном файле —
поэтому его нет и в списке ресурсов). Явных значений у членов нет,
значит нумерация последовательная с нуля:

> **Числа ниже — свойство языка, а не игрового режима, и в этом они надёжны.**
> Значения `0..19` одинаковы в любом режиме; меняется лишь то, *какие звания
> определены* у фракции и *с какого звания начинают игроки*. Подробности — в §3.0
> и §3.3.

| Значение | Член | Примечание |
|---:|---|---|
| 0 | `RENEGADE` | Штрафное звание. Помечено `m_bIsRenegade 1`; логика `SCR_CharacterRankComponent.SpecialRankHandling()` при этом звании переводит игрока во «скрытую» фракцию RNGD, а при возврате — обратно в INDFOR. |
| 1 | `PRIVATE` | **Значение по умолчанию** (`m_eStartingRank` = `SCR_ECharacterRank.PRIVATE`, `SCR_CharacterRankComponent.m_iRank` defvalue `"1"`). |
| 2 | `CORPORAL` | |
| 3 | `SERGEANT` | |
| 4 | `LIEUTENANT` | |
| 5 | `CAPTAIN` | |
| 6 | `MAJOR` | Именно это значение стояло в проверенном рабочем конфиге сервера. |
| 7 | `COLONEL` | |
| 8 | `GENERAL` | |
| 9 | `CUSTOM1` | Свободные звания для модов и кастомных фракций. |
| 10 | `CUSTOM2` | |
| 11 | `CUSTOM3` | |
| 12 | `CUSTOM4` | |
| 13 | `CUSTOM5` | |
| 14 | `CUSTOM6` | |
| 15 | `CUSTOM7` | |
| 16 | `CUSTOM8` | |
| 17 | `CUSTOM9` | |
| 18 | `CUSTOM10` | **Максимально допустимое значение** для репликации. |
| 19 | `INVALID` | Сентинел. **Нельзя использовать как `m_eStartingRank`.** |

**Доказательство, что нумерация именно такая.** В
`SCR_CharacterRankComponent.RplSave()` / `RplLoad()` стоит:

```c
writer.WriteIntRange(m_iRank, 0, SCR_ECharacterRank.INVALID - 1);
reader.ReadIntRange(m_iRank, 0, SCR_ECharacterRank.INVALID - 1);
```

Сетевой диапазон `0..INVALID-1` имеет смысл только если `INVALID` — последний член,
то есть 19, а значимых значений ровно 19 (0–18). Совпадает с количеством членов выше.

Дополнительно сходится значение по умолчанию: `SCR_CharacterRankComponent.m_iRank`
объявлен как `[Attribute(defvalue: "1", ...)]`, а в комментарии к полю
`SCR_CharacterRankComponent.GetCharacterRank` дефолт назван `PRIVATE`.
`1` → `PRIVATE` ✓.

> **Практическая рекомендация: используйте числа.** Проверенный рабочий конфиг
> содержал `"m_eStartingRank": 6`, и сервер прошёл валидацию схемы. Символьные имена
> (`"MAJOR"`) в `.conf`-файлах сценариев используются (например,
> `m_iRank RENEGADE` в `Configs/Ranks/NonCombatantRanks.conf`), но для JSON-поля
> `missionHeader` этот вариант **не проверялся**.

### 3.3 Важная оговорка: звание должно существовать у фракции

`SCR_ECharacterRank` — это только идентификатор. Название, значок и порог опыта
задаются **отдельно для каждой фракции** через конфиг `SCR_RankContainer`
(`Configs/Ranks/*.conf`), который содержит массив `SCR_RankInfo`.

> **Это и есть главный источник расхождения умолчаний между режимами** (см. §3.0).
> Одно и то же число означает в разных фракциях и режимах разное звание. Ваниль
> содержит как минимум три разных контейнера: `Configs/Ranks/BaseMilitaryRanks.conf`
> (военные), `FIAMilitaryRanks.conf` (FIA) и `NonCombatantRanks.conf` (некомбатанты).
> В последнем, например, значение `1` описано не как `PRIVATE`, а как
> `#AR-Rank_Volunteer` — другое название, другой значок (`AR_Rank_OR-2`)
> и другой порог опыта (`-100`). Так что «умолчание `1` = PRIVATE» верно только
> для тех фракций, где контейнер званий определяет `1` именно как `PRIVATE`.

Поля одного `SCR_RankInfo` (базовый класс, из `scripts/Game/Ranks/SCR_RankInfo.c` в pak):

| Поле | Тип | По умолч. | Описание |
|---|---|---|---|
| `m_iRank` | `SCR_ECharacterRank` | `1` | ID звания из таблицы §3.2. Если в записи конфига поле опущено, это означает `PRIVATE` (значение `1`). |
| `m_bIsRenegade` | bool | `0` | Считается ли звание враждебным для своих. |
| `m_iRequiredXP` | int | `100` | Сколько опыта нужно для повышения до этого звания. |
| `m_sRankName` | string | `""` | Название звания (обычно ключ локализации). |
| `m_sRankNameUpper` | string | `""` | Название в верхнем регистре. |
| `m_sRankNameShort` | string | `""` | Короткое название. |
| `m_sInsignia` | string | `""` | Имя квада значка в `MilitaryIcons.imageset`. |

Все три ванильных контейнера используют подкласс **`SCR_RankInfoCampaign`**, который
добавляет четыре поля (определён в
`scripts/Game/GameMode/FactionManager/SCR_CampaignFactionManager.c`, а не в папке `Ranks/`):

| Поле | Тип | По умолч. | Описание |
|---|---|---|---|
| `m_iRequestCD` | int | `10` | Сколько секунд игрок этого звания ждёт между запросами. Геттер `GetRankRequestCooldown()` возвращает значение в **миллисекундах** (`m_iRequestCD * 1000`). |
| `m_iRadioRespawnCooldown` | int | `30` | Таймер возрождения при высадке на этого бойца, когда у него радио. |
| `m_iFastTravelCooldown` | int | `300` | Откат быстрого перемещения. |
| `m_eRadioMsg` | `SCR_ERadioMsg` | `0` | Радиосообщение, выдаваемое при получении звания. |

Все три контейнера, прочитанные целиком из **установленного** архива 1.8.0.13. Названия
званий — ключи локализации; ID — из §3.2. **`m_iRequiredXP` — порог, при котором звание
выдаётся**, и контейнер не обязан определять все звания:

`Configs/Ranks/BaseMilitaryRanks.conf` (2496 Б) — воинские звания:

| `m_iRank` | Ключ названия | `m_iRequiredXP` | `m_iRequestCD` / `m_iRadioRespawnCooldown` / `m_iFastTravelCooldown` |
|---|---|---:|---|
| `RENEGADE` (`m_bIsRenegade 1`) | `#AR-Rank_Renegade` | `-51` | 1200 / 600 / 3600 |
| *(отсутствует → `PRIVATE`)* | `#AR-Rank_WestPrivate` | `-50` | 600 / 45 / 600 |
| `CORPORAL` | `#AR-Rank_WestCorporal` | `150` | 600 / 42 / 540 |
| `SERGEANT` | `#AR-Rank_WestSergeant` | `600` | 450 / 39 / 480 |
| `LIEUTENANT` | `#AR-Rank_WestLieutenant` | `1200` | 300 / 36 / 480 |
| `CAPTAIN` | `#AR-Rank_WestCaptain` | `2100` | 150 / 33 / 360 |
| `MAJOR` | `#AR-Rank_WestMajor` | `3300` | 5 / — / — |

`Configs/Ranks/FIAMilitaryRanks.conf` (1210 Б) — FIA, всего четыре звания:

| `m_iRank` | Ключ названия | `m_iRequiredXP` | Откаты |
|---|---|---:|---|
| `RENEGADE` (`m_bIsRenegade 1`) | `#AR-Rank_Renegade` | `-21` | 1200 / 600 / 3600 |
| *(отсутствует → `PRIVATE`)* | `#AR-Rank_Volunteer` | `-20` | 600 / 45 / 600 |
| `CORPORAL` | `#AR-Rank_Partisan` | `550` | 450 / 39 / 480 |
| `MAJOR` | `#AR-Rank_WestCaptain` | `1100` | 150 / — / 350 |

> В контейнере FIA запись `MAJOR` названа `#AR-Rank_WestCaptain` — *западный* капитан — и
> несёт значок `AR_Rank_OF-5`. Это текст самой ванили, а не ошибка переноса сюда. То есть
> игроку FIA, повышенному до `MAJOR`, показывается название западного капитана.

`Configs/Ranks/NonCombatantRanks.conf` (518 Б) — два звания, имён значков кроме
ренегатского нет:

| `m_iRank` | Ключ названия | `m_iRequiredXP` | Откаты |
|---|---|---:|---|
| `RENEGADE` (`m_bIsRenegade 1`) | `#AR-Rank_Renegade` | `-101` | 1200 / 600 / 3600 |
| *(отсутствует → `PRIVATE`)* | `#AR-Rank_Volunteer` | `-100` | 600 / 45 / 600 |

Из полного чтения этих трёх файлов следует две вещи:

1. **Отрицательный `m_iRequiredXP` — норма.** У `RENEGADE` это `-51`, `-21` или `-101`
   в зависимости от контейнера, а звание под ним стоит на один пункт выше. Так звание
   оказывается «ниже» любого, до которого можно дорасти опытом:
   `SCR_RankContainer.GetRankByXP()` выбирает звание с наибольшим `m_iRequiredXP`,
   не превышающим текущий опыт.
2. **Контейнер может не определять часть званий, а опущенный `m_iRank` означает `PRIVATE`.**
   У FIA определены только четыре — `RENEGADE`, `PRIVATE`, `CORPORAL` и `MAJOR`;
   `SERGEANT`, `LIEUTENANT`, `CAPTAIN`, `COLONEL`, `GENERAL` и десять значений `CUSTOM*`
   там не определены вовсе, поэтому фактический потолок лестницы FIA — `MAJOR`. Ваниль
   поставляет только перечисленные контейнеры — мод, добавляющий звания, обязан принести
   свой `SCR_RankContainer`.

Если заданное `m_eStartingRank` не определено в контейнере званий вашей фракции,
код не падает: `SCR_RankContainer.GetNextRank()` / `GetPreviousRank()` умеют искать
ближайшее определённое звание. Но игрок увидит не то звание, которое вы задали.

### 3.4 `m_aCampaignCustomBaseList` — список пользовательских баз

Список **фильтрует базы, которые уже есть в мире, а в режиме whitelist ещё и перезаписывает их
кампанийные флаги.** Он не создаёт базы, не переносит их и не переименовывает. Читается он ровно
один раз, при старте, в `SCR_GameModeCampaign.InitalBaseSetup()`, и это единственное место в
ванильных скриптах, которое читает любое из двух полей — проверено на 1.8.0.13 через
[`tools/cscript.mjs`](../../tools/cscript.mjs) `refs InitalBaseSetup`: символ встречается в
`scripts/Game/GameMode/SCR_GameModeCampaign.c` и больше нигде — в строке 615 (объявление) и в
строке 604 (вызов из `Start()`, до инициализации любой базы).

#### 3.4.1 Одна запись: класс `SCR_CampaignCustomBase`

Класс объявлен в конце `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`
(строка 2956 на 1.8.0.13) и имеет пять полей `[Attribute]` — значения по умолчанию ниже взяты
из этих атрибутов, а не выведены рассуждением:

| Ключ | Тип | По умолчанию | Что делает |
|---|---|---|---|
| `m_sBaseName` | string | `""` | **База, которую надо найти.** Описание атрибута — "Base entity name as set up in World Editor", то есть имя сущности из редактора мира; что это значит и чего это не значит, см. §3.4.2. |
| `m_bIsControlPoint` | bool | `0` | Считать ли базу точкой контроля. От этого зависит победа: `SCR_CampaignMilitaryBaseManager.EvaluateControlPoints()` собирает точки контроля именно по этому флагу. |
| `m_bCanBeHQ` | bool | `0` | Можно ли выбрать базу главной базой фракции (HQ). |
| `m_bDisableWhenUnusedAsHQ` | bool | `1` | Выключать ли базу, когда фракция переносит штаб в другое место (§3.4.6). |
| `m_fRadioRange` | float, метры | `-1` | Радиус собственного трансивера базы. В атрибуте сказано "Use -1 for default base setting", и код трактует отрицательное значение как «не трогать» (§3.4.5). |

Полей ровно пять и других нет. **`m_bIsSupplyHub`, `m_eType` и радиус базы через этот список
изменить нельзя** — в классе для них просто нет поля.

#### 3.4.2 Сопоставление идёт по *имени сущности*

`InitalBaseSetup()` собирает обычный массив из `m_sBaseName` записей и сравнивает с ним каждую базу
мира (строки 622–668, сокращённо — комментарии принадлежат этому документу):

```c
bool whitelist = false;
array<string> customBaseList = {};

SCR_MissionHeaderCampaign header = SCR_MissionHeaderCampaign.Cast(GetGame().GetMissionHeader());
if (header)
{
    whitelist = header.m_bCustomBaseWhitelist;
    foreach (SCR_CampaignCustomBase customBase : header.m_aCampaignCustomBaseList)
        customBaseList.Insert(customBase.GetBaseName());            // m_sBaseName записи
}

array<SCR_CampaignMilitaryBaseComponent> candidatesForHQ = {};
array<SCR_CampaignMilitaryBaseComponent> controlPoints = {};

foreach (SCR_MilitaryBaseComponent base : bases)                    // все базы мира
{
    SCR_CampaignMilitaryBaseComponent campaignBase = SCR_CampaignMilitaryBaseComponent.Cast(base);
    if (!campaignBase)
        continue;

    if (header)
    {
        const string baseName = campaignBase.GetOwner().GetName();   // имя СУЩНОСТИ
        const int listIndex = customBaseList.Find(baseName);         // побеждает первое совпадение

        if (listIndex != -1)
        {
            if (!whitelist)
                continue;                                            // blacklist: база пропущена
        }
        else if (whitelist)
        {
            continue;                                                // whitelist: база пропущена
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

Четыре факта о сопоставлении, все — из этих строк:

1. **Сравнивается имя сущности, а не отображаемое имя.** Справа стоит
   `GetOwner().GetName()` — имя, которое сущность носит в редакторе мира: `TownBaseMeaux`,
   `MajorBaseMorton`, `StartingPos07`. То, что показывает карта («Мо», «Береговая база в Мортоне»),
   — это отдельная, локализованная строка `m_sBaseName` компонента, и в сопоставлении она не
   участвует. Поэтому отображаемое имя в записи не совпадёт ни с чем, и в лог об этом ничего не
   попадёт.
2. **`array<string>.Find()` возвращает первое совпадение**, поэтому две записи с одним именем
   означают, что первая работает, а вторая мертва.
3. **Имя, не совпавшее ни с одной базой, не меняет ничего** — и молча: строки в логе о промахе
   списка нет. Единственное сообщение, которое пишет этот код, — жалоба на штабы из §3.4.4.
4. **Сравнение — обычный поиск равенства строк.** Чувствительно ли оно к регистру в этой сборке,
   не установлено; все ванильные списки используют ровно то написание, что в файле мира, поэтому
   копируйте написание, а не проверяйте этот вопрос на практике.

Каталог всех баз ванильных миров — имя сущности и отображаемое имя в одной строке — это
[документ о базах](ArmaReforger_VanillaBases_RU.md); именно с ним и должны совпадать записи.

#### 3.4.3 Whitelist и blacklist: что каждый из них делает на самом деле

`m_bCustomBaseWhitelist` задаёт смысл всего массива:

| `m_bCustomBaseWhitelist` | База, имя которой **есть** в списке | База, имени которой в списке **нет** |
|---|---|---|
| `false` (по умолчанию) — **blacklist** | **Пропущена**: не инициализируется, не становится кандидатом в штаб и точкой контроля. **Остальные четыре поля её записи не читаются вообще** — вызов `ApplyHeaderSettings()` стоит за условием `if (whitelist && …)` | Остаётся с флагами, которые даёт мир |
| `true` — **whitelist** | Остаётся, и **все четыре поля копируются из записи** поверх значений базы | **Пропущена**, ровно как база из blacklist |

Отсюда два следствия, которых описание атрибута ("use the custom base list as a whitelist instead of
a blacklist") не подсказывает:

- **В режиме blacklist запись — это только имя.** Выставить `m_bIsControlPoint` или
  `m_fRadioRange` на базе из blacklist невозможно: настройки применяются только в режиме whitelist.
  Blacklist — это список баз, которые надо убрать, и больше ничего.
- **В режиме whitelist запись заменяет, а не дополняет.** Все три булевых поля присваиваются
  безусловно, поэтому база, попавшая в whitelist с одним лишь именем, теряет все флаги, которые дал
  мир: она становится не точкой контроля и не может быть штабом, а радиус радио при этом не
  трогается (§3.4.5). Всё, что база должна сохранить, надо написать в записи.
- **Список определяет, сколько контрольных точек существует, а не сколько нужно для победы.**
  Нужное число задаёт `m_iControlPointsCap`, и при умолчании `-1` оно остаётся тем, что задал мир
  в сущности игрового режима. Whitelist, оставляющий меньше контрольных точек, чем это число, даёт
  раунд, который никто не может выиграть; blacklist, убирающий контрольные точки, может сделать то
  же самое. См. §3.4.8.

«Пропущена» означает пропущена этим циклом — а это единственный цикл, который инициализирует базы на
старте: база остаётся зарегистрированной в менеджере баз, но никогда не инициализируется и не
становится ни штабом фракции, ни точкой контроля. На практике для этого раунда она инертна.

#### 3.4.4 Нужно минимум два кандидата в штаб

Сразу после цикла (строки 680–684):

```c
if (candidatesForHQ.Count() < 2)
{
    Print("Not enough suitable starting locations found in current setup. Check 'Can Be HQ' attributes in SCR_CampaignMilitaryBaseComponent!", LogLevel.ERROR);
    return;
}
```

`return` выходит из `InitalBaseSetup()` до `SelectHQs()`, до установки снабжения и до инициализации
любой базы — и мир стартует **вообще без главной базы фракции**, а единственный след — та строка
ошибки. Считаются здесь базы, оставшиеся после фильтрации *и* имеющие `m_bCanBeHQ` true *на этот
момент*, то есть в режиме whitelist — то значение, которое задали ваши записи.

Значит, whitelist'у нужно **минимум две записи с `m_bCanBeHQ: true`**. Пустой массив при
`m_bCustomBaseWhitelist: true` даёт ноль кандидатов и попадает в ту же ветку. Каждый whitelist,
который поставляет ваниль, помечает две базы `m_bCanBeHQ 1` и `m_bDisableWhenUnusedAsHQ 0` именно
поэтому; два поставляемых файла сценариев это правило забывают и ломают —
[документ о базах](ArmaReforger_VanillaBases_RU.md) §4.3 показывает это целиком.

#### 3.4.5 Что делают скопированные флаги

```c
// SCR_CampaignMilitaryBaseComponent.ApplyHeaderSettings(), строки 664-693
void ApplyHeaderSettings(notnull SCR_CampaignCustomBase settings)
{
    m_bCanBeHQ               = settings.GetCanBeHQ();
    m_bDisableWhenUnusedAsHQ = settings.GetDisableWhenUnusedAsHQ();
    m_bIsControlPoint        = settings.IsControlPoint();

    SCR_CoverageRadioComponent coverageComp =
        SCR_CoverageRadioComponent.Cast(GetOwner().FindComponent(SCR_CoverageRadioComponent));
    if (coverageComp)
        coverageComp.SetIsSource(m_bCanBeHQ);        // база, способная быть штабом, — источник радио

    float radioRange = settings.GetRadioRange();
    if (radioRange < 0)
        return;                                       // отрицательный радиус — радио не трогаем

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

Что из этого следует практически:

1. **`m_sBaseName` здесь не используется.** Имя нужно было только чтобы найти базу; собственное
   отображаемое имя базы список не переписывает никогда.
2. **`m_bCanBeHQ` управляет не только выбором штаба.** Он ещё делает базу *источником* радиопокрытия
   (`SetIsSource`) — поэтому база, сохранившая флаг, сохраняет и покрытие.
3. **`m_fRadioRange` задаёт только радиус базы.** Последующий `RecalculateRadioRange()` поднимает его
   до наибольшего радиуса среди антенн, построенных на базе (`SCR_EServicePointType.RADIO_ANTENNA`),
   поэтому антенна может радиус увеличить, но не уменьшить ниже заданного.
4. **Отрицательный `m_fRadioRange` всё равно применяет три булевых поля** — ранний `return` стоит
   после их присваивания. То есть `-1` означает «флаги да, радио не трогать», и это обычный выбор.
5. **До радио дело доходит только если у базы есть компоненты.** База без `BaseRadioComponent` или
   без трансивера 0 молча сохраняет свой радиус; флаги присвоены раньше, поэтому это им не мешает.

#### 3.4.6 `m_bDisableWhenUnusedAsHQ`

Флаг читается в `SetAsHQ()` (строки 1015–1035): когда база становится главной, проверяется прежняя
главная база той же фракции, и если у неё этот флаг включён — она выключается.

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

`Disable()` снимает питание с радиокомпонента, убирает стартовые машины, снимает привязку к
фракции и удаляет построенную композицию базы. Значит `false` здесь означает «оставить прежнюю
главную базу живой», а `true` (значение по умолчанию) — «выключить её». Обратите внимание, что
штаб противника этот путь не выключает никогда, что бы ни говорил его флаг.

#### 3.4.7 Где список не делает ничего

| Ситуация | Почему ничего не происходит |
|---|---|
| `.conf` сценария начинается не с `SCR_MissionHeaderCampaign` (или его наследника) — Game Master, Training, все сценарии Capture & Hold | Эти два ключа есть только у `SCR_MissionHeaderCampaign`. `InitalBaseSetup()` читает их через `SCR_MissionHeaderCampaign.Cast()`, а если приведение не удалось, весь блок `if (header)` пропускается: ни фильтрации, ни настроек, ни сообщения. |
| Игровой режим сценария — не `SCR_GameModeCampaign`: миры Combat Ops создают `SCR_BaseGameMode`, Game Master использует `SCR_GameModeEditor` | `InitalBaseSetup()` вызывается только из `SCR_GameModeCampaign.Start()`, других ссылок на него в скриптах нет. |
| В мире нет баз — Combat Ops, Game Master, Capture & Hold, Training, одиночные сценарии | Сопоставлять не с чем: 32 мира этих сценариев были прочитаны, и ни в одном нет компонента — [документ о базах](ArmaReforger_VanillaBases_RU.md) §1. |
| Имя принадлежит базе без имени сущности | `GetName()` для неё — пустая строка, поэтому совпасть может только запись с `""`. В таком состоянии 29 из 168 ванильных баз. |
| Опечатка в `m_sBaseName` | `Find()` возвращает `-1`, запись просто никогда не применяется. Ни строки в логе, ни предупреждения. |

#### 3.4.8 Примеры

**Blacklist** — то небольшое изменение, которое обычно и нужно: убрать из раунда четыре базы у
побережья и городов и больше ничего не трогать. В режиме blacklist записям нужны только имена.

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

**Whitelist** — небольшой раунд на Everon: два переносимых штаба, одна точка контроля и одна
обычная база. Каждый флаг, который базы должны сохранить, выписан явно, потому что записи его
заменяют. Все четыре имени — строки каталога Everon в [документе о базах](ArmaReforger_VanillaBases_RU.md)
§3.1, а правило двух штабов из §3.4.4 выполняют первые две записи. **`m_iControlPointsCap: 1` —
часть примера, а не украшение:** whitelist оставляет в раунде ровно одну контрольную точку, тогда
как мир Everon требует пять, — примечание после примера объясняет, почему такая пара не даёт
победителя.

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

> Оба примера собраны по образцу списков, которые поставляет сама ваниль: те же имена ключей, тот же
> `m_fRadioRange 2000` у штабов, — а их имена сверены с установленным миром в каталоге баз. На
> сервере из этого репозитория они не запускались: проверены имена, а не получившаяся игра.

> **Почему whitelist'у нужен `m_iControlPointsCap`.** `SCR_CampaignMilitaryBaseManager.EvaluateControlPoints()`
> запускает таймер победы фракции только при `controlPointsHeld >= m_Campaign.GetControlPointTreshold()`
> (`SCR_CampaignMilitaryBaseManager.c:843` в 1.8.0.13). Удержание *всех* контрольных точек раунда, в
> котором их меньше порога, это условие не выполняет никогда: `SetVictoryTimestamp` не выставляется,
> и раунд остаётся без победителя — без сообщения и без ошибки. Порог — не умолчание заголовка:
> `SCR_GameModeCampaign` перезаписывает `m_iControlPointsThreshold` только когда
> `m_iControlPointsCap != -1` (`SCR_GameModeCampaign.c:1892`), поэтому при `-1` действует значение на
> сущности игрового режима в мире — измерено в 1.8.0.13: ванильные Eden и Cain задают `5`, Montignac
> — `3`, Arland — `2`, а префаб, из которого все они собраны,
> `Prefabs/MP/Modes/Conflict/GameMode_Campaign.et`, несёт `4`. То есть действует то, что говорят мир
> и его цепочка префабов, а не фиксированное число. Whitelist выше оставляет одну контрольную точку
> (записи `MainBase*` больше не несут `m_bIsControlPoint`), поэтому выиграть его позволяет именно
> `m_iControlPointsCap: 1`; при `-1` остаётся `5` мира, и победить не может никто.
>
> **Blacklist снижает число точно так же.** Blacklist выше убирает `MajorBaseMorton` и
> `MajorBaseLamentin`, а обе базы в ванильном Eden — контрольные точки: из 7 остаётся 5, ровно порог,
> так что умолчание ещё работает, — но уберите ещё одну контрольную точку, и раунд тоже станет
> невыигрываемым. Независимо от режима задавайте `m_iControlPointsCap` равным числу контрольных
> точек, которые действительно остаются после списка.

---

## 4. Что в `missionHeader` переносится, а что нет

| Поле из `.conf` сценария | Можно ли задать в `missionHeader` | Почему |
|---|---|---|
| `World` | **нет** | Это свойство движкового класса `MissionHeader`, доступное только для чтения из скрипта. Мир определяется самим сценарием. |
| `SystemsConfig` | **нет** | То же — читается методом `GetWorldSystemsConfig()`. |
| `m_sName`, `m_sAuthor`, `m_sDescription`, `m_sDetails` | да | Обычные строковые атрибуты. |
| `m_sIcon`, `m_sLoadingScreen`, `m_sPreviewImage`, `m_sBriefingConfig` | да | `ResourceName`; в JSON — строка с GUID-квалифицированным путём. |
| `m_sGameMode` | да | Строка. |
| `m_iPlayerCount` | да | int. |
| `m_eEditableGameFlags`, `m_eDefaultGameFlags` | да | Битовая маска int. |
| `m_eSaveTypes` | да | Битовая маска int. |
| все `m_b*` | да | bool. В JSON — `true`/`false`, в `.conf` — `1`/`0`. |
| все `m_i*`, `m_f*` | да | int / float. |
| `m_aFactionLimits` | да | Массив объектов. |
| `m_aCampaignCustomBaseList` | да | Массив объектов. |

> **Важно про булевы значения.** В `.conf` сценариев булевы поля записаны как `0`/`1`
> (`m_bSpawnRandomCaches 1`). В `server.json` это JSON, поэтому пишите `true`/`false`.
> Если в логе появилось `Parameter 'm_bSpawnRandomCaches' is not supported type!` —
> значит тип не совпал.

---

## 5. Рабочие примеры

### 5.1 Полный `missionHeader` для Conflict

Проверено на реальном выделенном сервере (сборка 1.8.0.13) — конфиг проходит
валидацию схемы (`JSON is Valid`).

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

### 5.2 Минимальный осмысленный набор

Если хочется просто зафиксировать время суток и поднять опыт, этого достаточно:

```json
"missionHeader": {
  "m_iStartingHours": 12,
  "m_iStartingMinutes": 30,
  "m_bOverrideScenarioTimeAndWeather": true,
  "m_fXpMultiplier": 2.0
}
```

> `m_bOverrideScenarioTimeAndWeather` здесь не для красоты. Его значение по умолчанию — `0`,
> а при `0` время и погода берутся из сценария, так что `m_iStartingHours`/`m_iStartingMinutes`
> ни на что не влияют — молча, потому что `missionHeader` пишет в лог только об ошибках (§7).
> Кроме того, для переопределения нужен `SCR_TimeAndWeatherHandlerComponent` на сущности
> игрового режима (таблица полей, §3).

### 5.3 Полный пример со всеми ключами кампании

```json
"missionHeader": {
  "m_sName": "Conflict — Everon (custom)",
  "m_sAuthor": "My Community",
  "m_sDescription": "Захват точек с удвоенным опытом",
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

> `m_eStartingRank: 2` здесь — `CORPORAL` (см. §3.2). Значения выше `18`
> (`CUSTOM10`) использовать нельзя: сетевой диапазон ограничен `INVALID-1`.
> Ставьте число от `0` до `18`; `1` — `PRIVATE`, то есть ванильное поведение.

### 5.4 Для Game Master (`SCR_MissionHeader`)

Здесь доступны только базовые поля — всё, что относится к кампании
(`m_iStartingHQSupplies`, `m_bCommanderRoleEnabled`, `m_eStartingRank` и т. д.),
будет проигнорировано. Разумный набор:

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

## 6. Как это выглядит в самом файле сценария

Для сравнения — реальные ванильные `.conf`, извлечённые из `data007.pak`.
Именно эти значения `missionHeader` переопределяет.

`Missions/23_Campaign.conf` (сокращённо, класс `SCR_MissionHeaderCampaign`):

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

`Missions/21_GM_Eden.conf` (класс `SCR_MissionHeader`):

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

Обратите внимание: строки вида `#AR-...` — это ключи таблицы локализации,
а не литеральный текст. В `missionHeader` можно писать и обычный текст.

---

## 7. Проверка

1. Соберите конфиг и запустите сервер.
2. Убедитесь, что в логе есть `BACKEND : JSON is Valid`.
3. Поищите в `console.log` строки `Server Config MissionHeader:` — если они есть,
   соответствующий параметр был отброшен, и в тексте будет его имя.
4. Проверьте поведение в игре (время суток, стартовое звание, лимиты фракций).
   `missionHeader` не выводит в лог подтверждение применения — только ошибки.

---

## 8. Источники и границы достоверности

| Что | Откуда |
|---|---|
| Поля `SCR_MissionHeaderCampaign` и их атрибуты (значения по умолчанию, описания, диапазоны ползунков) | `scripts/Game/Mission/SCR_MissionHeaderCampaign.c`, прочитан из `addons/data/data007.pak` установленной сборки 1.8.0.13 через [`tools/pak.mjs`](../../tools/pak.mjs); список сверен с Arma Reforger Explorer 1.7.0.54, откуда он был взят до появления этой сборки |
| Поля `SCR_MissionHeader` и методы `IsMultiplayer()` / `GetFactionLimitMap()` | `scripts/Game/Mission/SCR_MissionHeader.c`, тот же архив и тот же инструмент |
| Состав базового класса `MissionHeader` и тот факт, что `World`/`SystemsConfig` только читаются | `scripts/Game/generated/Mission/MissionHeader.c` (файл вытащен прямо из `data007.pak`, читается без сжатия) |
| `EGameFlags` (`Metabolism=1`, `SpawnVehicles=2`, `SpawnAI=4`), применение флагов и типов сохранений в `OnMissionSet()` | `scripts/Game/game.c`, строки 16–22 и 258–273 |
| `ESaveGameType` (`MANUAL`, `AUTO`, `SCRIPTED`, `SHUTDOWN`) | `scripts/Game/generated/Plugins/Persistence/SaveGame/ESaveGameType.c` |
| Структура `SCR_FactionLimit` (`m_sFactionKey`, `m_iFactionLimit`) | `scripts/Game/Mission/SCR_FactionLimit.c` |
| **Числовые значения `SCR_ECharacterRank`** (20 членов, `INVALID = 19`) | Объявление enum в конце `scripts/Game/Ranks/SCR_RankInfo.c` в архиве 1.8.0.13. Подтверждено двумя независимыми проверками: диапазоном репликации `0..INVALID-1` в `SCR_CharacterRankComponent.RplSave/RplLoad` и дефолтом `defvalue: "1"` = `PRIVATE` |
| Поля `SCR_RankInfo`, логика `SCR_RankContainer` (`GetRankByXP`, `GetNextRank`, `GetPreviousRank`) | Исходники `scripts/Game/Ranks/SCR_RankInfo.c` и `scripts/Game/Ranks/SCR_RankContainer.c` |
| Поля `SCR_CampaignCustomBase` (имена, типы, значения атрибутов по умолчанию, описание «Base entity name as set up in World Editor», геттеры) | `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`, строки 2956–3009 установленного архива 1.8.0.13, прочитано [`tools/cscript.mjs`](../../tools/cscript.mjs). Это заменяет API-документацию Bohemia, которой раздел пользовался до появления этой сборки: класс лежит в архиве, поэтому его значения по умолчанию больше не выводятся из компонента, в который они копируются |
| Поведение `ApplyHeaderSettings`, `SetAsHQ`, `Disable`, `RecalculateRadioRange` | `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c`, строки 664–693, 1015–1035 и соседние методы, тот же архив |
| Цикл сопоставления, ветки whitelist/blacklist и требование двух штабов | `scripts/Game/GameMode/SCR_GameModeCampaign.c`, `InitalBaseSetup()`, строки 615–734, тот же архив; `refs InitalBaseSetup` показывает, что вызов у него один |
| Значения по умолчанию `m_bIsControlPoint` (`"0"`), `m_bCanBeHQ` (`"0"`), `m_bDisableWhenUnusedAsHQ` (`"1"`), `m_fRadioRange` (`"-1"`) | `[Attribute]`-декораторы тех же полей в `SCR_CampaignMilitaryBaseComponent.c` (строки 39–58) и в `SCR_CampaignCustomBase` (строки 2959–2972) |
| Какой базе соответствует каждый `m_sBaseName`, по мирам | [каталог баз](ArmaReforger_VanillaBases_RU.md) и [`tools/ebin.mjs`](../../tools/ebin.mjs) |
| Реальные значения в сценариях | `Missions/23_Campaign.conf`, `Missions/21_GM_Eden.conf`, извлечены из `data007.pak` инструментом `tools/pak.mjs` (GUID в `World` перечитаны из установленного архива 1.8.0.13 и сверены с `resourceDatabase.rdb`, см. §2.1) |
| Ванильный `m_sFactionKey` фракции FIA (`"FIA"`) и то, что ваниль закрывает её через `m_iFactionLimit 0` | `Missions/23_Campaign_Montignac.conf` и `Missions/23_Campaign_Western.conf`, прочитаны целиком из `data007.pak` инструментом `tools/pak.mjs` — вместе со строкой заголовка. Перекрёстная проверка принадлежности ключа зарегистрированной фракции: `Prefabs/MP/Campaign/CampaignFactionManager.et` создаёт `Configs/Factions/FIA_Campaign.conf`. **Трактовка `0` как «без игроков» выведена из того, что «без ограничения» — это `-1`**; запуском сервера она не проверялась |
| Что происходит с фракцией, которой нет в `m_aFactionLimits`, — лимита нет, это то же самое, что `-1` | Тело `GetFactionLimitMap()` в `scripts/Game/Mission/SCR_MissionHeader.c` (вставляются только указанные ключи, запись с пустым ключом пропускается) и содержимое массива в ванильных `Missions/23_Campaign_Montignac.conf` / `23_Campaign_Western.conf`, где `US` и `USSR` отсутствуют, хотя играют там именно за них. Потребитель — `SCR_FactionManager.EOnInit()`, вызов `SetPlayerLimit()` в нём стоит под условием `playerTotalLimit >= 0`. Переход от «нет записи» к «нет лимита» — по-прежнему **чтение кода и этого использования, а не поведение, наблюдённое в игре**. Смысл `0` и `-1` называет и сторонний гайд [Arma Reforger Conflict server settings](https://loafhosts.com/guides/arma-reforger-conflict-server-settings) (проверен на 1.8.0.13) |
| Пример формата конфига званий, пороги опыта всех трёх ванильных контейнеров и поля `SCR_RankInfoCampaign` | `Configs/Ranks/BaseMilitaryRanks.conf`, `FIAMilitaryRanks.conf`, `NonCombatantRanks.conf` и `scripts/Game/GameMode/FactionManager/SCR_CampaignFactionManager.c`, прочитаны из установленного архива 1.8.0.13 инструментом `tools/pak.mjs` (см. §3.3) |
| Подтверждение имён полей `m_aCampaignCustomBaseList` и того, что `m_fRadioRange` — в метрах | Сторонний гайд [Arma Reforger Conflict server settings](https://loafhosts.com/guides/arma-reforger-conflict-server-settings) (проверен на 1.8.0.13). Использован только как перекрёстная проверка; всё остальное в §3.4 — из кода |
| Формат ошибок `Server Config MissionHeader: ...` | Строки `ArmaReforgerServer.exe` сборки 1.8.0.13 |

### Чего в этом документе нет

- **Полей `SCR_MissionHeaderCombatOps` и `SCR_MissionHeaderScenarioFramework`.**
  Второй добавляет поля сценарного фреймворка (`m_iMaxNumberOfTasks`, `m_aTaskTypesAvailable`,
  `m_aDebugAreas`, `m_iDynamicDespawn`, `m_iUpdateRate`, `m_aFactionAliases` и др.), а первый —
  его наследник, а не сосед. Они относятся к конкретным сценариям Combat Ops и здесь не разбирались.
- **Поведения списка баз, в отличие от его данных.** §3.4 объясняет, что код делает с
  `m_aCampaignCustomBaseList`; ничего из этого не наблюдалось на запущенном сервере — ни один
  список из этого репозитория не применялся к живой партии Conflict. Имена, с которыми список
  обязан совпадать, лежат в [каталоге баз](ArmaReforger_VanillaBases_RU.md), и они получены
  механически.
- **Кто потребляет `GetFactionLimitMap()` и что игра делает, когда указанная фракция
  заполнена.** Ответ теперь есть в исходниках, которые **читаются**:
  `scripts/Game/GameMode/FactionManager/SCR_FactionManager.c`. В `EOnInit()`, на серверной
  стороне, менеджер строит две карты — `missionHeader.GetFactionLimitMap()` и
  `GetFactionLimitMapCLI()` — и для каждой фракции берёт

  ```c
  playerMissionLimit = missionFactionLimitMap.Get(scriptedFactionKey);   // нет записи -> -1
  if (cliFactionLimitMap.Contains(scriptedFactionKey))
      playerTotalLimit = playerMissionLimit >= 0
          ? Math.Min(playerMissionLimit, cliFactionLimitMap.Get(scriptedFactionKey))
          : cliFactionLimitMap.Get(scriptedFactionKey);
  if (playerTotalLimit < 0 && playerMissionLimit >= 0)
      playerTotalLimit = playerMissionLimit;
  if (playerTotalLimit >= 0)
      scriptedFaction.SetPlayerLimit(playerTotalLimit);
  ```

  То есть лимит из заголовка и лимит из командной строки `-playerLimits` **объединяются
  по минимуму** (побеждает более строгий), а `SetPlayerLimit()` вызывается **только когда
  результат не меньше 0** — это подтверждение на уровне кода, что `-1`/отсутствие записи
  означает «вызова нет, лимита нет», а `0` — «лимит ноль». Отказ в игре при заполненной
  фракции по-прежнему не наблюдался, поэтому §3.1 опирается на тела методов, на то,
  как сам массив заполняет ваниль, и на сторонний гайд.

### Как добыть недостающее

Внутри `pak` читается **всё**: прежнее утверждение этого документа, что сжатые `.c` и
`.conf` «зашифрованы», происходило от читателя, который отсчитывал смещения от неверной
базы и падал с `incorrect header check` на каждой сжатой записи (см. §2.1). Пользуйтесь
[`tools/pak.mjs`](../../tools/pak.mjs) — он читает обе формы хранения и сам проверяет
выбранную базу смещений:

```
node tools/pak.mjs list  <путь к data007.pak> "Missions/.*\.conf$"
node tools/pak.mjs cat   <путь к data007.pak> scripts/Game/Ranks/SCR_RankInfo.c
node tools/pak.mjs get   <путь к data007.pak> Missions/23_Campaign.conf out.conf
node tools/pak.mjs find  <путь к data007.pak> "GetFactionLimitMap"
node tools/pak.mjs verify <путь к data007.pak>
```

Именно `find` отвечает на вопрос «кто это вызывает»: он распаковывает записи на месте и
печатает окружающий текст — так и был найден вызов в `SCR_FactionManager` выше.

Arma Reforger Explorer (`https://arexplorer.zeroy.com/`) по-прежнему полезно знать как
**второй источник**: это другая сборка и другой путь извлечения, то есть перекрёстная
проверка, а не необходимость. Его страницы обрезаются при прямом скачивании; приём —
страница вида

```
https://arexplorer.zeroy.com/_<имя_файла_в_нижнем_регистре_с_подчёркиваниями>_8c_source.html
```

прогоняется через `https://www.w3.org/services/html2txt?url=<URL-в-urlencode>&nonums=on`.
Для файлов с неоднозначным именем (например `game.c`, который есть в нескольких
модулях) используется форма с путём: `_game_2game_8c_source.html`. Там есть только
`.c` и `.h` — ни `.conf`, ни `.layout` — и он привязан к более старой сборке, чем
установленная игра, поэтому класса, которого в нём нет, вполне может не быть и в `pak`.
