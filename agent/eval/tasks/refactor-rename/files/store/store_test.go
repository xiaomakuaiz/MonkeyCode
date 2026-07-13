package store

import "testing"

func TestGet(t *testing.T) {
	if v, err := Fetch("a"); err != nil || v != "1" {
		t.Fatalf("got %q, %v", v, err)
	}
	if _, err := Fetch("missing"); err != ErrNotFound {
		t.Fatalf("err = %v", err)
	}
}
