import { Contents } from '@jupyterlab/services';
import { NotebookPanel } from '@jupyterlab/notebook';
import { MimeModel } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import {
  applyRelationshipHighlights,
  getMarkdownPortionRelationships,
  getRelationshipTooltipContent,
  loadRelationshipFile
} from './relationshipVisualizer';
import {
  isTwoColumnLayout,
  LINKMAKER_LAYOUT_CHANGED_EVENT,
  toggleTwoColumnLayout,
  updateOutputBoundingBoxes
} from './TwoColumnNotebookLayout';

interface IVisit {
  cellId: string;
  relationshipId: string;
  markdownId: string;
  text: string;
  reason: string;
  kind: string;
  color: string;
}

/** Highlight a rendered Markdown excerpt without replacing its formatting. */
function highlightRenderedText(
  root: HTMLElement,
  target: string,
  color: string,
  relationshipId: string
): HTMLElement[] {
  const normalizedTarget = target.replace(/\s+/gu, ' ').trim();
  if (!normalizedTarget) {
    return [];
  }
  const characters: string[] = [];
  const positions: Array<{ node: Text; offset: number }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  let pendingWhitespace: { node: Text; offset: number } | null = null;
  while (current) {
    const node = current as Text;
    for (let offset = 0; offset < node.data.length; offset += 1) {
      if (/\s/u.test(node.data[offset])) {
        pendingWhitespace = pendingWhitespace ?? { node, offset };
      } else {
        if (pendingWhitespace && characters.length > 0) {
          characters.push(' ');
          positions.push(pendingWhitespace);
        }
        pendingWhitespace = null;
        characters.push(node.data[offset]);
        positions.push({ node, offset });
      }
    }
    current = walker.nextNode();
  }
  const start = characters.join('').indexOf(normalizedTarget);
  if (start < 0) {
    return [];
  }
  const selected = positions.slice(start, start + normalizedTarget.length);
  const ranges = new Map<Text, { start: number; end: number }>();
  selected.forEach(position => {
    const range = ranges.get(position.node) ?? {
      start: position.offset,
      end: position.offset + 1
    };
    range.start = Math.min(range.start, position.offset);
    range.end = Math.max(range.end, position.offset + 1);
    ranges.set(position.node, range);
  });
  const marks: HTMLElement[] = [];
  [...ranges.entries()].reverse().forEach(([node, offsets]) => {
    const range = document.createRange();
    range.setStart(node, offsets.start);
    range.setEnd(node, offsets.end);
    const mark = document.createElement('mark');
    mark.className = 'jp-LinkMaker-explorerMarkdownHighlight';
    mark.dataset.linkmakerRelationshipId = relationshipId;
    mark.style.setProperty('--jp-linkmaker-active-color', color);
    range.surroundContents(mark);
    marks.push(mark);
  });
  return marks;
}

const explorers = new WeakMap<NotebookPanel, CodeRelationshipExplorer>();

/** Install one code-first exploration control per notebook. */
export function addCodeRelationshipExplorer(
  panel: NotebookPanel,
  contents: Contents.IManager
): void {
  if (explorers.has(panel)) {
    return;
  }
  const explorer = new CodeRelationshipExplorer(panel, contents);
  explorers.set(panel, explorer);
  panel.toolbar.addItem('linkmaker-code-explorer', explorer);
}

/** Code-first navigation with transient previews and notebook-scoped history. */
class CodeRelationshipExplorer extends Widget {
  constructor(
    private panel: NotebookPanel,
    private contents: Contents.IManager
  ) {
    super({ node: document.createElement('button') });
    this.node.className = 'jp-LinkMaker-twoColumnToggle';
    this.node.setAttribute('type', 'button');
    this.node.textContent = 'Explore code';
    this.node.setAttribute('aria-pressed', 'false');
    this.node.addEventListener('click', this.toggle);
    this.aside.className = 'jp-LinkMaker-explorerPanel';
    this.aside.setAttribute(
      'aria-label',
      'Related Markdown and navigation history'
    );
    this.aside.hidden = true;
    panel.node.append(this.aside);
    panel.content.node.addEventListener(
      'linkmaker:relationships-updated',
      this.refresh
    );
    panel.content.node.addEventListener(
      LINKMAKER_LAYOUT_CHANGED_EVENT,
      this.layoutChanged
    );
    window.addEventListener('keydown', this.onKey);
    panel.node.addEventListener('click', this.onExplorerClick, true);
    panel.content.node.addEventListener(
      'linkmaker:exit-code-explorer',
      this.exitExplorer
    );
    this.resizeObserver = new ResizeObserver(() => this.positionEvidence());
    this.resizeObserver.observe(panel.content.node);
    panel.disposed.connect(this.dispose, this);
    void panel.context.ready.then(() => {
      if (!this.isDisposed) {
        panel.model?.contentChanged.connect(this.invalidate, this);
      }
    });
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.disable();
    this.resizeObserver?.disconnect();
    this.panel.content.node.removeEventListener(
      'linkmaker:exit-code-explorer',
      this.exitExplorer
    );
    this.aside.remove();
    this.panel.content.node.removeEventListener(
      'linkmaker:relationships-updated',
      this.refresh
    );
    this.panel.content.node.removeEventListener(
      LINKMAKER_LAYOUT_CHANGED_EVENT,
      this.layoutChanged
    );
    window.removeEventListener('keydown', this.onKey);
    this.panel.node.removeEventListener('click', this.onExplorerClick, true);
    this.panel.model?.contentChanged.disconnect(this.invalidate, this);
    this.panel.disposed.disconnect(this.dispose, this);
    this.node.removeEventListener('click', this.toggle);
    super.dispose();
  }

  private toggle = (): void => {
    if (this.active) {
      this.disable();
      return;
    }
    if (isTwoColumnLayout(this.panel)) {
      toggleTwoColumnLayout(this.panel);
    }
    this.active = true;
    this.config = { ...this.panel.content.notebookConfig };
    this.panel.content.notebookConfig = {
      ...this.config,
      windowingMode: 'none'
    };
    this.panel.node.classList.add('jp-LinkMaker-codeExplorer');
    this.node.setAttribute('aria-pressed', 'true');
    this.node.textContent = 'Exit code explorer';
    this.aside.hidden = true;
    this.refresh();
    // Existing maps are loaded locally; entering this view never calls the model.
    void this.load().catch(error => {
      console.error('Unable to open code relationship explorer', error);
      if (this.active && !this.isDisposed) {
        this.render(
          'Unable to load relationships. Try reopening the explorer.'
        );
      }
    });
  };

  private async load(): Promise<void> {
    await this.panel.context.ready;
    if (!this.active || this.isDisposed) {
      return;
    }
    const file = await loadRelationshipFile(
      this.contents,
      this.panel.context.path
    );
    if (this.active && !this.isDisposed) {
      await applyRelationshipHighlights(this.panel, file);
    }
  }

  private exitExplorer = (): void => {
    if (this.active) {
      this.disable();
    }
  };

  private disable(): void {
    this.active = false;
    this.panel.node.classList.remove(
      'jp-LinkMaker-codeExplorer',
      'jp-LinkMaker-explorerShowMarkdown',
      'jp-LinkMaker-explorerRelationshipVisible'
    );
    this.clearMarkers();
    this.pinnedLinks = [];
    this.pinned = false;
    this.clearSelection();
    this.aside.hidden = true;
    this.node.textContent = 'Explore code';
    this.node.setAttribute('aria-pressed', 'false');
    if (this.config) {
      this.panel.content.notebookConfig = this.config;
      this.config = null;
    }
  }

  private layoutChanged = (): void => {
    if (this.active && isTwoColumnLayout(this.panel)) {
      this.disable();
    }
  };

  private invalidate = (): void => {
    if (!this.active) {
      return;
    }
    this.clearMarkers();
    this.pinnedLinks = [];
    this.pinned = false;
    this.clearSelection();
    this.history = [];
    this.cursor = -1;
    this.render(
      'Notebook changed. Refresh relationship analysis before exploring links.'
    );
  };

  private clearMarkers(): void {
    this.cellHoverHandlers.forEach(({ node, pointerEnter, pointerLeave }) => {
      node.removeEventListener('pointerenter', pointerEnter);
      node.removeEventListener('pointerleave', pointerLeave);
    });
    this.cellHoverHandlers = [];
    this.markers.forEach(marker => marker.remove());
    this.markers = [];
    this.clearRelatedMarkdown();
  }

  private refresh = (): void => {
    if (!this.active) {
      return;
    }
    this.clearMarkers();
    this.pinnedLinks = [];
    this.pinned = false;
    this.clearSelection();
    this.history = [];
    this.cursor = -1;
    this.panel.content.widgets.forEach(cell => {
      if (cell.model.type !== 'code') {
        return;
      }
      const links = this.linksFor(cell.model.id);
      if (!links.length) {
        return;
      }
      const marker = this.button(`↔ ${links.length}`, () =>
        this.visit(links[0], links)
      );
      marker.className = 'jp-LinkMaker-relationshipMarker';
      marker.setAttribute(
        'aria-label',
        `Explore ${links.length} relationships for code cell`
      );
      marker.title = links[0].text;
      const pointerEnter = (): void => {
        this.cancelPreviewReset();
        if (this.pinned) {
          return;
        }
        if (this.cursor < 0) {
          this.renderPreview(links);
        }
        void this.showRelatedMarkdown(links, cell.node);
      };
      const pointerLeave = (): void => this.schedulePreviewReset();
      cell.node.addEventListener('pointerenter', pointerEnter);
      cell.node.addEventListener('pointerleave', pointerLeave);
      this.cellHoverHandlers.push({
        node: cell.node,
        pointerEnter,
        pointerLeave
      });
      marker.addEventListener('focus', () => {
        if (this.pinned) {
          return;
        }
        if (this.cursor < 0) {
          this.renderPreview(links);
        }
        void this.showRelatedMarkdown(links, cell.node);
      });
      cell.node.append(marker);
      this.markers.push(marker);
    });
    this.render(
      this.markers.length
        ? 'Hover a relationship marker to preview; click to explore.'
        : 'No saved relationships available. Run relationship analysis in the Notebook Inspector.'
    );
  };

  private linksFor(cellId: string): IVisit[] {
    const cell = this.panel.content.widgets.find(
      widget => widget.model.id === cellId
    );
    if (!cell) {
      return [];
    }
    const ids = new Set(
      cell.node.dataset.linkmakerRelationshipIds?.split(',') ?? []
    );
    const visits: IVisit[] = [];
    this.panel.content.widgets.forEach(markdown => {
      if (markdown.model.type !== 'markdown') {
        return;
      }
      const reasons = getRelationshipTooltipContent(markdown.node).entries;
      getMarkdownPortionRelationships(markdown.node).forEach(link => {
        if (
          !ids.has(link.id) ||
          markdown.model.sharedModel
            .getSource()
            .slice(link.startOffset, link.endOffset) !== link.text
        ) {
          return;
        }
        const reason = reasons.find(entry => entry.id === link.id);
        visits.push({
          cellId,
          relationshipId: link.id,
          markdownId: markdown.model.id,
          text: link.text,
          reason: reason?.text ?? 'No saved explanation.',
          kind: reason?.kind ?? 'code',
          color: link.color
        });
      });
    });
    return visits;
  }

  private visit(link: IVisit, links = this.linksFor(link.cellId)): void {
    this.clearRelatedMarkdown();
    this.pinned = true;
    this.pinnedLinks = links;
    this.detailRelationshipIds = [];
    this.pinnedDetailId = null;
    const current = this.history[this.cursor];
    if (
      current?.relationshipId !== link.relationshipId ||
      current?.cellId !== link.cellId
    ) {
      this.history = this.history.slice(0, this.cursor + 1);
      this.history.push(link);
      if (this.history.length > 50) {
        this.history.shift();
      }
      this.cursor = this.history.length - 1;
    }
    this.showCurrent();
    const cell = this.panel.content.widgets.find(
      widget => widget.model.id === link.cellId
    );
    if (cell) {
      void this.showRelatedMarkdown(links, cell.node, true);
    }
  }

  private showCurrent(): void {
    this.clearSelection();
    const current = this.history[this.cursor];
    if (!current) {
      this.render('Select a relationship marker.');
      return;
    }
    const cell = this.panel.content.widgets.find(
      widget => widget.model.id === current.cellId
    );
    if (!cell) {
      this.invalidate();
      return;
    }
    cell.node.classList.add('jp-LinkMaker-explorerSelected');
    const relationshipIds = new Set(
      this.pinnedLinks.map(item => item.relationshipId)
    );
    this.panel.content.widgets.forEach(widget => {
      if (widget.model.type === 'markdown') {
        return;
      }
      const linked =
        widget.node.dataset.linkmakerRelationshipIds
          ?.split(',')
          .some(id => relationshipIds.has(id)) ?? false;
      widget.node.classList.toggle('jp-LinkMaker-focusDimmed', !linked);
      widget.node.classList.toggle('jp-LinkMaker-hoverLinkedCode', linked);
      if (linked) {
        widget.node.style.setProperty(
          '--jp-linkmaker-active-color',
          this.pinnedLinks.find(item =>
            widget.node.dataset.linkmakerRelationshipIds
              ?.split(',')
              .includes(item.relationshipId)
          )?.color ?? current.color
        );
      } else {
        widget.node.style.removeProperty('--jp-linkmaker-active-color');
      }
    });
    cell.node
      .querySelectorAll<HTMLElement>(
        '[data-linkmaker-code-relationship], [data-linkmaker-bounding-relationship-id]'
      )
      .forEach(mark => {
        if (
          relationshipIds.has(
            mark.dataset.linkmakerCodeRelationship ??
              mark.dataset.linkmakerBoundingRelationshipId ??
              ''
          )
        ) {
          mark.classList.add('jp-LinkMaker-explorerEvidence');
        }
      });
    this.positionEvidence();
    cell.node.scrollIntoView({ block: 'nearest' });
    this.render();
  }

  private positionEvidence(): void {
    if (!this.active) {
      return;
    }
    const relationshipIds = this.pinned
      ? this.detailRelationshipIds
      : this.previewLinks.map(link => link.relationshipId);
    this.panel.content.node
      .querySelectorAll<HTMLElement>('.jp-LinkMaker-outputRelated')
      .forEach(output => {
        const outputIds =
          output.dataset.linkmakerOutputRelationshipIds
            ?.split(',')
            .filter(Boolean) ?? [];
        const activeId = outputIds.find(id => relationshipIds.includes(id));
        output.classList.toggle(
          'jp-LinkMaker-hoverLinkedOutput',
          activeId !== undefined
        );
        if (activeId !== undefined) {
          const colors =
            output.dataset.linkmakerRelationshipColors
              ?.split(',')
              .filter(Boolean) ?? [];
          const color = colors[outputIds.indexOf(activeId)];
          if (color) {
            output.style.setProperty('--jp-linkmaker-active-color', color);
          }
        } else {
          output.style.removeProperty('--jp-linkmaker-active-color');
        }
        updateOutputBoundingBoxes(output, relationshipIds);
      });
  }

  private clearSelection(): void {
    this.panel.content.node
      .querySelectorAll<HTMLElement>('.jp-LinkMaker-outputRelated')
      .forEach(output => updateOutputBoundingBoxes(output, []));
    this.panel.node
      .querySelectorAll(
        '.jp-LinkMaker-explorerSelected, .jp-LinkMaker-explorerEvidence, .jp-LinkMaker-focusDimmed, .jp-LinkMaker-hoverLinkedCode, .jp-LinkMaker-hoverLinkedOutput'
      )
      .forEach(node => {
        node.classList.remove(
          'jp-LinkMaker-explorerSelected',
          'jp-LinkMaker-explorerEvidence',
          'jp-LinkMaker-focusDimmed',
          'jp-LinkMaker-hoverLinkedCode',
          'jp-LinkMaker-hoverLinkedOutput'
        );
        if (node instanceof HTMLElement) {
          node.style.removeProperty('--jp-linkmaker-active-color');
        }
      });
  }

  private renderPreview(links: IVisit[]): void {
    this.render('Preview — click a relationship to keep it open.');
    links.forEach(link =>
      this.aside.append(this.button(link.text, () => this.visit(link)))
    );
  }

  /** Render and align every related Markdown cell beside the code. */
  private async showRelatedMarkdown(
    links: IVisit[],
    codeNode: HTMLElement,
    pinned = false
  ): Promise<void> {
    this.clearRelatedMarkdown();
    this.pinned = pinned;
    this.previewLinks = pinned ? [] : links;
    const generation = this.previewGeneration;
    const markdownIds = new Set(links.map(link => link.markdownId));
    const panelRect = this.panel.node.getBoundingClientRect();
    let nextTop = codeNode.getBoundingClientRect().top - panelRect.top;
    this.panel.node.classList.add('jp-LinkMaker-explorerRelationshipVisible');
    this.positionEvidence();
    this.aside.hidden = true;

    for (const cell of this.panel.content.widgets) {
      if (cell.model.type !== 'markdown' || !markdownIds.has(cell.model.id)) {
        continue;
      }
      const cellLinks = links.filter(link => link.markdownId === cell.model.id);
      const preview = document.createElement('article');
      preview.className =
        'jp-Cell jp-MarkdownCell jp-LinkMaker-explorerRelatedMarkdown jp-LinkMaker-hoverLinkedMarkdown';
      preview.style.setProperty(
        '--jp-linkmaker-active-color',
        cellLinks[0]?.color ?? 'var(--jp-brand-color1)'
      );
      preview.style.setProperty(
        '--jp-linkmaker-explorer-related-top',
        `${nextTop}px`
      );
      preview.style.setProperty('--jp-linkmaker-explorer-related-left', '8px');
      this.panel.node.append(preview);
      this.relatedMarkdown.push(preview);

      const renderer =
        this.panel.content.rendermime.createRenderer('text/markdown');
      this.previewRenderers.push(renderer);
      const portionHost = document.createElement('div');
      portionHost.className = 'jp-LinkMaker-explorerMarkdownPortions';
      renderer.node.hidden = true;
      preview.append(portionHost, renderer.node);
      await renderer.renderModel(
        new MimeModel({
          data: { 'text/markdown': cell.model.sharedModel.getSource() },
          trusted: cell.model.trusted
        })
      );
      if (generation !== this.previewGeneration || !preview.isConnected) {
        continue;
      }

      for (const link of cellLinks) {
        const portionRenderer =
          this.panel.content.rendermime.createRenderer('text/markdown');
        this.previewRenderers.push(portionRenderer);
        await portionRenderer.renderModel(
          new MimeModel({
            data: { 'text/markdown': link.text },
            trusted: cell.model.trusted
          })
        );
        const marks = highlightRenderedText(
          renderer.node,
          portionRenderer.node.textContent ?? link.text,
          link.color,
          link.relationshipId
        );
        portionRenderer.node.classList.add(
          'jp-LinkMaker-explorerMarkdownPortion'
        );
        portionRenderer.node.dataset.linkmakerRelationshipId =
          link.relationshipId;
        portionRenderer.node.style.setProperty(
          '--jp-linkmaker-active-color',
          link.color
        );
        this.bindDetailTarget(portionRenderer.node, link);
        marks.forEach(mark => this.bindDetailTarget(mark, link));
        portionHost.append(portionRenderer.node);
      }

      const controls = document.createElement('div');
      controls.className = 'jp-LinkMaker-explorerMarkdownControls';
      const expand = this.button('Show whole cell', () => {
        const expanded = renderer.node.hidden;
        renderer.node.hidden = !expanded;
        portionHost.hidden = expanded;
        expand.textContent = expanded
          ? 'Show related portion'
          : 'Show whole cell';
      });
      controls.append(expand);
      if (pinned) {
        const close = this.button('Close relationship', () => {
          this.resetPinnedRelationship();
        });
        close.className = 'jp-LinkMaker-explorerCloseRelationship';
        controls.append(close);
      }
      preview.prepend(controls);
      const pointerEnter = (): void => this.cancelPreviewReset();
      const pointerLeave = (): void => this.schedulePreviewReset();
      preview.addEventListener('pointerenter', pointerEnter);
      preview.addEventListener('pointerleave', pointerLeave);
      this.markdownHoverHandlers.push({
        node: preview,
        pointerEnter,
        pointerLeave
      });
      nextTop += Math.max(preview.offsetHeight, 80) + 8;
    }
  }

  /** Let one Markdown excerpt control one chart/table target in detail mode. */
  private bindDetailTarget(node: HTMLElement, link: IVisit): void {
    node.addEventListener('pointerenter', () => {
      if (this.pinned) {
        this.showDetailRelationship(link.relationshipId);
      }
    });
    node.addEventListener('pointerleave', () => {
      if (this.pinned && this.pinnedDetailId !== link.relationshipId) {
        this.showDetailRelationship(null);
      }
    });
    node.addEventListener('click', event => {
      if (!this.pinned) {
        return;
      }
      event.stopPropagation();
      this.pinnedDetailId =
        this.pinnedDetailId === link.relationshipId
          ? null
          : link.relationshipId;
      this.showDetailRelationship(this.pinnedDetailId);
    });
  }

  private showDetailRelationship(relationshipId: string | null): void {
    this.detailRelationshipIds = relationshipId ? [relationshipId] : [];
    this.panel.node
      .querySelectorAll<HTMLElement>('[data-linkmaker-relationship-id]')
      .forEach(node =>
        node.classList.toggle(
          'jp-LinkMaker-explorerMarkdownDetailActive',
          node.dataset.linkmakerRelationshipId === relationshipId
        )
      );
    this.positionEvidence();
  }

  /** Keep the preview open while crossing the gap between linked cells. */
  private schedulePreviewReset(): void {
    this.cancelPreviewReset();
    this.previewResetTimer = window.setTimeout(() => {
      this.previewResetTimer = null;
      if (this.pinned) {
        return;
      }
      this.clearRelatedMarkdown();
      this.aside.hidden = true;
    }, 120);
  }

  private cancelPreviewReset(): void {
    if (this.previewResetTimer !== null) {
      window.clearTimeout(this.previewResetTimer);
      this.previewResetTimer = null;
    }
  }

  private clearRelatedMarkdown(): void {
    this.previewGeneration += 1;
    this.cancelPreviewReset();
    this.markdownHoverHandlers.forEach(
      ({ node, pointerEnter, pointerLeave }) => {
        node.removeEventListener('pointerenter', pointerEnter);
        node.removeEventListener('pointerleave', pointerLeave);
      }
    );
    this.markdownHoverHandlers = [];
    this.relatedMarkdown.forEach(node => node.remove());
    this.relatedMarkdown = [];
    this.panel.node.classList.remove(
      'jp-LinkMaker-explorerRelationshipVisible'
    );
    this.previewRenderers.forEach(renderer => renderer.dispose());
    this.previewRenderers = [];
    this.previewLinks = [];
    this.positionEvidence();
  }

  private render(message?: string): void {
    this.aside.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = 'Related Markdown';
    this.aside.append(heading);
    const controls = document.createElement('div');
    controls.className = 'jp-LinkMaker-explorerControls';
    const back = this.button('Back', () => {
      this.cursor--;
      this.showCurrent();
    });
    back.disabled = this.cursor <= 0;
    const forward = this.button('Forward', () => {
      this.cursor++;
      this.showCurrent();
    });
    forward.disabled = this.cursor >= this.history.length - 1;
    const reveal = this.button(
      this.panel.node.classList.contains('jp-LinkMaker-explorerShowMarkdown')
        ? 'Hide all Markdown'
        : 'Show all Markdown',
      () => {
        this.panel.node.classList.toggle('jp-LinkMaker-explorerShowMarkdown');
        this.render();
      }
    );
    controls.append(
      back,
      forward,
      reveal,
      this.button('Close detail', () => {
        this.resetPinnedRelationship();
        this.node.focus();
      })
    );
    this.aside.append(controls);
    const current = this.history[this.cursor];
    if (message || !current) {
      const text = document.createElement('p');
      text.textContent = message ?? 'Select a relationship marker.';
      this.aside.append(text);
    } else {
      const source = this.panel.content.widgets.find(
        widget => widget.model.id === current.markdownId
      );
      const headingText = source?.model.sharedModel
        .getSource()
        .match(/^#{1,6}\s+(.+)$/m)?.[1];
      const label = document.createElement('h3');
      label.textContent =
        headingText ??
        `Markdown cell ${this.panel.content.widgets.findIndex(widget => widget.model.id === current.markdownId) + 1}`;
      const excerpt = document.createElement('blockquote');
      excerpt.textContent = current.text;
      const reason = document.createElement('p');
      reason.textContent = `Model suggestion · ${current.kind}: ${current.reason}`;
      this.aside.append(
        label,
        excerpt,
        reason,
        this.button('Go to original Markdown', () => {
          this.panel.node.classList.add('jp-LinkMaker-explorerShowMarkdown');
          source?.node.scrollIntoView({ block: 'center' });
          this.render();
        })
      );
      this.linksFor(current.cellId).forEach(link => {
        const button = this.button(link.text, () => this.visit(link));
        button.setAttribute(
          'aria-pressed',
          String(link.relationshipId === current.relationshipId)
        );
        this.aside.append(button);
      });
    }
    const historyHeading = document.createElement('h3');
    historyHeading.textContent = `History (${this.history.length})`;
    this.aside.append(historyHeading);
    this.history.forEach((entry, index) => {
      const button = this.button(
        `${index + 1}. ${entry.text.slice(0, 90)}`,
        () => {
          this.cursor = index;
          this.showCurrent();
        }
      );
      button.setAttribute('aria-current', String(index === this.cursor));
      this.aside.append(button);
    });
    this.aside.append(
      this.button('Clear history', () => {
        this.history = [];
        this.cursor = -1;
        this.resetPinnedRelationship();
        this.render();
      })
    );
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', event => {
      event.stopPropagation();
      action();
    });
    return button;
  }

  private onKey = (event: KeyboardEvent): void => {
    if (this.active && event.key === 'Escape' && this.pinned) {
      event.preventDefault();
      this.resetPinnedRelationship();
      this.node.focus();
    }
  };

  private resetPinnedRelationship(): void {
    this.pinned = false;
    this.pinnedLinks = [];
    this.detailRelationshipIds = [];
    this.pinnedDetailId = null;
    this.clearSelection();
    this.clearRelatedMarkdown();
    this.aside.hidden = true;
  }

  private onExplorerClick = (event: Event): void => {
    if (!this.active || !(event.target instanceof Element)) {
      return;
    }
    const codeNode = event.target.closest<HTMLElement>('.jp-CodeCell');
    const cell = this.panel.content.widgets.find(
      widget => widget.node === codeNode && widget.model.type === 'code'
    );
    if (!cell) {
      return;
    }
    const links = this.linksFor(cell.model.id);
    if (links.length > 0) {
      this.visit(links[0], links);
    }
  };

  private resizeObserver: ResizeObserver | null = null;
  private active = false;
  private config: NotebookPanel['content']['notebookConfig'] | null = null;
  private aside = document.createElement('aside');
  private markers: HTMLButtonElement[] = [];
  private cellHoverHandlers: Array<{
    node: HTMLElement;
    pointerEnter: EventListener;
    pointerLeave: EventListener;
  }> = [];
  private markdownHoverHandlers: Array<{
    node: HTMLElement;
    pointerEnter: EventListener;
    pointerLeave: EventListener;
  }> = [];
  private relatedMarkdown: HTMLElement[] = [];
  private previewRenderers: Widget[] = [];
  private previewResetTimer: number | null = null;
  private previewGeneration = 0;
  private pinned = false;
  private pinnedLinks: IVisit[] = [];
  private previewLinks: IVisit[] = [];
  private detailRelationshipIds: string[] = [];
  private pinnedDetailId: string | null = null;
  private history: IVisit[] = [];
  private cursor = -1;
}
