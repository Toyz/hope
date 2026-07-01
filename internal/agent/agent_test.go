package agent

import (
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
)

type nopLog struct{}

func (nopLog) Info(string, ...any)  {}
func (nopLog) Warn(string, ...any)  {}
func (nopLog) Error(string, ...any) {}

// echoListener accepts TCP and echoes everything back.
func echoListener(t *testing.T) (addr string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()
	return ln.Addr().String(), func() { ln.Close() }
}

// TestTunnel exercises the full agent wire: handshake, then a hub-opened yamux
// stream that the agent proxies through to a backend, round-tripping bytes.
func TestTunnel(t *testing.T) {
	backend, stopBackend := echoListener(t)
	defer stopBackend()

	hubLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hubLn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Agent dials the hub and serves backend over the tunnel.
	go func() {
		_ = serveOnce(ctx, Options{
			Connect: hubLn.Addr().String(), Token: "secret", HostID: "host-1",
			Docker: "tcp://" + backend, Log: nopLog{},
		})
	}()

	conn, err := hubLn.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Hub side of the handshake.
	line, err := readLine(conn)
	if err != nil {
		t.Fatalf("read handshake: %v", err)
	}
	// The handshake carries build info + self-id after the stable prefix
	// (version, go/platform, container id) — assert the prefix, not the whole line.
	if want := fmt.Sprintf("%s secret host-1", protoVersion); !strings.HasPrefix(line, want) {
		t.Fatalf("handshake = %q, want prefix %q", line, want)
	}
	if _, err := conn.Write([]byte("OK\n")); err != nil {
		t.Fatal(err)
	}

	sess, err := yamux.Client(conn, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()

	stream, err := sess.Open()
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer stream.Close()

	_ = stream.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := stream.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(stream, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != "ping" {
		t.Fatalf("echo = %q, want ping", buf)
	}
}

// TestHandshakeReject verifies a bad token is denied before any tunnel.
func TestHandshakeReject(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()

	hub := NewHub("right-token", "", nopLog{})
	go hub.handle(context.Background(), c2)

	if _, err := fmt.Fprintf(c1, "%s wrong-token h1\n", protoVersion); err != nil {
		t.Fatal(err)
	}
	reply, err := readLine(c1)
	if err != nil {
		t.Fatal(err)
	}
	if reply != "DENIED\n" {
		t.Fatalf("reply = %q, want DENIED", reply)
	}
}
