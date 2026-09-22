"""HTTP routes for the LinkMaker server extension."""

from __future__ import annotations

import base64
import inspect
import json
import logging
import os
import posixpath
import re
from typing import Any

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from openai import AsyncOpenAI
import tornado
from tornado import web


LOGGER = logging.getLogger(__name__)

MEDIA_DIRECTORY_NAME = "linkmaker_media"
SUPPORTED_SOURCES = {"mime-bundle", "rendered-dom"}
MIME_EXTENSION_MAP = {
    "application/json": "json",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/html": "html",
    "text/plain": "txt",
}
RELATIONSHIP_FILE_SUFFIX = ".linkmaker.json"
RELATIONSHIP_MODEL = os.environ.get("LINKMAKER_OPENAI_MODEL", "gpt-5-mini")
OUTPUT_RELATIONSHIP_MODEL = os.environ.get(
    "LINKMAKER_OPENAI_OUTPUT_MODEL", RELATIONSHIP_MODEL
)
OUTPUT_RELATIONSHIP_REASONING_EFFORT = os.environ.get(
    "LINKMAKER_OPENAI_OUTPUT_REASONING_EFFORT", "medium"
)
OUTPUT_COMPONENT_TYPES = {
    "bar",
    "bar_group",
    "point",
    "point_group",
    "line",
    "line_segment",
    "legend_item",
    "axis",
    "axis_label",
    "title",
    "annotation",
    "plot_region",
    "table_region",
    "whole_output",
}

RELATIONSHIP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "relationships": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "markdownCellId": {"type": "string", "minLength": 1},
                    "markdownCellIndex": {"type": "integer", "minimum": 0},
                    "markdownText": {"type": "string", "minLength": 1},
                    "codeCellId": {"type": "string", "minLength": 1},
                    "codeCellIndex": {"type": "integer", "minimum": 0},
                    "codeScope": {"type": "string", "enum": ["excerpt", "whole_cell"]},
                    "codeText": {"type": "string", "minLength": 1},
                    "relationshipType": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "reason": {"type": "string"},
                },
                "required": [
                    "markdownCellId",
                    "markdownCellIndex",
                    "markdownText",
                    "codeCellId",
                    "codeCellIndex",
                    "codeScope",
                    "codeText",
                    "relationshipType",
                    "confidence",
                    "reason",
                ],
            },
        }
    },
    "required": ["relationships"],
}

OUTPUT_RELATIONSHIP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "relationships": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "markdownCellId": {"type": "string", "minLength": 1},
                    "markdownCellIndex": {"type": "integer", "minimum": 0},
                    "markdownText": {"type": "string", "minLength": 1},
                    "outputId": {"type": "string", "minLength": 1},
                    "outputCellId": {"type": "string", "minLength": 1},
                    "outputCellIndex": {"type": "integer", "minimum": 0},
                    "outputIndex": {"type": "integer", "minimum": 0},
                    "componentDescription": {"type": "string", "minLength": 1},
                    "componentType": {
                        "type": "string",
                        "enum": [
                            "bar",
                            "bar_group",
                            "point",
                            "point_group",
                            "line",
                            "line_segment",
                            "legend_item",
                            "axis",
                            "axis_label",
                            "title",
                            "annotation",
                            "plot_region",
                            "table_region",
                            "whole_output",
                        ],
                    },
                    "rectangle": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "x": {"type": "integer", "minimum": 0, "maximum": 10000},
                            "y": {"type": "integer", "minimum": 0, "maximum": 10000},
                            "width": {"type": "integer", "minimum": 1, "maximum": 10000},
                            "height": {"type": "integer", "minimum": 1, "maximum": 10000},
                        },
                        "required": ["x", "y", "width", "height"],
                    },
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "reason": {"type": "string", "minLength": 1},
                },
                "required": [
                    "markdownCellId",
                    "markdownCellIndex",
                    "markdownText",
                    "outputId",
                    "outputCellId",
                    "outputCellIndex",
                    "outputIndex",
                    "componentDescription",
                    "componentType",
                    "rectangle",
                    "confidence",
                    "reason",
                ],
            },
        }
    },
    "required": ["relationships"],
}


class HelloRouteHandler(APIHandler):
    """Basic health-check route for the extension."""

    @tornado.web.authenticated
    def get(self) -> None:
        """Return a small hello payload."""
        self.finish(
            json.dumps(
                {
                    "data": (
                        "Hello, world!"
                        " This is the '/LinkMaker/hello' endpoint."
                        " Try visiting me in your browser!"
                    ),
                }
            )
        )


class SaveMediaRouteHandler(APIHandler):
    """Persist media captured from notebook outputs."""

    @tornado.web.authenticated
    async def post(self) -> None:
        """Save a media payload next to the source notebook."""
        body = self.get_json_body()
        if not isinstance(body, dict):
            raise web.HTTPError(400, "Request body must be a JSON object.")

        notebook_path = _require_string(body, "notebookPath")
        mime_type = _require_string(body, "mimeType")
        raw_data = _require_string(body, "rawData")
        source = _require_string(body, "source")
        if source not in SUPPORTED_SOURCES:
            raise web.HTTPError(400, f"Unsupported media source: {source}")

        cell_index = _require_nonnegative_int(body, "cellIndex")
        media_index = _require_nonnegative_int(body, "mediaIndex")
        output_index = _optional_nonnegative_int(body.get("outputIndex"), "outputIndex")

        media_directory = await _ensure_media_directory(self.contents_manager, notebook_path)
        filename = _build_filename(
            notebook_path=notebook_path,
            mime_type=mime_type,
            cell_index=cell_index,
            output_index=output_index,
            media_index=media_index,
        )
        filename = await _await_if_needed(
            self.contents_manager.increment_filename(filename, path=media_directory)
        )
        target_path = posixpath.join(media_directory, filename)

        model = _build_file_model(mime_type, raw_data)
        await _await_if_needed(self.contents_manager.save(model, target_path))

        self.finish(
            {
                "directory": media_directory,
                "filename": filename,
                "path": target_path,
                "status": "success",
            }
        )


class AnalyzeNotebookRouteHandler(APIHandler):
    """Analyze all Markdown-to-code relationships in a supplied notebook."""

    @tornado.web.authenticated
    async def post(self) -> None:
        """Write a checkpointed relationship map beside the notebook."""
        if not os.environ.get("OPENAI_API_KEY"):
            raise web.HTTPError(
                503, "OPENAI_API_KEY is not configured on the Jupyter server."
            )

        body = self.get_json_body()
        if not isinstance(body, dict):
            raise web.HTTPError(400, "Request body must be a JSON object.")

        notebook_path = _require_string(body, "notebookPath")
        notebook = body.get("notebook")
        if not isinstance(notebook, dict):
            raise web.HTTPError(400, "'notebook' must be a notebook JSON object.")

        markdown_cells, code_cells = _extract_notebook_cells(notebook)
        relationship_path = _relationship_file_path(notebook_path)
        result: dict[str, Any] = {
            "version": 1,
            "notebookPath": notebook_path,
            "model": RELATIONSHIP_MODEL,
            "markdownAnalyses": [],
            "failures": [],
        }
        saved_model = await _save_relationship_file(
            self.contents_manager, relationship_path, result
        )
        client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

        try:
            try:
                result["markdownAnalyses"] = await _analyze_notebook_relationships(
                    client, markdown_cells, code_cells
                )
            except Exception as error:  # noqa: BLE001
                self.log.warning("LinkMaker notebook analysis failed: %s", error)
                result["failures"] = [
                    {
                        "markdownCellIndex": markdown_cell["index"],
                        "message": str(error),
                    }
                    for markdown_cell in markdown_cells
                ]
            saved_model = await _save_relationship_file(
                self.contents_manager, relationship_path, result
            )
        finally:
            await client.close()

        completed = len(result["markdownAnalyses"])
        failures = len(result["failures"])
        self.finish(
            {
                "completedMarkdownCells": completed,
                "failedMarkdownCells": failures,
                "path": _saved_model_path(saved_model, relationship_path),
                "status": "success" if failures == 0 else "partial",
            }
        )


class AnalyzeOutputRouteHandler(APIHandler):
    """Analyze Markdown references to rendered chart and table outputs."""

    @tornado.web.authenticated
    async def post(self) -> None:
        if not os.environ.get("OPENAI_API_KEY"):
            raise web.HTTPError(
                503, "OPENAI_API_KEY is not configured on the Jupyter server."
            )

        body = self.get_json_body()
        if not isinstance(body, dict):
            raise web.HTTPError(400, "Request body must be a JSON object.")
        notebook_path = _require_string(body, "notebookPath")
        notebook = body.get("notebook")
        output_artifacts = body.get("outputArtifacts")
        if not isinstance(notebook, dict):
            raise web.HTTPError(400, "'notebook' must be a notebook JSON object.")
        if not isinstance(output_artifacts, list):
            raise web.HTTPError(400, "'outputArtifacts' must be an array.")

        markdown_cells, _ = _extract_notebook_cells(notebook)
        artifacts = _validate_output_artifacts(output_artifacts)
        relationship_path = _relationship_file_path(notebook_path)
        result = await _load_relationship_file(self.contents_manager, relationship_path)
        result["version"] = max(result.get("version", 1), 2)
        result["notebookPath"] = notebook_path
        result["outputModel"] = OUTPUT_RELATIONSHIP_MODEL
        result["markdownOutputAnalyses"] = []
        result["outputFailures"] = []
        saved_model = await _save_relationship_file(
            self.contents_manager, relationship_path, result
        )

        client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        try:
            try:
                result["markdownOutputAnalyses"] = await _analyze_output_relationships(
                    client, markdown_cells, artifacts
                )
            except Exception as error:  # noqa: BLE001
                self.log.warning("LinkMaker output analysis failed: %s", error)
                result["outputFailures"] = [
                    {
                        "markdownCellIndex": markdown_cell["index"],
                        "message": str(error),
                    }
                    for markdown_cell in markdown_cells
                ]
            saved_model = await _save_relationship_file(
                self.contents_manager, relationship_path, result
            )
        finally:
            await client.close()

        failures = len(result["outputFailures"])
        self.finish(
            {
                "completedMarkdownCells": len(result["markdownOutputAnalyses"]),
                "failedMarkdownCells": failures,
                "path": _saved_model_path(saved_model, relationship_path),
                "status": "success" if failures == 0 else "partial",
            }
        )


def setup_route_handlers(web_app: Any) -> None:
    """Register the server extension route handlers."""
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    hello_route_pattern = url_path_join(base_url, "LinkMaker", "hello")
    save_media_route_pattern = url_path_join(base_url, "LinkMaker", "save-media")
    analyze_notebook_route_pattern = url_path_join(
        base_url, "LinkMaker", "analyze-notebook"
    )
    analyze_output_route_pattern = url_path_join(base_url, "LinkMaker", "analyze-outputs")
    handlers = [
        (hello_route_pattern, HelloRouteHandler),
        (save_media_route_pattern, SaveMediaRouteHandler),
        (analyze_notebook_route_pattern, AnalyzeNotebookRouteHandler),
        (analyze_output_route_pattern, AnalyzeOutputRouteHandler),
    ]

    web_app.add_handlers(host_pattern, handlers)


def _require_string(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise web.HTTPError(400, f"'{key}' must be a non-empty string.")
    return value


def _require_nonnegative_int(body: dict[str, Any], key: str) -> int:
    value = body.get(key)
    if not isinstance(value, int) or value < 0:
        raise web.HTTPError(400, f"'{key}' must be a non-negative integer.")
    return value


def _optional_nonnegative_int(value: Any, key: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or value < 0:
        raise web.HTTPError(400, f"'{key}' must be null or a non-negative integer.")
    return value


async def _ensure_media_directory(contents_manager: Any, notebook_path: str) -> str:
    notebook_directory = posixpath.dirname(notebook_path.strip("/"))
    media_directory = posixpath.join(notebook_directory, MEDIA_DIRECTORY_NAME)

    if not await _await_if_needed(contents_manager.dir_exists(media_directory)):
        await _await_if_needed(contents_manager.save({"type": "directory"}, media_directory))

    return media_directory


def _build_filename(
    notebook_path: str,
    mime_type: str,
    cell_index: int,
    output_index: int | None,
    media_index: int,
) -> str:
    notebook_name = posixpath.basename(notebook_path)
    notebook_stem = notebook_name.rsplit(".", 1)[0]
    safe_stem = _slugify(notebook_stem) or "notebook"

    filename = f"{safe_stem}-cell-{cell_index + 1:03d}"
    if output_index is not None:
        filename += f"-output-{output_index + 1:03d}"
    filename += f"-media-{media_index + 1:03d}"

    extension = MIME_EXTENSION_MAP.get(mime_type, _mime_to_extension(mime_type))
    return f"{filename}.{extension}"


def _build_file_model(mime_type: str, raw_data: str) -> dict[str, str]:
    if mime_type in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
        return {
            "content": _extract_base64_payload(raw_data),
            "format": "base64",
            "type": "file",
        }

    if mime_type == "application/json":
        json_text = _normalize_json_text(raw_data)
        return {"content": json_text, "format": "text", "type": "file"}

    return {"content": raw_data, "format": "text", "type": "file"}


def _extract_base64_payload(raw_data: str) -> str:
    if raw_data.startswith("data:"):
        _, _, payload = raw_data.partition(",")
        if not payload:
            raise web.HTTPError(400, "Media data URL is missing its payload.")
        return payload

    try:
        base64.b64decode(raw_data, validate=True)
    except Exception as error:  # noqa: BLE001
        raise web.HTTPError(400, "Image payload is not valid base64 data.") from error

    return raw_data


def _normalize_json_text(raw_data: str) -> str:
    try:
        return json.dumps(json.loads(raw_data), indent=2, ensure_ascii=True)
    except json.JSONDecodeError:
        return raw_data


def _mime_to_extension(mime_type: str) -> str:
    subtype = mime_type.split("/")[-1]
    return _slugify(subtype) or "txt"


def _slugify(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-_").lower()


def _extract_notebook_cells(
    notebook: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cells = notebook.get("cells")
    if not isinstance(cells, list):
        raise web.HTTPError(400, "'notebook.cells' must be an array.")

    markdown_cells: list[dict[str, Any]] = []
    code_cells: list[dict[str, Any]] = []
    used_cell_ids: set[str] = set()
    for index, raw_cell in enumerate(cells):
        if not isinstance(raw_cell, dict):
            continue
        cell_type = raw_cell.get("cell_type")
        if cell_type not in {"markdown", "code"}:
            continue
        source = _normalize_source(raw_cell.get("source"))
        raw_cell_id = raw_cell.get("id")
        cell_id = raw_cell_id if isinstance(raw_cell_id, str) and raw_cell_id else ""
        if not cell_id or cell_id in used_cell_ids:
            cell_id = f"cell-{index}"
        suffix = 1
        while cell_id in used_cell_ids:
            cell_id = f"cell-{index}-{suffix}"
            suffix += 1
        used_cell_ids.add(cell_id)
        cell = {
            "id": cell_id,
            "index": index,
            "metadata": (
                raw_cell.get("metadata")
                if isinstance(raw_cell.get("metadata"), dict)
                else {}
            ),
            "source": source,
        }
        if cell_type == "markdown":
            markdown_cells.append(cell)
        else:
            code_cells.append(cell)
    return markdown_cells, code_cells


async def _analyze_notebook_relationships(
    client: AsyncOpenAI,
    markdown_cells: list[dict[str, Any]],
    code_cells: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Find notebook-wide relationships in one model request."""
    if not markdown_cells or not code_cells:
        return [
            {"markdownCell": _cell_reference(cell), "relationships": []}
            for cell in markdown_cells
        ]

    prompt = _build_relationship_prompt(markdown_cells, code_cells)
    response = await client.responses.create(
        model=RELATIONSHIP_MODEL,
        input=prompt,
        reasoning={"effort": "low"},
        text={
            "format": {
                "type": "json_schema",
                "name": "notebook_relationships",
                "schema": RELATIONSHIP_SCHEMA,
                "strict": True,
            }
        },
    )

    if getattr(response, "status", None) not in {None, "completed"}:
        status = getattr(response, "status", "unknown")
        raise ValueError(f"The LLM response did not complete successfully: {status}")

    payload = _extract_payload_from_response(response)
    if not isinstance(payload, dict):
        raise ValueError("The LLM response did not return a JSON object.")

    relationships = payload.get("relationships")
    if not isinstance(relationships, list):
        raise ValueError("The LLM response does not contain a relationships list.")
    return _materialize_notebook_relationships(
        markdown_cells, code_cells, relationships
    )


async def _analyze_markdown_cell(
    client: AsyncOpenAI,
    markdown_cell: dict[str, Any],
    code_cells: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Retain the previous helper contract for existing evaluation callers."""
    analyses = await _analyze_notebook_relationships(
        client, [markdown_cell], code_cells
    )
    return analyses[0]["relationships"] if analyses else []


async def _analyze_output_relationships(
    client: AsyncOpenAI,
    markdown_cells: list[dict[str, Any]],
    output_artifacts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Find Markdown references to captured chart and table outputs."""
    if not markdown_cells or not output_artifacts:
        return [
            {"markdownCell": _cell_reference(cell), "relationships": []}
            for cell in markdown_cells
        ]

    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": _build_output_relationship_prompt(markdown_cells, output_artifacts),
        }
    ]
    for artifact in output_artifacts:
        if artifact["kind"] == "image":
            content.append(
                {
                    "type": "input_text",
                    "text": f"OUTPUT ARTIFACT {artifact['outputId']} (chart/image)",
                }
            )
            content.append(
                {
                    "type": "input_image",
                    "image_url": artifact["content"],
                    "detail": "high",
                }
            )
            continue

        content.append(
            {
                "type": "input_text",
                "text": f"OUTPUT ARTIFACT {artifact['outputId']} (HTML table file)",
            }
        )
        encoded_html = base64.b64encode(
            artifact["content"].encode("utf-8")
        ).decode("ascii")
        content.append(
            {
                "type": "input_file",
                "filename": f"{artifact['outputId']}.html",
                "file_data": f"data:text/html;base64,{encoded_html}",
            }
        )

    response = await client.responses.create(
        model=OUTPUT_RELATIONSHIP_MODEL,
        input=[{"role": "user", "content": content}],
        reasoning={"effort": "low"},
        text={
            "format": {
                "type": "json_schema",
                "name": "notebook_output_relationships",
                "schema": OUTPUT_RELATIONSHIP_SCHEMA,
                "strict": True,
            }
        },
    )
    if getattr(response, "status", None) not in {None, "completed"}:
        raise ValueError(
            f"The output relationship model did not complete successfully: "
            f"{getattr(response, 'status', 'unknown')}"
        )
    payload = _extract_payload_from_response(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("relationships"), list):
        raise ValueError("The output relationship model did not return relationships.")
    return _materialize_output_relationships(
        markdown_cells,
        output_artifacts,
        payload["relationships"],
    )


def _build_output_relationship_prompt(
    markdown_cells: list[dict[str, Any]], output_artifacts: list[dict[str, Any]]
) -> str:
    """Build a grounded multimodal request without broad topical matches."""
    table_artifacts = [
        {
            "outputId": artifact["outputId"],
            "cellId": artifact["cellId"],
            "cellIndex": artifact["cellIndex"],
            "outputIndex": artifact["outputIndex"],
            "text": artifact.get("text", ""),
        }
        for artifact in output_artifacts
        if artifact["kind"] == "table"
    ]
    image_artifacts = [
        {
            "outputId": artifact["outputId"],
            "cellId": artifact["cellId"],
            "cellIndex": artifact["cellIndex"],
            "outputIndex": artifact["outputIndex"],
            "imageWidth": artifact.get("imageWidth", 1000),
            "imageHeight": artifact.get("imageHeight", 1000),
        }
        for artifact in output_artifacts
        if artifact["kind"] == "image"
    ]
    return (
        "Find explicit relationships between Markdown text and visible evidence in the "
        "supplied chart or table outputs. Link only claims that directly describe, "
        "interpret, compare, or conclude from visible evidence; shared topic alone is "
        "insufficient.\n\n"
        "For each relationship, return the smallest exact Markdown span, exact output "
        "identity, and smallest visible component that supports the claim. Use a tight "
        "rectangle around the relevant bar, mark, group, line segment, label, annotation, or "
        "table region. Exclude unrelated marks, labels, legends, whitespace, and panels. "
        "Coordinates are source-image pixels. Measure x from the left edge and y from the "
        "bottom edge of the complete supplied image. Width and height are pixel sizes. Use "
        "the supplied imageWidth and imageHeight. Ensure the rectangle overlaps the "
        "described visual component. For table outputs, use the same bottom-left convention "
        "in a 0-to-1000 coordinate space.\n\n"
        "Use componentType=whole_output with rectangle 0,0,imageWidth,imageHeight for an "
        "image, or 0,0,1000,1000 for a table, only when the entire "
        "output is necessary evidence. If the claim refers to a specific visible "
        "component, category, bar, value, range, or series, localize that component instead. "
        "The component type, description, reason, and rectangle must describe the same "
        "visual scope. Return no relationship when the evidence cannot be identified. "
        "Do not return duplicates.\n\n"
        f"MARKDOWN CELLS\n{json.dumps([_prompt_cell(cell) for cell in markdown_cells], ensure_ascii=False)}\n\n"
        f"IMAGE OUTPUT METADATA\n{json.dumps(image_artifacts, ensure_ascii=False)}\n\n"
        f"TABLE OUTPUTS\n{json.dumps(table_artifacts, ensure_ascii=False)}"
    )


def _validate_output_artifacts(value: list[Any]) -> list[dict[str, Any]]:
    """Accept bounded frontend captures and discard malformed artifacts."""
    artifacts: list[dict[str, Any]] = []
    for item in value[:40]:
        if not isinstance(item, dict):
            continue
        required_strings = ("outputId", "cellId", "kind", "mimeType", "content")
        if any(not isinstance(item.get(key), str) or not item[key] for key in required_strings):
            continue
        if item["kind"] not in {"image", "table"}:
            continue
        if not all(
            isinstance(item.get(key), int) and item[key] >= 0
            for key in ("cellIndex", "outputIndex")
        ):
            continue
        content = item["content"]
        if len(content.encode("utf-8")) > 4_000_000:
            continue
        artifact = {
            "outputId": item["outputId"],
            "cellId": item["cellId"],
            "cellIndex": item["cellIndex"],
            "outputIndex": item["outputIndex"],
            "kind": item["kind"],
            "mimeType": item["mimeType"],
            "content": content,
        }
        if item["kind"] == "image":
            image_width = item.get("imageWidth")
            image_height = item.get("imageHeight")
            if (
                isinstance(image_width, int)
                and not isinstance(image_width, bool)
                and image_width > 0
                and isinstance(image_height, int)
                and not isinstance(image_height, bool)
                and image_height > 0
            ):
                artifact["imageWidth"] = image_width
                artifact["imageHeight"] = image_height
        if isinstance(item.get("text"), str):
            artifact["text"] = item["text"][:20_000]
        artifacts.append(artifact)
    return artifacts


def _materialize_output_relationships(
    markdown_cells: list[dict[str, Any]],
    output_artifacts: list[dict[str, Any]],
    relationships: list[Any],
) -> list[dict[str, Any]]:
    """Validate Markdown spans and immutable output identities from the model."""
    markdown_by_id = {cell["id"]: cell for cell in markdown_cells}
    artifact_by_id = {artifact["outputId"]: artifact for artifact in output_artifacts}
    grouped: dict[str, list[dict[str, Any]]] = {cell["id"]: [] for cell in markdown_cells}
    seen: set[tuple[str, int, int, str]] = set()
    for relationship_index, relationship in enumerate(relationships):
        if not isinstance(relationship, dict):
            _record_output_rejection(
                relationship_index,
                relationship,
                ["invalid_relationship_object"],
            )
            continue
        markdown_id = relationship.get("markdownCellId")
        output_id = relationship.get("outputId")
        if not isinstance(markdown_id, str) or not isinstance(output_id, str):
            _record_output_rejection(
                relationship_index,
                relationship,
                ["invalid_identifier_type"],
            )
            continue
        markdown_cell = markdown_by_id.get(markdown_id)
        artifact = artifact_by_id.get(output_id)
        identity_reasons = []
        if not markdown_cell:
            identity_reasons.append("unknown_markdown_cell")
        if not artifact:
            identity_reasons.append("unknown_output_artifact")
        if identity_reasons:
            _record_output_rejection(
                relationship_index,
                relationship,
                identity_reasons,
            )
            continue
        reference_reasons = []
        if relationship.get("markdownCellIndex") != markdown_cell["index"]:
            reference_reasons.append("markdown_index_mismatch")
        if reference_reasons:
            _record_output_rejection(
                relationship_index,
                relationship,
                reference_reasons,
            )
            continue
        _log_output_identity_correction(relationship_index, relationship, artifact)
        markdown_range = _find_output_markdown_range(
            markdown_cell["source"], relationship.get("markdownText")
        )
        confidence = relationship.get("confidence")
        reason = relationship.get("reason")
        component = relationship.get("componentDescription")
        component_type = relationship.get("componentType")
        rectangle = _normalize_output_rectangle(
            relationship.get("rectangle"), artifact
        )
        content_reasons = []
        if not markdown_range:
            content_reasons.append("markdown_text_not_found")
        if (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not 0 <= confidence <= 1
        ):
            content_reasons.append("invalid_confidence")
        if not isinstance(reason, str):
            content_reasons.append("invalid_reason")
        if not isinstance(component, str):
            content_reasons.append("invalid_component_description")
        if component_type not in OUTPUT_COMPONENT_TYPES:
            content_reasons.append("invalid_component_type")
        if not _is_normalized_rectangle(rectangle):
            content_reasons.append("invalid_rectangle")
        if content_reasons:
            _record_output_rejection(
                relationship_index,
                relationship,
                content_reasons,
            )
            continue
        key = (markdown_id, markdown_range[0], markdown_range[1], output_id)
        if key in seen:
            _record_output_rejection(
                relationship_index,
                relationship,
                ["duplicate_relationship"],
            )
            continue
        seen.add(key)
        grouped[markdown_id].append(
            {
                "markdownPortion": _portion(markdown_cell["source"], markdown_range),
                "outputTarget": {
                    "id": output_id,
                    "cellId": artifact["cellId"],
                    "cellIndex": artifact["cellIndex"],
                    "outputIndex": artifact["outputIndex"],
                    "kind": artifact["kind"],
                    "componentDescription": component,
                    "componentType": component_type,
                    "rectangle": rectangle,
                },
                "confidence": confidence,
                "reason": reason,
            }
        )
    return [
        {"markdownCell": _cell_reference(cell), "relationships": grouped[cell["id"]]}
        for cell in markdown_cells
    ]


def _record_output_rejection(
    relationship_index: int,
    relationship: Any,
    reasons: list[str],
) -> None:
    """Log why a model-produced output relationship was not persisted."""
    summary: dict[str, Any] = {
        "relationshipIndex": relationship_index,
        "reasons": reasons,
    }
    if isinstance(relationship, dict):
        for key in (
            "markdownCellId",
            "markdownCellIndex",
            "markdownText",
            "outputId",
            "outputCellId",
            "outputCellIndex",
            "outputIndex",
            "componentType",
            "rectangle",
        ):
            if key in relationship:
                summary[key] = relationship[key]
    LOGGER.warning(
        "LinkMaker rejected output relationship: %s",
        json.dumps(summary, ensure_ascii=False),
    )


def _log_output_identity_correction(
    relationship_index: int,
    relationship: dict[str, Any],
    artifact: dict[str, Any],
) -> None:
    """Report redundant model identities replaced by canonical artifact values."""
    corrections = {}
    for model_key, artifact_key in (
        ("outputCellId", "cellId"),
        ("outputCellIndex", "cellIndex"),
        ("outputIndex", "outputIndex"),
    ):
        received = relationship.get(model_key)
        expected = artifact[artifact_key]
        if received != expected:
            corrections[model_key] = {"received": received, "used": expected}
    if corrections:
        LOGGER.warning(
            "LinkMaker corrected output identity from outputId at relationship %s: %s",
            relationship_index,
            json.dumps(corrections, ensure_ascii=False),
        )


def _is_normalized_rectangle(value: Any) -> bool:
    """Validate a non-empty rectangle in the output's 0–1000 coordinate space."""
    if not isinstance(value, dict):
        return False
    coordinates = [value.get(key) for key in ("x", "y", "width", "height")]
    if not all(isinstance(item, int) and not isinstance(item, bool) for item in coordinates):
        return False
    x, y, width, height = coordinates
    return (
        0 <= x <= 1000
        and 0 <= y <= 1000
        and 1 <= width <= 1000
        and 1 <= height <= 1000
        and x + width <= 1000
        and y + height <= 1000
    )


def _find_output_markdown_range(source: str, excerpt: Any) -> tuple[int, int] | None:
    """Match output-link evidence exactly, tolerating only outer whitespace."""
    exact_range = _find_exact_range(source, excerpt)
    if exact_range is not None or not isinstance(excerpt, str):
        return exact_range
    stripped_excerpt = excerpt.strip()
    if not stripped_excerpt or stripped_excerpt == excerpt:
        return None
    return _find_exact_range(source, stripped_excerpt)


def _normalize_output_rectangle(
    value: Any, artifact: dict[str, Any]
) -> dict[str, int] | None:
    """Normalize bottom-left-origin image pixels to the persisted 0–1000 space."""
    if not isinstance(value, dict):
        return None
    coordinates = (value.get("x"), value.get("y"), value.get("width"), value.get("height"))
    if any(not isinstance(item, int) or isinstance(item, bool) for item in coordinates):
        return None
    x, y, width, height = coordinates
    if x < 0 or y < 0 or width < 1 or height < 1:
        return None

    if artifact.get("kind") != "image":
        return value if _is_normalized_rectangle(value) else None

    image_width = artifact.get("imageWidth", 1000)
    image_height = artifact.get("imageHeight", 1000)
    if x + width > image_width or y + height > image_height:
        # Older/model-generated responses may still use the persisted 0–1000
        # coordinate space even when the prompt requests source-image pixels.
        # Preserve those rectangles instead of silently dropping the relation.
        return value if _is_normalized_rectangle(value) else None

    left = round((x / image_width) * 1000)
    top = round((y / image_height) * 1000)
    right = round(((x + width) / image_width) * 1000)
    bottom = round(((y + height) / image_height) * 1000)
    return {
        "x": min(left, 999),
        "y": min(top, 999),
        "width": max(1, min(1000, right) - min(left, 999)),
        "height": max(1, min(1000, bottom) - min(top, 999)),
    }


def _build_relationship_prompt(
    markdown_cells: list[dict[str, Any]], code_cells: list[dict[str, Any]]
) -> str:
    instruction = (
        "Find every relationship between the supplied Markdown cells and code cells. "
        "A Markdown cell may relate to zero, one, or multiple code cells, and a code "
        "cell may relate to zero, one, or multiple Markdown cells. Treat distinct "
        "Markdown sentences, bullets, numbered items, or subsections as separate "
        "potential relationships when they refer to different code components. Before "
        "returning, check every substantive Markdown cell for all relationships "
        "supported by its specific content; do not stop after finding only the most "
        "obvious links. Prefer "
        "explicit local references such as file names, function names, variables, or "
        "described operations over the broader topic of the Markdown cell. For each "
        "relationship, select the smallest contiguous Markdown portion that expresses "
        "it and the smallest contiguous code portion that corresponds to it. Use the "
        "whole code cell only when the relationship depends on the cell as a whole. "
        "Return markdownCellId, markdownCellIndex, codeCellId, and codeCellIndex exactly "
        "as supplied. Return markdownText and codeText as exact verbatim contiguous "
        "text from the source. Use whole_cell only when the entire meaningful source "
        "cell is required; otherwise use excerpt. The deliberately unrelated, synthetic "
        "example objects below illustrate the required output shape, evidence "
        "granularity, and relationship patterns. Do not treat them as notebook content "
        "or copy their IDs, indices, text, or relationship types into the result."
    )
    examples = {
        "relationships": [
            {
                "markdownCellId": "example-markdown-age-bands",
                "markdownCellIndex": 0,
                "markdownText": "Create age bands to inspect survival patterns.",
                "codeCellId": "example-code-age-bands",
                "codeCellIndex": 1,
                "codeScope": "excerpt",
                "codeText": "records['AgeBand'] = pd.cut(records['Age'], 5)",
                "relationshipType": "feature_engineering",
                "confidence": 0.95,
                "reason": "The Markdown describes creating age bands, which the code performs.",
            },
            {
                "markdownCellId": "example-markdown-remove-band",
                "markdownCellIndex": 2,
                "markdownText": (
                    "Remove the temporary AgeBand feature after its values have been used."
                ),
                "codeCellId": "example-code-remove-band",
                "codeCellIndex": 3,
                "codeScope": "excerpt",
                "codeText": "records = records.drop(['AgeBand'], axis=1)",
                "relationshipType": "feature_removal",
                "confidence": 0.95,
                "reason": "The Markdown describes removing AgeBand, which the code performs.",
            },
            {
                "markdownCellId": "example-markdown-port-values",
                "markdownCellIndex": 4,
                "markdownText": "Convert the port labels into ordinal values.",
                "codeCellId": "example-code-port-values",
                "codeCellIndex": 5,
                "codeScope": "excerpt",
                "codeText": (
                    "records['Port'] = records['Port'].map({'S': 0, 'C': 1, 'Q': 2})"
                ),
                "relationshipType": "categorical_to_numeric",
                "confidence": 0.95,
                "reason": "The code maps categorical port labels to numeric values.",
            },
        ]
    }
    markdown_section = json.dumps(
        [_prompt_cell(cell) for cell in markdown_cells], ensure_ascii=False
    )
    code_section = json.dumps(
        [_prompt_cell(cell) for cell in code_cells], ensure_ascii=False
    )
    return (
        f"{instruction}\n\n"
        f"EXAMPLE RELATIONSHIPS (FORMAT ONLY)\n"
        f"{json.dumps(examples, ensure_ascii=False)}\n\n"
        f"MARKDOWN CELLS\n{markdown_section}\n\n"
        f"CODE CELLS\n{code_section}"
    )


def _prompt_cell(cell: dict[str, Any]) -> dict[str, Any]:
    """Return the compact, stable cell representation sent to the model."""
    return {
        "cellId": cell["id"],
        "cellIndex": cell["index"],
        "text": cell["source"],
    }


def _extract_payload_from_response(response: Any) -> Any:
    output_text = getattr(response, "output_text", "")
    if output_text:
        try:
            return json.loads(output_text)
        except json.JSONDecodeError:
            pass

    output = getattr(response, "output", None)
    if isinstance(output, list):
        for item in output:
            if getattr(item, "type", None) == "message":
                for content in getattr(item, "content", []) or []:
                    if getattr(content, "type", None) == "output_text":
                        text = getattr(content, "text", "")
                        if text:
                            try:
                                return json.loads(text)
                            except json.JSONDecodeError:
                                continue

    if hasattr(response, "model_dump"):
        try:
            data = response.model_dump()
        except Exception:  # noqa: BLE001
            data = None
        if isinstance(data, dict):
            text_value = data.get("output_text")
            if isinstance(text_value, str):
                try:
                    return json.loads(text_value)
                except json.JSONDecodeError:
                    pass
            for item in data.get("output", []) or []:
                if isinstance(item, dict) and item.get("type") == "message":
                    for content in item.get("content", []) or []:
                        if isinstance(content, dict) and content.get("type") == "output_text":
                            text = content.get("text")
                            if isinstance(text, str):
                                try:
                                    return json.loads(text)
                                except json.JSONDecodeError:
                                    continue

    return None


def _materialize_relationships(
    markdown_cell: dict[str, Any],
    code_cells: list[dict[str, Any]],
    relationships: list[Any],
) -> list[dict[str, Any]]:
    """Materialize legacy single-Markdown results used by existing evaluations."""
    code_by_id = {cell["id"]: cell for cell in code_cells}
    code_by_index = {cell["index"]: cell for cell in code_cells}
    materialized: list[dict[str, Any]] = []
    for relationship in relationships:
        if not isinstance(relationship, dict):
            continue

        code_cell = None
        code_cell_id = relationship.get("codeCellId")
        code_cell_index = relationship.get("codeCellIndex")

        if isinstance(code_cell_id, int):
            code_cell = code_by_index.get(code_cell_id)
        elif isinstance(code_cell_id, str):
            if code_cell_id in code_by_id:
                code_cell = code_by_id[code_cell_id]
            elif code_cell_id.isdigit():
                code_cell = code_by_index.get(int(code_cell_id))
            elif code_cell_id.startswith("cell-") and code_cell_id[5:].isdigit():
                code_cell = code_by_index.get(int(code_cell_id[5:]))

        if not code_cell and isinstance(code_cell_index, int):
            code_cell = code_by_index.get(code_cell_index)

        if not code_cell:
            continue
        if isinstance(code_cell_index, int) and code_cell["index"] != code_cell_index:
            continue

        item = _materialize_relationship(markdown_cell, code_cell, relationship)
        if item:
            materialized.append(item)
    return materialized


def _materialize_notebook_relationships(
    markdown_cells: list[dict[str, Any]],
    code_cells: list[dict[str, Any]],
    relationships: list[Any],
) -> list[dict[str, Any]]:
    """Validate one notebook-wide response and restore the saved file structure."""
    markdown_by_id = {cell["id"]: cell for cell in markdown_cells}
    code_by_id = {cell["id"]: cell for cell in code_cells}
    grouped: dict[str, list[dict[str, Any]]] = {
        cell["id"]: [] for cell in markdown_cells
    }
    seen: set[tuple[Any, ...]] = set()

    for relationship in relationships:
        if not isinstance(relationship, dict):
            continue

        markdown_cell_id = relationship.get("markdownCellId")
        code_cell_id = relationship.get("codeCellId")
        if not isinstance(markdown_cell_id, str) or not isinstance(code_cell_id, str):
            continue

        markdown_cell = markdown_by_id.get(markdown_cell_id)
        code_cell = code_by_id.get(code_cell_id)
        if not markdown_cell or not code_cell:
            continue
        if relationship.get("markdownCellIndex") != markdown_cell["index"]:
            continue
        if relationship.get("codeCellIndex") != code_cell["index"]:
            continue

        item = _materialize_relationship(markdown_cell, code_cell, relationship)
        if not item:
            continue

        markdown_portion = item["markdownPortion"]
        code_portion = item["codeTarget"]["portion"]
        relationship_key = (
            markdown_cell_id,
            markdown_portion["startOffset"],
            markdown_portion["endOffset"],
            code_cell_id,
            item["codeTarget"]["scope"],
            code_portion["startOffset"],
            code_portion["endOffset"],
        )
        if relationship_key in seen:
            continue
        seen.add(relationship_key)
        grouped[markdown_cell_id].append(item)

    return [
        {
            "markdownCell": _cell_reference(markdown_cell),
            "relationships": grouped[markdown_cell["id"]],
        }
        for markdown_cell in markdown_cells
    ]


def _materialize_relationship(
    markdown_cell: dict[str, Any],
    code_cell: dict[str, Any],
    relationship: dict[str, Any],
) -> dict[str, Any] | None:
    """Verify exact source spans and build one persisted relationship."""
    markdown_range = _find_exact_range(
        markdown_cell["source"], relationship.get("markdownText")
    )
    code_text = relationship.get("codeText")
    code_scope = relationship.get("codeScope")
    code_text_range = _find_exact_range(code_cell["source"], code_text)
    if not markdown_range or not code_text_range:
        return None
    if code_scope == "whole_cell":
        if code_text != code_cell["source"]:
            return None
        code_range = (0, len(code_cell["source"]))
    elif code_scope == "excerpt":
        code_range = code_text_range
    else:
        return None

    relationship_type = relationship.get("relationshipType")
    confidence = relationship.get("confidence")
    reason = relationship.get("reason")
    if not isinstance(relationship_type, str) or not isinstance(reason, str):
        return None
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        return None
    if confidence < 0 or confidence > 1:
        return None

    return {
        "markdownPortion": _portion(markdown_cell["source"], markdown_range),
        "codeTarget": {
            **_cell_reference(code_cell),
            "scope": code_scope,
            "portion": _portion(code_cell["source"], code_range),
        },
        "relationshipType": relationship_type,
        "confidence": confidence,
        "reason": reason,
    }


def _find_exact_range(source: str, excerpt: Any) -> tuple[int, int] | None:
    """Find a verbatim model excerpt and reject incomplete or paraphrased text."""
    if not isinstance(excerpt, str) or not excerpt:
        return None
    start = source.find(excerpt)
    if start < 0:
        return None
    return start, start + len(excerpt)


def _portion(source: str, offsets: tuple[int, int]) -> dict[str, Any]:
    start, end = offsets
    return {"text": source[start:end], "startOffset": start, "endOffset": end}


def _cell_reference(cell: dict[str, Any]) -> dict[str, Any]:
    return {"id": cell["id"], "index": cell["index"], "metadata": cell["metadata"]}


def _normalize_source(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return "".join(value)
    return ""


def _relationship_file_path(notebook_path: str) -> str:
    stem, extension = posixpath.splitext(notebook_path)
    return f"{stem if extension == '.ipynb' else notebook_path}{RELATIONSHIP_FILE_SUFFIX}"


async def _load_relationship_file(contents_manager: Any, path: str) -> dict[str, Any]:
    """Load the existing map so output analysis never overwrites code analysis."""
    try:
        model = await _await_if_needed(contents_manager.get(path, content=True))
    except Exception:  # noqa: BLE001
        return {}
    content = getattr(model, "content", None)
    if isinstance(model, dict):
        content = model.get("content")
    if not isinstance(content, str):
        return {}
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def _save_relationship_file(
    contents_manager: Any, path: str, content: dict[str, Any]
) -> Any:
    """Save a relationship checkpoint with sync and async contents managers."""
    return await _await_if_needed(
        contents_manager.save(
            {"type": "file", "format": "text", "content": json.dumps(content, indent=2)},
            path,
        )
    )


async def _await_if_needed(result: Any) -> Any:
    """Await awaitables when present, otherwise return the value directly."""
    if inspect.isawaitable(result):
        return await result
    return result


def _saved_model_path(saved_model: Any, fallback: str) -> str:
    """Return the path confirmed by the Jupyter contents manager."""
    if isinstance(saved_model, dict) and isinstance(saved_model.get("path"), str):
        return saved_model["path"]
    return fallback
