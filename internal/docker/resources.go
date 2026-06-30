package docker

import (
	"context"
	"sort"
	"strings"

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
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Driver   string         `json:"driver"`
	Scope    string         `json:"scope"`
	Internal bool           `json:"internal"`
	Created  int64          `json:"created"` // unix seconds
	UsedBy   []ResourceUser `json:"used_by"`
}

// VolumeInfo is a Docker volume plus the containers mounting it.
type VolumeInfo struct {
	Name       string         `json:"name"`
	Driver     string         `json:"driver"`
	Mountpoint string         `json:"mountpoint"`
	CreatedAt  string         `json:"created_at"`
	UsedBy     []ResourceUser `json:"used_by"`
}

// userFrom builds a ResourceUser from a container summary.
func userFrom(ct container.Summary) ResourceUser {
	name := ""
	if len(ct.Names) > 0 {
		name = strings.TrimPrefix(ct.Names[0], "/")
	}
	return ResourceUser{ID: ct.ID, Name: name, Service: ct.Labels[labelService], Project: ct.Labels[labelProject]}
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
		out = append(out, NetworkInfo{
			ID:       n.ID,
			Name:     n.Name,
			Driver:   n.Driver,
			Scope:    n.Scope,
			Internal: n.Internal,
			Created:  n.Created.Unix(),
			UsedBy:   users,
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

// RemoveNetwork deletes a network by id.
func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	return c.sdk().NetworkRemove(ctx, id)
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
		out = append(out, VolumeInfo{
			Name:       v.Name,
			Driver:     v.Driver,
			Mountpoint: v.Mountpoint,
			CreatedAt:  v.CreatedAt,
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
