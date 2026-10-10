@echo off
rem Замер наборов движка с российского IP (этап 7 плана). Запускать
rem двойным щелчком, когда включён российский VPN. Идёт час-полтора;
rem окно можно свернуть, но не закрывать. Итог — в docs\research\
rem perf-rulesets.json, журнал — в docs\research\perf-ru.log.
chcp 65001 >nul
cd /d "%~dp0"
echo Сборка Cleathernet...
call npm run build:ext > ..\docs\research\perf-ru.log 2>&1
if errorlevel 1 (
    echo Сборка не удалась, подробности в docs\research\perf-ru.log
    pause
    exit /b 1
)
echo Замер идёт, около полутора часов. Ход — в docs\research\perf-ru.log
node perf-rulesets.mjs --geo-ru --runs 2 >> ..\docs\research\perf-ru.log 2>&1
if errorlevel 1 (
    echo Замер прервался, подробности в docs\research\perf-ru.log
) else (
    echo Готово. Результат: docs\research\perf-rulesets.json
)
pause
