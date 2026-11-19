/**
 * Declarative play import/export used by the `obras` CLI.
 *
 * Runs outside Next.js (plain bun/node): never import `server-only`, `next/*`
 * or lib/admin-play-save.ts from here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { AutoAssignError, computeAutoAssignments, parseAutoAssign } from "@/lib/auto-assign";
import { getDb } from "@/lib/db";
import { buildMediaPath } from "@/lib/media";
import {
  createActor,
  createPlayWithId,
  deleteActor,
  deleteAssignment,
  getAdminPlayById,
  getAllPlayMarkdown,
  isSlugTaken,
  saveAssignment,
  setPlayActive,
  updateAssignmentRange,
  updatePlay,
  updatePlayHidden,
  updatePlayPublished,
} from "@/lib/plays";
import {
  buildMediaKey,
  contentTypeForKey,
  deleteMedia,
  isAllowedMediaType,
  listMedia,
  resolveMediaPath,
  saveMediaFromFile,
} from "@/lib/storage";
import type { AdminPlayDetail, AssignmentSummary } from "@/lib/types";
import { slugify } from "@/lib/utils";

export class CliError extends Error {
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

/** Start offsets of every occurrence of `needle` (overlapping occurrences included). */
export function findOccurrences(haystack: string, needle: string) {
  const result: number[] = [];

  if (!needle) {
    return result;
  }

  let index = haystack.indexOf(needle);

  while (index >= 0) {
    result.push(index);
    index = haystack.indexOf(needle, index + 1);
  }

  return result;
}

/**
 * Runs an async body inside one SQLite transaction. The CLI is single-threaded
 * and owns its own connection, so awaiting between statements is safe here.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = await fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function sha256File(filePath: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function isAudioKey(key: string) {
  return contentTypeForKey(key).startsWith("audio/");
}

/** Markdown snippet the admin editor would insert for this media file. */
export function mediaSnippet(key: string, alt?: string) {
  const url = buildMediaPath(key);

  if (isAudioKey(key)) {
    return `<audio controls src="${url}"></audio>`;
  }

  const label = (alt ?? path.basename(key).replace(/^\d+-/, "")).replace(/[[\]]/g, "");
  return `![${label}](${url})`;
}

export function getPublicBaseUrl() {
  return (process.env.OBRAS_PUBLIC_URL || "https://obras.orientador.co").replace(/\/+$/, "");
}

export function playUrls(play: { id: string; slug: string; published: boolean; hidden: boolean; isActive: boolean }) {
  const base = getPublicBaseUrl();
  const visible = play.published && !play.hidden;

  return {
    public: `${base}/obras/${play.slug}`,
    publicVisible: visible,
    home: play.isActive && visible ? `${base}/` : null,
    admin: `${base}/tramoya/obras/${play.id}`,
  };
}

// ---------------------------------------------------------------------------
// Media lookup / dedup
// ---------------------------------------------------------------------------

const MEDIA_URL_PATTERN = /\/media\/[^\s)"'<>]+/g;

function decodeMediaUrlToKey(url: string) {
  return url
    .replace(/^\/media\//, "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** Media keys referenced (as /media/... URLs) in a markdown string. */
export function referencedMediaKeys(markdown: string) {
  return [...new Set([...markdown.matchAll(MEDIA_URL_PATTERN)].map((match) => decodeMediaUrlToKey(match[0])))];
}

export async function allReferencedMediaKeys() {
  const keys = new Set<string>();

  for (const play of await getAllPlayMarkdown()) {
    for (const key of referencedMediaKeys(play.markdown)) {
      keys.add(key);
    }
  }

  return keys;
}

type MediaIndex = {
  bySize: Map<number, string[]>;
  hashCache: Map<string, string>;
};

async function buildMediaIndex(): Promise<MediaIndex> {
  const bySize = new Map<number, string[]>();

  for (const item of await listMedia("")) {
    const list = bySize.get(item.size) ?? [];
    list.push(item.key);
    bySize.set(item.size, list);
  }

  return { bySize, hashCache: new Map() };
}

/** Finds an already stored file with identical content. Preference order: preferred keys, same play folder, anything. */
function findExistingMedia(index: MediaIndex, size: number, hash: string, playId: string, preferred: Set<string>) {
  const matches: string[] = [];

  for (const key of index.bySize.get(size) ?? []) {
    let keyHash = index.hashCache.get(key);

    if (!keyHash) {
      const absolute = resolveMediaPath(key);
      if (!absolute) continue;
      keyHash = sha256File(absolute);
      index.hashCache.set(key, keyHash);
    }

    if (keyHash === hash) {
      matches.push(key);
    }
  }

  return (
    matches.find((key) => preferred.has(key)) ??
    matches.find((key) => key.startsWith(`plays/${playId}/`)) ??
    matches[0] ??
    null
  );
}

export type StoreMediaResult = {
  name: string;
  file: string;
  key: string;
  url: string;
  contentType: string;
  size: number;
  reused: boolean;
  snippet: string;
};

/** Plans storage of local files for a play (dedup by content hash). Does not write anything. */
async function planMediaStorage(
  files: Array<{ name: string; file: string; alt?: string }>,
  playId: string,
  preferred: Set<string>,
) {
  const index = await buildMediaIndex();
  const planned: StoreMediaResult[] = [];
  const byHash = new Map<string, string>();

  for (const entry of files) {
    const contentType = contentTypeForKey(entry.file);
    const stat = fs.statSync(entry.file);
    const hash = sha256File(entry.file);
    const existing = byHash.get(hash) ?? findExistingMedia(index, stat.size, hash, playId, preferred);
    let key = existing ?? buildMediaKey(playId, path.basename(entry.file), contentType);

    if (!existing) {
      // Same basename + same millisecond but different content: keep keys distinct.
      const baseKey = key;
      let counter = 2;
      while (planned.some((item) => item.key === key)) {
        key = baseKey.replace(/(\.[^./]+)?$/, (ext) => `-${counter}${ext}`);
        counter += 1;
      }
    }


    byHash.set(hash, key);
    planned.push({
      name: entry.name,
      file: entry.file,
      key,
      url: buildMediaPath(key),
      contentType,
      size: stat.size,
      reused: Boolean(existing) || planned.some((item) => item.key === key),
      snippet: mediaSnippet(key, entry.alt ?? entry.name),
    });
  }

  return planned;
}

async function writePlannedMedia(planned: StoreMediaResult[]) {
  const written: string[] = [];

  try {
    for (const item of planned) {
      if (item.reused || written.includes(item.key)) continue;
      await saveMediaFromFile(item.key, item.file);
      written.push(item.key);
    }
  } catch (error) {
    await rollbackMedia(written);
    throw error;
  }

  return written;
}

async function rollbackMedia(keys: string[]) {
  for (const key of keys) {
    await deleteMedia(key).catch(() => undefined);
  }
}

function validateMediaFile(file: string, label: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new CliError(`Archivo de ${label} no encontrado: ${file}`);
  }

  const contentType = contentTypeForKey(file);

  if (!isAllowedMediaType(contentType)) {
    throw new CliError(`Tipo de archivo no permitido (${contentType}) en ${file}. Solo imágenes o audios.`);
  }
}

/** Copies local files into the media store for a play (reusing identical files). */
export async function storeMediaFiles(playId: string, files: string[], currentMarkdown = "") {
  const entries = files.map((file) => {
    const absolute = path.resolve(file);
    validateMediaFile(absolute, "medio");
    return { name: path.basename(absolute, path.extname(absolute)), file: absolute };
  });
  const planned = await planMediaStorage(entries, playId, new Set(referencedMediaKeys(currentMarkdown)));
  await writePlannedMedia(planned);
  return planned;
}

// ---------------------------------------------------------------------------
// Assignment relocation (when the markdown changes)
// ---------------------------------------------------------------------------

export type RelocationResult = {
  kept: AssignmentSummary[];
  moved: Array<{ assignment: AssignmentSummary; startOffset: number; endOffset: number }>;
  lost: AssignmentSummary[];
};

export function relocateAssignments(oldMarkdown: string, newMarkdown: string, assignments: AssignmentSummary[]): RelocationResult {
  const result: RelocationResult = { kept: [], moved: [], lost: [] };

  if (oldMarkdown === newMarkdown) {
    result.kept = [...assignments];
    return result;
  }

  const maxCommon = Math.min(oldMarkdown.length, newMarkdown.length);
  let prefix = 0;

  while (prefix < maxCommon && oldMarkdown[prefix] === newMarkdown[prefix]) prefix += 1;

  let suffix = 0;

  while (
    suffix < maxCommon - prefix &&
    oldMarkdown[oldMarkdown.length - 1 - suffix] === newMarkdown[newMarkdown.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const delta = newMarkdown.length - oldMarkdown.length;
  const oldSuffixStart = oldMarkdown.length - suffix;
  const taken = new Set<string>();

  for (const assignment of assignments) {
    const text = assignment.selectedText;
    const length = text.length;
    let target: number | null = null;

    if (assignment.endOffset <= prefix && newMarkdown.slice(assignment.startOffset, assignment.endOffset) === text) {
      target = assignment.startOffset;
    } else if (
      assignment.startOffset >= oldSuffixStart &&
      newMarkdown.slice(assignment.startOffset + delta, assignment.endOffset + delta) === text
    ) {
      target = assignment.startOffset + delta;
    } else {
      const expected = assignment.startOffset >= prefix ? assignment.startOffset + delta : assignment.startOffset;
      const candidates = findOccurrences(newMarkdown, text).filter((start) => !taken.has(`${start}:${start + length}`));

      if (candidates.length) {
        target = candidates.reduce((best, current) =>
          Math.abs(current - expected) < Math.abs(best - expected) ? current : best,
        );
      }
    }

    if (target === null || !text) {
      result.lost.push(assignment);
      continue;
    }

    const rangeKey = `${target}:${target + length}`;

    if (taken.has(rangeKey)) {
      result.lost.push(assignment);
      continue;
    }

    taken.add(rangeKey);

    if (target === assignment.startOffset && target + length === assignment.endOffset) {
      result.kept.push(assignment);
    } else {
      result.moved.push({ assignment, startOffset: target, endOffset: target + length });
    }
  }

  return result;
}

export function summarizeRelocation(relocation: RelocationResult) {
  return {
    kept: relocation.kept.length,
    moved: relocation.moved.map((item) => ({
      id: item.assignment.id,
      text: item.assignment.selectedText,
      from: item.assignment.startOffset,
      to: item.startOffset,
    })),
    lost: relocation.lost.map((assignment) => ({
      id: assignment.id,
      text: assignment.selectedText,
      actors: assignment.actorNames,
    })),
  };
}

/** Persists a relocation: moves ranges and deletes the assignments that could not be found any more. */
export async function applyRelocation(playId: string, relocation: RelocationResult) {
  // Two-phase move avoids transient UNIQUE(play_id, start, end) collisions.
  for (const item of relocation.moved) {
    await updateAssignmentRange(playId, item.assignment.id, -1 - item.startOffset, -1 - item.endOffset, item.assignment.selectedText);
  }

  for (const item of relocation.moved) {
    await updateAssignmentRange(playId, item.assignment.id, item.startOffset, item.endOffset, item.assignment.selectedText);
  }

  for (const assignment of relocation.lost) {
    await deleteAssignment(playId, assignment.id);
  }
}

/** Saves new markdown for a play and relocates its assignments. Caller wraps it in a transaction. */
export async function saveMarkdownWithRelocation(play: AdminPlayDetail, title: string, slug: string, markdown: string) {
  const relocation = relocateAssignments(play.markdown, markdown, play.assignments);
  await updatePlay(play.id, title, slug, markdown);
  await applyRelocation(play.id, relocation);
  return summarizeRelocation(relocation);
}

// ---------------------------------------------------------------------------
// Text targeting (assign / manifest assignments)
// ---------------------------------------------------------------------------

export type TextTarget = {
  text: string;
  occurrence?: number;
  all?: boolean;
};

/** Resolves a text target into concrete [start, end) ranges of the markdown. */
export function resolveTextTarget(markdown: string, target: TextTarget, label = "Texto") {
  const text = normalizeLineEndings(target.text ?? "");

  if (!text.trim()) {
    throw new CliError(`${label}: el texto está vacío.`);
  }

  const occurrences = findOccurrences(markdown, text);

  if (!occurrences.length) {
    throw new CliError(`${label}: no se encontró en el markdown: ${JSON.stringify(text.slice(0, 120))}`);
  }

  if (target.all) {
    return occurrences.map((start) => ({ startOffset: start, endOffset: start + text.length, text }));
  }

  if (target.occurrence !== undefined) {
    const n = Number(target.occurrence);

    if (!Number.isInteger(n) || n < 1 || n > occurrences.length) {
      throw new CliError(
        `${label}: occurrence=${target.occurrence} fuera de rango; ${JSON.stringify(text.slice(0, 80))} aparece ${occurrences.length} vez/veces.`,
      );
    }

    const start = occurrences[n - 1]!;
    return [{ startOffset: start, endOffset: start + text.length, text }];
  }

  if (occurrences.length > 1) {
    throw new CliError(
      `${label}: ${JSON.stringify(text.slice(0, 80))} aparece ${occurrences.length} veces; usa occurrence: n (manifiesto) o --occurrence n (CLI) con n en 1..${occurrences.length}, o all: true / --all.`,
    );
  }

  return [{ startOffset: occurrences[0]!, endOffset: occurrences[0]! + text.length, text }];
}

/** 1-based occurrence number of the assignment's text at its start offset. */
export function occurrenceOf(markdown: string, text: string, startOffset: number) {
  const occurrences = findOccurrences(markdown, text);
  return { index: occurrences.indexOf(startOffset) + 1, total: occurrences.length };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type ManifestAssignment = {
  text: string;
  actors: string[] | string;
  occurrence?: number;
  all?: boolean;
};

export type ManifestMediaEntry = string | { file: string; alt?: string };

export type Manifest = {
  id?: string;
  title?: string;
  slug?: string;
  markdown?: string;
  markdown_file?: string;
  actors?: Array<string | { name: string }>;
  assignments?: ManifestAssignment[];
  auto_assign?: unknown;
  media?: Record<string, ManifestMediaEntry>;
  published?: boolean;
  hidden?: boolean;
  active?: boolean;
};

const MANIFEST_KEYS = new Set([
  "id",
  "title",
  "slug",
  "markdown",
  "markdown_file",
  "actors",
  "assignments",
  "auto_assign",
  "media",
  "published",
  "hidden",
  "active",
]);

type YamlApi = { parse(input: string): unknown; stringify(value: unknown, replacer?: null, space?: number): string };

export function getYaml(): YamlApi | null {
  const runtime = (globalThis as unknown as { Bun?: { YAML?: YamlApi } }).Bun;
  return runtime?.YAML ?? null;
}

export function parseManifestText(text: string, fileName: string): Manifest {
  const isJson = /\.json$/i.test(fileName) || text.trimStart().startsWith("{");
  let data: unknown;

  try {
    if (isJson) {
      data = JSON.parse(text);
    } else {
      const yaml = getYaml();
      if (!yaml) throw new CliError("YAML no disponible en este runtime (usa bun) o pasa un .json.");
      data = yaml.parse(text);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`No se pudo leer el manifiesto ${fileName}: ${(error as Error).message}`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError("El manifiesto debe ser un objeto (YAML/JSON).");
  }

  const unknownKeys = Object.keys(data).filter((key) => !MANIFEST_KEYS.has(key));

  if (unknownKeys.length) {
    throw new CliError(`Claves desconocidas en el manifiesto: ${unknownKeys.join(", ")}. Válidas: ${[...MANIFEST_KEYS].join(", ")}`);
  }

  return data as Manifest;
}

const PLACEHOLDER_PATTERN = /\{\{\s*(media|embed)\s*:\s*([^}\s]+)\s*\}\}/g;

function placeholderNames(markdown: string) {
  return [...new Set([...markdown.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[2]!))];
}

function substitutePlaceholders(markdown: string, media: Map<string, StoreMediaResult>) {
  return markdown.replace(PLACEHOLDER_PATTERN, (_whole, kind: string, name: string) => {
    const item = media.get(name);
    if (!item) throw new CliError(`Placeholder sin medio declarado: {{${kind}:${name}}}`);
    return kind === "media" ? item.url : item.snippet;
  });
}

function actorKey(name: string) {
  return name.trim().toLocaleLowerCase("es");
}

function asBool(value: unknown, key: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CliError(`"${key}" debe ser true o false.`);
  return value;
}

export type ApplyOptions = {
  baseDir: string;
  dryRun?: boolean;
  prune?: boolean;
};

type DesiredAssignment = { startOffset: number; endOffset: number; text: string; actorNames: string[] };

/** Validates a manifest, computes the plan and (unless dryRun) applies it atomically. */
export async function applyManifest(manifest: Manifest, options: ApplyOptions) {
  // ---------- 1. Normalize & validate the manifest shape ----------
  const published = asBool(manifest.published, "published");
  const hidden = asBool(manifest.hidden, "hidden");
  const active = asBool(manifest.active, "active");

  if (manifest.markdown !== undefined && manifest.markdown_file !== undefined) {
    throw new CliError("Usa markdown o markdown_file, no ambos.");
  }

  let sourceMarkdown: string | undefined;

  if (manifest.markdown_file !== undefined) {
    const file = path.resolve(options.baseDir, String(manifest.markdown_file));
    if (!fs.existsSync(file)) throw new CliError(`markdown_file no encontrado: ${file}`);
    sourceMarkdown = normalizeLineEndings(fs.readFileSync(file, "utf8"));
  } else if (manifest.markdown !== undefined) {
    if (typeof manifest.markdown !== "string") throw new CliError(`"markdown" debe ser texto.`);
    sourceMarkdown = normalizeLineEndings(manifest.markdown);
  }

  const manifestActors =
    manifest.actors === undefined
      ? undefined
      : (Array.isArray(manifest.actors) ? manifest.actors : [manifest.actors]).map((entry) => {
          const name = (typeof entry === "string" ? entry : entry?.name ?? "").trim();
          if (!name) throw new CliError("Hay un actor sin nombre en actors.");
          return name;
        });

  if (manifestActors) {
    const seen = new Set<string>();
    for (const name of manifestActors) {
      if (seen.has(actorKey(name))) throw new CliError(`Actor duplicado en actors: ${name}`);
      seen.add(actorKey(name));
    }
  }

  const mediaEntries = Object.entries(manifest.media ?? {}).map(([name, entry]) => {
    const file = typeof entry === "string" ? entry : entry?.file;
    if (!file) throw new CliError(`media.${name}: falta la ruta del archivo.`);
    const absolute = path.resolve(options.baseDir, file);
    validateMediaFile(absolute, `media.${name}`);
    return { name, file: absolute, alt: typeof entry === "object" ? entry.alt : undefined };
  });

  // ---------- 2. Locate the target play ----------
  let existing: AdminPlayDetail | null = null;
  const manifestSlug = manifest.slug !== undefined ? slugify(String(manifest.slug)) : undefined;

  if (manifest.slug !== undefined && !manifestSlug) throw new CliError(`slug inválido: ${manifest.slug}`);

  if (manifest.id) existing = await getAdminPlayById(String(manifest.id));

  const lookupSlug = manifestSlug ?? (manifest.title ? slugify(String(manifest.title)) : undefined);

  if (!existing && lookupSlug) {
    const row = getDb().prepare(`SELECT id FROM plays WHERE slug = ? LIMIT 1`).get(lookupSlug) as { id?: string } | undefined;
    if (row?.id) existing = await getAdminPlayById(String(row.id));
  }

  const title = String(manifest.title ?? existing?.title ?? "").trim();

  if (!title) throw new CliError("El manifiesto necesita title para crear la obra.");

  const playId = existing?.id ?? (manifest.id ? String(manifest.id) : crypto.randomUUID());
  const slug = manifestSlug ?? existing?.slug ?? (slugify(title) || "obra");

  if (await isSlugTaken(slug, existing?.id)) {
    throw new CliError(`El slug "${slug}" ya lo usa otra obra.`);
  }

  // ---------- 3. Media & final markdown ----------
  const usedNames = new Set(placeholderNames(sourceMarkdown ?? ""));
  const declaredNames = new Set(mediaEntries.map((entry) => entry.name));
  const undeclared = [...usedNames].filter((name) => !declaredNames.has(name));

  if (undeclared.length) {
    throw new CliError(`Placeholders sin entrada en media: ${undeclared.map((name) => `{{media:${name}}}`).join(", ")}`);
  }

  const usedEntries = mediaEntries.filter((entry) => usedNames.has(entry.name));
  const unusedMedia = mediaEntries.filter((entry) => !usedNames.has(entry.name)).map((entry) => entry.name);
  const plannedMedia = await planMediaStorage(usedEntries, playId, new Set(referencedMediaKeys(existing?.markdown ?? "")));
  const mediaByName = new Map(plannedMedia.map((item) => [item.name, item]));
  const finalMarkdown =
    sourceMarkdown === undefined ? existing?.markdown ?? "" : substitutePlaceholders(sourceMarkdown, mediaByName);

  // ---------- 4. Actors ----------
  const existingActors = existing?.actors ?? [];
  const existingByKey = new Map(existingActors.map((actor) => [actorKey(actor.name), actor]));
  const desiredActorNames = manifestActors ?? existingActors.map((actor) => actor.name);
  const desiredByKey = new Map(desiredActorNames.map((name) => [actorKey(name), name]));
  const actorsToAdd = desiredActorNames.filter((name) => !existingByKey.has(actorKey(name)));
  const extraActors = existingActors.filter((actor) => !desiredByKey.has(actorKey(actor.name)));
  const actorsToRemove = options.prune && manifestActors ? extraActors : [];

  // ---------- 5. Assignments ----------
  let desired: DesiredAssignment[] | null = null;

  let autoAssignStats: Record<string, number> | undefined;

  if (manifest.assignments !== undefined || manifest.auto_assign !== undefined) {
    if (manifest.assignments !== undefined && !Array.isArray(manifest.assignments)) {
      throw new CliError("assignments debe ser una lista.");
    }

    const byRange = new Map<string, DesiredAssignment>();

    if (manifest.auto_assign !== undefined) {
      try {
        const config = parseAutoAssign(manifest.auto_assign);
        for (const character of Object.values(config.characters)) {
          for (const name of character.actors) {
            if (!desiredByKey.has(actorKey(name))) throw new CliError(`auto_assign: actor "${name}" no está en actors.`);
          }
        }
        const auto = computeAutoAssignments(finalMarkdown, config);
        autoAssignStats = auto.stats;
        for (const range of auto.ranges) {
          byRange.set(`${range.startOffset}:${range.endOffset}`, {
            startOffset: range.startOffset,
            endOffset: range.endOffset,
            text: range.text,
            actorNames: range.actorNames.map((name) => desiredByKey.get(actorKey(name))!),
          });
        }
      } catch (error) {
        if (error instanceof AutoAssignError) throw new CliError(error.message);
        throw error;
      }
    }

    (manifest.assignments ?? []).forEach((entry, index) => {
      const label = `assignments[${index}]`;
      if (!entry || typeof entry.text !== "string") throw new CliError(`${label}: falta "text".`);

      const rawActors = Array.isArray(entry.actors) ? entry.actors : String(entry.actors ?? "").split(",");
      const names = rawActors.map((name) => String(name).trim()).filter(Boolean);
      if (!names.length) throw new CliError(`${label}: falta "actors".`);

      const resolvedNames = names.map((name) => {
        const match = desiredByKey.get(actorKey(name));
        if (!match) throw new CliError(`${label}: actor "${name}" no está en actors.`);
        if (actorsToRemove.some((actor) => actorKey(actor.name) === actorKey(name))) {
          throw new CliError(`${label}: actor "${name}" se eliminaría con --prune.`);
        }
        return match;
      });

      for (const range of resolveTextTarget(finalMarkdown, entry, label)) {
        const key = `${range.startOffset}:${range.endOffset}`;
        const current = byRange.get(key);
        if (current) {
          for (const name of resolvedNames) if (!current.actorNames.includes(name)) current.actorNames.push(name);
        } else {
          byRange.set(key, { ...range, actorNames: [...resolvedNames] });
        }
      }
    });

    desired = [...byRange.values()].sort((a, b) => a.startOffset - b.startOffset);
  }

  const existingAssignments = existing?.assignments ?? [];
  const markdownChanged = Boolean(existing) && finalMarkdown !== existing!.markdown;
  let relocation: RelocationResult | null = null;
  const assignmentPlan = { add: [] as DesiredAssignment[], update: [] as DesiredAssignment[], remove: [] as AssignmentSummary[], unchanged: 0 };

  if (desired) {
    const existingByRange = new Map(existingAssignments.map((a) => [`${a.startOffset}:${a.endOffset}`, a]));
    const desiredKeys = new Set(desired.map((d) => `${d.startOffset}:${d.endOffset}`));

    for (const item of desired) {
      const current = existingByRange.get(`${item.startOffset}:${item.endOffset}`);
      if (!current) {
        assignmentPlan.add.push(item);
        continue;
      }
      const sameActors =
        current.actorNames.length === item.actorNames.length &&
        item.actorNames.every((name) => current.actorNames.some((other) => actorKey(other) === actorKey(name)));
      if (sameActors && current.selectedText === item.text) assignmentPlan.unchanged += 1;
      else assignmentPlan.update.push(item);
    }

    assignmentPlan.remove = existingAssignments.filter((a) => !desiredKeys.has(`${a.startOffset}:${a.endOffset}`));
  } else if (markdownChanged) {
    relocation = relocateAssignments(existing!.markdown, finalMarkdown, existingAssignments);
  }

  // ---------- 6. State ----------
  const currentState = {
    published: existing?.published ?? false,
    hidden: existing?.hidden ?? false,
    active: existing?.isActive ?? false,
  };
  const targetState = {
    published: published ?? currentState.published,
    hidden: hidden ?? currentState.hidden,
    active: active ?? currentState.active,
  };

  if (!targetState.published || targetState.hidden) {
    if (active === true) throw new CliError("active: true requiere published: true y hidden: false.");
    targetState.active = false;
  }

  const stateChanges = (Object.keys(targetState) as Array<keyof typeof targetState>).filter(
    (key) => targetState[key] !== currentState[key],
  );

  const titleChanged = Boolean(existing) && existing!.title !== title;
  const slugChanged = Boolean(existing) && existing!.slug !== slug;
  const mediaToUpload = plannedMedia.filter((item) => !item.reused);

  const plan = {
    action: existing ? "update" : "create",
    play: { id: playId, title, slug },
    changes: {
      title: titleChanged,
      slug: slugChanged,
      markdown: existing ? markdownChanged : true,
      state: Object.fromEntries(stateChanges.map((key) => [key, targetState[key]])),
    },
    actors: {
      add: actorsToAdd,
      remove: actorsToRemove.map((actor) => actor.name),
      extra: options.prune ? [] : extraActors.map((actor) => actor.name),
    },
    media: {
      upload: mediaToUpload.map((item) => ({ name: item.name, key: item.key, url: item.url })),
      reuse: plannedMedia.filter((item) => item.reused).map((item) => ({ name: item.name, key: item.key, url: item.url })),
      unused: unusedMedia,
    },
    assignments: desired
      ? {
          add: assignmentPlan.add.map((item) => ({ text: item.text, actors: item.actorNames, startOffset: item.startOffset })),
          update: assignmentPlan.update.map((item) => ({ text: item.text, actors: item.actorNames, startOffset: item.startOffset })),
          remove: assignmentPlan.remove.map((item) => ({ id: item.id, text: item.selectedText, actors: item.actorNames })),
          unchanged: assignmentPlan.unchanged,
          ...(autoAssignStats ? { auto: autoAssignStats } : {}),
        }
      : relocation
        ? { relocated: summarizeRelocation(relocation) }
        : { unchanged: existingAssignments.length },
    warnings: [
      ...unusedMedia.map((name) => `media.${name} no se usa en el markdown (no se sube).`),
      ...(options.prune || !manifestActors ? [] : extraActors.map((actor) => `Actor "${actor.name}" existe pero no está en el manifiesto (usa --prune para eliminarlo).`)),
      ...(relocation?.lost.length ? [`${relocation.lost.length} asignación(es) no se pudieron reubicar y se eliminarán.`] : []),
    ],
  };

  const changed =
    !existing ||
    titleChanged ||
    slugChanged ||
    markdownChanged ||
    stateChanges.length > 0 ||
    actorsToAdd.length > 0 ||
    actorsToRemove.length > 0 ||
    mediaToUpload.length > 0 ||
    assignmentPlan.add.length + assignmentPlan.update.length + assignmentPlan.remove.length > 0 ||
    Boolean(relocation && (relocation.moved.length || relocation.lost.length));

  if (options.dryRun || !changed) {
    return { dryRun: Boolean(options.dryRun), changed, plan };
  }

  // ---------- 7. Write (media first, then one DB transaction) ----------
  const writtenMedia = await writePlannedMedia(plannedMedia);

  try {
    await withTransaction(async () => {
      if (!existing) {
        await createPlayWithId(playId, title, slug, finalMarkdown);
      } else if (titleChanged || slugChanged || markdownChanged) {
        await updatePlay(playId, title, slug, finalMarkdown);
      }

      for (const actor of actorsToRemove) await deleteActor(playId, actor.id);
      for (const name of actorsToAdd) await createActor(playId, name);

      if (relocation) await applyRelocation(playId, relocation);

      if (desired) {
        const fresh = await getAdminPlayById(playId);
        const actorIdByKey = new Map((fresh?.actors ?? []).map((actor) => [actorKey(actor.name), actor.id]));

        for (const item of assignmentPlan.remove) await deleteAssignment(playId, item.id);
        for (const item of [...assignmentPlan.add, ...assignmentPlan.update]) {
          const actorIds = item.actorNames.map((name) => actorIdByKey.get(actorKey(name))!);
          await saveAssignment(playId, item.startOffset, item.endOffset, item.text, actorIds);
        }
      }

      if (targetState.published !== currentState.published) await updatePlayPublished(playId, targetState.published);
      if (targetState.hidden !== currentState.hidden) await updatePlayHidden(playId, targetState.hidden);
      if (targetState.active !== currentState.active) await setPlayActive(playId, targetState.active);
    });
  } catch (error) {
    await rollbackMedia(writtenMedia);
    throw error;
  }

  return { dryRun: false, changed: true, plan };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportOptions = {
  outDir?: string;
  copyMedia?: boolean;
};

function uniqueMediaName(key: string, used: Set<string>) {
  const base =
    slugify(path.basename(key, path.extname(key)).replace(/^\d+-/, "")).replace(/-/g, "_") || "medio";
  let name = base;
  let index = 2;

  while (used.has(name)) {
    name = `${base}_${index}`;
    index += 1;
  }

  used.add(name);
  return name;
}

/** Builds a manifest that `applyManifest` reimports without changes. */
export async function exportPlay(play: AdminPlayDetail, options: ExportOptions = {}) {
  const assignments: ManifestAssignment[] = play.assignments
    .filter((assignment) => assignment.actorNames.length)
    .map((assignment) => {
      const { index, total } = occurrenceOf(play.markdown, assignment.selectedText, assignment.startOffset);
      const entry: ManifestAssignment = { text: assignment.selectedText, actors: assignment.actorNames };
      if (total > 1 && index > 0) entry.occurrence = index;
      return entry;
    });

  const manifest: Manifest = {
    id: play.id,
    title: play.title,
    slug: play.slug,
    actors: play.actors.map((actor) => actor.name),
    published: play.published,
    hidden: play.hidden,
    active: play.isActive,
  };

  const files: string[] = [];

  if (!options.outDir) {
    return { manifest: { ...manifest, markdown: play.markdown, assignments }, files };
  }

  const outDir = path.resolve(options.outDir);
  await fsp.mkdir(outDir, { recursive: true });
  let markdown = play.markdown;
  const media: Record<string, string> = {};
  const missing: string[] = [];

  if (options.copyMedia !== false) {
    const used = new Set<string>();
    const urlToName = new Map<string, string>();

    for (const match of play.markdown.matchAll(MEDIA_URL_PATTERN)) {
      const url = match[0];
      if (urlToName.has(url)) continue;
      const key = decodeMediaUrlToKey(url);
      const absolute = resolveMediaPath(key);

      if (!absolute || !fs.existsSync(absolute)) {
        missing.push(key);
        continue;
      }

      const name = uniqueMediaName(key, used);
      const relative = `media/${name}${path.extname(key).toLowerCase()}`;
      await fsp.mkdir(path.join(outDir, "media"), { recursive: true });
      await fsp.copyFile(absolute, path.join(outDir, relative));
      files.push(path.join(outDir, relative));
      media[name] = relative;
      urlToName.set(url, name);
    }

    // Replace longest URLs first so a URL that is a prefix of another is not clobbered.
    for (const [url, name] of [...urlToName.entries()].sort((a, b) => b[0].length - a[0].length)) {
      markdown = markdown.split(url).join(`{{media:${name}}}`);
    }
  }

  const fullManifest: Manifest = {
    ...manifest,
    markdown_file: `${play.slug}.md`,
    ...(Object.keys(media).length ? { media } : {}),
    assignments,
  };

  const markdownPath = path.join(outDir, `${play.slug}.md`);
  await fsp.writeFile(markdownPath, markdown, "utf8");
  files.push(markdownPath);

  const yaml = getYaml();
  const manifestPath = path.join(outDir, yaml ? "obra.yaml" : "obra.json");
  const header = `# Manifiesto exportado de "${play.title}". Reimportar con: obras apply ${manifestPath}\n`;
  await fsp.writeFile(
    manifestPath,
    yaml ? header + yaml.stringify(fullManifest, null, 2) + "\n" : JSON.stringify(fullManifest, null, 2) + "\n",
    "utf8",
  );
  files.unshift(manifestPath);

  return { manifest: fullManifest, manifestPath, files, missingMedia: missing };
}
