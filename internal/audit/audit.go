// Package audit is hope's reusable audit engine: one place every router records "who
// did what, to which resource, when, from where, and did it work". It supersedes the
// per-router audit logic (previously only plugin actions were recorded) so no caller
// duplicates sealing/pruning/actor-extraction — they just call Auditor.Record.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/store"
)

// Source is where an audited action originated.
const (
	SourceOperator = "operator" // an authenticated user, via the UI / API
	SourcePlugin   = "plugin"   // a plugin acting over the reverse channel
	SourceSystem   = "system"   // hope itself (automation: crawlers, reconcilers)
)

// Category groups entries by the kind of thing acted on, so the audit page can filter.
const (
	CatContainer = "container"
	CatStack     = "stack"
	CatImage     = "image"
	CatVolume    = "volume"
	CatNetwork   = "network"
	CatTunnel    = "tunnel"
	CatPlugin    = "plugin"
	CatAgent     = "agent"
	CatRegistry  = "registry"
)

// auditCap bounds the durable log; the oldest entries beyond it are pruned on append.
const auditCap = 5000

// seq disambiguates two entries stamped in the same nanosecond so their keys stay
// unique and still sort chronologically.
var seq atomic.Uint64

// Entry is one audited action — the unified record across core operations and plugin
// actions. hope owns every field except the plugin-supplied Action/Target semantics.
type Entry struct {
	Time     time.Time `json:"time"`
	Actor    string    `json:"actor"`            // authenticated subject (SourceOperator) or "plugin:<key>"
	Source   string    `json:"source"`           // operator | plugin | system
	Category string    `json:"category"`          // container | stack | image | ... (see Cat* )
	Action   string    `json:"action"`            // restart | redeploy | remove | enable | ...
	Host     string    `json:"host,omitempty"`    // fleet host id the action targeted
	Project  string    `json:"project,omitempty"` // the stack (compose project) it came from, when applicable
	Target   string    `json:"target,omitempty"`  // the specific resource: container name, image ref, plugin key, ...
	Detail   string    `json:"detail,omitempty"`  // optional short context line
	// Meta is optional structured extra data for the row flyout — and the hook for
	// tying arbitrary metadata to an event later. hope never interprets it; the UI
	// renders it in the detail flyout.
	Meta   json.RawMessage `json:"meta,omitempty"`
	Danger bool            `json:"danger,omitempty"` // a destructive action
	OK     bool            `json:"ok"`
	Err    string          `json:"err,omitempty"`
	Millis int64           `json:"ms,omitempty"`

	// Legacy fields from the pre-engine plugin audit, read (never written) so old
	// entries still render; normalized into Category/Action/Target by Query.
	LegacyPlugin string `json:"plugin,omitempty"`
	LegacyMethod string `json:"method,omitempty"`
}

// Auditor records and queries the fleet audit log. Durable via the sealed bbolt bucket
// when the store is mounted; a safe no-op (records drop, queries return empty) when not.
type Auditor struct{ store *store.Store }

// New builds an Auditor over the state store. A nil/disabled store makes every Record a
// no-op and every Query empty — audit degrades quietly, never blocks an operation.
func New(st *store.Store) *Auditor { return &Auditor{store: st} }

// Record persists one entry, best-effort. It stamps Time (now), fills Actor from ctx
// when the caller left it blank, and defaults Source to operator. A disabled store or a
// write error is swallowed — auditing must never fail the operation it records. Pass the
// handler's *rpc.Context as ctx so the subject can be read.
func (a *Auditor) Record(ctx context.Context, e Entry) {
	if a == nil || a.store == nil || !a.store.Enabled() {
		return
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	if e.Actor == "" {
		e.Actor = subjectOf(ctx)
	}
	if e.Source == "" {
		e.Source = SourceOperator
	}
	payload, err := json.Marshal(e)
	if err != nil {
		return
	}
	sealed, err := a.store.Seal(payload)
	if err != nil {
		return
	}
	key := fmt.Sprintf("%020d%06x", e.Time.UnixNano(), seq.Add(1)&0xffffff)
	if a.store.Put(store.BucketAudit, key, sealed) != nil {
		return
	}
	a.prune()
}

// Filter narrows a Query. Zero-value fields are wildcards.
type Filter struct {
	Category string
	Source   string
	Host     string
	Actor    string
	Target   string
	Limit    int // <=0 or over the cap => the cap
	Offset   int // skip this many of the newest matches first (paging)
}

// Query returns matching entries newest-first, capped. Empty when the store is disabled.
func (a *Auditor) Query(f Filter) ([]Entry, error) {
	if a == nil || a.store == nil || !a.store.Enabled() {
		return nil, nil
	}
	limit := f.Limit
	if limit <= 0 || limit > auditCap {
		limit = auditCap
	}
	var all []Entry
	err := a.store.ForEach(store.BucketAudit, func(_, value []byte) error {
		plain, uerr := a.store.Unseal(value)
		if uerr != nil {
			return nil // skip an unreadable entry rather than failing the whole query
		}
		var e Entry
		if json.Unmarshal(plain, &e) != nil {
			return nil
		}
		e.normalize()
		if f.Category != "" && e.Category != f.Category {
			return nil
		}
		if f.Source != "" && e.Source != f.Source {
			return nil
		}
		if f.Host != "" && e.Host != f.Host {
			return nil
		}
		if f.Actor != "" && e.Actor != f.Actor {
			return nil
		}
		if f.Target != "" && e.Target != f.Target {
			return nil
		}
		all = append(all, e)
		return nil
	})
	if err != nil {
		return nil, err
	}
	// all is oldest-first (keys sort chronologically); return newest-first, skipping
	// Offset of the newest for paging, then up to Limit.
	skip := f.Offset
	out := make([]Entry, 0, limit)
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		if skip > 0 {
			skip--
			continue
		}
		out = append(out, all[i])
	}
	return out, nil
}

// normalize maps a legacy plugin-audit entry (Plugin/Method) into the unified shape so
// pre-engine records render correctly alongside new ones.
func (e *Entry) normalize() {
	if e.Category == "" && e.LegacyPlugin != "" {
		e.Category = CatPlugin
	}
	if e.Source == "" && e.LegacyPlugin != "" {
		e.Source = SourcePlugin
	}
	if e.Action == "" && e.LegacyMethod != "" {
		e.Action = e.LegacyMethod
	}
	if e.Target == "" && e.LegacyPlugin != "" {
		e.Target = e.LegacyPlugin
	}
	e.LegacyPlugin, e.LegacyMethod = "", ""
}

// prune deletes the oldest entries beyond auditCap (keys iterate oldest-first).
func (a *Auditor) prune() {
	var keys []string
	_ = a.store.ForEach(store.BucketAudit, func(k, _ []byte) error {
		keys = append(keys, string(k))
		return nil
	})
	for i := 0; i < len(keys)-auditCap; i++ {
		_ = a.store.Delete(store.BucketAudit, keys[i])
	}
}

// ErrStr is the audit-friendly form of an error: its message, or "" when nil.
func ErrStr(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}

// subjectOf extracts the authenticated subject from a handler context. Returns "" when
// ctx isn't an rpc.Context (e.g. a background/system call) or carries no claims.
func subjectOf(ctx context.Context) string {
	if rc, ok := ctx.(*rpc.Context); ok {
		if c := rc.Claims(); c != nil {
			return c.Subject
		}
	}
	return ""
}
