package shop

// CartTotal 计算购物车总价,单位:分。
func CartTotal(items []string) int {
	total := 0
	for _, it := range items {
		// bug: 把"分"当成"元"又乘了 100
		total += PriceCents(it) * 100
	}
	return total
}
