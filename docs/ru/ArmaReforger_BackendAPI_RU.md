# Backend API Arma Reforger

Онлайн-сервис, с которым разговаривают игра и выделенный сервер: что это, какие его части
использует сервер, какие эндпоинты называет его собственный бинарник, какие тут есть токены
и идентификаторы, и что установить не удалось.

**Сборка, на которой проверено:** Arma Reforger **1.8.0.13** (engine 192142) — установленная
сборка, новее пина этого репозитория 1.6.0.119 ([data/build.json](../../data/build.json)).
Названия эндпоинтов, операций и полей в §3, §4 и §7 сняты со строк и символов RTTI
`ArmaReforgerServer.exe` **1.8.0.13**; классы со стороны скриптов в §6 — из arexplorer
**1.7.0.54** и с опубликованных страниц членов API BI, поэтому §6 описывает сборку старше
остального. **Ни один запрос и ни один ответ на живом соединении не перехвачены** — границы
всего, что ниже, перечислены в §9, и их стоит прочитать прежде, чем на что-то отсюда ссылаться.

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

- **Единого базового URL в бинарнике нет.** Ни у одного из этих имён нет рядом адреса; адрес
  каждого контекста выясняется во время работы. Что сервер делает, когда выяснить его не
  удаётся, видно в §9: `[RestApi] Context Request - Empty URL provided!`, `ENV:[invalid]`.
- **Путь каждого эндпоинта относителен своего контекста.** `rooms/register` относится к
  лобби, `v4/asset/list` — к Workshop, `s2s/files/` — к хранилищу. **Какой префикс какому
  контексту принадлежит — это вывод из имён, а не наблюдение** (§9).

У нескольких сервисов есть два взаимозаменяемых только на вид семейства методов:
**клиентские** (`ClientLobbyApi`, `GetPingSites`, `RoomsJoin`) и **S2S** — server-to-server —
(`LobbyApiS2S`, `RoomsRegisterS2S`, `CharacterUpdateS2S`). S2S-методы может вызывать только
сервер, и это различие видно в названиях операций ниже.

---

## 3. Эндпоинты, которые называет бинарник

Каждая строка в левой колонке — литерал в `ArmaReforgerServer.exe` **1.8.0.13**. В правой
колонке — имя класса или операции, найденное рядом. **HTTP-метод, полный URL, тело запроса и
тело ответа не наблюдались**: известно, что эти пути есть и какая операция за них отвечает.

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
`SessionLogin`, `ListActiveBans`, `ListBlockedUsers`, `GameStatsRecord`.

### 3.2 Лобби: комнаты, регистрация и heartbeat

Выделенный сервер регистрируется как *комната* (room). Ниже — пути, которыми пользуется
сервер, и рядом имена из старого API лобби:

| Путь | Операции |
|---|---|
| `rooms/register` — `dedicatedHostId`, `scenarioVersion`, `hostUsername`, `dedicated`, `invisible`, `joinQueueMaxSize`, `rplTimeoutS`, `autoJoinable`, `cloudSaveId`, `currentPlayers` | `LobbyApiRoomsRegisterS2S`, `ClientRoomsRegister` |
| `rooms/heartBeat` | `RoomsHeartBeat` |
| `rooms/update`, `rooms/remove` | `RoomsUpdateS2S`, `RoomsRemoveS2S` |
| `rooms/acceptPlayer` — `userProfile`, `userGameData`, `platformIdentities`, `steamId`, `xboxIdHash`, `psnIdHash`, `currencies`, `overallPlayTime` | `LobbyApiRoomsAcceptPlayerS2S` |
| `rooms/removePlayer` | `LobbyApiRoomsRemovePlayerS2S` |
| `rooms/search`, `rooms/getRoomsByIds`, `rooms/listPlayers` | `LobbyApiRoomsSearch`, `RoomsGetByIds`, `RoomListPlayers` |
| `rooms/join`, `rooms/verifyPassword`, `rooms/joinQueue/poll`, `rooms/joinQueue/leave` | `RoomsJoin`, `LobbyApiVerifyPassword`, `QueuePoll`, `QueueLeave` |
| `lobby/getActiveScenarios` | `GetActiveScenariosS2S` |
| `dedicatedServers/heartBeat` | `DSHeartbeatS2S` |
| `dedicatedServers/registerUnmanagedServer` | `DSUnmanagedRegisterS2S` |
| `dedicatedServers/updateGameSaveFileId` | `UpdateGameSaveFileIdS2S` |

### 3.3 Токен владельца

| Путь | Операция | Класс ответа |
|---|---|---|
| `dedicatedServers/createOwnerToken` | `LobbyApiCreateServerOwnerToken`, `CreateServerOwnerToken` | `LobbyApiResponseCreateServerOwnerToken` |

Это тот самый вызов, который даёт `ownerToken.bin`; сам файл, его поля и доказательства
атрибуции — в [Профиле §3](ArmaReforger_Profile_RU.md). Тот же объект несёт токен полем
`ownerToken`, когда конфигурация сервера уходит на бэкенд
(`OwnerTokenExpand@ServerConfiguration`, рядом с ключами `serverId` и `ownerType`).

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

| Путь | Операция |
|---|---|
| `rooms/createBan` — `banDuration` | `CreateBanS2S` |
| `rooms/removeBans` | `RemoveBansS2S` |
| `rooms/listActiveBans` — `playerNameMatchType`, `activeBans` | `ListActiveBansS2S` |
| `rooms/recordBanEvent` — `eventKey`, `currentValue`, `triggerValue`, `triggered` | `RecordBanEventS2S` |
| `rooms/reportPlayer` — `reporterId` | `ReportPlayerS2S` |
| `bans/listActive`, `blockList/listBlocked`, `feedback/create` | `GameApiListActiveBans`, `GameApiListBlockedUsers` |

Классы на стороне движка — `BanServiceApi` и `BlockListApi`; класс записи бана —
`OnlineBanListData`. Где на самом деле живёт список банов и что делает админский бан, —
в [`RCON`](ArmaReforger_RCON_RU.md) §4.4 и [Профиле](ArmaReforger_Profile_RU.md) §5.7.

### 3.6 Остальная поверхность, одной таблицей

| Сервис (контекст) | Пути и операции |
|---|---|
| **Хранилище** `URI_StorageApi` | `s2s/files/`, `s2s/files/<uuid>`, `/temp-url`, `s2s/upload/` — `GetFile`, `GetFileS2S`, `GetFileTempURL(S2S)`, `Upload(S2S)`, `PatchFileS2S`, `DeleteFileS2S`, `ReuploadS2S`; поля `spaceId`, `usedCapacity`, `userSpace`, `mimetype` |
| **Workshop** `URI_WorkshopApi`, `URI_ContentApi`, `URI_WorkshopApi_Backup1` | `assets/list`, `assets/check-user-assets`, `assets/download-list`, `assets/<id>/dependencies`, `/versions/`, `/ratings/@me`, `/reports`, `/subscriptions`, `/favorites`, `assets/difference/size`, `assets/upload/create`, `assets/upload/<id>/files`, `/files/chunk`, `/files/commit`, `/process`, `/cancel`, `s2s/assets/download-list`, `v4/asset/upload/config`, `v4/asset/upload/getDetails`, `v4/asset/download/resolveVersionList`, `v4/asset/download/listFull`, `v4/asset/download/listPartial`, `v4/asset/stats/countDownloads`, `v4/asset/list`, `v4/asset/getListRemainder`, `v4/asset/getDetails`, `v4/asset/revision/*`, `v4/asset/addRating`, `v4/asset/addSubscriptions`, `v4/asset/addBlocks`, `v4/asset/report`, `v4/comment/list`, `v4/comment/create`, `v4/comment/addReaction`, `v4/comment/delete`, `v4/profile/listInteractions`, `contributor/invitations`, `auth/delegationTokens` |
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

Восстановлено по логу живого сервера **1.8.0.13** и по именам из §3. В этом проходе
наблюдались только первые две строки; форма последовательности — то, что подразумевают
эндпоинты.

| Шаг | Что происходит | Что видно в логе |
|---|---|---|
| 1 | Конфиг читается и проверяется локально, затем сервер запрашивает свою онлайн-конфигурацию игры | `Loading dedicated server config.` → `Server config loaded.` → `JSON Schema Validation:` → `JSON is Valid` → `Attempting online Game Config instead.` |
| 2 | `GameConfig/List` — первый REST-вызов. Пока он не проходит, повторяется примерно каждые 6 с | `[RestApi] ID:[1] TYPE:[GameConfig/List] ENV:[invalid] Error - Cannot send request` |
| 3 | Запрашиваются токен сервера и токен доступа (`servers/createToken`: `serverToken`, `serverAccessToken`, `expireIn`, `persistent`), затем сессия аутентифицируется (`servers/auth`, обновление через `servers/auth/refresh`) | — |
| 4 | Регистрируется комната (`rooms/register`, `servers/register`) с тем адресом, который бэкенд отдаст клиентам | `Server registered with address: 127.0.0.1:2001` |
| 5 | Бэкенд отвечает коротким кодом, который игрок может ввести для прямого входа | `Direct Join Code: 0783916060` |
| 6 | Для браузера выбирается ping site | `Ping Site: unknown` |
| 7 | Heartbeat идёт всё время сессии (`rooms/heartBeat`, `dedicatedServers/heartBeat`, `servers/heartbeat`) с FPS, временем кадра и памятью | `DS Heartbeat Stats: FPS: %.1f, frame time (avg: %.1f, min: %.1f, max: %.1f)` |
| 8 | Игроки входят и выходят через лобби (`servers/join`, `rooms/acceptPlayer`, `rooms/removePlayer`), неся с собой профиль и игровые данные игрока | — |
| 9 | Сервер отправляет статистику и, если система преступлений эскалирует, баны (`gameStats/record`, `rooms/createBan`, `rooms/recordBanEvent`) | — |
| 10 | При завершении комната снимается с регистрации (`rooms/remove`, `servers/remove`) | — |

**Токен владельца появляется между шагами 2 и 4.** Он выдаётся один раз на профиль вызовом
`dedicatedServers/createOwnerToken`, а дальше читается с диска при каждом следующем запуске;
в профиле, чьи запросы к бэкенду так и не прошли, токена нет вообще — именно это и обнаружил
зонд из §9.

---

## 5. Токены, идентификаторы и что нельзя публиковать

| Что | Что это | Срок жизни |
|---|---|---|
| **`ownerToken.bin`** | Подписанный JWT (`RS512`), называющий сервер и его владельца. **Подпись может поставить только бэкенд** | Постоянный; пишется один раз на профиль ([Профиль §3](ArmaReforger_Profile_RU.md)) |
| **`serverToken` / `serverAccessToken`** | Учётные данные сессии API из `servers/createToken`, с `expireIn` и флагом `persistent`, и путь обновления (`servers/auth/refresh`) | Короткий, обновляется |
| **Заголовок `Authorization`** | Как предъявляются учётные данные сессии; выдаёт их эндпоинт `servers/auth` | На сессию |
| **Платформенные идентификаторы** | `steamId`, `xboxIdHash`, `psnIdHash`, `platformIdentities`, `currentDeviceType` — хеш платформенного идентификатора, а не сырой Xbox/PSN id | На игрока |
| **Game Identity** | Платформенный идентификатор игрока на стороне бэкенда, который можно привязать к одному аккаунту Bohemia; `ownerId` в клиентском токене владельца — как раз он ([Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity)) | Постоянный |

> **Ничто из этого не должно попадать в лог, на скриншот, в отчёт об ошибке или в архив
> профиля.** `ownerToken.bin` и каталог логов `.backend/` — две вещи в профиле сервера,
> на которые стоит посмотреть, прежде чем кому-то его отдавать.

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
| `-backendEnv <значение>` | Принимается и отражается в `CLI Params:`. С `production`, `preprod` и `dev` строка REST-лога по-прежнему читалась как `ENV:[invalid]`, ровно как и без параметра, поэтому **что он выбирает — не установлено** |
| `-backendDS`, `-backendFreshSession`, `-backendLocalStorage`, `-backendDisableStorage`, `-backendOnlineStorage`, `-autotest`, `-userName` | Строки в том же блоке бинарника (около `0x1A47E0xx`), рядом с `config`, `gameConfig`, `bindIP`, `bindPort`, `a2sPort`, `rconPort`, `a2sIpAddress`, `rconIpAdress`, `rconPassword`, `addonTempDir`, `addonsVerify`, `steelShieldEnable`, `agones`. **Не пробовались** |

Имена окружений, которые несёт бинарник, — `production`, `preprod` и `submission` (в двух
вариантах регистра), а значение по умолчанию в строке лога — `ENV:[invalid]`.

---

## 8. Что читать в логе, когда бэкенд недоволен

Про свой обмен с API сервер рассказывает много, в `console.log` и `error.log`.

| Строка | Что означает |
|---|---|
| `[RestApi] ID:[n] TYPE:[<Операция>] ENV:[<окружение>] Error - Cannot send request` | Запрос так и не был отправлен. **Причину смотрите строкой выше** |
| `Curl error=<текст>` | Транспорт не сработал. `SSL peer certificate or SSH remote key was not OK` — это провал проверки TLS: сбитые часы, прокси, отсутствующее хранилище сертификатов или песочница дадут то же самое |
| `Http Error (BAD_REQUEST)` | Запрос дошёл до сервиса и вернулся не-2xx |
| `[RestApi] Context Request - Empty URL provided!` | У контекста не было адреса, куда отправлять; так выглядит полностью неразрешимое окружение |
| `[RestApi] Context Count=%d`, `[RestApi] Context Request "%s" - Failed!` | Учёт контекстов |
| `[RestApi] ID:[%d] (Response << SUCCESS)`, `[RestApi] ID:[%d] (%s) size=%d, age=%d ms :: <тело>` | Успешный ответ, с его размером и возрастом |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Error Code:%d - %s, apiCode="%s", uid="%s", message="%s"` | Структурированная ошибка сервиса: код HTTP, сообщение, собственный код API и участвующий uid |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Timeout` | Ответа вовремя не было |
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

- **Ни один живой обмен по HTTP не перехвачен.** Машина, на которой шёл этот проход, не может
  завершить рукопожатие TLS (`Curl error=SSL peer certificate or SSH remote key was not OK` от
  игры и `schannel: AcquireCredentialsHandle failed` из оболочки), поэтому все запросы
  сервера-зонда умирали, не успев уйти. Следовательно **базовые URL, полный URL любого пути,
  HTTP-метод любого вызова и любые тела запросов и ответов неизвестны.** Пути в §3 — это строки
  в бинарнике, а не наблюдённый трафик.
- **Базового URL в бинарнике нет.** У имён контекстов `URI_*` нет рядом адресов, и ни одного
  имени хоста игрового сервиса в `ArmaReforgerServer.exe` не встречается вовсе — присутствуют
  только URL крашрепортера (`cs-public.bistudio.com`, `cs-inter.bistudio.com`) и
  `www.bohemia.net`.
- **То, какой контекст обслуживает какой путь, — вывод** из имён классов и контекстов, а не
  наблюдение. Группировка в §3.6 — самая спорная часть этого документа.
- **`ENV:[invalid]`** было значением в каждой строке каждого прогона-зонда, включая прогоны с
  `-backendEnv production`, `preprod` и `dev`. Что делает окружение «недействительным» и тот ли
  это параметр, который его выбирает, не установлено.
- **Связь корневых `serverId` и `ownerType` в `server.json` с одноимёнными полями токена
  владельца** не проверялась. Оба имени есть в схеме конфига и оба заполняет бэкенд; совет
  руководства в силе — не пишите ни то, ни другое
  ([ServerConfig](ArmaReforger_ServerConfig_RU.md) §5.1).
- **Может ли мод вызывать S2S-эндпоинты** и что будет, если он попробует, не проверялось.
- **Ограничения частоты, политика повторов, таймауты и детали схемы аутентификации** в этот
  документ не входят. Единственная наблюдённая задержка — повтор `GameConfig/List` примерно
  каждые 6 с, пока он не проходит.
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
| Все пути, имена операций, имена полей JSON и фрагменты имён классов, процитированные в §3, §4, §5 и §7 | Строки и символы RTTI `ArmaReforgerServer.exe` **1.8.0.13** (блоки около `0x1A8xxxx`–`0x1A9xxxx` для путей, `0x1A47Dxx`–`0x1A47Fxx` для ключей CLI и конфига, `0x205xxxx`–`0x207xxxx` для имён классов) |
| Имена контекстов `URI_*`, `production` / `preprod` / `submission`, ключи health-check и статуса | Тот же бинарник, блоки около `0x1A87xxx`–`0x1A8Axxx` и `0x18F5xxx` |
| Поверхность скриптов из §6, строки `GetErrorCode`, перечисления `EBackendError` и `EServerType` | `scripts/GameLib/generated/online/BackendApi.c` через arexplorer **1.7.0.54**, плюс wiki BI и опубликованные страницы членов API BI; `EServerType.c` и `BackendDebugApi.c` дополнительно извлечены из **установленного** `addons/core/data.pak` |
| Жизненный цикл выделенного сервера из §4, интервал повторов, строки `ENV:[invalid]`, предупреждения `JsonApi Array` и поведение `-backendLog` | Прогон выделенного сервера **1.8.0.13** для этого прохода: непубличный конфиг, `-profile` в пустом каталоге внутри `out/backend-probe`, `-logFS`, `-backendLog`, 45 с работы; плюс пять коротких прогонов для `-backendEnv` и три для `-backendLog` |
| `ownerToken.bin` как JWT, его поля и атрибуция `dedicatedServers/createOwnerToken` | [Профиль](ArmaReforger_Profile_RU.md) §3 и пять файлов токена, которые он перечисляет |
| Входящие порты, которые хостеру нужно открыть | [`ServerConfig`](ArmaReforger_ServerConfig_RU.md) §5.1 и [`RCON`](ArmaReforger_RCON_RU.md) §1 |
| `-noBackend`, уничтожающий игровой экземпляр, список банов на стороне бэкенда, карьера как объект бэкенда | [Профиль](ArmaReforger_Profile_RU.md) §5.6, §5.7 и §10 |
| REST API и JsonApiStruct из скриптов | Wiki BI, «Arma Reforger: REST API Usage» и «JsonApiStruct Usage» |
