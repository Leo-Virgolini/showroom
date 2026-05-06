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
#   - MaxRAMPercentage=75: usa hasta el 75% de la RAM del container.
#   - UseZGC: garbage collector de baja latencia (<1ms pauses). En JDK 25
#     ya viene en modo generacional por default — ideal para apps web con
#     cargas variables (sync de catálogo = picos de heap).
#   - UseStringDeduplication: deduplica strings idénticos en el heap. El
#     cache de productos suele tener muchas descripciones/categorías
#     repetidas; ahorra ~5-10% de heap sin afectar performance.
# Override desde docker-compose con `environment: JAVA_OPTS: "..."` si hace falta.
#
# Flag opcional NO incluida por default (probar si querés ahorrar heap):
#   -XX:+UnlockExperimentalVMOptions -XX:+UseCompactObjectHeaders
#   (JEP 450/519 — reduce el header de cada objeto Java de 12 a 4 bytes;
#    todavía marcada experimental en JDK 25 pero estable en producción).
ENV JAVA_OPTS="-XX:MaxRAMPercentage=75.0 -XX:+UseZGC -XX:+UseStringDeduplication"
ENTRYPOINT ["sh","-c","exec java $JAVA_OPTS -jar /app/app.jar"]
