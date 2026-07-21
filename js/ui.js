/**
 * Couche presentation : bascule de vues, rendu, et defilement des paroles.
 *
 * Regle de perf qui structure ce fichier : sur le SoC de la tablette, tout ce
 * qui touche au layout coute cher. Donc on mesure UNE fois par piste (les
 * positions des lignes de paroles) puis on ne fait plus que des `transform`,
 * qui restent sur le compositeur et ne declenchent ni reflow ni repaint.
 */

const $ = (id) => document.getElementById(id);

const els = {
  views: {
    setup: $("view-setup"),
    login: $("view-login"),
    loading: $("view-loading"),
    player: $("view-player"),
    playlists: $("view-playlists"),
    tracks: $("view-tracks"),
    error: $("view-error"),
  },
  cover: $("cover"),
  title: $("title"),
  artist: $("artist"),
  toggleIcon: $("toggle-icon"),
  btnPrev: $("btn-prev"),
  btnNext: $("btn-next"),
  btnToggle: $("btn-toggle"),
  lyrics: $("lyrics"),
  lyricsTrack: $("lyrics-track"),
  lyricsEmpty: $("lyrics-empty"),
  plGrid: $("pl-grid"),
  tracksList: $("tracks-list"),
  tracksTitle: $("tracks-title"),
  currentContext: $("current-context"),
  currentContextName: $("current-context-name"),
  toast: $("toast"),
  errorTitle: $("error-title"),
  errorMsg: $("error-msg"),
  errorAction: $("error-action"),
};

export { els };

/* ------------------------------------------------------------------ */
/* Vues                                                                */
/* ------------------------------------------------------------------ */

export function showView(name) {
  for (const [key, el] of Object.entries(els.views)) {
    el.classList.toggle("hidden", key !== name);
  }
}

export function showError(message, { title = "Oups", actionLabel = "Reessayer" } = {}) {
  els.errorTitle.textContent = title;
  els.errorMsg.textContent = message;
  els.errorAction.textContent = actionLabel;
  showView("error");
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;

export function toast(message, duration = 3200) {
  els.toast.textContent = message;
  els.toast.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("is-shown"), duration);
}

/* ------------------------------------------------------------------ */
/* Rendu de la piste en cours                                          */
/* ------------------------------------------------------------------ */

let renderedTrackId = null;
let renderedCoverUrl = null;

/**
 * @param {object|null} track  item Spotify (track ou episode), ou null
 * @returns {boolean} true si la piste a change depuis le dernier rendu
 */
export function renderTrack(track) {
  const id = track?.id ?? null;
  if (id === renderedTrackId) return false;
  renderedTrackId = id;

  if (!track) {
    els.title.textContent = "Rien en cours";
    els.artist.textContent = "";
    setCover(null);
    return true;
  }

  els.title.textContent = track.name ?? "";
  // Les episodes de podcast n'ont pas d'`artists` mais un `show`.
  els.artist.textContent = track.artists?.length
    ? track.artists.map((a) => a.name).join(", ")
    : (track.show?.name ?? "");

  setCover(pickCover(track));
  return true;
}

function pickCover(track) {
  const images = track.album?.images ?? track.images ?? [];
  if (!images.length) return null;
  // On vise ~400px : au-dela, le cout de decodage ne se voit pas a l'ecran.
  const sized = images.filter((i) => i.width);
  if (!sized.length) return images[0].url;
  const big = sized.filter((i) => i.width >= 400);
  const pool = big.length ? big : sized;
  return pool.reduce((a, b) => (a.width <= b.width ? a : b)).url;
}

const BLANK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

function setCover(url) {
  if (url === renderedCoverUrl) return;
  renderedCoverUrl = url;
  els.cover.src = url || BLANK;
}

/** Met a jour l'icone lecture/pause et l'etat des boutons. */
export function renderPlayback({ isPlaying, disallows = {} }) {
  els.toggleIcon.setAttribute("href", isPlaying ? "#i-pause" : "#i-play");
  els.btnToggle.setAttribute(
    "aria-label",
    isPlaying ? "Mettre en pause" : "Lancer la lecture",
  );

  // Spotify indique dans `actions.disallows` ce qui est interdit dans le
  // contexte courant. On grise les boutons plutot que de laisser l'enfant
  // appuyer sur un bouton qui renverra une erreur.
  els.btnPrev.disabled = Boolean(disallows.skipping_prev);
  els.btnNext.disabled = Boolean(disallows.skipping_next);
}

/* ------------------------------------------------------------------ */
/* Playlists                                                           */
/* ------------------------------------------------------------------ */

export function renderPlaylists(playlists, onPick) {
  const frag = document.createDocumentFragment();

  for (const pl of playlists) {
    const item = document.createElement("button");
    item.className = "pl-item";
    item.type = "button";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = pl.image || BLANK;

    const label = document.createElement("span");
    label.textContent = pl.name;

    item.append(img, label);
    item.addEventListener("click", () => onPick(pl));
    frag.append(item);
  }

  els.plGrid.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* Titres d'une playlist                                               */
/* ------------------------------------------------------------------ */

/** Affiche ou masque la pastille "playlist en cours" sur la vue lecture. */
export function renderContext(name) {
  const hasName = Boolean(name);
  els.currentContext.classList.toggle("hidden", !hasName);
  if (hasName) els.currentContextName.textContent = name;
}

let renderedTrackRows = new Map();

/** Message a la place de la liste (chargement, playlist vide, erreur). */
export function showTracksMessage(message, playlistName) {
  if (playlistName !== undefined) els.tracksTitle.textContent = playlistName;
  renderedTrackRows = new Map();
  const p = document.createElement("p");
  p.className = "tracks-message";
  p.textContent = message;
  els.tracksList.replaceChildren(p);
}

/**
 * @param {{id:string, uri:string, name:string, artist:string, image:string|null}[]} tracks
 * @param {string} playlistName
 * @param {(track: object) => void} onPick
 */
export function renderTracks(tracks, playlistName, onPick) {
  els.tracksTitle.textContent = playlistName;

  const frag = document.createDocumentFragment();
  renderedTrackRows = new Map();

  for (const track of tracks) {
    const row = document.createElement("button");
    row.className = "track-row";
    row.type = "button";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = track.image || BLANK;

    const text = document.createElement("div");
    text.className = "track-text";

    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = track.name;

    const artist = document.createElement("span");
    artist.className = "track-artist";
    artist.textContent = track.artist;

    text.append(name, artist);

    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("class", "track-mark");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-playing");
    mark.append(use);

    row.append(img, text, mark);
    row.addEventListener("click", () => onPick(track));

    // Plusieurs lignes peuvent porter le meme id (doublon dans la playlist) :
    // on ne garde que la premiere pour le surlignage.
    if (!renderedTrackRows.has(track.id)) renderedTrackRows.set(track.id, row);
    frag.append(row);
  }

  els.tracksList.replaceChildren(frag);
  els.tracksList.scrollTop = 0;
}

/**
 * Met a jour le surlignage sans reconstruire la liste — appele a chaque
 * changement de piste, y compris pendant que la vue est ouverte.
 * @param {string|null} trackId
 * @param {boolean} [scrollIntoView]
 */
export function markCurrentTrack(trackId, scrollIntoView = false) {
  for (const [id, row] of renderedTrackRows) {
    row.classList.toggle("is-current", id === trackId);
  }

  if (!scrollIntoView) return;
  const row = trackId && renderedTrackRows.get(trackId);
  if (!row) return;

  // `content-visibility: auto` empeche scrollIntoView de bien mesurer une
  // ligne encore non rendue : on calcule la position nous-memes.
  els.tracksList.scrollTop =
    row.offsetTop - els.tracksList.clientHeight / 2 + row.offsetHeight / 2;
}

/* ------------------------------------------------------------------ */
/* Paroles synchronisees                                               */
/* ------------------------------------------------------------------ */

/** @type {{times: number[], offsets: number[], nodes: HTMLElement[]}|null} */
let lyricsLayout = null;
let activeLineIndex = -1;

export function clearLyrics(message = "Pas de paroles") {
  lyricsLayout = null;
  activeLineIndex = -1;
  els.lyrics.classList.remove("is-scrollable");
  els.lyricsTrack.replaceChildren();
  els.lyricsTrack.style.transform = "";
  els.lyricsEmpty.textContent = message;
  els.lyricsEmpty.classList.remove("hidden");
}

/**
 * Affiche des paroles non synchronisees : pas de defilement automatique, mais
 * c'est toujours mieux que rien — l'enfant suit avec le doigt.
 * @param {string} text
 */
export function setPlainLyrics(text) {
  lyricsLayout = null;
  activeLineIndex = -1;
  els.lyricsEmpty.classList.add("hidden");
  els.lyrics.classList.add("is-scrollable");
  els.lyrics.scrollTop = 0;
  els.lyricsTrack.style.transform = "";

  const frag = document.createDocumentFragment();
  for (const raw of text.split(/\r?\n/)) {
    const el = document.createElement("div");
    el.className = "lyric-line is-active"; // tout en pleine opacite
    el.textContent = raw.trim() || " ";
    frag.append(el);
  }
  els.lyricsTrack.replaceChildren(frag);
}

/**
 * Injecte les paroles synchronisees et mesure les positions une seule fois.
 * @param {{timeMs: number, text: string}[]} lines
 */
export function setLyrics(lines) {
  if (!lines?.length) {
    clearLyrics();
    return;
  }

  els.lyricsEmpty.classList.add("hidden");
  els.lyrics.classList.remove("is-scrollable");

  const frag = document.createDocumentFragment();
  const nodes = [];

  for (const line of lines) {
    const el = document.createElement("div");
    el.className = "lyric-line";
    // Une ligne vide dans un LRC = pause instrumentale. On garde la hauteur
    // pour que le defilement reste fidele au timing.
    el.textContent = line.text || " ";
    nodes.push(el);
    frag.append(el);
  }

  els.lyricsTrack.replaceChildren(frag);

  // Unique passe de mesure : on force le layout une fois, on lit tous les
  // offsetTop d'affilee (pas d'alternance lecture/ecriture = pas de thrash).
  const offsets = nodes.map((n) => n.offsetTop + n.offsetHeight / 2);

  lyricsLayout = {
    times: lines.map((l) => l.timeMs),
    offsets,
    nodes,
  };
  activeLineIndex = -1;
}

/**
 * Positionne les paroles pour une position de lecture donnee.
 * Appelee ~4x/seconde : ne doit rien faire de couteux quand rien ne change.
 * @param {number} positionMs
 */
export function syncLyrics(positionMs) {
  if (!lyricsLayout) return;

  const { times, offsets, nodes } = lyricsLayout;

  // Recherche dichotomique de la derniere ligne dont le timestamp est passe.
  let lo = 0;
  let hi = times.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= positionMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (idx === activeLineIndex) return;

  if (activeLineIndex >= 0) nodes[activeLineIndex]?.classList.remove("is-active");
  activeLineIndex = idx;

  if (idx < 0) {
    els.lyricsTrack.style.transform = "translate3d(0,0,0)";
    return;
  }

  nodes[idx].classList.add("is-active");

  // La ligne active se cale a 38 % de la hauteur visible : assez haut pour
  // qu'on lise la suite, assez bas pour garder le contexte precedent.
  const anchor = els.lyrics.clientHeight * 0.38;
  const y = Math.max(0, offsets[idx] - anchor);
  els.lyricsTrack.style.transform = `translate3d(0,${-y}px,0)`;
}
