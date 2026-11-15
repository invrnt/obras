import path from "node:path";

/** Root folder for all local state (SQLite DB + media files). */
export function getDataDir() {
  return path.resolve(process.env.OBRAS_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));
}

export function getMediaDir() {
  return path.join(getDataDir(), "media");
}
