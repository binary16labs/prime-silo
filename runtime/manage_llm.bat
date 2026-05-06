@echo off
REM =============================================================================
REM Benny LLM Service Manager
REM Start, stop, and check status of local LLM providers
REM =============================================================================

if "%1"=="" goto :help
if "%1"=="start-lemonade" goto :start_lemonade
if "%1"=="start-ollama" goto :start_ollama
if "%1"=="start-fastflow" goto :start_fastflow
if "%1"=="stop-all" goto :stop_all
if "%1"=="status" goto :status
if "%1"=="help" goto :help
goto :help

:start_lemonade
echo Starting Lemonade server on port 13305...
start "lemonade" cmd /k "LemonadeServer.exe serve --port 13305"
echo ✅ Lemonade started
goto :eof

:start_ollama
echo Starting Ollama server on port 11434...
start "ollama" cmd /k "ollama serve"
echo ✅ Ollama started
goto :eof

:start_fastflow
echo Starting FastFlowLM (gemma3:4b) on port 52625...
start "FastFlowLM" cmd /k "flm serve gemma3:4b --port 52625"
echo ✅ FastFlowLM started
goto :eof

:stop_all
echo Stopping all LLM services...
taskkill /FI "WINDOWTITLE eq lemonade*" /F 2>nul
taskkill /IM ollama.exe /F 2>nul
taskkill /FI "WINDOWTITLE eq FastFlowLM*" /F 2>nul
echo ✅ All LLM services stopped
goto :eof

:status
echo.
echo ============================================
echo   Local LLM Provider Status
echo ============================================
echo.
curl -s http://localhost:13305/api/v1/models >nul 2>&1 && echo   Lemonade (13305):   ✅ RUNNING || echo   Lemonade (13305):   ❌ STOPPED
curl -s http://localhost:11434/v1/models >nul 2>&1 && echo   Ollama (11434):     ✅ RUNNING || echo   Ollama (11434):     ❌ STOPPED
curl -s http://localhost:52625/v1/models >nul 2>&1 && echo   FastFlowLM (52625): ✅ RUNNING || echo   FastFlowLM (52625): ❌ STOPPED
echo.
goto :eof

:help
echo.
echo Benny LLM Service Manager
echo.
echo Usage: manage_llm.bat [command]
echo.
echo Commands:
echo   start-lemonade   Start Lemonade server (AMD NPU - Port 13305)
echo   start-ollama     Start Ollama server
echo   start-fastflow   Start FastFlowLM server (Intel NPU)
echo   stop-all         Stop all LLM services
echo   status           Check status of all providers
echo   help             Show this help
echo.
goto :eof
