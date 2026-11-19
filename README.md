# Ensayo de Obras

Aplicación interna para cargar guiones de teatro y repasarlos desde el celular.
Corre en local en la mini PC (`node01`) y se publica en **https://obras.orientador.co** mediante un Cloudflare Tunnel.

## Qué incluye

- Frente público de solo lectura (`/`, `/obras`, `/obras/<slug>`).
- Panel oculto en `/tramoya` (usuario y contraseña en `~/.config/obras/server.env`).
- Editor Markdown con imágenes, audio y bloques de votación.
- Actores por obra y asignación de fragmentos a uno o varios actores.
- Publicar, ocultar y marcar una única `obra activa`.
- Exportar a PDF (portada, reparto, guion en A4; por actor con sus partes resaltadas): botón en cada obra, `/obras/<slug>/pdf` u `obras pdf`.
- CLI `obras` para que un agente de IA gestione todo (ver `cli/README.md`).

## Arquitectura local

| Pieza | Dónde |
|---|---|
| Base de datos | SQLite (`node:sqlite`, modo WAL) en `data/obras.sqlite`; el esquema se crea solo (`lib/db.ts`) |
| Multimedia | Archivos en `data/media/`, servidos por `/media/<key>` con Range, ETag y caché `immutable` (`lib/storage.ts`) |
| Servidor | `next start` en `127.0.0.1:3410`, servicio `systemctl --user` `obras.service` |
| Túnel | Cloudflare Tunnel `obras` (cuenta ascend, id `6d96b451-ce40-48fa-b3e1-2c4274877bb5`), servicio `obras-tunnel.service` |
| Secretos | `~/.config/obras/server.env` (ADMIN_PASSWORD, SESSION_SECRET, OBRAS_DATA_DIR) y `~/.config/obras/tunnel-token` |

`data/` no se versiona: haz copias con `obras backup`.

## Desarrollo

```bash
bun install
set -a; . ~/.config/obras/server.env; set +a
OBRAS_DATA_DIR=./data-dev bun dev
```

## Desplegar cambios de código

```bash
bun run build && systemctl --user restart obras.service
# o: obras rebuild
```

Los cambios de contenido (obras, actores, medios) no requieren build: las páginas leen SQLite en cada request.

## Operación

```bash
systemctl --user status obras.service obras-tunnel.service
journalctl --user -u obras.service -f
```
