# Showroom KT GASTRO

Punto de venta para el showroom físico de **Kitchen Tools Gastronomía**, integrado con DUX (sistema ERP/contable). Permite escanear productos por código de barras o QR, armar pedidos y enviarlos a DUX, generar etiquetas QR para las muestras y mantener un cache local del catálogo sincronizado periódicamente.

---

## Funcionalidades

- 🔎 **Escaneo de muestras** por código de barras (EAN), SKU o QR — match exacto contra cache local con fallback a DUX on-demand.
- 🛒 **Armado de pedidos** con validación de stock disponible y categoría fiscal del cliente.
- 📤 **Envío del pedido a DUX** con creación del cliente si no existe.
- 📧 **Email de picking** automático con planilla XLSX (SKU + cantidad) para el depósito.
- 🏷️ **Generador de etiquetas QR** para las muestras del showroom — soporta hojas A4/Carta/Oficio o impresoras térmicas Zebra (modo `window.print()` o ZPL nativo para volúmenes grandes).
- 🔄 **Sincronización con DUX**: incremental (solo cambios de stock/precio, ~1 min) o completa (~12 min). Corre programada cada día a las 6 AM o on-demand desde la UI.
- 📦 **Cache local** del catálogo en MySQL para que el showroom no dependa de la latencia ni del rate limit de DUX.
- 🖼️ **Imágenes de productos** servidas desde una carpeta local indexada en memoria (lookup O(1)).

---

## Stack tecnológico

### Backend (`showroom-backend/`)

- **Java 25** + **Spring Boot 4.0.5**
- **MySQL 8.4** (con HikariCP, índices y batching de inserts)
- **Hibernate / JPA** con `ddl-auto=update` (migración de schema automática)
- **Lombok** + **MapStruct** para DTOs y boilerplate
- **Jackson** (en `tools.jackson.databind`) para JSON
- **Virtual Threads** habilitados (1 vthread por request — escala con I/O bound de DUX)
- **ZGC** + **String Deduplication** como GC y optimizaciones de heap

### Frontend (`showroom-frontend/`)

- **Angular 21** standalone components + signals
- **PrimeNG 21** (tema Aura)
- **Tailwind CSS v4** (con `@tailwindcss/postcss`)
- **PWA** habilitada (Service Worker, instalable)
- **PapaParse** para importar CSVs
- **qrcode** para generar QRs en el cliente

### Infraestructura

- **Docker Compose**: 3 servicios (mysql, backend, frontend)
- **Nginx** (en el container del frontend) sirve los estáticos y proxea `/api` al backend

---

## Quickstart

### Requisitos previos

- **Docker Desktop** (Windows/Mac/Linux)
- **Git**
- Una cuenta de **DUX** con token válido (archivo `dux_tokens.json` con formato `{ "token": "<jwt>" }`)
- Carpeta con **imágenes de productos** nombradas `{sku}.jpg|png|webp|...`

### Setup inicial

```bash
# 1. Clonar el repo
git clone https://github.com/Leo-Virgolini/showroom.git
cd showroom

# 2. Copiar y editar el .env con tus rutas/secretos
cp .env.example .env
# Editar .env: rutas de imágenes, tokens DUX, IDs de empresa, password MySQL, email del picking

# 3. Levantar el stack
docker compose up -d --build

# 4. Esperar ~1-2 min a que el backend esté healthy
docker compose ps
```

### URLs

| Servicio | URL |
|---|---|
| Frontend (operador del showroom) | http://localhost:4200 |
| Backend (API + healthcheck) | http://localhost:8081/api/showroom/health |
| MySQL (si exponés el puerto) | localhost:3307 |

---

## Variables de entorno (`.env`)

Copiar `.env.example` a `.env` y completar. Las más importantes:

| Variable | Para qué |
|---|---|
| `MYSQL_ROOT_PASSWORD` | Password del root de MySQL (queda en el volumen `mysql-data`) |
| `DUX_EMPRESA_ID` | ID de empresa en DUX (1068 para KT GASTRO) |
| `DUX_EMPRESA_ID_SUCURSAL` | ID de la sucursal del showroom en DUX |
| `DUX_SECRETS_PATH` | Carpeta del HOST con `dux_tokens.json` (reusable del super-master) |
| `SHOWROOM_IMAGENES_PATH` | Carpeta del HOST con `{sku}.{jpg,png,webp,...}` |
| `SHOWROOM_PICKING_EMAIL_*` | Config para que el picking reciba el XLSX al confirmar pedido |
| `SPRING_MAIL_*` | SMTP Gmail (usar app password de 16 dígitos, no la contraseña normal) |

Ver [`.env.example`](.env.example) para la lista completa con comentarios.

---

## Comandos útiles

### Desarrollo local sin Docker

**Backend:**
```bash
cd showroom-backend
./mvnw spring-boot:run
```

**Frontend:**
```bash
cd showroom-frontend
npm install
npm start            # localhost:4200, proxy a backend en :8081
```

### Producción (Docker)

```bash
# Levantar todo
docker compose up -d --build

# Logs en vivo
docker compose logs -f backend
docker compose logs -f frontend

# Reiniciar solo el backend
docker compose restart backend

# Ver estado y disco usado
docker compose ps
docker system df

# Bajar todo
docker compose down

# Bajar todo + borrar la base de datos (⚠️ pierde el cache)
docker compose down -v
```

### Redeploy automatizado (recomendado)

El script [`redeploy.ps1`](redeploy.ps1) (con wrapper [`redeploy.bat`](redeploy.bat) para doble click) hace:

1. `git pull --ff-only origin main`
2. `docker compose up -d --build --remove-orphans` (recrea solo los containers cuyo image cambió, MySQL queda corriendo)
3. `docker image prune -f` (limpia imágenes dangling del rebuild)
4. Espera healthy del backend (~30 s)
5. Muestra estado final + últimos logs

Doble click en `redeploy.bat` (Windows) o `pwsh redeploy.ps1` (PowerShell).

**Downtime estimado por deploy: ~10-15 segundos** (solo durante la recreación del container del backend).

---

## Estructura del repo

```
showroom/
├── showroom-backend/          # Spring Boot 4 + Java 25
│   ├── src/main/java/         # Código Java
│   ├── src/main/resources/    # application.properties, recursos
│   ├── pom.xml
│   └── Dockerfile             # Build multi-stage Maven + JRE 25
│
├── showroom-frontend/         # Angular 21 + PrimeNG + Tailwind v4
│   ├── src/app/               # Componentes standalone
│   ├── public/                # Assets estáticos (logos, manifest PWA)
│   ├── nginx.conf             # Config del nginx que sirve los estáticos
│   ├── Dockerfile             # Build multi-stage npm + nginx
│   └── package.json
│
├── docker-compose.yml         # Stack completo (mysql + backend + frontend)
├── .env.example               # Template de variables de entorno
├── redeploy.ps1               # Script PowerShell para redeploy
├── redeploy.bat               # Wrapper para doble click en Windows
└── README.md                  # (este archivo)
```

---

## Sincronización con DUX

DUX tiene **rate limit de ~7 segundos** entre requests, así que la app mantiene un cache local actualizado.

### Sync programada

Configurada en [`application.properties`](showroom-backend/src/main/resources/application.properties) (`showroom.cache.refresh-cron`). Por default corre **todos los días a las 6 AM** hora Argentina.

### Sync manual

Desde el botón **"Sincronizar"** en la toolbar del showroom:

- **Sin marcar "Sincronización completa"**: solo trae los productos que tuvieron cambios de **stock** o **precio** desde la última sync (~1 min).
- **Marcado**: descarga TODO el catálogo desde DUX (~12 min, ~5000 productos). Útil si hay sospechas de divergencia o productos eliminados en DUX.

Corre en background — el operador puede seguir usando el sistema. Un banner global muestra el progreso a todos los usuarios conectados (vía SSE).

---

## Etiquetas QR

Hay un módulo en `/etiquetas` para generar etiquetas QR de las muestras del showroom. Soporta:

- **Importación CSV** (orden + SKU): cada fila genera una etiqueta con su número de orden impreso.
- **Búsqueda manual** o pegado de SKUs.
- **Configuración del rollo**: ancho/alto de etiqueta, etiquetas por fila, márgenes, separación. Persiste en `localStorage`.
- **Tamaños del contenido** ajustables: tamaño del QR, fonts, padding. Independientes del tamaño de la etiqueta.
- **Dos modos de impresión**:
  - `window.print()` para tiradas chicas (≤30 etiquetas), preview visual antes.
  - **ZPL nativo** (botón "ZPL Zebra") para tiradas grandes — descarga un `.zpl` que se envía con [Zebra Setup Utilities](https://www.zebra.com/us/en/support-downloads/printer-software/printer-setup-utilities.html). Imprime miles de etiquetas sin saturar el spooler de Windows.
---

## Stack a un vistazo

```
┌─────────────────────────────────────────────────┐
│  Operador del showroom (browser, tablet)        │
│  http://<ip-pc>:4200                            │
└────────────────┬────────────────────────────────┘
                 │ HTTP
                 ↓
┌─────────────────────────────────────────────────┐
│  showroom-frontend (Angular 21 + nginx)         │
│  Puerto 4200. Sirve PWA + proxy /api → :8081   │
└────────────────┬────────────────────────────────┘
                 │ /api
                 ↓
┌─────────────────────────────────────────────────┐
│  showroom-backend (Spring Boot 4 + JDK 25)     │
│  Puerto 8081. Cache local + lógica de pedidos  │
└────────┬───────────────────┬────────────────────┘
         │                   │
         ↓                   ↓
   ┌──────────┐        ┌──────────────┐
   │  MySQL   │        │  DUX (ERP)   │
   │  cache   │        │  rate-limit  │
   └──────────┘        └──────────────┘
```

---

## Licencia

Uso interno de Kitchen Tools Gastronomía.