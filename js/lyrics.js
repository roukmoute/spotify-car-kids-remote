/**
 * Paroles via LRCLIB (https://lrclib.net).
 *
 * Pourquoi LRCLIB et pas Musixmatch : chez Musixmatch, les paroles
 * synchronisees sont derriere un plan payant (`track.subtitle.get` au plan
 * Grow, `track.richsync.get` au plan Enterprise) ; le palier gratuit ne donne
 * que des extraits sans aucun timing. En prime, l'API n'envoie pas d'en-tete
 * CORS en `format=json` et la cle transite en query param — il faudrait donc un
 * backend uniquement pour la porter. LRCLIB est gratuit, sans cle, et repond
 * `Access-Control-Allow-Origin: *` : c'est ce qui permet a cette app de rester
 * 100 % statique.
 *
 * Spotify n'expose aucun endpoint public de paroles ; celui qu'utilise son
 * application officielle est interne et exige un jeton de web player extrait a
 * la main, hors CGU. On ne s'appuie pas dessus.
 *
 * Cadre d'usage : affichage transitoire, prive et non commercial. La base est
 * communautaire et ne porte pas de licence sur le contenu — on affiche, on ne
 * redistribue pas.
 */

const BASE = "https://lrclib.net/api";

/* LRCLIB demande d'identifier le client. Le navigateur interdit de definir
   `User-Agent`, donc l'API accepte explicitement ces deux en-tetes a la place.
   Ils rendent la requete "non simple" : un preflight par origine a froid, que
   LRCLIB gere correctement. */
const CLIENT = "spotify-car-kids-remote v1 (https://github.com/roukmoute/spotify-car-kids-remote)";
const HEADERS = { "X-User-Agent": CLIENT, "Lrclib-Client": CLIENT };

/**
 * Cache : UNE CLEF PAR PISTE, plus un petit index pour l'eviction.
 *
 * La version precedente gardait tout dans une seule clef JSON. Mesure sur la
 * tablette cible (Android 7, SoC sc8830), cache plein de 120 titres soit
 * 574 Ko : 39 ms pour relire le blob, 80 ms pour le reecrire, soit 119 ms de
 * blocage du thread principal A CHAQUE changement de piste — localStorage
 * etant synchrone. Sept images perdues, juste au moment ou l'ecran doit se
 * rafraichir.
 *
 * Par clef, la meme operation coute 0,9 ms : 126 fois moins. L'index reste
 * minuscule (un horodatage par piste), donc sa relecture est gratuite.
 */
const KEY_PREFIX = "scr.lyr.";
const INDEX_KEY = "scr.lyr_index";
/** Ancienne clef monolithique, purgee au demarrage. */
const LEGACY_KEY = "scr.lyrics_cache";
const CACHE_MAX = 120;

/**
 * @typedef {{kind: "synced", lines: {timeMs: number, text: string}[]}
 *         | {kind: "plain", text: string}
 *         | {kind: "instrumental"}
 *         | null} LyricsResult
 */

/* ------------------------------------------------------------------ */
/* Cache local                                                         */
/* ------------------------------------------------------------------ */

/* L'ancien format monolithique occupait jusqu'a 574 Ko pour rien une fois la
   migration faite : on le purge des le chargement du module. */
try {
  localStorage.removeItem(LEGACY_KEY);
} catch {
  /* stockage indisponible */
}

/** Index { idPiste: horodatage }, uniquement pour l'eviction LRU. */
function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY)) || {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* voir cacheSet : gere par la purge */
  }
}

/** `undefined` = jamais cherche ; `null` = cherche, rien trouve. */
function cacheGet(trackId) {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + trackId);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function cacheSet(trackId, value) {
  const index = readIndex();

  try {
    localStorage.setItem(KEY_PREFIX + trackId, JSON.stringify(value));
  } catch {
    // Quota depasse : on libere la moitie du cache et on retente une fois.
    evict(index, Math.ceil(CACHE_MAX / 2));
    try {
      localStorage.setItem(KEY_PREFIX + trackId, JSON.stringify(value));
    } catch {
      return; // stockage sature ou indisponible : on continue sans cache
    }
  }

  index[trackId] = Date.now();

  // Eviction par lot : on jette le tiers le plus ancien d'un coup plutot que
  // une entree a chaque fois, pour amortir le cout.
  if (Object.keys(index).length > CACHE_MAX) {
    evict(index, Math.ceil(CACHE_MAX / 3));
  }

  writeIndex(index);
}

/** Supprime les `count` entrees les plus anciennes. Mute `index`. */
function evict(index, count) {
  const oldest = Object.keys(index)
    .sort((a, b) => index[a] - index[b])
    .slice(0, count);

  for (const id of oldest) {
    try {
      localStorage.removeItem(KEY_PREFIX + id);
    } catch {
      /* rien a faire */
    }
    delete index[id];
  }
}

export function clearLyricsCache() {
  try {
    for (const id of Object.keys(readIndex())) {
      localStorage.removeItem(KEY_PREFIX + id);
    }
    localStorage.removeItem(INDEX_KEY);
  } catch {
    /* rien a faire */
  }
}

/* ------------------------------------------------------------------ */
/* Parsing LRC                                                         */
/* ------------------------------------------------------------------ */

/* [mm:ss], [mm:ss.xx] ou [mm:ss.xxx]. Une meme ligne peut porter plusieurs
   timestamps (`[00:21.10][00:45.10]refrain`), d'ou le drapeau `g`. */
const TS = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Decalage global signe, en millisecondes : `[offset:+500]` / `[offset:-200]`. */
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * @param {string} lrc
 * @returns {{timeMs: number, text: string}[]} trie par timeMs croissant
 */
export function parseLrc(lrc) {
  if (!lrc) return [];

  // Un LRC peut porter un decalage global que le producteur a mesure ; ne pas
  // l'appliquer decale toutes les paroles de facon uniforme.
  const offsetMs = Number(lrc.match(OFFSET_TAG)?.[1] ?? 0);

  const out = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    TS.lastIndex = 0;
    const stamps = [];
    let match;

    while ((match = TS.exec(rawLine)) !== null) {
      const [, mm, ss, frac] = match;
      // "5" -> 500 ms, "50" -> 500 ms, "500" -> 500 ms : normalise sur 3 chiffres.
      const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
      stamps.push(Number(mm) * 60_000 + Number(ss) * 1000 + ms);
    }

    // Aucun timestamp : en-tete de metadonnees ([ti:], [ar:], [offset:]...).
    if (!stamps.length) continue;

    const text = rawLine.replace(TS, "").trim();
    // Les lignes vides horodatees sont des pauses instrumentales : on les garde,
    // elles donnent son rythme au defilement.
    for (const timeMs of stamps) {
      out.push({ timeMs: Math.max(0, timeMs + offsetMs), text });
    }
  }

  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/* ------------------------------------------------------------------ */
/* Appels reseau                                                       */
/* ------------------------------------------------------------------ */

async function lrclib(path, params) {
  const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
    headers: HEADERS,
  });

  // 404 = aucune correspondance. C'est un cas nominal, pas une panne.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);

  return res.json();
}

/**
 * Cherche les paroles d'une piste Spotify.
 *
 * Ordre de degradation : synchronisees -> texte simple -> instrumental -> rien.
 *
 * @param {object} track  item Spotify (id, name, artists, album, duration_ms)
 * @returns {Promise<LyricsResult>}
 */
export async function fetchLyrics(track) {
  if (!track?.id || !track.name) return null;

  const cached = cacheGet(track.id);
  if (cached !== undefined) return cached;

  const artist = track.artists?.[0]?.name ?? "";
  const album = track.album?.name ?? "";
  const durationSec = Math.round((track.duration_ms ?? 0) / 1000);

  let result = null;

  try {
    // 1) Correspondance exacte. LRCLIB n'accepte l'entree que si la duree
    //    correspond a +/- 2 s, ce qui ecarte d'emblee les mauvaises versions.
    let hit = await lrclib("/get", {
      track_name: track.name,
      artist_name: artist,
      album_name: album,
      duration: String(durationSec),
    });

    // 2) Repli en recherche large. Indispensable en pratique : remaster,
    //    live, radio edit, edition deluxe — le nom d'album ou la duree
    //    divergent et /get renvoie 404 alors que les paroles existent.
    if (!hit) {
      const results = await lrclib("/search", {
        track_name: track.name,
        artist_name: artist,
      });
      hit = pickBestMatch(results, durationSec);
    }

    result = toResult(hit);
  } catch {
    // Panne reseau ou LRCLIB indisponible : on ne met PAS en cache, pour
    // retenter au prochain passage de la chanson.
    return null;
  }

  cacheSet(track.id, result);
  return result;
}

/** @returns {LyricsResult} */
function toResult(hit) {
  if (!hit) return null;
  if (hit.instrumental) return { kind: "instrumental" };

  const lines = parseLrc(hit.syncedLyrics);
  if (lines.length) return { kind: "synced", lines };

  // Mieux vaut du texte fixe que rien : l'enfant suit avec le doigt.
  const plain = hit.plainLyrics?.trim();
  return plain ? { kind: "plain", text: plain } : null;
}

/**
 * Parmi les resultats de recherche, retient celui dont la duree colle le mieux.
 * La duree est le meilleur discriminant : elle ecarte live, remixes et
 * versions radio, qui portent souvent le meme titre et le meme artiste.
 *
 * Note : /search renvoie `200` avec un tableau vide quand rien ne correspond
 * (et non un 4xx), d'ou le test sur le contenu et pas sur le statut.
 */
function pickBestMatch(results, durationSec) {
  if (!Array.isArray(results) || !results.length) return null;

  // Environ 40 % des resultats de recherche n'ont pas de version synchronisee.
  const synced = results.filter((r) => r.syncedLyrics && !r.instrumental);
  const pool = synced.length ? synced : results.filter((r) => r.plainLyrics);
  if (!pool.length) return null;

  let best = null;
  let bestDelta = Infinity;

  for (const r of pool) {
    const delta = Math.abs((r.duration ?? 0) - durationSec);
    if (delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }

  // Au-dela de 8 s d'ecart, c'est une autre version : mieux vaut afficher
  // "pas de paroles" que des paroles decalees de bout en bout.
  return bestDelta <= 8 ? best : null;
}
