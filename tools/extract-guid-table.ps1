# extract-guid-table.ps1
#
# Extracts the resource GUID -> path table from an Arma Reforger resource database
# (resourceDatabase.rdb). Useful for obtaining GUIDs that are otherwise only stored
# in Workbench .meta files, which are NOT shipped inside .pak archives.
#
# WHY THIS IS NEEDED
# ------------------
# A reference like {2B4183DF23E88249}Missions/CAH_Morton.conf consists of a resource
# GUID plus a path. The GUID normally lives in a <file>.meta sidecar. Packed game data
# contains no .meta files at all, and the GUID string does not appear anywhere inside
# the .pak files (verified: a full content scan of data007.pak for
# "2B4183DF23E88249" returned 0 hits among 28161 entries). The GUID is however present
# in resourceDatabase.rdb as raw little-endian bytes.
#
# RECORD LAYOUT (empirically determined and validated)
# ---------------------------------------------------
#   [u32 LE length][path UTF-8][0x00][6 bytes payload][GUID: 8 bytes little-endian]
#
# So the GUID begins exactly 7 bytes after the path's NUL terminator:
#   skip 6 unknown bytes, then read 8 bytes and reverse them to get the GUID string.
#
# VALIDATION
# ----------
# With -Validate the script checks its output against GUIDs published on the BI wiki.
# As of the 1.6.0.119 build all 8 known pairs matched exactly.

[CmdletBinding()]
param(
    # Path to resourceDatabase.rdb. The dedicated server copy is authoritative for
    # dedicated-server scenarios; the client/Workbench copy works too.
    [string]$Rdb = "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server\addons\data\resourceDatabase.rdb",

    # Substring that matching paths must START with (e.g. "Missions/", "worlds/", "Prefabs/").
    [string]$Filter = "Missions/",

    # Restrict to a file extension, or empty for any.
    [string]$Extension = ".conf",

    # Bytes between the path's NUL terminator and the GUID. 7 for this RDB format.
    [int]$GuidOffset = 7,

    # Write "{GUID}path<TAB>path" lines to this file. Empty = do not write.
    [string]$Out = "",

    # Compare against GUIDs documented on the BI wiki and report MATCH/MISMATCH.
    [switch]$Validate
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Rdb)) {
    throw "resourceDatabase.rdb not found: $Rdb"
}

Write-Host ("Reading {0} ({1:N0} bytes)..." -f $Rdb, (Get-Item -LiteralPath $Rdb).Length)
$bytes = [System.IO.File]::ReadAllBytes($Rdb)
# Latin-1 maps bytes 1:1 to chars, so string offsets equal byte offsets.
$latin = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)

$results = New-Object System.Collections.Generic.List[object]
$pos = 0
while ($true) {
    $i = $latin.IndexOf($Filter, $pos)
    if ($i -lt 0) { break }

    $end = $latin.IndexOf([char]0, $i)
    if ($end -lt 0) { break }

    $path = $latin.Substring($i, $end - $i)
    $pos = $i + 1

    # Keep only clean paths; a real resource path is printable and has no '/'-doubling.
    if ($path -notmatch '^[A-Za-z0-9_\-/\. ]+$') { continue }
    if ($path -match '//') { continue }
    if ($Extension -and -not $path.EndsWith($Extension)) { continue }

    $g = $end + $GuidOffset
    if ($g + 8 -gt $bytes.Length) { continue }

    $b = $bytes[$g..($g + 7)]
    $guid = ($b[7..0] | ForEach-Object { $_.ToString('X2') }) -join ''
    if ($guid -notmatch '^[0-9A-F]{16}$') { continue }
    if ($guid -eq '0000000000000000') { continue }

    $results.Add([pscustomobject]@{ Guid = $guid; Path = $path })
}

$uniq = $results | Sort-Object Path -Unique

if ($Out) {
    $lines = $uniq | ForEach-Object { "{{{0}}}{1}" -f $_.Guid, $_.Path }
    Set-Content -LiteralPath $Out -Value $lines -Encoding utf8
    Write-Host ("Wrote {0} entries to {1}" -f $uniq.Count, $Out)
}

if ($Validate) {
    # GUIDs published on https://community.bistudio.com/wiki/Arma_Reforger:Server_Config
    $known = [ordered]@{
        'Missions/23_Campaign.conf'     = 'ECC61978EDCC2B5A'
        'Missions/21_GM_Eden.conf'      = '59AD59368755F41A'
        'Missions/22_GM_Arland.conf'    = '2BBBE828037C6F4B'
        'Missions/Tutorial.conf'        = '002AF7323E0129AF'
        'Missions/CAH_Castle.conf'      = 'F1A1BEA67132113E'
        'Missions/CAH_Factory.conf'     = '9405201CBD22A30C'
        'Missions/CAH_LeMoule.conf'     = '7C491B1FCC0FF0E1'
        'Missions/CAH_Morton.conf'      = '2B4183DF23E88249'
    }
    Write-Host "`n=== Validation against BI wiki GUIDs ==="
    $fail = 0
    foreach ($k in $known.Keys) {
        $row = $uniq | Where-Object { $_.Path -eq $k }
        if (-not $row) {
            Write-Host ("{0,-32} NOT FOUND" -f $k) -ForegroundColor Yellow
            $fail++
        } elseif ($row.Guid -eq $known[$k]) {
            Write-Host ("{0,-32} {1}  MATCH" -f $k, $row.Guid) -ForegroundColor Green
        } else {
            Write-Host ("{0,-32} rdb={1} expected={2}  MISMATCH" -f $k, $row.Guid, $known[$k]) -ForegroundColor Red
            $fail++
        }
    }
    if ($fail -eq 0) { Write-Host "All checks passed." -ForegroundColor Green }
    else { Write-Host "$fail check(s) failed - do NOT trust this table." -ForegroundColor Red }
}

Write-Host ""
Write-Host ("=== {0} unique entries for filter '{1}' ===" -f $uniq.Count, $Filter)
$uniq | ForEach-Object { "{{{0}}}{1}" -f $_.Guid, $_.Path }
