# Backend API Arma Reforger

Онлайн-сервис, с которым разговаривают игра и выделенный сервер: что это, какие его части
использует сервер, какие эндпоинты называет его собственный бинарник, какие тут есть токены
и идентификаторы, и что установить не удалось.

**Сборка, на которой проверено:** Arma Reforger **1.8.0.13** (engine 192142) — установленная
сборка, новее пина этого репозитория 1.6.0.119 ([data/build.json](../../data/build.json)).
Названия эндпоинтов, операций и полей в §3, §4 и §7 сняты со строк и символов RTTI
`ArmaReforgerServer.exe` **1.8.0.13**; классы со стороны скриптов в §6 — из arexplorer
**1.7.0.54** и с опубликованных страниц членов API BI, поэтому §6 описывает сборку старше
остального. **Собственная регистрация выделенного сервера перехвачена в сети** (§3.0) — вызовы,
URL, заголовки и тела в §3.0, §4 и §5 являются наблюдениями, а всё остальное в §3 — список
строк в бинарнике. Что именно чем является, сказано в §9.

> **Это неофициальное описание закрытого API.** Bohemia не публикует по нему справку — wiki
> описывает *доступ к нему из скриптов* ([REST API
> Usage](https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage),
> [JsonApiStruct Usage](https://community.bistudio.com/wiki/Arma_Reforger:JsonApiStruct_Usage),
> [Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity)) и
> аккаунтную сторону публикации модов, но не сам сервис. Названия ниже прочитаны из
> поставленного бинарника, они не являются стабильным контрактом и могут измениться любым
> патчем без предупреждения. Обращение к этому сервису извне игры Bohemia не поддерживает.

---

## 1. Что такое «бэкенд»

**Бэкенд — это онлайн-сервис Bohemia для игры**, и клиент, и выделенный сервер являются его
*клиентами*. Это источник истины для того, что игра не хранит локально:

| Что там лежит | Кто использует | Где это видно |
|---|---|---|
| Реестр серверов и браузер серверов — какие серверы есть, их адрес, число игроков, моды, пинг | Сервер регистрирует, клиент читает | Браузер серверов; строка «Server registered with address: …» в логе сервера |
| **Токен владельца**, подтверждающий, кому принадлежит сервер ([Профиль §3](ArmaReforger_Profile_RU.md)) | Сервер | `ownerToken.bin` в профиле |
| Админские баны и жалобы — список принадлежит одному серверу | Сервер | `#ban` через RCON и в чате; [`RCON`](ArmaReforger_RCON_RU.md) §4.4 |
| Карьера каждого игрока (`m_aStats`, звания, опыт) | Сервер, клиент | `profile/.save/playersave/`, [Профиль](ArmaReforger_Profile_RU.md) §5 |
| Аккаунты и Game Identity — связь платформенного идентификатора (Steam, Xbox, PSN) с аккаунтом Bohemia | Клиент | «Привязать аккаунт Bohemia» в интерфейсе |
| Конфигурации серверов в облаке (группа `server-configs/*`) | Клиент, сервер | Экран конфигураций сервера в игре |
| Workshop: моды, версии, манифесты, комментарии, оценки, загрузки | Клиент, Workbench | Workshop; скачивание аддонов в `data*.pak` |
| Облачное хранилище для сохранений и прочих файлов | Клиент, сервер | Сохранения сессий, `cloud-saves-ar` |
| Уведомления, новости, всплывающие окна, группы, предложения продуктов, телеметрия | Клиент, сервер | Главное меню; отчётность самого сервера |

**Выделенный сервер — клиент бэкенда с первой же секунды.** На проверенной сборке первый
запрос к бэкенду уходит ещё до загрузки мира, а сервер, который до бэкенда не дотянулся,
не доходит и до попадания в список, — см. §4. Ключ `-noBackend` существует и принимается,
но на этой сборке с ним игровой экземпляр уничтожается примерно через 17 с после загрузки
мира ([Профиль](ArmaReforger_Profile_RU.md) §10), так что офлайн так не запуститься.

**Входящих портов для этого не открывают.** Сервер сам *ходит наружу* по HTTPS; порты,
которые хостеру нужно пробросить, — игровой, A2S и RCON ([ServerConfig](ArmaReforger_ServerConfig_RU.md)
§5.1), и ничего из этого документа среди них нет.

---

## 2. Как устроено это API

Бинарник называет свои «контексты» API: `URI_AccountApi`, `URI_ClientLobbyApi`,
`URI_ContentApi`, `URI_GameApi`, `URI_GameApiS2S`, `URI_GameApiV2`, `URI_GroupApi`,
`URI_GroupApiV2`, `URI_IdentityApi`, `URI_LobbyApi`, `URI_NewsApi`, `URI_NotifyApi`,
`URI_PopUpApi`, `URI_StarRiver`, `URI_StorageApi`, `URI_TreasureData`, `URI_UserApi`,
`URI_WorkshopApi`, `URI_WorkshopApi_Backup1`, `URI_BImageApi`, `URI_BImageApi_CDN`, `URI_STSApi`,
`URI_STSContext`, `URI_NotifyWs` — и переключатель окружения со значениями `production`,
`preprod`, `submission`.

Отсюда следуют две вещи, важные для чтения §3:

- **Адреса выясняются во время работы, а не читаются из бинарника.** Ни одного имени хоста
  игрового сервиса в `ArmaReforgerServer.exe` нет; что сервер делает, когда выяснить адрес не
  удаётся, видно в §8 и §9 (`[RestApi] Context Request - Empty URL provided!`,
  `ENV:[invalid]`). **Три хоста, к которым он на самом деле ходит, перехвачены в сети** (§3.0):
  `api-ar-gc.bistudio.com`, `api-ar-game.bistudio.com` и `reforger.armaplatform.com`, а при
  разрешённом окружении строка лога читается как `ENV:[production]`.
- **Путь каждого эндпоинта относителен своего контекста и несёт префикс API.** Пойманный
  S2S-вызов — это `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/rooms/register`:
  хост, `game-api`, `s2s-api/v1.0`, затем строка пути из §3.1/§3.2. Клиентский префикс в том же
  семействе — `api/v1.0` (`/game-api/api/v1.0/world`), а конфигурация игры живёт на своём хосте
  со своим префиксом (`/game-config/api/v1/reforger/1.8.0/13/list`). **Какой префикс у остальных
  контекстов, не перехватывалось** (§9).

У нескольких сервисов есть два взаимозаменяемых только на вид семейства методов:
**клиентские** (`ClientLobbyApi`, `GetPingSites`, `RoomsJoin`) и **S2S** — server-to-server —
(`LobbyApiS2S`, `RoomsRegisterS2S`, `CharacterUpdateS2S`). S2S-методы может вызывать только
сервер, и это различие видно в названиях операций ниже.

---

## 3. Эндпоинты, которые называет бинарник

**Машиночитаемая форма этого раздела лежит в
[schemas/backend-api/](../../schemas/backend-api/README.md)**: по одной JSON-схеме на каждый
наблюдённый эндпоинт, общие определения значений (`scenarioId`, `modId`, `hostAddress`, формы
токена и страницы) и пойманные тела в виде примеров, которые `npm run check:backend-schemas`
проверяет — и заставляет схемы по-прежнему отвергать плохое — на каждом прогоне. Если документ и
схема разойдутся, проверяется именно схема.

Каждая строка в левой колонке — литерал в `ArmaReforgerServer.exe` **1.8.0.13**. В правой
колонке — имя класса или операции, найденное рядом. Для большинства из них **HTTP-метод, полный
URL и тела неизвестны**: известно, что эти пути есть и какая операция за них отвечает. Те
немногие, что были видны в сети, перечислены первыми, и только они в этом документе являются
наблюдениями, а не строками.

### 3.0 Что увидено в сети

Два прогона выделенного сервера **1.8.0.13**, каждый с чистым профилем и непубличным конфигом,
за прокси, терминирующим TLS: один обычный (3,5 минуты, бан выдан и снят через RCON, затем
корректное завершение) и один с единственным модом Workshop в конфиге. Всё ниже записано
(`out/mitm-capture*.jsonl` в рабочем каталоге зондов).

**До регистрации — пять вызовов:**

| # | Вызов | Ответ |
|---|---|---|
| 1 | `GET https://api-ar-gc.bistudio.com/game-config/api/v1/reforger/1.8.0/13/list` | `200`, 4668 Б — онлайн-конфигурация игры (`name`, `version`, `env`, `overview`, `properties`, `services`, `createdAt`) |
| 2 | `GET https://api-ar-game.bistudio.com/game-api/api/v1.0/world?platformId=ReforgerSteam&clientVersion=1.8.0` | `200`, 401 Б — `version`, `gameData` |
| 3 | `GET https://reforger.armaplatform.com/api/popup?loc=en_us` | `200`, 12 Б — `items` |
| 4 | `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` | `200`, 959 Б — `dsConfig`, **`ownerToken`** |
| 5 | `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/rooms/register` | `200`, 705 Б — `roomId`, `mpRoom` |

**Во время работы** — обычный прогон, по порядку:

| Когда | Вызов | Ответ |
|---|---|---|
| через 61 с после регистрации и ещё через 61 с | `POST …/lobby/dedicatedServers/heartBeat` | `200`, 67 Б |
| на `#ban create` через RCON | `POST …/lobby/rooms/createBan` | `200`, `{"status":"OK"}` |
| на `#ban list 1` | `POST …/lobby/rooms/listActiveBans` | `200`, 428 Б — сам список банов |
| на `#ban remove` | `POST …/lobby/rooms/removeBans` | `200`, `{"status":"OK"}` |
| на `shutdown` через RCON | `POST …/lobby/rooms/remove` | `200`, `{"status":"OK"}` |

**Когда игрок в игре** — третий прогон, живой игрок с той же машины:

| Когда | Вызов | Ответ |
|---|---|---|
| при входе | `POST …/lobby/rooms/acceptPlayer` | `200`, 979 Б — профиль игрока, **его `platformIdentities` (`biAccountId`, `steamId`)** и `character.data`, строка JSON со всем массивом `m_aStats` |
| при выходе | `POST …/lobby/rooms/removePlayer` | `200` — `{"status":"OK","expireAt":…}` |
| непосредственно перед обоими | `GET https://api-ar-game.bistudio.com/game-api/api/v1.0/dummy` | `200`, тело `{}`, **без каких-либо учётных данных** — проверка живости |
| раз в минуту | `POST …/lobby/dedicatedServers/heartBeat` | теперь с `"players":[{"identity":"0ac6169c-…"}]` |

**Запись карьеры обратно так и не ушла** — ни по таймеру 120 с, пока игрок играл семь минут, ни
когда он вышел, ни при корректной остановке сервера, ни при `#restart` (четыре сценария подряд).
Причина в коде игры, а не в перехвате:
`SCR_PlayerProfileManagerComponent.OnPlayerDisconnected` вызывает `StoreProfile(playerId, true)`,
что заканчивается `PlayerCharacterUpdateS2S`, но нужный объект профиля создаёт
`LoadPlayerProfileFromBackend()` — и **только когда
`GetBackendApi().GetDSSession().Status() == EDSESSION_ACTIVE`**, а `StoreProfile` без этого
профиля выходит первой же строкой. Сервер сообщества такую сессию не поднимает — у него токен
владельца и семейство лобби S2S (§4), — поэтому путь записи так и остаётся спящим, а сама
карьера приходит только на чтение, в ответе `acceptPlayer`.

**Скачивание мода** — второй прогон, до собственной регистрации:

| Вызов | Ответ |
|---|---|
| `POST https://api-ar-workshop.bistudio.com/workshop-api/api/v3.0/s2s/assets/download-list` | `200`, 1519 Б — ассет, его `version`/`gameVersion` и три файла (`data.pak`, `resourceDatabase.rdb`, `addon.gproj`), у каждого `manifestPath` |
| `GET https://ar-gcp-cdn.bistudio.com/manifest/<2 hex>/<2 hex>/<sha512>/<размер>` | по одному на файл (`200`, 120–2747 Б) |
| `GET https://ar-gcp-cdn.bistudio.com/fragment/<2 hex>/<2 hex>/<sha512>/<размер>` | по одному на фрагмент — около двадцати на аддон в 16 КБ — пока не появится `Required addons are ready to use.` |

**Форма одинакова во всех S2S-вызовах выше.** Каждый запрос несёт токен владельца как
`accessToken`, а также `dedicatedServerId`, `roomId`, `clientVersion` и `platformId`: те же учётные
данные и идентификаторы, на том же хосте, под `game-api/s2s-api/v1.0/lobby/`. Исключения — CDN и
хост конфигурации игры: они отвечают по путям, которые сами идентифицируют содержимое, и такого
тела не несут.

Оба POST регистрации передаются chunked и несут `Expect: 100-continue`; они и каждый S2S POST —
`application/json` с заголовками

```text
x-client-id: $edb1b7862bba5cade1f6e06bfdeac2c
x-client-secret: <32 символа>
user-agent: Arma Reforger/1.8.0.13 (Headless; Windows)
```

а ответы приходят от Cloudflare с `x-signature-validation-result: true`,
`cache-control: no-cache, no-store` и cookie `x-bi-rid`. Что в этих телах — в §3.5 и §4; токен из
вызова 4 — предмет [Профиля §3](ArmaReforger_Profile_RU.md).

**Обратите внимание, чего нет.** Ни одного вызова из семейства `servers/*`
(`servers/createToken`, `servers/auth`, `servers/heartbeat`) выделенный сервер не сделал, как и
вызовов `dedicatedServers/createOwnerToken`, `server-configs/*`, ничего из хранилища, групп и
уведомлений, а также `rooms/joinQueue/*` (очередь, которую мог видеть входящий клиент, — это его
собственный трафик: игровой клиент за прокси не был). Эти пути в бинарнике есть, и разделы ниже
по-прежнему список того, что существует; но вся жизнь сервера сообщества прошла через семейство
**лобби S2S** и Workshop, а его учётными данными был токен владельца.

### 3.1 Регистрация сервера и браузер серверов

| Путь / операция | Чем представлено |
|---|---|
| `servers/createToken` — поля `serverToken`, `serverAccessToken`, `serverType`, `persistent`, `expireIn` | `GameApiV2_Servers_CreateToken` |
| `servers/auth`, `servers/auth/refresh` — заголовок `Authorization` | `GameApiV2_Servers_Auth` |
| `servers/register` | `GameApiV2_Servers_Register` |
| `servers/heartbeat` — `frameTime`, `frameCount`, `memory`, `rplSentBytes`, `ai_chars_active`, `vhc_wheeled_active`, `vhc_helicopter_active` | `GameApiV2_Servers_Heartbeat`, `LobbyApiRequestDSHeartbeat`, `DSHeartbeatS2S` |
| `servers/remove` | `GameApiV2_Servers_Remove` |
| `servers/acceptPlayer`, `servers/removePlayer` (`removeEvent`) | `GameApiV2_Servers_AcceptPlayer`, `…_RemovePlayer` |
| `servers/join`, `servers/joinQueue/poll`, `servers/joinQueue/leave` — `sessionTicket`, `ticket`, `secret` | `GameApiV2_Servers_Join`, `…_Queue_Poll`, `…_Queue_Leave` |
| `servers/getDetails`, `servers/getByIds`, `servers/list` — `detailsFields`, `serverIds`, `slice` | `GameApiV2_Servers_GetDetails`, `…_GetByIds`, `…_List` |
| `servers/pingSites` — `pingSiteId`, `avgRTT` | `GameApiV2_Servers_PingSites`, `LobbyApiGetPingSites` |
| `servers/markFavorites`, `servers/unmarkFavorites` | `GameApiV2_Servers_MarkFavorites`, `…_UnmarkFavorites` |
| `user/gameData/getOwn`, `updateOwn`, `getBatch`, `updateBatch` — `userIds`, `updates`, `expectedVersion`, `replaceGameData`, `patchGameData` | `GameApiV2_UserGameData_*` |

Семейство постарше, но всё ещё присутствующее (`GameApiV1`, `GameApiS2S`), несёт то же самое
под другими путями: `session/login`, `character/getCharacter`, `character/updateCharacter`,
`devel/getCharacter`, `devel/updateCharacter`, `userProfiles/getMetadata`, `bans/listActive`,
`blockList/listBlocked`, `gameStats/record`, и операции `CharacterGet`, `CharacterUpdateS2S`,
`SessionLogin`, `ListActiveBans`, `ListBlockedUsers`, `GameStatsRecord`. Один из них не наблюдался,
а был спрошен напрямую — `userProfiles/getMetadata`, потому что он единственный выглядит как
разворот идентичности в платформу: результат в §5, а схема запроса —
в [`schemas/backend-api/game-api/`](../../schemas/backend-api/game-api/).

### 3.2 Лобби: комнаты, регистрация и heartbeat

Выделенный сервер регистрируется как *комната* (room). Ниже — пути, которыми пользуется
сервер, и рядом имена из старого API лобби:

| Путь | Операции |
|---|---|
| `rooms/register` — `dedicatedHostId`, `scenarioVersion`, `hostUsername`, `dedicated`, `invisible`, `joinQueueMaxSize`, `rplTimeoutS`, `autoJoinable`, `cloudSaveId`, `currentPlayers` | `LobbyApiRoomsRegisterS2S`, `ClientRoomsRegister` |
| `rooms/heartBeat` | `RoomsHeartBeat` |
| `rooms/update`, `rooms/remove` | `RoomsUpdateS2S`, `RoomsRemoveS2S` |
| `rooms/acceptPlayer` — `userProfile`, `userGameData`, `platformIdentities`, `steamId`, `xboxIdHash`, `psnIdHash`, `currencies`, `overallPlayTime` | `LobbyApiRoomsAcceptPlayerS2S` — **перехвачен**; запрос несёт `sessionTicket` (512 символов), ответ — `userProfile`, `platformIdentities` и `character.data` (§3.0) |
| `rooms/removePlayer` | `LobbyApiRoomsRemovePlayerS2S` — **перехвачен**; `userId`, `expireIn: 4995` и `removeEvent:{"group":1,"reason":9}` |
| `rooms/search`, `rooms/getRoomsByIds`, `rooms/listPlayers` | `LobbyApiRoomsSearch`, `RoomsGetByIds`, `RoomListPlayers` |
| `rooms/join`, `rooms/verifyPassword`, `rooms/joinQueue/poll`, `rooms/joinQueue/leave` | `RoomsJoin`, `LobbyApiVerifyPassword`, `QueuePoll`, `QueueLeave` — **клиентские**, сервер их не вызывает |
| `lobby/getActiveScenarios` | `GetActiveScenariosS2S` |
| `dedicatedServers/heartBeat` | `DSHeartbeatS2S` |
| `dedicatedServers/registerUnmanagedServer` | `DSUnmanagedRegisterS2S` |
| `dedicatedServers/updateGameSaveFileId` | `UpdateGameSaveFileIdS2S` |

### 3.3 Токен владельца

**Свой токен владельца выделенный сервер получает из собственного вызова регистрации —
`registerUnmanagedServer`, а не `createOwnerToken`.** Оба пути в бинарнике есть:

| Путь | Операция | Что известно |
|---|---|---|
| `dedicatedServers/registerUnmanagedServer` | `DSUnmanagedRegisterS2S`, `LobbyApiDSUnmanagedRegS2S` | **Вызывается сервером, перехвачен.** Ответ `200` несёт `{"dsConfig":{…},"ownerToken":"…"}`; член `ownerToken` сервер записывает в `$profile:ownerToken.bin` и отправляет обратно как `accessToken` в `rooms/register` |
| `dedicatedServers/createOwnerToken` | `LobbyApiCreateServerOwnerToken`, `CreateServerOwnerToken` | **Не вызывался ни в одном пойманном прогоне выделенного сервера.** Классы запроса и ответа (`LobbyApiResponseCreateServerOwnerToken`) существуют, значит кто-то его вызывает — вероятный результат этого пути собственный токен игрового клиента, где `ownerType: GameIdentity` и есть `ownerId`. **Не установлено** |

Тот же токен — поле `ownerToken` объекта конфигурации сервера, которым сервер обменивается с
бэкендом (`OwnerTokenExpand@ServerConfiguration`, рядом с ключами `serverId` и `ownerType`), то
есть объекта, за которым стоит группа `server-configs/*`. Сам файл, его поля и пойманный обмен —
в [Профиле §3](ArmaReforger_Profile_RU.md).

### 3.4 Конфигурации серверов в облаке

| Путь | Операция |
|---|---|
| `server-configs/save` | `SaveServerConfig` |
| `server-configs/list` | `ListServerConfig` |
| `server-configs/download` | `DownloadServerConfig`, `DownloadServerConfigS2S` |
| `server-configs/delete` | `DeleteServerConfig` |

В том же блоке строк лежат `Upload server config` и ключ `dsConfig`. Объект, который здесь
сохраняется, — то же семейство `ServerConfiguration`, что несёт `ownerToken`, `serverId`,
`ownerType`, `maxPlayers`, `mods`, `missionHeader`, `gameProperties` и остальное: ключи JSON
из §5 руководства по конфигу тоже присутствуют в этом блоке.

### 3.5 Баны, блокировки и жалобы

**Все три вызова банов перехвачены**, каждый — `POST …/game-api/s2s-api/v1.0/lobby/<путь>` с
токеном владельца как `accessToken`, `dedicatedServerId` и `roomId` в теле:

| Путь | Операция | Пойманный запрос и ответ |
|---|---|---|
| `rooms/createBan` | `CreateBanS2S` | `{"…","userId":"0ac6169c-…","reason":"backend-probe","banDuration":600}` → `{"status":"OK"}` |
| `rooms/listActiveBans` | `ListActiveBansS2S` | `{"…","page":{"limit":25,"offset":0}}` → `{"status":"OK","activeBans":{"entries":[…],"totalCount":1,"page":{…}}}` |
| `rooms/removeBans` | `RemoveBansS2S` | `{"…","userIds":["0ac6169c-…"]}` → `{"status":"OK"}` |

Настоящая запись из списка, с токеном и идентификаторами как они пришли:

```text
{"id":2430040,"targetType":"gid","targetId":"0ac6169c-…","targetName":"kolya_500",
 "currentName":"kolya_500","scope":"reforger:86d1f436-…:join","type":"gameServer",
 "reason":"backend-probe","issuer":"room 86d1f436-…",
 "createdAt":1792160229,"expiresAt":1792160832}
```

Это тот самый серверный объект, который разворачивает класс движка `OnlineBanListData`: цель —
игровая идентичность (`targetType: "gid"`), **scope прибивает бан к одной комнате**
(`reforger:<roomId>:join`), выдавший — эта комната, а длительность равна `expiresAt - createdAt`
(600 с при запрошенном `banDuration: 600`). `page.limit` равен 25 — поэтому RCON показывает
список по 25 записей ([`RCON`](ArmaReforger_RCON_RU.md) §4.4). Остальное в этом разделе —
по-прежнему строки бинарника:

| Путь | Операция |
|---|---|
| `rooms/recordBanEvent` — `eventKey`, `currentValue`, `triggerValue`, `triggered` | `RecordBanEventS2S` |
| `rooms/reportPlayer` — `reporterId` | `ReportPlayerS2S` |
| `bans/listActive`, `blockList/listBlocked`, `feedback/create` | `GameApiListActiveBans`, `GameApiListBlockedUsers` |

Классы на стороне движка — `BanServiceApi` и `BlockListApi`. Где на самом деле живёт список
банов и что делает админский бан, — в [`RCON`](ArmaReforger_RCON_RU.md) §4.4 и
[Профиле](ArmaReforger_Profile_RU.md) §5.7.

### 3.6 Остальная поверхность, одной таблицей

| Сервис (контекст) | Пути и операции |
|---|---|
| **Хранилище** `URI_StorageApi` | `s2s/files/`, `s2s/files/<uuid>`, `/temp-url`, `s2s/upload/` — `GetFile`, `GetFileS2S`, `GetFileTempURL(S2S)`, `Upload(S2S)`, `PatchFileS2S`, `DeleteFileS2S`, `ReuploadS2S`; поля `spaceId`, `usedCapacity`, `userSpace`, `mimetype` |
| **Workshop** `URI_WorkshopApi`, `URI_ContentApi`, `URI_WorkshopApi_Backup1` | **Перехвачено:** `POST https://api-ar-workshop.bistudio.com/workshop-api/api/v3.0/s2s/assets/download-list` с `{"assets":{"<modId>":null}}`, в ответе — версия ассета, `gameVersion`, файлы и `manifestPath` каждого. **Дальше контент отдаёт `https://ar-gcp-cdn.bistudio.com`**: `GET /manifest/<2 hex>/<2 hex>/<sha512>/<размер>` на файл и `GET /fragment/<2 hex>/<2 hex>/<sha512>/<размер>` на фрагмент. Остальное — строки бинарника: `assets/list`, `assets/check-user-assets`, `assets/download-list`, `assets/<id>/dependencies`, `/versions/`, `/ratings/@me`, `/reports`, `/subscriptions`, `/favorites`, `assets/difference/size`, `assets/upload/create`, `assets/upload/<id>/files`, `/files/chunk`, `/files/commit`, `/process`, `/cancel`, `s2s/assets/download-list`, `v4/asset/upload/config`, `v4/asset/upload/getDetails`, `v4/asset/download/resolveVersionList`, `v4/asset/download/listFull`, `v4/asset/download/listPartial`, `v4/asset/stats/countDownloads`, `v4/asset/list`, `v4/asset/getListRemainder`, `v4/asset/getDetails`, `v4/asset/revision/*`, `v4/asset/addRating`, `v4/asset/addSubscriptions`, `v4/asset/addBlocks`, `v4/asset/report`, `v4/comment/list`, `v4/comment/create`, `v4/comment/addReaction`, `v4/comment/delete`, `v4/profile/listInteractions`, `contributor/invitations`, `auth/delegationTokens`. Обратите внимание на расхождение версий: пути в бинарнике говорят `v4`, а вызов выделенного сервера — `v3.0` |
| **Аккаунты, идентификаторы, вход** `URI_UserApi`, `URI_AccountApi`, `URI_IdentityApi`, `URI_STSApi` | `auth/login` (`client_id`, `two_factor_token`, `access_token`), `game-identity/token`, `/links`, `/links/bi-account`, `/token` — `DirectLogin`, `GetUser`, `IdentityApiAuth`, `IdentityApiCreate`, `IdentityApiLink`, `IdentityApiUnlink`, `SecurityGetJWT4STS` (класс `STSApi…`), `WorkshopApiDelegationTokens` |
| **Группы** `URI_GroupApi`, `URI_GroupApiV2` | `group/list`, `group/create`, `group/update`, `group/disband`, `group/<id>`, `group/transferTopRole`, `group/members/list`, `group/membership/kick`, `group/membership/updateRole`, `group/leave`, `group/setActive`, `group/account/current/membership`, `group/application/create`, `group/application/list`, `group/application/evaluate`, `group/application/delete`, `group/createImageUploadToken`, `group/log/list`, `images/groups/` — `GroupApiGetGroups`, `GroupApiRegisterGroup`, `GroupApiGetMembers`, `GroupApiEvaluateApplication`, `GroupApiGetAuditLog`, … |
| **Уведомления и профили** `URI_NotifyApi`, `URI_NotifyWs` | `notifications/list`, `notifications/delete`, `notifications/markAsRead`, `profiles/settings/update`, `profiles/me`, `profiles/@me/personalBlocks/profiles` — `ListNotifications`, `MarkAsRead`, `DeleteNotifications`, `GetProfile`, `UpdateProfileSettings`, `NotificationCatalogueApi` |
| **Новости и всплывающие окна** `URI_NewsApi`, `URI_PopUpApi` | объекты новостной ленты и всплывающих окон (`NewsFeedItem`, `PopupFeedItem`, `BannerText`, `ActionButtonURL`, …) |
| **Изображения** `URI_BImageApi`, `URI_BImageApi_CDN` | `v1/image/upload` — `ImageUpload`, `BImageApiDownload`; заголовок `X-TD-Write-Key` рядом с блоком телеметрии |
| **Телеметрия** `URI_StarRiver`, `URI_TreasureData` | `/demo/prod/report` с `log_name`, `log_data`, `ts_server_time` — `SendEventSR`, `SendEventTD`, `SendLegacySR`; ключи собственной статистики сервера (`evt_*`, `id_server`, `req_total`, `req_fail`, `beat_total`, `beat_fail`, `amt_ram`, `cnt_cpu`, `code_country`, …) лежат в том же блоке |
| **Аренда серверов и предложения** `URI_GameApi` | `offers/list`, `products/get` — `ProductOfferCatalogueApi`, `ExtrasApiListOffers`, `ExtrasApiGetProduct`; `ProductServerRentingDetails`, `EServerHardwareSize` |
| **Оркестрация игровых серверов** | `gameserver`, `watch/gameserver`, `metadata/label`, `metadata/annotation`, `allocate`, `reserve`, `ready`, `health` — классы `AgonesApi*`. Это слой парка хостинга, а не то, что вызывает сервер сообщества |

---

## 4. Что делает выделенный сервер, по шагам

**Наблюдалось от начала до конца** в двух пойманных прогонах; строки лога в последней колонке — из
того же прогона, если не сказано иное.

| Шаг | Что происходит | Что видно в логе или в сети |
|---|---|---|
| 1 | Конфиг читается и проверяется локально, затем сервер запрашивает свою онлайн-конфигурацию игры | `Loading dedicated server config.` → `Server config loaded.` → `JSON Schema Validation:` → `JSON is Valid` → `Attempting online Game Config instead.` |
| 2 | `GET …/game-config/api/v1/reforger/1.8.0/13/list` — первый вызов. Пока он не проходит, повторяется примерно каждые 6 с, и `ENV:[invalid]` в строке повтора — это то, что печатает сервер, не сумевший разрешить окружение | `[RestApi] ID:[1] TYPE:[GameConfig/List] ENV:[invalid] Error - Cannot send request` (неудачный прогон); когда проходит — `200` |
| 3 | `GET …/game-api/api/v1.0/world` и `GET https://reforger.armaplatform.com/api/popup` — то, что игре нужно до хостинга | — |
| 4 | `POST …/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` со своей конфигурацией, `x-client-id` и `x-client-secret` — и в ответе приходит **токен владельца**, который пишется в профиль | тело запроса (сокращённо): `{"clientVersion":"1.8.0","platformId":"ReforgerSteam","platformName":"Windows","region":"","gameVersion":"1.8.0.13","scenarioId":"{ECC61978EDCC2B5A}Missions/23_Campaign.conf","name":"…","playerCountLimit":8,"visible":false,"supportedGameClientTypes":["PLATFORM_PC"],"mods":[]}` |
| 5 | `POST …/s2s-api/v1.0/lobby/rooms/register` с `dedicatedHostId`, токеном владельца **как `accessToken`**, сценарием, адресом, который бэкенд отдаёт клиентам, и всей конфигурацией комнаты | тело запроса (сокращённо): `{"dedicatedHostId":"8b6aca5a-…","accessToken":"<токен владельца>","sessionId":"3fddf207-0000d9019b9c","scenarioId":"{ECC61978EDCC2B5A}Missions/23_Campaign.conf","scenarioName":"#AR-Campaign_ScenarioName_Everon","hostAddress":"127.0.0.1:2005","dedicated":true,"invisible":true,"joinable":true,"playerCountLimit":8,"joinQueueMaxSize":0,"battlEye":false,"rplTimeoutS":10.0,"password":"…","admins":[],"supportedGameClientTypes":["PLATFORM_PC"],"mods":[]}` |
| 6 | Ответ комнаты и становится регистрацией | `{"roomId":"d53ef442-…","mpRoom":{"hostType":"CommunityDs","hostAddress":"127.0.0.1:2005","directJoinCode":"0197881396","pingSiteId":"unknown", …}}` → `Server registered with address: 127.0.0.1:2005`, `Direct Join Code: 0197881396`, `Ping Site: unknown` |
| 7 | `POST …/lobby/dedicatedServers/heartBeat` **раз в минуту** на всё время сессии, неся id комнаты, `state: "HostingGame"`, текущий список игроков и блок статистики | запрос: `{"accessToken":"<токен владельца>","clientVersion":"1.8.0","platformId":"ReforgerSteam","id":"<dedicatedServerId>","state":"HostingGame","stats":{"frameTime":{"@type":"aggregation","avg":0.78,"min":0.59,"max":448.7},"memory":{"@type":"single","value":1001833.0},"memory2":{"@type":"single","value":2149996.0},"ai_chars_active":{"@type":"single","value":0.0}},"players":[]}` → `{"currentWorldVersion":"BanSettings","gameEvents":[],"status":"OK"}`; строка лога — `DS Heartbeat Stats: FPS: … frame time (avg: …, min: …, max: …)`. Замерено: через 61 с после регистрации и ещё через 61 с |
| 8 | Игрок входит и выходит через лобби: `rooms/acceptPlayer` с `sessionTicket`, затем `rooms/removePlayer` с причиной выхода. Ответ на первый — всё, что сервер узнаёт об игроке: профиль, валюты, время в игре, **привязки аккаунтов** и запись карьеры | `Authenticated player: rplIdentity=0x00000000 identityId=0ac6169c-… name=kolya_500`, `Player connected: connectionID=0`, `### Updating player: PlayerId=1, …, IdentityId=0ac6169c-…`, `Players connected: 1 / 1`; `character.data` в ответе — это `{"m_aStats":[ … 39 значений … ]}` |
| 9 | Баны: `#ban` администратора уходит в `rooms/createBan` / `rooms/listActiveBans` / `rooms/removeBans` (§3.5), а эскалация системы преступлений — в `rooms/recordBanEvent` | `Player '<id>' banned!`, `Ban removed!` и таблица по 25 записей на страницу в клиенте RCON |
| 10 | При завершении комната снимается с регистрации | `POST …/lobby/rooms/remove` → `{"status":"OK"}` |

Четыре вещи в этой последовательности стоит назвать отдельно:

- **`providerServerId` — это и есть `serverId` токена.** Ответ регистрации возвращает
  `dsConfig.providerServerId`, и выданный вместе с ним токен несёт ровно это значение; то же
  значение возвращается как `roomId`. А `dedicatedServerId` из того же ответа отправляет каждый
  следующий вызов — и как `dedicatedHostId` в `rooms/register`, и как `id` в heartbeat.
- **Сервер отправляет собственные поля, которых не принимает схема конфига.**
  `playerCountLimit` и `supportedGameClientTypes` отвергаются в `server.json`
  ([ServerConfig §5.1](ArmaReforger_ServerConfig_RU.md)), но есть в обоих телах регистрации —
  сервер составляет их сам.
- **В теле комнаты пароль сервера идёт открытым текстом.** `"password":"…"` есть в пойманном
  запросе `rooms/register`; это игровой пароль из `game.password`, отправленный на бэкенд как
  есть. Ничего из этого документа не стоит логировать или куда-то вставлять вместе с этими
  телами. **Когда пароль не задан, поля нет вовсе**, а тот же запрос несёт вместо него
  `"autoJoinable":true` — в перехватах встречается либо пароль без `autoJoinable`, либо его
  отсутствие с этим флагом. Правило, связывающее эту пару, не установлено, а ответ возвращает
  флаг как `dsConfig.game.autoJoinable`.
- **Настроенный мод скачивается до регистрации, а не после.** Второй прогон забрал свой аддон
  через S2S API Workshop и CDN и только потом зарегистрировался. Забранный аддон был собран под
  версию игры 1.4.0.55, скачался без единой жалобы и затем не скомпилировался на 1.8.0.13
  (`Can't compile "Game" script module! … Expected attribute call`) — список загрузки не
  фильтрует по совместимости, а несовместимый мод роняет весь сервер, а не только себя.
- **Карьера на сервере сообщества едет только в одну сторону.** Она приходит в ответе
  `acceptPlayer` и никогда не уходит обратно: запись — это
  `SCR_PlayerProfileManagerComponent.StoreProfile()` → `PlayerCharacterUpdateS2S`, вызываемая из
  `OnPlayerDisconnected`, и ей нужен объект профиля, который `LoadPlayerProfileFromBackend()`
  создаёт **только пока `GetBackendApi().GetDSSession().Status() == EDSESSION_ACTIVE`** — сессию,
  которой путь с токеном владельца не открывает. Пробовались четыре триггера, и ни один не дал
  вызова: 120 с игры, выход игрока, корректная остановка и `#restart`. То есть всё, что игрок
  заработал на таком сервере, в записи карьеры потом не оказывается; пишет ли что-то своё
  *клиент* во время сессии — это другой путь, и он не наблюдался (клиент за прокси не был).

---

## 5. Токены, идентификаторы и что нельзя публиковать

| Что | Что это | Срок жизни |
|---|---|---|
| **`ownerToken.bin`** | Подписанный JWT (`RS512`), называющий сервер и его владельца. **Подпись может поставить только бэкенд.** Выделенный сервер получает его в ответе на свой вызов регистрации, а затем отправляет ту же строку обратно как `accessToken` лобби **в каждом следующем S2S-вызове** — heartbeat, вызовы банов и снятие с регистрации несут его все | Постоянный; пишется один раз на профиль ([Профиль §3](ArmaReforger_Profile_RU.md)) |
| **`x-client-id` / `x-client-secret`** | Пара, которую несёт каждый пойманный вызов: `x-client-id: $edb1b7862bba5cade1f6e06bfdeac2c` и секрет из 32 символов. Это собственные учётные данные клиента, одинаковые на каждом сервере; по ним бэкенд узнаёт легитимный клиент ещё до всякого аккаунта | Статические, поставляются со сборкой |
| **`serverToken` / `serverAccessToken`** | Учётные данные сессии API, которые называют операция `servers/createToken` и её поля (`expireIn`, `persistent`), с обновлением через `servers/auth/refresh`. **Пойманный сервер сообщества ими не пользовался** — его учётными данными сессии был токен владельца, — так что это семейство относится к хостинговому/официальному пути | Короткий, обновляется |
| **Платформенные идентификаторы** | `steamId`, `xboxIdHash`, `psnIdHash`, `platformIdentities`, `currentDeviceType` — хеш платформенного идентификатора, а не сырой Xbox/PSN id. В пойманных запросах отправлялся `platformId: ReforgerSteam`. **Поймано на живом входе:** `platformIdentities` вернулись как `{"biAccountId":"61633507-…","steamId":"76561198964110917"}` — привязанный аккаунт Bohemia игрока, ровно та связка, которую описывает страница [Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity) | На игрока |
| **Game Identity** | Платформенный идентификатор игрока на стороне бэкенда, который можно привязать к одному аккаунту Bohemia; `ownerId` в клиентском токене владельца — как раз он ([Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity)) | Постоянный |

> **Ничто из этого не должно попадать в лог, на скриншот, в отчёт об ошибке или в архив
> профиля.** `ownerToken.bin` и каталог логов `.backend/` — две вещи в профиле сервера,
> на которые стоит посмотреть, прежде чем кому-то его отдавать, — а одно из пойманных тел
> запроса несёт ещё и игровой пароль сервера открытым текстом (§4).

### До чего можно развернуть идентичность

У вопроса «вот identityId — какая платформа, какой магазин, какой аккаунт?» есть короткий ответ
и граница.

**Пока игрок в сессии, у сервера уже есть всё это** — оно приходит в ответе `rooms/acceptPlayer`
(§3.0) и отдельного запроса не требует:

| Поле в том ответе | Что оно говорит | Наблюдено |
|---|---|---|
| `gameClientType` | семейство платформ — `PLATFORM_PC`, `PLATFORM_XBL` или `PLATFORM_PSN` | `PLATFORM_PC` |
| `platformIdentities.steamId` | магазин и аккаунт, целиком: SteamID64 | `76561198964110917` |
| `currentDeviceType` | на чём запущен клиент | `WINDOWS` |
| `platformUsername` | отображаемое имя на платформе | `kolya_500` |
| `platformIdentities.biAccountId` | привязанный аккаунт Bohemia — **только в сети**, см. ниже | UUID |

Моду для первых двух HTTP-тело не нужно. `BackendApi.GetPlayerPlatformKind(playerId)` возвращает
собственное перечисление движка, а оно ровно такое:

```text
enum PlatformKind { NONE, XBOX, PSN, STEAM }
```

(`scripts/GameLib/generated/PlatformKind.c`), а `BackendApi.GetPlayerPlatformId(playerId)`
возвращает идентификатор строкой. Оба имени методов есть в серверном бинарнике 1.8.0.13; оба
помечены `[Obsolete]` в arexplorer 1.7.0.54, и предупреждения в логе самого этого сервера
(`'GetPlayerPlatformKind' is obsolete` в `SCR_EditableEntityComponent.c,785`) — это движок, который
их всё ещё вызывает: на этой сборке они работают, на следующей могут и нет.

**По одной идентичности кандидат есть, но выделенному серверу он недоступен.** Ни одного эндпоинта,
который разворачивает `identityId` в платформу, сервер не вызывал и перехват не поймал, но в
бинарнике один назван — и его спросили напрямую (см. опыт ниже):

```text
POST https://api-ar-game.bistudio.com/game-api/api/v1.0/userProfiles/getMetadata
{"userIds":["<identityId>"],"accessToken":"<пользовательский access token>"}
```

| Что установил опыт | Как |
|---|---|
| Путь существует и принимает **только POST** | GET отвечает `404` с `There is no Msg handler for 'GET /api/v1.0/userProfiles/getMetadata'` |
| Поле называется **`userIds`**, а не `users`, и оно обязательно | Тело с `users` отвечает `Field 'userIds' must not be null, found: null.` |
| **`accessToken` обязателен** | С `userIds` ответ становится `accessToken can't be empty` |
| Нужен **пользовательский** токен, которого у сервера нет | Токен владельца выделенного сервера отвергается с `Unsupported accessToken type` — как и собственный токен владельца игрового клиента, в полезной нагрузке которого `ownerType: GameIdentity` |
| Ответ нёс бы платформенные данные | Класс ответа — `GameApiListGetUserMetadataResponse`, а его RTTI называет `UserMetadata` с вложенной структурой `Platform` |

То есть **выделенный сервер развернуть идентичность в платформу так не может**, и ничто другое,
у чего есть только токен владельца, тоже. Что содержит успешный ответ, не наблюдалось: для этого
нужен клиентский access token, а он есть только у вошедшего игрового клиента. Ограничен ли вызов
своей идентичностью или разворачивает любую, тоже не проверялось — и на чужой идентичности это
лучше и не проверять.

**Конверт ошибок этого API стоит знать при зондировании.** Каждый отказ выше выглядел так:

```text
{"code":400,"apiCode":"InvalidInput","message":"…","uid":"…"}
```

— код HTTP повторён в `code`, собственный короткий код API в `apiCode` (`InvalidInput`,
`NotFound`) и `uid` на запрос. При ошибке валидации `message` **называет виновные поля**, и
именно так была установлена форма запроса у эндпоинта, который нигде не документирован: сервер
сам рассказывает, чего хочет, отказывая в том, что получил.

**Консольные идентификаторы хешированы.** Имена полей в движке — `steamId`, `xboxIdHash` и
`psnIdHash`: сырой только Steam-идентификатор. Это вывод из имён полей, потому что ни один
консольный игрок не заходил ни в одну пойманную сессию, — доходит ли до игры сырой Xbox- или
PSN-идентификатор, неизвестно.

**Ссылки на профиль взять негде.** Шаблона URL страницы игрока в серверном бинарнике нет — там
вообще только адреса крашрепортера и `www.bohemia.net`, — и ни ответ `acceptPlayer`, ни запись
бана ссылки не несут. Ссылку на профиль Steam можно собрать из SteamID64 по соглашению самого
Steam, а в интерфейсе клиента есть `ShowUserProfile`, но на стороне сервера этого не делает
ничто.

**Про `biAccountId` — отдельное предупреждение.** Он в ответе есть, и **ни один класс ни в одном
из бинарников его не объявляет**: строки `biAccountId` нет ни в `ArmaReforgerServer.exe`, ни в
`ArmaReforgerSteam.exe`. Поле разбирается и отбрасывается при разворачивании JSON — так же, как
массивы `blacklist`, `whitelist` и `admins` (`!!! JsonApi Array name="…" found in JSON - which
missing adequate script declaration, items will be skipped!`). Поэтому скрипт на сервере не может
прочитать привязанный аккаунт Bohemia из развёрнутого объекта, хотя бэкенд его присылает:
для этого нужно сырое тело, которого слой REST в скрипты не отдаёт.

---

## 6. Сторона скриптов: до чего дотягивается мод

Мод не говорит с бэкендом по HTTP сам — он спрашивает движок, который уже аутентифицирован.
По `BackendApi.c` (arexplorer **1.7.0.54**):

| Доступ | Что даёт |
|---|---|
| `GetGame().GetBackendApi()` | Объект `BackendApi`: `IsRunning`, `IsInitializing`, `IsActive`, `GetBackendEnv`, счётчики связи (`GetCommTestStatus`, `GetCommResponseTime`, `GetCommTimeLastSuccess`, `GetCommTimeLastFail`, `RefreshCommStatus`) |
| `BackendApi.GetStatusCount()` / `GetStatusItem(i)` / `GetMainStatus()` | Список состояний сервисов — какие сервисы Bohemia живы; за этим стоит экран «Arma Reforger Online Service(s) Status» |
| `BackendApi.GetWorkshop()` | `WorkshopApi` — моды, версии, загрузки, оценки, комментарии |
| `BackendApi.GetGroupCatalogue()` | Группы и их каталоги |
| `BackendApi.GetServerConfigApi()` | `ServerConfigApi` — группа `server-configs/*` |
| `BackendApi.GetBanServiceApi()` | `BanServiceApi` — список банов *этого* сервера |
| `BackendApi.GetClientLobby()` | `ClientLobbyApi` — комнаты, поиск, вход |
| `BackendApi.GetStorage()` | `SessionStorage` — сохранение и загрузка в облаке |
| `BackendApi.GetDSSession()`, `SetSessionCallback(DSSessionCallback)` | Объект сессии выделенного сервера и её события |
| `BackendApi.PlayerCharacterGet(cb, obj, playerId)` / `PlayerCharacterUpdateS2S(cb, obj, playerId)` | Карьера игрока: чтение и запись **только server-to-server** |
| `BackendApi.IsServerOwner(playerId)` / `IsListedServerAdmin(playerId)` | Проверка владельца, за которой стоит `#login` без пароля ([RCON](ArmaReforger_RCON_RU.md) §4.3), и проверка `game.admins` |
| `BackendApi.GetPlayerIdentityId(playerId)` | `identityId` игрока; **устарело** в пользу `BackendAuthenticatorApi.GetIdentityId()` / `IsAuthenticated()` / `IsAuthInProgress()` |
| `BackendApi.GetAvailableConfigs(out array<string>)`, `LoadDSConfig`, `SaveDSConfig`, `GetRunningDSConfig`, `SetDefaultIpPort` | Объект конфигурации выделенного сервера, то есть те же данные, что в `server.json` |
| `GetGame().GetBackendDebugApi()` | `SetLag`, `SetTimeoutRate`, `SetErrorRate`, `SetErrorCode`, `SetTamperRate`, `ApplyOnHost` — **только в developer mode**, чтобы проверить, как ваш код переживает медленный или врущий бэкенд |
| `GetGame().GetRestApi()` | `RestContext`/`RestCallback` для **своих** HTTP-эндпоинтов; только GET и POST, без своих заголовков, до 1 МБ ([wiki](https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage)) |

Данные через эту границу описываются подклассами `JsonApiStruct`, которые регистрируют каждое
поле через `RegV("name")`; **поле, которое класс не зарегистрировал, молча пропускается**, и в
логе это видно: `!!! JsonApi Array name="blacklist" found in JSON - which missing adequate
script declaration, items will be skipped!` (наблюдалось для `blacklist`, `whitelist` и `admins`
на живом прогоне).

Полезно держать в голове две границы: клиентские вызовы вроде `BackendApi.GetLocalIdentityId()`
на выделенном сервере бесполезны, а варианты S2S действительны только на сервере. И, как и всё
остальное здесь, это закрытая поверхность: любой патч BI может её переименовать, пометить
устаревшей или убрать.

---

## 7. Параметры запуска, связанные с бэкендом

Эти четыре строки есть в `ArmaReforgerServer.exe` **1.8.0.13** и **отсутствуют** в
[`data/startup-params.json`](../../data/startup-params.json), то есть в счётчики того документа
они не входят. Что здесь пробовалось и с каким результатом:

| Параметр | Что наблюдалось |
|---|---|
| `-noBackend` | Принимается; в логе `Backend Services are disabled.` — и после этого игровой экземпляр уничтожается примерно через 17 с после загрузки мира, так что сервер этого не переживает ([Профиль](ArmaReforger_Profile_RU.md) §10) |
| `-backendLog <значение>` | **Создаёт `$logs:.backend/logs/`** в каталоге логов запуска. Проверено со значениями `1`, `0` и `false` — все три его создали, и ни в одном случае внутри не появилось файла. Если дать его голым ключом, а следом другой параметр, каталог не появлялся вовсе, то есть значение ему нужно |
| `-backendEnv <значение>` | Принимается и отражается в `CLI Params:`. **Вне песочницы с `preprod` сервер ходил на те же три хоста и нормально регистрировался**, то есть это не переадресация на другой адрес. Поле `ENV:[…]` печатается **только при сбоях**, поэтому из успешного прогона его не прочитать; при сбое без этого параметра печатается `ENV:[production]`. **Что параметр меняет, если меняет вообще, не установлено** |
| `-backendDS`, `-backendFreshSession`, `-backendLocalStorage`, `-backendDisableStorage`, `-backendOnlineStorage`, `-autotest`, `-userName` | Строки в том же блоке бинарника (около `0x1A47E0xx`), рядом с `config`, `gameConfig`, `bindIP`, `bindPort`, `a2sPort`, `rconPort`, `a2sIpAddress`, `rconIpAdress`, `rconPassword`, `addonTempDir`, `addonsVerify`, `steelShieldEnable`, `agones`. **Не пробовались** |

Имена окружений, которые несёт бинарник, — `production`, `preprod` и `submission` (в двух
вариантах регистра); значение по умолчанию в строке сбоя — `ENV:[production]`, а `ENV:[invalid]`
печатает сервер, который вообще не смог разрешить окружение.

---

## 8. Что читать в логе, когда бэкенд недоволен

Про свой обмен с API сервер рассказывает много, в `console.log` и `error.log`.

| Строка | Что означает |
|---|---|
| `[RestApi] ID:[n] TYPE:[<Операция>] ENV:[<окружение>] Error - Cannot send request` | Запрос так и не был отправлен. **Причину смотрите строкой выше.** Поле `ENV` заполняется только когда окружение разрешилось, так что `ENV:[production]` здесь — самая здоровая форма этой строки, а `ENV:[invalid]` означает, что сломано само окружение |
| `Curl error=<текст>` | Транспорт не сработал. `SSL peer certificate or SSH remote key was not OK` — это провал проверки TLS: сбитые часы, прокси или машина, на которой процесс не дотягивается до хранилища сертификатов (например, песочница) |
| `Http Error (BAD_REQUEST)`, `Http Error (TIMEOUT)` | Запрос так и не дал пригодного ответа |
| `[RestApi] Context Request - Empty URL provided!` | У контекста не было адреса, куда отправлять; так выглядит полностью неразрешимое окружение |
| `[RestApi] ID:[%d] TYPE:[LobbyApiS2S/DSUnmanagedRegisterS2S] ENV:[production] Timeout` | Настоящее имя операции из настоящего сбоя: вызов регистрации выше, с разрешённым окружением и без ответа вовремя |
| `[RestApi] Context Count=%d`, `[RestApi] Context Request "%s" - Failed!` | Учёт контекстов |
| `[RestApi] ID:[%d] (Response << SUCCESS)`, `[RestApi] ID:[%d] (%s) size=%d, age=%d ms :: <тело>` | Успешный ответ, с его размером и возрастом |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Error Code:%d - %s, apiCode="%s", uid="%s", message="%s"` | Структурированная ошибка сервиса: код HTTP, сообщение, собственный код API и участвующий uid |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Timeout` | Ответа вовремя не было |
| `curl: (35) schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK` | Это пишет не сервер, но эту строку стоит узнавать, когда *вы* что-то поставили между сервером и бэкендом: Windows отказывает сертификату, у которого не может проверить отзыв |
| `BACKEND: Server registered with address: …`, `Direct Join Code: …`, `Ping Site: …` | Регистрация прошла; код — это то, что игрок вводит для прямого входа |
| `DS Heartbeat Stats: FPS: … frame time (avg: …, min: …, max: …)` | Heartbeat уходит |
| `!!! JsonApi Array name="…" found in JSON - which missing adequate script declaration, items will be skipped!` | В конфиге, присланном бэкендом, было поле, которого не объявляет принимающий класс; элементы отброшены |
| `Backend Services are disabled.` | Принят `-noBackend` |

Коды ошибок, которые печатает сторона скриптов, даёт `BackendApi.GetErrorCode(int)`: `OK`,
`Offline`, `Communication Disabled`, `Cannot be called from current state`,
`Busy processing requests`, `Failed to logon`, `Failed to Authenticate` и ` * ` для всего
остального. Экран состояния в игре питается от `GetStatusCount()` / `GetStatusItem()` /
`GetMainStatus()`.

---

## 9. Что этот документ не устанавливает

- **Перехват охватывает два сервера и один живой вход, причём игровой клиент в него не входит.**
  Собственные вызовы выделенного сервера увидены от начала до конца (§3.0): регистрация,
  конфигурация игры, всплывающее окно, heartbeat, вызовы банов, вход и выход игрока, скачивание
  мода и снятие с регистрации. **Половина клиента — нет**: браузер серверов, очередь на вход, в
  которую клиент может попасть, `servers/join`, вход в сессию и эндпоинты идентичностей
  принадлежат игровому процессу, который намеренно оставлен вне прокси (с ним внутри клиент не
  смог инициализироваться). **Запись** карьеры тоже не наблюдалась, и почему — сказано в §3.0 и §4.
- **Целые сервисы остаются ненаблюдёнными.** Хранилище, группы, уведомления, новостная лента,
  конфигурации серверов в облаке, эндпоинты состояния сервисов и идентичностей и семейство
  `servers/*`: для них этот документ по-прежнему **список строк в бинарнике**, без метода, URL
  и формы. `GET /game-api/api/v1.0/dummy` наблюдался, но не объяснён ничем, кроме своего имени.
- **Соответствие «контекст → префикс» известно только там, где оно увидено.**
  `/game-api/api/v1.0`, `/game-api/s2s-api/v1.0`,
  `/game-config/api/v1/reforger/<версия>/<сборка>/list`, `/workshop-api/api/v3.0`,
  `reforger.armaplatform.com/api` и пути CDN `/manifest` и `/fragment` наблюдались. Какой префикс
  у контекстов хранилища, групп, уведомлений и идентичностей и какой хост их обслуживает,
  **не наблюдалось**.
- **Базового URL в бинарнике по-прежнему нет.** У имён `URI_*` нет рядом адресов, и ни одного
  имени хоста игрового сервиса в `ArmaReforgerServer.exe` не встречается вовсе — присутствуют
  только URL крашрепортера (`cs-public.bistudio.com`, `cs-inter.bistudio.com`) и
  `www.bohemia.net`. Хосты выше взяты из сети, а не из файла.
- **Про timing heartbeat есть один замер.** Через 61 с после регистрации и ещё через 61 с, в одном
  прогоне; фиксирован ли интервал на 60 с, меняется ли он с числом игроков и что может нести
  массив `gameEvents` в ответе — не установлено. `currentWorldVersion: "BanSettings"` в том же
  ответе не объяснено ничем, кроме своего имени.
- **Что меняет `-backendEnv`, не установлено** (§7): с `preprod` хосты были те же, а поле
  `ENV:[…]` печатается только при сбоях.
- **Какой эндпоинт выдаёт *клиентский* токен владельца, не установлено.** У его токена
  `ownerType: GameIdentity` и есть `ownerId`; путь выделенного сервера установлен (§3.3), а
  `dedicatedServers/createOwnerToken` не вызывался ни в одном пойманном прогоне.
- **Связь корневых `serverId` и `ownerType` в `server.json` с одноимёнными полями токена
  владельца** не проверялась. Оба имени есть в схеме конфига и оба заполняет бэкенд; пойманный
  ответ регистрации показывает, что сервер *получает* пару `providerServerId`/`dedicatedServerId`,
  но не то, что он записывает обратно в свой конфиг.
- **Может ли мод вызывать S2S-эндпоинты** и что будет, если он попробует, не проверялось.
- **Ограничения частоты, политика повторов, детали схемы аутентификации и смысл
  `x-client-secret`** в этот документ не входят. Единственные наблюдённые задержки — повтор
  вызова конфигурации игры примерно каждые 6 с, пока он не проходит, heartbeat раз в 61 с и то,
  что бан истёк через 603 с при запрошенных 600.
- **§6 описывает arexplorer 1.7.0.54**, а не 1.8.0.13. Часть членов там уже помечена устаревшей
  (`GetPlayerUID`, `GetLocalIdentityId`, `IsAuthenticated`, `PlayerData`, `Request`) — видно,
  насколько быстро движется эта поверхность. Имена классов и методов в §6 сверялись со списком
  членов, опубликованным вместе с API, а не с установленной сборкой.
- **Agones** (`gameserver`, `watch/gameserver`, `allocate`, `reserve`) описан ровно настолько,
  насколько хватает имён классов. Он относится к собственному парку хостинга Bohemia; ничто
  здесь не говорит, что его использует сервер сообщества, и это не проверялось.

### Источники

| Что | Откуда |
|---|---|
| §3.0, §3.5, §4 и §5 — каждый вызов, URL, метод, заголовок и тело, `ownerToken` в ответе регистрации, тот же JWT как `accessToken` в каждом следующем вызове, запись бана как её вернул бэкенд, тело heartbeat и его интервал 61 с, ответ комнаты с `directJoinCode`/`pingSiteId`/`hostType` и пароль открытым текстом | Четыре прогона выделенного сервера **1.8.0.13** через прокси, терминирующий TLS, на этой машине: чистые профили, непубличные конфиги, запись в `out/mitm-capture.jsonl`, `out/mitm-capture-A.jsonl` (3,5 мин, RCON `ban create`/`ban list 1`/`ban remove`, затем `shutdown`), `out/mitm-capture-B.jsonl` (один мод Workshop) и `out/mitm-capture-JOIN4.jsonl` (игрок с той же машины: вход, игра, выход, повторный вход и RCON `restart`). Каждый прогон зарегистрировался: `Server registered with address:` и `Direct Join Code` |
| §3.0, §3.2, §4 и §5 — вызовы вокруг игрока: запрос `acceptPlayer` (`sessionTicket`) и ответ (`userProfile`, `currencies`, `overallPlayTime`, `platformIdentities` с `biAccountId` и `steamId`, `character.data` с 39 значениями `m_aStats`), `removePlayer` (`expireIn`, `removeEvent`), `dummy` и массив `players` в heartbeat | Тот же прогон со входом; строки лога сервера `Authenticated player:`, `Player connected:`, `### Updating player:` и `Players connected: N / M` — из его `console.log` |
| §3.0 и §4 — почему запись карьеры на сервере сообщества не происходит: триггер и проверка `EDSESSION_ACTIVE` | `scripts/Game/Campaign/SCR_PlayerProfileManagerComponent.c` (строки 87-118 и 124-146) и `scripts/Game/DataCollection/PlayerData/SCR_PlayerData.c` (строки 293-315) через arexplorer **1.7.0.54**; сам отрицательный результат — четыре пойманных сценария |
| §3.6 — путь скачивания из Workshop: `workshop-api/api/v3.0/s2s/assets/download-list`, `manifestPath` каждого файла и запросы CDN `/manifest` и `/fragment` | Второй прогон выше; забранный аддон — `6653028F468BD115` (GTG_Licences), в логе `Addon Download started 6653028F468BD115 - GTG_Licences` → `Required addons are ready to use.` |
| §4 — что несовместимый мод роняет сервер | Тот же прогон: `crash.log` с `Can't compile "Game" script module! scripts/Game/Player/Modded/SCR_PlayerController.c(1): Expected attribute call`, затем `Unable to initialize the game` и `Game destroyed.` |
| §2, §7 и §8 — хосты, `ENV:[production]` как значение по умолчанию и появление поля `ENV:[…]` только при сбоях | Те же перехваты для хостов; неудачные и удачные прогоны того же прохода для поля `ENV`, включая два прогона с `-backendEnv preprod` (те же хосты, зарегистрировался) и `submission` (остановлен, пока грузил мир) |
| Все пути, имена операций, имена полей JSON и фрагменты имён классов, процитированные в §3, §4, §5 и §7 | Строки и символы RTTI `ArmaReforgerServer.exe` **1.8.0.13** (блоки около `0x1A8xxxx`–`0x1A9xxxx` для путей, `0x1A47Dxx`–`0x1A47Fxx` для ключей CLI и конфига, `0x205xxxx`–`0x207xxxx` для имён классов) |
| Имена контекстов `URI_*`, `production` / `preprod` / `submission`, ключи health-check и статуса | Тот же бинарник, блоки около `0x1A87xxx`–`0x1A8Axxx` и `0x18F5xxx` |
| Поверхность скриптов из §6, строки `GetErrorCode`, перечисления `EBackendError` и `EServerType` | `scripts/GameLib/generated/online/BackendApi.c` через arexplorer **1.7.0.54**, плюс wiki BI и опубликованные страницы членов API BI; `EServerType.c` и `BackendDebugApi.c` дополнительно извлечены из **установленного** `addons/core/data.pak` |
| Интервал повторов, предупреждения `JsonApi Array` и поведение `-backendLog` | Прогоны выделенного сервера **1.8.0.13** для этого прохода: `-profile` в пустом каталоге, `-logFS`, `-backendLog` с разными значениями, время работы от 22 с до 3,5 мин. Каталог `$logs:.backend/logs/` создавался от `-backendLog <значение>` и оставался пустым в каждом прогоне, включая зарегистрировавшиеся |
| `ownerToken.bin` как JWT и его поля | [Профиль](ArmaReforger_Profile_RU.md) §3 и перечисленные там файлы токена |
| Входящие порты, которые хостеру нужно открыть | [`ServerConfig`](ArmaReforger_ServerConfig_RU.md) §5.1 и [`RCON`](ArmaReforger_RCON_RU.md) §1 |
| `-noBackend`, уничтожающий игровой экземпляр, список банов на стороне бэкенда, карьера как объект бэкенда | [Профиль](ArmaReforger_Profile_RU.md) §5.6, §5.7 и §10 |
| REST API и JsonApiStruct из скриптов | Wiki BI, «Arma Reforger: REST API Usage» и «JsonApiStruct Usage» |
