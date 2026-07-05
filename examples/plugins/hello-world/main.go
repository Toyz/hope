// hello-world is the reference hope plugin. It exercises every view kind (kv,
// table, query, tree), a counter stream, and an action — all with stdlib only —
// so it doubles as a copy-paste starter and a test fixture. Point hope at it:
//
//	docker run -e HOPE_PLUGIN_TOKEN=dev \
//	  -l hope.plugin=true -l hope.plugin.port=8080 <image>
package main

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/toyz/hope/plugin"
)

func main() {
	p := plugin.New("hello-world", "1.0.0").
		Description("Every hope view kind, one small plugin").
		Icon("rocket")

	// Operator-managed settings (configured + saved from the plugin inspector,
	// pushed to the plugin via hope.settings; read with p.SettingValue).
	p.Setting(plugin.Setting{Key: "greeting", Label: "Greeting", Default: "hello", Hint: "prefix used by the greet action"})
	p.Setting(plugin.Setting{Key: "mood", Label: "Mood", Kind: plugin.SettingSelect, Default: "cheerful",
		Options: []plugin.Option{{Label: "Cheerful", Value: "cheerful"}, {Label: "Grumpy", Value: "grumpy"}}})
	p.Setting(plugin.Setting{Key: "loud", Label: "Loud", Kind: plugin.SettingToggle, Hint: "UPPERCASE the greeting"})

	// kv: a flat label/value map.
	p.View("info", "Info", plugin.KV, func(ctx context.Context) (any, error) {
		host, _ := os.Hostname()
		return map[string]any{
			"host":    host,
			"pid":     os.Getpid(),
			"started": startedAt.Format(time.RFC3339),
			"uptime":  time.Since(startedAt).Truncate(time.Second).String(),
		}, nil
	})

	// table: columns + rows.
	p.View("planets", "Planets", plugin.Table, func(ctx context.Context) (any, error) {
		return map[string]any{
			"columns": []string{"name", "moons", "au"},
			"rows": [][]any{
				{"Mercury", 0, 0.39},
				{"Earth", 1, 1.00},
				{"Jupiter", 95, 5.20},
			},
		}, nil
	})

	// query: echo the user's input back as a one-row table.
	p.View("echo", "Echo Query", plugin.Query, func(ctx context.Context) (any, error) {
		in := plugin.Input(ctx)
		return map[string]any{
			"columns": []string{"you typed", "length"},
			"rows":    [][]any{{in, len(in)}},
		}, nil
	})

	// tree: a small hierarchy.
	p.View("tree", "Tree", plugin.Tree, func(ctx context.Context) (any, error) {
		return map[string]any{
			"nodes": []any{
				map[string]any{"label": "fruit", "children": []any{
					map[string]any{"label": "apple"},
					map[string]any{"label": "pear"},
				}},
				map[string]any{"label": "veg", "children": []any{
					map[string]any{"label": "carrot"},
				}},
			},
		}, nil
	})

	// action: greet, collecting one text field.
	p.Action("greet", "Greet", []plugin.Field{
		{Key: "name", Label: "Name", Placeholder: "world"},
	}, func(ctx context.Context, in map[string]any) (any, error) {
		name, _ := in["name"].(string)
		if name == "" {
			name = "world"
		}
		greeting := p.SettingValue("greeting")
		if greeting == "" {
			greeting = "hello"
		}
		msg := greeting + ", " + name
		if p.SettingValue("mood") == "grumpy" {
			msg = greeting + "... " + name + ", what do you want"
		}
		if p.SettingValue("loud") == "true" {
			msg = strings.ToUpper(msg)
		}
		return map[string]any{"message": msg}, nil
	})

	// counter stream: a value ticking up once a second until the UI disconnects.
	p.Stream("ticks", "Ticks", plugin.Counter, func(ctx context.Context, emit plugin.EmitFunc) error {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var n int
		emit(map[string]any{"tick": n})
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				n++
				emit(map[string]any{"tick": n})
			}
		}
	})

	// A view that echoes the selected page's param — proves param-passing from a
	// dynamic page into a shared view.
	p.View("picked", "Selection", plugin.KV, func(ctx context.Context) (any, error) {
		var pr map[string]any
		_ = plugin.Params(ctx, &pr)
		if len(pr) == 0 {
			return map[string]any{"note": "nothing selected"}, nil
		}
		return pr, nil
	})

	// A dynamic page nested one level: two groups, each with leaf pages that share
	// the SAME layout (the "picked" view) but pass a distinct param. In the rail:
	// hello-world -> Colors -> Red/Green, Shapes -> Circle.
	p.DynamicPage("Explorer", plugin.Section("Selected", plugin.Leaf("picked")), []plugin.PageItem{
		{Title: "Colors", Children: []plugin.PageItem{
			{Title: "Red", Param: map[string]any{"group": "colors", "value": "red"}},
			{Title: "Green", Param: map[string]any{"group": "colors", "value": "green"}},
		}},
		{Title: "Shapes", Children: []plugin.PageItem{
			{Title: "Circle", Param: map[string]any{"group": "shapes", "value": "circle"}},
		}},
	})

	// Explicit layout: tabs over the views + streams, actions in their own section.
	// (Omitting this would auto-generate an equivalent container panel.)
	p.ContainerPanel("Hello", &plugin.Match{}, plugin.Section("",
		plugin.Tabs(
			plugin.Leaf("info").Titled("Info"),
			plugin.Leaf("planets").Titled("Planets"),
			plugin.Leaf("echo").Titled("Query"),
			plugin.Leaf("tree").Titled("Tree"),
			plugin.Leaf("ticks").Titled("Live"),
		),
		plugin.Section("Actions", plugin.Leaf("greet")),
	))

	addr := ":8080"
	if v := os.Getenv("HOPE_PLUGIN_ADDR"); v != "" {
		addr = v
	}
	log.Printf("hello-world plugin listening on %s", addr)
	log.Fatal(p.ListenAndServe(addr))
}

var startedAt = time.Now()
