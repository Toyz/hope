package plugin

// Component views — the "escape hatch". The built-in view kinds (kv/table/chart/…)
// cover most admin UIs, but sometimes an author wants a custom widget hope doesn't
// have a kind for. Rather than ship raw HTML/JS (which hope never renders — plugins
// are data-only, so the browser is safe), a Component view returns a small tree of
// SAFE primitives that hope composes: boxes/stacks/rows/grids of headings, text,
// key/values, icons, sparklines, and the same rich Cells you already use in tables.
//
// It's the same primitive tree in two places:
//
//   - as a view (p.ComponentView) — dynamic, fetched like any other view, and a
//     good target for plugin.Static() so it caches;
//   - as an INLINE layout node (plugin.Component(...)) — the tree rides inside the
//     single hope.layout response, so it renders with ZERO extra round-trips (no
//     per-view Plugins.call). Use this for a small static dashboard/stack tile.
//
// Example — a compact fleet tile:
//
//	plugin.Box(
//	    plugin.Heading("Fleet", 3),
//	    plugin.CRow(
//	        plugin.KeyVal("nodes", plugin.Badge("3", plugin.ToneOK)),
//	        plugin.Sparkline(4, 8, 5, 9, 7),
//	    ),
//	    plugin.Divider(),
//	    plugin.CCell(plugin.Link("open dashboard", "dashboard")),
//	)
//
// Everything is typed data hope interprets; the primitives inherit hope's existing
// safety rails (tone allowlist, http(s)-only links/images, sanitized icons).

// CompKind names one primitive in a Component tree. Containers hold Children;
// terminals carry their own inline payload (text, a cell, values, an icon).
type CompKind string

const (
	CompBox       CompKind = "box"       // vertical container (a card/tile body)
	CompStack     CompKind = "stack"     // vertical container, tighter — labeled rows
	CompRow       CompKind = "row"       // horizontal container (children side by side)
	CompGrid      CompKind = "grid"      // responsive grid of children
	CompText      CompKind = "text"      // a line/paragraph of text
	CompHeading   CompKind = "heading"   // a heading (Level 1..4)
	CompDivider   CompKind = "divider"   // a horizontal rule
	CompSpacer    CompKind = "spacer"    // vertical gap of Size px
	CompKeyval    CompKind = "keyval"    // a Label + Value line (value may be a rich Cell)
	CompIcon      CompKind = "icon"      // a single icon (built-in name or an Icons key)
	CompSparkline CompKind = "sparkline" // a tiny inline line chart from Values
	CompCell      CompKind = "cell"      // any rich Cell (Badge/Link/Number/Time/Progress/Image)
	CompTable     CompKind = "table"     // an embedded table (rich cells, alignment, ellipsis)
	CompCard      CompKind = "card"      // a bordered card: header (icon/title/subtitle/tone stripe) + body children
)

// Comp is one node in a Component tree. Build nodes with the constructors below
// (Box/Stack/CRow/CGrid for containers; Heading/CText/KeyVal/CIcon/Sparkline/CCell
// for terminals) rather than filling this struct by hand. Unknown kinds are skipped
// by hope, never fatal, so a newer primitive degrades gracefully on an older hope.
type Comp struct {
	Kind     CompKind  `json:"kind"`
	Children []*Comp   `json:"children,omitempty"` // containers
	Text     string    `json:"text,omitempty"`     // text/heading content
	Label    string    `json:"label,omitempty"`    // keyval label
	Cell     Cell      `json:"cell,omitempty"`     // cell primitive: a rich Cell
	Value    any       `json:"value,omitempty"`    // keyval value (a scalar or a rich Cell)
	Level    int       `json:"level,omitempty"`    // heading level 1..4
	Tone     string    `json:"tone,omitempty"`     // ok|warn|bad|info accent (text/heading/keyval/box)
	Icon     string    `json:"icon,omitempty"`     // icon primitive
	Values   []float64 `json:"values,omitempty"`   // sparkline points
	Gap      int        `json:"gap,omitempty"`   // container child gap, px
	Size     int        `json:"size,omitempty"`  // row/grid child weight | spacer height px
	Table    *TableData `json:"table,omitempty"` // embedded table (CompTable)
}

// Box builds a vertical container (a tile/card body) from children.
func Box(children ...*Comp) *Comp { return &Comp{Kind: CompBox, Children: children} }

// Stack builds a tight vertical container — good for a run of KeyVal lines.
func Stack(children ...*Comp) *Comp { return &Comp{Kind: CompStack, Children: children} }

// CRow builds a horizontal container (children laid out left-to-right). Named CRow
// (not Row) because Row already builds a layout Node; a Comp tree uses CRow.
func CRow(children ...*Comp) *Comp { return &Comp{Kind: CompRow, Children: children} }

// CGrid builds a responsive grid of children (see CRow on the C-prefix).
func CGrid(children ...*Comp) *Comp { return &Comp{Kind: CompGrid, Children: children} }

// Heading builds a heading; level is clamped to 1..4 by hope (1 = largest).
func Heading(text string, level int) *Comp { return &Comp{Kind: CompHeading, Text: text, Level: level} }

// CText builds a line/paragraph of text (auto-escaped by hope). C-prefixed because
// Text is already a ViewKind constant.
func CText(s string) *Comp { return &Comp{Kind: CompText, Text: s} }

// Divider builds a horizontal rule between sections of a tile.
func Divider() *Comp { return &Comp{Kind: CompDivider} }

// Spacer builds a vertical gap of px pixels.
func Spacer(px int) *Comp { return &Comp{Kind: CompSpacer, Size: px} }

// KeyVal builds a label + value line. value may be a plain scalar or a rich Cell
// (Badge/Number/…); the `any` mirrors Number's signature — hope renders a Cell
// specially and stringifies a scalar.
func KeyVal(label string, value any) *Comp { return &Comp{Kind: CompKeyval, Label: label, Value: value} }

// CIcon builds a single icon (a hope built-in name or one of this plugin's Icons
// keys). C-prefixed to leave room for future top-level icon helpers.
func CIcon(name string) *Comp { return &Comp{Kind: CompIcon, Icon: name} }

// Sparkline builds a tiny inline line chart from the given points.
func Sparkline(vals ...float64) *Comp { return &Comp{Kind: CompSparkline, Values: vals} }

// CCell wraps any rich Cell (Badge/Link/Number/Time/Progress/Code/Image) as a
// standalone primitive, so the whole cell vocabulary works inside a Component tree.
func CCell(cell Cell) *Comp { return &Comp{Kind: CompCell, Cell: cell} }

// CTable embeds a full table inside a Component tree — column headers, aligned cells,
// ellipsis, DetailLink/Image cells, all rendered by hope's table renderer. Build the data
// with plugin.Table(...). Ideal for a compact list-with-structure inside a flyout/panel
// (e.g. the badges on a canvas) instead of hand-stacking rows.
func CTable(data *TableData) *Comp { return &Comp{Kind: CompTable, Table: data} }

// Toned sets a semantic accent (ToneOK/Warn/Bad/Info) on a node — a colored heading,
// a tinted box border, a status-colored keyval.
func (c *Comp) Toned(tone string) *Comp { c.Tone = tone; return c }

// CCard builds a bordered card: a header (icon/title/subtitle + a tone stripe) over a body
// of child components — the good default "item" to render in a grid or a paged collection.
// C-prefixed (Card is already the data-card type). Chain .Ico/.Sub/.Toned for the header.
func CCard(title string, body ...*Comp) *Comp { return &Comp{Kind: CompCard, Text: title, Children: body} }

// Ico sets a card's (or any node's) leading icon — a hope built-in name or an Icons key.
func (c *Comp) Ico(name string) *Comp { c.Icon = name; return c }

// Sub sets a card's subtitle (the smaller line under its title).
func (c *Comp) Sub(text string) *Comp { c.Label = text; return c }

// Gapped sets the gap (px) between a container's children.
func (c *Comp) Gapped(px int) *Comp { c.Gap = px; return c }

// Weight sets a child's flex/grid weight inside a CRow/CGrid (0 = equal share),
// mirroring a layout Node's Weight.
func (c *Comp) Weight(n int) *Comp { c.Size = n; return c }
