import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { buildMediaPath } from "@/lib/media";
import { getMediaDir } from "@/lib/paths";
import { sanitizeFilename } from "@/lib/utils";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
};

const EXTENSIONS_BY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(CONTENT_TYPES).map(([ext, type]) => [type, ext]),
);

export function contentTypeForKey(key: string) {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] || "application/octet-stream";
}

export function isAllowedMediaType(contentType: string) {
  return contentType.startsWith("image/") || contentType.startsWith("audio/");
}

/** Resolves a media key to an absolute path, refusing anything outside the media dir. */
export function resolveMediaPath(key: string) {
  const root = getMediaDir();
  const normalizedKey = key.replace(/^\/+/, "");
  const absolute = path.resolve(root, normalizedKey);

  if (!normalizedKey || (absolute !== root && !absolute.startsWith(root + path.sep))) {
    return null;
  }

  return absolute;
}

export function buildMediaKey(playId: string, originalName: string, contentType = "") {
  const extension =
    path.extname(originalName).toLowerCase() ||
    EXTENSIONS_BY_TYPE[contentType] ||
    (contentType.startsWith("image/") ? ".png" : ".mp3");
  const safeName = sanitizeFilename(path.basename(originalName, path.extname(originalName))) || "archivo";
  const safePlayId = sanitizeFilename(playId) || "general";
  return `plays/${safePlayId}/${Date.now()}-${safeName}${extension}`;
}

export type StoredMedia = {
  key: string;
  url: string;
  size: number;
  contentType: string;
};

async function finalizeStored(key: string): Promise<StoredMedia> {
  const absolute = resolveMediaPath(key)!;
  const stat = await fsp.stat(absolute);
  return { key, url: buildMediaPath(key), size: stat.size, contentType: contentTypeForKey(key) };
}

/** Streams a web ReadableStream (e.g. request.body) to disk atomically. */
export async function saveMediaStream(key: string, body: ReadableStream<Uint8Array>) {
  const absolute = resolveMediaPath(key);
  if (!absolute) throw new Error("Ruta de archivo inválida.");

  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.${Date.now()}.tmp`;

  try {
    await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(tmp));
    await fsp.rename(tmp, absolute);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }

  return finalizeStored(key);
}

/** Copies a local file into the media store. */
export async function saveMediaFromFile(key: string, sourcePath: string) {
  const absolute = resolveMediaPath(key);
  if (!absolute) throw new Error("Ruta de archivo inválida.");

  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.copyFile(sourcePath, absolute);
  return finalizeStored(key);
}

export async function statMedia(key: string) {
  const absolute = resolveMediaPath(key);
  if (!absolute) return null;

  try {
    const stat = await fsp.stat(absolute);
    return stat.isFile() ? { absolute, stat } : null;
  } catch {
    return null;
  }
}

export async function deleteMedia(key: string) {
  const absolute = resolveMediaPath(key);
  if (!absolute) return false;
  await fsp.rm(absolute, { force: true });
  return true;
}

export async function listMedia(prefix = "") {
  const root = getMediaDir();
  const start = resolveMediaPath(prefix || ".") ?? root;
  const results: StoredMedia[] = [];

  async function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        const key = path.relative(root, full).split(path.sep).join("/");
        const stat = await fsp.stat(full);
        results.push({ key, url: buildMediaPath(key), size: stat.size, contentType: contentTypeForKey(key) });
      }
    }
  }

  await walk(start);
  return results.sort((a, b) => a.key.localeCompare(b.key));
}
