package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
)

// serveStream runs a stream handler, writing each emitted value as one NDJSON
// line of a JSON-RPC result frame (Content-Type application/x-ndjson) — the shape
// hope's existing stream plumbing consumes. The handler's context is the request
// context, so it is cancelled the moment hope/the UI disconnects; a well-behaved
// handler selects on ctx.Done() and stops emitting, avoiding goroutine leaks.
func (p *Plugin) serveStream(w http.ResponseWriter, id json.RawMessage, st streamEntry, ctx context.Context) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, id, codeInternal, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	enc := json.NewEncoder(w)

	// emit is called from the handler's goroutine(s); guard the encoder+flusher
	// and drop frames once the context is done so a late emit can't panic on a
	// closed connection.
	var mu sync.Mutex
	emit := func(v any) {
		if ctx.Err() != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_ = enc.Encode(rpcResponse{JSONRPC: "2.0", ID: id, Result: v})
		flusher.Flush()
	}

	err := st.fn(ctx, emit)
	if err != nil && ctx.Err() == nil {
		mu.Lock()
		defer mu.Unlock()
		_ = enc.Encode(rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: codeInternal, Message: err.Error()}})
		flusher.Flush()
	}
}
