package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ErrNoReverseChannel is returned by Publish/Storage when hope hasn't provided a
// callback URL (an older hope, or one without [plugins] callback_url configured). The
// plugin still runs; it just can't call back into hope.
var ErrNoReverseChannel = errors.New("hope reverse channel unavailable (no callback URL from hope.init)")

// reverse snapshots the reverse-channel coordinates hope delivered in hope.init: its
// base URL, this install's key, and the token to present. url/key empty => the channel
// isn't available.
func (p *Plugin) reverse() (url, key, token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	token = p.token
	if token == "" {
		token = p.pinned
	}
	return p.hopeURL, p.pluginKey, token
}

// postReverse POSTs payload to a reverse-channel endpoint and returns the raw response
// body, mapping a non-200 to an error. Shared by Publish and Storage.
func postReverse(ctx context.Context, url, token, path string, payload any) (json.RawMessage, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(url, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hope rejected request (%d): %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

// Publish emits an event onto hope's bus. Requires (a) the events:publish permission
// granted by the operator and (b) hope's reverse channel configured. hope stamps the
// Source and namespaces the Kind (plugin.<identity>.<kind>), so only Kind + Data here
// are meaningful — a plugin can never spoof another's events or a core hope kind.
func (p *Plugin) Publish(ctx context.Context, e Event) error {
	url, key, token := p.reverse()
	if url == "" || key == "" {
		return ErrNoReverseChannel
	}
	_, err := postReverse(ctx, url, token, "/rpc/_plugin_events", map[string]any{"key": key, "event": e})
	return err
}

// RequestPermission asks the operator, at runtime, to grant a scope this plugin
// doesn't yet hold (the Android runtime-permission model). It does not grant anything
// — hope raises a consent prompt; the plugin gains the capability only if the operator
// allows it. Safe to call repeatedly: an already-granted/denied/pending scope is a
// no-op on hope's side. Declaring the scope up front via RequirePermission (so it's
// asked at enable) is usually better; use this when a capability is only needed
// conditionally at runtime.
func (p *Plugin) RequestPermission(ctx context.Context, scope, reason string) error {
	url, key, token := p.reverse()
	if url == "" || key == "" {
		return ErrNoReverseChannel
	}
	_, err := postReverse(ctx, url, token, "/rpc/_plugin/request-permission", map[string]any{"key": key, "scope": scope, "reason": reason})
	return err
}

// Alert is a convenience over Publish: it publishes an event whose Data is
// {severity, title, detail, dedupeKey}. hope namespaces the kind to
// plugin.<identity>.alert. Requires events:publish.
func (p *Plugin) Alert(ctx context.Context, severity, title, detail, dedupeKey string) error {
	data, _ := json.Marshal(map[string]string{
		"severity":  severity,
		"title":     title,
		"detail":    detail,
		"dedupeKey": dedupeKey,
	})
	return p.Publish(ctx, Event{Kind: "alert", Data: data})
}

// ResolveAlert clears a previously-raised alert (matched by dedupeKey): hope surfaces
// it as a "resolved" confirmation and drops the alert from any active view. Use it when
// a monitored condition recovers. Requires events:publish.
func (p *Plugin) ResolveAlert(ctx context.Context, title, dedupeKey string) error {
	data, _ := json.Marshal(map[string]string{
		"title":     title,
		"dedupeKey": dedupeKey,
		"resolved":  "true",
	})
	return p.Publish(ctx, Event{Kind: "alert", Data: data})
}
