package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// DeriveToken returns a deterministic per-plugin bearer token: HMAC(store key,
// name). Because it's derived from hope's secret (the same one that seals the db)
// and the plugin's stable identity, it stays the SAME across disable/enable/forget
// — so the plugin's trust-on-first-use pin keeps matching instead of breaking when
// hope would otherwise mint a fresh random token. Unguessable without the secret.
func (s *Store) DeriveToken(name string) string {
	mac := hmac.New(sha256.New, s.key[:])
	mac.Write([]byte(name))
	return hex.EncodeToString(mac.Sum(nil))
}

// PluginRecord is a discovered container plugin the operator has acted on: its
// trust state (enabled + the fingerprint captured at enable time) and the
// per-plugin bearer token hope mints and presents on every call. The whole
// record is sealed at rest because it holds the token.
//
// The bucket key is the plugin's STABLE identity (host + compose project +
// service), not its container id — so trust survives a redeploy (new container,
// same identity) and two instances of the same image in different stacks stay
// distinct. The identity string is computed in internal/pluginhost.
type PluginRecord struct {
	Key         string    `json:"-"`    // bucket key: the stable identity string
	Host        string    `json:"host"` // fleet host id the plugin lives on
	Project     string    `json:"project"`
	Service     string    `json:"service"`
	ContainerID string    `json:"container_id"` // representative container at enable time
	Name        string    `json:"name"`         // plugin name/title captured at enable time
	Enabled     bool      `json:"enabled"`
	Fingerprint string    `json:"fingerprint"` // image digest at enable time (cheap fleet-wide stale check)
	SchemaHash  string    `json:"schema_hash"` // hash of hope.schema at enable time (catches runtime schema changes)
	Token       string    `json:"token"`       // per-plugin bearer secret hope presents
	EnabledAt   time.Time `json:"enabled_at"`
	// Settings holds the operator-managed setting VALUES for this plugin (the
	// plugin declares the schema via hope.schema; hope stores the values here and
	// pushes them to the plugin). Sealed with the rest of the record, so secret
	// settings are encrypted at rest.
	Settings map[string]string `json:"settings,omitempty"`
}

// PutPlugin persists (or replaces) a plugin record, sealed.
func (s *Store) PutPlugin(rec PluginRecord) error {
	if !s.Enabled() {
		return nil
	}
	payload, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	sealed, err := s.Seal(payload)
	if err != nil {
		return err
	}
	return s.Put(BucketPlugins, rec.Key, sealed)
}

// Plugin returns the record at key, or nil if absent / store disabled.
func (s *Store) Plugin(key string) (*PluginRecord, error) {
	if !s.Enabled() {
		return nil, nil
	}
	v := s.Get(BucketPlugins, key)
	if v == nil {
		return nil, nil
	}
	plain, err := s.Unseal(v)
	if err != nil {
		return nil, err
	}
	var rec PluginRecord
	if err := json.Unmarshal(plain, &rec); err != nil {
		return nil, err
	}
	rec.Key = key
	return &rec, nil
}

// Plugins returns all persisted plugin records (undecryptable/corrupt entries
// are skipped).
func (s *Store) Plugins() ([]PluginRecord, error) {
	var out []PluginRecord
	err := s.ForEach(BucketPlugins, func(key, value []byte) error {
		plain, err := s.Unseal(value)
		if err != nil {
			return nil
		}
		var rec PluginRecord
		if err := json.Unmarshal(plain, &rec); err != nil {
			return nil
		}
		rec.Key = string(key)
		out = append(out, rec)
		return nil
	})
	return out, err
}

// DisablePlugin flips a record's Enabled to false in place, re-reading it first so a
// concurrent SetSettings/Enable isn't clobbered by a stale in-memory copy (the
// caller may hold an old *PluginRecord). No-op if the record is gone.
func (s *Store) DisablePlugin(key string) error {
	rec, err := s.Plugin(key)
	if err != nil || rec == nil {
		return err
	}
	if !rec.Enabled {
		return nil
	}
	rec.Enabled = false
	return s.PutPlugin(*rec)
}

// DeletePlugin removes a plugin record (e.g. when the container is gone).
func (s *Store) DeletePlugin(key string) error {
	return s.Delete(BucketPlugins, key)
}
