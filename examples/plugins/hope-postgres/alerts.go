package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/toyz/hope/plugin"
)

// registerAlerts turns hope-postgres into a health monitor: a background loop polls a
// few key Postgres metrics and raises hope alerts (p.Alert) when they breach
// operator-tunable thresholds, resolving them when they recover. The thresholds are
// plain settings, so the operator tunes them from hope's plugin inspector. Alerting
// needs the events:publish grant (consented on enable) + hope's reverse channel
// (callback_url); until then p.Alert no-ops gracefully, so the monitor is safe to start
// before the plugin is even reachable.
func registerAlerts(p *plugin.Plugin) {
	p.Setting(plugin.Setting{Key: "alert_cache_hit_min", Label: "Cache hit floor (%)", Kind: plugin.SettingNumber, Default: "90", Hint: "alert when the buffer cache hit ratio drops below this"})
	p.Setting(plugin.Setting{Key: "alert_conn_pct", Label: "Connection ceiling (%)", Kind: plugin.SettingNumber, Default: "80", Hint: "alert when connections exceed this % of max_connections"})
	p.Setting(plugin.Setting{Key: "alert_longquery_secs", Label: "Long query (s)", Kind: plugin.SettingNumber, Default: "60", Hint: "alert when a query has run longer than this"})
	p.Setting(plugin.Setting{Key: "alert_interval_secs", Label: "Check interval (s)", Kind: plugin.SettingNumber, Default: "30", Hint: "how often to evaluate the health checks"})

	p.RequirePermission(plugin.ScopeEventsPublish, "raise Postgres health alerts (cache hit, connections, slow queries)")

	go monitor(p)
}

// monitor is the edge-triggered health loop: it fires an alert once when a condition
// starts breaching and resolves it once when it recovers (no re-alert spam while it
// stays breached). A plugin/hope restart resets the state, so active conditions
// re-surface on the next pass.
func monitor(p *plugin.Plugin) {
	firing := map[string]bool{} // dedupeKey -> currently breaching

	set := func(ctx context.Context, key, sev, title, detail string, breaching bool) {
		switch {
		case breaching && !firing[key]:
			firing[key] = true
			_ = p.Alert(ctx, sev, title, detail, key)
		case !breaching && firing[key]:
			delete(firing, key)
			_ = p.ResolveAlert(ctx, title, key)
		}
	}

	tick := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		pool, err := getPool(ctx)
		if err != nil {
			return
		}

		// Buffer cache hit ratio across all databases.
		minHit := settingFloat(p, "alert_cache_hit_min", 90)
		var hit, read float64
		if pool.QueryRow(ctx, `select coalesce(sum(blks_hit),0), coalesce(sum(blks_read),0) from pg_stat_database`).Scan(&hit, &read) == nil {
			total := hit + read
			ratio := 100.0
			if total > 0 {
				ratio = hit / total * 100
			}
			set(ctx, "pg-cache-hit", "warn", "Low cache hit ratio",
				fmt.Sprintf("%.1f%% (floor %.0f%%) — consider more shared_buffers or an index", ratio, minHit),
				total > 0 && ratio < minHit)
		}

		// Connection saturation vs max_connections.
		maxPct := settingFloat(p, "alert_conn_pct", 80)
		var used int
		var maxStr string
		if pool.QueryRow(ctx, `select count(*) from pg_stat_activity`).Scan(&used) == nil &&
			pool.QueryRow(ctx, `select current_setting('max_connections')`).Scan(&maxStr) == nil {
			if maxc, _ := strconv.Atoi(maxStr); maxc > 0 {
				pct := float64(used) / float64(maxc) * 100
				set(ctx, "pg-conn", "warn", "Connections near limit",
					fmt.Sprintf("%d/%d (%.0f%%, ceiling %.0f%%)", used, maxc, pct, maxPct), pct >= maxPct)
			}
		}

		// Long-running active queries.
		longSecs := settingFloat(p, "alert_longquery_secs", 60)
		var longCount int
		if pool.QueryRow(ctx, `select count(*) from pg_stat_activity where state='active' and now()-query_start > make_interval(secs => $1)`, longSecs).Scan(&longCount) == nil {
			set(ctx, "pg-longquery", "critical", "Long-running query",
				fmt.Sprintf("%d quer%s running over %.0fs", longCount, plural(longCount), longSecs), longCount > 0)
		}
	}

	tick()
	for {
		time.Sleep(time.Duration(settingFloat(p, "alert_interval_secs", 30)) * time.Second)
		tick()
	}
}

// settingFloat reads a numeric operator setting, falling back to def when unset/invalid.
func settingFloat(p *plugin.Plugin, key string, def float64) float64 {
	if v, err := strconv.ParseFloat(p.SettingValue(key), 64); err == nil && v > 0 {
		return v
	}
	return def
}

func plural(n int) string {
	if n == 1 {
		return "y"
	}
	return "ies"
}
