package pluginhost

import (
	"encoding/json"
	"path"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
)

// ContainerSurface is one enabled plugin's container-inspector contribution that
// applies to a given container: the plugin's identity + the layout node to render
// + the plugin's schema (so the renderer knows each ref's view kind).
type ContainerSurface struct {
	Key    string          `json:"key"`
	Name   string          `json:"name"`
	Icon   string          `json:"icon"`
	Title  string          `json:"title"`
	Node   json.RawMessage `json:"node"`
	Schema json.RawMessage `json:"schema"`
}

// SurfacesParams identifies the container being inspected.
type SurfacesParams struct {
	Host        string `json:"host"`
	ContainerID string `json:"container_id"`
}

// layoutDoc / matchDoc / schemaDoc mirror just the fields hope needs from the
// plugin's hope.layout + hope.schema (the rest is passed through as raw JSON).
type layoutDoc struct {
	Contributions []struct {
		Surface string          `json:"surface"`
		Title   string          `json:"title"`
		Icon    string          `json:"icon"`
		Match   *matchDoc       `json:"match"`
		Node    json.RawMessage `json:"node"`
	} `json:"contributions"`
}
type matchDoc struct {
	Always   bool              `json:"always"`
	Images   []string          `json:"images"`
	Labels   map[string]string `json:"labels"`
	Services []string          `json:"services"`
}
type schemaDoc struct {
	Name string `json:"name"`
	Icon string `json:"icon"`
}

// Surfaces returns the container-surface contributions of every enabled plugin on
// the container's host that MATCH this container — what the container inspector
// renders as plugin tabs. An empty match means "the plugin's own container".
func (r *PluginsRouter) Surfaces(ctx *rpc.Context, p *SurfacesParams) ([]ContainerSurface, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if p == nil || p.Host == "" || p.ContainerID == "" {
		return nil, rpc.BadRequest("host and container_id are required")
	}
	recs, _ := r.store.Plugins()
	if len(recs) == 0 {
		return []ContainerSurface{}, nil
	}

	// The target container's match attributes (image + labels), read once.
	var image string
	var labels map[string]string
	if hc, ok := r.hostClient(p.Host); ok && hc.Client != nil {
		image, labels, _ = hc.Client.ContainerMatchInfo(ctx, p.ContainerID)
	}

	out := []ContainerSurface{}
	for _, rec := range recs {
		if !rec.Enabled || rec.Host != p.Host {
			continue
		}
		members, host, ok := r.group(ctx, rec.Key)
		if !ok {
			continue
		}
		rep := representative(members)
		ep, err := r.dial(ctx, host, rep, rec.Token)
		if err != nil {
			continue // unreachable plugin — skip, don't fail the whole inspector
		}
		schemaRaw, err := ep.callRPC(ctx, "hope.schema", nil)
		if err != nil {
			continue
		}
		layoutRaw, err := ep.callRPC(ctx, "hope.layout", nil)
		if err != nil {
			continue
		}
		var sd schemaDoc
		_ = json.Unmarshal(schemaRaw, &sd)
		var ld layoutDoc
		if err := json.Unmarshal(layoutRaw, &ld); err != nil {
			continue
		}
		ownContainer := p.ContainerID == rep.ContainerID
		for _, c := range ld.Contributions {
			if c.Surface != "container" || len(c.Node) == 0 {
				continue
			}
			if !surfaceApplies(c.Match, ownContainer, image, labels) {
				continue
			}
			title := c.Title
			if title == "" {
				title = sd.Name
			}
			icon := c.Icon
			if icon == "" {
				icon = sd.Icon
			}
			out = append(out, ContainerSurface{
				Key:    rec.Key,
				Name:   sd.Name,
				Icon:   icon,
				Title:  title,
				Node:   c.Node,
				Schema: schemaRaw,
			})
		}
	}
	return out, nil
}

// surfaceApplies evaluates a container contribution's match. Nil/empty match =>
// the plugin's OWN container only. Otherwise set clauses are AND-ed and values
// within a clause OR-ed (image globs, label equality, compose service).
func surfaceApplies(m *matchDoc, ownContainer bool, image string, labels map[string]string) bool {
	if m == nil || (!m.Always && len(m.Images) == 0 && len(m.Labels) == 0 && len(m.Services) == 0) {
		return ownContainer
	}
	if m.Always {
		return true
	}
	if len(m.Images) > 0 && !anyGlob(m.Images, image) {
		return false
	}
	for k, v := range m.Labels {
		if labels[k] != v {
			return false
		}
	}
	if len(m.Services) > 0 {
		svc := labels[docker.LabelService]
		if !contains(m.Services, svc) {
			return false
		}
	}
	return true
}

func anyGlob(globs []string, s string) bool {
	for _, g := range globs {
		if ok, _ := path.Match(g, s); ok {
			return true
		}
	}
	return false
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
