let nextTooltipId = 0;
let closeActiveTooltip: (() => void) | null = null;

export interface IRelationshipTooltipContent {
  activeIds: string[];
  entries: Array<{
    color: string;
    id: string;
    kind: 'code' | 'output';
    text: string;
  }>;
}

/** Attach a keyboard-accessible explanation that remains open while hovered. */
export function attachRelationshipTooltip(
  node: HTMLElement,
  getContent: (event: Event) => IRelationshipTooltipContent
): () => void {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const originalTabIndex = node.getAttribute('tabindex');
  const originalDescription = node.getAttribute('aria-describedby');
  if (originalTabIndex === null) {
    node.tabIndex = 0;
  }
  const card = document.createElement('div');
  card.id = `jp-LinkMaker-reason-${nextTooltipId++}`;
  card.className = 'jp-LinkMaker-reasonCard';
  card.setAttribute('role', 'tooltip');
  const heading = document.createElement('strong');
  heading.textContent = 'Why linked';
  const body = document.createElement('div');
  card.append(heading, body);
  let timer: number | null = null;
  let dismissed = false;
  let pendingContent: IRelationshipTooltipContent = {
    activeIds: [],
    entries: []
  };
  let pendingKey = '';
  const cancelTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const close = (): void => {
    cancelTimer();
    card.remove();
    if (originalDescription === null) {
      node.removeAttribute('aria-describedby');
    } else {
      node.setAttribute('aria-describedby', originalDescription);
    }
    if (closeActiveTooltip === close) {
      closeActiveTooltip = null;
    }
  };
  const open = (): void => {
    timer = null;
    if (dismissed || !node.isConnected || pendingContent.entries.length === 0) {
      return;
    }
    if (closeActiveTooltip !== close) {
      closeActiveTooltip?.();
    }
    closeActiveTooltip = close;
    renderContent(body, card, pendingContent);
    document.body.append(card);
    node.setAttribute(
      'aria-describedby',
      [originalDescription, card.id].filter(Boolean).join(' ')
    );
    const rect = node.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - card.offsetWidth - 8))}px`;
    const below = rect.bottom + 8;
    card.style.top = `${Math.max(8, Math.min(below, window.innerHeight - card.offsetHeight - 8))}px`;
  };
  const preview = (event: Event): void => {
    // Output widgets handle their own explanations rather than the parent cell.
    if (
      event.target instanceof Element &&
      event.target.closest('.jp-LinkMaker-outputRelated') !== null &&
      !node.classList.contains('jp-LinkMaker-outputRelated')
    ) {
      return;
    }
    const content = getContent(event);
    const key = JSON.stringify(content);
    if (card.isConnected) {
      cancelTimer();
    }
    if (key === pendingKey && (timer !== null || card.isConnected)) {
      return;
    }
    pendingContent = content;
    pendingKey = key;
    cancelTimer();
    if (card.isConnected) {
      renderContent(body, card, content);
    } else if (!dismissed && content.entries.length > 0) {
      timer = window.setTimeout(open, 150);
    }
  };
  const leave = (): void => {
    cancelTimer();
    dismissed = false;
    if (!node.contains(document.activeElement)) {
      timer = window.setTimeout(close, 300);
    }
  };
  node.addEventListener('pointerenter', preview, options);
  node.addEventListener('pointermove', preview, options);
  node.addEventListener('focusin', preview, options);
  node.addEventListener('pointerleave', leave, options);
  node.addEventListener('focusout', leave, options);
  card.addEventListener('pointerenter', cancelTimer, options);
  card.addEventListener('pointerleave', leave, options);
  document.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Escape' && (card.isConnected || timer !== null)) {
        dismissed = true;
        close();
      }
    },
    options
  );
  window.addEventListener(
    'scroll',
    event => {
      if (!(event.target instanceof Node) || !card.contains(event.target)) {
        close();
      }
    },
    { ...options, capture: true }
  );
  window.addEventListener('resize', close, options);
  return () => {
    close();
    controller.abort();
    if (originalTabIndex === null) {
      node.removeAttribute('tabindex');
    } else {
      node.setAttribute('tabindex', originalTabIndex);
    }
  };
}

function renderContent(
  body: HTMLElement,
  card: HTMLElement,
  content: IRelationshipTooltipContent
): void {
  body.replaceChildren();
  const activeIds = new Set(content.activeIds);
  card.toggleAttribute('data-linkmaker-has-active', activeIds.size > 0);
    const entries = [...content.entries].sort(
      (left, right) =>
        Number(activeIds.has(right.id)) - Number(activeIds.has(left.id))
    );
    entries.forEach(entry => {
    const explanation = document.createElement('div');
    explanation.className = 'jp-LinkMaker-reasonEntry';
    explanation.dataset.linkmakerRelationshipId = entry.id;
    explanation.classList.toggle(
      'jp-LinkMaker-reasonEntryActive',
      activeIds.has(entry.id)
    );
    explanation.style.setProperty('--jp-linkmaker-reason-color', entry.color);
    explanation.textContent = `${entry.kind === 'code' ? 'Code' : 'Output'} relationship ${Number(entry.id) + 1}: ${entry.text}`;
    body.append(explanation);
  });
}
