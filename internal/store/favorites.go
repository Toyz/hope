package store

import "encoding/json"

// favoritesKey is the single key under BucketFavorites holding the rail's quick-jump
// list. The list is small and always read/written whole, so one sealed blob beats
// per-entry keys.
const favoritesKey = "list"

// Favorite is one rail quick-jump target: a whole stack (Service empty) or a single
// service within it. Keyed by the STABLE compose service, not a container id — an id
// churns on every redeploy, so the id is resolved live at navigation time. Stored in
// the state db so favorites follow the hope instance, not a browser.
type Favorite struct {
	Host    string `json:"host"`
	Project string `json:"project"`
	Service string `json:"service,omitempty"` // empty => the whole stack
	Label   string `json:"label"`
	Kind    string `json:"kind"` // "stack" | "container"
}

// Favorites returns the saved rail favorites — nil (not an error) when the store is
// disabled or nothing has been favorited yet.
func (s *Store) Favorites() ([]Favorite, error) {
	if !s.Enabled() {
		return nil, nil
	}
	raw := s.Get(BucketFavorites, favoritesKey)
	if raw == nil {
		return nil, nil
	}
	plain, err := s.Unseal(raw)
	if err != nil {
		return nil, err
	}
	var favs []Favorite
	if err := json.Unmarshal(plain, &favs); err != nil {
		return nil, err
	}
	return favs, nil
}

// SetFavorites replaces the saved rail favorites (the UI sends the whole list). No-op
// when the store is disabled.
func (s *Store) SetFavorites(favs []Favorite) error {
	if !s.Enabled() {
		return nil
	}
	payload, err := json.Marshal(favs)
	if err != nil {
		return err
	}
	sealed, err := s.Seal(payload)
	if err != nil {
		return err
	}
	return s.Put(BucketFavorites, favoritesKey, sealed)
}
