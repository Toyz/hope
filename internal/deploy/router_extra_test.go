package deploy

import (
	"reflect"
	"testing"
)

// parseKV turns "KEY=VALUE" lines into a map: blanks and #comments skipped,
// values split on the first '=', keys with an empty name dropped, nil when empty.
func TestParseKV(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want map[string]string
	}{
		{name: "empty -> nil", in: "", want: nil},
		{name: "only comments/blanks -> nil", in: "# a\n\n   \n#b", want: nil},
		{
			name: "trims key and value, keeps empty value",
			in:   "A=1\nB = 2 \n# comment\n\nC=",
			want: map[string]string{"A": "1", "B": "2", "C": ""},
		},
		{
			name: "no '=' or empty key are skipped",
			in:   "noequals\n=orphan\nK=v",
			want: map[string]string{"K": "v"},
		},
		{
			name: "only the first '=' splits",
			in:   "K = v = w",
			want: map[string]string{"K": "v = w"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseKV(tt.in); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseKV(%q) = %v; want %v", tt.in, got, tt.want)
			}
		})
	}
}
