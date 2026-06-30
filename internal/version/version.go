// Package version exposes build information stamped into the binary at link
// time (-ldflags -X). When those aren't set (a plain `go build` in a git tree),
// it falls back to the VCS info the Go toolchain records automatically.
package version

import (
	"runtime"
	"runtime/debug"
)

// Set via -ldflags "-X github.com/toyz/hope/internal/version.Version=..." etc.
var (
	Version   = "dev" // git tag or branch
	Revision  = ""    // git commit sha
	BuildTime = ""    // RFC3339 build timestamp
)

// Info is the build metadata surfaced to logs / the API / agents.
type Info struct {
	Version   string `json:"version"`
	Revision  string `json:"revision"`
	BuildTime string `json:"build_time"`
	GoVersion string `json:"go_version"`
}

// Get returns the build info, filling revision/time from the embedded VCS stamp
// when ldflags didn't provide them.
func Get() Info {
	rev, bt := Revision, BuildTime
	if rev == "" || bt == "" {
		if bi, ok := debug.ReadBuildInfo(); ok {
			for _, s := range bi.Settings {
				switch s.Key {
				case "vcs.revision":
					if rev == "" {
						rev = s.Value
					}
				case "vcs.time":
					if bt == "" {
						bt = s.Value
					}
				}
			}
		}
	}
	return Info{Version: Version, Revision: rev, BuildTime: bt, GoVersion: runtime.Version()}
}

// Short is a compact one-line summary for startup logs.
func Short() string {
	i := Get()
	rev := i.Revision
	if len(rev) > 12 {
		rev = rev[:12]
	}
	s := i.Version
	if rev != "" {
		s += " (" + rev + ")"
	}
	return s
}
