package pluginhost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/toyz/hope/internal/docker"
	"github.com/toyz/hope/internal/hosts"
)

// ContainerDialer opens a raw connection to a container's ip:port on a remote host
// over the agent tunnel. Satisfied by *agent.Hub; nil when no hub is configured.
type ContainerDialer interface {
	DialContainer(hostID, addr string) (net.Conn, error)
}

const (
	dialTimeout = 15 * time.Second
	maxRespBody = 4 << 20 // mirror front.go's cap — a plugin must not flood the control plane

	// ProtocolVersion is the plugin-protocol version hope speaks. hope announces it
	// on every call (X-Hope-Protocol-Version) so a plugin can adapt, and degrades
	// gracefully when a plugin speaks a different one (unknown surfaces/view kinds
	// are skipped, not fatal). Mirrors the SDK's plugin.ProtocolVersion.
	ProtocolVersion = 1
	headerProtocol  = "X-Hope-Protocol-Version"

	// Capability negotiation: alongside the protocol version, hope announces WHICH view
	// kinds and features THIS build can render, so a plugin built against a newer SDK can
	// degrade gracefully (emit a component only where supported, else a fallback) instead
	// of hitting "unsupported view". The header names are a wire contract shared with the
	// SDK's plugin.Caps (see plugin/caps.go); the values below must track the frontend
	// renderView switch + the feature flags the renderer honors.
	headerViewKinds = "X-Hope-View-Kinds"
	headerFeatures  = "X-Hope-Features"
	capViewKinds    = "kv,table,query,tree,chart,cards,stat,text,search,component"
	capFeatures     = "static,empty,flyout,status"
)

// endpoint is a dialed plugin: the ordered JSON-RPC URLs to try (network IP first,
// published-port fallback), the bearer token hope presents, and an http client.
type endpoint struct {
	urls   []string
	token  string
	client *http.Client
}

// hostClient finds a connected host by id.
func (r *PluginsRouter) hostClient(host string) (hosts.HostClient, bool) {
	for _, h := range r.hosts.All() {
		if h.ID == host {
			return h, true
		}
	}
	return hosts.HostClient{}, false
}

// dial prepares an endpoint to reach a plugin container's JSON-RPC URL. v1 handles
// the LOCAL host only: it resolves the container IP, best-effort attaches hope to
// the plugin's network so the IP is routable, then returns an http endpoint.
// Remote hosts error until the agent DIAL stream lands (a later phase).
func (r *PluginsRouter) dial(ctx context.Context, host string, pc docker.PluginContainer, token string, streaming bool) (*endpoint, error) {
	hc, ok := r.hostClient(host)
	if !ok || hc.Client == nil {
		return nil, fmt.Errorf("host %q is not connected", host)
	}
	dock := hc.Client
	netTargets, directTargets, netName, err := dock.PluginDialCandidates(ctx, pc.ContainerID, pc.Port)
	if err != nil {
		return nil, fmt.Errorf("resolve plugin address: %w", err)
	}
	path := pc.Path
	if path == "" {
		path = "/__hope"
	}
	// A stream must not use the unary request timeout (it would cut the stream off);
	// it relies on context cancellation when the UI disconnects instead.
	timeout := dialTimeout
	if streaming {
		timeout = 0
	}
	directURLs := func(ts []string) []string {
		urls := make([]string, len(ts))
		for i, t := range ts {
			urls[i] = "http://" + t + path
		}
		return urls
	}

	// Shared ink-plugins network. Put the routing side (hope on a local socket, the
	// agent on a remote host) AND the plugin on one bridge, then reach the plugin by its
	// SHORT CONTAINER ID — docker's embedded DNS resolves that on every user network a
	// container joins, automatically, so a plain connect is enough (no custom alias to
	// register, which a no-op'd "already connected" attach would silently drop). No
	// published port, no hairpin. Best-effort; the raw candidates below stay as fallback.
	// Skipped for a remote tcp:// daemon (hope isn't a container there, so it can't join).
	alias := ""
	pluginNetIP := "" // container IP on ink-plugins, resolved AFTER the attach
	if dock.IsLocalSocket() || (hc.Kind != "local" && r.dialer != nil) {
		if dock.EnsurePluginNetwork(ctx) == nil {
			if self := dock.SelfContainerID(ctx); self != "" {
				_ = dock.AttachNetwork(ctx, self, docker.PluginNetwork, nil) // hope/agent joins
			}
			if dock.AttachNetwork(ctx, pc.ContainerID, docker.PluginNetwork, nil) == nil {
				alias = docker.PluginNetAlias(pc.ContainerID) // == the short id docker resolves
				// DNS-independent fallback: the alias's embedded-DNS record can lag the
				// first request right after a live connect, and a port-less plugin has no
				// other candidate — so a disable→re-enable races DNS and the schema query
				// fails. The endpoint IP is in inspect immediately; dial it directly.
				pluginNetIP = dock.PluginNetworkIP(ctx, pc.ContainerID)
			}
		}
	}
	// Fallback: also attach the routing side to the plugin's OWN network so netTargets
	// (the container IP) stays reachable if the shared-net path didn't take.
	if self := dock.SelfID(); self != "" && netName != "" {
		_ = dock.AttachNetwork(ctx, self, netName, nil)
	}

	if hc.Kind == "local" {
		// Local daemon: dial the shared-net alias first (unix socket), then the
		// published host port (remote tcp:// daemon — the daemon-host port is routable
		// while the container IP is not), then the container IP.
		var urls []string
		// The ink-plugins IP first: it's resolved fresh from inspect after the attach,
		// so it skips the embedded-DNS lag the alias name suffers on a re-enable.
		if pluginNetIP != "" {
			urls = append(urls, "http://"+net.JoinHostPort(pluginNetIP, strconv.Itoa(pc.Port))+path)
		}
		if alias != "" {
			urls = append(urls, "http://"+alias+":"+strconv.Itoa(pc.Port)+path) // short container id
			// The container NAME is also auto-registered on the shared network — try it
			// too, in case a custom --hostname made the short id unresolvable.
			if pc.Name != "" && pc.Name != alias {
				urls = append(urls, "http://"+pc.Name+":"+strconv.Itoa(pc.Port)+path)
			}
		}
		urls = append(urls, directURLs(directTargets)...)
		urls = append(urls, directURLs(netTargets)...)
		if len(urls) == 0 {
			return nil, fmt.Errorf("no dial candidates for plugin container %s", pc.ContainerID)
		}
		return &endpoint{urls: urls, token: token, client: &http.Client{Timeout: timeout}}, nil
	}

	// Remote host: if the plugin publishes a port on a remote TCP daemon, hope can
	// reach it DIRECTLY at the daemon's host IP (directTargets) — no agent needed.
	if len(directTargets) > 0 {
		return &endpoint{urls: directURLs(directTargets), token: token, client: &http.Client{Timeout: timeout}}, nil
	}

	// Otherwise tunnel through the agent: dial the plugin by its shared-net alias (the
	// agent net.Dials it, resolving DNS on ink-plugins) or, failing that, its raw
	// network IP. Needs an agent co-located with the containers.
	if r.dialer == nil {
		return nil, fmt.Errorf("remote plugin dialing needs the agent hub (or publish the plugin's port so hope can reach it at the docker host)")
	}
	// This path dials ONE target with no fallback loop, so prefer the DNS-independent
	// ink-plugins IP over the alias name (which can NXDOMAIN right after a re-attach).
	target := ""
	switch {
	case pluginNetIP != "":
		target = net.JoinHostPort(pluginNetIP, strconv.Itoa(pc.Port))
	case alias != "":
		target = alias + ":" + strconv.Itoa(pc.Port)
	case len(netTargets) > 0:
		target = netTargets[0]
	default:
		return nil, fmt.Errorf("no dial candidates for plugin container %s", pc.ContainerID)
	}
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DisableKeepAlives: true, // one tunnel stream per request
			DialContext: func(dctx context.Context, _, _ string) (net.Conn, error) {
				return r.dialer.DialContainer(host, target)
			},
		},
	}
	return &endpoint{urls: []string{"http://" + target + path}, token: token, client: client}, nil
}

// callRPC performs one unary JSON-RPC 2.0 request and returns the raw result (or a
// Go error carrying the plugin's JSON-RPC error).
func (e *endpoint) callRPC(ctx context.Context, method string, params any) (json.RawMessage, error) {
	var praw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		praw = b
	}
	reqBody, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": praw})
	if err != nil {
		return nil, err
	}

	// Try each candidate address; a connection failure falls through to the next
	// (network IP -> published port). Once we get an HTTP response it's
	// authoritative — parse it, even if the plugin returned a JSON-RPC error.
	var connErr error
	for _, url := range e.urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(headerProtocol, strconv.Itoa(ProtocolVersion))
		req.Header.Set(headerViewKinds, capViewKinds)
		req.Header.Set(headerFeatures, capFeatures)
		if e.token != "" {
			req.Header.Set("Authorization", "Bearer "+e.token)
		}
		resp, err := e.client.Do(req)
		if err != nil {
			connErr = err
			continue
		}
		body, rerr := io.ReadAll(io.LimitReader(resp.Body, maxRespBody))
		resp.Body.Close()
		if rerr != nil {
			return nil, rerr
		}
		var out struct {
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, fmt.Errorf("bad plugin response: %w", err)
		}
		if out.Error != nil {
			return nil, fmt.Errorf("plugin error %d: %s", out.Error.Code, out.Error.Message)
		}
		return out.Result, nil
	}
	// Every candidate refused/unreachable — actionable guidance.
	return nil, fmt.Errorf("%w — hope couldn't reach the plugin. Run hope as a container (it auto-attaches to the plugin's network), or publish the plugin's port for native/Desktop dev", connErr)
}

// stream POSTs a stream method and forwards each NDJSON result frame to onFrame
// until the plugin ends the stream, the context is cancelled, or onFrame returns
// an error (the UI disconnected). Reads incrementally — the endpoint's client must
// have no unary timeout (see dial(streaming=true)).
func (e *endpoint) stream(ctx context.Context, method string, params any, onFrame func(json.RawMessage) error) error {
	var praw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		praw = b
	}
	reqBody, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": praw})
	if err != nil {
		return err
	}

	var connErr error
	for _, url := range e.urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(headerProtocol, strconv.Itoa(ProtocolVersion))
		req.Header.Set(headerViewKinds, capViewKinds)
		req.Header.Set(headerFeatures, capFeatures)
		if e.token != "" {
			req.Header.Set("Authorization", "Bearer "+e.token)
		}
		resp, err := e.client.Do(req)
		if err != nil {
			connErr = err
			continue
		}
		// This iteration owns the stream; read it in a closure so Body.Close fires on
		// every return path (not a defer stacked inside the candidate loop).
		return func() error {
			defer resp.Body.Close()
			sc := bufio.NewScanner(resp.Body)
			sc.Buffer(make([]byte, 0, 64*1024), maxRespBody)
			for sc.Scan() {
				line := bytes.TrimSpace(sc.Bytes())
				if len(line) == 0 {
					continue
				}
				var f struct {
					Result json.RawMessage `json:"result"`
					Error  *struct {
						Code    int    `json:"code"`
						Message string `json:"message"`
					} `json:"error"`
				}
				if err := json.Unmarshal(line, &f); err != nil {
					continue
				}
				if f.Error != nil {
					return fmt.Errorf("plugin error %d: %s", f.Error.Code, f.Error.Message)
				}
				if err := onFrame(f.Result); err != nil {
					return err
				}
			}
			return sc.Err()
		}()
	}
	return fmt.Errorf("%w — hope couldn't reach the plugin for streaming", connErr)
}
