/**
 * Serveur statique de developpement, sans dependance.
 *
 *   node tools/dev-server.mjs [port]
 *
 * Ecoute sur 127.0.0.1 volontairement : c'est la seule adresse pour laquelle
 * Spotify accepte encore une URI de redirection en http:// (exception
 * loopback), et c'est aussi un "secure context" pour le navigateur, donc les
 * service workers et crypto.subtle fonctionnent comme en production.
 *
 * Declare http://127.0.0.1:5173/ dans le dashboard Spotify pour tester en
 * local. Attention : "localhost" n'est PAS accepte, il faut l'IP.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // normalize + suppression des ".." : empeche de sortir de ROOT.
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (rel.endsWith("/") || rel === "\\") rel = join(rel, "index.html");

  const file = join(ROOT, rel);

  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error("directory");

    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      // Jamais de cache en dev : sinon on debugge l'ancienne version.
      "Cache-Control": "no-store",
      // Le service worker doit pouvoir prendre le scope racine.
      "Service-Worker-Allowed": "/",
    });
    res.end(body);
  } catch {
    // Repli SPA : toute route inconnue rend index.html, ce qui reproduit le
    // comportement du retour de redirection OAuth (/?code=...).
    try {
      const html = await readFile(join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404");
    }
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`spotify-car-kids-remote -> http://127.0.0.1:${PORT}/`);
  console.log(`URI de redirection Spotify a declarer : http://127.0.0.1:${PORT}/`);
});
