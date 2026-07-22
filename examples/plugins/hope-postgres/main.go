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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("hope-postgres", "2.2.0").
		Description("Browse, query, operate, and monitor a Postgres database").
		Icon("database").
		// Plugin-scoped icons: names hope doesn't ship as built-ins, registered here so
		// the plugin can use them anywhere (leaf/tab/stat/empty/rail). Inner SVG markup
		// only (Lucide-style, 24x24 stroke); hope sanitizes + namespaces them per plugin.
		Icons(map[string]string{
			"activity": `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
			"key":      `<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>`,
			"check":    `<path d="M20 6 9 17l-5-5"/>`,
			"layers":   `<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>`,
		})

	// Operator-managed default page size for the drill-down data grid. Configured +
	// saved from the plugin inspector; read here with p.SettingValue.
	p.Setting(plugin.Setting{Key: "page_size", Label: "Data grid page size", Kind: plugin.SettingNumber, Default: "100", Hint: "rows per page in the table data browser"})

	registerOverview(p)
	registerBrowser(p)
	registerQuery(p)
	registerActivity(p)
	registerMaintenance(p)
	registerAlerts(p)
	registerLayout(p)

	// Advisory self-status: hope owns liveness (can it dial us); we report Postgres's
	// own health — reachable, the database, and its connection load.
	p.OnStatus(func(ctx context.Context) plugin.StatusReport {
		pool, err := getPool(ctx)
		if err != nil {
			return plugin.StatusReport{Status: "unreachable", Level: plugin.StatusError, Detail: err.Error()}
		}
		var db string
		if err := pool.QueryRow(ctx, `select current_database()`).Scan(&db); err != nil {
			return plugin.StatusReport{Status: "query failed", Level: plugin.StatusError, Detail: err.Error()}
		}
		var active, total int64
		_ = pool.QueryRow(ctx, `select count(*), count(*) filter (where state = 'active') from pg_stat_activity`).Scan(&total, &active)
		return plugin.StatusReport{Status: db, Level: plugin.StatusOK, Detail: strconv.FormatInt(active, 10) + " active / " + strconv.FormatInt(total, 10) + " connections"}
	})

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
			{Label: "Size", Value: humanBytes(sizeBytes), Icon: "hard-drive"},
			{Label: "Tables", Value: tables},
			{Label: "Connections", Value: total, Sub: strconv.FormatInt(active, 10) + " active", Icon: "activity", Tip: plugin.Tip("Total backends vs the ones actively running a query right now")},
			{Label: "Cache hit", Value: hitVal, Tone: hitTone, Sub: "blocks served from cache", Tip: plugin.Tip("Share of block reads served from shared_buffers instead of disk — low means add RAM or tune shared_buffers")},
		}}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(15))

	// A COMPONENT view — the escape hatch. Composes a custom health tile hope has no
	// built-in kind for: a tone-flagged cache-hit heading over the live connection mix.
	// Caps(ctx) degrades to a plain KV on an older hope; Static() would fight the live
	// numbers, so it stays refreshable instead.
	p.ComponentView("health", "Health", func(ctx context.Context) (any, error) {
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		var total, active, idle int64
		var hit *float64
		_ = pool.QueryRow(ctx, `select count(*), count(*) filter (where state='active'), count(*) filter (where state='idle') from pg_stat_activity`).Scan(&total, &active, &idle)
		_ = pool.QueryRow(ctx, `select sum(blks_hit)::float / nullif(sum(blks_hit)+sum(blks_read), 0) from pg_stat_database`).Scan(&hit)
		hitPct, hitTone := "—", plugin.ToneInfo
		if hit != nil {
			hitPct = strconv.FormatFloat(*hit*100, 'f', 1, 64) + "%"
			switch {
			case *hit >= 0.99:
				hitTone = plugin.ToneOK
			case *hit >= 0.90:
				hitTone = plugin.ToneWarn
			default:
				hitTone = plugin.ToneBad
			}
		}
		if !plugin.Caps(ctx).Supports("component") {
			return plugin.KVData{"cache hit": hitPct, "connections": total, "active": active, "idle": idle}, nil
		}
		activeTone := plugin.ToneOK
		if active > 0 {
			activeTone = plugin.ToneWarn
		}
		return plugin.Box(
			plugin.Heading("Cache hit "+hitPct, 2).Toned(hitTone),
			plugin.CText("blocks served from shared_buffers vs disk"),
			plugin.Divider(),
			plugin.CRow(
				plugin.KeyVal("connections", plugin.Number(total, "")),
				plugin.KeyVal("active", plugin.Badge(strconv.FormatInt(active, 10), activeTone)),
				plugin.KeyVal("idle", plugin.Number(idle, "")),
			).Gapped(20),
		), nil
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
		for _, r := range res.Rows {
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
				To:    "database/" + name, // open the per-database page (maintenance lives there)
				Fields: []plugin.CardField{
					{Label: "size", Value: plugin.Badge(humanBytes(int64(bytes)), tone)},
					{Label: "connections", Value: plugin.Number(conns, "")},
				},
			})
		}
		return plugin.CardsData{Items: items}, nil
	})

	// Per-database detail: stats for the ONE database named in the {db} param. The stat
	// catalogs (pg_database_size, pg_stat_activity, pg_stat_database) are cluster-wide, so
	// this reads them from the pooled connection without connecting to the target DB — only
	// the maintenance actions (analyzeDb/vacuumDb) need a connection to it.
	p.ComponentView("databaseDetail", "Database", func(ctx context.Context) (any, error) {
		name, err := dbParam(ctx)
		if err != nil {
			return nil, err
		}
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		var (
			size, encoding                            string
			connLimit                                 int64
			xidAge                                    int64
			commits, rollbacks, blksRead, blksHit     int64
			tupIns, tupUpd, tupDel                     int64
			tempFiles, tempBytes, deadlocks, conflicts int64
			statsReset                                *time.Time
			current                                   bool
		)
		if err := pool.QueryRow(ctx, `
			select pg_size_pretty(pg_database_size(d.datname)),
			       pg_encoding_to_char(d.encoding),
			       d.datconnlimit,
			       age(d.datfrozenxid),
			       coalesce(s.xact_commit,0), coalesce(s.xact_rollback,0),
			       coalesce(s.blks_read,0), coalesce(s.blks_hit,0),
			       coalesce(s.tup_inserted,0), coalesce(s.tup_updated,0), coalesce(s.tup_deleted,0),
			       coalesce(s.temp_files,0), coalesce(s.temp_bytes,0),
			       coalesce(s.deadlocks,0), coalesce(s.conflicts,0),
			       s.stats_reset,
			       d.datname = current_database()
			from pg_database d
			left join pg_stat_database s on s.datname = d.datname
			where d.datname = $1`, name).Scan(
			&size, &encoding, &connLimit, &xidAge,
			&commits, &rollbacks, &blksRead, &blksHit,
			&tupIns, &tupUpd, &tupDel,
			&tempFiles, &tempBytes, &deadlocks, &conflicts,
			&statsReset, &current); err != nil {
			return nil, plugin.NewError(-32602, "database not found: "+name)
		}
		// Connection state breakdown + the oldest open transaction (a long xact holds
		// locks + blocks vacuum — a real thing to watch).
		var conns, active, idle, idleTx int64
		var longestTx float64
		_ = pool.QueryRow(ctx, `
			select count(*),
			       count(*) filter (where state='active'),
			       count(*) filter (where state='idle'),
			       count(*) filter (where state='idle in transaction'),
			       coalesce(extract(epoch from max(now()-xact_start)),0)
			from pg_stat_activity where datname=$1`, name).Scan(&conns, &active, &idle, &idleTx, &longestTx)

		hitPct := 100.0
		if blksHit+blksRead > 0 {
			hitPct = float64(blksHit) / float64(blksHit+blksRead) * 100
		}
		hitTone := plugin.ToneOK
		if hitPct < 99 {
			hitTone = plugin.ToneWarn
		}
		if hitPct < 90 {
			hitTone = plugin.ToneBad
		}
		rbPct := 0.0
		if commits+rollbacks > 0 {
			rbPct = float64(rollbacks) / float64(commits+rollbacks) * 100
		}
		idleTxComp := plugin.Number(idleTx, "")
		if idleTx > 0 {
			idleTxComp = plugin.Badge(strconv.FormatInt(idleTx, 10), plugin.ToneWarn) // idle-in-tx blocks vacuum
		}
		connLimitStr := "unlimited"
		if connLimit >= 0 {
			connLimitStr = strconv.FormatInt(connLimit, 10)
		}
		statsSince := "—"
		if statsReset != nil {
			statsSince = statsReset.Format("2006-01-02 15:04")
		}

		// Degrade to a flat KV on an older hope with no component renderer.
		if !plugin.Caps(ctx).Supports("component") {
			return plugin.KVData{
				"database": name, "size": size, "encoding": encoding,
				"connections": conns, "active": active, "idle in tx": idleTx,
				"cache hit": fmt.Sprintf("%.1f%%", hitPct), "deadlocks": deadlocks,
				"rollback ratio": fmt.Sprintf("%.2f%%", rbPct), "longest tx": humanDur(longestTx),
			}, nil
		}

		var status any = "—"
		if current {
			status = plugin.Badge("connected", plugin.ToneInfo)
		}
		return plugin.Box(
			plugin.CRow(
				plugin.KeyVal("database", plugin.Badge(name, plugin.ToneInfo)),
				plugin.KeyVal("size", size),
				plugin.KeyVal("encoding", encoding),
				plugin.KeyVal("status", status),
			).Gapped(24),
			plugin.Divider(),
			plugin.Heading("Connections", 3),
			plugin.CRow(
				plugin.KeyVal("total", plugin.Number(conns, "")),
				plugin.KeyVal("active", plugin.Number(active, "")),
				plugin.KeyVal("idle", plugin.Number(idle, "")),
				plugin.KeyVal("idle in tx", idleTxComp),
				plugin.KeyVal("limit", connLimitStr),
			).Gapped(24),
			plugin.Divider(),
			plugin.Heading("Performance", 3),
			plugin.CRow(
				plugin.KeyVal("cache hit", plugin.Badge(fmt.Sprintf("%.1f%%", hitPct), hitTone)),
				plugin.KeyVal("disk reads", plugin.Number(blksRead, " blks")),
				plugin.KeyVal("commits", plugin.Number(commits, "")),
				plugin.KeyVal("rollback ratio", fmt.Sprintf("%.2f%%", rbPct)),
				plugin.KeyVal("deadlocks", plugin.Number(deadlocks, "")),
			).Gapped(24),
			plugin.CRow(
				plugin.KeyVal("rows written", plugin.Number(tupIns+tupUpd+tupDel, "")),
				plugin.KeyVal("temp files", plugin.Number(tempFiles, "")),
				plugin.KeyVal("temp spilled", humanBytes(tempBytes)),
				plugin.KeyVal("conflicts", plugin.Number(conflicts, "")),
			).Gapped(24),
			plugin.Divider(),
			plugin.Heading("Health", 3),
			plugin.CRow(
				plugin.KeyVal("longest tx", humanDur(longestTx)),
				plugin.KeyVal("xid age", plugin.Number(xidAge, "")),
				plugin.KeyVal("stats since", statsSince),
			).Gapped(24),
		), nil
	}, plugin.Refreshable(), plugin.RefreshEvery(15))

	// Top tables by total size (heap + indexes + toast) — the bar chart that shows
	// where disk goes.
	p.ChartView("sizes", "Largest tables", func(ctx context.Context) (any, error) {
		res, err := grid(ctx, `
			select c.relname as name, pg_total_relation_size(c.oid) as bytes
			from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			where c.relkind in ('r','p','m')
			  and n.nspname not in ('pg_catalog','information_schema')
			  and n.nspname not like 'pg_toast%'
			order by bytes desc
			limit 12`)
		if err != nil {
			return nil, err
		}
		labels := []string{}
		mib := []float64{}
		for _, r := range res.Rows {
			name, _ := r[0].(string)
			labels = append(labels, name)
			mib = append(mib, float64(toInt(r[1]))/(1024*1024))
		}
		return plugin.ChartData{Type: "bar", Labels: labels, Series: []plugin.ChartSeries{{Name: "MiB", Values: mib}}}, nil
	})

	// schema -> table -> column tree, for a compact structural overview. Static: the
	// schema rarely changes mid-session and the introspection query is heavy, so hope
	// fetches it once and reuses it on tab re-entry instead of re-running it.
	p.View("schema", "Schema", plugin.Tree, func(ctx context.Context) (any, error) {
		return schemaTree(ctx)
	}, plugin.Static())

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
		// Enumerate from pg_class (not pg_stat_user_tables) so materialized views are
		// always included, and take the row estimate from reltuples — which REFRESH keeps
		// current for an MV, unlike n_live_tup (bumped only by DML, so it sits at 0 for an
		// MV and for any never-analyzed table). reltuples is -1 when unknown; fall back to
		// n_live_tup then. Scan stats come from an optional LEFT JOIN (null for a fresh MV).
		res, err := grid(ctx, `
			select n.nspname, c.relname, c.relkind::text,
			       case when c.reltuples < 0 then coalesce(s.n_live_tup, 0) else c.reltuples::bigint end as est_rows,
			       coalesce(s.n_dead_tup, 0), coalesce(s.seq_scan, 0), coalesce(s.idx_scan, 0),
			       pg_total_relation_size(c.oid) as bytes
			from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_stat_user_tables s on s.relid = c.oid
			where c.relkind in ('r','p','m')
			  and n.nspname not in ('pg_catalog','information_schema')
			  and n.nspname not like 'pg_toast%'
			order by bytes desc`)
		if err != nil {
			return nil, err
		}
		src := res.Rows
		var maxBytes int64 = 1
		for _, r := range src {
			if b := int64(toInt(r[7])); b > maxBytes {
				maxBytes = b
			}
		}
		rows := [][]any{}
		for _, r := range src {
			schema, _ := r[0].(string)
			table, _ := r[1].(string)
			kind, _ := r[2].(string)
			est := toInt(r[3])
			dead, seq, idx := toInt(r[4]), toInt(r[5]), toInt(r[6])
			bytes := int64(toInt(r[7]))
			// Bloat/scan health: mostly-sequential scans or lots of dead tuples warn. A
			// materialized view is a read-only snapshot — scan/bloat health is N/A, so mark
			// it as a matview instead.
			health, tone := "ok", plugin.ToneOK
			switch {
			case kind == "m":
				health, tone = "matview", plugin.ToneInfo
			case dead > 0 && est > 0 && dead*100/est > 20:
				health, tone = "bloated", plugin.ToneBad
			case seq > 0 && idx == 0 && est > 10000:
				health, tone = "seq scans", plugin.ToneWarn
			}
			rows = append(rows, []any{
				plugin.Badge(schema, ""),
				plugin.DetailLink(table, "table", schema+"."+table),
				plugin.Number(est, ""),
				plugin.Badge(humanBytes(bytes), ""),
				plugin.Progress(float64(bytes) / float64(maxBytes)),
				plugin.Badge(health, tone),
			})
		}
		return &plugin.TableData{
			Columns: []string{"schema", "table", "rows", "size", "", "health"},
			Rows:    rows,
			ColumnTips: map[string]*plugin.Tooltip{
				"rows":   plugin.Tip("Row estimate from planner stats (pg_class.reltuples); exact after ANALYZE / REFRESH"),
				"health": plugin.Tip("Scan/bloat state: seq-scan-heavy or a high dead-tuple ratio; matview = read-only snapshot"),
			},
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
		res.Total = int(total)
		return res, nil
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
		cols, err := columnsOf(ctx, schema, table)
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for _, ci := range cols {
			nullCell := plugin.Badge("not null", plugin.ToneWarn)
			if !ci.NotNull {
				nullCell = plugin.Badge("null", "")
			}
			key := ""
			if pks[ci.Name] {
				key = "PK"
			}
			rows = append(rows, []any{plugin.Badge(key, plugin.ToneInfo), ci.Name, plugin.Code(ci.Type), nullCell, plugin.Code(ci.Default)})
		}
		return &plugin.TableData{Columns: []string{"key", "column", "type", "null", "default"}, Rows: rows}, nil
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
		for _, r := range res.Rows {
			name, _ := r[0].(string)
			def, _ := r[1].(string)
			sz, _ := r[2].(string)
			uniq := plugin.Badge("", "")
			if strings.Contains(strings.ToUpper(def), "UNIQUE") {
				uniq = plugin.Badge("unique", plugin.ToneInfo)
			}
			rows = append(rows, []any{name, uniq, sz, plugin.Code(def)})
		}
		return &plugin.TableData{Columns: []string{"index", "", "size", "definition"}, Rows: rows}, nil
	}, plugin.EmptyView("No indexes", plugin.EmptyIcon("key"), plugin.EmptyText("This table has no indexes — sequential scans only.")))

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
		var est, live, dead, seq, idx int64
		var totalSize, tableSize string
		var lastVacuum, lastAnalyze *time.Time
		// Source the estimate from reltuples (kept current by REFRESH for an MV; n_live_tup
		// is not), falling back to n_live_tup when reltuples is unknown (-1). Stats columns
		// LEFT JOIN in — null for a materialized view that's never been vacuumed/analyzed.
		_ = pool.QueryRow(ctx, `
			select case when c.reltuples < 0 then coalesce(s.n_live_tup, 0) else c.reltuples::bigint end,
			       coalesce(s.n_live_tup, 0), coalesce(s.n_dead_tup, 0), coalesce(s.seq_scan, 0), coalesce(s.idx_scan, 0),
			       pg_size_pretty(pg_total_relation_size(c.oid)),
			       pg_size_pretty(pg_relation_size(c.oid)),
			       greatest(s.last_vacuum, s.last_autovacuum), greatest(s.last_analyze, s.last_autoanalyze)
			from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_stat_user_tables s on s.relid = c.oid
			where n.nspname = $1 and c.relname = $2`, schema, table).
			Scan(&est, &live, &dead, &seq, &idx, &totalSize, &tableSize, &lastVacuum, &lastAnalyze)
		return map[string]any{
			"est. rows":    plugin.Number(est, ""),
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
	// SQL editor → results grid. The {table} default is filled from the page param —
	// which is the already-schema-qualified "schema.table", so the template is just
	// {table} (a separate {schema} placeholder would expand to nothing and yield a stray
	// leading dot: "from .public.foo"). Result rows are clickable (row_detail). The
	// plugin owns the connection; hope audits the call.
	p.QueryView("query", "Query", "sql", "select * from {table} limit 100", func(ctx context.Context) (any, error) {
		sql := strings.TrimSpace(plugin.Input(ctx))
		if sql == "" {
			return &plugin.TableData{Columns: []string{}, Rows: [][]any{}}, nil
		}
		res, err := grid(ctx, sql)
		if err != nil {
			return nil, plugin.NewError(-32602, err.Error())
		}
		res.RowMethod = "row_detail"
		return res, nil
	})

	// EXPLAIN pane: type a query, see its plan. Plain EXPLAIN (no ANALYZE) never runs
	// the statement, so it's safe to poke at anything.
	p.QueryView("explain", "Explain", "sql", "select * from {table}", func(ctx context.Context) (any, error) {
		sql := strings.TrimSpace(plugin.Input(ctx))
		if sql == "" {
			return &plugin.TableData{Columns: []string{"QUERY PLAN"}, Rows: [][]any{}}, nil
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
		for _, r := range res.Rows {
			pid := toInt(r[0])
			state, _ := r[3].(string)
			query, _ := r[6].(string)
			rows = append(rows, []any{
				pid, r[1], r[2], plugin.Badge(state, stateTone(state)), r[4],
				plugin.Number(toInt(r[5]), "s"), plugin.Code(truncate(query, 200)),
			})
		}
		return &plugin.TableData{
			Columns: []string{"pid", "user", "db", "state", "wait", "age", "query"},
			Rows:    rows,
			ColumnTips: map[string]*plugin.Tooltip{
				"wait": plugin.Tip("Wait-event type if the backend is blocked (Lock, IO, …)"),
				"age":  plugin.Tip("Seconds since the current query started"),
			},
		}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(5),
		plugin.EmptyView("No active queries 🎉", plugin.EmptyIcon("check"), plugin.EmptyText("Every backend is idle right now.")),
		// Row click opens a right-side flyout with the FULL query + backend detail (the
		// grid truncates it); its cancel/terminate row actions ride along as the footer.
		plugin.RowFlyout("activityDetail"),
		plugin.RowActions(
			plugin.RowAction{Method: "cancel", Label: "Cancel query", Icon: "stop", Tip: plugin.Tip("Cancel this backend's running query (pg_cancel_backend)", plugin.TipTopEnd)},
			plugin.RowAction{Method: "terminate", Label: "Terminate", Icon: "trash", Danger: true, Tip: plugin.Tip("Drop the whole backend connection (pg_terminate_backend)", plugin.TipTopEnd)},
		))

	// activityDetail is the flyout body for a clicked backend: its full SQL (re-fetched by
	// pid, since the grid cell is truncated) plus its identity/state, as a component tree.
	p.ComponentView("activityDetail", "Backend", func(ctx context.Context) (any, error) {
		var pr struct {
			Row map[string]any `json:"row"`
		}
		_ = plugin.Params(ctx, &pr)
		pid := toInt(pr.Row["pid"])
		if pid == 0 {
			return plugin.Box(plugin.CText("no pid on this row")), nil
		}
		pool, err := getPool(ctx)
		if err != nil {
			return nil, err
		}
		var user, db, state, wait, query string
		var dur int
		_ = pool.QueryRow(ctx, `
			select coalesce(usename, ''), coalesce(datname, ''), coalesce(state, ''),
			       coalesce(wait_event_type, '—'),
			       coalesce(extract(epoch from (now() - query_start))::int, 0), coalesce(query, '')
			from pg_stat_activity where pid = $1`, pid).Scan(&user, &db, &state, &wait, &dur, &query)
		if query == "" {
			query = "(no active query)"
		}
		return plugin.Box(
			plugin.Heading(fmt.Sprintf("Backend %d", pid), 2),
			plugin.CRow(
				plugin.KeyVal("user", user),
				plugin.KeyVal("db", db),
				plugin.KeyVal("state", plugin.Badge(state, stateTone(state))),
			).Gapped(18),
			plugin.CRow(
				plugin.KeyVal("wait", wait),
				plugin.KeyVal("age", plugin.Number(dur, "s")),
			).Gapped(18),
			plugin.Divider(),
			plugin.CText("query"),
			plugin.CCell(plugin.Code(query)),
		), nil
	})

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
	}, plugin.ActionIcon("rotate"), plugin.ActionTip("Refresh the planner's statistics — safe and quick", plugin.TipTop))
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
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Reclaim dead-tuple space + refresh stats — heavier, runs a while", plugin.TipTop))

	// Per-database variants — the {db} page param names the target, and we open a
	// connection to THAT database (VACUUM/ANALYZE act on the connection's own database).
	p.Action("analyzeDb", "Analyze this database", nil, func(ctx context.Context, in map[string]any) (any, error) {
		name, err := dbParam(ctx)
		if err != nil {
			return nil, err
		}
		conn, err := connectTo(ctx, name)
		if err != nil {
			return nil, err
		}
		defer conn.Close(ctx)
		if _, err := conn.Exec(ctx, `analyze`); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "analyzed " + name}, nil
	}, plugin.ActionIcon("rotate"), plugin.ActionTip("Refresh this database's planner statistics", plugin.TipTop))
	p.DangerAction("vacuumDb", "Vacuum this database", nil, func(ctx context.Context, in map[string]any) (any, error) {
		name, err := dbParam(ctx)
		if err != nil {
			return nil, err
		}
		conn, err := connectTo(ctx, name)
		if err != nil {
			return nil, err
		}
		defer conn.Close(ctx)
		if _, err := conn.Exec(ctx, `vacuum (analyze)`); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "vacuum + analyze complete on " + name}, nil
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Reclaim dead-tuple space in this database + refresh stats", plugin.TipTop))
}

// --- Layout ---------------------------------------------------------------------

func registerLayout(p *plugin.Plugin) {
	// Container panel on any postgres-family image: the server-wide tabs, plus a
	// maintenance section. Per-table views are reached by drilling into a table.
	p.ContainerPanel("Postgres", &plugin.Match{Images: []string{"postgres*", "pgvector*", "timescale*"}},
		plugin.Section("",
			plugin.Tabs(
				plugin.Leaf("overview").Titled("Overview"),
				plugin.Leaf("health").Titled("Health"),
				plugin.Leaf("databases").Titled("Databases"),
				plugin.Leaf("tables").Titled("Tables"),
				plugin.Leaf("sizes").Titled("Sizes"),
				plugin.Leaf("schema").Titled("Schema"),
				plugin.Leaf("query").Titled("Query"),
				plugin.Leaf("explain").Titled("Explain"),
				plugin.Leaf("activity").Titled("Activity"),
				plugin.Leaf("alertRules").Titled("Alerts"),
			),
			plugin.Section("Alerts", plugin.Buttons("addAlert")),
			plugin.Section("Maintenance", plugin.Buttons("analyze", "vacuum")),
		))

	// A standalone nav page — a first-class rail entry + a ⌘K command-palette entry,
	// openable without drilling into the postgres container. A fuller layout than the
	// container tabs (stat band, a size/database row, then the working tabs) with the
	// maintenance ops as a header toolbar. PageID makes it a stable link/breadcrumb
	// target (the table detail page points its crumb back here).
	p.Page("Postgres", plugin.Section("",
		plugin.Leaf("overview"),
		plugin.Row(
			plugin.Section("Health", plugin.Leaf("health")),
			plugin.Section("Largest tables", plugin.Leaf("sizes")),
			plugin.Section("Databases", plugin.Leaf("databases")),
		),
		plugin.Tabs(
			plugin.Leaf("tables").Titled("Tables").Filled(),
			plugin.Leaf("query").Titled("Query"),
			plugin.Leaf("explain").Titled("Explain"),
			plugin.Leaf("activity").Titled("Activity"),
			plugin.Leaf("alertRules").Titled("Alerts"),
			plugin.Leaf("schema").Titled("Schema"),
		),
	)).PageID("postgres").
		Subtitle("browse, query, operate, and monitor this database").
		HeaderActions("addAlert", "analyze", "vacuum")

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

	// Per-database page, reached by clicking a card in the Databases gallery. Its {db}
	// param drives the detail view and the maintenance header actions (analyze/vacuum
	// scoped to that one database).
	p.DetailPage("database", "Database", "db", plugin.Section("",
		plugin.Section("Overview", plugin.Leaf("databaseDetail")),
	)).Subtitle("{db}").
		Breadcrumbs(
			plugin.Crumb{Label: "Postgres", To: "postgres"},
			plugin.Crumb{Label: "{db}"},
		).HeaderActions("analyzeDb", "vacuumDb")

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
	// pg_class (not information_schema, which omits materialized views) so MVs show in
	// the rail tree alongside tables. relkind: 'r' table, 'p' partitioned, 'm' matview.
	res, err := grid(ctx, `
		select n.nspname, c.relname, c.relkind::text
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		where c.relkind in ('r','p','m')
		  and n.nspname not in ('pg_catalog','information_schema')
		  and n.nspname not like 'pg_toast%'
		order by n.nspname, c.relname`)
	if err != nil {
		return treeItems
	}
	// Keep tables and materialized views in separate buckets per schema, so MVs can be
	// tucked under their own "materialized views" subgroup instead of mixing into the
	// table list (cleaner tree, and the group carries the distinguishing icon).
	order := []string{}
	tables := map[string][]plugin.PageItem{}
	matviews := map[string][]plugin.PageItem{}
	for _, r := range res.Rows {
		schema, _ := r[0].(string)
		table, _ := r[1].(string)
		kind, _ := r[2].(string)
		if _, seen := tables[schema]; !seen {
			if _, seen2 := matviews[schema]; !seen2 {
				order = append(order, schema)
			}
		}
		item := plugin.PageItem{Title: table, Param: map[string]any{"table": schema + "." + table}}
		if kind == "m" {
			matviews[schema] = append(matviews[schema], item)
		} else {
			tables[schema] = append(tables[schema], item)
		}
	}
	items := make([]plugin.PageItem, 0, len(order))
	for _, s := range order {
		kids := tables[s]
		if mvs := matviews[s]; len(mvs) > 0 {
			// Nest MVs under one collapsible group at the end of the schema's children.
			kids = append(kids, plugin.PageItem{Title: "materialized views", Icon: "layers", Children: mvs})
		}
		items = append(items, plugin.PageItem{Title: s, Icon: "database", Children: kids})
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
// grid runs a query and returns it as a typed *plugin.TableData ({columns, rows}).
// Views return it (optionally setting Total/RowMethod/ColumnTips); helpers read .Rows.
func grid(ctx context.Context, sql string, args ...any) (*plugin.TableData, error) {
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
	return &plugin.TableData{Columns: cols, Rows: out}, nil
}

// dbParam reads the {db} page param — the database a per-database page/action targets.
func dbParam(ctx context.Context) (string, error) {
	var pr struct {
		DB string `json:"db"`
	}
	_ = plugin.Params(ctx, &pr)
	name := strings.TrimSpace(pr.DB)
	if name == "" {
		return "", plugin.NewError(-32602, "no database selected")
	}
	return name, nil
}

// connectTo opens a short-lived connection to another database on the same server,
// reusing DATABASE_URL's host/credentials but swapping the database name. The per-database
// maintenance actions need it because VACUUM/ANALYZE run against the connection's OWN
// database and the pool is pinned to one. The name only sets the connection's database
// (never interpolated into SQL), so there's no injection surface. Caller must Close.
func connectTo(ctx context.Context, dbname string) (*pgx.Conn, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return nil, errors.New("DATABASE_URL is not set")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	cfg.Database = dbname
	return pgx.ConnectConfig(ctx, cfg)
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

// colInfo is one column's catalog metadata. Sourced from pg_attribute (not
// information_schema) so it covers materialized views and views too — Postgres omits
// both from information_schema entirely, which is why an MV's columns/data/DDL used to
// come back empty.
type colInfo struct {
	Name    string
	Type    string
	NotNull bool
	Default string
}

// columnsOf returns a relation's columns from pg_catalog, in attribute order. Works for
// ordinary/partitioned tables AND materialized views + views.
func columnsOf(ctx context.Context, schema, table string) ([]colInfo, error) {
	res, err := grid(ctx, `
		select a.attname,
		       format_type(a.atttypid, a.atttypmod) as type,
		       a.attnotnull,
		       coalesce(pg_get_expr(d.adbin, d.adrelid), '') as def
		from pg_attribute a
		join pg_class c on c.oid = a.attrelid
		join pg_namespace n on n.oid = c.relnamespace
		left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
		where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
		order by a.attnum`, schema, table)
	if err != nil {
		return nil, err
	}
	out := make([]colInfo, 0, len(res.Rows))
	for _, r := range res.Rows {
		var ci colInfo
		ci.Name, _ = r[0].(string)
		ci.Type, _ = r[1].(string)
		ci.NotNull, _ = r[2].(bool)
		ci.Default, _ = r[3].(string)
		out = append(out, ci)
	}
	if len(out) == 0 {
		return nil, plugin.NewError(-32602, "relation not found: "+schema+"."+table)
	}
	return out, nil
}

// relkindOf returns a relation's pg_class.relkind ('r' table, 'p' partitioned, 'm'
// materialized view, 'v' view). Defaults to 'r' if it can't be resolved.
func relkindOf(ctx context.Context, schema, table string) string {
	res, err := grid(ctx, `
		select c.relkind::text from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relname = $2`, schema, table)
	if err == nil && len(res.Rows) > 0 {
		if s, ok := res.Rows[0][0].(string); ok && s != "" {
			return s
		}
	}
	return "r"
}

// tableColumns returns the ordered column names of a table (or MV/view).
func tableColumns(ctx context.Context, schema, table string) ([]string, error) {
	cis, err := columnsOf(ctx, schema, table)
	if err != nil {
		return nil, err
	}
	cols := make([]string, len(cis))
	for i := range cis {
		cols[i] = cis[i].Name
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
	for _, r := range res.Rows {
		if s, ok := r[0].(string); ok {
			pk[s] = true
		}
	}
	return pk, nil
}

// tableDDL reconstructs a readable CREATE TABLE (+ index definitions) from the
// catalog — enough to copy the shape, not a pg_dump-exact reproduction.
func tableDDL(ctx context.Context, schema, table string) (string, error) {
	// A materialized view has no CREATE TABLE — reconstruct its defining query instead.
	if relkindOf(ctx, schema, table) == "m" {
		res, err := grid(ctx, `select pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)`, schema, table)
		if err == nil && len(res.Rows) > 0 {
			if def, ok := res.Rows[0][0].(string); ok {
				return fmt.Sprintf("CREATE MATERIALIZED VIEW %s.%s AS\n%s", quoteIdent(schema), quoteIdent(table), def), nil
			}
		}
	}
	cols, err := columnsOf(ctx, schema, table)
	if err != nil {
		return "", err
	}
	pks, _ := primaryKey(ctx, schema, table)

	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s.%s (\n", quoteIdent(schema), quoteIdent(table))
	pkOrder := []string{}
	for i, ci := range cols {
		fmt.Fprintf(&b, "    %s %s", quoteIdent(ci.Name), ci.Type)
		if ci.NotNull {
			b.WriteString(" NOT NULL")
		}
		if ci.Default != "" {
			fmt.Fprintf(&b, " DEFAULT %s", ci.Default)
		}
		if pks[ci.Name] {
			pkOrder = append(pkOrder, quoteIdent(ci.Name))
		}
		if i < len(cols)-1 || len(pkOrder) > 0 {
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
		for _, r := range ires.Rows {
			if def, ok := r[0].(string); ok {
				fmt.Fprintf(&b, "\n%s;", def)
			}
		}
	}
	return b.String(), nil
}

// schemaTree builds a rich schema -> table -> column tree: schemas collapse, tables
// carry a "box" icon and link (To) to their detail page, columns show name : type.
func schemaTree(ctx context.Context) (plugin.TreeData, error) {
	// pg_catalog, not information_schema — the latter omits materialized views (and their
	// columns) entirely, so MVs were missing from the schema tree.
	res, err := grid(ctx, `
		select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
		where c.relkind in ('r','p','m')
		  and n.nspname not in ('pg_catalog','information_schema')
		  and n.nspname not like 'pg_toast%'
		order by n.nspname, c.relname, a.attnum`)
	if err != nil {
		return plugin.TreeData{}, err
	}

	type tbl struct {
		name string
		cols []plugin.TreeNode
	}
	schemaOrder := []string{}
	schemas := map[string][]*tbl{}
	tblIndex := map[string]*tbl{}
	for _, r := range res.Rows {
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
		t.cols = append(t.cols, plugin.TreeNode{Label: col + " : " + typ})
	}

	nodes := []plugin.TreeNode{}
	for _, s := range schemaOrder {
		tables := []plugin.TreeNode{}
		for _, t := range schemas[s] {
			tables = append(tables, plugin.TreeNode{
				Label:    t.name,
				Icon:     "box",
				To:       "table/" + s + "." + t.name, // -> the "table" detail page
				Tip:      plugin.Tip("Open " + s + "." + t.name),
				Children: t.cols,
			})
		}
		// Collapse all but the first schema so a big database isn't a wall of tables.
		nodes = append(nodes, plugin.TreeNode{Label: s, Icon: "database", Collapsed: len(nodes) > 0, Children: tables})
	}
	return plugin.TreeData{Nodes: nodes}, nil
}

// --- small helpers --------------------------------------------------------------

// jsonSafeRow converts values pgx returns into JSON-friendly forms (mainly []byte
// -> string) so the grid renders cleanly.
func jsonSafeRow(vals []any) []any {
	out := make([]any, len(vals))
	for i, v := range vals {
		switch t := v.(type) {
		case [16]byte:
			// pgx decodes a uuid column into a raw [16]byte ARRAY (not a []byte slice), so
			// it slips past the []byte case below and JSON-marshals as a 16-number array.
			// uuid.UUID IS a [16]byte, so this is a direct cast to a proper UUID whose
			// String() is the canonical 8-4-4-4-12 form.
			out[i] = uuid.UUID(t).String()
		case []byte:
			// json / jsonb come back as raw bytes. Render valid JSON as a Code cell (indented
			// so it reads as structured data, not a wall of text); everything else (bytea,
			// text served as bytes) stays a plain string.
			s := string(t)
			if trimmed := strings.TrimSpace(s); (strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")) && json.Valid(t) {
				var buf bytes.Buffer
				if json.Indent(&buf, t, "", "  ") == nil {
					out[i] = plugin.Code(buf.String())
					continue
				}
			}
			out[i] = s
		default:
			out[i] = v
		}
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

// humanDur formats a duration in seconds compactly (used for the oldest open txn).
func humanDur(secs float64) string {
	if secs <= 0 {
		return "—"
	}
	switch {
	case secs < 60:
		return fmt.Sprintf("%.0fs", secs)
	case secs < 3600:
		return fmt.Sprintf("%.0fm", secs/60)
	default:
		return fmt.Sprintf("%.1fh", secs/3600)
	}
}
