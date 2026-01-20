# YARRRML to RML service


This service can be run through docker compose as follows:

```
services:
  combined-map:
    image: ghcr.io/dexagod/yarrrml-to-rml-service-docker:latest
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - DEFAULT_SERIALIZATION=nquads
```


## Interacting with the service: 

Interactions with the service requires sending a **POST** request to the service interface,
the default location of which is at [https://localhost:3000/map?serialization=nquads](https://localhost:3000/map?serialization=nquads),
with a content type header indicating a JSON body (*Content-Type: application/json*), and containing the following request body:

```
{
  yarrml: "yarrrml mapping",
  resources: [ { resourceUrl: "resource url", fileName: "data.json" }, ... ]
}
```
