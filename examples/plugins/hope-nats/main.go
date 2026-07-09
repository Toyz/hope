// hope-nats is a first-party reference plugin: point it at a NATS server (NATS_URL) and it
// exposes a control panel inside hope — server + JetStream stat tiles, a stream browser you
// drill into (config, state, consumers), KV bucket + key browsing, a live subject monitor, a
// publish action, and stream maintenance (purge/delete).
//
// The plugin holds the connection (your secret, in your container); hope only speaks the
// plugin protocol, proxies + audits calls, and never touches NATS directly.
//
//	docker run -e NATS_URL=nats://user:pass@host:4222 \
//	  -e HOPE_PLUGIN_TOKEN=secret \
//	  -l hope.plugin=true -l hope.plugin.port=8080 <image>
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

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("hope-nats", "1.0.0").
		Description("Inspect streams, consumers, and KV; watch subjects; publish and operate a NATS server").
		Icon("server").
		// Icons hope doesn't ship as built-ins, registered per-plugin (inner SVG only).
		Icons(map[string]string{
			"activity": `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
			"layers":   `<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>`,
			"key":      `<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>`,
		})

	// The subject the live monitor subscribes to (">" = every subject). Operator-tunable.
	p.Setting(plugin.Setting{Key: "watch_subject", Label: "Live monitor subject", Kind: plugin.SettingText, Default: ">", Hint: "subject filter for the Activity tab (e.g. orders.> or >)"})
	p.Setting(plugin.Setting{Key: "page_size", Label: "Table page size", Kind: plugin.SettingNumber, Default: "100", Hint: "rows per page in the KV key browser"})

	registerOverview(p)
	registerStreams(p)
	registerKV(p)
	registerActivity(p)
	registerPublish(p)
	registerLayout(p)

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("hope-nats plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
}

// --- Connection -----------------------------------------------------------------

var (
	connOnce sync.Once
	ncRef    *nats.Conn
	jsRef    jetstream.JetStream
	connErr  error
)

// conn lazily connects (so the plugin serves hope.schema even before NATS is reachable).
// JetStream may be disabled server-side — jsRef is non-nil but AccountInfo will error; the
// JS views degrade to an "unavailable" message rather than failing the whole panel.
func conn(ctx context.Context) (*nats.Conn, jetstream.JetStream, error) {
	connOnce.Do(func() {
		url := os.Getenv("NATS_URL")
		if url == "" {
			url = nats.DefaultURL
		}
		ncRef, connErr = nats.Connect(url, nats.Name("hope-nats"), nats.Timeout(5*time.Second), nats.MaxReconnects(-1))
		if connErr != nil {
			return
		}
		jsRef, connErr = jetstream.New(ncRef)
	})
	return ncRef, jsRef, connErr
}

// --- Overview -------------------------------------------------------------------

func registerOverview(p *plugin.Plugin) {
	p.StatView("overview", "Overview", func(ctx context.Context) (any, error) {
		nc, js, err := conn(ctx)
		if err != nil {
			return plugin.StatData{Stats: []plugin.StatBlock{{Label: "NATS", Value: "unreachable", Tone: plugin.ToneBad}}}, nil
		}
		stats := nc.Stats()
		blocks := []plugin.StatBlock{
			{Label: "Server", Value: orDash(nc.ConnectedServerName()), Sub: nc.ConnectedServerVersion(), Icon: "server", Tone: plugin.ToneInfo},
			{Label: "In msgs", Value: int64(stats.InMsgs)},
			{Label: "Out msgs", Value: int64(stats.OutMsgs)},
		}
		if cluster := nc.ConnectedClusterName(); cluster != "" {
			blocks = append(blocks, plugin.StatBlock{Label: "Cluster", Value: cluster})
		}
		// JetStream account usage (streams/consumers/storage) — only when JS is enabled.
		if ai, jerr := js.AccountInfo(ctx); jerr == nil {
			blocks = append(blocks,
				plugin.StatBlock{Label: "Streams", Value: ai.Streams, Tone: plugin.ToneOK, Sub: "jetstream"},
				plugin.StatBlock{Label: "Consumers", Value: ai.Consumers},
				plugin.StatBlock{Label: "Memory", Value: humanBytes(int64(ai.Memory))},
				plugin.StatBlock{Label: "Storage", Value: humanBytes(int64(ai.Store))},
			)
		} else {
			blocks = append(blocks, plugin.StatBlock{Label: "JetStream", Value: "disabled", Tone: plugin.ToneWarn})
		}
		return plugin.StatData{Stats: blocks}, nil
	}, plugin.Refreshable(), plugin.RefreshEvery(10))

	// Connection health as a component (RTT + throughput + reconnects).
	p.ComponentView("health", "Health", func(ctx context.Context) (any, error) {
		nc, _, err := conn(ctx)
		if err != nil {
			return plugin.Box(plugin.Heading("NATS unreachable", 2).Toned(plugin.ToneBad), plugin.CText(err.Error())), nil
		}
		rtt, _ := nc.RTT()
		s := nc.Stats()
		return plugin.Box(
			plugin.Heading("Connected", 2).Toned(plugin.ToneOK),
			plugin.CText(orDash(nc.ConnectedUrl())),
			plugin.Divider(),
			plugin.CRow(
				plugin.KeyVal("rtt", rtt.Round(time.Microsecond).String()),
				plugin.KeyVal("reconnects", plugin.Number(int64(s.Reconnects), "")),
				plugin.KeyVal("in", humanBytes(int64(s.InBytes))),
				plugin.KeyVal("out", humanBytes(int64(s.OutBytes))),
			).Gapped(20),
		), nil
	}, plugin.Refreshable(), plugin.RefreshEvery(5))

	// Live message rate — inbound msgs/sec, a ticking pulse of server traffic.
	p.Stream("live", "Msgs/sec", plugin.Series, func(ctx context.Context, emit plugin.EmitFunc) error {
		nc, _, err := conn(ctx)
		if err != nil {
			return err
		}
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		last := nc.Stats().InMsgs
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				now := nc.Stats().InMsgs
				emit(map[string]any{"y": float64(now-last) / 2.0})
				last = now
			}
		}
	})
}

// --- Streams --------------------------------------------------------------------

func registerStreams(p *plugin.Plugin) {
	cols := []string{"id", "stream", "storage", "subjects", "messages", "bytes", "consumers", "last seq"}
	p.TableView("streams", "Streams", func(ctx context.Context) (any, error) {
		_, js, err := conn(ctx)
		if err != nil {
			return pageResult(cols, nil, 0, "id"), nil
		}
		rows := [][]any{}
		lister := js.ListStreams(ctx)
		for si := range lister.Info() {
			// KV buckets + object stores are JetStream streams under the hood (named KV_* /
			// OBS_*). They're surfaced in the KV tab, so hide their backing streams here — the
			// Streams tab should show real streams only.
			if strings.HasPrefix(si.Config.Name, "KV_") || strings.HasPrefix(si.Config.Name, "OBS_") {
				continue
			}
			rows = append(rows, []any{
				plugin.Code(si.Config.Name),
				plugin.DetailLink(si.Config.Name, "stream", si.Config.Name),
				plugin.Badge(si.Config.Storage.String(), storageTone(si.Config.Storage.String())),
				truncate(strings.Join(si.Config.Subjects, " "), 60),
				plugin.Number(int64(si.State.Msgs), ""),
				plugin.Badge(humanBytes(int64(si.State.Bytes)), ""),
				plugin.Number(si.State.Consumers, ""),
				plugin.Number(int64(si.State.LastSeq), ""),
			})
		}
		if err := lister.Err(); err != nil {
			return &plugin.TableData{Columns: []string{"stream"}, Rows: [][]any{{"JetStream unavailable: " + err.Error()}}}, nil
		}
		return pageResult(cols, rows, len(rows), "id"), nil
	}, plugin.Refreshable(), plugin.RefreshEvery(10), plugin.NoSort(), plugin.Static(),
		plugin.EmptyView("No streams", plugin.EmptyIcon("layers"), plugin.EmptyText("This server has no JetStream streams (or JetStream is disabled).")),
		plugin.RowFlyout("streamFlyout"))

	// Stream detail hero — config + state only. The DETAIL PAGE hero (the consumers table
	// renders separately below it there). Reads the name from the {stream} page param.
	p.ComponentView("streamHead", "Stream", func(ctx context.Context) (any, error) {
		si, err := infoOf(ctx, streamName(ctx))
		if err != nil {
			return plugin.Box(plugin.CText(err.Error())), nil
		}
		return plugin.Box(streamHeroKids(si)...), nil
	})

	// streamFlyout — the row-flyout body: the hero PLUS the stream's consumers as an embedded
	// (flush) table, so a row click is a self-contained quick view — no dead "open" link back
	// to a page that just re-shows the hero.
	p.ComponentView("streamFlyout", "Stream", func(ctx context.Context) (any, error) {
		name := streamName(ctx)
		si, err := infoOf(ctx, name)
		if err != nil {
			return plugin.Box(plugin.CText(err.Error())), nil
		}
		kids := streamHeroKids(si)
		_, js, _ := conn(ctx)
		if s, serr := js.Stream(ctx, name); serr == nil {
			if rows := consumerRows(ctx, s); len(rows) > 0 {
				kids = append(kids,
					plugin.Divider(),
					plugin.CText("consumers"),
					plugin.CTable(&plugin.TableData{Columns: consumerCols, Rows: rows, Flush: true}),
				)
			}
		}
		return plugin.Box(kids...), nil
	})

	// Consumers of the current stream ({stream} param) — the detail-page table.
	p.TableView("streamConsumers", "Consumers", func(ctx context.Context) (any, error) {
		name := streamName(ctx)
		_, js, err := conn(ctx)
		if err != nil || name == "" {
			return &plugin.TableData{Columns: consumerCols}, nil
		}
		s, err := js.Stream(ctx, name)
		if err != nil {
			return &plugin.TableData{Columns: consumerCols}, nil
		}
		return &plugin.TableData{Columns: consumerCols, Rows: consumerRows(ctx, s)}, nil
	}, plugin.EmptyView("No consumers", plugin.EmptyIcon("check"), plugin.EmptyText("No consumers are bound to this stream.")))

	// Purge (drop all messages, keep the stream) + delete (remove the stream). Both danger.
	p.DangerAction("purgeStream", "Purge stream", nil, func(ctx context.Context, in map[string]any) (any, error) {
		name := streamName(ctx)
		_, js, err := conn(ctx)
		if err != nil || name == "" {
			return map[string]any{"ok": false, "message": "no stream"}, nil
		}
		s, err := js.Stream(ctx, name)
		if err != nil {
			return nil, err
		}
		if err := s.Purge(ctx); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "purged " + name, "refetch": true}, nil
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Delete every message in the stream (keeps the stream + consumers)", plugin.TipTop))

	p.DangerAction("deleteStream", "Delete stream", nil, func(ctx context.Context, in map[string]any) (any, error) {
		name := streamName(ctx)
		_, js, err := conn(ctx)
		if err != nil || name == "" {
			return map[string]any{"ok": false, "message": "no stream"}, nil
		}
		if err := js.DeleteStream(ctx, name); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "message": "deleted " + name, "refetch": true}, nil
	}, plugin.ActionIcon("trash"), plugin.ActionTip("Permanently remove the stream and all its messages + consumers", plugin.TipTop))
}

// --- KV -------------------------------------------------------------------------

func registerKV(p *plugin.Plugin) {
	cols := []string{"id", "bucket", "values", "bytes", "history", "ttl"}
	p.TableView("buckets", "KV Buckets", func(ctx context.Context) (any, error) {
		_, js, err := conn(ctx)
		if err != nil {
			return pageResult(cols, nil, 0, "id"), nil
		}
		rows := [][]any{}
		kl := js.KeyValueStores(ctx)
		for st := range kl.Status() {
			ttl := "—"
			if st.TTL() > 0 {
				ttl = st.TTL().String()
			}
			rows = append(rows, []any{
				plugin.Code(st.Bucket()),
				plugin.DetailLink(st.Bucket(), "bucket", st.Bucket()),
				plugin.Number(int64(st.Values()), ""),
				plugin.Badge(humanBytes(int64(st.Bytes())), ""),
				plugin.Number(st.History(), ""),
				ttl,
			})
		}
		if err := kl.Error(); err != nil {
			return &plugin.TableData{Columns: []string{"bucket"}, Rows: [][]any{{"KV unavailable: " + err.Error()}}}, nil
		}
		return pageResult(cols, rows, len(rows), "id"), nil
	}, plugin.Refreshable(), plugin.RefreshEvery(15), plugin.NoSort(), plugin.Static(),
		plugin.EmptyView("No KV buckets", plugin.EmptyIcon("key"), plugin.EmptyText("This server has no JetStream KV buckets.")))

	// Keys in the current bucket ({bucket} param). Each key's current value + revision.
	p.TableView("bucketKeys", "Keys", func(ctx context.Context) (any, error) {
		kcols := []string{"key", "revision", "updated", "value"}
		bucket := bucketName(ctx)
		_, js, err := conn(ctx)
		if err != nil || bucket == "" {
			return &plugin.TableData{Columns: kcols}, nil
		}
		kv, err := js.KeyValue(ctx, bucket)
		if err != nil {
			return &plugin.TableData{Columns: kcols}, nil
		}
		keys, err := kv.Keys(ctx)
		if err != nil {
			// An empty bucket returns ErrNoKeysFound — not a real error.
			return &plugin.TableData{Columns: kcols}, nil
		}
		sort.Strings(keys)
		limit := settingInt(p, "page_size", 100)
		rows := [][]any{}
		for i, k := range keys {
			if i >= limit {
				break
			}
			e, gerr := kv.Get(ctx, k)
			if gerr != nil {
				continue
			}
			t := e.Created()
			rows = append(rows, []any{
				plugin.Code(k),
				plugin.Number(int64(e.Revision()), ""),
				plugin.Time(t.Unix()),
				plugin.Code(truncate(string(e.Value()), 200)),
			})
		}
		return &plugin.TableData{Columns: kcols, Rows: rows}, nil
	}, plugin.EmptyView("Empty bucket", plugin.EmptyIcon("key"), plugin.EmptyText("This bucket has no keys.")))
}

// --- Activity + publish ---------------------------------------------------------

func registerActivity(p *plugin.Plugin) {
	// Live subject monitor: subscribe to the configured subject and stream each message as a
	// log line (subject + a payload preview). ctx cancels on UI disconnect -> unsubscribes.
	p.Stream("activity", "Live subjects", plugin.Log, func(ctx context.Context, emit plugin.EmitFunc) error {
		nc, _, err := conn(ctx)
		if err != nil {
			return err
		}
		subject := strings.TrimSpace(p.SettingValue("watch_subject"))
		if subject == "" {
			subject = ">"
		}
		sub, err := nc.Subscribe(subject, func(m *nats.Msg) {
			emit(m.Subject + "  " + truncate(string(m.Data), 160))
		})
		if err != nil {
			return err
		}
		defer sub.Unsubscribe()
		emit("subscribed to " + subject)
		<-ctx.Done()
		return nil
	})
}

func registerPublish(p *plugin.Plugin) {
	fields := []plugin.Field{
		{Key: "subject", Label: "Subject", Placeholder: "orders.new"},
		{Key: "payload", Label: "Payload", Type: "textarea", Placeholder: "message body", Optional: true},
	}
	p.Action("publish", "Publish", fields, func(ctx context.Context, in map[string]any) (any, error) {
		nc, _, err := conn(ctx)
		if err != nil {
			return nil, err
		}
		subject := strings.TrimSpace(fmt.Sprint(in["subject"]))
		if subject == "" {
			return map[string]any{"ok": false, "message": "subject is required"}, nil
		}
		if err := nc.Publish(subject, []byte(fmt.Sprint(in["payload"]))); err != nil {
			return nil, err
		}
		_ = nc.Flush()
		return map[string]any{"ok": true, "message": "published to " + subject}, nil
	}, plugin.ActionIcon("play"), plugin.ActionTip("Publish a message to a subject", plugin.TipTop))
}

// --- Layout ---------------------------------------------------------------------

func registerLayout(p *plugin.Plugin) {
	panel := plugin.Section("",
		plugin.Tabs(
			plugin.Leaf("overview").Titled("Overview"),
			plugin.Leaf("health").Titled("Health"),
			plugin.Leaf("streams").Titled("Streams").Filled(),
			plugin.Leaf("buckets").Titled("KV").Filled(),
			plugin.Leaf("activity").Titled("Activity"),
		),
		plugin.Section("Publish", plugin.Buttons("publish")),
	)
	p.ContainerPanel("NATS", &plugin.Match{Images: []string{"nats*", "nats-server*"}}, panel)

	p.Page("NATS", plugin.Section("",
		plugin.Leaf("overview"),
		plugin.Row(
			plugin.Section("Health", plugin.Leaf("health")),
			plugin.Section("Rate", plugin.Leaf("live")),
		),
		plugin.Tabs(
			plugin.Leaf("streams").Titled("Streams").Filled(),
			plugin.Leaf("buckets").Titled("KV Buckets").Filled(),
			plugin.Leaf("activity").Titled("Activity"),
		),
	)).PageID("nats").Subtitle("inspect and operate this NATS server").HeaderActions("publish")

	p.DashboardWidget("NATS", plugin.Section("", plugin.Leaf("overview")))
	p.StackWidget("NATS", nil, plugin.Section("", plugin.Leaf("overview")))

	// Stream detail — hero + consumers, with purge/delete in the header.
	p.DetailPage("stream", "Stream", "stream", plugin.Section("",
		plugin.Section("Overview", plugin.Leaf("streamHead")),
		plugin.Section("Consumers", plugin.Leaf("streamConsumers").Filled()),
	)).Subtitle("stream {stream}").
		Breadcrumbs(plugin.Crumb{Label: "NATS", To: "nats"}, plugin.Crumb{Label: "{stream}"}).
		HeaderActions("purgeStream", "deleteStream")

	// KV bucket detail — its keys.
	p.DetailPage("bucket", "Bucket", "bucket", plugin.Section("",
		plugin.Section("Keys", plugin.Leaf("bucketKeys").Filled()),
	)).Subtitle("bucket {bucket}").
		Breadcrumbs(plugin.Crumb{Label: "NATS", To: "nats"}, plugin.Crumb{Label: "{bucket}"})
}

// --- Params + helpers -----------------------------------------------------------

var consumerCols = []string{"consumer", "durable", "ack pending", "pending", "redelivered"}

// infoOf fetches a stream's info by name (empty name / missing stream -> error).
func infoOf(ctx context.Context, name string) (*jetstream.StreamInfo, error) {
	_, js, err := conn(ctx)
	if err != nil || name == "" {
		return nil, fmt.Errorf("stream not found")
	}
	s, err := js.Stream(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("stream not found: %s", name)
	}
	return s.Info(ctx)
}

// streamHeroKids builds the shared config/state component rows for a stream (hero), used by
// both the detail-page head and the flyout.
func streamHeroKids(si *jetstream.StreamInfo) []*plugin.Comp {
	kids := []*plugin.Comp{plugin.Heading(si.Config.Name, 2)}
	if si.Config.Description != "" {
		kids = append(kids, plugin.CText(si.Config.Description))
	}
	return append(kids,
		plugin.KeyVal("subjects", plugin.Code(strings.Join(si.Config.Subjects, " "))),
		plugin.KeyVal("storage", plugin.Badge(si.Config.Storage.String(), storageTone(si.Config.Storage.String()))),
		plugin.Divider(),
		plugin.CRow(
			plugin.KeyVal("messages", plugin.Number(int64(si.State.Msgs), "")),
			plugin.KeyVal("bytes", humanBytes(int64(si.State.Bytes))),
			plugin.KeyVal("consumers", plugin.Number(si.State.Consumers, "")),
		).Gapped(20),
		plugin.CRow(
			plugin.KeyVal("first seq", plugin.Number(int64(si.State.FirstSeq), "")),
			plugin.KeyVal("last seq", plugin.Number(int64(si.State.LastSeq), "")),
		).Gapped(20),
	)
}

// consumerRows returns a stream's consumer table rows, shared by the detail table + the flyout.
func consumerRows(ctx context.Context, s jetstream.Stream) [][]any {
	rows := [][]any{}
	cl := s.ListConsumers(ctx)
	for ci := range cl.Info() {
		durable := ci.Config.Durable
		if durable == "" {
			durable = "—"
		}
		rows = append(rows, []any{
			plugin.Code(ci.Name),
			durable,
			plugin.Number(int64(ci.NumAckPending), ""),
			plugin.Number(int64(ci.NumPending), ""),
			plugin.Number(int64(ci.NumRedelivered), ""),
		})
	}
	return rows
}

// streamName resolves the target stream from the {stream} page param OR a clicked row's id.
func streamName(ctx context.Context) string { return rowOrParam(ctx, "stream") }

// bucketName resolves the target bucket from the {bucket} page param OR a clicked row's id.
func bucketName(ctx context.Context) string { return rowOrParam(ctx, "bucket") }

func rowOrParam(ctx context.Context, key string) string {
	var pr struct {
		Stream string         `json:"stream"`
		Bucket string         `json:"bucket"`
		Row    map[string]any `json:"row"`
	}
	_ = plugin.Params(ctx, &pr)
	if pr.Row != nil {
		if id := cellStr(pr.Row["id"]); id != "" {
			return id
		}
	}
	if key == "bucket" {
		return pr.Bucket
	}
	return pr.Stream
}

// cellStr unwraps a plain string, a JSON number, or a rich cell ({value}).
func cellStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case map[string]any:
		return cellStr(t["value"])
	}
	return fmt.Sprint(v)
}

// pageResult is the {columns, rows, total} shape a hope table view returns; hidden columns
// stay in each row (so a flyout/detail can read an id) but aren't rendered.
func pageResult(cols []string, rows [][]any, total int, hidden ...string) map[string]any {
	m := map[string]any{"columns": cols, "rows": rows, "total": total}
	if len(hidden) > 0 {
		m["hidden"] = hidden
	}
	return m
}

func settingInt(p *plugin.Plugin, key string, def int) int {
	if n, err := strconv.Atoi(p.SettingValue(key)); err == nil && n > 0 && n <= 100000 {
		return n
	}
	return def
}

// storageTone: memory storage is volatile (warn), file is durable (ok).
func storageTone(s string) string {
	if s == "memory" {
		return plugin.ToneWarn
	}
	return plugin.ToneOK
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func humanBytes(n int64) string {
	const u = 1024
	if n < u {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(u), 0
	for x := n / u; x >= u; x /= u {
		div *= u
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
