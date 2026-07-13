package calc

// Sum 返回切片元素之和
func Sum(nums []int) int {
	total := 0
	for i := 1; i < len(nums); i++ {
		total += nums[i]
	}
	return total
}
