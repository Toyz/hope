// Package tunnels exposes the TunnelsRouter: manage a Cloudflare tunnel's public
// routes per stack. hope doesn't run cloudflared — you run a connector (a
// cloudflared container labeled ink.hope.tunnel=<tunnel-id>) and hope manages its
// ingress + the matching DNS via the Cloudflare API. Wire name: "Tunnels".
package tunnels

import (
	"errors"
	"net/url"
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

func (r *TunnelsRouter) dock() *docker.Client { return r.hosts.Active() }

// enabled gates every method: without a Cloudflare client the domain is off.
func (r *TunnelsRouter) enabled(ctx *rpc.Context) error {
	if _, err := rpc.RequireSubject(ctx); err != nil {
		return err
	}
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
	Project     string   `json:"project"`     // set when the connector lives in a stack
	Networks    []string `json:"networks"`
	Routes      int      `json:"routes"` // ingress rules pointing through it
}

// Connectors lists hope-managed connectors on the active host with tunnel status.
func (r *TunnelsRouter) Connectors(ctx *rpc.Context) ([]ConnectorView, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	cons, err := r.dock().Connectors(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	out := make([]ConnectorView, len(cons))
	var wg sync.WaitGroup
	for i, c := range cons {
		out[i] = ConnectorView{
			ID: c.ContainerID, Name: c.Name, Title: c.Title, TunnelID: c.TunnelID,
			Default: c.Default, Running: c.Running, Project: c.Project, Networks: c.Networks,
		}
		wg.Add(1)
		go func(i int, tunnelID string) {
			defer wg.Done()
			if d, err := r.cf.TunnelStatus(ctx, tunnelID); err == nil {
				out[i].Status = d.Status
				out[i].Online = d.Status == "healthy" || d.Status == "degraded"
				out[i].Connections = len(d.Connections)
			}
			if rules, err := r.cf.TunnelConfig(ctx, tunnelID); err == nil {
				out[i].Routes = countRoutes(rules)
			}
		}(i, c.TunnelID)
	}
	wg.Wait()
	return out, nil
}

// TunnelView is one public route: a hostname served through a connector.
type TunnelView struct {
	Hostname  string `json:"hostname"`
	Path      string `json:"path,omitempty"`
	Service   string `json:"service"`   // raw ingress origin, e.g. http://blog-web-1:8080
	Connector string `json:"connector"` // connector container name
	TunnelID  string `json:"tunnel_id"`
	Project   string `json:"project"` // resolved stack, if known
	SvcName   string `json:"svc_name"`
	Container string `json:"container"`
	Port      string `json:"port"`
}

// Tunnels lists every route across the active host's connectors (read from each
// tunnel's ingress config, resolved back to a stack/service where possible).
func (r *TunnelsRouter) Tunnels(ctx *rpc.Context) ([]TunnelView, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	cons, err := r.dock().Connectors(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	idx, err := r.dock().OriginIndex(ctx)
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
			}
			out = append(out, tv)
		}
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
	existing, _ := r.dock().Connectors(ctx)
	isDefault := !hasDefault(existing)
	cid, err := r.dock().DeployConnector(ctx, p.Name, id, token, isDefault)
	if err != nil {
		// Best-effort rollback so we don't leave an orphan tunnel.
		_ = r.cf.DeleteTunnel(ctx, id)
		return nil, rpc.Internal("deploy cloudflared: %v", err)
	}
	return &docker.Connector{ContainerID: cid, Name: p.Name, Title: p.Name, TunnelID: id, Default: isDefault, Running: true}, nil
}

// RemoveConnectorParams targets a connector container (and optionally its tunnel).
type RemoveConnectorParams struct {
	ID           string `sov:"id,0,required" json:"id"`
	DeleteTunnel bool   `sov:"delete_tunnel,1" json:"delete_tunnel"`
}

// RemoveConnector stops+removes a connector container, optionally deleting the
// Cloudflare tunnel too (only hope-deployed ones should be fully deleted).
func (r *TunnelsRouter) RemoveConnector(ctx *rpc.Context, p *RemoveConnectorParams) (*OpResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	con, ok := r.findConnector(ctx, p.ID)
	if !ok {
		return nil, rpc.NotFound("connector not found")
	}
	if err := r.dock().Remove(ctx, con.ContainerID); err != nil {
		return nil, rpc.Internal("remove connector: %v", err)
	}
	if p.DeleteTunnel && con.TunnelID != "" {
		if err := r.cf.DeleteTunnel(ctx, con.TunnelID); err != nil {
			return &OpResult{OK: false, Error: "container removed but tunnel delete failed: " + err.Error()}, nil
		}
	}
	return &OpResult{OK: true}, nil
}

// ── routes ──────────────────────────────────────────────────────────────

// OpResult is a simple outcome envelope.
type OpResult struct {
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
}

// AddTunnel wires hostname -> service through a connector: attaches the connector
// to the origin's network, upserts the tunnel ingress, and ensures the DNS CNAME.
func (r *TunnelsRouter) AddTunnel(ctx *rpc.Context, p *AddTunnelParams) (*OpResult, error) {
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
		if err := r.dock().AttachNetwork(ctx, con.ContainerID, netName, nil); err != nil {
			return nil, rpc.Internal("attach connector to %s: %v", netName, err)
		}
	}
	// Upsert ingress.
	rules, err := r.cf.TunnelConfig(ctx, con.TunnelID)
	if err != nil {
		return nil, rpc.Internal("read tunnel config: %v", err)
	}
	rules = upsertIngress(rules, host, "http://"+origin+":"+p.Port)
	if err := r.cf.PutTunnelConfig(ctx, con.TunnelID, rules); err != nil {
		return nil, rpc.Internal("update tunnel config: %v", err)
	}
	// Ensure DNS.
	if err := r.ensureDNS(ctx, host, con.TunnelID); err != nil {
		return &OpResult{OK: false, Origin: origin, Error: "route added but DNS failed: " + err.Error()}, nil
	}
	return &OpResult{OK: true, Origin: origin, Reattached: reattached}, nil
}

// RemoveTunnelParams targets a route by hostname.
type RemoveTunnelParams struct {
	Hostname string `sov:"hostname,0,required" json:"hostname"`
}

// RemoveTunnel drops the ingress rule for hostname on whichever connector serves
// it and deletes the matching DNS record.
func (r *TunnelsRouter) RemoveTunnel(ctx *rpc.Context, p *RemoveTunnelParams) (*OpResult, error) {
	if err := r.enabled(ctx); err != nil {
		return nil, err
	}
	host := strings.ToLower(strings.TrimSpace(p.Hostname))
	cons, err := r.dock().Connectors(ctx)
	if err != nil {
		return nil, rpc.Internal("%v", err)
	}
	for _, con := range cons {
		rules, err := r.cf.TunnelConfig(ctx, con.TunnelID)
		if err != nil {
			continue
		}
		kept, found := dropIngress(rules, host)
		if !found {
			continue
		}
		if err := r.cf.PutTunnelConfig(ctx, con.TunnelID, kept); err != nil {
			return nil, rpc.Internal("update tunnel config: %v", err)
		}
		if err := r.deleteDNS(ctx, host); err != nil {
			return &OpResult{OK: false, Error: "route removed but DNS delete failed: " + err.Error()}, nil
		}
		return &OpResult{OK: true}, nil
	}
	return nil, rpc.NotFound("no route for %q", host)
}

// resolveOrigin returns the ingress origin host, the network to attach the
// connector to, and whether replicas were reattached to add an alias.
func (r *TunnelsRouter) resolveOrigin(ctx *rpc.Context, con docker.Connector, p *AddTunnelParams) (origin, netName string, reattached bool, err error) {
	// Loose container target.
	if p.Container != "" {
		nets, e := r.dock().ContainerNetworks(ctx, p.Container)
		if e != nil {
			return "", "", false, e
		}
		idx, _ := r.dock().OriginIndex(ctx)
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
			net, e := r.dock().EnsureTunnelsNetwork(ctx)
			if e != nil {
				return "", "", false, e
			}
			if e := r.dock().AttachNetwork(ctx, p.Container, net, nil); e != nil {
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
	stacks, e := r.dock().Stacks(ctx)
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
	nets, e := r.dock().ContainerNetworks(ctx, members[0].ID)
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
		_ = r.dock().DetachNetwork(ctx, m.ID, netName)
		if e := r.dock().AttachNetwork(ctx, m.ID, netName, []string{alias}); e != nil {
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
		if rec.Type == "CNAME" && rec.Content == content {
			return nil // already points at this tunnel
		}
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
	cons, err := r.dock().Connectors(ctx)
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

// upsertIngress replaces any rule for host (drops catch-all; PutTunnelConfig
// re-adds it) and appends the new one.
func upsertIngress(rules []cloudflare.IngressRule, host, service string) []cloudflare.IngressRule {
	out := make([]cloudflare.IngressRule, 0, len(rules)+1)
	for _, r := range rules {
		if r.Hostname == host || r.Hostname == "" {
			continue
		}
		out = append(out, r)
	}
	return append(out, cloudflare.IngressRule{Hostname: host, Service: service})
}

// dropIngress removes the rule for host, reporting whether one existed.
func dropIngress(rules []cloudflare.IngressRule, host string) ([]cloudflare.IngressRule, bool) {
	out := make([]cloudflare.IngressRule, 0, len(rules))
	found := false
	for _, r := range rules {
		if r.Hostname == host {
			found = true
			continue
		}
		if r.Hostname == "" {
			continue // catch-all re-added by PutTunnelConfig
		}
		out = append(out, r)
	}
	return out, found
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
