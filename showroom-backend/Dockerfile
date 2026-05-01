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

ENV JAVA_OPTS="-XX:MaxRAMPercentage=75.0"
ENTRYPOINT ["sh","-c","exec java $JAVA_OPTS -jar /app/app.jar"]
