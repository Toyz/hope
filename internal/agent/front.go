package agent

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Toyz/sov/gateway"
)

// FrontServer is a sov gateway.Server that fronts hope's HTTP listener so the
// agent tunnel can ride the SAME port as the UI/API (so it traverses Cloudflare
// on 443 with no extra port). It claims one path for the WebSocket tunnel and
// hands every other request to sov's dispatch untouched.
//
// The non-tunnel bridge mirrors sov's default NetHTTPServer: a 4 MiB body cap,
// stripping inbound X-Sov-* identity headers (hope faces the public internet, so
// it must not trust smuggled identity claims), and streaming responses with a
// per-chunk flush and no write deadline.
type FrontServer struct {
	hub     *Hub
	wsPath  string
	maxBody int64
	handler gateway.RequestHandler
}

const defaultMaxBody = 4 << 20 // 4 MiB, matching sov's NetHTTPServer default

// NewFrontServer returns a Server that serves the agent WebSocket at wsPath and
// forwards everything else to the gateway.
func NewFrontServer(hub *Hub, wsPath string) *FrontServer {
	if wsPath == "" {
		wsPath = "/agent/connect"
	}
	return &FrontServer{hub: hub, wsPath: wsPath, maxBody: defaultMaxBody}
}

// Handle records the gateway's request handler (sov calls this once at boot).
func (s *FrontServer) Handle(h gateway.RequestHandler) { s.handler = h }

// ListenAndServe binds addr and serves until ctx is cancelled.
func (s *FrontServer) ListenAndServe(ctx context.Context, addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc(s.wsPath, s.hub.ServeWS(ctx))
	mux.HandleFunc("/", s.bridge)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: the WebSocket tunnel and NDJSON streams are
		// long-lived. Buffered RPC responses are small, so the missing
		// slowloris guard on writes is an acceptable trade for this app.
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		return ctx.Err()
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

// bridge adapts a net/http request to the gateway and writes its response,
// faithfully matching sov's NetHTTPServer behavior for non-tunnel traffic.
func (s *FrontServer) bridge(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.maxBody))
	if err != nil {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}

	hdr := gateway.Header{}
	for k, v := range r.Header {
		ks := http.CanonicalHeaderKey(k)
		if isIdentityHeader(ks) {
			continue // never trust inbound identity claims from the edge
		}
		hdr[ks] = strings.Join(v, ",")
	}

	resp := s.handler(r.Context(), &gateway.Request{
		Method:   r.Method,
		Path:     r.URL.Path,
		Header:   hdr,
		Body:     body,
		RemoteIP: remoteIP(r),
	})
	if resp == nil {
		http.Error(w, "internal: nil response", http.StatusInternalServerError)
		return
	}
	for k, v := range resp.Header {
		w.Header().Set(k, v)
	}

	if resp.Stream != nil {
		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Time{}) // long-lived stream: no deadline
		w.WriteHeader(resp.Status)
		_, _ = io.Copy(&flushWriter{w: w, rc: rc}, resp.Stream)
		if c, ok := resp.Stream.(io.Closer); ok {
			_ = c.Close()
		}
		return
	}

	if _, ok := resp.Header["Content-Type"]; !ok {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(resp.Status)
	_, _ = w.Write(resp.Body)
}

// isIdentityHeader matches the X-Sov-* headers that carry caller identity, which
// a public-facing gateway must strip so a client can't smuggle e.g.
// X-Sov-Subject: admin. (Mirrors sov's internal set.)
func isIdentityHeader(canonical string) bool {
	switch canonical {
	case "X-Sov-Subject", "X-Sov-Issuer", "X-Sov-Scopes", "X-Sov-Expires", "X-Sov-Seal":
		return true
	}
	return false
}

func remoteIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// flushWriter flushes after each write so stream chunks reach the client
// immediately instead of stalling in net/http's output buffer.
type flushWriter struct {
	w  io.Writer
	rc *http.ResponseController
}

func (fw *flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	if err != nil {
		return n, err
	}
	_ = fw.rc.Flush()
	return n, nil
}
