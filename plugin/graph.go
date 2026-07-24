package plugin

// Graph view — the spatial / blueprint surface. hope ships no node types; the plugin defines
// each node (title, ports, an arbitrary Comp body) via these builders, returns a GraphData
// from the view function, and registers mutation methods (move/connect/delete/add) that hope
// calls as the operator edits the canvas. See ViewKind Graph + GraphData in schema.go.

// GraphView registers a Graph view (clone of ChartView with Kind: Graph). The function returns
// a *GraphData. Pair with the Graph* opts to wire editing, a node-click flyout, a run stream,
// and the plugin-controlled chrome (sidebar / toolbar / palette). A bare GraphView with no
// mutation opts is a read-only canvas.
func (p *Plugin) GraphView(method, label string, fn ViewFunc, opts ...GraphOpt) *Plugin {
	return p.View(method, label, Graph, fn, opts...)
}

// GraphOpt configures a Graph view's descriptor (a functional option, composes with ViewOpt).
type GraphOpt = TableOpt

// --- mutation / behavior opts (method refs hope calls with {row:{...}}) ---

// GraphMove names the method hope calls to persist a dragged node's position: {id, x, y}.
func GraphMove(method string) GraphOpt { return func(v *ViewDesc) { v.GraphMove = method } }

// GraphConnect names the method hope calls to add an edge: {from:"nodeID:portID", to:"nodeID:portID"}.
func GraphConnect(method string) GraphOpt { return func(v *ViewDesc) { v.GraphConnect = method } }

// GraphDisconnect names the method hope calls to remove an edge: {from, to}.
func GraphDisconnect(method string) GraphOpt { return func(v *ViewDesc) { v.GraphDisconnect = method } }

// GraphDelete names the method hope calls to delete a node: {id}. Confirm it with a DangerAction.
func GraphDelete(method string) GraphOpt { return func(v *ViewDesc) { v.GraphDelete = method } }

// GraphAdd names the method hope calls to create a node — with the picked palette {type, x, y},
// or {type:"", x, y} from a double-click on empty canvas (your default node).
func GraphAdd(method string) GraphOpt { return func(v *ViewDesc) { v.GraphAdd = method } }

// GraphNodeFlyout names the method hope calls when a node is clicked: {id} -> a Comp body it
// renders in the right-side drawer. (A node with a config Form opens that form instead.)
func GraphNodeFlyout(method string) GraphOpt { return func(v *ViewDesc) { v.GraphNodeFlyout = method } }

// GraphConfig names the method hope calls to persist a node's config Form: {id, ...values}.
// Required for GNode(...).Form(...) node inputs to save.
func GraphConfig(method string) GraphOpt { return func(v *ViewDesc) { v.GraphConfig = method } }

// GraphMenu names the method hope calls on right-click to build a custom context menu. It
// receives the target ({kind:"node"|"edge"|"canvas", id/from/to}) and returns []GraphMenuItem;
// hope shows them under its own built-ins (Configure / Delete node / Disconnect). Each item's
// Method is invoked with the target's row.
func GraphMenu(method string) GraphOpt { return func(v *ViewDesc) { v.GraphMenu = method } }

// GraphValidateConnect names an optional pre-connect gate: {from, to} -> a ConfirmResult-ish
// {ok bool, reason string}. hope only commits the connection when ok.
func GraphValidateConnect(method string) GraphOpt {
	return func(v *ViewDesc) { v.GraphValidateConnect = method }
}

// GraphRun names a StreamComponent-kind stream that emits GraphData frames while a run is
// active — the plugin advances each node's State so hope highlights progress live.
func GraphRun(streamMethod string) GraphOpt { return func(v *ViewDesc) { v.GraphRun = streamMethod } }

// --- plugin-controlled chrome regions ---

// GraphSidebar names a method returning a Comp for the left rail — the natural home for a
// browsable list of the plugin's DAGs. Pair with GraphSelect to switch the active graph.
func GraphSidebar(method string) GraphOpt { return func(v *ViewDesc) { v.GraphSidebar = method } }

// GraphToolbar names a method returning a Comp for the strip above the canvas.
func GraphToolbar(method string) GraphOpt { return func(v *ViewDesc) { v.GraphToolbar = method } }

// GraphSidebarActions renders the given action methods as buttons atop the sidebar — the home
// for "New pipeline" / "New folder" and the like. Each runs like any action (fields, confirm);
// on success hope re-fetches the sidebar + the graph.
func GraphSidebarActions(methods ...string) GraphOpt {
	return func(v *ViewDesc) { v.GraphSidebarActions = methods }
}

// GraphSelect names the method hope calls when a sidebar entry is chosen: {id}. The canvas then
// re-fetches with {graph: id} so selecting a DAG swaps the canvas in place.
func GraphSelect(method string) GraphOpt { return func(v *ViewDesc) { v.GraphSelect = method } }

// GraphPalette names a method returning the []NodeType catalog — the node types the operator
// can drag onto the canvas. For a fixed catalog use StaticPalette instead.
func GraphPalette(method string) GraphOpt { return func(v *ViewDesc) { v.GraphPalette = method } }

// StaticPalette sets a fixed node-type catalog on the view (alternative to GraphPalette).
func StaticPalette(types ...NodeType) GraphOpt { return func(v *ViewDesc) { v.Palette = types } }

// GraphDirected draws arrowheads on edges (a directed graph).
func GraphDirected() GraphOpt { return func(v *ViewDesc) { v.GraphDirected = true } }

// GraphSnap snaps dragged nodes to an N-px grid (0 = free positioning).
func GraphSnap(px int) GraphOpt { return func(v *ViewDesc) { v.GraphSnap = px } }

// --- node / port / edge builders ---

// GNode builds a node: an id + title, with any body components rendered in the node card.
// Chain .At/.Typed/.Ico/.Toned/.Wide/.InPorts/.OutPorts/.Stated/.With.
func GNode(id, title string, body ...*Comp) *GraphNode {
	var b *Comp
	if len(body) == 1 {
		b = body[0]
	} else if len(body) > 1 {
		b = Box(body...)
	}
	return &GraphNode{ID: id, Title: title, Body: b}
}

// At sets the node's canvas position.
func (n *GraphNode) At(x, y float64) *GraphNode { n.X, n.Y = x, y; return n }

// Typed sets the node's plugin-defined type name (metadata; drives nothing in hope).
func (n *GraphNode) Typed(t string) *GraphNode { n.Type = t; return n }

// Ico sets the node's leading icon (a built-in name or a plugin Icons key).
func (n *GraphNode) Ico(name string) *GraphNode { n.Icon = name; return n }

// Toned sets the node's accent tone.
func (n *GraphNode) Toned(tone string) *GraphNode { n.Tone = tone; return n }

// Wide sets the node's width in px.
func (n *GraphNode) Wide(px int) *GraphNode { n.W = px; return n }

// WithMeta appends a key/value line to the node's clean meta strip (its params/config),
// rendered on the node face. Chainable: n.WithMeta("mode", "dedupe").WithMeta("parallel", "4").
func (n *GraphNode) WithMeta(label, value string) *GraphNode {
	n.Meta = append(n.Meta, NodeMeta{Label: label, Value: value})
	return n
}

// InPorts sets the node's input ports (rendered down the left edge).
func (n *GraphNode) InPorts(ports ...Port) *GraphNode { n.In = ports; return n }

// OutPorts sets the node's output ports (rendered down the right edge).
func (n *GraphNode) OutPorts(ports ...Port) *GraphNode { n.Out = ports; return n }

// Stated sets the node's run state (idle|running|done|error) — the run glow.
func (n *GraphNode) Stated(s string) *GraphNode { n.State = s; return n }

// With attaches opaque data echoed back to the mutation methods.
func (n *GraphNode) With(data map[string]any) *GraphNode { n.Data = data; return n }

// Form gives the node a config form — the same dynamic Fields as an action (a select with
// OptionsMethod, number, multiselect, ...). Clicking the node opens it, prefilled from Data;
// saving calls the view's GraphConfig method with {id, ...values}.
func (n *GraphNode) Form(fields ...Field) *GraphNode { n.Fields = fields; return n }

// GPort builds a port. Chain .Kinded (typing for connect-validation) / .Toned.
func GPort(id, label string) Port { return Port{ID: id, Label: label} }

// Kinded sets a port's connection type (matched by GraphValidateConnect).
func (p Port) Kinded(kind string) Port { p.Kind = kind; return p }

// Toned sets a port's tone. (Value receiver: use in a builder chain, e.g. GPort(...).Toned("ok").)
func (p Port) Toned(tone string) Port { p.Tone = tone; return p }

// GEdge builds an edge between "nodeID:portID" endpoints. Chain .Toned / .Labeled.
func GEdge(from, to string) GraphEdge { return GraphEdge{From: from, To: to} }

// Toned sets an edge's tone.
func (e GraphEdge) Toned(tone string) GraphEdge { e.Tone = tone; return e }

// Labeled sets an edge's label.
func (e GraphEdge) Labeled(label string) GraphEdge { e.Label = label; return e }
