package catalog

import (
	"sort"
	"strings"
)

// TrustedImagePrefixes are the image prefixes a remote repo may name without being
// marked trusted. Keeps a compromised third-party manifest from offering a hostile
// image behind hope's install button.
var TrustedImagePrefixes = []string{"ghcr.io/toyz/"}

// trustedImage reports whether ref is under a trusted prefix.
func trustedImage(ref string) bool {
	for _, p := range TrustedImagePrefixes {
		if strings.HasPrefix(ref, p) {
			return true
		}
	}
	return false
}

// SourceEntries is one remote repo's fetched entries plus its trust flag. Name labels
// the origin (stamped onto each entry's Source for display).
type SourceEntries struct {
	Name    string
	Entries []CatalogEntry
	Trust   bool
}

// Merge folds the built-in entries with any number of remote repos: repos are applied
// in order, each overriding an earlier entry (or a built-in) of the same id, and adding
// new ids. Each entry is stamped with its Source (SourceBuiltin or the repo Name). An
// entry from an untrusted repo whose image is outside TrustedImagePrefixes is dropped
// (any prior entry of that id survives). Result is sorted by id.
func Merge(builtins []CatalogEntry, sources []SourceEntries) []CatalogEntry {
	byID := make(map[string]CatalogEntry)
	for _, e := range builtins {
		e.Source = SourceBuiltin
		byID[e.ID] = e
	}
	for _, src := range sources {
		for _, e := range src.Entries {
			if e.ID == "" || e.Image == "" {
				continue // malformed entry
			}
			if !src.Trust && !trustedImage(e.Image) {
				continue // untrusted repo naming an untrusted image — keep any prior entry
			}
			e.Source = src.Name
			byID[e.ID] = e
		}
	}
	out := make([]CatalogEntry, 0, len(byID))
	for _, e := range byID {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
