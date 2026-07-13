package counter

import (
	"sync"
	"testing"
)

func TestConcurrentInc(t *testing.T) {
	var c Counter
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Inc() }()
	}
	wg.Wait()
	if c.Value() != 100 {
		t.Fatalf("Value = %d, want 100", c.Value())
	}
}
