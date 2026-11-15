import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDb, getDbPath } from "@/lib/db";
import { buildMediaPath } from "@/lib/media";
import { getDataDir, getMediaDir } from "@/lib/paths";
import {
  allReferencedMediaKeys,
  applyManifest,
  CliError,
  exportPlay,
  findOccurrences,
  getPublicBaseUrl,
  normalizeLineEndings,
  occurrenceOf,
  parseManifestText,
  playUrls,
  referencedMediaKeys,
  resolveTextTarget,
  saveMarkdownWithRelocation,
  storeMediaFiles,
  withTransaction,
} from "@/lib/play-import";
import {
  createActor,
  createPlayWithId,
  deleteActor,
  deleteAssignment,
  deletePlay,
  deletePlayVotes,
  ensureUniqueSlug,
  findPlayIdByRef,
  getAdminPlayById,
  getAdminPlayList,
  isSlugTaken,
  saveAssignment,
  setPlayActive,
  updateActorName,
  updatePlayHidden,
  updatePlayPublished,
} from "@/lib/plays";
import { deleteMedia, listMedia } from "@/lib/storage";
import type { AdminPlayDetail, AssignmentSummary } from "@/lib/types";
import { slugify } from "@/lib/utils";

type Flags = Record<string, string | boolean>;

export type CommandContext = {
  positionals: string[];
  flags: Flags;
  str: (name: string) => string | undefined;
  int: (name: string) => number | undefined;
  need: (value: string | undefined, what: string) => string;
  splitList: (values: string[]) => string[];
  readStdin: () => Promise<string>;
  runtime: { repoDir: string; service: string; tunnelService: string; localUrl: string };
};

type Handler = (ctx: CommandContext) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolvePlay(ref: string | undefined) {
  if (!ref) throw new CliError("Falta <obra> (id o slug).");
  const id = await findPlayIdByRef(ref);
  const play = id ? await getAdminPlayById(id) : null;
  if (!play) throw new CliError(`Obra no encontrada: ${ref}. Usa "obras list".`);
  return play;
}

async function reload(id: string) {
  return (await getAdminPlayById(id))!;
}

function summary(play: AdminPlayDetail) {
  return {
    id: play.id,
    slug: play.slug,
    title: play.title,
    published: play.published,
    hidden: play.hidden,
    active: play.isActive,
    urls: playUrls(play),
  };
}

function resolveActor(play: AdminPlayDetail, ref: string) {
  const key = ref.trim().toLocaleLowerCase("es");
  const actor =
    play.actors.find((candidate) => candidate.id === ref.trim()) ??
    play.actors.find((candidate) => candidate.name.toLocaleLowerCase("es") === key);
  if (!actor) {
    throw new CliError(`Actor no encontrado en "${play.slug}": ${ref}. Actores: ${play.actors.map((a) => a.name).join(", ") || "(ninguno)"}`);
  }
  return actor;
}

function describeAssignment(markdown: string, assignment: AssignmentSummary) {
  const { index, total } = occurrenceOf(markdown, assignment.selectedText, assignment.startOffset);
  return {
    id: assignment.id,
    text: assignment.selectedText,
    startOffset: assignment.startOffset,
    endOffset: assignment.endOffset,
    actors: assignment.actorNames,
    occurrence: index || null,
    occurrences: total,
    valid: markdown.slice(assignment.startOffset, assignment.endOffset) === assignment.selectedText,
  };
}

async function readMarkdownInput(ctx: CommandContext) {
  const file = ctx.str("markdown-file");
  const inline = ctx.flags.markdown;

  if (file && inline !== undefined) throw new CliError("Usa --markdown-file o --markdown, no ambos.");
  if (file) {
    if (!fs.existsSync(file)) throw new CliError(`Archivo no encontrado: ${file}`);
    return normalizeLineEndings(fs.readFileSync(file, "utf8"));
  }
  if (inline === undefined) return undefined;
  if (typeof inline !== "string") throw new CliError("--markdown necesita un valor (texto o - para stdin).");
  return normalizeLineEndings(inline === "-" ? await ctx.readStdin() : inline);
}

function requireYes(ctx: CommandContext, what: string) {
  if (!ctx.flags.yes) throw new CliError(`${what} es destructivo: repite con --yes.`);
}

function run(cmd: string, args: string[], options: { cwd?: string; inherit?: boolean } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.inherit ? ["ignore", process.stderr, process.stderr] : ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? (result.error ? 127 : 1),
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString() || (result.error ? String(result.error.message) : ""),
  };
}

function serviceState(unit: string) {
  const result = run("systemctl", ["--user", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState"]);
  if (result.code !== 0) return { unit, exists: false, active: false, state: "unknown", error: result.stderr.trim() };
  const props = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const exists = props.LoadState === "loaded";
  return {
    unit,
    exists,
    active: props.ActiveState === "active",
    state: exists ? `${props.ActiveState}/${props.SubState}` : props.LoadState || "not-found",
  };
}

async function httpCheck(url: string, timeoutMs = 4000) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return { url, ok: response.status < 500, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { url, ok: false, status: null, ms: Date.now() - started, error: (error as Error).message };
  }
}

async function waitHealthy(url: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  let last = await httpCheck(url, 2000);
  while (!last.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    last = await httpCheck(url, 2000);
  }
  return last;
}

async function setState(play: AdminPlayDetail, change: "publish" | "unpublish" | "hide" | "unhide" | "activate" | "deactivate") {
  switch (change) {
    case "publish":
      await updatePlayPublished(play.id, true);
      break;
    case "unpublish":
      await updatePlayPublished(play.id, false);
      break;
    case "hide":
      await updatePlayHidden(play.id, true);
      break;
    case "unhide":
      await updatePlayHidden(play.id, false);
      break;
    case "activate":
      if (!play.published || play.hidden) {
        throw new CliError(`Solo una obra publicada y visible puede quedar activa. Usa "obras deploy ${play.slug}".`);
      }
      await setPlayActive(play.id, true);
      break;
    case "deactivate":
      await setPlayActive(play.id, false);
      break;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const apply: Handler = async (ctx) => {
  const file = ctx.need(ctx.positionals[0], "<manifiesto.yaml|json>");
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new CliError(`Manifiesto no encontrado: ${absolute}`);
  const manifest = parseManifestText(fs.readFileSync(absolute, "utf8"), absolute);
  const result = await applyManifest(manifest, {
    baseDir: path.dirname(absolute),
    dryRun: Boolean(ctx.flags["dry-run"]),
    prune: Boolean(ctx.flags.prune),
  });
  const play = result.dryRun ? null : await getAdminPlayById(result.plan.play.id);
  return { ...result, play: play ? summary(play) : result.plan.play };
};

const exportCmd: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  const result = await exportPlay(play, { outDir: ctx.str("out"), copyMedia: !ctx.flags["no-media"] });
  return { play: summary(play), ...result };
};

const list: Handler = async () => {
  const plays = await getAdminPlayList();
  const base = getPublicBaseUrl();
  return {
    count: plays.length,
    plays: plays.map((play) => ({
      id: play.id,
      slug: play.slug,
      title: play.title,
      published: play.published,
      hidden: play.hidden,
      active: play.isActive,
      actors: play.actorCount,
      assignments: play.assignmentCount,
      voteBlocks: play.voteBlockCount,
      votes: play.voteCount,
      updatedAt: play.updatedAt,
      url: `${base}/obras/${play.slug}`,
    })),
  };
};

const show: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  return {
    play: {
      ...summary(play),
      markdownChars: play.markdown.length,
      ...(ctx.flags.markdown ? { markdown: play.markdown } : {}),
      actors: play.actors,
      assignments: play.assignments.map((assignment) => describeAssignment(play.markdown, assignment)),
      media: referencedMediaKeys(play.markdown).map((key) => ({ key, url: buildMediaPath(key) })),
      votes: play.votes,
    },
  };
};

const create: Handler = async (ctx) => {
  const title = ctx.need(ctx.str("title")?.trim(), "--title");
  const markdown = (await readMarkdownInput(ctx)) ?? "";
  const requestedSlug = ctx.str("slug");
  let slug: string;
  if (requestedSlug) {
    slug = slugify(requestedSlug);
    if (!slug) throw new CliError(`Slug inválido: ${requestedSlug}`);
    if (await isSlugTaken(slug)) throw new CliError(`El slug "${slug}" ya existe.`);
  } else {
    slug = await ensureUniqueSlug(title);
  }
  const actors = ctx.splitList([ctx.str("actors") ?? ""]);
  const id = crypto.randomUUID();
  await withTransaction(async () => {
    await createPlayWithId(id, title, slug, markdown);
    for (const name of actors) await createActor(id, name);
  });
  return { play: summary(await reload(id)) };
};

const update: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  const markdown = await readMarkdownInput(ctx);
  const title = ctx.str("title")?.trim() || play.title;
  let slug = play.slug;
  const requestedSlug = ctx.str("slug");
  if (requestedSlug) {
    slug = slugify(requestedSlug);
    if (!slug) throw new CliError(`Slug inválido: ${requestedSlug}`);
    if (await isSlugTaken(slug, play.id)) throw new CliError(`El slug "${slug}" ya lo usa otra obra.`);
  }
  if (markdown === undefined && title === play.title && slug === play.slug) {
    return { changed: false, play: summary(play) };
  }
  const assignments = await withTransaction(() =>
    saveMarkdownWithRelocation(play, title, slug, markdown ?? play.markdown),
  );
  return { changed: true, play: summary(await reload(play.id)), assignments };
};

const del: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  requireYes(ctx, `Borrar la obra "${play.slug}"`);
  await deletePlay(play.id);
  const removedMedia: string[] = [];
  if (!ctx.flags["keep-media"]) {
    const stillUsed = await allReferencedMediaKeys();
    for (const item of await listMedia(`plays/${play.id}`)) {
      if (stillUsed.has(item.key)) continue;
      await deleteMedia(item.key);
      removedMedia.push(item.key);
    }
    await fsp.rm(path.join(getMediaDir(), "plays", play.id), { recursive: true, force: true }).catch(() => undefined);
  }
  return { deleted: { id: play.id, slug: play.slug, title: play.title }, removedMedia };
};

function stateCommand(change: Parameters<typeof setState>[1]): Handler {
  return async (ctx) => {
    const play = await resolvePlay(ctx.positionals[0]);
    await setState(play, change);
    return { play: summary(await reload(play.id)) };
  };
}

const deploy: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  await withTransaction(async () => {
    if (!play.published) await updatePlayPublished(play.id, true);
    if (play.hidden) await updatePlayHidden(play.id, false);
    await setPlayActive(play.id, true);
  });
  const fresh = await reload(play.id);
  const urls = playUrls(fresh);
  return { play: summary(fresh), urls };
};

const actor: Handler = async (ctx) => {
  const [sub, ref, ...names] = ctx.positionals;
  const play = await resolvePlay(ref);
  switch (sub) {
    case "list":
    case undefined:
      return { play: play.slug, actors: play.actors };
    case "add": {
      const toAdd = ctx.splitList(names);
      if (!toAdd.length) throw new CliError("Falta <nombre>.");
      const added: string[] = [];
      const existing: string[] = [];
      await withTransaction(async () => {
        const known = new Set(play.actors.map((a) => a.name.toLocaleLowerCase("es")));
        for (const name of toAdd) {
          if (known.has(name.toLocaleLowerCase("es"))) {
            existing.push(name);
            continue;
          }
          await createActor(play.id, name);
          known.add(name.toLocaleLowerCase("es"));
          added.push(name);
        }
      });
      return { play: play.slug, added, existing, actors: (await reload(play.id)).actors };
    }
    case "rename": {
      const [from, to] = names;
      const target = resolveActor(play, ctx.need(from, "<actor>"));
      const newName = ctx.need(to?.trim(), "<nuevo nombre>");
      const clash = play.actors.find((a) => a.id !== target.id && a.name.toLocaleLowerCase("es") === newName.toLocaleLowerCase("es"));
      if (clash) throw new CliError(`Ya existe un actor llamado "${clash.name}".`);
      await updateActorName(play.id, target.id, newName);
      return { play: play.slug, renamed: { id: target.id, from: target.name, to: newName } };
    }
    case "remove":
    case "rm": {
      if (!names.length) throw new CliError("Falta <actor>.");
      const targets = ctx.splitList(names).map((name) => resolveActor(play, name));
      await withTransaction(async () => {
        for (const target of targets) await deleteActor(play.id, target.id);
      });
      return { play: play.slug, removed: targets, actors: (await reload(play.id)).actors };
    }
    default:
      throw new CliError(`Subcomando de actor desconocido: ${sub}. Usa list|add|rename|remove.`);
  }
};

const assign: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  const text = ctx.need(ctx.str("text"), "--text");
  const actorNames = ctx.splitList([ctx.need(ctx.str("actors"), "--actors")]);
  const actors = actorNames.map((name) => resolveActor(play, name));
  const ranges = resolveTextTarget(play.markdown, { text, occurrence: ctx.int("occurrence"), all: Boolean(ctx.flags.all) }, "--text");
  await withTransaction(async () => {
    for (const range of ranges) {
      await saveAssignment(play.id, range.startOffset, range.endOffset, range.text, actors.map((a) => a.id));
    }
  });
  const fresh = await reload(play.id);
  const keys = new Set(ranges.map((r) => `${r.startOffset}:${r.endOffset}`));
  return {
    play: play.slug,
    assigned: fresh.assignments
      .filter((a) => keys.has(`${a.startOffset}:${a.endOffset}`))
      .map((a) => describeAssignment(fresh.markdown, a)),
  };
};

const unassign: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  const id = ctx.str("id");
  const text = ctx.str("text");
  let targets: AssignmentSummary[];
  if (id) {
    targets = play.assignments.filter((a) => a.id === id);
    if (!targets.length) throw new CliError(`Asignación no encontrada: ${id}`);
  } else if (text !== undefined) {
    const normalized = normalizeLineEndings(text);
    const occurrence = ctx.int("occurrence");
    targets = play.assignments.filter((a) => a.selectedText === normalized);
    if (occurrence !== undefined) {
      const starts = findOccurrences(play.markdown, normalized);
      const start = starts[occurrence - 1];
      targets = targets.filter((a) => a.startOffset === start);
    }
    if (!targets.length) throw new CliError(`No hay asignaciones con ese texto exacto: ${JSON.stringify(text.slice(0, 80))}`);
  } else {
    throw new CliError("Usa --id o --text.");
  }
  const actorRef = ctx.str("actor");
  const actorToRemove = actorRef ? resolveActor(play, actorRef) : null;
  const removed: string[] = [];
  const updated: string[] = [];
  await withTransaction(async () => {
    for (const target of targets) {
      const remaining = actorToRemove ? target.actorIds.filter((actorId) => actorId !== actorToRemove.id) : [];
      if (actorToRemove && !target.actorIds.includes(actorToRemove.id)) continue;
      if (remaining.length) {
        await saveAssignment(play.id, target.startOffset, target.endOffset, target.selectedText, remaining);
        updated.push(target.id);
      } else {
        await deleteAssignment(play.id, target.id);
        removed.push(target.id);
      }
    }
  });
  return { play: play.slug, removed, updated };
};

const assignments: Handler = async (ctx) => {
  const play = await resolvePlay(ctx.positionals[0]);
  const actorRef = ctx.str("actor");
  const filterActor = actorRef ? resolveActor(play, actorRef) : null;
  const items = play.assignments
    .filter((a) => !filterActor || a.actorIds.includes(filterActor.id))
    .map((a) => describeAssignment(play.markdown, a));
  return { play: play.slug, count: items.length, assignments: items };
};

function insertSnippets(markdown: string, snippets: string[], after: string | undefined, occurrence?: number) {
  const block = snippets.join("\n\n");
  if (after === undefined) {
    const trimmed = markdown.replace(/\s+$/, "");
    return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }
  const [range] = resolveTextTarget(markdown, { text: after, occurrence: occurrence ?? 1 }, "--after");
  const lineEnd = markdown.indexOf("\n", range!.endOffset);
  const position = lineEnd === -1 ? markdown.length : lineEnd;
  return `${markdown.slice(0, position)}\n\n${block}${markdown.slice(position)}`;
}

const media: Handler = async (ctx) => {
  const [sub, ...rest] = ctx.positionals;
  switch (sub) {
    case "add": {
      const play = await resolvePlay(rest[0]);
      const files = rest.slice(1);
      if (!files.length) throw new CliError("Falta <archivo...>.");
      const alt = ctx.str("alt");
      const stored = await storeMediaFiles(play.id, files, play.markdown);
      const items = stored.map((item) => ({
        ...item,
        snippet: alt && item.contentType.startsWith("image/") ? `![${alt}](${item.url})` : item.snippet,
      }));
      let inserted: Record<string, unknown> | null = null;
      if (ctx.flags.insert) {
        const next = insertSnippets(play.markdown, items.map((item) => item.snippet), ctx.str("after"), ctx.int("occurrence"));
        const relocation = await withTransaction(() => saveMarkdownWithRelocation(play, play.title, play.slug, next));
        inserted = { assignments: relocation };
      }
      return { play: play.slug, files: items, inserted };
    }
    case "list":
    case undefined: {
      const play = rest[0] ? await resolvePlay(rest[0]) : null;
      const referenced = await allReferencedMediaKeys();
      let items = await listMedia(play ? `plays/${play.id}` : "");
      if (play) {
        // Also include files referenced by this play stored elsewhere.
        const own = new Set(items.map((i) => i.key));
        const extra = (await listMedia("")).filter((i) => !own.has(i.key) && play.markdown.includes(i.url));
        items = [...items, ...extra];
      }
      const totalBytes = items.reduce((sum, i) => sum + i.size, 0);
      return {
        count: items.length,
        totalBytes,
        media: items.map((item) => ({ ...item, referenced: referenced.has(item.key) })),
      };
    }
    case "rm": {
      if (!rest.length) throw new CliError("Falta <key>.");
      const referenced = await allReferencedMediaKeys();
      const keys = rest.map((key) => key.replace(/^\/?media\//, "").replace(/^\/+/, ""));
      const inUse = keys.filter((key) => referenced.has(key));
      if (inUse.length && !ctx.flags.force) throw new CliError(`Archivos en uso por alguna obra (usa --force): ${inUse.join(", ")}`);
      const removed: string[] = [];
      for (const key of keys) {
        const existing = await listMedia(key);
        if (!existing.some((item) => item.key === key)) throw new CliError(`Archivo no encontrado: ${key}`);
        await deleteMedia(key);
        removed.push(key);
      }
      return { removed };
    }
    case "prune": {
      const referenced = await allReferencedMediaKeys();
      const orphans = (await listMedia("")).filter((item) => !referenced.has(item.key));
      const bytes = orphans.reduce((sum, item) => sum + item.size, 0);
      if (!ctx.flags.yes) {
        return { dryRun: true, count: orphans.length, bytes, orphans: orphans.map((o) => o.key), hint: "Repite con --yes para borrar." };
      }
      for (const item of orphans) await deleteMedia(item.key);
      return { dryRun: false, count: orphans.length, bytes, removed: orphans.map((o) => o.key) };
    }
    default:
      throw new CliError(`Subcomando de media desconocido: ${sub}. Usa add|list|rm|prune.`);
  }
};

const votes: Handler = async (ctx) => {
  const [first, second] = ctx.positionals;
  if (first === "reset") {
    const play = await resolvePlay(second);
    const voteId = ctx.str("vote");
    if (voteId && !play.votes.some((vote) => vote.id === voteId)) {
      throw new CliError(`Votación no encontrada: ${voteId}. Ids: ${play.votes.map((v) => v.id).join(", ") || "(ninguna)"}`);
    }
    requireYes(ctx, "Borrar votos");
    const removed = await deletePlayVotes(play.id, voteId);
    return { play: play.slug, vote: voteId ?? "all", removedBallots: removed };
  }
  const play = await resolvePlay(first);
  return { play: play.slug, votes: play.votes };
};

const status: Handler = async (ctx) => {
  const db = getDb();
  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const mediaItems = await listMedia("");
  const active = db.prepare(`SELECT id, slug, title FROM plays WHERE is_active = 1 LIMIT 1`).get() as
    | { id: string; slug: string; title: string }
    | undefined;
  const checks: Record<string, unknown> = { local: await httpCheck(`${ctx.runtime.localUrl}/`) };
  if (ctx.flags.public) checks.public = await httpCheck(`${getPublicBaseUrl()}/`, 8000);
  return {
    dataDir: getDataDir(),
    dbPath: getDbPath(),
    dbBytes: fs.existsSync(getDbPath()) ? fs.statSync(getDbPath()).size : 0,
    mediaDir: getMediaDir(),
    counts: {
      plays: count(`SELECT COUNT(*) AS n FROM plays`),
      published: count(`SELECT COUNT(*) AS n FROM plays WHERE published = 1 AND hidden = 0`),
      actors: count(`SELECT COUNT(*) AS n FROM actors`),
      assignments: count(`SELECT COUNT(*) AS n FROM fragment_assignments`),
      votes: count(`SELECT COUNT(*) AS n FROM play_votes`),
      mediaFiles: mediaItems.length,
      mediaBytes: mediaItems.reduce((sum, item) => sum + item.size, 0),
    },
    activePlay: active ? { ...active, url: `${getPublicBaseUrl()}/` } : null,
    services: {
      app: serviceState(ctx.runtime.service),
      tunnel: serviceState(ctx.runtime.tunnelService),
    },
    http: checks,
    publicUrl: getPublicBaseUrl(),
  };
};

async function restartService(ctx: CommandContext) {
  const state = serviceState(ctx.runtime.service);
  if (!state.exists) throw new CliError(`El servicio ${ctx.runtime.service} no existe (systemctl --user). Créalo primero.`);
  const result = run("systemctl", ["--user", "restart", ctx.runtime.service]);
  if (result.code !== 0) throw new CliError(`No se pudo reiniciar ${ctx.runtime.service}: ${result.stderr.trim()}`);
  const health = await waitHealthy(`${ctx.runtime.localUrl}/`, 30);
  return { service: serviceState(ctx.runtime.service), health };
}

const restart: Handler = async (ctx) => restartService(ctx);

const logs: Handler = async (ctx) => {
  const lines = ctx.int("lines") ?? 100;
  const result = run("journalctl", ["--user", "-u", ctx.runtime.service, "-n", String(lines), "--no-pager", "-o", "short-iso"]);
  if (result.code !== 0) throw new CliError(`journalctl falló: ${result.stderr.trim()}`);
  return { service: ctx.runtime.service, lines: result.stdout.split("\n").filter(Boolean) };
};

const rebuild: Handler = async (ctx) => {
  const started = Date.now();
  const build = run("bun", ["run", "build"], { cwd: ctx.runtime.repoDir, inherit: true });
  if (build.code !== 0) throw new CliError(`bun run build falló (exit ${build.code}); el servicio no se reinició. Revisa stderr.`);
  const restarted = await restartService(ctx);
  return { build: { ok: true, seconds: Math.round((Date.now() - started) / 1000) }, ...restarted };
};

const backup: Handler = async (ctx) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(ctx.str("out") ?? path.join(getDataDir(), "backups", `obras-${stamp}.tar.gz`));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "obras-backup-"));
  try {
    const dbCopy = path.join(tmp, "obras.sqlite");
    getDb().exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    const args = ["-czf", out, "-C", tmp, "obras.sqlite"];
    if (fs.existsSync(getMediaDir())) args.push("-C", getDataDir(), "media");
    const result = run("tar", args);
    if (result.code !== 0) throw new CliError(`tar falló: ${result.stderr.trim()}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  return {
    file: out,
    bytes: fs.statSync(out).size,
    restore: `Detén el servicio; tar -xzf ${out} -C "$OBRAS_DATA_DIR" (sobrescribe obras.sqlite y media/); borra obras.sqlite-wal/-shm; inicia el servicio.`,
  };
};

export const COMMANDS: Record<string, Handler> = {
  apply,
  export: exportCmd,
  list,
  ls: list,
  show,
  create,
  update,
  delete: del,
  publish: stateCommand("publish"),
  unpublish: stateCommand("unpublish"),
  hide: stateCommand("hide"),
  unhide: stateCommand("unhide"),
  activate: stateCommand("activate"),
  deactivate: stateCommand("deactivate"),
  deploy,
  actor,
  actors: actor,
  assign,
  unassign,
  assignments,
  media,
  votes,
  status,
  restart,
  logs,
  rebuild,
  backup,
};
