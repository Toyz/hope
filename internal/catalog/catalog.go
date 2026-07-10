// Package catalog is hope's installable-plugin catalog: the machine-readable
// descriptors that let hope DEPLOY a first-party plugin (pull the image, create the
// container with the right labels/env/volumes/networks), as opposed to merely
// DISCOVERING one an operator already ran. Entries come from a built-in list plus an
// optional remote JSON manifest (same schema) fetched from an upstream URL, so the
// catalog is extensible without shipping a new hope build.
//
// A catalog entry describes only what hope can't learn from a not-yet-running
// container — image, env inputs, volumes, labels, port/path — plus value-only setting
// seeds. What the plugin DOES once running (views, actions, setting descriptors) still
// comes from its live hope.schema.
package catalog

// Option is one choice for a kind=select env field (label shown, value submitted).
// Mirrors plugin.Option / the settings Option shape so the frontend renders it the
// same way.
type Option struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// EnvField is one machine-readable env/config input the install wizard renders. Kind
// mirrors the plugin SDK's Setting/Field kinds so the existing prompt-form draws it.
type EnvField struct {
	Key         string   `json:"key"`            // env var name, e.g. "DATABASE_URL"
	Label       string   `json:"label"`          // form label
	Kind        string   `json:"kind,omitempty"` // "" text | select | toggle | number | secret
	Required    bool     `json:"required,omitempty"`
	Default     string   `json:"default,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Hint        string   `json:"hint,omitempty"`
	Options     []Option `json:"options,omitempty"` // kind=select: the ONLY allowed values
}

// VolumeMount declares storage a plugin needs. A "volume" (default) is a named volume
// hope auto-creates and mounts (persists across recreate); a "bind" is a host path the
// user supplies at install (must exist on the target host).
type VolumeMount struct {
	Target   string `json:"target"`         // mount path in the container, e.g. "/data"
	Name     string `json:"name,omitempty"` // volume name (default derived from the instance)
	Type     string `json:"type,omitempty"` // "" volume (auto-created) | "bind"
	ReadOnly bool   `json:"read_only,omitempty"`
	Hint     string `json:"hint,omitempty"`
}

// SettingSeed is a value-only initial setting applied once after install (via the
// hope.init handshake), overriding the plugin author's Default. It deliberately carries
// NO kind/options/label — the plugin's own hope.schema Setting descriptors remain the
// single source of truth for what settings exist and how they render.
type SettingSeed struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// CatalogEntry is one installable plugin.
type CatalogEntry struct {
	ID          string            `json:"id"`             // stable slug, e.g. "hope-redis"
	Title       string            `json:"title"`          // hope.plugin.title
	Icon        string            `json:"icon,omitempty"` // hope.plugin.icon
	Description string            `json:"description,omitempty"`
	Image       string            `json:"image"`          // e.g. ghcr.io/toyz/hope-redis:latest
	Port        int               `json:"port,omitempty"` // hope.plugin.port (default 8080)
	Path        string            `json:"path,omitempty"` // hope.plugin.path (default /__hope)
	Env         []EnvField        `json:"env,omitempty"`
	Volumes     []VolumeMount     `json:"volumes,omitempty"`
	Settings    []SettingSeed     `json:"settings,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"` // extra static container labels
	// Permissions the plugin will request (its reverse-channel scopes) — declared here
	// so the marketplace can DISCLOSE them before install and the operator accepts at
	// install time. Should match the plugin's own RequirePermission; the authoritative
	// gate remains the per-scope consent at enable, this is the up-front accept.
	Permissions []CatalogPermission `json:"permissions,omitempty"`
	Source      string              `json:"source,omitempty"` // "builtin" | "remote" (filled at merge)
}

// CatalogPermission is one reverse-capability scope a catalog plugin requests, with a
// human reason shown on the marketplace consent screen.
type CatalogPermission struct {
	Scope  string `json:"scope"`
	Reason string `json:"reason,omitempty"`
}

// Manifest is the remote catalog document: a versioned list of entries. Version lets a
// newer upstream add fields hope can skip.
type Manifest struct {
	Version int            `json:"version"`
	Entries []CatalogEntry `json:"entries"`
}

// SourceBuiltin is stamped on the built-in entries; remote entries are stamped with
// their repo name at merge time.
const SourceBuiltin = "builtin"

// DefaultPort / DefaultPath fill an entry that omits them.
const (
	DefaultPort = 8080
	DefaultPath = "/__hope"
)

// PortOrDefault / PathOrDefault normalize an entry's RPC endpoint.
func (e CatalogEntry) PortOrDefault() int {
	if e.Port > 0 {
		return e.Port
	}
	return DefaultPort
}

func (e CatalogEntry) PathOrDefault() string {
	if e.Path != "" {
		return e.Path
	}
	return DefaultPath
}
