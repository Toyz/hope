package plugin

// This file defines the wire types hope reads from a plugin: the capability
// manifest (hope.schema) and the UI contribution descriptor (hope.layout). They
// are plain JSON structs on purpose — any language can produce the same shapes;
// this SDK is just the reference + fast path for Go authors.

// ProtocolVersion is the plugin-protocol version this SDK speaks. hope sends its
// own; a mismatch degrades gracefully (unknown surfaces/kinds are skipped) rather
// than breaking, so a new plugin still works against an older hope and vice-versa.
const ProtocolVersion = 1

// ViewKind tells hope how to render a view's returned data.
type ViewKind string

const (
	KV    ViewKind = "kv"    // flat key/value map -> hope-kvlist
	Table ViewKind = "table" // {columns, rows} -> paginated grid
	Query ViewKind = "query" // user-edited input -> tabular result grid (e.g. a SQL box)
	Tree  ViewKind = "tree"  // hierarchy -> tree browser (e.g. a schema)
	Chart ViewKind = "chart" // {type, labels, series} -> bar/line chart (see ChartData)
	Cards ViewKind = "cards" // {items:[Card]} -> a responsive grid of cards (a gallery)
	Stat  ViewKind = "stat"  // {stats:[Stat]} (or one Stat) -> big-number stat blocks (see StatData)
	Text  ViewKind = "text"  // {text:"…"} (or a raw string) -> a monospace scrollable block (logs, config, output)
	// Search is an autocomplete box: hope calls the method with {q: <typed text>} as the
	// user types (debounced) and renders the returned SearchItems as a live dropdown.
	// Selecting one navigates to its To (a DetailPage/link target) — a "go to X" jump.
	Search ViewKind = "search"
)

// SearchData is what a Search view returns for a query: the current suggestion list.
type SearchData struct {
	Items []SearchItem `json:"items"`
}

// SearchItem is one autocomplete suggestion. Label is the primary text; Sub is a dim
// secondary line (e.g. an id); Image is an optional thumbnail (absolute http(s) URL);
// To is where selecting it navigates — plugin-relative like a Link/DetailLink cell
// (e.g. "creator/42").
type SearchItem struct {
	Label string `json:"label"`
	Sub   string `json:"sub,omitempty"`
	Image string `json:"image,omitempty"`
	To    string `json:"to"`
}

// ChartData is what a Chart view returns: categorical labels on the x-axis and one
// or more named series of values. Type is "bar" (default) or "line". A line chart
// with one series and many points is a good time-series-at-rest view (use a stream
// for live). hope draws the axes, gridlines, legend, and scaling.
type ChartData struct {
	Type   string        `json:"type,omitempty"`
	Labels []string      `json:"labels"`
	Series []ChartSeries `json:"series"`
}

// ChartSeries is one named line/bar series; Values aligns with ChartData.Labels.
type ChartSeries struct {
	Name   string    `json:"name"`
	Values []float64 `json:"values"`
}

// TableData is what a Table view returns: the column names, the rows (each a slice of
// cells — plain scalars or rich cells like Badge/Link/Image), the total row count (for
// the pager; for a server table this is the full count, not len(Rows)), and optional
// hidden column names (kept in each row for row-detail/actions but not rendered). Build
// it with plugin.Table(...).
type TableData struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
	Total   int      `json:"total"`
	Hidden  []string `json:"hidden,omitempty"`
	// ColumnTips maps a column name to a hover tooltip on its header — for clarifying
	// a terse or computed column (e.g. "health": Tip("seq-scan / bloat state")).
	ColumnTips map[string]*Tooltip `json:"column_tips,omitempty"`
}

// KVData is what a KV view returns: a flat map of label -> value. A value may be a
// plain scalar or a rich cell (Badge/Link/Image/…). It's a named alias so a KV handler
// reads as returning KVData, while a map literal still satisfies it.
type KVData = map[string]any

// TextData is what a Text view returns: a block of monospace text (logs, config,
// command output). A Text handler may also return a raw string.
type TextData struct {
	Text string `json:"text"`
}

// CardsData is what a Cards view returns: a grid of cards.
type CardsData struct {
	Items []Card `json:"items"`
}

// Card is one tile in a Cards view. Fields render as a small label/value list (the
// values may be rich cells — Badge/Number/…). A non-empty To makes the card
// navigate on click (plugin-relative, like a Link cell — see DetailLink).
type Card struct {
	Title    string      `json:"title"`
	Subtitle string      `json:"subtitle,omitempty"`
	Icon     string      `json:"icon,omitempty"`
	Tone     string      `json:"tone,omitempty"` // ok|warn|bad|info accent
	To       string      `json:"to,omitempty"`
	Image    string      `json:"image,omitempty"` // absolute http(s) URL -> a hero image at the card top
	Fields   []CardField `json:"fields,omitempty"`
}

// CardField is one label/value line on a Card; Value may be a rich cell.
type CardField struct {
	Label string `json:"label"`
	Value any    `json:"value"`
}

// StatData is what a Stat view returns: one or more big-number stat blocks (counts,
// totals, sizes). Return {stats: [...]} for a row, or a single Stat.
type StatData struct {
	Stats []StatBlock `json:"stats"`
}

// StatBlock is one stat: a big Value with a Label, optional Unit, a Sub line (e.g. a
// delta or context), a semantic Tone, and an optional Icon.
type StatBlock struct {
	Label string   `json:"label"`
	Value any      `json:"value"`
	Unit  string   `json:"unit,omitempty"`
	Sub   string   `json:"sub,omitempty"`
	Tone  string   `json:"tone,omitempty"` // ok|warn|bad|info
	Icon  string   `json:"icon,omitempty"`
	Tip   *Tooltip `json:"tip,omitempty"` // hover tooltip explaining the metric (build with Tip)
}

// TipPos is where a tooltip points relative to its target.
type TipPos string

const (
	TipTop       TipPos = "top" // default
	TipBottom    TipPos = "bottom"
	TipTopEnd    TipPos = "top-end"
	TipBottomEnd TipPos = "bottom-end"
)

// Tooltip is hover help with an optional placement. Build one with Tip("text") or
// Tip("text", plugin.TipBottom). Empty Pos renders at the top.
type Tooltip struct {
	Text string `json:"text"`
	Pos  TipPos `json:"pos,omitempty"`
}

// Tip builds a Tooltip — hover help text with an optional placement (the author's
// control over where it points): Tip("Reclaims space", plugin.TipBottom). Extra pos
// args are ignored.
func Tip(text string, pos ...TipPos) *Tooltip {
	t := &Tooltip{Text: text}
	if len(pos) > 0 {
		t.Pos = pos[0]
	}
	return t
}

// StreamKind tells hope how to render a live NDJSON stream.
type StreamKind string

const (
	Counter StreamKind = "counter" // number(s) ticking -> stat
	Log     StreamKind = "log"     // append-only lines
	Series  StreamKind = "series"  // time series -> sparkline
)

// Option is a select choice, mirroring hope's PromptOption.
type Option struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// Field mirrors hope's PromptField: the UI collects these before invoking an
// action, then passes the values map to the action handler.
type Field struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Type        string   `json:"type,omitempty"` // text|textarea|select|toggle|kv (default text)
	Placeholder string   `json:"placeholder,omitempty"`
	Hint        string   `json:"hint,omitempty"`
	Value       string   `json:"value,omitempty"`
	Optional    bool     `json:"optional,omitempty"`
	Options     []Option `json:"options,omitempty"`
}

// Schema is the plugin's identity + capability manifest — the result of the fixed
// hope.schema method. It is the only method hope calls before the operator enables
// the plugin (discovery), so it must be safe to expose unauthenticated.
type Schema struct {
	ProtocolVersion int               `json:"protocolVersion"`
	Name            string            `json:"name"`
	Version         string            `json:"version"`
	Description     string            `json:"description,omitempty"`
	Icon            string            `json:"icon,omitempty"`  // default icon: a hope built-in OR an Icons key
	Icons           map[string]string `json:"icons,omitempty"` // plugin-scoped {name: inner-svg-markup}
	Actions         []ActionDesc      `json:"actions"`
	Views           []ViewDesc        `json:"views"`
	Streams         []StreamDesc      `json:"streams"`
	Settings        []Setting         `json:"settings,omitempty"` // operator-managed config (see Setting)
}

// SettingKind enumerates the input type for an operator-managed plugin setting.
type SettingKind string

const (
	SettingText     SettingKind = "text"
	SettingTextarea SettingKind = "textarea"
	SettingSelect   SettingKind = "select"
	SettingToggle   SettingKind = "toggle"
	SettingNumber   SettingKind = "number"
	SettingSecret   SettingKind = "secret" // masked input; hope stores it encrypted, never renders it back
)

// Setting is one operator-managed configuration field the plugin exposes. Unlike
// an action's Fields (per-invocation input), settings are configured once in the
// plugin inspector, persisted by hope (encrypted at rest), and pushed to the
// plugin via the reserved hope.settings method — read them in a handler with
// plugin.SettingValue(key). This is distinct from the plugin's rendered panel &
// metrics, which live on the container inspector: settings are what the operator
// CONFIGURES, the panel is what the plugin SHOWS.
type Setting struct {
	Key     string      `json:"key"`
	Label   string      `json:"label"`
	Kind    SettingKind `json:"kind,omitempty"` // default text
	Default string      `json:"default,omitempty"`
	Hint    string      `json:"hint,omitempty"`
	Options []Option    `json:"options,omitempty"` // for kind=select
}

// ActionDesc describes an invocable action (a mutation). Danger flags a
// destructive action so hope confirms before running it.
type ActionDesc struct {
	Method string   `json:"method"`
	Label  string   `json:"label"`
	Icon   string   `json:"icon,omitempty"`
	Danger bool     `json:"danger,omitempty"`
	Fields []Field  `json:"fields,omitempty"`
	Tip    *Tooltip `json:"tip,omitempty"` // hover tooltip on the action button (set with ActionTip)
}

// ViewDesc describes a read-only data view and how to render it.
type ViewDesc struct {
	Method  string   `json:"method"`
	Label   string   `json:"label"`
	Kind    ViewKind `json:"kind"`
	Icon    string   `json:"icon,omitempty"`
	Lang    string   `json:"lang,omitempty"`    // query views: syntax-highlight language (sql, json, …)
	Default string   `json:"default,omitempty"` // query views: initial text; {param} placeholders are filled from the page param
	// RowMethod (table/query views): a method hope calls to open a row-detail modal,
	// with params {row: {column: value}}. The result (kv or table) is shown in a
	// modal — a fully author-controlled row-detail RPC.
	RowMethod string `json:"row_method,omitempty"`
	// RowDetailButton triggers RowMethod from a dedicated per-row button instead of a
	// whole-row click. Use when the row body is otherwise interactive (e.g. inline-
	// editable cells) so the two don't fight.
	RowDetailButton bool `json:"row_detail_button,omitempty"`
	// RowActions (table/query views): per-row action buttons. hope renders each in a
	// trailing column (and in the row-detail modal); clicking one calls its Method
	// with {row: {column: value}} — an author-controlled mutation like "delete row".
	// A Danger action is confirmed first; on success hope refetches the table.
	RowActions []RowAction `json:"row_actions,omitempty"`
	// PageSize (table/query views) sets how many rows hope shows per page — the
	// author knows the shape of their data, so paging is plugin-level. 0 => hope's
	// default.
	PageSize int `json:"page_size,omitempty"`
	// EditMethod (table/query views): editing a cell calls this method with
	// {row: {column: value}, column, value}. Return ok (and optionally a message).
	// EditColumns limits which columns are editable (empty => all). An
	// author-controlled inline-edit RPC — hope refetches the table on success.
	EditMethod  string   `json:"edit_method,omitempty"`
	EditColumns []string `json:"edit_columns,omitempty"`
	// Server marks a table server-driven: hope does NOT ship every row and page in
	// the browser. Instead it sends the query state ({_q: {page, page_size, sort,
	// filter}}) on each call and expects one page back plus a total row count
	// ({columns, rows, total}). Required for tables too large to send whole — read
	// the query with plugin.ReadTableQuery.
	Server bool `json:"server,omitempty"`
	// Refresh adds a manual refresh button to the view header that re-fetches it —
	// e.g. a stat/counter you want to recompute on demand.
	Refresh bool `json:"refresh,omitempty"`
	// RefreshInterval auto-refetches the view every N seconds (0 = off) — a live-ish
	// view without a stream. hope stops the timer when the view leaves the DOM.
	RefreshInterval int `json:"refresh_interval,omitempty"`
	// Facets (server tables) are dropdown filters hope renders in the toolbar; the
	// selected values arrive in the query as filters[key] (see TableQuery.Filters),
	// which you apply in your store. Distinct from the free-text search box.
	Facets []Facet `json:"facets,omitempty"`
	// DefaultSort (server tables) is the sort hope applies on FIRST load, before the
	// user clicks any column header — e.g. newest-indexed first. hope seeds the query
	// state with it (so it arrives in TableQuery.Sort) and shows the arrow on that
	// column. The user can still re-sort. Column must be one your handler accepts.
	DefaultSort *SortSpec `json:"default_sort,omitempty"`
	// NoFilter hides the search box and NoSort makes column headers non-interactive —
	// for a plain paged list (a fixed order your handler controls, no user search/sort).
	NoFilter bool `json:"no_filter,omitempty"`
	NoSort   bool `json:"no_sort,omitempty"`
}

// SortSpec is a column + direction ("asc" | "desc"). Used for a table's DefaultSort.
type SortSpec struct {
	Column string `json:"column"`
	Dir    string `json:"dir"`
}

// Facet is one dropdown filter on a server table: a key, a label, and the choices.
type Facet struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Options []Option `json:"options"`
}

// RowAction is one author-declared action bound to a table row. hope calls Method
// with {row: {column: value}} (plus the page param); use for row-scoped mutations.
// If Fields is set, hope collects them first and merges the values into the call
// params alongside row — e.g. a "Rename" action with a new-name field.
type RowAction struct {
	Method string   `json:"method"`
	Label  string   `json:"label"`
	Icon   string   `json:"icon,omitempty"`
	Danger bool     `json:"danger,omitempty"` // hope confirms before running and audit-logs it
	Fields []Field  `json:"fields,omitempty"` // optional input collected before the call
	Tip    *Tooltip `json:"tip,omitempty"`    // hover tooltip on the row action button (build with Tip)
}

// StreamDesc describes a live stream and how to render it.
type StreamDesc struct {
	Method string     `json:"method"`
	Label  string     `json:"label"`
	Kind   StreamKind `json:"kind"`
	Icon   string     `json:"icon,omitempty"`
}

// --- UI contribution descriptor (hope.layout) ---------------------------------

// Surface names a mount point in the hope UI. The schema defines them all so the
// wire is forward-compatible; hope renders the surfaces it knows and silently
// ignores any it doesn't, so a newer plugin degrades gracefully on older hope.
type Surface string

const (
	SurfaceContainer Surface = "container" // panel/tab in the container inspector
	SurfacePage      Surface = "page"      // full custom nav page (+ dynamic nested pages)
	SurfaceRail      Surface = "rail"      // rail/nav entry + actions
	SurfaceDashboard Surface = "dashboard" // fleet/host dashboard widget
	SurfaceStack     Surface = "stack"     // stack-view widget (matched to the stack's containers)
	SurfaceCommand   Surface = "command"   // command-palette entry
)

// Layout is the result of the fixed hope.layout method: the plugin's UI
// contributions, versioned for graceful cross-version degradation.
type Layout struct {
	ProtocolVersion int            `json:"protocolVersion"`
	Contributions   []Contribution `json:"contributions"`
}

// Contribution mounts one layout tree onto a Surface. For container/stack
// surfaces, Match decides which containers it applies to. For page surfaces, Pages
// (optional) turns one node into MANY rail entries that share the layout but each
// pass a distinct Param.
type Contribution struct {
	Surface Surface    `json:"surface"`
	Title   string     `json:"title,omitempty"` // tab/page title
	Icon    string     `json:"icon,omitempty"`
	Match   *Match     `json:"match,omitempty"`
	Pages   []PageItem `json:"pages,omitempty"`
	Node    *Node      `json:"node"`
	// Actions are method names of registered actions shown as a toolbar at the top of
	// this surface (page/panel/dashboard header) — page-level actions distinct from
	// leaf actions inside the layout. hope collects fields, confirms danger, audits.
	Actions []string `json:"actions,omitempty"`
	// ID is a stable address for a page contribution, so links can target it by name
	// (a plugin does NOT know its hope key or a page's positional path). A DetailPage
	// sets ID + ParamKey and is Hidden from the rail; a Link/DetailLink navigates to
	// it plugin-relative, and hope passes the URL arg as param[ParamKey].
	ID       string `json:"id,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`    // not listed in the rail (a link/detail target)
	ParamKey string `json:"param_key,omitempty"` // detail pages: the URL arg becomes param[ParamKey]
	// Subtitle sets the page header's sub/meta line (page surfaces) — e.g. a record
	// count or a connection string. {param} placeholders are filled from the page
	// param. Empty => hope shows the plugin name.
	Subtitle string `json:"subtitle,omitempty"`
	// Breadcrumbs render above the page heading (page surfaces). Each Crumb's Label
	// and To may contain {param} placeholders hope fills from the page param — e.g.
	// on a user detail page, [{Users, users}, {"user {id}"}].
	Breadcrumbs []Crumb `json:"breadcrumbs,omitempty"`
}

// Crumb is one breadcrumb. To (optional) is a plugin-relative navigation target
// (like a Link cell / DetailLink); the last crumb is usually the current page and
// has no To. {param} placeholders in Label/To are filled from the page param.
type Crumb struct {
	Label string `json:"label"`
	To    string `json:"to,omitempty"`
}

// PageItem is one dynamic subpage: it shares the contribution's Node but carries
// its own Param, which hope merges into every call the page makes — so a plugin
// can list e.g. every DB table as a rail entry that renders the same view with a
// different argument. Read it in a handler with plugin.Params(ctx, &v).
//
// Children nests items one level (a group node), so e.g. three databases each
// listing their tables become nested rail entries. A node with Children is a
// group (not itself a page); a leaf node (no Children) is the navigable page.
type PageItem struct {
	Title    string         `json:"title"`
	Icon     string         `json:"icon,omitempty"`
	Param    map[string]any `json:"param,omitempty"`
	Children []PageItem     `json:"children,omitempty"`
}

// Match decides which containers a container/stack contribution applies to. The
// plugin declares this (hope does not map containers to plugins). A nil/empty
// Match means "the plugin's own container" — the trivial self-describing case.
// Semantics: set clauses are AND-ed; values within a clause are OR-ed.
type Match struct {
	Always   bool              `json:"always,omitempty"`   // every container
	Images   []string          `json:"images,omitempty"`   // image-ref globs, e.g. "postgres*"
	Labels   map[string]string `json:"labels,omitempty"`   // label == value
	Services []string          `json:"services,omitempty"` // compose service names
}

// NodeKind enumerates layout-tree node types. Containers hold Children; a leaf
// references a registered view/action/stream by method name.
type NodeKind string

const (
	NodeSection NodeKind = "section" // titled group
	NodeTabs    NodeKind = "tabs"    // tabbed children
	NodeRow     NodeKind = "row"     // horizontal arrangement (equal-width columns)
	NodeButtons NodeKind = "buttons" // horizontal group of action buttons, sized to content
	NodeGrid    NodeKind = "grid"    // grid arrangement
	NodeLeaf    NodeKind = "leaf"    // a single view/action/stream
)

// Node is one node in the surface-agnostic layout tree. The same tree drives a
// container panel now and a full page later; hope's renderer walks it without
// caring which surface hosts it.
type Node struct {
	Kind  NodeKind `json:"kind"`
	Title string   `json:"title,omitempty"`
	Ref   string   `json:"ref,omitempty"`  // leaf: method name of a view/action/stream
	Size  int      `json:"size,omitempty"` // optional row/grid weight
	Fill  bool     `json:"fill,omitempty"` // grow to fill the remaining height (e.g. a table)
	// Collapsible makes a titled section fold on a title click; Collapsed starts it
	// closed. For dense pages where not everything needs to be open at once.
	Collapsible bool    `json:"collapsible,omitempty"`
	Collapsed   bool    `json:"collapsed,omitempty"`
	Children    []*Node `json:"children,omitempty"`
}

// Section builds a titled section node from children.
func Section(title string, children ...*Node) *Node {
	return &Node{Kind: NodeSection, Title: title, Children: children}
}

// Tabs builds a tabbed node from children (each child's Title is its tab label).
func Tabs(children ...*Node) *Node {
	return &Node{Kind: NodeTabs, Children: children}
}

// Row builds a horizontal row from children — equal-width columns (each child gets
// an equal flex share). For a group of action buttons use Buttons instead, so they
// size to content and don't spread across the row.
func Row(children ...*Node) *Node { return &Node{Kind: NodeRow, Children: children} }

// Buttons builds a horizontal group of action buttons from action method refs. The
// buttons size to content and sit together (a toolbar), unlike Row's stretched
// columns — e.g. Buttons("analyze", "vacuum") for a maintenance section.
func Buttons(refs ...string) *Node {
	kids := make([]*Node, len(refs))
	for i, r := range refs {
		kids[i] = Leaf(r)
	}
	return &Node{Kind: NodeButtons, Children: kids}
}

// Grid builds a grid from children.
func Grid(children ...*Node) *Node { return &Node{Kind: NodeGrid, Children: children} }

// Leaf references a registered view/action/stream by its method name.
func Leaf(ref string) *Node { return &Node{Kind: NodeLeaf, Ref: ref} }

// Titled sets a node's title (useful for wrapping a Leaf inside Tabs).
func (n *Node) Titled(t string) *Node { n.Title = t; return n }

// Filled marks a node to grow and fill the remaining height (and propagates up its
// ancestors when rendered) — e.g. a table that should fill the page.
func (n *Node) Filled() *Node { n.Fill = true; return n }

// Weight sets a child's flex weight inside a Row (or Grid) — the WIDTH proportion it
// takes relative to its siblings. Default (0) means equal share. e.g. in a two-column
// Row, Weight(1) beside Weight(2) makes the second column twice as wide:
//
//	plugin.Row(
//	    plugin.Section("Overview", plugin.Leaf("head")).Weight(1),
//	    plugin.Section("Fields", plugin.Leaf("fields")).Weight(2),
//	)
func (n *Node) Weight(w int) *Node { n.Size = w; return n }

// Collapse makes a titled section fold on a title click. Pass collapsed=true to
// start it closed.
func (n *Node) Collapse(collapsed bool) *Node {
	n.Collapsible = true
	n.Collapsed = collapsed
	return n
}
