# RCON сервера Arma Reforger

Удалённое управление сервером: настройка, права, команды, диагностика.

**Сборка, на которой проверено:** Arma Reforger 1.6.0.119 (engine 192142).

---

## 1. Что это такое и чем не является

RCON в Arma Reforger — **собственная реализация Bohemia**, а не протокол BattlEye.
Это важно, потому что в игре есть **два независимых удалённых консоли**, и их постоянно путают:

| | RCON Arma Reforger | RCON BattlEye |
|---|---|---|
| Где настраивается | секция `rcon` в `server.json` | файл `battleye\BEServer_x64.cfg` |
| Включается | `rcon.password` | `RConPassword` в том файле |
| Роль | удалённое управление сервером | античит |
| Клиент | любой совместимый с протоколом Bohemia | `BERCon.exe` из комплекта сервера |

Собственная реализация видна прямо в коде: в серверном бинарнике есть классы
`RCONProtocol`, `RCONCommunicator`, `RCONCommandHandler`, `RCONServerBase`,
`RCONClientBase`, `RCONConnectedClient`, а также отдельные
`RCONAdminCommand` и `RCONMonitorCommand`.

**Практический вывод:** `BERCon.exe`, лежащий рядом с сервером, к секции `rcon`
из `server.json` отношения не имеет. Не пытайтесь подключиться им к порту 19999.

> **Протокол RCON не подтверждён как UDP или TCP.** Официальная спецификация BattlEye
> говорит UDP, вики BI для Arma Reforger протокол не указывает, а распространённый
> контейнерный образ публикует 19999 как TCP. Проверить можно только на своём сервере:
> `ss -lunp | grep 19999` (UDP) и `ss -ltnp | grep 19999` (TCP).
> Подробнее — в [`ArmaReforger_StartupParams_RU.md`](ArmaReforger_StartupParams_RU.md) А.5.

---

## 2. Настройка

### 2.1 Секция `rcon` в конфиге

```json
"rcon": {
  "address": "127.0.0.1",
  "port": 19999,
  "password": "ChangeMe123",
  "maxClients": 4,
  "permission": "admin",
  "blacklist": [],
  "whitelist": []
}
```

| Ключ | Тип | По умолч. | Описание |
|---|---|---|---|
| `address` | string | — | Адрес, к которому привязан RCON-сокет. Помечен в вики как **required**. Для локального доступа — `127.0.0.1`. |
| `port` | number 1..65535 | 19999 | Порт RCON. |
| `password` | string | — | **Обязателен для запуска RCON.** Без пробелов, минимум 3 символа. |
| `maxClients` | number 1..16 | 16 | Максимум одновременных RCON-клиентов. |
| `permission` | string | — | `"admin"` — любые команды; `"monitor"` — только не меняющие состояние. |
| `blacklist` | array | `[]` | Команды, исключённые из выполнения. |
| `whitelist` | array | `[]` | Если задан — разрешены только перечисленные команды. |

**Безопасность прежде всего.** RCON даёт полный контроль над сервером: кик, бан,
перезапуск сценария, выключение. Поэтому:

- **не выставляйте `address` в `0.0.0.0`**, если сервер смотрит в интернет, — иначе
  RCON открыт всему миру и защищён только паролем. В примере выше стоит `127.0.0.1`,
  и это правильный выбор: подключайтесь через SSH-туннель;
- **пароль длинный и случайный**, а не `123`. Минимум в 3 символа — это техническое
  ограничение движка, а не рекомендация;
- для наблюдения за сервером без права менять что-либо используйте `"permission": "monitor"`.

### 2.2 Параметры запуска

Секцию можно перекрыть из командной строки:

| Параметр | Что задаёт |
|---|---|
| `-rconPort <порт>` | Порт RCON |
| `-rconIpAdress <IP>` | Адрес RCON. **Опечатка в самом движке** — именно `Adress`, без `d` |
| `-rconPassword <строка>` | Пароль RCON |

### 2.3 Проверка, что RCON поднялся

В `console.log` при успешном старте:

```
BACKEND : [RCON] Init, Ip address=127.0.0.1 and Port=19999
```

При проблемах — одна из строк ниже. Все они из серверного бинарника:

| Строка в логе | Причина |
|---|---|
| `[RCON] Init failed... Missing password or password length < 3 characters !!!` | Пароль не задан или короче 3 символов |
| `[RCON] Init failed... RCON is now turned off.` | Следствие предыдущей строки — RCON выключен |
| `[RCON] Invalid port, set to default=19999...` | `rcon.port` вне диапазона; **не фатально**, порт заменён на стандартный |
| `[RCON] run failed, net socket invalid` | Сокет не поднялся — чаще всего занят порт или неверный `address` |

---

## 3. Права

Права описываются перечислением `ERCONPermissions` — ровно тремя значениями,
что совпадает со значениями `rcon.permission` в конфиге:

```enforce
enum ERCONPermissions
{
    PERMISSIONS_NONE,
    PERMISSIONS_MONITOR,
    PERMISSIONS_ADMIN,
}
```

Каждая команда объявляет требуемое право методом `RequiredRCONPermission()`.
Например, у команды `ban`:

```enforce
override int RequiredRCONPermission()
{
    return ERCONPermissions.PERMISSIONS_ADMIN;
}
```

Итог: **`monitor` может только смотреть, `admin` может всё**. Отдельного уровня
«только кик» или «только бан» нет.

Второй, независимый набор прав — для **чата**:

```enforce
enum EPlayerRole
{
    NONE,
    ADMINISTRATOR,
    SESSION_ADMINISTRATOR,
    GAME_MASTER,
}
```

Команды объявляют его отдельно методом `RequiredChatPermission()`. У `ban` и `kick`
там стоит `ADMINISTRATOR` — то есть в чате те же команды доступны только вошедшему
администратору.

> **Важно:** одна и та же команда имеет **две разные проверки прав** — для RCON
> и для чата. Команда может быть доступна по RCON, но недоступна в чате, и наоборот.

---

## 4. Команды

### 4.1 Матрица прав

Составлено по официальной вики BI (страница «Server Management»). Столбцы — кто выполняет
команду, строки — сама команда.

| Команда | Вошедший админ | Избранный админ | Игрок | RCON `admin` | RCON `monitor` |
|---|:---:|:---:|:---:|:---:|:---:|
| `#login` | — | — | ✔ | — | — |
| `#logout` | ✔ | ✔ | — | — | — |
| `#roles` | ✔ | ✔ | ✔ | — | — |
| `#restart` | ✔ | — | — | ✔ | — |
| `#shutdown` | ✔ | — | — | ✔ | — |
| `#kick <playerId>` | ✔ | — | — | ✔ | — |
| `#ban …` | ✔ | — | — | ✔ | — |
| `#id` | ✔ | ✔ | ✔ | — | — |
| `#players` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `@logout` (1.2.1) | — | — | — | ✔ | ✔ |

Что из этого следует практически:

- **`#players` — единственная команда, доступная `monitor`.** Через RCON это ровно
  то, что нужно мониторингу: список игроков без возможности что-то менять.
- **`#restart`, `#shutdown`, `#kick`, `#ban` требуют `admin`.**
- **`#login`, `#logout`, `#roles`, `#id` через RCON недоступны вообще** — это
  чатовые команды. `#login` при этом доступен обычному игроку: он и предназначен
  для входа в админы.

### 4.2 Команды RCON и чата

| Команда | Синтаксис | Что делает |
|---|---|---|
| `#players` | `#players` | Список игроков сессии с их `playerId` |
| `#kick` | `#kick <playerId>` | Выкинуть игрока. Он может вернуться |
| `#ban create` | `#ban create <playerId\|identityId\|"playerName"> <секунды> <причина>` | Забанить. `0` в секундах = навсегда. Причина необязательна |
| `#ban remove` | `#ban remove <identityId>` | Снять бан |
| `#ban list` | `#ban list [страница]` | Список банов. **RCON показывает 25 на страницу, чат — 10** |
| `#restart` | `#restart` | Перезапустить текущий сценарий, **не разрывая клиентов** |
| `#shutdown` | `#shutdown` | Выключить сервер, разорвав всех |
| `@logout` | `@logout` | **Только RCON, с 1.2.1.** Деаутентифицировать клиент RCON и сразу освободить подключение |

### 4.3 Команды только для чата

| Команда | Синтаксис | Что делает |
|---|---|---|
| `#login` | `#login [пароль]` | Войти администратором. Пароль — `game.passwordAdmin`. **Админы из `game.admins` и владелец из `ownerToken.bin` входят без пароля** |
| `#logout` | `#logout` | Выйти из администратора |
| `#roles` | `#roles` | Показать роли, которые есть у игрока |
| `#id` | `#id` | Показать свой `playerId` |

### 4.4 Разбор команды `ban` по исходнику

Из `scripts/Game/Network/ServerCommands/BanCommands.c` (строка 319) — справка, которую
сервер выдаёт сам, если вызвать `#ban` без подкоманды:

```
Help for ban command.
#ban create <playerId/playerName> <duration> <reason>
#ban create <identityId/playerName> <duration> <reason>
#ban remove <identityId/playerName>
#ban list <page>

- <duration> is in seconds and can be set to 0 for permanent.
- <reason> is optional.
```

Детали, которые видно только в коде:

- **Тип идентификатора определяется по формату строки** (метод `GetPlayerIdType`):
  - длина 36 и дефисы на позициях 8, 13, 18, 23 → **`identityId`**;
  - только цифры → **`playerId`**;
  - всё остальное → **имя игрока**;
- **имя с пробелами берётся в кавычки:** `#ban create "Name with spaces" 3600`. Это
  разбирается отдельным методом `TryParsePlayerNameWithSpaces`.
- **`playerId` работает только для подключённого игрока.** Если игрок вышел —
  используйте `identityId`. На это же указывает и вики.
- **Отрицательная длительность отклоняется:** `Not Valid time value in seconds`.
- **Если имя совпало с несколькими игроками**, сервер вернёт
  `Multiple users found! Please use a unique identifier.` и покажет список —
  это не ошибка, а подсказка.
- **`#ban` работает только на выделенном сервере.** Проверка стоит первой в обработчике:
  `Command is supported only on Dedicated Servers`.

Ещё несколько деталей, которые видно только в коде:

- **Причина по умолчанию** — `No reason provided`. Если причина состоит из нескольких
  слов, сервер сам склеивает все оставшиеся аргументы через пробел — отдельный параметр
  для этого не нужен.
- **Бан идёт через бэкенд Bohemia**, а не в локальный файл:
  `BackendApi.GetBanServiceApi()` → `CreateBanPlayerId` / `CreateBanIdentityId` /
  `RemoveBans` / `RemoveBanByName` / `RequestServerBanList`. Отсюда и `PENDING`:
  ответ приходит не сразу, а движок тем временем периодически вызывает `OnUpdate()`.
- **`#ban remove` по имени ищет в два прохода**: сначала точное совпадение
  (`ESMT_EQUALS`), при `EACODE_ERROR_NOT_FOUND` — повтор по началу имени
  (`ESMT_STARTS_WITH`) с записью в лог `Retrying unban of user with user name: '%1'`.
- **Бан по `identityId` создаётся без имени**: в поле имени попадает сам `identityId` —
  игрок офлайн, и ник сервер узнать не может.
- **Формат `#ban list`** — строка заголовка и по строке на бан:

  ```
  Total bans: <N> | Page: <X>/<Y>
  - Identity Id | Banned name
  - <identityId> | <имя>
  ```

- **Лимит страницы выбирается по вызывающему**: `playerId == 0` (RCON) → 25,
  иначе (чат) → 10. То есть 10 и 25 — это не настройка, а две константы в коде.
- **Неоднозначное имя** приходит от бэкенда как `EACODE_ERROR_MULTIPLE_TARGET_MATCH`;
  сервер превращает его в подсказку `Multiple users found! …` со списком совпадений
  по началу имени.

### 4.5 Разбор команды `kick` по исходнику

`KickCommand` лежит в том же файле `BanCommands.c` (строка 567) и устроен заметно проще.

| Свойство | Значение |
|---|---|
| `GetKeyword()` | `kick` |
| `RequiredRCONPermission()` | `PERMISSIONS_ADMIN` |
| `RequiredChatPermission()` | `EPlayerRole.ADMINISTRATOR` |
| `IsServerSide()` | `true`; `OnChatClientExecution` всегда отвечает `OK` и ничего не делает |

- Принимается **только `playerId`** — имя не поддерживается, в отличие от `ban`.
- Аргументов меньше двух → пустой ответ с типом `PARAMETERS`: в чате это выглядит как
  «ничего не произошло», без текста ошибки.
- `playerId < 1` → `Not Valid Player ID`; игрока нет в сети → `Player not found`.
- Успех → `Player '<имя>' kicked!`; игрок выкидывается с причиной
  `PlayerManagerKickReason.KICK` и может зайти снова.
- **Проверки «только выделенный сервер» у `kick` нет** — в отличие от `ban`, она в коде
  не стоит.

### 4.6 Что сервер отвечает на команды

Тексты сверены по исходникам (`BanCommands.c`), а не по вики. В чате и в RCON это
буквально одни и те же строки.

| Ответ | Команда | Когда |
|---|---|---|
| `Not Valid Player ID` | `kick`, `ban` | идентификатор меньше 1 |
| `Player not found` | `kick`, `ban create` | игрока с таким `playerId` нет в сети |
| `Not Valid time value in seconds` | `ban create` | отрицательная длительность |
| `Not Valid page number` | `ban list` | номер страницы меньше 1 |
| `Page not found!` | `ban list` | страница больше числа страниц |
| `Server has no bans to list.` | `ban list` | список банов пуст |
| `Multiple users found! Please use a unique identifier.` | `ban create` / `ban remove` по имени | имя совпало с несколькими игроками |
| `User not found!` | `ban remove` | бан не найден ни точно, ни по началу имени |
| `Player '<имя>' kicked!` | `kick` | успех |
| `Player '<имя>' banned!` | `ban create` | успех |
| `Ban removed!` | `ban remove` | успех |
| `Command is supported only on Dedicated Servers` | `ban` | сервер не выделенный |
| `Processing ban list` | `ban list` | запрос ушёл в бэкенд, результат придёт позже |
| `Timeout` | `ban …` | бэкенд не ответил |
| `Failed to create ban.` / `Failed to remove ban.` / `Failed to list bans.` | `ban …` | бэкенд отклонил запрос сразу |
| `Unknown error.` | `ban …` | `EACODE_ERROR_UNKNOWN` от бэкенда |

Это **ответы команды, а не строки лога**: и в чате, и в RCON-клиенте они приходят
в поле ответа на команду, поэтому искать их в `console.log` бессмысленно.

---

## 5. Как это устроено внутри

Полезно, если вы пишете свою команду для мода.

Команда — это класс, наследующий `ScrServerCommand` (базовый класс в
`scripts/Game/generated/ScrServerCommand.c`):

```enforce
class ScrServerCommand
{
    event string GetKeyword();                      // ключевое слово команды
    event bool   IsServerSide();                    // передавать ли на сервер
    event int    RequiredRCONPermission();          // право для RCON
    event int    RequiredChatPermission();          // право для чата
    event protected ref ScrServerCmdResult OnRCONExecution(array<string> argv);
    event protected ref ScrServerCmdResult OnChatServerExecution(array<string> argv, int playerId);
    event protected ref ScrServerCmdResult OnChatClientExecution(array<string> argv, int playerId);
    event protected ref ScrServerCmdResult OnUpdate();   // дообработка PENDING-запроса
}
```

Обратите внимание на разделение: **одна и та же команда имеет отдельные точки входа
для RCON и для чата.** В `BanCommand` обе ведут в общий `HandleCommand(argv, playerId)`,
но это выбор автора, а не требование архитектуры.

Результат команды — `ScrServerCmdResult` с типом из `EServerCmdResultType`:

| Тип | Смысл |
|---|---|
| `OK` | Успех, ответ готов |
| `UNKNOWN_COMMAND` | Команды с таким ключевым словом нет |
| `MISSING_PERMISSION` | Недостаточно прав или роли |
| `PARAMETERS` | Ошибка в параметрах: мало аргументов, неверный id или имя |
| `PENDING` | Ответ ещё не готов — асинхронная операция. Движок вызовет `OnUpdate()` |
| `BUSY` | Занято |
| `ERR` | Общая ошибка |

`PENDING` объясняет, почему часть команд отвечает не сразу: например, `#ban list`
ходит в бэкенд Bohemia за списком банов. Получение ответа занимает время, и в этот
момент движок периодически вызывает `OnUpdate()`.

---

## 6. Диагностика

### 6.1 Жизненный цикл подключения в логе

Сервер подробно логирует работу RCON — по этим строкам можно разобрать почти любую
проблему:

```
[RCON] run started
[RCON] Login packet received
[RCON] 192.168.1.5:54321 Authorized as Client #0 | Connected clients: [1/4]
[RCON] [CLIENT: 0] Received Game Command: players
[RCON] Process Command: players
[RCON] [ID:0] Sent Message for client: ...
[RCON] Client 0 logged out!
[RCON] destroying...
```

### 6.2 Таблица симптомов

| Строка в логе | Что произошло |
|---|---|
| `[RCON] Client List is full! Dropping connection with %d.%d.%d.%d:%d` | Достигнут `rcon.maxClients`. Увеличьте значение или отключите лишних клиентов |
| `[RCON] %d.%d.%d.%d:%d Authorization DENIED` | **Неверный пароль** |
| `[RCON] [ID:%d] [CLIENT: %d.%d.%d.%d:%d] Unauthorized Client! Command: %s` | Команда отправлена **до** авторизации |
| `[RCON] [ID:%d] [CLIENT: %d] Mismatched sequence number! Command: %s` | Нарушена нумерация пакетов — обычно баг клиента RCON |
| `[RCON] Unknown protocol command: %s` | Клиент прислал нечто, не являющееся командой протокола |
| `[RCON] Invalid packet received` | Битый пакет — чаще всего неверный протокол (например, TCP вместо UDP или наоборот) |
| `[RCON] message[%i] attempt[%i] TIMEOUT` | Клиент не подтвердил сообщение. Сервер повторяет отправку несколько раз |
| `[RCON] Dropped client: #%d` | Клиент отключён — истёк таймаут или превышено число попыток |
| `[RCON] output queue exceeded its capacity!` | Очередь исходящих сообщений переполнена. Обычно значит, что клиент не читает ответы |
| `[RCON] Failed to send message to client. Connection Refused!` | Соединение разорвано на стороне клиента |
| `[RCON] Failed to send Message of %d bytes due to System Error: %s - %d` | Системная ошибка отправки, с кодом |
| `[RCON] [CLIENT: %d] No Command` | Пустая команда — движок использует её как keep-alive |
| `RCONCommandHandler: Executing command {%s}.` | Команда дошла до игрового обработчика |

### 6.3 Таймаут 45 секунд

**Клиент RCON обязан регулярно подтверждать получение сообщений.** Если сообщения от
клиента не приходят дольше 45 секунд, сервер считает его отключённым и освобождает
подключение. Вики описывает это применительно к `@logout`:

> «Если клиент RCON убит без подачи этой команды, он деаутентифицируется автоматически
> через 45 секунд по таймауту соединения.»

Практическое следствие: **убитый клиент RCON занимает слот `maxClients` до 45 секунд.**
Если вы часто перезапускаете свой клиент и упираетесь в лимит — либо увеличьте
`maxClients`, либо корректно закрывайте клиент командой `@logout`.

---

## 7. Границы достоверности

- **Протокол обмена (структура пакетов) не задокументирован.** Известно, что это
  собственная реализация Bohemia с понятиями `RCONPacket`, `RCONInputPacket`,
  `RCONOutputPacket`, и что в логе различаются *login*, *command* и *message* пакеты.
  **Точный формат не восстановлен** — сведений о нём нет ни в вики, ни в читаемых
  исходниках. Писать свой клиент RCON с нуля по этому документу нельзя.
- **TCP или UDP — не подтверждено.** Источники расходятся, см. §1.
- **Полный список команд** взят со страницы вики «Server Management» (ревизия
  `oldid=370483` от 2024-12-18) — она **старше** проверяемой сборки 1.6.0.119.
  Команды, добавленные позже, в неё не попали. Матрица прав оттуда же.
- **В публичных исходниках команд ровно две.** Каталог
  `scripts/Game/Network/ServerCommands/` содержит единственный файл `BanCommands.c`,
  а в нём — только классы `BanCommand` и `KickCommand`. Остальные команды
  (`#login`, `#logout`, `#roles`, `#id`, `#players`, `#restart`, `#shutdown`)
  реализованы на стороне движка и в публичное зеркало исходников не попадают: их
  синтаксис и права подтверждаются **только вики**. Проверить их можно на живом
  сервере, но не чтением кода — поэтому в §4.3 они и не разобраны построчно.
- **Утверждения о коде** (`ERCONPermissions`, `EPlayerRole`, `EServerCmdResultType`,
  структура `ScrServerCommand`, логика `ban` и `kick`, тексты ответов из §4.6)
  проверены по исходникам через Arma Reforger Explorer 1.7.0.54, где игра
  **новее** сборки 1.6.0.119.
- **Строки лога** — из серверного бинарника 1.6.0.119, то есть относятся точно
  к вашей сборке.
- **`maxClients` = 16 по умолчанию** и диапазон **1..16** — из вики.
- **Расхождение в матрице вики:** таблица помечает `#login` как доступный игроку, но
  недоступный RCON. Так и есть по смыслу (это чатовая команда), но обратите внимание,
  что для RCON столбцы `#login` и `#logout` пусты **во всех колонках, кроме `@logout`** —
  то есть RCON-клиент не «логинится» этими командами, он авторизуется паролем
  из конфига при подключении.

### Источники

| Что | Откуда |
|---|---|
| Матрица прав, список и синтаксис команд, таймаут 45 с, правило про `identityId` | BI Wiki «Arma Reforger: Server Management», ревизия `oldid=370483` от 2024-12-18 (сырой снимок Wayback; прямой доступ закрыт Cloudflare) |
| Секция `rcon` конфига: поля, диапазоны, умолчания, `required` | BI Wiki «Arma Reforger: Server Config» |
| Описание `ERCONPermissions`, `EPlayerRole`, `EServerCmdResultType`, базового класса `ScrServerCommand` | Сгенерированные скрипты `scripts/GameLib/generated/ERCONPermissions.c`, `EPlayerRole.c`, `EServerCmdResultType.c`, `scripts/Game/generated/ScrServerCommand.c` через arexplorer |
| Логика команд `ban` и `kick`, проверка «только выделенный сервер», форматы идентификаторов, разбор имён с пробелами, лимиты страниц 25/10, текст справки и все тексты ответов команд | `scripts/Game/Network/ServerCommands/BanCommands.c` через arexplorer |
| Состав каталога `ServerCommands` — только `BanCommands.c`; остальные команды в публичных исходниках отсутствуют | Листинг каталога `scripts/Game/Network/ServerCommands/` через arexplorer |
| Классы протокола (`RCONProtocol`, `RCONCommunicator`, `RCONCommandHandler`, `RCONAdminCommand`, `RCONMonitorCommand`), тексты всех сообщений `[RCON] …`, сообщения `[RCON] Init …` | Строки `ArmaReforgerServer.exe` 1.6.0.119 |
| Рабочий конфиг с включённым RCON и строка `[RCON] Init` в логе | `Arma Reforger Server\config.json` и `test\logs\logs_*\console.log` |
