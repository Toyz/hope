package pluginhost

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/docker"
)

// ContainerSurface is one enabled plugin's container-inspector contribution that
// applies to a given container: the plugin's identity + the layout node to render
// + the plugin's schema (so the renderer knows each ref's view kind).
type ContainerSurface struct {
	Key     string          `json:"key"`
	Name    string          `json:"name"`
	Icon    string          `json:"icon"`
	Title   string          `json:"title"`
	Node        json.RawMessage `json:"node"`
	Schema      json.RawMessage `json:"schema"`
	Actions     []string        `json:"actions,omitempty"`     // surface header actions (method refs)
	Subtitle    string          `json:"subtitle,omitempty"`    // page header sub/meta line (templated)
	Breadcrumbs []crumbDoc      `json:"breadcrumbs,omitempty"` // page breadcrumb trail (templated)
	Param       json.RawMessage `json:"param,omitempty"`       // page param merged into calls (dynamic pages)
}

// crumbDoc is one breadcrumb (label + optional plugin-relative target).
type crumbDoc struct {
	Label string `json:"label"`
	To    string `json:"to,omitempty"`
}

// SurfacesParams identifies the container being inspected.
type SurfacesParams struct {
	Host        string `json:"host"`
	ContainerID string `json:"container_id"`
}

// layoutDoc / matchDoc / schemaDoc mirror just the fields hope needs from the
// plugin's hope.layout + hope.schema (the rest is passed through as raw JSON).
type layoutDoc struct {
	Contributions []contributionDoc `json:"contributions"`
}
type contributionDoc struct {
	Surface  string          `json:"surface"`
	Title    string          `json:"title"`
	Icon     string          `json:"icon"`
	Match    *matchDoc       `json:"match"`
	Pages    []pageItemDoc   `json:"pages"`
	Node        json.RawMessage `json:"node"`
	Actions     []string        `json:"actions"`
	ID          string          `json:"id"`
	Hidden      bool            `json:"hidden"`
	ParamKey    string          `json:"param_key"`
	Subtitle    string          `json:"subtitle"`
	Breadcrumbs []crumbDoc      `json:"breadcrumbs"`
}

// fillTemplate substitutes {param} placeholders in s from the page param.
func fillTemplate(s string, param json.RawMessage) string {
	if s == "" || len(param) == 0 {
		return s
	}
	var m map[string]any
	if json.Unmarshal(param, &m) != nil {
		return s
	}
	return crumbVar.ReplaceAllStringFunc(s, func(tok string) string {
		if v, ok := m[tok[1:len(tok)-1]]; ok {
			return fmt.Sprint(v)
		}
		return tok
	})
}
type pageItemDoc struct {
	Title    string          `json:"title"`
	Icon     string          `json:"icon"`
	Param    json.RawMessage `json:"param"`
	Children []pageItemDoc   `json:"children"`
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

	r.scan(ctx, true) // fresh scan so a just-redeployed plugin resolves, not the stale container
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
		ep, err := r.dial(ctx, host, rep, rec.Token, false)
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
				Key:     rec.Key,
				Name:    sd.Name,
				Icon:    icon,
				Title:   title,
				Node:    c.Node,
				Schema:  schemaRaw,
				Actions: c.Actions,
			})
		}
	}
	return out, nil
}

// DashboardWidget is one enabled plugin's `dashboard`-surface contribution: the
// node to render on the fleet/host dashboard + the schema the renderer needs.
type DashboardWidget struct {
	Key     string          `json:"key"`
	Name    string          `json:"name"`
	Host    string          `json:"host"`
	Icon    string          `json:"icon"`
	Title   string          `json:"title"`
	Node    json.RawMessage `json:"node"`
	Schema  json.RawMessage `json:"schema"`
	Actions []string        `json:"actions,omitempty"`
}

// Dashboard returns the `dashboard`-surface contributions of every enabled plugin
// (fleet-wide, tagged with host so the UI can group them). Unlike container
// surfaces these aren't container-matched — a plugin declares a dashboard widget and
// hope renders it. Unreachable plugins are skipped, never fatal.
func (r *PluginsRouter) Dashboard(ctx *rpc.Context) ([]DashboardWidget, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	recs, _ := r.store.Plugins()
	out := []DashboardWidget{}
	r.scan(ctx, true)
	for _, rec := range recs {
		if !rec.Enabled {
			continue
		}
		members, host, ok := r.group(ctx, rec.Key)
		if !ok {
			continue
		}
		ep, err := r.dial(ctx, host, representative(members), rec.Token, false)
		if err != nil {
			continue
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
		for _, c := range ld.Contributions {
			if c.Surface != "dashboard" || len(c.Node) == 0 {
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
			out = append(out, DashboardWidget{
				Key: rec.Key, Name: sd.Name, Host: rec.Host, Icon: icon,
				Title: title, Node: c.Node, Schema: schemaRaw, Actions: c.Actions,
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

// PluginPageNode is one rail node in a plugin's page tree: a group (has Children)
// or a navigable leaf (has Path). Path addresses the page as a dotted index chain
// "<contribIndex>.<i>.<j>..." so Page can walk straight to it.
type PluginPageNode struct {
	Title    string           `json:"title"`
	Icon     string           `json:"icon,omitempty"`
	Path     string           `json:"path,omitempty"`
	Children []PluginPageNode `json:"children,omitempty"`
}

// PluginPages groups an enabled plugin's page tree for the rail (plugin -> pages).
type PluginPages struct {
	Key   string           `json:"key"`
	Name  string           `json:"name"`
	Host  string           `json:"host"`
	Icon  string           `json:"icon"`
	Pages []PluginPageNode `json:"pages"`
}

// Pages returns every enabled plugin (fleet-wide) that contributes `page` surfaces,
// as a rail tree (plugin -> groups -> pages).
func (r *PluginsRouter) Pages(ctx *rpc.Context) ([]PluginPages, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	recs, _ := r.store.Plugins()
	out := []PluginPages{}
	r.scan(ctx, true) // fresh scan so a just-redeployed plugin resolves, not the stale container
	for _, rec := range recs {
		if !rec.Enabled {
			continue
		}
		members, host, ok := r.group(ctx, rec.Key)
		if !ok {
			continue
		}
		ep, err := r.dial(ctx, host, representative(members), rec.Token, false)
		if err != nil {
			continue
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
		nodes := []PluginPageNode{}
		for ci, c := range ld.Contributions {
			if c.Surface != "page" || c.Hidden {
				continue // hidden pages (detail/link targets) aren't listed in the rail
			}
			if len(c.Pages) > 0 {
				nodes = append(nodes, buildPageNodes(c.Pages, strconv.Itoa(ci))...)
			} else if len(c.Node) > 0 {
				title := c.Title
				if title == "" {
					title = sd.Name
				}
				icon := c.Icon
				if icon == "" {
					icon = sd.Icon
				}
				// Prefer the stable id as the path so rail links and author
				// breadcrumbs/links target the SAME URL (else the rail can't mark the
				// page active when navigated to by id). Page() resolves either.
				path := strconv.Itoa(ci)
				if c.ID != "" {
					path = c.ID
				}
				nodes = append(nodes, PluginPageNode{Title: title, Icon: icon, Path: path})
			}
		}
		if len(nodes) > 0 {
			out = append(out, PluginPages{Key: rec.Key, Name: sd.Name, Host: host, Icon: sd.Icon, Pages: nodes})
		}
	}
	return out, nil
}

// buildPageNodes turns nested page items into rail nodes. Every node gets its
// dotted Path (a leaf's is navigable; a group's is the prefix, used by the rail to
// highlight the whole active branch).
func buildPageNodes(items []pageItemDoc, prefix string) []PluginPageNode {
	out := make([]PluginPageNode, 0, len(items))
	for i, it := range items {
		p := prefix + "." + strconv.Itoa(i)
		n := PluginPageNode{Title: it.Title, Icon: it.Icon, Path: p}
		if len(it.Children) > 0 {
			n.Children = buildPageNodes(it.Children, p)
		}
		out = append(out, n)
	}
	return out
}

// PageParams addresses one page by its dotted path (from PluginPageNode.Path).
type PageParams struct {
	Key  string `json:"key"`
	Path string `json:"path"`
	Arg  string `json:"arg,omitempty"` // master-detail: the URL arg for a DetailPage (param[ParamKey])
}

// Page returns the surface for one page: the contribution's shared node + schema +
// the selected page's Param (which the renderer merges into every call), so many
// pages can share one layout and differ only by argument.
func (r *PluginsRouter) Page(ctx *rpc.Context, p *PageParams) (*ContainerSurface, error) {
	if err := r.gate(); err != nil {
		return nil, err
	}
	if p == nil || p.Key == "" || p.Path == "" {
		return nil, rpc.BadRequest("key and path are required")
	}
	ep, _, err := r.enabledEndpoint(ctx, p.Key)
	if err != nil {
		return nil, err
	}
	schemaRaw, err := ep.callRPC(ctx, "hope.schema", nil)
	if err != nil {
		return nil, rpc.Internal("plugin schema: %v", err)
	}
	layoutRaw, err := ep.callRPC(ctx, "hope.layout", nil)
	if err != nil {
		return nil, rpc.Internal("plugin layout: %v", err)
	}
	var sd schemaDoc
	_ = json.Unmarshal(schemaRaw, &sd)
	var ld layoutDoc
	if err := json.Unmarshal(layoutRaw, &ld); err != nil {
		return nil, rpc.Internal("bad plugin layout: %v", err)
	}

	// Resolve the contribution by positional index (rail pages) OR by stable ID
	// (master-detail / link targets — a plugin addresses those by name, not index).
	segs := strings.Split(p.Path, ".")
	var c contributionDoc
	found := false
	if ci, cerr := strconv.Atoi(segs[0]); cerr == nil && ci >= 0 && ci < len(ld.Contributions) {
		c, found = ld.Contributions[ci], true
	} else {
		for _, cc := range ld.Contributions {
			if cc.Surface == "page" && cc.ID != "" && cc.ID == segs[0] {
				c, found = cc, true
				break
			}
		}
	}
	if !found {
		return nil, rpc.BadRequest("no such page")
	}
	if c.Surface != "page" || len(c.Node) == 0 {
		return nil, rpc.BadRequest("contribution is not a page")
	}

	// Walk any item path into the (possibly nested) pages to find the leaf's param.
	title := c.Title
	var param json.RawMessage
	items := c.Pages
	for _, seg := range segs[1:] {
		idx, err := strconv.Atoi(seg)
		if err != nil || idx < 0 || idx >= len(items) {
			return nil, rpc.BadRequest("no such page")
		}
		it := items[idx]
		title = it.Title
		param = it.Param
		items = it.Children
	}
	if title == "" {
		title = sd.Name
	}
	// Master-detail: the URL arg becomes param[ParamKey], merged over any positional
	// page param — so the detail page's handlers read the clicked entity's id.
	if c.ParamKey != "" && p.Arg != "" {
		m := map[string]any{}
		if len(param) > 0 {
			_ = json.Unmarshal(param, &m)
		}
		m[c.ParamKey] = p.Arg
		if b, merr := json.Marshal(m); merr == nil {
			param = b
		}
	}
	icon := c.Icon
	if icon == "" {
		icon = sd.Icon
	}
	return &ContainerSurface{
		Key: p.Key, Name: sd.Name, Icon: icon, Title: title, Node: c.Node,
		Schema: schemaRaw, Actions: c.Actions, Subtitle: fillTemplate(c.Subtitle, param),
		Breadcrumbs: fillCrumbs(c.Breadcrumbs, param), Param: param,
	}, nil
}

// crumbVar matches a {name} placeholder in a breadcrumb label/target.
var crumbVar = regexp.MustCompile(`\{(\w+)\}`)

// fillCrumbs substitutes {param} placeholders in each crumb's label + target from
// the page param, so a detail page's trail reads e.g. "Users / user 42".
func fillCrumbs(crumbs []crumbDoc, param json.RawMessage) []crumbDoc {
	if len(crumbs) == 0 {
		return nil
	}
	var m map[string]any
	if len(param) > 0 {
		_ = json.Unmarshal(param, &m)
	}
	sub := func(s string) string {
		return crumbVar.ReplaceAllStringFunc(s, func(tok string) string {
			k := tok[1 : len(tok)-1]
			if v, ok := m[k]; ok {
				return fmt.Sprint(v)
			}
			return tok
		})
	}
	out := make([]crumbDoc, len(crumbs))
	for i, cr := range crumbs {
		out[i] = crumbDoc{Label: sub(cr.Label), To: sub(cr.To)}
	}
	return out
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
