package store

import (
	"path/filepath"
	"syscall"
)

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
