import { Contents, ServerConnection } from '@jupyterlab/services';

import { requestAPI } from './request';

export interface INotebookRelationshipAnalysisResponse {
  completedMarkdownCells: number;
  failedMarkdownCells: number;
  path: string;
  status: 'success' | 'partial';
}

export interface OutputArtifact {
  tableCells?: import('./tableCells').TableCellSnapshot[];
  cellId: string;
  cellIndex: number;
  content: string;
  kind: 'image' | 'table';
  mimeType: string;
  imageHeight?: number;
  imageWidth?: number;
  outputId: string;
  outputIndex: number;
  text?: string;
}

export interface SaveMediaRequest {
  cellIndex: number;
  mediaIndex: number;
  mimeType: string;
  notebookPath: string;
  outputIndex: number | null;
  rawData: string;
  source: 'mime-bundle' | 'rendered-dom';
}

interface SaveMediaResponse {
  directory: string;
  filename: string;
  path: string;
  status: 'success';
}

const MEDIA_DIRECTORY_NAME = 'linkmaker_media';
const MIME_EXTENSION_MAP: Record<string, string> = {
  'application/json': 'json',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/html': 'html',
  'text/plain': 'txt'
};

/**
 * Save a captured media item alongside the active notebook.
 */
export async function saveMediaToNotebookDirectory(
  payload: SaveMediaRequest,
  contentsManager: Contents.IManager
): Promise<SaveMediaResponse> {
  const notebookDirectory = getNotebookDirectory(
    contentsManager,
    payload.notebookPath
  );
  const mediaDirectory = sanitizeContentsPath(
    contentsManager.resolvePath(notebookDirectory, MEDIA_DIRECTORY_NAME)
  );

  await ensureDirectory(contentsManager, mediaDirectory);

  const filename = await buildUniqueFilename(
    contentsManager,
    mediaDirectory,
    payload
  );
  const path = sanitizeContentsPath(
    contentsManager.resolvePath(mediaDirectory, filename)
  );

  await contentsManager.save(
    path,
    buildFileModel(payload.mimeType, payload.rawData)
  );

  return {
    directory: mediaDirectory,
    filename,
    path,
    status: 'success'
  };
}

/**
 * Analyze every Markdown cell in a notebook and persist its relationship map.
 */
export async function analyzeNotebookRelationships(
  notebookPath: string,
  notebook: unknown
): Promise<INotebookRelationshipAnalysisResponse> {
  return requestAPI<INotebookRelationshipAnalysisResponse>(
    'analyze-notebook',
    ServerConnection.makeSettings(),
    {
      body: JSON.stringify({ notebookPath, notebook }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    }
  );
}

/** Analyze Markdown references to captured chart and table outputs. */
export async function analyzeNotebookOutputRelationships(
  notebookPath: string,
  notebook: unknown,
  outputArtifacts: OutputArtifact[]
): Promise<INotebookRelationshipAnalysisResponse> {
  return requestAPI<INotebookRelationshipAnalysisResponse>(
    'analyze-outputs',
    ServerConnection.makeSettings(),
    {
      body: JSON.stringify({ notebookPath, notebook, outputArtifacts }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    }
  );
}

function getNotebookDirectory(
  contentsManager: Contents.IManager,
  notebookPath: string
): string {
  const localPath = contentsManager.localPath(notebookPath);
  const slashIndex = localPath.lastIndexOf('/');
  const localDirectory =
    slashIndex === -1 ? '' : localPath.slice(0, slashIndex);
  const drive = contentsManager.driveName(notebookPath);

  return sanitizeContentsPath(
    drive ? `${drive}:${localDirectory}` : localDirectory
  );
}

async function ensureDirectory(
  contentsManager: Contents.IManager,
  directoryPath: string
): Promise<void> {
  try {
    const model = await contentsManager.get(directoryPath, { content: false });
    if (model.type !== 'directory') {
      throw new Error(`Path exists but is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      await contentsManager.save(directoryPath, { type: 'directory' });
      return;
    }

    throw error;
  }
}

async function buildUniqueFilename(
  contentsManager: Contents.IManager,
  mediaDirectory: string,
  payload: SaveMediaRequest
): Promise<string> {
  const notebookName = payload.notebookPath.split('/').pop() ?? 'notebook';
  const notebookStem = notebookName.replace(/\.ipynb$/i, '');
  const safeStem = slugify(notebookStem) || 'notebook';
  const baseNameParts = [
    `${safeStem}-cell-${String(payload.cellIndex + 1).padStart(3, '0')}`
  ];

  if (payload.outputIndex !== null) {
    baseNameParts.push(
      `output-${String(payload.outputIndex + 1).padStart(3, '0')}`
    );
  }

  baseNameParts.push(
    `media-${String(payload.mediaIndex + 1).padStart(3, '0')}`
  );

  const extension =
    MIME_EXTENSION_MAP[payload.mimeType] ?? mimeToExtension(payload.mimeType);
  const baseName = baseNameParts.join('-');

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`;
    const filename = `${baseName}${suffix}.${extension}`;
    const path = sanitizeContentsPath(
      contentsManager.resolvePath(mediaDirectory, filename)
    );
    const exists = await pathExists(contentsManager, path);
    if (!exists) {
      return filename;
    }
  }

  throw new Error('Could not find a free filename for the media export.');
}

async function pathExists(
  contentsManager: Contents.IManager,
  path: string
): Promise<boolean> {
  try {
    await contentsManager.get(path, { content: false });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function buildFileModel(
  mimeType: string,
  rawData: string
): Partial<Contents.IModel> {
  if (
    mimeType === 'image/png' ||
    mimeType === 'image/jpeg' ||
    mimeType === 'image/gif' ||
    mimeType === 'image/webp'
  ) {
    return {
      content: extractBase64Payload(rawData),
      format: 'base64',
      type: 'file'
    };
  }

  if (mimeType === 'application/json') {
    return {
      content: normalizeJsonText(rawData),
      format: 'text',
      type: 'file'
    };
  }

  return {
    content: rawData,
    format: 'text',
    type: 'file'
  };
}

function extractBase64Payload(rawData: string): string {
  if (rawData.startsWith('data:')) {
    const parts = rawData.split(',', 2);
    return parts[1] ?? '';
  }

  return rawData;
}

function normalizeJsonText(rawData: string): string {
  try {
    return JSON.stringify(JSON.parse(rawData), null, 2);
  } catch {
    return rawData;
  }
}

function mimeToExtension(mimeType: string): string {
  const subtype = mimeType.split('/').pop() ?? 'txt';
  return slugify(subtype) || 'txt';
}

function slugify(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .toLowerCase();
}

function sanitizeContentsPath(path: string): string {
  const parts = path.split(':');
  if (parts.length === 1) {
    return parts[0].replace(/^\/+/, '');
  }

  const drive = parts[0];
  const localPath = parts.slice(1).join(':').replace(/^\/+/, '');
  return `${drive}:${localPath}`;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof ServerConnection.ResponseError &&
    error.response.status === 404
  );
}
