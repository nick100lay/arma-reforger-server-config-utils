# Причины кика и отключения в Arma Reforger

Что игроку пишут, когда сеанс заканчивается, откуда берётся эта причина и что каждая из них значит.

**Сборка, на которой проверено:** Arma Reforger 1.8.0.13 (engine 192142) — перечисления и пресеты
диалогов прочитаны из архивов самой сборки (`addons/core/data.pak`, `addons/data/data007.pak`),
тексты — из её таблицы локализации, а нумерация и поведение диалога — из лога клиента этой сборки.
§9 называет источник каждого утверждения и то, что установить не удалось.

---

## 0. С чего начать

Почти все ошибки чтения причины сводятся к трём:

1. **Причина — это пара, а не слово.** Конец сеанса всегда несёт `KickCauseCode`, то есть
   **группу** плюс **причину**: `PLAYER_MANAGER` + `KICK`, `REPLICATION` + `SHUTDOWN`. `SHUTDOWN`
   сам по себе — не группа, а `PLAYER_KICK` — не причина; вместе они дают тег диалога
   `GROUP_REASON` (`PLAYER_MANAGER_KICK`), и искать надо именно эту строку.
2. **Причина говорит, как закончился сеанс, а не за что игрока выкинули.** Причину получает и тот,
   кто вышел сам, и тот, кого выкинуло, и все, кого отключил остановленный сервер. Все двадцать
   строк с причиной в измеренном здесь логе клиента (§9.2) приходят *после* того, как игра уже
   вернулась в главное меню.
3. **Номер в логе — не позиция в файле перечисления.** Для группы `REPLICATION` в поставленном
   `RplError.c` первым идёт `SYSTEM_FAILURE`, а лог пишет `reason=1`; для `PLAYER_MANAGER`
   нумерация с файлом совпадает (`KICK` — 0, `BAN` — 3). Ориентируйтесь на имя в кавычках, а номер
   считайте вторым мнением (§9.3).

## 1. Из чего состоит код

`KickCauseCode` — непрозрачный 64-битный хэндл: `scripts/GameLib/generated/KickCauseCode.c`
называет его «opaque code representing various reasons for ending gameplay … consists of two parts:
category and reason», и каждая система должна публиковать свой список причин. `[binary]`

Сервер и клиент передают его по каналу репликации: в исполняемом файле есть строки
`RplConnection::Rpc_DisconnectReason_O sent kickCode=0x%08X` и
`Attempting to disconnect a player once the connection is already being severed. identity=0x%08X
kickCode=0x%08X`. `[binary]`

Имена в этом документе — те, что печатает на клиенте `typename.EnumToString`, то есть ровно то, что
объявляют перечисления:

| Номер группы | Перечисление | Где объявлено |
|---|---|---|
| 0 | `RplKickCauseGroup.NONE` | `scripts/Core/generated/RplKickCauseGroup.c` |
| 1 | `RplKickCauseGroup.REPLICATION` | тот же файл |
| 2 | `KickCauseGroup.BATTLEYE_INIT` | `scripts/GameLib/generated/KickCauseGroup.c` |
| 3 | `KickCauseGroup.BATTLEYE` | тот же файл |
| 4 | `KickCauseGroup.DATA` | тот же файл |
| 5 | `KickCauseGroup2.PLATFORM` | `scripts/Game/generated/GameStateTransitions/KickCauseGroup2.c` |
| 6 | `KickCauseGroup2.PLAYER_MANAGER` | тот же файл |

`KickCauseGroup: RplKickCauseGroup` продолжает перечисление движка, а `KickCauseGroup2` продолжает
результат ещё раз; номера идут в порядке объявления, `0` означает «группы нет». Номера 1, 3, 4 и 6
подтверждены измеренными здесь логами и публичными сообщениями (§9.2); 2 и 5 — две оставшиеся
позиции, в логе они не встречались. `[binary]` `[practice]`

В каждой группе свой список причин, объявленный в том файле, на который указывает имя перечисления:

| Группа | Перечисление причин | Файл |
|---|---|---|
| `REPLICATION` | `RplError` | `scripts/Core/generated/Replication/RplError.c` |
| `BATTLEYE_INIT` | `BattlEyeInitError` | `scripts/GameLib/generated/BattlEyeInitError.c` |
| `BATTLEYE` | `BattlEyeKickReason` | `scripts/GameLib/generated/BattlEyeKickReason.c` |
| `DATA` | `DataError` | `scripts/GameLib/generated/DataError.c` |
| `PLATFORM` | `PlatformKickReason` | `scripts/Game/generated/GameStateTransitions/PlatformKickReason.c` |
| `PLAYER_MANAGER` | `PlayerManagerKickReason` | `scripts/Game/generated/Network/PlayerManagerKickReason.c` |
| `PLAYER_MANAGER` | `SCR_PlayerManagerKickReason` (расширение) | `scripts/GameCode/Online/SCR_PlayerManagerKickReason.c` |

Связь группы с перечислением — атрибут `[KickCauseGroupLink("…")]` на перечислении, и движок его
проверяет. Мод, который ошибётся, получит при загрузке одну из четырёх строк — все `[binary]` и все
есть в исполняемом файле 1.8.0.13:

```text
Duplicate reason value %u for variable '%s' in enum assigned to KickCauseGroup '%s'.
Enum '%s' has KickCauseGroupLink("%s") but no matching KickCauseGroup value exists.
Multiple enums assigned to KickCauseGroup '%s': '%s'.
KickCauseGroup is missing assigned enum to group '%s'.
```

Поэтому мод может добавить свои причины в существующую группу, и они отобразятся правильно: группа
и причина передаются числами, а имя клиент берёт из *своей* копии перечисления — вот почему причина,
которой в сборке клиента нет, отображается как `<unknown>`.

## 2. `REPLICATION` — группа, в которую попадает почти всё необъяснимое

Это собственная группа транспорта: она говорит, что сеанс завершил слой репликации, и её причины —
самая полезная часть документа, потому что именно их видит игрок, когда «сервер просто выкинул».
Во втором столбце — номер, который печатает лог 1.8.0.13; почему он не совпадает с порядком в файле,
объясняет §9.3.

| № | Причина | Почему случается | Источник |
|---|---|---|---|
| 1 | `SYSTEM_FAILURE` | Внутренняя ошибка системы репликации — общая причина, подробностей в логе нет | `[practice]` |
| 2 | `DISCONNECTION` | Сеанс сознательно закрыла одна из сторон | `[binary]` |
| 3 | `CONNECTION_FAILURE` | Соединение не удалось установить или оно оборвалось | `[binary]` |
| 4 | `TIMEOUT` | Сервер перестал слышать клиента и сдался. Комната, которую эта сборка регистрирует на бэкенде, объявляет `rplTimeoutS` = 10 с (`[practice]`, [BackendAPI](ArmaReforger_BackendAPI_RU.md) §4); что это то же самое число, не измерялось | `[practice]` |
| 5 | `FLOODED` | Клиент послал больше трафика, чем сервер принимает на соединении | `[binary]` |
| 6 | `STALLED` | Репликация перестала двигаться, хотя соединение не закрыто: клиент слишком медленный, завис или ещё грузится | `[practice]` |
| 7 | `SERVICE_FAILURE` | Отказал сетевой сервис на стороне сервера | `[binary]` |
| 8 | `JIP_ERROR` | Не удался join-in-progress — передача состояния в уже идущую игру | `[binary]` |
| 9 | `SHUTDOWN` | Сервер уходит: конец миссии, `#restart` или `shutdown` по RCON, остановленный процесс, `-autoshutdown` ([StartupParams](ArmaReforger_StartupParams_RU.md)) | `[practice]` |
| 10 | `CREATION_FAILURE` | Сервер не смог создать игрока или сеанс | `[binary]` |
| 11 | `SERVER_UNREACHABLE` | Сервер недоступен снаружи — классический случай домашнего хостинга за NAT и то, что описывают треды про «reason 11» | `[binary]` |
| 12 | `SERVER_FULL` | Нет свободного слота: достигнут `playerCountLimit` или очередь отказала | `[binary]` |
| 13 | `PROTOCOL_MISMATCH` | Стороны говорят на разных версиях сетевого протокола | `[binary]` |

Там, где объяснение не написано в коде, оно выведено из имени: в логе, кроме номера, ничего нет,
поэтому «клиент завис» для `STALLED` — вывод, а не измерение.

`SHUTDOWN` стоит выделить: это единственная причина, в которой **никогда нет вины игрока** — сервер
решил закончить все сеансы сразу. Два следствия видны в коде. Клиент больше не предлагает перенести
тело игрока через такое отключение: `SCR_ReconnectComponent.HandlePlayerDisconnect` возвращает
`false` для `RplError.SHUTDOWN` (`scripts/Game/GameMode/Components/SCR_ReconnectComponent.c`),
поэтому после перезапуска игрок начинает с нуля, а не переподключается. И уведомление остальным
игрокам *не* отправляется: отправитель объявляет кик только тогда, когда для причины есть непустой
текст диалога или задан таймаут (`SCR_NotificationSenderComponent`). `[binary]` `[practice]`

## 3. `DATA` — клиент и сервер расходятся в контенте

`DATA` — не сетевая ошибка: сеанс заканчивается потому, что стороны не могут играть в одну и ту же
игру. На модовом сервере подозревать надо в первую очередь эту группу.

| № | Причина | Почему случается |
|---|---|---|
| 0 | `VERSION_MISMATCH` | Версия игры у клиента не та, которую поддерживает сервер |
| 1 | `RDB_MISMATCH` | База ресурсов отличается существенным образом |
| 2 | `SCRIPT_MISMATCH` | Скрипты отличаются — скриптовый мод или другая его сборка |
| 3 | `WORLD_LOAD_ERROR` | Мир не удалось загрузить |
| 4 | `WORLD_LOAD_INCONSISTENCY` | Реплицируемые части мира не совпадают |
| 5 | `ADDON_LOAD_ERROR` | Мод не загрузился |
| 6 | `IS_DEV_BINARY_MISMATCH` | Dev-сборка пыталась соединиться с обычной |
| 7 | `ADDON_LOAD_MISMATCH` | Набор модов или порядок их загрузки отличаются у клиента и сервера |

Все имена и комментарии — `[binary]`; объяснения выше взяты из комментариев `DataError.c`.

Практическая ловушка — в §7: у `ADDON_LOAD_MISMATCH`, самой частой на практике, **нет своего
пресета диалога**, поэтому игроку показывают общий текст «внутренняя ошибка», а причина видна только
в строке деталей и в логе.

## 4. `BATTLEYE_INIT` и `BATTLEYE`

Античит отчитывается двумя группами, потому что его отказы бывают двух разных видов.

`BATTLEYE_INIT` — клиент вообще не смог поднять BattlEye:

| № | Причина | Почему случается |
|---|---|---|
| 0 | `LOAD_ERROR` | Сервис BattlEye не установлен или не загрузился |
| 1 | `UNSUPPORTED_VERSION` | Установленная версия сервиса не поддерживается |
| 2 | `OTHER_ERROR` | Всё остальное при инициализации |

`BATTLEYE` — сеанс закончил сам BattlEye; причины — те же, что в его собственных сообщениях:

| № | Причина | Почему случается |
|---|---|---|
| 0 | `UNKNOWN` | Причина неизвестна |
| 1 | `CLIENT_NOT_RESPONDING` | Клиент перестал подтверждать пакеты сервера |
| 2 | `QUERY_TIMEOUT` | Клиент не отвечает на сканирующие запросы мастер-сервера |
| 3 | `GAME_RESTART_REQUIRED` | Сервис BE (защита) не включён — нужен перезапуск |
| 4 | `BAD_SERVICE_VERSION` | Неподдерживаемая версия сервиса BE |
| 5 | `DISALLOWED_PROGRAM` | Рядом с игрой работает заблокированная программа — это не обязательно читерство |
| 6 | `CORRUPTED_MEMORY` | Проверка целостности не прошла |
| 7 | `CORRUPTED_DATA` | Целостность игры нарушена |
| 8 | `WINAPI_FAILURE` | Критический вызов Windows API завершился ошибкой |
| 9 | `GLOBAL_BAN` | Глобальный бан BattlEye |
| 10 | `ADMIN_BAN` | Бан администратора сервера через BattlEye |
| 11 | `ADMIN_KICK` | Кик администратора сервера через BattlEye |
| 12 | `INVALID_SERVER_CONFIG` | Собственная конфигурация BE на сервере непригодна (нет GameID или master-порта) |

`[binary]` — имена и комментарии из `BattlEyeKickReason.c`; вердикты BE исполняемый файл пишет как
`BattlEye Server: Kick player identity=0x%08X, reason='%s'` и
`BattlEye Server: Disconnect player identity=0x%08X`.

Эти причины существуют только пока включён `game.gameProperties.battlEye`, а он включён по
умолчанию (`[wiki]`, [ServerConfig](ArmaReforger_ServerConfig_RU.md) §5.5). Когда он выключен, ни
`BATTLEYE`, ни `BATTLEYE_INIT` появиться не могут.

## 5. `PLATFORM` — это про аккаунт, а не про сервер

| № | Причина | Почему случается |
|---|---|---|
| 0 | `ACTIVE_USER_LOST` | Пользователь, который запустил игру, больше не активен |
| 1 | `NO_MP_PRIVILEGE` | Аккаунту не разрешён мультиплеер |
| 2 | `NO_CROSSPLAY_PRIVILEGE` | Аккаунту не разрешён кросс-платформенный мультиплеер |
| 3 | `USER_SIGNED_OUT` | Пользователь вышел из онлайн-сервиса платформы |

`[binary]`. Ничего на сервере этих причин вызвать не может, и администратор их не исправит: это
вердикт платформы об аккаунте.

## 6. `PLAYER_MANAGER` — решил человек или собственные правила игры

Это единственная группа, где причина — решение, а не отказ, и единственная, где номера точно
совпадают с файлом скрипта.

| № | Причина | Кто её создаёт |
|---|---|---|
| 0 | `KICK` | Команда `kick` — по RCON или админская чат-команда (`BanCommands.c`: `KickCommand` → `PlayerManagerKickReason.KICK`). В неё же заканчивается автоматическое наказание за огонь по своим |
| 1 | `KICK_VOTED` | Успешное голосование за кик (`SCR_VotingKick.c`), с таймаутом 300 секунд |
| 2 | `DUPLICATE_PLAYER_IDENTITY` | Одна и та же личность подключилась дважды — движок пишет `Another connected player with the same identity found. Dropping this connection request and disconnecting the client` |
| 3 | `BAN` | `ban create` по RCON или бессрочный бан. Единственная причина, уже наблюдённая в этом репозитории на живом сервере: проба бана записала `reason=3` ([Profile](ArmaReforger_Profile_RU.md) §5.7) |
| 4 | `TEMP_BAN` | Бан с таймаутом |
| 5 | `FRIENDLY_FIRE` | Причина, которую может выбрать человек; автоматическое наказание заменяет её на `KICK` или `TEMP_BAN` до отключения |
| 6 | `DISRUPTIVE_BEHAVIOUR` | То же, для неподобающего поведения |
| 10 | `KICKED_BY_GM` | Кик Мастера игры (`SCR_KickPlayerContextAction`, где GM выбирает и причину, и таймаут) |
| 11 | `BANNED_BY_GM` | Бан Мастера игры — таймаут `-1` в этом действии означает «до перезапуска процесса сервера» |

Причины 0–4 — движковое `PlayerManagerKickReason`; 5, 6, 10 и 11 — игровое расширение
`SCR_PlayerManagerKickReason`, которое явно пропускает 7–9. `[binary]`

Три пути попадают в эту группу, хотя администратор ничего не вводил:

- **Голосование.** `Configs/Voting/Kick.conf` запускает голосование при пороге 45 % и минимальном
  участии 45 %; `Auto_Kick.conf` — при 30 %/30 %. Успешный кик по голосованию несёт таймаут
  300 секунд (`PLAYER_VOTE_KICK_DURATION`), то есть игрока не пускают пять минут, а не навсегда.
- **Огонь по своим.** `SCR_DataCollectorCrimesModule` накапливает криминальный счёт и при переходе
  настроенного порога вызывает `ExecutePunishment(…, KICK или TEMP_BAN, …)` — поэтому в диалоге
  будет обычный текст кика или бана, а не текст про огонь по своим.
- **Двойной вход.** Достаточно двух машин на одной личности.

## 7. Что игрок видит на самом деле

Клиент собирает тег `group + "_" + reason` и ищет его в `Configs/ServerBrowser/KickDialogs.conf`.
Если тега нет — откат на одну группу, если нет и её — на `DEFAULT_ERROR`; незнакомая клиенту
группа сразу начинается с `DEFAULT_ERROR` (`game.c`, `OnKickedFromGame`). `[binary]`

Из-за этой цепочки видимый текст часто менее конкретен, чем причина. Свои пресеты есть у тегов:

| Группа | Теги со своим пресетом | Откат на текст группы |
|---|---|---|
| `REPLICATION` | `SYSTEM_FAILURE`, `DISCONNECTION`, `CONNECTION_FAILURE`, `TIMEOUT`, `FLOODED`, `STALLED`, `JIP_ERROR`, `CREATION_FAILURE` | `SERVICE_FAILURE`, `SHUTDOWN`, `SERVER_UNREACHABLE`, `SERVER_FULL`, `PROTOCOL_MISMATCH` |
| `DATA` | `VERSION_MISMATCH`, `RDB_MISMATCH`, `SCRIPT_MISMATCH`, `WORLD_LOAD_ERROR` | `WORLD_LOAD_INCONSISTENCY`, `ADDON_LOAD_ERROR`, `IS_DEV_BINARY_MISMATCH`, `ADDON_LOAD_MISMATCH` |
| `BATTLEYE_INIT` | `LOAD_ERROR`, `UNSUPPORTED_VERSION` | `OTHER_ERROR` |
| `BATTLEYE` | `BAD_SERVICE_VERSION` | все остальные, включая `ADMIN_KICK` и `ADMIN_BAN` |
| `PLATFORM` | `NO_MP_PRIVILEGE`, `USER_SIGNED_OUT` | `ACTIVE_USER_LOST`, `NO_CROSSPLAY_PRIVILEGE` |
| `PLAYER_MANAGER` | `KICK`, `KICK_VOTED`, `BAN`, `TEMP_BAN`, `FRIENDLY_FIRE`, `DISRUPTIVE_BEHAVIOUR`, `KICKED_BY_GM`, `BANNED_BY_GM` | `DUPLICATE_PLAYER_IDENTITY` |

Текст группы — общий: английское «Internal error has occurred.», русское «Произошла ошибка.». Именно
поэтому остановка сервера или несовпадение модов читаются как внутренняя ошибка. `[binary]`

Ещё две вещи видны игроку, и обе легко прочитать неверно:

- **Строка деталей.** `game.c` собирает `Kick cause code: group=%1 '%2', reason=%3 '%4'` и отдаёт её
  диалогу как детали ошибки, поэтому точная пара доступна под кнопкой деталей — и на уровне
  `LogLevel.NORMAL` в `console.log` клиента.
- **Текст может не соответствовать причине.** `PLAYER_MANAGER_KICK` привязан к
  `#AR-KickDialog_PM_Kicked` — «Voted out of the game.» / «Выгнан из игры путем голосования.» — то
  есть при обычном админском кике игроку сообщают, что его выгнали голосованием. Точный текст есть
  только у `KICKED_BY_GM` («Kicked by Game Master.»), а `DUPLICATE_PLAYER_IDENTITY` наследует от
  группы тот же текст про голосование. `[binary]`

Диалог предлагает переподключение для транспортных причин и отказывает в нём там, где это
бессмысленно или неверно: `m_bCanBeReconnected` по умолчанию `true`, а пресеты для `REPLICATION`,
`BATTLEYE*`, `DATA` и `PLAYER_MANAGER` ставят `0`. Там, где переподключение предложено, таймер
автовозврата — 10 секунд, и `SCR_KickDialogs.MAX_AUTO_REJOINS` разрешает три попытки, после чего
кнопка отключается. `[binary]`

Остальные игроки в сеансе получают уведомление `%1 был выгнан. Причина: %2` (английское
`%1 was kicked. Reason: %2`), собранное из того же пресета — но только если у пресета есть непустой
текст или приложен таймаут бана; уведомление различает кик (`PLAYER_KICKED`), временный бан
(`PLAYER_BANNED`) и бессрочный (`PLAYER_BANNED_NO_DURATION`). При остановке сервера уведомления о
кике поэтому не рассылаются вовсе. `[binary]`

## 8. Где читать причину

| Что | Где | Пример |
|---|---|---|
| Точная пара, на клиенте | `console.log` в профиле, две строки подряд | `Kicked from game. group=1 reason=9`, затем `Kick cause code: group=1 'REPLICATION', reason=9 'SHUTDOWN'` |
| Точная пара, на сервере | `console.log` сервера | `ServerImpl event: disconnected (identity=0x…, slots=1/8), group=6, reason=0` |
| Слова самого античита | лог сервера | `BattlEye Server: Kick player identity=0x…, reason='…'` |
| Кто выгнал | лог сервера, строка самой команды | `Kick <имя>[<id>]` для `kick`, затем отключение игрока |
| Какой тег диалога сработал или не нашёлся | `console.log` клиента | `[SCR_ConfigurableDialogUi] Preset was not found: … REPLICATION_SHUTDOWN` |

`[practice]` `[binary]` — первая и пятая строки взяты из лога этой сборки, форматы строк есть в
исполняемом файле.

Причина уходит и на бэкенд, когда игрока удаляют из комнаты: вызов `rooms/removePlayer` несёт
`removeEvent` с теми же числами `group` и `reason` ([BackendAPI](ArmaReforger_BackendAPI_RU.md) §4);
поэтому числа видны в захватах этого API даже тогда, когда никакого диалога не показывали.

## 9. Как это получено и что этим не устанавливается

Всё прочитано из установленной сборки читателями этого репозитория — ни один архив не распаковывался
руками:

```bash
node tools/pak.mjs cat "<client>/addons/core/data.pak" scripts/Core/generated/Replication/RplError.c
node tools/pak.mjs cat "<client>/addons/data/data007.pak" Configs/ServerBrowser/KickDialogs.conf
node tools/loc.mjs get "<client>/addons/data/data007.pak:Language/localization.ru_ru.conf" AR-KickDialog_PM_Kicked
node tools/pak.mjs find "<client>/addons/data/data007.pak" "KickCauseGroupLink" --path-regex "\.c$"
```

Нумерация сверена с логом клиента этой сборки на машине, где документ писался: 20 строк с кодом
причины, все — `REPLICATION`. Перечень — в §9.2.

### 9.1 Что установлено

- Полный список групп, полный список причин каждой группы и все атрибуты `KickCauseGroupLink` —
  прочитаны из архивов 1.8.0.13. `[binary]`
- Цепочка выбора диалога, таблица пресетов, тексты на двух языках, флаги переподключения, правила
  уведомлений и исключение `SHUTDOWN` из переподключения — прочитаны из тех же архивов. `[binary]`
- Нумерация причин `REPLICATION` 1, 4, 6 и 9 и причины `PLAYER_MANAGER` 3 — из логов этой сборки.
  `[practice]`

### 9.2 Наблюдённые коды, и почему «kicked» в логе — не всегда кик

Все двадцать строк были, без исключения, такого вида:

```text
19:01:49.864 DEFAULT   (E): Kicked from game. group=1 reason=9
19:01:49.864 SCRIPT       : string strDetail = 'Kick cause code: group=1 'REPLICATION', reason=9 'SHUTDOWN''
```

и в каждой из них строка появлялась **после** `Entered main menu.` — клиент уже покинул сеанс.
Встретились четыре разных кода: `1 SYSTEM_FAILURE`, `4 TIMEOUT`, `6 STALLED`, `9 SHUTDOWN`. Значит,
код причины в логе отвечает на вопрос «как закончился сеанс», и только группа говорит, наказывали ли
кого-нибудь.

Публичные сообщения согласуются с нумерацией и дают группы, которых на этой машине не было: пара
`group=6 'PLAYER_MANAGER', reason=0 'KICK'` и `group=3 'BATTLEYE', reason=0 'UNKNOWN'` — в
[треде Steam](https://steamcommunity.com/app/1874880/discussions/1/841754670748837625/),
`group=4 'DATA'` — в [тикете Bohemia](https://feedback.bistudio.com/T180153), а `reason=9 'SHUTDOWN'`
рядом с неразрешённым `reason=11` — в [другом треде](https://steamcommunity.com/app/1874880/discussions/1/840610464762369435/).
Они и есть источник номеров 3, 4 и 6 в §1, и на этой машине они не воспроизводились.

### 9.3 Что не установлено

- **Почему номера `REPLICATION` сдвинуты на единицу** относительно `RplError.c`, а
  `PLAYER_MANAGER` — нет. Сдвиг измерен на четырёх значениях; причина неизвестна. Имя в кавычках
  разбирает та же сборка, и это надёжная половина строки.
- **Номера групп 2 и 5** в логе не встречались. Это две оставшиеся позиции, то есть порядок
  объявления, а не измерение.
- **Причины, никогда не виденные на этой машине** — `FLOODED`, `SERVICE_FAILURE`, `JIP_ERROR`,
  `SERVER_FULL`, `PROTOCOL_MISMATCH`, все причины `DATA`, все причины `BATTLEYE`, все причины
  `PLATFORM`, `DUPLICATE_PLAYER_IDENTITY` — описаны по коду, комментариям и именам, а не по
  наблюдённому кику.
- **`rplTimeoutS` в 10 секунд** — это то, что комната объявляет бэкенду; что это же число определяет
  поведение слоя репликации при таймауте, не измерялось, и в логе нет никаких данных о прошедшем
  времени.
- **Может ли мод объявить новую группу** (а не причину в существующей) — не установлено: движок
  проверяет связь, и четыре строки проверки выше — всё, что документ может сказать о том, что он
  принимает.
- Публичные сообщения о `group=1 reason=11` при указанном сдвиге соответствуют
  `SERVER_UNREACHABLE`, и исправления в этих тредах — сетевые, но лога с разобранным именем для
  подтверждения не нашлось.
