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
