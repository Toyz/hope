package tunnels

import (
	"reflect"
	"testing"

	"github.com/toyz/hope/internal/cloudflare"
	"github.com/toyz/hope/internal/docker"
)

// rule is a terse constructor for an ingress rule.
func rule(host, path, svc string) cloudflare.IngressRule {
	return cloudflare.IngressRule{Hostname: host, Path: path, Service: svc}
}

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"   ", ""},
		{"/", "/"},
		{"api", "/api"},
		{"/api", "/api"},
		{"  /api  ", "/api"},
		{"  api  ", "/api"},
		{"api/v2", "/api/v2"},
	}
	for _, tc := range tests {
		if got := normalizePath(tc.in); got != tc.want {
			t.Errorf("normalizePath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSplitOrigin(t *testing.T) {
	tests := []struct {
		service    string
		host, port string
	}{
		{"http://blog-web-1:8080", "blog-web-1", "8080"},
		{"https://api:443", "api", "443"},
		{"http://host", "host", ""},   // no port
		{"tcp://box:22", "", ""},      // non-http scheme
		{"ssh://box:22", "", ""},      // non-http scheme
		{"http_status:404", "", ""},   // catch-all service, not a URL
		{"", "", ""},                  // empty
		{"unix:/tmp/x.sock", "", ""},  // no http prefix
	}
	for _, tc := range tests {
		host, port := splitOrigin(tc.service)
		if host != tc.host || port != tc.port {
			t.Errorf("splitOrigin(%q) = (%q,%q), want (%q,%q)", tc.service, host, port, tc.host, tc.port)
		}
	}
}

func TestCountRoutes(t *testing.T) {
	tests := []struct {
		name  string
		rules []cloudflare.IngressRule
		want  int
	}{
		{"empty", nil, 0},
		{"only catch-all", []cloudflare.IngressRule{rule("", "", "http_status:404")}, 0},
		{
			name: "two hosts plus catch-all",
			rules: []cloudflare.IngressRule{
				rule("a.com", "", "http://x:1"),
				rule("b.com", "/api", "http://y:2"),
				rule("", "", "http_status:404"),
			},
			want: 2,
		},
		{
			name: "same host different paths count separately",
			rules: []cloudflare.IngressRule{
				rule("a.com", "/api", "http://x:1"),
				rule("a.com", "", "http://x:2"),
				rule("", "", "http_status:404"),
			},
			want: 2,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := countRoutes(tc.rules); got != tc.want {
				t.Errorf("countRoutes = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestHasDefault(t *testing.T) {
	tests := []struct {
		name string
		cons []docker.Connector
		want bool
	}{
		{"empty", nil, false},
		{"none default", []docker.Connector{{Default: false}, {Default: false}}, false},
		{"one default", []docker.Connector{{Default: false}, {Default: true}}, true},
		{"single default", []docker.Connector{{Default: true}}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasDefault(tc.cons); got != tc.want {
				t.Errorf("hasDefault = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestUpsertIngress(t *testing.T) {
	tests := []struct {
		name                string
		rules               []cloudflare.IngressRule
		host, path, service string
		want                []cloudflare.IngressRule
	}{
		{
			name:    "add first path-less rule to empty",
			rules:   nil,
			host:    "a.com",
			path:    "",
			service: "http://x:1",
			want:    []cloudflare.IngressRule{rule("a.com", "", "http://x:1")},
		},
		{
			name:    "drops catch-all and replaces duplicate host+path",
			rules:   []cloudflare.IngressRule{rule("a.com", "", "http://old:1"), rule("", "", "http_status:404")},
			host:    "a.com",
			path:    "",
			service: "http://new:1",
			want:    []cloudflare.IngressRule{rule("a.com", "", "http://new:1")},
		},
		{
			name:    "path rule inserted before same host path-less rule",
			rules:   []cloudflare.IngressRule{rule("a.com", "", "http://root:1")},
			host:    "a.com",
			path:    "/api",
			service: "http://api:2",
			want: []cloudflare.IngressRule{
				rule("a.com", "/api", "http://api:2"),
				rule("a.com", "", "http://root:1"),
			},
		},
		{
			name:    "second path rule still inserted before path-less rule",
			rules:   []cloudflare.IngressRule{rule("a.com", "/api", "http://api:1"), rule("a.com", "", "http://root:1")},
			host:    "a.com",
			path:    "/v2",
			service: "http://v2:3",
			want: []cloudflare.IngressRule{
				rule("a.com", "/api", "http://api:1"),
				rule("a.com", "/v2", "http://v2:3"),
				rule("a.com", "", "http://root:1"),
			},
		},
		{
			name:    "path rule appended when no path-less rule for host",
			rules:   []cloudflare.IngressRule{rule("b.com", "", "http://b:1")},
			host:    "a.com",
			path:    "/api",
			service: "http://api:2",
			want: []cloudflare.IngressRule{
				rule("b.com", "", "http://b:1"),
				rule("a.com", "/api", "http://api:2"),
			},
		},
		{
			name:    "replace exact host+path keeps ordering, other host untouched",
			rules:   []cloudflare.IngressRule{rule("b.com", "", "http://b:1"), rule("a.com", "/api", "http://old:2"), rule("a.com", "", "http://root:1")},
			host:    "a.com",
			path:    "/api",
			service: "http://new:9",
			want: []cloudflare.IngressRule{
				rule("b.com", "", "http://b:1"),
				rule("a.com", "/api", "http://new:9"),
				rule("a.com", "", "http://root:1"),
			},
		},
		{
			name:    "path-less rule appended at end even with existing path rule",
			rules:   []cloudflare.IngressRule{rule("a.com", "/api", "http://api:1")},
			host:    "a.com",
			path:    "",
			service: "http://root:1",
			want: []cloudflare.IngressRule{
				rule("a.com", "/api", "http://api:1"),
				rule("a.com", "", "http://root:1"),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := upsertIngress(tc.rules, tc.host, tc.path, tc.service)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("upsertIngress = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestDropIngress(t *testing.T) {
	tests := []struct {
		name          string
		rules         []cloudflare.IngressRule
		host, path    string
		want          []cloudflare.IngressRule
		wantFound     bool
		wantRemaining int
	}{
		{
			name:      "not found leaves rules (minus catch-all) intact",
			rules:     []cloudflare.IngressRule{rule("b.com", "", "http://b:1"), rule("", "", "http_status:404")},
			host:      "a.com",
			path:      "",
			want:      []cloudflare.IngressRule{rule("b.com", "", "http://b:1")},
			wantFound: false,
		},
		{
			name:          "found, no other rules for host remain",
			rules:         []cloudflare.IngressRule{rule("a.com", "", "http://a:1"), rule("", "", "http_status:404")},
			host:          "a.com",
			path:          "",
			want:          []cloudflare.IngressRule{},
			wantFound:     true,
			wantRemaining: 0,
		},
		{
			name:          "found path rule, path-less rule for host remains",
			rules:         []cloudflare.IngressRule{rule("a.com", "/api", "http://api:1"), rule("a.com", "", "http://root:1")},
			host:          "a.com",
			path:          "/api",
			want:          []cloudflare.IngressRule{rule("a.com", "", "http://root:1")},
			wantFound:     true,
			wantRemaining: 1,
		},
		{
			name:          "catch-all always dropped, other host preserved",
			rules:         []cloudflare.IngressRule{rule("a.com", "", "http://a:1"), rule("b.com", "", "http://b:1"), rule("", "", "http_status:404")},
			host:          "a.com",
			path:          "",
			want:          []cloudflare.IngressRule{rule("b.com", "", "http://b:1")},
			wantFound:     true,
			wantRemaining: 0,
		},
		{
			name:          "found, two other paths for same host remain",
			rules:         []cloudflare.IngressRule{rule("a.com", "/api", "http://api:1"), rule("a.com", "/v2", "http://v2:1"), rule("a.com", "", "http://root:1")},
			host:          "a.com",
			path:          "/api",
			want:          []cloudflare.IngressRule{rule("a.com", "/v2", "http://v2:1"), rule("a.com", "", "http://root:1")},
			wantFound:     true,
			wantRemaining: 2,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, found, remaining := dropIngress(tc.rules, tc.host, tc.path)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("dropIngress out = %+v, want %+v", got, tc.want)
			}
			if found != tc.wantFound {
				t.Errorf("found = %v, want %v", found, tc.wantFound)
			}
			if remaining != tc.wantRemaining {
				t.Errorf("remaining = %d, want %d", remaining, tc.wantRemaining)
			}
		})
	}
}
