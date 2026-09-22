import { DocumentRegistry } from '@jupyterlab/docregistry';
import {
  INotebookModel,
  NotebookPanel,
  StaticNotebook
} from '@jupyterlab/notebook';

import { DisposableDelegate, IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';

import { getRenderedMarkdownRelationshipTargetAtPoint } from './relationshipVisualizer';

interface ILayoutState {
  notebookConfig: StaticNotebook.INotebookConfig;
  viewportStyle: IGridStyle;
  cellStyles: Map<HTMLElement, IGridStyle>;
  markdownColumn: HTMLElement;
  codeColumn: HTMLElement;
  observer: MutationObserver;
  arrangeScheduled: boolean;
  markdownFocusHandlers: Map<HTMLElement, IMarkdownFocusHandlers>;
  codeFocusHandlers: Map<HTMLElement, ICodeFocusHandlers>;
  activeMarkdownCell: HTMLElement | null;
  unrelatedCodeCells: HTMLElement[];
  unrelatedToggle: HTMLButtonElement;
  unrelatedToggleHandler: EventListener;
  viewportPointerLeaveHandler: EventListener;
  keyDownHandler: EventListener;
  focusResetTimer: number | null;
  resizeHandler: EventListener;
  unrelatedVisible: boolean;
  activeFocusKey: string | null;
  activeAnchorTop: number | null;
  pinnedFocusKey: string | null;
}

interface IMarkdownFocusHandlers {
  pointerDown: EventListener;
  pointerEnter: EventListener;
  pointerLeave: EventListener;
  pointerMove: EventListener;
}

interface ICodeFocusHandlers {
  click: EventListener;
  pointerEnter: EventListener;
  pointerLeave: EventListener;
}

interface IMarkdownFocusTarget {
  anchorClientTop: number;
  relationshipIds: string[];
}

interface IMarkdownPortionLink {
  color: string;
  endOffset: number;
  id: string;
  startOffset: number;
  text: string;
}

interface IGridStyle {
  display: string;
  gridAutoFlow: string;
  gridTemplateColumns: string;
  alignItems: string;
  columnGap: string;
  gridColumn: string;
  minHeight: string;
  position: string;
}

const ACTIVE_LAYOUT_CLASS = 'jp-LinkMaker-twoColumnNotebook';
export const LINKMAKER_LAYOUT_CHANGED_EVENT =
  'linkmaker:two-column-layout-changed';
const layoutStates = new WeakMap<NotebookPanel, ILayoutState>();

/** Return whether a notebook is currently using LinkMaker's two-column layout. */
export function isTwoColumnLayout(panel: NotebookPanel): boolean {
  return panel.content.hasClass(ACTIVE_LAYOUT_CLASS);
}

/** Toggle the active notebook between the default and two-column layouts. */
export function toggleTwoColumnLayout(panel: NotebookPanel): boolean {
  if (isTwoColumnLayout(panel)) {
    const state = layoutStates.get(panel);
    if (state) {
      panel.content.notebookConfig = state.notebookConfig;
      restoreColumnLayout(panel, state);
      layoutStates.delete(panel);
    }
    panel.content.removeClass(ACTIVE_LAYOUT_CLASS);
    panel.content.update();
    panel.content.node.dispatchEvent(new Event(LINKMAKER_LAYOUT_CHANGED_EVENT));
    return false;
  }

  const unrelatedToggle = document.createElement('button');
  const state: ILayoutState = {
    notebookConfig: { ...panel.content.notebookConfig },
    viewportStyle: readGridStyle(panel.content.viewportNode),
    cellStyles: new Map(),
    markdownColumn: document.createElement('div'),
    codeColumn: document.createElement('div'),
    observer: new MutationObserver(() => undefined),
    arrangeScheduled: false,
    markdownFocusHandlers: new Map(),
    codeFocusHandlers: new Map(),
    activeMarkdownCell: null,
    unrelatedCodeCells: [],
    unrelatedToggle,
    unrelatedToggleHandler: () => undefined,
    viewportPointerLeaveHandler: () => undefined,
    keyDownHandler: () => undefined,
    focusResetTimer: null,
    resizeHandler: () => undefined,
    unrelatedVisible: false,
    activeFocusKey: null,
    activeAnchorTop: null,
    pinnedFocusKey: null
  };
  state.unrelatedToggleHandler = () => toggleUnrelatedCodeCells(panel, state);
  state.viewportPointerLeaveHandler = () => scheduleFocusReset(panel, state);
  state.resizeHandler = () => refreshActiveOutputBoundingBoxes(panel, state);
  state.keyDownHandler = event => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') {
      resetCodeAccordionState(panel, state);
    }
  };
  unrelatedToggle.type = 'button';
  unrelatedToggle.className = 'jp-LinkMaker-unrelatedToggle';
  unrelatedToggle.hidden = true;
  unrelatedToggle.addEventListener('click', state.unrelatedToggleHandler);
  panel.content.node.addEventListener(
    'pointerleave',
    state.viewportPointerLeaveHandler
  );
  window.addEventListener('resize', state.resizeHandler);
  window.addEventListener('keydown', state.keyDownHandler);
  layoutStates.set(panel, state);
  panel.content.notebookConfig = {
    ...panel.content.notebookConfig,
    // A grid needs all cell widgets attached. JupyterLab windowing is restored
    // unchanged when this layout is turned off.
    windowingMode: 'none'
  };
  panel.content.addClass(ACTIVE_LAYOUT_CLASS);
  applyColumnLayout(panel, state);
  panel.content.update();
  panel.content.node.dispatchEvent(new Event(LINKMAKER_LAYOUT_CHANGED_EVENT));
  return true;
}

/** Create independent cell columns inside the active notebook viewport. */
function applyColumnLayout(panel: NotebookPanel, state: ILayoutState): void {
  const viewport = panel.content.viewportNode;
  viewport.style.display = 'block';
  viewport.style.gridAutoFlow = '';
  viewport.style.gridTemplateColumns = '';
  viewport.style.alignItems = '';
  viewport.style.columnGap = '';
  viewport.style.position = 'relative';
  state.markdownColumn.className = 'jp-LinkMaker-twoColumnColumn';
  state.markdownColumn.classList.add('jp-LinkMaker-markdownColumn');
  state.codeColumn.className =
    'jp-LinkMaker-twoColumnColumn jp-LinkMaker-codeColumn';
  state.markdownColumn.style.width = 'calc(50% - 12px)';
  state.codeColumn.style.left = 'calc(50% + 12px)';
  state.codeColumn.style.position = 'absolute';
  state.codeColumn.style.top = '0px';
  state.codeColumn.style.width = 'calc(50% - 12px)';
  state.codeColumn.appendChild(state.unrelatedToggle);
  viewport.append(state.markdownColumn, state.codeColumn);

  panel.content.widgets.forEach(cell => {
    state.cellStyles.set(cell.node, readGridStyle(cell.node));
  });
  arrangeCells(panel, state);
  requestAnimationFrame(() => updateViewportHeight(panel, state));

  state.observer = new MutationObserver(() => {
    if (state.arrangeScheduled) {
      return;
    }
    state.arrangeScheduled = true;
    requestAnimationFrame(() => {
      state.arrangeScheduled = false;
      arrangeCells(panel, state);
      updateViewportHeight(panel, state);
    });
  });
  state.observer.observe(viewport, { childList: true });
}

/** Place cells into their independent Markdown or code/output column. */
function arrangeCells(panel: NotebookPanel, state: ILayoutState): void {
  panel.content.widgets.forEach((cell, index) => {
    if (cell.model.type === 'markdown') {
      if (cell.node.parentElement !== state.markdownColumn) {
        state.markdownColumn.appendChild(cell.node);
      }
      addMarkdownFocusHandlers(panel, state, cell.node);
      return;
    }

    cell.node.dataset.linkmakerAccordionLabel = `Code cell ${index + 1}`;
    if (cell.node.parentElement !== state.codeColumn) {
      state.codeColumn.appendChild(cell.node);
    }
    addCodeExpandHandler(panel, cell.node, state);
  });
}

/** Let a collapsed native code cell expand without wrapping its Lumino widget. */
function addCodeExpandHandler(
  panel: NotebookPanel,
  cellNode: HTMLElement,
  state: ILayoutState
): void {
  if (state.codeFocusHandlers.has(cellNode)) {
    return;
  }
  const click: EventListener = event => {
    if (cellNode.classList.contains('jp-LinkMaker-codeCollapsed')) {
      event.stopPropagation();
      cellNode.classList.remove('jp-LinkMaker-codeCollapsed');
    }
  };
  const pointerEnter: EventListener = () => {
    cancelFocusReset(state);
    if (state.pinnedFocusKey !== null) {
      return;
    }
    const relationshipIds = getRelationshipIds(cellNode);
    if (relationshipIds.length === 0) {
      resetCodeAccordionState(panel, state);
      return;
    }
    const anchorClientTop = getRelationshipAnchorTop(
      panel,
      relationshipIds,
      cellNode.getBoundingClientRect().top
    );
    setCodeAccordionState(panel, state, relationshipIds, anchorClientTop);
  };
  const pointerLeave: EventListener = () => scheduleFocusReset(panel, state);
  cellNode.addEventListener('click', click, true);
  cellNode.addEventListener('pointerenter', pointerEnter);
  cellNode.addEventListener('pointerleave', pointerLeave);
  state.codeFocusHandlers.set(cellNode, { click, pointerEnter, pointerLeave });
}

/** Capture pointer clicks anywhere inside a Markdown cell. */
function addMarkdownFocusHandlers(
  panel: NotebookPanel,
  state: ILayoutState,
  cellNode: HTMLElement
): void {
  if (state.markdownFocusHandlers.has(cellNode)) {
    return;
  }
  const focus = (
    relationshipIds: string[],
    anchorClientTop = cellNode.getBoundingClientRect().top,
    force = false
  ): void => {
    cancelFocusReset(state);
    if (relationshipIds.length === 0) {
      return;
    }
    const focusKey = [...relationshipIds].sort().join(',');
    if (
      state.activeMarkdownCell === cellNode &&
      state.activeFocusKey === focusKey &&
      state.activeAnchorTop !== null &&
      Math.abs(state.activeAnchorTop - anchorClientTop) < 1 &&
      !force
    ) {
      return;
    }
    state.activeMarkdownCell?.classList.remove(
      'jp-LinkMaker-activeMarkdownLink',
      'jp-LinkMaker-pinnedMarkdownLink'
    );
    state.activeMarkdownCell = cellNode;
    state.activeFocusKey = focusKey;
    state.activeAnchorTop = anchorClientTop;
    cellNode.classList.add('jp-LinkMaker-activeMarkdownLink');
    cellNode.classList.toggle(
      'jp-LinkMaker-pinnedMarkdownLink',
      state.pinnedFocusKey === focusKey
    );
    setCodeAccordionState(panel, state, relationshipIds, anchorClientTop);
  };
  const pointerEnter: EventListener = () => {
    if (state.pinnedFocusKey !== null) {
      cancelFocusReset(state);
      return;
    }
    const relationshipIds = getRelationshipIds(cellNode);
    if (relationshipIds.length === 0) {
      resetCodeAccordionState(panel, state);
      return;
    }
    focus(relationshipIds);
  };
  const pointerLeave: EventListener = () => scheduleFocusReset(panel, state);
  const pointerMove: EventListener = event => {
    if (state.pinnedFocusKey !== null) {
      return;
    }
    const target = getExactRelationshipTarget(cellNode, event);
    if (target) {
      focus(target.relationshipIds, target.anchorClientTop);
    }
  };
  const pointerDown: EventListener = event => {
    const target = getExactRelationshipTarget(cellNode, event);
    if (target) {
      const focusKey = [...target.relationshipIds].sort().join(',');
      if (state.pinnedFocusKey === focusKey) {
        resetCodeAccordionState(panel, state);
        return;
      }
      state.pinnedFocusKey = focusKey;
      focus(target.relationshipIds, target.anchorClientTop, true);
      return;
    }
    if (state.pinnedFocusKey !== null) {
      return;
    }
    focus(getRelationshipIds(cellNode));
  };
  cellNode.addEventListener('pointerenter', pointerEnter);
  cellNode.addEventListener('pointermove', pointerMove);
  cellNode.addEventListener('pointerdown', pointerDown, true);
  cellNode.addEventListener('pointerleave', pointerLeave);
  state.markdownFocusHandlers.set(cellNode, {
    pointerDown,
    pointerEnter,
    pointerLeave,
    pointerMove
  });
}

/** Focus related cells while preserving the surrounding notebook context. */
function setCodeAccordionState(
  panel: NotebookPanel,
  state: ILayoutState,
  relationshipIds: string[],
  anchorClientTop: number
): void {
  const unrelatedCodeCells: HTMLElement[] = [];
  const hasLinkedCodeCell = panel.content.widgets.some(
    cell =>
      cell.model.type !== 'markdown' &&
      hasSharedRelationship(cell.node, relationshipIds)
  );
  state.codeColumn.style.top = '0px';
  state.codeColumn.scrollTop = 0;
  panel.content.widgets.forEach(cell => {
    const sharedColor = getSharedRelationshipColor(cell.node, relationshipIds);
    const linked =
      hasSharedRelationship(cell.node, relationshipIds) && sharedColor !== null;

    if (cell.model.type === 'markdown') {
      cell.node.classList.toggle('jp-LinkMaker-focusDimmed', !linked);
      cell.node.classList.toggle('jp-LinkMaker-hoverLinkedMarkdown', linked);
      if (linked) {
        cell.node.style.setProperty('--jp-linkmaker-active-color', sharedColor);
      } else {
        cell.node.style.removeProperty('--jp-linkmaker-active-color');
      }
      return;
    }

    cell.node.classList.toggle('jp-LinkMaker-focusDimmed', !linked);
    cell.node.classList.remove('jp-LinkMaker-outputHostFocused');
    cell.node.classList.remove('jp-LinkMaker-codeCollapsed');
    cell.node.classList.toggle('jp-LinkMaker-hoverLinkedCode', linked);
    cell.node
      .querySelectorAll<HTMLElement>('.jp-LinkMaker-hoverLinkedOutput')
      .forEach(output => {
        output.classList.remove(
          'jp-LinkMaker-hoverLinkedOutput',
          'jp-LinkMaker-pinnedOutput'
        );
        output.style.removeProperty('--jp-linkmaker-active-color');
        output.style.removeProperty('--jp-linkmaker-output-translate-y');
        output.style.removeProperty('transform');
      });
    cell.node
      .querySelectorAll<HTMLElement>('[data-linkmaker-output-relationship-ids]')
      .forEach(output => clearOutputBoundingBoxFocus(output));
    if (linked) {
      showCodeCell(cell.node);
      cell.node.style.setProperty('--jp-linkmaker-active-color', sharedColor);
      getLinkedOutputs(cell.node, relationshipIds).forEach(linkedOutput => {
        linkedOutput.node.classList.add('jp-LinkMaker-hoverLinkedOutput');
        linkedOutput.node.classList.toggle(
          'jp-LinkMaker-pinnedOutput',
          state.pinnedFocusKey === state.activeFocusKey
        );
        linkedOutput.node.style.setProperty(
          '--jp-linkmaker-active-color',
          linkedOutput.color
        );
        updateOutputBoundingBoxes(linkedOutput.node, relationshipIds);
      });
    } else {
      showCodeCell(cell.node);
      cell.node.style.removeProperty('--jp-linkmaker-active-color');
      unrelatedCodeCells.push(cell.node);
    }
  });
  state.unrelatedCodeCells = unrelatedCodeCells;
  state.unrelatedVisible = true;
  updateUnrelatedToggle(state);
  if (hasLinkedCodeCell) {
    const viewportTop = panel.content.viewportNode.getBoundingClientRect().top;
    const outputAnchor = getOutputAnchor(panel, relationshipIds, state);
    const anchorTop = outputAnchor
      ? anchorClientTop - viewportTop - outputAnchor.offsetInColumn
      : anchorClientTop - viewportTop;
    state.codeColumn.style.top = `${Math.max(0, anchorTop)}px`;
  }
  requestAnimationFrame(() => refreshActiveOutputBoundingBoxes(panel, state));
  state.codeColumn.scrollTop = 0;
  requestAnimationFrame(() => updateViewportHeight(panel, state));
}

interface ILinkedOutput {
  color: string;
  node: HTMLElement;
}

interface IOutputAnchor {
  offsetInColumn: number;
}

/** Calculate the linked output's offset so its visible top aligns to Markdown. */
function getOutputAnchor(
  panel: NotebookPanel,
  relationshipIds: string[],
  state: ILayoutState
): IOutputAnchor | null {
  const targetCell = panel.content.widgets.find(
    cell =>
      cell.model.type !== 'markdown' &&
      getLinkedOutputs(cell.node, relationshipIds).length > 0
  );
  if (!targetCell) {
    return null;
  }
  const output = getLinkedOutputs(targetCell.node, relationshipIds)[0]?.node;
  if (!output) {
    return null;
  }
  const columnTop = state.codeColumn.getBoundingClientRect().top;
  return { offsetInColumn: output.getBoundingClientRect().top - columnTop };
}

/** Return rendered output nodes that share the current Markdown relationship. */
function getLinkedOutputs(
  cellNode: HTMLElement,
  relationshipIds: string[]
): ILinkedOutput[] {
  return [
    ...cellNode.querySelectorAll<HTMLElement>(
      '[data-linkmaker-output-relationship-ids]'
    )
  ]
    .map(node => ({
      color: getSharedRelationshipColor(node, relationshipIds),
      node
    }))
    .filter((output): output is ILinkedOutput => output.color !== null);
}

/** Position saved normalized rectangles over the output's rendered visual. */
function updateOutputBoundingBoxes(
  output: HTMLElement,
  relationshipIds: string[]
): void {
  const visual = findOutputVisual(output);
  const outputRect = output.getBoundingClientRect();
  const visualRect = visual?.getBoundingClientRect();
  output
    .querySelectorAll<HTMLElement>('.jp-LinkMaker-outputBoundingBox')
    .forEach(box => {
      const relationshipId = box.dataset.linkmakerBoundingRelationshipId;
      const active =
        typeof relationshipId === 'string' &&
        relationshipIds.includes(relationshipId);
      box.classList.toggle('jp-LinkMaker-outputBoundingBoxActive', active);
      if (
        !active ||
        !visualRect ||
        visualRect.width <= 0 ||
        visualRect.height <= 0
      ) {
        return;
      }
      const x = readBoundingCoordinate(box, 'linkmakerBoundingX');
      const y = readBoundingCoordinate(box, 'linkmakerBoundingY');
      const width = readBoundingCoordinate(box, 'linkmakerBoundingWidth');
      const height = readBoundingCoordinate(box, 'linkmakerBoundingHeight');
      if (x === null || y === null || width === null || height === null) {
        return;
      }
      box.style.left = `${
        visualRect.left -
        outputRect.left +
        output.scrollLeft +
        (x / 1000) * visualRect.width
      }px`;
      const top = 1000 - y - height;
      box.style.top = `${
        visualRect.top -
        outputRect.top +
        output.scrollTop +
        (top / 1000) * visualRect.height
      }px`;
      box.style.width = `${(width / 1000) * visualRect.width}px`;
      box.style.height = `${(height / 1000) * visualRect.height}px`;
    });
}

/** Remove focus state while keeping the persisted relationship rectangle. */
function clearOutputBoundingBoxFocus(output: HTMLElement): void {
  output.classList.remove('jp-LinkMaker-hoverLinkedOutput');
  output.style.removeProperty('--jp-linkmaker-active-color');
  output
    .querySelectorAll<HTMLElement>('.jp-LinkMaker-outputBoundingBoxActive')
    .forEach(box =>
      box.classList.remove('jp-LinkMaker-outputBoundingBoxActive')
    );
}

/** Recalculate active overlays after column movement or viewport resizing. */
function refreshActiveOutputBoundingBoxes(
  panel: NotebookPanel,
  state: ILayoutState
): void {
  const relationshipIds =
    state.activeFocusKey?.split(',').filter(Boolean) ?? [];
  if (relationshipIds.length === 0) {
    return;
  }
  panel.content.node
    .querySelectorAll<HTMLElement>('.jp-LinkMaker-hoverLinkedOutput')
    .forEach(output => updateOutputBoundingBoxes(output, relationshipIds));
}

/** Prefer the exact chart/table surface rather than the whole output widget. */
function findOutputVisual(output: HTMLElement): Element | null {
  return output.querySelector(
    '.jp-RenderedImage img, .jp-RenderedSVG svg, canvas, img, svg, table'
  );
}

function readBoundingCoordinate(
  box: HTMLElement,
  key:
    | 'linkmakerBoundingX'
    | 'linkmakerBoundingY'
    | 'linkmakerBoundingWidth'
    | 'linkmakerBoundingHeight'
): number | null {
  const value = Number(box.dataset[key]);
  return Number.isFinite(value) ? value : null;
}

/** Return the top position of a Markdown cell connected to a code relationship. */
function getRelationshipAnchorTop(
  panel: NotebookPanel,
  relationshipIds: string[],
  fallbackTop: number
): number {
  const markdownCell = panel.content.widgets.find(
    cell =>
      cell.model.type === 'markdown' &&
      hasSharedRelationship(cell.node, relationshipIds)
  );
  return markdownCell?.node.getBoundingClientRect().top ?? fallbackTop;
}

/** Delay reset briefly so the pointer can move between connected cells. */
function scheduleFocusReset(panel: NotebookPanel, state: ILayoutState): void {
  if (state.pinnedFocusKey !== null) {
    return;
  }
  cancelFocusReset(state);
  state.focusResetTimer = window.setTimeout(() => {
    state.focusResetTimer = null;
    resetCodeAccordionState(panel, state);
  }, 90);
}

/** Keep focus active while the pointer enters another relevant cell. */
function cancelFocusReset(state: ILayoutState): void {
  if (state.focusResetTimer !== null) {
    window.clearTimeout(state.focusResetTimer);
    state.focusResetTimer = null;
  }
}

/** Let users explicitly hide or show the dimmed, unrelated code cells. */
function toggleUnrelatedCodeCells(
  panel: NotebookPanel,
  state: ILayoutState
): void {
  state.unrelatedVisible = !state.unrelatedVisible;
  state.unrelatedCodeCells.forEach(cellNode => {
    cellNode.classList.toggle(
      'jp-LinkMaker-unrelatedCodeHidden',
      !state.unrelatedVisible
    );
    if (state.unrelatedVisible) {
      showCodeCell(cellNode);
    } else {
      hideCodeCell(cellNode);
    }
  });
  updateUnrelatedToggle(state);
  requestAnimationFrame(() => updateViewportHeight(panel, state));
}

/** Hide an unrelated native code cell without detaching its DOM or ranges. */
function hideCodeCell(cellNode: HTMLElement): void {
  cellNode.hidden = true;
  cellNode.setAttribute('aria-hidden', 'true');
  cellNode.style.setProperty('display', 'none', 'important');
}

/** Reveal a native code cell while preserving its existing relationship colors. */
function showCodeCell(cellNode: HTMLElement): void {
  cellNode.hidden = false;
  cellNode.removeAttribute('aria-hidden');
  cellNode.style.removeProperty('display');
}

/** Synchronize the unrelated-code accordion control. */
function updateUnrelatedToggle(state: ILayoutState): void {
  const count = state.unrelatedCodeCells.length;
  state.unrelatedToggle.hidden = count === 0;
  state.unrelatedToggle.setAttribute(
    'aria-expanded',
    String(state.unrelatedVisible)
  );
  state.unrelatedToggle.textContent = state.unrelatedVisible
    ? `Hide ${count} unrelated code cell${count === 1 ? '' : 's'}`
    : `Show ${count} unrelated code cell${count === 1 ? '' : 's'}`;
}

/** Ensure an absolutely positioned relation group remains inside notebook flow. */
function updateViewportHeight(panel: NotebookPanel, state: ILayoutState): void {
  const codeBottom = state.codeColumn.offsetTop + state.codeColumn.scrollHeight;
  const requiredHeight = Math.max(
    state.markdownColumn.scrollHeight,
    codeBottom
  );
  panel.content.viewportNode.style.minHeight = `${requiredHeight}px`;
}

/** Restore all cells after the Markdown focus ends. */
function resetCodeAccordionState(
  panel: NotebookPanel,
  state: ILayoutState
): void {
  cancelFocusReset(state);
  state.activeMarkdownCell?.classList.remove(
    'jp-LinkMaker-activeMarkdownLink',
    'jp-LinkMaker-pinnedMarkdownLink'
  );
  state.activeMarkdownCell = null;
  state.activeFocusKey = null;
  state.activeAnchorTop = null;
  state.pinnedFocusKey = null;
  panel.content.widgets.forEach(cell => {
    cell.node.classList.remove(
      'jp-LinkMaker-codeCollapsed',
      'jp-LinkMaker-hoverLinkedCode',
      'jp-LinkMaker-hoverLinkedMarkdown',
      'jp-LinkMaker-outputHostFocused',
      'jp-LinkMaker-unrelatedCodeHidden',
      'jp-LinkMaker-focusDimmed'
    );
    cell.node.style.removeProperty('--jp-linkmaker-active-color');
    cell.node
      .querySelectorAll<HTMLElement>('.jp-LinkMaker-hoverLinkedOutput')
      .forEach(output => {
        output.classList.remove('jp-LinkMaker-hoverLinkedOutput');
        output.classList.remove('jp-LinkMaker-pinnedOutput');
        output.style.removeProperty('--jp-linkmaker-active-color');
        output.style.removeProperty('--jp-linkmaker-output-translate-y');
        output.style.removeProperty('transform');
      });
    cell.node
      .querySelectorAll<HTMLElement>('[data-linkmaker-output-relationship-ids]')
      .forEach(output => clearOutputBoundingBoxFocus(output));
    if (cell.model.type !== 'markdown') {
      showCodeCell(cell.node);
    }
  });
  state.codeColumn.scrollTop = 0;
  state.codeColumn.style.top = '0px';
  state.unrelatedCodeCells = [];
  state.unrelatedVisible = false;
  state.unrelatedToggle.hidden = true;
}

/** Read relationship IDs that the highlighter stored on a notebook cell. */
function getRelationshipIds(cellNode: HTMLElement): string[] {
  return (
    cellNode.dataset.linkmakerRelationshipIds?.split(',').filter(Boolean) ?? []
  );
}

/** Resolve the exact JSON Markdown portion and its visible pointer position. */
function getExactRelationshipTarget(
  cellNode: HTMLElement,
  event: Event
): IMarkdownFocusTarget | null {
  const links = getMarkdownPortionLinks(cellNode);
  if (links.length === 0 || !(event instanceof PointerEvent)) {
    return null;
  }
  const renderedTarget = getRenderedMarkdownRelationshipTargetAtPoint(
    cellNode,
    event.clientX,
    event.clientY
  );
  if (renderedTarget) {
    return {
      anchorClientTop: renderedTarget.top,
      relationshipIds: renderedTarget.relationshipIds
    };
  }
  const editor = cellNode.querySelector<HTMLElement>('.cm-content');
  const offset = editor
    ? getTextOffsetAtPoint(editor, event.clientX, event.clientY)
    : null;
  if (offset === null) {
    return null;
  }

  const exact = links.filter(
    link => offset >= link.startOffset && offset <= link.endOffset
  );
  if (exact.length > 0) {
    return {
      anchorClientTop: event.clientY,
      relationshipIds: [...new Set(exact.map(link => link.id))]
    };
  }

  return null;
}

/** Convert a browser caret position into a CodeMirror source-text offset. */
function getTextOffsetAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number
): number | null {
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offset: number; offsetNode: Node } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);
  const fallbackRange = position
    ? null
    : (caretDocument.caretRangeFromPoint?.(clientX, clientY) ?? null);
  const offsetNode =
    position?.offsetNode ?? fallbackRange?.startContainer ?? null;
  const offset = position?.offset ?? fallbackRange?.startOffset ?? 0;
  if (!offsetNode || !root.contains(offsetNode)) {
    return null;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(offsetNode, offset);
  return range.toString().length;
}

function getMarkdownPortionLinks(
  cellNode: HTMLElement
): IMarkdownPortionLink[] {
  const value = cellNode.dataset.linkmakerMarkdownLinks;
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isMarkdownPortionLink) : [];
  } catch {
    return [];
  }
}

function isMarkdownPortionLink(value: unknown): value is IMarkdownPortionLink {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<IMarkdownPortionLink>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.color === 'string' &&
    typeof candidate.startOffset === 'number' &&
    typeof candidate.endOffset === 'number' &&
    typeof candidate.text === 'string'
  );
}

/** Return whether a code cell and a Markdown cell share a relationship. */
function hasSharedRelationship(
  cellNode: HTMLElement,
  relationshipIds: string[]
): boolean {
  return getRelationshipIds(cellNode).some(id => relationshipIds.includes(id));
}

/** Get the JSON relationship color shared by Markdown and code cells. */
function getSharedRelationshipColor(
  cellNode: HTMLElement,
  relationshipIds: string[]
): string | null {
  const codeIds = getRelationshipIds(cellNode);
  const colors =
    cellNode.dataset.linkmakerRelationshipColors?.split(',').filter(Boolean) ??
    [];
  const index = codeIds.findIndex(id => relationshipIds.includes(id));
  return index >= 0 ? (colors[index] ?? null) : null;
}

/** Restore the single notebook cell sequence and its original inline styles. */
function restoreColumnLayout(panel: NotebookPanel, state: ILayoutState): void {
  state.observer.disconnect();
  state.markdownFocusHandlers.forEach((handlers, cellNode) => {
    cellNode.removeEventListener('pointerdown', handlers.pointerDown, true);
    cellNode.removeEventListener('pointerenter', handlers.pointerEnter);
    cellNode.removeEventListener('pointerleave', handlers.pointerLeave);
    cellNode.removeEventListener('pointermove', handlers.pointerMove);
  });
  state.codeFocusHandlers.forEach((handlers, cellNode) => {
    cellNode.removeEventListener('click', handlers.click, true);
    cellNode.removeEventListener('pointerenter', handlers.pointerEnter);
    cellNode.removeEventListener('pointerleave', handlers.pointerLeave);
  });
  state.unrelatedToggle.removeEventListener(
    'click',
    state.unrelatedToggleHandler
  );
  panel.content.node.removeEventListener(
    'pointerleave',
    state.viewportPointerLeaveHandler
  );
  window.removeEventListener('resize', state.resizeHandler);
  window.removeEventListener('keydown', state.keyDownHandler);
  resetCodeAccordionState(panel, state);
  panel.content.widgets.forEach(cell => {
    panel.content.viewportNode.appendChild(cell.node);
  });
  state.markdownColumn.remove();
  state.codeColumn.remove();
  writeGridStyle(panel.content.viewportNode, state.viewportStyle);
  state.cellStyles.forEach((style, node) => {
    writeGridStyle(node, style);
  });
}

/** Read only the inline properties controlled by this extension. */
function readGridStyle(node: HTMLElement): IGridStyle {
  return {
    display: node.style.display,
    gridAutoFlow: node.style.gridAutoFlow,
    gridTemplateColumns: node.style.gridTemplateColumns,
    alignItems: node.style.alignItems,
    columnGap: node.style.columnGap,
    gridColumn: node.style.gridColumn,
    minHeight: node.style.minHeight,
    position: node.style.position
  };
}

/** Restore the inline properties controlled by this extension. */
function writeGridStyle(node: HTMLElement, style: IGridStyle): void {
  node.style.display = style.display;
  node.style.gridAutoFlow = style.gridAutoFlow;
  node.style.gridTemplateColumns = style.gridTemplateColumns;
  node.style.alignItems = style.alignItems;
  node.style.columnGap = style.columnGap;
  node.style.gridColumn = style.gridColumn;
  node.style.minHeight = style.minHeight;
  node.style.position = style.position;
}

/** A per-notebook Lumino header control for the two-column layout. */
export class TwoColumnNotebookLayoutExtension implements DocumentRegistry.IWidgetExtension<
  NotebookPanel,
  INotebookModel
> {
  createNew(panel: NotebookPanel): IDisposable {
    return addTwoColumnLayoutControl(panel);
  }
}

/** Add the visible layout button to a notebook toolbar exactly once. */
export function addTwoColumnLayoutControl(panel: NotebookPanel): IDisposable {
  const button = new TwoColumnLayoutButton(panel);
  const added = panel.toolbar.addItem('linkmaker-two-column-layout', button);
  if (!added) {
    button.dispose();
    return new DisposableDelegate(() => undefined);
  }
  return new DisposableDelegate(() => button.dispose());
}

/** Button widget kept in sync with the notebook layout state. */
export class TwoColumnLayoutButton extends Widget {
  constructor(panel: NotebookPanel) {
    const node = document.createElement('button');
    node.type = 'button';
    super({ node });
    this._panel = panel;
    this.addClass('jp-LinkMaker-twoColumnToggle');
    node.addEventListener('click', this._onClick);
    panel.content.node.addEventListener(
      LINKMAKER_LAYOUT_CHANGED_EVENT,
      this._sync
    );
    this._sync();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.node.removeEventListener('click', this._onClick);
    this._panel.content.node.removeEventListener(
      LINKMAKER_LAYOUT_CHANGED_EVENT,
      this._sync
    );
    super.dispose();
  }

  private _onClick = (): void => {
    toggleTwoColumnLayout(this._panel);
  };

  private _sync = (): void => {
    const active = isTwoColumnLayout(this._panel);
    this.node.textContent = active ? 'Default layout' : 'Two-column layout';
    this.node.setAttribute('aria-pressed', String(active));
    this.node.title = active
      ? 'Restore the normal notebook layout'
      : 'Put Markdown on the left and code with outputs on the right';
  };

  private _panel: NotebookPanel;
}
