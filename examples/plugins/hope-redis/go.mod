// hope-redis — a first-party reference hope plugin: a Redis/Valkey control panel.
// Its own module so it can carry a Redis client while the hope plugin SDK stays
// stdlib-only; the replace points at the in-repo SDK. Valkey/KeyDB are Redis-wire
// compatible, so the same go-redis client drives all three.
module github.com/toyz/hope/examples/plugins/hope-redis

go 1.25.0

require (
	github.com/redis/go-redis/v9 v9.7.0
	github.com/toyz/hope/plugin v0.0.6
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
)

replace github.com/toyz/hope/plugin => ../../../plugin
