# Internal Design Notes

This directory holds design notes, runbooks, and validation records that are
**not published** to the public docs site at <https://inferoa.agentic-in.ai>.
They are included in the npm package for reference during development.

## Index

| File | Description |
| --- | --- |
| [`roadmap.md`](roadmap.md) | T0–T10 product milestones and the post-T10 backlog. |
| [`tui-product-design.md`](tui-product-design.md) | TUI visual language, scenes, animations, and brand direction. |
| [`omni-endpoint-adaptation.md`](omni-endpoint-adaptation.md) | How vLLM-Omni capabilities are wired as endpoint-backed tools. |
| [`omni-real-endpoint-validation.md`](omni-real-endpoint-validation.md) | Real-endpoint validation matrix and smoke-test protocol. |
| [`final-acceptance-task.md`](final-acceptance-task.md) | Real-endpoint acceptance contract for end-to-end validation. |
| [`public-source-hygiene.md`](public-source-hygiene.md) | Guardrails for what public materials may reference. |

## When To Add A Note Here

- The content describes implementation rationale, not user-facing documentation.
- The audience is Inferoa contributors and maintainers.
- The content would clutter the public docs site or is not ready for public
  release.

Anything that should be user-facing belongs under
[`website/docs/`](../website/docs/) and must be registered in
[`website/sidebars.ts`](../website/sidebars.ts).
