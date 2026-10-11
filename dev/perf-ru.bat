@echo off
rem Ruleset speed benchmark from a Russian IP. Double-click with Russian VPN on.
rem Takes 1-1.5 hours; if interrupted, run again - it resumes. Details: perf-ru.mjs.
rem ASCII only: Cyrillic text in .bat breaks cmd.exe parsing.
cd /d "%~dp0"
node perf-ru.mjs
pause
