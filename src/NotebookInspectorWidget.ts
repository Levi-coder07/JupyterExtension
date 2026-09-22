import { CodeCell } from '@jupyterlab/cells';
import {
  INotebookModel,
  INotebookTracker,
  NotebookPanel
} from '@jupyterlab/notebook';

import { Notification } from '@jupyterlab/apputils';
import { Contents } from '@jupyterlab/services';

import { Widget } from '@lumino/widgets';

import {
  analyzeNotebookOutputRelationships,
  analyzeNotebookRelationships,
  saveMediaToNotebookDirectory
} from './api';
import { captureNotebookOutputArtifacts } from './outputCapture';
import {
  applyRelationshipHighlights,
  loadRelationshipFile
} from './relationshipVisualizer';
import { LINKMAKER_LAYOUT_CHANGED_EVENT } from './TwoColumnNotebookLayout';

interface NotebookSnapshot {
  cellCount: number;
  codeCellCount: number;
  formatVersion: string;
  markdownCellCount: number;
  notebookMetadata: Record<string, unknown> | null;
  path: string;
  cells: CellSnapshot[];
}

interface CellSnapshot {
  cellType: string;
  executionCount: number | null;
  metadata: Record<string, unknown> | null;
  outputs: OutputSnapshot[];
  renderedMedia: MediaSnapshot[];
  source: string;
}

interface OutputSnapshot {
  media: MediaSnapshot[];
  outputType: string;
  text: string;
}

interface MediaSnapshot {
  kind: 'html' | 'image' | 'json' | 'text';
  label: string;
  mimeType: string;
  previewUri: string | null;
  rawData: string;
  source: 'mime-bundle' | 'rendered-dom';
}

/**
 * Side panel that shows the active notebook metadata, cells, and outputs.
 */
export class NotebookInspectorWidget extends Widget {
  constructor(tracker: INotebookTracker, contentsManager: Contents.IManager) {
    super();

    this._tracker = tracker;
    this._contentsManager = contentsManager;
    this.id = 'LinkMaker:notebook-inspector';
    this.title.label = 'Notebook Inspector';
    this.title.caption = 'Show notebook metadata, cells, and outputs';
    this.title.closable = true;
    this.addClass('jp-LinkMaker-panel');
    this.node.style.height = '100%';
    this.node.style.minHeight = '0';
    this.node.style.overflowY = 'auto';
    this.node.style.overflowX = 'hidden';

    this._tracker.currentChanged.connect(this._onCurrentChanged, this);
    this._bindNotebook(this._tracker.currentWidget);
    void this._refreshRelationshipHighlights();
    this._render();
  }

  /**
   * Dispose of the resources held by the widget.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._tracker.currentChanged.disconnect(this._onCurrentChanged, this);
    if (this._highlightRefreshTimer !== null) {
      window.clearTimeout(this._highlightRefreshTimer);
    }
    this._unbindNotebook();
    super.dispose();
  }

  private _bindNotebook(panel: NotebookPanel | null): void {
    if (this._panel === panel) {
      return;
    }

    this._unbindNotebook();
    this._panel = panel;
    this._analysisStatus = '';
    this._outputAnalysisStatus = '';
    this._selectedOutputId = null;

    if (!panel) {
      this._model = null;
      return;
    }

    this._model = panel.model;
    panel.context.pathChanged.connect(this._onNotebookUpdated, this);
    panel.disposed.connect(this._onNotebookDisposed, this);
    panel.content.node.addEventListener(
      LINKMAKER_LAYOUT_CHANGED_EVENT,
      this._onNotebookLayoutChanged
    );

    if (this._model) {
      this._model.contentChanged.connect(this._onNotebookUpdated, this);
      this._model.metadataChanged.connect(this._onNotebookUpdated, this);
    }
  }

  private _unbindNotebook(): void {
    if (this._panel) {
      this._panel.context.pathChanged.disconnect(this._onNotebookUpdated, this);
      this._panel.disposed.disconnect(this._onNotebookDisposed, this);
      this._panel.content.node.removeEventListener(
        LINKMAKER_LAYOUT_CHANGED_EVENT,
        this._onNotebookLayoutChanged
      );
    }

    if (this._model) {
      this._model.contentChanged.disconnect(this._onNotebookUpdated, this);
      this._model.metadataChanged.disconnect(this._onNotebookUpdated, this);
    }

    this._panel = null;
    this._model = null;
  }

  private _onCurrentChanged(): void {
    this._bindNotebook(this._tracker.currentWidget);
    this._render();
  }

  private _onNotebookDisposed(): void {
    this._bindNotebook(this._tracker.currentWidget);
    this._render();
  }

  private _onNotebookUpdated(): void {
    if (this._isApplyingHighlights) {
      this._highlightRefreshPending = true;
    } else {
      this._scheduleRelationshipHighlightRefresh();
    }
    this._render();
  }

  private _onNotebookLayoutChanged = (): void => {
    this._scheduleRelationshipHighlightRefresh();
  };

  /**
   * Create the notebook-wide Markdown-to-code relationship file on request.
   */
  private async _analyzeNotebook(panel: NotebookPanel): Promise<void> {
    if (this._isAnalyzing || !panel.model) {
      return;
    }

    this._isAnalyzing = true;
    this._analysisStatus = 'Analyzing Markdown-to-code relationships…';
    this._render();

    try {
      const response = await analyzeNotebookRelationships(
        panel.context.path,
        panel.model.toJSON()
      );
      this._analysisStatus =
        response.status === 'success'
          ? `Relationship file saved to ${response.path}`
          : `Relationship file partially saved to ${response.path} (${response.failedMarkdownCells} Markdown cells failed).`;

      await this._refreshRelationshipHighlights();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown analysis error';
      this._analysisStatus = `Relationship analysis could not run: ${message}`;
    } finally {
      this._isAnalyzing = false;
    }

    if (this._panel === panel) {
      this._render();
    }
  }

  /**
   * Start analysis for the notebook currently shown in the inspector.
   */
  private _onAnalyzeRequested(): void {
    if (this._panel) {
      void this._analyzeNotebook(this._panel);
    }
  }

  /** Analyze Markdown references to rendered charts and tables separately. */
  private async _analyzeNotebookOutputs(panel: NotebookPanel): Promise<void> {
    if (this._isAnalyzingOutputs || !panel.model) {
      return;
    }

    const capturedArtifacts = captureNotebookOutputArtifacts(panel);
    const outputArtifacts = this._selectedOutputId
      ? capturedArtifacts.filter(
          artifact => artifact.outputId === this._selectedOutputId
        )
      : capturedArtifacts.slice(0, 1);
    if (outputArtifacts.length === 0) {
      this._outputAnalysisStatus =
        'No supported chart or table outputs are currently rendered.';
      this._render();
      return;
    }

    this._isAnalyzingOutputs = true;
    this._outputAnalysisStatus = `Analyzing Markdown-to-output links for ${outputArtifacts.length} captured outputs…`;
    this._render();

    try {
      const response = await analyzeNotebookOutputRelationships(
        panel.context.path,
        panel.model.toJSON(),
        outputArtifacts
      );
      this._outputAnalysisStatus =
        response.status === 'success'
          ? `Output relationship file saved to ${response.path}`
          : `Output relationship analysis partially saved to ${response.path} (${response.failedMarkdownCells} Markdown cells failed).`;
      await this._refreshRelationshipHighlights();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown output analysis error';
      this._outputAnalysisStatus = `Output relationship analysis could not run: ${message}`;
    } finally {
      this._isAnalyzingOutputs = false;
    }

    if (this._panel === panel) {
      this._render();
    }
  }

  private _onAnalyzeOutputsRequested(): void {
    if (this._panel) {
      void this._analyzeNotebookOutputs(this._panel);
    }
  }

  private _onApplyHighlightsRequested(): void {
    if (this._panel) {
      void this._applySavedHighlights();
    }
  }

  private async _applySavedHighlights(): Promise<void> {
    const panel = this._panel;
    if (!panel) {
      return;
    }
    const highlightedCells = await this._loadAndApplyHighlights(panel);

    if (highlightedCells > 0) {
      this._analysisStatus = `Highlighted ${highlightedCells} related notebook cells.`;
    } else {
      this._analysisStatus =
        'No relationships were found in the saved JSON file.';
    }

    this._render();
  }

  private async _refreshRelationshipHighlights(): Promise<void> {
    const panel = this._panel;
    if (!panel) {
      return;
    }
    await this._loadAndApplyHighlights(panel);
  }

  private _scheduleRelationshipHighlightRefresh(): void {
    if (this._highlightRefreshTimer !== null) {
      window.clearTimeout(this._highlightRefreshTimer);
    }
    this._highlightRefreshTimer = window.setTimeout(() => {
      this._highlightRefreshTimer = null;
      void this._refreshRelationshipHighlights();
    }, 100);
  }

  private async _loadAndApplyHighlights(panel: NotebookPanel): Promise<number> {
    if (this._isApplyingHighlights) {
      this._highlightRefreshPending = true;
      return 0;
    }

    this._isApplyingHighlights = true;
    try {
      const relationshipFile = await loadRelationshipFile(
        this._contentsManager,
        panel.context.path
      );
      if (panel.isDisposed || this._panel !== panel) {
        return 0;
      }
      return await applyRelationshipHighlights(panel, relationshipFile);
    } finally {
      this._isApplyingHighlights = false;
      if (this._highlightRefreshPending) {
        this._highlightRefreshPending = false;
        this._scheduleRelationshipHighlightRefresh();
      }
    }
  }

  private _createAnalysisSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'jp-LinkMaker-section';

    const heading = document.createElement('h3');
    heading.className = 'jp-LinkMaker-sectionTitle';
    heading.textContent = 'Markdown-to-Code Relationships';
    section.appendChild(heading);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'jp-LinkMaker-buttonRow';

    const applyButton = document.createElement('button');
    applyButton.className = 'jp-LinkMaker-secondaryButton';
    applyButton.textContent = 'Apply saved highlights';
    applyButton.onclick = () => this._onApplyHighlightsRequested();
    buttonRow.appendChild(applyButton);

    const rebuildButton = document.createElement('button');
    rebuildButton.className = 'jp-LinkMaker-saveButton';
    rebuildButton.disabled = this._isAnalyzing;
    rebuildButton.textContent = this._isAnalyzing
      ? 'Analyzing notebook…'
      : 'Rebuild from model';
    rebuildButton.onclick = () => this._onAnalyzeRequested();
    buttonRow.appendChild(rebuildButton);

    const outputButton = document.createElement('button');
    outputButton.className = 'jp-LinkMaker-secondaryButton';
    outputButton.disabled = this._isAnalyzingOutputs;
    outputButton.textContent = this._isAnalyzingOutputs
      ? 'Analyzing outputs…'
      : 'Analyze Markdown ↔ outputs';
    outputButton.onclick = () => this._onAnalyzeOutputsRequested();
    buttonRow.appendChild(outputButton);

    section.appendChild(buttonRow);

    const panel = this._panel;
    if (panel) {
      const outputArtifacts = captureNotebookOutputArtifacts(panel);
      if (outputArtifacts.length > 0) {
        const selectorLabel = document.createElement('label');
        selectorLabel.className = 'jp-LinkMaker-outputSelectorLabel';
        selectorLabel.textContent = 'Output to analyze';
        const selector = document.createElement('select');
        selector.className = 'jp-LinkMaker-outputSelector';
        selector.disabled = this._isAnalyzingOutputs;
        outputArtifacts.forEach((artifact, index) => {
          const option = document.createElement('option');
          option.value = artifact.outputId;
          option.textContent = `Cell ${artifact.cellIndex + 1}, output ${artifact.outputIndex + 1} — ${artifact.kind}`;
          if (
            artifact.outputId ===
            (this._selectedOutputId ?? outputArtifacts[0].outputId)
          ) {
            option.selected = true;
          }
          selector.appendChild(option);
          if (index === 0 && this._selectedOutputId === null) {
            this._selectedOutputId = artifact.outputId;
          }
        });
        selector.onchange = () => {
          this._selectedOutputId = selector.value;
        };
        selectorLabel.appendChild(selector);
        section.appendChild(selectorLabel);
      }
    }

    if (this._analysisStatus) {
      section.appendChild(this._createMessage(this._analysisStatus));
    }
    if (this._outputAnalysisStatus) {
      section.appendChild(this._createMessage(this._outputAnalysisStatus));
    }

    return section;
  }

  private _render(): void {
    this.node.textContent = '';

    const body = document.createElement('div');
    body.className = 'jp-LinkMaker-panelBody';
    this.node.appendChild(body);

    try {
      if (!this._panel || !this._model) {
        body.appendChild(
          this._createMessage(
            'Open a notebook to inspect its metadata, cell sources, and outputs.'
          )
        );
        return;
      }

      const snapshot = this._createSnapshot(
        this._panel.context.path,
        this._model,
        this._panel
      );
      body.appendChild(this._createHeader(snapshot));
      body.appendChild(this._createAnalysisSection());
      body.appendChild(
        this._createJsonSection(
          'Notebook Metadata',
          snapshot.notebookMetadata,
          'No notebook metadata found.'
        )
      );

      if (snapshot.cells.length === 0) {
        body.appendChild(
          this._createMessage('This notebook does not contain any cells.')
        );
        return;
      }

      snapshot.cells.forEach((cell, index) => {
        body.appendChild(this._createCellCard(cell, index));
      });
    } catch (error) {
      console.error('Notebook Inspector failed to render.', error);
      body.appendChild(
        this._createMessage(
          `Notebook Inspector hit an error while rendering: ${this._getErrorMessage(
            error
          )}`
        )
      );
    }
  }

  private _createSnapshot(
    path: string,
    model: INotebookModel,
    panel: NotebookPanel
  ): NotebookSnapshot {
    const rawNotebook = this._asRecord(model.toJSON());
    const rawCells = Array.isArray(rawNotebook?.cells) ? rawNotebook.cells : [];
    const renderedMediaByCell = this._captureRenderedMedia(panel);
    const cells = rawCells.map((value, index) =>
      this._createCellSnapshot(value, renderedMediaByCell[index] ?? [])
    );
    const codeCellCount = cells.filter(cell => cell.cellType === 'code').length;
    const markdownCellCount = cells.filter(
      cell => cell.cellType === 'markdown'
    ).length;

    return {
      cellCount: cells.length,
      codeCellCount,
      formatVersion: `${model.nbformat}.${model.nbformatMinor}`,
      markdownCellCount,
      notebookMetadata: this._asRecord(rawNotebook?.metadata),
      path,
      cells
    };
  }

  private _createCellSnapshot(
    value: unknown,
    renderedMedia: MediaSnapshot[]
  ): CellSnapshot {
    const cell = this._asRecord(value);
    const rawOutputs = Array.isArray(cell?.outputs) ? cell.outputs : [];

    return {
      cellType:
        typeof cell?.cell_type === 'string' ? cell.cell_type : 'unknown',
      executionCount:
        typeof cell?.execution_count === 'number' ? cell.execution_count : null,
      metadata: this._asRecord(cell?.metadata),
      outputs: rawOutputs.map(output => this._createOutputSnapshot(output)),
      renderedMedia,
      source: this._normalizeText(cell?.source)
    };
  }

  private _createOutputSnapshot(value: unknown): OutputSnapshot {
    const output = this._asRecord(value);
    const outputType =
      typeof output?.output_type === 'string' ? output.output_type : 'unknown';
    const text = this._extractOutputText(output);
    const media = this._extractMedia(output);

    return {
      media,
      outputType,
      text
    };
  }

  private _captureRenderedMedia(panel: NotebookPanel): MediaSnapshot[][] {
    return panel.content.widgets.map((widget, index) => {
      if (!(widget instanceof CodeCell)) {
        return [];
      }

      try {
        panel.content.renderCellOutputs(index);
        return this._captureOutputAreaMedia(widget.outputArea.node);
      } catch (error) {
        console.warn(
          `Unable to capture rendered output for cell ${index + 1}.`,
          error
        );
        return [];
      }
    });
  }

  private _captureOutputAreaMedia(node: HTMLElement): MediaSnapshot[] {
    const elements = Array.from(node.querySelectorAll('svg, canvas, img'));
    const snapshots: MediaSnapshot[] = [];
    const seen = new Set<string>();

    elements.forEach(element => {
      const snapshot = this._createRenderedMediaSnapshot(element);
      if (!snapshot) {
        return;
      }

      const key = `${snapshot.mimeType}:${snapshot.previewUri ?? snapshot.rawData}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      snapshots.push(snapshot);
    });

    return snapshots;
  }

  private _createRenderedMediaSnapshot(element: Element): MediaSnapshot | null {
    if (element.tagName.toLowerCase() === 'svg') {
      const rawData = new XMLSerializer().serializeToString(element);
      return {
        kind: 'image',
        label: 'Rendered SVG Capture',
        mimeType: 'image/svg+xml',
        previewUri: this._createSvgPreviewUri(rawData),
        rawData,
        source: 'rendered-dom'
      };
    }

    if (element instanceof HTMLCanvasElement) {
      try {
        const rawData = element.toDataURL('image/png');
        return {
          kind: 'image',
          label: 'Rendered Canvas Capture',
          mimeType: 'image/png',
          previewUri: rawData,
          rawData,
          source: 'rendered-dom'
        };
      } catch (error) {
        console.warn('Unable to capture canvas output.', error);
        return null;
      }
    }

    if (element instanceof HTMLImageElement) {
      const rawData = element.currentSrc || element.src;
      if (!rawData) {
        return null;
      }

      return {
        kind: 'image',
        label: 'Rendered Image Capture',
        mimeType: this._getImageMimeTypeFromUri(rawData),
        previewUri: rawData,
        rawData,
        source: 'rendered-dom'
      };
    }

    return null;
  }

  private _extractMedia(
    output: Record<string, unknown> | null
  ): MediaSnapshot[] {
    const data = this._asRecord(output?.data);
    if (!data) {
      return [];
    }

    return Object.entries(data)
      .map(([mimeType, value]) =>
        this._createMimeMediaSnapshot(mimeType, value)
      )
      .filter((value): value is MediaSnapshot => value !== null);
  }

  private _createMimeMediaSnapshot(
    mimeType: string,
    value: unknown
  ): MediaSnapshot | null {
    const kind = this._getMimeKind(mimeType);
    const rawData = this._normalizeMimeValue(value);
    if (!rawData) {
      return null;
    }

    if (kind === 'image') {
      return {
        kind,
        label: `Saved ${mimeType}`,
        mimeType,
        previewUri: this._createImagePreviewUri(mimeType, rawData),
        rawData,
        source: 'mime-bundle'
      };
    }

    return {
      kind,
      label: `Saved ${mimeType}`,
      mimeType,
      previewUri: null,
      rawData,
      source: 'mime-bundle'
    };
  }

  private _getMimeKind(mimeType: string): MediaSnapshot['kind'] {
    if (mimeType.startsWith('image/')) {
      return 'image';
    }

    if (mimeType === 'text/html') {
      return 'html';
    }

    if (mimeType.endsWith('+json') || mimeType === 'application/json') {
      return 'json';
    }

    return 'text';
  }

  private _normalizeMimeValue(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (this._isStringArray(value)) {
      return value.join('');
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (value && typeof value === 'object') {
      return this._stringifyValue(value);
    }

    return '';
  }

  private _getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown rendering error';
  }

  private _createImagePreviewUri(
    mimeType: string,
    rawData: string
  ): string | null {
    if (mimeType === 'image/svg+xml') {
      return this._createSvgPreviewUri(rawData);
    }

    if (mimeType.startsWith('image/')) {
      const normalized = rawData.replace(/\s+/g, '');
      return `data:${mimeType};base64,${normalized}`;
    }

    return null;
  }

  private _createSvgPreviewUri(rawSvg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawSvg)}`;
  }

  private _getImageMimeTypeFromUri(uri: string): string {
    if (!uri.startsWith('data:')) {
      return 'image/*';
    }

    const match = uri.match(/^data:([^;]+);/);
    return match?.[1] ?? 'image/*';
  }

  private _extractOutputText(output: Record<string, unknown> | null): string {
    if (!output) {
      return '';
    }

    const directText = this._normalizeText(output.text);
    if (directText) {
      return directText;
    }

    if (this._isStringArray(output.traceback)) {
      return output.traceback.join('\n');
    }

    const data = this._asRecord(output.data);
    if (data) {
      const textPlain = this._normalizeText(data['text/plain']);
      if (textPlain) {
        return textPlain;
      }

      const markdown = this._normalizeText(data['text/markdown']);
      if (markdown) {
        return markdown;
      }

      const html = this._normalizeText(data['text/html']);
      if (html) {
        return html;
      }

      return this._stringifyValue(data);
    }

    const name = typeof output.name === 'string' ? output.name : '';
    const errorName = typeof output.ename === 'string' ? output.ename : '';
    const errorValue = typeof output.evalue === 'string' ? output.evalue : '';

    if (name || errorName || errorValue) {
      return [name, errorName, errorValue].filter(Boolean).join(': ');
    }

    return this._stringifyValue(output);
  }

  private _createHeader(snapshot: NotebookSnapshot): HTMLElement {
    const header = document.createElement('section');
    header.className = 'jp-LinkMaker-section';

    const title = document.createElement('h2');
    title.className = 'jp-LinkMaker-title';
    title.textContent = 'Active Notebook';
    header.appendChild(title);

    const path = document.createElement('div');
    path.className = 'jp-LinkMaker-subtitle';
    path.textContent = snapshot.path || 'Untitled notebook';
    header.appendChild(path);

    const version = document.createElement('div');
    version.className = 'jp-LinkMaker-subtitle';
    version.textContent = `nbformat ${snapshot.formatVersion}`;
    header.appendChild(version);

    const summary = document.createElement('div');
    summary.className = 'jp-LinkMaker-summary';
    summary.appendChild(
      this._createSummaryItem('Cells', String(snapshot.cellCount))
    );
    summary.appendChild(
      this._createSummaryItem('Code', String(snapshot.codeCellCount))
    );
    summary.appendChild(
      this._createSummaryItem('Markdown', String(snapshot.markdownCellCount))
    );
    header.appendChild(summary);

    return header;
  }

  private _createSummaryItem(label: string, value: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'jp-LinkMaker-summaryItem';

    const valueNode = document.createElement('div');
    valueNode.className = 'jp-LinkMaker-summaryValue';
    valueNode.textContent = value;
    item.appendChild(valueNode);

    const labelNode = document.createElement('div');
    labelNode.className = 'jp-LinkMaker-summaryLabel';
    labelNode.textContent = label;
    item.appendChild(labelNode);

    return item;
  }

  private _createCellCard(cell: CellSnapshot, index: number): HTMLElement {
    const card = document.createElement('section');
    card.className = 'jp-LinkMaker-cell';

    const heading = document.createElement('h3');
    heading.className = 'jp-LinkMaker-cardTitle';
    heading.textContent = `Cell ${index + 1}: ${cell.cellType}`;
    card.appendChild(heading);

    if (cell.executionCount !== null) {
      const execution = document.createElement('div');
      execution.className = 'jp-LinkMaker-subtitle';
      execution.textContent = `Execution count: ${cell.executionCount}`;
      card.appendChild(execution);
    }

    card.appendChild(
      this._createTextSection('Source', cell.source || 'No source text.')
    );
    card.appendChild(
      this._createJsonSection(
        'Cell Metadata',
        cell.metadata,
        'No cell metadata found.'
      )
    );

    if (cell.outputs.length === 0) {
      card.appendChild(this._createMessage('No outputs for this cell.'));
      return card;
    }

    const outputs = document.createElement('div');
    outputs.className = 'jp-LinkMaker-outputGroup';

    cell.outputs.forEach((output, outputIndex) => {
      const outputNode = document.createElement('section');
      outputNode.className = 'jp-LinkMaker-output';

      const outputTitle = document.createElement('h4');
      outputTitle.className = 'jp-LinkMaker-outputTitle';
      outputTitle.textContent = `Output ${outputIndex + 1}: ${output.outputType}`;
      outputNode.appendChild(outputTitle);

      if (output.media.length > 0) {
        outputNode.appendChild(
          this._createMediaGroup(
            'Saved Output Media',
            output.media,
            index,
            outputIndex,
            this._panel?.context.path ?? ''
          )
        );
      }

      outputNode.appendChild(
        this._createTextSection(
          'Readable Output',
          output.text || 'Output has no readable text.'
        )
      );

      outputs.appendChild(outputNode);
    });

    if (cell.renderedMedia.length > 0) {
      card.appendChild(
        this._createMediaGroup(
          'Rendered Output Capture',
          cell.renderedMedia,
          index,
          null,
          this._panel?.context.path ?? ''
        )
      );
    }

    card.appendChild(outputs);
    return card;
  }

  private _createMediaGroup(
    title: string,
    media: MediaSnapshot[],
    cellIndex: number,
    outputIndex: number | null,
    notebookPath: string
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = 'jp-LinkMaker-section';

    const heading = document.createElement('h4');
    heading.className = 'jp-LinkMaker-sectionTitle';
    heading.textContent = title;
    section.appendChild(heading);

    const group = document.createElement('div');
    group.className = 'jp-LinkMaker-mediaGroup';

    media.forEach((item, mediaIndex) => {
      group.appendChild(
        this._createMediaCard(
          item,
          cellIndex,
          outputIndex,
          mediaIndex,
          notebookPath
        )
      );
    });

    section.appendChild(group);
    return section;
  }

  private _createMediaCard(
    media: MediaSnapshot,
    cellIndex: number,
    outputIndex: number | null,
    mediaIndex: number,
    notebookPath: string
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'jp-LinkMaker-mediaCard';

    const title = document.createElement('div');
    title.className = 'jp-LinkMaker-mediaTitle';
    title.textContent = media.label;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'jp-LinkMaker-mediaMeta';
    meta.textContent = `${media.mimeType} via ${media.source}`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'jp-LinkMaker-mediaActions';

    const saveButton = document.createElement('button');
    saveButton.className = 'jp-LinkMaker-saveButton';
    saveButton.textContent = 'Save in notebook directory';
    saveButton.onclick = () => {
      void this._saveMedia(
        media,
        cellIndex,
        outputIndex,
        mediaIndex,
        notebookPath,
        saveButton
      );
    };
    actions.appendChild(saveButton);
    card.appendChild(actions);

    if (media.previewUri) {
      const preview = document.createElement('div');
      preview.className = 'jp-LinkMaker-mediaPreview';

      const image = document.createElement('img');
      image.className = 'jp-LinkMaker-mediaImage';
      image.src = media.previewUri;
      image.alt = media.label;
      preview.appendChild(image);

      card.appendChild(preview);
    }

    const rawSectionTitle = document.createElement('div');
    rawSectionTitle.className = 'jp-LinkMaker-mediaMeta';
    rawSectionTitle.textContent = 'Raw data';
    card.appendChild(rawSectionTitle);

    const rawData = document.createElement('pre');
    rawData.className = 'jp-LinkMaker-pre';
    rawData.textContent = media.rawData;
    card.appendChild(rawData);

    return card;
  }

  private async _saveMedia(
    media: MediaSnapshot,
    cellIndex: number,
    outputIndex: number | null,
    mediaIndex: number,
    notebookPath: string,
    button: HTMLButtonElement
  ): Promise<void> {
    if (!notebookPath) {
      Notification.error('LinkMaker could not determine the notebook path.');
      return;
    }

    button.disabled = true;

    try {
      const response = await saveMediaToNotebookDirectory(
        {
          cellIndex,
          mediaIndex,
          mimeType: media.mimeType,
          notebookPath,
          outputIndex,
          rawData: media.rawData,
          source: media.source
        },
        this._contentsManager
      );

      Notification.success(`Saved media to ${response.path}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown save error';
      Notification.error(`LinkMaker could not save the media: ${message}`);
    } finally {
      button.disabled = false;
    }
  }

  private _createTextSection(label: string, text: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'jp-LinkMaker-section';

    const heading = document.createElement('h4');
    heading.className = 'jp-LinkMaker-sectionTitle';
    heading.textContent = label;
    section.appendChild(heading);

    const content = document.createElement('pre');
    content.className = 'jp-LinkMaker-pre';
    content.textContent = text;
    section.appendChild(content);

    return section;
  }

  private _createJsonSection(
    label: string,
    value: Record<string, unknown> | null,
    emptyMessage: string
  ): HTMLElement {
    if (!value || Object.keys(value).length === 0) {
      return this._createMessage(emptyMessage);
    }

    return this._createTextSection(label, this._stringifyValue(value));
  }

  private _createMessage(text: string): HTMLElement {
    const message = document.createElement('div');
    message.className = 'jp-LinkMaker-message';
    message.textContent = text;
    return message;
  }

  private _normalizeText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (this._isStringArray(value)) {
      return value.join('');
    }

    return '';
  }

  private _isStringArray(value: unknown): value is string[] {
    return (
      Array.isArray(value) && value.every(item => typeof item === 'string')
    );
  }

  private _asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private _stringifyValue(value: unknown): string {
    const text = JSON.stringify(value, null, 2);
    return text ?? '';
  }

  private _tracker: INotebookTracker;
  private _contentsManager: Contents.IManager;
  private _panel: NotebookPanel | null = null;
  private _model: INotebookModel | null = null;
  private _isAnalyzing = false;
  private _isAnalyzingOutputs = false;
  private _isApplyingHighlights = false;
  private _highlightRefreshPending = false;
  private _highlightRefreshTimer: number | null = null;
  private _analysisStatus = '';
  private _outputAnalysisStatus = '';
  private _selectedOutputId: string | null = null;
}
