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
const POLL_PAUSED_MS = 15_000;
/** Sondage rapide juste apres une commande, le temps que Spotify propage. */
const POLL_AFTER_COMMAND_MS = 700;
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
  /** Date.now() au moment de la reception, pour interpoler la position. */
  syncedAt: 0,
  positionMs: 0,
  isPlaying: false,
  trackId: null,
  deviceId: null,
  /** Empeche deux commandes concurrentes de se marcher dessus. */
  busy: false,
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
  state.player = player;
  state.syncedAt = Date.now();

  if (!player) {
    // 204 : aucun appareil actif. On garde l'UI en place mais neutre.
    state.isPlaying = false;
    state.positionMs = 0;
    if (ui.renderTrack(null)) ui.clearLyrics("Lance la musique sur le telephone");
    ui.renderPlayback({ isPlaying: false });
    return;
  }

  state.isPlaying = Boolean(player.is_playing);
  state.positionMs = player.progress_ms ?? 0;
  state.deviceId = player.device?.id ?? null;

  const track = player.item;
  ui.renderPlayback({
    isPlaying: state.isPlaying,
    disallows: player.actions?.disallows ?? {},
  });

  if (ui.renderTrack(track)) {
    state.trackId = track?.id ?? null;
    onTrackChanged(track);
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

  const lines = await fetchLyrics(track);

  // La piste a pu changer pendant la requete : on jette le resultat perime.
  if (state.trackId !== requestedFor) return;

  if (lines?.length) ui.setLyrics(lines);
  else ui.clearLyrics("Pas de paroles pour ce titre");
}

/* ------------------------------------------------------------------ */
/* Interpolation locale de la position                                 */
/* ------------------------------------------------------------------ */

function estimatedPositionMs() {
  if (!state.isPlaying) return state.positionMs;
  return state.positionMs + (Date.now() - state.syncedAt);
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

async function loadPlaylists() {
  try {
    const playlists = await api.getPlaylists();
    ui.renderPlaylists(playlists, pickPlaylist);
  } catch (err) {
    handleError(err, { silent: true });
  }
}

function pickPlaylist(playlist) {
  ui.showView("player");
  command(() => api.playContext(playlist.uri, state.deviceId, { shuffle: true }));
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

  /* --- Navigation playlists --- */
  document
    .getElementById("open-playlists")
    .addEventListener("click", () => ui.showView("playlists"));
  document
    .getElementById("close-playlists")
    .addEventListener("click", () => ui.showView("player"));

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
