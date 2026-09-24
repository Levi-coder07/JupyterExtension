# Localization prompt revision

The observed failures paired descriptions of tiny bars or narrow age intervals
with rectangles covering entire panels. The renderer displayed the model's
saved coordinates. This revision targets that semantic/geometric mismatch.

Changes: explicit tick-anchor calibration; linear versus logarithmic/reversed
axis handling; confirmation against visible mark edges; baseline-to-tip bar
height; separate regions for separate facets; no whole-panel fallback for
uncertain small targets; inverse range checking; confidence reflecting both
semantic and spatial uncertainty. A synthetic interval example illustrates
calibration without copying Titanic coordinates. Unsupported percentages and
majority claims must be omitted. Table bounds cannot be inferred reliably from
HTML row order alone.

The revision replaces the previous output prompt only. Model, reasoning setting,
single-request architecture, rectangle schema, and Markdown-to-code prompt are
unchanged. Python syntax validation and the 20 existing unit tests pass; these
verify software compatibility, not vision accuracy. No fresh model evaluation
has established an improvement.

Research consulted:

- [ChartPoint (ICCV 2025)](https://arxiv.org/abs/2512.00305)
  connects chart reasoning with box annotations and rendered visual feedback,
  with specialized instruction tuning. The consistency check here is inspired
  by that grounding objective; this implementation does not reproduce its
  feedback loop, training, or measured results.
- [ChartREG++ (2026 preprint)](https://arxiv.org/abs/2605.07415)
  studies multiple target grounding and finer localization, including masks and
  a trained segmentation component. It supports evaluating individual marks
  rather than accepting a panel box. This implementation retains rectangles
  and does not implement segmentation.
- [OpenAI vision guidance](https://developers.openai.com/api/docs/guides/images-vision)
  documents limitations in precise spatial localization. Prompt instructions
  alone cannot guarantee accurate boxes.

Next evaluation should use fixed captured images and human-marked target boxes.
Compare old/new prompts on identical inputs and settings across repeated runs.
Measure per-target intersection-over-union, target coverage, unrelated highlighted
area, missed/extra regions, and unsupported-link rate. Match multiple boxes to
individual targets rather than comparing only their enclosing union. Include
tiny bars, intervals spanning facets, reversed/log scales, and table cells. If
localization remains poor, rendered-box verification or programmatic element
bounds is a separate architectural experiment, not another wording guarantee.
