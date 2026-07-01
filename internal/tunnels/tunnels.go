// Package tunnels exposes the TunnelsRouter: manage a Cloudflare tunnel's public
// routes per stack. hope doesn't run cloudflared — you run a connector (a
// cloudflared container labeled ink.hope.tunnel=<tunnel-id>) and hope manages its
// ingress + the matching DNS via the Cloudflare API. Wire name: "Tunnels".
package tunnels

import (
	"net/url"
	"strings"
	"sync"

	"github.com/Toyz/sov/rpc"
	"github.com/toyz/hope/internal/cloudflare"
	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
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
