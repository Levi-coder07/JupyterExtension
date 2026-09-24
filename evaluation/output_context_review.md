# Execution-output context evaluation

## Verdict

Promising additional evidence with negligible local extraction overhead, but an
improvement in model accuracy has not yet been demonstrated. No live comparison
was run because OPENAI_API_KEY was unavailable in the evaluation environment.

## Measurements

Measured against the current Titanic notebook and current relationship prompt:

| Measure                                               | Result                    |
| ----------------------------------------------------- | ------------------------- |
| Markdown cells                                        | 49                        |
| Code cells                                            | 52                        |
| Code cells with extracted output text                 | 49 (94.2%)                |
| Extracted output characters                           | 14,641                    |
| Prompt characters without output fields               | 46,236                    |
| Prompt characters with output fields                  | 62,035                    |
| Prompt growth                                         | 15,799 characters (34.2%) |
| Cells truncated by the output limit                   | 0                         |
| Median complete cell extraction, 100 local iterations | 0.0955 ms                 |
| Existing automated tests                              | 17 passed                 |

Both prompt-size measurements use the new instructions; the comparison isolates
the output fields, not the full old-versus-new implementation. Character counts
are not token counts. Extraction timing excludes API latency and model execution;
it is a local microbenchmark, not a production latency estimate. Python syntax
checks passed. No model accuracy, token usage, or API latency was measured.

Two other local notebooks had no usable output text (one and six code cells),
and including optional context caused no prompt-size increase for them.

## Benefits and limitations

The Titanic model-summary output exposes the actual scores, including 86.76 for
both Random Forest and Decision Tree. That supplies evidence for Markdown claims
about equal scores which variable names alone cannot establish. This is a
qualitative benefit, not proof that model predictions improve.

The extractor includes streams, error summaries and tracebacks, and display or
execution results. It prefers plain text, then Markdown, then extracted HTML.
Source-span validation still prevents output text from becoming a code target.
Tests verify that context reaches the model request and that absent/nontext
outputs are omitted. Existing tests do not establish semantic link quality.

Additional output can also introduce unrelated warnings, repeat data across
cells, or reflect an earlier execution. The prompt cautions about stale outputs,
but freshness is not validated. The per-cell limit does not bound total notebook
context. Increased input size can increase token usage and processing time;
neither increase was measured here.

## Confirmed edge cases

1. Separate stream chunks `Accu` and `racy: 95%` become
   `Accu\n\nracy: 95%`. Inserting separators and stripping each chunk can alter
   messages emitted incrementally, reducing their usefulness for matching.
2. HTML `<div>Accuracy<br>95%</div>` becomes `Accuracy95%`. The fallback loses
   the line break and merges adjacent values or labels.

These additional probes expose gaps despite the 17 passing tests. They were
evaluated without modifying production behavior during this review.

## Accuracy evaluation still needed

The previous evaluation report identifies the Titanic reference as a manual
relationship file: 38 code labels collapsed into 36 unique Markdown/code pairs.
The JSON filename and legacy metadata alone do not establish that it is model
generated. My initial review inferred that incorrectly. This is the established
project benchmark and should be retained for comparisons. The report notes that
manual labels may be incomplete, so unmatched predictions still merit review.

## Previous evaluations and current saved result

Recomputed from the archived raw JSON using the existing exact-cell-pair scorer:

| Configuration                              | Runs | Precision | Recall | F1    |
| ------------------------------------------ | ---- | --------- | ------ | ----- |
| GPT-5 mini, low reasoning                  | 3    | 71.2%     | 73.1%  | 72.1% |
| GPT-5.4 mini, low reasoning                | 3    | 53.0%     | 88.9%  | 66.4% |
| GPT-5 nano, low reasoning, model matrix    | 1    | 83.3%     | 13.9%  | 23.8% |
| Current titanic.linkmaker.json, GPT-5 mini | 1    | 64.9%     | 66.7%  | 65.8% |

Historical multi-run metrics are pooled, matching the previous report. The
current saved file contains 37 unique predicted pairs: 24 true positives,
13 benchmark false positives, and 12 false negatives. Compared with the
historical GPT-5 mini pooled result, precision is lower by 6.3 percentage points,
recall by 6.5, and F1 by 6.4. Historical mini per-run F1 ranged from 65.8% to
76.5%, so this current result is essentially at the prior observed lower end.

The current file records the model but no prompt version, output-context flag,
reasoning setting, input snapshot, or run timestamp. It cannot be confidently
attributed to the execution-output change. If confirmed as a run with the new
context enabled, it shows no improvement on this benchmark in this single run;
it does not establish a reliable regression across repeated runs.

Additional prior experiments are documented in the evaluation report: five-run
nano prompt experiments (v0 F1 16.5%, v1 4.3%, v2 31.1%) and a single nano
medium-reasoning run (F1 74.7%). They are not matched controls for the current
GPT-5 mini configuration. The report's v2 user-run archive is distinct from the
other v2 files, and its first raw user run was not retained. A separate House
reference contains 15 code labels, but its source notebook is not in the project
root. The Markdown-to-output experiment measures a different target task.

For a defensible comparison, reuse the existing frozen 36-pair benchmark for continuity and separately
review unmatched output-supported links without changing labels to favor a run.
Use identical notebook snapshots, model, reasoning settings, and validation for
at least three repeated runs per condition: previous source-only behavior and
new output-aware behavior. Report precision, recall, F1, invalid source spans,
API latency, input/output tokens, and run-to-run variation. Review added and
removed links manually, including exact excerpt quality. Include errors, stale
outputs, repeated tables, large outputs, and notebooks without output text.
An additional ablation with the same new instructions but output fields removed
would distinguish the effect of added evidence from the instruction changes.

The current conclusion is to retain this as a candidate improvement, address
the two formatting cases, and withhold claims of higher accuracy until that
controlled comparison is complete.
