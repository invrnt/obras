import { NextResponse } from "next/server";

import { isAdminAuthenticated } from "@/lib/auth";
import { buildMediaKey, isAllowedMediaType, saveMediaStream } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Raw upload: POST the file bytes as the body.
 * Query: ?playId=...&fileName=...  Header: Content-Type of the file.
 */
export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const playId = searchParams.get("playId") || "general";
  const fileName = searchParams.get("fileName") || "";
  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim();

  if (!fileName) {
    return NextResponse.json({ error: "Falta el nombre del archivo." }, { status: 400 });
  }

  if (!isAllowedMediaType(contentType)) {
    return NextResponse.json({ error: "Solo se aceptan imágenes o audios." }, { status: 400 });
  }

  if (!request.body) {
    return NextResponse.json({ error: "El archivo está vacío." }, { status: 400 });
  }

  try {
    const stored = await saveMediaStream(buildMediaKey(playId, fileName, contentType), request.body);
    return NextResponse.json({ url: stored.url, key: stored.key, size: stored.size });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo guardar el archivo." },
      { status: 500 },
    );
  }
}
