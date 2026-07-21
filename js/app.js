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

async function start() {
  ui.showView("player");
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
      state.positionMs = estimatedPositionMs();
      state.syncedAt = Date.now();
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

async function loadPlaylists() {
  try {
    const playlists = await api.getPlaylists();
    playlistById.clear();
    for (const p of playlists) playlistById.set(p.id, p);
    ui.renderPlaylists(playlists, (p) => openPlaylist(p));
  } catch (err) {
    handleError(err, { silent: true });
  }
}

/** Playlist actuellement affichee dans la vue titres. */
let viewedPlaylist = null;

/**
 * Ouvre la liste des titres d'une playlist.
 * @param {{id:string, uri:string, name:string}} playlist
 * @param {{focusCurrent?: boolean}} [options]
 */
async function openPlaylist(playlist, { focusCurrent = false } = {}) {
  viewedPlaylist = playlist;

  ui.showTracksMessage("Chargement...", playlist.name);
  ui.showView("tracks");

  let tracks;
  try {
    tracks = await api.getPlaylistTracks(playlist.id);
  } catch (err) {
    // On reste sur la vue : afficher l'erreur en place vaut mieux que
    // renvoyer l'enfant sur un ecran qu'il n'a pas demande.
    ui.showTracksMessage("Impossible de charger les titres.");
    handleError(err, { silent: true });
    return;
  }

  // L'utilisateur a pu ouvrir une autre playlist entre-temps.
  if (viewedPlaylist?.id !== playlist.id) return;

  if (!tracks.length) {
    ui.showTracksMessage("Cette playlist est vide.");
    return;
  }

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
 * Unique point d'entree depuis la vue lecture : les chansons de la playlist
 * en cours si on en joue une, sinon la grille des playlists.
 */
async function openPlaylistsOrCurrent() {
  const id = currentPlaylistId();
  if (!id) {
    ui.showView("playlists");
    return;
  }

  // Cas courant : la playlist est deja connue, on bascule sans latence.
  const known = playlistById.get(id);
  if (known) {
    openPlaylist(known, { focusCurrent: true });
    return;
  }

  // Playlist inconnue (partagee par un tiers) : on montre la vue tout de
  // suite pour que l'appui soit ressenti, puis on resout le nom.
  ui.showTracksMessage("Chargement...", "");
  ui.showView("tracks");

  const fetched = await resolveCurrentPlaylist();
  if (fetched) openPlaylist(fetched, { focusCurrent: true });
  else ui.showView("playlists");
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

  ui.toast(err?.message || "Une erreur est survenue.");
}

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                        */
/* ------------------------------------------------------------------ */

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(lyricsTimer);
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
  // Hierarchie volontairement lineaire, pour qu'un enfant n'ait jamais qu'un
  // seul bouton retour a comprendre :
  //   lecture  --[liste]-->  chansons  --[retour]-->  playlists  --[retour]--> lecture
  document
    .getElementById("open-playlists")
    .addEventListener("click", openPlaylistsOrCurrent);
  document
    .getElementById("close-tracks")
    .addEventListener("click", () => ui.showView("playlists"));
  document
    .getElementById("close-playlists")
    .addEventListener("click", () => ui.showView("player"));
  document.getElementById("play-all").addEventListener("click", playWholePlaylist);

  /* --- Reprise apres mise en veille --- */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // Au retour, l'etat local a derive : on resynchronise tout de suite.
    tick().then(() => scheduleNextPoll());
    requestWakeLock();
  });

  // Le wake lock et le plein ecran exigent un geste utilisateur : on
  // s'accroche au premier contact avec l'ecran.
  document.addEventListener("pointerdown", requestWakeLock, { once: true });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // `load` plutot qu'immediat : l'enregistrement du SW ne doit pas concurrencer
  // le premier rendu sur un SoC lent.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Contexte non securise (http://) ou navigateur sans SW : l'app
      // fonctionne quand meme, elle demarre juste moins vite.
    });
  });
}
