"""Run reproducible Markdown-to-code model evaluations for LinkMaker."""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI

from LinkMaker import routes


GROUND_TRUTH_PATH = Path("evaluation/baselines/titanic_code_only_v0_baseline.json")
NOTEBOOK_PATH = Path("titanic.ipynb")


def _edge_set_from_ground_truth() -> set[tuple[int, int]]:
    """Return the unique code-only Markdown-to-code ground-truth pairs."""
    payload = json.loads(GROUND_TRUTH_PATH.read_text(encoding="utf-8"))
    return {
        (item["markdownCellIndex"], item["codeCellIndex"])
        for item in payload["predictions"]
    }


def _edge_set_from_analyses(analyses: list[dict[str, Any]]) -> set[tuple[int, int]]:
    """Return unique Markdown-to-code pairs from materialized LinkMaker output."""
    return {
        (analysis["markdownCell"]["index"], relationship["codeTarget"]["index"])
        for analysis in analyses
        for relationship in analysis["relationships"]
    }


def _metrics(
    predicted_edges: set[tuple[int, int]], ground_truth_edges: set[tuple[int, int]]
) -> dict[str, int | float]:
    """Calculate exact-pair metrics against the fixed Titanic ground truth."""
    true_positives = len(predicted_edges & ground_truth_edges)
    false_positives = len(predicted_edges - ground_truth_edges)
    false_negatives = len(ground_truth_edges - predicted_edges)
    precision = true_positives / len(predicted_edges) if predicted_edges else 0.0
    recall = true_positives / len(ground_truth_edges)
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return {
        "predictions": len(predicted_edges),
        "truePositives": true_positives,
        "falsePositives": false_positives,
        "falseNegatives": false_negatives,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


async def _run_once(
    client: AsyncOpenAI,
    model: str,
    markdown_cells: list[dict[str, Any]],
    code_cells: list[dict[str, Any]],
    ground_truth_edges: set[tuple[int, int]],
) -> dict[str, Any]:
    """Execute one request and return its materialized output and metrics."""
    routes.RELATIONSHIP_MODEL = model
    started_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    analyses = await routes._analyze_notebook_relationships(
        client, markdown_cells, code_cells
    )
    latency_seconds = time.perf_counter() - started
    metrics = _metrics(_edge_set_from_analyses(analyses), ground_truth_edges)
    return {
        "version": 1,
        "notebookPath": str(NOTEBOOK_PATH),
        "model": model,
        "reasoningEffort": "low",
        "startedAt": started_at,
        "latencySeconds": latency_seconds,
        "groundTruth": {
            "path": str(GROUND_TRUTH_PATH),
            "scope": "code-only; outputs and sketches excluded",
            "uniquePairs": len(ground_truth_edges),
        },
        "metrics": metrics,
        "markdownAnalyses": analyses,
    }


async def main_async(models: list[str], runs: int, output_directory: Path) -> None:
    """Run the requested model matrix and write one JSON file per trial."""
    notebook = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
    markdown_cells, code_cells = routes._extract_notebook_cells(notebook)
    ground_truth_edges = _edge_set_from_ground_truth()
    output_directory.mkdir(parents=True, exist_ok=True)

    async with AsyncOpenAI() as client:
        for model in models:
            model_directory = output_directory / model.replace(".", "_")
            model_directory.mkdir(parents=True, exist_ok=True)
            for run_number in range(1, runs + 1):
                print(f"Starting {model}, run {run_number}/{runs}", flush=True)
                result = await _run_once(
                    client, model, markdown_cells, code_cells, ground_truth_edges
                )
                result_path = model_directory / f"run_{run_number}.json"
                result_path.write_text(
                    json.dumps(result, indent=2, ensure_ascii=True), encoding="utf-8"
                )
                metrics = result["metrics"]
                print(
                    f"Completed {model}, run {run_number}: "
                    f"F1={metrics['f1']:.3f}, latency={result['latencySeconds']:.1f}s",
                    flush=True,
                )


def main() -> None:
    """Parse command-line settings and run the model comparison."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--models",
        nargs="+",
        default=["gpt-5-nano", "gpt-5-mini", "gpt-5.4-mini"],
    )
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=Path("evaluation/runs/titanic_model_low"),
    )
    args = parser.parse_args()
    asyncio.run(main_async(args.models, args.runs, args.output_directory))


if __name__ == "__main__":
    main()
