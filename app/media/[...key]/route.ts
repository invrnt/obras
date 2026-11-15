import fs from "node:fs";
import { Readable } from "node:stream";

import { decodeMediaRouteKey } from "@/lib/media";
import { contentTypeForKey, statMedia } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MediaRouteProps = {
  params: Promise<{
    key: string[];
  }>;
};

// Keys include a timestamp and are never overwritten, so they are safe to cache forever.
const CACHE_CONTROL = "public, max-age=31536000, immutable";

function notFound() {
  return new Response("Archivo no encontrado.", { status: 404, headers: { "Cache-Control": "no-store" } });
}

function parseRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  let start: number;
  let end: number;

  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  return start <= end && start < size ? { start, end } : null;
}

async function serve(request: Request, { params }: MediaRouteProps, headOnly: boolean) {
  const { key } = await params;
  const objectKey = decodeMediaRouteKey(key);
  const media = objectKey ? await statMedia(objectKey) : null;

  if (!media) {
    return notFound();
  }

  const { absolute, stat } = media;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": CACHE_CONTROL,
    "Content-Disposition": "inline",
    "Content-Type": contentTypeForKey(objectKey),
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
  });

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const rangeHeader = request.headers.get("range");
  let status = 200;
  let start = 0;
  let end = stat.size - 1;

  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size);

    if (!range) {
      headers.set("Content-Range", `bytes */${stat.size}`);
      return new Response(null, { status: 416, headers });
    }

    ({ start, end } = range);
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }

  headers.set("Content-Length", String(stat.size === 0 ? 0 : end - start + 1));

  if (headOnly || stat.size === 0) {
    return new Response(null, { status, headers });
  }

  const stream = Readable.toWeb(fs.createReadStream(absolute, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}

export async function GET(request: Request, context: MediaRouteProps) {
  return serve(request, context, false);
}

export async function HEAD(request: Request, context: MediaRouteProps) {
  return serve(request, context, true);
}
