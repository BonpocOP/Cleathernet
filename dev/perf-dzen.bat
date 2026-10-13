@echo off
rem dzen.ru: 5 runs with and without RU AdList Counters. Russian VPN on.
rem About 10 minutes. ASCII only: Cyrillic text in .bat breaks cmd.exe parsing.
cd /d "%~dp0"
node perf-ru.mjs --only dzen.ru --runs 5 --configs rus-1 --tag dzen
pause
