package docker

import (
	"context"
	"errors"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
)

// PluginNetwork is the dedicated user bridge hope uses to reach plugins on a daemon:
// hope (or the agent) and each enabled plugin container both join it, and hope dials
// the plugin by a stable alias on it — no published port, no hairpin, deterministic
// DNS. Created on demand per daemon (local socket, or an agent's daemon over tunnel).
const PluginNetwork = "ink-plugins"

// EnsurePluginNetwork creates the shared ink-plugins bridge if missing (idempotent).
func (c *Client) EnsurePluginNetwork(ctx context.Context) error {
	f := filters.NewArgs(filters.Arg("name", PluginNetwork))
	nets, err := c.sdk().NetworkList(ctx, network.ListOptions{Filters: f})
	if err != nil {
		return err
	}
	for _, n := range nets {
		if n.Name == PluginNetwork {
			return nil
		}
	}
	_, err = c.sdk().NetworkCreate(ctx, PluginNetwork, network.CreateOptions{Driver: "bridge"})
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return nil
	}
	return err
}

// PluginNetAlias is the stable DNS name a plugin container is aliased to on the shared
// network — always a valid DNS label (hex id), so hope can dial it directly.
func PluginNetAlias(containerID string) string {
	id := containerID
	if len(id) > 12 {
		id = id[:12]
	}
	return "plugin-" + id
}

// IsLocalSocket reports whether this client talks to a local unix socket (as opposed
// to a remote tcp:// daemon). Only for a local socket can hope join the plugin's
// network and reach it by container DNS; a remote tcp daemon needs a published port.
func (c *Client) IsLocalSocket() bool { return c.daemonHostIP() == "" }

// SelfContainerID resolves the container id of the process on THIS daemon that should
// join the plugin network — hope on the local daemon, the agent on a tunnel. It tries
// the hostname/hint first (usually the container id), then falls back to the daemon's
// HOPE_MANAGED container (hope + agent images bake HOPE_MANAGED=1) — robust even when a
// custom --hostname hides the id. Returns "" if none is found.
func (c *Client) SelfContainerID(ctx context.Context) string {
	if id := c.selfID(); id != "" {
		if _, err := c.sdk().ContainerInspect(ctx, id); err == nil {
			return id
		}
	}
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{})
	if err != nil {
		return ""
	}
	for _, ct := range list {
		if c.isHopeManaged(ctx, ct.ID) {
			return ct.ID
		}
	}
	return ""
}

// Labels a container sets to opt into the hope plugin system. These are the
// USER-facing namespace (distinct from the ink.hope.* labels hope sets on
// containers it manages).
const (
	labelPlugin       = "hope.plugin"       // "true" => this container is a plugin
	labelPluginPort   = "hope.plugin.port"  // container port the JSON-RPC endpoint listens on
	labelPluginPath   = "hope.plugin.path"  // endpoint path (default /__hope)
	labelPluginTitle  = "hope.plugin.title" // optional pre-manifest display hint
	labelPluginIcon   = "hope.plugin.icon"  // optional pre-manifest icon hint
	defaultPluginPath = "/__hope"
)

// Exported plugin label keys — the installer stamps these on a deployed plugin
// container so discovery picks it up (the same labels an author would set by hand).
const (
	LabelPlugin      = labelPlugin
	LabelPluginPort  = labelPluginPort
	LabelPluginPath  = labelPluginPath
	LabelPluginTitle = labelPluginTitle
	LabelPluginIcon  = labelPluginIcon
)

// PluginContainer is a container that declares a hope plugin endpoint. Identity
// (name/version/icons/capabilities) comes from the plugin's own getSchema; these
// fields are only what the labels + docker tell us — where to dial and enough to
// list it before it's trusted.
type PluginContainer struct {
	ContainerID string   `json:"container_id"`
	Name        string   `json:"name"` // container name (no leading slash)
	Port        int      `json:"port"`
	Path        string   `json:"path"`
	Title       string   `json:"title"` // pre-manifest hint, else name
	Icon        string   `json:"icon"`  // pre-manifest hint
	Project     string   `json:"project"`
	Service     string   `json:"service"` // compose service — part of the stable identity
	Networks    []string `json:"networks"`
	Image       string   `json:"image"`
	ImageID     string   `json:"image_id"` // image digest — part of the trust fingerprint
	Running     bool     `json:"running"`
}

// PluginContainers lists containers on this daemon that opt into the plugin
// system (label hope.plugin truthy) and declare a valid port. Mirrors Connectors.
func (c *Client) PluginContainers(ctx context.Context) ([]PluginContainer, error) {
	f := filters.NewArgs(filters.Arg("label", labelPlugin))
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, err
	}
	out := make([]PluginContainer, 0, len(list))
	for _, ct := range list {
		if !truthy(ct.Labels[labelPlugin]) {
			continue // label present but explicitly off
		}
		port, err := strconv.Atoi(strings.TrimSpace(ct.Labels[labelPluginPort]))
		if err != nil || port <= 0 || port > 65535 {
			continue // no usable port => can't dial it
		}
		path := strings.TrimSpace(ct.Labels[labelPluginPath])
		if path == "" {
			path = defaultPluginPath
		}
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		title := ct.Labels[labelPluginTitle]
		if title == "" {
			title = name
		}
		var nets []string
		if ct.NetworkSettings != nil {
			for n := range ct.NetworkSettings.Networks {
				if n != "bridge" && n != "host" && n != "none" {
					nets = append(nets, n)
				}
			}
			sort.Strings(nets)
		}
		out = append(out, PluginContainer{
			ContainerID: ct.ID,
			Name:        name,
			Port:        port,
			Path:        path,
			Title:       title,
			Icon:        ct.Labels[labelPluginIcon],
			Project:     projectLabel(ct.Labels),
			Service:     ct.Labels[LabelService],
			Networks:    nets,
			Image:       ct.Image,
			ImageID:     ct.ImageID,
			Running:     ct.State == "running",
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// PluginDialCandidates returns ordered host:port addresses hope can try to reach a
// container's port, plus the user network to attach to. Order:
//  1. the container's network IP (works when hope shares the network — the normal
//     containerized deployment, after AttachNetwork);
//  2. any PUBLISHED host port at 127.0.0.1 (works for NATIVE hope, including Docker
//     Desktop, which forwards published ports to localhost) — the dev fast path.
//
// Errors only if the container exposes neither.
// PluginDialCandidates resolves how hope can reach a plugin container. It returns
// two kinds of address:
//   - netTargets: the container's network IP:port — reachable only from the plugin's
//     docker network (hope attaches to it locally, or the agent dials it on the host).
//   - directTargets: a published host port at an address hope can reach DIRECTLY —
//     127.0.0.1 for a local daemon, or the daemon's host IP when the daemon is a
//     remote TCP endpoint (so a plugin published on the remote host is reachable at
//     <daemon-host>:<published> without an agent on that host).
//
// attachNet is the user network name to attach the routing container to for the
// container-IP path.
func (c *Client) PluginDialCandidates(ctx context.Context, id string, port int) (netTargets, directTargets []string, attachNet string, err error) {
	insp, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return nil, nil, "", err
	}
	ns := insp.NetworkSettings
	if ns == nil {
		return nil, nil, "", errors.New("container has no network settings")
	}
	// 1) container network IP — prefer a user network hope can attach to.
	var ip, ipNet, fbIP, fbNet string
	for name, ep := range ns.Networks {
		if ep == nil || ep.IPAddress == "" {
			continue
		}
		if name == "bridge" || name == "host" || name == "none" {
			if fbIP == "" {
				fbIP, fbNet = ep.IPAddress, name
			}
			continue
		}
		ip, ipNet = ep.IPAddress, name
		break
	}
	if ip == "" {
		ip, ipNet = fbIP, fbNet
	}
	if ip != "" {
		netTargets = append(netTargets, net.JoinHostPort(ip, strconv.Itoa(port)))
	}
	attachNet = ipNet
	// 2) published host port — directly reachable. For a remote TCP daemon the
	// wildcard bind is reachable at the daemon's host IP; for a local daemon it's
	// 127.0.0.1.
	hostIP := c.daemonHostIP()
	if hostIP == "" {
		hostIP = "127.0.0.1"
	}
	prefix := strconv.Itoa(port) + "/"
	for k, binds := range ns.Ports {
		if !strings.HasPrefix(string(k), prefix) {
			continue
		}
		for _, b := range binds {
			if b.HostPort == "" {
				continue
			}
			hip := b.HostIP
			if hip == "" || hip == "0.0.0.0" || hip == "::" {
				hip = hostIP
			}
			directTargets = append(directTargets, net.JoinHostPort(hip, b.HostPort))
		}
	}
	if len(netTargets) == 0 && len(directTargets) == 0 {
		return nil, nil, "", errors.New("container has no reachable address (no network IP, no published port)")
	}
	return netTargets, directTargets, attachNet, nil
}

// daemonHostIP returns the docker daemon's host IP when it's a remote TCP endpoint
// (tcp://host:port), or "" for a local socket / localhost — used to reach a plugin's
// published port on a remote host without an agent there.
func (c *Client) daemonHostIP() string {
	h := c.sdk().DaemonHost()
	if !strings.HasPrefix(h, "tcp://") {
		return ""
	}
	u, err := url.Parse(h)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	switch host {
	case "", "localhost", "127.0.0.1", "::1":
		return ""
	}
	return host
}

// ContainerMatchInfo returns a container's image ref + labels, for evaluating a
// plugin's container-surface match against it.
func (c *Client) ContainerMatchInfo(ctx context.Context, id string) (image string, labels map[string]string, err error) {
	insp, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return "", nil, err
	}
	if insp.Config != nil {
		image = insp.Config.Image
		labels = insp.Config.Labels
	}
	return image, labels, nil
}

// truthy reports whether a label value opts in (true/1/yes/on, case-insensitive).
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}
