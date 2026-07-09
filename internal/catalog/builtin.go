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
	}
}
