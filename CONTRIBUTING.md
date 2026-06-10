# Contributing

Thanks for improving Inferoa. This project is a TypeScript/Node CLI and targets
Node.js 24 or newer.

## Source Setup

```bash
npm install
npm run build
make dev-bin
inferoa setup
inferoa
```

`make dev-bin` builds the project and links the local `inferoa` binary for
interactive development. Use `make dev-unlink` to remove the global link when
you want to fall back to the published `inferoa` package.

## Development Commands

```bash
npm test            # TypeScript build and Node test suite
npm run check       # TypeScript type-check without output files
make dev-bin        # Build and link the local CLI
make docs-preview   # Local Docusaurus dev server
make docs-build     # Production docs build (validates links)
make dev-unlink     # Remove the local `inferoa` global link
```

Run `npm test` before sending changes. It runs the TypeScript build and the
Node test suite. Use `npm run check` for a quick type-check without producing
output files.

## Project Layout

The repository is organized so the public surface stays in `src/` and the
documentation surface stays under `docs/` and `website/docs/`.

```text
src/                  TypeScript source. CLI, runtime, TUI, tools, models, daemon, …
test/                 Node `--test` test suite (built to dist/test by `npm test`)
docs/                 Internal design notes (roadmap, TUI product design,
                      vLLM-Omni validation, public-source hygiene)
website/              Docusaurus site that publishes the public docs
website/docs/         Public docs, sidebar-registered
website/blog/         Docusaurus blog posts
website/static/       Static assets (images, gifs, json) served at /img/, /gif/, /data/
website/src/pages/    Custom pages (index, etc.) and the WebGL hero
```

The `docs/` folder is internal — it is not published to the docs site. Use it
for design notes, runbooks, and validation records. Anything that should be
public belongs under `website/docs/` so it is registered in
[`website/sidebars.ts`](website/sidebars.ts).

## Documentation Site

The website lives under `website/`. It is a Docusaurus v3 site with the
`@docusaurus/theme-mermaid` plugin enabled, so the `mermaid` fenced blocks
across the docs render as diagrams.

```bash
make docs-preview    # Local docs server with hot reload
make docs-build      # Production build (validates links)
```

`make docs-preview` starts the local docs server. `make docs-build` validates
the production build, including markdown and image link integrity.

### Adding A Doc Page

1. Pick the right category in `website/docs/`. New pages go alongside the
   existing files in `concepts/`, `configuration/`, `workflows/`,
   `operations/`, or `reference/`. Use `getting-started/` for onboarding
   material and `intro.md`, `architecture.md`, or `quickstart.md` only when
   rewriting the existing entry points.
2. Add the page id to the matching category in
   [`website/sidebars.ts`](website/sidebars.ts). Docusaurus resolves the id to
   the file by stripping the `.md` extension; the directory is implicit.
3. Cross-link from at least one other page so the new page is reachable from
   the documentation map. The `intro.md` "Documentation Map" section is the
   canonical entry point.
4. Run `make docs-build` before sending the change. It validates internal
   markdown links, the sidebar, and image references.

### Internal Design Notes

Design notes, runbooks, and validation records live under `docs/`. They are
not registered with the docs site and they are not part of the npm package.
Examples:

- `docs/roadmap.md` — T0–T10 product milestones and the post-T10 backlog.
- `docs/tui-product-design.md` — TUI visual language, scenes, animations.
- `docs/omni-endpoint-adaptation.md` — how vLLM-Omni capabilities are wired
  as tool calls.
- `docs/omni-real-endpoint-validation.md` — real-endpoint validation matrix.
- `docs/final-acceptance-task.md` — the real-endpoint acceptance contract.
- `docs/public-source-hygiene.md` — guardrails for what the public site may
  reference.

## Slash Command Registry

The TUI slash command registry is the source of truth for in-product command
names. It lives in [`src/tui/slash.ts`](src/tui/slash.ts) as
`SLASH_COMMANDS`, `SLASH_SUBCOMMANDS`, and `COMMAND_ALIASES`. When you add or
rename a command, update:

- `src/tui/slash.ts` (registry and aliases)
- `src/tui/app.ts` (`openView` switch and any subcommand handlers)
- `src/cli.ts` `printHelp` (TUI command list shown by `--help`)
- [`website/docs/reference/slash-commands.md`](website/docs/reference/slash-commands.md)

The runtime config defaults are defined in
[`src/config/defaults.ts`](src/config/defaults.ts) and merged from
[`src/config/config.ts`](src/config/config.ts). Update the
[Configuration reference](website/docs/reference/configuration.md) whenever
the defaults, schema, or environment overrides change.

## Publishing

Publishing is automated from `main`. After `package.json` is bumped, the GitHub
workflow builds, tests, packs, and publishes `inferoa@latest` to npm.

For npm publishing, configure one of:

- `NPM_TOKEN` repository secret using an npm automation token.
- npm Trusted Publishing for package `inferoa`, owner `agentic-in`, repository
  `inferoa`, workflow filename `npm-publish.yml`.

If the npm account has two-factor authentication enabled, the token must be an
automation token or a granular token with publish permission and 2FA bypass.

## License

By contributing, you agree that your contributions are licensed under the
Apache License, Version 2.0.
