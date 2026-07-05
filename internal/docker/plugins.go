package docker

import (
	"context"
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

// truthy reports whether a label value opts in (true/1/yes/on, case-insensitive).
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}
