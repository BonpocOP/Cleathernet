@echo off
rem Sweep of ad-heavy sites (test\ad-sites.json): each site with Cleathernet, without it,
rem and with extra engine rulesets (A/B: RU AdList Counters, URL tracking params).
rem Also measures speed (requests, traffic, load, scripts) with and without us.
rem Turn on a Russian VPN first to see Russian ads. Takes about 2.5-3 hours.
rem Result: test\fixtures\raw\sweep\<date>\index.html - opens by itself at the end.
rem If interrupted, just run again: it continues the unfinished sweep.
rem ASCII only: Cyrillic text in .bat breaks cmd.exe parsing. Details: sweep.mjs.
cd /d "%~dp0"
node build.mjs
node build-extension.mjs
node sweep.mjs --continue --open --ab rus-1,adguard-spyware-url
pause
