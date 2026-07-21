/**
 * Petit magasin persistant, une clef localStorage par entree.
 *
 * Meme principe que le cache de paroles : jamais de gros blob JSON relu et
 * reecrit en entier. Mesure sur la tablette cible, cache plein : 80 ms par
 * operation en blob unique contre 0,3 ms par clef.
 *
 * Sert a garder l'interface peuplee quand le reseau lache — le cas normal en
 * voiture. A noter : cela ne rend pas l'application utilisable hors ligne,
 * puisque piloter la lecture passe forcement par les serveurs Spotify. Cela
 * evite seulement un ecran vide et des listes qui disparaissent des que la
 * connexion faiblit.
 */

const PREFIX = "scr.st.";

/** @returns {any|undefined} `undefined` si absent ou illisible. */
export function read(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** @returns {boolean} false si le stockage a refuse (quota, mode prive). */
export function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* rien a faire */
  }
}

/**
 * Limite le nombre d'entrees partageant un prefixe, en supprimant les plus
 * anciennement ECRITES. L'ordre d'insertion de localStorage n'etant pas
 * garanti, on maintient une liste explicite.
 *
 * @param {string} family   prefixe logique, ex. "tracks."
 * @param {string} key      clef qu'on vient d'ecrire (sans le prefixe global)
 * @param {number} max      nombre d'entrees conservees
 */
export function trackRecent(family, key, max) {
  const listKey = family + "__recent";
  const list = (read(listKey) || []).filter((k) => k !== key);
  list.push(key);

  while (list.length > max) remove(list.shift());

  write(listKey, list);
}
