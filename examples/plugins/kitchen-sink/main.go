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
	"maps"
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

// ── graph (blueprint) demo state — a few in-memory DAGs the canvas edits ──
type dag struct {
	name  string
	nodes map[string]*plugin.GraphNode
	order []string
	edges []plugin.GraphEdge
}

var (
	gmu   sync.Mutex
	dags  map[string]*dag
	gseq  int
	gicon = map[string]string{"source": "box", "transform": "beaker", "filter": "search", "sink": "check"}
	gtone = map[string]string{"source": plugin.ToneOK, "transform": plugin.ToneInfo, "filter": plugin.ToneWarn, "sink": plugin.ToneOK}
)

func gPortsFor(typ string) (in, out []plugin.Port) {
	switch typ {
	case "source":
		out = []plugin.Port{plugin.GPort("out", "rows")}
	case "sink":
		in = []plugin.Port{plugin.GPort("in", "rows")}
	case "filter":
		in = []plugin.Port{plugin.GPort("in", "rows")}
		out = []plugin.Port{plugin.GPort("out", "kept")}
	default:
		in = []plugin.Port{plugin.GPort("in", "rows")}
		out = []plugin.Port{plugin.GPort("out", "rows")}
	}
	return
}

// gApplyMeta rebuilds a node's clean meta strip (type + any configured params) — so populated
// params show on the node face without a hand-built body.
func gApplyMeta(n *plugin.GraphNode) {
	n.Meta = []plugin.NodeMeta{{Label: "type", Value: n.Type}}
	if m, _ := n.Data["mode"].(string); m != "" {
		n.Meta = append(n.Meta, plugin.NodeMeta{Label: "mode", Value: m, Tone: plugin.ToneInfo})
	}
	if p, _ := n.Data["parallel"].(string); p != "" && p != "0" {
		n.Meta = append(n.Meta, plugin.NodeMeta{Label: "parallel", Value: p + " workers"})
	}
}

func gMkNode(id, typ, title string, x, y float64) *plugin.GraphNode {
	in, out := gPortsFor(typ)
	n := plugin.GNode(id, title).At(x, y).Typed(typ).Ico(gicon[typ]).Toned(gtone[typ]).InPorts(in...).OutPorts(out...)
	gApplyMeta(n)
	// transform/filter nodes get a config form: a Mode dropdown populated from an
	// OptionsMethod + a numeric worker count. Click the node (or right-click -> Configure).
	if typ == "transform" || typ == "filter" {
		n = n.Form(
			plugin.Field{Key: "mode", Label: "Mode", Type: plugin.FieldSelect, OptionsMethod: "xfModes", Help: "how this stage processes rows"},
			plugin.Field{Key: "parallel", Label: "Parallel", Type: plugin.FieldNumber, Min: 1, Max: 16, Unit: "workers", Optional: true},
		)
	}
	return n
}

func gSeed() {
	if dags != nil {
		return
	}
	dags = map[string]*dag{}
	mk := func(name string, nodes []*plugin.GraphNode, edges ...plugin.GraphEdge) *dag {
		d := &dag{name: name, nodes: map[string]*plugin.GraphNode{}}
		for _, n := range nodes {
			d.nodes[n.ID] = n
			d.order = append(d.order, n.ID)
		}
		d.edges = edges
		return d
	}
	dags["ingest"] = mk("ingest",
		[]*plugin.GraphNode{gMkNode("src", "source", "API source", 40, 70), gMkNode("xf", "transform", "Normalize", 300, 70), gMkNode("snk", "sink", "Warehouse", 560, 70)},
		plugin.GEdge("src:out", "xf:in"), plugin.GEdge("xf:out", "snk:in"))
	dags["nightly-report"] = mk("nightly-report",
		[]*plugin.GraphNode{gMkNode("q", "source", "Query", 40, 70), gMkNode("f", "filter", "Filter", 300, 70), gMkNode("m", "sink", "Email", 560, 70)},
		plugin.GEdge("q:out", "f:in"), plugin.GEdge("f:out", "m:in"))
}

// gPick resolves the active DAG from a mutation/view's {graph} arg (default "ingest").
func gPick(id string) *dag {
	gSeed()
	if id == "" || dags[id] == nil {
		return dags["ingest"]
	}
	return dags[id]
}

func gRowStr(in map[string]any, key string) string {
	row, _ := in["row"].(map[string]any)
	if row == nil {
		return ""
	}
	s, _ := row[key].(string)
	return s
}

func gRowF(in map[string]any, key string) float64 {
	row, _ := in["row"].(map[string]any)
	if row == nil {
		return 0
	}
	switch v := row[key].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return 0
}

func main() {
	p := plugin.New("kitchen-sink", "1.5.0").
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
		return map[string]any{"columns": []string{"id", "db", "table", "name", "value"}, "rows": rows,
			"column_tips": map[string]*plugin.Tooltip{"value": plugin.Tip("The row's value (demo data)")}}, nil
	},
		plugin.PageSize(50),                 // plugin-declared page size (the author knows the data)
		plugin.Editable("editRow", "name"),  // the "name" column is inline-editable
		plugin.RowDetailButton("rowDetail"), // detail via a "view" button (rows are editable, so no whole-row click)
		plugin.RowActions(
			// A row action with an input field: hope collects "name" before the call.
			// Icon "beaker" is this plugin's own SVG (sanitized + namespaced by hope).
			plugin.RowAction{Method: "renameRow", Label: "Rename", Icon: "beaker", Tip: plugin.Tip("Rename this row", plugin.TipTopEnd), Fields: []plugin.Field{
				{Key: "name", Label: "New name", Placeholder: "row-name"},
			}},
			plugin.RowAction{Method: "delRow", Label: "Delete", Icon: "trash", Danger: true, Tip: plugin.Tip("Delete this row (demo)", plugin.TipTopEnd)},
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
		maps.Copy(out, pr.Row)
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

	// A STAT/counter view with a manual refresh button — e.g. "count rows in my DB"
	// on demand. Returns StatData (big-number blocks). Refreshable() adds the button.
	p.StatView("counts", "Counters", func(ctx context.Context) (any, error) {
		stateMu.Lock()
		del := len(deleted)
		stateMu.Unlock()
		return plugin.StatData{Stats: []plugin.StatBlock{
			{Label: "Users", Value: 100000, Tone: plugin.ToneInfo},
			{Label: "Tables", Value: 60},
			{Label: "Deleted rows", Value: del, Tone: plugin.ToneBad, Sub: "since start", Tip: plugin.Tip("Rows deleted via the demo delete action this session", plugin.TipBottom)},
		}}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(10)) // manual button + auto every 10s

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
		band := q.Filters["band"] // the facet dropdown selection ("" = all)
		name := func(i int) string { return fmt.Sprintf("user-%05d", i) }
		score := func(i int) int { return i * 7 % 1000 }
		// filter (search + band facet, server-side) -> list of matching ids
		ids := make([]int, 0, totalRows)
		for i := range totalRows {
			if band != "" && scoreBand(score(i)) != band {
				continue
			}
			if f == "" || strings.Contains(name(i), f) || strings.Contains(strconv.Itoa(score(i)), f) {
				ids = append(ids, i)
			}
		}
		// sort (server-side) by the requested column
		if q.Sort.Column != "" {
			byScore := func(a, b int) bool { return score(a) < score(b) }
			less := map[string]func(a, b int) bool{
				"id":       func(a, b int) bool { return a < b },
				"name":     func(a, b int) bool { return name(a) < name(b) },
				"band":     byScore,
				"points":   byScore,
				"progress": byScore,
				"seen":     func(a, b int) bool { return a > b }, // larger id = older = seen earlier
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
			sc := score(i)
			tone := plugin.ToneOK
			if sc < 300 {
				tone = plugin.ToneBad
			} else if sc < 700 {
				tone = plugin.ToneWarn
			}
			rows = append(rows, []any{
				plugin.Code(fmt.Sprintf("#%05d", i)),
				plugin.DetailLink(name(i), "user", strconv.Itoa(i)), // -> the "user" detail page, param {id}
				plugin.Badge(scoreBand(sc), tone),
				plugin.Number(sc*137, ""),
				plugin.Progress(float64(sc) / 1000),
				plugin.Time(started.Add(-time.Duration(i) * time.Minute).Unix()),
			})
		}
		return map[string]any{
			"columns": []string{"id", "name", "band", "points", "progress", "seen"},
			"rows":    rows, "total": total,
		}, nil
	}, plugin.ServerSide(), plugin.PageSize(100), plugin.Facets(plugin.Facet{
		Key: "band", Label: "band",
		Options: []plugin.Option{{Label: "Bronze", Value: "bronze"}, {Label: "Silver", Value: "silver"}, {Label: "Gold", Value: "gold"}},
	}))

	// text: a monospace scrollable block (logs, config, raw output).
	p.TextView("config", "Config", func(ctx context.Context) (any, error) {
		host, _ := os.Hostname()
		return map[string]any{"text": fmt.Sprintf(
			"# kitchen-sink config\nhost = %q\npid  = %d\ntheme = %q\nrows = %s\nuptime = %s\n",
			host, os.Getpid(), p.SettingValue("theme"), p.SettingValue("rows"),
			time.Since(started).Truncate(time.Second),
		)}, nil
	})

	// A rich Tree: collapsible schema groups, per-node icons + tone dots, and a
	// clickable node (To) that links to the "user" detail page — a tree that navigates.
	p.View("tree", "Schema", plugin.Tree, func(ctx context.Context) (any, error) {
		return plugin.TreeData{Nodes: []plugin.TreeNode{
			{Label: "app", Icon: "database", Children: []plugin.TreeNode{
				{Label: "users", Icon: "box", Tone: plugin.ToneOK, To: "user/1", Tip: plugin.Tip("Open user 1", plugin.TipTopEnd)},
				{Label: "orders", Icon: "box"},
				{Label: "events", Icon: "box", Tone: plugin.ToneWarn, Tip: plugin.Tip("Backfill lagging")},
			}},
			{Label: "analytics", Icon: "database", Collapsed: true, Children: []plugin.TreeNode{
				{Label: "daily", Icon: "box"},
				{Label: "monthly", Icon: "box"},
			}},
		}}, nil
	}, plugin.Static()) // schema is fixed for the session — fetch once, don't re-fetch on tab re-entry

	// userView reads the detail page's param {id} and shows that "user" — the
	// master-detail target the Big Table's name column links to.
	p.View("userView", "User", plugin.KV, func(ctx context.Context) (any, error) {
		var pr struct {
			ID string `json:"id"`
		}
		_ = plugin.Params(ctx, &pr)
		i, _ := strconv.Atoi(pr.ID)
		return map[string]any{
			"id": i, "name": fmt.Sprintf("user-%05d", i),
			"band": scoreBand(i * 7 % 1000), "points": (i * 7 % 1000) * 137,
		}, nil
	})

	// cards: a gallery view (Cards kind). Each card links to its user detail page.
	p.CardsView("leaders", "Leaderboard", func(ctx context.Context) (any, error) {
		items := make([]plugin.Card, 0, 8)
		for i := range 8 {
			sc := (i*211 + 40) % 1000
			tone := plugin.ToneWarn
			if sc >= 700 {
				tone = plugin.ToneOK
			} else if sc < 300 {
				tone = plugin.ToneBad
			}
			items = append(items, plugin.Card{
				Title: fmt.Sprintf("user-%05d", i), Subtitle: scoreBand(sc),
				Icon: "beaker", Tone: tone, To: "user/" + strconv.Itoa(i),
				Fields: []plugin.CardField{
					{Label: "points", Value: plugin.Number(sc*137, "")},
					{Label: "band", Value: plugin.Badge(scoreBand(sc), tone)},
					{Label: "fill", Value: plugin.Progress(float64(sc) / 1000)},
				},
			})
		}
		return plugin.CardsData{Items: items}, nil
	})

	// A COMPONENT view — the escape hatch. Composes a custom tile from safe primitives
	// hope has no dedicated kind for (heading + keyvals + sparkline + a link cell).
	// Static() caches it (fetched once, reused on tab re-entry). The Caps(ctx) check
	// degrades to a plain KV on an older hope that can't render components — the
	// capability-negotiation pattern.
	p.ComponentView("widget", "Fleet Widget", func(ctx context.Context) (any, error) {
		stateMu.Lock()
		del := len(deleted)
		stateMu.Unlock()
		if !plugin.Caps(ctx).Supports("component") {
			return plugin.KVData{"users": 100000, "tables": 60, "deleted rows": del}, nil // baseline fallback
		}
		return plugin.Box(
			plugin.Heading("Fleet", 3),
			plugin.CRow(
				plugin.KeyVal("users", plugin.Number(100000, "")),
				plugin.KeyVal("tables", plugin.Number(60, "")),
				plugin.KeyVal("deleted", plugin.Badge(strconv.Itoa(del), plugin.ToneBad)),
			).Gapped(18),
			plugin.Divider(),
			plugin.CText("rows/sec (last minute)").Toned(plugin.ToneInfo),
			plugin.Sparkline(4, 9, 6, 12, 8, 15, 11, 18),
			plugin.Divider(),
			plugin.CRow(
				plugin.CIcon("beaker"),
				plugin.CCell(plugin.Link("open dashboard", "dashboard")),
			),
		), nil
	}, plugin.Static())

	// A table that resolves EMPTY, to show an author-controlled empty state (icon +
	// title + text) instead of the generic "empty".
	p.TableView("alerts", "Alerts", func(ctx context.Context) (any, error) {
		return plugin.TableData{Columns: []string{"time", "severity", "message"}, Rows: [][]any{}}, nil
	}, plugin.EmptyView("No active alerts 🎉", plugin.EmptyIcon("check"), plugin.EmptyText("Everything is nominal.")))

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
	}, plugin.ActionIcon("beaker"), plugin.ActionTip("Greets the name you enter"))
	p.DangerAction("wipe", "Wipe (danger)", nil, func(ctx context.Context, in map[string]any) (any, error) {
		return map[string]any{"ok": true, "message": "pretend-wiped"}, nil
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Pretend-wipe everything (demo — does nothing real)", plugin.TipBottom))

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
			plugin.Leaf("alerts").Titled("Alerts"), // demoes the author empty state
			plugin.Leaf("log").Titled("Log"),
		),
		plugin.Section("Actions", plugin.Buttons("greet", "runCommand", "bulkTag", "fireAlert", "tagService", "wipe")),
		// dynamic commanding: the connection wizard + the per-selection "issue command"
		// action (typed sub-form, live validation, impact confirm, order flyout).
		plugin.Section("Commanding", plugin.Buttons("connect", "issueCommand")),
		// conditional row actions: Cancel shows only on queued orders.
		plugin.Section("Orders", plugin.Leaf("orders")),
		// (the blueprint / DAG editor has its own full-height "Pipeline" page in the rail —
		// keeping it off the container panel avoids two live copies fighting over the active DAG.)
		// the v0.5 collection/table/card/stream surfaces.
		plugin.Grid(
			plugin.Section("Wide table", plugin.Leaf("wide")),
			plugin.Section("Fleet cards", plugin.Leaf("fleet")),
		),
		plugin.Row(
			plugin.Section("Activity feed", plugin.Leaf("feed")),
			plugin.Section("Live card", plugin.Leaf("liveCard")),
		),
	))

	// --- a dashboard widget: keep it COMPACT. An INLINE component node renders a
	//     custom tile straight from the layout — no per-view round-trip — above the
	//     live counters leaf. ---
	p.DashboardWidget("Kitchen Sink", plugin.Section("",
		plugin.Component(plugin.Box(
			plugin.Heading("Kitchen Sink", 4),
			plugin.CRow(
				plugin.KeyVal("status", plugin.Badge("healthy", plugin.ToneOK)),
				plugin.KeyVal("build", plugin.Code("dev")),
			).Gapped(16),
		)),
		plugin.Leaf("counts"),
	))

	// --- a stack widget: renders on a STACK's page, matched against the stack's
	//     containers (the whole-stack analog of a container panel). Match{Always:true}
	//     shows it on every stack for the demo; a real plugin scopes it — e.g.
	//     &plugin.Match{Images: []string{"postgres*"}} to appear only on stacks that
	//     have a postgres container, or an empty match for the plugin's own stack. ---
	p.StackWidget("Kitchen Sink", &plugin.Match{Always: true}, plugin.Section("",
		plugin.Row(plugin.Leaf("overview"), plugin.Leaf("counter")),
	))

	// --- a single full page, with page-level header actions (a toolbar) ---
	p.Page("Dashboard", plugin.Section("",
		plugin.Row(plugin.Leaf("overview"), plugin.Leaf("counter"), plugin.Leaf("series")),
		// A custom component-view tile beside the empty-state Alerts table.
		plugin.Row(
			plugin.Section("Fleet Widget", plugin.Leaf("widget")),
			plugin.Section("Alerts", plugin.Leaf("alerts")),
		),
		// Traffic chart on the left, the counters column on the right.
		plugin.Row(
			plugin.Section("Traffic", plugin.Leaf("chart")),
			plugin.Section("Counters", plugin.Leaf("counts")),
		),
		plugin.Section("Leaderboard", plugin.Leaf("leaders")),
		plugin.Section("Config", plugin.Leaf("config")).Collapse(true), // collapsible, starts closed
		plugin.Section("Big Table", plugin.Leaf("big").Filled()),
		plugin.Section("Rows", plugin.Leaf("rows")).Collapse(false), // collapsible, starts open
	)).PageID("dashboard"). // stable id so breadcrumbs/links can target it
				Subtitle("100,000 users · 60 tables").
				HeaderActions("greet", "runCommand", "issueCommand", "connect", "bulkTag", "wipe")

	// --- a dedicated full page for the blueprint/DAG editor (a rail entry). The graph
	//     leaf is Filled() so the canvas takes the whole page height. ---
	p.Page("Pipeline", plugin.Section("",
		plugin.Leaf("pipeline").Filled(),
	)).PageID("pipeline").Subtitle("blueprint / DAG editor")

	// --- master-detail: a hidden "user" page the Big Table + cards link to. hope
	//     passes the clicked id as param {id}; userView renders it. ---
	p.DetailPage("user", "User", "id", plugin.Section("",
		plugin.Section("Profile", plugin.Leaf("userView")),
	)).Subtitle("id {id} · bronze tier").
		Breadcrumbs(
			plugin.Crumb{Label: "Dashboard", To: "dashboard"}, // links back to the Dashboard page
			plugin.Crumb{Label: "user-{id}"},                  // filled from the page param -> "user-42"
		)

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

	// --- reverse channel demo: subscribe to fleet events, publish alerts, use durable
	// storage, and act as an operator. Each capability is least-privilege: the operator
	// consents to these scopes when enabling the plugin (events:subscribe is auto-
	// declared by OnEvent). They no-op gracefully when hope's reverse channel isn't
	// reachable (a remote plugin). This is the end-to-end smoke test for the event bus. ---
	p.RequirePermission(plugin.ScopeEventsPublish, "raise alerts you can see in hope")
	p.RequirePermission(plugin.ScopeStorage, "remember how many events it has seen")
	p.RequirePermission(plugin.ScopeSpecLabel, "tag its own stack's services on request")

	// OnEvent: log every fleet event, count them in hope-persisted storage, and raise a
	// demo alert every 5th event (deduped by key so it doesn't spam).
	p.OnEvent(func(ctx context.Context, e plugin.Event) error {
		log.Printf("event: kind=%s host=%s project=%s", e.Kind, e.Host, e.Project)
		var count int
		_, _ = p.Storage().Get(ctx, "eventCount", &count)
		count++
		_ = p.Storage().Set(ctx, "eventCount", count)
		if count%5 == 0 {
			_ = p.Alert(ctx, "info", "kitchen-sink milestone", fmt.Sprintf("seen %d fleet events", count), "milestone")
		}
		return nil
	})

	// A button that publishes an alert on demand (proves publish end-to-end).
	p.Action("fireAlert", "Fire a demo alert", []plugin.Field{{Key: "sev", Label: "Severity", Placeholder: "warn"}}, func(ctx context.Context, in map[string]any) (any, error) {
		sev, _ := in["sev"].(string)
		if sev == "" {
			sev = "warn"
		}
		if err := p.Alert(ctx, sev, "manual alert from kitchen-sink", "you pressed the button", ""); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})

	// Operator action: add a label to one of THIS plugin's own stack services (persists
	// across redeploys). The Prometheus-labels pattern.
	p.Action("tagService", "Tag a service", []plugin.Field{
		{Key: "service", Label: "Service"},
		{Key: "key", Label: "Label key", Placeholder: "prometheus.io/scrape"},
		{Key: "value", Label: "Label value", Placeholder: "true"},
	}, func(ctx context.Context, in map[string]any) (any, error) {
		svc, _ := in["service"].(string)
		k, _ := in["key"].(string)
		v, _ := in["value"].(string)
		if err := p.Hope().AddServiceLabel(ctx, svc, k, v); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})

	// --- dynamic forms demo: the "command" select is RPC-populated (Options) AND
	// resolves to a live preview surface as you pick it (Resolve -> selector->surface).
	// hope calls commandPreview with the current form values on every change and renders
	// the returned component inline below the field. ---
	commands := map[string]struct{ what, tone string }{
		"restart": {"Restart every worker. Brief downtime.", plugin.ToneWarn},
		"migrate": {"Apply pending migrations, then verify.", plugin.ToneInfo},
		"backup":  {"Snapshot the database to object storage.", plugin.ToneOK},
		"vacuum":  {"Reclaim dead tuples. Heavy I/O while it runs.", plugin.ToneWarn},
	}
	p.Options("commandList", func(ctx context.Context) ([]plugin.Option, error) {
		return []plugin.Option{
			{Label: "Restart workers", Value: "restart"},
			{Label: "Run migrations", Value: "migrate"},
			{Label: "Backup database", Value: "backup"},
			{Label: "Vacuum", Value: "vacuum"},
		}, nil
	})
	p.Resolve("commandPreview", func(ctx context.Context) (any, error) {
		var vals map[string]any
		_ = plugin.Params(ctx, &vals)
		cmd, _ := vals["command"].(string)
		c, ok := commands[cmd]
		if !ok {
			return plugin.Box(plugin.KeyVal("preview", "pick a command above")), nil
		}
		return plugin.Box(
			plugin.Heading(cmd, 4),
			plugin.KeyVal("impact", plugin.Badge(c.tone, c.tone)),
			plugin.KeyVal("what it does", c.what),
		), nil
	})
	p.Action("runCommand", "Run a command", []plugin.Field{
		{Key: "command", Label: "Command", Type: plugin.FieldSelect, OptionsMethod: "commandList", ResolveMethod: "commandPreview"},
	}, func(ctx context.Context, in map[string]any) (any, error) {
		cmd, _ := in["command"].(string)
		return map[string]any{"message": "ran command: " + cmd}, nil
	})

	// Repeatable group (forms-builder): one action collects N label rows at once, each
	// a sub-form of {service, key, value}. The action receives an array of objects.
	p.Action("bulkTag", "Tag services", []plugin.Field{
		{Key: "labels", Label: "Labels", Type: plugin.FieldGroup, AddLabel: "label", Fields: []plugin.Field{
			{Key: "service", Label: "Service"},
			{Key: "key", Label: "Label key", Placeholder: "prometheus.io/scrape"},
			{Key: "value", Label: "Value", Placeholder: "true"},
		}},
	}, func(ctx context.Context, in map[string]any) (any, error) {
		rows, _ := in["labels"].([]any)
		return map[string]any{"message": fmt.Sprintf("would set %d label(s)", len(rows))}, nil
	})

	// ── v0.5 surfaces: wizard, card, paged collection, hscroll table, component stream ──

	// Cascading options for the wizard's Database step: the choices depend on the host the
	// operator typed in the earlier step (read via Params).
	p.Options("wizDatabases", func(ctx context.Context) ([]plugin.Option, error) {
		var v struct {
			Host string `json:"host"`
		}
		_ = plugin.Params(ctx, &v)
		if strings.TrimSpace(v.Host) == "" {
			return nil, nil
		}
		return []plugin.Option{
			{Label: v.Host + " · app", Value: "app"},
			{Label: v.Host + " · analytics", Value: "analytics"},
			{Label: v.Host + " · sessions", Value: "sessions"},
		}, nil
	})

	// WIZARD: a stepped form. Step 2's database options cascade from step 1's host; step 3's
	// cert field only appears when "Require SSL" is on (a conditional field, DependsValue).
	p.Action("connect", "Connection wizard", nil, func(ctx context.Context, in map[string]any) (any, error) {
		return map[string]any{"message": fmt.Sprintf("connect %v:%v/%v (ssl=%v)", in["host"], in["port"], in["db"], in["ssl"])}, nil
	}, plugin.ActionIcon("rocket"), plugin.ActionSteps(
		plugin.StepHint("Server", "where to connect",
			plugin.Field{Key: "host", Label: "Host", Placeholder: "db.internal"},
			plugin.Field{Key: "port", Label: "Port", Value: "5432"},
		),
		plugin.StepHint("Database", "options cascade from the host above",
			plugin.Field{Key: "db", Label: "Database", Type: plugin.FieldSelect, OptionsMethod: "wizDatabases", DependsOn: "host"},
		),
		plugin.Step("Security",
			plugin.Field{Key: "ssl", Label: "Require SSL", Type: plugin.FieldToggle},
			plugin.Field{Key: "cert", Label: "Client cert", Placeholder: "/etc/ssl/client.pem", Optional: true, DependsOn: "ssl", DependsValue: "true"},
		),
	))

	// HORIZONTAL-SCROLL table: 12 columns keep their natural width and scroll sideways
	// instead of cramming. Also demos a wide row flyout.
	p.View("wide", "Wide table", plugin.Table, func(ctx context.Context) (any, error) {
		cols := []string{"id", "service", "region", "tier", "cpu", "mem", "disk", "net_in", "net_out", "uptime", "restarts", "status"}
		var rows [][]any
		for i := 0; i < 18; i++ {
			rows = append(rows, []any{
				fmt.Sprintf("svc-%02d", i), fmt.Sprintf("worker-%d", i), "us-east-1", "standard",
				fmt.Sprintf("%d%%", 10+i%80), fmt.Sprintf("%dMi", 128+i*32), fmt.Sprintf("%dGi", 2+i%9),
				fmt.Sprintf("%dKB/s", i*7), fmt.Sprintf("%dKB/s", i*4), fmt.Sprintf("%dh", i*3),
				i % 4, plugin.Badge("running", "ok"),
			})
		}
		return map[string]any{"columns": cols, "rows": rows}, nil
	}, plugin.HScroll(), plugin.RowFlyout("rowDetail"), plugin.RowFlyoutWidth("large"))

	// CARD primitive: a component view rendering a grid of cards.
	p.View("fleet", "Fleet cards", plugin.CompView, func(ctx context.Context) (any, error) {
		card := func(name, img, tone, region string) *plugin.Comp {
			return plugin.CCard(name,
				plugin.KeyVal("region", region).Help("the AWS region this replica runs in"),
				plugin.KeyVal("status", plugin.Badge("healthy", tone)).Help("rolls up liveness + last health check"),
			).Ico("box").Sub(img).Toned(tone).Help("click through for the replica's full lifecycle")
		}
		return plugin.CGrid(
			card("web-01", "nginx:1.27", "ok", "us-east-1"),
			card("api-02", "hope/api:1.3", "warn", "us-west-2"),
			card("db-03", "postgres:16", "ok", "eu-central-1"),
		), nil
	})

	// PAGED collection: hope pages, the plugin renders each item. Mixed types — every 4th
	// item is an inline Comp (A); the rest use the "event" ItemTemplate bound to their Data (B).
	p.PagedView("feed", "Activity feed", func(ctx context.Context) (any, error) {
		var pr struct {
			Offset int `json:"offset"`
			Limit  int `json:"limit"`
		}
		_ = plugin.Params(ctx, &pr)
		if pr.Limit <= 0 {
			pr.Limit = 15
		}
		const total = 84
		var items []plugin.Item
		for i := pr.Offset; i < pr.Offset+pr.Limit && i < total; i++ {
			if i%4 == 0 {
				items = append(items, plugin.Item{Comp: plugin.CCard(fmt.Sprintf("milestone #%d", i), plugin.CText("a one-off custom item (inline Comp)")).Ico("star").Toned("info")})
			} else {
				items = append(items, plugin.Item{Type: "event", Data: map[string]any{"n": i, "actor": fmt.Sprintf("user-%d", i%9), "action": []string{"deployed", "scaled", "restarted"}[i%3]}})
			}
		}
		return &plugin.Page{Items: items, Total: total}, nil
	}, plugin.PageSize(15), plugin.PageLayout("list"),
		plugin.ItemTemplate("event", plugin.CCard("event #{n}",
			plugin.KeyVal("actor", "{actor}"),
			plugin.KeyVal("action", "{action}"),
		).Ico("activity")),
	)

	// COMPONENT stream: each live frame is a full component tree hope renders (not a fixed kind).
	p.Stream("liveCard", "Live card", plugin.StreamComponent, func(ctx context.Context, emit plugin.EmitFunc) error {
		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
			emit(plugin.CCard("live tick",
				plugin.KeyVal("count", i),
				plugin.KeyVal("at", time.Now().Format("15:04:05")),
			).Ico("activity").Toned("ok"))
		}
	})

	// ── dynamic commanding (needed.md #1,#3,#4,#5,#6,#7,#8): one "issue command" action
	// that per-selection renders typed params, validates live, gates on impact, prefills,
	// keeps its target list live, and jumps to the new order on success. Mirrors the
	// mission-control use case the plugin API was extended for. ──

	// #8 live options: the target list re-fetches every few seconds (RefreshEvery on the
	// field) so each satellite's in-contact status stays current while the modal is open.
	sats := []string{"AURORA-1", "AURORA-2", "HELIOS-3", "VESPER-4"}
	p.Options("targetList", func(ctx context.Context) ([]plugin.Option, error) {
		bucket := time.Now().Second() / 5 // flips the live label every 5s
		out := make([]plugin.Option, 0, len(sats))
		for i, s := range sats {
			status := "queues next pass"
			if (bucket+i)%2 == 0 {
				status = "in contact"
			}
			out = append(out, plugin.Option{Label: fmt.Sprintf("%s · %s", s, status), Value: s})
		}
		return out, nil
	})

	// #1 FieldsMethod: picking a command returns ITS OWN typed parameters as a sub-form,
	// rendered inline under the command select — not a free-form kv box. Read the chosen
	// command via Params. Demonstrates #5 typed fields (number Min/Max/Step/Unit, multiselect).
	p.Fields("commandParams", func(ctx context.Context) ([]plugin.Field, error) {
		var v struct {
			Command string `json:"command"`
		}
		_ = plugin.Params(ctx, &v)
		switch v.Command {
		case "capture-image":
			return []plugin.Field{
				{Key: "mode", Label: "Mode", Type: plugin.FieldSelect, Value: "pan", Options: []plugin.Option{
					{Label: "Panchromatic", Value: "pan"}, {Label: "Multispectral", Value: "multi"}, {Label: "Stereo", Value: "stereo"}}},
				{Key: "exposure", Label: "Exposure", Type: plugin.FieldNumber, Min: 1, Max: 1000, Step: 1, Unit: "ms", Value: "50"},
			}, nil
		case "downlink":
			return []plugin.Field{
				{Key: "bandwidth", Label: "Bandwidth", Type: plugin.FieldNumber, Min: 1, Max: 500, Step: 5, Unit: "Mbps", Value: "50"},
				// chips: the inline toggle-pill multi-select (vs the dropdown multiselect above).
				{Key: "bands", Label: "Bands", Type: plugin.FieldChips, Options: []plugin.Option{
					{Label: "S-band", Value: "s"}, {Label: "X-band", Value: "x"}, {Label: "Ka-band", Value: "ka"}}},
			}, nil
		}
		return nil, nil // enter-safe-mode takes no params; the confirm gate does the work
	})

	// #4 ValidateMethod: live per-field checks; hope renders the errors inline and keeps
	// Run disabled until the form is valid. Values arrive as the raw form strings (a
	// multiselect is a JSON-array string here — validate before the action parses it).
	p.Validate("commandValidate", func(ctx context.Context) ([]plugin.FieldError, error) {
		var v struct {
			Targets  string `json:"targets"`
			Command  string `json:"command"`
			Priority string `json:"priority"`
		}
		_ = plugin.Params(ctx, &v)
		var errs []plugin.FieldError
		if v.Targets == "" || v.Targets == "[]" {
			errs = append(errs, plugin.FieldError{Key: "targets", Error: "select at least one satellite"})
		}
		if v.Command == "" {
			errs = append(errs, plugin.FieldError{Key: "command", Error: "pick a command"})
		}
		if n, err := strconv.Atoi(strings.TrimSpace(v.Priority)); v.Priority != "" && (err != nil || n < 1 || n > 9) {
			errs = append(errs, plugin.FieldError{Key: "priority", Error: "priority must be 1-9"})
		}
		return errs, nil
	})

	// #6 ConfirmMethod: an impact go/no-go computed from the entered values, shown after
	// the form. Here targets is already parsed to an array (the confirm runs post-merge).
	p.Confirm("commandConfirm", func(ctx context.Context) (plugin.ConfirmResult, error) {
		var v struct {
			Command string   `json:"command"`
			Targets []string `json:"targets"`
		}
		_ = plugin.Params(ctx, &v)
		if v.Command == "enter-safe-mode" {
			return plugin.ConfirmResult{
				Title:        "Enter safe mode",
				Message:      fmt.Sprintf("Safe-mode %d satellite(s)? They stop tasking until an operator recovers them.", len(v.Targets)),
				Danger:       true,
				ConfirmLabel: "Enter safe mode",
			}, nil
		}
		return plugin.ConfirmResult{Message: fmt.Sprintf("Issue %q to %d satellite(s)?", v.Command, len(v.Targets))}, nil
	})

	// The command itself: #3 Prefill seeds priority; #5 number + multiselect; #1 the command
	// select drives the dynamic sub-form; #4 validate + #6 confirm gate the submit; #7 the
	// result opens the new order's lifecycle straight in the right-side drawer.
	var orderSeq int
	p.Action("issueCommand", "Issue command", []plugin.Field{
		{Key: "targets", Label: "Satellites", Type: plugin.FieldMultiselect, OptionsMethod: "targetList", RefreshEvery: 5,
			Hint: "batch-command N at once; in-contact status refreshes live",
			Help: "Only satellites currently in contact can execute immediately; the rest queue until their next pass over a ground station."},
		{Key: "command", Label: "Command", Type: plugin.FieldSelect, FieldsMethod: "commandParams", Options: []plugin.Option{
			{Label: "Capture image", Value: "capture-image"},
			{Label: "Downlink", Value: "downlink"},
			{Label: "Enter safe mode", Value: "enter-safe-mode"}}},
		{Key: "priority", Label: "Priority", Type: plugin.FieldNumber, Min: 1, Max: 9, Step: 1, Unit: "prio",
			Help: "1 is highest. Priority decides ordering when two commands contend for the same pass window."},
		// combobox with AllowCustom: pick a known ground station OR type a new one.
		{Key: "station", Label: "Ground station", Type: plugin.FieldCombobox, AllowCustom: true, Placeholder: "pick or type a station", Options: []plugin.Option{
			{Label: "Svalbard", Value: "svalbard"}, {Label: "Punta Arenas", Value: "punta"}, {Label: "Fairbanks", Value: "fairbanks"}}},
	}, func(ctx context.Context, in map[string]any) (any, error) {
		cmd, _ := in["command"].(string)
		targets, _ := in["targets"].([]any) // parsed from the multiselect
		orderSeq++
		id := fmt.Sprintf("ord-%04d", orderSeq)
		return map[string]any{
			"message":     fmt.Sprintf("issued %s to %d satellite(s) — order %s", cmd, len(targets), id),
			"flyoutTitle": "Order " + id,
			"flyout": plugin.Box(
				plugin.Heading("Order "+id, 3),
				plugin.KeyVal("command", cmd),
				plugin.KeyVal("satellites", fmt.Sprintf("%d", len(targets))),
				plugin.KeyVal("priority", fmt.Sprintf("%v", in["priority"])),
				plugin.KeyVal("station", fmt.Sprintf("%v", in["station"])),
				plugin.Heading("Lifecycle", 4),
				plugin.Timeline(
					plugin.TStep("queued").Done().At(plugin.Time(time.Now().Unix())),
					plugin.TStep("uplinked").Done().At(plugin.Time(time.Now().Unix())),
					// custom dot icon from the plugin's OWN loaded SVG (Icons key "beaker"),
					// tone-colored — not limited to hope's built-in icon set.
					plugin.TStep("tasked").Ico("beaker").Toned(plugin.ToneInfo).Sub("executing over target"),
					// a custom state: a built-in icon marker + tone, not one of the three presets
					plugin.TStep("link degraded").Ico("alert").Toned(plugin.ToneWarn).Sub("retrying downlink"),
					plugin.TStep("completed").Sub("product downlinked").Pending(),
				),
			),
		}, nil
	}, plugin.ActionIcon("rocket"),
		plugin.ActionPrefill(map[string]string{"priority": "5"}),
		plugin.ActionValidate("commandValidate"),
		plugin.ActionConfirm("commandConfirm"),
	)

	// CONDITIONAL ROW ACTIONS (needed.md): the Cancel button shows ONLY on queued orders —
	// gated per row by the "state" cell — in both the table and the flyout footer. Committed
	// orders show no Cancel, so the operator never sees an un-actionable button.
	p.View("orders", "Orders", plugin.Table, func(ctx context.Context) (any, error) {
		return map[string]any{
			"columns": []string{"id", "command", "state"},
			"rows": [][]any{
				{"ord-0001", "capture-image", plugin.Badge("queued", plugin.ToneInfo)},
				{"ord-0002", "downlink", plugin.Badge("uplinked", plugin.ToneWarn)},
				{"ord-0003", "enter-safe-mode", plugin.Badge("completed", plugin.ToneOK)},
			},
		}, nil
	}, plugin.RowActions(
		plugin.RowAction{Method: "cancelOrder", Label: "Cancel", Danger: true, Icon: "x",
			ShowWhenKey: "state", ShowWhenValue: "queued",
			Tip: plugin.Tip("Cancel this order — only possible while still queued", plugin.TipTopEnd)},
	),
		// LIVE flyout: click a row -> the drawer's lifecycle Timeline advances every 2s
		// WITHOUT reopening (RowFlyoutRefresh). Feature-gated: hope advertises "flyout-refresh".
		plugin.RowFlyout("orderDetail"), plugin.RowFlyoutWidth("560px"), plugin.RowFlyoutRefresh(2))

	// orderDetail renders the clicked order's live lifecycle. hope re-invokes it every 2s
	// (RowFlyoutRefresh) with the same {row}; the current step is derived from wall-clock so
	// an OPEN drawer visibly progresses queued -> uplinked -> tasked -> completed.
	p.View("orderDetail", "Order detail", plugin.CompView, func(ctx context.Context) (any, error) {
		var pr struct {
			Row map[string]any `json:"row"`
		}
		_ = plugin.Params(ctx, &pr)
		id, _ := pr.Row["id"].(string)
		cmd, _ := pr.Row["command"].(string)
		steps := []struct{ label, sub string }{
			{"queued", ""}, {"uplinked", ""}, {"tasked", "executing over target"}, {"completed", "product downlinked"},
		}
		cur := int((time.Now().Unix() / 2) % int64(len(steps))) // advances one step every 2s
		tl := make([]*plugin.Comp, 0, len(steps))
		for i, st := range steps {
			s := plugin.TStep(st.label)
			if st.sub != "" {
				s = s.Sub(st.sub)
			}
			switch {
			case i < cur:
				s = s.Done().At(plugin.Time(time.Now().Unix()))
			case i == cur:
				s = s.Current()
			default:
				s = s.Pending()
			}
			tl = append(tl, s)
		}
		return plugin.Box(
			plugin.Heading("Order "+orDefault(id, "?"), 3),
			plugin.KeyVal("command", cmd),
			plugin.Heading("Lifecycle", 4),
			plugin.Timeline(tl...),
		), nil
	})
	p.DangerAction("cancelOrder", "Cancel order", nil, func(ctx context.Context, in map[string]any) (any, error) {
		row, _ := in["row"].(map[string]any)
		// defense-in-depth: the handler still guards, even though the button is gated.
		if s, _ := row["state"].(map[string]any); s != nil && s["value"] != "queued" {
			return map[string]any{"ok": false, "message": "order already committed"}, nil
		}
		return map[string]any{"message": fmt.Sprintf("cancelled %v", row["id"])}, nil
	})

	// ── GRAPH (blueprint) surface: hope ships no node types — this plugin defines the nodes,
	// owns the in-memory DAGs, and hope is the editor. Drag nodes, drag out->in ports to
	// connect, click an edge to disconnect, drag a palette type onto the canvas to add, select
	// a DAG in the sidebar, and Run to watch node states advance live. ──
	p.GraphView("pipeline", "Pipeline", func(ctx context.Context) (any, error) {
		var pr struct {
			Graph string `json:"graph"`
		}
		_ = plugin.Params(ctx, &pr)
		gmu.Lock()
		defer gmu.Unlock()
		gSeed()
		id := pr.Graph
		if id == "" || dags[id] == nil {
			id = "ingest"
		}
		d := dags[id]
		nodes := make([]*plugin.GraphNode, 0, len(d.order))
		for _, k := range d.order {
			nodes = append(nodes, d.nodes[k])
		}
		return &plugin.GraphData{Nodes: nodes, Edges: d.edges, Directed: true, Active: id}, nil
	},
		plugin.GraphMove("gMove"), plugin.GraphConnect("gConn"), plugin.GraphDisconnect("gDisc"),
		plugin.GraphDelete("gDel"), plugin.GraphAdd("gAdd"), plugin.GraphNodeFlyout("gNode"),
		plugin.GraphConfig("gConfig"), plugin.GraphMenu("gMenu"),
		plugin.GraphSidebar("gList"), plugin.GraphSidebarActions("gNew"), plugin.GraphToolbar("gBar"), plugin.GraphPalette("gPalette"),
		plugin.GraphRun("gRun"), plugin.GraphDirected(), plugin.GraphSnap(10))

	// mutations — each gets {row:{..., graph:<activeId>}}; hope re-fetches the canvas on success.
	p.Action("gMove", "move node", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		if n := gPick(gRowStr(in, "graph")).nodes[gRowStr(in, "id")]; n != nil {
			n.X, n.Y = gRowF(in, "x"), gRowF(in, "y")
		}
		return map[string]any{"refetch": true}, nil
	})
	p.Action("gConn", "connect", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		d := gPick(gRowStr(in, "graph"))
		d.edges = append(d.edges, plugin.GEdge(gRowStr(in, "from"), gRowStr(in, "to")))
		return map[string]any{"refetch": true}, nil
	})
	p.Action("gDisc", "disconnect", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		d := gPick(gRowStr(in, "graph"))
		from, to := gRowStr(in, "from"), gRowStr(in, "to")
		kept := d.edges[:0:0]
		for _, e := range d.edges {
			if e.From != from || e.To != to {
				kept = append(kept, e)
			}
		}
		d.edges = kept
		return map[string]any{"refetch": true}, nil
	})
	p.DangerAction("gDel", "delete node", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		d := gPick(gRowStr(in, "graph"))
		id := gRowStr(in, "id")
		delete(d.nodes, id)
		order := d.order[:0:0]
		for _, k := range d.order {
			if k != id {
				order = append(order, k)
			}
		}
		d.order = order
		edges := d.edges[:0:0]
		for _, e := range d.edges {
			if !strings.HasPrefix(e.From, id+":") && !strings.HasPrefix(e.To, id+":") {
				edges = append(edges, e)
			}
		}
		d.edges = edges
		return map[string]any{"refetch": true}, nil
	})
	p.Action("gAdd", "add node", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		d := gPick(gRowStr(in, "graph"))
		typ := gRowStr(in, "type")
		if typ == "" {
			typ = "transform"
		}
		gseq++
		id := fmt.Sprintf("%s-%d", typ, gseq)
		title := strings.ToUpper(typ[:1]) + typ[1:]
		n := gMkNode(id, typ, title, gRowF(in, "x"), gRowF(in, "y"))
		d.nodes[id] = n
		d.order = append(d.order, id)
		return map[string]any{"refetch": true}, nil
	})
	p.View("gNode", "node detail", plugin.CompView, func(ctx context.Context) (any, error) {
		var pr struct {
			Row map[string]any `json:"row"`
		}
		_ = plugin.Params(ctx, &pr)
		id, _ := pr.Row["id"].(string)
		gmu.Lock()
		defer gmu.Unlock()
		n := gPick("").nodes[id]
		if n == nil {
			return plugin.Box(plugin.CText("gone")), nil
		}
		return plugin.Box(
			plugin.Heading(n.Title, 3),
			plugin.KeyVal("id", n.ID),
			plugin.KeyVal("type", n.Type),
			plugin.KeyVal("position", fmt.Sprintf("%.0f, %.0f", n.X, n.Y)),
			plugin.Heading("Ports", 4),
			plugin.KeyVal("in", fmt.Sprintf("%d", len(n.In))),
			plugin.KeyVal("out", fmt.Sprintf("%d", len(n.Out))),
		), nil
	})
	// node config: the "mode" dropdown is populated from this Options provider (a list).
	p.Options("xfModes", func(ctx context.Context) ([]plugin.Option, error) {
		return []plugin.Option{
			{Label: "Passthrough", Value: "passthrough"}, {Label: "Dedupe", Value: "dedupe"},
			{Label: "Aggregate", Value: "aggregate"}, {Label: "Enrich", Value: "enrich"},
		}, nil
	})
	// gConfig persists a node's config form (click a transform/filter node) -> its body updates.
	p.Action("gConfig", "configure node", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		n := gPick(gRowStr(in, "graph")).nodes[gRowStr(in, "id")]
		if n == nil {
			return map[string]any{"ok": false, "message": "node gone"}, nil
		}
		n.Data = map[string]any{"mode": gRowStr(in, "mode"), "parallel": gRowStr(in, "parallel")}
		gApplyMeta(n) // params show cleanly on the node face
		return map[string]any{"message": "node configured"}, nil
	})
	// gMenu: extra right-click items (hope prepends built-in Configure/Delete/Disconnect).
	p.View("gMenu", "menu", plugin.CompView, func(ctx context.Context) (any, error) {
		var pr struct {
			Row map[string]any `json:"row"`
		}
		_ = plugin.Params(ctx, &pr)
		if k, _ := pr.Row["kind"].(string); k == "node" {
			return []plugin.GraphMenuItem{{Label: "Duplicate", Icon: "plus", Method: "gDup"}}, nil
		}
		return []plugin.GraphMenuItem{}, nil
	})
	p.Action("gDup", "duplicate node", nil, func(ctx context.Context, in map[string]any) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		d := gPick(gRowStr(in, "graph"))
		src := d.nodes[gRowStr(in, "id")]
		if src == nil {
			return map[string]any{"ok": false}, nil
		}
		gseq++
		id := fmt.Sprintf("%s-%d", src.Type, gseq)
		cp := *src
		cp.ID, cp.X, cp.Y = id, src.X+40, src.Y+40
		d.nodes[id] = &cp
		d.order = append(d.order, id)
		return map[string]any{"message": "duplicated " + src.ID}, nil
	})

	// sidebar: the DAG browser — a folder TREE (the plugin controls this fully). Tree leaves
	// with To:"graph:<id>" select a DAG in place; the "New pipeline" button is a sidebar action.
	p.View("gList", "pipelines", plugin.CompView, func(ctx context.Context) (any, error) {
		gmu.Lock()
		defer gmu.Unlock()
		gSeed()
		names := make([]string, 0, len(dags))
		for k := range dags {
			names = append(names, k)
		}
		sort.Strings(names)
		leaves := make([]plugin.TreeNode, 0, len(names))
		for _, k := range names {
			leaves = append(leaves, plugin.TreeNode{
				Label: dags[k].name, Icon: "beaker", To: "graph:" + k,
				Args: map[string]any{"id": k},
				Actions: []plugin.RowAction{
					{Method: "gRename", Label: "Rename", Icon: "beaker", Tip: plugin.Tip("rename", plugin.TipTopEnd),
						Fields: []plugin.Field{{Key: "name", Label: "New name", Value: dags[k].name}}},
					{Method: "gDelDag", Label: "Delete", Icon: "trash", Danger: true, Tip: plugin.Tip("delete pipeline", plugin.TipTopEnd)},
				},
			})
		}
		return plugin.CTree(plugin.TreeNode{Label: "pipelines", Icon: "box", Children: leaves}), nil
	})
	p.Action("gRename", "Rename pipeline", []plugin.Field{{Key: "name", Label: "New name"}}, func(ctx context.Context, in map[string]any) (any, error) {
		id := gRowStr(in, "id")
		name, _ := in["name"].(string)
		name = strings.TrimSpace(name)
		gmu.Lock()
		defer gmu.Unlock()
		d := dags[id]
		if d == nil || name == "" {
			return map[string]any{"ok": false, "message": "bad rename"}, nil
		}
		d.name = name
		return map[string]any{"message": "renamed to " + name}, nil
	})
	p.DangerAction("gDelDag", "Delete pipeline", nil, func(ctx context.Context, in map[string]any) (any, error) {
		id := gRowStr(in, "id")
		gmu.Lock()
		defer gmu.Unlock()
		if id == "ingest" {
			return map[string]any{"ok": false, "message": "can't delete the default pipeline"}, nil
		}
		delete(dags, id)
		return map[string]any{"message": "deleted " + id}, nil
	})
	p.Action("gNew", "New pipeline", []plugin.Field{{Key: "name", Label: "Name", Placeholder: "my-pipeline"}}, func(ctx context.Context, in map[string]any) (any, error) {
		name, _ := in["name"].(string)
		name = strings.TrimSpace(name)
		if name == "" {
			return map[string]any{"ok": false, "message": "name required"}, nil
		}
		gmu.Lock()
		defer gmu.Unlock()
		gSeed()
		if dags[name] != nil {
			return map[string]any{"ok": false, "message": "already exists"}, nil
		}
		d := &dag{name: name, nodes: map[string]*plugin.GraphNode{}}
		d.nodes["src"] = gMkNode("src", "source", "Source", 60, 80)
		d.order = []string{"src"}
		dags[name] = d
		return map[string]any{"message": "created " + name}, nil
	})
	p.View("gBar", "toolbar", plugin.CompView, func(ctx context.Context) (any, error) {
		var pr struct {
			Graph string `json:"graph"`
		}
		_ = plugin.Params(ctx, &pr)
		gmu.Lock()
		defer gmu.Unlock()
		gSeed()
		name := "—"
		if d := dags[pr.Graph]; d != nil {
			name = d.name
		}
		return plugin.CRow(
			plugin.Heading("Pipeline", 4),
			plugin.KeyVal("editing", plugin.Badge(name, plugin.ToneInfo)),
			plugin.KeyVal("hint", "drag ports · Run to simulate"),
		).Gapped(16), nil
	})
	// palette: the node-TYPE catalog to drag onto the canvas (hope reads the returned array).
	p.View("gPalette", "palette", plugin.CompView, func(ctx context.Context) (any, error) {
		return []plugin.NodeType{
			{Type: "source", Label: "Source", Icon: "box", Tone: plugin.ToneOK, Desc: "an input feed"},
			{Type: "transform", Label: "Transform", Icon: "beaker", Tone: plugin.ToneInfo, Desc: "map / normalize"},
			{Type: "filter", Label: "Filter", Icon: "search", Tone: plugin.ToneWarn, Desc: "drop rows"},
			{Type: "sink", Label: "Sink", Icon: "check", Tone: plugin.ToneOK, Desc: "an output"},
		}, nil
	})
	// run: hope streams the run with {graph:<id>} (the active DAG), so the server runs the
	// right pipeline with no shared global — walk it, advancing each node idle -> running ->
	// done ~1s apart and emitting a GraphData frame so the canvas lights up.
	p.Stream("gRun", "Run", plugin.StreamComponent, func(ctx context.Context, emit plugin.EmitFunc) error {
		var pr struct {
			Graph string `json:"graph"`
		}
		_ = plugin.Params(ctx, &pr)
		gmu.Lock()
		order := append([]string{}, gPick(pr.Graph).order...)
		gmu.Unlock()
		states := map[string]string{}
		frame := func() *plugin.GraphData {
			gmu.Lock()
			defer gmu.Unlock()
			d := gPick(pr.Graph)
			nodes := make([]*plugin.GraphNode, 0, len(d.order))
			for _, k := range d.order {
				c := *d.nodes[k]
				c.State = states[k]
				nodes = append(nodes, &c)
			}
			return &plugin.GraphData{Nodes: nodes, Edges: d.edges, Directed: true, Active: pr.Graph}
		}
		for _, k := range order {
			select {
			case <-ctx.Done():
				return nil
			default:
			}
			states[k] = "running"
			emit(frame())
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
			states[k] = "done"
			emit(frame())
		}
		emit(frame())
		return nil
	})

	// Advisory self-status: hope owns liveness; kitchen-sink reports its own health —
	// the running fleet-event tally it keeps in durable storage. Demonstrates OnStatus.
	p.OnStatus(func(ctx context.Context) plugin.StatusReport {
		var count int
		_, _ = p.Storage().Get(ctx, "eventCount", &count)
		if count == 0 {
			return plugin.StatusReport{Status: "idle", Level: plugin.StatusInfo, Detail: "no fleet events seen yet"}
		}
		return plugin.StatusReport{Status: "serving", Level: plugin.StatusOK, Detail: fmt.Sprintf("seen %d fleet events", count)}
	})

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("kitchen-sink plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
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
	for part := range strings.SplitSeq(list, ",") {
		if c := strings.TrimSpace(part); c != "" {
			out = append(out, c)
		}
	}
	return out
}

func scoreBand(sc int) string {
	switch {
	case sc < 300:
		return "bronze"
	case sc < 700:
		return "silver"
	default:
		return "gold"
	}
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

var started = time.Now()
