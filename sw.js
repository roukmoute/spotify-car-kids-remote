/**
 * Service worker minimal.
 *
 * Le but n'est pas le mode hors-ligne (sans reseau, il n'y a de toute facon
 * rien a piloter) mais le demarrage instantane : le shell est servi depuis le
 * disque local, sans aller-retour reseau.
 *
 * Strategie : stale-while-revalidate partout, et surtout AUCUN cache sur les
 * appels d'API. Le SWR plutot que le cache-first est un choix delibere : il
 * sert la version en cache immediatement (donc demarrage instantane) tout en
 * rafraichissant en arriere-plan, si bien qu'un deploiement se propage tout
 * seul au chargement suivant. En cache-first pur, oublier de bumper
 * SHELL_VERSION laisse la tablette bloquee indefiniment sur l'ancienne
 * version — le piege classique du service worker.
 *
 * Bumper SHELL_VERSION reste utile pour forcer un remplacement immediat et
 * atomique plutot qu'a retardement.
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
      staleWhileRevalidate(
        new Request("./index.html", { credentials: "same-origin" }),
        SHELL_CACHE,
      ).catch(() => fetch(request)),
    );
    return;
  }

  // Pochettes d'albums Spotify.
  if (url.hostname.endsWith("scdn.co")) {
    event.respondWith(staleWhileRevalidate(request, ART_CACHE, ART_MAX_ENTRIES));
    return;
  }

  // Reste du shell (js, css, icones, manifest).
  if (url.origin === location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});

/**
 * Sert la version en cache immediatement et rafraichit en arriere-plan.
 * @param {Request} request
 * @param {string} cacheName
 * @param {number} [maxEntries] si defini, eviction FIFO au-dela
 */
async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      // On ne stocke que les reponses exploitables : une reponse opaque
      // occupe de la place sans qu'on puisse verifier son statut.
      if (res.ok) {
        cache.put(request, res.clone()).then(() => {
          if (maxEntries) trimCache(cache, maxEntries);
        });
      }
      return res;
    })
    .catch(() => cached);

  // Si rien en cache, on attend le reseau. Sinon, reponse immediate et la
  // revalidation se poursuit sans bloquer.
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
