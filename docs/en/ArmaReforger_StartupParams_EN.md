# Arma Reforger server startup parameters

A reference for the command-line arguments. A supplement to the
[config guide](ArmaReforger_ServerConfig_EN.md).

**Build verified on:** Arma Reforger 1.6.0.119 (engine 192142).
**Source of the descriptions:** the BI page "Startup Parameters", revision `oldid=379133`
of 2026-10-10 (the full text of the page, 41536 characters).

The `present`/`absent` column is a statement about 1.6.0.119 alone; §7.3 re-checked that list on
the installed **1.8.0.13** the same way, and the same 13 names are still absent.

---

## 0. Read this first: the wiki is newer than your build

The wiki page is from **October 2026**, while the build being verified is the server build of
**January 2026** (1.6.0.119). The gap is almost a year, and it is not theoretical: of the **70**
parameters catalogued below — 69 parameters, plus the second spelling of `-AILimit`/`-aiLimit` —
**13 are absent** from the 1.6.0.119 binary.

That is why in this document every parameter carries **two** marks:

- **the description and the version tag** — from the wiki (it states in which version the parameter appeared);
- **"present in 1.6.0.119"** — verified by searching for the name in the strings of the build being
  checked, `ArmaReforgerServer.exe`. The **Diag exe only** rows are the exception, and it matters:
  those switches live in `ArmaReforgerServerDiag.exe`, so a plain server build ignores them without
  a word. §7.3 measured the split on the installed 1.8.0.13.

If a parameter is absent from your build, the engine will most likely **silently ignore
it** — no error and no effect. The list of missing ones is in §7.

> **An important caveat about the method.** The absence of a string in the binary is strong, but not
> absolute evidence. The parameters `-autoreload` and `-autoshutdown` have no string in the binary,
> yet **they were present on the real command line** of this same server (§1) and were accepted
> without a single error. That is, the engine can accept parameters without storing their name in
> that form. The converse is also true: the presence of a parameter on the command line **does not
> prove** that it works. The only reliable proof is an effect in the log or in the game.

---

## 1. The real command line

> ### ⚠️ First, go to the server working directory
>
> **Before launching, be sure to `cd` into the server directory.** If you launch the executable
> from anywhere else, the server will not find its own game base and will show a modal window:
>
> ```
> Missing Addon
> Can't find '58D0FB3206B6F859' game addon! Check setup guidelines!
> ```
>
> `58D0FB3206B6F859` is the GUID of the **`ArmaReforger.gproj`** project (the file
> `addons\data\ArmaReforger.gproj`, field `TITLE "Arma Reforger"`). So the "missing
> addon" is the game itself, not your mod. The cause is not the config and not the mod: the
> server looks for `.\addons\core` and `.\addons\data` **relative to the current directory**, not
> relative to its own `.exe`.
>
> ```powershell
> cd "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
> .\ArmaReforgerServer.exe -config .\config.json -profile .\profile
> ```
>
> That is exactly why the paths in the examples below start with `.\` — they are relative to the
> server directory, and the log shows `Addon dirs: dir: './addons'`.
>
> The same symptom occurs when launching the game `.exe` directly instead of
> `steam.exe -applaunch`: Steam sets the working directory itself when launched through it. For the
> server a plain `cd` is enough.
>
> **How to tell this error from similar ones.** Here the text is exactly about `game addon` and the
> GUID `58D0FB3206B6F859`. If the message has a different GUID, it is no longer about the working
> directory but about a missing addon of your mod.

A live example from the logs of a dedicated server:

```
ArmaReforgerServer.exe -config .\config.json -profile .\test ^
  -autoreload 30 -autoshutdown -logStats 60000 ^
  -keepNumOfLogs 9999 -logTime datetime -logLevel normal
```

In the log this is visible in full — handy for self-checking:

```
ENGINE : CLI Params: -config .\config.json -profile .\test -autoreload 30 -autoshutdown ...
ENGINE : Addon dirs:
 ENGINE : dir: './addons'
```

**Always check this line in `console.log`**: it shows what the engine actually received, not what
is written in the shortcut.

### The minimal set

```powershell
cd "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
.\ArmaReforgerServer.exe -config server.json -profile profile
```

---

## 2. Hosting section

The wiki marks this section: **the parameters refer to the server executable**.
For several parameters the wiki separately notes that they work **only on the diag build**
(`ArmaReforgerServerDiag.exe`) — this is stated in the table.

| Parameter | Value | Version | 1.6.0.119 | Description |
|---|---|---|---|---|
| `-config <file.json>` | path | — | present | Specifies the JSON config of the server. Example: `-config "myConfigFile.json"` |
| `-profile <directory>` | path | — | present | The profile directory: logs, saves, settings, `ownerToken.bin`. If not set, it is created next to the executable. A breakdown of the contents is in [`ArmaReforger_Profile_EN.md`](ArmaReforger_Profile_EN.md). |
| `-bindIP <IP>` | IP | — | present | Overrides **both** `bindAddress` **and** `publicAddress` from the config. Example: `-bindIP 192.168.1.42`. ⚠ Specifying a public IP here gives you the same problem with joining from the local network as described below. |
| `-bindPort <port>` | 1..65535 | — | present | Overrides **both** `bindPort` **and** `publicPort`. Example: `-bindPort 2302` |
| `-a2sIpAddress <IP>` | IP | — | present | The bind address of Steam Query. Example: `-a2sIpAddress 192.168.1.10` |
| `-a2sPort <port>` | 1..65535 | 0.9.6 | present | The bind port of Steam Query. Example: `-a2sPort 7777` |
| `-maxFPS <number>` | number | 1.7.0 | present | The FPS limit. Wiki: useful for the server, and also works on clients. Example: `-maxFPS 30` |
| `-server "<world>"` | path to a `.ent` | — | present | Bring up a local server with the given world. **The config is ignored in this case.** Can be combined with `-addons` and `-addonsDir` to test a mod: `-server "worlds/MP/MPTest.ent" -addonsDir "C:\MyModsDir" -addons MyCustomMod` |
| `-addonsVerify` | — | 1.3.0 | present | **Dedicated server only.** Verifies the integrity of all addons; on corruption the server shuts down and writes the list of bad files. Can take time. |
| `-addonsRepair` | — | 1.3.0 | present | **Dedicated server only.** The same, but it tries to repair; if it fails, the server shuts down. |
| `-loadSessionSave [UUID]` | no value, or a UUID | 1.6.0 | present | Load the previous game session. Without a value — the last save for the current scenario; you can pass the UUID of a specific save from its `meta-info.json`, field `m_Id`. A breakdown of the save structure is in [`ArmaReforger_Profile_EN.md`](ArmaReforger_Profile_EN.md) §4. |
| `-keepSessionSave` | — | — | present | Keep the saves of completed playthroughs on the results screen. |
| `-logStats [ms]` | number (ms) | 1.3.0 | present | Periodic output of performance statistics. Without a value — once a second. The detailed output format is in §5. |
| `-keepNumOfLogs <N>` | number, default **10** | — | present | How many logs to keep. |
| `-logTime <format>` | `none` / `time` (default) / `datetime` | 0.9.8 | present | The format of the timestamp in the log. |
| `-logsDir <name or path>` | name or path | 0.9.8 | present | Where to write the logs. A **name** — a subdirectory in the profile directory (`-logsDir "DebugSession1337"` → `<profile>\logs\DebugSession1337`); a **full path** — used directly. |
| `-worldSystemsConfig <resource>` | a GUID path to a `.conf` | 1.3.0 | present | **Diag exe only.** Sets the world systems config when launching a mission directly (not through `MissionHeader.conf`). Example: `-worldSystemsConfig "{C50579A2EC48E8EF}Configs/Systems/MissionSystems.conf"` |
| `-autoreload <sec>` | seconds | 1.3.0 | **not in the binary** | Reloads the scenario at the end of a session after the given delay, **without shutting down the server**. Since 1.3.0 a disabled value makes the server restart by the same instance. Example: `-autoreload 10` |
| `-autoshutdown` | — | 1.3.0 | **not in the binary** | Ensures a clean shutdown of the server. Gives 30 seconds after the game and shuts down: `-autoreload 30 -autoshutdown`. The wiki recommends using it together with an automatic restart of the server on crash/shutdown — this is a workaround for the 1.3.0 restart problem. |
| `-client <IP>` | IP | 1.6.0 | present | **Refers to the game executable.** Starts an RplSession in local client mode and connects to the given IP: `ArmaReforgerSteam.exe -client 127.0.0.1` |
| `-enableNightGrain` | — | 1.6.0 | **absent** | Enables night grain in multiplayer. In single player night grain is always off. Was `-forceDisableNightGrain` in 1.6.0.54, renamed in 1.6.0.76. |
| `-listScenarios` | — | 1.0.0, 1.6.0 | **absent** | Prints the paths to the scenario `.conf` files **to the game log**. Workshop scenarios will get into the list only if no scenario is being loaded (for example through the config). Example: `-listScenarios` |
| `-logVoting` | — | — | **absent** | Logging of the voting system: who created a vote, who voted and against whom. |
| `-playerLimits "<Faction>:<N>,..."` | a comma-separated list | — | **absent** | The maximum number of players per faction. Examples: `-playerLimits "FIA:3"`, `-playerLimits "US:1,USSR:1,FIA:62"` |

> **`-profile` is the server's identity, not just a folder for logs and saves.** `ownerToken.bin` lives
> in it, and that file is what the backend knows the server by: one token maps to one room, and the room
> carries the server's ban list. Three consequences, each measured rather than assumed
> ([Backend API §3.2](ArmaReforger_BackendAPI_EN.md)):
>
> - **Two servers must not share a profile directory** — and handing the same `ownerToken.bin` to a
>   second profile is not a way to clone a server. The later registration takes the room; the earlier
>   server is told `404 DedicatedServerNotFound` on its next heartbeat and logs
>   `DS Room/ Server not exist anymore, shutting down...` before shutting itself down cleanly. If both
>   start in the same instant the loser fails with a backend `500 InternalServerError` and never serves
>   at all. Two servers need two profiles, which also means two tokens, two rooms and two ban lists.
> - **Wiping the directory costs more than the saves.** The next start registers as a new server: new
>   `providerServerId`, and a ban list that is empty again.
> - **Therefore: back up `ownerToken.bin`** and keep the backup away from the server —
>   [Profile §3](ArmaReforger_Profile_EN.md).

> **About `-listScenarios`.** This is exactly the case where my guess was confirmed by the
> documentation: the wiki says outright "prints to game logs", that is **to the log**, not to stdout.
> That is why running `ArmaReforgerServer.exe -listScenarios` produced no list on screen.
> A ready-made list with GUIDs is in [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md).

> **About `-playerLimits`.** It is marked as absent from the build, and that disagrees with
> third-party guides — but it has **no version tag** in the wiki, that is, it is unknown when it
> appeared. It may have been added after January 2026. Faction limits in your build
> are set with the field `missionHeader.m_aFactionLimits`.

---

## 3. Network Tuning section

Wiki: **the parameters refer to the server executable**. This is where the settings that are most
often needed for load tuning are concentrated.

| Parameter | Value | Default | 1.6.0.119 | Description |
|---|---|---|---|---|
| `-nds <diameter>` | number, 0 = disable | **2** | present | Network Dynamic Simulation: streams only relevant entities to each client. The value is the diameter, that is, the number of replicated cells. A larger diameter means a larger network view and lower performance. `-nds 0` disables the mechanism. |
| `-nwkResolution <m>` | 100..1000 | — | present | The resolution of the spatial map cells in metres. Smaller — less "pop-in", but a smaller view. For a large view the wiki advises **high resolution with a small diameter**. |
| `-staggeringBudget <N>` | 1..10201 | taken from `-nds` | present | How many **static** cells of the spatial map to process per tick. Smaller — the server is lighter, but the client receives entities for longer. |
| `-streamingBudget <N>` | not below 100 | — | present | The global streaming budget, split equally between all connections. Consumed by the size of an entity's replication hierarchy. **Cannot be below 100** — otherwise the system will stall. |
| `-streamsDelta <N>` | 1..1000 | **100** | present | A limit on the number of streams opened to a client: if the difference between those open on the server and on the client is greater than N, the server does not open new streams in that tick. Tuned to the average network speed of the clients. |
| `-rpl-timeout-ms <ms>` | number (ms) | — | present | The client/server timeout. Example: `-rpl-timeout-ms 10000` |
| `-rpl-timeout-disable` | — | — | present | **Diag exe only.** Disables the timeout. ⚠ The wiki warns: a client that stopped responding will degrade server performance until it runs out of memory. Debugging only. |
| `-rpl-vcons <N>` | 0..200 | **0** | present | **Diag exe only.** The number of virtual connections. |
| `-rpl-reconnect` | — | — | present | **Diag exe only, on the client.** Replication tries to reconnect instead of dropping immediately. |
| `-rpl-validation-rdb-disable` | — | — | present | **Diag exe only.** Disables the verification of the client's resource database. ⚠ A data mismatch gives undefined behaviour. |
| `-rpl-validation-scr-disable` | — | — | present | **Diag exe only.** Disables the verification of the client's script checksum. ⚠ The same warning. |
| `-rpl-validation-version-disable` | — | — | present | **Diag exe only.** Disables the verification of the client's executable version. ⚠ The same warning. |
| `-rpl-validation-devbin-disable` | — | — | present | **Diag exe only.** Disables the verification of the developer build flag — allows mixing dev and regular binaries in one session. |

---

## 4. Debug section

| Parameter | Value | Default | 1.6.0.119 | Description |
|---|---|---|---|---|
| `-aiLimit <N>` | number | — | present | The upper limit of the number of AI. A value **≤ 0 disables AI completely**. The wiki warns: the parameter also applies in single player and can ruin the experience. Example: `-aiLimit 32` |
| `-disableAI` | — | — | present | Disables the initialization and ticks of AIWorld. |
| `-aiPartialSim <N>` | number | **4** | present | How many batches all simulated AI are split into. Example: 100 simulated AIs with 4 batches give 4 batches of 25. |
| `-disableNavmeshStreaming [list]` | no value, or project names separated by commas | — | present | Disables navmesh streaming. Since 1.2.0 it accepts a list of projects (`Soldiers` for characters, `BTRlike` for vehicles). |
| `-disableCrashReporter` | — | — | present | Disables the automatic sending of crash reports. |
| `-silentCrashReport` | — | — | present | Sends the report without a dialog and without user involvement. Before 1.0.0 it was called `-noCrashDialog`. |
| `-createDB` | — | — | present | Forces regeneration of the database file. Useful after moving resources. Takes a few seconds at startup. |
| `-debugger <address>` | string | **localhost** | present | The address of the script debugger. Example: `-debugger 192.168.0.5` |
| `-debuggerPort <port>` | number | **1000** | present | The port of the script debugger. Example: `-debuggerPort 1040` |
| `-VMErrorMode <mode>` | `silent` / `log_only` / `full` / `fatal` | — | present | The mode of script VM error messages: continue silently / write to the log and continue / show a dialog / write and **terminate the game**. |
| `-logLevel <level>` | `normal` … `fatal` | — | present | The log level; **each level includes the lower ones** (for example `error` includes `fatal`). The wiki lists: `normal`, `warning`, `error`, `fatal`. |
| `-logAppend` | — | — | present | Do not clear the logs at startup, preserving the history. |
| `-logFS` | — | — | present | Logs **every** file-system read/write operation to `filesystem.log`. Wiki: very demanding, quickly produces a large file, debugging only. |
| `-log-rdb-checksum` | — | — | present | A detailed log of the RDB checksum computation (GUID and path in the order of addition) — for debugging problems with it. |
| `-log-scr-checksum` | — | — | present | Logs all script files participating in the compilation and their checksums. |
| `-rplEncodeAsLongJobs` | — | — | present | Replication uses long encoding jobs instead of short ones. |
| `-jobsysShortWorkerCount <N>` | number | — | present | The number of threads for short jobs (finish within one iteration). Limited by the number of CPUs or 16 — whichever is less. |
| `-jobsysLongWorkerCount <N>` | 1..number of CPUs | `jobsysShortWorkerCount / 2` | present | The number of threads for long jobs (can take several iterations). |
| `-generateShaders` | — | — | present | Forces shader generation. |
| `-minidump <mode>` | `normal` / `dataSegs` / `fullMemory` | — | present | The amount of extra data in the minidump. Mappings: `normal` → MiniDumpNormal, `dataSegs` → MiniDumpWithDataSegs, `fullMemory` → MiniDumpWithFullMemory. |
| `-AILimit` / `-aiLimit` | see `-aiLimit` | — | present | The same as `-aiLimit`: parameter names are case-insensitive. The wiki writes `-AILimit`, the binary has both forms. |
| `-autodeployFaction <key>` | faction key | — | **absent** | **Diag exe only.** Overrides the respawn faction (`US`, `USSR`, `FIA`). Alias: `tdmf`. |
| `-autodeployLoadout <role>` | role name | — | **absent** | **Diag exe only.** Overrides the respawn role (the role name from the scenario's `LoadoutManager`). Alias: `tdml`. |
| `-disableShadersBuild` | — | — | **absent** | Disables shader generation. |
| `-keepCrashFiles` | — | — | **absent** | Do not delete the crash files after a report has been sent successfully. |
| `-scriptAuthorizeAll` | — | — | **absent** | Disables the confirmation dialog for `RunCmd`, `RunProcess`, `KillProcess` and file operations outside the profile directory. |
| `-noSplash` | — | — | **absent** | The wiki page names this parameter in its list, but gives no description for it in any of the sections reproduced in §2–§6, so none is offered here. Absent from the 1.6.0.119 binary, like the rest of §7.1. |

---

## 5. Profiling section

| Parameter | 1.6.0.119 | Description |
|---|---|---|
| `-checkInstance` | **absent** | Enables logging of script VM memory allocations (see Script Profiling in the wiki). |

---

## 6. Mods and addons (General section)

This section in the wiki is **shared** — the parameters refer both to the game and to the server.

| Parameter | Value | 1.6.0.119 | Description |
|---|---|---|---|
| `-addons <ID,...>` | comma-separated IDs | present | Load the listed addons. An ID is the `GUID` from `.gproj` (preferred) or the project `ID`. Mods are looked for in `profile/addons`, `<executable directory>/addons` and in the directories from `-addonsDir`. Example: `-addons 88037E46AD234C72,88037E46AD234C73`. **The game itself hands you the ready-made line:** mods menu → "Saved mod settings" → the "Command line" tab, and the contents depend on the selected mod preset (see [`ArmaReforger_ServerConfig_EN.md`](ArmaReforger_ServerConfig_EN.md) §5.4.1). |
| `-addonsDir <path,...>` | comma-separated paths | present | Additional mod search directories. **Absolute** paths are recommended. Example: `-addonsDir D:\DownloadedMods` |
| `-addonDownloadDir <path>` | path | present | Where the game and the Workshop download addons; an `addons` subdirectory is created inside. No need to combine it with `-addonsDir`. |
| `-addonTempDir <path>` | path | present | The directory of addon temporary files. |

### ⚠️ `-config` and `-addons` are incompatible

The binary has a separate message:

```
-config cannot be used together with addons!
```

The mod list is set **either** by the `game.mods` field in the config **or** by the `-addons`
parameter. Not both at the same time. When launching mods through `-addons`, do not expect
`game.mods` to apply as well.

The neighbouring startup messages — useful for diagnostics:

```
Unable to read the mission header '%s'
Error while loading vanilla addons!
Unable to start replication (world '%s')
Invalid config!
No resource passed!
```

---

## 7. What build 1.6.0.119 does not have

13 parameters from the wiki that are absent from the binary fall into two groups: **11** that the
wiki gained after this build was made and that have nothing else behind them (§7.1), and **2**
that were accepted on a real command line anyway (§7.2). Split by the criterion
"did we see them in real operation".

### 7.1 Appeared after January 2026 — do not use

| Parameter | Version tag in the wiki |
|---|---|
| `-listScenarios` | 1.0.0, changed in 1.6.0 |
| `-logVoting` | — |
| `-playerLimits` | — (version not stated) |
| `-autodeployFaction`, `-autodeployLoadout` | 1.0.0 |
| `-disableShadersBuild`, `-keepCrashFiles`, `-scriptAuthorizeAll` | 1.1.0 |
| `-checkInstance` | — |
| `-noSplash` | — |
| `-enableNightGrain` | 1.6.0 (renamed in 1.6.0.76) |

For `-playerLimits` use `missionHeader.m_aFactionLimits`, for `-listScenarios` —
the ready-made table in [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md).

### 7.2 A special case: `-autoreload` and `-autoshutdown`

Documented (1.3.0), but there are no strings in the binary — yet **both were present
on the real command line** and were accepted without error.

What this means in practice: the parameters most likely work, but **this cannot be confirmed
on build 1.6.0.119 from the documentation** — the version tag 1.3.0 is older than the build,
and the name is not found in the binary. If you rely on `-autoreload` to restart
the scenario, verify the effect in the log: the wiki describes it as "reloads the scenario
at the end of a session without shutting down the server".

### 7.3 Re-checked on a newer build: 1.8.0.13 `[binary]`

The list above is a statement about 1.6.0.119. A later build installed in 2026 — **1.8.0.13**,
which carries the string `Arma Reforger 1.8.0.13` in its executable — was checked the same way
(§8), and **all 13 names are still absent from it**. The four `gameHost*` field names from the
config guide are still absent as well, and all 42 scenario and terrain GUIDs are unchanged.

Reproduce it with [`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs),
which runs the absent-name probe and the GUID comparison in one go and self-checks its
`resourceDatabase.rdb` parser against the 8 GUIDs published on the wiki before trusting it:

```bash
node tools/verify-against-install.mjs
```

Two minor versions is enough for behaviour to change in either direction, so read this as "the
list still holds on 1.8.0.13", not as "these parameters will never work". The caveat at the top
of this document stands: absence of a string was never proof.

**Where the names live was measured on 1.8.0.13 too**, across the four executables of the server
and client installs. Of the **56** names marked present, **49** occur in
`ArmaReforgerServer.exe`, and **7** occur in `ArmaReforgerServerDiag.exe` only — every one of them
marked **Diag exe only** in the tables above: `-rpl-timeout-disable`, `-rpl-vcons`,
`-rpl-reconnect` and the four `-rpl-validation-*-disable` switches. A plain server build ignores
those without a word, which is exactly the silent failure §0 warns about; the same seven are absent
from the non-Diag client executable as well and present in its Diag twin, so this is how the two
builds are cut, not an accident of one file. No name marked present is missing from both server
executables. Of the 13 names §7 calls absent, 12 occur in neither, and `-checkInstance` occurs in
the Diag build only.

---

## 8. How to check a parameter in your build

Parameter names sit in the executable as ordinary strings, without encryption:

```powershell
$exe = "ArmaReforgerServer.exe"
$s = [System.Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($exe))
$s.IndexOf("maxFPS")     # -> an offset, or -1 if the name is not in the build
```

You have to check **case-insensitively** — parameter names are case-insensitive:
`$s.ToLowerInvariant().IndexOf("maxfps")`.

A ready-made script for a list of names at once — [`tools/probe-keys.ps1`](../../tools/probe-keys.ps1):

```powershell
powershell -ExecutionPolicy Bypass -File tools/probe-keys.ps1 -Keys @('maxFPS','bindIP','autoreload','playerLimits')
```

> **`-ExecutionPolicy Bypass` is not optional on a stock Windows setup.** Without it the script
> does not load at all: *"probe-keys.ps1 is not digitally signed. You cannot run this script on
> the current system."* — the default `Restricted` policy blocks unsigned scripts. Reproduced on
> Windows while re-checking §7.3. The same applies to
> [`tools/extract-guid-table.ps1`](../../tools/extract-guid-table.ps1).

The same script is used to check config field renames after a game update.

The whole set of checks in one command, without PowerShell — the absent list above, the field
names from before 0.9.8.73, every scenario GUID against the installed `resourceDatabase.rdb`,
and the installed build version against the pinned one:

```bash
node tools/verify-against-install.mjs
```

### Where to look at what the server accepted

1. **`console.log`, the `CLI Params:` line** — the full list of arguments that reached the
   engine. The first thing worth checking on strange behaviour.
2. **Startup lines** — which mode came up:
   `Starting dedicated server using command line args.` /
   `Starting local multiplayer server using command line args.` /
   `Starting multiplayer client using command line args.`
3. **`BACKEND : JSON is Valid`** — the config was accepted by the schema (see the main guide, §9).

### The output format of `-logStats`

Useful to know if you have enabled the statistics:

```
FPS: 60.0, frame time (avg: 16.7 ms, min: 9.3 ms, max: 23.7 ms), Mem: 3291106 kB,
Player: 2, AI: 104, Veh: 0 (17), Proj (S: 12, M: 0, G: 0 | 12),
RplItemsS: 410, RplItemsC0: 17068
```

| Field | Meaning |
|---|---|
| `FPS` | the current server FPS |
| `frame time` | the average, minimum and maximum frame time |
| `Mem` | memory consumption in kilobytes **according to the server's internal estimate** — the wiki warns that it does not match the OS figures |
| `Player` | the number of players |
| `AI` | the number of AI on the server |
| `Veh <N> (<M>)` | in parentheses — the current number of spawned vehicles |
| `Proj (S/M/G \| N)` | projectiles / missiles / grenades and their sum |
| `RplItemsS` | the number of dynamic (created during the game) streams on the server |
| `RplItemsC0` | the number of streams opened to the client |

---

## 9. Order of application and conflicts

| What | Priority |
|---|---|
| `-server "<world>"` | **the config is ignored entirely**; can be combined with `-addons`/`-addonsDir` |
| `-addons` | **conflicts** with `-config` (§6): not both at the same time |
| `-bindIP`, `-bindPort` | each overrides **two** config fields: `bindAddress`+`publicAddress` and `bindPort`+`publicPort` |
| `-a2sPort`, `-a2sIpAddress` | override the corresponding A2S fields |
| `-config` | needed if `-server` is not used |

The practical conclusion: if a field in the config "does not work" — first check whether it is
overridden by a startup parameter. The `CLI Params:` line in the log shows this at once.

---

## 10. Boundaries of reliability

- **The descriptions come from the wiki of 2026-10-10, while the build is 1.6.0.119.** For each
  parameter, the presence in the build was verified separately (§0, §7), but the **behaviour** in
  your build may differ from what is described: the wiki describes a newer version.
- **The default values** are given where the wiki states them: `-nds` = 2,
  `-streamsDelta` = 100, `-keepNumOfLogs` = 10, `-logTime` = `time`, `-debugger` =
  `localhost`, `-debuggerPort` = 1000, `-aiPartialSim` = 4,
  `-jobsysLongWorkerCount` = `jobsysShortWorkerCount / 2`. For the rest the wiki does not state
  the defaults.
- **`-logLevel`**: the wiki lists only `normal`, `warning`, `error`, `fatal`,
  while the binary also contains `spam`, `verbose`, `debug`. That is, there are more valid values
  than described.
- **The "diag exe only" mark** is taken from the wiki as is. It means
  `ArmaReforgerServerDiag.exe` / `ArmaReforgerSteamDiag.exe`; in the regular build
  the parameter will not work.
- **The General section** in the wiki is shared between the game and the server; the Hosting and
  Network Tuning sections are marked by the wiki as referring to the server executable.

### Sources

| What | From |
|---|---|
| Descriptions, default values, ranges, version tags, examples | BI Wiki "Arma Reforger: Startup Parameters", revision `oldid=379133` of 2026-10-10 |
| The presence of the parameters in the build | A case-insensitive search in the strings of `ArmaReforgerServer.exe` 1.6.0.119 (engine 192142) |
| Error messages, value enumerations, the grouping of names in the binary | The same binary: blocks `0x1A47E48`, `0x1A47F10`, `0x1905AC0`, `0x17A50B0`, `0x1A435F0`, `0x17A4300` |
| The working command line and the `CLI Params:` line | `Arma Reforger Server\test\logs\logs_*\console.log`, 9 sessions |

---

## Appendix A. Running on Linux

> ### ⚠️ What is verified here and what is not
>
> **Everything in this appendix is assembled from documentation and working Linux projects, not
> verified by running.** I have no access to a Linux machine, so I give the differences from Windows
> with a source, and I honestly mark the disputed points.
> **Personally verified:** the structure and the launch scripts on Windows (§1–§9), the port protocols
> per the official BattlEye specification and per the BI wiki.
> **Not verified:** the file names in the Linux depot, the logging behaviour, the operation of the systemd unit.

### A.1 The server is native — Wine is not needed

The Arma Reforger dedicated server ships as a **native Linux build** —
it is not a Windows binary under Proton. Therefore:

- Wine/Proton are not required and will only add problems;
- `steamclient.so` is placed by SteamCMD automatically;
- **ARM64 is not supported** — only x86_64. The developer of one of the container images
  answers a request for an ARM build outright: "Until the devs release ARM compiled server
  binaries I won't do this".

Separately, a known problem: the Linux server **does not work under Steam Linux Runtime**
(BI ticket `T165196`). So if you launch through a container or `steam-runtime`,
that may be the cause of the failure — launch the binary directly.

### A.2 Installing with SteamCMD

The application IDs — from the BI wiki: **stable `1874900`**, experimental `1890870`.

```bash
# a user for the server, without root
sudo useradd -m -s /bin/bash steam
sudo -iu steam

mkdir -p ~/reforger && cd ~/reforger

# SteamCMD
mkdir -p ~/steamcmd && cd ~/steamcmd
curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf -
./steamcmd.sh +quit          # self-update, it must be allowed to finish

# the server itself
./steamcmd.sh \
  +force_install_dir "$HOME/reforger/server" \
  +login anonymous \
  +app_update 1874900 validate \
  +quit
```

`+login anonymous` — the server depot is public, no Steam account is needed.
In the Windows manifest of the same application the depots `1874901` and `1874903` are visible;
which of them is Linux does not follow from the wiki.

**Check what the binary is called in your depot.** Installers on Linux usually call
it `ArmaReforgerServer` (without an extension), and the variant `ArmaReforgerServer.sh` is also possible:

```bash
ls -la ~/reforger/server | grep -i arma
```

Further on in the examples I write `./ArmaReforgerServer` — substitute the actual name.

### A.3 The key point: the same working directory as on Windows

The requirement from §1 also applies on Linux, and there it is even more noticeable: the server
resolves `./addons/core` and `./addons/data` **relative to the current directory**.

The symptom is exactly the same — a modal window (in a container/without X it will go into the log):

```
Missing Addon
Can't find '58D0FB3206B6F859' game addon! Check setup guidelines!
```

So do not launch the binary by an absolute path from a foreign directory. Make a launch
script next to the server — that way `cd` is guaranteed:

```bash
#!/usr/bin/env bash
# ~/reforger/start-armareforger.sh
set -euo pipefail

SERVER_DIR="$HOME/reforger/server"

# MANDATORY: working directory = the server directory
cd "$SERVER_DIR"

exec ./ArmaReforgerServer \
  -config "$SERVER_DIR/config.json" \
  -profile "$SERVER_DIR/profile" \
  -maxFPS 60 \
  -logStats 10000 \
  -logTime datetime \
  -logLevel normal
```

```bash
chmod +x ~/reforger/start-armareforger.sh
~/reforger/start-armareforger.sh
```

Note: `-config` and `-profile` here are given as **absolute** paths. This
is safer than `./`, because the path to the config no longer depends on where the
script was launched from — while `cd` is still needed for `addons`.

To avoid launching the server twice, add a check — it will also come in handy for cron:

```bash
pgrep -f ArmaReforgerServer >/dev/null && { echo "already running"; exit 1; }
```

### A.4 systemd: autostart

The script from A.3 is wrapped in a unit. This is the standard approach: for example, `armactl`
generates `systemd` units and restart/start timers and launches the server through the
generated `start-armareforger.sh`.

```ini
# /etc/systemd/system/armareforger.service
[Unit]
Description=Arma Reforger Dedicated Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=steam
Group=steam

# WorkingDirectory is mandatory — otherwise you get Missing Addon
WorkingDirectory=/home/steam/reforger/server
ExecStart=/home/steam/reforger/start-armareforger.sh

# The server must shut down cleanly, not crash
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGINT

# Logs go to journalctl if you do not use -logsDir
StandardOutput=journal
StandardError=journal

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now armareforger
sudo systemctl status armareforger
journalctl -u armareforger -f
```

`WorkingDirectory=` in the unit is the same `cd`, only from systemd's side.
**Without it the server will not find its game base.**

### A.5 Ports

| Port | Protocol | Purpose |
|---|---|---|
| 2001 | **UDP** | the game port (`publicPort`) |
| 17777 | **UDP** | A2S / Steam Query (`a2s.port`) |
| 19999 | **UDP** | RCON (`rcon.port`) — **verified by running the server**, see below |

The game port and A2S are UDP. **The RCON transport is UDP too**, and that was established by
running the server rather than inferred from sources:

- on build 1.8.0.13 the server was started with a non-public config (bound to `127.0.0.1`,
  `visible: false`, `rcon.port` 2402). While it ran, the RCON port was a **UDP endpoint owned by
  the server process**, there was **no TCP listener** on it, and a TCP connect to it was refused.
  The control ports behaved as documented — the game port (2401) and A2S (17778) were UDP as
  well — and that is what makes the negative result meaningful: the method distinguishes the
  protocols instead of merely failing to see TCP anywhere;
- the log of that same run gives only
  `BACKEND : [RCON] Init, Ip address=127.0.0.1 and Port=2402` — neither the address nor the port
  reveals the protocol, which is why the question stayed open so long;
- why the sources disagreed: the official BattlEye specification ("BE RCon uses the game
  server's network interface, i.e. its UDP game port") says UDP; the BI wiki states no protocol
  at all — in its port summary the "Protocol" cell for 19999 is empty; and the popular container
  image `sknnr/arma-reforger-server` publishes 19999 as **TCP**, which is wrong about the
  transport.

The binary does not state the protocol either: the surroundings of the messages
`[RCON] Init, Ip address=%i.%i.%i.%i and Port=%i` and `[RCON] Invalid port, set to default...`
carry only the address and the port.

**What to do in practice:** open **UDP only**. An open TCP rule for this port is extra attack
surface, not insurance:

```bash
sudo ufw allow 2001/udp
sudo ufw allow 17777/udp
sudo ufw allow 19999/udp
```

To re-check on your own machine: `ss -lunp | grep 19999` shows UDP, and `ss -ltnp | grep 19999`
shows nothing. On Windows the same two checks are
`Get-NetUDPEndpoint -LocalPort 19999` and `Get-NetTCPConnection -State Listen -LocalPort 19999`.

**The message format is no longer open either.** It was recovered later, on the same build:
the packets are BattlEye RCon v2 — see §1.1 of
[`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md), which carries the layout and a captured
exchange.

To check that RCON came up at all, use the log:

```
BACKEND : [RCON] Init, Ip address=127.0.0.1 and Port=19999
```

If instead of it:

```
[RCON] Init failed... Missing password or password length < 3 characters !!!
[RCON] Init failed... RCON is now turned off.
```

— then the password is not set or is shorter than 3 characters (messages from the binary).

### A.6 A public IP in the config breaks joining from the local network

This is not a Linux-specific problem, but on home and office servers it comes up
constantly, so I describe it in detail here.

**Symptom:** the server is visible in the browser and reachable by players from the internet, but
**you cannot join from your own machine or from the same local network**. The server log shows
nothing resembling a refusal — the packets simply do not reach it. Verified in practice:
joining did not work until forwarding from the public IP to the local one was configured on the router.

**Cause.** If an external public IP is set in the config (`publicAddress`) or by a parameter (`-bindIP`),
the server registers exactly that in the backend. All clients receive that same
address — both external ones and you. A packet from the local network goes to the public IP of your own
network and has to come back inside. This works only with **NAT hairpin** (NAT loopback) on the
router. Many home routers cannot do that.

**What the wiki recommends:** leave the address empty so that it is determined automatically.
For the local variant a keyword `"local"` is provided — "automatically
determine the local address of the network card".

**Solutions, from the best to the workable:**

1. Remove `publicAddress` (leave it empty) — the recommended path.
2. Try the `"local"` literal if the server is needed only inside the network.
   **Not verified** — the wiki describes the possibility without details.
3. Enable NAT hairpin / NAT loopback on the router.
4. Set up forwarding from the public IP to the local one — it works, but requires that
   all traffic to the public IP be routed inside.

**For a container this is especially important.** Inside Docker `publicAddress` has to be set
manually, otherwise the container IP will go to the backend (see A.7). But you must set the
**host address** visible from outside, not a public IP with the hairpin problem and not `172.17.x.x`.

**What not to do:** do not put the local address `192.168.x.x` into `publicAddress` if
the server must be reachable from the internet — external players will not reach it. And do not
try to fix this through `-bindIP`: it overrides both `bindAddress` and
`publicAddress`, that is, it will set the same address even more rigidly.

### A.7 Docker and containers

A ready-made image: `sknnr/arma-reforger-server` (unofficial). It is useful because it
shows a working set of variables and confirms the field names.

```bash
docker volume create reforger-data
docker run -d --name reforger-server \
  --mount type=volume,source=reforger-data,target=/home/steam/reforger \
  --publish 2001:2001/udp \
  --publish 17777:17777/udp \
  --publish 19999:19999/udp \
  --env=SERVER_NAME='My Reforger Server' \
  --env=ADMIN_PASSWORD='ChangeMe' \
  --env=SCENARIO_ID='{ECC61978EDCC2B5A}Missions/23_Campaign.conf' \
  --env=MAX_FPS='60' \
  sknnr/arma-reforger-server:latest
```

**The main subtlety of a container is addresses.** Inside the container `bindAddress` must
stay `0.0.0.0`, but `publicAddress` must be set manually: otherwise the server
will register the **container IP** in the backend, and players outside will not be able to connect.
In the BI wiki this is described outright: in Docker you need to set in the config `gameHostRegisterBindAddress`
and `gameHostRegisterPort` (the old names; now `publicAddress` and `publicPort`) to one
of the local IP:Port of the host machine.

Through the image variables this is done like this:

```bash
  --env=PUBLIC_ADDRESS='203.0.113.10' \
  --env=GAME_PORT='2001' \
```

> **Note one trap of the image.** Its documentation says: the environment variables
> **override** the values from the mounted `config.json`. So if you provided your own
> config but did not unset the variable, the variable wins. Pass unneeded variables
> empty: `--env=SERVER_NAME=''`.

### A.8 Linux-specific pitfalls

| Pitfall | The point |
|---|---|
| **Case in paths** | Linux is case-sensitive. `configs/` and `Configs/` are **different** directories. A scenario that was found on Windows may not be found here. This applies both to `scenarioId` and to mod paths. |
| **Write permissions** | The server needs write access to the `-profile` directory (logs, saves) and write access to the server directory when using `-createDB`. Running as root masks the problem and then breaks the file permissions. Keep a dedicated user. |
| **`-createDB` after an update** | If resources have moved or the database did not rebuild, `-createDB` helps — it forces regeneration of the database. |
| **`-logsDir` with an absolute path** | The wiki supports both a subdirectory name and a full path. In a systemd unit an absolute path is more predictable. |
| **Modal windows without graphics** | On a headless server the `Missing Addon` dialog cannot be shown. Look at `console.log` / `journalctl`, not at the screen. |
| **Backing up `ownerToken.bin`** | The file grants the rights of the server owner. On Linux it is easy to lose during a reinstall — keep a copy. |
| **Steam Linux Runtime** | A known problem `T165196`: the server does not work under Steam Linux Runtime. Launch the binary directly. |

### A.9 What this appendix does not cover

- **The exact name of the Linux binary.** There is nowhere to verify it; look at `ls` after installation (A.2).
- **A confirmed Linux depot number.** The manifest shows `1874901` and `1874903`, but
  which of them is the Linux depot does not follow from the wiki; SteamDB is closed by Cloudflare and forbids
  automated requests.
- **Verification that `console.log` on Linux contains the `CLI Params:` line.** I expect it does
  (it is an engine message), but I cannot confirm it — check it yourself, it is the fastest
  way to see what the server received.
- **Installation scripts from the official documentation.** BI does not publish any; everything that
  exists is third-party projects like `armactl` and container images.

### Appendix sources

| What | From |
|---|---|
| The application IDs (1874900 stable, 1890870 experimental), the note about Docker and `gameHostRegister*` | BI Wiki "Arma Reforger: Server Hosting" |
| "BE RCon uses the game server's network interface, i.e. its UDP game port" | The official [BattlEye RCon Protocol v2](https://www.battleye.com/downloads/BERConProtocol.txt) specification |
| The architecture "launch script + systemd + restart timers", launching with `-logStats`, the separation of code and runtime data | [dturovskiy/armactl](https://github.com/dturovskiy/armactl) — a server installer and manager for Ubuntu |
| The set of variables, the directory structure in the container, the override behaviour of `config.json`, the absence of ARM64, firewall and CGNAT recommendations | [jsknnr/arma-reforger-server](https://github.com/jsknnr/arma-reforger-server) — a container image |
| The problem of launching under Steam Linux Runtime | BI ticket `T165196` (visible in search results, the page itself is closed by Cloudflare) |

