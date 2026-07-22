package audit

import "github.com/Toyz/sov/rpc"

// AuditRouter serves the fleet audit log to the UI — the "who did what, where, when"
// trail across core operations and plugin actions. Wire name: "Audit" (sov strips the
// required "Router" suffix). Auth is the gateway's global subject gate.
type AuditRouter struct{ auditor *Auditor }

// NewAuditRouter wires the query router to the shared Auditor.
func NewAuditRouter(a *Auditor) *AuditRouter { return &AuditRouter{auditor: a} }

// ListParams optionally filters the audit log; every field is a wildcard when empty.
type ListParams struct {
	Category string `json:"category"`
	Source   string `json:"source"`
	Host     string `json:"host"`
	Actor    string `json:"actor"`
	Target   string `json:"target"`
	Limit    int    `json:"limit"`
}

// List returns recent audit entries newest-first, optionally filtered. Empty (not an
// error) when the state store isn't mounted — there's simply nothing recorded.
func (r *AuditRouter) List(ctx *rpc.Context, p *ListParams) ([]Entry, error) {
	var f Filter
	if p != nil {
		f = Filter{Category: p.Category, Source: p.Source, Host: p.Host, Actor: p.Actor, Target: p.Target, Limit: p.Limit}
	}
	entries, err := r.auditor.Query(f)
	if err != nil {
		return nil, rpc.Internal("audit query: %v", err)
	}
	return entries, nil
}
