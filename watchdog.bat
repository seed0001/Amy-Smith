@echo off
rem ============================================================
rem  Champ watchdog - restarts the bot when core files change
rem
rem  Watches src\, knowledge\, persona.md, package.json and
rem  start.bat. When any of them changes it kills the running
rem  node process, then relaunches start.bat.
rem
rem  Run THIS instead of start.bat. It launches the bot itself.
rem  Close this window to stop watching (the bot keeps running).
rem  Activity is written to watchdog.log next to this file.
rem ============================================================
setlocal
cd /d "%~dp0"

set "ROOT=%~dp0"
set "STAMP=%TEMP%\champ-watch-stamp.txt"
set "NEW=%TEMP%\champ-watch-new.txt"
set "LOG=%~dp0watchdog.log"

echo [%date% %time%] watchdog started>>"%LOG%"

call :snapshot "%STAMP%"
call :launch

:watch
timeout /t 3 /nobreak >nul
call :snapshot "%NEW%"
fc /b "%STAMP%" "%NEW%" >nul 2>&1
if errorlevel 1 goto changed
goto watch

:changed
rem The doctor is editing her code: don't restart mid-visit (the owner restarts her after).
if exist "%ROOT%data\doctor.lock" (
  copy /y "%NEW%" "%STAMP%" >nul
  goto watch
)
echo [%date% %time%] change detected, restarting>>"%LOG%"
echo [watchdog] Change detected - restarting bot.
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -like '*src/index.js*' } ^| Select-Object -ExpandProperty ProcessId"`) do (
  echo [watchdog] killing node pid %%P
  taskkill /PID %%P /F >nul 2>&1
)
timeout /t 2 /nobreak >nul
copy /y "%NEW%" "%STAMP%" >nul
goto launch

:launch
call "%ROOT%start.bat"
call :snapshot "%STAMP%"
goto watch

:snapshot
rem One line per file: full path | byte size | last-write ticks.
powershell -NoProfile -Command "$p='%ROOT%'; $f=@(); foreach($d in @('src','knowledge')){ $f += Get-ChildItem -LiteralPath (Join-Path $p $d) -Recurse -File -ErrorAction SilentlyContinue }; foreach($n in @('persona.md','package.json','start.bat')){ $i = Get-Item -LiteralPath (Join-Path $p $n) -ErrorAction SilentlyContinue; if($i){ $f += $i } }; $f | Sort-Object FullName | ForEach-Object { '{0}|{1}|{2}' -f $_.FullName, $_.Length, $_.LastWriteTimeUtc.Ticks }" > "%~1"
exit /b 0
