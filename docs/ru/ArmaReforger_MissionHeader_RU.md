# `missionHeader` в конфиге сервера Arma Reforger — полный разбор

Это дополнение к [основному руководству](ArmaReforger_ServerConfig_RU.md), раздел §5.5.2.
Здесь описано то, чего нет в вики: **какие именно ключи принимает `missionHeader`**,
какие у них типы, значения по умолчанию и что они делают.

Вики про это поле говорит ровно одну фразу — «переопределяет
`SCR_MissionHeaderCampaign` сценария» — и не приводит ни списка ключей, ни типов.
Поэтому всё ниже собрано из исходников классов и проверено на реальных
конфигах ванильных сценариев.

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
MissionHeader                          (база: только методы, полей нет)
├── SCR_MissionHeader                  ← Game Master, Training, Conflict (без AIs)
│   ├── SCR_MissionHeaderCampaign      ← Conflict (23_Campaign*)
│   └── SCR_MissionHeaderSequence      ← кампанийные последовательности
└── SCR_MissionHeaderScenarioFramework
    ├── SCR_MissionHeaderSequence
    └── SCR_MissionHeaderCombatOps     ← Combat Ops (24_CombatOps, CAH_*)
```

Практически важно вот что: **Conflict-сценарии используют `SCR_MissionHeaderCampaign`**,
а Game Master — голый `SCR_MissionHeader`. Поэтому один и тот же ключ в
`missionHeader` сработает на Conflict и будет молча проигнорирован на Game Master.

Ванильные конфиги подтверждают привязку:

| Файл сценария | Класс в первой строке |
|---|---|
| `Missions/23_Campaign.conf` | `SCR_MissionHeaderCampaign` |
| `Missions/21_GM_Eden.conf` | `SCR_MissionHeader` |
| `Missions/CAH_Morton.conf` | `SCR_MissionHeaderCombatOps` |

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
| `Missions/27_GM_Cain.conf` | `{F2F3CFB83D44833C}worlds/CapeMaster/GM_Cain.ent` | `#AR-Editor_Mission_GM_Kolguyev_Name` |
| `Missions/23_Campaign.conf` | `{DC924A8DDECC73AD}worlds/MP/CTI_Campaign_Eden.ent` | `#AR-Campaign_ScenarioName_Everon` |
| `Missions/23_Campaign_Cain.conf` | *(в этой записи pak нечитаема)* | `Conflict - Kolguyev` |
| `Missions/23_Campaign_Arland.conf` | `{5D71F496D28056E0}worlds/MP/CTI_Campaign_Arland.ent` | `#AR-MainMenu_ConflictArland_Name` |

Дополнительно: в `resourceDatabase.rdb` ресурсы террейна Колгуева лежат целиком в
`worlds/Cain/` (`Cain.ent`, `Cain.smap`, `Cain.smd`, `Cain.topo`, `Cain_SMD.conf`,
`EmptyCain.ent`). Слова «Kolguyev» в путях нет ни одного.

**Что из этого следует практически:**

- Ищете сценарий для Колгуева — смотрите файлы с `Cain`, не ищите «Kolguyev».
  В таблице сценариев ([`ArmaReforger_Scenarios_RU.md`](ArmaReforger_Scenarios_RU.md))
  они подписаны как «Conflict — Cain», потому что имя GUID-ссылки — именно `Cain`.
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
| `m_iControlPointsCap` | int | `-1` | Сколько контрольных точек нужно удержать для победы (переопределение, `-1` — по умолчанию). |
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

Поля одного `SCR_RankInfo`:

| Поле | Тип | По умолч. | Описание |
|---|---|---|---|
| `m_iRank` | `SCR_ECharacterRank` | `1` | ID звания из таблицы §3.2. |
| `m_bIsRenegade` | bool | `0` | Считается ли звание враждебным для своих. |
| `m_iRequiredXP` | int | `100` | Сколько опыта нужно для повышения до этого звания. |
| `m_sRankName` | string | `""` | Название звания (обычно ключ локализации). |
| `m_sRankNameUpper` | string | `""` | Название в верхнем регистре. |
| `m_sRankNameShort` | string | `""` | Короткое название. |
| `m_sInsignia` | string | `""` | Имя квада значка в `MilitaryIcons.imageset`. |

Ванильный `Configs/Ranks/BaseMilitaryRanks.conf` (2496 Б) и `FIAMilitaryRanks.conf`
(1210 Б) **зашифрованы** внутри pak и через доступные инструменты не читаются,
поэтому пороги опыта для военных званий здесь не приводятся.

`Configs/Ranks/NonCombatantRanks.conf` (518 Б) читается, но **с дефектом чтения**:
запись отдаётся одновременно повёрнутой и с захватом лишних байт — в конце файла
виден фрагмент совсем другого конфига (`SCR_ResourceEntityRefundAction`).
Поэтому начало файла (объявление `SCR_RankContainer`) в выдаче отсутствует,
и восстановить его нельзя. Вот что реально удалось прочитать:

```
 SCR_RankInfoCampaign "{68DA91122F6E9408}" {
  m_iRank RENEGADE
  m_bIsRenegade 1
  m_iRequiredXP -101
  m_sRankName "#AR-Rank_Renegade"
  m_sRankNameUpper "#AR-Rank_Renegade-UC"
  m_sInsignia "AR_Renegade"
  m_iRequestCD 1200
  m_iRadioRespawnCooldown 600
  m_iFastTravelCooldown 3600
 }
 SCR_RankInfoCampaign "{68DA91122F6E9405}" {
  m_iRequiredXP -100
  m_sRankName "#AR-Rank_Volunteer"
  m_sRankNameUpper "#AR-Rank_Volunteer-UC"
  m_sInsignia "AR_Rank_OR-2"
 }
```

Из этого фрагмента видно две вещи:

1. **Отрицательный `m_iRequiredXP` — норма.** У `RENEGADE` это `-101`, у Volunteer
   `-100`. Так звание оказывается «ниже» любого, до которого можно дорасти опытом:
   `SCR_RankContainer.GetRankByXP()` выбирает звание с наибольшим `m_iRequiredXP`,
   не превышающим текущий опыт.
2. **Записи в этом файле — класса `SCR_RankInfoCampaign`, а не `SCR_RankInfo`**, и
   несут поля, которых нет в базовом классе (`m_iRequestCD`,
   `m_iRadioRespawnCooldown`, `m_iFastTravelCooldown`). **Состав `SCR_RankInfoCampaign`
   не извлекался** — не считайте таблицу выше исчерпывающей.

> Не делайте из этого фрагмента вывод, что `NonCombatantRanks.conf` не содержит
> объявления `SCR_RankContainer`: оно там почти наверняка есть, просто не попало
> в прочитанный кусок. Порядок записей и полный состав файла неизвестны.

Если заданное `m_eStartingRank` не определено в контейнере званий вашей фракции,
код не падает: `SCR_RankContainer.GetNextRank()` / `GetPreviousRank()` умеют искать
ближайшее определённое звание. Но игрок увидит не то звание, которое вы задали.

### 3.4 `m_aCampaignCustomBaseList` — список пользовательских баз

Это **список переопределений существующих баз на карте**. Каждый элемент описывает одну
базу и меняет её поведение. Новые базы этим списком не создаются: запись лишь находит
уже размещённую в мире базу и настраивает её.

Поля одного элемента (класс `SCR_CampaignCustomBase`):

| Ключ | Тип | По умолч. | Что делает |
|---|---|---|---|
| `m_sBaseName` | string | — | **Имя базы, по которому запись сопоставляется с базой в мире.** См. ниже. |
| `m_bIsControlPoint` | bool | `false` | Считать ли базу контрольной точкой. От этого зависит победа: `SCR_CampaignMilitaryBaseManager.EvaluateControlPoints()` собирает контрольные точки именно по этому флагу. |
| `m_bCanBeHQ` | bool | `false` | Может ли база быть выбрана как главная база (HQ) фракции. |
| `m_bDisableWhenUnusedAsHQ` | bool | `true` | Выключать ли базу, когда фракция перенесла HQ в другое место. |
| `m_fRadioRange` | float, метры | — | Радиус радиосвязи базы. Отрицательное значение (например `-1`) означает «не менять». |

> **Общее замечание §3.0 действует здесь в полную силу.** Список имеет смысл только
> в режимах с военными базами кампании — то есть в Conflict. В Game Master и Combat Ops
> базы кампании не создаются, `ApplyHeaderSettings()` для них не вызывается, и весь
> массив будет проигнорирован без сообщения в логе. Более того, даже внутри Conflict
> итоговое поведение зависит от того, какие базы вообще размещены в конкретном
> сценарии: если базы с указанным `m_sBaseName` в мире нет, запись не сработает.

**Значения по умолчанию — оговорка.** Класс `SCR_CampaignCustomBase` отсутствует в
arexplorer 1.7.0.54 (он новее), а API-документация отдаёт только имена членов без
`[Attribute]`-декораторов. Значения в таблице взяты у полей компонента
`SCR_CampaignMilitaryBaseComponent`, куда эти значения копируются напрямую
(`ApplyHeaderSettings`), — это обоснованное соответствие, но не проверенный факт.
Для `m_fRadioRange` значение по умолчанию не приводится: в исходнике видно только,
что отрицательное число трактуется как «не переопределять».

#### Как работает сопоставление

```
SCR_CampaignMilitaryBaseComponent.ApplyHeaderSettings(SCR_CampaignCustomBase settings)
{
    m_bCanBeHQ                = settings.GetCanBeHQ();
    m_bDisableWhenUnusedAsHQ  = settings.GetDisableWhenUnusedAsHQ();
    m_bIsControlPoint         = settings.IsControlPoint();

    SCR_CoverageRadioComponent coverageComp =
        SCR_CoverageRadioComponent.Cast(GetOwner().FindComponent(SCR_CoverageRadioComponent));
    if (coverageComp)
        coverageComp.SetIsSource(m_bCanBeHQ);        // ← HQ-статус влияет на радио

    float radioRange = settings.GetRadioRange();
    if (radioRange < 0)
        return;                                       // ← отрицательный радиус = не трогать

    BaseRadioComponent radio =
        BaseRadioComponent.Cast(GetOwner().FindComponent(BaseRadioComponent));
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

1. **Обратите внимание: `m_sBaseName` в `ApplyHeaderSettings` не используется.**
   Имя нужно только для поиска базы; сам код копирования имя не переписывает.
2. **`m_bCanBeHQ` управляет не только выбором HQ.** Он же включает базу как *источник*
   радиосвязи (`SetIsSource`). То есть база с `m_bCanBeHQ: true` становится ретранслятором.
3. **`m_fRadioRange` задаёт только *базовый* радиус.** Дальше `RecalculateRadioRange()`
   поднимает его до максимального радиуса среди построенных на базе антенн
   (`SCR_EServicePointType.RADIO_ANTENNA`). То есть антенна может увеличить радиус,
   но не уменьшить ниже заданного.
4. **Если `m_fRadioRange` отрицательный, три булевых поля всё равно применяются** —
   ранний `return` стоит уже после их присваивания.

#### Как работает `m_bDisableWhenUnusedAsHQ`

Флаг читается в `SetAsHQ()`: когда база становится главной, у той же фракции проверяется
предыдущая главная база, и если у неё этот флаг включён — она выключается.

```
previousHQ = faction.GetMainBase();
if (previousHQ && previousHQ != this && previousHQ != enemyHQ)
{
    if (previousHQ.GetDisableWhenUnusedAsHQ())
        previousHQ.Disable();
}
```

`Disable()` снимает питание с радиокомпонента, удаляет стартовую технику, снимает
привязку фракции и удаляет построенную композицию базы. Поэтому `false` здесь означает
«оставить бывшую главную базу живой», а `true` (значение по умолчанию) — «погасить её».

#### `m_bCustomBaseWhitelist` — как читается список

Отдельное поле заголовка определяет смысл всего массива:

| `m_bCustomBaseWhitelist` | Смысл `m_aCampaignCustomBaseList` |
|---|---|
| `false` (по умолчанию) | **Чёрный список**: перечисленные базы исключаются / не используются как обычно. |
| `true` | **Белый список**: используются только перечисленные базы. |

Формулировка взята из описания атрибута: *«Use custom base list whitelist instead of
blacklist»*. **Точная реализация фильтрации в коде не проверялась** — я не нашёл
функцию, которая обходит массив и сравнивает имена: она находится в коде новее
arexplorer 1.7.0.54. Не полагайтесь на эту таблицу как на точное описание того,
какие именно базы будут отброшены.

#### Пример

```json
"missionHeader": {
  "m_bCustomBaseWhitelist": false,
  "m_aCampaignCustomBaseList": [
    {
      "m_sBaseName": "Morton",
      "m_bIsControlPoint": true,
      "m_bCanBeHQ": true,
      "m_bDisableWhenUnusedAsHQ": true,
      "m_fRadioRange": 3000
    },
    {
      "m_sBaseName": "Camp Blake",
      "m_bIsControlPoint": false,
      "m_bCanBeHQ": false,
      "m_bDisableWhenUnusedAsHQ": true,
      "m_fRadioRange": -1
    }
  ]
}
```

> **Про `m_sBaseName`.** Какое именно значение сюда подставлять — локализованное
> отображаемое имя (`GetBaseName()`, по умолчанию `"#AR-MapSymbol_Installation"`),
> его вариант в верхнем регистре или `m_sMapLocationName` — **не установлено**.
> Строка должна совпадать с тем, что записано в `m_sBaseName` у базы в мире.
> Это значение видно в Prefab Editor / World Editor у компонента
> `SCR_CampaignMilitaryBaseComponent` (поле «Base Name», категория **Campaign**),
> и его же удобно посмотреть в GUI Workbench на нужной базе.
> Не подставляйте название карты наугад — при несовпадении запись просто ни на что
> не повлияет, без ошибки в логе.

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

Проверено на реальном выделенном сервере (сборка 1.6.0.119) — конфиг проходит
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
 World "{DC924A8DDECC73AD}worlds/MP/CTI_Campaign_Eden.ent"
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
 World "{77C41EA429B6AC35}worlds/GameMaster/GM_Eden.ent"
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
| Поля `SCR_MissionHeaderCampaign` и их атрибуты (значения по умолчанию, описания, диапазоны ползунков) | Исходник `scripts/Game/Mission/SCR_MissionHeaderCampaign.c` через Arma Reforger Explorer 1.7.0.54 |
| Поля `SCR_MissionHeader` и методы `IsMultiplayer()` / `GetFactionLimitMap()` | Исходник `scripts/Game/Mission/SCR_MissionHeader.c` |
| Состав базового класса `MissionHeader` и тот факт, что `World`/`SystemsConfig` только читаются | `scripts/Game/generated/Mission/MissionHeader.c` (файл вытащен прямо из `data007.pak`, читается без сжатия) |
| `EGameFlags` (`Metabolism=1`, `SpawnVehicles=2`, `SpawnAI=4`), применение флагов и типов сохранений в `OnMissionSet()` | `scripts/Game/game.c`, строки 16–22 и 258–273 |
| `ESaveGameType` (`MANUAL`, `AUTO`, `SCRIPTED`, `SHUTDOWN`) | `scripts/Game/generated/Plugins/Persistence/SaveGame/ESaveGameType.c` |
| Структура `SCR_FactionLimit` (`m_sFactionKey`, `m_iFactionLimit`) | `scripts/Game/Mission/SCR_FactionLimit.c` |
| **Числовые значения `SCR_ECharacterRank`** (20 членов, `INVALID = 19`) | Объявление enum в конце `scripts/Game/Ranks/SCR_RankInfo.c` через Arma Reforger Explorer. Подтверждено двумя независимыми проверками: диапазоном репликации `0..INVALID-1` в `SCR_CharacterRankComponent.RplSave/RplLoad` и дефолтом `defvalue: "1"` = `PRIVATE` |
| Поля `SCR_RankInfo`, логика `SCR_RankContainer` (`GetRankByXP`, `GetNextRank`, `GetPreviousRank`) | Исходники `scripts/Game/Ranks/SCR_RankInfo.c` и `scripts/Game/Ranks/SCR_RankContainer.c` |
| Поля `SCR_CampaignCustomBase` (имена, типы, геттеры) | API-документация Bohemia: страница класса и список членов (`interfaceSCR__CampaignCustomBase.html` / `-members.html`). Из них же видно, что класс сгенерирован из `Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c` |
| Поведение `ApplyHeaderSettings`, `SetAsHQ`, `Disable`, `RecalculateRadioRange` | Исходник `scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c` через arexplorer |
| Значения по умолчанию `m_bIsControlPoint` (`"0"`), `m_bCanBeHQ` (`"0"`), `m_bDisableWhenUnusedAsHQ` (`"1"`) | `[Attribute]`-декораторы тех же полей в `SCR_CampaignMilitaryBaseComponent.c` |
| Реальные значения в сценариях | `Missions/23_Campaign.conf`, `Missions/21_GM_Eden.conf`, извлечены из `data007.pak` |
| Ванильный `m_sFactionKey` фракции FIA (`"FIA"`) и то, что ваниль закрывает её через `m_iFactionLimit 0` | `Missions/23_Campaign_Montignac.conf` и `Missions/23_Campaign_Western.conf`, извлечены из `data007.pak` (в обоих файлах блок `m_aFactionLimits` цел; строка заголовка потеряна тем же дефектом чтения — запись отдаётся повёрнутой и с захватом лишних байт). Перекрёстная проверка принадлежности ключа зарегистрированной фракции: `Prefabs/MP/Campaign/CampaignFactionManager.et` создаёт `Configs/Factions/FIA_Campaign.conf`. **Трактовка `0` как «без игроков» выведена из того, что «без ограничения» — это `-1`**; запуском сервера она не проверялась |
| Что происходит с фракцией, которой нет в `m_aFactionLimits`, — лимита нет, это то же самое, что `-1` | Тело `GetFactionLimitMap()` в `scripts/Game/Mission/SCR_MissionHeader.c` (вставляются только указанные ключи, запись с пустым ключом пропускается) и содержимое массива в ванильных `Missions/23_Campaign_Montignac.conf` / `23_Campaign_Western.conf`, где `US` и `USSR` отсутствуют, хотя играют там именно за них. Переход от «нет записи» к «нет лимита» — **чтение кода и этого использования, а не поведение, наблюдённое в игре**. Смысл `0` и `-1` называет и сторонний гайд [Arma Reforger Conflict server settings](https://loafhosts.com/guides/arma-reforger-conflict-server-settings) (проверен на 1.8.0.13) |
| Пример формата конфига званий | `Configs/Ranks/NonCombatantRanks.conf` (единственный из `Configs/Ranks/*`, который не зашифрован) |
| Подтверждение имён полей `m_aCampaignCustomBaseList` и того, что `m_fRadioRange` — в метрах | Сторонний гайд [Arma Reforger Conflict server settings](https://loafhosts.com/guides/arma-reforger-conflict-server-settings) (проверен на 1.8.0.13). Использован только как перекрёстная проверка; всё остальное в §3.4 — из кода |
| Формат ошибок `Server Config MissionHeader: ...` | Строки `ArmaReforgerServer.exe` сборки 1.6.0.119 |

### Чего в этом документе нет

- **Порогов опыта (`m_iRequiredXP`) для военных званий.** Файлы
  `Configs/Ranks/BaseMilitaryRanks.conf` (2496 Б) и `FIAMilitaryRanks.conf` (1210 Б)
  зашифрованы внутри pak и через доступные инструменты не читаются. Известен только
  формат (см. §3.3) и значения для некомбатантов.
- **Полей `SCR_RankInfoCampaign`.** В `NonCombatantRanks.conf` используются записи
  именно этого класса, и они содержат поля, которых нет в базовом `SCR_RankInfo`
  (`m_iRequestCD`, `m_iRadioRespawnCooldown`, `m_iFastTravelCooldown`). Полный состав
  наследника не извлекался.
- **Полей `SCR_MissionHeaderCombatOps` и `SCR_MissionHeaderScenarioFramework`.**
  Первый — почти пустой наследник, второй добавляет поля сценарного фреймворка
  (`m_iMaxNumberOfTasks`, `m_aTaskTypesAvailable`, `m_aDebugAreas`, `m_iDynamicDespawn`,
  `m_iUpdateRate`, `m_aFactionAliases` и др.). Они относятся к конкретным сценариям
  Combat Ops и здесь не разбирались.
- **Значений по умолчанию класса `SCR_CampaignCustomBase`.** Его `[Attribute]`-декораторы
  недоступны: класс отсутствует в arexplorer 1.7.0.54, а в API-документации видны только
  имена членов. Значения в §3.4 приведены по полям компонента, куда они копируются, —
  это обоснованное соответствие, а не проверенный факт.
- **Кто потребляет `GetFactionLimitMap()` и что игра делает, когда указанная фракция
  заполнена.** Скрипты внутри `data007.pak` зашифрованы (`incorrect header check`), а поиск
  по имени метода среди читаемых записей не находит ни одного вызова, поэтому потребитель
  карты не найден и отказ в игре ни разу не наблюдался. §3.1 опирается на тело метода, на то,
  как сам массив заполняет ваниль, и на сторонний гайд.

### Как добыть недостающее

Сжатые `.c` из `pak` прочитать нельзя (шифрование, ошибка `incorrect header check`),
но исходники доступны через Arma Reforger Explorer. Приём: страница вида

```
https://arexplorer.zeroy.com/_<имя_файла_в_нижнем_регистре_с_подчёркиваниями>_8c_source.html
```

прогоняется через `https://www.w3.org/services/html2txt?url=<URL-в-urlencode>&nonums=on`.
Для файлов с неоднозначным именем (например `game.c`, который есть в нескольких
модулях) используется форма с путём: `_game_2game_8c_source.html`.

Готовый инструмент для извлечения **несжатых** файлов прямо из `pak` —
[`tools/pak-tool.mjs`](../../tools/pak-tool.mjs):

```
node tools/pak-tool.mjs get <путь к data007.pak> scripts/Game/generated/Mission/MissionHeader.c out.c
node tools/pak-tool.mjs list <pak> "Missions/.*\.conf$"
```

> ⚠️ Извлечённые из `pak` файлы часто возвращаются **циклически сдвинутыми**
> (известный баг: видны хвост и начало, точка разреза потеряна). Хвост при этом
> не теряется — это поворот, а не обрезка. Для разворота есть два инструмента:
>
> - [`tools/unrotate.mjs`](../../tools/unrotate.mjs) — рабочий вариант для `.conf`
>   сценариев. Ищет **последнее** вхождение маркера `SCR_MissionHeader*` и разворачивает
>   буфер по нему. Проверен на `Missions/23_Campaign.conf`, `21_GM_Eden.conf`,
>   `CAH_Morton.conf` — все три дали корректную первую строку.
> - [`tools/repair-rotated.mjs`](../../tools/repair-rotated.mjs) — запасной вариант для
>   случая, когда файл не начинается с объявления класса и сдвиг попал на границу
>   строки. Перебирает позиции после переводов строк с конца и выбирает ту, при
>   которой первая строка совпадает с заданным regex. **На реальных данных пока не
>   срабатывал** — оставлен как инструмент на будущее.
>
> Важно: эти инструменты лечат только **сдвиг**. Если запись прочитана ещё и с
> захватом лишних байт (как `NonCombatantRanks.conf` в §3.3), восстановить её нельзя.
> Отдельно: часть записей `pak` **зашифрована** (не обычный zlib, поэтому `inflate`
> даёт `incorrect header check`) — такие файлы доступны только через GUI Workbench.
