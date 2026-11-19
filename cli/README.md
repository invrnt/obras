# `obras`: CLI de Ensayo de Obras

Con este CLI se gestiona toda la app desde la terminal: obras, actores, asignaciones de fragmentos, votaciones, medios, publicación y el servidor. Está pensado para agentes de IA: nunca pregunta nada en modo interactivo, imprime JSON en stdout y termina con exit ≠ 0 cuando hay error.

```bash
obras help                 # resumen de todos los comandos
obras <comando> --help     # detalle de un comando
obras example              # manifiesto YAML de ejemplo completo
```

- Wrapper global: `~/.local/bin/obras`. Ejecuta `bun /home/cami/obras/cli/obras.ts` con `OBRAS_DATA_DIR=${OBRAS_DATA_DIR:-/home/cami/obras/data}`. Desde el repo también sirve `bun run obras …`.
- Datos: `$OBRAS_DATA_DIR/obras.sqlite` (SQLite) y `$OBRAS_DATA_DIR/media/` (servidos en `/media/<key>`). Las páginas leen SQLite directamente, así que lo que escribe el CLI se ve al instante, sin rebuild ni restart.
- Salida: `{"ok":true,...}` / `{"ok":false,"error":"..."}`. `--pretty` indenta el JSON y `--human` lo muestra como texto (YAML). `OBRAS_DEBUG=1` añade el stack a los errores.
- Referencias: `<obra>` acepta id o slug. `<actor>` acepta el nombre (sin distinguir mayúsculas) o el id.
- URLs: base `OBRAS_PUBLIC_URL` (default `https://obras.orientador.co`). La obra está en `/obras/<slug>` (si está publicada y no oculta), la obra activa en `/` y el admin en `/tramoya/obras/<id>`.
- Otras variables: `OBRAS_SERVICE` (default `obras.service`), `OBRAS_TUNNEL_SERVICE` (`obras-tunnel.service`) y `OBRAS_LOCAL_URL` (`http://127.0.0.1:3410`).

## Flujo recomendado

```bash
obras example > obra.yaml            # partir del ejemplo
# editar obra.yaml (+ guion.md, media/…)
obras apply obra.yaml --dry-run      # ver el plan sin escribir
obras apply obra.yaml                # crear/actualizar (idempotente)
obras deploy <slug>                  # publicar + visible + activa → devuelve URLs
obras show <slug>                    # verificar actores/asignaciones/votos
```

Para editar una obra que ya existe: `obras export <slug> --out dir`, editar `dir/obra.yaml` y `dir/<slug>.md`, y luego `obras apply dir/obra.yaml`.

## Manifiesto (`apply`)

YAML o JSON. Las rutas son relativas al manifiesto.

| clave | tipo | notas |
|---|---|---|
| `title` | texto | obligatorio al crear |
| `slug` | texto | identifica la obra; si falta se usa `slugify(title)` |
| `id` | uuid | opcional; tiene prioridad sobre slug (export lo incluye) |
| `markdown` / `markdown_file` | texto / ruta | uno de los dos; si no hay ninguno se conserva el markdown actual |
| `media` | `{nombre: ruta}` o `{nombre: {file, alt}}` | imágenes o audios locales |
| `actors` | lista de nombres | crea los que falten; los sobrantes se borran solo con `--prune` |
| `assignments` | lista | `{text, actors, occurrence?, all?}` |
| `published`, `hidden`, `active` | bool | `active` requiere `published: true` y `hidden: false`; solo puede haber una activa |

- **Placeholders de medios** en el markdown: `{{media:nombre}}` se reemplaza por la URL `/media/...`. `{{embed:nombre}}` se reemplaza por el bloque completo, igual al que inserta el admin: `![alt](url)` para imágenes o `<audio controls src="url"></audio>` para audios. Si un archivo tiene el mismo contenido (sha256) que uno ya guardado, no se vuelve a subir: se reutiliza su key. Un medio declarado que no se usa en el markdown no se sube y genera un warning.
- **Asignaciones**: `text` debe aparecer EXACTO en el markdown final, después de sustituir los placeholders. Eso incluye los `**` y la puntuación. Si aparece varias veces hay que indicar `occurrence: n` (empieza en 1) o `all: true`. `actors` puede ser una lista o `"Ana, Luis"`, y cada nombre debe estar en `actors`. Si el manifiesto trae `assignments`, esa lista reemplaza todas las asignaciones de la obra. Si no las trae y el markdown cambia, las existentes se reubican buscando su texto.
- **Offsets**: cada asignación se guarda como `start_offset`/`end_offset` sobre el string markdown crudo más `selected_text`. Es exactamente lo que guarda el editor del admin cuando se selecciona texto en el textarea.
- **Atomicidad**: primero se valida todo (textos, actores, archivos, placeholders, slug y estado). Después se copian los medios y todos los cambios en la DB van en una sola transacción. Si algo falla, se hace rollback y se borran los archivos recién copiados.
- **Idempotencia**: si se re-aplica el mismo manifiesto, la respuesta trae `"changed": false` y no se escribe nada (ni siquiera `updated_at`).
- La salida incluye `plan`: `changes`, `actors.add|remove|extra`, `media.upload|reuse|unused`, `assignments.add|update|remove|unchanged` (o `relocated`) y `warnings`.

### Asignación automática (`auto_assign`)

Para guiones con formato `**PERSONAJE:** texto` y acotaciones `*(…)*`. Evita listar cada línea en `assignments`:

```yaml
auto_assign:
  section: Guion              # opcional: solo bajo el encabezado "Guion" (hasta el siguiente de igual nivel)
  characters:                 # PERSONAJE (como aparece en **PERSONAJE:**) -> actor(es) de `actors`
    ANA: Mariana (Ana)
    GABRIEL: {actors: Alexandra (Gabriel), match: [ángel]}   # match = otras palabras que lo nombran en acotaciones
  groups:                     # nombres colectivos, en diálogos (**GABRIEL Y PASTORES:**) y en acotaciones
    PASTORES: {members: [DÉBORA, RUT], match: [pastores]}
    TODOS: {members: "*", match: [todos los actores]}
  skip: Audio pendiente       # regex: párrafos que la detección por menciones ignora
  # dialogue: true / mentions: true (por defecto)
```

- Diálogo: el párrafo entero va a los actores del personaje (o personajes: `A Y B`, `A, B`, grupos). Un personaje sin mapear es error.
- Resto de párrafos (acotaciones, pistas de sonido): van a los personajes cuyo nombre (o `match`) aparece, sin importar tildes ni mayúsculas.
- Las acotaciones que no nombran a nadie (`*(Salen.)*`) se completan con `assignments` normales; se combinan.
- `apply --dry-run` muestra `assignments.auto` con conteos. Ejemplo real: `~/obras-contenido/permanecer/obra.yaml`.

### Votaciones (sintaxis del markdown)

```
[vote]
---
Opción A
---
Opción B
```

El bloque empieza con una línea `[vote]` y lleva al menos 2 opciones separadas por `---`. Termina en la primera línea vacía. El id del bloque (`vote-<hash>-n`) sale de su contenido, así que si se edita el bloque sus votos anteriores quedan huérfanos.

## Comandos

### Obras
| comando | qué hace |
|---|---|
| `apply <f> [--dry-run] [--prune]` | crea o actualiza desde un manifiesto |
| `export <obra> [--out dir] [--no-media]` | sin `--out` imprime el manifiesto con el markdown inline. Con `--out` escribe `obra.yaml`, `<slug>.md` y `media/`, y cambia las URLs por `{{media:…}}`. El resultado se reimporta sin cambios |
| `example` / `schema` | imprime un manifiesto de ejemplo |
| `list` | obras con estado, conteos y URL |
| `show <obra> [--markdown]` | detalle: actores, asignaciones (con `valid` y `occurrence`), medios, votaciones y URLs |
| `create --title T [--slug s] [--markdown-file f \| --markdown txt\|-] [--actors "A,B"]` | crea la obra sin publicar. `-` lee de stdin |
| `update <obra> [--title] [--slug] [--markdown-file f \| --markdown txt\|-]` | reubica las asignaciones por su texto. Las que no encuentra se borran y salen en `assignments.lost` |
| `delete <obra> --yes [--keep-media]` | borra la obra con sus actores, asignaciones, votos y los medios propios que nadie más use |
| `publish` `unpublish` `hide` `unhide` `activate` `deactivate <obra>` | cambian el estado. `activate` exige que esté publicada y visible |
| `deploy <obra>` | publica, deja visible y activa la obra (la anterior se desactiva). Devuelve `urls` |

### Actores
`actor list <obra>` · `actor add <obra> <nombre...>` (acepta "A,B") · `actor rename <obra> <actor> <nuevo>` · `actor remove <obra> <actor...>`. Borrar un actor también borra sus asignaciones y votos.

### Asignaciones
- `assign <obra> --text T --actors "A,B" [--occurrence n | --all]`: fija exactamente esos actores para ese rango.
- `unassign <obra> --id ID` o `unassign <obra> --text T [--occurrence n]`. Con `--actor A` solo quita a ese actor.
- `assignments <obra> [--actor A]`.

### Medios
- `media add <obra> <archivo...> [--insert [--after T] [--occurrence n]] [--alt T]`: devuelve `key`, `url`, `snippet` y `reused`. Con `--insert`, añade el snippet como párrafo después de la línea que contiene `--after` (o al final) y reubica las asignaciones.
- `media list [obra]`: cada archivo trae `referenced`. `media rm <key...> [--force]`: exige `--force` si alguna obra usa el archivo. `media prune [--yes]`: borra los archivos que ningún markdown referencia (sin `--yes` es dry-run).

### Votaciones
`votes <obra>`: resultados por bloque y por opción, y quién votó. `votes reset <obra> [--vote ID] --yes`.

### Operación
| comando | qué hace |
|---|---|
| `status [--public]` | rutas, conteos, obra activa, estado de `obras.service` / `obras-tunnel.service` (`systemctl --user`) y health HTTP local (y público con `--public`). Nunca falla si los servicios no existen |
| `restart` | `systemctl --user restart obras.service` y espera hasta 30 s a que responda |
| `logs [--lines n]` | `journalctl --user -u obras.service` |
| `rebuild` | `bun run build` (la salida va a stderr) y luego `restart`. Solo hace falta cuando cambia el código, no el contenido |
| `backup [--out f.tar.gz]` | `VACUUM INTO` + `media/` en un tar.gz (default `$OBRAS_DATA_DIR/backups/`) |

## Pruebas sin tocar producción

```bash
export OBRAS_DATA_DIR=$(mktemp -d)   # DB y media aisladas
obras apply obra.yaml && obras show <slug>
```

## Código

- `cli/obras.ts`: entrada, parseo de args, ayuda y salida.
- `cli/commands.ts`: los comandos.
- `lib/play-import.ts`: manifiesto, apply/export, reubicación de asignaciones y deduplicación de medios.
- Reutiliza `lib/plays.ts`, `lib/db.ts` y `lib/storage.ts`. No importa nada de Next (`server-only`, `next/cache`).

## PDF

- `obras pdf <obra> [--actor A | --all-actors] [--out archivo.pdf|dir/]`: portada con reparto + guion en A4, pie con título y número de página. Con `--actor`, sus partes quedan resaltadas y marcadas en el margen. `--all-actors` genera el completo + uno por actor.
- Lo renderiza el servidor local con Chrome headless (`/usr/bin/google-chrome-stable`, `OBRAS_CHROME_PATH`); queda en caché en `data/cache/pdf/` hasta que cambie la obra o el build.
- Web: `/obras/<slug>/pdf?actor=<id>` (descarga) y `/obras/<slug>/imprimir` (vista previa con selector de actor). Obras no publicadas: solo admin o CLI.
- Clasificación para el diseño: `**PERSONAJE:**` = diálogo, `*(…)*` = acotación, `**[…]**` al inicio = pista de sonido, `*🔊 …*` = audio pendiente.
