// Package cloudflare is a thin, typed client for the slice of the Cloudflare API
// hope's tunnels domain needs: a remotely-managed tunnel's ingress configuration,
// tunnel status, and DNS records. It deliberately covers only those endpoints.
//
// Auth: a single API token (Bearer) with two policies — Account -> Cloudflare
// Tunnel: Edit, and All zones -> DNS: Edit + Zone: Read. The token is a secret and
// is never logged.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/toyz/hope/internal/config"
)

const apiBase = "https://api.cloudflare.com/client/v4"

// Client talks to the Cloudflare API for one account.
type Client struct {
	token     string
	accountID string
	http      *http.Client
}

// New returns a client, or nil when the cloudflare integration is disabled (so
// callers can treat nil as "tunnels off", mirroring socketproxy.New).
func New(cfg config.CloudflareConfig) *Client {
	if !cfg.Enabled {
		return nil
	}
	return &Client{
		token:     cfg.APIToken,
		accountID: cfg.AccountID,
		http:      &http.Client{Timeout: 15 * time.Second},
	}
}

// AccountID exposes the configured account (for building cfargotunnel targets).
func (c *Client) AccountID() string { return c.accountID }

// envelope is the standard Cloudflare API response wrapper.
type envelope struct {
	Success bool            `json:"success"`
	Errors  []apiError      `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// do issues a request and decodes the envelope's result into out (may be nil).
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("cloudflare: encode body: %w", err)
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, apiBase+path, reader)
	if err != nil {
		return fmt.Errorf("cloudflare: request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("cloudflare: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("cloudflare: decode %s %s (%s): %w", method, path, resp.Status, err)
	}
	if !env.Success {
		return fmt.Errorf("cloudflare: %s %s: %s", method, path, joinErrors(env.Errors, resp.Status))
	}
	if out != nil && len(env.Result) > 0 {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return fmt.Errorf("cloudflare: decode result %s %s: %w", method, path, err)
		}
	}
	return nil
}

func joinErrors(errs []apiError, fallback string) string {
	if len(errs) == 0 {
		return fallback
	}
	parts := make([]string, len(errs))
	for i, e := range errs {
		parts[i] = fmt.Sprintf("%d %s", e.Code, e.Message)
	}
	return strings.Join(parts, "; ")
}

// ── Tunnels ──────────────────────────────────────────────────────────────

// IngressRule is one entry in a tunnel's ingress config. The last rule in a
// valid config is always the catch-all {Service: "http_status:404"}.
type IngressRule struct {
	Hostname      string          `json:"hostname,omitempty"`
	Path          string          `json:"path,omitempty"`
	Service       string          `json:"service"`
	OriginRequest json.RawMessage `json:"originRequest,omitempty"`
}

type tunnelConfigResult struct {
	Config struct {
		Ingress []IngressRule `json:"ingress"`
	} `json:"config"`
}

// TunnelConfig returns the tunnel's current ingress rules (catch-all included).
func (c *Client) TunnelConfig(ctx context.Context, tunnelID string) ([]IngressRule, error) {
	var res tunnelConfigResult
	if err := c.do(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/configurations", c.accountID, tunnelID), nil, &res); err != nil {
		return nil, err
	}
	return res.Config.Ingress, nil
}

// PutTunnelConfig replaces the tunnel's ingress rules. The caller must keep the
// catch-all 404 last; PutTunnelConfig enforces it as a safety net.
func (c *Client) PutTunnelConfig(ctx context.Context, tunnelID string, ingress []IngressRule) error {
	ingress = withCatchAll(ingress)
	body := map[string]any{"config": map[string]any{"ingress": ingress}}
	return c.do(ctx, http.MethodPut,
		fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/configurations", c.accountID, tunnelID), body, nil)
}

// withCatchAll guarantees exactly one trailing catch-all 404 rule.
func withCatchAll(in []IngressRule) []IngressRule {
	out := make([]IngressRule, 0, len(in)+1)
	for _, r := range in {
		if r.Hostname == "" && strings.HasPrefix(r.Service, "http_status:") {
			continue // drop existing catch-alls; we re-append one
		}
		out = append(out, r)
	}
	return append(out, IngressRule{Service: "http_status:404"})
}

// CreateTunnel creates a remotely-managed named tunnel and returns its id + the
// connector run token (so hope can start a cloudflared for it).
func (c *Client) CreateTunnel(ctx context.Context, name string) (id, token string, err error) {
	var res struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	body := map[string]any{"name": name, "config_src": "cloudflare"}
	if err = c.do(ctx, http.MethodPost, fmt.Sprintf("/accounts/%s/cfd_tunnel", c.accountID), body, &res); err != nil {
		return "", "", err
	}
	token = res.Token
	if token == "" { // some API versions omit the token on create; fetch it
		if token, err = c.TunnelToken(ctx, res.ID); err != nil {
			return "", "", err
		}
	}
	return res.ID, token, nil
}

// TunnelToken returns a tunnel's connector run token.
func (c *Client) TunnelToken(ctx context.Context, tunnelID string) (string, error) {
	var token string
	err := c.do(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/token", c.accountID, tunnelID), nil, &token)
	return token, err
}

// DeleteTunnel deletes a tunnel (must have no active connections).
func (c *Client) DeleteTunnel(ctx context.Context, tunnelID string) error {
	return c.do(ctx, http.MethodDelete,
		fmt.Sprintf("/accounts/%s/cfd_tunnel/%s", c.accountID, tunnelID), nil, nil)
}

// TunnelDetail is the subset of a tunnel's status we surface.
type TunnelDetail struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Status      string `json:"status"`     // healthy | degraded | down | inactive
	CreatedAt   string `json:"created_at"` // when the tunnel was created
	Connections []struct {
		ColoName           string `json:"colo_name"`
		ClientVersion      string `json:"client_version"` // cloudflared version
		OpenedAt           string `json:"opened_at"`
		IsPendingReconnect bool   `json:"is_pending_reconnect"`
	} `json:"connections"`
}

// TunnelStatus returns a tunnel's health + active connections.
func (c *Client) TunnelStatus(ctx context.Context, tunnelID string) (TunnelDetail, error) {
	var d TunnelDetail
	err := c.do(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/cfd_tunnel/%s", c.accountID, tunnelID), nil, &d)
	return d, err
}

// ── DNS ──────────────────────────────────────────────────────────────────

// Zone is a Cloudflare DNS zone.
type Zone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Zones lists every zone the token can see (for the hostname domain picker).
func (c *Client) Zones(ctx context.Context) ([]Zone, error) {
	var zones []Zone
	err := c.do(ctx, http.MethodGet, "/zones?per_page=200", nil, &zones)
	return zones, err
}

// ZoneForHost returns the zone whose name is the longest suffix of host (so
// "blog.helba.ai" resolves to the "helba.ai" zone).
func (c *Client) ZoneForHost(ctx context.Context, host string) (Zone, error) {
	zones, err := c.Zones(ctx)
	if err != nil {
		return Zone{}, err
	}
	best := Zone{}
	for _, z := range zones {
		if host == z.Name || strings.HasSuffix(host, "."+z.Name) {
			if len(z.Name) > len(best.Name) {
				best = z
			}
		}
	}
	if best.ID == "" {
		return Zone{}, fmt.Errorf("cloudflare: no zone matches host %q", host)
	}
	return best, nil
}

// DNSRecord is a DNS record (we only ever create/inspect CNAMEs).
type DNSRecord struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
	TTL     int    `json:"ttl,omitempty"`
}

// ListDNS returns records in a zone matching an exact name.
func (c *Client) ListDNS(ctx context.Context, zoneID, name string) ([]DNSRecord, error) {
	var recs []DNSRecord
	err := c.do(ctx, http.MethodGet,
		fmt.Sprintf("/zones/%s/dns_records?name=%s", zoneID, url.QueryEscape(name)), nil, &recs)
	return recs, err
}

// CreateDNS creates a record and returns it (with its id).
func (c *Client) CreateDNS(ctx context.Context, zoneID string, rec DNSRecord) (DNSRecord, error) {
	var out DNSRecord
	err := c.do(ctx, http.MethodPost, fmt.Sprintf("/zones/%s/dns_records", zoneID), rec, &out)
	return out, err
}

// UpdateDNS repoints an existing CNAME record at new content (keeps it proxied).
func (c *Client) UpdateDNS(ctx context.Context, zoneID, recordID, content string) error {
	body := map[string]any{"content": content, "proxied": true}
	return c.do(ctx, http.MethodPatch, fmt.Sprintf("/zones/%s/dns_records/%s", zoneID, recordID), body, nil)
}

// DeleteDNS removes a record by id.
func (c *Client) DeleteDNS(ctx context.Context, zoneID, recordID string) error {
	return c.do(ctx, http.MethodDelete,
		fmt.Sprintf("/zones/%s/dns_records/%s", zoneID, recordID), nil, nil)
}
