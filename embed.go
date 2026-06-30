// Package hope embeds the built frontend so the binary can serve its own SPA.
// The embed lives at the module root because go:embed can only reach files in
// its own directory subtree, and the build output is frontend/dist.
package hope

import "embed"

// DistFS is the built frontend tree. The placeholder index.html is replaced
// by `npm run build` output in frontend/dist.
//
//go:embed all:frontend/dist
var DistFS embed.FS
