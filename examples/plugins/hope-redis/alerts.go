package main

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/toyz/hope/plugin"
)

// Alerting is OPERATOR-DEFINED, not baked in: the operator adds their own rules from
// hope's UI ("alert when memory vs max > 90"), the rules persist in hope via p.Storage
// (durable state for a stateless plugin — what the storage capability is for), and a
// background loop evaluates them, raising + resolving hope alerts. hope-redis ships no
// fixed thresholds — it reads a curated set of INFO metrics and lets the operator
// compose rules over them. Mirrors hope-postgres so the two read the same.

// alertRule is one operator-authored rule: fire when <metric> <op> <threshold>.
type alertRule struct {
	ID        string  `json:"id"`
	Metric    string  `json:"metric"`
	Op        string  `json:"op"` // > < >= <=
	Threshold float64 `json:"threshold"`
	Severity  string  `json:"severity"` // warn | critical
}

// metricDef is a metric the operator can build a rule on: a label/unit for display and
// a function that derives a single numeric value from the parsed INFO map.
type metricDef struct {
	label string
	unit  string
	value func(info map[string]string) float64
}

// infoF reads a numeric INFO field directly.
func infoF(key string) func(map[string]string) float64 {
	return func(i map[string]string) float64 { return toF(i[key]) }
}

// metricOrder keeps the select stable (map iteration is random).
var metricOrder = []string{
	"mem_used_pct", "mem_used_mb", "hit_ratio_pct", "connected_clients",
	"blocked_clients", "ops_per_sec", "evicted_keys", "expired_keys",
	"rejected_connections", "total_keys", "frag_ratio", "unsaved_changes",
}

var metrics = map[string]metricDef{
	"mem_used_pct": {"Memory vs maxmemory", "%", func(i map[string]string) float64 {
		max := toF(i["maxmemory"])
		if max <= 0 {
			return 0 // no maxmemory set -> can't breach a percentage
		}
		return toF(i["used_memory"]) / max * 100
	}},
	"mem_used_mb": {"Memory used", "MB", func(i map[string]string) float64 { return toF(i["used_memory"]) / 1048576 }},
	"hit_ratio_pct": {"Hit ratio", "%", func(i map[string]string) float64 {
		h, m := toF(i["keyspace_hits"]), toF(i["keyspace_misses"])
		if h+m <= 0 {
			return 100
		}
		return h / (h + m) * 100
	}},
	"connected_clients":    {"Connected clients", "", infoF("connected_clients")},
	"blocked_clients":      {"Blocked clients", "", infoF("blocked_clients")},
	"ops_per_sec":          {"Ops/sec", "", infoF("instantaneous_ops_per_sec")},
	"evicted_keys":         {"Evicted keys (total)", "", infoF("evicted_keys")},
	"expired_keys":         {"Expired keys (total)", "", infoF("expired_keys")},
	"rejected_connections": {"Rejected connections (total)", "", infoF("rejected_connections")},
	"total_keys":           {"Total keys", "", func(i map[string]string) float64 { return float64(totalKeys(i)) }},
	"frag_ratio":           {"Memory fragmentation ratio", "", infoF("mem_fragmentation_ratio")},
	"unsaved_changes":      {"Unsaved changes since last save", "", infoF("rdb_changes_since_last_save")},
}

func registerAlerts(p *plugin.Plugin) {
	// Only the poll cadence is a setting; the rules themselves are operator data.
	p.Setting(plugin.Setting{Key: "alert_interval_secs", Label: "Alert check interval (s)", Kind: plugin.SettingNumber, Default: "30", Hint: "how often to evaluate alert rules"})

	// Publish alerts + persist the operator's rules — both consented on enable.
	p.RequirePermission(plugin.ScopeEventsPublish, "raise the alerts you define")
	p.RequirePermission(plugin.ScopeStorage, "save the alert rules you create")

	// The rules table — lists what the operator has defined, with a per-row delete.
	p.View("alertRules", "Alert rules", plugin.Table, func(ctx context.Context) (any, error) {
		rows := [][]any{}
		for _, r := range loadRules(ctx, p) {
			md := metrics[r.Metric]
			rows = append(rows, []any{md.label, r.Op + " " + fmtNum(r.Threshold) + md.unit, r.Severity, r.ID})
		}
		return map[string]any{"columns": []string{"metric", "condition", "severity", "id"}, "rows": rows}, nil
	},
		plugin.Refreshable(),
		plugin.RowActions(plugin.RowAction{Method: "removeAlert", Label: "Delete", Icon: "trash", Danger: true}),
	)

	// Add a rule: metric + comparator + threshold + severity, all from the UI.
	p.Action("addAlert", "Add alert rule", []plugin.Field{
		{Key: "metric", Label: "Metric", Type: "select", Options: metricOptions()},
		{Key: "op", Label: "Condition", Type: "select", Options: []plugin.Option{
			{Value: ">", Label: "greater than"}, {Value: "<", Label: "less than"},
			{Value: ">=", Label: "at least"}, {Value: "<=", Label: "at most"},
		}},
		{Key: "threshold", Label: "Threshold", Placeholder: "e.g. 90"},
		{Key: "severity", Label: "Severity", Type: "select", Options: []plugin.Option{
			{Value: "warn", Label: "Warning"}, {Value: "critical", Label: "Critical"},
		}},
	}, func(ctx context.Context, in map[string]any) (any, error) {
		metric, _ := in["metric"].(string)
		op, _ := in["op"].(string)
		sev, _ := in["severity"].(string)
		thr, err := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(in["threshold"])), 64)
		if _, ok := metrics[metric]; !ok {
			return nil, plugin.NewError(-32602, "unknown metric")
		}
		if !validOp(op) || err != nil {
			return nil, plugin.NewError(-32602, "pick a condition and a numeric threshold")
		}
		if sev == "" {
			sev = "warn"
		}
		rules := append(loadRules(ctx, p), alertRule{ID: uuid.NewString(), Metric: metric, Op: op, Threshold: thr, Severity: sev})
		if err := saveRules(ctx, p, rules); err != nil {
			return nil, plugin.NewError(-32603, "couldn't save the rule: "+err.Error())
		}
		return map[string]any{"ok": true, "message": "alert rule added"}, nil
	})

	// Delete a rule (the table's row action passes {row:{id}}).
	p.DangerAction("removeAlert", "Delete alert rule", nil, func(ctx context.Context, in map[string]any) (any, error) {
		id := rowID(in)
		if id == "" {
			return map[string]any{"ok": false, "message": "no rule"}, nil
		}
		kept := []alertRule{}
		for _, r := range loadRules(ctx, p) {
			if r.ID != id {
				kept = append(kept, r)
			}
		}
		if err := saveRules(ctx, p, kept); err != nil {
			return nil, plugin.NewError(-32603, err.Error())
		}
		return map[string]any{"ok": true, "message": "alert rule removed"}, nil
	})

	go monitor(p)
}

// monitor evaluates the operator's rules on an interval, edge-triggered: one alert when
// a rule starts breaching, one resolve when it recovers (or the rule is deleted). No
// re-alert spam. A restart resets state, so active breaches re-surface next pass.
func monitor(p *plugin.Plugin) {
	firing := map[string]string{} // rule id -> alert title (so a deleted rule can still resolve)

	tick := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		rules := loadRules(ctx, p)
		if len(rules) == 0 {
			// still resolve anything left firing (all rules deleted)
			for id, title := range firing {
				delete(firing, id)
				_ = p.ResolveAlert(ctx, title, id)
			}
			return
		}
		c, err := getClient(ctx)
		if err != nil {
			return
		}
		info, err := infoMap(ctx, c)
		if err != nil {
			return
		}
		seen := map[string]bool{}
		for _, r := range rules {
			seen[r.ID] = true
			md, ok := metrics[r.Metric]
			if !ok {
				continue
			}
			val := md.value(info)
			title := md.label + " " + r.Op + " " + fmtNum(r.Threshold) + md.unit
			breach := compare(val, r.Op, r.Threshold)
			_, isFiring := firing[r.ID]
			switch {
			case breach && !isFiring:
				firing[r.ID] = title
				_ = p.Alert(ctx, r.Severity, title, fmt.Sprintf("%s is now %s%s", md.label, fmtNum(val), md.unit), r.ID)
			case !breach && isFiring:
				delete(firing, r.ID)
				_ = p.ResolveAlert(ctx, title, r.ID)
			}
		}
		// A rule deleted while firing -> resolve its alert.
		for id, title := range firing {
			if !seen[id] {
				delete(firing, id)
				_ = p.ResolveAlert(ctx, title, id)
			}
		}
	}

	tick()
	for {
		time.Sleep(time.Duration(intervalSecs(p)) * time.Second)
		tick()
	}
}

// --- storage-backed rule CRUD (persisted in hope via p.Storage) ---

const rulesKey = "alert_rules"

func loadRules(ctx context.Context, p *plugin.Plugin) []alertRule {
	var rs []alertRule
	_, _ = p.Storage().Get(ctx, rulesKey, &rs)
	return rs
}

func saveRules(ctx context.Context, p *plugin.Plugin, rs []alertRule) error {
	return p.Storage().Set(ctx, rulesKey, rs)
}

// --- small helpers ---

func metricOptions() []plugin.Option {
	out := make([]plugin.Option, 0, len(metricOrder))
	for _, k := range metricOrder {
		md := metrics[k]
		lbl := md.label
		if md.unit != "" {
			lbl += " (" + md.unit + ")"
		}
		out = append(out, plugin.Option{Value: k, Label: lbl})
	}
	return out
}

func validOp(op string) bool { return op == ">" || op == "<" || op == ">=" || op == "<=" }

func compare(v float64, op string, t float64) bool {
	switch op {
	case ">":
		return v > t
	case "<":
		return v < t
	case ">=":
		return v >= t
	case "<=":
		return v <= t
	}
	return false
}

func fmtNum(f float64) string {
	if f == math.Trunc(f) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', 2, 64)
}

func rowID(in map[string]any) string {
	row, _ := in["row"].(map[string]any)
	id, _ := row["id"].(string)
	return id
}

func intervalSecs(p *plugin.Plugin) float64 {
	if v, err := strconv.ParseFloat(p.SettingValue("alert_interval_secs"), 64); err == nil && v > 0 {
		return v
	}
	return 30
}
