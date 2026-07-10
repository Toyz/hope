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

// Publish emits an event onto hope's bus. Requires (a) the events:publish permission
// granted by the operator and (b) hope's reverse channel configured (a callback URL,
// delivered via hope.init). hope stamps the Source and namespaces the Kind
// (plugin.<identity>.<kind>), so only Kind + Data here are meaningful — a plugin can
// never spoof another's events or a core hope kind. A 4xx from hope (no grant, bad
// token, rate/size cap) is returned as an error.
func (p *Plugin) Publish(ctx context.Context, e Event) error {
	p.mu.Lock()
	url, key, token := p.hopeURL, p.pluginKey, p.token
	if token == "" {
		token = p.pinned
	}
	p.mu.Unlock()
	if url == "" || key == "" {
		return ErrNoReverseChannel
	}

	body, err := json.Marshal(map[string]any{"key": key, "event": e})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(url, "/")+"/rpc/_plugin_events", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<12))
		return fmt.Errorf("hope rejected publish (%d): %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// Alert is a convenience over Publish for the common case: it publishes an event
// whose Data is {severity, title, detail, dedupeKey}. hope namespaces the kind to
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
