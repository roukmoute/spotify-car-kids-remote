/**
 * OAuth 2.0 Authorization Code + PKCE, 100 % cote navigateur.
 *
 * Pourquoi PKCE et pas le flow implicite : le flow implicite ne rend PAS de
 * refresh_token, donc il faudrait relogger toutes les heures — inacceptable
 * quand ce sont des enfants qui utilisent la tablette. PKCE rend un
 * refresh_token utilisable sans client_secret, donc sans backend.
 *
 * Point d'attention : chez Spotify, le refresh_token est ROTATIF. Chaque appel
 * a /api/token avec grant_type=refresh_token renvoie un NOUVEAU refresh_token
 * qu'il faut persister immediatement. Si on rate une rotation, la session est
 * morte et il faut relogger.
 */

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Marge avant expiration reelle, pour ne jamais envoyer un token perime. */
const EXPIRY_MARGIN_MS = 60_000;

export const SCOPES = [
  "user-read-playback-state", // GET /me/player, /me/player/devices
  "user-modify-playback-state", // play, pause, next, previous, transfer
  "user-read-currently-playing", // GET /me/player/currently-playing
  "playlist-read-private", // GET /me/playlists (playlists privees)
  "playlist-read-collaborative", // playlists collaboratives
].join(" ");

const K = {
  clientId: "scr.client_id",
  refresh: "scr.refresh_token",
  access: "scr.access_token",
  expiresAt: "scr.expires_at",
  verifier: "scr.pkce_verifier",
  state: "scr.oauth_state",
};

/* ------------------------------------------------------------------ */
/* Utilitaires PKCE                                                    */
/* ------------------------------------------------------------------ */

/** base64url sans padding, comme exige par la RFC 7636. */
function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(length = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64url(bytes).slice(0, 128); // RFC : 43..128 caracteres
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * L'URI de redirection doit correspondre EXACTEMENT (au caractere pres) a
 * celle declaree dans le dashboard Spotify. On la derive de l'URL courante en
 * retirant query et fragment, ce qui donne par ex. :
 *   https://roukmoute.github.io/spotify-car-kids-remote/
 * Le slash final compte : origin + pathname le garantit tant que le fichier
 * servi est bien index.html a la racine du sous-chemin.
 */
export function redirectUri() {
  return location.origin + location.pathname;
}

export function getClientId() {
  return localStorage.getItem(K.clientId) || "";
}

export function setClientId(id) {
  localStorage.setItem(K.clientId, id.trim());
}

export function clearConfig() {
  for (const key of Object.values(K)) localStorage.removeItem(key);
}

export function isLoggedIn() {
  return Boolean(localStorage.getItem(K.refresh));
}

/* ------------------------------------------------------------------ */
/* Etape 1 : redirection vers Spotify                                  */
/* ------------------------------------------------------------------ */

/**
 * Construit l'URL d'autorisation et persiste le verifier + le state.
 * Separee de la redirection pour rester verifiable sans quitter la page.
 * @returns {Promise<string>}
 */
export async function buildAuthorizeUrl() {
  const clientId = getClientId();
  if (!clientId) throw new Error("client_id manquant");

  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  // localStorage et pas sessionStorage : sur certains navigateurs Android en
  // mode standalone, la redirection externe puis le retour peuvent repartir
  // sur un nouveau contexte d'onglet, ce qui viderait sessionStorage.
  localStorage.setItem(K.verifier, verifier);
  localStorage.setItem(K.state, state);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });

  return `${AUTHORIZE_URL}?${params}`;
}

export async function beginLogin() {
  location.assign(await buildAuthorizeUrl());
}

/* ------------------------------------------------------------------ */
/* Etape 2 : retour de Spotify (?code=... ou ?error=...)               */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<"none"|"ok">} "none" si l'URL ne contient pas de retour
 *   OAuth. Jette une Error explicite si le retour est en erreur.
 */
export async function completeLoginFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  const state = params.get("state");

  if (!code && !error) return "none";

  const expectedState = localStorage.getItem(K.state);
  const verifier = localStorage.getItem(K.verifier);
  localStorage.removeItem(K.state);
  localStorage.removeItem(K.verifier);

  // Nettoie l'URL tout de suite : evite qu'un rechargement rejoue un code deja
  // consomme (les codes Spotify sont a usage unique).
  history.replaceState(null, "", redirectUri());

  if (error) {
    throw new Error(
      error === "access_denied"
        ? "Autorisation refusee sur Spotify."
        : `Spotify a renvoye une erreur : ${error}`,
    );
  }
  if (!expectedState || state !== expectedState) {
    throw new Error("Parametre state invalide (tentative de CSRF ?).");
  }
  if (!verifier) {
    throw new Error("Verifier PKCE introuvable. Relance la connexion.");
  }

  const token = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: getClientId(),
    code_verifier: verifier,
  });

  persist(token);
  return "ok";
}

/* ------------------------------------------------------------------ */
/* Etape 3 : obtention / rafraichissement du token d'acces             */
/* ------------------------------------------------------------------ */

let inFlightRefresh = null;

/**
 * Renvoie un access_token valide, en rafraichissant si besoin.
 * Les appels concurrents partagent le meme refresh en vol : sans ca, deux
 * requetes simultanees declencheraient deux rotations et l'une des deux
 * invaliderait l'autre.
 */
export async function getAccessToken() {
  const access = localStorage.getItem(K.access);
  const expiresAt = Number(localStorage.getItem(K.expiresAt) || 0);

  if (access && Date.now() < expiresAt - EXPIRY_MARGIN_MS) return access;

  if (!inFlightRefresh) {
    inFlightRefresh = refresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

async function refresh() {
  const refreshToken = localStorage.getItem(K.refresh);
  if (!refreshToken) throw new AuthExpiredError("Aucun refresh_token.");

  let token;
  try {
    token = await postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getClientId(),
    });
  } catch (err) {
    // invalid_grant = refresh_token revoque ou perime : session morte.
    if (err instanceof TokenError && err.code === "invalid_grant") {
      logout();
      throw new AuthExpiredError("Session Spotify expiree.");
    }
    throw err;
  }

  persist(token);
  return token.access_token;
}

async function postToken(body) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  } catch {
    throw new Error("Reseau indisponible.");
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new TokenError(
      data.error_description || data.error || `HTTP ${res.status}`,
      data.error || String(res.status),
    );
  }
  return data;
}

/**
 * Persiste le token. `refresh_token` n'est ecrase que s'il est present :
 * l'echange initial le renvoie toujours, le refresh le renvoie en rotation,
 * mais on se protege du cas ou une reponse l'omettrait — sinon on effacerait
 * la seule chose qui permet de rester connecte.
 */
function persist(token) {
  localStorage.setItem(K.access, token.access_token);
  localStorage.setItem(
    K.expiresAt,
    String(Date.now() + (token.expires_in ?? 3600) * 1000),
  );
  if (token.refresh_token) {
    localStorage.setItem(K.refresh, token.refresh_token);
  }
}

export function logout() {
  localStorage.removeItem(K.access);
  localStorage.removeItem(K.refresh);
  localStorage.removeItem(K.expiresAt);
}

/**
 * Jette l'access_token courant sans toucher au refresh_token.
 * Utilise quand l'API repond 401 alors qu'on croyait le token encore valide
 * (horloge locale decalee, token revoque cote Spotify) : le prochain
 * getAccessToken() declenchera un refresh.
 */
export function invalidateAccessToken() {
  localStorage.removeItem(K.access);
  localStorage.removeItem(K.expiresAt);
}

/* ------------------------------------------------------------------ */
/* Erreurs typees                                                      */
/* ------------------------------------------------------------------ */

export class TokenError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TokenError";
    this.code = code;
  }
}

/** Levee quand il faut renvoyer l'utilisateur sur l'ecran de connexion. */
export class AuthExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthExpiredError";
  }
}
