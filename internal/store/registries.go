package store

import "encoding/json"

// RegistryRecord is a runtime-added registry credential. On disk the whole
// {username,password} payload is sealed (AES-256-GCM, see secret.go); the server
// is the plaintext bucket key. In memory the fields are cleartext.
type RegistryRecord struct {
	Server   string `json:"-"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// PutRegistry seals and persists a registry credential under its server key.
// No-op (nil) when the store is disabled — the caller still applies it live for
// the session.
func (s *Store) PutRegistry(server, username, password string) error {
	if !s.Enabled() {
		return nil
	}
	payload, err := json.Marshal(RegistryRecord{Username: username, Password: password})
	if err != nil {
		return err
	}
	sealed, err := s.Seal(payload)
	if err != nil {
		return err
	}
	return s.Put(BucketRegistries, server, sealed)
}

// DeleteRegistry removes a persisted registry credential. No-op when disabled.
func (s *Store) DeleteRegistry(server string) error {
	return s.Delete(BucketRegistries, server)
}

// Registries returns every persisted registry credential, decrypted. Empty when
// the store is disabled. A record that fails to decrypt (wrong token_secret) is
// skipped rather than aborting the whole load.
func (s *Store) Registries() ([]RegistryRecord, error) {
	var out []RegistryRecord
	err := s.ForEach(BucketRegistries, func(key, value []byte) error {
		plain, err := s.Unseal(value)
		if err != nil {
			return nil // skip undecryptable entry (token_secret changed?)
		}
		var rec RegistryRecord
		if err := json.Unmarshal(plain, &rec); err != nil {
			return nil
		}
		rec.Server = string(key)
		out = append(out, rec)
		return nil
	})
	return out, err
}
