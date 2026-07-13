package main

import (
	"fmt"

	"app/store"
)

func main() {
	// Fetch 读取键 a
	v, err := store.Fetch("a")
	if err != nil {
		panic(err)
	}
	fmt.Println(v)
}
