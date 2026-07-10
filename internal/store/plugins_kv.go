package store

import "strings"

// Per-plugin opaque key/value storage (the p.Storage capability). hope persists bytes
// it never interprets, namespaced to the plugin's stable identity — the same "own no
// bespoke domain state" relationship as the token/approval it already holds. Values
// are sealed at rest (plugin config may carry secrets). Keys in the shared bucket are
// "<pluginKey>\x00<userKey>"; the NUL separator can't appear in either part.

const kvSep = "\x00"

func kvKey(pluginKey, k string) string { return pluginKey + kvSep + k }

// PutPluginKV stores (sealed) a value under a plugin's namespace. No-op if the store
// is disabled.
func (s *Store) PutPluginKV(pluginKey, k string, val []byte) error {
	if !s.Enabled() {
		return nil
	}
	sealed, err := s.Seal(val)
	if err != nil {
		return err
	}
	return s.Put(BucketPluginKV, kvKey(pluginKey, k), sealed)
}

// GetPluginKV returns the value at a plugin's key, or nil if absent / store disabled.
func (s *Store) GetPluginKV(pluginKey, k string) ([]byte, error) {
	if !s.Enabled() {
		return nil, nil
	}
	v := s.Get(BucketPluginKV, kvKey(pluginKey, k))
	if v == nil {
		return nil, nil
	}
	return s.Unseal(v)
}

// DeletePluginKV removes one key from a plugin's namespace.
func (s *Store) DeletePluginKV(pluginKey, k string) error {
	return s.Delete(BucketPluginKV, kvKey(pluginKey, k))
}

// ListPluginKV returns the user keys in a plugin's namespace matching prefix (the
// namespace + separator are stripped from the returned keys).
func (s *Store) ListPluginKV(pluginKey, prefix string) ([]string, error) {
	pfx := pluginKey + kvSep
	var keys []string
	err := s.ForEach(BucketPluginKV, func(key, _ []byte) error {
		ks := string(key)
		if !strings.HasPrefix(ks, pfx) {
			return nil
		}
		user := ks[len(pfx):]
		if strings.HasPrefix(user, prefix) {
			keys = append(keys, user)
		}
		return nil
	})
	return keys, err
}

// DeletePluginKVAll wipes a plugin's whole namespace (on Forget / record GC).
func (s *Store) DeletePluginKVAll(pluginKey string) error {
	pfx := pluginKey + kvSep
	var del []string
	if err := s.ForEach(BucketPluginKV, func(key, _ []byte) error {
		if strings.HasPrefix(string(key), pfx) {
			del = append(del, string(key))
		}
		return nil
	}); err != nil {
		return err
	}
	for _, k := range del {
		if err := s.Delete(BucketPluginKV, k); err != nil {
			return err
		}
	}
	return nil
}
