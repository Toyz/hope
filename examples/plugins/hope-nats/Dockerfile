# hope-nats plugin.
#
# Build from the REPO ROOT so both this example module and the in-repo SDK are in
# context (the go.mod replace points at ../../../plugin):
#
#   docker build -f examples/plugins/hope-nats/Dockerfile -t hope-nats .
#
# Run it pointed at a server; the hope.plugin.* labels make it discoverable:
#
#   docker run -e NATS_URL=nats://user:pass@host:4222 \
#     -e HOPE_PLUGIN_TOKEN=secret hope-nats
FROM golang:alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
COPY plugin/ ./plugin/
COPY examples/plugins/hope-nats/ ./examples/plugins/hope-nats/
WORKDIR /src/examples/plugins/hope-nats
RUN go mod download
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /plugin .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /plugin /plugin
LABEL hope.plugin="true" \
      hope.plugin.port="8080" \
      hope.plugin.path="/__hope" \
      hope.plugin.title="NATS" \
      hope.plugin.icon="server"
EXPOSE 8080
ENTRYPOINT ["/plugin"]
