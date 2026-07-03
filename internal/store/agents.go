package store

import (
	"encoding/json"
	"time"
)

// AgentRecord is a lightweight, persisted record of a known agent so the Agents
// page can show it (last seen, build info) even while it's disconnected. It
// holds no secrets — enrollment stays token-based — so it's stored as plain JSON.
type AgentRecord struct {
	ID          string    `json:"-"` // bucket key
	Remote      string    `json:"remote"`
	Version     string    `json:"version"`
	Revision    string    `json:"revision"`
	GoVersion   string    `json:"go_version"`
	Platform    string    `json:"platform"`
	BuildTime   string    `json:"build_time"`
	ContainerID string    `json:"container_id"`
	LastSeen    time.Time `json:"last_seen"`
}

// PutAgent persists (or updates) an agent record under its id. No-op when the
// store is disabled.
func (s *Store) PutAgent(rec AgentRecord) error {
	if !s.Enabled() {
		return nil
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return s.Put(BucketAgents, rec.ID, data)
}

// Agents returns every known agent record. Empty when the store is disabled.
func (s *Store) Agents() ([]AgentRecord, error) {
	var out []AgentRecord
	err := s.ForEach(BucketAgents, func(key, value []byte) error {
		var rec AgentRecord
		if err := json.Unmarshal(value, &rec); err != nil {
			return nil // skip a corrupt record rather than failing the list
		}
		rec.ID = string(key)
		out = append(out, rec)
		return nil
	})
	return out, err
}

// DeleteAgent forgets a known agent (operator removed it). No-op when disabled.
func (s *Store) DeleteAgent(id string) error {
	return s.Delete(BucketAgents, id)
}
