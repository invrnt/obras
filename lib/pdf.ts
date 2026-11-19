import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dbFirst } from "@/lib/db";
import { getDataDir } from "@/lib/paths";
import { slugify } from "@/lib/utils";

const PRINT_TOKEN_TTL_SECONDS = 10 * 60;

function readSecretFromEnvFile() {
  const file = process.env.OBRAS_ENV_FILE || path.join(os.homedir(), ".config/obras/server.env");
  try {
    const line = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("SESSION_SECRET="));
    return line ? line.slice("SESSION_SECRET=".length).trim() : "";
  } catch {
    return "";
  }
}

function getSecret() {
  const secret = process.env.SESSION_SECRET || readSecretFromEnvFile();
  if (!secret) throw new Error("Falta SESSION_SECRET para firmar la vista de impresión.");
  return secret;
}

function sign(payload: string) {
  return createHmac("sha256", getSecret()).update(`print:${payload}`).digest("base64url");
}

/** Short-lived token that lets the headless renderer open the print view of a non-public play. */
export function createPrintToken(playId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + PRINT_TOKEN_TTL_SECONDS;
  return `${expiresAt}.${sign(`${playId}.${expiresAt}`)}`;
}

export function isValidPrintToken(playId: string, token: string | null | undefined) {
  if (!token) return false;
  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature || Number(expiresAt) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(`${playId}.${expiresAt}`));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function getInternalBaseUrl() {
  return (process.env.OBRAS_INTERNAL_URL || "http://127.0.0.1:3410").replace(/\/+$/, "");
}

function getChromePath() {
  return process.env.OBRAS_CHROME_PATH || "/usr/bin/google-chrome-stable";
}

export function pdfFileName(title: string, actorName?: string | null) {
  const base = slugify(title) || "obra";
  return actorName ? `${base}-${slugify(actorName) || "actor"}.pdf` : `${base}.pdf`;
}

// One Chrome at a time: the mini PC has limited RAM.
let queue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>) {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function printUrlToPdf(url: string, outFile: string) {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "obras-pdf-"));

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        getChromePath(),
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--hide-scrollbars",
          `--user-data-dir=${profileDir}`,
          "--no-pdf-header-footer",
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=8000",
          `--print-to-pdf=${outFile}`,
          url,
        ],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (error) => (error ? reject(new Error(`Chrome no pudo generar el PDF: ${error.message}`)) : resolve()),
      );
    });

    const stat = await fsp.stat(outFile).catch(() => null);
    if (!stat || stat.size === 0) throw new Error("Chrome no generó el PDF.");
  } finally {
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
}

/** Changes on every `next build`, so a new design never serves an old cached PDF. */
function getBuildId() {
  const repo = process.env.OBRAS_REPO_DIR || "/home/cami/obras";
  try {
    return fs.readFileSync(path.join(repo, ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
}

type PlayRow = { id: string; slug: string; title: string; updated_at: string };

export type PlayPdf = { file: string; fileName: string; cached: boolean; size: number };

/**
 * Renders (or reuses from cache) the PDF of a play, optionally highlighting one actor.
 * The cache key includes the play's updated_at, so any edit produces a fresh PDF.
 */
export async function renderPlayPdf(playId: string, actorId?: string | null): Promise<PlayPdf> {
  const play = await dbFirst<PlayRow>(`SELECT id, slug, title, updated_at FROM plays WHERE id = ? LIMIT 1`, [playId]);
  if (!play) throw new Error("La obra no existe.");

  let actorName: string | null = null;
  if (actorId) {
    const actor = await dbFirst<{ name: string }>(`SELECT name FROM actors WHERE id = ? AND play_id = ? LIMIT 1`, [actorId, playId]);
    if (!actor) throw new Error("El actor no pertenece a esta obra.");
    actorName = actor.name;
  }

  const cacheDir = path.join(getDataDir(), "cache", "pdf", play.id);
  const key = createHash("sha1").update(`${play.updated_at}|${actorId ?? ""}|${getBuildId()}`).digest("hex").slice(0, 16);
  const file = path.join(cacheDir, `${key}.pdf`);
  const fileName = pdfFileName(play.title, actorName);

  const cachedStat = await fsp.stat(file).catch(() => null);
  if (cachedStat?.size) return { file, fileName, cached: true, size: cachedStat.size };

  return runExclusive(async () => {
    const again = await fsp.stat(file).catch(() => null);
    if (again?.size) return { file, fileName, cached: true, size: again.size };

    await fsp.mkdir(cacheDir, { recursive: true });
    // Drop PDFs of older versions of this play.
    for (const entry of await fsp.readdir(cacheDir)) {
      if (entry.endsWith(".pdf") && !entry.startsWith(key)) {
        const stale = path.join(cacheDir, entry);
        const stat = await fsp.stat(stale).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 60_000) await fsp.rm(stale, { force: true });
      }
    }

    const params = new URLSearchParams({ t: createPrintToken(play.id) });
    if (actorId) params.set("actor", actorId);
    const url = `${getInternalBaseUrl()}/obras/${encodeURIComponent(play.slug)}/imprimir?${params}`;
    const tmp = `${file}.${process.pid}.tmp`;

    try {
      await printUrlToPdf(url, tmp);
      await fsp.rename(tmp, file);
    } finally {
      await fsp.rm(tmp, { force: true });
    }

    const stat = await fsp.stat(file);
    return { file, fileName, cached: false, size: stat.size };
  });
}
