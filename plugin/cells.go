package plugin

// Rich table cells. A table/query row may mix plain scalars with these typed cells;
// hope renders each specially (a pill, a link, relative time, a formatted number, a
// progress bar, inline code) so dense data reads well. Return them as row values.
//
//	rows := [][]any{{
//	    42,
//	    plugin.Link("alice", "/plugin/"+key+"/user/42"),
//	    plugin.Badge("active", plugin.ToneOK),
//	    plugin.Number(1402301, ""),
//	    plugin.Time(user.CreatedUnix),
//	}}

// Tone names a semantic color for a Badge (matches hope's ok/warn/bad/info).
const (
	ToneOK   = "ok"
	ToneWarn = "warn"
	ToneBad  = "bad"
	ToneInfo = "info"
)

// Badge renders value as a colored pill. tone is one of the Tone* constants ("" =
// neutral).
func Badge(value, tone string) map[string]any {
	return map[string]any{"type": "badge", "value": value, "tone": tone}
}

// Link renders value as an in-app link that navigates to a hope route `to` (e.g. a
// master-detail page). Use ExternalLink for an off-site URL.
func Link(value, to string) map[string]any {
	return map[string]any{"type": "link", "value": value, "to": to}
}

// ExternalLink renders value as a link that opens href in a new tab.
func ExternalLink(value, href string) map[string]any {
	return map[string]any{"type": "link", "value": value, "href": href}
}

// Time renders a unix timestamp (seconds or millis) as relative time ("2h ago"),
// with the absolute time on hover.
func Time(unix int64) map[string]any {
	return map[string]any{"type": "time", "value": unix}
}

// Number renders n right-formatted with thousands separators; unit ("" = none) is
// appended (e.g. "MB", "reqs").
func Number(n any, unit string) map[string]any {
	m := map[string]any{"type": "number", "value": n}
	if unit != "" {
		m["unit"] = unit
	}
	return m
}

// Progress renders frac (0..1) as a small progress bar.
func Progress(frac float64) map[string]any {
	return map[string]any{"type": "progress", "value": frac}
}

// Code renders value as inline monospace (an id, hash, snippet).
func Code(value string) map[string]any {
	return map[string]any{"type": "code", "value": value}
}
