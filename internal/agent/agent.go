// Package agent implements hope's remote-host model. A hope-agent runs on a
// remote Docker host and dials OUT to a hope hub (so the remote needs only
// outbound access — no inbound ports, no VPN). Over that single connection it
// multiplexes (yamux) the host's Docker socket back to hope: hope opens a
// stream per Docker request and the agent proxies each to the local daemon. So
// hope's entire existing Docker layer works against the remote host unchanged.
package agent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"github.com/hashicorp/yamux"
)

// protoLine is the handshake the agent sends first: "HOPE-AGENT/1 <token> <id>".
const protoVersion = "HOPE-AGENT/1"

// Logger is the small logging surface the agent/hub need (hope's logger fits).
type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
	Error(msg string, kv ...any)
}

// Run connects to a hope hub and serves the local Docker socket over the tunnel
// until ctx is cancelled, reconnecting on drop.
func Run(ctx context.Context, hubAddr, token, hostID, dockerHost string, log Logger) error {
	for {
		if err := serveOnce(ctx, hubAddr, token, hostID, dockerHost, log); err != nil && ctx.Err() == nil {
			log.Warn("agent disconnected", "err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

func serveOnce(ctx context.Context, hubAddr, token, hostID, dockerHost string, log Logger) error {
	conn, err := net.DialTimeout("tcp", hubAddr, 10*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := fmt.Fprintf(conn, "%s %s %s\n", protoVersion, token, hostID); err != nil {
		return err
	}
	reply, err := readLine(conn)
	if err != nil {
		return err
	}
	if strings.TrimSpace(reply) != "OK" {
		return fmt.Errorf("hub rejected: %s", strings.TrimSpace(reply))
	}
	log.Info("agent connected", "hub", hubAddr, "host", hostID)

	// Agent accepts streams; hope (the hub) opens them.
	sess, err := yamux.Server(conn, nil)
	if err != nil {
		return err
	}
	defer sess.Close()

	go func() {
		<-ctx.Done()
		sess.Close()
	}()

	for {
		stream, err := sess.Accept()
		if err != nil {
			return err // session closed
		}
		go proxyToDocker(stream, dockerHost)
	}
}

// proxyToDocker pipes one tunnel stream to the local Docker endpoint.
func proxyToDocker(stream net.Conn, dockerHost string) {
	defer stream.Close()
	network, addr := dockerDial(dockerHost)
	d, err := net.DialTimeout(network, addr, 10*time.Second)
	if err != nil {
		return
	}
	defer d.Close()
	done := make(chan struct{}, 1)
	go func() { _, _ = io.Copy(d, stream); done <- struct{}{} }()
	_, _ = io.Copy(stream, d)
	<-done
}

// dockerDial splits a docker host URI into a net network+address.
func dockerDial(host string) (network, addr string) {
	switch {
	case strings.HasPrefix(host, "unix://"):
		return "unix", strings.TrimPrefix(host, "unix://")
	case strings.HasPrefix(host, "tcp://"):
		return "tcp", strings.TrimPrefix(host, "tcp://")
	case host == "":
		return "unix", "/var/run/docker.sock"
	default:
		return "unix", host
	}
}

// readLine reads a single '\n'-terminated line without buffering past it, so the
// remaining bytes stay on the wire for yamux.
func readLine(conn net.Conn) (string, error) {
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	defer conn.SetReadDeadline(time.Time{})
	br := bufio.NewReaderSize(oneByteReader{conn}, 1)
	return br.ReadString('\n')
}

// oneByteReader forces single-byte reads so a bufio.Reader can't pull more than
// the handshake line off the connection.
type oneByteReader struct{ r io.Reader }

func (o oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return o.r.Read(p)
}
