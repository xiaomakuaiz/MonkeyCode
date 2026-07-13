BINARY := mc-agent
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build test vet install cross clean

build:
	CGO_ENABLED=0 go build -trimpath -o bin/$(BINARY) ./cmd/mc-agent

test:
	go test ./...

vet:
	go vet ./...

install: build
	mkdir -p $(INSTALL_DIR)
	cp bin/$(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "已安装到 $(INSTALL_DIR)/$(BINARY),请确保该目录在 PATH 中"

cross:
	@for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do \
		GOOS=$${target%/*} GOARCH=$${target#*/} CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w" \
		-o dist/$(BINARY)-$${target%/*}-$${target#*/}$$( [ $${target%/*} = windows ] && echo .exe ) ./cmd/mc-agent; \
		echo "built dist/$(BINARY)-$${target%/*}-$${target#*/}"; \
	done

clean:
	rm -rf bin dist
