# Night run of sweep.mjs (night.bat starts it). Runs without Claude: start it and go to sleep.
# Keeps the computer awake (SetThreadExecutionState: no sleep, the screen may turn off).
# Before the run - the latest stable Chrome for Testing (security fixes; the browser
# shows real third-party ads for hours). If the download fails - the run does not start.
# Pass 1: all sites + one article each, with Cleathernet / without / with extra engine
#         rulesets (what each of them breaks), speed, header check. About 5-6 hours.
# Pass 2, 3: if time is left - main pages again in random order (speed samples,
#         is the text loss stable). At most 3 passes: a site is opened about 20 times a day.
# Stops by itself at 16:00 (or the time given: night.bat 12:00); on captchas it skips the site, pauses, and stops if many
# (then no more passes).
param([string]$Until = '16:00')
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
Add-Type -Namespace Night -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[Night.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
# Deadline: today, or tomorrow if that time has already passed (started before midnight).
$deadline = Get-Date $Until
if ($deadline -le (Get-Date)) { $deadline = $deadline.AddDays(1) }
$log = Join-Path $PSScriptRoot ('night-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.log')
try {
    $chrome = (npx --yes @puppeteer/browsers install chrome@stable --path (Join-Path $PSScriptRoot '.browsers\stable') 2>> $log | Select-Object -Last 1)
    $exe = ($chrome -split ' ', 2)[1]
    if (-not $exe -or -not (Test-Path $exe)) {
        'No fresh Chrome (download failed) - not starting. Check the internet / VPN and run again.' | Tee-Object -FilePath $log -Append
        return
    }
    $env:YGAB_CHROME = $exe
    "Chrome: $chrome" | Tee-Object -FilePath $log -Append
    node build.mjs *>> $log
    node build-extension.mjs *>> $log
    node sweep.mjs --night --until $until --ab annoyances-social,annoyances-widgets,annoyances-others,adguard-spyware-url,rus-1 *>&1 | Tee-Object -FilePath $log -Append
    # Exit code 2: stopped on captchas - the IP looks flagged, do not go on.
    $pass = 1
    while ($LASTEXITCODE -ne 2 -and $pass -lt 3 -and (Get-Date) -lt $deadline) {
        $pass += 1
        node sweep.mjs --night --no-deep --shuffle --until $until *>&1 | Tee-Object -FilePath $log -Append
    }
    "Night run finished: $(Get-Date -Format 'HH:mm'), passes: $pass" | Tee-Object -FilePath $log -Append
} finally {
    # ES_CONTINUOUS: back to normal sleep settings
    [Night.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null
}
