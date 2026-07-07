// hope-redis is a first-party reference plugin: point it at a Redis (or Valkey /
// KeyDB) server (REDIS_URL) and it exposes a control panel inside hope — stat tiles,
// a keyspace tree you drill into, per-key value viewers, a command console, a live
// slowlog + client monitor you can kill connections from, and maintenance ops.
//
// The plugin holds the connection (your secret, in your container); hope only speaks
// the plugin protocol, proxies + audits calls, and never touches Redis directly.
//
//	docker run -e REDIS_URL=redis://:pass@host:6379/0 \
//	  -e HOPE_PLUGIN_TOKEN=secret \
//	  -l hope.plugin=true -l hope.plugin.port=8080 <image>
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("hope-redis", "1.0.0").
		Description("Browse, query, and operate a Redis / Valkey server").
		Icon("database")

	// How many keys the keyspace tree SCANs (a big instance has millions — cap it).
	p.Setting(plugin.Setting{Key: "scan_limit", Label: "Keyspace scan limit", Kind: plugin.SettingNumber, Default: "500", Hint: "max keys the keyspace tree loads"})

	registerOverview(p)
	registerKeyspace(p)
	registerConsole(p)
	registerMonitor(p)
	registerMaintenance(p)
	registerLayout(p)

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("hope-redis plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
}

// --- Overview -------------------------------------------------------------------

func registerOverview(p *plugin.Plugin) {
	// Big-number tiles from INFO: version/role, memory, clients, ops/sec, hit ratio.
	p.StatView("overview", "Overview", func(ctx context.Context) (any, error) {
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		info, err := infoMap(ctx, c)
		if err != nil {
			return nil, err
		}
		hits, misses := toF(info["keyspace_hits"]), toF(info["keyspace_misses"])
		hitTone, hitVal := plugin.ToneInfo, "—"
		if hits+misses > 0 {
			r := hits / (hits + misses)
			hitVal = strconv.FormatFloat(r*100, 'f', 1, 64) + "%"
			switch {
			case r >= 0.95:
				hitTone = plugin.ToneOK
			case r >= 0.8:
				hitTone = plugin.ToneWarn
			default:
				hitTone = plugin.ToneBad
			}
		}
		return plugin.StatData{Stats: []plugin.StatBlock{
			{Label: "Server", Value: orDash(info["redis_version"]), Sub: "role " + orDash(info["role"]), Icon: "database", Tone: plugin.ToneInfo,
				Tip: plugin.Tip(orDash(info["redis_version"]) + " · uptime " + humanDur(toF(info["uptime_in_seconds"])))},
			{Label: "Memory", Value: orDash(info["used_memory_human"]), Icon: "hdd", Tip: plugin.Tip("Peak " + orDash(info["used_memory_peak_human"]))},
			{Label: "Keys", Value: totalKeys(info), Icon: "box", Tip: plugin.Tip("Across all logical databases")},
			{Label: "Clients", Value: orDash(info["connected_clients"]), Icon: "activity", Tip: plugin.Tip("Connected client connections")},
			{Label: "Ops/sec", Value: orDash(info["instantaneous_ops_per_sec"])},
			{Label: "Hit ratio", Value: hitVal, Tone: hitTone, Sub: "keyspace hits/misses",
				Tip: plugin.Tip("Share of key lookups that hit — a low ratio means cache misses / churn")},
		}}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(15))

	// Per-database key counts from INFO keyspace, as a table.
	p.TableView("databases", "Databases", func(ctx context.Context) (any, error) {
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		info, err := infoMap(ctx, c)
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for i := 0; i < 16; i++ {
			line := info["db"+strconv.Itoa(i)] // e.g. "keys=12,expires=3,avg_ttl=0"
			if line == "" {
				continue
			}
			f := kvPairs(line)
			rows = append(rows, []any{i, plugin.Number(toInt(f["keys"]), ""), plugin.Number(toInt(f["expires"]), "")})
		}
		return &plugin.TableData{Columns: []string{"db", "keys", "with TTL"}, Rows: rows}, nil
	}, plugin.Refreshable())

	// Live active-connection / ops pulse.
	p.Stream("live", "Ops/sec", plugin.Counter, func(ctx context.Context, emit plugin.EmitFunc) error {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		poll := func() {
			c, err := getClient(ctx)
			if err != nil {
				return
			}
			if info, err := infoMap(ctx, c); err == nil {
				emit(map[string]any{"ops": toInt(info["instantaneous_ops_per_sec"])})
			}
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

// --- Keyspace: tree -> per-key detail --------------------------------------------

func registerKeyspace(p *plugin.Plugin) {
	// A keyspace tree: SCAN up to the operator's limit, group keys by ":" segments,
	// each leaf carrying a type icon + a TTL dot and a link into its detail page.
	p.View("keyspace", "Keyspace", plugin.Tree, func(ctx context.Context) (any, error) {
		return keyspaceTree(ctx, settingInt(p, "scan_limit", 500))
	})

	// Per-key metadata (type, TTL, encoding, size).
	p.View("key_info", "Info", plugin.KV, func(ctx context.Context) (any, error) {
		c, key, err := keyParam(ctx)
		if err != nil {
			return nil, err
		}
		typ, _ := c.Type(ctx, key).Result()
		ttl, _ := c.TTL(ctx, key).Result()
		enc, _ := c.Do(ctx, "OBJECT", "ENCODING", key).Text()
		size, _ := c.Do(ctx, "MEMORY", "USAGE", key).Int64()
		ttlStr := "no expiry"
		if ttl > 0 {
			ttlStr = ttl.Truncate(time.Second).String()
		} else if ttl == -2 {
			ttlStr = "(missing)"
		}
		return map[string]any{
			"key":      plugin.Code(key),
			"type":     plugin.Badge(typ, typeTone(typ)),
			"ttl":      ttlStr,
			"encoding": enc,
			"size":     humanBytes(size),
			"length":   plugin.Number(keyLen(ctx, c, key, typ), ""),
		}, nil
	})

	// Per-key value, shaped by its type (string / hash / list / set / zset).
	p.TableView("key_value", "Value", func(ctx context.Context) (any, error) {
		c, key, err := keyParam(ctx)
		if err != nil {
			return nil, err
		}
		return keyValue(ctx, c, key)
	}, plugin.PageSize(100))
}

// --- Command console -------------------------------------------------------------

func registerConsole(p *plugin.Plugin) {
	// Run an arbitrary command and see the reply. The plugin owns the connection; hope
	// audits the call. Naive whitespace splitting — fine for a console.
	p.QueryView("command", "Console", "bash", "INFO server", func(ctx context.Context) (any, error) {
		line := strings.TrimSpace(plugin.Input(ctx))
		if line == "" {
			return &plugin.TableData{Columns: []string{"reply"}, Rows: [][]any{}}, nil
		}
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		fields := strings.Fields(line)
		args := make([]any, len(fields))
		for i, f := range fields {
			args[i] = f
		}
		rep, err := c.Do(ctx, args...).Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			return nil, plugin.NewError(-32602, err.Error())
		}
		return &plugin.TableData{Columns: []string{"reply"}, Rows: replyRows(rep)}, nil
	})
}

// --- Live: slowlog + clients -----------------------------------------------------

func registerMonitor(p *plugin.Plugin) {
	// Slowlog — the slowest recent commands.
	p.TableView("slowlog", "Slowlog", func(ctx context.Context) (any, error) {
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		entries, err := c.SlowLogGet(ctx, 50).Result()
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for _, e := range entries {
			rows = append(rows, []any{
				e.ID, plugin.Time(e.Time.Unix()),
				plugin.Number(e.Duration.Microseconds(), "µs"),
				e.ClientAddr, plugin.Code(truncate(strings.Join(e.Args, " "), 160)),
			})
		}
		return &plugin.TableData{
			Columns:    []string{"id", "when", "duration", "client", "command"},
			Rows:       rows,
			ColumnTips: map[string]*plugin.Tooltip{"duration": plugin.Tip("Server-side execution time (excludes network)")},
		}, nil
	}, plugin.Refreshable())

	// Connected clients, with a per-row "kill" (danger) action.
	p.TableView("clients", "Clients", func(ctx context.Context) (any, error) {
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		list, err := c.ClientList(ctx).Result()
		if err != nil {
			return nil, err
		}
		rows := [][]any{}
		for _, ln := range strings.Split(strings.TrimSpace(list), "\n") {
			if ln == "" {
				continue
			}
			f := kvPairs(strings.ReplaceAll(ln, " ", ","))
			rows = append(rows, []any{
				f["id"], f["addr"], f["name"], plugin.Number(toInt(f["age"]), "s"), f["db"], plugin.Code(f["cmd"]),
			})
		}
		return &plugin.TableData{Columns: []string{"id", "addr", "name", "age", "db", "cmd"}, Rows: rows}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(4),
		plugin.RowActions(
			plugin.RowAction{Method: "kill_client", Label: "Kill", Icon: "trash", Danger: true, Tip: plugin.Tip("Close this client connection (CLIENT KILL)", plugin.TipTopEnd)},
		))

	p.DangerAction("kill_client", "Kill client", nil, func(ctx context.Context, in map[string]any) (any, error) {
		row, _ := in["row"].(map[string]any)
		id, _ := row["id"].(string)
		if id == "" {
			return map[string]any{"ok": false, "message": "no client id"}, nil
		}
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		if err := c.Do(ctx, "CLIENT", "KILL", "ID", id).Err(); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "client " + id + " killed"}, nil
	})
}

// --- Maintenance ----------------------------------------------------------------

func registerMaintenance(p *plugin.Plugin) {
	p.DangerAction("flushdb", "Flush DB", nil, func(ctx context.Context, in map[string]any) (any, error) {
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		if err := c.FlushDB(ctx).Err(); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "current database flushed"}, nil
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Delete every key in the CURRENT database", plugin.TipTop))

	p.DangerAction("flushall", "Flush ALL", nil, func(ctx context.Context, in map[string]any) (any, error) {
		c, err := getClient(ctx)
		if err != nil {
			return nil, err
		}
		if err := c.FlushAll(ctx).Err(); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "all databases flushed"}, nil
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Delete every key in EVERY database — irreversible", plugin.TipTop))
}

// --- Layout ---------------------------------------------------------------------

func registerLayout(p *plugin.Plugin) {
	panel := plugin.Section("",
		plugin.Tabs(
			plugin.Leaf("overview").Titled("Overview"),
			plugin.Leaf("keyspace").Titled("Keyspace"),
			plugin.Leaf("databases").Titled("Databases"),
			plugin.Leaf("command").Titled("Console"),
			plugin.Leaf("slowlog").Titled("Slowlog"),
			plugin.Leaf("clients").Titled("Clients"),
		),
		plugin.Section("Maintenance", plugin.Buttons("flushdb", "flushall")),
	)

	// Container panel on any redis-family image.
	p.ContainerPanel("Redis", &plugin.Match{Images: []string{"redis*", "valkey*", "keydb*"}}, panel)

	// Standalone nav page (rail + ⌘K palette).
	p.Page("Redis", plugin.Section("",
		plugin.Leaf("overview"),
		plugin.Row(
			plugin.Section("Keyspace", plugin.Leaf("keyspace")),
			plugin.Section("Databases", plugin.Leaf("databases")),
		),
		plugin.Tabs(
			plugin.Leaf("command").Titled("Console").Filled(),
			plugin.Leaf("slowlog").Titled("Slowlog"),
			plugin.Leaf("clients").Titled("Clients"),
		),
	)).PageID("redis").
		Subtitle("browse, query, and operate this server").
		HeaderActions("flushdb", "flushall")

	p.DashboardWidget("Redis", plugin.Section("", plugin.Leaf("overview")))
	p.StackWidget("Redis", nil, plugin.Section("", plugin.Leaf("overview")))

	// A key's detail page, reached from the keyspace tree (To: "key/<name>").
	p.DetailPage("key", "Key", "key", plugin.Section("",
		plugin.Tabs(
			plugin.Leaf("key_value").Titled("Value").Filled(),
			plugin.Leaf("key_info").Titled("Info"),
		),
	)).Subtitle("{key}").
		Breadcrumbs(plugin.Crumb{Label: "Redis", To: "redis"}, plugin.Crumb{Label: "{key}"})
}

// --- Redis access ---------------------------------------------------------------

var (
	clientOnce sync.Once
	clientRef  *redis.Client
	clientErr  error
)

// getClient lazily opens a client from REDIS_URL, so the plugin serves hope.schema
// even before the server is reachable.
func getClient(ctx context.Context) (*redis.Client, error) {
	clientOnce.Do(func() {
		url := os.Getenv("REDIS_URL")
		if url == "" {
			clientErr = errors.New("REDIS_URL is not set")
			return
		}
		opt, err := redis.ParseURL(url)
		if err != nil {
			clientErr = err
			return
		}
		clientRef = redis.NewClient(opt)
	})
	return clientRef, clientErr
}

// keyParam resolves the client + the {key} page param.
func keyParam(ctx context.Context) (*redis.Client, string, error) {
	var pr struct {
		Key string `json:"key"`
	}
	_ = plugin.Params(ctx, &pr)
	if pr.Key == "" {
		return nil, "", plugin.NewError(-32602, "no key selected")
	}
	c, err := getClient(ctx)
	return c, pr.Key, err
}

// keyspaceTree SCANs keys, resolves TYPE + TTL in one pipeline, and groups them into
// a prefix tree split on ":".
func keyspaceTree(ctx context.Context, limit int) (plugin.TreeData, error) {
	c, err := getClient(ctx)
	if err != nil {
		return plugin.TreeData{}, err
	}
	keys := []string{}
	var cursor uint64
	for len(keys) < limit {
		batch, cur, err := c.Scan(ctx, cursor, "*", 200).Result()
		if err != nil {
			return plugin.TreeData{}, err
		}
		keys = append(keys, batch...)
		cursor = cur
		if cursor == 0 {
			break
		}
	}
	if len(keys) > limit {
		keys = keys[:limit]
	}
	sort.Strings(keys)

	pipe := c.Pipeline()
	types := make([]*redis.StatusCmd, len(keys))
	ttls := make([]*redis.DurationCmd, len(keys))
	for i, k := range keys {
		types[i] = pipe.Type(ctx, k)
		ttls[i] = pipe.TTL(ctx, k)
	}
	_, _ = pipe.Exec(ctx)

	root := &treeBuilder{children: map[string]*treeBuilder{}}
	for i, k := range keys {
		root.add(strings.Split(k, ":"), k, types[i].Val(), ttls[i].Val())
	}
	return plugin.TreeData{Nodes: root.nodes()}, nil
}

// treeBuilder assembles the ":"-split prefix tree, then emits plugin.TreeNodes.
type treeBuilder struct {
	children map[string]*treeBuilder
	order    []string
	// leaf fields (set when this node IS a full key)
	fullKey string
	typ     string
	ttl     time.Duration
}

func (b *treeBuilder) add(segs []string, full, typ string, ttl time.Duration) {
	if len(segs) == 0 {
		b.fullKey, b.typ, b.ttl = full, typ, ttl
		return
	}
	head := segs[0]
	child := b.children[head]
	if child == nil {
		child = &treeBuilder{children: map[string]*treeBuilder{}}
		b.children[head] = child
		b.order = append(b.order, head)
	}
	child.add(segs[1:], full, typ, ttl)
}

func (b *treeBuilder) nodes() []plugin.TreeNode {
	out := []plugin.TreeNode{}
	for _, seg := range b.order {
		c := b.children[seg]
		n := plugin.TreeNode{Label: seg}
		if c.fullKey != "" { // a real key
			n.Icon = typeIcon(c.typ)
			n.To = "key/" + c.fullKey
			if c.ttl > 0 {
				n.Tone = plugin.ToneWarn // expiring
				n.Tip = plugin.Tip(c.typ + " · expires in " + c.ttl.Truncate(time.Second).String())
			} else {
				n.Tip = plugin.Tip(c.typ + " · no expiry")
			}
		} else {
			n.Icon = "menu" // a prefix group
			n.Collapsed = true
		}
		n.Children = c.nodes()
		out = append(out, n)
	}
	return out
}

// keyValue reads a key's value shaped by its type.
func keyValue(ctx context.Context, c *redis.Client, key string) (*plugin.TableData, error) {
	typ, err := c.Type(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	switch typ {
	case "string":
		v, _ := c.Get(ctx, key).Result()
		return &plugin.TableData{Columns: []string{"value"}, Rows: [][]any{{plugin.Code(v)}}}, nil
	case "hash":
		m, _ := c.HGetAll(ctx, key).Result()
		rows := [][]any{}
		for f, v := range m {
			rows = append(rows, []any{f, plugin.Code(v)})
		}
		return &plugin.TableData{Columns: []string{"field", "value"}, Rows: rows}, nil
	case "list":
		vals, _ := c.LRange(ctx, key, 0, 999).Result()
		rows := [][]any{}
		for i, v := range vals {
			rows = append(rows, []any{i, plugin.Code(v)})
		}
		return &plugin.TableData{Columns: []string{"index", "value"}, Rows: rows}, nil
	case "set":
		vals, _ := c.SMembers(ctx, key).Result()
		rows := [][]any{}
		for _, v := range vals {
			rows = append(rows, []any{plugin.Code(v)})
		}
		return &plugin.TableData{Columns: []string{"member"}, Rows: rows}, nil
	case "zset":
		zs, _ := c.ZRangeWithScores(ctx, key, 0, 999).Result()
		rows := [][]any{}
		for _, z := range zs {
			rows = append(rows, []any{plugin.Code(fmt.Sprint(z.Member)), plugin.Number(z.Score, "")})
		}
		return &plugin.TableData{Columns: []string{"member", "score"}, Rows: rows}, nil
	default:
		return &plugin.TableData{Columns: []string{"type"}, Rows: [][]any{{typ + " (no viewer)"}}}, nil
	}
}

func keyLen(ctx context.Context, c *redis.Client, key, typ string) int64 {
	switch typ {
	case "string":
		n, _ := c.StrLen(ctx, key).Result()
		return n
	case "hash":
		n, _ := c.HLen(ctx, key).Result()
		return n
	case "list":
		n, _ := c.LLen(ctx, key).Result()
		return n
	case "set":
		n, _ := c.SCard(ctx, key).Result()
		return n
	case "zset":
		n, _ := c.ZCard(ctx, key).Result()
		return n
	}
	return 0
}

// --- small helpers --------------------------------------------------------------

// infoMap parses INFO output into a flat key -> value map.
func infoMap(ctx context.Context, c *redis.Client) (map[string]string, error) {
	s, err := c.Info(ctx).Result()
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		if k, v, ok := strings.Cut(ln, ":"); ok {
			out[k] = v
		}
	}
	return out, nil
}

// kvPairs parses "k1=v1,k2=v2" into a map.
func kvPairs(s string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		if k, v, ok := strings.Cut(part, "="); ok {
			out[k] = v
		}
	}
	return out
}

// totalKeys sums keys across all dbN entries in INFO keyspace.
func totalKeys(info map[string]string) int {
	total := 0
	for i := 0; i < 16; i++ {
		if line := info["db"+strconv.Itoa(i)]; line != "" {
			total += toInt(kvPairs(line)["keys"])
		}
	}
	return total
}

// replyRows turns a redis reply into table rows (one per element for a multi-bulk).
func replyRows(v any) [][]any {
	switch t := v.(type) {
	case nil:
		return [][]any{{"(nil)"}}
	case []any:
		rows := make([][]any, 0, len(t))
		for _, e := range t {
			rows = append(rows, []any{plugin.Code(fmt.Sprint(e))})
		}
		if len(rows) == 0 {
			rows = [][]any{{"(empty)"}}
		}
		return rows
	default:
		return [][]any{{plugin.Code(fmt.Sprint(t))}}
	}
}

func typeIcon(typ string) string {
	switch typ {
	case "string":
		return "file"
	case "hash":
		return "box"
	case "list":
		return "menu"
	case "set":
		return "database"
	case "zset":
		return "rocket"
	case "stream":
		return "terminal"
	}
	return "code"
}

func typeTone(typ string) string {
	switch typ {
	case "string":
		return plugin.ToneInfo
	case "hash", "zset":
		return plugin.ToneOK
	case "list", "set":
		return ""
	}
	return ""
}

func settingInt(p *plugin.Plugin, key string, def int) int {
	if n, err := strconv.Atoi(p.SettingValue(key)); err == nil && n > 0 && n <= 100000 {
		return n
	}
	return def
}

func toInt(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func toF(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func truncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func humanDur(secs float64) string {
	d := time.Duration(secs) * time.Second
	if d < time.Minute {
		return d.String()
	}
	days := int(d.Hours()) / 24
	if days > 0 {
		return strconv.Itoa(days) + "d"
	}
	return d.Truncate(time.Minute).String()
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
