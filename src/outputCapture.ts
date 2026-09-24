import { CodeCell } from '@jupyterlab/cells';
import { NotebookPanel } from '@jupyterlab/notebook';

import { OutputArtifact } from './api';
import { captureTableCells } from './tableCells';

const MAX_ARTIFACT_BYTES = 4_000_000;
const MAX_VISION_IMAGE_DIMENSION = 1600;
const MAX_VISION_IMAGE_PIXELS = 2_000_000;
const MAX_RASTER_SCALE = 3;

/** Capture visual chart and table outputs with stable notebook identities. */
export function captureNotebookOutputArtifacts(
  panel: NotebookPanel
): OutputArtifact[] {
  const artifacts: OutputArtifact[] = [];

  panel.content.widgets.forEach((cell, cellIndex) => {
    if (!(cell instanceof CodeCell)) {
      return;
    }
    panel.content.renderCellOutputs(cellIndex);
    cell.outputArea.widgets.forEach((output, outputIndex) => {
      const artifact = captureOutputArtifact(
        output.node,
        cell.model.id,
        cellIndex,
        outputIndex
      );
      if (artifact) {
        artifacts.push(artifact);
      }
    });
  });

  return artifacts;
}

/** Capture one rendered output, preferring charts before tabular HTML. */
function captureOutputArtifact(
  node: HTMLElement,
  cellId: string,
  cellIndex: number,
  outputIndex: number
): OutputArtifact | null {
  const image = node.querySelector('svg, canvas, img');
  if (image) {
    const capturedImage = captureImage(image);
    if (capturedImage && isWithinSizeLimit(capturedImage.content)) {
      return {
        cellId,
        cellIndex,
        content: capturedImage.content,
        imageHeight: capturedImage.imageHeight,
        imageWidth: capturedImage.imageWidth,
        kind: 'image',
        mimeType: capturedImage.mimeType,
        outputIndex,
        outputId: `${cellId}:${outputIndex}`
      };
    }
  }

  const table = node.querySelector('table');
  if (!table) {
    return null;
  }
  const content = table.outerHTML;
  if (!isWithinSizeLimit(content)) {
    return null;
  }
  return {
    cellId,
    cellIndex,
    content,
    kind: 'table',
    tableCells: captureTableCells(table),
    mimeType: 'text/html',
    outputIndex,
    outputId: `${cellId}:${outputIndex}`,
    text: table.textContent?.trim().slice(0, 20_000) ?? ''
  };
}

/** Serialize SVG, rasterize canvas, or reuse a safe image URL/data URL. */
function captureImage(element: Element): {
  content: string;
  imageHeight: number;
  imageWidth: number;
  mimeType: string;
} | null {
  if (element instanceof SVGElement) {
    const bounds = element.getBoundingClientRect();
    const clone = element.cloneNode(true) as SVGElement;
    clone.setAttribute('width', `${Math.max(1, Math.round(bounds.width))}`);
    clone.setAttribute('height', `${Math.max(1, Math.round(bounds.height))}`);
    const svg = new XMLSerializer().serializeToString(clone);
    return {
      content: `data:image/svg+xml;base64,${encodeBase64(svg)}`,
      imageHeight: Math.max(1, Math.round(bounds.height)),
      imageWidth: Math.max(1, Math.round(bounds.width)),
      mimeType: 'image/svg+xml'
    };
  }
  if (element instanceof HTMLCanvasElement) {
    try {
      return {
        content: element.toDataURL('image/png'),
        imageHeight: element.height,
        imageWidth: element.width,
        mimeType: 'image/png'
      };
    } catch (error) {
      console.warn(
        'Unable to capture canvas output for relationship analysis.',
        error
      );
      return null;
    }
  }
  if (element instanceof HTMLImageElement) {
    const source = element.currentSrc || element.src;
    if (!source) {
      return null;
    }
    try {
      const canvas = document.createElement('canvas');
      const sourceWidth = element.naturalWidth || element.width;
      const sourceHeight = element.naturalHeight || element.height;
      if (sourceWidth === 0 || sourceHeight === 0) {
        return source.startsWith('data:')
          ? {
              content: source,
              imageHeight: Math.max(1, element.height),
              imageWidth: Math.max(1, element.width),
              mimeType: mimeTypeFromImageUrl(source)
            }
          : null;
      }
      const scale = Math.max(
        1,
        Math.min(
          MAX_RASTER_SCALE,
          MAX_VISION_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight),
          Math.sqrt(MAX_VISION_IMAGE_PIXELS / (sourceWidth * sourceHeight))
        )
      );
      canvas.width = Math.round(sourceWidth * scale);
      canvas.height = Math.round(sourceHeight * scale);
      const context = canvas.getContext('2d');
      if (!context) {
        return null;
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      return {
        content: canvas.toDataURL('image/png'),
        imageHeight: canvas.height,
        imageWidth: canvas.width,
        mimeType: 'image/png'
      };
    } catch (error) {
      console.warn(
        'Unable to convert rendered image output into a model-ready data URL.',
        error
      );
      return null;
    }
  }
  return null;
}

function isWithinSizeLimit(content: string): boolean {
  return new TextEncoder().encode(content).byteLength <= MAX_ARTIFACT_BYTES;
}

function mimeTypeFromImageUrl(url: string): string {
  const match = url.match(/^data:([^;,]+)/);
  return match?.[1] ?? 'image/*';
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

