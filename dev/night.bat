@echo off
rem Night run: sweep of ad-heavy sites while you sleep (details: night.ps1, sweep.mjs).
rem 1. Turn on the Russian VPN. 2. Run this file. 3. Do not close the black console window (browsers run without windows).
rem The computer will not go to sleep until it finishes (by 16:00; other time: night.bat 12:00).
rem Claude is not needed while it runs - you can close it.
rem Morning: results are in test\fixtures\raw\sweep\<date>\index.html, log - dev\night-*.log.
rem Captcha on a site - it is skipped (never solved); many captchas - the run stops itself.
rem ASCII only: Cyrillic text in .bat breaks cmd.exe parsing.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0night.ps1" %1
