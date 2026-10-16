---
name: arma-reforger-game-data
description: Read Arma Reforger game data out of the .pak archives - the entry tree, extracted .conf and .c sources, resource GUIDs, and content searches. Use when a .pak read fails with "incorrect header check", "unknown compression method" or Z_DATA_ERROR, when an extracted file looks cyclically shifted or has another file's bytes at the end, when you need the GUID for a scenario/world/prefab to put in a config, or when you need vanilla script or config text to override. Also use before writing any new pak-parsing code - the format and the one mistake that breaks it are documented here.
---

# Reading Arma Reforger game data

Everything inside a `.pak` is readable with plain zlib and no key material. There is **no
encryption in the format** — no matter what an error message suggests. Three real obstacles
remain, and only one of them is about the archive at all:

| Symptom | Cause | What to do |
|---|---|---|
| `incorrect header check`, `unknown compression method`, `Z_DATA_ERROR` | entry payload read from the **wrong offset base** — by far the most common cause | §2. Fix the base; do not reach for a decryption tool |
| Text that starts mid-word, or ends with a fragment of an unrelated file | same wrong base: the window is shifted, so it begins late and the tail belongs to the neighbouring entry | §2 |
| `compressionType` other than `0` or `0x106` | a codec this toolkit does not know | `get --raw` the stored bytes, and report the type |
| Need a `{GUID}` for a config | GUIDs live in `resourceDatabase.rdb`, not in the pak | §3 |
| Need one file from a 2 GB archive | normal case | §1 |

**The rule that matters most:** in this engine a *failed* read and a *successful* read of the
wrong bytes look equally plausible. A shifted `.conf` still parses as text; a shifted
compressed entry just throws. Before reporting that something cannot be read, run
`verify` (§1) and confirm the base — a wrong base turns every compressed entry into
"encrypted" and every stored one into "rotated", and both conclusions are false.

## 1. The tool: `tools/pak.mjs`

```
node tools/pak.mjs info   <pak> [--json]                 # chunks, entry count, codec histogram, pack time, offset base
node tools/pak.mjs list   <pak> [pathRegex] [--limit N]  # find entries by path
node tools/pak.mjs tree   <pak> [pathRegex]              # the entry tree
node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--raw]
node tools/pak.mjs cat    <pak> <virtualPath> [--raw]    # print to stdout
node tools/pak.mjs find   <pak> <needle> [--max-size N] [--path-regex RE]
node tools/pak.mjs verify <pak> [--sample N]             # check every entry against the index
```

It is also a library — `import { openPak, findEntry } from "./tools/pak.mjs"` — with no
dependencies, so a one-off script can use it instead of re-implementing the parser.

The archives live in the install, not in this repository:

- dedicated server: `<Dedicated Server>/addons/data/data*.pak`, `worlds*.pak`, `addons/core/data.pak`
- client (same format, more content — scenarios and scripts are here): `<Arma Reforger>/addons/data/data*.pak`

Typical session:

```bash
node tools/pak.mjs verify "<client>/addons/data/data007.pak"     # always start here
node tools/pak.mjs list   "<client>/addons/data/data007.pak" "^Missions/.*\.conf$"
node tools/pak.mjs cat    "<client>/addons/data/data007.pak" Missions/23_Campaign_Western.conf
node tools/pak.mjs find   "<client>/addons/data/data007.pak" "GetFactionLimitMap"   # who calls it
```

`find` decompresses entries **in place** (there is no need to extract a 2 GB archive) and prints
the matches with surrounding text. It is the tool for "which file references X" and for locating
a method's callers — that is how the `SCR_FactionManager.EOnInit()` caller of
`GetFactionLimitMap()` was found when the documents still said the scripts were encrypted.

`verify` checks, mechanically: every entry's payload lies inside the DATA chunk, stored entries
agree with their own length, the reserved field is zero, and a sample of compressed entries
inflates to exactly the indexed length. On the installed 1.8.0.13 archives (23 files,
~408 000 entries) it reports the absolute base with 64/64 zlib headers where the index says
they are and 0/64 at the DATA-relative one, and no problems.

## 2. The format, and the one mistake

```
offset 0   "FORM" + u32BE size + "PAC1"                        (12 bytes)
then chunks, each u32BE magic + u32BE bodyLength + body:
  "HEAD"   28 bytes of pack metadata, skip
  "DATA"   every entry payload, back to back
  "FILE"   the entry tree, last in every archive observed
```

Entry tree, read sequentially (`u8 kind`, `u8 nameLength`, name, then):

```
kind 0 (directory): u32LE childCount, then childCount entries
kind 1 (file):      u32LE offset            <- ABSOLUTE file offset
                    u32LE storedLength
                    u32LE originalLength    (0 for a stub)
                    4 bytes                 always 0 in every archive observed
                    u32BE compressionType   0x0 = stored, 0x106 = zlib
                    u32LE timestamp         pack time, seconds since epoch
```

**`offset` is measured from the start of the `.pak` file.** Reading it from the start of the DATA
chunk body — the intuitive reading, and the one an earlier version of this repository's tool
used — is wrong by exactly 56 bytes in every archive here: 12 (FORM) + 8 + 28 (HEAD) + 8 (DATA
header). That single error produces all of these, at once:

- compressed entries throw `Z_DATA_ERROR` / `incorrect header check`, which reads exactly like
  encryption and is not;
- stored entries come back as a window into the middle of the concatenated DATA stream, so the
  text starts mid-word and the tail is the beginning of the **next** entry in the archive;
- a "repair" that rotates the buffer to the first class declaration it can find stitches the
  file together out of two different files, silently. This is how wrong `World` GUIDs were
  published for vanilla scenarios: the GUID belonged to the entry stored after the one being
  read, while the rest of the line came from the intended file.

`--data-relative` reproduces the broken behaviour on purpose, so an extract made with the old
tool can be recognised as such.

Compression: `0x106` is zlib, i.e. `inflateSync` on the stored bytes with no header stripping.
`0x0` is stored. Nothing else has ever been observed in ~408 000 entries; if a type appears,
`pak.mjs` refuses to guess and names it rather than emitting plausible garbage.

**Independent confirmation of the layout.** [rvost/PakInspector](https://github.com/rvost/PakInspector)
reaches the same structure from a Kaitai Struct description
([`formats/pak.ksy`](https://github.com/rvost/PakInspector/blob/main/formats/pak.ksy)) and reads
payloads at `io: _root._io, pos: offset` — the whole file, not the DATA body — with
`compression_type` as `u4be` and `0x106` handled as DEFLATE in its extractor. Two independent
parsers agreeing on both the offset base and the codec value is worth more than either alone;
it is also why the 56-byte defect above is a defect in the reader and not a change in the
container format between builds.

## 3. Getting a GUID

`{2B4183DF23E88249}Missions/CAH_Morton.conf` — the GUID is a resource identity. It is stored in
Workbench `<file>.meta` sidecars, which are **not shipped inside the pak**, but it *is* in
`resourceDatabase.rdb` (in the install under `addons/data/`, ~11 MB) as raw little-endian bytes:

```
[u32LE pathLen][path UTF-8][0x00][6 bytes][GUID: 8 bytes little-endian]
```

So the GUID starts **7 bytes after the path's NUL terminator** — skip 6, read 8, reverse.

```
powershell -File tools/extract-guid-table.ps1 -Validate -Out table.txt
```

`-Validate` compares the output against GUIDs published on the BI wiki and prints
MATCH/MISMATCH. **Run it with `-Validate` every time** — it is the only thing standing
between you and confidently emitting a wrong GUID. As of build 1.6.0.119 all 8 known pairs match.
Change `-Filter` to mine other tables: `worlds/`, `Prefabs/`, `Configs/`.

The RDB is a second opinion for anything read out of the pak: a `.conf` that names a world or a
prefab can be cross-checked by looking the same path up in the RDB and comparing GUIDs. Doing
that is what proved the corrected `World` values in
[the MissionHeader document](../../docs/en/ArmaReforger_MissionHeader_EN.md) §2.1.

Session scenario table for build 1.6.0.119:
[ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md).

## 4. Vanilla `.c` and `.conf` sources

Both read straight out of the pak now, compressed or not. Use the pak — it is the build you
actually run.

Arma Reforger Explorer (`https://arexplorer.zeroy.com/`) remains useful as an independent
**second source** for a `.c` or `.h` file: a different build, a different extraction path. Its
pages truncate when fetched directly, so two steps are needed:

1. Build the page URL:

   ```
   https://arexplorer.zeroy.com/_<filename_lowercased_with_underscores>_8c_source.html
   ```

   `SCR_NotificationsComponent.c` → `_s_c_r___notifications_component_8c_source.html`
   (`SCR` → `s_c_r`, then `_` between words, `.c` → `_8c`).
   For names that exist in several modules, use the path form:
   `_game_2game_8c_source.html` for `scripts/Game/game.c`.

2. Wrap it in the W3C HTML→text service, urlencoded, with `nonums=on`:

   ```
   https://www.w3.org/services/html2txt?url=<URLENCODED>&nonums=on
   ```

   Encode `:` → `%3A` and `/` → `%2F`.

Why the wrapper is mandatory: `web_fetch` on an arexplorer source page hits the output budget and
stops mid-file **and does not create a spill file**. The result is a text render with tokens and
line numbers exact.

**Limits.** The explorer has `.c` and `.h` and **no `.conf` or `.layout` files at all** — for those
the pak is the only source. It is also pinned to an older build than the installed game, so a
class added recently may be absent (HTTP 403/404) while still existing in the game; check the
installed build before concluding a class does not exist.

If a wiki page was saved locally as `.htm`, [`tools/html2text.mjs`](../../tools/html2text.mjs)
converts it to clean text with no network access at all.

## 5. What is genuinely out of reach

- **`-listScenarios` expecting stdout** — the wiki confirms it prints scenario `.conf` paths
  **to the game log**, and Workshop scenarios appear only when no scenario is loaded
  (e.g. through a config). Read the log, not the console.
- **GUIDs from the pak itself.** They are not in entry payloads; a full content scan of
  `data007.pak` for one known GUID returns zero hits. Use §3.
- **A `.pak` written by a different tool with a different offset convention.** `pak.mjs`
  detects this (`info`/`verify` print the base) but the archives it has been tested against are
  all the game's own. If `verify` reports a data-relative base, read with `--data-relative`
  and say so.

## 6. Verification checklist

Before reporting a result from this skill:

- [ ] Did you confirm the read actually succeeded, rather than that the file is absent?
- [ ] Did `verify` (or `info`) show the offset base the archive really uses?
- [ ] If a GUID: did `extract-guid-table.ps1 -Validate` pass, and for a value taken from a
      `.conf`, does the RDB agree?
- [ ] If you extracted a `.conf`: is the first line a class declaration, not mid-value?
- [ ] If you gave up on an entry: did you say *why* (unknown `compressionType`, truncated
      archive), not just "unreadable"?
