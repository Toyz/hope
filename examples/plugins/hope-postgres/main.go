// hope-postgres is a first-party reference plugin: point it at a Postgres database
// (DATABASE_URL) and it exposes a pgAdmin-class panel inside hope — stat tiles, a
// database gallery, a drill-down table browser (paginated server-side data grid +
// columns + indexes + DDL + stats), a SQL editor with an EXPLAIN pane, a live
// activity monitor you can cancel/terminate backends from, and maintenance ops.
//
// The plugin holds the database credentials (your secret, in your container); hope
// only speaks the plugin protocol, proxies + audits calls, and never touches the
// database directly.
//
//	docker run -e DATABASE_URL=postgres://user:pass@db:5432/app \
//	  -e HOPE_PLUGIN_TOKEN=secret \
//	  -l hope.plugin=true -l hope.plugin.port=8080 <image>
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("hope-postgres", "2.0.0").
		Description("Browse, query, and operate a Postgres database").
		Icon("database")

	// Operator-managed default page size for the drill-down data grid. Configured +
	// saved from the plugin inspector; read here with p.SettingValue.
	p.Setting(plugin.Setting{Key: "page_size", Label: "Data grid page size", Kind: plugin.SettingNumber, Default: "100", Hint: "rows per page in the table data browser"})

	registerOverview(p)
	registerBrowser(p)
	registerQuery(p)
	registerActivity(p)
	registerMaintenance(p)
	registerLayout(p)

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("hope-postgres plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
}

// --- Overview: stat tiles, database gallery, size chart, live connections --------

func registerOverview(p *plugin.Plugin) {
	// Big-number tiles: size, tables, live/total connections, cache-hit ratio. Tone
	// flags a low cache-hit ratio (the classic "add RAM / tune shared_buffers" tell).
	p.StatView("overview", "Overview", func(ctx context.Context) (any, error) {
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		var db, version string
		var sizeBytes, total, active, tables int64
		var hit *float64
		_ = pool.QueryRow(ctx, `select current_database()`).Scan(&db)
		_ = pool.QueryRow(ctx, `select version()`).Scan(&version)
		_ = pool.QueryRow(ctx, `select pg_database_size(current_database())`).Scan(&sizeBytes)
		_ = pool.QueryRow(ctx, `select count(*), count(*) filter (where state = 'active') from pg_stat_activity`).Scan(&total, &active)
		_ = pool.QueryRow(ctx, `select count(*) from pg_stat_user_tables`).Scan(&tables)
		_ = pool.QueryRow(ctx, `select sum(blks_hit)::float / nullif(sum(blks_hit) + sum(blks_read), 0) from pg_stat_database`).Scan(&hit)

		hitTone, hitVal := plugin.ToneInfo, "—"
		if hit != nil {
			hitVal = strconv.FormatFloat(*hit*100, 'f', 2, 64) + "%"
			switch {
			case *hit >= 0.99:
				hitTone = plugin.ToneOK
			case *hit >= 0.90:
				hitTone = plugin.ToneWarn
			default:
				hitTone = plugin.ToneBad
			}
		}
		return plugin.StatData{Stats: []plugin.StatBlock{
			{Label: "Database", Value: db, Sub: serverVersion(version), Icon: "database", Tone: plugin.ToneInfo},
			{Label: "Size", Value: humanBytes(sizeBytes), Icon: "hdd"},
			{Label: "Tables", Value: tables},
			{Label: "Connections", Value: total, Sub: strconv.FormatInt(active, 10) + " active", Icon: "activity"},
			{Label: "Cache hit", Value: hitVal, Tone: hitTone, Sub: "blocks served from cache"},
		}}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(15))

	// A gallery of every database on the cluster, biggest first — the current one is
	// accented. A quick "where's the weight" glance across the whole server.
	p.CardsView("databases", "Databases", func(ctx context.Context) (any, error) {
		res, err := grid(ctx, `
			select d.datname,
			       pg_database_size(d.datname) as bytes,
			       (select count(*) from pg_stat_activity a where a.datname = d.datname) as conns,
			       d.datname = current_database() as current
			from pg_database d
			where not d.datistemplate
			order by pg_database_size(d.datname) desc`)
		if err != nil {
			return nil, err
		}
		items := []plugin.Card{}
		for _, r := range res.(map[string]any)["rows"].([][]any) {
			name, _ := r[0].(string)
			bytes := toInt(r[1])
			conns := toInt(r[2])
			current, _ := r[3].(bool)
			tone := ""
			sub := ""
			if current {
				tone, sub = plugin.ToneInfo, "connected"
			}
			items = append(items, plugin.Card{
				Title: name, Subtitle: sub, Icon: "database", Tone: tone,
				Fields: []plugin.CardField{
					{Label: "size", Value: plugin.Badge(humanBytes(int64(bytes)), tone)},
					{Label: "connections", Value: plugin.Number(conns, "")},
				},
			})
		}
		return plugin.CardsData{Items: items}, nil
	})

	// Top tables by total size (heap + indexes + toast) — the bar chart that shows
	// where disk goes.
	p.ChartView("sizes", "Largest tables", func(ctx context.Context) (any, error) {
		res, err := grid(ctx, `
			select schemaname || '.' || relname as name,
			       pg_total_relation_size(relid) as bytes
			from pg_stat_user_tables
			order by bytes desc
			limit 15`)
		if err != nil {
			return nil, err
		}
		labels := []string{}
		mib := []float64{}
		for _, r := range res.(map[string]any)["rows"].([][]any) {
			name, _ := r[0].(string)
			labels = append(labels, name)
			mib = append(mib, float64(toInt(r[1]))/(1024*1024))
		}
		return plugin.ChartData{Type: "bar", Labels: labels, Series: []plugin.ChartSeries{{Name: "MiB", Values: mib}}}, nil
	})

	// schema -> table -> column tree, for a compact structural overview.
	p.View("schema", "Schema", plugin.Tree, func(ctx context.Context) (any, error) {
		return schemaTree(ctx)
	})

	// Live active-connection count, every 2s — a ticking pulse of DB load.
	p.Stream("live", "Active Connections", plugin.Counter, func(ctx context.Context, emit plugin.EmitFunc) error {
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
}

// --- Table browser: list -> per-table drill-down (data/columns/indexes/ddl/stats) -

func registerBrowser(p *plugin.Plugin) {
	// The tables list. Each row's name is a DetailLink into the "table" detail page,
	// carrying "schema.table" as the param — the pgAdmin left-tree click, as a link.
	// A relative size bar makes the heavy tables pop.
	p.View("tables", "Tables", plugin.Table, func(ctx context.Context) (any, error) {
		res, err := grid(ctx, `
			select schemaname, relname, n_live_tup, n_dead_tup, seq_scan, idx_scan,
			       pg_total_relation_size(relid) as bytes
			from pg_stat_user_tables
			order by bytes desc`)
		if err != nil {
			return nil, err
		}
		src := res.(map[string]any)["rows"].([][]any)
		var maxBytes int64 = 1
		for _, r := range src {
			if b := int64(toInt(r[6])); b > maxBytes {
				maxBytes = b
			}
		}
		rows := [][]any{}
		for _, r := range src {
			schema, _ := r[0].(string)
			table, _ := r[1].(string)
			live, dead := toInt(r[2]), toInt(r[3])
			seq, idx := toInt(r[4]), toInt(r[5])
			bytes := int64(toInt(r[6]))
			// Bloat/scan health: mostly-sequential scans or lots of dead tuples warn.
			health, tone := "ok", plugin.ToneOK
			if seq > 0 && idx == 0 && live > 10000 {
				health, tone = "seq scans", plugin.ToneWarn
			}
			if live > 0 && dead*100/live > 20 {
				health, tone = "bloated", plugin.ToneBad
			}
			rows = append(rows, []any{
				plugin.Badge(schema, ""),
				plugin.DetailLink(table, "table", schema+"."+table),
				plugin.Number(live, ""),
				plugin.Badge(humanBytes(bytes), ""),
				plugin.Progress(float64(bytes) / float64(maxBytes)),
				plugin.Badge(health, tone),
			})
		}
		return map[string]any{
			"columns": []string{"schema", "table", "rows", "size", "", "health"},
			"rows":    rows,
		}, nil
	})

	// The keystone: a server-driven data grid for one table. hope sends the page /
	// sort / filter state (_q); we run just that slice with LIMIT/OFFSET and return
	// the page plus a total count so nothing ships the whole table. Row click opens
	// the full record.
	p.TableView("table_data", "Data", func(ctx context.Context) (any, error) {
		schema, table, err := tableParam(ctx)
		if err != nil {
			return nil, err
		}
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		q, _ := plugin.ReadTableQuery(ctx)
		size := q.PageSize
		if size <= 0 {
			size = settingInt(p, "page_size", 100)
		}

		cols, err := tableColumns(ctx, schema, table)
		if err != nil {
			return nil, err
		}
		qname := pgx.Identifier{schema, table}.Sanitize()

		// Free-text filter → OR of ILIKE across every column cast to text.
		where, args := "", []any{}
		if f := strings.TrimSpace(q.Filter); f != "" {
			parts := make([]string, len(cols))
			for i, c := range cols {
				parts[i] = pgx.Identifier{c}.Sanitize() + "::text ilike $1"
			}
			where = " where " + strings.Join(parts, " or ")
			args = append(args, "%"+f+"%")
		}

		var total int64
		if err := pool.QueryRow(ctx, `select count(*) from `+qname+where, args...).Scan(&total); err != nil {
			return nil, plugin.NewError(-32602, err.Error())
		}

		order := " order by 1"
		if q.Sort.Column != "" && slices.Contains(cols, q.Sort.Column) {
			dir := "asc"
			if q.Sort.Dir < 0 {
				dir = "desc"
			}
			order = " order by " + pgx.Identifier{q.Sort.Column}.Sanitize() + " " + dir
		}
		sql := "select * from " + qname + where + order +
			" limit " + strconv.Itoa(size) + " offset " + strconv.Itoa(q.Page*size)
		res, err := grid(ctx, sql, args...)
		if err != nil {
			return nil, plugin.NewError(-32602, err.Error())
		}
		m := res.(map[string]any)
		m["total"] = int(total)
		return m, nil
	}, plugin.ServerSide(), plugin.PageSize(100), plugin.RowDetail("row_detail"))

	// Columns of the current table: type, nullability, default, and a PK badge.
	p.View("table_columns", "Columns", plugin.Table, func(ctx context.Context) (any, error) {
		schema, table, err := tableParam(ctx)
		if err != nil {
			return nil, err
		}
		pks, err := primaryKey(ctx, schema, table)
		if err != nil {
			return nil, err
		}
		res, err := grid(ctx, `
			select column_name, data_type, is_nullable, coalesce(column_default, '')
			from information_schema.columns
			where table_schema = $1 and table_name = $2
			order by ordinal_position`, schema, table)
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for _, r := range res.(map[string]any)["rows"].([][]any) {
			name, _ := r[0].(string)
			typ, _ := r[1].(string)
			nullable, _ := r[2].(string)
			def, _ := r[3].(string)
			nullCell := plugin.Badge("not null", plugin.ToneWarn)
			if nullable == "YES" {
				nullCell = plugin.Badge("null", "")
			}
			key := ""
			if pks[name] {
				key = "PK"
			}
			rows = append(rows, []any{plugin.Badge(key, plugin.ToneInfo), name, plugin.Code(typ), nullCell, plugin.Code(def)})
		}
		return map[string]any{"columns": []string{"key", "column", "type", "null", "default"}, "rows": rows}, nil
	})

	// Indexes of the current table, with the full definition and a unique badge.
	p.View("table_indexes", "Indexes", plugin.Table, func(ctx context.Context) (any, error) {
		schema, table, err := tableParam(ctx)
		if err != nil {
			return nil, err
		}
		res, err := grid(ctx, `
			select indexname, indexdef, pg_size_pretty(pg_relation_size(($1||'.'||indexname)::regclass))
			from pg_indexes where schemaname = $1 and tablename = $2 order by indexname`, schema, table)
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for _, r := range res.(map[string]any)["rows"].([][]any) {
			name, _ := r[0].(string)
			def, _ := r[1].(string)
			sz, _ := r[2].(string)
			uniq := plugin.Badge("", "")
			if strings.Contains(strings.ToUpper(def), "UNIQUE") {
				uniq = plugin.Badge("unique", plugin.ToneInfo)
			}
			rows = append(rows, []any{name, uniq, sz, plugin.Code(def)})
		}
		return map[string]any{"columns": []string{"index", "", "size", "definition"}, "rows": rows}, nil
	})

	// Live stats for the current table: sizes, scan mix, bloat, last (auto)maintenance.
	p.View("table_stats", "Stats", plugin.KV, func(ctx context.Context) (any, error) {
		schema, table, err := tableParam(ctx)
		if err != nil {
			return nil, err
		}
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		var live, dead, seq, idx int64
		var totalSize, tableSize string
		var lastVacuum, lastAnalyze *time.Time
		_ = pool.QueryRow(ctx, `
			select n_live_tup, n_dead_tup, seq_scan, coalesce(idx_scan, 0),
			       pg_size_pretty(pg_total_relation_size(relid)),
			       pg_size_pretty(pg_relation_size(relid)),
			       greatest(last_vacuum, last_autovacuum), greatest(last_analyze, last_autoanalyze)
			from pg_stat_user_tables where schemaname = $1 and relname = $2`, schema, table).
			Scan(&live, &dead, &seq, &idx, &totalSize, &tableSize, &lastVacuum, &lastAnalyze)
		return map[string]any{
			"live rows":    plugin.Number(live, ""),
			"dead rows":    plugin.Number(dead, ""),
			"total size":   totalSize,
			"heap size":    tableSize,
			"seq scans":    plugin.Number(seq, ""),
			"index scans":  plugin.Number(idx, ""),
			"last vacuum":  tsCell(lastVacuum),
			"last analyze": tsCell(lastAnalyze),
		}, nil
	})

	// Reconstructed CREATE TABLE + its index definitions — copy-paste DDL.
	p.TextView("table_ddl", "DDL", func(ctx context.Context) (any, error) {
		schema, table, err := tableParam(ctx)
		if err != nil {
			return nil, err
		}
		ddl, err := tableDDL(ctx, schema, table)
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": ddl}, nil
	})

	// The full-record modal opened by clicking a data-grid or query-result row. hope
	// hands us the clicked row's cells under {row}; we just present them.
	p.View("row_detail", "Record", plugin.KV, func(ctx context.Context) (any, error) {
		var pr struct {
			Row map[string]any `json:"row"`
		}
		_ = plugin.Params(ctx, &pr)
		if pr.Row == nil {
			return map[string]any{}, nil
		}
		return pr.Row, nil
	})
}

// --- Query editor + EXPLAIN -----------------------------------------------------

func registerQuery(p *plugin.Plugin) {
	// SQL editor → results grid. The {schema}.{table} default is filled from the page
	// param, so opening it from a table starts on that table's SELECT. Result rows are
	// clickable (row_detail). The plugin owns the connection; hope audits the call.
	p.QueryView("query", "Query", "sql", "select * from {schema}.{table} limit 100", func(ctx context.Context) (any, error) {
		sql := strings.TrimSpace(plugin.Input(ctx))
		if sql == "" {
			return map[string]any{"columns": []string{}, "rows": [][]any{}}, nil
		}
		res, err := grid(ctx, sql)
		if err != nil {
			return nil, plugin.NewError(-32602, err.Error())
		}
		m := res.(map[string]any)
		m["row_method"] = "row_detail"
		return m, nil
	})

	// EXPLAIN pane: type a query, see its plan. Plain EXPLAIN (no ANALYZE) never runs
	// the statement, so it's safe to poke at anything.
	p.QueryView("explain", "Explain", "sql", "select * from {schema}.{table}", func(ctx context.Context) (any, error) {
		sql := strings.TrimSpace(plugin.Input(ctx))
		if sql == "" {
			return map[string]any{"columns": []string{"QUERY PLAN"}, "rows": [][]any{}}, nil
		}
		res, err := grid(ctx, "explain (format text) "+sql)
		if err != nil {
			return nil, plugin.NewError(-32602, err.Error())
		}
		return res, nil
	})
}

// --- Activity monitor + backend control -----------------------------------------

func registerActivity(p *plugin.Plugin) {
	// Live session monitor (auto-refreshes). Each row can be cancelled (stop the
	// running query) or terminated (drop the whole backend) — the pg_stat_activity
	// "kill" pgAdmin operators reach for.
	p.TableView("activity", "Activity", func(ctx context.Context) (any, error) {
		res, err := grid(ctx, `
			select pid, coalesce(usename, ''), coalesce(datname, ''), coalesce(state, ''),
			       coalesce(wait_event_type, ''),
			       coalesce(extract(epoch from (now() - query_start))::int, 0) as dur,
			       coalesce(query, '')
			from pg_stat_activity
			where pid <> pg_backend_pid() and state is not null
			order by query_start nulls last`)
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for _, r := range res.(map[string]any)["rows"].([][]any) {
			pid := toInt(r[0])
			state, _ := r[3].(string)
			query, _ := r[6].(string)
			rows = append(rows, []any{
				pid, r[1], r[2], plugin.Badge(state, stateTone(state)), r[4],
				plugin.Number(toInt(r[5]), "s"), plugin.Code(truncate(query, 200)),
			})
		}
		return map[string]any{
			"columns": []string{"pid", "user", "db", "state", "wait", "age", "query"},
			"rows":    rows,
		}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(3),
		plugin.RowActions(
			plugin.RowAction{Method: "cancel", Label: "Cancel query", Icon: "stop"},
			plugin.RowAction{Method: "terminate", Label: "Terminate", Icon: "trash", Danger: true},
		))

	p.Action("cancel", "Cancel query", nil, backendOp("pg_cancel_backend", "cancelled"))
	p.DangerAction("terminate", "Terminate backend", nil, backendOp("pg_terminate_backend", "terminated"))
}

// backendOp runs pg_cancel_backend / pg_terminate_backend on the row's pid.
func backendOp(fn, verb string) plugin.ActionFunc {
	return func(ctx context.Context, in map[string]any) (any, error) {
		row, _ := in["row"].(map[string]any)
		pid := toInt(row["pid"])
		if pid == 0 {
			return map[string]any{"ok": false, "message": "no pid on this row"}, nil
		}
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		var ok bool
		if err := pool.QueryRow(ctx, `select `+fn+`($1)`, pid).Scan(&ok); err != nil {
			return nil, err
		}
		if !ok {
			return map[string]any{"ok": false, "message": fmt.Sprintf("backend %d not %s (already gone?)", pid, verb)}, nil
		}
		return map[string]any{"ok": true, "message": fmt.Sprintf("backend %d %s", pid, verb)}, nil
	}
}

// --- Maintenance ----------------------------------------------------------------

func registerMaintenance(p *plugin.Plugin) {
	// ANALYZE only refreshes the planner's statistics — it doesn't touch data or
	// schema and takes no disruptive locks, so it's a plain (non-danger) action.
	p.Action("analyze", "Analyze database", nil, func(ctx context.Context, in map[string]any) (any, error) {
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		if _, err := pool.Exec(ctx, `analyze`); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "planner statistics refreshed"}, nil
	})
	p.DangerAction("vacuum", "Vacuum database", nil, func(ctx context.Context, in map[string]any) (any, error) {
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		// VACUUM can't run inside a transaction block — Exec sends it directly.
		if _, err := pool.Exec(ctx, `vacuum (analyze)`); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "vacuum + analyze complete"}, nil
	})
}

// --- Layout ---------------------------------------------------------------------

func registerLayout(p *plugin.Plugin) {
	// Container panel on any postgres-family image: the server-wide tabs, plus a
	// maintenance section. Per-table views are reached by drilling into a table.
	p.ContainerPanel("Postgres", &plugin.Match{Images: []string{"postgres*", "pgvector*", "timescale*"}},
		plugin.Section("",
			plugin.Tabs(
				plugin.Leaf("overview").Titled("Overview"),
				plugin.Leaf("databases").Titled("Databases"),
				plugin.Leaf("tables").Titled("Tables"),
				plugin.Leaf("sizes").Titled("Sizes"),
				plugin.Leaf("schema").Titled("Schema"),
				plugin.Leaf("query").Titled("Query"),
				plugin.Leaf("explain").Titled("Explain"),
				plugin.Leaf("activity").Titled("Activity"),
			),
			plugin.Section("Maintenance", plugin.Row(plugin.Leaf("analyze"), plugin.Leaf("vacuum"))),
		))

	// A standalone nav page — a first-class rail entry + a ⌘K command-palette entry,
	// openable without drilling into the postgres container. A fuller layout than the
	// container tabs (stat band, a size/database row, then the working tabs) with the
	// maintenance ops as a header toolbar. PageID makes it a stable link/breadcrumb
	// target (the table detail page points its crumb back here).
	p.Page("Postgres", plugin.Section("",
		plugin.Leaf("overview"),
		plugin.Row(
			plugin.Section("Largest tables", plugin.Leaf("sizes")),
			plugin.Section("Databases", plugin.Leaf("databases")),
		),
		plugin.Tabs(
			plugin.Leaf("tables").Titled("Tables").Filled(),
			plugin.Leaf("query").Titled("Query"),
			plugin.Leaf("explain").Titled("Explain"),
			plugin.Leaf("activity").Titled("Activity"),
			plugin.Leaf("schema").Titled("Schema"),
		),
	)).PageID("postgres").
		Subtitle("browse, query, and operate this database").
		HeaderActions("analyze", "vacuum")

	// Compact fleet-dashboard widget: just the stat tiles, so a DB's health shows on
	// the dashboard alongside hope's own cards (keep it small — no full panel).
	p.DashboardWidget("Postgres", plugin.Section("",
		plugin.Leaf("overview"),
	))

	// Stack-view widget: an empty match means "the plugin's OWN stack", so when this
	// plugin is deployed alongside the database it monitors, its overview shows on
	// that stack's page — the DB it targets, at stack scope.
	p.StackWidget("Postgres", nil, plugin.Section("",
		plugin.Leaf("overview"),
	))

	// LIVE schema tree in the rail: schema -> table, built from the database on every
	// layout fetch (DynamicPageFunc), so it tracks the real schema instead of a set
	// frozen at startup. Each table leaf passes {table:"schema.table"}; the shared
	// node renders that table's tabs — the pgAdmin left-tree, as navigable rail pages.
	p.DynamicPageFunc("Browse", tableTabs(), schemaPageItems)

	// Hidden master-detail page for a single table, reached via the DetailLink in the
	// tables list. Every leaf receives {table: "schema.table"} as the page param.
	p.DetailPage("table", "Table", "table", tableTabs()).
		Subtitle("{table}").
		Breadcrumbs(
			plugin.Crumb{Label: "Postgres", To: "postgres"}, // back to the standalone page
			plugin.Crumb{Label: "{table}"},
		)
}

// tableTabs is the per-table view tabs, shared by the "Browse" rail tree and the
// table detail page. Returns a fresh node each call (a *Node can't be shared across
// two contributions).
func tableTabs() *plugin.Node {
	return plugin.Section("",
		plugin.Tabs(
			plugin.Leaf("table_data").Titled("Data").Filled(),
			plugin.Leaf("table_columns").Titled("Columns"),
			plugin.Leaf("table_indexes").Titled("Indexes"),
			plugin.Leaf("table_stats").Titled("Stats"),
			plugin.Leaf("table_ddl").Titled("DDL"),
			plugin.Leaf("query").Titled("Query"),
		),
	)
}

// Schema-tree rail items are cached briefly: hope fetches the layout on several
// surface calls, and the table list rarely changes second-to-second.
var (
	treeMu    sync.Mutex
	treeAt    time.Time
	treeItems []plugin.PageItem
)

// schemaPageItems builds the schema -> table rail tree from the live database, with
// a short TTL cache. On error it serves the last good tree (nil before first fetch).
func schemaPageItems(ctx context.Context) []plugin.PageItem {
	treeMu.Lock()
	defer treeMu.Unlock()
	if treeItems != nil && time.Since(treeAt) < 15*time.Second {
		return treeItems
	}
	res, err := grid(ctx, `
		select table_schema, table_name
		from information_schema.tables
		where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE'
		order by table_schema, table_name`)
	if err != nil {
		return treeItems
	}
	order := []string{}
	bySchema := map[string][]plugin.PageItem{}
	for _, r := range res.(map[string]any)["rows"].([][]any) {
		schema, _ := r[0].(string)
		table, _ := r[1].(string)
		if _, ok := bySchema[schema]; !ok {
			order = append(order, schema)
		}
		bySchema[schema] = append(bySchema[schema], plugin.PageItem{
			Title: table,
			Param: map[string]any{"table": schema + "." + table},
		})
	}
	items := make([]plugin.PageItem, 0, len(order))
	for _, s := range order {
		items = append(items, plugin.PageItem{Title: s, Icon: "database", Children: bySchema[s]})
	}
	treeAt = time.Now()
	treeItems = items
	return items
}

// --- Postgres access ------------------------------------------------------------

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

// tableParam reads the {table} page param ("schema.table") and splits it.
func tableParam(ctx context.Context) (schema, table string, err error) {
	var pr struct {
		Table string `json:"table"`
	}
	_ = plugin.Params(ctx, &pr)
	schema, table, ok := strings.Cut(pr.Table, ".")
	if !ok || schema == "" || table == "" {
		return "", "", plugin.NewError(-32602, "no table selected")
	}
	return schema, table, nil
}

// tableColumns returns the ordered column names of a table.
func tableColumns(ctx context.Context, schema, table string) ([]string, error) {
	res, err := grid(ctx, `
		select column_name from information_schema.columns
		where table_schema = $1 and table_name = $2 order by ordinal_position`, schema, table)
	if err != nil {
		return nil, err
	}
	cols := []string{}
	for _, r := range res.(map[string]any)["rows"].([][]any) {
		if s, ok := r[0].(string); ok {
			cols = append(cols, s)
		}
	}
	if len(cols) == 0 {
		return nil, plugin.NewError(-32602, "table not found: "+schema+"."+table)
	}
	return cols, nil
}

// primaryKey returns the set of a table's primary-key column names.
func primaryKey(ctx context.Context, schema, table string) (map[string]bool, error) {
	res, err := grid(ctx, `
		select a.attname
		from pg_index i
		join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
		where i.indrelid = format('%I.%I', $1::text, $2::text)::regclass and i.indisprimary`, schema, table)
	if err != nil {
		return map[string]bool{}, nil // best-effort; a missing PK isn't fatal
	}
	pk := map[string]bool{}
	for _, r := range res.(map[string]any)["rows"].([][]any) {
		if s, ok := r[0].(string); ok {
			pk[s] = true
		}
	}
	return pk, nil
}

// tableDDL reconstructs a readable CREATE TABLE (+ index definitions) from the
// catalog — enough to copy the shape, not a pg_dump-exact reproduction.
func tableDDL(ctx context.Context, schema, table string) (string, error) {
	cres, err := grid(ctx, `
		select column_name, data_type, is_nullable, coalesce(column_default, '')
		from information_schema.columns
		where table_schema = $1 and table_name = $2 order by ordinal_position`, schema, table)
	if err != nil {
		return "", err
	}
	pks, _ := primaryKey(ctx, schema, table)

	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s.%s (\n", quoteIdent(schema), quoteIdent(table))
	colRows := cres.(map[string]any)["rows"].([][]any)
	pkOrder := []string{}
	for i, r := range colRows {
		name, _ := r[0].(string)
		typ, _ := r[1].(string)
		nullable, _ := r[2].(string)
		def, _ := r[3].(string)
		fmt.Fprintf(&b, "    %s %s", quoteIdent(name), typ)
		if nullable == "NO" {
			b.WriteString(" NOT NULL")
		}
		if def != "" {
			fmt.Fprintf(&b, " DEFAULT %s", def)
		}
		if pks[name] {
			pkOrder = append(pkOrder, quoteIdent(name))
		}
		if i < len(colRows)-1 || len(pkOrder) > 0 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	if len(pkOrder) > 0 {
		fmt.Fprintf(&b, "    PRIMARY KEY (%s)\n", strings.Join(pkOrder, ", "))
	}
	b.WriteString(");\n")

	ires, err := grid(ctx, `
		select indexdef from pg_indexes
		where schemaname = $1 and tablename = $2 and indexname not like '%_pkey'
		order by indexname`, schema, table)
	if err == nil {
		for _, r := range ires.(map[string]any)["rows"].([][]any) {
			if def, ok := r[0].(string); ok {
				fmt.Fprintf(&b, "\n%s;", def)
			}
		}
	}
	return b.String(), nil
}

// schemaTree builds a schema -> table -> column tree from information_schema.
func schemaTree(ctx context.Context) (any, error) {
	res, err := grid(ctx, `
		select table_schema, table_name, column_name, data_type
		from information_schema.columns
		where table_schema not in ('pg_catalog', 'information_schema')
		order by table_schema, table_name, ordinal_position`)
	if err != nil {
		return nil, err
	}
	rows := res.(map[string]any)["rows"].([][]any)

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

// --- small helpers --------------------------------------------------------------

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

// toInt coerces the numeric forms pgx/JSON produce (int64, float64, string) to int.
func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(n)
		return i
	}
	return 0
}

func settingInt(p *plugin.Plugin, key string, def int) int {
	if n, err := strconv.Atoi(p.SettingValue(key)); err == nil && n > 0 && n <= 100000 {
		return n
	}
	return def
}

// quoteIdent double-quotes an identifier for DDL text (doubles embedded quotes).
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func stateTone(state string) string {
	switch state {
	case "active":
		return plugin.ToneOK
	case "idle in transaction", "idle in transaction (aborted)":
		return plugin.ToneWarn
	case "disabled":
		return plugin.ToneBad
	default:
		return ""
	}
}

func tsCell(t *time.Time) any {
	if t == nil || t.IsZero() {
		return "—"
	}
	return plugin.Time(t.Unix())
}

func truncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ") // collapse whitespace/newlines
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func serverVersion(v string) string {
	// "PostgreSQL 16.2 on x86_64…" -> "PostgreSQL 16.2"
	fields := strings.Fields(v)
	if len(fields) >= 2 {
		return fields[0] + " " + fields[1]
	}
	return v
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
