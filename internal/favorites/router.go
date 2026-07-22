// Package favorites serves the rail's quick-jump favorites (stacks/containers) from the
// state store, so a favorite follows the hope instance instead of living in one browser.
package favorites

import (
	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/store"
)

// FavoritesRouter reads and writes the rail favorites. Wire name: "Favorites" (sov
// strips the required "Router" suffix). Auth is the gateway's global subject gate.
type FavoritesRouter struct{ store *store.Store }

// NewFavoritesRouter wires the router to the state store.
func NewFavoritesRouter(st *store.Store) *FavoritesRouter { return &FavoritesRouter{store: st} }

// List returns the saved favorites in the order the UI last stored them.
func (r *FavoritesRouter) List(ctx *rpc.Context) ([]store.Favorite, error) {
	favs, err := r.store.Favorites()
	if err != nil {
		return nil, rpc.Internal("read favorites: %v", err)
	}
	return favs, nil
}

// SetParams carries the whole favorites list — the UI owns ordering + dedup and sends
// the full set on every change.
type SetParams struct {
	Favorites []store.Favorite `json:"favorites"`
}

// Set replaces the saved favorites. Requires the state store mounted (nowhere to persist
// otherwise).
func (r *FavoritesRouter) Set(ctx *rpc.Context, p *SetParams) (any, error) {
	if !r.store.Enabled() {
		return nil, rpc.BadRequest("favorites need the state store mounted ([store] path)")
	}
	var favs []store.Favorite
	if p != nil {
		favs = p.Favorites
	}
	if err := r.store.SetFavorites(favs); err != nil {
		return nil, rpc.Internal("save favorites: %v", err)
	}
	return map[string]any{"ok": true}, nil
}
