// Package stackspec is hope's structured deploy model: a StackSpec (a whole
// compose-style stack) and its ContainerSpec services. It is the single shape
// the visual stack builder, the one-off container form, and the editor all
// produce and consume.
//
// The package is deliberately pure — it defines the types, parses/renders a
// practical compose subset (compose.go), and hashes a service for diffing. It
// imports neither the Docker SDK nor hope's docker package, so both the API
// executor (internal/docker) and the deploy engine (internal/deploy) can depend
// on it without a cycle. Reconstructing a StackSpec from live containers lives
// in the docker package (it needs SDK inspect); this package only shapes data.
package stackspec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

// PortMap is one published port. Host empty means the container port is exposed
// but not published to the host.
type PortMap struct {
	Host      string `json:"host,omitempty"`
	Container string `json:"container"`
	Protocol  string `json:"protocol,omitempty"` // tcp (default) | udp
	HostIP    string `json:"host_ip,omitempty"`
}

// MountSpec is one volume or bind mount.
type MountSpec struct {
	Type     string `json:"type"`   // "volume" | "bind"
	Source   string `json:"source"` // volume name or host path
	Target   string `json:"target"` // container path
	ReadOnly bool   `json:"read_only,omitempty"`
}

// HealthSpec mirrors a compose healthcheck.
type HealthSpec struct {
	Test        []string `json:"test,omitempty"` // CMD/CMD-SHELL form
	Interval    string   `json:"interval,omitempty"`
	Timeout     string   `json:"timeout,omitempty"`
	Retries     int      `json:"retries,omitempty"`
	StartPeriod string   `json:"start_period,omitempty"`
}

// TunnelRoute is an optional public-route intent (Cloudflare tunnel) attached to
// a service. It travels with the spec so the builder/editor can show and re-apply
// it; the actual route apply/teardown is driven through the Tunnels RPC.
type TunnelRoute struct {
	Connector string `json:"connector"` // connector container id
	Hostname  string `json:"hostname"`
	Port      string `json:"port"`
	Path      string `json:"path,omitempty"`
}

// ContainerSpec is one service (in a stack) or a one-off container.
type ContainerSpec struct {
	Name       string            `json:"name,omitempty"` // compose service name / container name
	Image      string            `json:"image"`
	Command    []string          `json:"command,omitempty"`
	Entrypoint []string          `json:"entrypoint,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	Ports      []PortMap         `json:"ports,omitempty"`
	Mounts     []MountSpec       `json:"mounts,omitempty"`
	Networks   []string          `json:"networks,omitempty"`
	Restart    string            `json:"restart,omitempty"`
	User       string            `json:"user,omitempty"`
	WorkingDir string            `json:"working_dir,omitempty"`
	Privileged bool              `json:"privileged,omitempty"`
	CapAdd     []string          `json:"cap_add,omitempty"`
	ExtraHosts []string          `json:"extra_hosts,omitempty"`
	DependsOn  []string          `json:"depends_on,omitempty"`
	Health     *HealthSpec       `json:"health,omitempty"`
	Tunnels    []TunnelRoute     `json:"tunnels,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// NetworkSpec is a stack-scoped (or standalone) network to create.
type NetworkSpec struct {
	Name       string            `json:"name"`
	Driver     string            `json:"driver,omitempty"` // default bridge
	Subnet     string            `json:"subnet,omitempty"`
	Gateway    string            `json:"gateway,omitempty"`
	Internal   bool              `json:"internal,omitempty"`
	Attachable bool              `json:"attachable,omitempty"`
	IPv6       bool              `json:"ipv6,omitempty"`
	External   bool              `json:"external,omitempty"` // don't create; must pre-exist
	Labels     map[string]string `json:"labels,omitempty"`
}

// VolumeSpec is a stack-scoped (or standalone) volume to create.
type VolumeSpec struct {
	Name     string            `json:"name"`
	Driver   string            `json:"driver,omitempty"` // default local
	Options  map[string]string `json:"options,omitempty"`
	External bool              `json:"external,omitempty"` // don't create; must pre-exist
	Labels   map[string]string `json:"labels,omitempty"`
}

// StackSpec is a whole stack: its services plus the networks/volumes it declares.
// A one-off container is a StackSpec with a single service and an empty Name.
type StackSpec struct {
	Name     string          `json:"name"`
	Services []ContainerSpec `json:"services"`
	Networks []NetworkSpec   `json:"networks,omitempty"`
	Volumes  []VolumeSpec    `json:"volumes,omitempty"`
}

// Warning is a non-fatal note from parsing/planning (an unsupported compose key,
// a skipped field) surfaced into the deploy log so nothing is dropped silently.
type Warning struct {
	Service string `json:"service,omitempty"`
	Message string `json:"message"`
}

// Hash is a stable content fingerprint of a service, used by the apply-diff to
// decide whether a live container needs recreating. Name is excluded (it keys
// the diff, not content) and order-insensitive slices are sorted so a service
// only re-hashes on a real change. Command/Entrypoint/Health.Test keep their
// order (it is semantic). encoding/json sorts map keys, so the result is
// deterministic.
func Hash(s ContainerSpec) string {
	c := s
	c.Name = ""
	c.Tunnels = nil // routes are applied out-of-band, not part of the container
	c.Networks = sortedCopy(c.Networks)
	c.CapAdd = sortedCopy(c.CapAdd)
	c.ExtraHosts = sortedCopy(c.ExtraHosts)
	c.DependsOn = sortedCopy(c.DependsOn)
	c.Ports = sortedPorts(c.Ports)
	c.Mounts = sortedMounts(c.Mounts)
	b, _ := json.Marshal(c)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

func sortedCopy(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func sortedPorts(in []PortMap) []PortMap {
	if len(in) == 0 {
		return nil
	}
	out := append([]PortMap(nil), in...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Container != out[j].Container {
			return out[i].Container < out[j].Container
		}
		if out[i].Protocol != out[j].Protocol {
			return out[i].Protocol < out[j].Protocol
		}
		return out[i].Host < out[j].Host
	})
	return out
}

func sortedMounts(in []MountSpec) []MountSpec {
	if len(in) == 0 {
		return nil
	}
	out := append([]MountSpec(nil), in...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Target != out[j].Target {
			return out[i].Target < out[j].Target
		}
		return out[i].Source < out[j].Source
	})
	return out
}

// ServiceByName returns the service with the given name (and whether it existed).
func (s *StackSpec) ServiceByName(name string) (ContainerSpec, bool) {
	for _, svc := range s.Services {
		if svc.Name == name {
			return svc, true
		}
	}
	return ContainerSpec{}, false
}

// Validate checks the spec is deployable, returning a human-readable reason if
// not. It does not mutate.
func (s *StackSpec) Validate() error {
	if strings.TrimSpace(s.Name) == "" && len(s.Services) != 1 {
		return errValidate("stack name is required")
	}
	if len(s.Services) == 0 {
		return errValidate("at least one service is required")
	}
	seen := map[string]bool{}
	for i, svc := range s.Services {
		if strings.TrimSpace(svc.Image) == "" {
			return errValidate("service " + svcLabel(svc, i) + ": image is required")
		}
		if svc.Name != "" {
			if seen[svc.Name] {
				return errValidate("duplicate service name " + svc.Name)
			}
			seen[svc.Name] = true
		}
	}
	return nil
}

func svcLabel(s ContainerSpec, i int) string {
	if s.Name != "" {
		return s.Name
	}
	return "#" + itoa(i+1)
}

// TopoSort orders services so a service's depends_on come before it. Cycles and
// unknown deps are tolerated (best-effort): remaining services are appended in
// their original order so a bad graph never drops a service.
func (s *StackSpec) TopoSort() []ContainerSpec {
	byName := map[string]ContainerSpec{}
	for _, svc := range s.Services {
		if svc.Name != "" {
			byName[svc.Name] = svc
		}
	}
	var out []ContainerSpec
	done := map[string]bool{}
	var visit func(svc ContainerSpec, stack map[string]bool)
	visit = func(svc ContainerSpec, stack map[string]bool) {
		if svc.Name != "" {
			if done[svc.Name] || stack[svc.Name] {
				return
			}
			stack[svc.Name] = true
		}
		deps := append([]string(nil), svc.DependsOn...)
		sort.Strings(deps)
		for _, d := range deps {
			if dep, ok := byName[d]; ok {
				visit(dep, stack)
			}
		}
		if svc.Name != "" {
			done[svc.Name] = true
			delete(stack, svc.Name)
		}
		out = append(out, svc)
	}
	for _, svc := range s.Services {
		if svc.Name == "" || !done[svc.Name] {
			visit(svc, map[string]bool{})
		}
	}
	return out
}

type validateErr struct{ msg string }

func (e validateErr) Error() string { return e.msg }
func errValidate(m string) error    { return validateErr{m} }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
