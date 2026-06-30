// Package logger is hope's request-logging plugin. It extends the sov gateway
// via DispatchHook (one line per dispatched call) AND implements gateway.Logger,
// so it becomes the gateway-wide log sink — the framework and every other plugin
// log THROUGH it, giving one unified, consistently-formatted output.
//
//	gw.MustUse(logger.New(logger.Config{Color: true, SkipFramework: true}))
package logger

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Toyz/sov/gateway"
)

// Config configures the logger plugin.
type Config struct {
	Out           io.Writer // default os.Stdout
	JSON          bool      // emit JSON instead of a text line
	Color         bool      // ANSI colors (terminals); off for files/JSON
	SkipFramework bool       // drop /rpc/_* 200s so business calls stand out
	MinStatus     int        // only log status >= this (e.g. 400 = errors only)
}

// Plugin is the request logger.
type Plugin struct {
	mu            sync.Mutex
	out           io.Writer
	json          bool
	color         bool
	skipFramework bool
	minStatus     int
}

// Compile-time proof of the hooks this plugin binds — implementing
// gateway.Logger makes it the gateway-wide log sink (gw.Log()).
var (
	_ gateway.Plugin       = (*Plugin)(nil)
	_ gateway.PluginDoc    = (*Plugin)(nil)
	_ gateway.DispatchHook = (*Plugin)(nil)
	_ gateway.Logger       = (*Plugin)(nil)
)

// New returns a logger plugin from cfg.
func New(cfg Config) *Plugin {
	out := cfg.Out
	if out == nil {
		out = os.Stdout
	}
	return &Plugin{
		out:           out,
		json:          cfg.JSON,
		color:         cfg.Color,
		skipFramework: cfg.SkipFramework,
		minStatus:     cfg.MinStatus,
	}
}

// PluginName surfaces in /rpc/_introspect.plugins[].
func (p *Plugin) PluginName() string { return "logger" }

// Doc satisfies gateway.PluginDoc.
func (p *Plugin) Doc() string {
	return "Logs one line per dispatched RPC (router, method, status, duration, subject, mode)."
}

// ---- gateway.Logger ----

func (p *Plugin) Debug(msg string, args ...any) { p.line("DEBUG", msg, args) }
func (p *Plugin) Info(msg string, args ...any)  { p.line("INFO", msg, args) }
func (p *Plugin) Warn(msg string, args ...any)  { p.line("WARN", msg, args) }
func (p *Plugin) Error(msg string, args ...any) { p.line("ERROR", msg, args) }

// ---- gateway.DispatchHook ----

// OnDispatch logs the call through this plugin's own Logger methods so request
// lines share the format/sink of every other line (and 4xx/5xx escalate level).
func (p *Plugin) OnDispatch(ev gateway.DispatchEvent) error {
	if ev.Status < p.minStatus {
		return nil
	}
	if p.skipFramework && strings.HasPrefix(ev.Path, "/rpc/_") && ev.Status < 400 {
		return nil
	}
	if p.json {
		if b, err := json.Marshal(ev); err == nil {
			p.write(string(b))
		}
		return nil
	}

	args := []any{}
	if ev.Router == "" && ev.Method == "" {
		args = append(args, "path", ev.Path)
	} else {
		args = append(args, "rpc", ev.Router+"/"+ev.Method)
	}
	args = append(args, "status", ev.Status, "dur", ev.Duration.Round(time.Microsecond))
	if ev.Subject != "" {
		args = append(args, "sub", ev.Subject)
	}
	if ev.Mode != "" {
		args = append(args, "mode", ev.Mode)
	}

	switch {
	case ev.Status >= 500:
		p.Error("request", args...)
	case ev.Status >= 400:
		p.Warn("request", args...)
	default:
		p.Info("request", args...)
	}
	return nil
}

// ---- formatting ----

func (p *Plugin) line(level, msg string, args []any) {
	var b strings.Builder
	b.WriteString(p.paint(cGray, time.Now().Format("15:04:05.000")))
	b.WriteByte(' ')
	b.WriteString(p.paint(levelColor(level), level))
	b.WriteByte(' ')
	b.WriteString(msg)
	for i := 0; i+1 < len(args); i += 2 {
		fmt.Fprintf(&b, " %s=%v", p.paint(cCyan, fmt.Sprint(args[i])), args[i+1])
	}
	p.write(b.String())
}

func (p *Plugin) write(s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintln(p.out, s)
}

// ANSI colors.
const (
	cReset  = "\x1b[0m"
	cGray   = "\x1b[90m"
	cGreen  = "\x1b[32m"
	cYellow = "\x1b[33m"
	cRed    = "\x1b[31m"
	cCyan   = "\x1b[36m"
)

func (p *Plugin) paint(c, s string) string {
	if !p.color {
		return s
	}
	return c + s + cReset
}

func levelColor(level string) string {
	switch level {
	case "DEBUG":
		return cGray
	case "WARN":
		return cYellow
	case "ERROR":
		return cRed
	default:
		return cGreen
	}
}
