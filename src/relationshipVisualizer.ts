import {
  attachRelationshipTooltip,
  IRelationshipTooltipContent
} from './relationshipTooltip';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { CodeCell } from '@jupyterlab/cells';
import { NotebookPanel } from '@jupyterlab/notebook';
import { MimeModel } from '@jupyterlab/rendermime';
import { Contents } from '@jupyterlab/services';
import { captureTableCells, TableCellSnapshot } from './tableCells';

interface RelationshipFile {
  markdownAnalyses?: MarkdownAnalysis[];
  markdownOutputAnalyses?: MarkdownOutputAnalysis[];
}

interface MarkdownAnalysis {
  markdownCell?: {
    index?: number;
  };
  relationships?: Relationship[];
}

interface Relationship {
  reason?: string;
  markdownPortion?: TextPortion;
  codeTarget?: {
    index?: number;
    scope?: 'excerpt' | 'whole_cell';
    portion?: TextPortion;
  };
}

interface MarkdownOutputAnalysis {
  markdownCell?: { index?: number };
  relationships?: OutputRelationship[];
}

interface OutputRelationship {
  confidence?: number;
  markdownPortion?: TextPortion;
  outputTarget?: {
    tableCellIds?: string[];
    tableSnapshot?: TableCellSnapshot[];
    cellIndex?: number;
    componentDescription?: string;
    outputIndex?: number;
    rectangle?: IOutputRectangle;
    rectangles?: IOutputRectangle[];
    coordinateSystem?: string;
  };
  reason?: string;
}

interface IOutputRectangle {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface TextPortion {
  endOffset?: number;
  startOffset?: number;
  text?: string;
}

interface IHighlightRegistry {
  delete(name: string): boolean;
  set(name: string, highlight: unknown): void;
}

interface IHighlightConstructor {
  new (...ranges: Range[]): unknown;
}

interface IMarkdownCellView {
  model: {
    type: string;
    sharedModel: { getSource(): string };
  };
  node: HTMLElement;
  ready: Promise<void>;
  rendered: boolean;
  renderer: { node: HTMLElement };
  showEditorForReadOnly: boolean;
}

interface IMarkdownRangeLink {
  color: string;
  key: string;
  range: Range;
  relationshipIds: string[];
}

export interface IRenderedMarkdownRelationshipTarget {
  relationshipIds: string[];
  top: number;
}

interface ICodeHighlightSpec {
  reason: string;
  color: string;
  from: number;
  relationshipId: string;
  text: string;
  to: number;
}

interface ITextOffsets {
  end: number;
  start: number;
}

const RELATIONSHIP_COLORS = [
  '#ff6b6b',
  '#4dabf7',
  '#51cf66',
  '#fcc419',
  '#cc5de8',
  '#20c997',
  '#ff922b',
  '#748ffc'
];
type MarkdownRelationshipHighlightKind = 'code' | 'output';

interface IMarkdownRelationshipHighlight {
  color: string;
  kind: MarkdownRelationshipHighlightKind;
  relationshipIds: string[];
  ranges: Range[];
}

const activeHighlightNames = new WeakMap<NotebookPanel, Set<string>>();
const activeCodeEditors = new WeakMap<NotebookPanel, Set<EditorView>>();
const highlightVersions = new WeakMap<NotebookPanel, number>();
const markdownRangeLinks = new WeakMap<HTMLElement, IMarkdownRangeLink[]>();
const relationshipReasons = new WeakMap<HTMLElement, Map<string, string>>();
const relationshipKinds = new WeakMap<
  HTMLElement,
  Map<string, 'code' | 'output'>
>();
const relationshipColors = new WeakMap<HTMLElement, Map<string, string>>();
const markdownHighlightRanges = new WeakMap<
  NotebookPanel,
  Map<string, IMarkdownRelationshipHighlight>
>();
const reasonHoverHandlers = new WeakMap<HTMLElement, () => void>();
const tooltipCleanupPanels = new WeakSet<NotebookPanel>();
const setCodeHighlights = StateEffect.define<ICodeHighlightSpec[]>({
  map: (highlights, changes) =>
    highlights.map(highlight => ({
      ...highlight,
      from: changes.mapPos(highlight.from),
      to: changes.mapPos(highlight.to)
    }))
});
const codeHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    transaction.effects.forEach(effect => {
      if (!effect.is(setCodeHighlights)) {
        return;
      }
      const marks = effect.value
        .filter(highlight => highlight.from < highlight.to)
        .map(highlight =>
          Decoration.mark({
            attributes: {
              'data-linkmaker-code-relationship': highlight.relationshipId,
              style: `--jp-linkmaker-code-highlight-color: ${highlight.color}99`
            },
            class: 'jp-LinkMaker-codePortionHighlight'
          }).range(highlight.from, highlight.to)
        );
      next = Decoration.set(marks, true);
    });
    return next;
  },
  provide: field => EditorView.decorations.from(field)
});

export async function loadRelationshipFile(
  contentsManager: Contents.IManager,
  notebookPath: string
): Promise<RelationshipFile | null> {
  const relationshipPath = buildRelationshipPath(notebookPath);
  if (!relationshipPath) {
    return null;
  }

  try {
    const model = await contentsManager.get(relationshipPath, {
      content: true
    });
    if (model.type !== 'file') {
      return null;
    }

    const content =
      typeof model.content === 'string'
        ? model.content
        : JSON.stringify(model.content);

    return JSON.parse(content) as RelationshipFile;
  } catch (error) {
    console.warn(
      `Unable to load relationship file ${relationshipPath}.`,
      error
    );
    return null;
  }
}

export async function applyRelationshipHighlights(
  panel: NotebookPanel,
  relationshipFile: RelationshipFile | null
): Promise<number> {
  if (!tooltipCleanupPanels.has(panel)) {
    panel.disposed.connect(() => clearRelationshipHighlightsInternal(panel));
    tooltipCleanupPanels.add(panel);
  }
  const version = (highlightVersions.get(panel) ?? 0) + 1;
  highlightVersions.set(panel, version);
  clearRelationshipHighlightsInternal(panel);

  if (
    !relationshipFile?.markdownAnalyses &&
    !relationshipFile?.markdownOutputAnalyses
  ) {
    return 0;
  }

  await showRelatedMarkdownRendered(panel, relationshipFile);
  if (highlightVersions.get(panel) !== version || panel.isDisposed) {
    return 0;
  }
  const renderedPortions = await renderMarkdownPortions(
    panel,
    relationshipFile
  );

  const widgets = panel.content.widgets;
  const highlightedIndexes = new Set<number>();
  const relationshipRanges = new Map<
    string,
    IMarkdownRelationshipHighlight
  >();
  const codeHighlights = new Map<HTMLElement, ICodeHighlightSpec[]>();
  const portionGroups = new Map<
    string,
    {
      color: string;
      highlightName: string;
      markdownAdded: boolean;
      ranges: Range[];
      relationshipIds: string[];
    }
  >();
  let relationshipNumber = 0;
  let portionNumber = 0;

  relationshipFile.markdownAnalyses?.forEach(analysis => {
    const markdownCellIndex = analysis.markdownCell?.index;
    const relationships = analysis.relationships ?? [];
    if (typeof markdownCellIndex !== 'number' || relationships.length === 0) {
      return;
    }

    const markdownWidget = widgets[markdownCellIndex];

    relationships.forEach(relationship => {
      const portionKey = getMarkdownPortionKey(
        markdownCellIndex,
        relationship.markdownPortion
      );
      let group = portionGroups.get(portionKey);
      if (!group) {
        const color =
          RELATIONSHIP_COLORS[portionNumber % RELATIONSHIP_COLORS.length];
        group = {
          color,
          highlightName: `${getPanelHighlightPrefix(panel)}-${portionNumber}`,
          markdownAdded: false,
          ranges: [],
          relationshipIds: []
        };
        portionGroups.set(portionKey, group);
        relationshipRanges.set(group.highlightName, {
          color: group.color,
          kind: 'code',
          relationshipIds: [],
          ranges: group.ranges
        });
        portionNumber += 1;
      }
      const { color, ranges } = group;
      group.relationshipIds.push(String(relationshipNumber));
      const renderedPortion = renderedPortions.get(portionKey) ?? '';
      const occurrence = getPortionOccurrence(
        markdownWidget?.model.sharedModel.getSource() ?? '',
        relationship.markdownPortion
      );
      const markdownRange = findNormalizedRenderedRange(
        getMarkdownRenderHost(markdownWidget?.node),
        renderedPortion,
        occurrence
      );
      if (markdownWidget) {
        markCellRelationship(
          markdownWidget.node,
          relationshipNumber,
          color,
          relationship.reason,
          'code'
        );
        markMarkdownPortionRelationship(
          markdownWidget.node,
          relationshipNumber,
          color,
          relationship.markdownPortion
        );
        if (markdownRange) {
          registerMarkdownRangeLink(
            markdownWidget.node,
            portionKey,
            markdownRange,
            relationshipNumber,
            color
          );
        }
      }
      if (markdownRange && !group.markdownAdded) {
        ranges.push(markdownRange);
        group.markdownAdded = true;
      }

      const codeCellIndex = relationship.codeTarget?.index;
      if (typeof codeCellIndex !== 'number') {
        return;
      }

      const codeWidget = widgets[codeCellIndex];
      if (codeWidget) {
        const codeOffsets = findExactSourceOffsets(
          codeWidget.model.sharedModel.getSource(),
          relationship.codeTarget?.portion
        );
        const wholeCell = relationship.codeTarget?.scope === 'whole_cell';
        if (codeOffsets) {
          markCellRelationship(
            codeWidget.node,
            relationshipNumber,
            color,
            relationship.reason,
            'code'
          );
          highlightedIndexes.add(codeCellIndex);
          const highlights = codeHighlights.get(codeWidget.node) ?? [];
          highlights.push({
            reason:
              relationship.reason?.trim() ||
              'No explanation was saved for this relationship.',
            color,
            from: codeOffsets.start,
            relationshipId: String(relationshipNumber),
            text: relationship.codeTarget?.portion?.text ?? '',
            to: codeOffsets.end
          });
          codeHighlights.set(codeWidget.node, highlights);
        }
        if (wholeCell && codeOffsets) {
          applyCellHighlight(
            codeWidget.node,
            'jp-LinkMaker-codeRelated',
            color,
            `Code relationship ${relationshipNumber + 1}`
          );
        }
      }

      relationshipNumber += 1;
    });

    if (markdownWidget) {
      highlightedIndexes.add(markdownCellIndex);
    }
  });

  await applyCodeHighlights(panel, codeHighlights);
  applyOutputRelationshipHighlights(
    panel,
    relationshipFile,
    relationshipNumber,
    renderedPortions,
    relationshipRanges,
    highlightedIndexes
  );
  applyTextHighlights(panel, relationshipRanges);
  panel.content.node.dispatchEvent(
    new CustomEvent('linkmaker:relationships-updated')
  );

  return highlightedIndexes.size;
}

/** Mark rendered chart/table outputs referenced by saved output relationships. */
function applyOutputRelationshipHighlights(
  panel: NotebookPanel,
  relationshipFile: RelationshipFile,
  relationshipOffset: number,
  renderedPortions: Map<string, string>,
  relationshipRanges: Map<string, IMarkdownRelationshipHighlight>,
  highlightedIndexes: Set<number>
): void {
  let relationshipNumber = relationshipOffset;
  relationshipFile.markdownOutputAnalyses?.forEach(analysis => {
    const markdownIndex = analysis.markdownCell?.index;
    const markdownWidget =
      typeof markdownIndex === 'number'
        ? panel.content.widgets[markdownIndex]
        : undefined;
    if (typeof markdownIndex !== 'number' || !markdownWidget) {
      return;
    }
    analysis.relationships?.forEach(relationship => {
      const target = relationship.outputTarget;
      const targetCell =
        typeof target?.cellIndex === 'number'
          ? panel.content.widgets[target.cellIndex]
          : undefined;
      const outputIndex = target?.outputIndex;
      if (!targetCell || typeof outputIndex !== 'number') {
        return;
      }
      const outputWidget =
        targetCell instanceof CodeCell
          ? targetCell.outputArea.widgets[outputIndex]
          : undefined;
      if (!outputWidget) {
        return;
      }
      const output = outputWidget.node;
      const table = output.querySelector('table');
      if (
        target?.tableCellIds &&
        (!table ||
          JSON.stringify(captureTableCells(table)) !==
            JSON.stringify(target.tableSnapshot))
      ) {
        return;
      }
      const color =
        RELATIONSHIP_COLORS[relationshipNumber % RELATIONSHIP_COLORS.length];
      const portionKey = getMarkdownPortionKey(
        markdownIndex,
        relationship.markdownPortion
      );
      const renderedPortion = renderedPortions.get(portionKey) ?? '';
      const markdownRange = findNormalizedRenderedRange(
        getMarkdownRenderHost(markdownWidget.node),
        renderedPortion,
        getPortionOccurrence(
          markdownWidget.model.sharedModel.getSource(),
          relationship.markdownPortion
        )
      );
      markCellRelationship(
        markdownWidget.node,
        relationshipNumber,
        color,
        relationship.reason,
        'output'
      );
      markMarkdownPortionRelationship(
        markdownWidget.node,
        relationshipNumber,
        color,
        relationship.markdownPortion
      );
      if (markdownRange) {
        registerMarkdownRangeLink(
          markdownWidget.node,
          portionKey,
          markdownRange,
          relationshipNumber,
          color
        );
        relationshipRanges.set(
          `${getPanelHighlightPrefix(panel)}-output-${relationshipNumber}`,
          {
            color,
            kind: 'output',
            relationshipIds: [String(relationshipNumber)],
            ranges: [markdownRange]
          }
        );
      }
      markCellRelationship(
        output,
        relationshipNumber,
        color,
        relationship.reason,
        'output'
      );
      markCellRelationship(
        targetCell.node,
        relationshipNumber,
        color,
        relationship.reason,
        'output'
      );
      markdownWidget.node.classList.add('jp-LinkMaker-markdownRelated');
      targetCell.node.classList.add('jp-LinkMaker-codeRelated');
      output.classList.add('jp-LinkMaker-outputRelated');
      output.style.setProperty('--jp-linkmaker-output-color', color);
      const description =
        target?.componentDescription ?? relationship.reason ?? '';
      output.dataset.linkmakerOutputDescription = description;
      output.dataset.linkmakerOutputRelationshipIds =
        output.dataset.linkmakerRelationshipIds ?? '';
      output.removeAttribute('title');
      for (const id of target?.tableCellIds ?? []) {
        const box = document.createElement('div');
        box.className = 'jp-LinkMaker-outputBoundingBox';
        box.dataset.linkmakerBoundingRelationshipId =
          String(relationshipNumber);
        box.dataset.linkmakerTableCellId = id;
        box.dataset.linkmakerTableSnapshot = JSON.stringify(
          target?.tableSnapshot
        );
        box.style.setProperty('--jp-linkmaker-bounding-color', color);
        box.setAttribute('aria-hidden', 'true');
        output.appendChild(box);
      }
      const rectangles =
        target?.coordinateSystem === 'normalized-top-left-1000-v1'
          ? (target.rectangles ?? []).filter(isOutputRectangle)
          : target?.coordinateSystem === undefined &&
              isOutputRectangle(target?.rectangle)
            ? [
                {
                  ...target.rectangle,
                  y: 1000 - target.rectangle.y - target.rectangle.height
                }
              ]
            : [];
      for (const rectangle of rectangles) {
        addOutputBoundingBox(
          output,
          relationshipNumber,
          rectangle,
          color
        );
      }
      highlightedIndexes.add(markdownIndex);
      if (typeof target?.cellIndex === 'number') {
        highlightedIndexes.add(target.cellIndex);
      }
      relationshipNumber += 1;
    });
  });
}

/**
 * Render related Markdown cells using JupyterLab's native Markdown renderer.
 */
async function showRelatedMarkdownRendered(
  panel: NotebookPanel,
  relationshipFile: RelationshipFile
): Promise<void> {
  const cellsToWaitFor: IMarkdownCellView[] = [];
  const analyses = [
    ...(relationshipFile.markdownAnalyses ?? []),
    ...(relationshipFile.markdownOutputAnalyses ?? [])
  ];
  analyses.forEach(analysis => {
    if (!analysis.relationships?.length) {
      return;
    }

    const index = analysis.markdownCell?.index;
    if (typeof index !== 'number') {
      return;
    }

    const cell = panel.content.widgets[index] as unknown as IMarkdownCellView;
    if (cell?.model.type === 'markdown') {
      cell.rendered = true;
      cellsToWaitFor.push(cell);
    }
  });

  await Promise.all(cellsToWaitFor.map(cell => waitForMarkdownRenderer(cell)));
}

/** Wait until the native Markdown renderer is populated. */
async function waitForMarkdownRenderer(cell: IMarkdownCellView): Promise<void> {
  await cell.ready;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (cell.rendered && cell.renderer.node.childNodes.length > 0) {
      return;
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
}

/** Render each distinct JSON excerpt with the notebook's own Markdown renderer. */
async function renderMarkdownPortions(
  panel: NotebookPanel,
  relationshipFile: RelationshipFile
): Promise<Map<string, string>> {
  const portions = new Map<string, string>();
  relationshipFile.markdownAnalyses?.forEach(analysis => {
    const markdownCellIndex = analysis.markdownCell?.index;
    if (typeof markdownCellIndex !== 'number') {
      return;
    }
    analysis.relationships?.forEach(relationship => {
      const key = getMarkdownPortionKey(
        markdownCellIndex,
        relationship.markdownPortion
      );
      const text = relationship.markdownPortion?.text;
      if (typeof text === 'string' && !portions.has(key)) {
        portions.set(key, text);
      }
    });
  });
  relationshipFile.markdownOutputAnalyses?.forEach(analysis => {
    const markdownCellIndex = analysis.markdownCell?.index;
    if (typeof markdownCellIndex !== 'number') {
      return;
    }
    analysis.relationships?.forEach(relationship => {
      const key = getMarkdownPortionKey(
        markdownCellIndex,
        relationship.markdownPortion
      );
      const text = relationship.markdownPortion?.text;
      if (typeof text === 'string' && !portions.has(key)) {
        portions.set(key, text);
      }
    });
  });

  await Promise.all(
    [...portions.entries()].map(async ([key, source]) => {
      const renderer = panel.content.rendermime.createRenderer('text/markdown');
      try {
        await renderer.renderModel(
          new MimeModel({
            data: { 'text/markdown': source },
            trusted: false
          })
        );
        portions.set(key, buildNormalizedDomText(renderer.node).text);
      } finally {
        renderer.dispose();
      }
    })
  );
  return portions;
}

export function clearRelationshipHighlights(panel: NotebookPanel): void {
  highlightVersions.set(panel, (highlightVersions.get(panel) ?? 0) + 1);
  clearRelationshipHighlightsInternal(panel);
}

function clearRelationshipHighlightsInternal(panel: NotebookPanel): void {
  clearCodeHighlights(panel);
  const registry = getHighlightRegistry();
  activeHighlightNames.get(panel)?.forEach(name => registry?.delete(name));
  activeHighlightNames.delete(panel);
  markdownHighlightRanges.delete(panel);
  document.getElementById(getPanelStyleId(panel))?.remove();
  panel.content.widgets.forEach(widget => {
    widget.removeClass('jp-LinkMaker-markdownRelated');
    widget.removeClass('jp-LinkMaker-codeRelated');
    widget.removeClass('jp-LinkMaker-preciseMarkdownLink');
    widget.node.removeAttribute('data-linkmaker-relationship-count');
    widget.node.removeAttribute('data-linkmaker-relationship-highlight');
    widget.node.removeAttribute('data-linkmaker-relationship-ids');
    widget.node.removeAttribute('data-linkmaker-relationship-colors');
    widget.node.removeAttribute('data-linkmaker-markdown-links');
    widget.node.removeAttribute('data-linkmaker-output-relationship-ids');
    markdownRangeLinks.delete(widget.node);
    clearRelationshipReasons(widget.node);
    widget.node.removeAttribute('title');
    widget.node.style.removeProperty('background-color');
    widget.node.style.removeProperty('background-image');
    widget.node.style.removeProperty('outline');
    widget.node.style.removeProperty('outline-offset');
  });
  panel.content.node
    .querySelectorAll<HTMLElement>('.jp-LinkMaker-outputRelated')
    .forEach(output => {
      output.classList.remove('jp-LinkMaker-outputRelated');
      output.style.removeProperty('--jp-linkmaker-output-color');
      output.removeAttribute('data-linkmaker-output-description');
      output.removeAttribute('data-linkmaker-output-relationship-ids');
      output.removeAttribute('title');
      clearRelationshipReasons(output);
    });
  panel.content.node
    .querySelectorAll<HTMLElement>('.jp-LinkMaker-outputBoundingBox')
    .forEach(box => box.remove());
}

/** Store a normalized model rectangle as a focus-only output overlay. */
function addOutputBoundingBox(
  output: HTMLElement,
  relationshipNumber: number,
  rectangle: IOutputRectangle,
  color: string
): void {
  const box = document.createElement('div');
  box.className = 'jp-LinkMaker-outputBoundingBox';
  box.dataset.linkmakerBoundingRelationshipId = String(relationshipNumber);
  box.dataset.linkmakerBoundingX = String(rectangle.x);
  box.dataset.linkmakerBoundingY = String(rectangle.y);
  box.dataset.linkmakerBoundingWidth = String(rectangle.width);
  box.dataset.linkmakerBoundingHeight = String(rectangle.height);
  box.style.setProperty('--jp-linkmaker-bounding-color', color);
  box.setAttribute('aria-hidden', 'true');
  output.appendChild(box);
}

/** Validate normalized coordinates before adding them to the notebook DOM. */
function isOutputRectangle(value: unknown): value is IOutputRectangle {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rectangle = value as Partial<IOutputRectangle>;
  const { x, y, width, height } = rectangle;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1000 &&
    y + height <= 1000
  );
}

/**
 * Highlight exact rendered source ranges without changing notebook cell content.
 */
function applyTextHighlights(
  panel: NotebookPanel,
  relationshipRanges: Map<string, IMarkdownRelationshipHighlight>
): void {
  const registry = getHighlightRegistry();
  const HighlightConstructor = getHighlightConstructor();
  if (!registry || !HighlightConstructor) {
    return;
  }

  const rules: string[] = [];
  const panelHighlightNames = new Set<string>();
  relationshipRanges.forEach(({ color, kind, ranges }, name) => {
    registry.set(name, new HighlightConstructor(...ranges));
    panelHighlightNames.add(name);
    const style =
      kind === 'code'
        ? `background-color: transparent; text-decoration: underline 3px ${color}; text-underline-offset: 3px;`
        : `background-color: ${color}66; text-decoration: underline 2px ${color}; text-underline-offset: 3px;`;
    rules.push(
      `::highlight(${name}) { ${style} color: var(--jp-ui-font-color0); }`
    );
  });

  const style = document.createElement('style');
  style.id = getPanelStyleId(panel);
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
  activeHighlightNames.set(panel, panelHighlightNames);
  markdownHighlightRanges.set(panel, relationshipRanges);
}

/** Show only the clicked Markdown relationship while a precise lookup is pinned. */
export function setPreciseMarkdownHighlights(
  panel: NotebookPanel,
  relationshipIds: string[] | null
): void {
  const registry = getHighlightRegistry();
  const HighlightConstructor = getHighlightConstructor();
  const ranges = markdownHighlightRanges.get(panel);
  if (!registry || !HighlightConstructor || !ranges) {
    return;
  }
  ranges.forEach((highlight, name) => {
    registry.delete(name);
    if (
      relationshipIds === null ||
      highlight.relationshipIds.some(id => relationshipIds.includes(id))
    ) {
      registry.set(name, new HighlightConstructor(...highlight.ranges));
    }
  });
}

function getPanelHighlightPrefix(panel: NotebookPanel): string {
  return `linkmaker-${panel.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-relationship`;
}

function getPanelStyleId(panel: NotebookPanel): string {
  return `${getPanelHighlightPrefix(panel)}-style`;
}

function getMarkdownRenderHost(
  cellNode: HTMLElement | undefined
): HTMLElement | undefined {
  return (
    cellNode?.querySelector<HTMLElement>('.jp-MarkdownOutput') ??
    cellNode?.querySelector<HTMLElement>('.jp-RenderedHTMLCommon') ??
    undefined
  );
}

interface IDomCharacterPosition {
  endOffset: number;
  node: Text;
  startOffset: number;
}

interface INormalizedDomText {
  positions: IDomCharacterPosition[];
  text: string;
}

/** Build normalized visible text while retaining a position for every character. */
function buildNormalizedDomText(root: HTMLElement): INormalizedDomText {
  const characters: string[] = [];
  const positions: IDomCharacterPosition[] = [];
  let whitespace: IDomCharacterPosition | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    const textNode = current as Text;
    for (let offset = 0; offset < textNode.data.length; offset += 1) {
      const character = textNode.data[offset];
      const position = {
        node: textNode,
        startOffset: offset,
        endOffset: offset + 1
      };
      if (/\s/u.test(character)) {
        whitespace = whitespace ?? position;
        continue;
      }
      if (whitespace && characters.length > 0) {
        characters.push(' ');
        positions.push(whitespace);
      }
      whitespace = null;
      characters.push(character);
      positions.push(position);
    }
    current = walker.nextNode();
  }

  return { text: characters.join(''), positions };
}

/** Locate a rendered excerpt and convert it back into a browser DOM range. */
function findNormalizedRenderedRange(
  root: HTMLElement | undefined,
  target: string,
  occurrence: number
): Range | null {
  if (!root || !target) {
    return null;
  }
  const normalized = buildNormalizedDomText(root);
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = normalized.text.indexOf(target, from);
    if (start < 0) {
      return null;
    }
    from = start + Math.max(1, target.length);
  }
  const first = normalized.positions[start];
  const last = normalized.positions[start + target.length - 1];
  if (!first || !last) {
    return null;
  }
  const range = document.createRange();
  range.setStart(first.node, first.startOffset);
  range.setEnd(last.node, last.endOffset);
  return range;
}

/** Determine which identical source occurrence the JSON offsets identify. */
function getPortionOccurrence(
  source: string,
  portion: TextPortion | undefined
): number {
  const text = portion?.text;
  const startOffset = portion?.startOffset;
  if (typeof text !== 'string' || !text || typeof startOffset !== 'number') {
    return 0;
  }
  let occurrence = 0;
  let from = 0;
  while (from < startOffset) {
    const found = source.indexOf(text, from);
    if (found < 0 || found >= startOffset) {
      break;
    }
    occurrence += 1;
    from = found + Math.max(1, text.length);
  }
  return occurrence;
}

function registerMarkdownRangeLink(
  cellNode: HTMLElement,
  key: string,
  range: Range,
  relationshipNumber: number,
  color: string
): void {
  const entries = markdownRangeLinks.get(cellNode) ?? [];
  let entry = entries.find(candidate => candidate.key === key);
  if (!entry) {
    entry = {
      color,
      key,
      range,
      relationshipIds: []
    };
    entries.push(entry);
    markdownRangeLinks.set(cellNode, entries);
  }
  const relationshipId = String(relationshipNumber);
  if (!entry.relationshipIds.includes(relationshipId)) {
    entry.relationshipIds.push(relationshipId);
  }
}

/** Resolve relationship IDs when the pointer is inside a rendered highlight. */
export function getRenderedMarkdownRelationshipIdsAtPoint(
  cellNode: HTMLElement,
  clientX: number,
  clientY: number
): string[] | null {
  return (
    getRenderedMarkdownRelationshipTargetAtPoint(cellNode, clientX, clientY)
      ?.relationshipIds ?? null
  );
}

/** Resolve the exact rendered highlight and the line where it is displayed. */
export function getRenderedMarkdownRelationshipTargetAtPoint(
  cellNode: HTMLElement,
  clientX: number,
  clientY: number
): IRenderedMarkdownRelationshipTarget | null {
  const entries = markdownRangeLinks.get(cellNode);
  if (!entries?.length) {
    return null;
  }
  const point = getCaretPoint(clientX, clientY);
  const matches = entries
    .map(entry => ({
      entry,
      rect: findRangeRectAtPoint(entry.range, clientX, clientY)
    }))
    .filter(
      candidate =>
        candidate.rect !== null ||
        (point !== null &&
          candidate.entry.range.isPointInRange(point.node, point.offset))
    );
  if (matches.length === 0) {
    return null;
  }
  const relationshipIds = [
    ...new Set(matches.flatMap(match => match.entry.relationshipIds))
  ];
  const hoveredTops = matches
    .map(match => match.rect?.top)
    .filter((top): top is number => typeof top === 'number');
  const fallbackTop = matches[0].entry.range.getBoundingClientRect().top;
  return {
    relationshipIds,
    top: hoveredTops.length > 0 ? Math.min(...hoveredTops) : fallbackTop
  };
}

/** Find the visual line rectangle of a possibly wrapped rendered range. */
function findRangeRectAtPoint(
  range: Range,
  clientX: number,
  clientY: number
): DOMRect | null {
  const rectangles = Array.from(range.getClientRects());
  return (
    rectangles.find(
      rectangle =>
        clientX >= rectangle.left &&
        clientX <= rectangle.right &&
        clientY >= rectangle.top &&
        clientY <= rectangle.bottom
    ) ?? null
  );
}

function getCaretPoint(
  clientX: number,
  clientY: number
): { node: Node; offset: number } | null {
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offset: number; offsetNode: Node } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);
  if (position) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = caretDocument.caretRangeFromPoint?.(clientX, clientY);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

/** Verify the JSON portion against source text and return source offsets. */
function findExactSourceOffsets(
  source: string,
  portion: TextPortion | undefined
): ITextOffsets | null {
  const text = portion?.text;
  if (typeof text !== 'string' || !text) {
    return null;
  }

  const requestedStart = portion?.startOffset;
  const requestedEnd = portion?.endOffset;
  let start = -1;
  if (
    typeof requestedStart === 'number' &&
    typeof requestedEnd === 'number' &&
    requestedStart >= 0 &&
    requestedEnd >= requestedStart &&
    source.slice(requestedStart, requestedEnd) === text
  ) {
    start = requestedStart;
  } else {
    start = source.indexOf(text);
  }
  if (start < 0) {
    return null;
  }
  return { start, end: start + text.length };
}

/** Apply persistent CodeMirror decorations from verified source offsets. */
async function applyCodeHighlights(
  panel: NotebookPanel,
  highlightsByCell: Map<HTMLElement, ICodeHighlightSpec[]>
): Promise<void> {
  const editors = new Set<EditorView>();
  await Promise.all(
    [...highlightsByCell.entries()].map(async ([cellNode, highlights]) => {
      const editor = await waitForCodeEditor(cellNode);
      if (!editor) {
        console.warn(
          'A related code cell was not mounted, so its exact highlight was deferred.'
        );
        return;
      }
      const validHighlights = highlights.filter(
        highlight =>
          highlight.from >= 0 &&
          highlight.from < highlight.to &&
          highlight.to <= editor.state.doc.length &&
          editor.state.doc.sliceString(highlight.from, highlight.to) ===
            highlight.text
      );
      if (validHighlights.length !== highlights.length) {
        console.warn(
          'Skipped a code highlight whose JSON span did not match the active editor text.'
        );
      }
      if (!editor.state.field(codeHighlightField, false)) {
        editor.dispatch({
          effects: StateEffect.appendConfig.of([codeHighlightField])
        });
      }
      editor.dispatch({ effects: setCodeHighlights.of(validHighlights) });
      editors.add(editor);
    })
  );
  activeCodeEditors.set(panel, editors);
}

/** Wait briefly for JupyterLab to mount a code cell's CodeMirror view. */
async function waitForCodeEditor(
  cellNode: HTMLElement
): Promise<EditorView | null> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const content = cellNode.querySelector<HTMLElement>('.cm-content');
    const editor = content ? EditorView.findFromDOM(content) : null;
    if (!editor) {
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => resolve())
      );
      continue;
    }
    return editor;
  }
  return null;
}

/** Remove LinkMaker decorations while leaving other editor extensions intact. */
function clearCodeHighlights(panel: NotebookPanel): void {
  activeCodeEditors.get(panel)?.forEach(editor => {
    if (editor.state.field(codeHighlightField, false)) {
      editor.dispatch({ effects: setCodeHighlights.of([]) });
    }
  });
  activeCodeEditors.delete(panel);
}

/** Stable visual grouping derived only from the JSON Markdown portion. */
function getMarkdownPortionKey(
  markdownCellIndex: number,
  portion: TextPortion | undefined
): string {
  return JSON.stringify([
    markdownCellIndex,
    portion?.startOffset ?? null,
    portion?.endOffset ?? null,
    portion?.text ?? ''
  ]);
}

function getHighlightRegistry(): IHighlightRegistry | null {
  const css = CSS as typeof CSS & { highlights?: IHighlightRegistry };
  return css.highlights ?? null;
}

function getHighlightConstructor(): IHighlightConstructor | null {
  const global = globalThis as typeof globalThis & {
    Highlight?: IHighlightConstructor;
  };
  return global.Highlight ?? null;
}

/**
 * Apply inline styles so highlights remain visible even if a theme overrides CSS.
 */
function applyCellHighlight(
  node: HTMLElement,
  className: string,
  color: string,
  label: string
): void {
  node.classList.add(className);
  node.setAttribute('data-linkmaker-relationship-highlight', 'true');
  node.setAttribute('aria-label', label);
  node.style.setProperty('background-color', `${color}14`, 'important');
  node.style.setProperty('outline', `1px solid ${color}`, 'important');
  node.style.setProperty('outline-offset', '-3px', 'important');
}

/** Store every relationship color on its source cell without overwriting prior ones. */
function markCellRelationship(
  node: HTMLElement,
  relationshipNumber: number,
  color: string,
  reason?: string,
  kind: 'code' | 'output' = 'code'
): void {
  const ids =
    node.dataset.linkmakerRelationshipIds?.split(',').filter(Boolean) ?? [];
  const colors = getRelationshipColors(node);
  const relationshipId = String(relationshipNumber);
  if (!ids.includes(relationshipId)) {
    ids.push(relationshipId);
    colors.push(color);
  }
  node.dataset.linkmakerRelationshipIds = ids.join(',');
  node.dataset.linkmakerRelationshipColors = colors.join(',');
  const reasons = relationshipReasons.get(node) ?? new Map<string, string>();
  reasons.set(
    relationshipId,
    reason?.trim() || 'No explanation was saved for this relationship.'
  );
  relationshipReasons.set(node, reasons);
  const kinds = relationshipKinds.get(node) ?? new Map();
  kinds.set(relationshipId, kind);
  relationshipKinds.set(node, kinds);
  if (kind === 'output') {
    const outputRelationshipIds =
      node.dataset.linkmakerOutputRelationshipIds
        ?.split(',')
        .filter(Boolean) ?? [];
    if (!outputRelationshipIds.includes(relationshipId)) {
      outputRelationshipIds.push(relationshipId);
    }
    node.dataset.linkmakerOutputRelationshipIds =
      outputRelationshipIds.join(',');
  }
  const relationshipColorsForNode =
    relationshipColors.get(node) ?? new Map<string, string>();
  relationshipColorsForNode.set(relationshipId, color);
  relationshipColors.set(node, relationshipColorsForNode);
  node.removeAttribute('title');
  if (!reasonHoverHandlers.has(node)) {
    const dispose = attachRelationshipTooltip(node, event => {
      const codeMark =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              '[data-linkmaker-code-relationship]'
            )
          : null;
      const codeId = codeMark?.dataset.linkmakerCodeRelationship;
      const boundingBox =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              '.jp-LinkMaker-outputBoundingBox'
            )
          : null;
      const boundingId =
        boundingBox?.dataset.linkmakerBoundingRelationshipId;
      const target =
        event instanceof PointerEvent
          ? getRenderedMarkdownRelationshipTargetAtPoint(
              node,
              event.clientX,
              event.clientY
            )
          : null;
      if (boundingId) {
        return getRelationshipTooltipContent(node, [boundingId], true);
      }
      return getRelationshipTooltipContent(
        node,
        codeId ? [codeId] : target?.relationshipIds
      );
    });
    reasonHoverHandlers.set(node, dispose);
  }
}

/** Show saved explanations for the exact Markdown portion, or the whole cell. */
function getRelationshipTooltipContent(
  node: HTMLElement,
  ids?: string[],
  onlyActive = false
): IRelationshipTooltipContent {
  const reasons = relationshipReasons.get(node);
  if (!reasons) {
    return { activeIds: [], entries: [] };
  }
  const kinds = relationshipKinds.get(node) ?? new Map();
  const colors = relationshipColors.get(node) ?? new Map();
  const activeIds = ids ?? [];
  return {
    activeIds,
    entries: [...reasons]
      .filter(([id]) => !onlyActive || activeIds.includes(id))
      .map(([id, text]) => ({
        color: colors.get(id) ?? 'var(--jp-brand-color1)',
        id,
        kind: kinds.get(id) ?? 'code',
        text
      }))
  };
}

/** Release hover listeners and explanations when relationships are refreshed. */
function clearRelationshipReasons(node: HTMLElement): void {
  const handler = reasonHoverHandlers.get(node);
  if (handler) {
    handler();
  }
  reasonHoverHandlers.delete(node);
  relationshipReasons.delete(node);
  relationshipKinds.delete(node);
  relationshipColors.delete(node);
}

/** Store JSON offsets so pointer selection can target one Markdown portion. */
function markMarkdownPortionRelationship(
  node: HTMLElement,
  relationshipNumber: number,
  color: string,
  portion: TextPortion | undefined
): void {
  if (
    typeof portion?.startOffset !== 'number' ||
    typeof portion.endOffset !== 'number' ||
    typeof portion.text !== 'string'
  ) {
    return;
  }
  const links = getMarkdownPortionRelationships(node);
  links.push({
    id: String(relationshipNumber),
    color,
    startOffset: portion.startOffset,
    endOffset: portion.endOffset,
    text: portion.text
  });
  node.dataset.linkmakerMarkdownLinks = JSON.stringify(links);
}

interface IMarkdownPortionRelationship {
  color: string;
  endOffset: number;
  id: string;
  startOffset: number;
  text: string;
}

function getMarkdownPortionRelationships(
  node: HTMLElement
): IMarkdownPortionRelationship[] {
  const value = node.dataset.linkmakerMarkdownLinks;
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isMarkdownPortionRelationship)
      : [];
  } catch {
    return [];
  }
}

function isMarkdownPortionRelationship(
  value: unknown
): value is IMarkdownPortionRelationship {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<IMarkdownPortionRelationship>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.color === 'string' &&
    typeof candidate.startOffset === 'number' &&
    typeof candidate.endOffset === 'number' &&
    typeof candidate.text === 'string'
  );
}

/** Read the relationship colors registered on a notebook cell. */
function getRelationshipColors(node: HTMLElement): string[] {
  return (
    node.dataset.linkmakerRelationshipColors?.split(',').filter(Boolean) ?? []
  );
}

function buildRelationshipPath(notebookPath: string): string | null {
  if (!notebookPath.toLowerCase().endsWith('.ipynb')) {
    return null;
  }

  return notebookPath.replace(/\.ipynb$/i, '.linkmaker.json');
}
