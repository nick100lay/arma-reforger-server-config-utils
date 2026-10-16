# Arma Reforger server config — guide for AI agents

**What this repository is.** A verified knowledge base for authoring and debugging Arma
Reforger dedicated server configs (`server.json` / `config.json`): the documentation, the
machine-readable data derived from it, a JSON Schema with a validator, and three agent
skills. There is no application code — the deliverables are documents and JSON; the scripts
in `tools/` exist to produce and check them, plus [tools/rcon.mjs](tools/rcon.mjs), a working
RCON client for talking to a live server.

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
| The remote console: enabling it, permissions, commands, why a ban hangs, the packet format | [docs/en/ArmaReforger_RCON_EN.md](docs/en/ArmaReforger_RCON_EN.md) — and [tools/rcon.mjs](tools/rcon.mjs) to actually talk to a running server |
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
| [schemas/rcon-result.schema.json](schemas/rcon-result.schema.json) | JSON Schema for the JSON that [tools/rcon.mjs](tools/rcon.mjs) prints — both the one-shot result and the per-command line of `shell --json`. Hand-written; the examples in the RCON skill are validated against it by `npm run check:rcon-schema`, which also fails if the schema stops rejecting a shape it should |

## Commands

Plain Node, no dependencies and no install step (Node 18+, developed on 25).

```bash
npm run validate-server -- path/to/server.json   # validate a real config
npm test                                         # validator test suite over tests/fixtures
npm run check                                    # everything below, in order
npm run check:data                               # fail if data/ is stale against docs/en/
npm run check:schema                             # schema keys <-> section 5 of the guide
npm run check:json                               # every ```json block in every .md parses
npm run check:encoding                           # UTF-8 without BOM, LF, no CP1251-mojibake residue
npm run check:links                              # every relative markdown link resolves
npm run check:rcon-schema                        # the RCON client's JSON examples match schemas/rcon-result.schema.json
npm run build:data                               # regenerate data/ after editing docs/en/
node tools/verify-against-install.mjs            # check an installed server against these documents
node tools/probe-config-schema.mjs cfg.json      # ask the server whether it accepts a config
npm run rcon -- players --password <pw>          # talk to a running server's RCON (tools/rcon.mjs)
npm run rcon -- shell --password <pw>            # the same client, interactive: type commands, read answers
```

`verify-against-install` and `probe-config-schema` both **launch or read a real installation**:
the first needs the game's files, the second starts the server itself and therefore needs an
environment where it can create named pipes (not a sandbox). `rcon` needs a server that is
already **running** with its `rcon` block configured, and it is not read-only: `ban create`,
`ban remove`, `kick`, `restart`, `shutdown` and anything typed into `shell` change state or
disconnect people, so confirm before pointing them at somebody else's server. Every run ends with
the `@logout` protocol command, so it does not leave a `maxClients` slot busy for 45 seconds
(`--no-logout` reproduces that); `shell` prints a `--- done:` status line after each command.
Everything else runs anywhere.

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
- **Commit as you work** — one reason per commit, made at each finished step, not once at the
  end: see [Commits](#commits-small-steps-committed-as-you-go) below.
- Conventions for editing the documents themselves: [CONTRIBUTING.md](CONTRIBUTING.md).

## Commits: small steps, committed as you go

**The history is part of the deliverable, and it is written while the work happens.** The failure
this section exists to prevent: do the whole task, then make one commit just before pushing. That
history cannot be bisected, cannot be reviewed one claim at a time, and cannot be reverted when
one of its claims turns out to be wrong. **Commit each finished step as you finish it.**

- **One reason per commit.** If the message needs "and also", it is two commits. Size is not the
  criterion: one count corrected across five documents is one commit; four unrelated corrections
  are four. A change that only reformats, only repairs encoding, or only adds a check is its own
  commit — never folded into the substantive one it happens to accompany.
- **A commit leaves the tree coherent, not finished.** Every file that one invariant binds
  together goes in the same commit: `docs/en/` + `docs/ru/` + regenerated `data/`, a §5 key plus
  its schema entry, a severity change plus the fixture and the test count it moves. Intermediate
  commits may be incomplete; they must not be broken. Run `npm run check` before committing
  anything that touches `docs/`, `data/`, `schemas/`, `skills/` or `tools/`, and keep it green —
  a commit that knowingly leaves a check failing is allowed only when that failure *is* the step,
  which the message must say.
- **The evidence rides with the claim.** A commit that changes what a document asserts carries
  what settled it in the same commit: the probe or client change, the fixture, the regenerated
  data, the corrected test count. The message names the evidence — `[practice]` on 1.8.0.13,
  `SCR_RankInfo.c` in the 1.6.0.119 pak — because that is what lets the next reader trust the
  change without redoing the work.
- **Stage by path, after reading `git status`.** `git add -A` collects what probing a config or
  running a server leaves behind (`*.report.json`, logs, `out/`); [.gitignore](.gitignore) covers
  the known cases and nothing else. Commit only files this step changed.
- **Never hand over with uncommitted work.** If the task is unfinished, commit what is coherent
  and let the message say what remains. Work that was genuinely exploratory and produced nothing
  should be discarded, not left in the tree.
- **Do not rewrite history that is already pushed**, and never `--force` `main`. Amending,
  squashing or rebasing your own unpushed commits is fine and often right.
- **Pushing is the human's decision.** `git push` only when asked to.

A task that would land as one big commit usually splits cleanly. Correcting the RCON packet
format, for instance: the client or probe change that established it; the claim itself with its
EN/RU pair and the regenerated `data/`; the fixture and pinned counts that stop the validator
drifting back. Three commits, each re-readable on its own.

Message style in detail, and the pairing rules that force a commit to span several files:
[CONTRIBUTING.md](CONTRIBUTING.md) §Commits.

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
4. **Resolved by running the server.** The RCON transport is **UDP**: with `rcon.address` and
   `rcon.port` set, the port was a UDP endpoint owned by the server process, there was no TCP
   listener, and a TCP connect was refused — with the game port and A2S as UDP controls, so the
   negative result is meaningful. The documents used to call the protocol unconfirmed and told
   readers to open both; the advice is now "open UDP only". **The packet format is no longer
   open either**: it is BattlEye RCon v2 — a 7-byte `BE | CRC32 | 0xFF` header, `0x00|password`
   to log in, `0x01|seq|command`, `0x02|seq|text` messages that must be acknowledged — see §1.1
   of the RCON document, and [tools/rcon.mjs](tools/rcon.mjs) for a client that speaks it. The
   traps found the hard way, all of them silent: the server does not verify the CRC of what it
   receives; a full RCON client list drops packets *before* parsing them, so a command gets
   silence rather than an error; a command whose `seq` is not the expected one is acknowledged
   with `0x01|seq` and otherwise ignored without a log line, so an acknowledgement proves
   nothing; and a client that is merely closed keeps its `maxClients` slot for 45 s — the
   `@logout` protocol command (`0x01|seq|@logout`) frees it at once, and the client sends it on
   every run.

## Skills in this repository

[skills/](skills/README.md) holds three skills in Agent Skills format (YAML frontmatter with
`name` and `description`, enforced by `npm run check:links`). **Nothing discovers them
automatically from this path** — point your agent at the file, or copy/symlink the skill
directory into the agent's own skills directory.

| Skill | Use when |
|---|---|
| [arma-reforger-server-config](skills/arma-reforger-server-config/SKILL.md) | Writing, reviewing or debugging a server config; the server refuses to start; the "Missing Addon 58D0FB3206B6F859" dialog |
| [arma-reforger-rcon](skills/arma-reforger-rcon/SKILL.md) | The remote console itself: enabling it, `monitor` vs `admin`, chat-only commands, a ban stuck in `PENDING`, and the client to use — [tools/rcon.mjs](tools/rcon.mjs) |
| [arma-reforger-game-data](skills/arma-reforger-game-data/SKILL.md) | Reading `.pak` archives, resolving a resource GUID, or reading vanilla `.c` sources to override them |
