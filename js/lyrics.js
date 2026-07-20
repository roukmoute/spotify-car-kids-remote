/**
 * Paroles synchronisees via LRCLIB (https://lrclib.net).
 *
 * Pourquoi LRCLIB et pas Musixmatch : les paroles synchronisees de Musixmatch
 * (track.subtitle.get / track.richsync.get) ne sont PAS dans le plan
 * developpeur gratuit, il faut un contrat commercial. Et l'API Musixmatch
 * n'envoie pas d'en-tete CORS, donc elle imposerait un backend proxy juste
 * pour porter la cle. LRCLIB est gratuit, sans cle, et repond
 * `Access-Control-Allow-Origin: *` : appelable directement depuis le
 * navigateur. C'est ce qui permet a cette app de rester 100 % statique.
 *
 * Spotify n'expose aucun endpoint public de paroles : celui qu'utilise son
 * app officielle est prive et non documente. On ne s'appuie pas dessus.
 */

const BASE = "https://lrclib.net/api";

/* LRCLIB demande d'identifier le client dans le User-Agent. Le navigateur
   interdit de definir cet en-tete, donc on le passe en query param, ce que
   l'API accepte, et on reste identifiable. */
const CLIENT_TAG = "spotify-car-kids-remote v1 (https://github.com/roukmoute/spotify-car-kids-remote)";

const CACHE_KEY = "scr.lyrics_cache";
const CACHE_MAX = 120;

/* ------------------------------------------------------------------ */
/* Cache local                                                         */
/* ------------------------------------------------------------------ */

/**
 * Cache en localStorage, clef = id de piste Spotify.
 * Valeur = { lines, t } ou `lines` peut etre `null` (= "cherche, rien trouve"),
 * ce qui evite de retaper LRCLIB a chaque passage de la meme chanson.
 */
function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota depasse : on repart d'un cache vide plutot que de planter.
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* stockage indisponible : on continue sans cache */
    }
  }
}

function cacheGet(trackId) {
  const entry = readCache()[trackId];
  return entry ? entry.lines : undefined;
}

function cacheSet(trackId, lines) {
  const cache = readCache();
  cache[trackId] = { lines, t: Date.now() };

  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    // Eviction LRU : on jette le tiers le plus ancien d'un coup, pour ne pas
    // recrire tout le cache a chaque nouvelle chanson.
    keys
      .sort((a, b) => cache[a].t - cache[b].t)
      .slice(0, Math.ceil(CACHE_MAX / 3))
      .forEach((k) => delete cache[k]);
  }

  writeCache(cache);
}

export function clearLyricsCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* rien a faire */
  }
}

/* ------------------------------------------------------------------ */
/* Parsing LRC                                                         */
/* ------------------------------------------------------------------ */

/* [mm:ss.xx] ou [mm:ss.xxx] ou [mm:ss] ; une ligne peut porter plusieurs
   timestamps (refrain repete), d'ou le `g` et la boucle. */
const TS = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * @param {string} lrc
 * @returns {{timeMs: number, text: string}[]} trie par timeMs
 */
export function parseLrc(lrc) {
  if (!lrc) return [];

  const out = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    TS.lastIndex = 0;
    const stamps = [];
    let match;

    while ((match = TS.exec(rawLine)) !== null) {
      const [, mm, ss, frac] = match;
      // "5" -> 500ms, "50" -> 500ms, "500" -> 500ms : on normalise sur 3 chiffres.
      const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
      stamps.push(Number(mm) * 60_000 + Number(ss) * 1000 + ms);
    }

    if (!stamps.length) continue; // en-tete [ar:], [ti:], [length:]...

    const text = rawLine.replace(TS, "").trim();
    for (const timeMs of stamps) out.push({ timeMs, text });
  }

  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/* ------------------------------------------------------------------ */
/* Recuperation                                                        */
/* ------------------------------------------------------------------ */

async function lrclib(path, params) {
  const qs = new URLSearchParams({ ...params, client: CLIENT_TAG });
  const res = await fetch(`${BASE}${path}?${qs}`);

  if (res.status === 404) return null; // aucune correspondance : cas normal
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);

  return res.json();
}

/**
 * Cherche les paroles synchronisees d'une piste Spotify.
 *
 * @param {object} track  item Spotify (doit avoir id, name, artists, album, duration_ms)
 * @param {AbortSignal} [signal] non utilise pour l'instant, reserve
 * @returns {Promise<{timeMs:number,text:string}[]|null>}
 *   Un tableau de lignes, ou null si aucune parole synchronisee n'existe.
 */
export async function fetchLyrics(track) {
  if (!track?.id || !track.name) return null;

  const cached = cacheGet(track.id);
  if (cached !== undefined) return cached;

  const artist = track.artists?.[0]?.name ?? "";
  const album = track.album?.name ?? "";
  const durationSec = Math.round((track.duration_ms ?? 0) / 1000);

  let lines = null;

  try {
    // 1) Correspondance exacte. LRCLIB tolere ~2s d'ecart sur la duree.
    let hit = await lrclib("/get", {
      track_name: track.name,
      artist_name: artist,
      album_name: album,
      duration: String(durationSec),
    });

    // 2) Repli : recherche large. Utile quand le nom d'album differe
    //    (editions deluxe, compilations, remasters), cas tres frequent.
    if (!hit) {
      const results = await lrclib("/search", {
        track_name: track.name,
        artist_name: artist,
      });
      hit = pickBestMatch(results, durationSec);
    }

    if (hit && !hit.instrumental && hit.syncedLyrics) {
      const parsed = parseLrc(hit.syncedLyrics);
      if (parsed.length) lines = parsed;
    }
  } catch {
    // Panne reseau ou LRCLIB indisponible : on ne met PAS en cache, pour
    // retenter au prochain passage de la chanson.
    return null;
  }

  cacheSet(track.id, lines);
  return lines;
}

/**
 * Parmi les resultats de recherche, prend celui qui a des paroles
 * synchronisees et dont la duree colle le mieux. La duree est le meilleur
 * discriminant : elle elimine les live, remixes et versions radio.
 */
function pickBestMatch(results, durationSec) {
  if (!Array.isArray(results) || !results.length) return null;

  const usable = results.filter((r) => r.syncedLyrics && !r.instrumental);
  if (!usable.length) return null;

  let best = null;
  let bestDelta = Infinity;

  for (const r of usable) {
    const delta = Math.abs((r.duration ?? 0) - durationSec);
    if (delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }

  // Au-dela de 8s d'ecart, c'est probablement une autre version : mieux vaut
  // afficher "pas de paroles" que des paroles decalees de bout en bout.
  return bestDelta <= 8 ? best : null;
}
