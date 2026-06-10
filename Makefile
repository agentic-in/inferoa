.PHONY: build dev-bin dev-unlink test release-prep docs-preview docs-build docs-serve

build:
	npm run build
	chmod +x dist/src/cli.js

dev-bin: build
	npm link
	@echo "inferoa is linked. Run: inferoa"

dev-unlink:
	npm unlink -g inferoa

test:
	npm test

release-prep:
	@test -n "$(VERSION)" || (echo "Usage: make release-prep VERSION=0.11.0" >&2; exit 2)
	npm version "$(VERSION)" --no-git-tag-version --allow-same-version
	npm test
	GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v$(VERSION) GITHUB_RUN_NUMBER=0 GITHUB_SHA=$$(git rev-parse HEAD) node dist/src/release/npm-publish-coordinates.js
	GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_RUN_NUMBER=0 GITHUB_SHA=$$(git rev-parse HEAD) node dist/src/release/npm-publish-coordinates.js
	npm pack --dry-run

docs-preview:
	npm run site:start

docs-build:
	npm run site:build

docs-serve:
	npm run site:serve
