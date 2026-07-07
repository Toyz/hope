// kitchen-sink — a reference hope plugin that exercises EVERY surface, view kind,
// stream kind, setting kind, layout primitive, and dynamic/nested pages, plus a
// large table for load testing. Its own module (stdlib-only) with a replace at the
// in-repo SDK, like the other examples.
module github.com/toyz/hope/examples/plugins/kitchen-sink

go 1.25

require github.com/toyz/hope/plugin v0.0.2

replace github.com/toyz/hope/plugin => ../../../plugin
