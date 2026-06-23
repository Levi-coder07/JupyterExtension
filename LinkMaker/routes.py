"""HTTP routes for the LinkMaker server extension."""

from __future__ import annotations

import base64
import json
import posixpath
import re
from typing import Any

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado
from tornado import web

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
    def post(self) -> None:
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

        media_directory = _ensure_media_directory(self.contents_manager, notebook_path)
        filename = _build_filename(
            notebook_path=notebook_path,
            mime_type=mime_type,
            cell_index=cell_index,
            output_index=output_index,
            media_index=media_index,
        )
        filename = self.contents_manager.increment_filename(filename, path=media_directory)
        target_path = posixpath.join(media_directory, filename)

        model = _build_file_model(mime_type, raw_data)
        self.contents_manager.save(model, target_path)

        self.finish(
            {
                "directory": media_directory,
                "filename": filename,
                "path": target_path,
                "status": "success",
            }
        )


def setup_route_handlers(web_app: Any) -> None:
    """Register the server extension route handlers."""
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    hello_route_pattern = url_path_join(base_url, "LinkMaker", "hello")
    save_media_route_pattern = url_path_join(base_url, "LinkMaker", "save-media")
    handlers = [
        (hello_route_pattern, HelloRouteHandler),
        (save_media_route_pattern, SaveMediaRouteHandler),
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


def _ensure_media_directory(contents_manager: Any, notebook_path: str) -> str:
    notebook_directory = posixpath.dirname(notebook_path.strip("/"))
    media_directory = posixpath.join(notebook_directory, MEDIA_DIRECTORY_NAME)

    if not contents_manager.dir_exists(media_directory):
        contents_manager.save({"type": "directory"}, media_directory)

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
