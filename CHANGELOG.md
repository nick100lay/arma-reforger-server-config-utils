# Changelog

Pinned to **Arma Reforger 1.6.0.119 (engine 192142)**. The pin and the verification methods
live in [`data/build.json`](data/build.json); per-document pins and hashes in
[`data/manifest.json`](data/manifest.json).

## [Unreleased]

An agent-facing layer on top of the existing documents. No statement in the documents was
changed — everything here is navigation, machine-readable data, and enforcement. Details of
the changes made together with it are in the commit history.

### Added — navigation

- `AGENTS.md` — the cross-agent entry point: the four rules that prevent almost every real
  failure, a question→document router, the command list, and the repository's open issues.
- `README.md`, `docs/README.md` — landing page and a router over the six reference documents
  with their EN/RU pairs and section maps. Sizes are deliberately left to
  `data/manifest.json` rather than restated.
- `skills/README.md` — the skill catalogue, plus how to make skills discoverable
  (`skills/` is not scanned by any runtime).
- `package.json` — stable entry points (`npm run check`, `validate-server`, `build:data`) so
  the tools no longer have to be remembered by command line.
- `CONTRIBUTING.md`, `CHANGELOG.md`, `.editorconfig`, `.gitignore`.

### Added — machine-readable data, generated from `docs/en/`

[`tools/build-data.mjs`](tools/build-data.mjs) converts the documents into:

- `data/scenarios.json` — 38 scenarios (30 official, 8 single-player) and 4 terrains with
  GUIDs, map codenames, a `byGuid` index and the documented scenario→header-class mapping.
- `data/mission-header-fields.json` — 47 `missionHeader` keys attributed to their class
  (30 base + 17 campaign), 7 nested-type fields, the 20-value `SCR_ECharacterRank` enum, and
  `allowedByClass`.
- `data/startup-params.json` — 68 parameters (69 names, counting the `-AILimit`/`-aiLimit`
  alias) with `present`/`absent` per the pinned binary, plus an index, a `diagOnly` flag and
  the `acceptedButNotInBinary` list.
- `data/server-keys.json` — 58 `server.json` keys with type, default and source tag, plus the
  undocumented fields from section 5.7.
- `data/manifest.json` — every document and skill with line count, byte size, build pin,
  hash, language and EN↔RU pairing.
- `data/build.json` — the hand-written build pin and the invariants the generator checks
  itself against. The only non-generated file in `data/`.

### Added — validation

- `schemas/server.schema.json` — a draft 2020-12 JSON Schema for `server.json`, usable with
  any validator, strict on unknown keys (including the 1.6.0.119 fields that are not publicly
  documented, so a working config still passes).
- [`tools/validate-server-config.mjs`](tools/validate-server-config.mjs) — validates a real
  config with three severities: **errors** (the server would refuse the file), **warnings**
  (the server starts but clamps or ignores the value — a bad port, an over-long name,
  `fastValidation: false`, an unreachable `publicAddress`, RCON on `0.0.0.0`), and **notes**.
  Beyond the schema it resolves the `scenarioId` GUID against `data/scenarios.json` (catching
  a GUID pasted onto the wrong scenario), names the replacement for every pre-0.9.8.73 field,
  checks `missionHeader` keys against the chosen scenario's header class, and applies the
  `supportedPlatforms` combination table.
- [`tools/check-schema-coverage.mjs`](tools/check-schema-coverage.mjs) — fails if a key
  documented in section 5 of the guide is missing from the schema or vice versa, if a `$ref`
  dangles, or if the objects derived from section 5 stop rejecting unknown keys.
- `tests/run-tests.mjs` with 9 fixtures — asserts exact error and warning counts per fixture
  and pins the wording that matters.

### Changed

- [`tools/validate-doc-json.mjs`](tools/validate-doc-json.mjs) now checks **every** markdown
  file in the repository when called with no arguments, instead of requiring an explicit file
  list. Existing explicit-file usage is unchanged. This removes the need for a shell glob,
  which npm scripts cannot expand portably on Windows.

### Fixed

- **The startup-parameter counts now match the tables.** §0 and §7 of
  `docs/en/ArmaReforger_StartupParams_EN.md` (and the Russian version) claimed 14 absent
  parameters out of 70 described in the wiki; the reference tables yield **13 absent** and
  **70 names** (69 parameters, `-AILimit`/`-aiLimit` being two spellings of one). Both
  statements were corrected, and the generator now compares the claimed total against the name
  count rather than the row count, so the check agrees with the corrected prose instead of
  warning about it.
- **`-noSplash` has a reference row.** It was listed as absent in §7.1 with no entry in the
  tables of §2–§6, so it could not be looked up or confirmed. It now has a row in §4 stating
  plainly that the wiki gives no description for it. No behaviour was invented for it.
- **The validator no longer overclaims about old field names.** It asserted of all eleven
  pre-0.9.8.73 names that the string "does not occur at all" in the pinned binary — the
  documents establish that for the four `gameHost*` names only. The message now separates the
  four verified cases from the rest, which say only that the name is documented as the old one.
- **`-ExecutionPolicy Bypass` documented, and the scripts say why.** `powershell -File
  tools/probe-keys.ps1 ...` — the invocation §8 recommended — fails outright on a stock Windows
  setup ("is not digitally signed"), reproduced while re-checking the build below. Both language
  versions now give the working form, and both PowerShell tools carry a header explaining it.
- **A BOM-writing hazard in `extract-guid-table.ps1`.** `Set-Content -Encoding utf8` writes a
  UTF-8 BOM under Windows PowerShell 5.1, which silently violates this repository's no-BOM rule
  for any artifact it produces. It now writes through an explicit `UTF8Encoding($false)`, and
  [CONTRIBUTING.md](CONTRIBUTING.md) documents the wider trap: Windows PowerShell decodes a
  BOM-less UTF-8 file as the ANSI code page, so a `Get-Content`/`WriteAllText` round trip turns
  every `—` into three mangled characters without failing. That is how `CONTRIBUTING.md` itself
  was corrupted once while this change was being written; it was rewritten, and every file in the
  repository is now checked for the residue.

### Added — verification against an installed build

- [`tools/verify-against-install.mjs`](tools/verify-against-install.mjs) — checks an installed
  server against the documents: the build version against the pin, all scenario and terrain GUIDs
  against the installed `resourceDatabase.rdb`, and the absent-parameter and obsolete-field-name
  claims against the executable. Its RDB parser self-checks against the 8 wiki-published GUIDs
  and refuses to report a GUID comparison if that fails, and its string-search results are only
  believed if a control set of known-present names is found. Needs no PowerShell, no arguments
  beyond an optional `--server-dir`, and exits non-zero on drift.

### Re-checked against a newer build

The documents are pinned to 1.6.0.119; the build installed on this machine is **1.8.0.13**. What
was re-checked mechanically, and recorded in `data/build.json` under `recheckedOn`:

- **all 42 scenario and terrain GUIDs unchanged** in that install's `resourceDatabase.rdb` — the
  first test of the documents' claim that GUIDs survive patches, run on a build two minor
  versions later;
- **all 13 absent startup parameters still absent** from that executable, and the four
  `gameHost*` names still absent;
- **one item left unresolved**: `playerCountLimit`, `supportedGameClientTypes` and
  `dedicatedServerId` *do* occur in the 1.8.0.13 executable, inside a name pool that also
  contains `operating`, `a2s` and `rcon`. Whether the config schema still accepts them is not
  established by a substring search, and both the config guide and [AGENTS.md](AGENTS.md) now say
  so instead of implying the names are simply gone.

Everything else in `docs/` remains a statement about 1.6.0.119.

### Verified by running the server (1.8.0.13)

Four claims the documents had made from string searches were settled by launching the dedicated
server with purpose-built configs and reading its own log, using the new
[`tools/probe-config-schema.mjs`](tools/probe-config-schema.mjs). Each run takes about two
seconds, and the control config reached `JSON is Valid`, so acceptance is demonstrable in the same
environment as the rejections.

- **`dedicatedServerId` and `region` are accepted by the schema.** The guide claimed they "occur
  only in the backend-access code, but not in the server config schema", and the validator
  reported them as removed fields. A config setting either key reaches `JSON is Valid`, so they are
  undocumented fields, not obsolete names. Both are now in the schema and in §5.1 of the guide
  (English and Russian), and the validator no longer flags them — that was a false positive on a
  valid config.
- **`playerCountLimit` and `supportedGameClientTypes` are rejected**, along with the four
  `gameHost*` names and an invented key, and the log names the offender:
  `Param "#/game/playerCountLimit" is not allowed and must be removed.` This also confirms the
  validator's strict `additionalProperties: false` design, which until now had been an assumption
  rather than a tested one.
- **The failure vocabulary is not what the wiki quotes.** `Server Config file is Invalid - cannot
  start server!` is present in the executable — at offset `0x1A87640`, the same offset as in
  1.6.0.119 — but the server did not write it on any of the three failure paths observed. §9 of the
  guide now lists what it writes instead: a schema violation names the offending key and the schema
  branch that rejected it, an unparsable file gives `JSON parse error: <reason> (Line: N, Char: M)`,
  and a missing file gives `Unable to open server config file: <path>`. A schema violation or a
  syntax error makes the server end by itself within seconds. The symptom table was replaced in
  both languages, and §1 no longer presents the quoted string as the verdict.
- **The failing paths were separated.** The guide had one row for "the JSON did not pass the
  schema"; parsing failures, schema failures and unreadable files are three different diagnoses
  with three different messages, and the old row pointed at a string the server never wrote.

[tests/fixtures/documented-accepted.json](tests/fixtures/documented-accepted.json) pins the first
finding, so the validator cannot drift back to reporting those two fields as errors.

The probe tool needs to launch a game server, so it must run outside a sandbox: under one that
forbids creating named pipes the engine hangs before writing a single line, which is how this work
started.

### RCON transport settled: UDP

The last open question in the documents was whether RCON listens on UDP or TCP — the wiki states no
protocol, the BattlEye specification says UDP, a widely used container image publishes 19999 as TCP,
and the server's own line `[RCON] Init, Ip address=..., Port=...` carries no protocol information.
The guide therefore told readers to open **both** protocols as a precaution.

It was settled by running the server: a non-public config (bound to `127.0.0.1`, `visible: false`,
with `rcon.address` and `rcon.port` set) was started on 1.8.0.13 and its sockets inspected while it
ran.

- The RCON port was a **UDP endpoint owned by the server process**; there was **no TCP listener** on
  it, and a TCP connect to it was refused.
- The controls behaved as documented — the game port and the A2S port were UDP as well — which is
  what makes the negative result meaningful rather than an artifact of a weak method.

Consequences, applied in both languages and in both skills: the port table in StartupParams A.5 now
says UDP; the advice changed from "open both" to **"open UDP only"**, since an open TCP rule for
that port is attack surface rather than insurance; §1 and §7 of the RCON document say the transport
is settled; and the skill checklist that asked whether the protocol had been confirmed now asks the
opposite — do not report it as unconfirmed. The **packet format** was a different question and a
later one: it is recovered in *The RCON client stopped leaking its slot, and `probe` stopped lying*
below, which supersedes the warning against writing an RCON client from scratch.

### The vanilla key for the FIA faction, read out of vanilla's own header

`m_aFactionLimits` was documented with `US` and `USSR` only, and `m_sFactionKey` was described in
one line as "Faction key or ID" — so the third vanilla faction could not be looked up at all.
A content scan of `data007.pak` for that field found exactly two vanilla files that use it:

```
Missions/23_Campaign_Montignac.conf
Missions/23_Campaign_Western.conf
```

Both carry a single limit — `m_sFactionKey "FIA"` with `m_iFactionLimit 0` — which settles the
spelling (the key is `FIA`; the config that defines the faction is the differently named
`FIA_Campaign.conf`) and shows that vanilla uses this array as an on/off switch for a faction.
§3.1 and the source table of both language versions now state it, list `US`, `USSR`, `FIA` as the
vanilla keys, and explain where keys come from: the `Configs/Factions/*.conf` files that the
scenario's `.../FactionManager*.et` prefab instantiates. The reading of `0` as "no players" is
marked as the reading it is — only `-1` is documented as "no limit".

The files that define the faction remain **encrypted** inside the pak, so this was read from
headers that reference the faction, not from `Configs/Factions/FIA*.conf` themselves.
**Superseded:** the files were readable all along and the encryption was a reader defect — see
*Nothing in the `pak` was ever encrypted* below.

### What an omitted faction means, answered from the method body

The follow-up question — what happens to a faction left out of `m_aFactionLimits` — had a
source-level answer rather than a behavioural one. The body of `SCR_MissionHeader.GetFactionLimitMap()`
(same source the source table already cites) inserts only the listed keys and skips an entry whose
`m_sFactionKey` is empty, so an omitted faction has no entry and no limit to apply: it behaves as
`-1`, and `0` stays the only value that closes a faction. The keys are not validated either, so a
typo quietly does nothing, and because the method `Print`s each key while it builds the map, the
server log lists exactly the entries the header contributed.

Vanilla is the cross-check: in `23_Campaign_Montignac.conf` and `23_Campaign_Western.conf` `US` and
`USSR` are absent from the array while they are exactly the sides played there, and the one faction
vanilla wants out is the one it names. §3.1 of both language versions now says this, and the source
table marks the step from "no entry" to "no limit" as a reading of the code and of that usage, not
as behaviour observed in game.

What could not be established is now listed under "what this document does not contain": **who
consumes the map.** The scripts inside `data007.pak` are encrypted and a content scan for the
method name finds no caller among the readable entries, so the in-game refusal at a full faction
was never observed — and this change does not pretend otherwise.
**Superseded:** both halves of that were wrong — the scripts were never encrypted, a content scan
does find the caller, and it is `SCR_FactionManager.EOnInit()`; see *Nothing in the `pak` was ever
encrypted* below.

### The RCON client stopped leaking its slot, and `probe` stopped lying

The packet format was recovered earlier (BattlEye RCon v2, §1.1 of the RCON document); what this
change settles is the part of it that decides whether a client *works*: the sequence number, the
way out of the 45-second slot, and the keep-alive. All of it comes from the same kind of run — a
dedicated server 1.8.0.13, a non-public config with `permission: "admin"`, its own `[RCON]` lines
read against the client count of the following login.

- **`probe` reported a login failure without testing anything.** `--framings` was split with an
  unguarded `",".split()`, so the default empty value became `[0]`; no framing `0` exists, every
  one was skipped, and the summary read `0 of 0 framings authorized. Nothing was authorized: is
  RCON enabled, and is the password right?` — against a server whose password was correct and
  whose `players` answered in the same minute. An empty value now means every framing, an unknown
  one is a usage error, and silence is reported as silence: an explicit `0x00|0x00` is `DENIED`
  (that one *is* about the password), a full client list is named as such with the log line to
  check, and only then is the framing suspected.
- **A wrong sequence number is acknowledged and then ignored in silence.** The same `players` sent
  as `01 00` executed and answered; sent as `01 07` it came back as `01 07` and nothing else — no
  game command, no message, and not even the `Mismatched sequence number!` line the binary carries.
  The counter does not move either, so the next correctly numbered packet still works. An
  acknowledgement is therefore not a success signal, and `tools/rcon.mjs` now says so in its own
  header.
- **`@logout` frees the slot at once, and the packet it needs is known.** `0x01 | seq | @logout`
  makes the server log `[RCON] [CLIENT: 0] Received Protocol Command: @logout` and
  `[RCON] Client 0 logged out!`, and the next login is counted as `[1/4]` rather than `[2/4]`. The
  wiki's "the bytes `@logout` sends" is no longer an open question, and the RCON document no longer
  lists it as one. Every run of the tool now ends with it — `--no-logout` reproduces the old
  behaviour — and `probe` sends it between framings, so probing a server with `maxClients: 1`
  works. This is what the previous behaviour cost: four consecutive `players` runs against
  `maxClients: 4` filled the list, and the fifth, and every framing of the next `probe`, got no
  answer at all. The one part of it that the wiki claimed and this work had not tested was
  whether `monitor` may send it: it may. Three consecutive `players` runs on a `monitor` server
  with `maxClients: 1` were each authorized as client `#0` at `[1/1]`, with `Client 0 logged
  out!` freeing the slot between them — and the same server refusing `kick 1` with
  `missing permission 'kick 1'` is what shows the permission really was in force.
- **A permission refusal and an unknown command were counted as successes.** Asking a `monitor`
  server for `kick 1` or `ban list 1` answers `missing permission '<command>'`, and a keyword
  that is not a game command answers `unknown command '<text>'`; both arrive *after* `Processing
  Command: <command>`, so the tool saw a "Processing" note and an `0x01|seq` acknowledgement and
  reported `status: ok`, exit 0 — a refused kick looked like a completed one. Both texts are now
  in the failure set (exit 5, `--- done: FAILED` in the shell), and both are documented as
  command answers in the RCON document, where they were missing: they are the engine's, not the
  ban command's, which is why the source-based table had never listed them. The English values
  correspond to the `#AR-ServerCommands_PermissionError` and `#AR-ServerCommands_UnknownCommand`
  keys the binary carries. A third one was found the same way, reported by a user who typed `kick`
  and `ban` with no arguments and got `ok` back: **`invalid parameters '<command>'`** — the engine's
  rendering of the `PARAMETERS` result type, which the source had described as an empty answer
  because that is what the *command* returns. `kick`, `ban create` and `ban create 1` answer it and
  are now exit 5 too. One thing is deliberately *not* a failure on the strength of silence alone:
  `#restart`, which was observed sending `Processing Command: restart` and then nothing at all — so
  "only a Processing note arrived" cannot be the test. A bare `ban` is the opposite case and is
  handled as a parameter error of its own (see the last bullet of this section): it is answered with
  the help screen, not with silence. The
  binary carries all four literals in one table next to `RCONCommandHandler: Executing command
  {%s}.` (`missing permission`, `unknown command`, `the server is busy`, `invalid parameters`),
  composed with the command by `%s '%s'`; `the server is busy` is the only one never reproduced.
- **Ctrl-C in the shell did not log out.** The interface was created with `terminal: false`, and a
  readline interface only emits its own `SIGINT` in terminal mode — so Ctrl-C went to the process,
  where the shell had registered no handler at all: the process died on the default action and the
  slot stayed busy for 45 s. Fixed on both paths: a real terminal now gets `terminal: true` (line
  editing included) and the interface's `SIGINT`, and a non-terminal stdin is covered by a
  process-level `SIGINT`/`SIGTERM` handler. Both call the same `finish()` the `.exit` command uses,
  which logs out, prints what happened and exits 130; a second Ctrl-C is not caught and leaves at
  once, with `@logout` already on the wire from the first. A one-shot run interrupted with Ctrl-C
  now logs out the same way instead of sending a logout it does not wait for. The handler itself
  cannot be exercised by signalling the process from outside on Windows — Node maps a foreign
  `process.kill('SIGINT')` to `TerminateProcess`, so no handler runs — and was therefore verified
  by emitting the signal in-process: the shell logged `--- shell: interrupted (Ctrl-C)`, sent
  `@logout` (the server wrote `Client 0 logged out!`), printed the acknowledgement and exited 130.
- **The 45-second timeout was measured, not assumed.** Four clients authorized at 01:25:40,
  01:25:44, 01:25:48 and 01:25:51 were dropped at 01:26:28, 01:26:32, 01:26:36 and 01:26:39 — 45 to
  48 seconds later, in order. With the client list held full, `probe` reproduced the user-visible
  symptom both before and after the fix, which is how the two causes were told apart.
- **The keep-alive holds a session open.** An empty `0x01|seq` every 20 seconds kept one alive for
  80 seconds against a 45-second limit, after which `players` was still answered — which is what
  lets the new `shell` survive a pause. It is the specification's own rule, now verified on this
  build.
- **One grammar, one meaning of "no answer", and `.json` in the shell.** Three inconsistencies
  reported from use, all of them the client's rather than the server's. (1) `ban` and `kick` with
  missing arguments were a usage error (`2`) on the command line and the *server's* answer (`5`) in
  the shell — the same text meaning two things depending on where it was typed. The grammar now
  lives in one function that both paths call before a packet is sent, so `ban`, `ban create 1`,
  `ban remove`, `ban foo` and `kick` are `2` everywhere and nothing leaves the client; the server's
  help screen is still reachable through `cmd ban`, which deliberately skips the check, and there it
  is classified as a missing-parameter failure (`5`). (2) An unknown protocol command (`@foo`) was
  reported as success, because the server acknowledges every command packet with `0x01|seq` even
  when it does nothing with it. "No answer" is now decided by the *messages* rather than by the
  packets — `@foo` is `4`, with the difference spelled out — while `#restart`, which answers only
  with its `Processing Command:` note, still has a message and stays `0`. (3) `.json` toggles the
  machine-readable output mid-session, like `.raw`, moving the banner, the notes and the prompt to
  stderr so that stdout stays one JSON object per command.
- **The RCON skill now documents what the tool prints, and that documentation is checked.** How a
  result is reported was only discoverable by running the tool: the skill described the subcommands
  and the exit codes, not the shape of the output. It now has a section per mode — one-shot (the
  `host:port login:` header, `command:`, `ack:`, the messages with a table where a parsed list was,
  the `logout:` line), `shell` (the same, plus the four shapes of the `--- done:` end-of-output line
  and the rule that the shell exits with the status of its last command), and JSON (`--json` prints
  one object and nothing else; shell JSON is one object per command with the notes on stderr) — with
  an annotated example of each and a field table for a consumer. The JSON shapes are also a real
  file, [`schemas/rcon-result.schema.json`](schemas/rcon-result.schema.json), and
  [`tools/check-rcon-schema.mjs`](tools/check-rcon-schema.mjs) (`npm run check:rcon-schema`, part of
  `npm run check`) validates the examples in the skill against it and fails if the schema stops
  rejecting what it should — the same relationship `docs/en/` has with `data/`. The check takes a
  file argument, and was pointed at captured output of a real run (one-shot result, plus shell lines
  for a player list, a ban list with a parsed page, a failure and a usage error) to confirm the
  schema matches the tool and not only its own documentation. Writing the negative cases paid for
  itself immediately: they caught the validator resolving a bare `$ref` pointer to nothing and
  passing every instance.
- **The player and ban lists are now tables wherever they are asked for, and parsed values in
  JSON.** `players` used to print the server's own lines and then a second, separate table *after*
  the logout note — and in `shell` it printed no table at all. Both answers that carry a list
  (`#players`, `#ban list`) are now parsed and rendered as a table **in place of the messages they
  were parsed from**, in the shell and in a one-shot run alike, with `Processing Command: …`, errors
  and `Server has no bans to list.` still printed as they arrive; the ban table keeps the server's
  own `Total bans: N | Page: X/Y` line above it, since the page count is stated nowhere else. In
  `--json` (and `.json` in the shell) the raw `messages` stay and the parsed value is added next to
  them, both at the top level and inside the `commands[]` entry it came from: `players` as an array
  of `{ playerId, uid, name }`, `bans` as `{ total, page, pages, entries }` with `entries` an array
  of `{ identityId, name }`. The two formats were taken off the wire (a ban created by `identityId`
  to make the list non-empty, then removed) and the parsers were also exercised against a stub
  endpoint so that a *non-empty* player list could be checked without a player joining.
- **A failed login in `shell` printed a Node stack trace.** Every other subcommand reported a wrong
  password or an unanswered server as one line on stderr with exit `3` or `4`; `shell` called
  `login()` outside any handler, so the same failure came out as `Error: no answer to the login …
  at Rcon.login` and Node's exit code `1`, with the banner about to be printed as if the session
  existed. The login is caught and reported like the rest (the banner now comes only after it
  succeeds), and a top-level catch turns anything else that escapes a subcommand into the same
  one-line form. Two neighbours were fixed with it, both of the same kind: `probe` had no socket
  error handler at all, so an unresolvable host produced an uncaught `'error'` event — it now says
  `None of the framings could even be sent: getaddrinfo ENOTFOUND <host>`, and a socket problem
  during login is named instead of being reported as one of the four silent causes; and an
  out-of-range `--port` went straight to the socket, which threw from inside `send` — numbers are now
  refused before anything is opened (`--port` 1..65535, `--timeout` ≥ 1, the waits ≥ 0) with exit `2`.
- **`shutdown` froze the shell, and Ctrl-C after it crashed.** Two faults in the client, both from
  use. (1) `#restart` and `#shutdown` were observed answering with their `Processing Command:` note
  and nothing else, but the client treats a lone "Processing …" as a sign that the real answer is
  still coming and waits out the whole `--timeout` for it — twenty seconds during which the shell
  looks hung, and with `shutdown` the server was already gone when the wait ended. Neither command
  is waited on any more, the status line is printed (including for `shutdown`, which used to be
  swallowed by the exit path), and a `shutdown` the server accepted now ends the shell the way it
  ends a one-shot run: no logout, because there is nobody left to answer one. (2) Ctrl-C during a
  command in flight closed the readline interface and then let the command finish and ask that
  closed interface for the next line — `ERR_USE_AFTER_CLOSE: readline was closed`, with the user's
  terminal left in the shell. The exit path is now a single shared promise that any caller can
  start, an interrupt sets a flag the waiting loop checks so the wait ends at once, the status line
  is skipped when the exit is already under way, and the prompt is not written to a closed
  interface. Verified on 1.8.0.13: `restart` and `shutdown` returned in ~2 s, a `shutdown` in the
  shell printed its status line and left with `--- shell: no @logout — the server is shutting down`,
  and a signal fired 300 ms into a command exited `130` with `Client 0 logged out!` in the server's
  log and no stack trace.
- **`shell` was added**, because the tool had no way to run several commands in one session. Every
  command ends with a `--- done:` line carrying the status, exit code, message count and time: the
  server sends an answer as several `0x02` messages and has no end-of-output marker of its own, so
  the client has to supply one. `.help`, `.exit`, `.raw`, `.keepalive` and `.reconnect` are local;
  `--json` emits one object per command instead, with the banner, the notes and the prompt moved to
  stderr so that stdout stays parseable. `.reconnect` logs the old session out first, for the same
  reason `probe` does.
- **A bare `ban` is a parameter error, and `@logout` typed by hand leaves the shell.** Both came
  back from use rather than from the documentation. The server answers `ban` — and `ban foo`, and
  `ban help` — with the command's help screen: a real answer, but nothing was banned, so the client
  now reports it as a missing-parameter failure (exit 5) with a one-line reason while still showing
  the help, and its own `ban` subcommand refuses the bare form before connecting at all (exit 2,
  naming the three subcommands). Typing the `@logout` protocol command into the shell used to do
  exactly what it says — the server ended the session — and leave the shell running on a
  de-authenticated client, where the next command could only collect silence; it now leaves the way
  `.exit` does, and a logout sent as a `cmd` argument no longer makes the client send a second one.
  An unknown protocol command (`@foo`) is acknowledged and then answered with nothing at all: the
  status line says so, because "something came back" would otherwise read as success.

Both language versions of the RCON document, §5.3 of the config guide, `data/build.json`, and the
two RCON skills now carry the findings; `skills/arma-reforger-server-config` no longer says the
message format is undocumented.

### Nothing in the `pak` was ever encrypted — the reader was 56 bytes off

The documents described a whole class of game data as unreachable: "compressed `.c` and `.conf`
entries are encrypted inside the pak", quoting `incorrect header check`, plus a "read defect"
that returned stored entries cyclically rotated with a fragment of an unrelated file at the end.
Both symptoms have one cause, and it is not encryption.

A PAC1 entry's `offset` field is measured **from the start of the `.pak` file**. The tool that
produced those extracts measured it from the start of the DATA chunk body instead — 56 bytes
further in, that being 12 (FORM) + 8 + 28 (HEAD) + 8 (DATA header). So every read began 56 bytes
late: a zlib stream no longer starts with its header (`Z_DATA_ERROR`, read as encryption), and a
stored file comes back as a window into the middle of the concatenated DATA stream, beginning
mid-word and ending with the first bytes of **the next entry in the archive**. The un-rotation
helper written to repair that stitched the missing head in from that neighbour, which is how the
resulting files kept a plausible first line while their `World` GUID belonged to a different
scenario. Reproduced deliberately with `--data-relative` in the new tool.

[tools/pak.mjs](tools/pak.mjs) replaces `tools/pak-tool.mjs`, `tools/unrotate.mjs` and
`tools/repair-rotated.mjs` (all three removed). It reads from the start of the file, parses and
bounds-checks the index, handles both storage forms (`0` stored, `0x106` zlib) and refuses to
guess at any other `compressionType`, decodes the reserved field and the trailing little-endian
pack timestamp, and offers `info`, `list`, `tree`, `get`, `cat`, `find` and `verify`. `verify`
reports which offset base the archive in front of it actually uses; on the installed 1.8.0.13
archives (23 files, ~408 000 entries) that is absolute, with 64/64 zlib headers at the indexed
offset and 0/64 at the DATA-relative one, and no problems — including 320/320 compressed entries
of the client's `core/data.pak` decompressed to the exact indexed length.

`tests/pak-tests.mjs` builds both layouts from bytes and pins the difference, so a regression
fails the suite rather than quietly corrupting an extract.

What the readable archive then settled, in both languages:

- **Three vanilla `World` GUIDs were wrong in print.** `27_GM_Cain.conf`, `23_Campaign.conf` and
  `23_Campaign_Arland.conf` carried the GUID of the entry stored after them;
  `23_Campaign_Cain.conf` was published as unreadable because its neighbour happened to be
  compressed. Re-read and cross-checked against `resourceDatabase.rdb`.
- **The rank containers read in full.** §3.3 of the MissionHeader document now carries the
  experience thresholds of `BaseMilitaryRanks.conf`, `FIAMilitaryRanks.conf` and
  `NonCombatantRanks.conf` (military `-51/-50/150/600/1200/2100/3300`, FIA `-21/-20/550/1100`,
  non-combatants `-101/-100`), the definition of `SCR_RankInfoCampaign` (found in
  `scripts/Game/GameMode/FactionManager/SCR_CampaignFactionManager.c`, not in `Ranks/`) with its
  four fields and their defaults, and the vanilla oddity that the FIA's `MAJOR` entry is named
  `#AR-Rank_WestCaptain`.
- **The consumer of `GetFactionLimitMap()` was found**, which the document had called impossible:
  `SCR_FactionManager.EOnInit()` combines the header's limit with `-playerLimits` by `Math.Min`
  and calls `SetPlayerLimit()` only when the result is at least 0 — the code-level confirmation of
  what `-1` and `0` mean.

[The game-data skill](skills/arma-reforger-game-data/SKILL.md) was rewritten around the new tool:
the format, the offset trap and the diagnostic order (verify the base before concluding anything
is unreadable or encrypted), the command list, and the GUID route through
`resourceDatabase.rdb`. Arma Reforger Explorer is demoted there from "the only way to read
scripts" to an independent second source for a different build.

### `Flags` measured box by box: two words with opposite senses

The entity's General section holds eleven flag boxes, and the file stores their state as the two `u32`
words of a `0x02` token. What those bits are cannot be read off a script: the generated
`scripts/Core/generated/Entities/EntityFlags.c` lists the same names in a numbering that does not match
— it puts `STATIC` at bit 7 (`0x80`) and the file writes `0x400`. So the mapping was measured the only
way it can be: one box changed in a project's World Editor, one save, one reading of
`worlds/arland_test_Layers/default.layer`, with a watcher recording every save so no observation was
lost, until all eleven boxes were mapped.

The two words mean **opposite things**. The first holds the boxes that are ticked, one bit each:

| ticked alone | stored |
|---|---|
| `Static` | `0x400` |
| `Feature` | `0x40` |
| `No Link` | `0x20` |
| `Streamable` | `0x100` |
| `On Filtered Navmesh` | `0x10000` |
| `Relative Y` | `0x80000` |
| `Editor Only` | `0x100000` |
| `Disabled` | `0x200000` |
| `Proxy` | `0x400000` |

The second holds the two that are **cleared**, a set bit meaning the box is off — the opposite sense.
Measured in all four states of those boxes: both ticked `0x4`, both cleared `0x7`, `Traceable` alone
`0x5`, `Visible` alone `0x6`, so `Visible` is `0x1` and `Traceable` is `0x2`. That reading was then
tested by prediction rather than assumed — a save made with only `Visible` unticked came back `0x5`,
which is what `Visible = 0x1` predicts. The `0x4` is constant in every state and no box of the panel
controls it, so it stays hex.

Three things this settled beyond the table. The words are **two different masks, not halves of one
64-bit value**; a box equal to the class default is **not stored at all**, so an entity with no `Flags`
line is at its defaults rather than carrying zeros; and the two guesses made on the way are both dead —
the "read the bit order off EntityFlags.c" one, and a "the second word is the mask of the boxes that
were touched" reading, which the constant `0x4` refutes.

The reader names all eleven now: the nine ticked boxes from the first word, `Visible off` /
`Traceable off` from the second, and anything left in either word as `+0x…`. Shipped values decode as
`0x80403 0` = `Static` + `Relative Y` + two unmeasured bits, `0x100003 0` = `Editor Only` + the same
two, and every vegetation instance `0 0x80000` = an empty first word and a second word with no panel
box behind it.

### The transform is three members, one of which was missing

An entity's Transformation panel shows Coords, Angles and **Scale**, and the file stores all three as
ordinary members of the entity's block. The reader reported the first two and left `scale` as just
another field; it is now part of the transform: `scale` on every entity and member node, default 1,
printed on the transform line the way the editor shows it. That default is not cosmetic — a value
equal to the default is **not written**, so `angles 0 0 0` and `scale 1` never appear and a member
without a `scale` is at 1, not at an unknown scale. 2 637 808 `scale` members are stored across the
shipped worlds; 816 of `Arland.ent`'s 2 271 nodes are not at 1.

That a panel value can be ahead of the file was observed directly: a hand-made entity read `Scale
2.200` in Workbench while its layer on disk had no `scale` at all, and saving the world added
`scale 2.2`. So "the editor shows it" is not evidence — the file is.

### Sub-components are a `components` list inside the component, not a bare class-and-GUID

A hand-made entity with no prefab, built in Workbench as a project layer, settled a rule this
repository had guessed wrong. `worlds/arland_test_Layers/default.layer` (text, 519 bytes) writes:

```cpp
SCR_BaseGameMode SCR_BaseGameMode1 {
 components {
  SCR_RespawnSystemComponent "{6AA37B0DFEF7C77E}" {
   components {
    SCR_FreeSpawnHandlerComponent "{6AA37B0DC66AC72F}" {
     m_bDestroyPreviousControlledEntity 1
    }
   }
   m_bEnablePauseMenuRespawn 0
  }
 }
 coords 2051.145 43.536 2060.131
}
```

So a component's own components are a **`components` member of the component** — the same keyword an
entity uses, one level down — and its own fields follow the list. The reader had been looking for a
bare `[class] [GUID] <block>` triple inside the component's block instead, which found nothing real:
it reported 10 "sub-components" across the whole corpus and every one of them was named `:`, while
the 57 components that do carry a list came back flat.

Now `componentEntry` takes the list from the member and `componentsOf` recurses into it, so a
component built out of components any number of levels deep is a tree. Measured over the 103 shipped
worlds: **57 components with a sub-component list, 140 sub-components** (`BaseVehicleNodeComponent` →
`ControllersManagerComponent`, `SCR_BaseHUDComponent`, `SCR_CarControllerComponent`; `DoorComponent`
→ `LadderComponent`), nesting one level deeper than a component. A class-and-GUID *without* the
wrapper stays what it is — a member's object value (`LinkType NavmeshDoorLink {…}`).

The same project also confirmed two things the reader already assumed: a world a Workbench project
saves is **text** (`arland_test.ent` is 65 bytes of `SubScene { Parent "{…}worlds/Arland/Arland.ent" }`,
with the content in a `.layer` beside it), and an entity created from scratch is
`[class] [id] <block>` with **no prefab and no `:`** — read as one entity carrying its transform,
which is what Workbench shows.

The fixture for this test now mirrors that layer byte for byte instead of a synthetic shape.

### `entities` no longer prints `scale undefined` for a group

A `$grp` node was built with `position` and `angle` but no `scale`, so the printer's `scale !== 1`
test was true for `undefined` and `num(undefined)` printed the word. A group header has no transform
of its own: it now carries the neutral `scale: 1` (position stays the first member's when the group
is not expanded, angle stays null), and the printer also refuses to print a missing scale. Pinned by
a test that runs the CLI on a group fixture and asserts the word never appears.

### A default can come from the class's attribute, not only from the prefab

The reader said "a value equal to the default is not written" and left the default to the prefab.
It is not only the prefab: `Attribute`'s constructor takes a `defvalue` and stores it in
`m_DefValue` (`scripts/Core/generated/Attributes/Attribute.c`), so a member's default can be the
attribute declared on it in the class definition, and `[Attribute()]` leaves that empty for the
engine to fill in — a class implemented in the engine can keep its default only in the binary. An
absent member is therefore "the default", not "zero", and a value missing from the prefab too has to
be read from the class (and its bases) rather than assumed. The game-data skill says so next to the
transform section, and `tools/ebin.mjs`'s header points there.

### Strict is the default: a file that does not tile is an error, not 99 %

`readEbin` used to resynchronise by default and report gaps; `--strict` was opt-in. That is the
wrong default for a tool whose claim is byte-exact: a damaged file came back "99.9 % decoded" with
the missing bytes in a list, which is the state that let a 56-byte-shifted `pak` reader survive. Now
`strict: true` is the default for the library and for every command, `--strict` is kept as an
accepted no-op, and **`--lenient`** restores the resynchronising pass for a file already known to be
damaged. `verify` and `info` exit 1 on a gap by default and print the coverage under `--lenient`.

The shipped worlds are unaffected — 103/103 exact, 0 gap bytes, 256 short lengths — and the tests
pin both directions now: the default throws at the offending offset, `--lenient` reports the gap and
exits 0, and `--strict` still does not turn an opaque block into a defect.

### The short block lengths are not a choice: a u16 that wraps, and a bound that lands inside a value

The entry below left the last 100 % described as *ambiguous* — "the engine writes block lengths
short by a few bytes, and where two short lengths contradict each other the reader has to choose".
That was the one claim in this work that rested on a preference, and it is wrong. The u16 after
`0x0e` is **not a delimiter**; it is a lower bound, and the corpus says so in three ways:

- **it cannot express a block over 64 KiB at all.** Twelve blocks are larger; seven of them store
  *exactly* `trueLength mod 65536` — the field wraps, and only the token stream can say where those
  blocks end.
- **256 stored lengths are short** in the 103 worlds (11 files). 189 of the recorded ends fall
  **inside a value** — `vec3`, `u64`, `f32`, `string`, `guid`, or a block's own header — a place no
  block can end. Of the 67 that fall on a token boundary, 53 are before a member name (`coords` 14,
  `angles` 15, `scale` 16, `Flags` 7, `Position` 1), 10 on padding before one of those, 3 on a bare
  value and 1 on a bare block: none can continue the record list it would be left in.
- **248 are the last child block's own doing**: that child's stored length is *exactly* its content
  and reaches past the parent's. The other 8 are enclosing blocks whose last child is itself short.

So there is no choice: a block's extent is its tokens' extent. The reader records the case as
`lengthShort` — `by`, the token the stored end lands in, whether the u16 wrapped, whether an exact
child forced it — `info` and `verify` print the counts, and the new `lengths` command prints every
one with its offset. Two parser gaps surfaced while pinning it: a scope whose last token is a leaf
now takes that token's end (it used to rewind to the recorded end), and a member whose id the
recorded end falls inside no longer stops a list extension. Coverage is unchanged:
**103/103 files exact, 100.00 % of 168 530 192 bytes**, and the node totals under the same options
are unchanged too — Arland 58 514, Eden 130 796, `MP/Coop_CombatOps_Cain` 12 405, `GM_Eden` 1 488
(with `--instances 2000`), identical before and after the two fixes.

### 103 of 103: the last 34 bytes were a member list that continued past its block

The last undecoded bytes in the corpus were in `MP/Coop_CombatOps_Cain.ent`, and the World Editor's
outliner for that world is what settled them. It shows `Ugoldar_Randomization_Arena` with seven layer
children — `Ugoldar_Hostiles_Randomized`, `Ugoldar_Bases_Randomized`, `Ugoldar_Patrols_Randomized` and
four more. The file wrote that list with a two-byte prefix and a **recorded length that ends after the
second member**, so the reader decoded two of the seven and then resynchronised inside the rest: 21
identifiers appeared twice, four layers landed outside the arena, and 34 bytes were left over.

Three fixes, each the same quirk seen from a different side:

- a **member list continues past the block's recorded end** while the bytes there are a named member
  (`[id] [block]`), and the block and every scope above it are widened to them — that is what puts all
  seven layers back inside the arena;
- the **list-behind-two-bytes reader lost its widening**: the block it decoded could tile past its
  recorded end, but the scope's limit was not raised, so the extension was dropped one level up — that
  is what fragmented the parent chain;
- a scope's failure can lie **inside a block already read whole**; the parse now continues after that
  block instead of resynchronising inside it, and tokens straddling a resync point are dropped.

Result: **103 of 103 files tile to their exact last byte, 100.00 % of 168 530 192 value-stream bytes**,
with no duplicates and no gaps anywhere. `Eden.ent`'s two blocks and this world's 34-byte span were the
whole of what used to be missing.

What remained at that point was not undecoded but *described as ambiguous*: the engine writes block
lengths that are short, and the entry above settles what they are — a lower bound, not a delimiter,
so there is no length to choose between.

### 100 % of the value stream: the last 92 612 bytes were a length that stopped mid-header

The two undecodable blocks in `Eden.ent` had been described as bytes that contradict their own recorded
lengths, which was true but useless. The bytes say something more specific: a scope's length stops two
bytes into its **last child's header** — `0e` and one length byte, with the third byte sitting after
the parent's end. The child's own length says where it ends, and the bytes after the parent's
end belong to that child, not to the parent's next sibling.

So the reader now re-parses such a scope widened to the child's own end, provided that end tiles
exactly. It does for both blocks, and one of them needed the two-byte instance-list prefix skipped as
well, which falls out for free because the repair sits in the scope parser itself.

Result at that step: **100.00 % of 168 530 192 value-stream bytes decoded, 102 of 103 files with no gaps
at all** (it was 99.95 %, 101 of 103). `Eden.ent` gained 21 606 tokens — 16 724 387 before, 16 745 993
now. `Coop_CombatOps_Cain.ent` kept its 34-byte gap for one more step, and why it closed is the entry
above.

One bug had to be fixed to get there: the repair re-parses a scope, so a failed attempt's tokens must
be kept when the scope finally fails (or a file loses its whole prefix while its coverage still counts
as decoded) and must **not** be kept when it succeeds (or the region lands in the tree twice). Tokens
that straddle a resync point are now dropped, since the resync re-reads them.

### A world is a tree, and a group's members are not all inside it

`entities` used to return a flat list in which a group was a separate record at the same level as
the entity next to it, and its members stopped at its own block. Both were wrong, and the World
Editor says so: the outliner nests a group under the entity it belongs to, groups nest several
levels deep, and the **same file reports 173 226 entities** where the reader produced 64 822.

The file had been read as a tree of blocks but not as a tree of *children*. It is the second: every
scope is a **child list**, the top of the file is the world's own, an entity's children sit in a
child list inside its body, and theirs in a child list inside theirs. `Arland.ent` is 4 levels deep,
`MP/Coop_CombatOps_Cain.ent` 8. Every node now carries `parent` — the index of its enclosing node —
so the tree is recovered from `--json` instead of inferred from indentation.

That change alone was not enough, because a group's member list is **not bounded by its block**:
when it does not fit, the remaining members follow *outside* it as sibling blocks, `[id] <block>`
pairs with no second header, and the parent's recorded length stops short of them — the "short
length" quirk seen from the other side. `Arland.ent` holds 63 644 members inside bodies and 108 078
outside them; with both, the world has **173 206** entity-and-member nodes against the 173 226
Workbench reports for the same file (20 off, 0.01 %), and without them it is 64 822, a third of the
world. 253 groups in the 103-file corpus overflow this way.

Three more shapes came out of the same reading:

- **compaction**: entities of one class and prefab are written consecutively and only the first
  names them, so `[id] <block>` after a record inherits both (`MP/Coop_CombatOps_Cain.ent` has 205);
- **sub-components**: a component's own components are `[class] [GUID] <block>` inside its block with
  no member name in front, while the same block with a name in front is that member's object value
  (`LinkType NavmeshDoorLink {…}`) — the name in front decides whether the node is a component or a
  field. A group inside a `components` block is read as a group of components; no world in the corpus
  has one, so that part is grammar, not observation;
- **a member's block is never a child list**: `Data { … }` is a struct-valued member of a
  `ShapePoint` (285 in `Eden.ent`), `RoadEntity { … }` is a road child of a road generator (434 in
  `Arland.ent`). Both are a name followed by a block; only the token in front says which — a value,
  or the list's boundary. Reading the first as the second invented 339 nodes in `Eden.ent`.

Corpus totals for 1.8.0.13 (103 worlds): **30 071 entities, 10 665 groups, 2 853 473 members** —
10 665 of 10 681 `$grp` headers reached, the 16 missing are inside `Eden.ent`'s undecodable 92 612
bytes. Coverage is unchanged at 99.95 % / 101 of 103 files exact, because none of this touched the
decoder: the bytes were already read, they were attributed to the wrong node.

`tests/ebin-tests.mjs` now pins the child-list shape, `parent`, a member list continuing outside its
body, a member with children of its own, the `Data`/`RoadEntity` boundary rule, and sub-components
against a member's object value; the synthetic nesting fixture was rewritten to the shape the files
actually use (children in a child list, not loose in the body).

### Worlds are a second binary format, and `tools/ebin.mjs` reads them

Everything in a `pak` is either text or a PAC1 entry — except the worlds. Every `worlds/**.ent`
starts with `EBIN` and is a value stream with its own container, which is why a `.ent` looked
like noise next to the prefabs (`worlds/**` is the only place the format is used: of the 19 551
`.et`/`.ent` entries in the installed archives, 103 are EBIN, all of them worlds, and every one of
the 19 448 `.et` is text).

[tools/ebin.mjs](tools/ebin.mjs) decodes it, and the file header of the tool states exactly what
is verified and how. The format was cracked in two passes: first the container and a flat token
stream, then — after the first pass decoded 47 of the 103 installed worlds exactly and the rest did
not — the two facts that make a world readable, which the first pass had wrong:

- the **container** is exact on all 103 binary worlds in the installed `addons/data` and
  `addons/core` — `"EBIN"`, a version, a name table (class names, field names, and syntax tokens
  such as `:` and `$grp`), and a table of 8-byte GUIDs holding **both** resources and component
  instance GUIDs;
- `0x0e` is not an integer of unresolved width but a **length-delimited scope**
  (`blockEnd = at + 1 + length`). Its content is tokens, a text payload (`BSP`), or a list behind two
  bytes; a block whose content is none of those is reported as `opaque` instead of being interpreted
  into invented records;
- `0x05` is the **GUID table index**, and it is how a record names its prefab. All 9 560 entity
  records that name a prefab resolve to a path, and of the 20 252 `:`+GUID+block constructs in the
  shipped worlds every one resolves (19 580 `.et`, 647 `.conf`, 25 `.ct`) — the difference between
  a list of class names and a readable scene;
- `0x8X` is a **typed array** (`0x81` i32, `0x86` f32, `0x87` vec2, `0x88` vec3, `0x8c` string,
  `0x8d` name, `0x85` GUID reference), confirmed by tiling: the elements consume the array exactly;
- `0x02` is **two 32-bit words**, not an unknown eight-byte value: every field that carries it is a
  bit mask, and the text form of the same object prints the same pair (`Flags 0x100003 0`,
  `LightType 0x40 0`, `Rendering 0x1d 0x20`). Verified against a prefab and the world that
  instantiates it;
- `0x07` is a **`vec2`**, found in the last undecoded blocks — `07 00 00 34 c2 00 00 34 42` is
  `-45 45`, and reading it took three files from 99.9 % to exact.

Result: **99.95 % of 168.5 MB of value stream decoded, 101 of 103 files with no gaps at all**, and
what is left is 92 612 bytes in `Eden.ent` plus a 34-byte span — payloads whose own bytes
contradict their recorded lengths. Getting there also needed three payload shapes to be read
instead of written off: `BSP` is ASCII (`<u32 nodeCount>` plus `nodeCount` × 4 integers, true for
all 19), a group's instances sit behind two bytes the reader carries but does not interpret, and a
parent length that is a few bytes short of its own last child is compensated because the child's own
length is exactly right. Those two bytes are not random: the first is a value of the prefab *in that
world* — constant for all 108 (world, prefab) pairs, different in another world for all 14 prefabs
that appear in more than one, and shared by prefabs that share a bucket (Arland: 10 prefabs, 5
values) — which is the shape of an index into a per-world material table; that reading is not
proven and is not used. `--strict` still refuses to resynchronise, and `info`/`verify` print the
coverage next to every result.

`entities` now reads the stream's grammar instead of its shape: a record is
`[class] [id] ":" <guidRef> <block>`, its children are the records in its block (real nesting, so
an area containing a task containing a slot comes back at depth 0/1/2), its components are the
class-and-GUID pairs in its `components` block, and `$grp <class> : <prefab> <block>` is a group of
instances. `--rdb` resolves the prefab of every record, so `CP_Kamensk` prints as an instance of
`ConflictControlPoint.et` at 11866.496, 8.292, 10679.665 — the transform Workbench reports. On the
HQC Kolguyev world it returns the control points and the HQ/source bases with their names, matching
the hand-extraction done before the tool existed; Cain returns 20 670 records instead of the
1 308 839 phantom entities the flat reading produced.

A member's value is read rather than summarised, because almost every non-scalar value is a block
and what is inside it parses: an array (`m_aIncludedEditableEntityLabels = [36, 37]`, 925 of them),
an array of objects (`m_aActivationActions`, 2 324), a nested object (`m_Getter` with its class and
GUID, 2 000), an empty value, or a plain struct. `name + value` is the append operator — the text
form writes `m_aWheels + { 4 5 6 7 }` for "append to the prefab's array" — and prints as `+=` so an
append cannot be read as a replacement. Only a block that did not tile stays a size, and it says
`opaque`.

The one thing stated in the output itself, because it changes what a reader may conclude: a world
stores **overrides**. `CP_Kamensk` has 22 components in Workbench and exactly one in the file,
because only that one has a property that differs from the prefab.

`tests/ebin-tests.mjs` writes a resource byte by byte and pins the container, every tag, the block
tiling, the record grammar, groups, nesting, opaque blocks, the resynchronisation behaviour,
`--strict`, and the error paths, so the format cannot drift unnoticed; it builds every block
through one helper that writes the length, which is what puts the layout itself under test.
The RDB lookup (`guids --rdb`, `readRdb`) is checked against the installed database —
`{9DF143A76F5C6460}` must resolve to `worlds/MP/CTI_Campaign_Eden.ent`.

### `pak.mjs get` no longer answers an uncreatable path with a false `ENOENT`

`get` reported `ENOENT: no such file or directory` for its output path while the parent directory
had just been created recursively — so the message named a missing directory that was not
missing, and creating it did not help. Measured on Windows (Node 25, 1.8.0.13 archives), the
cases that produce it are a path component containing one of `<>:"|?*`, a component longer than
255 characters, and a reserved device name: `mkdirSync` and `writeFileSync` fail with that same
`ENOENT`, and the `\\?\`-prefixed paths Node uses on Windows bypass the shell's own normalisation,
so the check has to be the tool's.

`describeUnusablePath()` (exported, and unit-tested with an explicit `platform`, so the Windows
rules are pinned from any host) inspects the **resolved absolute** path before anything is
written and names the component and the offending character, the length, or the device name;
`makeDirectory`/`writeOutputFile` wrap whatever the file system still refuses with the operation,
the resolved path, the errno and a hint for `ENOENT`/`EISDIR`/`ENOTDIR`/`EEXIST`/`EPERM`/`EACCES`.
`get` also prints the resolved destination it wrote to, rather than the argument as typed.

What this deliberately does **not** do is rename or skip the offending component: a plausible
substitute path would silently write somewhere the caller did not ask for.

### `pak.mjs get` extracts directories, and `<outFile>` follows the `cp -r` rule

A directory in the archive was invisible to `get`: the FILE chunk carries directories, but only
file entries were kept, so `get <pak> Missions out` answered `no entry "Missions"` — while
`cat`, `list` and `tree` behaved as if the path did not exist at all.

The index now keeps them (`pak.dirs`, the unnamed root excluded), `findTarget()` resolves a
virtual path to a file **or** a directory with the same exact-then-case-insensitive order, and
`get` walks `entriesUnder()` through the existing read path, so stored and zlib entries are
written alike. Measured on the installed 1.8.0.13 archives:
`get addons/data/data002.pak Missions out/pak-get-missions` writes **38 files (23 stored,
15 zlib) and all 38 compare byte-identical** to the same entries read directly.
`cat` of a directory now refuses with an explanation instead of claiming it does not exist, and
a directory asked to land on an existing file says so.

`<outFile>` follows the `cp -r` rule the usage now states: an existing directory, or a path
ending in a separator, means "inside it, under the entry's own name" (`get <pak> Missions out/`
→ `out/Missions/…`), and anything else is the destination itself with parents created. One rule
for files and directories alike, so `get <pak> <file> out/` and `get <pak> <dir> out/` agree.
`--verbose` prints every file of a directory as it is written; the default is one summary line
with the file count, the bytes and the codec mix.

The skill's §1 records the rule and the refusal behaviour; `tests/pak-tests.mjs` adds the
directory cases (subtree only, case-insensitive match, into an existing directory, trailing
separator, a directory onto a file, `--verbose` against the summary line, `cat` of a directory)
and the library-level `pak.dirs` / `findTarget` / `entriesUnder` checks.

### `/` is the archive root, so one command dumps a whole pak

A virtual path of only separators had no meaning: `get <pak> / out` normalised to the empty
string and answered `no entry or directory ""`, with the nearest-match list pointing at whatever
happened to end in a slash. The root is a real node in the FILE tree — it is simply the one
directory with no name — so `findTarget()` now returns it for an empty path, `entriesUnder()`
already treats the empty prefix as "everything", and `get` walks the whole archive at its own
paths. Measured on the installed 1.8.0.13 archives: `get addons/core/data.pak / out/pak-root-probe`
writes **939 entries / 18.8 MiB unpacked (320 zlib, 619 stored) and all 939 compare
byte-identical**, with no file on disk the index does not list.

The root has no name of its own, so the `cp -r` rule resolves to the destination itself and
nothing is nested under an empty component; `///` is the same root. Messages name it `/` rather
than `""`. A full dump is deliberately left as a deliberate act: `worlds001.pak` is 51 523 entries
and **5.58 GiB unpacked**, which the skill now says next to the command, since `list` and `find`
answer most questions by reading in place.

The synthetic suite covers the root (every entry at its own path, the summary line, `cat` of the
root, `///` into an existing directory) and adds a fixture with dot-directories
(`scripts/.NavData/GM_Eden/...`), because the vanilla archives nest those and a dump has to
recreate them.

### `ebin.mjs`: every refusal names its cause, and `--json` means JSON

Stressed as a library and as a CLI — the 103 installed worlds, then 32 000 mutated and synthetic
inputs — the reader had two ways to fail without a diagnosis, and the CLI had several ways to
answer a different question than the one asked.

- **A five-byte file could hang it.** `0x80` is an array of zero-width elements, so its u32 is a
  count with no bytes behind it; the reader looped `count` times, and 2^32-1 elements never
  finished. It returns the count and the first 256 `null`s at once now.
- **A u16 taken from a truncated value could point past the file.** Widening a scope to that
  offset read outside the buffer and threw Node's `RangeError`; the widened end must be a real
  offset in the file, and otherwise the block is the opaque payload it looks like.
- **3 000 nested blocks overflowed the stack.** Nesting is capped at 512 — the deepest shipped
  world is 8 — and past it the block is reported opaque with the cap in the gap, so `--lenient`
  keeps everything above it.
- **Three impossible values were accepted and reported as an exact file**: a `0x0e` length of 0 or
  1 (the field counts its own two bytes; exactly 2 is the empty block), a version other than 1
  (all 103 worlds are 1), and an array element whose name or GUID index is outside its table (it
  is a gap naming the element and the table now, because a value block that does not tile is
  opaque by design).
- **The CLI swallowed mistakes.** `--filte X` read as no filter at all, `--limit abc` as every
  row, `--from abc` as none, `--instances abc` as no expansion, a missing value for
  `--filter`/`--rdb`/`--limit`/`--from` as the default, and `find` with no needle died with a
  TypeError. Each fails with the option and the value named, and `--help` exits 0.
- **`--json` was accepted and ignored** by `names`, `guids` and `find`, and `lengths --json`
  changed shape between one file and two. All four answer consistently: `{ file, total, … }`
  envelopes for the first three, always an array for the file-list commands.
- **`--rdb` never resolved an array of GUID references** — the text form dropped the rdb before
  printing it — and `--filter` did not look inside arrays at all. Both do; `--json` gains `paths`
  per value.
- **`readEbin` only took a path**, so a pak entry had to be written to disk before it could be
  read. It takes a `Buffer`/`Uint8Array` too, with `name` labelling it in errors.

Measured after the changes: all 103 worlds still tile to their last byte (**168 530 192
value-stream bytes**, 101 + `Cain.ent` + `Eden.ent` re-run separately with an 8 GB heap), 32 000
fuzzed inputs produce only described `Error`s (19 212 throws, none a `RangeError`, none a hang,
27 s total), and `Cain.ent` — 19 803 563 tokens — reads in ~3 s. The skill's §3 documents the new
JSON shapes, the array `paths`, the nesting cap and the memory cost; `tests/ebin-tests.mjs` pins
every fix with a fixture.

### The GUID table is its own tool, and it reads a record's length

`readRdb` lived in `tools/ebin.mjs` as a forty-line scanner that took every run of printable
bytes before a NUL for a path. It is now [`tools/rdb.mjs`](tools/rdb.mjs) — the library
(`readRdb`, `scanRdb`, `reverseRdb`, `verifyRdb`) and a CLI (`get`, `guid`, `list`, `info`,
`verify`, as `npm run rdb`) — and `ebin.mjs` imports the map its `--rdb` resolves through.

Writing the CLI against the installed database showed the scanner was wrong in three ways at
once. The u32 in front of every path is the record's own length, **the NUL counted**; on the
client's copy, requiring it turns 98 363 accepted records with 98 362 distinct GUIDs into
**98 598 with 98 598**, because 10 of the old records were another table's bytes (`hqy.MA4`,
whose "GUID" was the ASCII tail of the next path) and 244 real resources were being refused for a
space in the path. The scan also stopped 24 bytes short of EOF, dropping
`worlds/Tests/TestFramework/empty.ent`. `verify` makes the 8 published wiki GUIDs a command, so a
layout change is a mismatch rather than a plausible wrong path, and it reports a mapping that is
not one-to-one instead of letting the `Map` drop a path. `tests/rdb-tests.mjs` pins the layout,
the false positive, the space, the last record, the duplicates and the CLI; the ebin fixture,
which had no length field at all, now has one. `verify-against-install.mjs` reads through the same
library, and on 1.8.0.13 its report is unchanged: 6 findings, 42/42 GUIDs, 8/8 wiki pairs.

The two installed copies of the database are not the same file: the client's holds 98 598 records
and the dedicated server's **98 755**, each one-to-one, each 8/8. The framing word differs too —
`06 00 00 00` in most of the client's records and `16 00 00 00` in a third of the server's — so
`info` and the skill report the distribution rather than a constant.

The skill's §4 and the two documents that point at the GUID table now lead with `tools/rdb.mjs`
and keep `extract-guid-table.ps1` as the older path-prefix script, which does not check the
length field.

### `ebin --rdb` checks the database before it trusts a path

`--rdb` resolved through `readRdb`, which returns the map and nothing else: the published-GUID
guard existed in `rdb verify` and in `verify-against-install`, but the command that actually
prints prefab paths never ran it. Every `--rdb` use now scans with `scanRdb` and runs `verifyRdb`
first, so the database must reproduce the 8 published GUIDs and its mapping must be one-to-one
before a single path is printed.

A database that fails is refused — exit 1, naming either the published path whose GUID differs
(the layout contradicting itself), the absence of the vanilla GUIDs (a mod's copy, or a fixture no
longer shaped like the real file), or the duplicate that would be dropped. `--no-verify` is the
deliberate exception, in the same spirit as `--lenient`: a mod's `resourceDatabase.rdb` does not
contain the vanilla resources, so reading it is legitimate when that is known — and impossible to
confirm.

The annotation fixture in `tests/ebin-tests.mjs` now carries the 8 published records, so the
ordinary `--rdb` cases exercise the passing check; three new cases pin the refusal, its message
and `--no-verify`. The skill's §3 says the check runs before the output, and §4 cross-references
it.

### The database is a container, and the published GUIDs are a fixture

`verify` treated the 8 GUIDs published on the BI wiki as the definition of a valid
`resourceDatabase.rdb`, and `ebin --rdb` refused anything that did not reproduce them. That is a
fixture, not a format check — and it hid the fact that the reader never parsed the file it was in:

```
FORM | u32BE size - 8 | RDBC | u32LE version | u32LE size | ...
```

Every copy checked — the client's, the dedicated server's and six workshop addons' — carries this
prologue, version 7, with both sizes agreeing with the file. The reader ignored it and carved
records out of the bytes, so a **2 MB prefix of a database parsed as 19 837 valid records** and
answered "not found" for everything after it: the silent wrong answer this tool exists to prevent.

`scanRdb` now checks the prologue and refuses a truncated, padded, foreign or wrong-version file
by name and numbers, and the scan starts after it. `verifyRdb` separates the two questions: `ok`
is structural (header, one-to-one, non-empty) and holds for any database; `vanilla` is the 8
published pairs, reported as `8/8`, as `0/8 — not the vanilla database`, or as a contradiction
when a published path carries another GUID. A workshop database is read without a flag, which is
what `--no-verify` was for; the flag is gone.

The 8 pairs still matter, and the header now says what they are: the only external evidence for
the GUID's position inside a record. Two checks that use no hardcoded value agree with that
position on 1.8.0.13 — the `{GUID}path` pairs written in the game's own text resources (132 843
references in data007.pak: 132 699 exact, 3 stale references in the game's data, 136 paths absent,
5 case-only), and the client's and server's copies agreeing on all 98 590 paths they share,
including all 33 119 of the server's kind-22 records that the 8 pairs never touch.

`tests/rdb-tests.mjs` and the ebin fixture now build the container; truncation, a foreign magic, a
wrong version, a workshop database, a contradiction and an empty database each have a case.
`verify-against-install.mjs` requires the pairs to be *present*, because it reads a vanilla
install; on 1.8.0.13 its report is unchanged (42/42 GUIDs, 8/8 pairs).

### The database parses end to end, across versions 5, 6 and 7

The reader above still carved records out of the bytes after checking the prologue; the header's
own content was unread. It is now parsed: `flags`, a **name table** (version 6 and 7), a
**record count**, the root record, then every record back to back. The count and the file's last
byte are both required to match, which is what turns a plausible chain into a checked parse.

That closes the remaining gaps, each measured:

- **228 copies checked** — the client's and the server's data and core databases and 224 workshop
  addons' — now parse, all to their exact last byte. Three versions occur and all are handled:
  **7** (the installed build), **6** (current Workshop content, 51 copies) and **5** (old Workshop
  content, 1 copy). Version 5 has no name table and a nonzero root GUID; version 6's files carry
  two `[mtime, type]` pairs where version 7's carry one, and version 5's carry three raw words.
  The metadata length is not assumed: the parser takes the first of 0/4/8/12/16 bytes that is
  followed by a record or by the end of the file, and the record after it validates the choice.
- **The map was missing real records.** The old printable set refused 12 entries with `@ ! # ( ) +`
  in the name (`pc_buttons@2x.edds`, `Material_#29.emat`, …), and the "must contain a dot" rule
  dropped all 11 816 directories and 151 groups. Both are fixed wholesale: the path range is all
  printable ASCII, and directories, groups and scripts are entries. The client's map grows from
  98 598 to **110 576**, the server's to 110 728.
- **The kind word is decoded**: base types 4 script, 5 directory, 6 file, 7 group, plus flag bits.
  On the server, all 35 461 kind-21/22/23 records are resources whose files are in none of its
  paks — `0x10` means "known but not shipped in this build"; 9 Cain vegetation prefabs carry
  `0x10000`.
- **Duplicates are data, not a parse failure.** 14 of the 228 databases reuse a GUID (a mod
  packaging fault); `verify` reports `duplicateGuids`/`duplicatePaths` and `unique: false`, keeps
  the first record deterministically, and reads the file. The installed databases are one-to-one.

The evidence is reproducible: `tests/rdb-tests.mjs` rebuilds the container for every case, and
when the game is installed it repeats the independent check — 132 843 `{GUID}path` references in
`data007.pak`, **132 781 exact**, the rest three stale references in the game's data, twelve case
or rename differences and references to addons that are not installed — and both installed copies
agree on all 116 375 records they share. `ebin --rdb` benefits without changing: prefabs,
directories and the odd-character paths now resolve, and a workshop database is read without a
flag.

### A component group no longer crashes `entities --rdb`

`annotate()` assumed that every entry of a world's `components` list has `fields`. A `$grp` inside
that list is a **group** — it carries `components` of its own and no `fields` — so `entities --rdb`
died with `Cannot read properties of undefined (reading 'map')`, with no file, node or offset in
the message, in the text form and in `--json` alike: the annotation runs before either branch, so
one such world made every `--rdb` answer unavailable.

The entry is now annotated by its own shape. No shipped world carries one — 0 across the 103 worlds
of 1.8.0.13, which is why the tool's header calls it grammar rather than observation — so
`tests/ebin-tests.mjs` builds a `$grp` inside a `components` list and pins both the `--json` and the
text answer.

### A sub-component's members are annotated and searchable

A component built out of components keeps its real members one level down, in its own
`components` list: 57 components, 140 sub-components across the 103 shipped worlds. The text printer
reads the database while it formats, so it always resolved a sub-component's resource-valued member
in place; `annotate()` and `--filter` looked at the top-level component only. The same world
therefore answered two ways: the text showed the path, `--json` had `guid`/`index` and no `path`,
and `--filter` found neither the sub-component's class, nor its member, nor the path — on
`Scenario04_Sabotage.ent`, `--filter MagazineTemplate` and `--filter MuzzleComponent` both returned
0 nodes while 10 weapons carried that sub-component.

`annotateComponent()` now recurses into `subComponents`, and `--filter` walks them with the same
class/member/value/path test it applies everywhere else. Verified on that world: both filters return
10 nodes, with and without `--rdb`. All 21 of the resource-valued members in the corpus are the zero
GUID — a path that resolves to nothing — so the fixture in `tests/ebin-tests.mjs` carries a
sub-component whose member resolves to `Prefabs/Test/Spawn.et` and pins the `--json` path, the text
line, and the four `--filter` routes (class, member, GUID, path). The skill's §3 and §5 say the same.

### The `--rdb` mapping check says what it does

`loadRdb` called `verifyRdb` and returned as soon as `ok` was true, then — on the false path —
collected a "the mapping is not one-to-one … so a duplicate was dropped" problem. After `4f0d9c3`
made `ok` structural (records present, no published contradiction), that clause became
**unreachable on its own**: `unique: false` always went through the early return, so a database that
reuses a GUID was read silently, while the function's docstring, `--help` and the test's own comment
said it was refused. Measured with a two-record database that repeats one GUID: `rdb verify` exits 0
and prints its note, `ebin --rdb` accepted it without a word.

The refusal path is now the one `verifyRdb` defines — the file did not parse (refused by
`scanRdb`), it has no records, or a published path carries another GUID — and a non-one-to-one
mapping is **reported** on stderr instead: `2 record(s) map onto 1 GUID(s) and 1 path(s)`, the map
keeps the first of each. That is the database's own ambiguity (14 of the 228 measured copies have
one), and the note is the difference between a path and a path that may belong to the other record;
it goes to stderr so `--json` on stdout stays parseable. The docstring, `--help` and both test
comments now say this. `tests/ebin-tests.mjs` pins the exit status, the note, the first-record path
and a parseable stdout; the heading in `tests/rdb-tests.mjs` that said "duplicates are refused by
verify" now says what its assertions say.

### A path a database does not carry is not "not a resource"

A GUID the database does not name was reported as a fact about the resource: `entities` printed
`<- not a resource` next to every prefab, `guids` closed with "N of M entries name a resource; the
rest are component instance GUIDs", and `resources` printed "no resource names in the GUID table".
All three are false for a database that is a **subset** — and those databases pass every check,
which is now deliberate: `addons/core/resourceDatabase.rdb` (1 193 records, 434 with a GUID) and a
mod's copy carry only their own resources. Measured: `Eden.ent` read with the core copy printed
`<- not a resource` for all of its 268 table entries, every one of which the data database resolves.

An unresolved entry is what the reader can actually establish, so it now says so: `entities` prints
`<- not in this database`, `guids` counts the entries that **resolve through this database** and
says the rest are either component instance GUIDs or resources it does not carry (with the subset
hint when none resolve), and `resources` says no GUID-table entry resolves through it rather than
that nothing in the table is a resource. The skill's §3 has the rule and the trap, and §4 stops
claiming `path: null` means "not a resource". `tests/ebin-tests.mjs` pins all three messages against
a database that names none of the fixture's GUIDs.

