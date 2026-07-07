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

// Cell is a rich table/field cell — a typed shape hope renders specially (a pill, a
// link, a progress bar, …). It's a type *alias* for map[string]any, so it stays a plain
// JSON object on the wire and every builder below (and any hand-built map) satisfies it
// with no conversion; the name just documents intent where a cell is expected (e.g. a
// Comp's Cell field, or CCell). Build one with Badge/Link/Number/Time/Progress/Code/Image.
type Cell = map[string]any

// Tone names a semantic color for a Badge (matches hope's ok/warn/bad/info).
const (
	ToneOK   = "ok"
	ToneWarn = "warn"
	ToneBad  = "bad"
	ToneInfo = "info"
)

// Badge renders value as a colored pill. tone is one of the Tone* constants ("" =
// neutral).
func Badge(value, tone string) Cell {
	return Cell{"type": "badge", "value": value, "tone": tone}
}

// Link renders value as an in-app link that navigates to a hope route `to` (e.g. a
// master-detail page). Use ExternalLink for an off-site URL.
func Link(value, to string) Cell {
	return Cell{"type": "link", "value": value, "to": to}
}

// ExternalLink renders value as a link that opens href in a new tab.
func ExternalLink(value, href string) Cell {
	return Cell{"type": "link", "value": value, "href": href}
}

// DetailLink renders value as a link to one of this plugin's DetailPage ids, passing
// arg as the page's ParamKey — a master-detail link that needs no knowledge of the
// plugin's hope key. e.g. DetailLink("alice", "user", "42") -> the "user" detail
// page with param {<paramKey>: "42"}.
func DetailLink(value, pageID, arg string) Cell {
	return Cell{"type": "link", "value": value, "to": pageID + "/" + arg}
}

// Time renders a unix timestamp (seconds or millis) as relative time ("2h ago"),
// with the absolute time on hover.
func Time(unix int64) Cell {
	return Cell{"type": "time", "value": unix}
}

// Number renders n right-formatted with thousands separators; unit ("" = none) is
// appended (e.g. "MB", "reqs").
func Number(n any, unit string) Cell {
	m := Cell{"type": "number", "value": n}
	if unit != "" {
		m["unit"] = unit
	}
	return m
}

// Progress renders frac (0..1) as a small progress bar.
func Progress(frac float64) Cell {
	return Cell{"type": "progress", "value": frac}
}

// Code renders value as inline monospace (an id, hash, snippet).
func Code(value string) Cell {
	return Cell{"type": "code", "value": value}
}

// Image renders src as an image (click opens the full image in a new tab). alt is the
// hover/accessible label. Unlike RPC calls, hope does NOT proxy image bytes — the
// browser loads src directly, so src MUST be an absolute http(s) URL reachable from
// the browser (e.g. a public on-demand webp/avif image proxy). A non-http(s) src
// renders as its alt text. Usable as a table cell or a stat/card/cards field value.
//
// With no opts it's a small inline thumbnail. Control the render box with opts:
//
//	Image(u, alt)                      // default thumbnail
//	Image(u, alt, ImgW(240))           // 240px wide, height auto (keeps aspect)
//	Image(u, alt, ImgBox(110, 110))    // fixed 110×110 box, image centered, contained
//	Image(u, alt, ImgBox(110,110), ImgFit("cover")) // fill the box, cropping overflow
func Image(src, alt string, opts ...ImageOpt) Cell {
	m := Cell{"type": "image", "value": src, "alt": alt}
	for _, o := range opts {
		o(m)
	}
	return m
}

// ImageOpt configures an Image cell's render box (size + fit).
type ImageOpt func(map[string]any)

// ImgW fixes the image width in px; height is auto, so the aspect ratio is kept
// (e.g. "240×N"). Combine with ImgH for a fixed box (see ImgBox).
func ImgW(px int) ImageOpt { return func(m map[string]any) { m["w"] = px } }

// ImgH fixes the image height in px; width is auto (keeps aspect).
func ImgH(px int) ImageOpt { return func(m map[string]any) { m["h"] = px } }

// ImgBox fixes both dimensions: the image is centered in a w×h box and, by default,
// contained (scaled to fit, no crop). Add ImgFit("cover") to fill and crop instead.
func ImgBox(w, h int) ImageOpt {
	return func(m map[string]any) { m["w"], m["h"] = w, h }
}

// ImgFit sets object-fit: "contain" (default — whole image, letterboxed) or "cover"
// (fill the box, cropping overflow).
func ImgFit(fit string) ImageOpt { return func(m map[string]any) { m["fit"] = fit } }

// ImgFallback sets an image shown when src fails to load (broken/404/blocked). It must
// also be an absolute http(s) URL. Tried once; if it too fails, the cell renders blank
// (no browser broken-image icon).
func ImgFallback(url string) ImageOpt { return func(m map[string]any) { m["fb"] = url } }

// ImgLightbox makes clicking the image open it in an in-app lightbox (a dimmed
// full-screen overlay, closed by backdrop click / Esc / the close button) instead of
// a new browser tab — nicer for viewing badge/avatar art in place.
func ImgLightbox() ImageOpt { return func(m map[string]any) { m["lb"] = true } }
