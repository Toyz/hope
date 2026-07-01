// Command hope-boot is a tiny launcher + self-update helper shipped alongside
// `hope` in the same (scratch) image.
//
//   - `hope-boot recreate <id>`  — the detached updater: from a throwaway
//     container (docker socket mounted, AutoRemove) it recreates the target
//     container in place on its freshly-pulled image. It outlives the target, so
//     hope/the agent can be torn down and replaced without killing the process
//     (or the tunnel) mid-recreate.
//   - anything else              — exec `hope` with the args passed straight
//     through, so `hope-boot agent --connect …`, `hope-boot -config …`, etc.
//     behave exactly like invoking `hope` directly (hope becomes PID 1).
//
// It links only the docker client (no gateway / embedded SPA), so it stays small.
package main

import (
	"context"
	"log"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/toyz/hope/internal/docker"
)

const hopeBin = "/usr/local/bin/hope"

func main() {
	log.SetFlags(0)
	if len(os.Args) > 1 && os.Args[1] == "recreate" {
		if len(os.Args) < 3 {
			log.Fatal("hope-boot: usage: hope-boot recreate <container-id>")
		}
		recreate(os.Args[2])
		return
	}
	// Launcher: replace ourselves with hope, forwarding every argument.
	argv := append([]string{"hope"}, os.Args[1:]...)
	if err := syscall.Exec(hopeBin, argv, os.Environ()); err != nil {
		log.Fatalf("hope-boot: exec hope: %v", err)
	}
}

// recreate runs in the throwaway helper container. It waits briefly so the
// parent's redeploy request can return, then recreates the target from the
// mounted docker socket. Idempotent: a target that's already gone counts as done.
func recreate(id string) {
	d, err := docker.New("unix:///var/run/docker.sock", "")
	if err != nil {
		log.Fatalf("hope-boot recreate: %v", err)
	}
	defer d.Close()
	time.Sleep(1500 * time.Millisecond)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		err := d.Recreate(ctx, id)
		cancel()
		if err == nil {
			log.Printf("hope-boot: %s recreated", id)
			return
		}
		if strings.Contains(strings.ToLower(err.Error()), "no such container") {
			log.Printf("hope-boot: %s already gone — nothing to do", id)
			return
		}
		lastErr = err
		time.Sleep(2 * time.Second)
	}
	log.Fatalf("hope-boot recreate %s: %v", id, lastErr)
}
