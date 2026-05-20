# Figma extension for pi

This is a native pi extension for Figma-driven frontend work.

Pi does not support MCP natively, so this extension provides the core Figma-to-code workflow directly through a custom tool backed by the Figma REST API.

## What it adds

- `figma_get_design_context` tool
  - accepts a Figma URL or `fileKey` + `nodeId`
  - fetches structured node/layout/typography/color context
  - optionally attaches a rendered preview image for frame/node URLs
- `/figma-status` command

## Setup

Create a Figma personal access token, then export it before starting pi:

```bash
export FIGMA_API_KEY=your_figma_personal_access_token
pi
```

If pi is already open, run:

```text
/reload
```

## Suggested prompts

- `Implement this Figma frame in the current app: <figma-url>`
- `Use this Figma design as reference and rebuild the landing page: <figma-url>`
- `Inspect this Figma frame and explain the layout system: <figma-url>`

## Notes

- Best results come from frame/node URLs, not whole-file URLs.
- The tool is optimized for implementation context, not full file export.
- This is a first-pass read/preview integration. It does not write back to the Figma canvas.
