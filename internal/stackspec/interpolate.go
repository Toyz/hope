package stackspec

import "maps"

import "strings"

// interpolate performs compose-style ${VAR} substitution over the raw compose
// text before parsing. Supported forms: $VAR, ${VAR}, ${VAR:-default} (default
// when unset or empty), ${VAR-default} (default when unset), and $$ as a literal
// $. Unknown variables expand to empty (compose behaviour), which keeps a paste
// from failing outright when a value is only used at runtime.
func interpolate(text string, vars map[string]string) string {
	var b strings.Builder
	b.Grow(len(text))
	for i := 0; i < len(text); {
		c := text[i]
		if c != '$' {
			b.WriteByte(c)
			i++
			continue
		}
		if i+1 >= len(text) {
			b.WriteByte(c)
			break
		}
		next := text[i+1]
		if next == '$' { // $$ -> literal $
			b.WriteByte('$')
			i += 2
			continue
		}
		if next == '{' {
			end := strings.IndexByte(text[i+2:], '}')
			if end < 0 { // unterminated — emit verbatim
				b.WriteByte(c)
				i++
				continue
			}
			expr := text[i+2 : i+2+end]
			b.WriteString(expandBraced(expr, vars))
			i += 2 + end + 1
			continue
		}
		if isNameStart(next) {
			j := i + 1
			for j < len(text) && isNameChar(text[j]) {
				j++
			}
			name := text[i+1 : j]
			b.WriteString(vars[name])
			i = j
			continue
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

// expandBraced resolves the inside of a ${...} expression.
func expandBraced(expr string, vars map[string]string) string {
	// ${VAR:?err} / ${VAR?err} — required; we don't hard-fail a paste, so the
	// value (or empty) is used and the error text is ignored.
	if name, _, ok := cut2(expr, ":?", "?"); ok {
		return vars[name]
	}
	// ${VAR:-default} — default when unset OR empty.
	if name, def, ok := cut1(expr, ":-"); ok {
		if v, present := vars[name]; present && v != "" {
			return v
		}
		return def
	}
	// ${VAR-default} — default when unset only.
	if name, def, ok := cut1(expr, "-"); ok {
		if v, present := vars[name]; present {
			return v
		}
		return def
	}
	return vars[expr]
}

// cut1 splits expr on sep once; ok is false if sep is absent.
func cut1(expr, sep string) (name, rest string, ok bool) {
	if before, after, ok := strings.Cut(expr, sep); ok {
		return before, after, true
	}
	return "", "", false
}

// cut2 tries sepA then sepB, returning the name before whichever matched.
func cut2(expr, sepA, sepB string) (name, rest string, ok bool) {
	if n, r, k := cut1(expr, sepA); k {
		return n, r, true
	}
	return cut1(expr, sepB)
}

func isNameStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isNameChar(c byte) bool {
	return isNameStart(c) || (c >= '0' && c <= '9')
}

// parseDotenv parses a .env text (KEY=value per line, # comments, blank lines).
// Surrounding single/double quotes on the value are stripped.
func parseDotenv(text string) map[string]string {
	out := map[string]string{}
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if len(v) >= 2 {
			if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
				v = v[1 : len(v)-1]
			}
		}
		if k != "" {
			out[k] = v
		}
	}
	return out
}

// mergeEnv layers env over base (env wins), returning a new map.
func mergeEnv(base, env map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(env))
	maps.Copy(out, base)
	maps.Copy(out, env)
	return out
}
