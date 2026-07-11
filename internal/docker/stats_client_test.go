package docker

import (
	"net/http"
	"strings"
	"testing"
)

// These cover the CPU/memory sampling (stats.go): the pure percentage math and the
// two-frame snapshot read against the fake daemon's stats stream.

func TestCPUPercent(t *testing.T) {
	mk := func(cur, pre, sysCur, sysPre uint64, cpus uint32) statsRaw {
		var s statsRaw
		s.CPUStats.CPUUsage.TotalUsage = cur
		s.PreCPUStats.CPUUsage.TotalUsage = pre
		s.CPUStats.SystemUsage = sysCur
		s.PreCPUStats.SystemUsage = sysPre
		s.CPUStats.OnlineCPUs = cpus
		return s
	}
	// cpuDelta 100 / sysDelta 1000 * 2 cpus * 100 = 20%.
	if got := cpuPercent(mk(200, 100, 2000, 1000, 2)); got != 20 {
		t.Errorf("cpuPercent(2 cpus) = %v; want 20", got)
	}
	// OnlineCPUs 0 defaults to 1: 100/1000 * 1 * 100 = 10%.
	if got := cpuPercent(mk(200, 100, 2000, 1000, 0)); got != 10 {
		t.Errorf("cpuPercent(0 cpus -> 1) = %v; want 10", got)
	}
	// No system delta => 0 (avoid a divide-by-zero blow-up).
	if got := cpuPercent(mk(200, 100, 1000, 1000, 2)); got != 0 {
		t.Errorf("cpuPercent(no sys delta) = %v; want 0", got)
	}
}

// statsFrame builds one stats-stream frame body.
func statsFrame(totalCur, totalPre, sysCur, sysPre, memUsage, memCache, memLimit uint64) map[string]any {
	return map[string]any{
		"cpu_stats": map[string]any{
			"cpu_usage":        map[string]any{"total_usage": totalCur},
			"system_cpu_usage": sysCur,
			"online_cpus":      1,
		},
		"precpu_stats": map[string]any{
			"cpu_usage":        map[string]any{"total_usage": totalPre},
			"system_cpu_usage": sysPre,
		},
		"memory_stats": map[string]any{
			"usage": memUsage,
			"limit": memLimit,
			"stats": map[string]any{"cache": memCache},
		},
	}
}

// TestStatsSnapshot proves the two-frame read: the second frame is the reported
// sample, cache is subtracted from memory, and CPU% comes from the deltas.
func TestStatsSnapshot(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/stats") {
			writePullStream(w, []map[string]any{
				statsFrame(100, 0, 1000, 0, 0, 0, 0),              // first frame (precpu warm-up)
				statsFrame(200, 100, 2000, 1000, 1000, 200, 4096), // reported sample
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	st, err := c.StatsSnapshot(t.Context(), "cid")
	if err != nil {
		t.Fatalf("StatsSnapshot err: %v", err)
	}
	if st.ID != "cid" {
		t.Errorf("ID = %q; want cid", st.ID)
	}
	// mem = usage(1000) - cache(200) = 800.
	if st.MemUsed != 800 || st.MemLimit != 4096 {
		t.Errorf("mem = %d/%d; want 800/4096 (cache subtracted)", st.MemUsed, st.MemLimit)
	}
	// cpuDelta 100 / sysDelta 1000 * 1 cpu * 100 = 10%.
	if st.CPUPercent != 10 {
		t.Errorf("CPUPercent = %v; want 10", st.CPUPercent)
	}
}

// TestProjectStats proves only running containers are sampled.
func TestProjectStats(t *testing.T) {
	c := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/json"):
			writeJSON(w, []map[string]any{
				{"Id": "run1", "State": "running", "Labels": map[string]string{labelProject: "blog"}},
				{"Id": "dead1", "State": "exited", "Labels": map[string]string{labelProject: "blog"}},
			})
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/stats"):
			writePullStream(w, []map[string]any{
				statsFrame(100, 0, 1000, 0, 0, 0, 0),
				statsFrame(200, 100, 2000, 1000, 500, 0, 2048),
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	stats, err := c.ProjectStats(t.Context(), "blog")
	if err != nil {
		t.Fatalf("ProjectStats err: %v", err)
	}
	if len(stats) != 1 || stats[0].ID != "run1" {
		t.Errorf("ProjectStats = %+v; want just the running container run1", stats)
	}
}
