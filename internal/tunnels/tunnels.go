// Package tunnels exposes the TunnelsRouter: manage a Cloudflare tunnel's public
// routes per stack. hope doesn't run cloudflared — you run a connector (a
// cloudflared container labeled ink.hope.tunnel=<tunnel-id>) and hope manages its
// ingress + the matching DNS via the Cloudflare API. Wire name: "Tunnels".
package tunnels

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
	"sync"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/cloudflare"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

var (
	errNoContainer = errors.New("target container not found")
	errNoTarget    = errors.New("no matching service to target")
	errNoNetwork   = errors.New("target has no user-defined network to attach")
)

// TunnelsRouter manages tunnel routes on the active host's connectors.
type TunnelsRouter struct {
	hosts *hosts.Set
	cf    *cloudflare.Client
}

// NewTunnelsRouter wires the router to the host set + Cloudflare client (cf may
// be nil when the integration is disabled).
func NewTunnelsRouter(hs *hosts.Set, cf *cloudflare.Client) *TunnelsRouter {
	return &TunnelsRouter{hosts: hs, cf: cf}
}

func (r *TunnelsRouter) dock(ctx context.Context) *docker.Client { return r.hosts.ActiveFor(ctx) }

// enabled gates every method: without a Cloudflare client the domain is off.
func (r *TunnelsRouter) enabled(ctx *rpc.Context) error {
	if r.cf == nil {
		return rpc.BadRequest("cloudflare integration is disabled (set [cloudflare] in config)")
	}
	return nil
}

// ConnectorView is one connector (a cloudflared container) + its live status.
type ConnectorView struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	TunnelID    string   `json:"tunnel_id"`
	Default     bool     `json:"default"`
	Running     bool     `json:"running"`     // container running
	Online      bool     `json:"online"`      // tunnel healthy per Cloudflare
	Status      string   `json:"status"`      // healthy | degraded | down | inactive
	Connections int      `json:"connections"` // active edge connections
	Colos       []string `json:"colos"`       // distinct edge locations (LAX, SJC…)
	Version     string   `json:"version"`     // cloudflared version reported by a connection
	CreatedAt   string   `json:"created_at"`  // tunnel creation time
	Project     string   `json:"project"`     // set when the connector lives in a stack
	Networks    []string `json:"networks"`
	Routes      int      `json:"routes"`       // ingress rules pointing through it
	UpdateReady bool     `json:"update_ready"` // a newer cloudflared image is available
}

// Connectors lists hope-managed connectors on the active host with tunnel status.
func (r *TunnelsRouter) Connectors(ctx *rpc.Context) ([]ConnectorView, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	cons, err := r.dock(ctx).Connectors(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	out := make([]ConnectorView, len(cons))
	var wg sync.WaitGroup
	for i, c := range cons {
		out[i] = r.baseView(ctx, c)
		wg.Add(1)
		go func(i int, tunnelID string) {
			defer wg.Done()
			r.enrich(ctx, &out[i], tunnelID)
		}(i, c.TunnelID)
	}
	wg.Wait()
	return out, nil
}

// ConnectorParams targets a single connector container by id.
type ConnectorParams struct {
	ID string `sov:"id,0,required" json:"id"`
}

// Connector returns one connector (by container id) with full tunnel status, so
// the UI can deep-link/refresh a single connector without listing every one. Host-
// aware: it resolves against the active host, so the inspector must query the
// connector's own host (X-Hope-Host) in fleet mode.
func (r *TunnelsRouter) Connector(ctx *rpc.Context, p *ConnectorParams) (*ConnectorView, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	con, ok := r.findConnector(ctx, p.ID)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	v := r.baseView(ctx, con)
	r.enrich(ctx, &v, con.TunnelID)
	return &v, nil
}

// baseView is the connector fields known from Docker alone (no Cloudflare call).
func (r *TunnelsRouter) baseView(ctx *rpc.Context, c docker.Connector) ConnectorView {
	return ConnectorView{
		ID: c.ContainerID, Name: c.Name, Title: c.Title, TunnelID: c.TunnelID,
		Default: c.Default, Running: c.Running, Project: c.Project, Networks: c.Networks,
		UpdateReady: r.dock(ctx).CachedStatus(c.Image) == "outdated",
	}
}

// enrich fills the live Cloudflare status (health, connections, edge colos,
// version, route count) onto a view. Best-effort: leaves fields zero on error.
func (r *TunnelsRouter) enrich(ctx *rpc.Context, v *ConnectorView, tunnelID string) {
	if d, err := r.cf.TunnelStatus(ctx, tunnelID); err == nil {
		v.Status = d.Status
		v.Online = d.Status == "healthy" || d.Status == "degraded"
		v.Connections = len(d.Connections)
		v.CreatedAt = d.CreatedAt
		if d.Name != "" {
			v.Title = d.Name // live tunnel name, so renames show without a recreate
		}
		seen := map[string]bool{}
		for _, cn := range d.Connections {
			if cn.ColoName != "" && !seen[cn.ColoName] {
				seen[cn.ColoName] = true
				v.Colos = append(v.Colos, cn.ColoName)
			}
			if v.Version == "" {
				v.Version = cn.ClientVersion
			}
		}
		sort.Strings(v.Colos)
	}
	if rules, err := r.cf.TunnelConfig(ctx, tunnelID); err == nil {
		v.Routes = countRoutes(rules)
	}
}

// TunnelView is one public route: a hostname served through a connector.
type TunnelView struct {
	Hostname  string `json:"hostname"`
	Path      string `json:"path,omitempty"`
	Service   string `json:"service"`   // raw ingress origin, e.g. http://blog-web-1:8080
	Connector string `json:"connector"` // connector container name
	TunnelID  string `json:"tunnel_id"`
	Project     string `json:"project"` // resolved stack, if known
	SvcName     string `json:"svc_name"`
	Container   string `json:"container"`    // origin container name
	ContainerID string `json:"container_id"` // origin container id, so the UI can deep-link it
	Port        string `json:"port"`
}

// Tunnels lists every route across the active host's connectors (read from each
// tunnel's ingress config, resolved back to a stack/service where possible).
func (r *TunnelsRouter) Tunnels(ctx *rpc.Context) ([]TunnelView, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	cons, err := r.dock(ctx).Connectors(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	idx, err := r.dock(ctx).OriginIndex(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	var out []TunnelView
	for _, c := range cons {
		rules, err := r.cf.TunnelConfig(ctx, c.TunnelID)
		if err != nil {
			continue // a connector whose config we can't read is skipped, not fatal
		}
		for _, rule := range rules {
			if rule.Hostname == "" { // catch-all
				continue
			}
			host, port := splitOrigin(rule.Service)
			tv := TunnelView{
				Hostname: rule.Hostname, Path: rule.Path, Service: rule.Service,
				Connector: c.Name, TunnelID: c.TunnelID, Port: port,
			}
			if ref, ok := idx[host]; ok {
				tv.Project = ref.Project
				tv.SvcName = ref.Service
				tv.Container = ref.Name
				tv.ContainerID = ref.ContainerID
			}
			out = append(out, tv)
		}
	}
	return out, nil
}

// ZoneView is a selectable Cloudflare zone (domain) for the hostname picker.
type ZoneView struct {
	Name string `json:"name"`
}

// Zones lists the domains the token can see, so the UI can offer a domain picker
// instead of a free-text hostname.
func (r *TunnelsRouter) Zones(ctx *rpc.Context) ([]ZoneView, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	zs, err := r.cf.Zones(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	out := make([]ZoneView, len(zs))
	for i, z := range zs {
		out[i] = ZoneView{Name: z.Name}
	}
	return out, nil
}

// ── connector lifecycle ─────────────────────────────────────────────────

// CreateConnectorParams names a new hope-deployed connector.
type CreateConnectorParams struct {
	Name string `sov:"name,0,required" json:"name"`
}

// CreateConnector creates a remotely-managed tunnel in Cloudflare and runs a
// cloudflared container for it on the active host (labeled as the shared/default
// connector). hope owns this container's lifecycle.
func (r *TunnelsRouter) CreateConnector(ctx *rpc.Context, p *CreateConnectorParams) (*docker.Connector, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Name) == "" {
		return nil, rpc.BadRequest("name required")
	}
	id, token, err := r.cf.CreateTunnel(ctx, p.Name)
	if err != nil {
		return nil, rpc.Internal("create tunnel: %v", err)
	}
	// First connector on this host becomes the default/shared one.
	existing, _ := r.dock(ctx).Connectors(ctx)
	isDefault := !hasDefault(existing)
	cid, err := r.dock(ctx).DeployConnector(ctx, p.Name, id, token, isDefault)
	if err != nil {
		// Best-effort rollback so we don't leave an orphan tunnel.
		_ = r.cf.DeleteTunnel(ctx, id)
		return nil, rpc.Internal("deploy cloudflared: %v", err)
	}
	return &docker.Connector{ContainerID: cid, Name: p.Name, Title: p.Name, TunnelID: id, Default: isDefault, Running: true}, nil
}

// RenameConnectorParams renames a connector's Cloudflare tunnel + hope title.
type RenameConnectorParams struct {
	ID   string `sov:"id,0,required" json:"id"`
	Name string `sov:"name,1,required" json:"name"`
}

// RenameConnector renames the connector's Cloudflare tunnel. This is a pure
// Cloudflare API change — the cloudflared container is NOT touched, so its route
// ingress (which lives in the tunnel config) and its Docker network attachments
// (added per-route so it can reach origins) are preserved. The connector's
// displayed title reads the live tunnel name (see Connectors), so it updates
// without a container recreate.
func (r *TunnelsRouter) RenameConnector(ctx *rpc.Context, p *RenameConnectorParams) (*RouteResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(p.Name)
	if name == "" {
		return nil, rpc.BadRequest("name required")
	}
	con, ok := r.findConnector(ctx, p.ID)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	if err := r.cf.RenameTunnel(ctx, con.TunnelID, name); err != nil {
		return nil, rpc.Internal("rename tunnel: %v", err)
	}
	return &RouteResult{OK: true}, nil
}

// RemoveConnectorParams targets a connector container (and optionally its tunnel).
type RemoveConnectorParams struct {
	ID           string `sov:"id,0,required" json:"id"`
	DeleteTunnel bool   `sov:"delete_tunnel,1" json:"delete_tunnel"`
}

// RemoveConnector stops+removes a connector container, optionally deleting the
// Cloudflare tunnel too (only hope-deployed ones should be fully deleted).
func (r *TunnelsRouter) RemoveConnector(ctx *rpc.Context, p *RemoveConnectorParams) (*RouteResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	con, ok := r.findConnector(ctx, p.ID)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	if err := r.dock(ctx).Remove(ctx, con.ContainerID); err != nil {
		return nil, rpc.Internal("remove connector: %v", err)
	}
	if p.DeleteTunnel && con.TunnelID != "" {
		if err := r.cf.DeleteTunnel(ctx, con.TunnelID); err != nil {
			return &RouteResult{OK: false, Error: "container removed but tunnel delete failed: " + err.Error()}, nil
		}
	}
	return &RouteResult{OK: true}, nil
}

// ── routes ──────────────────────────────────────────────────────────────

// RouteResult is a simple outcome envelope.
type RouteResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Origin     string `json:"origin,omitempty"`     // resolved ingress origin
	Reattached bool   `json:"reattached,omitempty"` // replicas were briefly reattached
}

// AddTunnelParams describes a route to add. Target is either a compose service
// (Project+Service) or a specific container (Container id, for loose containers).
type AddTunnelParams struct {
	Hostname  string `sov:"hostname,0,required" json:"hostname"`
	Port      string `sov:"port,1,required" json:"port"`
	Connector string `sov:"connector,2,required" json:"connector"` // connector container id
	Project   string `sov:"project,3" json:"project"`
	Service   string `sov:"service,4" json:"service"`
	Container string `sov:"container,5" json:"container"` // loose-container id
	Path      string `sov:"path,6" json:"path"`           // optional path prefix (e.g. /api)
}

// AddTunnel wires hostname -> service through a connector: attaches the connector
// to the origin's network, upserts the tunnel ingress, and ensures the DNS CNAME.
func (r *TunnelsRouter) AddTunnel(ctx *rpc.Context, p *AddTunnelParams) (*RouteResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	host := strings.ToLower(strings.TrimSpace(p.Hostname))
	if host == "" || p.Port == "" {
		return nil, rpc.BadRequest("hostname and port are required")
	}
	con, ok := r.findConnector(ctx, p.Connector)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	origin, netName, reattached, err := r.resolveOrigin(ctx, con, p)
	if err != nil {
		return nil, rpc.BadRequest("%v", err)
	}
	// Ensure the connector can reach the origin (additive; a per-stack connector
	// already on the network is a no-op).
	if netName != "" {
		if err := r.dock(ctx).AttachNetwork(ctx, con.ContainerID, netName, nil); err != nil {
			return nil, rpc.Internal("attach connector to %s: %v", netName, err)
		}
	}
	// Upsert ingress.
	rules, err := r.cf.TunnelConfig(ctx, con.TunnelID)
	if err != nil {
		return nil, rpc.Internal("read tunnel config: %v", err)
	}
	rules = upsertIngress(rules, host, normalizePath(p.Path), "http://"+origin+":"+p.Port)
	if err := r.cf.PutTunnelConfig(ctx, con.TunnelID, rules); err != nil {
		return nil, rpc.Internal("update tunnel config: %v", err)
	}
	// Ensure DNS.
	if err := r.ensureDNS(ctx, host, con.TunnelID); err != nil {
		return &RouteResult{OK: false, Origin: origin, Error: "route added but DNS failed: " + err.Error()}, nil
	}
	return &RouteResult{OK: true, Origin: origin, Reattached: reattached}, nil
}

// RemoveTunnelParams targets a route by hostname.
type RemoveTunnelParams struct {
	Hostname string `sov:"hostname,0,required" json:"hostname"`
	Path     string `sov:"path,1" json:"path"`
}

// RemoveTunnel drops the exact host+path ingress rule on whichever connector
// serves it; the DNS record is deleted only when no rules for that host remain.
func (r *TunnelsRouter) RemoveTunnel(ctx *rpc.Context, p *RemoveTunnelParams) (*RouteResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	host := strings.ToLower(strings.TrimSpace(p.Hostname))
	path := normalizePath(p.Path)
	cons, err := r.dock(ctx).Connectors(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	for _, con := range cons {
		rules, err := r.cf.TunnelConfig(ctx, con.TunnelID)
		if err != nil {
			continue
		}
		kept, found, remaining := dropIngress(rules, host, path)
		if !found {
			continue
		}
		if err := r.cf.PutTunnelConfig(ctx, con.TunnelID, kept); err != nil {
			return nil, rpc.Internal("update tunnel config: %v", err)
		}
		if remaining == 0 {
			if err := r.deleteDNS(ctx, host); err != nil {
				return &RouteResult{OK: false, Error: "route removed but DNS delete failed: " + err.Error()}, nil
			}
		}
		return &RouteResult{OK: true}, nil
	}
	return nil, rpc.NotFound("no route for %q", host)
}

// MoveRouteParams reorders a route within its connector's ingress (order matters
// — Cloudflare matches top-down, first match wins).
type MoveRouteParams struct {
	Connector string `sov:"connector,0,required" json:"connector"`
	Hostname  string `sov:"hostname,1,required" json:"hostname"`
	Path      string `sov:"path,2" json:"path"`
	Dir       string `sov:"dir,3,required" json:"dir"` // "up" | "down"
}

// MoveRoute swaps a route with its neighbour in the connector's ingress order.
func (r *TunnelsRouter) MoveRoute(ctx *rpc.Context, p *MoveRouteParams) (*RouteResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	con, ok := r.findConnector(ctx, p.Connector)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	rules, err := r.cf.TunnelConfig(ctx, con.TunnelID)
	if err != nil {
		return nil, rpc.Internal("read tunnel config: %v", err)
	}
	// Work on the ordered non-catch-all list.
	list := make([]cloudflare.IngressRule, 0, len(rules))
	for _, rule := range rules {
		if rule.Hostname != "" {
			list = append(list, rule)
		}
	}
	host := strings.ToLower(strings.TrimSpace(p.Hostname))
	path := normalizePath(p.Path)
	idx := -1
	for i, rule := range list {
		if rule.Hostname == host && rule.Path == path {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, rpc.NotFound("no route for %q", host)
	}
	swap := idx - 1
	if p.Dir == "down" {
		swap = idx + 1
	}
	if swap < 0 || swap >= len(list) {
		return &RouteResult{OK: true}, nil // already at the edge — no-op
	}
	list[idx], list[swap] = list[swap], list[idx]
	if err := r.cf.PutTunnelConfig(ctx, con.TunnelID, list); err != nil {
		return nil, rpc.Internal("update tunnel config: %v", err)
	}
	return &RouteResult{OK: true}, nil
}

// ReorderRoutesParams sets a connector's full ingress order in one write (for
// drag-and-drop). Order is a JSON array of {hostname, path} in the desired order.
type ReorderRoutesParams struct {
	Connector string `sov:"connector,0,required" json:"connector"`
	Order     string `sov:"order,1,required" json:"order"`
}

// ReorderRoutes rewrites a connector's ingress rules to match the client-supplied
// order in a single PutTunnelConfig — no per-swap Cloudflare churn. Rules not
// named in the order are appended (safety), and the catch-all is re-added by
// PutTunnelConfig, so nothing is dropped.
func (r *TunnelsRouter) ReorderRoutes(ctx *rpc.Context, p *ReorderRoutesParams) (*RouteResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	con, ok := r.findConnector(ctx, p.Connector)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	var order []struct {
		Hostname string `json:"hostname"`
		Path     string `json:"path"`
	}
	if err := json.Unmarshal([]byte(p.Order), &order); err != nil {
		return nil, rpc.BadRequest("bad order: %v", err)
	}
	rules, err := r.cf.TunnelConfig(ctx, con.TunnelID)
	if err != nil {
		return nil, rpc.Internal("read tunnel config: %v", err)
	}
	byKey := map[string]cloudflare.IngressRule{}
	for _, rule := range rules {
		if rule.Hostname != "" {
			byKey[rule.Hostname+"\x00"+rule.Path] = rule
		}
	}
	out := make([]cloudflare.IngressRule, 0, len(byKey))
	seen := map[string]bool{}
	for _, o := range order {
		k := strings.ToLower(strings.TrimSpace(o.Hostname)) + "\x00" + normalizePath(o.Path)
		if rule, ok := byKey[k]; ok && !seen[k] {
			out = append(out, rule)
			seen[k] = true
		}
	}
	for _, rule := range rules { // append any not named in the order
		if rule.Hostname == "" {
			continue
		}
		k := rule.Hostname + "\x00" + rule.Path
		if !seen[k] {
			out = append(out, rule)
			seen[k] = true
		}
	}
	if err := r.cf.PutTunnelConfig(ctx, con.TunnelID, out); err != nil {
		return nil, rpc.Internal("update tunnel config: %v", err)
	}
	return &RouteResult{OK: true}, nil
}

// resolveOrigin returns the ingress origin host, the network to attach the
// connector to, and whether replicas were reattached to add an alias.
func (r *TunnelsRouter) resolveOrigin(ctx *rpc.Context, con docker.Connector, p *AddTunnelParams) (origin, netName string, reattached bool, err error) {
	// Loose container target.
	if p.Container != "" {
		nets, e := r.dock(ctx).ContainerNetworks(ctx, p.Container)
		if e != nil {
			return "", "", false, e
		}
		idx, _ := r.dock(ctx).OriginIndex(ctx)
		var name string
		for _, ref := range idx {
			if ref.ContainerID == p.Container || strings.HasPrefix(ref.ContainerID, p.Container) {
				name = ref.Name
				break
			}
		}
		if name == "" {
			return "", "", false, errNoContainer
		}
		if len(nets) == 0 {
			net, e := r.dock(ctx).EnsureTunnelsNetwork(ctx)
			if e != nil {
				return "", "", false, e
			}
			if e := r.dock(ctx).AttachNetwork(ctx, p.Container, net, nil); e != nil {
				return "", "", false, e
			}
			netName = net
		} else {
			netName = nets[0]
		}
		return name, netName, false, nil
	}
	// Compose service target.
	if p.Project == "" || p.Service == "" {
		return "", "", false, errNoTarget
	}
	stacks, e := r.dock(ctx).Stacks(ctx)
	if e != nil {
		return "", "", false, e
	}
	var members []docker.ContainerSummary
	for _, s := range stacks {
		if s.Project != p.Project {
			continue
		}
		for _, c := range s.Containers {
			if c.Service == p.Service {
				members = append(members, c)
			}
		}
	}
	if len(members) == 0 {
		return "", "", false, errNoTarget
	}
	nets, e := r.dock(ctx).ContainerNetworks(ctx, members[0].ID)
	if e != nil || len(nets) == 0 {
		return "", "", false, errNoNetwork
	}
	netName = nets[0]
	if len(members) == 1 {
		return members[0].Name, netName, false, nil // single replica -> container name
	}
	// Replicated: give every replica a unique alias on the stack network (a brief
	// per-replica reattach), then round-robin on that alias.
	alias := "hope-" + p.Project + "-" + p.Service
	for _, m := range members {
		_ = r.dock(ctx).DetachNetwork(ctx, m.ID, netName)
		if e := r.dock(ctx).AttachNetwork(ctx, m.ID, netName, []string{alias}); e != nil {
			return "", "", false, e
		}
	}
	return alias, netName, true, nil
}

func (r *TunnelsRouter) ensureDNS(ctx *rpc.Context, host, tunnelID string) error {
	zone, err := r.cf.ZoneForHost(ctx, host)
	if err != nil {
		return err
	}
	content := tunnelID + ".cfargotunnel.com"
	recs, err := r.cf.ListDNS(ctx, zone.ID, host)
	if err != nil {
		return err
	}
	for _, rec := range recs {
		if rec.Type == "CNAME" {
			if rec.Content == content {
				return nil // already points at this tunnel
			}
			// An existing CNAME (e.g. from another tunnel) — repoint it here.
			return r.cf.UpdateDNS(ctx, zone.ID, rec.ID, content)
		}
		// A non-CNAME record (A/AAAA/…) would conflict — don't clobber it.
		return rpc.BadRequest("a %s record already exists for %s; remove it in Cloudflare first", rec.Type, host)
	}
	_, err = r.cf.CreateDNS(ctx, zone.ID, cloudflare.DNSRecord{Type: "CNAME", Name: host, Content: content, Proxied: true})
	return err
}

func (r *TunnelsRouter) deleteDNS(ctx *rpc.Context, host string) error {
	zone, err := r.cf.ZoneForHost(ctx, host)
	if err != nil {
		return err
	}
	recs, err := r.cf.ListDNS(ctx, zone.ID, host)
	if err != nil {
		return err
	}
	for _, rec := range recs {
		if rec.Type == "CNAME" && strings.HasSuffix(rec.Content, ".cfargotunnel.com") {
			if err := r.cf.DeleteDNS(ctx, zone.ID, rec.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// findConnector looks up a connector by container id (full or prefix).
func (r *TunnelsRouter) findConnector(ctx *rpc.Context, id string) (docker.Connector, bool) {
	cons, err := r.dock(ctx).Connectors(ctx)
	if err != nil {
		return docker.Connector{}, false
	}
	for _, c := range cons {
		if c.ContainerID == id || strings.HasPrefix(c.ContainerID, id) {
			return c, true
		}
	}
	return docker.Connector{}, false
}

func hasDefault(cons []docker.Connector) bool {
	for _, c := range cons {
		if c.Default {
			return true
		}
	}
	return false
}

// normalizePath cleans an optional ingress path prefix ("" stays "").
func normalizePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return p
}

// upsertIngress replaces any rule for the exact host+path (drops the catch-all;
// PutTunnelConfig re-adds it). A path rule is inserted BEFORE the same host's
// path-less rule, since Cloudflare matches ingress top-down (first match wins).
func upsertIngress(rules []cloudflare.IngressRule, host, path, service string) []cloudflare.IngressRule {
	out := make([]cloudflare.IngressRule, 0, len(rules)+1)
	for _, r := range rules {
		if r.Hostname == "" || (r.Hostname == host && r.Path == path) {
			continue
		}
		out = append(out, r)
	}
	nr := cloudflare.IngressRule{Hostname: host, Path: path, Service: service}
	if path == "" {
		return append(out, nr)
	}
	for i, r := range out {
		if r.Hostname == host && r.Path == "" {
			return append(out[:i:i], append([]cloudflare.IngressRule{nr}, out[i:]...)...)
		}
	}
	return append(out, nr)
}

// dropIngress removes the exact host+path rule, reporting whether it existed and
// how many rules for that host remain (so DNS is only removed when host is empty).
func dropIngress(rules []cloudflare.IngressRule, host, path string) (out []cloudflare.IngressRule, found bool, remaining int) {
	out = make([]cloudflare.IngressRule, 0, len(rules))
	for _, r := range rules {
		if r.Hostname == "" {
			continue // catch-all re-added by PutTunnelConfig
		}
		if r.Hostname == host && r.Path == path {
			found = true
			continue
		}
		if r.Hostname == host {
			remaining++
		}
		out = append(out, r)
	}
	return out, found, remaining
}

// countRoutes counts non-catch-all ingress rules.
func countRoutes(rules []cloudflare.IngressRule) int {
	n := 0
	for _, r := range rules {
		if r.Hostname != "" {
			n++
		}
	}
	return n
}

// splitOrigin extracts host + port from an ingress service like
// "http://blog-web-1:8080". Returns ("","") for non-http services.
func splitOrigin(service string) (host, port string) {
	if !strings.HasPrefix(service, "http://") && !strings.HasPrefix(service, "https://") {
		return "", ""
	}
	if u, err := url.Parse(service); err == nil {
		return u.Hostname(), u.Port()
	}
	return "", ""
}
