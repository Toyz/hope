package store

import (
	"os"
	"path/filepath"
	"syscall"
)

// inDocker reports whether hope is running inside a container. hope's own images
// bake HOPE_MANAGED=1, so its presence is the signal — the rootfs-vs-volume
// distinction (and its "will be lost on recreate" warning) only makes sense in a
// container. Run the binary natively and the db is just a normal file: never flagged.
func inDocker() bool { return os.Getenv("HOPE_MANAGED") != "" }

// onRootFS reports whether the db path lives on the same filesystem device as
// "/" — i.e. the container's rootfs (overlay) rather than a mounted volume. A
// Docker volume/bind mount has its own device, so a mismatch means "on a
// volume" (persistent). Same device = ephemeral: lost on a container recreate.
//
// Best-effort: if anything can't be stat'd we return false (don't cry wolf).
func onRootFS(dbPath string) bool {
	dir := filepath.Dir(dbPath)
	var ds, rs syscall.Stat_t
	if err := syscall.Stat(dir, &ds); err != nil {
		return false
	}
	if err := syscall.Stat("/", &rs); err != nil {
		return false
	}
	return ds.Dev == rs.Dev
}
