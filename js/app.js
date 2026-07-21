/**
 * Orchestrateur : boucle d'etat, gestion des commandes, cycle de vie.
 *
 * Principe de la boucle : on interroge Spotify peu souvent (toutes les 5 s en
 * lecture) et on INTERPOLE la position localement entre deux appels. C'est ce
 * qui permet des paroles fluides sans marteler l'API — un sondage a 200 ms
 * ferait ~18 000 requetes sur un trajet d'une heure et finirait en 429.
 */

import * as auth from "./auth.js";
import * as api from "./spotify.js";
import { fetchLyrics } from "./lyrics.js";
import * as store from "./store.js";
import * as ui from "./ui.js";

/* ------------------------------------------------------------------ */
/* Reglages                                                            */
/* ------------------------------------------------------------------ */

const POLL_PLAYING_MS = 5_000;
const POLL_PAUSED_MS = 20_000;
/** Sondage rapide juste apres une commande, le temps que Spotify propage. */
const POLL_AFTER_COMMAND_MS = 700;
/**
 * Nombre de 204 consecutifs avant de declarer qu'il n'y a plus rien en cours.
 * Spotify renvoie des 204 parasites alors que la musique joue (application en
 * arriere-plan sur le telephone, transition entre deux pistes) : reagir au
 * premier ferait clignoter l'ecran en "Rien en cours".
 */
const EMPTY_STATES_BEFORE_IDLE = 3;
/**
 * L'ordre d'execution n'est pas garanti entre deux appels Player. Apres un
 * transfert d'appareil, il faut laisser Spotify propager avant d'enchainer.
 */
const TRANSFER_SETTLE_MS = 400;
/** Cadence de rafraichissement des paroles (pas d'appel reseau). */
const LYRICS_TICK_MS = 200;
/**
 * Avance appliquee aux paroles. La chaine tablette -> API -> telephone
 * introduit un retard perceptible ; afficher la ligne legerement en avance
 * donne l'impression d'etre synchro plutot qu'a la traine.
 */
const LYRICS_LEAD_MS = 350;

/* ------------------------------------------------------------------ */
/* Etat local                                                          */
/* ------------------------------------------------------------------ */

const state = {
  /** Derniere reponse /me/player. */
  player: null,
  /**
   * Ancre de l'horloge locale, en `performance.now()` et non `Date.now()` :
   * monotone, donc insensible a un recalage d'horloge systeme (frequent sur
   * une tablette bas de gamme qui resynchronise via NTP en route).
   */
  syncedAt: 0,
  positionMs: 0,
  isPlaying: false,
  trackId: null,
  deviceId: null,
  /** Empeche deux commandes concurrentes de se marcher dessus. */
  busy: false,
  /** Compteur de 204 consecutifs (voir EMPTY_STATES_BEFORE_IDLE). */
  emptyStates: 0,
  /** URI du contexte de lecture (playlist, album...), pour detecter un changement. */
  contextUri: null,
};

let pollTimer = null;
let lyricsTimer = null;
let wakeLock = null;

/* ------------------------------------------------------------------ */
/* Amorcage                                                            */
/* ------------------------------------------------------------------ */

boot();

async function boot() {
  registerServiceWorker();
  wireEvents();

  if (!auth.getClientId()) {
    showSetup();
    return;
  }

  try {
    // Retour de redirection OAuth ? (?code=... ou ?error=...)
    const result = await auth.completeLoginFromUrl();
    if (result === "none" && !auth.isLoggedIn()) {
      ui.showView("login");
      return;
    }
  } catch (err) {
    ui.showError(err.message, { title: "Connexion echouee", actionLabel: "Reessayer" });
    ui.els.errorAction.onclick = () => auth.beginLogin();
    return;
  }

  start();
}

function showSetup() {
  ui.showView("setup");
  const hint = document.getElementById("setup-redirect");
  hint.textContent = `URI de redirection a declarer dans le dashboard Spotify : ${auth.redirectUri()}`;
  hint.classList.remove("hidden");
  document.getElementById("client-id-input").value = auth.getClientId();
}

/**
 * L'URI de redirection depend de l'URL d'ou l'app est servie : elle differe
 * entre le poste de dev et GitHub Pages, et les deux doivent etre declarees.
 * On l'affiche sur l'ecran de connexion parce que c'est la qu'on se trouve
 * quand Spotify refuse la redirection — l'ecran de setup est deja passe.
 */
function showRedirectHint() {
  const el = document.getElementById("login-redirect");
  if (el) el.textContent = auth.redirectUri();
}

/* ------------------------------------------------------------------ */
/* Comptes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resout l'identite du compte actif si elle est encore inconnue.
 *
 * C'est le cas juste apres une connexion — on detient les jetons sans savoir
 * a qui ils appartiennent — et lors de la migration depuis l'ancien format
 * mono-compte, ou la session existante n'avait pas d'identite attachee.
 */
async function ensureAccountIdentity() {
  if (!auth.hasPendingAccount()) return;

  let me;
  try {
    me = await api.getMe();
  } catch (err) {
    // Piege majeur du mode developpement : pour un compte absent de la liste
    // du dashboard, l'autorisation OAuth REUSSIT — jetons valides compris — et
    // l'echec n'apparait qu'ici. Sans ce controle, l'application afficherait
    // un compte "connecte" qui echoue ensuite sur chaque appel.
    if (err?.reason === "NOT_REGISTERED") {
      auth.discardPendingAccount();
      ui.showError(
        "Ce compte Spotify n'est pas autorise sur l'application. Ajoute son adresse " +
          "e-mail Spotify dans le dashboard developpeur, rubrique User Management.",
        { title: "Compte non autorise", actionLabel: "Retour" },
      );
      ui.els.errorAction.onclick = () => location.reload();
      return;
    }
    // Autre panne (reseau) : la session reste utilisable, on reessaiera au
    // prochain demarrage.
    handleError(err, { silent: true });
    return;
  }

  if (!me?.id) return;
  const result = auth.finalizePendingAccount(me);

  // Spotify n'a pas de selecteur de compte : si la session web etait deja
  // ouverte, on vient de re-autoriser la MEME personne en croyant en ajouter
  // une autre. Il faut le dire, sinon l'utilisateur cherche longtemps.
  if (result?.known) {
    ui.toast("Ce compte etait deja connecte. Utilise une fenetre privee pour en ajouter un autre.", 6000);
  }
}

function renderAccountsView() {
  ui.renderActiveAccount(auth.getActiveAccount());
  ui.renderAccounts(auth.listAccounts(), {
    onSwitch: switchToAccount,
    onRemove: removeAccountAndRefresh,
  });
}

/** Bascule de compte : aucune reconnexion, le jeton de l'autre est deja la. */
async function switchToAccount(id) {
  if (id === auth.activeAccountId()) {
    ui.showView("playlists");
    return;
  }

  auth.switchAccount(id);

  // Tout ce qui est affiche appartient a l'ancien compte : etat du lecteur,
  // playlists, titres. On repart d'une page blanche plutot que de melanger.
  resetForAccountChange();
  ui.showView("player");

  await tick();
  scheduleNextPoll();
  loadPlaylists();
  renderAccountsView();
}

function removeAccountAndRefresh(id) {
  const wasActive = id === auth.activeAccountId();
  auth.removeAccount(id);

  if (!auth.isLoggedIn()) {
    stopTimers();
    ui.showView("login");
    return;
  }

  if (wasActive) {
    resetForAccountChange();
    tick().then(() => scheduleNextPoll());
    loadPlaylists();
  }
  renderAccountsView();
}

/** Efface tout ce qui est propre a un compte donne. */
function resetForAccountChange() {
  playlistById.clear();
  viewedPlaylist = null;
  state.player = null;
  state.trackId = null;
  state.contextUri = null;
  state.deviceId = null;
  state.emptyStates = 0;
  ui.renderTrack(null);
  ui.renderContext(null);
  ui.clearLyrics("Chargement...");
  ui.renderPlaylists([], () => {});
}

async function start() {
  ui.showView("player");
  await ensureAccountIdentity();
  renderAccountsView();
  await tick(); // premier etat immediat, sans attendre le timer
  scheduleNextPoll();
  startLyricsTicker();
  loadPlaylists();
}

/* ------------------------------------------------------------------ */
/* Boucle d'etat                                                       */
/* ------------------------------------------------------------------ */

function scheduleNextPoll(delay) {
  clearTimeout(pollTimer);
  const ms = delay ?? (state.isPlaying ? POLL_PLAYING_MS : POLL_PAUSED_MS);
  pollTimer = setTimeout(async () => {
    await tick();
    scheduleNextPoll();
  }, ms);
}

async function tick() {
  // Inutile de consommer du quota quand l'ecran est eteint ou l'app en fond.
  if (document.hidden) return;

  let player;
  try {
    player = await api.getPlayerState();
  } catch (err) {
    handleError(err, { silent: true });
    return;
  }

  applyPlayerState(player);
}

function applyPlayerState(player) {
  if (!player) {
    // 204 : possiblement "aucun appareil actif", possiblement un faux negatif.
    // On ne vide l'ecran qu'apres plusieurs reponses vides d'affilee.
    state.emptyStates += 1;
    if (state.emptyStates < EMPTY_STATES_BEFORE_IDLE) return;

    state.player = null;
    state.isPlaying = false;
    state.positionMs = 0;
    state.contextUri = null;
    if (ui.renderTrack(null)) ui.clearLyrics("Lance la musique sur le telephone");
    ui.renderPlayback({ isPlaying: false });
    ui.renderContext(null);
    return;
  }

  state.emptyStates = 0;
  state.player = player;
  state.syncedAt = performance.now();
  state.isPlaying = Boolean(player.is_playing);
  state.positionMs = player.progress_ms ?? 0;
  state.deviceId = player.device?.id ?? null;

  const track = player.item;
  ui.renderPlayback({
    isPlaying: state.isPlaying,
    disallows: player.actions?.disallows ?? {},
  });

  // La pastille n'est rafraichie qu'au changement de contexte : sans ce
  // garde-fou, chaque sondage relancerait une resolution de playlist.
  const contextUri = player.context?.uri ?? null;
  if (contextUri !== state.contextUri) {
    state.contextUri = contextUri;
    refreshContextChip();
  }

  if (ui.renderTrack(track)) {
    state.trackId = track?.id ?? null;
    onTrackChanged(track);
    // La vue titres peut etre ouverte pendant que la lecture avance : on
    // deplace le surlignage sans reconstruire la liste.
    ui.markCurrentTrack(state.trackId);
  }
}

/** Charge les paroles de la nouvelle piste, en ignorant les reponses obsoletes. */
async function onTrackChanged(track) {
  if (!track) {
    ui.clearLyrics();
    return;
  }

  ui.clearLyrics("Recherche des paroles...");
  const requestedFor = track.id;

  // LRCLIB interroge des sources externes quand il n'a pas la piste en cache :
  // le temps de reponse est tres variable, d'ou l'ecran d'attente ci-dessus.
  const result = await fetchLyrics(track);

  // La piste a pu changer pendant la requete : on jette le resultat perime.
  if (state.trackId !== requestedFor) return;

  switch (result?.kind) {
    case "synced":
      ui.setLyrics(result.lines);
      break;
    case "plain":
      ui.setPlainLyrics(result.text);
      break;
    case "instrumental":
      ui.clearLyrics("Musique instrumentale");
      break;
    default:
      ui.clearLyrics("Pas de paroles pour ce titre");
  }
}

/* ------------------------------------------------------------------ */
/* Interpolation locale de la position                                 */
/* ------------------------------------------------------------------ */

function estimatedPositionMs() {
  if (!state.isPlaying) return state.positionMs;
  return state.positionMs + (performance.now() - state.syncedAt);
}

function startLyricsTicker() {
  clearInterval(lyricsTimer);
  lyricsTimer = setInterval(() => {
    if (document.hidden) return;
    ui.syncLyrics(estimatedPositionMs() + LYRICS_LEAD_MS);
  }, LYRICS_TICK_MS);
}

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

/**
 * Enveloppe commune a toutes les commandes :
 *   - reponse optimiste immediate (l'enfant voit le bouton reagir)
 *   - verrou anti double-appui
 *   - resynchronisation rapide juste apres
 */
async function command(fn, optimistic) {
  if (state.busy) return;
  state.busy = true;

  optimistic?.();

  try {
    await fn();
  } catch (err) {
    if (await recoverNoDevice(err, fn)) {
      // relance reussie apres transfert : rien de plus a faire
    } else {
      handleError(err);
      await tick(); // resynchronise l'UI sur l'etat reel
    }
  } finally {
    state.busy = false;
    scheduleNextPoll(POLL_AFTER_COMMAND_MS);
  }
}

/**
 * Cas tres frequent en voiture : le telephone a ete mis en veille, Spotify n'a
 * plus d'appareil actif. Plutot que d'afficher une erreur, on reactive
 * l'appareil le plus plausible et on rejoue la commande.
 * @returns {Promise<boolean>} true si la recuperation a fonctionne
 */
async function recoverNoDevice(err, retryFn) {
  if (err?.reason !== "NO_ACTIVE_DEVICE") return false;

  try {
    const devices = await api.getDevices();
    const target = pickDevice(devices);
    if (!target) {
      ui.toast("Aucun appareil Spotify trouve. Ouvre Spotify sur le telephone.");
      return false;
    }

    await api.transferPlayback(target.id, false);
    state.deviceId = target.id;

    // Spotify ne garantit pas l'ordre d'execution entre deux appels Player :
    // rejouer immediatement apres un transfert echoue de facon intermittente.
    await new Promise((r) => setTimeout(r, TRANSFER_SETTLE_MS));

    // La commande rejouee porte desormais un `device_id` explicite, ce qui
    // fonctionne meme si Spotify ne considere pas encore l'appareil comme actif.
    await retryFn();
    return true;
  } catch {
    ui.toast("Impossible de reactiver le telephone.");
    return false;
  }
}

/** Priorite : appareil deja actif > smartphone > premier de la liste. */
function pickDevice(devices) {
  if (!devices?.length) return null;
  return (
    devices.find((d) => d.is_active) ||
    devices.find((d) => d.type === "Smartphone") ||
    devices.find((d) => !d.is_restricted) ||
    devices[0]
  );
}

function togglePlayback() {
  const wasPlaying = state.isPlaying;
  command(
    () => (wasPlaying ? api.pause(state.deviceId) : api.play(state.deviceId)),
    () => {
      state.isPlaying = !wasPlaying;
      // On recale l'horloge pour que l'interpolation reste juste apres pause.
      // IMPERATIF : la meme base que `estimatedPositionMs`, donc
      // `performance.now()`. Melanger les deux donne un ecart de l'ordre de
      // 1,7e12 ms, la position estimee part en negatif, plus aucune ligne de
      // paroles ne correspond et le defilement se fige.
      state.positionMs = estimatedPositionMs();
      state.syncedAt = performance.now();
      ui.renderPlayback({ isPlaying: state.isPlaying });
    },
  );
}

function skipNext() {
  command(() => api.next(state.deviceId));
}

function skipPrevious() {
  command(() => api.previous(state.deviceId));
}

/* ------------------------------------------------------------------ */
/* Playlists                                                           */
/* ------------------------------------------------------------------ */

/** Playlists de l'utilisateur, indexees pour retrouver un nom depuis un URI. */
const playlistById = new Map();

/** Rend la grille et met a jour l'index utilise par la pastille. */
function applyPlaylists(playlists) {
  playlistById.clear();
  for (const p of playlists) playlistById.set(p.id, p);
  ui.renderPlaylists(playlists, (p) => openPlaylist(p, { from: "playlists" }));

  // La pastille a pu etre evaluee avant que cet index soit peuple : le nom
  // etait alors introuvable localement, et l'appel de repli a pu echouer.
  // On la reevalue maintenant que les playlists sont connues.
  refreshContextChip();
}

/**
 * Playlists : on affiche d'abord la version en cache, puis on rafraichit.
 *
 * En voiture, le reseau lache regulierement. Sans cache, la grille reste vide
 * jusqu'a ce que l'appel aboutisse — et ne s'affiche jamais dans un tunnel.
 * Avec, elle est la immediatement et se corrige silencieusement au retour du
 * reseau.
 */
/**
 * Les caches sont propres a un compte : sans ce prefixe, basculer afficherait
 * les playlists de l'autre personne.
 */
function scoped(key) {
  return auth.activeAccountId() + "." + key;
}

async function loadPlaylists() {
  const cacheKey = scoped("playlists");
  const cached = store.read(cacheKey);
  if (cached?.length) applyPlaylists(cached);

  let playlists;
  try {
    playlists = await api.getPlaylists();
  } catch (err) {
    // Hors ligne : on garde ce qui est affiche plutot que de le vider.
    handleError(err, { silent: true });
    return;
  }

  // Ne re-rend que si le contenu a reellement change : reconstruire la grille
  // pour rien coute cher sur ce SoC, et ferait sauter le defilement en cours.
  if (JSON.stringify(playlists) !== JSON.stringify(cached)) {
    applyPlaylists(playlists);
    store.write(cacheKey, playlists);
  }
}

/** Playlist actuellement affichee dans la vue titres. */
let viewedPlaylist = null;
/**
 * Vue vers laquelle revient le bouton retour de la vue titres.
 * On y revient toujours d'ou l'on vient : c'est le seul comportement qu'un
 * bouton "retour" peut avoir sans surprendre.
 */
let tracksBackView = "playlists";

/**
 * Ouvre la liste des titres d'une playlist.
 * @param {{id:string, uri:string, name:string}} playlist
 * @param {{from?: string, focusCurrent?: boolean}} [options]
 */
async function openPlaylist(playlist, { from = "playlists", focusCurrent = false } = {}) {
  viewedPlaylist = playlist;
  tracksBackView = from;
  ui.showView("tracks");

  const cacheKey = scoped("tracks." + playlist.id);
  const cached = store.read(cacheKey);

  // Version en cache affichee immediatement : ouvrir une playlist deja vue
  // est instantane, et reste possible dans une zone blanche.
  if (cached?.length) {
    ui.renderTracks(cached, playlist.name, (t) => playTrack(playlist, t));
    ui.markCurrentTrack(state.trackId, focusCurrent);
  } else {
    ui.showTracksMessage("Chargement...", playlist.name);
  }

  let tracks;
  try {
    tracks = await api.getPlaylistTracks(playlist.id);
  } catch (err) {
    // Hors ligne : si on avait une version en cache, elle reste a l'ecran.
    if (!cached?.length) {
      ui.showTracksMessage("Impossible de charger les titres.");
    }
    handleError(err, { silent: true });
    return;
  }

  // L'utilisateur a pu ouvrir une autre playlist entre-temps.
  if (viewedPlaylist?.id !== playlist.id) return;

  if (!tracks.length) {
    store.remove(cacheKey);
    ui.showTracksMessage("Cette playlist est vide.");
    return;
  }

  store.write(cacheKey, tracks);
  // Nombre de playlists dont on garde les titres, tous comptes confondus.
  // Au-dela, les moins recemment ouvertes sont oubliees : une playlist de
  // 200 titres pese ~14 Ko.
  store.trackRecent("tracks", cacheKey, 12);

  // Rien n'a bouge : on evite de reconstruire la liste et de perdre la
  // position de defilement de l'enfant en train de choisir.
  if (cached?.length && JSON.stringify(tracks) === JSON.stringify(cached)) return;

  ui.renderTracks(tracks, playlist.name, (track) => playTrack(playlist, track));
  ui.markCurrentTrack(state.trackId, focusCurrent);
}

function playTrack(playlist, track) {
  ui.showView("player");
  command(() => api.playTrackInContext(playlist.uri, track.uri, state.deviceId));
}

function playWholePlaylist() {
  if (!viewedPlaylist) return;
  const playlist = viewedPlaylist;
  ui.showView("player");
  command(() => api.playContext(playlist.uri, state.deviceId, { shuffle: true }));
}

const PLAYLIST_URI_PREFIX = "spotify:playlist:";

/** Id de la playlist en cours de lecture, ou null (album, artiste, radio). */
function currentPlaylistId() {
  const uri = state.player?.context?.uri;
  return uri?.startsWith(PLAYLIST_URI_PREFIX)
    ? uri.slice(PLAYLIST_URI_PREFIX.length)
    : null;
}

/**
 * Depuis la pastille : les chansons de la playlist en cours, positionnees sur
 * le morceau du moment. Le retour ramenera a la vue lecture.
 */
async function openCurrentContext() {
  const id = currentPlaylistId();
  if (!id) return;

  // Cas courant : la playlist est deja connue, on bascule sans latence.
  const known = playlistById.get(id);
  if (known) {
    openPlaylist(known, { from: "player", focusCurrent: true });
    return;
  }

  // Playlist inconnue (partagee par un tiers) : on montre la vue tout de
  // suite pour que l'appui soit ressenti, puis on resout le nom.
  ui.showTracksMessage("Chargement...", "");
  ui.showView("tracks");
  tracksBackView = "player";

  const fetched = await resolveCurrentPlaylist();
  if (fetched) openPlaylist(fetched, { from: "player", focusCurrent: true });
  else ui.showView("player");
}

/**
 * Retrouve la playlist correspondant au contexte de lecture. Elle n'est pas
 * forcement dans la liste de l'utilisateur (playlist d'un tiers), d'ou le
 * repli sur un appel a l'API.
 */
async function resolveCurrentPlaylist() {
  const id = currentPlaylistId();
  if (!id) return null;

  const known = playlistById.get(id);
  if (known) return known;

  try {
    const fetched = await api.getPlaylist(id);
    if (fetched) playlistById.set(id, fetched);
    return fetched;
  } catch {
    return null;
  }
}

/** Tient a jour l'etiquette "playlist en cours" sur la vue lecture. */
async function refreshContextChip() {
  if (!currentPlaylistId()) {
    ui.renderContext(null); // album, artiste, radio ou lecture libre
    return;
  }

  const playlist = await resolveCurrentPlaylist();
  ui.renderContext(playlist?.name ?? null);
}

/* ------------------------------------------------------------------ */
/* Erreurs                                                             */
/* ------------------------------------------------------------------ */

function handleError(err, { silent = false } = {}) {
  if (err instanceof auth.AuthExpiredError) {
    stopTimers();
    ui.showView("login");
    return;
  }

  if (err?.reason === "PREMIUM_REQUIRED") {
    ui.showError(
      "Le controle de lecture necessite un compte Spotify Premium.",
      { title: "Premium requis", actionLabel: "Reessayer" },
    );
    ui.els.errorAction.onclick = () => location.reload();
    return;
  }

  // Reseau instable en voiture : c'est attendu, on ne perturbe pas l'ecran.
  if (silent && (err?.reason === "NETWORK" || err?.reason === "RATE_LIMITED")) return;

  // Les SpotifyError portent un message redige pour l'utilisateur. Tout le
  // reste est une erreur JavaScript dont le message est technique et en
  // anglais : sur une tablette utilisee par des enfants, mieux vaut une
  // phrase comprehensible, le detail restant en console pour le debogage.
  if (err instanceof api.SpotifyError) {
    ui.toast(err.message);
    return;
  }

  console.warn("[musique] erreur inattendue", err);
  ui.toast("Petit souci, reessaie.");
}

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                        */
/* ------------------------------------------------------------------ */

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(lyricsTimer);
}

/* ------------------------------------------------------------------ */
/* Plein ecran                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sur Android, le plein ecran masque a la fois l'interface du navigateur
 * (onglets, barre d'adresse) et la barre de navigation systeme : c'est ce qui
 * rend le plus de place sur cet ecran.
 *
 * Les prefixes `webkit` restent necessaires : beaucoup de navigateurs Android
 * legers sont des habillages de la WebView systeme, dont la version peut etre
 * ancienne sur une tablette d'entree de gamme.
 */
function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      return;
    }
    const el = document.documentElement;
    // `navigationUI: "hide"` demande explicitement a masquer la barre de
    // navigation ; ignore la ou ce n'est pas supporte, sans consequence.
    await (el.requestFullscreen?.({ navigationUI: "hide" }) ??
      el.webkitRequestFullscreen?.());
  } catch {
    // Refuse (pas de geste utilisateur valide, ou mode non autorise).
    ui.toast("Plein ecran indisponible sur ce navigateur.");
  }
}

function syncFullscreenIcon() {
  const icon = document.getElementById("fullscreen-icon");
  const btn = document.getElementById("toggle-fullscreen");
  if (!icon || !btn) return;
  const full = isFullscreen();
  icon.setAttribute("href", full ? "#i-collapse" : "#i-expand");
  btn.setAttribute("aria-label", full ? "Quitter le plein ecran" : "Plein ecran");
}

/** Empeche la tablette de s'eteindre pendant le trajet. */
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    // Refuse (batterie faible, onglet en fond) : sans consequence.
  }
}

function wireEvents() {
  showRedirectHint();

  /* --- Setup --- */
  document.getElementById("setup-save").addEventListener("click", () => {
    const value = document.getElementById("client-id-input").value.trim();
    if (!value) {
      ui.toast("Colle le Client ID avant d'enregistrer.");
      return;
    }
    auth.setClientId(value);
    ui.showView("login");
  });

  /* --- Login --- */
  document.getElementById("login-btn").addEventListener("click", () => {
    auth.beginLogin().catch((err) => ui.toast(err.message));
  });

  document.getElementById("reset-config").addEventListener("click", () => {
    auth.clearConfig();
    showSetup();
  });

  /* --- Transport --- */
  ui.els.btnToggle.addEventListener("click", togglePlayback);
  ui.els.btnNext.addEventListener("click", skipNext);
  ui.els.btnPrev.addEventListener("click", skipPrevious);

  /* --- Navigation --- */
  // Deux acces directs depuis la vue lecture, un seul appui chacun :
  //   bouton grille   -> toutes les playlists
  //   pastille        -> les chansons de la playlist en cours
  // Et chaque bouton retour ramene exactement d'ou l'on vient.
  document
    .getElementById("open-playlists")
    .addEventListener("click", () => ui.showView("playlists"));
  document
    .getElementById("current-context")
    .addEventListener("click", openCurrentContext);
  document
    .getElementById("close-tracks")
    .addEventListener("click", () => ui.showView(tracksBackView));
  // Acces direct a la grille : sans lui, arriver ici depuis la vue lecture
  // obligerait a revenir en arriere avant de pouvoir changer de playlist.
  document
    .getElementById("tracks-to-playlists")
    .addEventListener("click", () => ui.showView("playlists"));
  document
    .getElementById("close-playlists")
    .addEventListener("click", () => ui.showView("player"));
  document.getElementById("play-all").addEventListener("click", playWholePlaylist);

  /* --- Comptes --- */
  document.getElementById("open-accounts").addEventListener("click", () => {
    renderAccountsView();
    ui.showView("accounts");
  });
  document
    .getElementById("close-accounts")
    .addEventListener("click", () => ui.showView("playlists"));
  document.getElementById("add-account").addEventListener("click", () => {
    // `chooseAccount` force Spotify a reafficher son ecran d'autorisation.
    // Sans cela, la session web deja ouverte serait reutilisee en silence et
    // on re-autoriserait la MEME personne en croyant en ajouter une autre.
    auth.beginLogin({ chooseAccount: true }).catch((err) => ui.toast(err.message));
  });

  /* --- Plein ecran --- */
  document
    .getElementById("toggle-fullscreen")
    .addEventListener("click", toggleFullscreen);
  // L'icone doit refleter l'etat reel : l'utilisateur peut sortir du plein
  // ecran par un geste systeme, sans passer par notre bouton.
  document.addEventListener("fullscreenchange", syncFullscreenIcon);
  document.addEventListener("webkitfullscreenchange", syncFullscreenIcon);

  /* --- Reprise apres mise en veille --- */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // Au retour, l'etat local a derive : on resynchronise tout de suite.
    tick().then(() => scheduleNextPoll());
    requestWakeLock();
  });

  // `click` et non `pointerdown` : au doigt, un pointerdown n'accorde PAS
  // l'activation utilisateur exigee par le wake lock. Le brancher sur
  // pointerdown fonctionne a la souris et echoue silencieusement sur la
  // tablette — exactement le genre de bug qu'on ne voit qu'en vrai.
  document.addEventListener("click", requestWakeLock, { once: true });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // `load` plutot qu'immediat : l'enregistrement du SW ne doit pas concurrencer
  // le premier rendu sur un SoC lent.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Contexte non securise (http://) ou navigateur sans SW : l'app
      // fonctionne quand meme, elle perd juste son secours hors ligne.
    });
  });
}
