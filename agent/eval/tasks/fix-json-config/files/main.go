package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type Config struct {
	Port    int  `json:"port"`
	Debug   bool `json:"debug"`
	Workers int  `json:"workers"`
}

func main() {
	data, err := os.ReadFile("config.json")
	if err != nil {
		panic(err)
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		fmt.Println("配置解析失败:", err)
		os.Exit(1)
	}
	fmt.Printf("port=%d debug=%t workers=%d\n", c.Port, c.Debug, c.Workers)
}
