package docker

import "maps"

// Exported compose + hope label keys, so other packages (internal/deploy) build
// on these instead of redefining the same string literals. The unexported
// aliases in docker.go keep internal call sites terse.
const (
	LabelProject = "com.docker.compose.project"
	LabelService = "com.docker.compose.service"
	LabelNumber  = "com.docker.compose.container-number"
	// LabelManaged marks a container/network/volume hope created via a deploy, so
	// the UI and teardown can tell hope-owned objects from externally-created ones.
	LabelManaged = "ink.hope.managed"
	// LabelSystem marks a hope-owned INFRASTRUCTURE network — the plugin bridge and
	// the tunnel fallback bridge. Distinct from LabelManaged (which also lands on
	// ordinary stack networks, which stay deletable): hope refuses to delete a network
	// carrying this, since removing it breaks plugin/tunnel connectivity.
	LabelSystem = "ink.hope.system"
)

// WithManaged tags labels with LabelManaged=1 (creating the map if needed).
func WithManaged(in map[string]string) map[string]string {
	out := map[string]string{LabelManaged: "1"}
	maps.Copy(out, in)
	return out
}
