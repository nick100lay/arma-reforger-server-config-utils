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

**The machine-readable form of this section lives in
[schemas/backend-api/](../../schemas/backend-api/README.md)**: one JSON Schema per observed
endpoint, the shared value definitions (`scenarioId`, `modId`, `hostAddress`, the token and page
shapes), and the captured bodies as examples that `npm run check:backend-schemas` validates — and
keeps rejecting — on every run. Where the two disagree, the schema is the one that is checked.

Every string in the left column is a literal in `ArmaReforgerServer.exe` **1.8.0.13**. The right
column is the class or operation name found beside it. For most of them **the HTTP method, the
full URL and the bodies are unknown** — what is known is that these paths exist and which
operation carries them. The handful that were seen on the wire are listed first, and they are the
only ones in this document that are observations rather than strings.

### 3.0 Observed on the wire

Two dedicated server **1.8.0.13** runs, each with a fresh profile and a non-public config, behind a
TLS-terminating proxy: one plain (3.5 minutes, a ban issued and lifted over RCON, then a clean
shutdown) and one with a single Workshop mod in the config. Everything below was recorded
(`out/mitm-capture*.jsonl` in the probe workspace).

**Before registration — five calls:**

| # | Call | Answer |
|---|---|---|
| 1 | `GET https://api-ar-gc.bistudio.com/game-config/api/v1/reforger/1.8.0/13/list` | `200`, 4668 B — the online game config (`name`, `version`, `env`, `overview`, `properties`, `services`, `createdAt`) |
| 2 | `GET https://api-ar-game.bistudio.com/game-api/api/v1.0/world?platformId=ReforgerSteam&clientVersion=1.8.0` | `200`, 401 B — `version`, `gameData` |
| 3 | `GET https://reforger.armaplatform.com/api/popup?loc=en_us` | `200`, 12 B — `items` |
| 4 | `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` | `200`, 959 B — `dsConfig`, **`ownerToken`** |
| 5 | `POST https://api-ar-game.bistudio.com/game-api/s2s-api/v1.0/lobby/rooms/register` | `200`, 705 B — `roomId`, `mpRoom` |

**While running** — the plain run, in order:

| When | Call | Answer |
|---|---|---|
| 61 s after registration, and again 61 s later | `POST …/lobby/dedicatedServers/heartBeat` | `200`, 67 B |
| on `#ban create` over RCON | `POST …/lobby/rooms/createBan` | `200`, `{"status":"OK"}` |
| on `#ban list 1` | `POST …/lobby/rooms/listActiveBans` | `200`, 428 B — the ban list itself |
| on `#ban remove` | `POST …/lobby/rooms/removeBans` | `200`, `{"status":"OK"}` |
| on `shutdown` over RCON | `POST …/lobby/rooms/remove` | `200`, `{"status":"OK"}` |

**While a player is connected** — the third run, a real player joining from the same machine:

| When | Call | Answer |
|---|---|---|
| on join | `POST …/lobby/rooms/acceptPlayer` | `200`, 979 B — the player's profile, **his `platformIdentities` (`biAccountId`, `steamId`)**, and `character.data`, a JSON string holding the whole `m_aStats` array |
| on leaving | `POST …/lobby/rooms/removePlayer` | `200` — `{"status":"OK","expireAt":…}` |
| just before both | `GET https://api-ar-game.bistudio.com/game-api/api/v1.0/dummy` | `200`, body `{}`, **no credential of any kind** — a liveness check |
| every minute | `POST …/lobby/dedicatedServers/heartBeat` | now carrying `"players":[{"identity":"0ac6169c-…"}]` |

**The career record was never written back** — not on a 120 s timer while the player played for
seven minutes, not when he left, not on a clean server shutdown and not on `#restart` (four
scenarios, one after another). The reason is in the game code rather than in the capture:
`SCR_PlayerProfileManagerComponent.OnPlayerDisconnected` calls `StoreProfile(playerId, true)`,
which ends in `PlayerCharacterUpdateS2S`, but `LoadPlayerProfileFromBackend()` creates the profile
object it needs **only when `GetBackendApi().GetDSSession().Status() == EDSESSION_ACTIVE`**, and
`StoreProfile` returns on its first line without one. A community server never brings that session
up — it has the owner token and the lobby S2S family instead (§4) — so the write path stays
dormant, while the career itself arrives read-only in the `acceptPlayer` answer.

**Downloading a mod** — the second run, before its own registration:

| Call | Answer |
|---|---|
| `POST https://api-ar-workshop.bistudio.com/workshop-api/api/v3.0/s2s/assets/download-list` | `200`, 1519 B — the asset, its `version`/`gameVersion`, and its three files (`data.pak`, `resourceDatabase.rdb`, `addon.gproj`), each with a `manifestPath` |
| `GET https://ar-gcp-cdn.bistudio.com/manifest/<2 hex>/<2 hex>/<sha512>/<size>` | one per file (`200`, 120–2747 B) |
| `GET https://ar-gcp-cdn.bistudio.com/fragment/<2 hex>/<2 hex>/<sha512>/<size>` | one per fragment — about twenty of them for a 16 KB addon — until `Required addons are ready to use.` |

**The shape is the same in every S2S call above.** Each request carries the owner token as
`accessToken`, plus `dedicatedServerId`, `roomId`, `clientVersion` and `platformId`: the same
credentials and identifiers, on the same host, under `game-api/s2s-api/v1.0/lobby/`. The CDN and
the game-config host are the exceptions — they answer on paths that identify the content and carry
no such body.

The two registration POSTs are chunked and carry `Expect: 100-continue`; they and every S2S POST are
`application/json` with the headers

```text
x-client-id: $edb1b7862bba5cade1f6e06bfdeac2c
x-client-secret: <32 characters>
user-agent: Arma Reforger/1.8.0.13 (Headless; Windows)
```

and the answers come from Cloudflare with `x-signature-validation-result: true`,
`cache-control: no-cache, no-store` and a `x-bi-rid` cookie. What the bodies contain is in §3.5
and §4; the token in call 4 is the subject of [Profile §3](ArmaReforger_Profile_EN.md).

**Note what is missing.** The dedicated server never called anything under `servers/*`
(`servers/createToken`, `servers/auth`, `servers/heartbeat`), nor `dedicatedServers/createOwnerToken`,
nor `server-configs/*`, nor anything in storage, groups or notifications, nor `rooms/joinQueue/*`
(whatever queue a joining client saw is its own traffic — the game client was not behind the
proxy). Those paths are in the binary, and the sections below are still a list of what exists;
but a community dedicated server's whole life went through the **lobby S2S** family and the
Workshop, with the owner token as its credential.

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
| `rooms/acceptPlayer` — `userProfile`, `userGameData`, `platformIdentities`, `steamId`, `xboxIdHash`, `psnIdHash`, `currencies`, `overallPlayTime` | `LobbyApiRoomsAcceptPlayerS2S` — **captured**; the request carries `sessionTicket` (512 characters) and the answer carries `userProfile`, `platformIdentities` and `character.data` (§3.0) |
| `rooms/removePlayer` | `LobbyApiRoomsRemovePlayerS2S` — **captured**; `userId`, `expireIn: 4995` and `removeEvent:{"group":1,"reason":9}` |
| `rooms/search`, `rooms/getRoomsByIds`, `rooms/listPlayers` | `LobbyApiRoomsSearch`, `RoomsGetByIds`, `RoomListPlayers` |
| `rooms/join`, `rooms/verifyPassword`, `rooms/joinQueue/poll`, `rooms/joinQueue/leave` | `RoomsJoin`, `LobbyApiVerifyPassword`, `QueuePoll`, `QueueLeave` — **client-side**, not called by the server |
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

**All three ban calls were captured**, each as `POST …/game-api/s2s-api/v1.0/lobby/<path>` with the
owner token as `accessToken`, `dedicatedServerId` and `roomId` in the body:

| Path | Operation | Captured request and answer |
|---|---|---|
| `rooms/createBan` | `CreateBanS2S` | `{"…","userId":"0ac6169c-…","reason":"backend-probe","banDuration":600}` → `{"status":"OK"}` |
| `rooms/listActiveBans` | `ListActiveBansS2S` | `{"…","page":{"limit":25,"offset":0}}` → `{"status":"OK","activeBans":{"entries":[…],"totalCount":1,"page":{…}}}` |
| `rooms/removeBans` | `RemoveBansS2S` | `{"…","userIds":["0ac6169c-…"]}` → `{"status":"OK"}` |

A real record from the list, with the token and the ids as they came back:

```text
{"id":2430040,"targetType":"gid","targetId":"0ac6169c-…","targetName":"kolya_500",
 "currentName":"kolya_500","scope":"reforger:86d1f436-…:join","type":"gameServer",
 "reason":"backend-probe","issuer":"room 86d1f436-…",
 "createdAt":1792160229,"expiresAt":1792160832}
```

That is the server-side object the `OnlineBanListData` class in the engine expands: the target is a
game identity (`targetType: "gid"`), the **scope pins the ban to one room**
(`reforger:<roomId>:join`), the issuer is that room, and the duration is `expiresAt - createdAt`
(600 s for the requested `banDuration: 600`). `page.limit` is 25, which is why RCON shows the list
25 entries at a time ([`RCON`](ArmaReforger_RCON_EN.md) §4.4). The rest of the section is still
binary strings:

| Path | Operation |
|---|---|
| `rooms/recordBanEvent` — `eventKey`, `currentValue`, `triggerValue`, `triggered` | `RecordBanEventS2S` |
| `rooms/reportPlayer` — `reporterId` | `ReportPlayerS2S` |
| `bans/listActive`, `blockList/listBlocked`, `feedback/create` | `GameApiListActiveBans`, `GameApiListBlockedUsers` |

The engine-side classes are `BanServiceApi` and `BlockListApi`. Where the ban list lives, and what an
admin ban does, is in [`RCON`](ArmaReforger_RCON_EN.md) §4.4 and
[Profile](ArmaReforger_Profile_EN.md) §5.7.

### 3.6 The rest of the surface, in one table

| Service (context) | Paths and operations |
|---|---|
| **Storage** `URI_StorageApi` | `s2s/files/`, `s2s/files/<uuid>`, `/temp-url`, `s2s/upload/` — `GetFile`, `GetFileS2S`, `GetFileTempURL(S2S)`, `Upload(S2S)`, `PatchFileS2S`, `DeleteFileS2S`, `ReuploadS2S`; the fields `spaceId`, `usedCapacity`, `userSpace`, `mimetype` |
| **Workshop** `URI_WorkshopApi`, `URI_ContentApi`, `URI_WorkshopApi_Backup1` | **Captured:** `POST https://api-ar-workshop.bistudio.com/workshop-api/api/v3.0/s2s/assets/download-list` with `{"assets":{"<modId>":null}}`, answering the asset's version, `gameVersion`, files and a `manifestPath` for each. **Then `https://ar-gcp-cdn.bistudio.com`** serves the content itself: `GET /manifest/<2 hex>/<2 hex>/<sha512>/<size>` per file and `GET /fragment/<2 hex>/<2 hex>/<sha512>/<size>` per fragment. The rest is binary strings: `assets/list`, `assets/check-user-assets`, `assets/download-list`, `assets/<id>/dependencies`, `/versions/`, `/ratings/@me`, `/reports`, `/subscriptions`, `/favorites`, `assets/difference/size`, `assets/upload/create`, `assets/upload/<id>/files`, `/files/chunk`, `/files/commit`, `/process`, `/cancel`, `s2s/assets/download-list`, `v4/asset/upload/config`, `v4/asset/upload/getDetails`, `v4/asset/download/resolveVersionList`, `v4/asset/download/listFull`, `v4/asset/download/listPartial`, `v4/asset/stats/countDownloads`, `v4/asset/list`, `v4/asset/getListRemainder`, `v4/asset/getDetails`, `v4/asset/revision/*`, `v4/asset/addRating`, `v4/asset/addSubscriptions`, `v4/asset/addBlocks`, `v4/asset/report`, `v4/comment/list`, `v4/comment/create`, `v4/comment/addReaction`, `v4/comment/delete`, `v4/profile/listInteractions`, `contributor/invitations`, `auth/delegationTokens`. Note the version split: the binary's paths say `v4`, the call a dedicated server makes is `v3.0` |
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

**Observed end to end** on the two captured runs; the log lines in the last column are from the same
run unless marked otherwise.

| Step | What happens | Seen in the log or on the wire |
|---|---|---|
| 1 | The config is read and validated locally, then the server asks for its online game config | `Loading dedicated server config.` → `Server config loaded.` → `JSON Schema Validation:` → `JSON is Valid` → `Attempting online Game Config instead.` |
| 2 | `GET …/game-config/api/v1/reforger/1.8.0/13/list` — the first call. It is retried about every 6 s while it fails, and `ENV:[invalid]` in the retry line is what a server that cannot resolve the environment prints | `[RestApi] ID:[1] TYPE:[GameConfig/List] ENV:[invalid] Error - Cannot send request` (failed run); the same call answers `200` when it gets through |
| 3 | `GET …/game-api/api/v1.0/world` and `GET https://reforger.armaplatform.com/api/popup` — what the game needs before hosting | — |
| 4 | `POST …/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` with the server's own configuration, `x-client-id` and `x-client-secret` — and the answer carries the **owner token**, which is written to the profile | request body (abridged): `{"clientVersion":"1.8.0","platformId":"ReforgerSteam","platformName":"Windows","region":"","gameVersion":"1.8.0.13","scenarioId":"{ECC61978EDCC2B5A}Missions/23_Campaign.conf","name":"…","playerCountLimit":8,"visible":false,"supportedGameClientTypes":["PLATFORM_PC"],"mods":[]}` |
| 5 | `POST …/s2s-api/v1.0/lobby/rooms/register` with `dedicatedHostId`, the owner token **as `accessToken`**, the scenario, the address the backend hands to clients, and the whole room configuration | request body (abridged): `{"dedicatedHostId":"8b6aca5a-…","accessToken":"<the owner token>","sessionId":"3fddf207-0000d9019b9c","scenarioId":"{ECC61978EDCC2B5A}Missions/23_Campaign.conf","scenarioName":"#AR-Campaign_ScenarioName_Everon","hostAddress":"127.0.0.1:2005","dedicated":true,"invisible":true,"joinable":true,"playerCountLimit":8,"joinQueueMaxSize":0,"battlEye":false,"rplTimeoutS":10.0,"password":"…","admins":[],"supportedGameClientTypes":["PLATFORM_PC"],"mods":[]}` |
| 6 | The room answer becomes the registration | `{"roomId":"d53ef442-…","mpRoom":{"hostType":"CommunityDs","hostAddress":"127.0.0.1:2005","directJoinCode":"0197881396","pingSiteId":"unknown", …}}` → `Server registered with address: 127.0.0.1:2005`, `Direct Join Code: 0197881396`, `Ping Site: unknown` |
| 7 | `POST …/lobby/dedicatedServers/heartBeat` **once a minute** for the life of the session, carrying the room's id, `state: "HostingGame"`, the current player list and a stats block | request: `{"accessToken":"<owner token>","clientVersion":"1.8.0","platformId":"ReforgerSteam","id":"<dedicatedServerId>","state":"HostingGame","stats":{"frameTime":{"@type":"aggregation","avg":0.78,"min":0.59,"max":448.7},"memory":{"@type":"single","value":1001833.0},"memory2":{"@type":"single","value":2149996.0},"ai_chars_active":{"@type":"single","value":0.0}},"players":[]}` → `{"currentWorldVersion":"BanSettings","gameEvents":[],"status":"OK"}`; the log line is `DS Heartbeat Stats: FPS: … frame time (avg: …, min: …, max: …)`. Measured 61 s after registration and 61 s later |
| 8 | A player joins and leaves through the lobby: `rooms/acceptPlayer` with a `sessionTicket`, then `rooms/removePlayer` with the departure reason. The answer to the first is everything the server learns about him — profile, currencies, play time, **the account links** and the career record | `Authenticated player: rplIdentity=0x00000000 identityId=0ac6169c-… name=kolya_500`, `Player connected: connectionID=0`, `### Updating player: PlayerId=1, …, IdentityId=0ac6169c-…`, `Players connected: 1 / 1`; the answer's `character.data` is `{"m_aStats":[ … 39 values … ]}` |
| 9 | Bans: the admin's `#ban` goes to `rooms/createBan` / `rooms/listActiveBans` / `rooms/removeBans` (§3.5), and the crime system's own escalation to `rooms/recordBanEvent` | `Player '<id>' banned!`, `Ban removed!` and the 25-per-page table in the RCON client |
| 10 | At shutdown the room is removed | `POST …/lobby/rooms/remove` → `{"status":"OK"}` |

Four things in that sequence are worth naming:

- **`providerServerId` is the token's `serverId`.** The registration answer returns
  `dsConfig.providerServerId`, and the token minted alongside it carries exactly that value; the
  same value comes back as `roomId`. The `dedicatedServerId` of the same answer is what every later
  call sends, both as `dedicatedHostId` in `rooms/register` and as `id` in the heartbeat.
- **The server sends its own fields the config schema will not accept.** `playerCountLimit` and
  `supportedGameClientTypes` are rejected by `server.json` ([ServerConfig §5.1](ArmaReforger_ServerConfig_EN.md))
  yet appear in both registration bodies — the server builds them itself.
- **The room body carries the server password in clear.** `"password":"…"` is in the captured
  `rooms/register` request; it is the game password from `game.password`, sent to the backend
  as-is. Nothing in this document should be logged or pasted anywhere with those bodies intact.
  **The field is absent when no password is set**, and that same request carries
  `"autoJoinable":true` instead — the captures show either a password with no `autoJoinable`, or
  no password with it. The rule behind the pair was not established, and the answer echoes the
  flag back as `dsConfig.game.autoJoinable`.
- **A configured mod is downloaded before registration, not after.** The second run fetched its
  addon through the Workshop S2S API and the CDN, and only then registered. The addon it fetched
  was built for game version 1.4.0.55, downloaded without complaint, and then failed to compile
  against 1.8.0.13 (`Can't compile "Game" script module! … Expected attribute call`) — the
  download list does not filter by compatibility, and an incompatible mod takes the whole server
  down, not just itself.
- **The career record only travels one way on a community server.** It arrives in the
  `acceptPlayer` answer and is never sent back: the write is
  `SCR_PlayerProfileManagerComponent.StoreProfile()` → `PlayerCharacterUpdateS2S`, triggered from
  `OnPlayerDisconnected`, and it needs a profile object that `LoadPlayerProfileFromBackend()`
  creates **only while `GetBackendApi().GetDSSession().Status() == EDSESSION_ACTIVE`** — a session
  the owner-token route never opens. Four triggers were tried and none produced the call: 120 s of
  play, the player leaving, a clean shutdown, and `#restart`. What a player earns on such a server
  is therefore not in the career record afterwards; whether the *client* writes something of its
  own during the session is a different path and was not observed (the client was not behind the
  proxy).

---

## 5. Tokens, identities and what may be published

| Thing | What it is | Lifetime |
|---|---|---|
| **`ownerToken.bin`** | A signed JWT (`RS512`) naming the server and its owner. **Its signature can only come from the backend.** The dedicated server receives it in the answer to its registration call and then re-sends the same string as the lobby's `accessToken` **on every later S2S call** — the heartbeat, the ban calls and the unregister all carry it | Permanent; written once per profile ([Profile §3](ArmaReforger_Profile_EN.md)) |
| **`x-client-id` / `x-client-secret`** | The pair every captured call carried: `x-client-id: $edb1b7862bba5cade1f6e06bfdeac2c` and a 32-character secret. They are the game's own client credentials, the same on every server, and they are what the backend uses to recognise a legitimate client before any account exists | Static, shipped with the build |
| **`serverToken` / `serverAccessToken`** | The API session credential named by the `servers/createToken` operation and its fields (`expireIn`, `persistent`), refreshed by `servers/auth/refresh`. **Not used by the community dedicated server that was captured** — its session credential was the owner token — so this family belongs to the hosted/official path | Short, refreshed |
| **Platform identities** | `steamId`, `xboxIdHash`, `psnIdHash`, `platformIdentities`, `currentDeviceType` — a hashed platform id, not a raw Xbox/PSN id. `platformId: ReforgerSteam` is what the captured requests sent. **Captured on a real join:** `platformIdentities` came back as `{"biAccountId":"61633507-…","steamId":"76561198964110917"}` — the player's linked Bohemia account, which is exactly the link the wiki's [Game Identity](https://community.bistudio.com/wiki/Arma_Reforger:Game_Identity) page describes | Per player |
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

- **The capture covers two servers and one real join, with the game client outside it.** The
  dedicated server's own calls are observed end to end (§3.0): registration, the game config, the
  popup, the heartbeat, the ban calls, a player joining and leaving, the mod download and the
  unregister. **The client's half is not**: the server browser, the join queue a client can be put
  into, `servers/join`, the session login and the identity endpoints all belong to the game
  process, which was deliberately left outside the proxy (with it inside, the client failed to
  initialise). The career record's **write** was never observed either, and §3.0 and §4 say why.
- **Whole services remain unobserved.** Storage, groups, notifications, the news feed, the server
  configs in the cloud, the service-status and identity endpoints, and the `servers/*` family: for
  those this document is still a list of **strings in the binary**, with no method, no URL and no
  shape. `GET /game-api/api/v1.0/dummy` is observed but unexplained beyond its name.
- **The context-to-prefix mapping is only known where it was seen.** `/game-api/api/v1.0`,
  `/game-api/s2s-api/v1.0`, `/game-config/api/v1/reforger/<version>/<build>/list`,
  `/workshop-api/api/v3.0`, `reforger.armaplatform.com/api` and the CDN's `/manifest` and
  `/fragment` are observed. Which prefix the storage, group, notification or identity contexts use,
  and which host serves them, was **not** observed.
- **The base URL is still not a literal in the binary.** The `URI_*` names have no addresses next
  to them, and no host name for the game service appears anywhere in `ArmaReforgerServer.exe`;
  the only URLs in the executable are the crash reporter's (`cs-public.bistudio.com`,
  `cs-inter.bistudio.com`) and `www.bohemia.net`. The hosts above come from the network, not from
  the file.
- **The heartbeat's timing is one sample.** 61 s after registration and 61 s after that, in one
  run; whether the interval is fixed at 60 s, whether it changes with player count, and what the
  `gameEvents` array in the answer can carry were not established. `currentWorldVersion:
  "BanSettings"` in that answer is unexplained beyond its name.
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
  are not in this document. The only timings observed are the ~6 s retry on the game config call
  while it fails, the 61 s heartbeat, and the fact that a ban expired 603 s after it was created
  for a requested 600.
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
| §3.0, §3.5, §4 and §5 — every call, URL, method, header and body quoted, the `ownerToken` in the registration answer, the same JWT as `accessToken` on every later call, the ban record as the backend returned it, the heartbeat body and its 61 s interval, the room answer with `directJoinCode`/`pingSiteId`/`hostType`, and the plaintext `password` | Three dedicated server **1.8.0.13** runs through a TLS-terminating proxy on this machine: fresh profiles, non-public configs, captured to `out/mitm-capture.jsonl`, `out/mitm-capture-A.jsonl` (3.5 min, RCON `ban create`/`ban list 1`/`ban remove`, then `shutdown`), `out/mitm-capture-B.jsonl` (one Workshop mod) and `out/mitm-capture-JOIN4.jsonl` (a player joining from the same machine, playing, leaving, then joining again before an RCON `restart`). Every run registered: `Server registered with address:` and a `Direct Join Code` |
| §3.0, §3.2, §4 and §5 — the player-facing calls: the `acceptPlayer` request (`sessionTicket`) and answer (`userProfile`, `currencies`, `overallPlayTime`, `platformIdentities` with `biAccountId` and `steamId`, `character.data` holding the 39-value `m_aStats`), `removePlayer` (`expireIn`, `removeEvent`), `dummy`, and the heartbeat's `players` array | The same joining run; the server log lines `Authenticated player:`, `Player connected:`, `### Updating player:` and `Players connected: N / M` come from its `console.log` |
| §3.0 and §4 — why the career write never happens on a community server: the trigger and the `EDSESSION_ACTIVE` guard | `scripts/Game/Campaign/SCR_PlayerProfileManagerComponent.c` (lines 87-118 and 124-146) and `scripts/Game/DataCollection/PlayerData/SCR_PlayerData.c` (lines 293-315) via arexplorer **1.7.0.54**; the negative result itself is the four captured scenarios |
| §3.6 — the Workshop download path: `workshop-api/api/v3.0/s2s/assets/download-list`, the per-file `manifestPath`, and the CDN's `/manifest` and `/fragment` requests | The second run above; the addon fetched was `6653028F468BD115` (GTG_Licences) and the log has `Addon Download started 6653028F468BD115 - GTG_Licences` → `Required addons are ready to use.` |
| §4 — that an incompatible mod takes the server down | The same run: `crash.log` with `Can't compile "Game" script module! scripts/Game/Player/Modded/SCR_PlayerController.c(1): Expected attribute call`, then `Unable to initialize the game` and `Game destroyed.` |
| §2, §7 and §8 — the hosts, `ENV:[production]` as the resting value, and the `ENV:[…]` field appearing only on failures | The same captures for the hosts; the failing and successful runs of the same pass for the `ENV` field, including two runs with `-backendEnv preprod` (same hosts, registered) and `submission` (stopped while still loading the world) |
| Every path, operation name, JSON field name and class-name fragment quoted in §3, §4, §5 and §7 | Strings and RTTI symbols of `ArmaReforgerServer.exe` **1.8.0.13** (blocks around `0x1A8xxxx`–`0x1A9xxxx` for the paths, `0x1A47Dxx`–`0x1A47Fxx` for the CLI/config keys, `0x205xxxx`–`0x207xxxx` for the class names) |
| `URI_*` context names, `production` / `preprod` / `submission`, the health-check and status keys | The same binary, blocks around `0x1A87xxx`–`0x1A8Axxx` and `0x18F5xxx` |
| The script-side surface of §6, `GetErrorCode`'s strings, the `EBackendError` and `EServerType` enums | `scripts/GameLib/generated/online/BackendApi.c` via arexplorer **1.7.0.54**, plus the BI wiki and the published BI API member pages; `EServerType.c` and `BackendDebugApi.c` were also extracted from the **installed** `addons/core/data.pak` |
| The retry interval, the `JsonApi Array` warnings, and the behaviour of `-backendLog` | Dedicated server **1.8.0.13** runs for this pass: `-profile` in an empty directory, `-logFS`, `-backendLog` with several values, 22 s to 3.5 min uptimes. `$logs:.backend/logs/` was created by `-backendLog <value>` and stayed empty in every run, including the ones that registered |
| `ownerToken.bin` as a JWT and its claims | [Profile](ArmaReforger_Profile_EN.md) §3, and the token files it lists |
| The inbound ports a hoster must open | [`ServerConfig`](ArmaReforger_ServerConfig_EN.md) §5.1 and [`RCON`](ArmaReforger_RCON_EN.md) §1 |
| `-noBackend` destroying the game instance, the ban list living in the backend, the career record being a backend object | [Profile](ArmaReforger_Profile_EN.md) §5.6, §5.7 and §10 |
| REST API and JsonApiStruct usage from script | BI wiki, "Arma Reforger: REST API Usage" and "JsonApiStruct Usage" |
