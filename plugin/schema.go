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
)

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
}

// ActionDesc describes an invocable action (a mutation). Danger flags a
// destructive action so hope confirms before running it.
type ActionDesc struct {
	Method string  `json:"method"`
	Label  string  `json:"label"`
	Icon   string  `json:"icon,omitempty"`
	Danger bool    `json:"danger,omitempty"`
	Fields []Field `json:"fields,omitempty"`
}

// ViewDesc describes a read-only data view and how to render it.
type ViewDesc struct {
	Method string   `json:"method"`
	Label  string   `json:"label"`
	Kind   ViewKind `json:"kind"`
	Icon   string   `json:"icon,omitempty"`
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
// wire is forward-compatible; hope v1 renders only SurfaceContainer and silently
// ignores the rest.
type Surface string

const (
	SurfaceContainer Surface = "container" // panel/tab in the container inspector (v1)
	SurfacePage      Surface = "page"      // full custom nav page (reserved)
	SurfaceRail      Surface = "rail"      // rail/nav entry + actions (reserved)
	SurfaceDashboard Surface = "dashboard" // dashboard widget (reserved)
	SurfaceStack     Surface = "stack"     // stack-view widget (reserved)
	SurfaceCommand   Surface = "command"   // command-palette entry (reserved)
)

// Layout is the result of the fixed hope.layout method: the plugin's UI
// contributions, versioned for graceful cross-version degradation.
type Layout struct {
	ProtocolVersion int            `json:"protocolVersion"`
	Contributions   []Contribution `json:"contributions"`
}

// Contribution mounts one layout tree onto a Surface. For container/stack
// surfaces, Match decides which containers it applies to.
type Contribution struct {
	Surface Surface `json:"surface"`
	Title   string  `json:"title,omitempty"` // tab/page title
	Icon    string  `json:"icon,omitempty"`
	Match   *Match  `json:"match,omitempty"`
	Node    *Node   `json:"node"`
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
	NodeRow     NodeKind = "row"     // horizontal arrangement
	NodeGrid    NodeKind = "grid"    // grid arrangement
	NodeLeaf    NodeKind = "leaf"    // a single view/action/stream
)

// Node is one node in the surface-agnostic layout tree. The same tree drives a
// container panel now and a full page later; hope's renderer walks it without
// caring which surface hosts it.
type Node struct {
	Kind     NodeKind `json:"kind"`
	Title    string   `json:"title,omitempty"`
	Ref      string   `json:"ref,omitempty"`  // leaf: method name of a view/action/stream
	Size     int      `json:"size,omitempty"` // optional row/grid weight
	Children []*Node  `json:"children,omitempty"`
}

// Section builds a titled section node from children.
func Section(title string, children ...*Node) *Node {
	return &Node{Kind: NodeSection, Title: title, Children: children}
}

// Tabs builds a tabbed node from children (each child's Title is its tab label).
func Tabs(children ...*Node) *Node {
	return &Node{Kind: NodeTabs, Children: children}
}

// Row builds a horizontal row from children.
func Row(children ...*Node) *Node { return &Node{Kind: NodeRow, Children: children} }

// Grid builds a grid from children.
func Grid(children ...*Node) *Node { return &Node{Kind: NodeGrid, Children: children} }

// Leaf references a registered view/action/stream by its method name.
func Leaf(ref string) *Node { return &Node{Kind: NodeLeaf, Ref: ref} }

// Titled sets a node's title (useful for wrapping a Leaf inside Tabs).
func (n *Node) Titled(t string) *Node { n.Title = t; return n }
