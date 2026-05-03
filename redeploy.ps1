#requires -Version 5.1
<#
.SYNOPSIS
    Redeploy del stack showroom: baja docker, actualiza desde GitHub y vuelve a
    levantarlo con --build.

.DESCRIPTION
    1. docker compose down (con --env-file y -f explícitos)
    2. git pull --ff-only origin main (avisa si hay cambios locales)
    3. docker compose up -d --build
    4. docker image prune -f (limpia dangling images del rebuild)
    5. docker compose ps + URLs

    Aborta limpio si cualquier paso falla. Trabaja siempre desde el directorio
    donde vive el script, así funciona desde cualquier CWD o doble-click.

    Repo: https://github.com/Leo-Virgolini/showroom.git
#>

# Trabajamos siempre desde el dir del script.
Set-Location -Path $PSScriptRoot

# Paths absolutos para que docker compose no dependa del CWD ni de variables
# heredadas del entorno: el .env se pasa explicito en cada comando.
$envFile = Join-Path $PSScriptRoot '.env'
$composeFile = Join-Path $PSScriptRoot 'docker-compose.yml'

# Validacion temprana: docker-compose.yml referencia variables del .env
# (DUX_EMPRESA_ID, DUX_SECRETS_PATH, SHOWROOM_IMAGENES_PATH, etc.). Sin .env
# el "up" arranca pero los volumes quedan rotos y la app falla en runtime.
if (-not (Test-Path $envFile)) {
    Write-Host "[ERROR] Falta $envFile" -ForegroundColor Red
    Write-Host '        Copiá .env.example a .env y completá las rutas/secretos.' -ForegroundColor Red
    exit 1
}

# Helpers --------------------------------------------------------------------

function Write-Section {
    param([int]$Step, [int]$Total, [string]$Title)
    Write-Host ''
    Write-Host ("=== [{0}/{1}] {2} " -f $Step, $Total, $Title.PadRight(60, '=')) -ForegroundColor Cyan
}

# Las CLIs nativas (docker, git) no tiran terminating errors aunque
# $ErrorActionPreference esté en Stop — hay que chequear $LASTEXITCODE a mano.
function Invoke-Step {
    param(
        [Parameter(Mandatory)] [scriptblock]$Action,
        [Parameter(Mandatory)] [string]$ErrorMessage
    )
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] $ErrorMessage (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

# Pipeline -------------------------------------------------------------------

Write-Section 1 5 'Bajando containers'
Invoke-Step -Action { docker compose --env-file $envFile -f $composeFile down } `
    -ErrorMessage 'Fallo "docker compose down".'

Write-Section 2 5 'Actualizando desde GitHub'

# Aviso si hay cambios locales: el pull con --ff-only podria fallar.
git diff --quiet
$dirty = $LASTEXITCODE -ne 0
git diff --cached --quiet
$staged = $LASTEXITCODE -ne 0
if ($dirty -or $staged) {
    Write-Host '[AVISO] Hay cambios locales sin commitear en el working tree.' -ForegroundColor Yellow
    Write-Host '        Si "git pull" falla, commitealos o descartalos antes de reintentar.' -ForegroundColor Yellow
}

Invoke-Step -Action { git pull --ff-only origin main } `
    -ErrorMessage 'Fallo "git pull". Resolve el conflicto y volve a correr el script.'

Write-Section 3 5 'Rebuild y up del stack'
Invoke-Step -Action { docker compose --env-file $envFile -f $composeFile up -d --build } `
    -ErrorMessage 'Fallo "docker compose up". Revisa los logs con: docker compose logs -f'

Write-Section 4 5 'Limpiando imagenes dangling'
# Cada `--build` deja la imagen vieja como <none>. Sin prune se acumulan y
# llenan el disco. -f evita el prompt interactivo. No tocamos volumes.
docker image prune -f

Write-Section 5 5 'Estado final'
docker compose --env-file $envFile -f $composeFile ps

Write-Host ''
Write-Host 'OK - Redeploy terminado.' -ForegroundColor Green
Write-Host ' - Frontend:  http://localhost:8080'
Write-Host ' - Backend:   http://localhost:8081/api/showroom/health'
Write-Host ''
Write-Host 'Para ver logs en vivo:  docker compose logs -f' -ForegroundColor DarkGray
