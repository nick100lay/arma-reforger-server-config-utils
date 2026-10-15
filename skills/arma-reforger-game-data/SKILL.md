---
name: arma-reforger-game-data
description: Extract and read Arma Reforger game data that the usual tools cannot reach - entries inside .pak archives, resource GUIDs, and vanilla .c sources. Use when a .pak read fails with "incorrect header check" or "unknown compression method", when you need the GUID for a scenario/world/prefab to put in a config, when a game data read returns nothing or garbage, or when you need to see vanilla script code to override it. Also use when a file extracted from a pak comes out cyclically shifted or with junk appended.
---

# Reading Arma Reforger game data

Three separate obstacles, three separate techniques. Diagnose which one you face before
picking a tool — they fail in different ways.

| Symptom | Cause | Technique |
|---|---|---|
| `incorrect header check` / `unknown compression method` | pak entry is **encrypted**, not zlib | Go through Arma Reforger Explorer (§2) |
| File comes out fine but starts mid-sentence and ends with the beginning | entry is **cyclically shifted** (rotation) | Parse the pak index yourself (§1) and rotate back |
| File ends with a fragment of an unrelated file | entry is read with **overrun** — the index's length is wrong | Not recoverable; do not trust that entry |
| Need a `{GUID}` for a config | GUIDs live only in Workbench `.meta` files, which are **not** in the pak | Extract from `resourceDatabase.rdb` (§3) |

**The single most important rule:** when a read fails or looks wrong, do **not** conclude the
file is missing. In this engine, a failed read and an absent file look identical from the
outside. Verify with a second, independent method before telling anyone something
cannot be read.

## 1. Parsing a pak yourself

The game ships `addons/data/data00*.pak` (2 GB each) and `addons/core/*.pak`.
Parsing the pak index directly is reliable and fast (the index is small) and does not
depend on any resource lookup outside the archive.

Pak container layout — walk chunk headers from offset 12:

```
offset 0:  "FORM" (4B BE) + u32BE size + "PAC1" (4B BE)          -> 12 bytes
then chunks: u32BE magic + u32BE payloadLen, payload follows
  "HEAD" -> skip
  "DATA" -> record payload start (this is the base for entry offsets)
  "FILE" -> the index tree; stop here
```

FILE-tree entry encoding, read sequentially:

```
u8  kind       0 = directory, 1 = file
u8  nameLen
    name
--- directory:
u32LE childCount, then childCount entries recursively
--- file:
u32LE offset            <- relative to DATA payload start
u32LE compressedLen
u32LE decompressedLen
6 bytes unknown
u8  compressedFlag
5 bytes (level + timestamp)
```

Read `compressedLen` bytes at `dataStart + offset`. If `compressedFlag` is set, try
`inflateSync`; if it throws `Z_DATA_ERROR`, **the entry is encrypted** — stop and use §2.

A ready implementation is in [`tools/pak-tool.mjs`](../../tools/pak-tool.mjs) with three modes:

```
node tools/pak-tool.mjs list <pak> "<regex>"     # find entries
node tools/pak-tool.mjs get  <pak> <virtualPath> <outFile>
node tools/pak-tool.mjs find <pak> "<needle>" [maxEntrySize]
```

`find` is the most useful: it scans decompressed entry contents for a string. Use it to
locate which file references something, without knowing the path in advance.

### 1.1 Rotated entries

`.conf` scenario files frequently come back rotated: the tail is at the front and the head
is at the end, with **no bytes lost**. Recognize it by the first line starting in the middle
of a value (e.g. `rlds/MP/CTI_Campaign_Eden.ent"` instead of `SCR_MissionHeaderCampaign {`).

Repair by finding the header marker and rotating the buffer there:

```
node tools/unrotate.mjs <dir>          # marker list: SCR_MissionHeaderCampaign/CombatOps/SCR_MissionHeader
node tools/repair-rotated.mjs <file> <headRegex>   # fallback when the file has no class header
```

Both live in [`tools/`](../../tools/). Work on **Buffers**, never on decoded text — decoding
and re-encoding destroys the file. `unrotate.mjs` is the proven one; `repair-rotated.mjs`
has not yet succeeded on real data.

### 1.2 Overrun entries are unrecoverable

If the extracted file ends with the beginning of an unrelated file (e.g. a rank config
ending with `}SCR_ResourceEntityRefundAction {`), the index reported a length longer than
the real entry. Rotating will not help. Report the entry as unreadable and use another route.

## 2. Vanilla sources and configs: Arma Reforger Explorer

Compressed `.c` and `.conf` from pak are encrypted and cannot be decrypted with any zlib
variant. For **script sources** there is a public mirror.

Two steps, both required — fetching the page directly truncates:

1. Build the source page URL:

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

Why the wrapper is mandatory: `web_fetch` on an arexplorer source page hits the output
budget and stops mid-file (once at line 485 of 1134) **and does not create a spill file**.
The W3C service strips the doxygen link markup server-side, and the result fits.

Properties of the result: text render, leading tabs normalised to spaces, link markers
removed. **Tokens, order and line numbers are exact** — you can cite lines.

**Limits.** This is a code explorer: it has `.c` and `.h`, and **no `.conf` or `.layout`
files at all**. For those, only the Workbench GUI helps. It is also pinned to an older build
than the installed game, so a class added recently may be absent (HTTP 403/404) while still
existing in the game — check the installed build itself before concluding a class does
not exist.

## 3. Getting a GUID

`{2B4183DF23E88249}Missions/CAH_Morton.conf` — the GUID is a resource identity. It is
stored in Workbench `<file>.meta` sidecars, which are **not shipped inside the pak**;
a full content scan of `data007.pak` for one known GUID returned zero hits.

It *is* present in `resourceDatabase.rdb` (in the dedicated server install under
`addons/data/`, ~11 MB) as raw little-endian bytes:

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

Session scenario table for build 1.6.0.119:
[ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md).

Related documents in this workspace (English, in `docs/en/`; the Russian originals are in `docs/ru/`):

- [ArmaReforger_Profile_EN.md](../../docs/en/ArmaReforger_Profile_EN.md) — what the game writes to
  disk. §4 documents the session-save layout (`<GUID>-<name>/playthroughNNN/savepointNNN/meta-info.json`)
  and §5 breaks down all 39 `m_aStats` values in `PlayerData.<UUID>.json` — an example of
  recovering meaning from a file with no field names, by matching enum ordinals to array
  indices and then confirming against the code.
- [ArmaReforger_ServerConfig_EN.md](../../docs/en/ArmaReforger_ServerConfig_EN.md) — if the extracted
  GUIDs are destined for a server config rather than a mod.

## 4. What is deliberately out of reach

Do not burn time on these; they were tested and do not work:

- **Parsing the pak FILE table by hand to reach encrypted entries.** The table region is
  itself compressed/encrypted. Reading the index works; decrypting payloads does not.
- **`.conf` and `.layout` via arexplorer** — the explorer has no such files. But if a wiki
  page was saved locally as `.htm`, [`tools/html2text.mjs`](../../tools/html2text.mjs)
  converts it to clean text with no network access at all — far more reliable than fetching.
- **`-listScenarios` expecting stdout** — the wiki confirms it prints scenario `.conf` paths
  **to the game log**, and Workshop scenarios appear only when no scenario is loaded
  (e.g. through a config). Read the log, not the console.

## 5. Verification checklist

Before reporting a result from this skill:

- [ ] Did you confirm the read actually succeeded, rather than that the file is absent?
- [ ] If a GUID: did `extract-guid-table.ps1 -Validate` pass?
- [ ] If a vanilla source: does the class still exist in the installed build?
- [ ] If you extracted a `.conf`: is the first line a class declaration, not mid-value?
- [ ] If you gave up on an entry: did you say *why* (encrypted / overrun), not just "unreadable"?
