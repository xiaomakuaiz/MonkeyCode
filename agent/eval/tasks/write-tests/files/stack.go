package stack

import "errors"

// ErrEmpty 空栈。
var ErrEmpty = errors.New("stack is empty")

// Stack 后进先出栈。
type Stack[T any] struct{ items []T }

// Push 入栈。
func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

// Pop 出栈,空栈返回 ErrEmpty。
func (s *Stack[T]) Pop() (T, error) {
	var zero T
	if len(s.items) == 0 {
		return zero, ErrEmpty
	}
	v := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return v, nil
}

// Peek 查看栈顶,空栈返回 ErrEmpty。
func (s *Stack[T]) Peek() (T, error) {
	var zero T
	if len(s.items) == 0 {
		return zero, ErrEmpty
	}
	return s.items[len(s.items)-1], nil
}

// Len 元素数量。
func (s *Stack[T]) Len() int { return len(s.items) }
