#requires -Version 5.1
<#
.SYNOPSIS
    Redeploy del stack showroom: actualiza desde GitHub y rebuilda solo lo
    necesario, sin bajar todo el stack.

.DESCRIPTION
    1. git pull --ff-only origin main (avisa si hay cambios locales)
    2. docker compose up -d --build --remove-orphans
       - Compose detecta cambios y recrea solo los containers cuya imagen
         cambio (~5-10s de downtime por servicio cambiado).
       - MySQL queda corriendo si su imagen no cambio (lo normal).
       - --remove-orphans limpia containers viejos si se renombro un servicio.
    3. docker image prune -f (limpia dangling images del rebuild)
    4. Espera a que el backend llegue a healthy (timeout ~2.5 min)
    5. docker compose ps + tail de logs del backend + URLs

    Si necesitas bajar todo (ej. para borrar volumes con `down -v` o forzar
    estado limpio), corre `docker compose down` aparte antes del script.

    Aborta limpio si cualquier paso falla. Trabaja siempre desde el directorio
    donde vive el script, asi funciona desde cualquier CWD o doble-click.

    NOTA DE ENCODING: el script se mantiene en ASCII puro (sin tildes ni
    em-dash). PowerShell 5.1 sin BOM interpreta el archivo en la codepage del
    sistema (CP1252 en Windows ES), y los caracteres multi-byte UTF-8 rompen el
    parser - en particular el em-dash, que decodifica con una comilla doble que
    parte los strings.

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
    Write-Host '        Copia .env.example a .env y completa las rutas/secretos.' -ForegroundColor Red
    exit 1
}

# Helpers --------------------------------------------------------------------

function Write-Section {
    param([int]$Step, [int]$Total, [string]$Title)
    Write-Host ''
    Write-Host ("=== [{0}/{1}] {2} " -f $Step, $Total, $Title.PadRight(60, '=')) -ForegroundColor Cyan
}

# Las CLIs nativas (docker, git) no tiran terminating errors aunque
# $ErrorActionPreference este en Stop - hay que chequear $LASTEXITCODE a mano.
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

Write-Section 1 5 'Actualizando desde GitHub'

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

Write-Section 2 5 'Rebuild y up del stack'
# Sin `down` previo: Compose detecta que la imagen cambio y recrea solo los
# containers afectados. MySQL queda corriendo si su imagen no cambio. Esto
# baja el downtime de ~3 min (down + build + up) a ~10 s (solo recreate del
# backend) y evita reiniciar Hikari/buffer pool de MySQL en cada deploy.
# --remove-orphans limpia containers viejos si se renombro un servicio.
Invoke-Step -Action { docker compose --env-file $envFile -f $composeFile up -d --build --remove-orphans } `
    -ErrorMessage 'Fallo "docker compose up". Revisa los logs con: docker compose logs -f'

Write-Section 3 5 'Limpiando imagenes dangling'
# Cada `--build` deja la imagen vieja como <none>. Sin prune se acumulan y
# llenan el disco. -f evita el prompt interactivo. No tocamos volumes.
docker image prune -f

Write-Section 4 5 'Esperando que el backend este healthy'
# El healthcheck del compose tiene start_period=60s + 5 retries x 15s = ~135s
# en el peor caso. Damos 150s de margen y polleamos cada 5s. Si no llega a
# healthy, abortamos mostrando los ultimos logs para debug rapido - sin esto,
# el script terminaba diciendo "OK" aunque el backend estuviera en loop de
# restart, y el bug solo se detectaba al usar la app.
$timeoutSec = 150
$intervalSec = 5
$elapsed = 0
$status = ''
while ($elapsed -lt $timeoutSec) {
    # 2>$null silencia el error si el container todavia no existe en docker.
    $status = (docker inspect --format='{{.State.Health.Status}}' showroom-backend 2>$null)
    if ($status -eq 'healthy') { break }
    if ($status -eq 'unhealthy') { break }
    Start-Sleep -Seconds $intervalSec
    $elapsed += $intervalSec
    Write-Host ("  ... {0}/{1}s - estado: {2}" -f $elapsed, $timeoutSec, $status) -ForegroundColor DarkGray
}
if ($status -ne 'healthy') {
    Write-Host ("[ERROR] Backend no llego a 'healthy' (estado final: {0})" -f $status) -ForegroundColor Red
    Write-Host 'Ultimos 100 lineas del backend:' -ForegroundColor Yellow
    docker compose --env-file $envFile -f $composeFile logs --tail 100 backend
    exit 1
}
Write-Host '[OK] Backend healthy' -ForegroundColor Green

Write-Section 5 5 'Estado final'
docker compose --env-file $envFile -f $composeFile ps

Write-Host ''
Write-Host 'Ultimas lineas del backend:' -ForegroundColor DarkGray
docker compose --env-file $envFile -f $composeFile logs --tail 30 backend

Write-Host ''
Write-Host 'OK - Redeploy terminado.' -ForegroundColor Green
Write-Host ' - Frontend:  http://localhost:8080'
Write-Host ' - Backend:   http://localhost:8081/api/showroom/health'
Write-Host ''
Write-Host 'Para ver logs en vivo:  docker compose logs -f' -ForegroundColor DarkGray
