# Arma Reforger backend API

The online service the game and the dedicated server talk to: what it is, which parts of it a
server uses, the endpoints its own binary names, the tokens and identities involved, and what
could not be established.

**Build verified on:** Arma Reforger **1.8.0.13** (engine 192142) — the installed build, newer
than this repository's 1.6.0.119 pin ([data/build.json](../../data/build.json)). The endpoint,
operation and field names in §3, §4 and §7 are read from the strings and RTTI symbols of
`ArmaReforgerServer.exe` **1.8.0.13**; the script-side classes in §6 are from arexplorer
**1.7.0.54** and the published BI API member pages, so §6 describes a build older than the rest.
**No request or response was captured on a live connection** — §9 is the boundary of everything
below, and it is worth reading before quoting any of it.

> **This is an unofficial description of a private API.** Bohemia publishes no reference for these
> endpoints — the wiki covers the *script-side* access to them ([REST API
> Usage](https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage),
> [JsonApiStruct Usage](https://community.bistudio.com/wiki/Arma_Reforger:JsonApiStruct_Usage),
> [Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity)) and the
> account side of mod publishing, but not the service itself. The names below were read out of a
> shipped binary, they are not a stable contract, and they can change in any patch without notice.
> Calling this service from outside the game is not supported by Bohemia.

---

## 1. What "the backend" is

**The backend is Bohemia's online service for the game**, and both the client and the dedicated
server are *clients* of it. It is the authority for things the game does not keep locally:

| What lives there | Used by | Where it shows |
|---|---|---|
| The server registry and the server browser — what servers exist, their address, player count, mods, ping | Server registers, client reads | The server browser; "Server registered with address: …" in the server log |
| The **owner token** that proves who owns a server ([Profile §3](ArmaReforger_Profile_EN.md)) | Server | `ownerToken.bin` in the profile |
| Admin bans and reports — the list belongs to one server | Server | `#ban` over RCON and in chat; [`RCON`](ArmaReforger_RCON_EN.md) §4.4 |
| The career record of every player (`m_aStats`, ranks, XP) | Server, client | `profile/.save/playersave/`, [Profile](ArmaReforger_Profile_EN.md) §5 |
| Accounts and Game Identities — the link between a platform identity (Steam, Xbox, PSN) and a Bohemia account | Client | "Link Bohemia account" in the UI |
| Server configs stored in the cloud (the `server-configs/*` group) | Client, server | The server-config UI in the game |
| The Workshop: mods, versions, manifests, comments, ratings, uploads | Client, Workbench | The Workshop; `data*.pak` addon downloads |
| Cloud storage for saves and other files | Client, server | Session saves, `cloud-saves-ar` |
| Notifications, news, popups, groups, product offers, telemetry | Client, server | The main menu; the server's own stats reporting |

**A dedicated server is a backend client from the first second.** On the verified build the first
backend call happens before the world loads, and a server that cannot reach the backend does not
get to the point of being listed — see §4. The `-noBackend` switch exists and is accepted, but on
this build the game instance is destroyed about 17 s into the world load with it
([Profile](ArmaReforger_Profile_EN.md) §10), so it is not a way to run offline.

**Nothing is opened inbound for this.** The server *dials out* over HTTPS; the ports a hoster has
to forward are the game port, A2S and RCON ([ServerConfig](ArmaReforger_ServerConfig_EN.md) §5.1),
not anything in this document.

---

## 2. How the API is organised

The binary names its own API "contexts" — `URI_AccountApi`, `URI_ClientLobbyApi`, `URI_ContentApi`,
`URI_GameApi`, `URI_GameApiS2S`, `URI_GameApiV2`, `URI_GroupApi`, `URI_GroupApiV2`,
`URI_IdentityApi`, `URI_LobbyApi`, `URI_NewsApi`, `URI_NotifyApi`, `URI_PopUpApi`,
`URI_StarRiver`, `URI_StorageApi`, `URI_TreasureData`, `URI_UserApi`, `URI_WorkshopApi`,
`URI_WorkshopApi_Backup1`, `URI_BImageApi`, `URI_BImageApi_CDN`, `URI_STSApi`, `URI_STSContext`,
`URI_NotifyWs` — and an environment selector with the values `production`, `preprod`,
`submission`.

Two things follow, and they matter for reading §3:

- **There is no single base URL in the binary.** Not one of these names has a URL next to it; the
  address behind each context is resolved at runtime. What the server does when it cannot resolve
  one is in §9: `[RestApi] Context Request - Empty URL provided!`, `ENV:[invalid]`.
- **Each endpoint path is relative to its context.** `rooms/register` belongs to the lobby
  context, `v4/asset/list` to the Workshop context, `s2s/files/` to storage. **Which prefix
  belongs to which context is an inference from the names, not an observation** (§9).

Two method families exist for several services and are not interchangeable: **client** methods
(`ClientLobbyApi`, `GetPingSites`, `RoomsJoin`) and **S2S** — server-to-server — methods
(`LobbyApiS2S`, `RoomsRegisterS2S`, `CharacterUpdateS2S`). Only a server can call the S2S ones,
and the distinction is visible in the operation names below.

---

## 3. The endpoints the binary names

Every string in the left column is a literal in `ArmaReforgerServer.exe` **1.8.0.13**. The right
column is the class or operation name found beside it. **The HTTP method, the full URL, the
request and response bodies were not observed**: what is known is that these paths exist and which
operation carries them.

### 3.1 Registering a server and the server browser

| Path / operation | Carried by |
|---|---|
| `servers/createToken` — fields `serverToken`, `serverAccessToken`, `serverType`, `persistent`, `expireIn` | `GameApiV2_Servers_CreateToken` |
| `servers/auth`, `servers/auth/refresh` — header `Authorization` | `GameApiV2_Servers_Auth` |
| `servers/register` | `GameApiV2_Servers_Register` |
| `servers/heartbeat` — `frameTime`, `frameCount`, `memory`, `rplSentBytes`, `ai_chars_active`, `vhc_wheeled_active`, `vhc_helicopter_active` | `GameApiV2_Servers_Heartbeat`, `LobbyApiRequestDSHeartbeat`, `DSHeartbeatS2S` |
| `servers/remove` | `GameApiV2_Servers_Remove` |
| `servers/acceptPlayer`, `servers/removePlayer` (`removeEvent`) | `GameApiV2_Servers_AcceptPlayer`, `…_RemovePlayer` |
| `servers/join`, `servers/joinQueue/poll`, `servers/joinQueue/leave` — `sessionTicket`, `ticket`, `secret` | `GameApiV2_Servers_Join`, `…_Queue_Poll`, `…_Queue_Leave` |
| `servers/getDetails`, `servers/getByIds`, `servers/list` — `detailsFields`, `serverIds`, `slice` | `GameApiV2_Servers_GetDetails`, `…_GetByIds`, `…_List` |
| `servers/pingSites` — `pingSiteId`, `avgRTT` | `GameApiV2_Servers_PingSites`, `LobbyApiGetPingSites` |
| `servers/markFavorites`, `servers/unmarkFavorites` | `GameApiV2_Servers_MarkFavorites`, `…_UnmarkFavorites` |
| `user/gameData/getOwn`, `updateOwn`, `getBatch`, `updateBatch` — `userIds`, `updates`, `expectedVersion`, `replaceGameData`, `patchGameData` | `GameApiV2_UserGameData_*` |

The older, still present family (`GameApiV1`, `GameApiS2S`) carries the same idea under different
paths: `session/login`, `character/getCharacter`, `character/updateCharacter`, `devel/getCharacter`,
`devel/updateCharacter`, `userProfiles/getMetadata`, `bans/listActive`, `blockList/listBlocked`,
`gameStats/record`, and the operations `CharacterGet`, `CharacterUpdateS2S`, `SessionLogin`,
`ListActiveBans`, `ListBlockedUsers`, `GameStatsRecord`.

### 3.2 The lobby: rooms, registration and heartbeats

The dedicated server registers as a *room*. These are the paths a server used, with the older
lobby API's own names beside them:

| Path | Operations |
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

### 3.3 The owner token

| Path | Operation | Response class |
|---|---|---|
| `dedicatedServers/createOwnerToken` | `LobbyApiCreateServerOwnerToken`, `CreateServerOwnerToken` | `LobbyApiResponseCreateServerOwnerToken` |

This is the call that produces `ownerToken.bin`; the file, its claims and the evidence for the
attribution are in [Profile §3](ArmaReforger_Profile_EN.md). The same object carries the token as
the field `ownerToken` when the server configuration is exchanged with the backend
(`OwnerTokenExpand@ServerConfiguration`, beside the keys `serverId` and `ownerType`).

### 3.4 Server configs in the cloud

| Path | Operation |
|---|---|
| `server-configs/save` | `SaveServerConfig` |
| `server-configs/list` | `ListServerConfig` |
| `server-configs/download` | `DownloadServerConfig`, `DownloadServerConfigS2S` |
| `server-configs/delete` | `DeleteServerConfig` |

`Upload server config` and the key `dsConfig` sit in the same string block. The object saved here
is the same `ServerConfiguration` family that carries `ownerToken`, `serverId`, `ownerType`,
`maxPlayers`, `mods`, `missionHeader`, `gameProperties` and the rest — the JSON keys of §5 of the
config guide appear in that block too.

### 3.5 Bans, blocks and reports

| Path | Operation |
|---|---|
| `rooms/createBan` — `banDuration` | `CreateBanS2S` |
| `rooms/removeBans` | `RemoveBansS2S` |
| `rooms/listActiveBans` — `playerNameMatchType`, `activeBans` | `ListActiveBansS2S` |
| `rooms/recordBanEvent` — `eventKey`, `currentValue`, `triggerValue`, `triggered` | `RecordBanEventS2S` |
| `rooms/reportPlayer` — `reporterId` | `ReportPlayerS2S` |
| `bans/listActive`, `blockList/listBlocked`, `feedback/create` | `GameApiListActiveBans`, `GameApiListBlockedUsers` |

The engine-side classes are `BanServiceApi` and `BlockListApi`; the ban record class is
`OnlineBanListData`. Where the ban list actually lives, and what an admin ban does, is in
[`RCON`](ArmaReforger_RCON_EN.md) §4.4 and [Profile](ArmaReforger_Profile_EN.md) §5.7.

### 3.6 The rest of the surface, in one table

| Service (context) | Paths and operations |
|---|---|
| **Storage** `URI_StorageApi` | `s2s/files/`, `s2s/files/<uuid>`, `/temp-url`, `s2s/upload/` — `GetFile`, `GetFileS2S`, `GetFileTempURL(S2S)`, `Upload(S2S)`, `PatchFileS2S`, `DeleteFileS2S`, `ReuploadS2S`; the fields `spaceId`, `usedCapacity`, `userSpace`, `mimetype` |
| **Workshop** `URI_WorkshopApi`, `URI_ContentApi`, `URI_WorkshopApi_Backup1` | `assets/list`, `assets/check-user-assets`, `assets/download-list`, `assets/<id>/dependencies`, `/versions/`, `/ratings/@me`, `/reports`, `/subscriptions`, `/favorites`, `assets/difference/size`, `assets/upload/create`, `assets/upload/<id>/files`, `/files/chunk`, `/files/commit`, `/process`, `/cancel`, `s2s/assets/download-list`, `v4/asset/upload/config`, `v4/asset/upload/getDetails`, `v4/asset/download/resolveVersionList`, `v4/asset/download/listFull`, `v4/asset/download/listPartial`, `v4/asset/stats/countDownloads`, `v4/asset/list`, `v4/asset/getListRemainder`, `v4/asset/getDetails`, `v4/asset/revision/*`, `v4/asset/addRating`, `v4/asset/addSubscriptions`, `v4/asset/addBlocks`, `v4/asset/report`, `v4/comment/list`, `v4/comment/create`, `v4/comment/addReaction`, `v4/comment/delete`, `v4/profile/listInteractions`, `contributor/invitations`, `auth/delegationTokens` |
| **Accounts, identities, auth** `URI_UserApi`, `URI_AccountApi`, `URI_IdentityApi`, `URI_STSApi` | `auth/login` (`client_id`, `two_factor_token`, `access_token`), `game-identity/token`, `/links`, `/links/bi-account`, `/token` — `DirectLogin`, `GetUser`, `IdentityApiAuth`, `IdentityApiCreate`, `IdentityApiLink`, `IdentityApiUnlink`, `SecurityGetJWT4STS` (class `STSApi…`), `WorkshopApiDelegationTokens` |
| **Groups** `URI_GroupApi`, `URI_GroupApiV2` | `group/list`, `group/create`, `group/update`, `group/disband`, `group/<id>`, `group/transferTopRole`, `group/members/list`, `group/membership/kick`, `group/membership/updateRole`, `group/leave`, `group/setActive`, `group/account/current/membership`, `group/application/create`, `group/application/list`, `group/application/evaluate`, `group/application/delete`, `group/createImageUploadToken`, `group/log/list`, `images/groups/` — `GroupApiGetGroups`, `GroupApiRegisterGroup`, `GroupApiGetMembers`, `GroupApiEvaluateApplication`, `GroupApiGetAuditLog`, … |
| **Notifications and profiles** `URI_NotifyApi`, `URI_NotifyWs` | `notifications/list`, `notifications/delete`, `notifications/markAsRead`, `profiles/settings/update`, `profiles/me`, `profiles/@me/personalBlocks/profiles` — `ListNotifications`, `MarkAsRead`, `DeleteNotifications`, `GetProfile`, `UpdateProfileSettings`, `NotificationCatalogueApi` |
| **News and popups** `URI_NewsApi`, `URI_PopUpApi` | news-feed and popup objects (`NewsFeedItem`, `PopupFeedItem`, `BannerText`, `ActionButtonURL`, …) |
| **Images** `URI_BImageApi`, `URI_BImageApi_CDN` | `v1/image/upload` — `ImageUpload`, `BImageApiDownload`; header `X-TD-Write-Key` next to the telemetry block |
| **Telemetry** `URI_StarRiver`, `URI_TreasureData` | `/demo/prod/report` with `log_name`, `log_data`, `ts_server_time` — `SendEventSR`, `SendEventTD`, `SendLegacySR`; the server's own stat keys (`evt_*`, `id_server`, `req_total`, `req_fail`, `beat_total`, `beat_fail`, `amt_ram`, `cnt_cpu`, `code_country`, …) sit in the same block |
| **Server renting and offers** `URI_GameApi` | `offers/list`, `products/get` — `ProductOfferCatalogueApi`, `ExtrasApiListOffers`, `ExtrasApiGetProduct`; `ProductServerRentingDetails`, `EServerHardwareSize` |
| **Game-server orchestration** | `gameserver`, `watch/gameserver`, `metadata/label`, `metadata/annotation`, `allocate`, `reserve`, `ready`, `health` — the `AgonesApi*` classes. This is the fleet layer for hosted servers, not something a community server calls |

---

## 4. What a dedicated server does, in order

Reconstructed from a live **1.8.0.13** server log and from the names in §3. Only the first two
lines were watched in this pass; the shape of the sequence is what the endpoints imply.

| Step | What happens | Seen in the log |
|---|---|---|
| 1 | The config is read and validated locally, then the server asks for its online game config | `Loading dedicated server config.` → `Server config loaded.` → `JSON Schema Validation:` → `JSON is Valid` → `Attempting online Game Config instead.` |
| 2 | `GameConfig/List` — the first REST call. It is retried about every 6 s while it fails | `[RestApi] ID:[1] TYPE:[GameConfig/List] ENV:[invalid] Error - Cannot send request` |
| 3 | A server token and an access token are requested (`servers/createToken`: `serverToken`, `serverAccessToken`, `expireIn`, `persistent`), then the session authenticates (`servers/auth`, refreshed by `servers/auth/refresh`) | — |
| 4 | The room is registered (`rooms/register`, `servers/register`) with the address the backend will hand to clients | `Server registered with address: 127.0.0.1:2001` |
| 5 | The backend answers with a short code players can type to join directly | `Direct Join Code: 0783916060` |
| 6 | A ping site is chosen for the browser | `Ping Site: unknown` |
| 7 | Heartbeats continue for the life of the session (`rooms/heartBeat`, `dedicatedServers/heartBeat`, `servers/heartbeat`) with FPS, frame time and memory | `DS Heartbeat Stats: FPS: %.1f, frame time (avg: %.1f, min: %.1f, max: %.1f)` |
| 8 | Players join and leave through the lobby (`servers/join`, `rooms/acceptPlayer`, `rooms/removePlayer`), carrying the player's profile and game data | — |
| 9 | The server reports stats and, if a crime system escalates, bans (`gameStats/record`, `rooms/createBan`, `rooms/recordBanEvent`) | — |
| 10 | At shutdown the room is unregistered (`rooms/remove`, `servers/remove`) | — |

**The owner token belongs between steps 2 and 4.** It is issued once per profile by
`dedicatedServers/createOwnerToken` and then read from disk on every later start; a profile whose
backend calls never got through holds no token at all, which is what the probe in §9 found.

---

## 5. Tokens, identities and what may be published

| Thing | What it is | Lifetime |
|---|---|---|
| **`ownerToken.bin`** | A signed JWT (`RS512`) naming the server and its owner. **Its signature can only come from the backend** | Permanent; written once per profile ([Profile §3](ArmaReforger_Profile_EN.md)) |
| **`serverToken` / `serverAccessToken`** | The API session credential from `servers/createToken`, with `expireIn` and a `persistent` flag, and a refresh path (`servers/auth/refresh`) | Short, refreshed |
| **`Authorization` header** | How the session credential is presented; `servers/auth` is the endpoint that issues it | Per session |
| **Platform identities** | `steamId`, `xboxIdHash`, `psnIdHash`, `platformIdentities`, `currentDeviceType` — a hashed platform id, not a raw Xbox/PSN id | Per player |
| **Game Identity** | The backend's per-platform identity for a player, linkable to one Bohemia account; `ownerId` in the client's owner token is one ([Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity)) | Permanent |

> **None of these belong in a log, a screenshot, an issue report or a profile archive.**
> `ownerToken.bin` and the `.backend/` log directory are the two things in a server profile to look
> at before handing it to anyone.

---

## 6. The script side: what a mod can reach

A mod does not speak HTTP to the backend itself; it asks the engine, which is already
authenticated. From `BackendApi.c` (arexplorer **1.7.0.54**):

| Access | What it gives |
|---|---|
| `GetGame().GetBackendApi()` | The `BackendApi` object: `IsRunning`, `IsInitializing`, `IsActive`, `GetBackendEnv`, communication counters (`GetCommTestStatus`, `GetCommResponseTime`, `GetCommTimeLastSuccess`, `GetCommTimeLastFail`, `RefreshCommStatus`) |
| `BackendApi.GetStatusCount()` / `GetStatusItem(i)` / `GetMainStatus()` | The service status list — which Bohemia services are up, behind the "Arma Reforger Online Service(s) Status" screen |
| `BackendApi.GetWorkshop()` | `WorkshopApi` — mods, versions, downloads, ratings, comments |
| `BackendApi.GetGroupCatalogue()` | Groups and their catalogues |
| `BackendApi.GetServerConfigApi()` | `ServerConfigApi` — the `server-configs/*` group |
| `BackendApi.GetBanServiceApi()` | `BanServiceApi` — the ban list of *this* server |
| `BackendApi.GetClientLobby()` | `ClientLobbyApi` — rooms, search, join |
| `BackendApi.GetStorage()` | `SessionStorage` — cloud save and load |
| `BackendApi.GetDSSession()`, `SetSessionCallback(DSSessionCallback)` | The dedicated-server session object and its events |
| `BackendApi.PlayerCharacterGet(cb, obj, playerId)` / `PlayerCharacterUpdateS2S(cb, obj, playerId)` | The career record of a player: read, and write **server-to-server only** |
| `BackendApi.IsServerOwner(playerId)` / `IsListedServerAdmin(playerId)` | The owner check behind password-less `#login` ([RCON](ArmaReforger_RCON_EN.md) §4.3), and the `game.admins` check |
| `BackendApi.GetPlayerIdentityId(playerId)` | The player's `identityId`; **obsolete** in favour of `BackendAuthenticatorApi.GetIdentityId()` / `IsAuthenticated()` / `IsAuthInProgress()` |
| `BackendApi.GetAvailableConfigs(out array<string>)`, `LoadDSConfig`, `SaveDSConfig`, `GetRunningDSConfig`, `SetDefaultIpPort` | The dedicated-server config object, i.e. the same data as `server.json` |
| `GetGame().GetBackendDebugApi()` | `SetLag`, `SetTimeoutRate`, `SetErrorRate`, `SetErrorCode`, `SetTamperRate`, `ApplyOnHost` — **developer mode only**, for testing how your code handles a slow or lying backend |
| `GetGame().GetRestApi()` | `RestContext`/`RestCallback` for **your own** HTTP endpoints; GET and POST only, no custom headers, under 1 MB ([wiki](https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage)) |

Data crossing this boundary is described by `JsonApiStruct` subclasses that register each field
with `RegV("name")`; **a field the class does not register is silently skipped**, and the log says
so: `!!! JsonApi Array name="blacklist" found in JSON - which missing adequate script declaration,
items will be skipped!` (observed for `blacklist`, `whitelist` and `admins` in a live run).

Two boundaries worth keeping in mind: client-only calls such as `BackendApi.GetLocalIdentityId()`
do nothing useful on a dedicated server, and the S2S variants are only valid server-side. And as
with everything else here, this is a private surface: a BI patch may rename, obsolete or remove
any of it.

---

## 7. Startup parameters that touch the backend

These four are strings in `ArmaReforgerServer.exe` **1.8.0.13** and are **not** part of
[`data/startup-params.json`](../../data/startup-params.json), so they are outside that document's
counts. What was tried here, and with what result:

| Parameter | What was observed |
|---|---|
| `-noBackend` | Accepted; the log says `Backend Services are disabled.` — and the game instance is then destroyed about 17 s into the world load, so the server does not survive it ([Profile](ArmaReforger_Profile_EN.md) §10) |
| `-backendLog <value>` | **Creates `$logs:.backend/logs/`** in the run's log directory. Verified with `1`, `0` and `false` — all three created it, and in none of them did it contain a file. Given as a bare switch with another parameter after it, the directory did not appear at all, so it wants a value |
| `-backendEnv <value>` | Accepted and echoed in `CLI Params:`. With `production`, `preprod` and `dev` the REST log line still read `ENV:[invalid]`, exactly as with no parameter at all, so **what it selects was not established** |
| `-backendDS`, `-backendFreshSession`, `-backendLocalStorage`, `-backendDisableStorage`, `-backendOnlineStorage`, `-autotest`, `-userName` | Strings in the same block of the binary (around `0x1A47E0xx`), beside `config`, `gameConfig`, `bindIP`, `bindPort`, `a2sPort`, `rconPort`, `a2sIpAddress`, `rconIpAdress`, `rconPassword`, `addonTempDir`, `addonsVerify`, `steelShieldEnable`, `agones`. **Not tried** |

The environment names the binary carries are `production`, `preprod` and `submission` (in two
casing variants), and the resting value in a log line is `ENV:[invalid]`.

---

## 8. Reading the log when the backend is unhappy

The server says a lot about its own API traffic, in `console.log` and `error.log`.

| Line | What it means |
|---|---|
| `[RestApi] ID:[n] TYPE:[<Op>] ENV:[<env>] Error - Cannot send request` | The request was never sent. **Look one line up for the reason** |
| `Curl error=<text>` | The transport failed. `SSL peer certificate or SSH remote key was not OK` is a TLS verification failure — a bad clock, a proxy, a missing certificate store or a sandboxed machine will all produce it |
| `Http Error (BAD_REQUEST)` | The request reached the service and came back non-2xx |
| `[RestApi] Context Request - Empty URL provided!` | The context had no address to send to; this is the shape a completely unresolvable environment takes |
| `[RestApi] Context Count=%d`, `[RestApi] Context Request "%s" - Failed!` | Context bookkeeping |
| `[RestApi] ID:[%d] (Response << SUCCESS)`, `[RestApi] ID:[%d] (%s) size=%d, age=%d ms :: <body>` | A successful answer, with its size and age |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Error Code:%d - %s, apiCode="%s", uid="%s", message="%s"` | A structured service error: HTTP code, message, the API's own code and the uid involved |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Timeout` | No answer in time |
| `BACKEND: Server registered with address: …`, `Direct Join Code: …`, `Ping Site: …` | Registration succeeded; the code is what a player types to join directly |
| `DS Heartbeat Stats: FPS: … frame time (avg: …, min: …, max: …)` | The heartbeat is going out |
| `!!! JsonApi Array name="…" found in JSON - which missing adequate script declaration, items will be skipped!` | The config sent by the backend held a field the receiving class does not declare; the items were dropped |
| `Backend Services are disabled.` | `-noBackend` was accepted |

The error codes the script side prints come from `BackendApi.GetErrorCode(int)`: `OK`, `Offline`,
`Communication Disabled`, `Cannot be called from current state`, `Busy processing requests`,
`Failed to logon`, `Failed to Authenticate`, and ` * ` for anything else. The status screen the
game shows is fed by `GetStatusCount()` / `GetStatusItem()` / `GetMainStatus()`.

---

## 9. What this document does not establish

- **No live HTTP exchange was captured.** The machine this pass ran on cannot complete a TLS
  handshake (`Curl error=SSL peer certificate or SSH remote key was not OK` from the game, and
  `schannel: AcquireCredentialsHandle failed` from the shell), so every request the probe server
  made died before it was sent. Consequently **the base URLs, the full URL of any path, the HTTP
  method of any call, and every request and response body are unknown.** The paths in §3 are
  strings in the binary, not observed traffic.
- **The base URL is not a literal in the binary.** The `URI_*` context names have no addresses
  next to them, and no host name for the game service appears anywhere in
  `ArmaReforgerServer.exe` — the only URLs present are the crash reporter's
  (`cs-public.bistudio.com`, `cs-inter.bistudio.com`) and `www.bohemia.net`.
- **Which context serves which path is an inference** from the class and context names, not an
  observation. The grouping in §3.6 is the least certain part of this document.
- **`ENV:[invalid]`** was the value in every line of every probe run, including runs with
  `-backendEnv production`, `preprod` and `dev`. What makes an environment "invalid", and whether
  `-backendEnv` is the parameter that selects it, was not established.
- **The relationship between the root-level `serverId` and `ownerType` in `server.json` and the
  claims of the same name in the owner token** was not verified. Both names exist in the config
  schema and both are filled in by the backend; the guide's advice stands — do not write either
  ([ServerConfig](ArmaReforger_ServerConfig_EN.md) §5.1).
- **Whether a mod may call the S2S endpoints**, and what happens if it tries, was not tested.
- **Rate limits, retry policy, timeouts and the auth scheme's details** are not in this document.
  The only timing observed is the ~6 s retry on `GameConfig/List` while it fails.
- **§6 describes arexplorer 1.7.0.54**, not 1.8.0.13. Several members are already marked obsolete
  there (`GetPlayerUID`, `GetLocalIdentityId`, `IsAuthenticated`, `PlayerData`, `Request`), which
  shows how fast this surface moves. The class and method names in §6 were checked against the
  member list published with the API, not against the installed build.
- **Agones** (`gameserver`, `watch/gameserver`, `allocate`, `reserve`) is described only as far as
  the class names go. It belongs to Bohemia's own hosting fleet; nothing here suggests a community
  server uses it, and that was not tested.

### Sources

| What | From where |
|---|---|
| Every path, operation name, JSON field name and class-name fragment quoted in §3, §4, §5 and §7 | Strings and RTTI symbols of `ArmaReforgerServer.exe` **1.8.0.13** (blocks around `0x1A8xxxx`–`0x1A9xxxx` for the paths, `0x1A47Dxx`–`0x1A47Fxx` for the CLI/config keys, `0x205xxxx`–`0x207xxxx` for the class names) |
| `URI_*` context names, `production` / `preprod` / `submission`, the health-check and status keys | The same binary, blocks around `0x1A87xxx`–`0x1A8Axxx` and `0x18F5xxx` |
| The script-side surface of §6, `GetErrorCode`'s strings, the `EBackendError` and `EServerType` enums | `scripts/GameLib/generated/online/BackendApi.c` via arexplorer **1.7.0.54**, plus the BI wiki and the published BI API member pages; `EServerType.c` and `BackendDebugApi.c` were also extracted from the **installed** `addons/core/data.pak` |
| The dedicated-server lifecycle of §4, the retry interval, the `ENV:[invalid]` lines, the `JsonApi Array` warnings, and the behaviour of `-backendLog` | A dedicated server **1.8.0.13** run for this pass: non-public config, `-profile` in an empty directory under `out/backend-probe`, `-logFS`, `-backendLog`, 45 s of uptime; plus five shorter runs for `-backendEnv` and three for `-backendLog` |
| `ownerToken.bin` as a JWT, its claims, and the `dedicatedServers/createOwnerToken` attribution | [Profile](ArmaReforger_Profile_EN.md) §3, and the five token files it lists |
| The inbound ports a hoster must open | [`ServerConfig`](ArmaReforger_ServerConfig_EN.md) §5.1 and [`RCON`](ArmaReforger_RCON_EN.md) §1 |
| `-noBackend` destroying the game instance, the ban list living in the backend, the career record being a backend object | [Profile](ArmaReforger_Profile_EN.md) §5.6, §5.7 and §10 |
| REST API and JsonApiStruct usage from script | BI wiki, "Arma Reforger: REST API Usage" and "JsonApiStruct Usage" |
