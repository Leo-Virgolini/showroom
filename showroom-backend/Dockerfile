# syntax=docker/dockerfile:1.7

# ============================================================
# Build stage: compila el jar con Maven + Java 25
# ============================================================
FROM maven:3-eclipse-temurin-25 AS build
WORKDIR /build

# Cachear dependencias antes de copiar el código
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline

COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q clean package -DskipTests

# ============================================================
# Runtime stage: solo JRE 25 + el jar
# ============================================================
FROM eclipse-temurin:25-jre
WORKDIR /app

# curl para que el healthcheck del docker-compose pueda chequear /api/showroom/health
# (la imagen JRE base no incluye wget ni curl).
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r app && useradd -r -g app app
COPY --from=build /build/target/*.jar app.jar
RUN chown -R app:app /app
USER app

EXPOSE 8081

# Flags de JVM optimizadas para Spring Boot + JDK 25:
#   - Xmx1536m: tope de heap ABSOLUTO. Antes se usaba MaxRAMPercentage=75, pero
#     sin un mem_limit de cgroup la JVM lee la RAM TOTAL del host (16 GB en esta
#     VPS) y apunta ~12 GB de heap — con 2 apps full-stack + 2 MySQL conviviendo,
#     eso disparaba el OOM-killer (los "504" y "OOM" vistos en prod). Un valor
#     absoluto garantiza el límite sin depender de que Coolify aplique mem_limit.
#     1536m sobra para el cache de ~6000 productos y el pico del sync; subir si
#     hiciera falta. Se combina con el mem_limit del docker-compose (defensa extra).
#   - UseZGC: garbage collector de baja latencia (<1ms pauses). En JDK 25
#     ya viene en modo generacional por default — ideal para apps web con
#     cargas variables (sync de catálogo = picos de heap).
#   - UseStringDeduplication: deduplica strings idénticos en el heap. El
#     cache de productos suele tener muchas descripciones/categorías
#     repetidas; ahorra ~5-10% de heap sin afectar performance.
#   - HeapDumpOnOutOfMemoryError + HeapDumpPath=/app/logs: ante un
#     java.lang.OutOfMemoryError (heap agotado por la app) vuelca un .hprof a la
#     carpeta de logs (montada al host /data/showroom/logs) para analizar la fuga.
#     OJO: esto NO cubre el OOM-killer del kernel (SIGKILL por exceder mem_limit),
#     que no deja rastro en la app — ese se detecta con
#     `docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}'` (→ true 137).
#   - ExitOnOutOfMemoryError: ante un OOME interno, termina la JVM de una en vez
#     de quedar medio-viva con threads muertos; con restart: unless-stopped el
#     contenedor reinicia limpio (y el dump ya quedó escrito).
# Override desde docker-compose con `environment: JAVA_OPTS: "..."` si hace falta.
#
# Flag opcional NO incluida por default (probar si querés ahorrar heap):
#   -XX:+UnlockExperimentalVMOptions -XX:+UseCompactObjectHeaders
#   (JEP 450/519 — reduce el header de cada objeto Java de 12 a 4 bytes;
#    todavía marcada experimental en JDK 25 pero estable en producción).
ENV JAVA_OPTS="-Xmx1536m -Xms384m -XX:+UseZGC -XX:+UseStringDeduplication -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/app/logs -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["sh","-c","exec java $JAVA_OPTS -jar /app/app.jar"]
