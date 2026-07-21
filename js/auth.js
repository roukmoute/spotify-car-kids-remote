/**
 * OAuth 2.0 Authorization Code + PKCE, 100 % cote navigateur, MULTI-COMPTES.
 *
 * Pourquoi PKCE et pas le flow implicite : le flow implicite ne rend PAS de
 * refresh_token, donc il faudrait relogger toutes les heures — inacceptable
 * quand ce sont des enfants qui utilisent la tablette. PKCE rend un
 * refresh_token utilisable sans client_secret, donc sans backend.
 *
 * Multi-comptes : rien dans le modele Spotify n'empeche de detenir des
 * refresh_token valides pour plusieurs utilisateurs d'un meme client_id. On
 * en garde donc un par personne, et basculer de l'un a l'autre ne demande
 * aucune ressaisie.
 *
 * Point d'attention : le refresh_token est ROTATIF. Chaque appel a /api/token
 * avec grant_type=refresh_token renvoie un NOUVEAU refresh_token qu'il faut
 * persister immediatement. Rater une rotation tue la session du compte.
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
  accounts: "scr.accounts", // { id: { name, image, refresh } }
  active: "scr.active", // id du compte courant
  token: (id) => `scr.tok.${id}`, // { access, expires } — volatil
  verifier: "scr.pkce_verifier",
  state: "scr.oauth_state",
};

/** Emplacement temporaire, entre l'echange du code et l'identification. */
const PENDING = "__pending";

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
/* Stockage                                                            */
/* ------------------------------------------------------------------ */

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage sature ou indisponible */
  }
}

/**
 * Les comptes tiennent dans une seule clef, contrairement aux paroles : ils
 * sont deux ou trois et pesent quelques centaines d'octets. Le jeton d'acces,
 * lui, change toutes les heures et vit dans sa propre clef.
 */
function readAccounts() {
  return readJson(K.accounts, {});
}

function writeAccounts(accounts) {
  writeJson(K.accounts, accounts);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * L'URI de redirection doit correspondre EXACTEMENT (au caractere pres) a
 * celle declaree dans le dashboard Spotify.
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
  for (const id of Object.keys(readAccounts())) {
    localStorage.removeItem(K.token(id));
  }
  localStorage.removeItem(K.token(PENDING));
  for (const key of [K.clientId, K.accounts, K.active, K.verifier, K.state]) {
    localStorage.removeItem(key);
  }
}

/* ------------------------------------------------------------------ */
/* Comptes                                                             */
/* ------------------------------------------------------------------ */

/** @returns {{id:string, name:string, image:string|null, active:boolean}[]} */
export function listAccounts() {
  const accounts = readAccounts();
  const active = activeAccountId();
  return Object.entries(accounts)
    .filter(([id]) => id !== PENDING)
    .map(([id, a]) => ({
      id,
      name: a.name || id,
      image: a.image ?? null,
      active: id === active,
    }));
}

export function activeAccountId() {
  return localStorage.getItem(K.active) || "";
}

export function getActiveAccount() {
  const id = activeAccountId();
  const account = readAccounts()[id];
  return account ? { id, name: account.name || id, image: account.image ?? null } : null;
}

export function isLoggedIn() {
  const id = activeAccountId();
  return Boolean(id && readAccounts()[id]?.refresh);
}

/**
 * Bascule sur un autre compte deja connecte. Aucune ressaisie : son
 * refresh_token est deja en memoire.
 */
export function switchAccount(id) {
  if (!readAccounts()[id]) throw new Error("Compte inconnu");
  localStorage.setItem(K.active, id);
  inFlightRefresh = null; // un refresh en vol appartenait a l'ancien compte
}

export function removeAccount(id) {
  const accounts = readAccounts();
  delete accounts[id];
  writeAccounts(accounts);
  localStorage.removeItem(K.token(id));

  if (activeAccountId() === id) {
    const next = Object.keys(accounts).filter((k) => k !== PENDING)[0];
    if (next) localStorage.setItem(K.active, next);
    else localStorage.removeItem(K.active);
    inFlightRefresh = null;
  }
}

/**
 * Termine l'ajout d'un compte : deplace les jetons de l'emplacement temporaire
 * vers l'identite reelle. Appele une fois le profil recupere.
 * @param {{id:string, display_name?:string, images?:{url:string}[]}} profile
 */
export function finalizePendingAccount(profile) {
  const accounts = readAccounts();
  const pending = accounts[PENDING];
  if (!pending) return null;

  // `account_id` plutot que `id` : Spotify le decrit comme immuable et
  // recommande explicitement de s'en servir pour lier un compte, `id`
  // n'etant pas garanti stable dans le temps. Repli sur `id` pour les
  // reponses anterieures a son introduction.
  const id = profile.account_id || profile.id;
  const known = Boolean(accounts[id]);

  accounts[id] = {
    // `display_name` peut etre absent selon les scopes accordes : on retombe
    // sur l'identifiant, qui est toujours present.
    name: profile.display_name || accounts[id]?.name || id,
    image: profile.images?.[0]?.url ?? accounts[id]?.image ?? null,
    refresh: pending.refresh,
  };
  delete accounts[PENDING];
  writeAccounts(accounts);

  // Transfere le jeton d'acces deja obtenu, pour ne pas refaire un aller-retour.
  const tok = readJson(K.token(PENDING), null);
  if (tok) writeJson(K.token(id), tok);
  localStorage.removeItem(K.token(PENDING));

  localStorage.setItem(K.active, id);
  // `known` signale une RE-autorisation du meme compte plutot qu'un ajout :
  // Spotify n'ayant pas de selecteur de compte, c'est le cas le plus frequent
  // quand on croit en ajouter un second.
  return { id, known };
}

/** Abandonne un ajout de compte qui s'est revele inutilisable. */
export function discardPendingAccount() {
  const accounts = readAccounts();
  delete accounts[PENDING];
  writeAccounts(accounts);
  localStorage.removeItem(K.token(PENDING));

  const next = Object.keys(accounts)[0];
  if (next) localStorage.setItem(K.active, next);
  else localStorage.removeItem(K.active);
  inFlightRefresh = null;
}

/** Un ajout de compte est-il en attente d'identification ? */
export function hasPendingAccount() {
  return Boolean(readAccounts()[PENDING]);
}

/* ------------------------------------------------------------------ */
/* Etape 1 : redirection vers Spotify                                  */
/* ------------------------------------------------------------------ */

/**
 * Construit l'URL d'autorisation et persiste le verifier + le state.
 * Separee de la redirection pour rester verifiable sans quitter la page.
 *
 * @param {{chooseAccount?: boolean}} [options] `chooseAccount` force Spotify a
 *   reafficher son ecran d'autorisation au lieu de reutiliser silencieusement
 *   la session web en cours — indispensable pour ajouter une DEUXIEME
 *   personne, sinon on re-autoriserait le premier compte sans s'en rendre
 *   compte.
 * @returns {Promise<string>}
 */
export async function buildAuthorizeUrl({ chooseAccount = false } = {}) {
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
  if (chooseAccount) params.set("show_dialog", "true");

  return `${AUTHORIZE_URL}?${params}`;
}

export async function beginLogin(options) {
  location.assign(await buildAuthorizeUrl(options));
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

  // Les jetons atterrissent d'abord dans l'emplacement temporaire : on ne sait
  // pas encore A QUI ils appartiennent. `finalizePendingAccount` les rangera
  // sous la bonne identite, sans ecraser un compte deja enregistre.
  const accounts = readAccounts();
  accounts[PENDING] = { name: "", image: null, refresh: token.refresh_token };
  writeAccounts(accounts);
  writeJson(K.token(PENDING), {
    access: token.access_token,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
  });
  localStorage.setItem(K.active, PENDING);

  return "ok";
}

/* ------------------------------------------------------------------ */
/* Etape 3 : obtention / rafraichissement du token d'acces             */
/* ------------------------------------------------------------------ */

let inFlightRefresh = null;

/**
 * Renvoie un access_token valide pour le compte ACTIF, en rafraichissant si
 * besoin. Les appels concurrents partagent le meme refresh en vol : sans ca,
 * deux requetes simultanees declencheraient deux rotations et l'une des deux
 * invaliderait l'autre.
 */
export async function getAccessToken() {
  const id = activeAccountId();
  if (!id) throw new AuthExpiredError("Aucun compte actif.");

  const tok = readJson(K.token(id), null);
  if (tok?.access && Date.now() < tok.expires - EXPIRY_MARGIN_MS) return tok.access;

  if (!inFlightRefresh) {
    inFlightRefresh = refresh(id).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

async function refresh(id) {
  const accounts = readAccounts();
  const refreshToken = accounts[id]?.refresh;
  if (!refreshToken) throw new AuthExpiredError("Aucun refresh_token.");

  let token;
  try {
    token = await postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getClientId(),
    });
  } catch (err) {
    // invalid_grant = refresh_token revoque ou perime : session morte pour CE
    // compte seulement. Les autres restent intacts.
    if (err instanceof TokenError && err.code === "invalid_grant") {
      logout();
      throw new AuthExpiredError("Session Spotify expiree.");
    }
    throw err;
  }

  // Rotation : le nouveau refresh_token n'est pas toujours renvoye, on ne
  // remplace donc l'ancien que s'il est present — sinon on effacerait la
  // seule chose qui permet de rester connecte.
  if (token.refresh_token) {
    const fresh = readAccounts();
    if (fresh[id]) {
      fresh[id].refresh = token.refresh_token;
      writeAccounts(fresh);
    }
  }

  writeJson(K.token(id), {
    access: token.access_token,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
  });

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

/** Deconnecte le compte ACTIF uniquement. Les autres restent utilisables. */
export function logout() {
  const id = activeAccountId();
  if (id) removeAccount(id);
}

/**
 * Jette le jeton d'acces courant sans toucher au refresh_token.
 * Utilise quand l'API repond 401 alors qu'on croyait le token encore valide.
 */
export function invalidateAccessToken() {
  const id = activeAccountId();
  if (id) localStorage.removeItem(K.token(id));
}

/* ------------------------------------------------------------------ */
/* Migration depuis l'ancien format mono-compte                        */
/* ------------------------------------------------------------------ */

(function migrateLegacy() {
  const legacyRefresh = localStorage.getItem("scr.refresh_token");
  if (!legacyRefresh || Object.keys(readAccounts()).length) return;

  // On ne connait pas encore l'identite : l'emplacement temporaire sera
  // resolu au premier appel de profil, sans reconnexion.
  const accounts = { [PENDING]: { name: "", image: null, refresh: legacyRefresh } };
  writeAccounts(accounts);
  localStorage.setItem(K.active, PENDING);

  const access = localStorage.getItem("scr.access_token");
  const expires = Number(localStorage.getItem("scr.expires_at") || 0);
  if (access && expires) writeJson(K.token(PENDING), { access, expires });

  for (const k of ["scr.refresh_token", "scr.access_token", "scr.expires_at"]) {
    localStorage.removeItem(k);
  }
})();

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
