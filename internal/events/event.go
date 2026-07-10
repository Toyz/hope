// Package events is hope's in-process event bus: producers across the daemon
// publish state-change events, and a single NDJSON RouteHandler (/rpc/_events)
// fans them out live to the frontend so the rail/sidebar and pages update without
// a manual refresh. It is deliberately tiny and stdlib-only — the whole point is a
// non-blocking, replay-capable fan-out with no external dependency.
//
// The bus is also the substrate the plugin tiers build on (plugins subscribe to
// and publish onto it, and pluginhost consumes it for record GC) — see the
// event-bus plan.
package events

import "encoding/json"

// Kind is the event discriminator. Core hope kinds are namespaced by dotted area
// (stack.*, container.*, image.*, plugin.*, tunnel.*, agent.*); plugin-published
// kinds are namespaced plugin.<identity>.<name> server-side (never spoofable).
// Two feed-only control kinds (ping/resync) ride the same frame shape.
type Kind string

const (
	// Control frames (feed-only; not real state changes). The client ignores a
	// ping and does one full refetch on a resync.
	KindPing   Kind = "ping"
	KindResync Kind = "resync"

	// Core producer kinds. Data carries kind-specific detail when useful.
	KindStackDeployed    Kind = "stack.deployed"
	KindStackRedeployed  Kind = "stack.redeployed"
	KindStackDestroyed   Kind = "stack.destroyed"
	KindContainerRemoved Kind = "container.removed"
	KindContainerState   Kind = "container.state"
	KindImageUpdate      Kind = "image.update"  // a freshness verdict flipped to outdated
	KindImageCurrent     Kind = "image.current" // ...or back to current
	KindPluginChanged    Kind = "plugin.changed"
	KindTunnelChanged    Kind = "tunnel.changed"
	KindAgentOnline      Kind = "agent.online"
	KindAgentOffline     Kind = "agent.offline"
)

// SourceHope is the Source on every core (hope-originated) event. Plugin-published
// events carry "plugin.<identity>" instead, stamped by hope at ingest.
const SourceHope = "hope"

// Event is one bus frame. Seq/Ts are stamped by the bus on Publish; producers fill
// only the fields that scope the change. All-but-Kind are optional so a producer
// call site stays a one-liner, and the same struct doubles as the wire frame.
type Event struct {
	Seq     uint64          `json:"seq,omitempty"`
	Kind    Kind            `json:"kind"`
	Host    string          `json:"host,omitempty"`
	Project string          `json:"project,omitempty"`
	IDs     []string        `json:"ids,omitempty"`
	Source  string          `json:"source,omitempty"`
	Ts      int64           `json:"ts,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}
