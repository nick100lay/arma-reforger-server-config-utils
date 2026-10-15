# probe-keys.ps1
#
# Reports whether each of a list of names occurs in an Arma Reforger server executable, by
# searching its strings. Used to check startup parameters and config field names against a
# build (docs/en/ArmaReforger_StartupParams_EN.md section 8).
#
# USAGE
# -----
#   powershell -ExecutionPolicy Bypass -File tools/probe-keys.ps1 -Keys @('maxFPS','playerLimits')
#
# -ExecutionPolicy Bypass is required on a stock Windows setup: without it the script does not
# load at all ("is not digitally signed"). Same for tools/extract-guid-table.ps1.
#
# READING THE OUTPUT
# ------------------
# The "as bare" column is a substring search and is therefore weak evidence: a hit can belong
# to unrelated code. A hit is NOT proof that a parameter works or that a config field is
# accepted, and the absence of a string is not proof either — -autoreload and -autoshutdown
# have no string in the binary yet were accepted on a real command line.
#
# For the whole set of checks at once (absent parameters, obsolete field names, scenario GUIDs,
# installed build version) use tools/verify-against-install.mjs instead.
param(
    [string]$Exe = "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server\ArmaReforgerServer.exe",
    [string[]]$Keys = @(
        'bindAddress','bindPort','publicAddress','publicPort',
        'gameHostBindAddress','gameHostBindPort','gameHostRegisterBindAddress','gameHostRegisterPort',
        'dedicatedServerId','region','serverId','ownerType',
        'scenarioId','maxPlayers','passwordAdmin','admins','visible','name','password',
        'mods','modId','modID','version','required','modsRequiredByDefault',
        'supportedPlatforms','crossPlatform','gameProperties',
        'serverMaxViewDistance','serverMinGrassDistance','networkViewDistance',
        'fastValidation','battlEye','disableThirdPerson',
        'VONDisableUI','VONDisableDirectSpeechUI','VONCanTransmitCrossFaction','missionHeader',
        'operating','lobbyPlayerSynchronise','disableCrashReporter','disableServerShutdown',
        'aiLimit','disableAI','disableNavmeshStreaming','slotReservationTimeout','playerSaveTime','joinQueue','maxSize',
        'a2s','rcon','permission','whitelist','blacklist','maxClients','address','port'
    )
)
$bytes = [System.IO.File]::ReadAllBytes($Exe)
$ascii = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)

"{0,-34} {1,-10} {2,-12} {3}" -f 'KEY', 'as "key"', 'as bare', 'offsets (first 3, quoted-preferring)'
"-" * 100
foreach ($k in $Keys) {
    $quoted = '"' + $k + '"'
    $qHits = New-Object System.Collections.Generic.List[int]
    $i = $ascii.IndexOf($quoted)
    while ($i -ge 0 -and $qHits.Count -lt 3) { $qHits.Add($i); $i = $ascii.IndexOf($quoted, $i + 1) }

    $bHits = New-Object System.Collections.Generic.List[int]
    $i = $ascii.IndexOf($k)
    while ($i -ge 0 -and $bHits.Count -lt 3) { $bHits.Add($i); $i = $ascii.IndexOf($k, $i + 1) }

    $off = if ($qHits.Count) { ($qHits | ForEach-Object { $_.ToString('X') }) -join ' ' }
           elseif ($bHits.Count) { ($bHits | ForEach-Object { $_.ToString('X') }) -join ' ' }
           else { '' }
    "{0,-34} {1,-10} {2,-12} {3}" -f $k, $qHits.Count, $bHits.Count, $off
}
