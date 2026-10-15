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

### Known discrepancies, recorded rather than papered over

Surfaced while generating `data/`, and left in the documents deliberately — they are
documentation defects, not data defects:

1. `docs/en/ArmaReforger_StartupParams_EN.md` §0 and §7 claim **14** absent parameters out of
   **70** described in the wiki; the reference tables yield **13** distinct absent names and
   **68** entries (69 names counting the alias). The likely cause is `-enableNightGrain` being
   counted together with its pre-1.6.0.76 name `-forceDisableNightGrain`.
2. `-noSplash` is listed in §7.1 as absent but has no row in the reference tables of §2–§6, so
   it cannot be confirmed from the data.

`npm run check:data` prints both as warnings on every run. See
[AGENTS.md](AGENTS.md#known-open-issues--verified-discrepancies-do-not-fix-them-silently).
