package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

// ContainerStat is a point-in-time CPU/memory reading for one container.
type ContainerStat struct {
	ID         string  `json:"id"`
	CPUPercent float64 `json:"cpu_percent"`
	MemUsed    uint64  `json:"mem_used"`
	MemLimit   uint64  `json:"mem_limit"`
}

// statsRaw is the subset of the Docker stats stream we need.
type statsRaw struct {
	CPUStats    cpuStats `json:"cpu_stats"`
	PreCPUStats cpuStats `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Limit uint64 `json:"limit"`
		Stats struct {
			Cache        uint64 `json:"cache"`
			InactiveFile uint64 `json:"inactive_file"`
		} `json:"stats"`
	} `json:"memory_stats"`
}

type cpuStats struct {
	CPUUsage struct {
		TotalUsage uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	SystemUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs  uint32 `json:"online_cpus"`
}

// StatsSnapshot reads a single CPU/memory sample for a container. CPU% needs a
// delta, so it reads two frames of the stats stream (the second carries a valid
// precpu) and then closes.
func (c *Client) StatsSnapshot(ctx context.Context, id string) (ContainerStat, error) {
	resp, err := c.sdk().ContainerStats(ctx, id, true)
	if err != nil {
		return ContainerStat{}, fmt.Errorf("stats %s: %w", id, err)
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	var s statsRaw
	for i := 0; i < 2; i++ {
		if err := dec.Decode(&s); err != nil {
			if i == 0 {
				return ContainerStat{}, fmt.Errorf("stats %s: %w", id, err)
			}
			break
		}
	}

	mem := s.MemoryStats.Usage
	if cache := s.MemoryStats.Stats.Cache; cache > 0 && cache <= mem {
		mem -= cache
	} else if inactive := s.MemoryStats.Stats.InactiveFile; inactive > 0 && inactive <= mem {
		mem -= inactive
	}
	return ContainerStat{ID: id, CPUPercent: cpuPercent(s), MemUsed: mem, MemLimit: s.MemoryStats.Limit}, nil
}

func cpuPercent(s statsRaw) float64 {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemUsage) - float64(s.PreCPUStats.SystemUsage)
	cpus := float64(s.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = 1
	}
	if sysDelta > 0 && cpuDelta >= 0 {
		return (cpuDelta / sysDelta) * cpus * 100
	}
	return 0
}

// ProjectStats snapshots every running container in a compose project,
// concurrently. Non-running containers are skipped; per-container errors are
// dropped so one bad container doesn't fail the whole snapshot.
func (c *Client) ProjectStats(ctx context.Context, project string) ([]ContainerStat, error) {
	f := filters.NewArgs(filters.Arg("label", labelProject+"="+project))
	list, err := c.sdk().ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, fmt.Errorf("list project %q: %w", project, err)
	}

	var (
		mu  sync.Mutex
		out []ContainerStat
		wg  sync.WaitGroup
		sem = make(chan struct{}, 12) // cap concurrency
	)
	for _, ct := range list {
		if ct.State != "running" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			st, err := c.StatsSnapshot(ctx, id)
			if err != nil {
				return
			}
			mu.Lock()
			out = append(out, st)
			mu.Unlock()
		}(ct.ID)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
