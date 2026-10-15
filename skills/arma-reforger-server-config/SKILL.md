---
name: arma-reforger-server-config
description: Author or fix an Arma Reforger dedicated server config (server.json / config.json) - the top-level keys, gameProperties, mods, operating, the missionHeader override block, and how to launch the server on Windows or Linux so it actually reads the config. Use when asked to create, edit, review, or debug a server config; when a server refuses to start or the log shows "JSON is invalid!", "additionalProperties error", "There are errors in server config!", "JSON parse error" or "Failed to load server config!" (older notes and the wiki quote "Server Config file is Invalid" instead, which the server does not actually write); when it shows a "Missing Addon" dialog with the GUID 58D0FB3206B6F859; when setting up a Linux server with SteamCMD or systemd; when a missionHeader key seems to have no effect; or when choosing a scenarioId. Not for client-side settings or for Workbench project files.
---

# Authoring an Arma Reforger server config

## 0. Before you write anything

Two rules that prevent almost every real failure:

1. **Never invent a `scenarioId`.** It must be `{GUID}Missions/Name.conf` with a real GUID.
   Take it from [ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md) (build 1.6.0.119)
   or, for a mod's mission, from the mission's `.conf.meta` (`Name` field). A wrong GUID is
   a silent failure.
2. **Never reuse an old config as a template.** Files written before 0.9.8.73 carry
   obsolete field names (`gameHostBindAddress`, `gameHostBindPort`,
   `gameHostRegisterBindAddress`, `gameHostRegisterPort`, `playerCountLimit`,
   `supportedGameClientTypes`, `a2sQueryEnabled`, `steamQueryPort`). Verified by running the
   server: it rejects each of them and names the key, for example
   `Param "#/game/playerCountLimit" is not allowed and must be removed.` **But
   `dedicatedServerId` and `region` are not obsolete** — the schema still accepts them
   (verified by running the server on 1.8.0.13), so do not "fix" a config by deleting them
   unless you know they are unwanted. Start from §2 below instead.

## 1. Ground rules

- Flat JSON. No comments, no trailing commas, no single quotes.
- **Keys are case-sensitive.** `maxPlayers` works, `maxplayers` does not.
- Numbers unquoted, strings quoted, booleans bare. The config is checked against an
  **embedded JSON schema**; on mismatch the server does not start and writes a block that names
  the offending key — `Param "#/game/x" is not allowed and must be removed.`, then
  `JSON is invalid!` and `There are errors in server config!`. The string
  `Server Config file is Invalid - cannot start server!` is present in the executable but was
  **not** written on any failure path observed on 1.8.0.13, so do not grep the log for it.
- On a good start the log shows, in order:
  `Loading dedicated server config.` -> `Server config loaded.` -> `JSON Schema Validation:` -> `JSON is Valid`.
  **`JSON is Valid` is the only proof the file was accepted.**
- One scenario per server. No mission rotation.
- Only `a2s.address`, `rcon.address` and `rcon.password` are marked required, and the whole
  `rcon` block is optional. Everything else has a default — but see §4.

## 2. Minimal working config

```json
{
  "bindAddress": "0.0.0.0",
  "bindPort": 2001,
  "publicAddress": "127.0.0.1",
  "publicPort": 2001,
  "a2s": { "address": "0.0.0.0", "port": 17777 },
  "game": {
    "name": "Test Server",
    "password": "",
    "passwordAdmin": "admin",
    "admins": [],
    "scenarioId": "{ECC61978EDCC2B5A}Missions/23_Campaign.conf",
    "maxPlayers": 16,
    "visible": false,
    "gameProperties": {
      "serverMaxViewDistance": 1600,
      "serverMinGrassDistance": 50,
      "networkViewDistance": 1500,
      "disableThirdPerson": false,
      "fastValidation": true,
      "battlEye": false,
      "VONDisableUI": false,
      "VONDisableDirectSpeechUI": false,
      "VONCanTransmitCrossFaction": false
    },
    "mods": []
  }
}
```

`fastValidation` must be `true` on any server clients reach over the internet — BI flags this
as "very important". `-maxFPS` should be set on the command line (60..120) or the server
will try to consume all CPU.

`bindAddress`/`bindPort`/`publicAddress`/`publicPort` should generally be **omitted** so the
server auto-detects; set them only for unusual port-forwarding.

Parameter names matter and the wiki is newer than most installed builds. On build
1.6.0.119 these hold: the crash-reporter flag is `-disableCrashReporter` (matching the wiki),
`-aiLimit`/`-AILimit` are the same parameter (names are case-insensitive), `-listScenarios`
exists but prints paths **to the game log**, not stdout, and `-playerLimits`,
`-logVoting`, `-autodeployFaction`, `-scriptAuthorizeAll`, `-keepCrashFiles`,
`-checkInstance`, `-noSplash` and `-disableShadersBuild` are **absent from the binary**
because they came later. Screen every parameter before recommending it — procedure and a
full per-parameter build check:
[ArmaReforger_StartupParams_EN.md](../../docs/en/ArmaReforger_StartupParams_EN.md).

## 3. Hard constraints

| Field | Constraint |
|---|---|
| `game.scenarioId` | `{16 hex}path` — real GUID required |
| `game.maxPlayers` | 1..128 |
| `game.name` | at most 100 chars (longer is silently cropped, with a log line) |
| `gameProperties.serverMaxViewDistance` | 500..10000 |
| `gameProperties.networkViewDistance` | 500..5000 |
| `gameProperties.serverMinGrassDistance` | **`0`, or 50..150** — 1..49 invalid |
| `gameProperties.fastValidation` | always `true` for a public server |
| `rcon.password` | no spaces, at least 3 chars, required for RCON to start |
| `game.passwordAdmin` | no spaces |
| all ports | 1..65535 |
| `game.mods[].modId` | 16 hex chars, **no braces**, = `GUID` in `addon.gproj` (not `ID`) |
| `game.admins` | max 20 unique IDs since 1.3.0 |

`mods[]` entry keys: `modId` (the real one — the wiki's own heading says `modID` but its
example uses `modId`), `name` (a comment; does nothing), `version` (optional),
`required` (default from `modsRequiredByDefault`).

**Getting the mod list without typing GUIDs by hand.** The game client exports it: main menu
-> mods icon (puzzle piece, top right) -> "Saved mod settings" -> the **JSON** tab ->
"Copy to clipboard". The output is exactly the objects `game.mods` needs, with `modId`
already in bare-hex form and `version` filled in.

> **The exported text is NOT valid JSON — it is a bare list of objects with no surrounding
> array.** There is no opening `[` and no closing `]`. Wrap the pasted text in square
> brackets to get a value for `game.mods`, and keep commas **between** objects but not after
> the last one. Pasted as-is, what fails is **parsing**, not the schema: the server writes
> `JSON parse error: <reason> (Line: N, Char: M)` and then `There are errors in server config!`,
> even though the text itself looks fine.
> Container images document this same manual step.

The third tab in that window, "Command line", produces a ready `-addons` argument instead —
remember `-addons` and `-config` are mutually exclusive.

**Mod presets.** The first tab of that same window ("Saved mod settings") holds named mod
presets. The mod set itself is chosen in the **mod manager** (button at the bottom of the
window), where individual mods are toggled on and off; the resulting set can then be saved
as a preset, and the preset list shows how many mods each one contains. Loading a preset
switches the whole active set. Recommended workflow for a server config: enable exactly the
mods the server needs in the mod manager, save them as a preset, load it, then copy the JSON
— the JSON reflects the loaded preset. Note the JSON tab is the source of truth: it always
shows what will actually end up in the config.

`supportedPlatforms`: `PLATFORM_PC`, `PLATFORM_XBL`, `PLATFORM_PSN`. Valid: PC alone, or
PC + all consoles. PC + Xbox only is valid **on modded servers**; PSN is never added there.

## 4. Defaults are mode-dependent — the main trap

Field defaults come from the mission header **class**, and the class is chosen by the
scenario. `SCR_MissionHeaderCampaign` (Conflict) *inherits* `SCR_MissionHeader`
(Game Master). Consequences:

- Fields such as `m_iStartingHQSupplies`, `m_eStartingRank`, `m_bCommanderRoleEnabled`
  **exist only on the Campaign class**. Putting them in a Game Master config is silently
  ignored.
- The scenario `.conf` fills in its own values, which override class defaults. Vanilla
  `Missions/23_Campaign.conf` has `m_iPlayerCount 64` while the attribute default is `1`.
- Some behaviour is gated by mode at runtime, not by a field value.

So: the attribute default tells you only *what happens if the key is absent*. It is not
"the current setting". Never present a default as the server's live value.

Full field tables, including the rank enum and the custom-base list:
[ArmaReforger_MissionHeader_EN.md](../../docs/en/ArmaReforger_MissionHeader_EN.md).

## 5. Launching, and why it often fails before the config is even read

**Always `cd` into the server directory before launching.** Started from anywhere else, the
server cannot find its own game base and throws a modal dialog:

```
Missing Addon
Can't find '58D0FB3206B6F859' game addon! Check setup guidelines!
```

`58D0FB3206B6F859` is the GUID of `addons\data\ArmaReforger.gproj` — **the game itself**,
not the user's mod. The server resolves `.\addons\core` and `.\addons\data` relative to the
**current directory**, not relative to its `.exe`. So this error says nothing about the
config or the mod, and a "correct-looking" config will appear to be at fault when it is not.

```powershell
cd "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
.\ArmaReforgerServer.exe -config .\config.json -profile .\profile
```

Confirm the working directory from the log — these lines must be present:

```
ENGINE : Addon dirs:
 ENGINE : dir: './addons'
ENGINE : Available addons:
 ENGINE : gproj: './addons/core/core.gproj' guid: '5614BBCCBB55ED1C' (packed)
 ENGINE : gproj: './addons/data/ArmaReforger.gproj' guid: '58D0FB3206B6F859' (packed)
```

If the dialog shows a **different** GUID than `58D0FB3206B6F859`, the cause is different:
an addon required by the scenario or a mod is genuinely missing.

### On Linux

The dedicated server is a **native** Linux build — do not reach for Wine or Proton, and note
ARM64 is unsupported (x86_64 only). The same working-directory rule applies, and there it is
usually enforced through systemd rather than a shell:

- install with SteamCMD: `+force_install_dir <dir> +login anonymous +app_update 1874900 validate`
  (stable app id 1874900, experimental 1890870);
- launch from a script that does `cd "$SERVER_DIR"` first, because the server resolves
  `./addons` relative to the current directory;
- a systemd unit needs **`WorkingDirectory=/path/to/server`** for exactly the same reason —
  without it the server cannot find its own base addon;
- `-config` and `-profile` are safest as **absolute** paths;
- **case sensitivity**: `Configs/` and `configs/` are different directories, so a
  `scenarioId` or mod path that worked on Windows may fail here;
- the server must be able to write to the profile directory; avoid running as root.

**RCON is UDP** — verified by running the server and inspecting the socket; open only UDP
(`19999/udp`). The packets are BattlEye RCon v2 (RCON §1.1), so neither the transport nor the
format is open any more. The game port (2001) and A2S (17777) are UDP as well. Re-check on the
host with `ss -lunp | grep 19999` (Linux) or `Get-NetUDPEndpoint -LocalPort 19999` (Windows);
`ss -ltnp` should show nothing.

A practical Linux-specific self-check: the profile lives in a `test/` directory beside the
Windows binary, and `Addon dirs:` in the log proves which directory the server actually used.

### Public address vs. reaching the server from the same LAN

Setting `publicAddress` to a public IP **breaks joining from the server's own local
network** when the router lacks NAT hairpin (loopback): every client is told the same
address, so a local client sends packets to the public IP of its own network and they never
come back. Symptom: the server is visible and reachable from the internet, but you cannot
join from the machine hosting it, with nothing suspicious in the server log. Confirmed on a
home setup — joining only worked after the public IP was forwarded back to the local one.

Prefer leaving `publicAddress` empty so it is auto-detected; the wiki explicitly recommends
that, and offers a `"local"` literal for the local-address case. Do not "fix" it with
`-bindIP` — that overrides **both** `bindAddress` and `publicAddress`, pinning the same
address harder.

Also do not put a `192.168.x.x` address in `publicAddress` on an internet-facing server:
that value is registered in the backend as the public address and external players cannot
reach it.

### RCON is not BattlEye's RCON — but it speaks BattlEye's packets

Arma Reforger ships **two unrelated remote consoles** and they are constantly confused. The
`rcon` section in `server.json` is a Bohemia service (`RCONProtocol`, `RCONCommandHandler` in the
server binary), used through its own port (default 19999). The `BERCon.exe` that ships next to the
server belongs to **BattlEye** and is configured in `battleye\BEServer_x64.cfg`, not in
`server.json`. The endpoints differ; the packet format does not — it is BattlEye RCon v2
(RCON §1.1), so a tool written against that specification should be able to talk to it, although
pointing `BERCon.exe` itself at 19999 has not been tried.

Practical points worth remembering:

- **Do not hand-write an RCON client**: [`tools/rcon.mjs`](../../tools/rcon.mjs) implements the
  protocol (`node tools/rcon.mjs players --password …`, `npm run rcon -- players`). The
  arma-reforger-rcon skill carries the subcommand list.
- RCON will not start without `rcon.password` (no spaces, at least 3 characters).
- Bind `rcon.address` to `127.0.0.1` on any internet-facing server: RCON grants full control
  (kick, ban, scenario restart, shutdown) and is protected by the password alone.
- `rcon.permission` maps to the `ERCONPermissions` enum: `monitor` can only run `#players`;
  `admin` can run `#restart`, `#shutdown`, `#kick`, `#ban`. There is no finer granularity.
- Commands are `#`-prefixed and are **both** chat commands and RCON commands, with separate
  permission checks for each path — a command can work over RCON but not in chat.
- A killed RCON client holds its `maxClients` slot for **45 seconds** unless it sends
  `@logout` first.
- The **message format** is not documented; do not attempt to write an RCON client from
  scratch on the basis of the docs. The **transport is UDP** — verified by running the server,
  so open only UDP for the RCON port.

Full command list, permission matrix and log-based diagnostics:
[ArmaReforger_RCON_EN.md](../../docs/en/ArmaReforger_RCON_EN.md).

## 6. Diagnosing a config failure

| Log line | Meaning | Action |
|---|---|---|
| `JSON Schema Validation:` then `additionalProperties error:` / `Param "#/game/x" is not allowed and must be removed.` / `Reference in schema: "#/properties/game"` / `JSON is invalid!` / `There are errors in server config!` | schema rejected the file — **and the game names the offending key** | fix the key it names: usually a typo or a pre-0.9.8.73 name |
| `JSON parse error: <reason> (Line: N, Char: M)` / `There are errors in server config!` | the file is not valid JSON at all | fix the syntax at the reported line and character — a trailing comma, a comment, or a mod list pasted without its `[` `]` |
| `Unable to open server config file: <path>` / `Failed to load server config!` | `-config` points at a missing or unreadable file | check the path; a relative path resolves against the current directory |
| `Session name exceed max value > N, cropped under limit...` | `game.name` too long | shorten |
| `[A2S] Invalid port, set to default=17777...` | `a2s.port` out of range | fix; not fatal |
| `[RCON] Invalid port, set to default=19999...` | `rcon.port` out of range | fix; not fatal |
| `Server Config MissionHeader: Parameter 'X' is not supported type!` | wrong type in `missionHeader` | fix or remove; not fatal — **this is how you test whether a key is accepted** |
| `... Item on index N in parameter 'X' is invalid type!` | bad array element in `missionHeader` | fix |
| `Storage "X" contains undefined database named "Y"!` | `storages` references a missing `databases` entry | align names |

`missionHeader` never logs success — only errors. Absence of an error plus expected
behaviour in game is the only confirmation.

Syntax-check the file (e.g. `jq .`) before blaming the server.

## 7. Reviewing someone else's config

Check, in this order:

1. `scenarioId` — real GUID? If unknown, look it up; do not pass it through unchecked.
2. Presence of legacy keys: `gameHost*`, `playerCountLimit`, `supportedGameClientTypes`,
   `a2sQueryEnabled`, `steamQueryPort`, root-level `passwordAdmin`. All obsolete.
3. `fastValidation` is `true`; `serverMinGrassDistance` is `0` or 50..150.
4. `mods[].modId` — braces stripped, and it is the `GUID`, not the project `ID`.
5. `missionHeader` keys — do they belong to the class of *this* scenario's header?
6. `rcon.password` — no spaces, at least 3 chars, if `rcon` is present at all.

## 8. Reference documents in this workspace

All documents live in `docs/en/`, and these skills use their terminology. The Russian

### Directly for server work

- [ArmaReforger_ServerConfig_EN.md](../../docs/en/ArmaReforger_ServerConfig_EN.md) — the main guide:
  every parameter with type/range/default and a source tag, ready-made templates, a real
  config walkthrough, an error table, and the verbatim wiki Template/Example in Appendix A.
  §5.4.1 also covers getting the mod list out of the game.
- [ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md) — **38 scenarios with
  GUIDs** (30 official + 8 single-player), plus 4 terrain GUIDs. This is the source for
  `game.scenarioId`; it also explains the Cain = Kolguyev / Eden = Everon codename mapping.
- [ArmaReforger_MissionHeader_EN.md](../../docs/en/ArmaReforger_MissionHeader_EN.md) — the
  `missionHeader` block in detail: header class hierarchy, every field with defaults, the
  rank enum, and the `m_aCampaignCustomBaseList` structure.
- [ArmaReforger_StartupParams_EN.md](../../docs/en/ArmaReforger_StartupParams_EN.md) — startup
  parameters by wiki section, with a per-parameter check against the 1.6.0.119 binary, plus
  **Appendix A on running the server on Linux** (SteamCMD, launch script, systemd).
- [ArmaReforger_RCON_EN.md](../../docs/en/ArmaReforger_RCON_EN.md) — remote console: why it is not
  BattlEye, the permission matrix, the full command list, and log-based diagnostics.
- Sibling skill [`arma-reforger-rcon`](../arma-reforger-rcon/SKILL.md) — use it when the
  question is the remote console itself (enabling it, `monitor` vs `admin`, which command
  is chat-only, why a ban hangs in `PENDING`), rather than the config file around it.
- [ArmaReforger_Profile_EN.md](../../docs/en/ArmaReforger_Profile_EN.md) — the profile directory:
  logs, session saves and their `meta-info.json`, `ownerToken.bin`, engine settings, and the
  breakdown of the 39 `m_aStats` values in `PlayerData`.

### Tools

Most live in [`tools/`](../../tools/); the ones relevant to config work:

- [`extract-guid-table.ps1`](../../tools/extract-guid-table.ps1) — pulls the GUID→path table
  out of `resourceDatabase.rdb`. Always run it with `-Validate`: it checks the result
  against known-good GUIDs. Use it to obtain a `scenarioId`, or `modId` GUIDs.
- [`probe-keys.ps1`](../../tools/probe-keys.ps1) — checks which key names exist in a given
  `ArmaReforgerServer.exe`. Run it after a game update to see whether a field or startup
  parameter was renamed.
- [`pak-tool.mjs`](../../tools/pak-tool.mjs), [`unrotate.mjs`](../../tools/unrotate.mjs),
  [`html2text.mjs`](../../tools/html2text.mjs) — extracting and reading game data; see the
  separate `arma-reforger-game-data` skill.
- [`validate-doc-json.mjs`](../../tools/validate-doc-json.mjs) and
  [`validate-skills-and-links.mjs`](../../tools/validate-skills-and-links.mjs) — run these
  after editing any document here, so the JSON examples and cross-links stay valid.

Source tags used in the guides: `[wiki]` = BI wiki, `[binary]` = string found in
