package logger

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Toyz/sov/gateway"
)

// OnDispatch renders one text line per call, escalating level by status and
// choosing rpc= vs path= depending on whether a router/method is present.
func TestOnDispatchText(t *testing.T) {
	tests := []struct {
		name     string
		ev       gateway.DispatchEvent
		wantSubs []string
		notSubs  []string
	}{
		{
			name:     "rpc call, 200 -> INFO",
			ev:       gateway.DispatchEvent{Router: "Widget", Method: "Create", Path: "/rpc/Widget/Create", Status: 200, Duration: time.Millisecond},
			wantSubs: []string{"INFO", "request", "rpc=Widget/Create", "status=200", "dur="},
		},
		{
			name:     "4xx -> WARN",
			ev:       gateway.DispatchEvent{Router: "Widget", Method: "Get", Status: 404},
			wantSubs: []string{"WARN", "rpc=Widget/Get", "status=404"},
			notSubs:  []string{"INFO"},
		},
		{
			name:     "5xx -> ERROR",
			ev:       gateway.DispatchEvent{Router: "Widget", Method: "Get", Status: 500},
			wantSubs: []string{"ERROR", "status=500"},
		},
		{
			name:     "framework path with no router uses path=",
			ev:       gateway.DispatchEvent{Path: "/rpc/_health", Status: 200},
			wantSubs: []string{"path=/rpc/_health", "status=200"},
			notSubs:  []string{"rpc="},
		},
		{
			name:     "subject and mode appended when present",
			ev:       gateway.DispatchEvent{Router: "Widget", Method: "Create", Status: 200, Subject: "alice", Mode: "local"},
			wantSubs: []string{"sub=alice", "mode=local"},
		},
		{
			name:     "subject and mode omitted when empty",
			ev:       gateway.DispatchEvent{Router: "Widget", Method: "Create", Status: 200},
			notSubs:  []string{"sub=", "mode="},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			p := New(Config{Out: &buf})
			if err := p.OnDispatch(tt.ev); err != nil {
				t.Fatalf("OnDispatch: %v", err)
			}
			out := buf.String()
			for _, s := range tt.wantSubs {
				if !strings.Contains(out, s) {
					t.Errorf("output %q missing %q", out, s)
				}
			}
			for _, s := range tt.notSubs {
				if strings.Contains(out, s) {
					t.Errorf("output %q should not contain %q", out, s)
				}
			}
		})
	}
}

// MinStatus drops calls below the threshold entirely.
func TestOnDispatchMinStatus(t *testing.T) {
	var buf bytes.Buffer
	p := New(Config{Out: &buf, MinStatus: 400})

	if err := p.OnDispatch(gateway.DispatchEvent{Router: "W", Method: "M", Status: 200}); err != nil {
		t.Fatal(err)
	}
	if buf.Len() != 0 {
		t.Errorf("200 with MinStatus=400 logged: %q", buf.String())
	}
	if err := p.OnDispatch(gateway.DispatchEvent{Router: "W", Method: "M", Status: 500}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "status=500") {
		t.Errorf("500 with MinStatus=400 should log; got %q", buf.String())
	}
}

// SkipFramework drops successful /rpc/_* calls but keeps their errors.
func TestOnDispatchSkipFramework(t *testing.T) {
	tests := []struct {
		name    string
		ev      gateway.DispatchEvent
		wantLog bool
	}{
		{"framework 200 dropped", gateway.DispatchEvent{Path: "/rpc/_introspect", Status: 200}, false},
		{"framework 500 kept", gateway.DispatchEvent{Path: "/rpc/_introspect", Status: 500}, true},
		{"business 200 kept", gateway.DispatchEvent{Router: "W", Method: "M", Path: "/rpc/W/M", Status: 200}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			p := New(Config{Out: &buf, SkipFramework: true})
			if err := p.OnDispatch(tt.ev); err != nil {
				t.Fatal(err)
			}
			if logged := buf.Len() > 0; logged != tt.wantLog {
				t.Errorf("logged = %v; want %v (out=%q)", logged, tt.wantLog, buf.String())
			}
		})
	}
}

// JSON mode emits the marshalled event instead of a text line.
func TestOnDispatchJSON(t *testing.T) {
	var buf bytes.Buffer
	p := New(Config{Out: &buf, JSON: true})
	ev := gateway.DispatchEvent{Router: "Widget", Method: "Create", Status: 201}
	if err := p.OnDispatch(ev); err != nil {
		t.Fatal(err)
	}
	var got gateway.DispatchEvent
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("output is not JSON: %q (%v)", buf.String(), err)
	}
	if got.Router != "Widget" || got.Status != 201 {
		t.Errorf("decoded = %+v; want Router=Widget Status=201", got)
	}
}

// Color wraps tokens in ANSI escapes only when enabled.
func TestColor(t *testing.T) {
	var on, off bytes.Buffer
	New(Config{Out: &on, Color: true}).OnDispatch(gateway.DispatchEvent{Router: "W", Method: "M", Status: 200})
	New(Config{Out: &off}).OnDispatch(gateway.DispatchEvent{Router: "W", Method: "M", Status: 200})
	if !strings.Contains(on.String(), "\x1b[") {
		t.Errorf("color on should emit ANSI escapes; got %q", on.String())
	}
	if strings.Contains(off.String(), "\x1b[") {
		t.Errorf("color off should not emit ANSI escapes; got %q", off.String())
	}
}

// The gateway.Logger surface writes leveled lines through the same sink.
func TestLoggerLevels(t *testing.T) {
	var buf bytes.Buffer
	p := New(Config{Out: &buf})
	p.Debug("dmsg", "k", "v")
	p.Info("imsg")
	p.Warn("wmsg")
	p.Error("emsg", "code", 7)
	out := buf.String()
	for _, s := range []string{"DEBUG dmsg", "INFO imsg", "WARN wmsg", "ERROR emsg", "k=v", "code=7"} {
		if !strings.Contains(out, s) {
			t.Errorf("output missing %q; got:\n%s", s, out)
		}
	}
	// One line per call.
	if n := strings.Count(strings.TrimRight(out, "\n"), "\n"); n != 3 {
		t.Errorf("want 4 lines (3 newlines between); got %d in %q", n, out)
	}
}

func TestPluginMeta(t *testing.T) {
	p := New(Config{})
	if p.PluginName() != "logger" {
		t.Errorf("PluginName = %q", p.PluginName())
	}
	if p.Doc() == "" {
		t.Error("Doc should be non-empty")
	}
}
