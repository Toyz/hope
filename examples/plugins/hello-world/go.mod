// hello-world — the tiny reference hope plugin: exercises every view kind plus a
// counter stream and an action, with zero external deps. Copy it as a starting
// point, or run it as the fixture hope's host tests dial against.
//
// A separate module from the SDK (and from hope) so it models the real
// external-container reality; the replace points at the in-repo SDK for local dev.
module github.com/toyz/hope/examples/plugins/hello-world

go 1.25

require github.com/toyz/hope/plugin v0.0.0

replace github.com/toyz/hope/plugin => ../../../plugin
