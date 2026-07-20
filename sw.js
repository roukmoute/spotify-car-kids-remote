/**
 * Service worker minimal : app-shell en cache-first, pochettes en
 * stale-while-revalidate, et surtout AUCUN cache sur les appels d'API.
 *
 * Le but n'est pas le mode hors-ligne (sans reseau, il n'y a de toute facon
 * rien a piloter) mais le demarrage instantane : sur la tablette, le shell
 * est servi depuis le disque local, sans aller-retour reseau.
 *
 * Bump SHELL_VERSION a chaque deploiement : c'est ce qui declenche le
 * remplacement du cache et evite le classique "coince sur l'ancienne version".
 */

const SHELL_VERSION = "v1";
const SHELL_CACHE = `scr-shell-${SHELL_VERSION}`;
const ART_CACHE = "scr-art-v1";

/** Nombre max de pochettes conservees (evite de remplir le stockage). */
const ART_MAX_ENTRIES = 120;

/* Chemins relatifs : fonctionne aussi bien a la racine d'un domaine que sur
   un sous-chemin GitHub Pages (/spotify-car-kids-remote/). */
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/auth.js",
  "./js/spotify.js",
  "./js/lyrics.js",
  "./js/ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

/** Hotes dont les reponses ne doivent JAMAIS etre mises en cache. */
const NEVER_CACHE_HOSTS = new Set([
  "api.spotify.com",
  "accounts.spotify.com",
  "lrclib.net",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll est atomique : si un seul asset echoue, l'install echoue et
      // l'ancien SW reste actif. C'est le comportement voulu.
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("scr-") && k !== SHELL_CACHE && k !== ART_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API : on laisse passer sans interception. Mettre en cache l'etat du
  // lecteur ou un token serait activement nuisible.
  if (NEVER_CACHE_HOSTS.has(url.hostname)) return;

  // Navigation (y compris le retour OAuth avec ?code=...) : on sert le shell
  // depuis le cache. Les query params restent lisibles cote JS via
  // location.search, ils ne transitent pas par la reponse.
  if (request.mode === "navigate") {
    event.respondWith(
      caches
        .match("./index.html", { ignoreSearch: true })
        .then((hit) => hit || fetch(request)),
    );
    return;
  }

  // Pochettes d'albums Spotify : stale-while-revalidate.
  if (url.hostname.endsWith("scdn.co")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Reste du shell : cache-first.
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request)),
    );
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ART_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      // Les images scdn.co sont servies en CORS ; on ne stocke que les
      // reponses exploitables (une reponse opaque occupe de la place sans
      // qu'on puisse verifier son statut).
      if (res.ok) {
        cache.put(request, res.clone()).then(() => trimCache(cache, ART_MAX_ENTRIES));
      }
      return res;
    })
    .catch(() => cached);

  return cached || network;
}

/** Eviction FIFO grossiere : l'ordre de keys() est l'ordre d'insertion. */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(
    keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)),
  );
}
