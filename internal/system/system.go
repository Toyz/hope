// Package system exposes the SystemRouter: daemon-wide info and disk usage.
// Wire name: "System".
package system

import (
	"context"
	"sync"
	"time"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
	"github.com/toyz/hope/internal/store"
)

// SystemRouter surfaces daemon-level diagnostics for the active host.
type SystemRouter struct {
	hosts       *hosts.Set
	agentToken  string // shared enrollment secret (empty = hub disabled)
	agentWSPath string
	apiEnabled  bool           // static API keys configured -> headless RPC + explorer link
	store       *store.Store   // persisted registry creds (no-op when unmounted)
	localDock   *docker.Client // local daemon — the canonical registry-auth view
}

// NewSystemRouter wires the router to the host set (active-host aware). The agent
// token + ws path power the "add an agent" enrollment helper; apiEnabled toggles
// the API explorer link. st persists UI-added registry creds; localDock is the
// canonical client for listing them (registries are applied fleet-wide).
func NewSystemRouter(hs *hosts.Set, agentToken, agentWSPath string, apiEnabled bool, st *store.Store, localDock *docker.Client) *SystemRouter {
	return &SystemRouter{hosts: hs, agentToken: agentToken, agentWSPath: agentWSPath, apiEnabled: apiEnabled, store: st, localDock: localDock}
}

// FeatureFlags reports which optional features are on, so the UI can show/hide
// affordances (e.g. the API explorer link).
type FeatureFlags struct {
	APIEnabled bool `json:"api_enabled"`
	// StoreEnabled is true when the embedded state db is mounted. False = agents,
	// freshness cache, deploy specs and UI-added registries are NOT persisted
	// across a restart, so the UI can warn.
	StoreEnabled bool `json:"store_enabled"`
	// StoreEphemeral is true when the db is enabled but sits on the container's
	// rootfs (no volume mounted at its path) — it'll be lost on a recreate.
	StoreEphemeral bool `json:"store_ephemeral"`
}

// Features returns the feature flags the UI needs at load. (Named Features, not
// Capabilities — "Capabilities" is a reserved sov marker method, so it would be
// skipped at registration and 404 as an RPC endpoint.)
func (r *SystemRouter) Features(ctx *rpc.Context) (*FeatureFlags, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	return &FeatureFlags{APIEnabled: r.apiEnabled, StoreEnabled: r.store.Enabled(), StoreEphemeral: r.store.Ephemeral()}, nil
}

// AgentEnrollInfo is what the "add agent" modal needs to build a ready-to-run
// command. Token is a secret — returned only to an authenticated operator and
// never logged.
type AgentEnrollInfo struct {
	Enabled bool   `json:"enabled"` // the hub is on ([agent] token set)
	Token   string `json:"token"`
	WSPath  string `json:"ws_path"`
}

// AgentEnroll returns the shared token + ws path so the UI can render a complete
// enrollment command (the connect host is derived client-side from the URL).
func (r *SystemRouter) AgentEnroll(ctx *rpc.Context) (*AgentEnrollInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	path := r.agentWSPath
	if path == "" {
		path = "/agent/connect"
	}
	return &AgentEnrollInfo{Enabled: r.agentToken != "", Token: r.agentToken, WSPath: path}, nil
}

// dock is the docker client for the currently-active host.
func (r *SystemRouter) dock(ctx context.Context) *docker.Client { return r.hosts.ActiveFor(ctx) }

// Hosts lists every selectable host (local + connected agents) with the active
// one flagged, for the host switcher.
func (r *SystemRouter) Hosts(ctx *rpc.Context) ([]hosts.HostView, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	return r.hosts.List(), nil
}

// FleetHost is one host's slice of the cross-fleet overview: its stacks plus
// identity, so the UI can render a section per host.
type FleetHost struct {
	ID        string                 `json:"id"`
	Kind      string                 `json:"kind"` // "local" | "agent"
	Online    bool                   `json:"online"`
	Error     string                 `json:"error,omitempty"`
	Outdated  int                    `json:"outdated"`   // running images with a newer version
	Updates   []docker.ClusterUpdate `json:"updates"`    // the outdated items (for the fleet updates section)
	CheckedAt string                 `json:"checked_at"` // when this host's image-freshness was last crawled
	Stacks    []docker.StackSummary  `json:"stacks"`
}

// Fleet returns every host (local + connected agents) with its stacks, for the
// "all hosts" overview. Hosts are queried concurrently so one slow daemon
// doesn't stall the rest; a host that errors is returned offline with its
// message rather than failing the whole call.
func (r *SystemRouter) Fleet(ctx *rpc.Context) ([]FleetHost, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	return r.collectFleet(ctx, false), nil
}

// RefreshFleetUpdates forces an immediate image-freshness recrawl on every host
// (the fleet "check" button), then returns the fresh overview.
func (r *SystemRouter) RefreshFleetUpdates(ctx *rpc.Context) ([]FleetHost, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	return r.collectFleet(ctx, true), nil
}

func (r *SystemRouter) collectFleet(ctx context.Context, refresh bool) []FleetHost {
	hcs := r.hosts.All()
	out := make([]FleetHost, len(hcs))
	timeout := 25 * time.Second
	if refresh {
		timeout = 100 * time.Second // recrawl per host can be slow
	}
	var wg sync.WaitGroup
	for i, h := range hcs {
		out[i] = FleetHost{ID: h.ID, Kind: h.Kind, Online: h.Online, Stacks: []docker.StackSummary{}}
		if !h.Online || h.Client == nil {
			continue
		}
		wg.Add(1)
		go func(i int, c *docker.Client) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			if refresh {
				c.RefreshUpdates(cctx)
			}
			st, err := c.Stacks(cctx)
			if err != nil {
				out[i].Online = false
				out[i].Error = err.Error()
				return
			}
			out[i].Stacks = st
			// Outdated items from this host's (per-host) update cache.
			if ups, at, e := c.AllUpdates(cctx); e == nil {
				for _, u := range ups {
					if u.Status == "outdated" {
						out[i].Updates = append(out[i].Updates, u)
					}
				}
				out[i].Outdated = len(out[i].Updates)
				out[i].CheckedAt = stamp(at)
			}
		}(i, h.Client)
	}
	wg.Wait()
	return out
}

// SetActiveHostParams selects the host the UI operates on.
type SetActiveHostParams struct {
	ID string `sov:"id,0,required" json:"id"`
}

// SetActiveHost switches the active host. Subsequent calls (stacks, containers,
// logs, ...) operate on it. "local" selects the local daemon.
func (r *SystemRouter) SetActiveHost(ctx *rpc.Context, p *SetActiveHostParams) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if err := r.hosts.SetActive(p.ID); err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return map[string]string{"active": r.hosts.ActiveID()}, nil
}

// Info returns daemon info (version, counts, resources).
func (r *SystemRouter) Info(ctx *rpc.Context) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	info, err := r.dock(ctx).Info(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return info, nil
}

// UpdatesResult is the cluster-wide image-freshness report for the dashboard.
type UpdatesResult struct {
	Updates   []docker.ClusterUpdate `json:"updates"`
	Outdated  int                    `json:"outdated"`
	CheckedAt string                 `json:"checked_at"`
}

// Updates returns the cached cluster-wide image-freshness report (filled by the
// background crawler) so the dashboard can flag containers running stale images.
func (r *SystemRouter) Updates(ctx *rpc.Context) (*UpdatesResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return r.collectUpdates(cctx)
}

// RefreshUpdates runs an immediate cluster-wide crawl (user-triggered from the
// dashboard "updates" refresh) then returns the fresh report.
func (r *SystemRouter) RefreshUpdates(ctx *rpc.Context) (*UpdatesResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	r.dock(ctx).RefreshUpdates(cctx)
	return r.collectUpdates(cctx)
}

func (r *SystemRouter) collectUpdates(ctx context.Context) (*UpdatesResult, error) {
	updates, at, err := r.dock(ctx).AllUpdates(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	outdated := 0
	for _, u := range updates {
		if u.Status == "outdated" {
			outdated++
		}
	}
	return &UpdatesResult{Updates: updates, Outdated: outdated, CheckedAt: stamp(at)}, nil
}

// FleetImagesHost is one host's images for the cross-fleet images view.
type FleetImagesHost struct {
	ID     string             `json:"id"`
	Kind   string             `json:"kind"`
	Online bool               `json:"online"`
	Error  string             `json:"error,omitempty"`
	Images []docker.ImageInfo `json:"images"`
}

// FleetImages lists every host's images for the "all hosts" images view. Hosts
// are queried concurrently; one that errors is returned offline with its message.
func (r *SystemRouter) FleetImages(ctx *rpc.Context) ([]FleetImagesHost, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	hcs := r.hosts.All()
	out := make([]FleetImagesHost, len(hcs))
	var wg sync.WaitGroup
	for i, h := range hcs {
		out[i] = FleetImagesHost{ID: h.ID, Kind: h.Kind, Online: h.Online, Images: []docker.ImageInfo{}}
		if !h.Online || h.Client == nil {
			continue
		}
		wg.Add(1)
		go func(i int, c *docker.Client) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 25*time.Second)
			defer cancel()
			imgs, err := c.Images(cctx)
			if err != nil {
				out[i].Online = false
				out[i].Error = err.Error()
				return
			}
			out[i].Images = imgs
		}(i, h.Client)
	}
	wg.Wait()
	return out, nil
}

// Images lists the local images for the images page.
func (r *SystemRouter) Images(ctx *rpc.Context) ([]docker.ImageInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	imgs, err := r.dock(ctx).Images(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return imgs, nil
}

// Image returns the detail for a single image on the active host, looked up by
// id / tag / digest — powers the shared image-detail modal opened from anywhere
// a container's image is shown.
func (r *SystemRouter) Image(ctx *rpc.Context, p *IDParam) (*docker.ImageInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	im, err := r.dock(ctx).ImageByRef(cctx, p.ID)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	if im == nil {
		return nil, rpc.BadRequest("image %q not found on this host", p.ID)
	}
	return im, nil
}

// ImageHistory returns an image's build history (layers + per-layer size) for
// the image-detail modal's layers view, on the active host.
func (r *SystemRouter) ImageHistory(ctx *rpc.Context, p *IDParam) ([]docker.ImageLayer, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	layers, err := r.dock(ctx).History(cctx, p.ID)
	if err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return layers, nil
}

// FleetNetworksHost / FleetVolumesHost are one host's resources for the
// cross-fleet networks/volumes views.
type FleetNetworksHost struct {
	ID       string               `json:"id"`
	Kind     string               `json:"kind"`
	Online   bool                 `json:"online"`
	Error    string               `json:"error,omitempty"`
	Networks []docker.NetworkInfo `json:"networks"`
}
type FleetVolumesHost struct {
	ID      string              `json:"id"`
	Kind    string              `json:"kind"`
	Online  bool                `json:"online"`
	Error   string              `json:"error,omitempty"`
	Volumes []docker.VolumeInfo `json:"volumes"`
}

// FleetNetworks lists every host's networks (all-hosts networks view).
func (r *SystemRouter) FleetNetworks(ctx *rpc.Context) ([]FleetNetworksHost, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	hcs := r.hosts.All()
	out := make([]FleetNetworksHost, len(hcs))
	var wg sync.WaitGroup
	for i, h := range hcs {
		out[i] = FleetNetworksHost{ID: h.ID, Kind: h.Kind, Online: h.Online, Networks: []docker.NetworkInfo{}}
		if !h.Online || h.Client == nil {
			continue
		}
		wg.Add(1)
		go func(i int, c *docker.Client) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			ns, err := c.Networks(cctx)
			if err != nil {
				out[i].Online = false
				out[i].Error = err.Error()
				return
			}
			out[i].Networks = ns
		}(i, h.Client)
	}
	wg.Wait()
	return out, nil
}

// FleetVolumes lists every host's volumes (all-hosts volumes view).
func (r *SystemRouter) FleetVolumes(ctx *rpc.Context) ([]FleetVolumesHost, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	hcs := r.hosts.All()
	out := make([]FleetVolumesHost, len(hcs))
	var wg sync.WaitGroup
	for i, h := range hcs {
		out[i] = FleetVolumesHost{ID: h.ID, Kind: h.Kind, Online: h.Online, Volumes: []docker.VolumeInfo{}}
		if !h.Online || h.Client == nil {
			continue
		}
		wg.Add(1)
		go func(i int, c *docker.Client) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			vs, err := c.Volumes(cctx)
			if err != nil {
				out[i].Online = false
				out[i].Error = err.Error()
				return
			}
			out[i].Volumes = vs
		}(i, h.Client)
	}
	wg.Wait()
	return out, nil
}

// AgentView is one connected agent's detail (build info + daemon + counts).
type AgentView struct {
	ID            string `json:"id"`
	Remote        string `json:"remote"`
	ConnectedAt   string `json:"connected_at"`
	Version       string `json:"version"`
	Revision      string `json:"revision"`
	GoVersion     string `json:"go_version"`
	Platform      string `json:"platform"`
	BuildTime     string `json:"build_time"`
	DockerVersion string `json:"docker_version"`
	Containers    int    `json:"containers"`
	Running       int    `json:"running"`
	Images        int    `json:"images"`
	Online        bool   `json:"online"`
	LastSeen      string `json:"last_seen,omitempty"` // when last connected (for offline/known agents)
}

// Agents lists every connected agent with its build info, daemon version, and
// container/image counts (each daemon queried concurrently), plus any known-but-
// disconnected agents from the persisted roster (Online=false, last seen shown).
func (r *SystemRouter) Agents(ctx *rpc.Context) ([]AgentView, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	hs := r.hosts.AgentHosts()
	out := make([]AgentView, len(hs))
	online := make(map[string]bool, len(hs))
	var wg sync.WaitGroup
	for i, h := range hs {
		online[h.ID] = true
		out[i] = AgentView{
			ID: h.ID, Remote: h.Remote, ConnectedAt: stamp(h.ConnectedAt),
			Version: h.Info.Version, Revision: h.Info.Revision, GoVersion: h.Info.GoVersion,
			Platform: h.Info.Platform, BuildTime: h.Info.BuildTime, Online: true,
		}
		wg.Add(1)
		go func(i int, c *docker.Client) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			if si, err := c.ServerInfo(cctx); err == nil {
				out[i].DockerVersion = si.Version
				out[i].Containers = si.Containers
				out[i].Running = si.Running
				out[i].Images = si.Images
			} else {
				out[i].Online = false
			}
		}(i, h.Docker)
	}
	wg.Wait()
	// Fold in known agents that aren't currently connected (from the state db).
	if known, err := r.store.Agents(); err == nil {
		for _, rec := range known {
			if online[rec.ID] {
				continue
			}
			out = append(out, AgentView{
				ID: rec.ID, Remote: rec.Remote,
				Version: rec.Version, Revision: rec.Revision, GoVersion: rec.GoVersion,
				Platform: rec.Platform, BuildTime: rec.BuildTime,
				Online: false, LastSeen: stamp(rec.LastSeen),
			})
		}
	}
	return out, nil
}

// ForgetAgent removes a known-but-offline agent from the persisted roster (the
// operator decommissioned it). Rejected while the agent is connected — a live
// host would just be re-persisted on its next heartbeat.
func (r *SystemRouter) ForgetAgent(ctx *rpc.Context, p *IDParam) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	for _, h := range r.hosts.AgentHosts() {
		if h.ID == p.ID {
			return nil, rpc.BadRequest("%q is online — can't forget a connected host", p.ID)
		}
	}
	if err := r.store.DeleteAgent(p.ID); err != nil {
		return nil, rpc.Internal("forget agent: %v", err)
	}
	return map[string]bool{"ok": true}, nil
}

// Networks lists the active host's Docker networks with the containers attached
// to each (the reverse "who's on this network" mapping).
func (r *SystemRouter) Networks(ctx *rpc.Context) ([]docker.NetworkInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	nets, err := r.dock(ctx).Networks(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return nets, nil
}

// Volumes lists the active host's Docker volumes with the containers mounting
// each (the reverse mapping).
func (r *SystemRouter) Volumes(ctx *rpc.Context) ([]docker.VolumeInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	vols, err := r.dock(ctx).Volumes(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return vols, nil
}

// IDParam targets a resource by id/name.
type IDParam struct {
	ID string `sov:"id,0,required" json:"id"`
}

// Network returns one network's detail (by id or name) on the active host — for
// the shared network-detail modal opened from a container's networks list.
func (r *SystemRouter) Network(ctx *rpc.Context, p *IDParam) (*docker.NetworkInfo, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	n, err := r.dock(ctx).NetworkByRef(cctx, p.ID)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	if n == nil {
		return nil, rpc.BadRequest("network %q not found on this host", p.ID)
	}
	return n, nil
}

// RemoveNetwork deletes a network on the active host.
func (r *SystemRouter) RemoveNetwork(ctx *rpc.Context, p *IDParam) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := r.dock(ctx).RemoveNetwork(cctx, p.ID); err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return map[string]bool{"ok": true}, nil
}

// RemoveVolume deletes a volume on the active host (force-removes if referenced).
func (r *SystemRouter) RemoveVolume(ctx *rpc.Context, p *IDParam) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := r.dock(ctx).RemoveVolume(cctx, p.ID, true); err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return map[string]bool{"ok": true}, nil
}

// ImageRemoveParams targets one image for deletion.
type ImageRemoveParams struct {
	ID    string `sov:"id,0,required" json:"id"`
	Force bool   `sov:"force,1" json:"force"`
}

// RemoveImage deletes a single local image.
func (r *SystemRouter) RemoveImage(ctx *rpc.Context, p *ImageRemoveParams) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := r.dock(ctx).RemoveImage(cctx, p.ID, p.Force); err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	return map[string]bool{"ok": true}, nil
}

// PruneParams selects the prune scope.
type PruneParams struct {
	All bool `sov:"all,0" json:"all"` // true = all unused images, false = dangling only
}

// PruneImages removes unused images (dangling-only, or all unused).
func (r *SystemRouter) PruneImages(ctx *rpc.Context, p *PruneParams) (*docker.PruneResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	res, err := r.dock(ctx).PruneImages(cctx, p.All)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &res, nil
}

// PruneBuildCache clears the builder cache on the active host and returns the
// bytes reclaimed — the build cache is invisible to image prune and often the
// biggest reclaimable chunk.
func (r *SystemRouter) PruneBuildCache(ctx *rpc.Context) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	reclaimed, err := r.dock(ctx).PruneBuildCache(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return map[string]any{"ok": true, "reclaimed": reclaimed}, nil
}

// DiskResult wraps a disk-usage snapshot with the time it was taken.
type DiskResult struct {
	Usage     any    `json:"usage"`
	CheckedAt string `json:"checked_at"`
}

// DiskUsage returns the cached disk-usage snapshot (crawled hourly — df is too
// expensive to run on every dashboard load).
func (r *SystemRouter) DiskUsage(ctx *rpc.Context) (*DiskResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	du, at := r.dock(ctx).DiskUsageCached()
	return &DiskResult{Usage: du, CheckedAt: stamp(at)}, nil
}

// RefreshDiskUsage runs a live df (user-triggered) and updates the cache.
func (r *SystemRouter) RefreshDiskUsage(ctx *rpc.Context) (*DiskResult, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	du, at, err := r.dock(ctx).RefreshDiskUsage(cctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	return &DiskResult{Usage: du, CheckedAt: stamp(at)}, nil
}

// RegistryView is one known registry for the UI. The password is never sent;
// has_password only reports that one is stored. source is "config" (read-only,
// from config.json / [[registry]]) or "db" (added here, editable/removable).
type RegistryView struct {
	Server      string `json:"server"`
	Username    string `json:"username"`
	HasPassword bool   `json:"has_password"`
	Source      string `json:"source"`
	Editable    bool   `json:"editable"`
}

// Registries lists every registry hope has credentials for (config + runtime),
// credential-free, for the registries manager. hope is the fleet's registry-auth
// authority, so this list is applied to the local daemon and every agent alike.
func (r *SystemRouter) Registries(ctx *rpc.Context) ([]RegistryView, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	out := []RegistryView{}
	for _, e := range r.localDock.RegistryList() {
		out = append(out, RegistryView{
			Server:      e.Server,
			Username:    e.Username,
			HasPassword: e.HasPassword,
			Source:      string(e.Source),
			Editable:    e.Source == docker.RegistrySourceDB,
		})
	}
	return out, nil
}

// AddRegistryParams is a new/updated runtime registry credential.
type AddRegistryParams struct {
	Server   string `sov:"server,0,required" json:"server"`
	Username string `sov:"username,1,required" json:"username"`
	Password string `sov:"password,2,required" json:"password"`
}

// AddRegistry stores a registry credential (encrypted) and applies it live to
// the local daemon and every connected agent. Config-defined registries are
// read-only and rejected. With no state db mounted the cred still applies for
// the session but isn't retained across a restart.
func (r *SystemRouter) AddRegistry(ctx *rpc.Context, p *AddRegistryParams) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if r.localDock.IsConfigRegistry(p.Server) {
		return nil, rpc.BadRequest("%q is defined in config and can't be edited here", p.Server)
	}
	if err := r.store.PutRegistry(p.Server, p.Username, p.Password); err != nil {
		return nil, rpc.Internal("persist registry: %v", err)
	}
	for _, d := range r.fleetDockers() {
		d.AddRegistryCreds(p.Server, p.Username, p.Password, docker.RegistrySourceDB)
	}
	return map[string]any{"ok": true, "persisted": r.store.Enabled()}, nil
}

// RemoveRegistry deletes a runtime registry credential from the db and from the
// live auth map on every host. Config-defined registries are rejected.
func (r *SystemRouter) RemoveRegistry(ctx *rpc.Context, p *IDParam) (any, error) {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return nil, err
	}
	if r.localDock.IsConfigRegistry(p.ID) {
		return nil, rpc.BadRequest("%q is defined in config and can't be removed here", p.ID)
	}
	if err := r.store.DeleteRegistry(p.ID); err != nil {
		return nil, rpc.Internal("delete registry: %v", err)
	}
	for _, d := range r.fleetDockers() {
		d.RemoveRegistryCreds(p.ID)
	}
	return map[string]bool{"ok": true}, nil
}

// fleetDockers returns the local daemon plus every connected agent's client, so
// a registry change is applied everywhere hope pulls images.
func (r *SystemRouter) fleetDockers() []*docker.Client {
	ds := []*docker.Client{}
	if r.localDock != nil {
		ds = append(ds, r.localDock)
	}
	for _, h := range r.hosts.AgentHosts() {
		if h.Docker != nil {
			ds = append(ds, h.Docker)
		}
	}
	return ds
}

func stamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
