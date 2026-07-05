// Package store is hope's optional embedded state: a single bbolt file
// (pure Go, no external deps, CGO-free) at a mounted path. It unifies the small
// pieces of state hope keeps — the agent roster, the image-freshness cache,
// deploy stack specs, and runtime-added registry credentials — into named
// buckets.
//
// It follows the same "mount to persist, no-op if unmounted" contract as the
// deploy spec store: Open("") returns a live *Store whose every method is a safe
// no-op, so callers never branch on whether persistence is configured.
package store

import (
	"os"
	"path/filepath"
	"time"

	bolt "go.etcd.io/bbolt"
)

// DefaultDBFile is the db filename used when [store] path points at a directory.
const DefaultDBFile = "hope.db"

// Bucket names.
const (
	BucketAgents     = "agents"
	BucketUpdates    = "updates"
	BucketStacks     = "stacks"
	BucketRegistries = "registries"
	BucketPlugins    = "plugins"
)

var buckets = []string{BucketAgents, BucketUpdates, BucketStacks, BucketRegistries, BucketPlugins}

// Store wraps a bbolt DB. A nil db is the no-op store (path was empty).
type Store struct {
	db        *bolt.DB
	key       [32]byte // AES-256 key derived from token_secret (see secret.go); zero until SetSecret
	ephemeral bool     // path is on the container's rootfs, not a mounted volume (lost on recreate)
}

// Open opens (or creates) the bolt file at path and ensures the buckets exist.
// path=="" yields a no-op store (nil db) — every method succeeds and reads
// nothing, so persistence stays optional. The file is 0600 (it holds secrets).
func Open(path string) (*Store, error) {
	if path == "" {
		return &Store{}, nil
	}
	// A common setup is to mount a volume at e.g. /data and point [store] path at
	// the mount itself. If path is an existing directory, put the db file inside
	// it rather than trying to open the directory as a bolt file (which errors
	// with "is a directory").
	if fi, err := os.Stat(path); err == nil && fi.IsDir() {
		path = filepath.Join(path, DefaultDBFile)
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		for _, b := range buckets {
			if _, err := tx.CreateBucketIfNotExists([]byte(b)); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, ephemeral: onRootFS(path)}, nil
}

// Enabled reports whether the store is backed by a real file.
func (s *Store) Enabled() bool { return s != nil && s.db != nil }

// Ephemeral reports that the db lives on the container's rootfs rather than a
// mounted volume — so it'll be lost on a container recreate despite being
// "enabled". A common footgun: set [store] path but forget to mount the volume.
func (s *Store) Ephemeral() bool { return s.Enabled() && s.ephemeral }

// Close releases the file. Safe on a no-op store.
func (s *Store) Close() error {
	if !s.Enabled() {
		return nil
	}
	return s.db.Close()
}

// Get returns a copy of the value at bucket/key, or nil if absent / no-op.
func (s *Store) Get(bucket, key string) []byte {
	if !s.Enabled() {
		return nil
	}
	var out []byte
	_ = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return nil
		}
		if v := b.Get([]byte(key)); v != nil {
			out = append([]byte(nil), v...) // copy: bolt bytes are only valid in-tx
		}
		return nil
	})
	return out
}

// Put writes value at bucket/key. No-op (nil) when the store is disabled.
func (s *Store) Put(bucket, key string, value []byte) error {
	if !s.Enabled() {
		return nil
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists([]byte(bucket))
		if err != nil {
			return err
		}
		return b.Put([]byte(key), value)
	})
}

// Delete removes bucket/key. No-op when disabled.
func (s *Store) Delete(bucket, key string) error {
	if !s.Enabled() {
		return nil
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return nil
		}
		return b.Delete([]byte(key))
	})
}

// ForEach calls fn for every key/value in a bucket (value is a copy). No-op when
// disabled; a non-nil return from fn stops the walk and is returned.
func (s *Store) ForEach(bucket string, fn func(key, value []byte) error) error {
	if !s.Enabled() {
		return nil
	}
	return s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket))
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, v []byte) error {
			return fn(append([]byte(nil), k...), append([]byte(nil), v...))
		})
	})
}
