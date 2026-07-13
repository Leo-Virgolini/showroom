# Pickit en el VPS — configuración de infraestructura

Cómo funciona la generación de pickit ahora que el showroom corre en el VPS (Hetzner + Coolify) y el programa `Pickit y Etiquetas.jar` ya no está en la misma máquina.

## Contexto

El backend ejecuta el jar `Pickit y Etiquetas.jar` en modo CLI (`--pickit-manual`) para generar el Excel de pickit tras cada pedido. Antes el jar y sus Excels (`Stock.xlsx`, `Combos.xls`) vivían en la misma PC. Ahora:

- El jar y los Excels viven en una **PC del depósito** (LAN), donde la operadora **sigue usando el jar a mano** y los Excels se **descargan varias veces al día**.
- Esa carpeta está **sincronizada con Google Drive** por la PC.
- El backend está en el **VPS**, lejos de esos archivos.

**Solución:** reusar el patrón de las imágenes. Un cron de `rclone` en el VPS baja la carpeta pickit de Drive al host; el backend la monta read-only y ejecuta el jar (que **corre headless en Linux** — verificado). El resultado se auto-descarga en el navegador del operador y además vuelve a la subcarpeta "Pickits y Carros" de Drive para que quede accesible en el depósito.

> El jar corre headless porque `EtiquetasApp.main()` detecta `--pickit-manual` y llama a `PickitCli.run()` **antes** de `launch()`, sin inicializar JavaFX. El runtime del backend (`eclipse-temurin:25-jre`) ya tiene Java.

## Flujo

```
PC depósito ──(Google Drive para escritorio)──> Google Drive ◄─────────────┐
   jar + Stock.xlsx + Combos.xls                     │                      │ (subida aditiva
                                    cron /root/sync-imagenes.sh (cada 5 min) │  rclone move a
                            BAJADA (sync) ───────────▼                       │  "Pickits y Carros")
                                        /data/supermaster/pickit  (host, :ro)│
                                                      │                      │
   [pedido] ──► backend ejecuta el jar leyendo /app/pickit (headless)        │
                                                      │                      │
                                        /data/showroom/pickit-out (rw) ───────┘
                                                      │
                                        auto-descarga del .xlsx en el navegador (SSE pickit-externo)
```

- **Frescura de los Excels de entrada:** máximo ~5 min (ciclo del cron).
- **Salida:** el operador la recibe al instante por auto-descarga; la copia en Drive/depósito aparece en ≤5 min (próximo ciclo del cron).

## Datos concretos del deploy

| Ítem | Valor |
|---|---|
| Remote rclone | `gdrive:` |
| Carpeta pickit en Drive (folder ID) | `1zp0_l2VzwmomRx054MQpMjTAUGxLwZl2` |
| Link de la carpeta | https://drive.google.com/drive/folders/1zp0_l2VzwmomRx054MQpMjTAUGxLwZl2 |
| Entrada en el host (`:ro`) | `/data/supermaster/pickit` (jar + `Stock.xlsx` + `Combos.xls`) |
| Salida en el host (`rw`) | `/data/showroom/pickit-out` — `chown 999:999` (uid del user `app` del container) |
| Destino de la salida en Drive | subcarpeta `Pickits y Carros` (dentro de la carpeta pickit) |
| Script del cron | `/root/sync-imagenes.sh` (cada 5 min vía `crontab -l`) |
| Log del sync pickit | `/var/log/sync-pickit.log` |
| Combos | Nombre real en disco: **`Combos.xls`** (formato viejo, NO `.xlsx`) |

## Componentes

### 1. Cron de rclone (`/root/sync-imagenes.sh`)

El sync del pickit se agregó al script existente de imágenes (mismo lock, mismo ciclo de 5 min). Dos líneas: **bajada** de los insumos y **subida** de los generados.

```bash
# Pickit — BAJADA: jar + Excels, solo la raíz de la carpeta (excluye subcarpetas)
rclone sync gdrive: /data/supermaster/pickit --drive-root-folder-id 1zp0_l2VzwmomRx054MQpMjTAUGxLwZl2 --include "Pickit y Etiquetas.jar" --include "Stock.xlsx" --include "Combos.xls" --max-depth 1 --fast-list 2>> /var/log/sync-pickit.log

# Pickit — SUBIDA: los .xlsx generados van a "Pickits y Carros" (aditivo, NO borra nada más).
# move = sube y quita del VPS; --min-age 1m evita agarrar un archivo a medio escribir.
rclone move /data/showroom/pickit-out "gdrive:Pickits y Carros" --drive-root-folder-id 1zp0_l2VzwmomRx054MQpMjTAUGxLwZl2 --min-age 1m 2>> /var/log/sync-pickit.log
```

- **Bajada:** `--max-depth 1` + los `--include` traen solo esos 3 archivos de la raíz (excluyen `Etiquetas/`, `Pedidos/`, `Pickits y Carros/`, `logs/` y otros Excels).
- **Subida:** `move` (no `sync`) es puramente aditivo — solo sube lo que hay en `pickit-out`, nunca borra ni altera el resto de la carpeta de Drive. `"gdrive:Pickits y Carros"` con `--drive-root-folder-id` apunta a la subcarpeta relativa a la carpeta pickit.

### 2. `docker-compose.yml` (servicio `showroom-backend`, sección `volumes`)

```yaml
- "/data/supermaster/pickit:/app/pickit:ro"
- "/data/showroom/pickit-out:/app/pickit-out"
```

Versionado en el repo → Coolify lo despliega desde `main`.

### 3. Configuración en `/configuracion` (persistida en BD, tabla `configuracion`)

- Habilitado: ✅
- Path del .jar: `/app/pickit/Pickit y Etiquetas.jar`
- Stock.xlsx: `/app/pickit/Stock.xlsx`
- Combos.xlsx: `/app/pickit/Combos.xls`
- Carpeta de salida: `/app/pickit-out`

### 4. Código backend/frontend

**Sin cambios.** `PickitExternoService` invoca el jar por `ProcessBuilder` con esos paths y publica el SSE `pickit-externo` (toast + auto-descarga que el frontend ya maneja).

## Operación

### Actualizar el jar

Subir el nuevo `Pickit y Etiquetas.jar` a la carpeta de Drive. El cron lo baja en ≤5 min (rclone re-transfiere solo si cambió). No requiere redeploy.

### Forzar un sync manual

```bash
bash /root/sync-imagenes.sh
ls -la /data/supermaster/pickit
```

### Verificar que el container ve los archivos y puede escribir

El nombre del container cambia en cada deploy de Coolify — listarlo primero:

```bash
CID=$(docker ps --format '{{.Names}}' | grep -i showroom-backend)
docker exec "$CID" ls -la /app/pickit
docker exec "$CID" sh -c 'touch /app/pickit-out/.probe && rm /app/pickit-out/.probe && echo escribible'
```

### Debug

- Sync/subida del pickit: `tail -f /var/log/sync-pickit.log`
- Backend (incluye stdout/stderr del jar en errores): `/data/showroom/logs/showroom-backend.log`
- Resultado antes de subirse: `ls -la /data/showroom/pickit-out` (archivos `SHOWROOM-PICKIT_*.xlsx`; desaparecen cuando el cron los mueve a Drive)

## Troubleshooting

| Síntoma | Causa probable / acción |
|---|---|
| Toast `pickit-externo` FAILED con "no accesible" | Los Excels/jar no están en `/data/supermaster/pickit`. Correr el sync manual; revisar `/var/log/sync-pickit.log`. |
| FAILED al escribir la salida / el jar no genera | Permisos: `/data/showroom/pickit-out` debe ser `chown 999:999` (uid del user `app`). Verificar con la prueba de escritura de arriba. |
| El pickit no aparece en "Pickits y Carros" de Drive | El cron no corrió, o el archivo tiene <1 min (`--min-age`). Ver `/var/log/sync-pickit.log`; esperar el próximo ciclo o forzar el sync manual. |
| La auto-descarga en el navegador falla | El cron movió el archivo antes de que el operador lo bajara (tardó >1 min). El archivo está en "Pickits y Carros" de Drive; o regenerar el pickit. |
| El pickit usa datos viejos | El cron no corrió o falló. Ver `crontab -l` y `/var/log/sync-pickit.log`; forzar sync manual. |
| Cambió el nombre del container | Normal en Coolify; usar el `grep` de arriba en vez de un nombre fijo. |

## Futuro (Paso 2, no implementado)

Portar el pickit a una interfaz web de super-master (ambos en el VPS, Java) para eliminar el jar de escritorio. El programa completo (~10k LOC) incluye también etiquetas ZPL (impresoras físicas del depósito → problema de hardware local aparte) y pedidos ML/TiendaNube. Empezar solo por pickit. Ver `docs/superpowers/specs/2026-07-13-pickit-vps-rclone-design.md`.
