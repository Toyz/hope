package plugin

import (
	"context"
	"encoding/json"
)

// Storage is a handle to this plugin install's durable key/value store, persisted by
// hope. Values are opaque JSON hope never interprets, namespaced to this install's
// stable identity (two installs of the same image, or the same install on different
// hosts, are isolated; replicas of one install share it — last write wins). Requires
// the storage permission and hope's reverse channel; every op returns
// ErrNoReverseChannel until hope.init delivers a callback URL.
//
// Use it for config a stateless plugin has nowhere else to keep — e.g. alert rules the
// operator defined. It's for small config, not bulk data (hope caps value size).
type Storage struct{ p *Plugin }

// Storage returns this plugin's storage handle.
func (p *Plugin) Storage() *Storage { return &Storage{p: p} }

// Set stores v (JSON-encoded) at key.
func (s *Storage) Set(ctx context.Context, key string, v any) error {
	url, pkey, token := s.p.reverse()
	if url == "" || pkey == "" {
		return ErrNoReverseChannel
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = postReverse(ctx, url, token, "/rpc/_plugin/kv", map[string]any{"key": pkey, "op": "set", "k": key, "value": json.RawMessage(raw)})
	return err
}

// Get decodes the value at key into out. Returns (false, nil) when the key is absent.
func (s *Storage) Get(ctx context.Context, key string, out any) (bool, error) {
	url, pkey, token := s.p.reverse()
	if url == "" || pkey == "" {
		return false, ErrNoReverseChannel
	}
	raw, err := postReverse(ctx, url, token, "/rpc/_plugin/kv", map[string]any{"key": pkey, "op": "get", "k": key})
	if err != nil {
		return false, err
	}
	var resp struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return false, err
	}
	if len(resp.Value) == 0 || string(resp.Value) == "null" {
		return false, nil
	}
	if out != nil {
		if err := json.Unmarshal(resp.Value, out); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Delete removes key.
func (s *Storage) Delete(ctx context.Context, key string) error {
	url, pkey, token := s.p.reverse()
	if url == "" || pkey == "" {
		return ErrNoReverseChannel
	}
	_, err := postReverse(ctx, url, token, "/rpc/_plugin/kv", map[string]any{"key": pkey, "op": "del", "k": key})
	return err
}

// List returns the keys under prefix (empty prefix = all this plugin's keys).
func (s *Storage) List(ctx context.Context, prefix string) ([]string, error) {
	url, pkey, token := s.p.reverse()
	if url == "" || pkey == "" {
		return nil, ErrNoReverseChannel
	}
	raw, err := postReverse(ctx, url, token, "/rpc/_plugin/kv", map[string]any{"key": pkey, "op": "list", "prefix": prefix})
	if err != nil {
		return nil, err
	}
	var resp struct {
		Keys []string `json:"keys"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	return resp.Keys, nil
}
