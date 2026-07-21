/**
 * Service worker minimal.
 *
 * Strategie : RESEAU D'ABORD pour le shell, cache en secours.
 *
 * Le premier reflexe serait le cache-first, ou son cousin
 * stale-while-revalidate, pour un demarrage instantane. Les deux ont ete
 * essayes et abandonnes : ils servent par construction une version perimee, et
 * la moindre faille dans la revalidation laisse l'appareil bloque sur du vieux
 * code sans aucun signe exterieur — l'ecran s'affiche normalement, il est
 * simplement en retard. Sur une tablette posee dans une voiture, ce mode de
 * panne est invisible et donc particulierement penible.
 *
 * Le reseau d'abord est deterministe : ce qui est affiche est toujours ce qui
 * est deploye. Le cout reel est modeste — le shell fait ~30 Ko et l'app a de
 * toute facon besoin du reseau pour piloter Spotify. Et le cache continue de
 * jouer son role la ou il compte vraiment : tunnels, zones blanches, reseau
 * qui rame. Le delai d'attente evite d'y rester bloque.
 *
 * Les appels d'API ne sont jamais mis en cache.
 */

const SHELL_VERSION = "v2";
const SHELL_CACHE = `scr-shell-${SHELL_VERSION}`;
const ART_CACHE = "scr-art-v1";

/** Au-dela, on considere le reseau trop lent et on sert le cache. */
const NETWORK_TIMEOUT_MS = 2500;

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
  "./js/store.js",
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
    (async () => {
      const cache = await caches.open(SHELL_CACHE);

      // Volontairement PAS `cache.addAll` : celui-ci est atomique, donc une
      // seule requete qui echoue annule tout le pre-cache. Sur une tablette
      // partagee depuis un telephone en voiture, les echecs transitoires sont
      // la norme, et un cache partiel vaut mieux que pas de cache du tout.
      await Promise.allSettled(
        SHELL_ASSETS.map(async (asset) => {
          const res = await fetch(asset, { cache: "reload" });
          if (res.ok) await cache.put(asset, res);
        }),
      );

      await self.skipWaiting();
    })(),
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

  // Navigation (y compris le retour OAuth avec ?code=...). Les query params
  // restent lisibles cote JS via location.search, ils ne transitent pas par
  // la reponse, d'ou le repli sur index.html.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  // Pochettes d'albums : cache-first assume. Les URL Spotify sont adressees
  // par contenu, donc une entree en cache ne peut pas etre "perimee" — une
  // pochette differente aurait une URL differente.
  if (url.hostname.endsWith("scdn.co")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Reste du shell (js, css, icones, manifest).
  if (url.origin === location.origin) {
    event.respondWith(networkFirst(request));
  }
});

/**
 * Reseau d'abord, avec delai d'attente, puis cache.
 * @param {Request} request
 * @param {string} [cacheKey] entree a servir en secours (pour les navigations)
 */
async function networkFirst(request, cacheKey) {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (res.ok) {
      // Rafraichit le secours pour la prochaine coupure. On n'attend pas :
      // la reponse part immediatement vers la page.
      cache.put(cacheKey ?? request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    // Hors ligne, ou reseau trop lent : on sert ce qu'on a.
    const cached = await cache.match(cacheKey ?? request);
    if (cached) return cached;
    throw new Error("Ressource indisponible hors ligne");
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ART_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    await trimCache(cache, ART_MAX_ENTRIES);
  }
  return res;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout reseau")), ms),
    ),
  ]);
}

/** Eviction FIFO grossiere : l'ordre de keys() est l'ordre d'insertion. */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(
    keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)),
  );
}
