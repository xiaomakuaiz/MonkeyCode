package shop

import "testing"

func TestCartTotal(t *testing.T) {
	if got := CartTotal([]string{"apple", "banana"}); got != 370 {
		t.Fatalf("CartTotal = %d, want 370", got)
	}
}
