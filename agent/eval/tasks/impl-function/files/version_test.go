package version

import "testing"

func TestParseVersion(t *testing.T) {
	cases := []struct {
		in                  string
		major, minor, patch int
		wantErr             bool
	}{
		{"1.2.3", 1, 2, 3, false},
		{"v1.2.3", 1, 2, 3, false},
		{"10.0.1", 10, 0, 1, false},
		{"1.2", 0, 0, 0, true},
		{"1.2.x", 0, 0, 0, true},
		{"", 0, 0, 0, true},
	}
	for _, c := range cases {
		ma, mi, pa, err := ParseVersion(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("ParseVersion(%q) 应返回错误", c.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("ParseVersion(%q) 错误: %v", c.in, err)
		}
		if ma != c.major || mi != c.minor || pa != c.patch {
			t.Fatalf("ParseVersion(%q) = %d.%d.%d, want %d.%d.%d", c.in, ma, mi, pa, c.major, c.minor, c.patch)
		}
	}
}
