# Stage 1: get the jar from the official image
FROM rmlio/rmlmapper-java:latest AS rml

# Stage 2: Node service + Java runtime
FROM node:20-alpine

RUN apk add --no-cache openjdk17-jre-headless

WORKDIR /app

COPY --from=rml /rmlmapper.jar /opt/rmlmapper.jar

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV PORT=3000
ENV RMLMAPPER_JAR=/opt/rmlmapper.jar
ENV DEFAULT_SERIALIZATION=nquads

EXPOSE 3000
CMD ["node", "index.js"]
