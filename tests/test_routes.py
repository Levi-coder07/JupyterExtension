import asyncio
import json
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from LinkMaker import routes


class ExecutionOutputContextTests(unittest.TestCase):
    def test_table_targets_preserve_cells_and_reject_unknown_ids(self):
        cells = [
            {"id": "r0c0", "text": "Score", "rowSpan": 1, "colSpan": 2, "header": True},
            {"id": "r1c0", "text": "86.76", "rowSpan": 1, "colSpan": 1, "header": False},
            {"id": "r1c1", "text": "86.76", "rowSpan": 1, "colSpan": 1, "header": False},
        ]
        artifacts = routes._validate_output_artifacts([{
            "outputId": "code:0", "cellId": "code", "cellIndex": 1, "outputIndex": 0,
            "kind": "table", "mimeType": "text/html", "content": "<table></table>",
            "tableCells": cells,
        }])
        markdown = [{"id": "md", "index": 0, "metadata": {}, "source": "Scores are equal."}]
        relationship = {
            "markdownCellId": "md", "markdownCellIndex": 0, "markdownText": "Scores are equal.",
            "outputId": "code:0", "outputCellId": "code", "outputCellIndex": 1, "outputIndex": 0,
            "componentType": "table_region", "componentDescription": "two score cells",
            "confidence": 0.9, "reason": "Both scores are 86.76.",
            "rectangles": [], "tableCellIds": ["r1c0", "r1c1"],
        }
        result = routes._materialize_output_relationships(markdown, artifacts, [relationship])
        target = result[0]["relationships"][0]["outputTarget"]
        self.assertEqual(target["tableCellIds"], ["r1c0", "r1c1"])
        self.assertEqual(target["tableSnapshot"], cells)
        self.assertEqual(target["rectangles"], [])
        self.assertIn('"id": "r1c1"', routes._build_output_relationship_prompt(markdown, artifacts))
        with self.assertLogs(routes.LOGGER, level="WARNING"):
            result = routes._materialize_output_relationships(
                markdown, artifacts, [{**relationship, "tableCellIds": ["r9c9"]}]
            )
        self.assertEqual(result[0]["relationships"], [])

    def test_warning_filter_preserves_results_and_errors(self):
        outputs = [
            {"output_type": "stream", "name": "stderr", "text": [
                "Diagnostic before\n",
                "/lib/model.py:42: FutureWarning: default changing\n",
                "  warnings.warn(message, FutureWarning)\n",
                "/lib/model.py:50: ConvergenceWarning: convergence failed\n",
                "  fit(data)\n",
                "Diagnostic after\n",
            ]},
            {"output_type": "stream", "name": "stdout", "text": "Score: 0.95\n"},
            {"output_type": "execute_result", "data": {"text/plain": "0.95"}},
            {"output_type": "error", "ename": "ValueError", "evalue": "bad input"},
        ]
        self.assertEqual(routes._extract_execution_text(outputs),
                         "Diagnostic before\nDiagnostic after\n\nScore: 0.95\n\n0.95\n\nValueError: bad input")

    def test_warning_only_cell_has_no_output_context(self):
        _, cells = routes._extract_notebook_cells({"cells": [{
            "cell_type": "code", "source": "fit()", "outputs": [{
                "output_type": "stream", "name": "stderr",
                "text": "\u001b[31m/tmp/model.py:2: UserWarning: notice\u001b[0m\n  fit()\n",
            }],
        }]})
        self.assertNotIn("outputText", routes._prompt_cell(cells[0]))

    def test_execution_text_reaches_model_with_owning_cell(self):
        notebook = {"cells": [
            {"cell_type": "markdown", "source": "There are 42 rows."},
            {"cell_type": "code", "source": "display(df)", "outputs": [
                {"output_type": "stream", "text": ["Rows: ", "42\n"]},
                {"output_type": "execute_result", "data": {
                    "text/plain": "count\n42", "text/html": "<b>duplicate</b>"}},
                {"output_type": "error", "ename": "ValueError", "evalue": "bad",
                 "traceback": ["\u001b[31mframe one\u001b[0m", "frame two"]},
            ]},
            {"cell_type": "code", "source": "pass"},
        ]}
        markdown, code = routes._extract_notebook_cells(notebook)
        create = AsyncMock(return_value=SimpleNamespace(
            status="completed", output_text='{"relationships": []}'
        ))
        asyncio.run(routes._analyze_notebook_relationships(
            SimpleNamespace(responses=SimpleNamespace(create=create)), markdown, code
        ))
        prompt = create.await_args.kwargs["input"]
        sent_cells = json.loads(prompt.split("CODE CELLS\n", 1)[1])
        self.assertEqual(sent_cells[0]["outputText"],
                         "Rows: 42\n\ncount\n42\n\nValueError: bad\nframe one\nframe two")
        self.assertNotIn("outputText", sent_cells[1])
        self.assertNotIn("outputText", routes._prompt_cell(markdown[0]))

    def test_missing_empty_and_nontext_outputs_add_no_context(self):
        for outputs in (None, [], {}, [None], [
            {"output_type": "stream", "text": " \n"},
            {"output_type": "display_data", "data": {"image/png": "binary"}},
            {"output_type": "display_data", "data": None},
        ]):
            with self.subTest(outputs=outputs):
                self.assertEqual(routes._extract_execution_text(outputs), "")

    def test_html_fallback_and_large_output(self):
        text = routes._extract_execution_text([{
            "output_type": "display_data", "data": {"text/html": [
                "<style>hidden</style><table><tr><th>Count</th>",
                "<td>42 &amp; more</td></tr></table><script>hidden</script>",
            ]}
        }])
        self.assertIn("Count\n42 & more", text)
        self.assertNotIn("hidden", text)
        text = routes._extract_execution_text([
            {"output_type": "stream", "text": "x" * 30_000}
        ])
        self.assertEqual(text, "x" * 20_000 + "\n[Output text truncated]")


class DummyHandler:
    def __init__(self, contents_manager):
        self.contents_manager = contents_manager
        self.log = logging.getLogger("test")
        self.finished_payload = None

    def finish(self, payload):
        self.finished_payload = payload

    def get_json_body(self):
        return {
            "notebookPath": "/test/notebook.ipynb",
            "mimeType": "image/png",
            "rawData": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAIAAGQAGYdY3YQAAAABJRU5ErkJggg==",
            "source": "rendered-dom",
            "cellIndex": 0,
            "mediaIndex": 0,
            "outputIndex": 0,
        }


class SaveMediaRouteTests(unittest.TestCase):
    def test_save_media_route_awaits_async_contents_manager_calls(self):
        contents_manager = SimpleNamespace(
            dir_exists=AsyncMock(return_value=False),
            increment_filename=AsyncMock(return_value="notebook-cell-001-media-001.png"),
            save=AsyncMock(return_value={"path": "notebook-cell-001-media-001.png"}),
        )
        handler = DummyHandler(contents_manager)

        method = getattr(
            routes.SaveMediaRouteHandler.post,
            "__wrapped__",
            routes.SaveMediaRouteHandler.post,
        )

        asyncio.run(method(handler))

        self.assertEqual(handler.finished_payload["status"], "success")
        contents_manager.dir_exists.assert_awaited_once()
        contents_manager.increment_filename.assert_awaited_once()
        self.assertEqual(contents_manager.save.await_count, 2)

    def test_materialize_relationships_falls_back_to_code_cell_index(self):
        markdown_cell = {
            "source": "Explain the training pipeline.",
            "id": "cell-7",
            "index": 7,
            "metadata": {},
        }
        code_cells = [
            {"id": "cell-2", "index": 2, "metadata": {}, "source": "print('a')"},
            {"id": "cell-3", "index": 3, "metadata": {}, "source": "print('b')"},
        ]
        relationships = [{
            "codeCellId": "missing-cell",
            "codeCellIndex": 3,
            "markdownText": "Explain the training",
            "codeScope": "excerpt",
            "codeText": "print",
            "relationshipType": "describes_behavior",
            "confidence": 0.8,
            "reason": "test",
        }]

        materialized = routes._materialize_relationships(markdown_cell, code_cells, relationships)

        self.assertEqual(len(materialized), 1)
        self.assertEqual(materialized[0]["codeTarget"]["index"], 3)

    def test_materialize_relationships_rejects_non_verbatim_excerpts(self):
        markdown_cell = {"source": "abc", "id": "cell-7", "index": 7, "metadata": {}}
        code_cells = [{"id": "cell-2", "index": 2, "metadata": {}, "source": "print('a')"}]
        relationships = [{
            "codeCellId": "cell-2",
            "codeCellIndex": 2,
            "markdownText": "not present",
            "codeScope": "excerpt",
            "codeText": "print('a')",
            "relationshipType": "describes_behavior",
            "confidence": 0.8,
            "reason": "test",
        }]

        materialized = routes._materialize_relationships(markdown_cell, code_cells, relationships)

        self.assertEqual(materialized, [])

    def test_notebook_analysis_uses_one_request_for_all_cells(self):
        markdown_cells = [
            {
                "id": "markdown-a",
                "index": 0,
                "metadata": {},
                "source": "Load the dataset.",
            },
            {
                "id": "markdown-b",
                "index": 2,
                "metadata": {},
                "source": "Print the result.",
            },
        ]
        code_cells = [
            {
                "id": "code-a",
                "index": 1,
                "metadata": {},
                "source": "data = load_data()",
            },
            {
                "id": "code-b",
                "index": 3,
                "metadata": {},
                "source": "print(data)",
            },
        ]
        response = SimpleNamespace(
            status="completed",
            output_text=json.dumps(
                {
                    "relationships": [
                        {
                            "markdownCellId": "markdown-a",
                            "markdownCellIndex": 0,
                            "markdownText": "Load the dataset.",
                            "codeCellId": "code-a",
                            "codeCellIndex": 1,
                            "codeScope": "excerpt",
                            "codeText": "load_data()",
                            "relationshipType": "documents_behavior",
                            "confidence": 0.9,
                            "reason": "The Markdown documents the load call.",
                        },
                        {
                            "markdownCellId": "markdown-b",
                            "markdownCellIndex": 2,
                            "markdownText": "Print the result.",
                            "codeCellId": "code-b",
                            "codeCellIndex": 3,
                            "codeScope": "excerpt",
                            "codeText": "print(data)",
                            "relationshipType": "documents_output",
                            "confidence": 0.9,
                            "reason": "The Markdown documents the print call.",
                        },
                    ]
                }
            ),
        )
        create = AsyncMock(return_value=response)
        client = SimpleNamespace(responses=SimpleNamespace(create=create))

        analyses = asyncio.run(
            routes._analyze_notebook_relationships(
                client, markdown_cells, code_cells
            )
        )

        create.assert_awaited_once()
        prompt = create.await_args.kwargs["input"]
        self.assertIn("EXAMPLE RELATIONSHIPS (FORMAT ONLY)", prompt)
        self.assertIn("MARKDOWN CELLS", prompt)
        self.assertIn("CODE CELLS", prompt)
        self.assertIn("smallest contiguous Markdown portion", prompt)
        self.assertIn("exact verbatim contiguous text", prompt)
        self.assertIn("otherwise use excerpt", prompt)
        examples_text = prompt.split(
            "EXAMPLE RELATIONSHIPS (FORMAT ONLY)\n", 1
        )[1].split("\n\nMARKDOWN CELLS", 1)[0]
        examples = json.loads(examples_text)
        required_fields = set(
            routes.RELATIONSHIP_SCHEMA["properties"]["relationships"]["items"][
                "required"
            ]
        )
        self.assertEqual(len(examples["relationships"]), 3)
        for example in examples["relationships"]:
            self.assertEqual(set(example), required_fields)
        examples_lower = examples_text.lower()
        for task_term in ("dataset", "model", "pipeline", "test_size", "n_estimators"):
            self.assertNotIn(task_term, examples_lower)
        self.assertIn('"cellId": "markdown-a"', prompt)
        self.assertIn('"cellId": "markdown-b"', prompt)
        self.assertIn('"cellId": "code-a"', prompt)
        self.assertIn('"cellId": "code-b"', prompt)
        self.assertEqual(len(analyses), 2)
        self.assertEqual(len(analyses[0]["relationships"]), 1)
        self.assertEqual(len(analyses[1]["relationships"]), 1)

    def test_notebook_materialization_rejects_invalid_ids_and_spans(self):
        markdown_cells = [
            {
                "id": "markdown-a",
                "index": 0,
                "metadata": {},
                "source": "Load the dataset.",
            }
        ]
        code_cells = [
            {
                "id": "code-a",
                "index": 1,
                "metadata": {},
                "source": "data = load_data()",
            }
        ]
        base_relationship = {
            "markdownCellId": "markdown-a",
            "markdownCellIndex": 0,
            "markdownText": "Load the dataset.",
            "codeCellId": "code-a",
            "codeCellIndex": 1,
            "codeScope": "excerpt",
            "codeText": "load_data()",
            "relationshipType": "documents_behavior",
            "confidence": 0.9,
            "reason": "Direct evidence.",
        }
        invalid_markdown_id = {**base_relationship, "markdownCellId": "missing"}
        invalid_code_id = {**base_relationship, "codeCellId": "missing"}
        invalid_markdown_text = {
            **base_relationship,
            "markdownText": "Paraphrased text",
        }
        invalid_code_text = {**base_relationship, "codeText": "load()"}
        invalid_index = {**base_relationship, "codeCellIndex": 9}
        invalid_whole_cell = {
            **base_relationship,
            "codeScope": "whole_cell",
            "codeText": "load_data()",
        }

        analyses = routes._materialize_notebook_relationships(
            markdown_cells,
            code_cells,
            [
                base_relationship,
                invalid_markdown_id,
                invalid_code_id,
                invalid_markdown_text,
                invalid_code_text,
                invalid_index,
                invalid_whole_cell,
            ],
        )

        self.assertEqual(len(analyses), 1)
        self.assertEqual(len(analyses[0]["relationships"]), 1)
        relationship = analyses[0]["relationships"][0]
        self.assertEqual(relationship["markdownPortion"]["text"], "Load the dataset.")
        self.assertEqual(relationship["codeTarget"]["portion"]["text"], "load_data()")

    def test_notebook_analysis_skips_model_when_relationships_are_impossible(self):
        markdown_cells = [
            {
                "id": "markdown-a",
                "index": 0,
                "metadata": {},
                "source": "No code exists.",
            }
        ]
        create = AsyncMock()
        client = SimpleNamespace(responses=SimpleNamespace(create=create))

        analyses = asyncio.run(
            routes._analyze_notebook_relationships(client, markdown_cells, [])
        )

        create.assert_not_awaited()
        self.assertEqual(analyses[0]["relationships"], [])

    def test_output_materialization_requires_exact_markdown_and_output_identity(self):
        markdown_cells = [{
            "id": "markdown-a",
            "index": 0,
            "metadata": {},
            "source": "The survival rate is higher for women.",
        }]
        artifacts = [{
            "outputId": "code-a:0",
            "cellId": "code-a",
            "cellIndex": 1,
            "outputIndex": 0,
            "kind": "image",
            "mimeType": "image/png",
            "content": "data:image/png;base64,abc",
        }]
        relationship = {
            "markdownCellId": "markdown-a",
            "markdownCellIndex": 0,
            "markdownText": "survival rate is higher for women",
            "outputId": "code-a:0",
            "outputCellId": "code-a",
            "outputCellIndex": 1,
            "outputIndex": 0,
            "componentDescription": "the female survival-rate bar",
            "componentType": "bar",
            "rectangles": [{"x": 220, "y": 100, "width": 140, "height": 650}],
            "confidence": 0.9,
            "reason": "The Markdown interprets the chart bar.",
        }

        analyses = routes._materialize_output_relationships(
            markdown_cells,
            artifacts,
            [relationship, {**relationship, "outputId": "missing"}],
        )

        self.assertEqual(len(analyses[0]["relationships"]), 1)
        target = analyses[0]["relationships"][0]["outputTarget"]
        self.assertEqual(target["id"], "code-a:0")
        self.assertEqual(target["componentDescription"], "the female survival-rate bar")
        self.assertEqual(target["componentType"], "bar")
        self.assertEqual(target["rectangles"][0]["height"], 650)

        valid_full_chart = {
            **relationship,
            "componentType": "whole_output",
            "rectangles": [{"x": 0, "y": 0, "width": 1000, "height": 1000}],
        }
        full_chart = routes._materialize_output_relationships(
            markdown_cells, artifacts, [valid_full_chart]
        )
        self.assertEqual(len(full_chart[0]["relationships"]), 1)
        self.assertEqual(
            full_chart[0]["relationships"][0]["outputTarget"]["componentType"],
            "whole_output",
        )

    def test_output_materialization_keeps_normalized_top_left_coordinates(self):
        markdown_cells = [{
            "id": "markdown-a",
            "index": 0,
            "metadata": {},
            "source": "The oldest passenger survived.",
        }]
        artifacts = [{
            "outputId": "code-a:0",
            "cellId": "code-a",
            "cellIndex": 1,
            "outputIndex": 0,
            "kind": "image",
            "mimeType": "image/png",
            "content": "data:image/png;base64,abc",
            "imageWidth": 1200,
            "imageHeight": 600,
        }]
        relationship = {
            "markdownCellId": "markdown-a",
            "markdownCellIndex": 0,
            "markdownText": "oldest passenger survived",
            "outputId": "code-a:0",
            "outputCellId": "code-a",
            "outputCellIndex": 1,
            "outputIndex": 0,
            "componentDescription": "the final histogram bar",
            "componentType": "bar",
            "rectangles": [{"x": 900, "y": 100, "width": 50, "height": 100}],
            "confidence": 0.9,
            "reason": "The Markdown refers to the final bar.",
        }

        analyses = routes._materialize_output_relationships(
            markdown_cells, artifacts, [relationship]
        )

        rectangle = analyses[0]["relationships"][0]["outputTarget"]["rectangles"][0]
        self.assertEqual(
            rectangle, {"x": 900, "y": 100, "width": 50, "height": 100}
        )

    def test_output_coordinates_do_not_depend_on_capture_dimensions(self):
        markdown_cells = [{
            "id": "markdown-a",
            "index": 0,
            "metadata": {},
            "source": "The oldest passenger survived.",
        }]
        artifacts = [{
            "outputId": "code-a:0",
            "cellId": "code-a",
            "cellIndex": 1,
            "outputIndex": 0,
            "kind": "image",
            "mimeType": "image/png",
            "content": "data:image/png;base64,abc",
            "imageWidth": 1272,
            "imageHeight": 624,
        }]
        relationship = {
            "markdownCellId": "markdown-a",
            "markdownCellIndex": 0,
            "markdownText": "oldest passenger survived",
            "outputId": "code-a:0",
            "outputCellId": "code-a",
            "outputCellIndex": 1,
            "outputIndex": 0,
            "componentDescription": "the final histogram bar",
            "componentType": "bar",
            "rectangles": [{"x": 920, "y": 800, "width": 40, "height": 40}],
            "confidence": 0.9,
            "reason": "The Markdown refers to the final bar.",
        }

        analyses = routes._materialize_output_relationships(
            markdown_cells, artifacts, [relationship]
        )

        rectangle = analyses[0]["relationships"][0]["outputTarget"]["rectangles"][0]
        self.assertEqual(
            rectangle, {"x": 920, "y": 800, "width": 40, "height": 40}
        )

    def test_output_materialization_trims_outer_markdown_whitespace(self):
        markdown_cells = [{
            "id": "markdown-a",
            "index": 0,
            "metadata": {},
            "source": "Observations\n\n- Infants had high survival.",
        }]
        artifacts = [{
            "outputId": "code-a:0",
            "cellId": "code-a",
            "cellIndex": 1,
            "outputIndex": 0,
            "kind": "image",
            "mimeType": "image/png",
            "content": "data:image/png;base64,abc",
            "imageWidth": 1000,
            "imageHeight": 1000,
        }]
        relationship = {
            "markdownCellId": "markdown-a",
            "markdownCellIndex": 0,
            "markdownText": " - Infants had high survival. ",
            "outputId": "code-a:0",
            "outputCellId": "code-a",
            "outputCellIndex": 1,
            "outputIndex": 0,
            "componentDescription": "the infant-age bar",
            "componentType": "bar",
            "rectangles": [{"x": 10, "y": 10, "width": 20, "height": 20}],
            "confidence": 0.9,
            "reason": "The Markdown describes the bar.",
        }

        analyses = routes._materialize_output_relationships(
            markdown_cells, artifacts, [relationship]
        )

        portion = analyses[0]["relationships"][0]["markdownPortion"]
        self.assertEqual(portion["text"], "- Infants had high survival.")
        self.assertEqual(
            markdown_cells[0]["source"][portion["startOffset"]:portion["endOffset"]],
            portion["text"],
        )

    def test_output_materialization_logs_rejection_reason(self):
        markdown_cells = [{
            "id": "markdown-a",
            "index": 0,
            "metadata": {},
            "source": "A visible chart claim.",
        }]
        artifacts = [{
            "outputId": "code-a:0",
            "cellId": "code-a",
            "cellIndex": 1,
            "outputIndex": 0,
            "kind": "image",
            "mimeType": "image/png",
            "content": "data:image/png;base64,abc",
            "imageWidth": 1000,
            "imageHeight": 1000,
        }]
        relationship = {
            "markdownCellId": "markdown-a",
            "markdownCellIndex": 0,
            "markdownText": "Text that is not in the Markdown cell.",
            "outputId": "code-a:0",
            "outputCellId": "code-a",
            "outputCellIndex": 1,
            "outputIndex": 0,
            "componentDescription": "a chart component",
            "componentType": "bar",
            "rectangles": [{"x": 10, "y": 10, "width": 20, "height": 20}],
            "confidence": 0.9,
            "reason": "The claim refers to the component.",
        }

        with self.assertLogs(routes.LOGGER, level="WARNING") as captured:
            routes._materialize_output_relationships(
                markdown_cells, artifacts, [relationship]
            )

        self.assertIn("markdown_text_not_found", captured.output[0])

    def test_output_id_canonicalizes_redundant_model_identity_fields(self):
        markdown_cells = [{
            "id": "cell-27",
            "index": 27,
            "metadata": {},
            "source": "Female passengers had much better survival rate than males.",
        }]
        artifacts = [{
            "outputId": "output-cell-id:2",
            "cellId": "output-cell-id",
            "cellIndex": 31,
            "outputIndex": 2,
            "kind": "image",
            "mimeType": "image/png",
            "content": "data:image/png;base64,abc",
            "imageWidth": 1000,
            "imageHeight": 1000,
        }]
        relationship = {
            "markdownCellId": "cell-27",
            "markdownCellIndex": 27,
            "markdownText": "Female passengers had much better survival rate than males.",
            "outputId": "output-cell-id:2",
            "outputCellId": "output-cell-id:2",
            "outputCellIndex": 2,
            "outputIndex": 2,
            "componentDescription": "the higher survival line",
            "componentType": "line",
            "rectangles": [{"x": 120, "y": 520, "width": 600, "height": 360}],
            "confidence": 0.58,
            "reason": "The line supports the Markdown claim.",
        }

        with self.assertLogs(routes.LOGGER, level="WARNING") as captured:
            analyses = routes._materialize_output_relationships(
                markdown_cells, artifacts, [relationship]
            )

        target = analyses[0]["relationships"][0]["outputTarget"]
        self.assertEqual(target["cellId"], "output-cell-id")
        self.assertEqual(target["cellIndex"], 31)
        self.assertEqual(target["outputIndex"], 2)
        self.assertIn("corrected output identity", captured.output[0])

    def test_output_markdown_index_correction_requires_matching_id_and_text(self):
        markdown = [{"id": "cell-23", "index": 23, "metadata": {},
                     "source": "- Most passengers are in 15-35 age range."}]
        artifacts = [{"outputId": "plot:1", "cellId": "plot", "cellIndex": 24,
                      "outputIndex": 1, "kind": "image", "imageWidth": 1000,
                      "imageHeight": 1000}]
        relationship = {
            "markdownCellId": "cell-23", "markdownCellIndex": 24,
            "markdownText": markdown[0]["source"], "outputId": "plot:1",
            "outputCellId": "plot", "outputCellIndex": 24, "outputIndex": 1,
            "componentDescription": "Age bins 15-35", "componentType": "bar_group",
            "rectangles": [{"x": 90, "y": 120, "width": 360, "height": 360},
                           {"x": 600, "y": 120, "width": 200, "height": 360}],
            "confidence": 0.8, "reason": "The histogram shows the age range.",
        }
        with self.assertLogs(routes.LOGGER, level="WARNING") as logs:
            result = routes._materialize_output_relationships(markdown, artifacts, [relationship])
        self.assertEqual(result[0]["markdownCell"]["index"], 23)
        self.assertEqual(len(result[0]["relationships"]), 1)
        target = result[0]["relationships"][0]["outputTarget"]
        self.assertEqual(target["rectangles"], relationship["rectangles"])
        self.assertEqual(target["coordinateSystem"], "normalized-top-left-1000-v1")
        self.assertEqual(target["geometryDebug"]["rawRectangles"], relationship["rectangles"])
        self.assertEqual(target["geometryDebug"]["imageWidth"], 1000)
        self.assertIn("corrected Markdown identity", logs.output[0])
        self.assertEqual(relationship["markdownCellIndex"], 24)
        for changes, rejection in [
            ({"rectangles": []}, "invalid_rectangle"),
            ({"rectangles": [{"x": 950, "y": 0, "width": 100, "height": 20}]}, "invalid_rectangle"),
            ({"rectangles": [{"x": 1100, "y": 0, "width": 100, "height": 20}]}, "invalid_rectangle"),
            ({"markdownText": "A different claim"}, "markdown_text_not_found"),
            ({"markdownCellId": "unknown"}, "unknown_markdown_cell"),
        ]:
            with self.subTest(changes=changes), self.assertLogs(routes.LOGGER, level="WARNING") as logs:
                result = routes._materialize_output_relationships(
                    markdown, artifacts, [{**relationship, **changes}]
                )
            self.assertEqual(result[0]["relationships"], [])
            self.assertIn(rejection, logs.output[0])

    def test_output_analysis_sends_images_and_html_with_valid_input_types(self):
        markdown_cells = [{
            "id": "markdown-a",
            "index": 0,
            "metadata": {},
            "source": "The chart and table show the result.",
        }]
        artifacts = [
            {
                "outputId": "code-a:0",
                "cellId": "code-a",
                "cellIndex": 1,
                "outputIndex": 0,
                "kind": "image",
                "mimeType": "image/png",
                "content": "data:image/png;base64,abc",
            },
            {
                "outputId": "code-b:0",
                "cellId": "code-b",
                "cellIndex": 2,
                "outputIndex": 0,
                "kind": "table",
                "mimeType": "text/html",
                "content": "<table><tr><td>1</td></tr></table>",
                "text": "1",
            },
        ]
        response = SimpleNamespace(
            status="completed",
            output_text=json.dumps({"relationships": []}),
        )
        create = AsyncMock(return_value=response)
        client = SimpleNamespace(responses=SimpleNamespace(create=create))

        asyncio.run(
            routes._analyze_output_relationships(
                client, markdown_cells, artifacts
            )
        )

        content = create.await_args.kwargs["input"][0]["content"]
        image_inputs = [item for item in content if item["type"] == "input_image"]
        file_inputs = [item for item in content if item["type"] == "input_file"]
        self.assertEqual(
            image_inputs,
            [{
                "type": "input_image",
                "image_url": "data:image/png;base64,abc",
                "detail": "high",
            }],
        )
        self.assertEqual(len(file_inputs), 1)
        self.assertEqual(file_inputs[0]["filename"], "code-b:0.html")
        self.assertTrue(
            file_inputs[0]["file_data"].startswith("data:text/html;base64,")
        )

    def test_extract_notebook_cells_assigns_unique_stable_ids(self):
        notebook = {
            "cells": [
                {"cell_type": "markdown", "id": "duplicate", "source": "A"},
                {"cell_type": "code", "id": "duplicate", "source": "B"},
                {"cell_type": "code", "source": "C"},
                {"cell_type": "markdown", "id": "empty", "source": []},
            ]
        }

        markdown_cells, code_cells = routes._extract_notebook_cells(notebook)

        cell_ids = [
            *(cell["id"] for cell in markdown_cells),
            *(cell["id"] for cell in code_cells),
        ]
        self.assertEqual(cell_ids, ["duplicate", "empty", "cell-1", "cell-2"])
        self.assertEqual(len(cell_ids), len(set(cell_ids)))
        self.assertEqual(markdown_cells[1]["source"], "")


if __name__ == "__main__":
    unittest.main()
