// Package meme is a joke. MemeRouter.nodes returns the "status" of some very
// important infrastructure for the decorative strip on the login screen. It is
// intentionally public (no auth) — it's the login page, and it's a bit.
package meme

import "github.com/Toyz/sov/rpc"

// MemeRouter exposes the gag node-status endpoint. Wire name: "Meme".
type MemeRouter struct{}

// Node is one piece of critical infrastructure. status: ok | warn | bad | idle.
type Node struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Note   string `json:"note"`
}

// Nodes returns the current state of the fleet. PUBLIC — no RequireSubject.
func (r *MemeRouter) Nodes(_ *rpc.Context) ([]Node, error) {
	return nodes, nil
}

var nodes = []Node{
	{"skynet", "ok", "self-aware, behaving"},
	{"hal-9000", "warn", "won't open the pod bay doors"},
	{"the-cloud", "ok", "someone else's computer"},
	{"prod", "bad", "on fire (as usual)"},
	{"/dev/null", "ok", "100% uptime, stores everything"},
	{"blockchain", "idle", "still syncing"},
	{"magic-smoke", "bad", "escaped"},
	{"quantum-core", "warn", "both up and down"},
	{"left-pad", "bad", "unpublished again"},
	{"works-on-my-machine", "ok", "ships it"},
	{"the-mainframe", "ok", "cobol, immortal"},
	{"crypto-miner", "warn", "definitely not running"},
	{"rubber-duck", "ok", "debugging"},
	{"stack-overflow", "ok", "load-bearing"},
	{"coffee-machine", "bad", "CRITICAL"},
	{"tabs-vs-spaces", "warn", "flame war ongoing"},
	{"ai-overlord", "ok", "training"},
	{"y2k", "idle", "still waiting"},
	{"the-singularity", "warn", "loading..."},
	{"404-node", "idle", "not found"},
	{"schrodinger", "warn", "unobserved"},
	{"ping-pong-table", "ok", "fully operational"},
	{"the-matrix", "ok", "there is no node"},
	{"your-moms-server", "ok", "thicc uptime"},
}
