package store

import "errors"

var data = map[string]string{"a": "1", "b": "2"}

// ErrNotFound 键不存在。
var ErrNotFound = errors.New("not found")

// Fetch 按键读取存储的值。
func Fetch(key string) (string, error) {
	v, ok := data[key]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}
