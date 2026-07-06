// kitchen-sink exercises the whole hope plugin protocol in one plugin: every
// setting kind, every view kind, every stream kind, actions (incl. danger), every
// layout primitive, a full page, and a nested dynamic page that also generates
// load (3 databases x 20 tables = 60 rail entries) plus a large table view. Point
// hope at it to smoke-test the entire surface.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/toyz/hope/plugin"
)

// In-memory mutable state so mutations (rename/edit/delete) are VISIBLE after hope
// refetches — a real plugin would persist to its own store; the demo keeps a map so
// the round-trip is observable. Keyed by "table|id".
var (
	stateMu sync.Mutex
	renamed = map[string]string{} // table|id -> new name
	deleted = map[string]bool{}   // table|id -> removed
)

func rowKey(table string, id int) string { return table + "|" + strconv.Itoa(id) }

// rowIdent pulls the table + row id out of an action's {row: {...}} params. JSON
// numbers arrive as float64, so coerce id defensively.
func rowIdent(in map[string]any) (table string, id int, ok bool) {
	row, _ := in["row"].(map[string]any)
	if row == nil {
		return "", 0, false
	}
	table, _ = row["table"].(string)
	switch v := row["id"].(type) {
	case float64:
		id = int(v)
	case int:
		id = v
	case string:
		id, _ = strconv.Atoi(v)
	default:
		return "", 0, false
	}
	return table, id, true
}

func main() {
	p := plugin.New("kitchen-sink", "1.0.0").
		Description("Every hope plugin surface, kind, and primitive — plus load").
		Icon("box").
		Icons(map[string]string{
			// plugin-scoped inner SVG (24x24 stroke); hope sanitizes + namespaces these.
			"beaker": `<path d="M4.5 3h15"/><path d="M6 3v7L3 21h18L18 10V3"/><path d="M6 14h12"/>`,
		})

	// --- settings: one of every kind ---
	p.Setting(plugin.Setting{Key: "title", Label: "Title", Default: "Kitchen Sink", Hint: "shown on the overview"})
	p.Setting(plugin.Setting{Key: "notes", Label: "Notes", Kind: plugin.SettingTextarea})
	p.Setting(plugin.Setting{Key: "theme", Label: "Theme", Kind: plugin.SettingSelect, Default: "dark",
		Options: []plugin.Option{{Label: "Dark", Value: "dark"}, {Label: "Light", Value: "light"}}})
	p.Setting(plugin.Setting{Key: "verbose", Label: "Verbose", Kind: plugin.SettingToggle})
	p.Setting(plugin.Setting{Key: "rows", Label: "Table rows", Kind: plugin.SettingNumber, Default: "500", Hint: "load-test row count (max 5000)"})
	p.Setting(plugin.Setting{Key: "apikey", Label: "API key", Kind: plugin.SettingSecret})

	// --- views: every kind ---
	p.View("overview", "Overview", plugin.KV, func(ctx context.Context) (any, error) {
		host, _ := os.Hostname()
		return map[string]any{
			"title":   p.SettingValue("title"),
			"theme":   p.SettingValue("theme"),
			"verbose": p.SettingValue("verbose"),
			"host":    host,
			"pid":     os.Getpid(),
			"uptime":  time.Since(started).Truncate(time.Second).String(),
		}, nil
	})

	// table: synthetic rows, sized by the setting, tagged with the page param — so a
	// dynamic page (db/table) shows "its" data and big row counts stress rendering.
	// Rows are interactive: click one for a detail modal (rowDetail), or use the
	// per-row Delete action (delRow) — both author-declared, author-handled RPCs.
	p.TableView("rows", "Rows", func(ctx context.Context) (any, error) {
		var pr struct {
			DB    string `json:"db"`
			Table string `json:"table"`
		}
		_ = plugin.Params(ctx, &pr)
		n := 500
		if v, err := strconv.Atoi(p.SettingValue("rows")); err == nil && v > 0 && v <= 5000 {
			n = v
		}
		tbl := orDefault(pr.Table, "-")
		stateMu.Lock()
		defer stateMu.Unlock()
		rows := make([][]any, 0, n)
		for i := range n {
			key := rowKey(tbl, i)
			if deleted[key] {
				continue // removed by a row action — stays gone across refetches
			}
			name := fmt.Sprintf("row-%d", i)
			if nn, ok := renamed[key]; ok {
				name = nn // renamed/edited — the new value shows after refetch
			}
			rows = append(rows, []any{i, orDefault(pr.DB, "-"), tbl, name, i * 7 % 1000})
		}
		return map[string]any{"columns": []string{"id", "db", "table", "name", "value"}, "rows": rows}, nil
	},
		plugin.PageSize(50),                    // plugin-declared page size (the author knows the data)
		plugin.Editable("editRow", "name"),     // the "name" column is inline-editable
		plugin.RowDetailButton("rowDetail"),    // detail via a "view" button (rows are editable, so no whole-row click)
		plugin.RowActions(
			// A row action with an input field: hope collects "name" before the call.
			// Icon "beaker" is this plugin's own SVG (sanitized + namespaced by hope).
			plugin.RowAction{Method: "renameRow", Label: "Rename", Icon: "beaker", Fields: []plugin.Field{
				{Key: "name", Label: "New name", Placeholder: "row-name"},
			}},
			plugin.RowAction{Method: "delRow", Label: "Delete", Icon: "trash", Danger: true},
		),
	)

	// rowDetail: the author-controlled RPC hope calls when a row is clicked. Gets the
	// clicked row as {row: {col: val}}; returns whatever detail it wants (here a kv).
	p.View("rowDetail", "Row detail", plugin.KV, func(ctx context.Context) (any, error) {
		var pr struct {
			Row map[string]any `json:"row"`
		}
		_ = plugin.Params(ctx, &pr)
		out := map[string]any{}
		for k, v := range pr.Row {
			out[k] = v
		}
		out["note"] = "loaded by the plugin, not hope"
		return out, nil
	})

	// delRow: a per-row danger action. Gets {row}; here it just reports (a real
	// plugin would DELETE ... WHERE id = row.id against its own DB).
	p.DangerAction("delRow", "Delete row", nil, func(ctx context.Context, in map[string]any) (any, error) {
		tbl, id, ok := rowIdent(in)
		if !ok {
			return map[string]any{"ok": false, "message": "no row"}, nil
		}
		stateMu.Lock()
		deleted[rowKey(tbl, id)] = true
		stateMu.Unlock()
		// ok:true (default) => hope refetches; the row is now gone from the listing.
		return map[string]any{"ok": true, "message": fmt.Sprintf("deleted row %d", id)}, nil
	})

	// editRow: inline cell edit. Gets {row, column, value}. Only the "name" column is
	// editable (declared via Editable); persist it so the refetch shows the new value.
	p.Action("editRow", "Edit cell", nil, func(ctx context.Context, in map[string]any) (any, error) {
		tbl, id, ok := rowIdent(in)
		col, _ := in["column"].(string)
		val, _ := in["value"].(string)
		if !ok || col != "name" {
			return map[string]any{"ok": false, "message": "only the name column is editable"}, nil
		}
		stateMu.Lock()
		renamed[rowKey(tbl, id)] = val
		stateMu.Unlock()
		return map[string]any{"ok": true, "message": fmt.Sprintf("row %d name = %q", id, val)}, nil
	})

	// renameRow: a row action WITH input — hope collects "name" and merges it with
	// {row}; persist so the change is visible after refetch.
	p.Action("renameRow", "Rename row", []plugin.Field{{Key: "name", Label: "New name"}}, func(ctx context.Context, in map[string]any) (any, error) {
		tbl, id, ok := rowIdent(in)
		name, _ := in["name"].(string)
		if !ok || strings.TrimSpace(name) == "" {
			return map[string]any{"ok": false, "message": "a name is required"}, nil
		}
		stateMu.Lock()
		renamed[rowKey(tbl, id)] = name
		stateMu.Unlock()
		return map[string]any{"ok": true, "message": fmt.Sprintf("renamed row %d to %q", id, name)}, nil
	})

	// A real query view: SQL-highlighted editor prepopulated with "select * from
	// {table}" (the page's table). Columns are DYNAMIC — hope renders exactly the
	// columns the query's SELECT list names (pgAdmin-style), so `select id, name`
	// yields a two-column grid. Rows here are clickable too (rowDetail).
	p.QueryView("sql", "Query", "sql", "select * from {table}", func(ctx context.Context) (any, error) {
		var pr struct {
			Table string `json:"table"`
		}
		_ = plugin.Params(ctx, &pr) // the page's param (which table), when opened from Explorer
		cols := parseSelect(plugin.Input(ctx))
		if len(cols) == 0 {
			cols = []string{"id", "table", "name", "value", "created"}
		}
		rows := make([][]any, 0, 200)
		for i := range 200 {
			rec := map[string]any{
				"id": i, "table": orDefault(pr.Table, "-"), "name": fmt.Sprintf("row-%d", i),
				"value": i * 7 % 1000, "created": started.Add(time.Duration(i) * time.Minute).Format("15:04:05"),
			}
			row := make([]any, len(cols))
			for j, c := range cols {
				if v, ok := rec[c]; ok {
					row[j] = v
				} else {
					row[j] = "NULL" // unknown column -> pgAdmin-style NULL
				}
			}
			rows = append(rows, row)
		}
		return map[string]any{"columns": cols, "rows": rows, "row_method": "rowDetail"}, nil
	})

	// chart: a bar/line chart view (static data at rest; use a stream for live).
	p.ChartView("chart", "Traffic", func(ctx context.Context) (any, error) {
		return plugin.ChartData{
			Type:   "bar",
			Labels: []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"},
			Series: []plugin.ChartSeries{
				{Name: "reads", Values: []float64{120, 180, 150, 220, 300, 90, 60}},
				{Name: "writes", Values: []float64{40, 55, 48, 70, 110, 25, 18}},
			},
		}, nil
	})

	// A SERVER-DRIVEN table: 100k synthetic rows the plugin pages/sorts/filters —
	// hope never ships them all. Read the query with plugin.ReadTableQuery, return
	// one page + a total. This is the pattern data-heavy plugins need.
	p.TableView("big", "Big Table (server-side)", func(ctx context.Context) (any, error) {
		const totalRows = 100000
		q, _ := plugin.ReadTableQuery(ctx)
		size := q.PageSize
		if size <= 0 {
			size = 100
		}
		f := strings.ToLower(strings.TrimSpace(q.Filter))
		name := func(i int) string { return fmt.Sprintf("user-%05d", i) }
		score := func(i int) int { return i * 7 % 1000 }
		// filter (server-side) -> list of matching ids
		ids := make([]int, 0, totalRows)
		for i := range totalRows {
			if f == "" || strings.Contains(name(i), f) || strings.Contains(strconv.Itoa(score(i)), f) {
				ids = append(ids, i)
			}
		}
		// sort (server-side) by the requested column
		if q.Sort.Column != "" {
			less := map[string]func(a, b int) bool{
				"id":    func(a, b int) bool { return a < b },
				"name":  func(a, b int) bool { return name(a) < name(b) },
				"score": func(a, b int) bool { return score(a) < score(b) },
			}[q.Sort.Column]
			if less != nil {
				sort.SliceStable(ids, func(x, y int) bool {
					if q.Sort.Dir < 0 {
						return less(ids[y], ids[x])
					}
					return less(ids[x], ids[y])
				})
			}
		}
		total := len(ids)
		start := min(q.Page*size, total)
		end := min(start+size, total)
		rows := make([][]any, 0, end-start)
		for _, i := range ids[start:end] {
			rows = append(rows, []any{i, name(i), score(i)})
		}
		return map[string]any{"columns": []string{"id", "name", "score"}, "rows": rows, "total": total}, nil
	}, plugin.ServerSide(), plugin.PageSize(100))

	p.View("tree", "Schema", plugin.Tree, func(ctx context.Context) (any, error) {
		return map[string]any{"nodes": []any{
			node("app", node("users"), node("orders"), node("events")),
			node("analytics", node("daily"), node("monthly")),
		}}, nil
	})

	// --- streams: every kind ---
	p.Stream("counter", "Counter", plugin.Counter, func(ctx context.Context, emit plugin.EmitFunc) error {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var n int
		emit(map[string]any{"count": n, "rps": 0})
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				n++
				emit(map[string]any{"count": n, "rps": n % 13})
			}
		}
	})
	p.Stream("log", "Log", plugin.Log, func(ctx context.Context, emit plugin.EmitFunc) error {
		t := time.NewTicker(1500 * time.Millisecond)
		defer t.Stop()
		var i int
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				i++
				emit(map[string]any{"line": fmt.Sprintf("[%s] event %d", time.Now().Format("15:04:05"), i)})
			}
		}
	})
	p.Stream("series", "Series", plugin.Series, func(ctx context.Context, emit plugin.EmitFunc) error {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var x int
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				x++
				emit(map[string]any{"t": x, "y": (x * x) % 97})
			}
		}
	})

	// --- actions (normal + danger) ---
	p.Action("greet", "Greet", []plugin.Field{{Key: "name", Label: "Name", Placeholder: "world"}}, func(ctx context.Context, in map[string]any) (any, error) {
		name, _ := in["name"].(string)
		if name == "" {
			name = "world"
		}
		return map[string]any{"message": "hello, " + name}, nil
	})
	p.DangerAction("wipe", "Wipe (danger)", nil, func(ctx context.Context, in map[string]any) (any, error) {
		return map[string]any{"ok": true, "message": "pretend-wiped"}, nil
	})

	// --- container panel: every layout primitive (section/row/grid/tabs/leaf) ---
	p.ContainerPanel("Kitchen Sink", &plugin.Match{Always: true}, plugin.Section("",
		plugin.Row(
			plugin.Section("Overview", plugin.Leaf("overview")),
			plugin.Section("Counter", plugin.Leaf("counter")),
		),
		plugin.Grid(
			plugin.Section("Schema", plugin.Leaf("tree")),
			plugin.Section("Series", plugin.Leaf("series")),
		),
		plugin.Tabs(
			plugin.Leaf("sql").Titled("Query"),
			plugin.Leaf("rows").Titled("Rows").Filled(),
			plugin.Leaf("log").Titled("Log"),
		),
		plugin.Section("Actions", plugin.Row(plugin.Leaf("greet"), plugin.Leaf("wipe"))),
	))

	// --- a dashboard widget: a compact panel on hope's fleet/host dashboard ---
	p.DashboardWidget("Kitchen Sink", plugin.Section("",
		plugin.Row(plugin.Leaf("overview"), plugin.Leaf("series")),
	))

	// --- a single full page, with page-level header actions (a toolbar) ---
	p.Page("Dashboard", plugin.Section("",
		plugin.Row(plugin.Leaf("overview"), plugin.Leaf("counter"), plugin.Leaf("series")),
		plugin.Section("Traffic", plugin.Leaf("chart")),
		plugin.Section("Big Table", plugin.Leaf("big").Filled()),
		plugin.Section("Rows", plugin.Leaf("rows")),
	)).HeaderActions("greet", "wipe") // buttons in the page header, not inline

	// --- dynamic nested pages for LOAD: 3 databases x 20 tables = 60 rail entries,
	//     all sharing one layout, each passing {db, table} that the rows view reads.
	dbs := make([]plugin.PageItem, 0, 3)
	for _, db := range []string{"prod", "staging", "analytics"} {
		tables := make([]plugin.PageItem, 0, 20)
		for i := range 20 {
			t := fmt.Sprintf("table_%02d", i)
			tables = append(tables, plugin.PageItem{Title: t, Param: map[string]any{"db": db, "table": t}})
		}
		dbs = append(dbs, plugin.PageItem{Title: db, Children: tables})
	}
	p.DynamicPage("Explorer", plugin.Section("",
		plugin.Leaf("overview"),
		plugin.Section("Query", plugin.Leaf("sql")),
		plugin.Section("Rows", plugin.Leaf("rows").Filled()),
	), dbs)

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("kitchen-sink plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
}

func node(label string, children ...any) map[string]any {
	m := map[string]any{"label": label}
	if len(children) > 0 {
		m["children"] = children
	}
	return m
}

// parseSelect pulls the column list out of a "select a, b from …" query so the
// result grid's columns follow the query (dynamic columns). Returns nil for
// "select *" or an unparseable query, so the caller falls back to all columns.
func parseSelect(q string) []string {
	l := strings.ToLower(q)
	si := strings.Index(l, "select ")
	fi := strings.Index(l, " from ")
	if si < 0 || fi < 0 || fi <= si {
		return nil
	}
	list := strings.TrimSpace(q[si+len("select ") : fi])
	if list == "" || strings.Contains(list, "*") {
		return nil
	}
	var out []string
	for _, part := range strings.Split(list, ",") {
		if c := strings.TrimSpace(part); c != "" {
			out = append(out, c)
		}
	}
	return out
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

var started = time.Now()
