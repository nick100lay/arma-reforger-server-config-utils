# The reference documents

Eight documents, each in English (`*_EN.md`) and Russian (`*_RU.md`). **The English version is
the source of truth**; the Russian one is a translation and is expected to stay in step. Line
counts, byte sizes, per-document build pins and hashes are in
[../data/manifest.json](../data/manifest.json) — deliberately not repeated here, where they
would drift.

Prefer the generated JSON in [../data/](../data/build.json) when you need a value rather than
an explanation: it is derived from these documents by
[../tools/build-data.mjs](../tools/build-data.mjs), so it cannot disagree with them silently.
Come back to the prose for the reasoning, the caveats and the failure modes.

| Document | Answers | Key sections |
|---|---|---|
| [ServerConfig](en/ArmaReforger_ServerConfig_EN.md) · [RU](ru/ArmaReforger_ServerConfig_RU.md) | Every key of `server.json`: type, range, default, source. Ready-made templates, a walkthrough of a real config, symptom→cause tables, and the verbatim wiki template | §4 hard rules · §5 parameter reference (5.1 root, 5.2 `a2s`, 5.3 `rcon`, 5.4 `game`, 5.5 `gameProperties`, 5.6 `operating`, 5.7 undocumented `[binary]` fields) · §6 templates · §9 verification and errors · §10 launching |
| [Scenarios](en/ArmaReforger_Scenarios_EN.md) · [RU](ru/ArmaReforger_Scenarios_RU.md) | The ready-made `scenarioId` strings: 30 official scenarios, 8 single-player, 4 terrains, plus what the game calls each one (`m_sName` and the text it resolves to) and how the list was extracted and verified | The Cain = Kolguyev / Eden = Everon codename trap · the three missions named `Conflict` · literal (untranslated) names · how to get a mod mission's GUID from its `.conf.meta` |
| [MissionHeader](en/ArmaReforger_MissionHeader_EN.md) · [RU](ru/ArmaReforger_MissionHeader_RU.md) | Every `missionHeader` field: class, type, default. Why a default is not the live value, which class accepts which key, and what is silently ignored | §2 header class hierarchy · §3.0 defaults depend on game mode · §3.2 `SCR_ECharacterRank` values · §3.4 `m_aCampaignCustomBaseList` (matching by entity name, whitelist vs blacklist, the two-HQ rule) · §4 what carries over |
| [VanillaBases](en/ArmaReforger_VanillaBases_EN.md) · [RU](ru/ArmaReforger_VanillaBases_RU.md) | Every base in every vanilla game mode, per world: entity name (what `m_sBaseName` must equal), localized display name, type, control point / supply hub / HQ flags and world position (X/Z) — plus the four base lists vanilla itself ships and what they set | §0 the three traps · §1 which modes have bases at all · §2 how the values were derived, and how to read them in another language · §3 the catalogue, seven worlds · §4 the shipped lists, and the two that break the two-HQ rule · §6 how it was obtained |
| [StartupParams](en/ArmaReforger_StartupParams_EN.md) · [RU](ru/ArmaReforger_StartupParams_RU.md) | The command line, parameter by parameter, with a per-parameter check against the 1.6.0.119 binary. Hosting, network tuning, debug, profiling, addons. Running on Linux | §0 the wiki is newer than the build · §7 what this build does not have · §8 how to check a parameter yourself · Appendix A (SteamCMD, launch script, systemd, ports, Docker) |
| [RCON](en/ArmaReforger_RCON_EN.md) · [RU](ru/ArmaReforger_RCON_RU.md) | Bohemia's remote console — how it differs from BattlEye's anti-cheat RCON while speaking the same packet format. Enabling it, `monitor` vs `admin`, the full command list, the recovered packet format, log-based diagnostics | §1 what it is and what it is not · §1.1 the BattlEye RCon v2 packet format · §1.2 the client in this repository · §1.3 the `shell` subcommand · §1.4 what the client does not read as a verdict · §2 configuration · §3 permissions · §4 commands · §6 diagnostics · §7 boundaries of reliability |
| [Profile](en/ArmaReforger_Profile_EN.md) · [RU](ru/ArmaReforger_Profile_RU.md) | The profile directory: logs, `ownerToken.bin`, session saves and their `meta-info.json`, the 39 `m_aStats` values in `PlayerData`, where a player's identity and the bans actually live, engine settings, backup and migration | §2 logs · §3 `ownerToken.bin` as a backend-issued JWT · §4 session saves · §5 player data · §5.6 identity and the three storage tiers · §5.7 bans · §9 backup and migration |
| [BackendAPI](en/ArmaReforger_BackendAPI_EN.md) · [RU](ru/ArmaReforger_BackendAPI_RU.md) | Bohemia's online service, which both the client and the dedicated server are clients of: what it holds, the API contexts, the endpoints the server binary names, the server's registration sequence, the tokens and identities, the script-side surface a mod can reach, the backend-related startup parameters, and what could not be established | §2 API contexts and the absent base URLs · §3 the endpoints by service · §4 the dedicated server's sequence · §5 tokens and what must not be published · §6 the script-side API · §7 `-backendLog`, `-backendEnv`, `-noBackend` · §8 reading the log · §9 the boundaries |

## Not covered here

- **Client-side settings** — this repository is about the dedicated server.
- **Workbench projects** (`.gproj`, prefabs, `.layout`) — the game-data skill covers reading
  vanilla resources, but authoring a mod is out of scope.
- **Writing an RCON client** — the wire protocol is documented now ([RCON §1.1](en/ArmaReforger_RCON_EN.md)),
  but this repository ships no client of its own, and whether third-party BattlEye tooling
  interoperates with `rcon.port` has not been tried.

## Reading a document without reading all of it

Every document opens with the build it was verified against — a `**Build verified on:**`
statement that also says which claims a later pass on the installed build re-checked — and its
`##` sections are listed above. `data/manifest.json` records that declared pin, and the size of
each document, up front; `npm run check:data` fails when a document declares no build. A typical
budget: the ServerConfig guide is the longest, so when you only need a value, query
`data/server-keys.json` first and open the guide for the section it cites.
