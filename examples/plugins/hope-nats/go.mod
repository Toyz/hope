// hope-nats — a first-party reference hope plugin: a NATS control panel. Its own module so it
// can carry the NATS client while the hope plugin SDK stays stdlib-only; the replace points at
// the in-repo SDK.
module github.com/toyz/hope/examples/plugins/hope-nats

go 1.25.0

require (
	github.com/nats-io/nats.go v1.48.0
	github.com/toyz/hope/plugin v0.0.9
)

require (
	github.com/klauspost/compress v1.18.0 // indirect
	github.com/nats-io/nkeys v0.4.11 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	golang.org/x/crypto v0.37.0 // indirect
	golang.org/x/sys v0.32.0 // indirect
)

replace github.com/toyz/hope/plugin => ../../../plugin
