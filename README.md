# Arma Reforger dedicated server config — knowledge base

Everything needed to write, review and debug an Arma Reforger dedicated server config
(`server.json`), verified against **build 1.8.0.13 (engine 192142)** rather than copied from
the wiki — the wiki is a month newer than that build, and the difference is not
theoretical: 13 of the documented startup parameters do not exist in it.

Each fact in the documents carries its provenance: `[wiki]`, `[binary]` (a string found in
`ArmaReforgerServer.exe`) or `[practice]` (observed on a running server).

## Quick start

```bash
# Validate a server config before you launch anything.
npm run validate-server -- path/to/server.json

# Check the server installed on this machine against these documents: build version, every
# scenario GUID, and the parameters and field names the documents say are gone.
node tools/verify-against-install.mjs

# Regenerate the machine-readable data after editing a document, then run every check.
npm run build:data && npm run check

# Talk to a running server's remote console: list players, read the ban list, ban or unban.
npm run rcon -- players --password "$RCON_PASSWORD"

# Or open an interactive session, where every command reports its own status when it ends.
npm run rcon -- shell --password "$RCON_PASSWORD"
```

No dependencies, no install step — plain Node 18+.

**The documents are pinned to build 1.8.0.13 — the build installed here.** What is re-checkable
mechanically was re-checked before the pin moved: all 42 scenario and terrain GUIDs, every
`server.json` key name, all 69 startup parameters (56 present — 7 of them in the Diag build only —
and 13 absent), the engine revision from the server's own log line, the error strings the documents
quote, and the `missionHeader` field list read out of the build's own `data007.pak`. The previous
pin, 1.6.0.119, is recorded in [data/build.json](data/build.json) under `previousPin`. The RCON
packet format, long the open question, is recovered — BattlEye RCon v2, with a client in
[tools/rcon.mjs](tools/rcon.mjs). The remaining discrepancies are tracked in
[AGENTS.md](AGENTS.md).

Looking for a `scenarioId`? It is in [data/scenarios.json](data/scenarios.json) — 38 vanilla
scenarios with their GUIDs. Looking for a `missionHeader` key, or whether a startup parameter
exists in this build? [data/mission-header-fields.json](data/mission-header-fields.json) and
[data/startup-params.json](data/startup-params.json).

## What is here

| Path | What it is |
|---|---|
| [AGENTS.md](AGENTS.md) | **Start here if you are an AI agent.** The four rules that prevent almost every real failure, a question→document router, and the open issues |
| [docs/](docs/README.md) | The nine reference documents, in English and Russian, listed with what each one answers |
| [data/](data/build.json) | Generated JSON: scenarios and GUIDs, missionHeader fields by class, startup parameters per build, every config key, the build pin, and a document manifest |
| [schemas/server.schema.json](schemas/server.schema.json) | JSON Schema for `server.json`, with coverage enforced against the guide |
| [tools/](tools/validate-server-config.mjs) | The validator, the data generator, the coverage, link and encoding checks, the installed-build verifier, the config schema prober, the game-data reading tools ([pak](tools/pak.mjs), [ebin](tools/ebin.mjs), [rdb](tools/rdb.mjs), [loc](tools/loc.mjs), [etconf](tools/etconf.mjs), [cscript](tools/cscript.mjs)), the addons-folder resolver and filter ([addons](tools/addons.mjs) — dependency order from `addon.gproj`, `--mods-file`), and [rcon.mjs](tools/rcon.mjs) — a working RCON client for a running server |
| [skills/](skills/README.md) | Five agent skills: server config, launch, RCON, reading game data, analysing script code |
| [tests/](tests/run-tests.mjs) | The validator test suite, run against fixtures in `tests/fixtures/`, plus a suite per tool (pak, ebin, rdb, localization, etconf, cscript, addons, server-status) |

## The three traps worth knowing before anything else

1. **`scenarioId` must carry a real resource GUID** (`{16 hex}Missions/Name.conf`). A wrong
   GUID fails silently, so copy the string from [data/scenarios.json](data/scenarios.json)
   instead of typing it.
2. **Systems from before 0.9.8.73 are gone**, and old configs still circulate:
   `gameHostBindAddress`, `gameHostBindPort`, `gameHostRegisterBindAddress`,
   `gameHostRegisterPort`, root-level `passwordAdmin`, `playerCountLimit`,
   `supportedGameClientTypes`. Verified against the binary — those strings do not occur in
   it. The validator names the replacement for each.
3. **Always `cd` into the server directory before launching.** Started elsewhere, the server
   cannot find its own game base and shows a modal `Missing Addon` dialog naming the GUID
   `58D0FB3206B6F859` — which is the game itself, not your mod, and says nothing about your
   config.

## Status and conventions

The build pin, the verification methods and the invariants live in
[data/build.json](data/build.json). How to edit the documents, and what each source tag
means: [CONTRIBUTING.md](CONTRIBUTING.md). What changed and when: [CHANGELOG.md](CHANGELOG.md).
Known unresolved discrepancies between the prose and the tables: [AGENTS.md](AGENTS.md),
"Known open issues".
