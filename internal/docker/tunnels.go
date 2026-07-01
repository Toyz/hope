package docker

import (
	"context"
	"sort"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
)

// Labels that mark a cloudflared container as a hope-managed tunnel connector.
const (
	labelTunnel         = "ink.hope.tunnel"            // value = Cloudflare tunnel id
	labelConnectorTitle = "ink.hope.connector"         // optional friendly name
	labelConnectorFirst = "ink.hope.connector.default" // "1" => the default/shared connector
	hopeTunnelsNetwork  = "hope-tunnels"               // fallback user-defined net for bridge-only origins
)

// Connector is a cloudflared container hope will manage routes for.
type Connector struct {
	ContainerID string   `json:"container_id"`
	Name        string   `json:"name"` // container name (no leading slash)
	TunnelID    string   `json:"tunnel_id"`
	Title       string   `json:"title"`    // friendly label, else name
	Default     bool     `json:"default"`  // the shared/default connector
	Project     string   `json:"project"`  // compose project, if the connector lives in a stack
	Networks    []string `json:"networks"` // user-defined networks it's attached to
	Image       string   `json:"image"`    // the cloudflared image ref
	Running     bool     `json:"running"`
}

// Connectors lists hope-managed cloudflared connectors on this daemon.
func (c *Client) Connectors(ctx context.Context) ([]Connector, error) {
	f := filters.NewArgs(filters.Arg("label", labelTunnel))
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, err
	}
	out := make([]Connector, 0, len(list))
	for _, ct := range list {
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		title := ct.Labels[labelConnectorTitle]
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
		out = append(out, Connector{
			ContainerID: ct.ID,
			Name:        name,
			TunnelID:    ct.Labels[labelTunnel],
			Title:       title,
			Default:     ct.Labels[labelConnectorFirst] == "1",
			Project:     ct.Labels[labelProject],
			Networks:    nets,
			Image:       ct.Image,
			Running:     ct.State == "running",
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Default != out[j].Default {
			return out[i].Default // default first
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// OriginRef identifies a tunnel origin (a container) so ingress URLs can be
// resolved back to a stack/service in the UI.
type OriginRef struct {
	ContainerID string
	Name        string // container name
	Project     string
	Service     string
	Networks    []string // user-defined networks this container is on
	Aliases     []string // per-network aliases (union)
}

// OriginIndex maps container name AND per-network alias -> OriginRef, so an
// ingress service URL host ("blog-web-1" or "hope-blog-web") resolves to a stack.
func (c *Client) OriginIndex(ctx context.Context) (map[string]OriginRef, error) {
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}
	idx := map[string]OriginRef{}
	for _, ct := range list {
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		ref := OriginRef{
			ContainerID: ct.ID,
			Name:        name,
			Project:     ct.Labels[labelProject],
			Service:     ct.Labels[labelService],
		}
		if ct.NetworkSettings != nil {
			for n, ep := range ct.NetworkSettings.Networks {
				if n == "bridge" || n == "host" || n == "none" {
					continue
				}
				ref.Networks = append(ref.Networks, n)
				for _, a := range ep.Aliases {
					ref.Aliases = append(ref.Aliases, a)
					idx[a] = ref
				}
			}
		}
		if name != "" {
			idx[name] = ref
		}
		// The replica alias hope assigns (ContainerList doesn't return endpoint
		// aliases, so reconstruct it from labels) — so a replicated service's
		// route origin resolves back to its stack/service.
		if ref.Project != "" && ref.Service != "" {
			idx["hope-"+ref.Project+"-"+ref.Service] = ref
		}
	}
	return idx, nil
}

// ContainerNetworks returns the user-defined networks a container is attached to.
func (c *Client) ContainerNetworks(ctx context.Context, id string) ([]string, error) {
	insp, err := c.sdk().ContainerInspect(ctx, id)
	if err != nil {
		return nil, err
	}
	var nets []string
	if insp.NetworkSettings != nil {
		for n := range insp.NetworkSettings.Networks {
			if n != "bridge" && n != "host" && n != "none" {
				nets = append(nets, n)
			}
		}
	}
	sort.Strings(nets)
	return nets, nil
}

// AttachNetwork connects a container to a network (optionally with aliases). A
// no-op-safe wrapper: "already exists" is treated as success.
func (c *Client) AttachNetwork(ctx context.Context, containerID, netName string, aliases []string) error {
	var cfg *network.EndpointSettings
	if len(aliases) > 0 {
		cfg = &network.EndpointSettings{Aliases: aliases}
	}
	err := c.sdk().NetworkConnect(ctx, netName, containerID, cfg)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return nil
	}
	return err
}

// DetachNetwork disconnects a container from a network (ignores "not connected").
func (c *Client) DetachNetwork(ctx context.Context, containerID, netName string) error {
	err := c.sdk().NetworkDisconnect(ctx, netName, containerID, false)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "not connected") {
		return nil
	}
	return err
}

// connectorImage is the cloudflared image hope deploys.
const connectorImage = "cloudflare/cloudflared:latest"

// DeployConnector pulls cloudflared and runs it as a hope-managed connector for
// the given tunnel token, labeled so Connectors() discovers it. Returns the new
// container id.
func (c *Client) DeployConnector(ctx context.Context, name, tunnelID, token string, isDefault bool) (string, error) {
	if err := c.PullImage(ctx, connectorImage); err != nil {
		return "", err
	}
	labels := map[string]string{
		labelTunnel:         tunnelID,
		labelConnectorTitle: name,
	}
	if isDefault {
		labels[labelConnectorFirst] = "1"
	}
	cfg := &container.Config{
		Image:  connectorImage,
		Cmd:    []string{"tunnel", "--no-autoupdate", "run", "--token", token},
		Labels: labels,
	}
	host := &container.HostConfig{
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
	}
	cname := "hope-connector-" + sanitizeName(name)
	created, err := c.sdk().ContainerCreate(ctx, cfg, host, nil, nil, cname)
	if err != nil {
		return "", err
	}
	if err := c.sdk().ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return "", err
	}
	return created.ID, nil
}

// sanitizeName makes a docker-safe container name suffix.
func sanitizeName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-_")
	if out == "" {
		out = "cf"
	}
	return out
}

// EnsureTunnelsNetwork makes sure the fallback user-defined bridge exists (for
// loose containers that only have the default bridge, which lacks name DNS).
func (c *Client) EnsureTunnelsNetwork(ctx context.Context) (string, error) {
	f := filters.NewArgs(filters.Arg("name", hopeTunnelsNetwork))
	nets, err := c.sdk().NetworkList(ctx, network.ListOptions{Filters: f})
	if err != nil {
		return "", err
	}
	for _, n := range nets {
		if n.Name == hopeTunnelsNetwork {
			return hopeTunnelsNetwork, nil
		}
	}
	if _, err := c.sdk().NetworkCreate(ctx, hopeTunnelsNetwork, network.CreateOptions{Driver: "bridge"}); err != nil {
		return "", err
	}
	return hopeTunnelsNetwork, nil
}
