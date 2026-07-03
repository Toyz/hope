package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

// SetSecret derives the store's AES-256 key from hope's token_secret (already
// required in config), so secret-bearing values (registry passwords) are stored
// encrypted — a leaked hope.db isn't plaintext creds. Call once after Open.
func (s *Store) SetSecret(tokenSecret string) {
	s.key = sha256.Sum256([]byte(tokenSecret))
}

// Seal encrypts plaintext with AES-256-GCM, returning nonce||ciphertext.
func (s *Store) Seal(plaintext []byte) ([]byte, error) {
	gcm, err := s.gcm()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Unseal decrypts a nonce||ciphertext blob produced by Seal.
func (s *Store) Unseal(sealed []byte) ([]byte, error) {
	gcm, err := s.gcm()
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(sealed) < ns {
		return nil, errors.New("store: sealed value too short")
	}
	return gcm.Open(nil, sealed[:ns], sealed[ns:], nil)
}

func (s *Store) gcm() (cipher.AEAD, error) {
	block, err := aes.NewCipher(s.key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
