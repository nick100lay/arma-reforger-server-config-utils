# Editing the documents

These conventions are what make the English documents convertible into
[`data/`](data/build.json) by [`build-data.mjs`](tools/build-data.mjs). A document that
breaks them does not break the build silently вЂ” the generator warns or refuses вЂ” but it does
cost someone a debugging session.

## Source tags: every claim carries its provenance

Three tags, used inline and in table cells:

| Tag | Means |
|---|---|
| `[wiki]` | Stated by the BI wiki. The wiki is roughly a year **newer** than the verified build, so this is the weakest tag |
| `[binary]` | The string was found in (or is verifiably absent from) `ArmaReforgerServer.exe` of the pinned build. Parameter and field names can be checked this way; behaviour cannot |
| `[practice]` | Observed on a running server of the pinned build вЂ” a log line, an accepted config, a reproducible failure |

`tools/probe-keys.ps1` checks a name against a binary; `tools/extract-guid-table.ps1` pulls
GUIDs out of `resourceDatabase.rdb`. Use them rather than asserting from memory.

**An untagged claim is treated as `[wiki]` at best.** If something is unverified, say so in
the text вЂ” "not verified", "unconfirmed" вЂ” and keep it out of tables that look authoritative.
The RCON transport protocol is the model example: every source disagrees, so the documents
state that instead of picking one.

## Document skeleton

1. `# Title`, then the line **`**Build verified on:** Arma Reforger X.Y.Z.N (engine NNNNNN).**
   and the source of the descriptions, with the wiki revision if there is one.
2. A section for the reader's most likely mistake before the reference material вЂ” `В§0 Read
   this first`, or the equivalent warning block.
3. The reference material, as tables with a `Source` column wherever a cell's provenance
   varies.
4. A closing section on **boundaries of reliability**: what the document does not establish,
   and how to establish it.
5. For derived data: a **"How it was obtained (reproducible)"** block naming the file and the
   script, and how the method was cross-checked. The scenario GUIDs are verified against 8
   GUIDs published in the wiki вЂ” that is the standard to aim for.

## Rules the tooling enforces

- Relative markdown links must resolve (`npm run check:links`).
- Every ` ```json ` block must parse. If a block is *deliberately* invalid вЂ” the game's mod
  export that is a bare list of objects with no surrounding array is the standard example вЂ”
  fence it as ` ```text ` (`npm run check:json`).
- `skills/*/SKILL.md` frontmatter must have exactly `name` and `description`, with `name`
  equal to the directory name and a `description` of 80вЂ“1100 characters.
- After editing anything in `docs/` or `skills/`, run `npm run build:data` and commit the
  regenerated `data/` in the same change. `npm run check:data` fails otherwise, on purpose:
  two sources that disagree are worse than one source that is incomplete.

## Adding or changing reference material

**A key of `server.json`.** Add the row to the В§5 table in the ServerConfig guide with its
type, range, default and `[wiki]`/`[binary]` tag, then add it to
[`schemas/server.schema.json`](schemas/server.schema.json) **in the same change**.
`npm run check:schema` fails in both directions вЂ” a documented key missing from the schema,
and a schema key with no documentation.

**A startup parameter.** Add the row to the right В§2вЂ“В§6 table with the status column filled
in from the binary (`present` / `absent`). If it is absent, it must also be listed in В§7.1 or
В§7.2, and the counts in В§0 and В§7 must be updated to match вЂ” `npm run check:data` prints a
warning whenever the prose numbers and the tables disagree.

**A `missionHeader` field.** Add the row to the В§3 table of the MissionHeader guide. The
generator attributes a field to the class named in the nearest preceding backticked
`SCR_*` name, so keep the "Fields of the class X:" label directly above its table. A nested
type belongs in its own table, not in the top-level one.

**A scenario.** Add a row to the Scenarios table with the name and the full
`{GUID}Missions/Name.conf` string. The generator derives `guid`, `path`, `map` and
`mapCodename` from that one cell, and the counts in every document that quotes "38 scenarios"
must be updated too.

## Language parity

Every document exists as `_EN.md` and `_RU.md`. The English one is the source of truth.
Change one and change the other in the same commit; a translation that lags is a translation
that lies. `data/manifest.json` records the pairs so the omission is visible.

## After a game update

The build pin in [`data/build.json`](data/build.json) is the anchor вЂ” update it and every
document's "Build verified on" line together, then re-verify rather than re-assert:

1. `tools/probe-keys.ps1` over the config keys and parameter names, to catch renames.
2. `tools/extract-guid-table.ps1 -Validate`, to confirm the GUID table still matches.
3. `data/build.json` в†’ `verifiedOn` and the methods list.
4. `npm run build:data && npm run check`.

GUIDs are resource identifiers and do not change between patches, so a `scenarioId` survives
an update. Parameter and field names do not have that guarantee.

## Commits

One change, one reason. If you correct a statement, say in the message what it was verified
against вЂ” "verified `m_eStartingRank` 0..18 against `SCR_RankInfo.c` in the 1.6.0.119 pak" вЂ”
because that is what lets the next reader trust it without redoing the work.
