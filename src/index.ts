import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';

import { NotebookInspectorWidget } from './NotebookInspectorWidget';
import {
  addTwoColumnLayoutControl,
  toggleTwoColumnLayout,
  TwoColumnNotebookLayoutExtension
} from './TwoColumnNotebookLayout';

const PLUGIN_ID = 'LinkMaker:plugin';
const OPEN_INSPECTOR_COMMAND = 'LinkMaker:open-notebook-inspector';
const TOGGLE_TWO_COLUMN_LAYOUT_COMMAND = 'LinkMaker:toggle-two-column-layout';

/**
 * Initialization data for the LinkMaker notebook inspector extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Show notebook metadata, cells, and outputs in a side panel.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    palette: ICommandPalette | null
  ) => {
    let inspector: NotebookInspectorWidget | null = null;
    app.docRegistry.addWidgetExtension(
      'Notebook',
      new TwoColumnNotebookLayoutExtension()
    );
    tracker.forEach(panel => {
      addTwoColumnLayoutControl(panel);
    });
    tracker.widgetAdded.connect((_, panel) => {
      addTwoColumnLayoutControl(panel);
    });

    /**
     * Create the notebook inspector if it does not exist, then return it.
     */
    const ensureInspector = (): NotebookInspectorWidget => {
      if (!inspector || inspector.isDisposed) {
        inspector = new NotebookInspectorWidget(
          tracker,
          app.serviceManager.contents
        );
        app.shell.add(inspector, 'right', { rank: 700 });
      }

      return inspector;
    };

    app.commands.addCommand(OPEN_INSPECTOR_COMMAND, {
      label: 'Open Notebook Inspector',
      caption:
        'Show notebook metadata, cells, and outputs for the active notebook',
      execute: () => {
        const widget = ensureInspector();
        app.shell.activateById(widget.id);
      }
    });

    app.commands.addCommand(TOGGLE_TWO_COLUMN_LAYOUT_COMMAND, {
      label: 'Toggle Two-Column Notebook Layout',
      caption: 'Show Markdown on the left and code with outputs on the right',
      execute: () => {
        const panel = tracker.currentWidget;
        if (!panel) {
          return;
        }
        addTwoColumnLayoutControl(panel);
        toggleTwoColumnLayout(panel);
      },
      isEnabled: () => tracker.currentWidget !== null
    });

    if (palette) {
      palette.addItem({
        command: OPEN_INSPECTOR_COMMAND,
        category: 'LinkMaker'
      });
      palette.addItem({
        command: TOGGLE_TWO_COLUMN_LAYOUT_COMMAND,
        category: 'LinkMaker'
      });
    }

    void app.restored.then(() => {
      const widget = ensureInspector();
      app.shell.activateById(widget.id);
    });
  }
};

export default plugin;
