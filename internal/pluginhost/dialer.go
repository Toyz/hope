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
	// Best-effort attach the routing container (hope locally, the agent remotely) to
	// the plugin's network so the container IP is routable. Harmless if already on
	// it or not containerized. Done over the same docker client either way (local
	// daemon, or the agent's daemon over the tunnel).
	if self := dock.SelfID(); self != "" && netName != "" {
		_ = dock.AttachNetwork(ctx, self, netName, nil)
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

	if hc.Kind == "local" {
		// Local (or hope-driven) daemon: everything is directly reachable. Try the
		// published host port FIRST — for a remote tcp:// daemon (e.g. hope pointed at
		// tcp://host:2375) the daemon-host published port is routable while the
		// container's internal IP is not, and dialing the internal IP first would just
		// hang until timeout.
		urls := append(directURLs(directTargets), directURLs(netTargets)...)
		if len(urls) == 0 {
			return nil, fmt.Errorf("no dial candidates for plugin container %s", pc.ContainerID)
		}
		return &endpoint{urls: urls, token: token, client: &http.Client{Timeout: timeout}}, nil
	}

	// Remote host: if the plugin publishes a port on a remote TCP daemon, hope can
	// reach it DIRECTLY at the daemon's host IP (directTargets) — no agent needed on
	// that host. This is the path for driving a remote docker over tcp://.
	if len(directTargets) > 0 {
		return &endpoint{urls: directURLs(directTargets), token: token, client: &http.Client{Timeout: timeout}}, nil
	}

	// Otherwise dial the plugin's network IP through the agent tunnel (needs an agent
	// co-located with the containers so the internal IP is routable).
	if r.dialer == nil {
		return nil, fmt.Errorf("remote plugin dialing needs the agent hub (or publish the plugin's port so hope can reach it at the docker host)")
	}
	if len(netTargets) == 0 {
		return nil, fmt.Errorf("no dial candidates for plugin container %s", pc.ContainerID)
	}
	target := netTargets[0]
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
