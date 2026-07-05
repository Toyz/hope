# hope-postgres plugin.
#
# Build from the REPO ROOT so both this example module and the in-repo SDK are in
# context (the go.mod replace points at ../../../plugin):
#
#   docker build -f examples/plugins/hope-postgres/Dockerfile -t hope-postgres .
#
# Run it pointed at a database; the hope.plugin.* labels make it discoverable:
#
#   docker run -e DATABASE_URL=postgres://user:pass@db:5432/app \
#     -e HOPE_PLUGIN_TOKEN=secret hope-postgres
FROM golang:alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
COPY plugin/ ./plugin/
COPY examples/plugins/hope-postgres/ ./examples/plugins/hope-postgres/
WORKDIR /src/examples/plugins/hope-postgres
RUN go mod download
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /plugin .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /plugin /plugin
LABEL hope.plugin="true" \
      hope.plugin.port="8080" \
      hope.plugin.path="/__hope" \
      hope.plugin.title="Postgres" \
      hope.plugin.icon="database"
EXPOSE 8080
ENTRYPOINT ["/plugin"]
