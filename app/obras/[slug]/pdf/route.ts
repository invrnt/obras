import fs from "node:fs";
import { Readable } from "node:stream";

import { isAdminAuthenticated } from "@/lib/auth";
import { renderPlayPdf } from "@/lib/pdf";
import { findPlayIdByRef, getPlayStatusById } from "@/lib/plays";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteProps = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: RouteProps) {
  const { slug } = await params;
  const playId = await findPlayIdByRef(slug);
  const status = playId ? await getPlayStatusById(playId) : null;

  if (!status || (!(status.published && !status.hidden) && !(await isAdminAuthenticated()))) {
    return new Response("Obra no encontrada.", { status: 404 });
  }

  const actorId = new URL(request.url).searchParams.get("actor") || null;

  try {
    const pdf = await renderPlayPdf(status.id, actorId);
    const stream = Readable.toWeb(fs.createReadStream(pdf.file)) as ReadableStream<Uint8Array>;
    const asciiName = pdf.fileName.replace(/[^\x20-\x7e]/g, "_");

    return new Response(stream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.size),
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
        "Cache-Control": "private, no-store",
        "X-Obras-Pdf-Cache": pdf.cached ? "hit" : "miss",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo generar el PDF.";
    return new Response(message, { status: /actor/i.test(message) ? 400 : 500 });
  }
}
