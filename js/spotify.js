/**
 * Client Spotify Web API, reduit aux seuls endpoints dont l'app a besoin.
 *
 * Toutes les requetes passent par `api()`, qui centralise les trois choses qui
 * font echouer ce genre d'app en conditions reelles :
 *   - 401 : token perime -> on rafraichit et on rejoue UNE fois
 *   - 429 : rate limit -> on respecte Retry-After (Spotify le renvoie en
 *           secondes) plutot que de marteler
 *   - 204 : "rien en cours / aucun appareil actif" -> corps vide, il ne faut
 *           surtout pas tenter un res.json()
 */

import { getAccessToken, invalidateAccessToken, AuthExpiredError } from "./auth.js";

const BASE = "https://api.spotify.com/v1";

export class SpotifyError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.name = "SpotifyError";
    this.status = status;
    this.reason = reason; // ex. "NO_ACTIVE_DEVICE", "PREMIUM_REQUIRED"
  }
}

/* ------------------------------------------------------------------ */
/* Limitation de debit                                                 */
/* ------------------------------------------------------------------ */

/**
 * Spotify renvoie bien un en-tete `Retry-After` sur 429, mais il est
 * ILLISIBLE depuis un navigateur : l'API n'envoie pas
 * `Access-Control-Expose-Headers`, et `Retry-After` ne fait pas partie des
 * en-tetes exposes par defaut. `res.headers.get("Retry-After")` renvoie donc
 * toujours `null`. On applique un backoff aveugle.
 *
 * Le quota est compte PAR APPLICATION (fenetre glissante de 30 s), pas par
 * utilisateur : une fois limite, il faut vraiment lever le pied.
 */
const BACKOFF_STEPS_MS = [5_000, 15_000, 60_000, 300_000];
const BACKOFF_KEY = "scr.rate_limited_until";

let backoffStep = 0;

function rateLimitedUntil() {
  return Number(localStorage.getItem(BACKOFF_KEY) || 0);
}

/**
 * Persiste la penalite : sans ca, un simple rechargement de page relancerait
 * les requetes immediatement et prolongerait la limitation.
 */
function enterBackoff() {
  const wait = BACKOFF_STEPS_MS[Math.min(backoffStep, BACKOFF_STEPS_MS.length - 1)];
  backoffStep += 1;
  localStorage.setItem(BACKOFF_KEY, String(Date.now() + wait));
  return wait;
}

function clearBackoff() {
  if (backoffStep === 0 && !rateLimitedUntil()) return;
  backoffStep = 0;
  localStorage.removeItem(BACKOFF_KEY);
}

/**
 * @param {string} path      chemin relatif a /v1, ex. "/me/player/play"
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body]     serialise en JSON si present
 * @param {object} [options.query]    paires ajoutees en query string
 * @param {boolean} [options.retried] usage interne
 */
async function api(path, options = {}) {
  const { method = "GET", body, query, retried = false } = options;

  // Encore sous penalite : on echoue tout de suite sans consommer de quota.
  const until = rateLimitedUntil();
  if (Date.now() < until) {
    throw new SpotifyError(
      `Spotify limite les requetes, reprise dans ${Math.ceil((until - Date.now()) / 1000)} s.`,
      429,
      "RATE_LIMITED",
    );
  }

  const token = await getAccessToken();

  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null),
    );
    if (String(qs)) url += `?${qs}`;
  }

  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SpotifyError("Reseau indisponible.", 0, "NETWORK");
  }

  // 204 No Content : reponse legitime et frequente (aucun appareil actif,
  // ou commande acceptee sans corps de reponse).
  if (res.status === 204) {
    clearBackoff();
    return null;
  }

  if (res.ok) {
    clearBackoff();
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* ---------------- Gestion des erreurs ---------------- */

  if (res.status === 401 && !retried) {
    // Le token a expire entre le check local et l'appel : on force un refresh
    // en invalidant l'access token courant, puis on rejoue une seule fois.
    invalidateAccessToken();
    return api(path, { ...options, retried: true });
  }

  if (res.status === 401) {
    throw new AuthExpiredError("Session Spotify expiree.");
  }

  if (res.status === 429) {
    const wait = enterBackoff();
    throw new SpotifyError(
      `Trop de requetes, pause de ${Math.round(wait / 1000)} s.`,
      429,
      "RATE_LIMITED",
    );
  }

  const payload = await res.json().catch(() => ({}));
  const detail = payload?.error?.message || `HTTP ${res.status}`;

  if (res.status === 403) {
    // Spotify renvoie 403 pour trois cas tres differents : compte non-Premium,
    // compte non autorise sur l'app en mode developpement, et action interdite
    // dans le contexte courant (ex. "precedent" en debut de file d'attente).
    //
    // Le champ `reason` n'est pas contractuel — la doc de l'objet d'erreur ne
    // documente que `status` et `message` — donc on teste les deux.
    const isPremium =
      payload?.error?.reason === "PREMIUM_REQUIRED" || /premium/i.test(detail);

    throw new SpotifyError(
      isPremium
        ? "Cette action necessite un compte Spotify Premium."
        : `Action refusee par Spotify : ${detail}`,
      403,
      isPremium ? "PREMIUM_REQUIRED" : "RESTRICTED",
    );
  }

  if (res.status === 404) {
    // Sur les endpoints /me/player/*, un 404 signifie presque toujours
    // "aucun appareil actif" plutot qu'une URL erronee.
    throw new SpotifyError(
      "Aucun appareil Spotify actif. Lance la musique sur le telephone.",
      404,
      "NO_ACTIVE_DEVICE",
    );
  }

  throw new SpotifyError(detail, res.status, "UNKNOWN");
}

/* ------------------------------------------------------------------ */
/* Lecture d'etat                                                      */
/* ------------------------------------------------------------------ */

/**
 * Etat complet du lecteur. Renvoie null si aucun appareil n'est actif
 * (Spotify repond 204 dans ce cas).
 *
 * `additional_types=track,episode` evite que les podcasts remontent avec un
 * item null, ce qui casserait l'affichage.
 */
export function getPlayerState() {
  return api("/me/player", {
    query: { additional_types: "track,episode", market: "from_token" },
  });
}

/** Liste des appareils Spotify Connect visibles par le compte. */
export async function getDevices() {
  const data = await api("/me/player/devices");
  return data?.devices ?? [];
}

/**
 * Playlists de l'utilisateur. 50 est le maximum accepte par l'API ;
 * on pagine jusqu'a `max` pour eviter une grille interminable sur la tablette.
 */
export async function getPlaylists(max = 100) {
  const out = [];
  let offset = 0;

  while (out.length < max) {
    const page = await api("/me/playlists", { query: { limit: 50, offset } });
    const items = page?.items ?? [];
    out.push(...items.filter(Boolean));
    if (items.length < 50 || !page?.next) break;
    offset += 50;
  }

  return out.slice(0, max).map((p) => ({
    id: p.id,
    uri: p.uri,
    name: p.name,
    // images peut etre null ou vide (playlist sans pochette) ; on prend la
    // plus petite image >= 200px pour limiter le cout de decodage.
    image: pickImage(p.images, 300),
  }));
}

/**
 * Metadonnees d'une playlist par son id. Sert quand la lecture vient d'une
 * playlist absente de la liste de l'utilisateur (playlist partagee par
 * quelqu'un d'autre) : sans ca, impossible d'afficher son nom.
 */
export async function getPlaylist(playlistId) {
  const p = await api(`/playlists/${playlistId}`, {
    query: { fields: "id,uri,name,images" },
  });
  if (!p) return null;
  return {
    id: p.id,
    uri: p.uri,
    name: p.name,
    image: pickImage(p.images, 300),
  };
}

/**
 * Titres d'une playlist.
 *
 * Le parametre `fields` n'est pas une coquetterie : sans lui, chaque piste
 * renvoie une centaine de champs (marches disponibles, ids externes, objet
 * album complet...). Sur une playlist de 200 titres ca represente plusieurs
 * mega-octets a parser sur le thread principal de la tablette.
 *
 * @param {string} playlistId
 * @param {number} [max] plafond, pour ne pas rendre une liste interminable
 */
export async function getPlaylistTracks(playlistId, max = 200) {
  const fields =
    "next,items(is_local,track(id,uri,name,duration_ms,artists(name),album(images(url,width))))";

  const out = [];
  let offset = 0;

  while (out.length < max) {
    const page = await api(`/playlists/${playlistId}/tracks`, {
      query: { limit: 50, offset, fields, additional_types: "track" },
    });

    const items = page?.items ?? [];
    for (const item of items) {
      const t = item?.track;
      // `track` peut etre null (piste retiree du catalogue) et les fichiers
      // locaux n'ont pas d'URI jouable a distance : les deux casseraient la
      // lecture s'ils etaient proposes.
      if (!t?.uri || !t.id || item.is_local) continue;
      out.push({
        id: t.id,
        uri: t.uri,
        name: t.name,
        artist: t.artists?.map((a) => a.name).join(", ") ?? "",
        image: pickImage(t.album?.images, 200),
      });
    }

    if (items.length < 50 || !page?.next) break;
    offset += 50;
  }

  return out.slice(0, max);
}

/**
 * Lance une piste precise EN CONSERVANT le contexte de la playlist, pour que
 * "suivant" enchaine sur la suite de la playlist et non sur le neant.
 *
 * `offset` n'est accepte qu'accompagne de `context_uri`, et uniquement pour un
 * album ou une playlist. `context_uri` et `uris` sont mutuellement exclusifs.
 */
export function playTrackInContext(contextUri, trackUri, deviceId) {
  return api("/me/player/play", {
    method: "PUT",
    query: { device_id: deviceId },
    body: { context_uri: contextUri, offset: { uri: trackUri } },
  });
}

/** Choisit l'image la plus proche de `target` px sans descendre en dessous. */
function pickImage(images, target) {
  if (!images?.length) return null;
  const sized = images.filter((i) => i.width);
  if (!sized.length) return images[0].url;
  const big = sized.filter((i) => i.width >= target);
  const pool = big.length ? big : sized;
  return pool.reduce((a, b) => (a.width <= b.width ? a : b)).url;
}

/* ------------------------------------------------------------------ */
/* Commandes de lecture                                                */
/* ------------------------------------------------------------------ */

export function play(deviceId) {
  return api("/me/player/play", { method: "PUT", query: { device_id: deviceId } });
}

export function pause(deviceId) {
  return api("/me/player/pause", { method: "PUT", query: { device_id: deviceId } });
}

export function next(deviceId) {
  return api("/me/player/next", { method: "POST", query: { device_id: deviceId } });
}

export function previous(deviceId) {
  return api("/me/player/previous", { method: "POST", query: { device_id: deviceId } });
}

/**
 * Demarre une playlist (ou tout autre contexte : album, artiste).
 * `context_uri` va dans le CORPS, pas dans la query — erreur classique.
 */
export function playContext(contextUri, deviceId, { shuffle = false } = {}) {
  return (async () => {
    if (shuffle) {
      // L'ordre compte : activer le shuffle AVANT de lancer le contexte, sinon
      // la premiere piste est toujours la meme.
      await api("/me/player/shuffle", {
        method: "PUT",
        query: { state: "true", device_id: deviceId },
      }).catch(() => {}); // non bloquant : le shuffle est un confort
    }
    return api("/me/player/play", {
      method: "PUT",
      query: { device_id: deviceId },
      body: { context_uri: contextUri },
    });
  })();
}

/**
 * Bascule la lecture sur un appareil.
 * @param {boolean} startPlaying true = enchaine directement sur la lecture
 */
export function transferPlayback(deviceId, startPlaying = true) {
  return api("/me/player", {
    method: "PUT",
    body: { device_ids: [deviceId], play: startPlaying },
  });
}
