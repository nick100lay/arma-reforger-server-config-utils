# Arma Reforger server config — guide for AI agents

**What this repository is.** A verified knowledge base for authoring and debugging Arma
Reforger dedicated server configs (`server.json` / `config.json`): the documentation, the
machine-readable data derived from it, a JSON Schema with a validator, and three agent
skills. There is no application code — the deliverables are documents and JSON.

**Verified against build 1.6.0.119 (engine 192142), January 2026.** The pin lives in one
place, [data/build.json](data/build.json); per-document pins and hashes are in
[data/manifest.json](data/manifest.json). Claims verified by searching the binary or by
running a real server are tagged `[binary]` and `[practice]`; the rest come from the BI wiki
(`[wiki]`). **The wiki is newer than this build** — see rule 3.

## The four rules that prevent almost every real failure

1. **Never invent a `scenarioId`.** It is `{16 hex}Missions/Name.conf`. Copy the whole
   string from [data/scenarios.json](data/scenarios.json) (38 vanilla scenarios plus 4
   terrains, each with its GUID). For a mod mission the GUID comes from the mission's
   `.conf.meta`, field `Name`. A wrong GUID fails silently.
2. **Never reuse a config written before 0.9.8.73 as a template.** `gameHostBindAddress`,
   `gameHostBindPort`, `gameHostRegisterBindAddress`, `gameHostRegisterPort`, root-level
   `passwordAdmin`, `playerCountLimit`, `supportedGameClientTypes` and the
   `a2sQueryEnabled`/`steamQueryPort` pair are all **rejected by the schema** — verified by
   running the server, which names the offending key
   (`Param "#/game/playerCountLimit" is not allowed and must be removed.`). The validator
   reports each one with its replacement. Two traps in the opposite direction:
   `dedicatedServerId` and `region` are **accepted** (undocumented fields, not obsolete names),
   and a name being present in the executable proves nothing — the schema is the authority.
3. **Screen every command-line parameter against this build** before recommending it:
   [data/startup-params.json](data/startup-params.json) marks each one `present` or
   `absent`. Absence of a string in the binary is strong but not absolute evidence —
   `-autoreload` and `-autoshutdown` have no string yet were accepted on a real command
   line — so they are listed separately under `acceptedButNotInBinary`.
4. **Never present a class default as the server's live value.** `missionHeader` defaults
   belong to the header *class*, and the scenario's own `.conf` overrides them; some
   behaviour is gated by game mode at runtime. See
   [the missionHeader breakdown](docs/en/ArmaReforger_MissionHeader_EN.md) §3.0.

## Where to look

| Question | Read |
|---|---|
| Authoring or reviewing `server.json`: keys, ranges, defaults, templates, error table | [docs/en/ArmaReforger_ServerConfig_EN.md](docs/en/ArmaReforger_ServerConfig_EN.md) |
| A `scenarioId`, or which scenario is which map | [data/scenarios.json](data/scenarios.json), prose in [Scenarios](docs/en/ArmaReforger_Scenarios_EN.md) |
| A `missionHeader` key, its type, default, or which class accepts it | [data/mission-header-fields.json](data/mission-header-fields.json), prose in [MissionHeader](docs/en/ArmaReforger_MissionHeader_EN.md) |
| A startup parameter, a launch command line, systemd, SteamCMD, Linux hosting | [data/startup-params.json](data/startup-params.json), prose in [StartupParams](docs/en/ArmaReforger_StartupParams_EN.md) |
| The remote console: enabling it, permissions, commands, why a ban hangs | [docs/en/ArmaReforger_RCON_EN.md](docs/en/ArmaReforger_RCON_EN.md) |
| The profile directory: logs, saves, `ownerToken.bin`, `m_aStats` | [docs/en/ArmaReforger_Profile_EN.md](docs/en/ArmaReforger_Profile_EN.md) |
| Reading `.pak` archives, resource GUIDs, vanilla `.c` sources | [the arma-reforger-game-data skill](skills/arma-reforger-game-data/SKILL.md) — there is no document for this in `docs/` |
| Everything, by document and language | [docs/README.md](docs/README.md) |
| Client-side settings | **Not covered here.** This repository is about the dedicated server. |
| Workbench project files (`.gproj`, prefabs) | **Not covered here.** |

## Machine-readable data — prefer it over the prose

Each file is generated from the English documents by
[tools/build-data.mjs](tools/build-data.mjs), so it cannot drift from them silently
(`npm run check:data` fails when it does).

| File | Contents |
|---|---|
| [data/scenarios.json](data/scenarios.json) | `scenarios[]` with `scenarioId`, `guid`, `path`, `name`, `map`, `mapCodename`, `section`; `terrains[]`; `mapCodenames` (Cain = Kolguyev, Eden = Everon); `byGuid` index; `scenarioHeaderClasses` |
| [data/mission-header-fields.json](data/mission-header-fields.json) | `fields[]` with `key`, `className`, `type`, `default`; `allowedByClass` (which keys each header class accepts); `nestedTypes[]`; `ranks[]` (0..19, `SCR_ECharacterRank`) |
| [data/startup-params.json](data/startup-params.json) | `params[]` with `param`, `aliases`, `usage`, `section`, `status`, `value`, `default`, `diagOnly`, `scope`; `index` for name lookup; `absentNames`, `acceptedButNotInBinary`, `docClaims` |
| [data/server-keys.json](data/server-keys.json) | `keys[]` with `key`, `parent`, `type`, `default`, `source` (`wiki`/`binary`), `undocumented`; `undocumentedKeys` (section 5.7) |
| [data/build.json](data/build.json) | **The only hand-written file in `data/`**: the build pin, how it was verified, and the invariants the generator checks itself against |
| [data/manifest.json](data/manifest.json) | Every document with `lines`, `bytes`, `buildPin`, `sha256_16`, language, and EN↔RU `pairs`; plus the skill list |
| [schemas/server.schema.json](schemas/server.schema.json) | JSON Schema (draft 2020-12) for `server.json`, usable with any validator. Hand-written, coverage enforced against `data/server-keys.json` |

## Commands

Plain Node, no dependencies and no install step (Node 18+, developed on 25).

```bash
npm run validate-server -- path/to/server.json   # validate a real config
npm test                                         # validator test suite over tests/fixtures
npm run check                                    # everything below, in order
npm run check:data                               # fail if data/ is stale against docs/en/
npm run check:schema                             # schema keys <-> section 5 of the guide
npm run check:json                               # every ```json block in every .md parses
npm run check:links                              # every relative markdown link resolves
npm run check:encoding                           # UTF-8 without BOM, LF, no CP1251-mojibake residue
npm run build:data                               # regenerate data/ after editing docs/en/
node tools/verify-against-install.mjs            # check an installed server against these documents
node tools/probe-config-schema.mjs cfg.json      # ask the server whether it accepts a config
```

`verify-against-install` and `probe-config-schema` both **launch or read a real installation**:
the first needs the game's files, the second starts the server itself and therefore needs an
environment where it can create named pipes (not a sandbox). Everything else runs anywhere.

Before handing a config to anyone, run `npm run validate-server -- <file>`. It reports
**errors** (the server would reject the file), **warnings** (the server starts but clamps or
ignores the value — bad ports, over-long names, `fastValidation: false`), and **notes**. Use
`--json` for a machine-readable report, `--out report.json` to write it to a file, and
`--lenient` when reviewing a config that is known to work. The game's own confirmation is the
log line `JSON is Valid`; §9 of the config guide lists what it writes when it fails, which is
**not** the string the wiki quotes. When the question is "does the schema accept this key", only
the server can answer — `node tools/probe-config-schema.mjs <config.json>` asks it.

## Working in this repository

- **`docs/en/` is the source of truth.** `docs/ru/` is a translation and is expected to stay
  in step; a change to one without the other is incomplete.
- **`data/*.json` is generated.** Never hand-edit it: edit the document and run
  `npm run build:data`. `data/build.json` is the single hand-written exception.
- **The schema is hand-written but guarded.** `npm run check:schema` fails if a key in §5 of
  the guide is missing from the schema or vice versa, and if the objects derived from §5 stop
  being `additionalProperties: false`. Add a key to the guide and the schema in one change.
- **Tests assert exact counts.** [tests/run-tests.mjs](tests/run-tests.mjs) pins the number of
  errors and warnings per fixture, so changing severity is a deliberate act with a visible
  diff. When you change severity, update the fixture and say why.
- **Encoding:** UTF-8 without BOM, LF, final newline ([.editorconfig](.editorconfig)).
- **Fence deliberately-invalid JSON as ```text**, never ```json — `check:json` treats any
  failure in a ```json block as a real mistake.
- **Never add a second document that restates a table from an existing one.** That is exactly
  how this repository would acquire contradictions. Extend the existing document instead.
- Conventions for editing the documents themselves: [CONTRIBUTING.md](CONTRIBUTING.md).

## The installed build is not the documented build

The documents are verified against **1.6.0.119**. The build installed on this machine is
**1.8.0.13**, and that difference has its own command:

```bash
node tools/verify-against-install.mjs
```

It reports, mechanically: the installed version against the pin in
[data/build.json](data/build.json); every scenario and terrain GUID against the installed
`resourceDatabase.rdb`; and the startup parameters the documents call absent plus the
pre-0.9.8.73 field names, against the strings in the installed executable. Its RDB parser
self-checks against the 8 GUIDs published on the wiki and refuses to report a GUID comparison
if that fails. Last run: **42/42 GUIDs unchanged and 13/13 absent parameters still absent on
1.8.0.13**. Everything the documents say about behaviour, ranges and defaults remains a
statement about 1.6.0.119.

## Known open issues — verified discrepancies, do not "fix" them silently

1. **Resolved.** The startup-parameter counts now match the tables (13 absent out of 70 names),
   `-noSplash` has a reference row, and `npm run check:data` prints no count warnings. If one
   reappears, the prose and the tables have drifted apart again.
2. **Resolved by launching the server.** The old field names were settled by running 1.8.0.13
   with each one in turn (`tools/probe-config-schema.mjs`): the four `gameHost*` names,
   `playerCountLimit`, `supportedGameClientTypes`, `a2sQueryEnabled`, `steamQueryPort` and an
   invented key are all **rejected**, and the log names the key. **`dedicatedServerId` and
   `region` are accepted** — undocumented fields, not obsolete names; the guide said otherwise
   until this was tested, and both are now in the schema and in §5.1.
3. **The failure vocabulary is not what the wiki quotes.** `Server Config file is Invalid -
   cannot start server!` is in the executable but was not written on any of the three failure
   paths observed; §9 of the guide now lists what the server actually writes, including the
   offending key for a schema violation. Grepping the log for the quoted string finds nothing.
4. The RCON transport (UDP or TCP) is unconfirmed in every available source, and the
   documents say so explicitly. Do not resolve it by picking one.

## Skills in this repository

[skills/](skills/README.md) holds three skills in Agent Skills format (YAML frontmatter with
`name` and `description`, enforced by `npm run check:links`). **Nothing discovers them
automatically from this path** — point your agent at the file, or copy/symlink the skill
directory into the agent's own skills directory.

| Skill | Use when |
|---|---|
| [arma-reforger-server-config](skills/arma-reforger-server-config/SKILL.md) | Writing, reviewing or debugging a server config; the server refuses to start; the "Missing Addon 58D0FB3206B6F859" dialog |
| [arma-reforger-rcon](skills/arma-reforger-rcon/SKILL.md) | The remote console itself: enabling it, `monitor` vs `admin`, chat-only commands, a ban stuck in `PENDING` |
| [arma-reforger-game-data](skills/arma-reforger-game-data/SKILL.md) | Reading `.pak` archives, resolving a resource GUID, or reading vanilla `.c` sources to override them |
