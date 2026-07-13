package counter

// Counter 并发计数器。
type Counter struct {
	n int
}

// Inc 自增。
func (c *Counter) Inc() { c.n++ }

// Value 当前值。
func (c *Counter) Value() int { return c.n }
