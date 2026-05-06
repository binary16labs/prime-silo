@echo off
REM Load environment variables from .env if it exists
if exist .env (
    for /f "tokens=*" %%i in (.env) do set %%i
)

echo Starting Benny Development Environment...

echo [1/3] Starting Docker infrastructure (Marquez, Phoenix, Neo4j)...
docker-compose up -d

echo [2/3] Starting Backend API Server...
start "Benny Backend API" cmd /k ".\venv\Scripts\python.exe -m uvicorn benny.api.server:app --reload --host 0.0.0.0 --port %BACKEND_PORT%"

echo [3/3] Starting Frontend Development Server...
start "Benny Frontend" cmd /k "cd frontend && npm run dev"

echo.
echo ========================================================
echo Benny has been started!
echo ========================================================
echo - API Server:        http://localhost:%BACKEND_PORT%
echo - API Docs:          http://localhost:%BACKEND_PORT%/docs
echo - Marquez Lineage:   http://localhost:%MARQUEZ_WEB_PORT%
echo - Phoenix Tracing:   http://localhost:%PHOENIX_PORT%
echo - Neo4j Studio:      http://localhost:%NEO4J_HTTP_PORT%
echo.
echo Note: If frontend isn't installed yet, run 'npm install' in the frontend folder.
echo ========================================================
