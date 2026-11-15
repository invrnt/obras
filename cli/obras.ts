#!/usr/bin/env bun
/**
 * `obras`: non-interactive CLI to manage the "Ensayo de Obras" app (JSON output).
 * Run with bun: `bun cli/obras.ts help`. See cli/README.md.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.OBRAS_DATA_DIR) {
  process.env.OBRAS_DATA_DIR = path.join(REPO_DIR, "data");
}

const SERVICE = process.env.OBRAS_SERVICE || "obras.service";
const TUNNEL_SERVICE = process.env.OBRAS_TUNNEL_SERVICE || "obras-tunnel.service";
const LOCAL_URL = (process.env.OBRAS_LOCAL_URL || "http://127.0.0.1:3410").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `obras — CLI de "Ensayo de Obras" (${"https://obras.orientador.co"}). Salida JSON {"ok":true,...}; error {"ok":false,"error"} y exit 1.
<obra> = id o slug. <actor> = nombre (sin importar mayúsculas) o id. Flags globales: --pretty (JSON indentado), --human (texto legible).

Flujo recomendado: obras example > obra.yaml; editar; obras apply obra.yaml --dry-run; obras apply obra.yaml; obras deploy <slug>

Obras
  apply <manifiesto.yaml|json> [--dry-run] [--prune]   Crea/actualiza una obra completa (idempotente)
  export <obra> [--out dir] [--no-media]               Manifiesto reimportable (con --out escribe obra.yaml + .md + media/)
  example | schema                                     Manifiesto de ejemplo comentado (YAML)
  list                                                 Todas las obras con estado y conteos
  show <obra> [--markdown]                             Detalle: actores, asignaciones, votaciones, URLs
  create --title T [--slug s] [--markdown-file f | --markdown txt|-] [--actors "A,B"]
  update <obra> [--title T] [--slug s] [--markdown-file f | --markdown txt|-]   (reubica asignaciones)
  delete <obra> --yes [--keep-media]
  publish|unpublish|hide|unhide|activate|deactivate <obra>
  deploy <obra>                                        Publica + visible + activa; devuelve URLs
Actores
  actor list <obra> | actor add <obra> <nombre...> | actor rename <obra> <actor> <nuevo> | actor remove <obra> <actor...>
Asignaciones (fragmento de texto -> actores)
  assign <obra> --text T --actors "A,B" [--occurrence n | --all]
  unassign <obra> (--id ID | --text T [--occurrence n|--all]) [--actor A]
  assignments <obra> [--actor A]
Medios (imágenes/audios, servidos en /media/<key>)
  media add <obra> <archivo...> [--insert [--after T]] [--alt T]
  media list [obra] | media rm <key...> [--force] | media prune [--yes]
Votaciones
  votes <obra> | votes reset <obra> [--vote ID] --yes
Operación
  status [--public] | restart | logs [--lines n] | rebuild | backup [--out f.tar.gz]

Más: obras <comando> --help`;

const COMMAND_HELP: Record<string, string> = {
  apply: `obras apply <manifiesto.yaml|json> [--dry-run] [--prune]
Crea o actualiza una obra a partir de un manifiesto declarativo. Idempotente: re-aplicar sin cambios no escribe nada ("changed":false).
- La obra se busca por id, luego por slug (o slugify(title) si no hay slug). Si no existe se crea.
- markdown inline o markdown_file (ruta relativa al manifiesto). Sin ninguno: conserva el markdown actual.
- media: {nombre: ruta | {file, alt}}. En el markdown: {{media:nombre}} -> URL /media/...; {{embed:nombre}} -> ![alt](url) o <audio controls src="url"></audio>. Archivos idénticos (sha256) no se resuben.
- actors: lista de nombres. Crea los faltantes; los sobrantes solo se borran con --prune.
- assignments: [{text, actors:[..], occurrence?: n (1-based), all?: true}]. text debe aparecer EXACTO en el markdown final. Si se incluye, reemplaza todas las asignaciones de la obra. Si se omite y el markdown cambia, las existentes se reubican por su texto.
- published/hidden/active: booleanos. active requiere published:true y hidden:false (solo una obra activa a la vez).
Todo se valida antes de escribir; los cambios en DB son atómicos. --dry-run devuelve el plan sin escribir. Ver: obras example`,
  export: `obras export <obra> [--out dir] [--no-media]
Sin --out: imprime el manifiesto (markdown inline, URLs /media tal cual).
Con --out: escribe dir/obra.yaml, dir/<slug>.md y copia los medios a dir/media/ reemplazando sus URLs por {{media:nombre}}. "obras apply dir/obra.yaml" lo reimporta sin cambios.`,
  example: "obras example: imprime un manifiesto YAML de ejemplo con actores, asignaciones, una votación, imagen y audio.",
  list: "obras list: lista obras (id, slug, título, published, hidden, active, conteos, URL).",
  show: "obras show <obra> [--markdown]: detalle con actores, asignaciones (texto, offsets, actores), votaciones con resultados y URLs. --markdown incluye el texto completo.",
  create: `obras create --title T [--slug s] [--markdown-file f | --markdown txt | --markdown -] [--actors "A,B"]
Crea una obra (sin publicar). --markdown - lee de stdin. Slug automático único si no se da.`,
  update: `obras update <obra> [--title T] [--slug s] [--markdown-file f | --markdown txt | --markdown -]
Actualiza título/slug/markdown. Al cambiar el markdown, reubica cada asignación buscando su texto (la ocurrencia más cercana); las que no se encuentran se eliminan y se reportan en "assignments.lost".`,
  delete: "obras delete <obra> --yes [--keep-media]: borra la obra, sus actores, asignaciones, votos y (salvo --keep-media) sus archivos en media/plays/<id>/ que ninguna otra obra use.",
  publish: "obras publish|unpublish|hide|unhide|activate|deactivate <obra>. Publicada+visible = se ve en /obras/<slug>. Activa = se ve en / (requiere publicada y visible; desactiva la anterior). unpublish/hide desactivan.",
  deploy: "obras deploy <obra>: published=true, hidden=false, active=true. Devuelve URLs pública, home y admin.",
  actor: `obras actor list <obra>
obras actor add <obra> <nombre...>            (varios nombres o "A,B")
obras actor rename <obra> <actor> <nuevo>
obras actor remove <obra> <actor...>          (borra también sus asignaciones y votos)`,
  assign: `obras assign <obra> --text "fragmento exacto" --actors "Ana,Luis" [--occurrence n | --all]
Asigna el fragmento a esos actores (reemplaza los actores de ese mismo rango). Si el texto aparece varias veces hay que elegir --occurrence (1-based) o --all. Los actores deben existir (obras actor add).`,
  unassign: `obras unassign <obra> --id ID
obras unassign <obra> --text T [--occurrence n | --all]     (por defecto todas las asignaciones cuyo texto es exactamente T)
--actor A: en vez de borrar la asignación, quita solo a ese actor (si queda vacía se borra).`,
  assignments: "obras assignments <obra> [--actor A]: lista asignaciones (id, texto, offsets, actores, occurrence).",
  media: `obras media add <obra> <archivo...> [--insert [--after "texto"] [--occurrence n]] [--alt T]
  Copia archivos (imagen/audio) y devuelve key, url y snippet markdown. Reutiliza archivos idénticos.
  --insert añade los snippets al markdown: tras la línea que contiene --after, o al final.
obras media list [obra]          Archivos (de la obra o todos) con "referenced"
obras media rm <key...> [--force]  Borra archivos (exige --force si alguna obra los usa)
obras media prune [--yes]        Archivos sin referencia en ningún markdown (dry-run salvo --yes)`,
  votes: `obras votes <obra>: resultados de cada bloque [vote] (opciones, conteos, quién votó).
obras votes reset <obra> [--vote ID] --yes: borra votos (todos o de un bloque).
Sintaxis en el markdown (línea [vote], opciones separadas por ---, mínimo 2, termina en línea vacía):
[vote]
---
Opción A
---
Opción B`,
  status: `obras status [--public]: ruta de datos/DB, conteos, estado de ${SERVICE} y ${TUNNEL_SERVICE} (systemd --user) y health HTTP de ${LOCAL_URL}/ (y la URL pública con --public).`,
  restart: `obras restart: systemctl --user restart ${SERVICE} y espera a que responda.`,
  logs: `obras logs [--lines n]: últimas n líneas (default 100) de journalctl --user -u ${SERVICE}.`,
  rebuild: "obras rebuild: bun run build en el repo y luego restart (cuando cambia el código).",
  backup: "obras backup [--out archivo.tar.gz]: copia consistente de la DB (VACUUM INTO) + media/ en un tar.gz. Default: $OBRAS_DATA_DIR/backups/obras-<fecha>.tar.gz",
};
COMMAND_HELP.schema = COMMAND_HELP.example;
for (const alias of ["unpublish", "hide", "unhide", "activate", "deactivate"]) COMMAND_HELP[alias] = COMMAND_HELP.publish;

const EXAMPLE = `# Manifiesto de obra para: obras apply obra.yaml
# Rutas relativas a este archivo. Re-aplicar es seguro (idempotente).
title: La casa de los espejos     # obligatorio al crear
slug: la-casa-de-los-espejos      # opcional; identifica la obra (si falta: slugify(title))
# id: <uuid>                      # opcional; si existe tiene prioridad sobre slug

# markdown_file: guion.md         # alternativa a markdown inline (no ambos)
markdown: |
  # La casa de los espejos

  {{embed:portada}}

  **ANA:** ¿Quién anda ahí?

  **LUIS:** Solo el viento.

  **ANA:** ¿Quién anda ahí?

  Escuchen la tormenta:

  {{embed:tormenta}}

  ¿Cómo termina la escena?

  [vote]
  ---
  Ana abre la puerta
  ---
  Luis apaga la vela

  **MARTA:** Fin.

# Archivos locales. {{media:nombre}} -> URL /media/...; {{embed:nombre}} -> ![alt](url) o <audio controls src="url"></audio>
media:
  portada:
    file: media/portada.png
    alt: Portada de la obra
  tormenta: media/tormenta.mp3

actors:            # crea los que falten; los sobrantes solo se borran con --prune
  - Ana
  - Luis
  - Marta

assignments:       # text debe aparecer EXACTO en el markdown final
  - text: "**ANA:** ¿Quién anda ahí?"
    actors: [Ana]
    all: true      # aparece 2 veces: todas (o usa occurrence: 1)
  - text: "**LUIS:** Solo el viento."
    actors: [Luis]
  - text: "Escuchen la tormenta:"
    actors: [Ana, Luis, Marta]
  - text: "**MARTA:** Fin."
    actors: Marta  # también vale "Ana, Luis"

published: true    # visible en /obras/<slug>
hidden: false
active: true       # la obra de la portada (/); requiere published y no hidden
`;

// ---------------------------------------------------------------------------
// Args / output
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  "help",
  "pretty",
  "human",
  "yes",
  "dry-run",
  "prune",
  "all",
  "insert",
  "force",
  "no-media",
  "keep-media",
  "public",
]);

type Args = { positionals: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq > 0 ? token.slice(2, eq) : token.slice(2);

      if (eq > 0) {
        flags[name] = token.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        const next = argv[index + 1];
        if (next === undefined || (next.startsWith("--") && next !== "-")) {
          flags[name] = true;
        } else {
          flags[name] = next;
          index += 1;
        }
      }
      continue;
    }

    if (token === "-h") {
      flags.help = true;
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

let outputMode: "json" | "pretty" | "human" = "json";

function toHuman(value: unknown): string {
  const yaml = (globalThis as unknown as { Bun?: { YAML?: { stringify(v: unknown, r: null, s: number): string } } }).Bun
    ?.YAML;
  return yaml ? yaml.stringify(value, null, 2) : JSON.stringify(value, null, 2);
}

function print(value: Record<string, unknown>) {
  if (outputMode === "human") {
    const rest = { ...value };
    delete rest.ok;
    process.stdout.write(`${toHuman(rest).trimEnd()}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, outputMode === "pretty" ? 2 : undefined)}\n`);
}

class UsageError extends Error {}

function str(flags: Args["flags"], name: string) {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} necesita un valor.`);
  return String(value);
}

function intFlag(flags: Args["flags"], name: string) {
  const value = str(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} debe ser un entero.`);
  return n;
}

function need(value: string | undefined, what: string) {
  if (!value) throw new UsageError(`Falta ${what}.`);
  return value;
}

function splitList(values: string[]) {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.flags.human) outputMode = "human";
  else if (args.flags.pretty) outputMode = "pretty";

  const [command, ...rest] = args.positionals;

  if (!command || command === "help") {
    const topic = rest[0];
    process.stdout.write(`${topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic] : HELP}\n`);
    return;
  }

  if (args.flags.help) {
    process.stdout.write(`${COMMAND_HELP[command] ?? HELP}\n`);
    return;
  }

  if (command === "example" || command === "schema") {
    process.stdout.write(EXAMPLE);
    return;
  }

  // Lazy imports so `help`/`example` work even if the DB layer cannot load.
  const commands = await import("./commands");
  const handler = commands.COMMANDS[command];

  if (!handler) {
    throw new UsageError(`Comando desconocido: ${command}. Usa "obras help".`);
  }

  const result = await handler({
    positionals: rest,
    flags: args.flags,
    str: (name) => str(args.flags, name),
    int: (name) => intFlag(args.flags, name),
    need,
    splitList,
    readStdin,
    runtime: { repoDir: REPO_DIR, service: SERVICE, tunnelService: TUNNEL_SERVICE, localUrl: LOCAL_URL },
  });
  print({ ok: true, ...result });
}

main().catch((error: unknown) => {
  const err = error as Error & { details?: unknown };
  const payload: Record<string, unknown> = { ok: false, error: err?.message || String(error) };
  if (err?.details !== undefined) payload.details = err.details;
  if (error instanceof UsageError) payload.hint = 'Usa "obras help" o "obras <comando> --help".';
  if (process.env.OBRAS_DEBUG && err?.stack) payload.stack = err.stack;
  print(payload);
  process.exitCode = 1;
});
