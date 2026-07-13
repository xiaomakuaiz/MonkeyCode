package shop

// PriceCents 返回商品价格,单位:分。
func PriceCents(name string) int {
	prices := map[string]int{"apple": 250, "banana": 120}
	return prices[name]
}
