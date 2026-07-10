// Package plugin is the hope plugin SDK: build a small JSON-RPC server that hope
// discovers across a fleet and renders in its UI. A plugin is your container, your
// language, your endpoint — hope dials in. Extend hope without joining it.
//
// Minimal plugin:
//
//	p := plugin.New("badge-directory", "1.0.0").Icon("database")
//	p.View("counts", "Counts", plugin.KV, func(ctx context.Context) (any, error) {
//		return map[string]any{"users": 1402301, "badges": 88123}, nil
//	})
//	log.Fatal(p.ListenAndServe(":8080")) // serves JSON-RPC 2.0 at /__hope
//
// The container then declares the labels hope scans for:
//
//	hope.plugin=true
//	hope.plugin.port=8080
//	hope.plugin.path=/__hope
package plugin

import (
	"context"
	"maps"
	"os"
	"strings"
	"sync"
)

// ViewFunc returns the data for a view; hope renders it per the view's ViewKind.
// For a Query view, the user's input arrives in the request params — read it with
// plugin.Input(ctx) (or plugin.Params for structured input).
type ViewFunc func(ctx context.Context) (any, error)

// ActionFunc runs an action with the UI-collected field values.
type ActionFunc func(ctx context.Context, in map[string]any) (any, error)

// EmitFunc pushes one frame to a live stream.
type EmitFunc func(v any)

// StreamFunc emits frames until it returns or ctx is cancelled (which hope does
// the moment the UI disconnects — so a dropped viewer never leaves you emitting
// forever). Always select on ctx.Done() in long loops.
type StreamFunc func(ctx context.Context, emit EmitFunc) error

// EventFunc handles a hope event pushed to the plugin (one unary hope.event call
// per event). It should return quickly; hope treats a slow/erroring handler as a
// missed delivery and moves on. Requires the events:subscribe permission.
type EventFunc func(ctx context.Context, e Event) error

type viewEntry struct {
	desc ViewDesc
	fn   ViewFunc
}
type actionEntry struct {
	desc ActionDesc
	fn   ActionFunc
}
type streamEntry struct {
	desc StreamDesc
	fn   StreamFunc
}

// Plugin is a hope plugin server. Construct with New, register capabilities, then
// ListenAndServe. Registration is not safe for concurrent use; serving is.
type Plugin struct {
	name    string
	version string
	desc    string
	icon    string
	icons   map[string]string
	path    string
	maxBody int64

	// Ordered method names preserve author declaration order in the manifest.
	order    []string
	views    map[string]viewEntry
	actions  map[string]actionEntry
	streams  map[string]streamEntry
	contribs []Contribution
	// pageFns[i] produces the Pages of contribs[i] LIVE at each hope.layout (a
	// DynamicPageFunc contribution) — kept off the wire Contribution so it stays
	// pure data. Keyed by index; contribs is append-only, so the index is stable.
	pageFns map[int]func(ctx context.Context) []PageItem

	// Operator-managed settings: the declared schema + the current values hope
	// pushes via hope.settings (read in a handler with SettingValue).
	settings    []Setting
	settingVals map[string]string
	// onInit, if set, runs when hope calls hope.init — the plugin's initialization
	// handshake, carrying its settings so it can set up WITH them (see OnInit).
	onInit func(ctx context.Context, in InitContext) error

	// onEvent, if set, handles hope events pushed via hope.event (requires the
	// events:subscribe grant). perms are the reverse-capability requests declared
	// via RequirePermission, surfaced in hope.schema for operator consent.
	onEvent func(ctx context.Context, e Event) error
	perms   []Permission

	// Reverse channel, delivered by hope.init: hopeURL is hope's base URL reachable
	// by this plugin, pluginKey is this install's stable identity. Both empty until
	// hope.init delivers them (needs a callback URL configured on hope) — Publish and
	// Storage are no-ops until then. Guarded by mu.
	hopeURL   string
	pluginKey string

	// auth: token is the configured shared secret (HOPE_PLUGIN_TOKEN or Token()).
	// When empty, the plugin trusts-on-first-use — it pins the first bearer hope
	// presents and rejects mismatches after (see authorize in jsonrpc.go).
	mu     sync.Mutex
	token  string
	pinned string
}

// New creates a plugin with the given name and semantic version. The endpoint
// path defaults to /__hope and the request body cap to 4 MiB. If the environment
// sets HOPE_PLUGIN_TOKEN, calls must present it as a bearer token.
func New(name, version string) *Plugin {
	return &Plugin{
		name:        name,
		version:     version,
		path:        "/__hope",
		maxBody:     4 << 20,
		icons:       map[string]string{},
		views:       map[string]viewEntry{},
		actions:     map[string]actionEntry{},
		streams:     map[string]streamEntry{},
		settingVals: map[string]string{},
		token:       os.Getenv("HOPE_PLUGIN_TOKEN"),
	}
}

// Description sets a one-line description shown in hope.
func (p *Plugin) Description(s string) *Plugin { p.desc = s; return p }

// Icon sets the plugin's default icon — a hope built-in name or one of the Icons
// keys registered with Icons.
func (p *Plugin) Icon(name string) *Plugin { p.icon = name; return p }

// Icons registers plugin-scoped icons: name -> inner SVG markup (path/circle/rect
// elements only, NOT a full <svg>), 24x24 stroke to match hope's icon set. hope
// resolves and sanitizes these in a per-plugin namespace, so they can't collide
// with other plugins or shadow hope's built-ins.
func (p *Plugin) Icons(m map[string]string) *Plugin {
	maps.Copy(p.icons, m)
	return p
}

// Path overrides the endpoint path (default /__hope). Must match the
// hope.plugin.path label.
func (p *Plugin) Path(path string) *Plugin {
	if path != "" {
		p.path = path
	}
	return p
}

// Token pins the shared secret hope must present as a bearer token, overriding
// HOPE_PLUGIN_TOKEN. Use when you configure the token in code rather than env.
func (p *Plugin) Token(token string) *Plugin { p.token = token; return p }

// MaxBodyBytes overrides the request body cap (default 4 MiB).
func (p *Plugin) MaxBodyBytes(n int64) *Plugin {
	if n > 0 {
		p.maxBody = n
	}
	return p
}

// reserved reports whether a method name is in the reserved hope.* namespace. The
// SDK forbids registering these so an author's method can't shadow the protocol.
func reserved(method string) bool { return strings.HasPrefix(method, "hope.") }

func (p *Plugin) claim(method string) {
	if reserved(method) {
		panic("hope plugin: method name " + method + " is reserved (hope.* namespace)")
	}
	if _, dup := p.views[method]; dup {
		panic("hope plugin: duplicate method " + method)
	}
	if _, dup := p.actions[method]; dup {
		panic("hope plugin: duplicate method " + method)
	}
	if _, dup := p.streams[method]; dup {
		panic("hope plugin: duplicate method " + method)
	}
	p.order = append(p.order, method)
}

// View registers a read-only data view rendered per kind. opts (Static/EmptyView/
// Refreshable/RefreshEvery) are optional and apply to any kind.
func (p *Plugin) View(method, label string, kind ViewKind, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: kind}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// QueryView registers a Query view whose input editor syntax-highlights lang and
// prepopulates with def (a template where {param} placeholders are filled from the
// page's param, e.g. "select * from {table}"). Read the input with plugin.Input.
func (p *Plugin) QueryView(method, label, lang, def string, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: Query, Lang: lang, Default: def}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// TableOpt configures an interactive Table view (row-click detail, row actions).
type TableOpt func(*ViewDesc)

// RowDetail makes table rows clickable: a click calls method with {row: {column:
// value}} and shows the returned kv/table in a modal (an author-controlled RPC).
func RowDetail(method string) TableOpt { return func(v *ViewDesc) { v.RowMethod = method } }

// RowFlyout makes table rows clickable into a right-side DRAWER (not a modal): a click
// calls method with {row: {column: value}} and hope renders the returned component tree
// (plugin.Box(...) — image, key/values, Buttons bound to actions) in the flyout. Richer
// than RowDetail's modal; good for a compact record shown beside the table. If both
// RowFlyout and RowDetail are set, the flyout wins.
func RowFlyout(method string) TableOpt { return func(v *ViewDesc) { v.RowFlyout = method } }

// RowDetailButton is like RowDetail but triggers from a per-row button instead of a
// whole-row click — use it when the row is also inline-editable so the click to
// edit a cell and the click to open the detail don't collide.
func RowDetailButton(method string) TableOpt {
	return func(v *ViewDesc) { v.RowMethod = method; v.RowDetailButton = true }
}

// RowActions adds per-row action buttons; each click calls the action's Method with
// {row: {column: value}}. Use for row-scoped mutations like "delete row".
func RowActions(actions ...RowAction) TableOpt {
	return func(v *ViewDesc) { v.RowActions = append(v.RowActions, actions...) }
}

// PageSize sets how many rows hope shows per page for this table (0 => hope default).
func PageSize(n int) TableOpt { return func(v *ViewDesc) { v.PageSize = n } }

// Facets adds dropdown filters to a server table; the selected values arrive in the
// query as filters[key] (read with ReadTableQuery). Apply them in your store.
func Facets(facets ...Facet) TableOpt {
	return func(v *ViewDesc) { v.Facets = append(v.Facets, facets...) }
}

// DefaultSort sets the sort a server table applies on first load (before the user
// touches a column header) — e.g. DefaultSort("indexed", "desc") for newest-first.
// dir is "asc" or "desc"; column must be one your handler's sort map accepts.
func DefaultSort(column, dir string) TableOpt {
	return func(v *ViewDesc) { v.DefaultSort = &SortSpec{Column: column, Dir: dir} }
}

// NoFilter hides a table's search box — for a plain paged list with no user search.
func NoFilter() TableOpt { return func(v *ViewDesc) { v.NoFilter = true } }

// NoSort makes a table's column headers non-interactive — the order is fixed by your
// handler (e.g. always newest-first), not user-sortable. Pair with NoFilter for a
// pure paged list.
func NoSort() TableOpt { return func(v *ViewDesc) { v.NoSort = true } }

// RefreshEvery auto-refetches the view every n seconds (a live-ish view without a
// stream). hope stops the timer when the view leaves the DOM.
func RefreshEvery(seconds int) ViewOpt { return func(v *ViewDesc) { v.RefreshInterval = seconds } }

// ServerSide marks a table server-driven: hope sends the query state each call and
// expects one page + a total back, so a table too large to ship whole still works.
// Read the query with plugin.ReadTableQuery and return {columns, rows, total}.
func ServerSide() TableOpt { return func(v *ViewDesc) { v.Server = true } }

// Editable makes cells editable: editing one calls method with {row, column, value}.
// Pass column names to limit which are editable (none => every column).
func Editable(method string, columns ...string) TableOpt {
	return func(v *ViewDesc) { v.EditMethod = method; v.EditColumns = append(v.EditColumns, columns...) }
}

// TableView registers a Table view. Add RowDetail/RowActions opts to make rows
// interactive — e.g. TableView("rows","Rows",fn, plugin.RowDetail("inspect"),
// plugin.RowActions(plugin.RowAction{Method:"del",Label:"Delete",Danger:true})).
func (p *Plugin) TableView(method, label string, fn ViewFunc, opts ...TableOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: Table}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// CardsView registers a Cards view; the handler returns CardsData (a grid of
// cards / a gallery — e.g. badges, users). Cards with a To navigate on click. opts
// (Static/EmptyView/…) are optional.
func (p *Plugin) CardsView(method, label string, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: Cards}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// ViewOpt configures a view (Refreshable, PageSize on tables, …). TableOpt is the
// same underlying type, so table options compose here too.
type ViewOpt = TableOpt

// Refreshable adds a manual refresh button to the view header (re-fetches on click).
func Refreshable() ViewOpt { return func(v *ViewDesc) { v.Refresh = true } }

// Static marks a view's data fixed for the life of the surface: hope fetches it once
// and reuses the cached result on tab re-entry / re-navigation instead of re-calling
// the plugin — fewer round-trips, less rate-limit pressure. Pair with Refreshable()
// for a "load once, refresh on demand" view. Don't combine with RefreshEvery.
func Static() ViewOpt { return func(v *ViewDesc) { v.Static = true } }

// EmptyOpt configures a view's EmptyState (its icon, secondary text, or a custom Comp).
type EmptyOpt func(*EmptyState)

// EmptyIcon sets the empty state's leading icon (a built-in name or an Icons key).
func EmptyIcon(name string) EmptyOpt { return func(e *EmptyState) { e.Icon = name } }

// EmptyText sets the empty state's dim secondary line under the title.
func EmptyText(s string) EmptyOpt { return func(e *EmptyState) { e.Text = s } }

// EmptyComp sets a fully custom empty state (a Comp tree — see component.go),
// overriding the icon/title/text — e.g. an icon plus a "create one" Link.
func EmptyComp(c *Comp) EmptyOpt { return func(e *EmptyState) { e.Comp = c } }

// EmptyView customizes the "no data" state shown when a view resolves empty (an empty
// table, a stat with no blocks) instead of hope's generic text — a title plus optional
// icon/text (or a custom Comp). Attach it wherever view opts are accepted (TableView,
// StatView, ComponentView), e.g.
//
//	p.TableView("slow", "Slow queries", fn,
//	    plugin.EmptyView("No slow queries 🎉", plugin.EmptyIcon("check")))
func EmptyView(title string, opts ...EmptyOpt) ViewOpt {
	return func(v *ViewDesc) {
		e := &EmptyState{Title: title}
		for _, o := range opts {
			o(e)
		}
		v.Empty = e
	}
}

// StatView registers a Stat view: the handler returns StatData (one or more
// big-number blocks — counts, totals, sizes). Add plugin.Refreshable() for a manual
// refresh button (e.g. "count rows in my table" on demand).
func (p *Plugin) StatView(method, label string, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: Stat}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// TextView registers a Text view: the handler returns {text: "…"} (or a raw
// string) rendered as a monospace scrollable block — logs, config, command output.
// opts (Static/EmptyView/…) are optional.
func (p *Plugin) TextView(method, label string, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: Text}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// SearchView registers a Search (autocomplete) view: hope calls fn with {q: <text>}
// as the user types and renders the returned SearchData as a live dropdown; selecting
// a SearchItem navigates to its To. Read the query with plugin.SearchQuery(ctx). Great
// for a "go to <entity>" jump box.
func (p *Plugin) SearchView(method, label string, fn ViewFunc) *Plugin {
	p.claim(method)
	p.views[method] = viewEntry{ViewDesc{Method: method, Label: label, Kind: Search}, fn}
	return p
}

// ChartView registers a Chart view; the handler returns ChartData (bar or line,
// one or more named series over categorical labels). hope draws axes + legend. opts
// (Static/EmptyView/…) are optional.
func (p *Plugin) ChartView(method, label string, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: Chart}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// ComponentView registers a Component view — the escape hatch. The handler returns a
// *Comp: a tree of safe primitives (box/row/heading/keyval/sparkline/cell/…) hope
// composes into a custom widget the built-in kinds don't cover (see component.go). Add
// plugin.Static() to cache it or plugin.EmptyView(...) to customize its empty state. For
// a small STATIC tile, prefer an inline plugin.Component node in the layout instead — it
// needs no per-view round-trip.
func (p *Plugin) ComponentView(method, label string, fn ViewFunc, opts ...ViewOpt) *Plugin {
	p.claim(method)
	d := ViewDesc{Method: method, Label: label, Kind: CompView}
	for _, o := range opts {
		o(&d)
	}
	p.views[method] = viewEntry{d, fn}
	return p
}

// ActionOpt configures a registered action beyond its label (its icon, …). Pass
// these to Action/DangerAction; the danger tone is set by DangerAction itself.
type ActionOpt func(*ActionDesc)

// ActionIcon sets the action button's icon — a hope built-in icon name or one of
// this plugin's Icons keys. e.g. plugin.ActionIcon("rotate").
func ActionIcon(name string) ActionOpt { return func(a *ActionDesc) { a.Icon = name } }

// ActionTip sets a hover tooltip on the action button explaining what it does, with
// an optional placement (see Tip). e.g. plugin.ActionTip("Refresh stats", plugin.TipBottom).
func ActionTip(text string, pos ...TipPos) ActionOpt {
	return func(a *ActionDesc) { a.Tip = Tip(text, pos...) }
}

// Action registers an invocable action. The UI collects fields, then calls fn
// with the values. Mark destructive actions with DangerAction.
func (p *Plugin) Action(method, label string, fields []Field, fn ActionFunc, opts ...ActionOpt) *Plugin {
	p.claim(method)
	d := ActionDesc{Method: method, Label: label, Fields: fields}
	for _, o := range opts {
		o(&d)
	}
	p.actions[method] = actionEntry{d, fn}
	return p
}

// DangerAction is like Action but flags the action destructive, so hope confirms
// before running it and audit-logs the invocation.
func (p *Plugin) DangerAction(method, label string, fields []Field, fn ActionFunc, opts ...ActionOpt) *Plugin {
	p.claim(method)
	d := ActionDesc{Method: method, Label: label, Fields: fields, Danger: true}
	for _, o := range opts {
		o(&d)
	}
	p.actions[method] = actionEntry{d, fn}
	return p
}

// Stream registers a live stream emitted as NDJSON frames.
func (p *Plugin) Stream(method, label string, kind StreamKind, fn StreamFunc) *Plugin {
	p.claim(method)
	p.streams[method] = streamEntry{StreamDesc{Method: method, Label: label, Kind: kind}, fn}
	return p
}

// OnEvent registers a handler for hope events (stack/container/image/plugin/agent
// changes, and plugin-published events). hope pushes each relevant event as a unary
// hope.event call. Registering a handler auto-declares the events:subscribe
// permission, so the operator is asked to consent on enable; without the grant hope
// never calls it. Call RequirePermission(ScopeEventsSubscribe, "<reason>") first to
// set a custom consent reason.
func (p *Plugin) OnEvent(fn EventFunc) *Plugin {
	p.onEvent = fn
	if fn != nil {
		p.RequirePermission(ScopeEventsSubscribe, "react to fleet events")
	}
	return p
}

// RequirePermission declares that the plugin wants a reverse capability (an
// events:*/storage/... scope). It appears in hope.schema; the operator consents when
// enabling the plugin, and hope gates the capability on the grant. Idempotent per
// scope — a later call only updates the reason if one is given.
func (p *Plugin) RequirePermission(scope, reason string) *Plugin {
	for i := range p.perms {
		if p.perms[i].Scope == scope {
			if reason != "" {
				p.perms[i].Reason = reason
			}
			return p
		}
	}
	p.perms = append(p.perms, Permission{Scope: scope, Reason: reason})
	return p
}

// Setting declares an operator-managed configuration field. hope renders these in
// the plugin inspector, persists the values (encrypted), and pushes them to the
// plugin; read a value in any handler with SettingValue. Settings are config the
// operator SETS — distinct from the panel the plugin SHOWS.
func (p *Plugin) Setting(s Setting) *Plugin {
	p.settings = append(p.settings, s)
	return p
}

// SettingValue returns the current value of an operator-managed setting (the value
// hope last pushed), falling back to the declared default. Safe for concurrent use.
func (p *Plugin) SettingValue(key string) string {
	p.mu.Lock()
	v, ok := p.settingVals[key]
	p.mu.Unlock()
	if ok && v != "" {
		return v
	}
	for _, s := range p.settings {
		if s.Key == key {
			return s.Default
		}
	}
	return v
}

// applySettings replaces the current setting values (hope.settings push).
func (p *Plugin) applySettings(vals map[string]string) {
	next := make(map[string]string, len(vals))
	maps.Copy(next, vals)
	p.mu.Lock()
	p.settingVals = next
	p.mu.Unlock()
}

// effectiveSettings returns each declared setting's current value (the pushed value,
// else its declared Default) — echoed back from hope.init.
func (p *Plugin) effectiveSettings() map[string]string {
	out := make(map[string]string, len(p.settings))
	for _, s := range p.settings {
		out[s.Key] = s.Default
	}
	p.mu.Lock()
	maps.Copy(out, p.settingVals)
	p.mu.Unlock()
	return out
}

// InitContext is what hope hands a plugin at initialization (hope.init): the settings
// the operator configured (so the plugin can set up WITH them), plus the hope build's
// protocol version and capabilities.
type InitContext struct {
	Settings map[string]string
	Protocol int
	Caps     Capabilities
}

// OnInit registers a handler hope calls once the plugin is reachable and being
// initialized (hope.init) — and again if the plugin restarts. It receives the current
// settings, so a plugin that needs its config at startup (a pool sized by a setting, a
// mode flag) can initialize with them instead of booting on defaults and waiting for a
// later hope.settings push. Optional: without it, settings are still applied so
// SettingValue works immediately. Errors are returned to hope (the install surfaces
// them). Register before ListenAndServe.
func (p *Plugin) OnInit(fn func(ctx context.Context, in InitContext) error) *Plugin {
	p.onInit = fn
	return p
}

// Contribute adds an explicit UI contribution. Without any, the plugin
// auto-generates a single container contribution (see layout) listing every
// registered capability — so a minimal plugin needs no layout code.
func (p *Plugin) Contribute(c Contribution) *Plugin {
	p.contribs = append(p.contribs, c)
	return p
}

// ContainerPanel is a shorthand for a container-surface contribution with the
// given title, match, and layout node.
func (p *Plugin) ContainerPanel(title string, match *Match, node *Node) *Plugin {
	return p.Contribute(Contribution{Surface: SurfaceContainer, Title: title, Match: match, Node: node, Icon: p.icon})
}

// Page contributes a full custom nav page (the `page` surface). hope lists it in
// the rail under the plugin and renders the node tree as a full page.
func (p *Plugin) Page(title string, node *Node) *Plugin {
	return p.Contribute(Contribution{Surface: SurfacePage, Title: title, Icon: p.icon, Node: node})
}

// HeaderActions attaches action buttons to the most recently added contribution —
// a page/panel/dashboard toolbar (distinct from leaf actions inside the layout).
// Each ref names a registered Action; hope collects its fields, confirms danger,
// and audits. Call it right after Page/ContainerPanel/DashboardWidget.
func (p *Plugin) HeaderActions(refs ...string) *Plugin {
	if len(p.contribs) > 0 {
		c := &p.contribs[len(p.contribs)-1]
		c.Actions = append(c.Actions, refs...)
	}
	return p
}

// PageID gives the most recently added page contribution a stable id so links and
// breadcrumbs can target it by name (a plugin doesn't know positional page paths).
// Call right after Page.
func (p *Plugin) PageID(id string) *Plugin {
	if len(p.contribs) > 0 {
		p.contribs[len(p.contribs)-1].ID = id
	}
	return p
}

// Subtitle sets the page header's sub/meta line for the most recently added page
// contribution ({param} placeholders filled from the page param). Call after Page.
func (p *Plugin) Subtitle(s string) *Plugin {
	if len(p.contribs) > 0 {
		p.contribs[len(p.contribs)-1].Subtitle = s
	}
	return p
}

// Breadcrumbs attaches a breadcrumb trail to the most recently added page
// contribution (call right after Page/DetailPage). {param} placeholders in a
// crumb's label/to are filled from the page param.
func (p *Plugin) Breadcrumbs(crumbs ...Crumb) *Plugin {
	if len(p.contribs) > 0 {
		c := &p.contribs[len(p.contribs)-1]
		c.Breadcrumbs = append(c.Breadcrumbs, crumbs...)
	}
	return p
}

// DetailPage contributes a hidden master-detail page addressed by a stable id (not
// shown in the rail). A Link/DetailLink navigates to it plugin-relative, and hope
// passes the URL arg as param[paramKey] — read it in a handler with plugin.Params.
// e.g. DetailPage("user", "User", "id", node) rendered at .../user/42 => {id:"42"}.
func (p *Plugin) DetailPage(id, title, paramKey string, node *Node) *Plugin {
	return p.Contribute(Contribution{Surface: SurfacePage, Title: title, Icon: p.icon, Node: node, ID: id, Hidden: true, ParamKey: paramKey})
}

// DashboardWidget contributes a widget to hope's fleet/host dashboard (the
// `dashboard` surface): the node renders as a compact panel alongside hope's own
// dashboard cards. Keep it small — a couple of kv/counter/series leaves.
func (p *Plugin) DashboardWidget(title string, node *Node) *Plugin {
	return p.Contribute(Contribution{Surface: SurfaceDashboard, Title: title, Icon: p.icon, Node: node})
}

// StackWidget contributes a widget to the stack view (the `stack` surface): the
// node renders as a panel on a stack's page, for stacks whose containers the Match
// selects. It's the container panel's whole-stack analog — same Match semantics
// (images/labels/services/always), but evaluated against the stack's set of
// containers rather than one. Keep it focused: a stack-scoped overview or action.
func (p *Plugin) StackWidget(title string, match *Match, node *Node) *Plugin {
	return p.Contribute(Contribution{Surface: SurfaceStack, Title: title, Match: match, Node: node, Icon: p.icon})
}

// DynamicPage contributes MANY rail pages that share one layout node but each pass
// a distinct Param (merged into every call the page makes). items may nest one
// level (groups of pages) — e.g. databases -> tables. Read the param in a handler
// with plugin.Params. Regenerate the items in getLayout to reflect live state.
func (p *Plugin) DynamicPage(title string, node *Node, items []PageItem) *Plugin {
	return p.Contribute(Contribution{Surface: SurfacePage, Title: title, Icon: p.icon, Node: node, Pages: items})
}

// DynamicPageFunc is DynamicPage with LIVE items: fn runs on every hope.layout to
// produce the rail entries, so the set reflects current state (a database's tables,
// a broker's topics) instead of a snapshot frozen at startup — the answer to "my
// pages depend on data I don't have until runtime." Keep fn fast: hope fetches the
// layout per surface, so cache if it hits a slow backend.
func (p *Plugin) DynamicPageFunc(title string, node *Node, fn func(ctx context.Context) []PageItem) *Plugin {
	p.Contribute(Contribution{Surface: SurfacePage, Title: title, Icon: p.icon, Node: node})
	if p.pageFns == nil {
		p.pageFns = map[int]func(ctx context.Context) []PageItem{}
	}
	p.pageFns[len(p.contribs)-1] = fn
	return p
}

// schema builds the hope.schema result from the registered capabilities, in
// author declaration order.
func (p *Plugin) schema() Schema {
	s := Schema{
		ProtocolVersion: ProtocolVersion,
		Name:            p.name,
		Version:         p.version,
		Description:     p.desc,
		Icon:            p.icon,
	}
	if len(p.icons) > 0 {
		s.Icons = p.icons
	}
	s.Settings = p.settings
	s.Permissions = p.perms
	for _, m := range p.order {
		switch {
		case p.views[m].fn != nil:
			s.Views = append(s.Views, p.views[m].desc)
		case p.actions[m].fn != nil:
			s.Actions = append(s.Actions, p.actions[m].desc)
		case p.streams[m].fn != nil:
			s.Streams = append(s.Streams, p.streams[m].desc)
		}
	}
	return s
}

// layout builds the hope.layout result. If the author registered no
// contributions, it synthesizes one container contribution (matching the
// plugin's own container) that lists views/streams first, then actions — a
// sensible default so trivial plugins render with zero layout code.
func (p *Plugin) layout(ctx context.Context) Layout {
	l := Layout{ProtocolVersion: ProtocolVersion}
	if len(p.contribs) > 0 {
		// Copy so a DynamicPageFunc's live Pages don't mutate the registered
		// contribution (fn is re-evaluated fresh on every fetch).
		out := make([]Contribution, len(p.contribs))
		copy(out, p.contribs)
		for i := range out {
			if fn := p.pageFns[i]; fn != nil {
				out[i].Pages = fn(ctx)
			}
		}
		l.Contributions = out
		return l
	}
	var data, acts []*Node
	for _, m := range p.order {
		switch {
		case p.views[m].fn != nil, p.streams[m].fn != nil:
			data = append(data, Leaf(m))
		case p.actions[m].fn != nil:
			acts = append(acts, Leaf(m))
		}
	}
	var kids []*Node
	if len(data) > 0 {
		kids = append(kids, Section(p.name, data...))
	}
	if len(acts) > 0 {
		kids = append(kids, Section("Actions", acts...))
	}
	root := &Node{Kind: NodeSection, Children: kids}
	l.Contributions = []Contribution{{
		Surface: SurfaceContainer,
		Title:   p.name,
		Icon:    p.icon,
		Match:   &Match{}, // empty => the plugin's own container
		Node:    root,
	}}
	return l
}
