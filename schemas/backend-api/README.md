# The backend API, as JSON Schema

A specification of the HTTP API Bohemia's online service exposes to an Arma Reforger dedicated
server — the endpoints, their request bodies, their answer bodies. It is written from capture, not
from documentation: Bohemia publishes no reference for this API, and everything here was observed
on the wire on **Arma Reforger 1.8.0.13 (engine 192142)** with a dedicated server behind a
TLS-terminating proxy. The prose that explains the same territory, and why it matters to a server
admin, is [../../docs/en/ArmaReforger_BackendAPI_EN.md](../../docs/en/ArmaReforger_BackendAPI_EN.md).

**Two rules govern this directory.** A schema describes only what was captured — where a shape was
never observed, the field is left open and the fact is written down rather than guessed. And every
example here is validated against its schema by
[tools/check-backend-schemas.mjs](../../tools/check-backend-schemas.mjs) on every `npm run check`,
together with mutations that must be *rejected*, so a schema cannot quietly decay into
"accepts anything".

## How it is laid out

| Path | What it is |
|---|---|
| [index.json](index.json) | The index: every endpoint, its method and URL, the schema file that describes it, the definitions to use, and the examples. Nothing in this directory may be missing from it — the checker fails on an orphaned schema or example |
| [common.schema.json](common.schema.json) | The shared value definitions: `uuid`, `token` (a three-part JWS), `scenarioId` (`{16 hex}Missions/Name.conf`), `modId` (16 hex), `hostAddress`, `page`, `okStatus`, the lobby request envelopes, the heartbeat stat forms. Referenced by every endpoint schema as `../common.schema.json#/$defs/…` |
| `game-config/`, `game-api/`, `lobby/`, `workshop/`, `platform/` | One directory per service - the host and path prefix the calls share |
| `<service>/<endpoint>.schema.json` | One file per endpoint, holding `$defs/request` and `$defs/response`. A `$comment` at the top of each states what was observed, in which run, and with what status |
| [examples/](examples/) | One file per captured body, named `<endpoint>.<request\|response>.json` |

## What is covered

| Endpoint | Method | Observed |
|---|---|---|
| `api-ar-gc.bistudio.com/game-config/api/v1/reforger/1.8.0/13/list` | GET | server, first call |
| `api-ar-game.bistudio.com/game-api/api/v1.0/world` | GET | server |
| `api-ar-game.bistudio.com/game-api/api/v1.0/dummy` | GET | server, before acceptPlayer/removePlayer/remove |
| `…/game-api/s2s-api/v1.0/lobby/dedicatedServers/registerUnmanagedServer` | POST | server — **carries the owner token** |
| `…/lobby/dedicatedServers/heartBeat` | POST | server, every 61 s |
| `…/lobby/rooms/register` | POST | server |
| `…/lobby/rooms/acceptPlayer` | POST | server, on a real join |
| `…/lobby/rooms/removePlayer` | POST | server, on a real leave |
| `…/lobby/rooms/createBan`, `listActiveBans`, `removeBans` | POST | server, driven by `#ban` over RCON |
| `…/lobby/rooms/remove` | POST | server, on a clean shutdown |
| `api-ar-workshop.bistudio.com/workshop-api/api/v3.0/s2s/assets/download-list` | POST | server, with one mod configured |
| `ar-gcp-cdn.bistudio.com/manifest/<2 hex>/<2 hex>/<sha512>/<size>` | GET | server, while downloading that mod |
| `reforger.armaplatform.com/api/popup` | GET | server |
| `reforger.armaplatform.com/api/news` | GET | **client only** — the server fetches `/api/popup` instead |

**Not schematised, deliberately:** `ar-gcp-cdn.bistudio.com/fragment/…`, which returns raw bytes
(one captured fragment happened to be the mod's own JSON config, the rest were pak data); the
element shapes of `activeBans`-style arrays that were always empty (`popup.items`,
`gameEvents`, `rentedServers.entries`, `dependencies`); and everything the dedicated server was
never seen calling — storage, groups, notifications, `server-configs/*`, the identity endpoints
and the whole `servers/*` family. Those paths exist in the server binary as strings, which is all
the backend document can say about them.

## The examples are sanitised

The captures themselves are not in the repository: they are written to `out/` (gitignored) by the
proxy used for the investigation. The checked-in examples were produced from them mechanically,
and every identifier and secret was replaced:

- every UUID became `00000000-0000-4000-8000-00000000000N`, consistently, so the relationships
  between ids still hold (the `roomId` of a ban record is still the `serverId` of the token);
- every token became the same obviously fake JWS, `eyJhbGciOiJSUzUxMiJ9.…` with a 342-character
  `A` signature — the same for `accessToken` and `ownerToken`, because they are the same string;
- the `sessionTicket` became 512 `T`s and the acceptPlayer `secret` 144 `S`s, their captured
  lengths;
- player names became `ExamplePlayer`, the `steamId` a placeholder SteamID64, the `biAccountId` a
  placeholder UUID;
- the career record's values were zeroed, keeping its 39-element shape, and the manifest paths and
  SHA-512 digests became placeholders.

Everything else — field names, enums, counts, timestamps, sizes, the numbers themselves — is as
captured. **A raw capture must not be pasted anywhere public**: the `rooms/register` body carries
`game.password` in clear and every lobby body carries the owner token.

## Checking it

```bash
npm run check:backend-schemas     # also part of npm run check
node tools/check-backend-schemas.mjs --quiet
```

The checker does three things, and any of them can fail the run: the index and the tree must
agree; every example must validate against the definition its entry names, with `$ref` resolved
across files; and the schemas must still reject what they should — a required property removed and
an unknown property added to every object-shaped example, plus endpoint-specific mutations such as
a `scenarioId` without its GUID, a lowercase `modId`, a `directJoinCode` that is not ten digits, a
`steamId` that is not a SteamID64, or a ban scope that is not pinned to a room.

The validator implements the same small subset of draft 2020-12 that
[the RCON schema's checker](../../tools/check-rcon-schema.mjs) does — `$ref`, `type`, `enum`,
`pattern`, `minLength`, `minItems`, `minimum`, `maximum`, `properties`, `required`,
`additionalProperties`, `propertyNames`, `items`, `oneOf`, `allOf` — and **fails on any other
keyword** rather than ignoring it, so an unsupported construct cannot pass unnoticed.
