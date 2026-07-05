package store

import (
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"
)

// auditCap bounds the plugin audit log so a busy fleet can't grow the db without
// limit; the oldest entries beyond this are pruned on append.
const auditCap = 2000

// auditSeq disambiguates two entries stamped in the same nanosecond so their bucket
// keys stay unique (and still sort chronologically).
var auditSeq atomic.Uint64

// AuditEntry is one audited plugin invocation — hope records these for action
// (mutation) calls, especially destructive ones, so the operator has a who/what/
// where/when trail of everything a plugin was asked to do through the control plane.
type AuditEntry struct {
	Time   time.Time `json:"time"`
	Actor  string    `json:"actor"`  // authenticated subject that triggered the call
	Plugin string    `json:"plugin"` // stable plugin identity (host + project/service)
	Host   string    `json:"host"`
	Method string    `json:"method"`
	Danger bool      `json:"danger"` // author flagged the action destructive
	OK     bool      `json:"ok"`
	Err    string    `json:"err,omitempty"`
	Millis int64     `json:"ms"`
}

// AppendAudit records one audited invocation (no-op when the store is disabled) and
// prunes the log back to auditCap. Keys are zero-padded nanos + a sequence so they
// sort chronologically and never collide.
func (s *Store) AppendAudit(e AuditEntry) error {
	if !s.Enabled() {
		return nil
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	sealed, err := s.Seal(payload)
	if err != nil {
		return err
	}
	key := fmt.Sprintf("%020d%06x", e.Time.UnixNano(), auditSeq.Add(1)&0xffffff)
	if err := s.Put(BucketAudit, key, sealed); err != nil {
		return err
	}
	s.pruneAudit()
	return nil
}

// pruneAudit deletes the oldest entries beyond auditCap. Cheap enough at human
// action cadence; keys iterate oldest-first so we drop the leading overflow.
func (s *Store) pruneAudit() {
	var keys []string
	_ = s.ForEach(BucketAudit, func(k, _ []byte) error {
		keys = append(keys, string(k))
		return nil
	})
	for i := 0; i < len(keys)-auditCap; i++ {
		_ = s.Delete(BucketAudit, keys[i])
	}
}

// AuditLog returns the most recent audited invocations, newest first, capped at
// limit (<=0 => auditCap). Filters to one plugin key when plugin != "".
func (s *Store) AuditLog(plugin string, limit int) ([]AuditEntry, error) {
	if !s.Enabled() {
		return nil, nil
	}
	if limit <= 0 || limit > auditCap {
		limit = auditCap
	}
	var all []AuditEntry
	err := s.ForEach(BucketAudit, func(_, value []byte) error {
		plain, uerr := s.Unseal(value)
		if uerr != nil {
			return nil
		}
		var e AuditEntry
		if json.Unmarshal(plain, &e) != nil {
			return nil
		}
		if plugin == "" || e.Plugin == plugin {
			all = append(all, e)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// all is oldest-first; return newest-first, capped.
	out := make([]AuditEntry, 0, limit)
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, all[i])
	}
	return out, nil
}
