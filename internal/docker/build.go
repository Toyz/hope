package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/docker/docker/api/types/build"
)

// BuildImageStream builds an image from a CONTEXTLESS Dockerfile — its text alone,
// with no build context. A Dockerfile that COPY/ADDs from a local path therefore
// can't resolve its sources; callers reject those before getting here (see the
// deploy engine / UI). It's the clean subset for one-off "bring your own Dockerfile"
// deploys (FROM + RUN + ENV + CMD). Progress lines from the daemon are forwarded via
// emit; a mid-stream error (a failed RUN, an unreachable base image) is surfaced as
// an error rather than draining silently.
func (c *Client) BuildImageStream(ctx context.Context, dockerfile, tag string, emit func(string)) error {
	if emit == nil {
		emit = func(string) {}
	}
	// The build context is a tar; for a contextless build it carries just the Dockerfile.
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	df := []byte(dockerfile)
	if err := tw.WriteHeader(&tar.Header{Name: "Dockerfile", Mode: 0o600, Size: int64(len(df))}); err != nil {
		return fmt.Errorf("tar dockerfile: %w", err)
	}
	if _, err := tw.Write(df); err != nil {
		return fmt.Errorf("tar dockerfile: %w", err)
	}
	if err := tw.Close(); err != nil {
		return fmt.Errorf("tar dockerfile: %w", err)
	}

	resp, err := c.sdk().ImageBuild(ctx, &buf, build.ImageBuildOptions{
		Tags:        []string{tag},
		Dockerfile:  "Dockerfile",
		Remove:      true,
		ForceRemove: true,
		PullParent:  true, // fetch a newer base image if one is available
	})
	if err != nil {
		return fmt.Errorf("build: %w", err)
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var msg struct {
			Stream      string `json:"stream"`
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := dec.Decode(&msg); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("build: %w", err)
		}
		if msg.Error != "" {
			detail := msg.Error
			if msg.ErrorDetail.Message != "" {
				detail = msg.ErrorDetail.Message
			}
			return fmt.Errorf("build failed: %s", detail)
		}
		if s := strings.TrimRight(msg.Stream, "\n"); s != "" {
			emit(s)
		}
	}
}
