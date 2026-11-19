/**
 * Automatic fragment assignment for scripts written as
 *   **PERSONAJE:** texto      (dialogue; "**A Y B:**" or a group name also work)
 *   *(acotación que menciona a Personaje)*   (directions / any other paragraph)
 *
 * Used by the `auto_assign` key of an `obras apply` manifest.
 */

export type AutoAssignCharacter = {
  /** Actor names (must exist in the manifest `actors`). */
  actors: string[];
  /** Extra words that refer to this character in directions (e.g. "el ángel"). The key itself always matches. */
  match: string[];
};

export type AutoAssignConfig = {
  characters: Record<string, AutoAssignCharacter>;
  /** Group name -> character keys, or "*" for everyone. */
  groups: Record<string, { members: string[] | "*"; match: string[] }>;
  /** Only paragraphs under the heading whose text equals this (until the next heading of the same or higher level). */
  section?: string;
  dialogue: boolean;
  /** Assign non-dialogue paragraphs to the characters mentioned in them. */
  mentions: boolean;
  /** Paragraphs matching this regex are skipped by `mentions`. */
  skip?: RegExp;
};

export type AutoRange = { startOffset: number; endOffset: number; text: string; actorNames: string[] };

export class AutoAssignError extends Error {}

export function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es")
    .replace(/\s+/g, " ")
    .trim();
}

function asStringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((item) => String(item).trim()).filter((item) => {
    if (!item) throw new AutoAssignError(`${label}: hay un valor vacío.`);
    return true;
  });
}

/** Validates the raw manifest value. */
export function parseAutoAssign(raw: unknown): AutoAssignConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AutoAssignError("auto_assign debe ser un objeto con characters (y opcionalmente groups, section, dialogue, mentions, skip).");
  }

  const value = raw as Record<string, unknown>;
  const allowed = new Set(["characters", "groups", "section", "dialogue", "mentions", "skip"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AutoAssignError(`auto_assign: clave desconocida "${key}".`);
  }

  const rawCharacters = value.characters;
  if (!rawCharacters || typeof rawCharacters !== "object" || Array.isArray(rawCharacters)) {
    throw new AutoAssignError("auto_assign.characters debe ser un mapa PERSONAJE -> actor(es) o {actors, match}.");
  }

  const characters: AutoAssignConfig["characters"] = {};
  for (const [name, entry] of Object.entries(rawCharacters as Record<string, unknown>)) {
    const label = `auto_assign.characters.${name}`;
    const isObject = entry && typeof entry === "object" && !Array.isArray(entry);
    const actors = asStringList(isObject ? (entry as Record<string, unknown>).actors : entry, label);
    if (!actors.length) throw new AutoAssignError(`${label}: falta el actor.`);
    const match = isObject ? asStringList((entry as Record<string, unknown>).match, `${label}.match`) : [];
    characters[normalizeName(name)] = { actors, match: [name, ...match] };
  }

  const groups: AutoAssignConfig["groups"] = {};
  const rawGroups = value.groups ?? {};
  if (typeof rawGroups !== "object" || Array.isArray(rawGroups)) {
    throw new AutoAssignError("auto_assign.groups debe ser un mapa GRUPO -> [personajes] | \"*\" | {members, match}.");
  }
  for (const [name, entry] of Object.entries(rawGroups as Record<string, unknown>)) {
    const label = `auto_assign.groups.${name}`;
    const isObject = entry && typeof entry === "object" && !Array.isArray(entry);
    const rawMembers = isObject ? (entry as Record<string, unknown>).members : entry;
    const members = rawMembers === "*" ? "*" : asStringList(rawMembers, label).map(normalizeName);
    if (members !== "*") {
      for (const member of members) {
        if (!characters[member]) throw new AutoAssignError(`${label}: "${member}" no está en auto_assign.characters.`);
      }
    }
    const match = isObject ? asStringList((entry as Record<string, unknown>).match, `${label}.match`) : [];
    groups[normalizeName(name)] = { members, match: [name, ...match] };
  }

  let skip: RegExp | undefined;
  if (value.skip !== undefined) {
    try {
      skip = new RegExp(String(value.skip), "u");
    } catch (error) {
      throw new AutoAssignError(`auto_assign.skip no es una regex válida: ${(error as Error).message}`);
    }
  }

  return {
    characters,
    groups,
    section: value.section === undefined ? undefined : String(value.section),
    dialogue: value.dialogue === undefined ? true : value.dialogue === true,
    mentions: value.mentions === undefined ? true : value.mentions === true,
    skip,
  };
}

type Paragraph = { start: number; end: number; text: string };

/** Splits markdown into blank-line separated paragraphs (offsets of the trimmed text). */
function paragraphs(markdown: string): Paragraph[] {
  const result: Paragraph[] = [];
  const pattern = /[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g;
  for (const match of markdown.matchAll(pattern)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) continue;
    const start = match.index! + leading;
    result.push({ start, end: start + text.length, text });
  }
  return result;
}

function headingLevel(text: string) {
  const match = /^(#{1,6})\s+(.*)$/.exec(text);
  return match ? { level: match[1]!.length, title: match[2]!.trim() } : null;
}

function wordPattern(word: string) {
  const escaped = normalizeName(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
}

export function computeAutoAssignments(markdown: string, config: AutoAssignConfig): { ranges: AutoRange[]; stats: Record<string, number> } {
  const allCharacters = Object.keys(config.characters);

  const resolveSpeaker = (label: string): string[] => {
    const key = normalizeName(label);
    if (config.characters[key]) return [key];
    const group = config.groups[key];
    if (group) return group.members === "*" ? allCharacters : group.members;
    return [];
  };

  const mentionMatchers: Array<{ pattern: RegExp; characters: string[] }> = [
    ...Object.entries(config.characters).flatMap(([key, character]) =>
      character.match.map((word) => ({ pattern: wordPattern(word), characters: [key] })),
    ),
    ...Object.values(config.groups).flatMap((group) =>
      group.match.map((word) => ({ pattern: wordPattern(word), characters: group.members === "*" ? allCharacters : group.members })),
    ),
  ];

  const ranges: AutoRange[] = [];
  const stats = { dialogue: 0, mentions: 0, skipped: 0 };
  const unknownSpeakers = new Set<string>();
  let inSection = config.section === undefined;
  let sectionLevel = 0;
  let sectionFound = config.section === undefined;

  for (const paragraph of paragraphs(markdown)) {
    const heading = headingLevel(paragraph.text);

    if (heading) {
      if (config.section !== undefined) {
        if (normalizeName(heading.title) === normalizeName(config.section)) {
          inSection = true;
          sectionFound = true;
          sectionLevel = heading.level;
        } else if (inSection && heading.level <= sectionLevel) {
          inSection = false;
        }
      }
      continue;
    }

    if (!inSection) continue;

    let characters: string[] = [];
    const speaker = /^\*\*([^*\n]+?):\*\*/u.exec(paragraph.text);

    if (speaker && config.dialogue) {
      for (const part of speaker[1]!.split(/\s+y\s+|\s*,\s*/iu)) {
        const resolved = resolveSpeaker(part);
        if (!resolved.length) unknownSpeakers.add(part.trim());
        characters.push(...resolved);
      }
      if (characters.length) stats.dialogue += 1;
    } else if (!speaker && config.mentions) {
      if (config.skip?.test(paragraph.text)) {
        stats.skipped += 1;
        continue;
      }
      const normalized = normalizeName(paragraph.text);
      for (const matcher of mentionMatchers) {
        if (matcher.pattern.test(normalized)) characters.push(...matcher.characters);
      }
      if (characters.length) stats.mentions += 1;
    }

    characters = [...new Set(characters)];
    if (!characters.length) continue;

    const actorNames = [...new Set(characters.flatMap((key) => config.characters[key]!.actors))];
    ranges.push({ startOffset: paragraph.start, endOffset: paragraph.end, text: paragraph.text, actorNames });
  }

  if (!sectionFound) {
    throw new AutoAssignError(`auto_assign.section: no hay un encabezado "${config.section}" en el markdown.`);
  }

  if (unknownSpeakers.size) {
    throw new AutoAssignError(
      `auto_assign: personajes sin mapear en diálogos: ${[...unknownSpeakers].join(", ")}. Añádelos a characters o groups.`,
    );
  }

  return { ranges, stats };
}
