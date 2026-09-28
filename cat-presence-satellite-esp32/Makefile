# Prefer tools on PATH; PlatformIO and VS Code may install them outside PATH.
CLANG_FORMAT ?= $(or $(shell command -v clang-format 2>/dev/null),$(firstword $(wildcard $(HOME)/.vscode-server/extensions/ms-vscode.cpptools-*/LLVM/bin/clang-format $(HOME)/.cursor-server/extensions/ms-vscode.cpptools-*/LLVM/bin/clang-format)))
CPPCHECK ?= $(or $(shell command -v cppcheck 2>/dev/null),$(firstword $(wildcard $(HOME)/.platformio/packages/tool-cppcheck/cppcheck)))

SOURCES := src/main.cpp include/wifi_secrets.example.h

.PHONY: format format-check lint

format:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format is required (install it or set CLANG_FORMAT)" >&2; exit 1; }
	$(CLANG_FORMAT) -i $(SOURCES)

format-check:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format is required (install it or set CLANG_FORMAT)" >&2; exit 1; }
	$(CLANG_FORMAT) --dry-run --Werror $(SOURCES)

lint:
	@test -n "$(CPPCHECK)" || { echo "cppcheck is required (install it or set CPPCHECK)" >&2; exit 1; }
	$(CPPCHECK) --quiet --enable=warning,style,performance,portability --language=c++ --std=c++11 --error-exitcode=1 --suppress=missingIncludeSystem -Iinclude src/main.cpp
