package docker

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
)

// ResourceUser is a container that references a network or volume, with its
// compose identity so the UI can group/link it.
type ResourceUser struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Service string `json:"service"`
	Project string `json:"project"`
}

// NetworkInfo is a Docker network plus the containers attached to it.
type NetworkInfo struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Driver     string            `json:"driver"`
	Scope      string            `json:"scope"`
	Internal   bool              `json:"internal"`
	Attachable bool              `json:"attachable"`
	IPv6       bool              `json:"ipv6"`
	Subnet     string            `json:"subnet"`  // first IPAM pool
	Gateway    string            `json:"gateway"` // first IPAM gateway
	Options    map[string]string `json:"options"`
	Labels     map[string]string `json:"labels,omitempty"`
	Created    int64             `json:"created"` // unix seconds
	UsedBy     []ResourceUser    `json:"used_by"`
}

// VolumeInfo is a Docker volume plus the containers mounting it.
type VolumeInfo struct {
	Name       string            `json:"name"`
	Driver     string            `json:"driver"`
	Mountpoint string            `json:"mountpoint"`
	CreatedAt  string            `json:"created_at"`
	Scope      string            `json:"scope,omitempty"`
	Size       int64             `json:"size"` // bytes; -1 when the daemon didn't compute it
	Options    map[string]string `json:"options,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	UsedBy     []ResourceUser    `json:"used_by"`
}

// userFrom builds a ResourceUser from a container summary.
func userFrom(ct container.Summary) ResourceUser {
	name := ""
	if len(ct.Names) > 0 {
		name = strings.TrimPrefix(ct.Names[0], "/")
	}
	return ResourceUser{ID: ct.ID, Name: name, Service: serviceLabel(ct.Labels), Project: projectLabel(ct.Labels)}
}

// Networks lists Docker networks with the containers attached to each (the
// "who's on this network" reverse mapping), busiest first.
func (c *Client) Networks(ctx context.Context) ([]NetworkInfo, error) {
	nets, err := c.sdk().NetworkList(ctx, network.ListOptions{})
	if err != nil {
		return nil, err
	}
	byNet := map[string][]ResourceUser{} // keyed by network name
	if conts, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true}); err == nil {
		for _, ct := range conts {
			if ct.NetworkSettings == nil {
				continue
			}
			u := userFrom(ct)
			for name := range ct.NetworkSettings.Networks {
				byNet[name] = append(byNet[name], u)
			}
		}
	}
	out := make([]NetworkInfo, 0, len(nets))
	for _, n := range nets {
		users := byNet[n.Name]
		if users == nil {
			users = []ResourceUser{}
		}
		subnet, gateway := "", ""
		if len(n.IPAM.Config) > 0 {
			subnet = n.IPAM.Config[0].Subnet
			gateway = n.IPAM.Config[0].Gateway
		}
		out = append(out, NetworkInfo{
			ID:         n.ID,
			Name:       n.Name,
			Driver:     n.Driver,
			Scope:      n.Scope,
			Internal:   n.Internal,
			Attachable: n.Attachable,
			IPv6:       n.EnableIPv6,
			Subnet:     subnet,
			Gateway:    gateway,
			Options:    n.Options,
			Labels:     n.Labels,
			Created:    n.Created.Unix(),
			UsedBy:     users,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].UsedBy) != len(out[j].UsedBy) {
			return len(out[i].UsedBy) > len(out[j].UsedBy)
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// NetworkByRef finds a single network by id (full or short) or exact name, with
// its attached-container mapping — for the shared network-detail modal opened
// from anywhere a network is shown. Returns (nil, nil) when nothing matches.
func (c *Client) NetworkByRef(ctx context.Context, ref string) (*NetworkInfo, error) {
	nets, err := c.Networks(ctx)
	if err != nil {
		return nil, err
	}
	for i := range nets {
		n := &nets[i]
		if n.ID == ref || n.Name == ref || (len(ref) >= 8 && strings.HasPrefix(n.ID, ref)) {
			return n, nil
		}
	}
	return nil, nil
}

// RemoveNetwork deletes a network by id.
func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	// Refuse to delete a protected network (mirrors the UI guard). The daemon already
	// rejects its own predefined nets; hope additionally protects its infrastructure
	// bridges (ink-plugins, hope-tunnels) which the daemon WOULD remove — doing so
	// severs plugin/tunnel connectivity. Best-effort: if inspect fails we fall through
	// and let NetworkRemove report the real error.
	if n, err := c.sdk().NetworkInspect(ctx, id, network.InspectOptions{}); err == nil && protectedNetwork(n.Name, n.Labels) {
		return fmt.Errorf("network %q is protected by hope and can't be removed", n.Name)
	}
	return c.sdk().NetworkRemove(ctx, id)
}

// protectedNetwork reports whether a network must never be deleted: the daemon's
// predefined nets (Docker bridge/host/none, Podman's default), or a hope
// infrastructure bridge — recognized by the LabelSystem marker, with a name fallback
// for bridges created before the label existed.
func protectedNetwork(name string, labels map[string]string) bool {
	switch name {
	case "bridge", "host", "none", "podman", PluginNetwork, hopeTunnelsNetwork:
		return true
	}
	return labels[LabelSystem] != ""
}

// RemoveVolume deletes a volume by name (force removes even if referenced).
func (c *Client) RemoveVolume(ctx context.Context, name string, force bool) error {
	return c.sdk().VolumeRemove(ctx, name, force)
}

// Volumes lists Docker volumes with the containers mounting each (the reverse
// mapping), busiest first.
func (c *Client) Volumes(ctx context.Context) ([]VolumeInfo, error) {
	resp, err := c.sdk().VolumeList(ctx, volume.ListOptions{})
	if err != nil {
		return nil, err
	}
	// Per-volume size comes from `system df` (VolumeList omits it). -1 when the
	// daemon couldn't compute it.
	sizes := map[string]int64{}
	if du, e := c.sdk().DiskUsage(ctx, types.DiskUsageOptions{Types: []types.DiskUsageObject{types.VolumeObject}}); e == nil {
		for _, v := range du.Volumes {
			if v != nil && v.UsageData != nil {
				sizes[v.Name] = v.UsageData.Size
			}
		}
	}
	byVol := map[string][]ResourceUser{}
	if conts, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true}); err == nil {
		for _, ct := range conts {
			u := userFrom(ct)
			for _, m := range ct.Mounts {
				if m.Type == "volume" && m.Name != "" {
					byVol[m.Name] = append(byVol[m.Name], u)
				}
			}
		}
	}
	out := make([]VolumeInfo, 0, len(resp.Volumes))
	for _, v := range resp.Volumes {
		if v == nil {
			continue
		}
		users := byVol[v.Name]
		if users == nil {
			users = []ResourceUser{}
		}
		sz, ok := sizes[v.Name]
		if !ok {
			sz = -1
		}
		out = append(out, VolumeInfo{
			Name:       v.Name,
			Driver:     v.Driver,
			Mountpoint: v.Mountpoint,
			CreatedAt:  v.CreatedAt,
			Scope:      v.Scope,
			Size:       sz,
			Options:    v.Options,
			Labels:     v.Labels,
			UsedBy:     users,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].UsedBy) != len(out[j].UsedBy) {
			return len(out[i].UsedBy) > len(out[j].UsedBy)
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}
