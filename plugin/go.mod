// The hope plugin SDK — a standalone, stdlib-only module authors import to expose
// a JSON-RPC endpoint hope discovers and renders. Nested under the hope repo but
// its OWN module so `go get github.com/toyz/hope/plugin` pulls a tiny dep graph
// (none of hope's docker/yamux/sov weight).
module github.com/toyz/hope/plugin

go 1.25
