@echo off
:: Change directory to the folder where this batch file is located
cd /d "%~dp0"

echo Installing dependencies...
call npm install

echo Building the project...
call npm run build

echo Build complete!
pause