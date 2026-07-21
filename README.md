# spotify-car-kids-remote

Télécommande Spotify minimaliste, pensée pour qu'un enfant change la musique de
la voiture depuis une tablette d'entrée de gamme — sans installer l'application
Spotify, qui est bien trop lourde pour ce matériel.

La musique continue de sortir du téléphone (ou de l'autoradio). La tablette ne
lit rien : elle envoie seulement des commandes à Spotify Connect.

**~40 Ko transférés** (30 Ko de code gzippé + 9 Ko d'icônes), sans dépendance,
sans build, sans backend. Et une fois en cache, le démarrage ne touche plus le
réseau du tout.

## Ce que ça fait

- Titre, artiste et pochette de ce qui joue
- Lecture / pause / suivant / précédent, en très gros boutons
- Sélecteur de playlists sous forme de grille de pochettes
- Liste des titres d'une playlist, avec le morceau en cours repéré par une
  icône — pour choisir une chanson précise et pas seulement lancer le tout
- Paroles synchronisées en grand, qui défilent toutes seules

Depuis la vue lecture, deux accès directs, un seul appui chacun : le bouton
en damier ouvre toutes les playlists, la pastille verte ouvre les chansons de
la playlist en cours, positionnée sur le morceau du moment. Chaque bouton
retour ramène exactement d'où l'on vient.

## Comment ça marche

```
Tablette (cette PWA)  ──HTTPS──>  API Spotify  ──>  Téléphone (Spotify Connect)
        │                                                    │
        │                                              lecture réelle
        └──HTTPS──> LRCLIB (paroles synchronisées, sans clé)
```

Aucun serveur intermédiaire. La tablette parle directement à l'API Spotify et à
LRCLIB, les deux acceptant les requêtes navigateur (CORS).

Deux conséquences pratiques :

- **La tablette n'a pas besoin d'être sur le même Wi-Fi que le téléphone.**
  Spotify Connect passe par les serveurs de Spotify. Un partage de connexion,
  ou deux connexions différentes, fonctionnent aussi bien.
- **La tablette doit être connectée avec le compte Spotify qui joue la
  musique**, puisque la liste des appareils est propre à chaque compte.

## Prérequis

| | |
|---|---|
| Compte Spotify | **Premium obligatoire.** Les endpoints `/me/player/*` de contrôle renvoient `403` sur un compte gratuit. |
| Tablette | Android avec un navigateur moderne (voir plus bas) |
| Hébergement | HTTPS obligatoire (service worker + URI de redirection Spotify) |

> **Deux exigences Premium, pas une.** Depuis mars 2026, une app en mode
> développement exige aussi que *le propriétaire de l'app dans le Dashboard*
> ait un abonnement Premium actif. Ici les deux se confondent — c'est ton
> compte dans les deux rôles — mais si ton abonnement s'interrompt, l'app
> cesse de fonctionner jusqu'au réabonnement.

---

## Installation

### 1. Créer l'application Spotify

1. Aller sur <https://developer.spotify.com/dashboard> et se connecter.
2. **Create app**.
   - *App name* : `Telecommande voiture` (peu importe)
   - *Redirect URIs* : ajouter **les deux** lignes suivantes
     ```
     https://roukmoute.github.io/spotify-car-kids-remote/
     http://127.0.0.1:5173/
     ```
     La seconde sert au développement en local.

     Deux pièges, tous les deux sanctionnés par le même message
     `redirect_uri: Not matching configuration` au moment de se connecter :
     - **le slash final compte** — Spotify compare les chaînes à l'identique,
       donc `http://127.0.0.1:5173` (sans slash) ne correspond pas à ce que
       l'app envoie ;
     - **`localhost` est refusé**, il faut l'adresse `127.0.0.1`. C'est la
       seule forme pour laquelle Spotify tolère encore du `http://` en clair
       (exception loopback ; tout le reste doit être en HTTPS depuis avril
       2025).

     En cas de doute, l'écran de connexion de l'app affiche l'URI exacte
     à déclarer, prête à copier.
   - *Which API/SDKs are you planning to use* : cocher **Web API**
3. Valider, puis ouvrir **Settings** et copier le **Client ID**.

Le Client ID n'est pas un secret : dans le flux PKCE, c'est un identifiant
public. Il n'y a **aucun** `client_secret` dans ce projet, c'est précisément ce
qui permet de se passer de backend.

> **Mode développement.** Une app fraîchement créée est limitée à 25 personnes,
> ajoutées à la main dans **Settings → User Management**. Comme la tablette se
> connecte avec *ton* compte (celui qui joue la musique), tu es le seul à
> ajouter — les enfants n'ont pas de compte à eux dans l'histoire.

### 2. Publier l'app

Le dépôt ne contient que des fichiers statiques : n'importe quel hébergeur HTTPS
convient. Avec GitHub Pages :

1. **Settings → Pages**
2. *Source* : `Deploy from a branch`
3. *Branch* : `main`, dossier `/ (root)`, puis **Save**

L'app est en ligne sur `https://<utilisateur>.github.io/spotify-car-kids-remote/`
au bout d'une minute environ.

> Si tu déploies ailleurs, pense à ajouter la nouvelle URL dans les *Redirect
> URIs* du dashboard Spotify : elle doit correspondre **exactement**.

### 3. Configurer la tablette

1. Ouvrir l'URL dans le navigateur.
2. Coller le **Client ID** — demandé une seule fois, il est ensuite mémorisé.
3. **Se connecter à Spotify**, accepter les autorisations.
4. Menu du navigateur → **Ajouter à l'écran d'accueil**.

L'icône lance ensuite l'app en plein écran, sans barre d'adresse. La session est
conservée : les enfants n'ont jamais à se reconnecter.

#### Quel navigateur sur la tablette

Il faut un navigateur basé sur Chromium **avec son propre moteur**. Beaucoup de
navigateurs « ultra-légers » sont en réalité de simples habillages de l'Android
System WebView : leur « Ajouter à l'écran d'accueil » ne crée qu'un raccourci
qui rouvre le navigateur avec sa barre d'adresse, au lieu d'une vraie fenêtre
autonome.

- **Chrome** : le choix par défaut, déjà présent, vraie installation PWA.
- **Cromite** : successeur maintenu de Bromite, sans télémétrie, plus léger que
  Chrome. Bon compromis sur une tablette poussive.
- **Fully Kiosk Browser** : si tu veux verrouiller la tablette sur cette seule
  app (utile en voiture — les enfants ne peuvent plus en sortir). Version
  gratuite suffisante, licence payante pour retirer la bannière.

Le poids de l'APK du navigateur importe peu : c'est l'app Spotify (plusieurs
centaines de Mo, et surtout son démarrage à froid) qui rendait la tablette
inutilisable, pas le navigateur.

---

## Développement local

```sh
node tools/dev-server.mjs      # http://127.0.0.1:5173/
```

Serveur statique sans dépendance. Il écoute volontairement sur `127.0.0.1` :
c'est la seule adresse pour laquelle Spotify tolère encore une redirection en
`http://`, et c'est un *secure context* pour le navigateur, donc les service
workers et `crypto.subtle` se comportent comme en production.

Régénérer les icônes après modification :

```sh
node tools/make-icons.mjs
```

## Structure

```
index.html              shell + icônes SVG en <symbol>
styles.css              tout le style (aucun framework)
manifest.webmanifest    métadonnées PWA
sw.js                   service worker : démarrage instantané
js/auth.js              OAuth 2.0 PKCE, rotation du refresh token
js/spotify.js           client Web API (401/403/404/429 gérés)
js/lyrics.js            LRCLIB + parseur LRC + cache local
js/ui.js                rendu DOM et défilement des paroles
js/app.js               boucle d'état et commandes
tools/dev-server.mjs    serveur statique de dev
tools/make-icons.mjs    générateur d'icônes PNG (sans dépendance)
```

## Choix techniques

**PKCE plutôt que le flux implicite.** Le flux implicite ne délivre pas de
`refresh_token` : il faudrait se reconnecter toutes les heures, rédhibitoire
quand ce sont des enfants qui utilisent la tablette. PKCE fournit un
`refresh_token` sans `client_secret`, donc sans backend.

Attention, ce `refresh_token` est **rotatif** : chaque rafraîchissement en
renvoie un nouveau qu'il faut persister immédiatement. Les rafraîchissements
concurrents sont donc mutualisés dans `auth.js`, sinon deux requêtes simultanées
déclencheraient deux rotations dont l'une invaliderait l'autre.

**Sondage espacé + interpolation locale.** L'état du lecteur est demandé toutes
les 5 s en lecture (20 s en pause), et la position est extrapolée localement
entre deux appels, sur `performance.now()` — horloge monotone, insensible à un
recalage NTP en cours de route. Sonder à 200 ms pour des paroles fluides
représenterait ~18 000 requêtes sur un trajet d'une heure, et le quota Spotify
se compte **par application**, pas par utilisateur.

**Backoff aveugle sur `429`.** Spotify envoie bien un en-tête `Retry-After`,
mais il est illisible depuis un navigateur : l'API n'expose pas cet en-tête via
CORS, donc `headers.get("Retry-After")` renvoie toujours `null`. La temporisation
est donc à l'aveugle (5 s → 15 s → 60 s → 300 s) et **persistée** — sans ça, un
simple rechargement de page relancerait les requêtes et prolongerait la
limitation.

**Paroles : LRCLIB, pas Musixmatch.** Les paroles synchronisées de Musixmatch
(`track.subtitle.get`, `track.richsync.get`) ne font pas partie du plan
développeur gratuit, et l'API n'envoie pas d'en-têtes CORS : il faudrait un
backend uniquement pour porter la clé. LRCLIB est gratuit, sans clé, et répond
`Access-Control-Allow-Origin: *`. C'est ce qui garde le projet 100 % statique.

Spotify n'expose aucun endpoint public de paroles — celui qu'utilise son
application officielle est privé et non documenté. Ce projet ne s'appuie pas
dessus.

**Défilement par `transform`.** Les positions des lignes sont mesurées une seule
fois par morceau, puis le défilement n'est qu'une `translate3d` : cela reste sur
le compositeur et ne déclenche ni recalcul de layout ni repeint, ce qui compte
beaucoup sur un SoC lent.

**Service worker en réseau d'abord, pas en cache-first.** Le cache-first et son
cousin stale-while-revalidate ont tous les deux été essayés et abandonnés : ils
servent par construction une version périmée, et la moindre faille dans la
revalidation laisse l'appareil bloqué sur du vieux code **sans aucun signe
extérieur** — l'écran s'affiche normalement, il est simplement en retard. Sur
une tablette posée dans une voiture, ce mode de panne est invisible, donc
particulièrement pénible à diagnostiquer.

Le réseau d'abord est déterministe : ce qui s'affiche est toujours ce qui est
déployé. Le coût est modeste — le shell fait ~30 Ko, et l'app a de toute façon
besoin du réseau pour piloter Spotify. Le cache garde son rôle là où il compte
vraiment : tunnels, zones blanches, réseau qui rame, avec un délai d'attente de
2,5 s pour ne pas y rester bloqué.

Le pré-cache n'utilise volontairement pas `cache.addAll`, qui est atomique :
une seule requête en échec annulerait tout. Sur une connexion partagée depuis
un téléphone en roulant, un cache partiel vaut mieux que pas de cache.

## Cache et connexion difficile

L'usage réel est une voiture : tunnels, zones blanches, 4G qui faiblit. Tout
ce qui peut être servi localement l'est.

| | Où | Plafond |
|---|---|---|
| Pochettes | Cache du service worker, *cache-first* | 120 images |
| Paroles | `localStorage`, une clé par piste | 120 titres (~520 Ko) |
| Liste des playlists | `localStorage` | 1 entrée |
| Titres des playlists | `localStorage`, éviction LRU | 12 playlists (~170 Ko) |

Playlists et titres sont affichés **depuis le cache d'abord**, puis rafraîchis
en arrière-plan et re-rendus seulement si le contenu a changé — reconstruire la
liste pour rien coûte cher sur ce SoC et ferait perdre la position de
défilement. Si le réseau est absent, ce qui est affiché reste affiché.

Vérifié réseau entièrement coupé : la grille et les titres restent utilisables,
sans message d'erreur.

**Ce que le cache ne peut pas faire :** rendre l'application utilisable hors
ligne. Piloter la lecture passe forcément par les serveurs Spotify — sans
connexion, les commandes échouent, quel que soit le cache. Il évite l'écran
vide et les listes qui disparaissent, pas la panne de réseau.

Le cache des paroles a été mesuré sur la tablette cible (`tools/bench.html`) :
une clé par piste coûte 0,3 ms par changement de piste, contre 80 ms pour un
cache monolithique — `localStorage` étant synchrone, ces 80 ms bloquaient le
rendu.

## Limites connues

- **Premium obligatoire** pour tout le contrôle de lecture.
- **Reconnexion tous les 6 mois.** Depuis juillet 2026, Spotify fait expirer le
  `refresh_token` six mois après l'autorisation initiale, et le rafraîchir ne
  remet pas le compteur à zéro. Deux fois par an, il faudra retaper les
  identifiants sur la tablette — l'app bascule alors d'elle-même sur l'écran de
  connexion.
- **Toutes les chansons n'ont pas de paroles synchronisées** dans LRCLIB. La
  base est communautaire : très bonne couverture sur le répertoire courant,
  clairsemée sur les comptines et le catalogue jeunesse. L'app dégrade dans
  l'ordre : synchronisées → texte simple défilable au doigt → « Musique
  instrumentale » → « Pas de paroles pour ce titre ».
- Les paroles peuvent dériver de quelques dixièmes de seconde : le décalage
  tablette → API → téléphone est compensé de façon empirique
  (`LYRICS_LEAD_MS` dans `js/app.js`, à ajuster au besoin).
- **Les playlists éditoriales Spotify** (Découvertes de la semaine, Radar des
  sorties, et plus généralement celles éditées par Spotify) sont restreintes
  pour les applications créées après novembre 2024. Elles peuvent ne pas
  apparaître dans la grille, ou ne pas être jouables. Tes propres playlists ne
  sont pas concernées.
- Le `refresh_token` est stocké en `localStorage`. Sur une tablette familiale
  partagée c'est un compromis assumé ; quiconque a la tablette en main a de
  toute façon accès à la session. En cas de doute, révoque l'accès depuis
  <https://www.spotify.com/account/apps/>.

> **Un point à connaître sur GitHub Pages.** Tous tes projets Pages sont servis
> depuis la même origine `https://roukmoute.github.io`. Or le cloisonnement du
> navigateur se fait par origine, pas par chemin : n'importe quel autre projet
> que tu publieras un jour sur ce compte pourra lire le `localStorage` de cette
> app — donc le jeton Spotify. Pour isoler proprement, héberge plutôt sur un
> domaine dédié (Cloudflare Pages ou Netlify donnent une origine propre, et un
> vrai contrôle des en-têtes HTTP pour poser une CSP). Vu le périmètre des
> droits demandés — contrôler la lecture, rien d'autre — le risque reste faible,
> mais autant le savoir.

## Licence

MIT
