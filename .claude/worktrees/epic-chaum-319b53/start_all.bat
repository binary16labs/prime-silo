@echo off
REM =============================================================================
REM Benny Full Stack Launcher
REM Starts: Marquez (Docker), LLM Provider, Backend (Uvicorn), Frontend (Vite)
REM =============================================================================

if "%1"=="stop" goto :stop_stack
if "%1"=="help" goto :help

REM Default LLM Provider
set LLM_PROVIDER=lemonade
if not "%1"=="" set LLM_PROVIDER=%1

echo.
echo ===================================================
echo   Starting Benny Stack
echo   Provider: %LLM_PROVIDER%
echo ===================================================
echo.

REM 1. Start Marquez (OpenLineage)
echo [1/4] Starting Marquez (OpenLineage)...
docker-compose up -d neo4j marquez-db marquez-api marquez-web

REM 2. Start LLM Provider
echo [2/4] Starting LLM Service (%LLM_PROVIDER%)...
if "%LLM_PROVIDER%"=="litert" (
    echo Note: LiteRT uses local library but falls back to Lemonade NPU for Windows support.
    call manage_llm.bat start-lemonade
) else (
    call manage_llm.bat start-%LLM_PROVIDER%
)

REM 3. Start Backend
echo [3/4] Starting Backend Server (using Python 3.12)...
set PYTHONUTF8=1
start "Benny Backend" cmd /k "C:\Users\nsdha\miniforge3\python.exe -m uvicorn benny.api.server:app --reload --host 0.0.0.0 --port 8005"

REM 4. Start Frontend
echo [4/4] Starting Frontend...
cd frontend
start "Benny Frontend" cmd /k "npm run dev"
cd ..

echo.
echo ✅ Distributed Stack Initialized.
echo    - Ryzen Server IP: 192.168.68.134
echo    - Backend Docs:  http://192.168.68.134:8005/docs
echo    - Frontend: http://localhost:5173 (on Thinkpad)
echo.
goto :eof

:stop_stack
echo.
echo ===================================================
echo   Stopping Benny Stack
echo ===================================================
echo.

echo [1/3] Stopping LLM Services...
call manage_llm.bat stop-all

echo [2/3] Stopping Docker Services (Marquez)...
docker-compose stop marquez-db marquez-api marquez-web

echo [3/3] Closing Backend & Frontend Windows...
taskkill /FI "WINDOWTITLE eq Benny Backend*" /F 2>nul
taskkill /FI "WINDOWTITLE eq Benny Frontend*" /F 2>nul

echo.
echo ✅ All services stopped.
goto :eof

:help
echo.
echo Usage: start_all.bat [provider|stop]
echo.
echo Options:
echo   [provider]   Start stack with specific LLM (fastflow, ollama, lemonade). Default: fastflow
echo   stop         Stop all running services
echo.
goto :eof
