package calc

import "testing"

func TestSum(t *testing.T) {
	cases := []struct {
		in   []int
		want int
	}{
		{[]int{1, 2, 3}, 6},
		{[]int{}, 0},
		{[]int{5}, 5},
	}
	for _, c := range cases {
		if got := Sum(c.in); got != c.want {
			t.Fatalf("Sum(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}
