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
// hope's UI ("alert when cache hit ratio < 95"), the rules are persisted in hope via
// p.Storage (so a stateless plugin has somewhere durable to keep them — exactly what
// the storage capability is for), and a background loop evaluates them, raising +
// resolving hope alerts. hope-postgres ships no fixed thresholds — it just knows how to
// query a curated set of metrics and lets the operator compose rules over them.

// alertRule is one operator-authored rule: fire when <metric> <op> <threshold>.
type alertRule struct {
	ID        string  `json:"id"`
	Metric    string  `json:"metric"`
	Op        string  `json:"op"` // > < >= <=
	Threshold float64 `json:"threshold"`
	Severity  string  `json:"severity"` // warn | critical
}

// metricDef is a metric the operator can build a rule on: a label/unit for display and
// a query returning a single numeric value.
type metricDef struct {
	label string
	unit  string
	query string
}

// metricOrder keeps the select stable (map iteration is random).
var metricOrder = []string{
	"cache_hit_pct", "connection_pct", "connections", "active_connections",
	"longest_query_secs", "db_size_gb", "rollback_pct", "deadlocks",
}

var metrics = map[string]metricDef{
	"cache_hit_pct":      {"Cache hit ratio", "%", `select coalesce(sum(blks_hit)::float/nullif(sum(blks_hit)+sum(blks_read),0)*100,100) from pg_stat_database`},
	"connection_pct":     {"Connections vs max", "%", `select count(*)::float/nullif(current_setting('max_connections')::float,0)*100 from pg_stat_activity`},
	"connections":        {"Connections", "", `select count(*) from pg_stat_activity`},
	"active_connections": {"Active connections", "", `select count(*) from pg_stat_activity where state='active'`},
	"longest_query_secs": {"Longest running query", "s", `select coalesce(max(extract(epoch from now()-query_start)),0) from pg_stat_activity where state='active'`},
	"db_size_gb":         {"Database size", "GB", `select pg_database_size(current_database())/1073741824.0`},
	"rollback_pct":       {"Rollback ratio", "%", `select coalesce(sum(xact_rollback)::float/nullif(sum(xact_commit)+sum(xact_rollback),0)*100,0) from pg_stat_database`},
	"deadlocks":          {"Deadlocks (total)", "", `select coalesce(sum(deadlocks),0) from pg_stat_database`},
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
		{Key: "threshold", Label: "Threshold", Placeholder: "e.g. 95"},
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
		pool, err := getPool(ctx)
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
			var val float64
			if pool.QueryRow(ctx, md.query).Scan(&val) != nil {
				continue
			}
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
