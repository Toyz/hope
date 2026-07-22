package catalog

// Builtins are the first-party plugins hope can always install — the images the CI
// matrix publishes (.github/workflows/docker-publish.yml). The env/volume/setting
// schema here is the machine-readable form of what the plugins' READMEs document in
// prose. A remote manifest can override or extend these by ID.
func Builtins() []CatalogEntry {
	return []CatalogEntry{
		{
			ID:          "hope-postgres",
			Title:       "Postgres",
			Icon:        "database",
			Description: "Browse databases, tables, and indexes; run queries and EXPLAIN; watch activity; analyze/vacuum.",
			Image:       "ghcr.io/toyz/hope-postgres:latest",
			Port:        8080,
			Path:        "/__hope",
			Env: []EnvField{
				{
					Key:         "DATABASE_URL",
					Label:       "Connection URL",
					Kind:        "secret",
					Required:    true,
					Placeholder: "postgres://user:pass@host:5432/db",
					Hint:        "Standard postgres:// DSN reachable from the plugin's networks",
				},
			},
			Settings: []SettingSeed{{Key: "page_size", Value: "50"}},
			Permissions: []CatalogPermission{
				{Scope: "events:publish", Reason: "raise the Postgres health alerts you define"},
				{Scope: "storage", Reason: "save your alert rules"},
			},
		},
		{
			ID:          "hope-redis",
			Title:       "Redis",
			Icon:        "database",
			Description: "Browse the keyspace, run commands, watch slowlog, kill clients, and operate a Redis/Valkey server.",
			Image:       "ghcr.io/toyz/hope-redis:latest",
			Port:        8080,
			Path:        "/__hope",
			Env: []EnvField{
				{
					Key:         "REDIS_URL",
					Label:       "Connection URL",
					Kind:        "secret",
					Required:    true,
					Placeholder: "redis://:pass@host:6379/0",
					Hint:        "redis:// or rediss:// DSN reachable from the plugin's networks",
				},
			},
			Settings: []SettingSeed{{Key: "scan_limit", Value: "1000"}},
		},
		{
			ID:          "hope-nats",
			Title:       "NATS",
			Icon:        "server",
			Description: "Inspect streams, consumers, and KV; watch subjects live; publish; purge/delete streams.",
			Image:       "ghcr.io/toyz/hope-nats:latest",
			Port:        8080,
			Path:        "/__hope",
			Env: []EnvField{
				{
					Key:         "NATS_URL",
					Label:       "Connection URL",
					Kind:        "secret",
					Required:    true,
					Placeholder: "nats://user:pass@host:4222",
					Hint:        "nats:// DSN reachable from the plugin's networks; JetStream must be enabled for stream/KV views",
				},
			},
			Settings: []SettingSeed{{Key: "watch_subject", Value: ">"}, {Key: "page_size", Value: "100"}},
		},
		{
			ID:          "kitchen-sink",
			Title:       "Kitchen Sink",
			Icon:        "box",
			Description: "Reference plugin exercising every hope surface — views, tables, streams, dynamic forms, alerts, and the reverse channel. Self-contained (no external service); install it to explore hope or smoke-test a build.",
			Image:       "ghcr.io/toyz/kitchen-sink:latest",
			Port:        8080,
			Path:        "/__hope",
			// No Env: it serves its own demo data, so it installs and runs with nothing
			// to configure — the point is a one-click plugin to poke at.
			Permissions: []CatalogPermission{
				{Scope: "events:subscribe", Reason: "log and count the fleet events it sees"},
				{Scope: "events:publish", Reason: "raise the demo alerts"},
				{Scope: "storage", Reason: "remember how many events it has seen"},
				{Scope: "spec:label", Reason: "tag its own stack's services on request"},
			},
		},
	}
}
