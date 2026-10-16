# Arma Reforger backend API

The online service the game and the dedicated server talk to: what it is, which parts of it a
server uses, the endpoints its own binary names, the tokens and identities involved, and what
could not be established.

**Build verified on:** Arma Reforger **1.8.0.13** (engine 192142) — the installed build, newer
than this repository's 1.6.0.119 pin ([data/build.json](../../data/build.json)). The endpoint,
operation and field names in §3, §4 and §7 are read from the strings and RTTI symbols of
`ArmaReforgerServer.exe` **1.8.0.13**; the script-side classes in §6 are from arexplorer
**1.7.0.54** and the published BI API member pages, so §6 describes a build older than the rest.
**A dedicated server's own registration was captured on the wire** (§3.0) — the calls, the URLs,
the headers and the bodies in §3.0, §4 and §5 are observations, and everything else in §3 is a
list of strings in the binary. §9 says exactly which is which.

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

- **The addresses are resolved at runtime, not read from the binary.** No host name for the game
  service appears anywhere in `ArmaReforgerServer.exe`; what the server does when it cannot
  resolve one is in §8 and §9 (`[RestApi] Context Request - Empty URL provided!`,
  `ENV:[invalid]`). **The three hosts it actually dials were captured on the wire** (§3.0):
  `api-ar-gc.bistudio.com`, `api-ar-game.bistudio.com` and `reforger.armaplatform.com`, and with
  the environment resolved the log line reads `ENV:[production]`.
- **Each endpoint path is relative to its context and carries an API prefix.** A captured S2S
  call is `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/rooms/register` —
  host, `game-api`, `s2s-api/v1.0`, then the path string from §3.1/§3.2. The client-side prefix
  in the same family is `api/v1.0` (`/game-api/api/v1.0/world`), and the game config lives under
  its own host and prefix (`/game-config/api/v1/reforger/1.8.0/13/list`). **Which prefix each of
  the remaining contexts uses was not captured** (§9).

Two method families exist for several services and are not interchangeable: **client** methods
(`ClientLobbyApi`, `GetPingSites`, `RoomsJoin`) and **S2S** — server-to-server — methods
(`LobbyApiS2S`, `RoomsRegisterS2S`, `CharacterUpdateS2S`). Only a server can call the S2S ones,
and the distinction is visible in the operation names below.

---

## 3. The endpoints the binary names

Every string in the left column is a literal in `ArmaReforgerServer.exe` **1.8.0.13**. The right
column is the class or operation name found beside it. For most of them **the HTTP method, the
full URL and the bodies are unknown** — what is known is that these paths exist and which
operation carries them. The handful that were seen on the wire are listed first, and they are the
only ones in this document that are observations rather than strings.

### 3.0 Observed on the wire

A dedicated server **1.8.0.13** was run with a fresh profile and a non-public config behind a
TLS-terminating proxy, and its whole exchange with the backend was recorded (`out/mitm-capture.jsonl`
in the probe workspace). Five calls, in this order, are the entire conversation this server had
before it was registered:

| # | Call | Answer |
|---|---|---|
| 1 | `GET https://api-ar-gc.bistudio.com/game-config/api/v1/reforger/1.8.0/13/list` | `200`, 4668 B — the online game config (`name`, `version`, `env`, `overview`, `properties`, `services`, `createdAt`) |
| 2 | `GET https://api-ar-game.bistudio.com/game-api/api/v1.0/world?platformId=ReforgerSteam&clientVersion=1.8.0` | `200`, 401 B — `version`, `gameData` |
| 3 | `GET https://reforger.armaplatform.com/api/popup?loc=en_us` | `200`, 12 B — `items` |
| 4 | `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` | `200`, 959 B — `dsConfig`, **`ownerToken`** |
| 5 | `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/rooms/register` | `200`, 705 B — `roomId`, `mpRoom` |

The two POSTs are chunked and carry `Expect: 100-continue`; both are `application/json` and carry
the headers

```text
x-client-id: $edb1b7862bba5cade1f6e06bfdeac2c
x-client-secret: <32 characters>
user-agent: Arma Reforger/1.8.0.13 (Headless; Windows)
```

and the answers come from Cloudflare with `x-signature-validation-result: true`,
`cache-control: no-cache, no-store` and a `x-bi-rid` cookie. What the two bodies contain is in
§4; the token in call 4 is the subject of [Profile §3](ArmaReforger_Profile_EN.md).

**Note what is missing.** The dedicated server never called anything under `servers/*`
(`servers/createToken`, `servers/auth`, `servers/heartbeat`) in this run, nor
`dedicatedServers/createOwnerToken`, nor `server-configs/*`. Those paths are in the binary — the
sections below are still a list of what exists — but a community dedicated server's registration
went through the **lobby S2S** family instead, with the owner token as its credential.

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

**The dedicated server gets its owner token from its own registration call — `registerUnmanagedServer`,
not `createOwnerToken`.** Both paths are in the binary:

| Path | Operation | What is known |
|---|---|---|
| `dedicatedServers/registerUnmanagedServer` | `DSUnmanagedRegisterS2S`, `LobbyApiDSUnmanagedRegS2S` | **Called by the server, captured.** The `200` answer carries `{"dsConfig":{…},"ownerToken":"…"}`; the server writes the `ownerToken` member to `$profile:ownerToken.bin` and replays it as `accessToken` on `rooms/register` |
| `dedicatedServers/createOwnerToken` | `LobbyApiCreateServerOwnerToken`, `CreateServerOwnerToken` | **Never called in any captured dedicated-server run.** The request and response classes exist (`LobbyApiResponseCreateServerOwnerToken`), so something does call it — the game client's own token, which carries `ownerType: GameIdentity` and an `ownerId`, is the likely product. **Not established** |

The token is also the field `ownerToken` of the server configuration object the server exchanges
with the backend (`OwnerTokenExpand@ServerConfiguration`, beside the keys `serverId` and
`ownerType`), which is the object behind the `server-configs/*` group. The file, its claims and
the captured exchange are in [Profile §3](ArmaReforger_Profile_EN.md).

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

**Observed end to end** on the captured run; the log lines in the last column are from the same
run unless marked otherwise.

| Step | What happens | Seen in the log or on the wire |
|---|---|---|
| 1 | The config is read and validated locally, then the server asks for its online game config | `Loading dedicated server config.` → `Server config loaded.` → `JSON Schema Validation:` → `JSON is Valid` → `Attempting online Game Config instead.` |
| 2 | `GET …/game-config/api/v1/reforger/1.8.0/13/list` — the first call. It is retried about every 6 s while it fails, and `ENV:[invalid]` in the retry line is what a server that cannot resolve the environment prints | `[RestApi] ID:[1] TYPE:[GameConfig/List] ENV:[invalid] Error - Cannot send request` (failed run); the same call answers `200` when it gets through |
| 3 | `GET …/game-api/api/v1.0/world` and `GET https://reforger.armaplatform.com/api/popup` — what the game needs before hosting | — |
| 4 | `POST …/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` with the server's own configuration, `x-client-id` and `x-client-secret` — and the answer carries the **owner token**, which is written to the profile | request body (abridged): `{"clientVersion":"1.8.0","platformId":"ReforgerSteam","platformName":"Windows","region":"","gameVersion":"1.8.0.13","scenarioId":"{ECC61978EDCC2B5A}Missions/23_Campaign.conf","name":"…","playerCountLimit":8,"visible":false,"supportedGameClientTypes":["PLATFORM_PC"],"mods":[]}` |
| 5 | `POST …/s2s-api/v1.0/lobby/rooms/register` with `dedicatedHostId`, the owner token **as `accessToken`**, the scenario, the address the backend hands to clients, and the whole room configuration | request body (abridged): `{"dedicatedHostId":"8b6aca5a-…","accessToken":"<the owner token>","sessionId":"3fddf207-0000d9019b9c","scenarioId":"{ECC61978EDCC2B5A}Missions/23_Campaign.conf","scenarioName":"#AR-Campaign_ScenarioName_Everon","hostAddress":"127.0.0.1:2005","dedicated":true,"invisible":true,"joinable":true,"playerCountLimit":8,"joinQueueMaxSize":0,"battlEye":false,"rplTimeoutS":10.0,"password":"…","admins":[],"supportedGameClientTypes":["PLATFORM_PC"],"mods":[]}` |
| 6 | The room answer becomes the registration | `{"roomId":"d53ef442-…","mpRoom":{"hostType":"CommunityDs","hostAddress":"127.0.0.1:2005","directJoinCode":"0197881396","pingSiteId":"unknown", …}}` → `Server registered with address: 127.0.0.1:2005`, `Direct Join Code: 0197881396`, `Ping Site: unknown` |
| 7 | Heartbeats continue for the life of the session, and the server reports stats. **Neither was captured**: the run was stopped 45 s in, and no heartbeat had been sent yet | `DS Heartbeat Stats: FPS: %.1f, frame time (avg: %.1f, min: %.1f, max: %.1f)` (string; the line appears on longer runs) |
| 8 | Players join and leave through the lobby (`servers/join` / `rooms/acceptPlayer` / `rooms/removePlayer`), carrying the player's profile and game data | — |
| 9 | Bans, when the crime system escalates, and the admin's own `#ban` (`rooms/createBan`, `rooms/recordBanEvent`) | — |
| 10 | At shutdown the room is removed | `rooms/remove` / `servers/remove` (strings) |

Three things in that sequence are worth naming:

- **`providerServerId` is the token's `serverId`.** The registration answer returns
  `dsConfig.providerServerId`, and the token minted alongside it carries exactly that value; the
  same value comes back as `roomId`. The `dedicatedServerId` of the same answer is what the next
  call sends as `dedicatedHostId`.
- **The server sends its own fields the config schema will not accept.** `playerCountLimit` and
  `supportedGameClientTypes` are rejected by `server.json` ([ServerConfig §5.1](ArmaReforger_ServerConfig_EN.md))
  yet appear in both bodies — the server builds them itself.
- **The room body carries the server password in clear.** `"password":"…"` is in the captured
  `rooms/register` request; it is the game password from `game.password`, sent to the backend
  as-is. Nothing in this document should be logged or pasted anywhere with those bodies intact.

---

## 5. Tokens, identities and what may be published

| Thing | What it is | Lifetime |
|---|---|---|
| **`ownerToken.bin`** | A signed JWT (`RS512`) naming the server and its owner. **Its signature can only come from the backend.** The dedicated server receives it in the answer to its registration call and then re-sends the same string as the lobby's `accessToken` | Permanent; written once per profile ([Profile §3](ArmaReforger_Profile_EN.md)) |
| **`x-client-id` / `x-client-secret`** | The pair every captured call carried: `x-client-id: $edb1b7862bba5cade1f6e06bfdeac2c` and a 32-character secret. They are the game's own client credentials, the same on every server, and they are what the backend uses to recognise a legitimate client before any account exists | Static, shipped with the build |
| **`serverToken` / `serverAccessToken`** | The API session credential named by the `servers/createToken` operation and its fields (`expireIn`, `persistent`), refreshed by `servers/auth/refresh`. **Not used by the community dedicated server that was captured** — its session credential was the owner token — so this family belongs to the hosted/official path | Short, refreshed |
| **Platform identities** | `steamId`, `xboxIdHash`, `psnIdHash`, `platformIdentities`, `currentDeviceType` — a hashed platform id, not a raw Xbox/PSN id. `platformId: ReforgerSteam` is what the captured requests sent | Per player |
| **Game Identity** | The backend's per-platform identity for a player, linkable to one Bohemia account; `ownerId` in the client's owner token is one ([Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity)) | Permanent |

> **None of these belong in a log, a screenshot, an issue report or a profile archive.**
> `ownerToken.bin` and the `.backend/` log directory are the two things in a server profile to look
> at before handing it to anyone — and one captured request body also carries the server's game
> password in clear (§4).

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
| `-backendEnv <value>` | Accepted and echoed in `CLI Params:`. **Outside the sandbox, with `preprod` the server dialled the same three hosts and registered normally**, so it does not redirect to another address. The `ENV:[…]` field is printed **only on failures**, so it cannot be read from a successful run; a failing run with no such parameter prints `ENV:[production]`. **What, if anything, the parameter changes was not established** |
| `-backendDS`, `-backendFreshSession`, `-backendLocalStorage`, `-backendDisableStorage`, `-backendOnlineStorage`, `-autotest`, `-userName` | Strings in the same block of the binary (around `0x1A47E0xx`), beside `config`, `gameConfig`, `bindIP`, `bindPort`, `a2sPort`, `rconPort`, `a2sIpAddress`, `rconIpAdress`, `rconPassword`, `addonTempDir`, `addonsVerify`, `steelShieldEnable`, `agones`. **Not tried** |

The environment names the binary carries are `production`, `preprod` and `submission` (in two
casing variants); the resting value in a failure line is `ENV:[production]`, and `ENV:[invalid]`
is what a server that cannot resolve the environment at all prints.

---

## 8. Reading the log when the backend is unhappy

The server says a lot about its own API traffic, in `console.log` and `error.log`.

| Line | What it means |
|---|---|
| `[RestApi] ID:[n] TYPE:[<Op>] ENV:[<env>] Error - Cannot send request` | The request was never sent. **Look one line up for the reason.** The `ENV` field is filled in only when the environment resolved, so `ENV:[production]` here is the healthiest possible form of this line and `ENV:[invalid]` means the environment itself is broken |
| `Curl error=<text>` | The transport failed. `SSL peer certificate or SSH remote key was not OK` is a TLS verification failure — a bad clock, a proxy, or a machine where the process cannot reach the certificate store (a sandbox, for instance) |
| `Http Error (BAD_REQUEST)`, `Http Error (TIMEOUT)` | The request never produced a usable answer |
| `[RestApi] Context Request - Empty URL provided!` | The context had no address to send to; this is the shape a completely unresolvable environment takes |
| `[RestApi] ID:[%d] TYPE:[LobbyApiS2S/DSUnmanagedRegisterS2S] ENV:[production] Timeout` | A real operation name from a real failure: the registration call above, with the environment resolved and no answer in time |
| `[RestApi] Context Count=%d`, `[RestApi] Context Request "%s" - Failed!` | Context bookkeeping |
| `[RestApi] ID:[%d] (Response << SUCCESS)`, `[RestApi] ID:[%d] (%s) size=%d, age=%d ms :: <body>` | A successful answer, with its size and age |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Error Code:%d - %s, apiCode="%s", uid="%s", message="%s"` | A structured service error: HTTP code, message, the API's own code and the uid involved |
| `[RestApi] ID:[%d] TYPE:[%s] ENV:[%s] Timeout` | No answer in time |
| `curl: (35) schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK` | Not a line this server writes, but the one to recognise when *you* put something between the server and the backend: Windows refuses a certificate it cannot revocation-check |
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

- **The capture covers one server and one flow.** Five calls, listed in §3.0, from a community
  dedicated server 1.8.0.13 that registered and then was stopped after 45 s. Everything else in
  §3 — the whole Workshop, storage, groups, notifications, the `servers/*` and `server-configs/*`
  families, the ban service — is still a list of **strings in the binary**, with no method, no URL
  and no shape behind it.
- **The context-to-prefix mapping is only known where it was seen.** `/game-api/api/v1.0`,
  `/game-api/s2s-api/v1.0`, `/game-config/api/v1/reforger/<version>/<build>/list` and
  `reforger.armaplatform.com/api` are observed. Which prefix the Workshop, storage, group or
  notification contexts use, and which host serves them, was **not** observed.
- **The base URL is still not a literal in the binary.** The `URI_*` names have no addresses next
  to them, and no host name for the game service appears anywhere in `ArmaReforgerServer.exe`;
  the only URLs in the executable are the crash reporter's (`cs-public.bistudio.com`,
  `cs-inter.bistudio.com`) and `www.bohemia.net`. The three hosts above come from the network, not
  from the file.
- **Heartbeat, player join, ban and shutdown calls were not captured.** The run was too short for
  a heartbeat, and nobody joined it.
- **What `-backendEnv` changes was not established** (§7): with `preprod` the hosts were identical,
  and the `ENV:[…]` field is only printed when something fails.
- **Which endpoint issues the *client's* owner token was not established.** Its token has
  `ownerType: GameIdentity` and an `ownerId`; the dedicated server's route is settled (§3.3), and
  `dedicatedServers/createOwnerToken` was never called in any captured run.
- **The relationship between the root-level `serverId` and `ownerType` in `server.json` and the
  claims of the same name in the owner token** was not verified. Both names exist in the config
  schema and both are filled in by the backend; the captured registration answer shows the server
  *receiving* a `providerServerId`/`dedicatedServerId` pair, but not what it writes back into its
  own config.
- **Whether a mod may call the S2S endpoints**, and what happens if it tries, was not tested.
- **Rate limits, retry policy, the auth scheme's details and the meaning of `x-client-secret`**
  are not in this document. The only timing observed is the ~6 s retry on the game config call
  while it fails.
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
| §3.0, §4 and §5 — the five calls, their URLs, methods, headers and bodies, the `ownerToken` in the registration answer, the same JWT replayed as `accessToken`, the room answer with `directJoinCode`/`pingSiteId`/`hostType`, and the plaintext `password` in the room body | A dedicated server **1.8.0.13** run through a TLS-terminating proxy on this machine: fresh profile, non-public config, captured to `out/mitm-capture.jsonl`; that run reached `Server registered with address: 127.0.0.1:2005` |
| §2, §7 and §8 — the three hosts, `ENV:[production]` as the resting value, and the `ENV:[…]` field appearing only on failures | The same capture for the hosts; the failing and successful runs of the same pass for the `ENV` field, including two runs with `-backendEnv preprod` (same hosts, registered) and `submission` (stopped while still loading the world) |
| Every path, operation name, JSON field name and class-name fragment quoted in §3, §4, §5 and §7 | Strings and RTTI symbols of `ArmaReforgerServer.exe` **1.8.0.13** (blocks around `0x1A8xxxx`–`0x1A9xxxx` for the paths, `0x1A47Dxx`–`0x1A47Fxx` for the CLI/config keys, `0x205xxxx`–`0x207xxxx` for the class names) |
| `URI_*` context names, `production` / `preprod` / `submission`, the health-check and status keys | The same binary, blocks around `0x1A87xxx`–`0x1A8Axxx` and `0x18F5xxx` |
| The script-side surface of §6, `GetErrorCode`'s strings, the `EBackendError` and `EServerType` enums | `scripts/GameLib/generated/online/BackendApi.c` via arexplorer **1.7.0.54**, plus the BI wiki and the published BI API member pages; `EServerType.c` and `BackendDebugApi.c` were also extracted from the **installed** `addons/core/data.pak` |
| The retry interval, the `JsonApi Array` warnings, and the behaviour of `-backendLog` | Dedicated server **1.8.0.13** runs for this pass: `-profile` in an empty directory, `-logFS`, `-backendLog` with several values, 45 s and 22 s uptimes |
| `ownerToken.bin` as a JWT and its claims | [Profile](ArmaReforger_Profile_EN.md) §3, and the token files it lists |
| The inbound ports a hoster must open | [`ServerConfig`](ArmaReforger_ServerConfig_EN.md) §5.1 and [`RCON`](ArmaReforger_RCON_EN.md) §1 |
| `-noBackend` destroying the game instance, the ban list living in the backend, the career record being a backend object | [Profile](ArmaReforger_Profile_EN.md) §5.6, §5.7 and §10 |
| REST API and JsonApiStruct usage from script | BI wiki, "Arma Reforger: REST API Usage" and "JsonApiStruct Usage" |
