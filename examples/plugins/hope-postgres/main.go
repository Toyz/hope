// hope-postgres is a first-party reference plugin: point it at a Postgres database
// (DATABASE_URL) and it exposes a PGAdmin-class panel inside hope — counters, a
// table browser, a SQL query grid, a schema tree, and a live-connections stream.
//
// The plugin holds the database credentials (your secret, in your container);
// hope only speaks the plugin protocol and never touches the database directly.
//
//	docker run -e DATABASE_URL=postgres://user:pass@db:5432/app \
//	  -e HOPE_PLUGIN_TOKEN=secret \
//	  -l hope.plugin=true -l hope.plugin.port=8080 <image>
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("hope-postgres", "1.0.0").
		Description("Browse and query a Postgres database").
		Icon("database")

	// Operator-managed setting: the max rows the tables view returns. Configured +
	// saved from the plugin inspector; read here with p.SettingValue.
	p.Setting(plugin.Setting{Key: "page_size", Label: "Page size", Kind: plugin.SettingNumber, Default: "500", Hint: "max rows per table listing"})

	// kv: server + database overview.
	p.View("overview", "Overview", plugin.KV, func(ctx context.Context) (any, error) {
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		out := map[string]any{}
		var version, db string
		var sizeBytes int64
		var conns, tables int
		_ = pool.QueryRow(ctx, `select version()`).Scan(&version)
		_ = pool.QueryRow(ctx, `select current_database()`).Scan(&db)
		_ = pool.QueryRow(ctx, `select pg_database_size(current_database())`).Scan(&sizeBytes)
		_ = pool.QueryRow(ctx, `select count(*) from pg_stat_activity`).Scan(&conns)
		_ = pool.QueryRow(ctx, `select count(*) from pg_stat_user_tables`).Scan(&tables)
		out["version"] = version
		out["database"] = db
		out["size"] = humanBytes(sizeBytes)
		out["connections"] = conns
		out["tables"] = tables
		return out, nil
	})

	// table: user tables with live row estimates. Row cap comes from the operator
	// setting (a validated int, so it's safe to inline into the query).
	p.View("tables", "Tables", plugin.Table, func(ctx context.Context) (any, error) {
		limit := 500
		if n, err := strconv.Atoi(p.SettingValue("page_size")); err == nil && n > 0 && n <= 100000 {
			limit = n
		}
		return grid(ctx, `
			select schemaname as schema, relname as table, n_live_tup as rows,
			       pg_size_pretty(pg_total_relation_size(relid)) as size
			from pg_stat_user_tables
			order by n_live_tup desc
			limit `+strconv.Itoa(limit))
	})

	// query: run the operator's SQL and return the grid. The plugin owns the DB
	// connection; hope is the control plane and audits the call.
	p.View("query", "SQL Query", plugin.Query, func(ctx context.Context) (any, error) {
		sql := plugin.Input(ctx)
		if sql == "" {
			return map[string]any{"columns": []string{}, "rows": [][]any{}}, nil
		}
		res, err := grid(ctx, sql)
		if err != nil {
			return nil, plugin.NewError(-32602, err.Error())
		}
		return res, nil
	})

	// tree: schema -> table -> column hierarchy.
	p.View("schema", "Schema", plugin.Tree, func(ctx context.Context) (any, error) {
		return schemaTree(ctx)
	})

	// danger action: ANALYZE refreshes planner stats (mutates catalog stats).
	p.DangerAction("analyze", "Analyze Database", nil, func(ctx context.Context, in map[string]any) (any, error) {
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		if _, err := pool.Exec(ctx, `analyze`); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})

	// counter stream: active (non-idle) connection count, every 2s.
	p.Stream("activity", "Active Connections", plugin.Counter, func(ctx context.Context, emit plugin.EmitFunc) error {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		poll := func() {
			pool, err := getPool(ctx)
			if err != nil {
				return
			}
			var active int
			_ = pool.QueryRow(ctx, `select count(*) from pg_stat_activity where state = 'active'`).Scan(&active)
			emit(map[string]any{"active": active})
		}
		poll()
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				poll()
			}
		}
	})

	// Container panel on any postgres image: tabs across the views + stream, with
	// the analyze action in its own section.
	p.ContainerPanel("Postgres", &plugin.Match{Images: []string{"postgres*", "pgvector*", "timescale*"}},
		plugin.Section("",
			plugin.Tabs(
				plugin.Leaf("overview").Titled("Overview"),
				plugin.Leaf("tables").Titled("Tables"),
				plugin.Leaf("query").Titled("Query"),
				plugin.Leaf("schema").Titled("Schema"),
				plugin.Leaf("activity").Titled("Activity"),
			),
			plugin.Section("Maintenance", plugin.Leaf("analyze")),
		))

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("hope-postgres plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
}

// --- Postgres access ----------------------------------------------------------

var (
	poolOnce sync.Once
	poolRef  *pgxpool.Pool
	poolErr  error
)

// getPool lazily opens a connection pool from DATABASE_URL, so the plugin starts
// (and serves hope.schema) even before a database is reachable.
func getPool(ctx context.Context) (*pgxpool.Pool, error) {
	poolOnce.Do(func() {
		dsn := os.Getenv("DATABASE_URL")
		if dsn == "" {
			poolErr = errors.New("DATABASE_URL is not set")
			return
		}
		poolRef, poolErr = pgxpool.New(ctx, dsn)
	})
	return poolRef, poolErr
}

// grid runs a query and returns a {columns, rows} table result.
func grid(ctx context.Context, sql string, args ...any) (any, error) {
	pool, err := getPool(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	fds := rows.FieldDescriptions()
	cols := make([]string, len(fds))
	for i, fd := range fds {
		cols[i] = fd.Name
	}
	out := [][]any{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		out = append(out, jsonSafeRow(vals))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"columns": cols, "rows": out}, nil
}

// schemaTree builds a schema -> table -> column tree from information_schema.
func schemaTree(ctx context.Context) (any, error) {
	res, err := grid(ctx, `
		select table_schema, table_name, column_name, data_type
		from information_schema.columns
		where table_schema not in ('pg_catalog','information_schema')
		order by table_schema, table_name, ordinal_position`)
	if err != nil {
		return nil, err
	}
	rows := res.(map[string]any)["rows"].([][]any)

	// Group rows into schema -> table -> [columns], preserving encounter order.
	type tbl struct {
		name string
		cols []any
	}
	schemaOrder := []string{}
	schemas := map[string][]*tbl{}
	tblIndex := map[string]*tbl{}
	for _, r := range rows {
		schema, _ := r[0].(string)
		table, _ := r[1].(string)
		col, _ := r[2].(string)
		typ, _ := r[3].(string)
		if _, ok := schemas[schema]; !ok {
			schemaOrder = append(schemaOrder, schema)
		}
		key := schema + "." + table
		t := tblIndex[key]
		if t == nil {
			t = &tbl{name: table}
			tblIndex[key] = t
			schemas[schema] = append(schemas[schema], t)
		}
		t.cols = append(t.cols, map[string]any{"label": col + " : " + typ})
	}

	nodes := []any{}
	for _, s := range schemaOrder {
		tblNodes := []any{}
		for _, t := range schemas[s] {
			tblNodes = append(tblNodes, map[string]any{"label": t.name, "children": t.cols})
		}
		nodes = append(nodes, map[string]any{"label": s, "children": tblNodes})
	}
	return map[string]any{"nodes": nodes}, nil
}

// jsonSafeRow converts values pgx returns into JSON-friendly forms (mainly []byte
// -> string) so the grid renders cleanly.
func jsonSafeRow(vals []any) []any {
	out := make([]any, len(vals))
	for i, v := range vals {
		if b, ok := v.([]byte); ok {
			out[i] = string(b)
			continue
		}
		out[i] = v
	}
	return out
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	units := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	return strconv.FormatFloat(float64(n)/float64(div), 'f', 1, 64) + " " + units[exp]
}
