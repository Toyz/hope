# hello-world hope plugin.
#
# Build from the REPO ROOT so both this example module and the in-repo SDK are in
# context (the go.mod replace points at ../../../plugin):
#
#   docker build -f examples/plugins/hello-world/Dockerfile -t hope-hello-world .
#
# The hope.plugin.* labels are baked in, so `docker run` alone is discoverable.
FROM golang:alpine AS build
WORKDIR /src
COPY plugin/ ./plugin/
COPY examples/plugins/hello-world/ ./examples/plugins/hello-world/
WORKDIR /src/examples/plugins/hello-world
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /plugin .

FROM scratch
COPY --from=build /plugin /plugin
LABEL hope.plugin="true" \
      hope.plugin.port="8080" \
      hope.plugin.path="/__hope" \
      hope.plugin.title="Hello World" \
      hope.plugin.icon="rocket"
EXPOSE 8080
ENTRYPOINT ["/plugin"]
