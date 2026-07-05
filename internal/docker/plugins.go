package docker

import (
	"context"
	"errors"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

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
// Errors only if the container exposes neither.
func (c *Client) PluginDialCandidates(ctx context.Context, id string, port int) (targets []string, attachNet string, err error) {
	insp, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return nil, "", err
	}
	ns := insp.NetworkSettings
	if ns == nil {
		return nil, "", errors.New("container has no network settings")
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
		targets = append(targets, net.JoinHostPort(ip, strconv.Itoa(port)))
	}
	attachNet = ipNet
	// 2) published host port — the dev fast path for native hope.
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
				hip = "127.0.0.1"
			}
			targets = append(targets, net.JoinHostPort(hip, b.HostPort))
		}
	}
	if len(targets) == 0 {
		return nil, "", errors.New("container has no reachable address (no network IP, no published port)")
	}
	return targets, attachNet, nil
}

// truthy reports whether a label value opts in (true/1/yes/on, case-insensitive).
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}
