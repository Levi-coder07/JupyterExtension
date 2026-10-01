/* Behaviour checks for the prototype's navigation, using a minimal notebook host. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

function setup() {
  const dom = new JSDOM('<!doctype html><body></body>');
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  class Signal {
    slots = [];
    connect(fn, context) {
      this.slots.push([fn, context]);
    }
    disconnect(fn) {
      this.slots = this.slots.filter(slot => slot[0] !== fn);
    }
    emit() {
      [...this.slots].forEach(([fn, context]) => fn.call(context));
    }
  }
  class Widget {
    constructor({ node }) {
      this.node = node;
      this.isDisposed = false;
    }
    dispose() {
      this.isDisposed = true;
    }
  }
  const exports = {};
  const source = ts.transpileModule(
    fs.readFileSync('src/CodeRelationshipExplorer.ts', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }
  ).outputText;
  vm.runInNewContext(source, {
    exports,
    console,
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    require(name) {
      if (name === '@lumino/widgets') {
        return { Widget };
      }
      if (name === '@jupyterlab/rendermime') {
        return {
          MimeModel: class {
            constructor(options) {
              Object.assign(this, options);
            }
          }
        };
      }
      if (name === './relationshipVisualizer') {
        return {
          getMarkdownPortionRelationships: node => node.links ?? [],
          getRelationshipTooltipContent: () => ({ entries: [] }),
          loadRelationshipFile: async () => null,
          applyRelationshipHighlights: async () => 0
        };
      }
      if (name === './TwoColumnNotebookLayout') {
        return {
          isTwoColumnLayout: () => false,
          LINKMAKER_LAYOUT_CHANGED_EVENT: 'layout',
          updateOutputBoundingBoxes(node, ids) {
            node.dataset.testActiveIds = ids.join(',');
          },
          toggleTwoColumnLayout() {}
        };
      }
      throw new Error(name);
    }
  });
  const doc = dom.window.document;
  const makeCell = (id, type, text) => ({
    model: { id, type, sharedModel: { getSource: () => text } },
    node: doc.createElement('div')
  });
  const code = makeCell('code-1', 'code', 'x = 1');
  code.node.dataset.linkmakerRelationshipIds = '0,1';
  code.node.dataset.linkmakerRelationshipColors = '#f00,#00f';
  const output = doc.createElement('div');
  output.className = 'jp-LinkMaker-outputRelated';
  output.dataset.linkmakerOutputRelationshipIds = '1';
  output.dataset.linkmakerRelationshipColors = '#00f';
  code.node.append(output);
  const unrelatedCode = makeCell('code-2', 'code', 'y = 2');
  const markdown = makeCell('md-1', 'markdown', 'First.');
  markdown.node.links = [
    {
      id: '0',
      startOffset: 0,
      endOffset: 6,
      text: 'First.',
      color: '#f00'
    }
  ];
  const markdownTwo = makeCell('md-2', 'markdown', 'Second.');
  markdownTwo.node.links = [
    {
      id: '1',
      startOffset: 0,
      endOffset: 7,
      text: 'Second.',
      color: '#00f'
    }
  ];
  const contentNode = doc.createElement('div');
  contentNode.append(
    code.node,
    unrelatedCode.node,
    markdown.node,
    markdownTwo.node
  );
  const root = doc.createElement('div');
  root.append(contentNode);
  doc.body.append(root);
  let controller;
  const panel = {
    node: root,
    content: {
      node: contentNode,
      widgets: [code, unrelatedCode, markdown, markdownTwo],
      notebookConfig: { windowingMode: 'full' },
      rendermime: {
        createRenderer() {
          const node = doc.createElement('div');
          return {
            node,
            async renderModel(model) {
              node.textContent = model.data['text/markdown'];
            },
            dispose() {
              node.remove();
            }
          };
        }
      }
    },
    context: { ready: new Promise(() => {}), path: 'test.ipynb' },
    model: { contentChanged: new Signal() },
    disposed: new Signal(),
    toolbar: {
      addItem(name, widget) {
        controller = widget;
        return true;
      }
    }
  };
  exports.addCodeRelationshipExplorer(panel, {});
  controller.node.click();
  return {
    controller,
    panel,
    code,
    unrelatedCode,
    output,
    root,
    dom
  };
}

const click = (root, label) => {
  const button = [...root.querySelectorAll('button')].find(
    node => node.textContent === label
  );
  assert.ok(button, `Button exists: ${label}`);
  button.click();
};

test('hover brings highlighted Markdown beside code without entering history', async () => {
  const { controller, code, output, root, dom, unrelatedCode } = setup();
  const marker = code.node.querySelector('button');
  assert.equal(marker.textContent, '↔ 2');
  code.node.dispatchEvent(new dom.window.Event('pointerenter'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(root.textContent, /History \(0\)/);
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerRelatedMarkdown').length,
    2
  );
  assert.equal(root.querySelector('aside').hidden, true);
  assert.equal(
    unrelatedCode.node.classList.contains('jp-LinkMaker-focusDimmed'),
    false
  );
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerMarkdownHighlight').length,
    2
  );
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerMarkdownPortion').length,
    2
  );
  assert.equal(output.dataset.testActiveIds, '0,1');
  click(root, 'Show whole cell');
  assert.ok(
    [...root.querySelectorAll('button')].some(
      button => button.textContent === 'Show related portion'
    )
  );
  controller.clearRelatedMarkdown();
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerRelatedMarkdown').length,
    0
  );
});

test('pinning keeps all relationships and Escape restores focus', async () => {
  const { controller, code, output, root, unrelatedCode, dom } = setup();
  const marker = code.node.querySelector('button');
  marker.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    unrelatedCode.node.classList.contains('jp-LinkMaker-focusDimmed'),
    true
  );
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerRelatedMarkdown').length,
    2
  );
  assert.equal(output.dataset.testActiveIds, '');
  const outputPortion = [
    ...root.querySelectorAll('.jp-LinkMaker-explorerMarkdownPortion')
  ].find(node => node.dataset.linkmakerRelationshipId === '1');
  assert.ok(outputPortion);
  outputPortion.dispatchEvent(new dom.window.Event('pointerenter'));
  assert.equal(output.dataset.testActiveIds, '1');
  outputPortion.dispatchEvent(new dom.window.Event('pointerleave'));
  assert.equal(output.dataset.testActiveIds, '');
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape' })
  );
  assert.equal(
    unrelatedCode.node.classList.contains('jp-LinkMaker-focusDimmed'),
    false
  );
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerRelatedMarkdown').length,
    0
  );
  assert.equal(output.dataset.testActiveIds, '');
});

test('selected visits support back, forward and branching', () => {
  const { controller, code, root } = setup();
  const marker = code.node.querySelector('button');
  marker.click();
  click(root, 'Second.');
  assert.match(root.textContent, /History \(2\)/);
  click(root, 'Back');
  assert.equal(root.querySelector('blockquote').textContent, 'First.');
  click(root, 'Forward');
  assert.equal(root.querySelector('blockquote').textContent, 'Second.');
  click(root, 'Back');
  click(root, 'Second.');
  assert.equal(controller.history.length, 2);
  click(root, 'Clear history');
  assert.equal(controller.history.length, 0);
  assert.equal(
    root.querySelectorAll('.jp-LinkMaker-explorerSelected').length,
    0
  );
});

test('layout exit restores config and removes markers; disposal removes the panel', () => {
  const { controller, panel, code, root, dom } = setup();
  assert.equal(panel.content.notebookConfig.windowingMode, 'none');
  panel.content.node.dispatchEvent(
    new dom.window.Event('linkmaker:exit-code-explorer')
  );
  assert.equal(panel.content.notebookConfig.windowingMode, 'full');
  assert.equal(code.node.querySelectorAll('button').length, 0);
  assert.equal(root.classList.contains('jp-LinkMaker-codeExplorer'), false);
  controller.dispose();
  assert.equal(root.querySelector('aside'), null);
});

test('history is isolated and invalidated when relationships refresh', () => {
  const first = setup();
  const second = setup();
  first.code.node.querySelector('button').click();
  assert.equal(first.controller.history.length, 1);
  assert.equal(second.controller.history.length, 0);
  first.panel.content.node.dispatchEvent(
    new first.dom.window.Event('linkmaker:relationships-updated')
  );
  assert.equal(first.controller.history.length, 0);
  first.controller.invalidate();
  assert.equal(first.code.node.querySelector('button'), null);
  assert.match(first.root.textContent, /Notebook changed/);
});
