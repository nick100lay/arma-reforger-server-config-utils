# Editing the documents

These conventions are what make the English documents convertible into
[`data/`](data/build.json) by [`build-data.mjs`](tools/build-data.mjs). A document that
breaks them does not break the build silently — the generator warns or refuses — but it does
cost someone a debugging session.

## Source tags: every claim carries its provenance

Three tags, used inline and in table cells:

| Tag | Means |
|---|---|
| `[wiki]` | Stated by the BI wiki. The wiki is roughly a year **newer** than the verified build, so this is the weakest tag |
| `[binary]` | The string was found in (or is verifiably absent from) `ArmaReforgerServer.exe` of the pinned build. Parameter and field names can be checked this way; behaviour cannot |
| `[practice]` | Observed on a running server of the pinned build — a log line, an accepted config, a reproducible failure |

`tools/probe-keys.ps1` checks a name against a binary; `tools/extract-guid-table.ps1` pulls
GUIDs out of `resourceDatabase.rdb`. Use them rather than asserting from memory.

**An untagged claim is treated as `[wiki]` at best.** If something is unverified, say so in
the text — "not verified", "unconfirmed" — and keep it out of tables that look authoritative.
The schema question is the model example: `playerCountLimit` **is** a string in the executable
and is still **rejected** as a config key, while `dedicatedServerId` was documented as gone and
is **accepted** — so a string search is evidence about a string, and only the server's own
verdict settles what it accepts.

**Claim no more than the check supports.** "The binary does not contain this string" is a
narrow statement about a string. It is not "the server rejects this field", and it is not
"this parameter does not work" — the reverse case is documented: `-autoreload` and
`-autoshutdown` have no string in the binary yet were accepted on a real command line. The
same discipline applies to tooling: if a script searches for a name, its message must say
what the search shows and nothing more.

## Document skeleton

1. `# Title`, then the line **`**Build verified on:** Arma Reforger X.Y.Z.N (engine NNNNNN).**
   and the source of the descriptions, with the wiki revision if there is one.
2. A section for the reader's most likely mistake before the reference material — `§0 Read
   this first`, or the equivalent warning block.
3. The reference material, as tables with a `Source` column wherever a cell's provenance
   varies.
4. A closing section on **boundaries of reliability**: what the document does not establish,
   and how to establish it.
5. For derived data: a **"How it was obtained (reproducible)"** block naming the file and the
   script, and how the method was cross-checked. The scenario GUIDs are verified against 8
   GUIDs published in the wiki — that is the standard to aim for.

## Rules the tooling enforces

- Relative markdown links must resolve (`npm run check:links`).
- Every ` ```json ` block must parse. If a block is *deliberately* invalid — the game's mod
  export that is a bare list of objects with no surrounding array is the standard example —
  fence it as ` ```text ` (`npm run check:json`).
- `skills/*/SKILL.md` frontmatter must have exactly `name` and `description`, with `name`
  equal to the directory name and a `description` of 80–1100 characters.
- Every text file is UTF-8 without a BOM, LF-only, and ends with a newline
  (`npm run check:encoding`). The same check looks for the CP1251 residue described below; the
  examples in that section are exempt by file name.
- After editing anything in `docs/` or `skills/`, run `npm run build:data` and commit the
  regenerated `data/` in the same change. `npm run check:data` fails otherwise, on purpose:
  two sources that disagree are worse than one source that is incomplete.

## Encoding: a real trap on Windows

Every file is UTF-8 **without** BOM, LF, final newline. This is enforced by
[`.editorconfig`](.editorconfig) for editors, and by nobody for scripts — so scripts are
where it goes wrong.

The trap, reproduced in this repository: Windows PowerShell 5.1 (`powershell`, not `pwsh`)
decodes a BOM-less UTF-8 file as the **ANSI code page** — `CP1251` on a Russian-locale system
— and writes it back as UTF-8. A `Get-Content -Raw` / `[IO.File]::WriteAllText` round trip
therefore silently converts every `—` into the three characters `вЂ”`. Nothing fails; the text
is simply wrong from then on.

- Prefer the editor tooling for document edits over a shell round trip.
- In a script, be explicit at both ends:
  `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` and
  `[System.IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding($false)))`.
- `Set-Content -Encoding utf8` is **not** safe either: Windows PowerShell writes a BOM with
  it, which is how a tool can quietly violate this rule. Pass an explicit
  `UTF8Encoding($false)`, as `tools/extract-guid-table.ps1` now does.
- After a scripted edit, check: the file parses as strict UTF-8 and contains no `вЂ”, `Рµ`,
  `СЃ` sequences. A Russian document legitimately contains Cyrillic, so look for the *mangled*
  forms, not for Cyrillic as such.

The three mangled sequences quoted above are the only ones in the repository, and
`npm run check:encoding` is told to exempt them by file name; everywhere else that check treats
them as a failure. Describe the residue rather than pasting it into a new document.

## Adding or changing reference material

**A key of `server.json`.** Add the row to the §5 table in the ServerConfig guide with its
type, range, default and `[wiki]`/`[binary]` tag, then add it to
[`schemas/server.schema.json`](schemas/server.schema.json) **in the same change**.
`npm run check:schema` fails in both directions — a documented key missing from the schema,
and a schema key with no documentation.

**A startup parameter.** Add the row to the right §2–§6 table with the status column filled
in from the binary (`present` / `absent`). If it is absent, it must also be listed in §7.1 or
§7.2, and the counts in §0 and §7 must be updated to match — `npm run check:data` prints a
warning whenever the prose numbers and the tables disagree. Note that the counts are counts of
*names*: a row written as `-AILimit` / `-aiLimit` contributes two names and one entry.

**A `missionHeader` field.** Add the row to the §3 table of the MissionHeader guide. The
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

Start with the automated check, which takes no arguments and needs no PowerShell:

```bash
node tools/verify-against-install.mjs
```

It reads the installed build version out of the executable and compares it with the pin, verifies
every scenario and terrain GUID against the installed `resourceDatabase.rdb` (after self-checking
its own parser against the 8 GUIDs published on the wiki), and probes the executable for the names
the documents call absent and for the pre-0.9.8.73 field names. It exits non-zero on drift, so it
can gate a release. Last run against 1.8.0.13: 42/42 GUIDs unchanged, 13/13 absent names still
absent.

Then do the part no script can do — re-assert by hand, with the pin in
[`data/build.json`](data/build.json) as the anchor:

1. Update `data/build.json` (`build`, `engine`, `verifiedOn`, the methods list) and every
   document's "Build verified on" line together.
2. `powershell -ExecutionPolicy Bypass -File tools/probe-keys.ps1 ...` over the config keys and
   parameter names, to catch renames. The policy flag is required on a stock Windows setup —
   without it the script does not load at all.
3. `npm run rdb -- verify "<install>/addons/data/resourceDatabase.rdb"` for the GUID table on its
   own. It reproduces the 8 published GUIDs first, so a layout change cannot pass as a table.
4. If you re-checked only part of the claims against a build you are *not* adopting as the new
   pin, record it in `data/build.json` under `recheckedOn` rather than moving the pin. A pin that
   moves without full re-verification is worse than an honest "checked partially on X".
5. `npm run build:data && npm run check`.

## Settling a question about the schema

A string search answers "is this name in the build". It cannot answer "does the schema accept this
key", and in this repository the two have disagreed: `playerCountLimit` **is** a string in the
executable and is still **rejected** as a config key, while `dedicatedServerId` was documented as
gone and is **accepted**.

The only authority is the server's own verdict:

```bash
node tools/probe-config-schema.mjs path/to/config.json
```

It launches the dedicated server with the config, reads the verdict from the log and prints the
lines the game wrote — including `Param "#/<path>" is not allowed and must be removed.` when the
schema rejects something. Exit code: 0 accepted, 1 rejected.

- Launch the server **outside a sandbox**. Under one that forbids creating named pipes the engine
  hangs before writing a line, and the tool reports a timeout instead of a verdict.
- Probe the smallest config that isolates the question, and keep a control config that is known to
  be accepted. A rejection only means something if acceptance is demonstrable in the same run.
- Record the answer where a reader will meet it: the parameter's row in the guide, `data/build.json`
  if it touches a build claim, and a fixture in `tests/fixtures/` pinning the severity so the
  validator cannot drift back.

## Commits

The history is part of the deliverable, so it is written **while the work happens**, not once at
the end: one commit per finished reason, made as that reason is finished. The agent-facing rules
are in section *Commits* of [AGENTS.md](AGENTS.md#commits-small-steps-committed-as-you-go); what
follows is what the messages themselves look like.

- **One change, one reason.** If the message needs "and also", it is two commits. If you correct a
  statement, say in the message what it was verified against — "verified `m_eStartingRank` 0..18
  against `SCR_RankInfo.c` in the 1.6.0.119 pak" — because that is what lets the next reader trust
  it without redoing the work. A pure reformat, an encoding repair or a new check is its own
  commit, never folded into the change it accompanies.
- **Files a rule binds together are one commit, not several.** `docs/en/` + `docs/ru/` + the
  regenerated `data/` (see *Language parity*); a §5 key plus its entry in
  [`schemas/server.schema.json`](schemas/server.schema.json) (*Adding or changing reference
  material*); a severity change plus the fixture and the pinned count it moves. Committing one
  half of a pair commits a failing `npm run check`.
- **Message style.** One sentence in the imperative, English, no prefixes and no `wip` —
  `git log --oneline` is the model. Name the artefact and the build whenever the claim is about
  one. Put the reasoning in the body when the diff alone would look arbitrary: for a correction,
  *why the old statement was wrong* is the whole value of the commit.
- **Stage by path** (`git add <path>`) after reading `git status`. Probing a config or running a
  server leaves scratch files (`*.report.json`, logs, `out/`); [`.gitignore`](.gitignore) covers
  the known ones and nothing else.
- **Run the checks that the change is subject to** before committing — `npm run check` for
  anything under `docs/`, `data/`, `schemas/`, `skills/` or `tools/`. Leaving a check red is
  acceptable only in the commit that *demonstrates* the failure, such as a fixture added before
  the fix; say so in the message.
- **Do not rewrite pushed history.** Amending, squashing or rebasing your own unpushed commits is
  fine and often right; `--force` on `main` is not. Pushing is the maintainer's decision.
