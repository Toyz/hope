# hope-redis plugin.
#
# Build from the REPO ROOT so both this example module and the in-repo SDK are in
# context (the go.mod replace points at ../../../plugin):
#
#   docker build -f examples/plugins/hope-redis/Dockerfile -t hope-redis .
#
# Run it pointed at a server; the hope.plugin.* labels make it discoverable:
#
#   docker run -e REDIS_URL=redis://:pass@host:6379/0 \
#     -e HOPE_PLUGIN_TOKEN=secret hope-redis
FROM golang:alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
COPY plugin/ ./plugin/
COPY examples/plugins/hope-redis/ ./examples/plugins/hope-redis/
WORKDIR /src/examples/plugins/hope-redis
RUN go mod download
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /plugin .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /plugin /plugin
LABEL hope.plugin="true" \
      hope.plugin.port="8080" \
      hope.plugin.path="/__hope" \
      hope.plugin.title="Redis" \
      hope.plugin.icon="database"
EXPOSE 8080
ENTRYPOINT ["/plugin"]
