// Package docker wraps the official Docker SDK with the small surface hope
// needs: list containers grouped into compose stacks by label, control a
// single container, and open log/stat streams. Domain types here are plain
// JSON shapes for the frontend — they do not leak SDK types over the wire.
package docker

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// Compose labels Docker stamps on every container started via `docker compose`.
// The shared keys live in labels.go (exported for other packages); these are the
// terse in-package aliases plus the two docker-only keys.
const (
	labelProject     = LabelProject
	labelService     = LabelService
	labelNumber      = LabelNumber
	labelManaged     = LabelManaged
	labelWorkingDir  = "com.docker.compose.project.working_dir"
	labelConfigFiles = "com.docker.compose.project.config_files"
)

// podman-compose fallbacks: podman's compose implementation groups under its own
// label namespace when the com.docker.compose.* labels aren't present, so hope
// works the same against a podman socket.
const (
	podmanLabelProject = "io.podman.compose.project"
	podmanLabelService = "io.podman.compose.service"
)

// projectLabel resolves a container's compose project, preferring the Docker
// label and falling back to podman-compose's.
func projectLabel(l map[string]string) string {
	if v := l[labelProject]; v != "" {
		return v
	}
	return l[podmanLabelProject]
}

// serviceLabel resolves a container's compose service (Docker, else podman).
func serviceLabel(l map[string]string) string {
	if v := l[labelService]; v != "" {
		return v
	}
	return l[podmanLabelService]
}

// ungrouped is the synthetic project name for containers with no compose label.
const ungrouped = "(ungrouped)"

// Client is hope's Docker facade over a single daemon endpoint. The underlying
// SDK handle is held atomically so the active daemon can be retargeted at
// runtime (Adopt) — e.g. binding a late-connecting agent tunnel as the primary
// host without rebuilding the routers that hold this client.
type Client struct {
	cli atomic.Pointer[client.Client]

	// selfHint, when set, overrides os.Hostname() for self-detection. Used for
	// agent clients: the remote agent reports its own container id so recreating
	// it routes through the detached self-updater instead of stopping the
	// tunnel mid-op.
	selfHint string

	// Registry auth. authMu guards `auths` (rebuilt by the cred watcher when
	// config.json changes). regCreds are the explicit [[registry]] credentials,
	// re-applied over the file's on every reload so config always wins.
	authMu      sync.RWMutex
	auths       map[string]string // registry host -> X-Registry-Auth header (merged, effective)
	configAuths map[string]string // registry host -> header, config.json only (for source tagging)
	authPath    string            // resolved config.json path (for the watcher)
	authSum     [sha256.Size]byte // last seen config.json checksum
	regCreds    []regCred

	// Cluster-wide image-freshness cache, filled by the background crawler.
	updMu    sync.RWMutex
	updByRef map[string]refStatus
	updAt    time.Time
	updPath  string           // optional on-disk JSON persistence (empty = memory only)
	updStore UpdateCacheStore // optional k/v persistence (state db); wins over updPath
	updKey   string           // this host's key in updStore

	// Docker disk-usage cache (df is expensive, so it's crawled, not live).
	duMu    sync.RWMutex
	duCache any
	duAt    time.Time
}

// New dials the Docker daemon at host (e.g. "unix:///var/run/docker.sock"
// or "tcp://host:2375") with API-version negotiation. configPath points at a
// docker config.json for private-registry pull credentials (empty = the
// default ~/.docker/config.json).
func New(host, configPath string) (*Client, error) {
	return newClient(configPath, client.WithHost(host))
}

// NewOverDialer builds a Client that talks to a Docker daemon reached through a
// custom dialer — e.g. a hope-agent tunnel, where every connection is a stream
// back to a remote host's socket. The SDK speaks plain HTTP over the dialer, so
// all of hope's existing operations work against the remote daemon unchanged.
func NewOverDialer(configPath string, dial func(ctx context.Context, network, addr string) (net.Conn, error)) (*Client, error) {
	return newClient(configPath,
		client.WithHost("http://hope-agent"), // dummy host; the dialer decides the wire
		client.WithDialContext(dial),
	)
}

func newClient(configPath string, opts ...client.Opt) (*Client, error) {
	opts = append(opts, client.WithAPIVersionNegotiation())
	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	c := &Client{auths: map[string]string{}, updByRef: map[string]refStatus{}}
	c.cli.Store(cli)
	c.initAuths(configPath)
	return c, nil
}

// Close releases the underlying client.
func (c *Client) Close() error { return c.sdk().Close() }

// sdk returns the live SDK handle (atomic, so Adopt can retarget it).
func (c *Client) sdk() *client.Client { return c.cli.Load() }

// SDK exposes the raw client for streaming callers (logstream plugin).
func (c *Client) SDK() *client.Client { return c.sdk() }

// Ping verifies the daemon is reachable.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.sdk().Ping(ctx)
	return err
}

// ContainerSummary is the per-container shape sent to the frontend.
type ContainerSummary struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Service string            `json:"service"`
	Image   string            `json:"image"`
	State   string            `json:"state"`  // running, exited, restarting, ...
	Status  string            `json:"status"` // human "Up 3 days" / "Restarting (2) ..."
	Health  string            `json:"health"` // healthy/unhealthy/starting/""
	Created int64             `json:"created"`
	Number  int               `json:"number"` // compose container-number
	Ports   []string          `json:"ports"`
	Labels  map[string]string `json:"labels,omitempty"`
}

// StackSummary groups a compose project's containers with the on-disk
// metadata needed to drive its lifecycle.
type StackSummary struct {
	Project     string             `json:"project"`
	WorkingDir  string             `json:"working_dir"`
	ConfigFiles []string           `json:"config_files"`
	Containers  []ContainerSummary `json:"containers"`
	Running     int                `json:"running"`
	Total       int                `json:"total"`
	// Restarting flags a stack with any container in a restart loop — the
	// dashboard surfaces these in red.
	Restarting bool `json:"restarting"`
	// ComposeAvailable is true when hope can read this stack's compose file
	// (file-based features like the compose viewer). False over a remote daemon
	// or when the project dir is not mounted — API ops still work regardless.
	ComposeAvailable bool `json:"compose_available"`
}

// Stacks lists all containers (running and stopped) grouped by compose
// project. Containers without a compose project land under "(ungrouped)".
func (c *Client) Stacks(ctx context.Context) ([]StackSummary, error) {
	containers, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}

	byProject := map[string]*StackSummary{}
	for _, raw := range containers {
		cs := toSummary(raw)
		proj := projectLabel(raw.Labels)
		if proj == "" {
			proj = ungrouped
		}
		st := byProject[proj]
		if st == nil {
			st = &StackSummary{
				Project:     proj,
				WorkingDir:  raw.Labels[labelWorkingDir],
				ConfigFiles: splitConfigFiles(raw.Labels[labelConfigFiles]),
			}
			byProject[proj] = st
		}
		st.Containers = append(st.Containers, cs)
		st.Total++
		if cs.State == "running" {
			st.Running++
		}
		if cs.State == "restarting" {
			st.Restarting = true
		}
	}

	out := make([]StackSummary, 0, len(byProject))
	for _, st := range byProject {
		st.ComposeAvailable = composeReadable(st.ConfigFiles)
		sort.Slice(st.Containers, func(i, j int) bool {
			if st.Containers[i].Service != st.Containers[j].Service {
				return st.Containers[i].Service < st.Containers[j].Service
			}
			return st.Containers[i].Number < st.Containers[j].Number
		})
		out = append(out, *st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Project < out[j].Project })
	return out, nil
}

// Inspect returns the full raw inspect JSON for a container (rendered as-is
// in the UI's inspect panel).
func (c *Client) Inspect(ctx context.Context, id string) (any, error) {
	info, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("inspect %s: %w", id, err)
	}
	return info, nil
}

// Start starts a stopped container.
func (c *Client) Start(ctx context.Context, id string) error {
	return c.sdk().ContainerStart(ctx, id, container.StartOptions{})
}

// Stop stops a running container with the daemon's default grace period.
func (c *Client) Stop(ctx context.Context, id string) error {
	return c.tolerateSelf(id, c.sdk().ContainerStop(ctx, id, container.StopOptions{}))
}

// Restart restarts a container.
func (c *Client) Restart(ctx context.Context, id string) error {
	return c.tolerateSelf(id, c.sdk().ContainerRestart(ctx, id, container.StopOptions{}))
}

// Kill sends SIGKILL to a container.
func (c *Client) Kill(ctx context.Context, id string) error {
	return c.tolerateSelf(id, c.sdk().ContainerKill(ctx, id, "SIGKILL"))
}

// Remove stops (graceful) then removes a container. Force covers the case where
// it's already stopped or won't stop in time.
func (c *Client) Remove(ctx context.Context, id string) error {
	_ = c.sdk().ContainerStop(ctx, id, container.StopOptions{})
	return c.tolerateSelf(id, c.sdk().ContainerRemove(ctx, id, container.RemoveOptions{Force: true}))
}

// tolerateSelf swallows a connection-drop error when the op targeted hope's own
// container (e.g. an agent restarting itself over its own tunnel): the request
// reached the daemon and executed — that's WHY the connection dropped — so it's a
// success, not a failure. The agent reconnects if its restart policy brings it
// back. Non-self errors, and self errors that aren't a dropped connection, pass
// through unchanged.
func (c *Client) tolerateSelf(id string, err error) error {
	if err == nil || !c.isSelf(id) || !isConnDropped(err) {
		return err
	}
	return nil
}

// isConnDropped reports whether err looks like the transport dropped mid-request
// (EOF / reset / closed pipe) rather than a daemon-reported failure.
func isConnDropped(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	for _, m := range []string{"eof", "connection reset", "broken pipe", "use of closed", "connection closed", "server closed", "unexpected eof"} {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// Exists reports whether a container id/name resolves — used by the
// logstream plugin to reject a stream before the first byte.
func (c *Client) Exists(ctx context.Context, id string) bool {
	_, err := c.sdk().ContainerInspect(ctx, id)
	return err == nil
}

// Info returns daemon-wide info (version, container/image counts, resources).
func (c *Client) Info(ctx context.Context) (any, error) {
	info, err := c.sdk().Info(ctx)
	if err != nil {
		return nil, fmt.Errorf("docker info: %w", err)
	}
	return info, nil
}

// ServerInfo is a small typed slice of the daemon info (for the agents view).
type ServerInfo struct {
	Version    string `json:"version"`
	Containers int    `json:"containers"`
	Running    int    `json:"running"`
	Images     int    `json:"images"`
}

// ServerInfo returns the daemon version + counts.
func (c *Client) ServerInfo(ctx context.Context) (ServerInfo, error) {
	i, err := c.sdk().Info(ctx)
	if err != nil {
		return ServerInfo{}, err
	}
	return ServerInfo{Version: i.ServerVersion, Containers: i.Containers, Running: i.ContainersRunning, Images: i.Images}, nil
}

// DiskUsage returns the daemon's disk-usage breakdown.
func (c *Client) DiskUsage(ctx context.Context) (any, error) {
	du, err := c.sdk().DiskUsage(ctx, types.DiskUsageOptions{})
	if err != nil {
		return nil, fmt.Errorf("docker disk usage: %w", err)
	}
	return du, nil
}

func toSummary(raw container.Summary) ContainerSummary {
	name := ""
	if len(raw.Names) > 0 {
		name = strings.TrimPrefix(raw.Names[0], "/")
	}
	num := 0
	if n := raw.Labels[labelNumber]; n != "" {
		num, _ = strconv.Atoi(n)
	}
	return ContainerSummary{
		ID:      raw.ID,
		Name:    name,
		Service: serviceLabel(raw.Labels),
		Image:   raw.Image,
		State:   raw.State,
		Status:  raw.Status,
		Health:  healthFromStatus(raw.Status),
		Created: raw.Created,
		Number:  num,
		Ports:   formatPorts(raw.Ports),
		Labels:  raw.Labels,
	}
}

// healthFromStatus extracts a health hint from the "Up 3 days (healthy)" text
// since the summary endpoint does not carry a structured health field.
func healthFromStatus(status string) string {
	switch {
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	default:
		return ""
	}
}

func formatPorts(ports []container.Port) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, p := range ports {
		var s string
		if p.PublicPort != 0 {
			s = fmt.Sprintf("%s:%d->%d/%s", p.IP, p.PublicPort, p.PrivatePort, p.Type)
		} else {
			s = fmt.Sprintf("%d/%s", p.PrivatePort, p.Type)
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// composeReadable reports whether hope can read the first config file — the
// signal for whether file-based compose features are available here.
func composeReadable(files []string) bool {
	if len(files) == 0 {
		return false
	}
	_, err := os.Stat(files[0])
	return err == nil
}

// splitConfigFiles splits the comma-joined config_files label into paths.
func splitConfigFiles(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
