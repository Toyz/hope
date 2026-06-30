// Package compose drives stack-level lifecycle by shelling out to the
// `docker compose` CLI, using the project/working_dir/config_files metadata
// that Docker stamps as container labels. It talks to the same daemon as
// hope's Docker client via DOCKER_HOST.
package compose

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Op is a supported stack operation.
type Op string

const (
	OpUp       Op = "up"       // up -d
	OpDown     Op = "down"     // down
	OpPull     Op = "pull"     // pull
	OpRestart  Op = "restart"  // restart
	OpRedeploy Op = "redeploy" // pull then up -d
)

// Valid reports whether op is a recognized operation.
func (o Op) Valid() bool {
	switch o {
	case OpUp, OpDown, OpPull, OpRestart, OpRedeploy:
		return true
	}
	return false
}

// StackRef identifies a compose project on disk. All fields come straight
// from container labels — hope never hardcodes paths.
type StackRef struct {
	Project     string
	WorkingDir  string
	ConfigFiles []string
}

// Manager runs compose commands against a fixed daemon endpoint, optionally
// restricted to project roots under an allowlist.
type Manager struct {
	dockerHost string
	roots      []string
}

// NewManager returns a Manager. roots, if non-empty, restricts operations to
// stacks whose working_dir is under one of the listed directories.
func NewManager(dockerHost string, roots []string) *Manager {
	return &Manager{dockerHost: dockerHost, roots: roots}
}

// Run executes op for the stack and returns the combined stdout+stderr. It is
// the buffered form used by RPC handlers; use Stream for live progress.
func (m *Manager) Run(ctx context.Context, ref StackRef, op Op) (string, error) {
	var buf bytes.Buffer
	err := m.Stream(ctx, ref, op, &buf)
	return buf.String(), err
}

// Stream executes op for the stack, writing combined stdout+stderr to w as it
// is produced. Redeploy runs pull then up -d in sequence.
func (m *Manager) Stream(ctx context.Context, ref StackRef, op Op, w io.Writer) error {
	if !op.Valid() {
		return fmt.Errorf("unknown compose op %q", op)
	}
	if err := m.authorize(ref); err != nil {
		return err
	}

	switch op {
	case OpRedeploy:
		if err := m.exec(ctx, ref, w, "pull"); err != nil {
			return err
		}
		return m.exec(ctx, ref, w, "up", "-d")
	case OpUp:
		return m.exec(ctx, ref, w, "up", "-d")
	case OpDown:
		return m.exec(ctx, ref, w, "down")
	case OpPull:
		return m.exec(ctx, ref, w, "pull")
	case OpRestart:
		return m.exec(ctx, ref, w, "restart")
	default:
		return fmt.Errorf("unknown compose op %q", op)
	}
}

// ComposeFile returns the concatenated text of the stack's config files for
// read-only display in the UI.
func (m *Manager) ComposeFile(ref StackRef) (string, error) {
	if err := m.authorize(ref); err != nil {
		return "", err
	}
	if len(ref.ConfigFiles) == 0 {
		return "", fmt.Errorf("stack %q has no config files", ref.Project)
	}
	var b strings.Builder
	for i, f := range ref.ConfigFiles {
		data, err := os.ReadFile(f)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", f, err)
		}
		if i > 0 {
			b.WriteString("\n# --- ")
			b.WriteString(f)
			b.WriteString(" ---\n")
		}
		b.Write(data)
	}
	return b.String(), nil
}

func (m *Manager) exec(ctx context.Context, ref StackRef, w io.Writer, sub ...string) error {
	args := []string{"compose"}
	if ref.Project != "" {
		args = append(args, "-p", ref.Project)
	}
	for _, f := range ref.ConfigFiles {
		args = append(args, "-f", f)
	}
	args = append(args, sub...)

	fmt.Fprintf(w, "$ docker %s\n", strings.Join(args, " "))

	cmd := exec.CommandContext(ctx, "docker", args...)
	if ref.WorkingDir != "" {
		cmd.Dir = ref.WorkingDir
	}
	cmd.Env = append(os.Environ(), "DOCKER_HOST="+m.dockerHost)
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker %s: %w", strings.Join(sub, " "), err)
	}
	return nil
}

// authorize enforces the optional project-root allowlist.
func (m *Manager) authorize(ref StackRef) error {
	if len(m.roots) == 0 {
		return nil
	}
	wd := filepath.Clean(ref.WorkingDir)
	for _, root := range m.roots {
		root = filepath.Clean(root)
		if wd == root || strings.HasPrefix(wd, root+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf("stack %q working_dir %q is outside the configured compose roots", ref.Project, ref.WorkingDir)
}
