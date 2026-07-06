// Package pluginhost is hope's control plane for container plugins: it discovers
// containers across the fleet that declare a JSON-RPC endpoint (labels
// hope.plugin.*), tracks which the operator has trusted, and (in later phases)
// dials + renders them. Wire name: "Plugins".
//
// This is distinct from the sov gateway plugins in internal/plugins — those are
// compiled-in gateway middleware; these are external containers hope talks to.
package pluginhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"sync"
	"time"

	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// cacheTTL bounds how often a List scans the whole fleet's docker daemons. A real
// fleet is many containers across many hosts; scanning on every UI poll is heavy,
// so results are cached briefly and a refresh flag forces a rescan.
const cacheTTL = 15 * time.Second

// Discovered is one plugin container found on one host.
type Discovered struct {
	Host string
	PC   docker.PluginContainer
}

// scan lists plugin containers across every online host, concurrently, and caches
// the result for cacheTTL. Mirrors system.collectFleet's fan-out.
func (r *PluginsRouter) scan(ctx context.Context, refresh bool) []Discovered {
	r.mu.Lock()
	if !refresh && r.cache != nil && time.Since(r.cachedAt) < cacheTTL {
		cached := r.cache
		r.mu.Unlock()
		return cached
	}
	r.mu.Unlock()

	// Serialize the fan-out: concurrent callers (Surfaces/Dashboard/Pages/tryDial all
	// force a rescan) would otherwise stampede every Docker daemon at once. After
	// acquiring, reuse a scan a peer just finished instead of running another.
	r.scanMu.Lock()
	defer r.scanMu.Unlock()
	r.mu.Lock()
	if r.cache != nil && time.Since(r.cachedAt) < cacheTTL {
		cached := r.cache
		r.mu.Unlock()
		return cached
	}
	r.mu.Unlock()

	hcs := r.hosts.All()
	perHost := make([][]Discovered, len(hcs))
	var wg sync.WaitGroup
	for i, h := range hcs {
		if !h.Online || h.Client == nil {
			continue
		}
		wg.Add(1)
		go func(i int, host hosts.HostClient) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			pcs, err := host.Client.PluginContainers(cctx)
			if err != nil {
				return
			}
			ds := make([]Discovered, 0, len(pcs))
			for _, pc := range pcs {
				ds = append(ds, Discovered{Host: host.ID, PC: pc})
			}
			perHost[i] = ds
		}(i, h)
	}
	wg.Wait()

	var out []Discovered
	for _, ds := range perHost {
		out = append(out, ds...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].PC.Name < out[j].PC.Name
	})

	r.mu.Lock()
	r.cache = out
	r.cachedAt = time.Now()
	r.mu.Unlock()
	return out
}

// pluginIdentity is a plugin instance's STABLE key across recreates. It is host +
// compose project + service when the plugin lives in a stack — so a redeploy (new
// container id, same project/service) keeps its identity, two instances of the
// same image in different stacks stay distinct, and replicas of one service
// collapse to a single identity (hope dials one; a plugin can't cross-talk stacks
// anyway). Falls back to the container name, then the container id, for plugins
// not managed by compose.
func pluginIdentity(host string, pc docker.PluginContainer) string {
	switch {
	case pc.Project != "" && pc.Service != "":
		return host + "|" + pc.Project + "/" + pc.Service
	case pc.Name != "":
		return host + "|~/" + pc.Name
	default:
		return host + "|id/" + pc.ContainerID
	}
}

// representative picks the container hope should dial for a group of same-identity
// containers (replicas): a running one if any, else the first.
func representative(members []docker.PluginContainer) docker.PluginContainer {
	for _, pc := range members {
		if pc.Running {
			return pc
		}
	}
	return members[0]
}

// group returns the same-identity container group for a stable key (cache-first).
func (r *PluginsRouter) group(ctx context.Context, key string) ([]docker.PluginContainer, string, bool) {
	var members []docker.PluginContainer
	host := ""
	for _, d := range r.scan(ctx, false) {
		if pluginIdentity(d.Host, d.PC) == key {
			members = append(members, d.PC)
			host = d.Host
		}
	}
	if len(members) == 0 {
		return nil, "", false
	}
	return members, host, true
}

// fingerprint captures what hope trusts about a plugin at enable time. Phase 2
// uses the image digest; phase 3 augments it with a hash of the plugin's getSchema
// so a schema change (not just an image swap) also forces re-approval.
func fingerprint(pc docker.PluginContainer) string { return pc.ImageID }

// hashBytes returns a hex sha256 of b — used to fingerprint a plugin's hope.schema
// so a runtime capability change is detectable against the approval.
func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
