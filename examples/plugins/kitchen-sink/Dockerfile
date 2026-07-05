# kitchen-sink hope plugin. Build from the REPO ROOT (the go.mod replace points at
# ../../../plugin):
#
#   docker build -f examples/plugins/kitchen-sink/Dockerfile -t kitchen-sink .
FROM golang:alpine AS build
WORKDIR /src
COPY plugin/ ./plugin/
COPY examples/plugins/kitchen-sink/ ./examples/plugins/kitchen-sink/
WORKDIR /src/examples/plugins/kitchen-sink
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /plugin .

FROM scratch
COPY --from=build /plugin /plugin
LABEL hope.plugin="true" \
      hope.plugin.port="8080" \
      hope.plugin.path="/__hope" \
      hope.plugin.title="Kitchen Sink" \
      hope.plugin.icon="box"
EXPOSE 8080
ENTRYPOINT ["/plugin"]
