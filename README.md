# LinkMaker

[![Github Actions Status](https://github.com/Levi-coder07/JupyterExtension/workflows/Build/badge.svg)](https://github.com/Levi-coder07/JupyterExtension/actions/workflows/build.yml)

A JupyterLab extension.

This extension is composed of a Python package named `LinkMaker`
for the server extension and a NPM package named `LinkMaker`
for the frontend extension.

## Requirements

- JupyterLab >= 4.0.0
- An `OPENAI_API_KEY` environment variable on the Jupyter server for notebook
  relationship analysis.

## Markdown-to-output relationship analysis

Use **Analyze Markdown ↔ outputs** in the Notebook Inspector to analyze
references to rendered charts and HTML tables separately from Markdown-to-code
relationships. Chart outputs are captured from rendered SVG, canvas, or image
elements; tables are captured as HTML and text. Results are stored alongside the
existing code relationships in the same `.linkmaker.json` file under
`markdownOutputAnalyses`, without replacing `markdownAnalyses`. Set
`LINKMAKER_OPENAI_OUTPUT_MODEL` to select the output-analysis model; it defaults
to `LINKMAKER_OPENAI_MODEL`.

The output-analysis prompt asks the model to interpret chart axes, scales,
legends, and panels or table headers and rows before matching Markdown claims
and selecting a supporting region. It checks evidence and rectangle bounds
internally and returns a brief evidence explanation. Unreadable, contradictory,
or unlocalizable evidence should produce no link. This remains one model request.
Localization uses readable tick anchors to calibrate numeric ranges, then checks
actual mark boundaries. Single-value and narrow-range claims must not use whole
panel boxes; separated evidence uses multiple tight boxes. These are prompt
constraints, not a guarantee of geometrically accurate predictions.

New output links store `rectangles` (1–16 regions per relationship) with
`coordinateSystem: "normalized-top-left-1000-v1"`. Coordinates are integers
relative to the complete visual, with x increasing rightward and y downward.
`geometryDebug` retains raw model rectangles and available image capture dimensions.
Out-of-bounds boxes are rejected rather than interpreted as another coordinate
format. Old saved single-rectangle links retain their bottom-left interpretation
and are converted to top-left coordinates by the frontend when loaded.

HTML tables now use `tableCellIds` instead of model-generated rectangles.
The model receives physical cell IDs, text, header flags, and row/column spans.
The frontend measures selected DOM cells directly, including separated cells.
Saved table links include a content/structure snapshot and are suppressed when
that snapshot no longer matches; rerun analysis after changing table contents.
Images of tables still use the image bounding-box path. Refresh the browser and
restart the server together when updating this table-targeting contract.

## Markdown-to-code relationship analysis

Use the **Analyze notebook relationships** button in the Notebook Inspector to
send all Markdown and code cells to the configured LLM in one notebook-wide
request.
When available, code-cell execution text (prints, errors, and textual results,
including tables) is included as supporting context. The extractor
excludes standard Python warning messages from stderr and their displayed source
line; ordinary stderr diagnostics and execution errors are retained. Custom
warning formats may remain. This filtering only affects analysis context.
Plain-text representations
are preferred, with Markdown or HTML text as fallbacks. Output context is capped
at 20,000 characters per cell; cells without textual outputs use source alone.
Links still target code source, not output text. Restart the JupyterLab server
after updating the backend, then rerun analysis to regenerate existing links.
It writes a checkpointed relationship map beside the notebook as
`<notebook-name>.linkmaker.json`. The map contains exact Markdown and code
source portions, cell IDs, cell indices, metadata, confidence, and the model's
short explanation. Set `LINKMAKER_OPENAI_MODEL` on the Jupyter server to select
a different OpenAI model; the prototype defaults to `gpt-5-mini`. Returned
cell IDs and verbatim spans are validated against the submitted notebook before
relationships are saved.

## Two-column notebook layout

Each notebook header has a **Two-column layout** button. It changes the active
notebook itself: Markdown cells appear on the left and code cells with their
outputs appear on the right. Select **Default layout** to restore JupyterLab's
normal single-column notebook view. Click a colored Markdown portion to show
only its linked code cells and align the first linked cell with that portion's
rendered line.

## Install

To install the extension, execute:

```bash
pip install LinkMaker
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall LinkMaker
```

## Troubleshoot

If you are seeing the frontend extension, but it is not working, check
that the server extension is enabled:

```bash
jupyter server extension list
```

If the server extension is installed and enabled, but you are not seeing
the frontend extension, check the frontend extension is installed:

```bash
jupyter labextension list
```

## Contributing

If you would like to contribute to this extension, please refer to the [Contributing Guide](CONTRIBUTING.md).

## AI Coding Assistant Support

This project includes an `AGENTS.md` file with coding standards and best practices for JupyterLab extension development. The file follows the [AGENTS.md standard](https://agents.md) for cross-tool compatibility.

### Compatible AI Tools

`AGENTS.md` works with AI coding assistants that support the standard, including Cursor, GitHub Copilot, Windsurf, Aider, and others. For a current list of compatible tools, see [the AGENTS.md standard](https://agents.md).
This project also includes symlinks for tool-specific compatibility:

- `CLAUDE.md` → `AGENTS.md` (for Claude Code)

- `GEMINI.md` → `AGENTS.md` (for Gemini Code Assist)

Other conventions you might encounter:

- `.cursorrules` - Cursor's YAML/JSON format (Cursor also supports AGENTS.md natively)
- `CONVENTIONS.md` / `CONTRIBUTING.md` - For CodeConventions.ai and GitHub bots
- Project-specific rules in JetBrains AI Assistant settings

All tool-specific files should be symlinks to `AGENTS.md` as the single source of truth.

### What's Included

The `AGENTS.md` file provides guidance on:

- Code quality rules and file-scoped validation commands
- Naming conventions for packages, plugins, and files
- Coding standards (TypeScript, Python)
- Development workflow and debugging
- Backend-frontend integration patterns (`APIHandler`, `requestAPI()`, routing)
- Common pitfalls and how to avoid them

### Customization

You can edit `AGENTS.md` to add project-specific conventions or adjust guidelines to match your team's practices. The file uses plain Markdown with Do/Don't patterns and references to actual project files.

**Note**: `AGENTS.md` is living documentation. Update it when you change conventions, add dependencies, or discover new patterns. Include `AGENTS.md` updates in commits that modify workflows or coding standards.
