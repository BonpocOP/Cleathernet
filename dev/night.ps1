# Night run of sweep.mjs (night.bat starts it). Runs without Claude: start it and go to sleep.
# Keeps the computer awake (SetThreadExecutionState: no sleep, the screen may turn off).
# Before the run - the latest stable Chrome for Testing (security fixes; the browser
# shows real third-party ads for hours). If the download fails - the run does not start.
# Pass 1: all sites + one article each, with Cleathernet / without / with extra engine
#         rulesets (what each of them breaks), speed, header check.
#         Measured 14.10: 177 addresses (108 sites + 69 articles) in 140 min, ~47 s each.
# Pass 2: only the addresses where text went missing in pass 1 (live feed or a real
#         loss?) - 13 addresses after the 14.10 run, so ~10-15 min. No more passes: speed over VPN
#         is noise, and every extra visit raises the captcha risk (decision 14.10).
# Stops by itself at 09:00 (or the time given: night.bat 12:00); a hung page is dropped
# after 6 min, and 15 min after the deadline sweep.mjs exits whatever happens.
# On captchas it skips the site, pauses, and stops if many (then no pass 2).
param([string]$Until = '09:00')
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Add-Type -Namespace Night -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[Night.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
# Deadline: today, or tomorrow if that time has already passed (started before midnight).
$deadline = Get-Date $Until
if ($deadline -le (Get-Date)) { $deadline = $deadline.AddDays(1) }
$log = Join-Path $PSScriptRoot ('night-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.log')
# node prints UTF-8: without this PowerShell 5.1 reads it as OEM 866 and the log
# comes out garbled (14.10). Log lines are written as UTF-8 by Log, not Tee/>>.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Log { process { $line = "$_"; $line; Add-Content -Path $log -Value $line -Encoding UTF8 } }
try {
    $chrome = (npx.cmd --yes '@puppeteer/browsers' install chrome@stable --path (Join-Path $PSScriptRoot '.browsers\stable') 2>&1 | Log | Where-Object { $_ -match '^chrome@' } | Select-Object -Last 1)
    $exe = ($chrome -split ' ', 2)[1]
    if (-not $exe -or -not (Test-Path $exe)) {
        'No fresh Chrome (download failed) - not starting. Check the internet / VPN and run again.' | Log
        return
    }
    $env:YGAB_CHROME = $exe
    "Chrome: $chrome" | Log
    node build.mjs 2>&1 | Log | Out-Null
    node build-extension.mjs 2>&1 | Log | Out-Null
    node sweep.mjs --night --until $until --ab annoyances-social,annoyances-widgets,annoyances-others,adguard-spyware-url,rus-1 2>&1 | Log
    # Exit code 2: stopped on captchas - the IP looks flagged, do not go on.
    $pass = 1
    if ($LASTEXITCODE -ne 2 -and (Get-Date) -lt $deadline) {
        $pass = 2
        node sweep.mjs --night --recheck last --until $until --ab annoyances-social,annoyances-widgets,annoyances-others,adguard-spyware-url,rus-1 2>&1 | Log
    }
    "Night run finished: $(Get-Date -Format 'HH:mm'), passes: $pass" | Log
} finally {
    # ES_CONTINUOUS: back to normal sleep settings
    [Night.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null
}
