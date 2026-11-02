# Guide complet — Panneau Computer (CUA) dans Pi Desktop

*Document initial rédigé le 2026-11-01 ; section de contrôle agent et sauvegarde mise à jour le 2026-11-02 par lecture du code uniquement, sans nouveau test ni smoke test. Les observations machine datées du 2026-11-01 sont historiques et ne garantissent pas l'état actuel.*

## Table des matières

1. [En une phrase](#1-en-une-phrase)
2. [Prérequis — ce qui doit tourner](#2-prérequis--ce-qui-doit-tourner)
3. [Utiliser le panneau Computer](#3-utiliser-le-panneau-computer)
4. [Configurer](#4-configurer)
5. [Que voit-on en cas de problème](#5-que-voit-on-en-cas-de-problème)
6. [Maintenir](#6-maintenir)
7. [Limites actuelles et pistes](#7-limites-actuelles-et-pistes)
8. [Annuaire des fichiers](#8-annuaire-des-fichiers)

---

## 1. En une phrase

Le fork Pi Desktop embarque un panneau « Computer » qui affiche, dans une petite fenêtre sécurisée à l'intérieur de l'application, un bureau Linux ou Windows distant hébergé par la plateforme Cua.ai — soit un conteneur jetable lancé sur la VM CUA ou sur ce PC, soit (bientôt) un vrai bureau complet — et qui peut laisser le modèle Jev de TypeSafe choisir automatiquement le bon environnement en fonction de votre dernière demande.

---

## 2. Prérequis — ce qui doit tourner

Tout ne doit pas tourner en permanence, mais chaque option du panneau dépend de quelque chose de précis.

### 2.1 Sur ce PC (Windows)

| Élément | État vérifié le 2026-11-01 | Utile pour |
|---|---|---|
| **Client SSH Windows** (`ssh` dans le PATH) | présent | tous les backends qui passent par la VM (`docker-vm`, `proxmox-vm`) |
| **Clé SSH agent** `C:\Users\noname\.ssh\id_pve` (ed25519, sans phrase de passe, commentaire `omp-agent`) | présente et autorisée sur la VM et sur Proxmox | se connecter à la VM CUA et à l'hôte Proxmox |
| **App Cua Spaces** — fournit le CLI local `C:\Users\noname\AppData\Local\Programs\Cua\bin\cua.exe` et le service hôte `cua-spacesd` sur `127.0.0.1:3211` | installée ; la machine Windows est déclarée sur le compte Cua sous le nom « PC-NONAME » (visible dans `cua spaces list`) | `docker-host` (délivrance du ticket du viewer) et `main-os` |
| **Docker Desktop** — binaire `C:\Users\noname\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe` | installé | `docker-host` uniquement |
| **Pi Desktop (le fork)** — version de développement ou installée | les deux existent | tout |

### 2.2 La VM CUA (backend par défaut « Docker (CUA VM) »)

| Élément | Détail vérifié |
|---|---|
| Hébergement | VM **ID 110** sur Proxmox `pve` (192.168.1.2), type `qm` (machine virtuelle, pas un LXC) |
| Système | Ubuntu 24.04, 4 vCPU, 8 Go de RAM, 64 Go de disque (`local-lvm`) |
| Réseau | **IP DHCP 192.168.1.44** — elle peut changer ; il est recommandé de la réserver sur l'UDR7 |
| Accès | `cua@192.168.1.44` avec la clé `id_pve`, sudo sans mot de passe |
| Docker Engine | version 29.9.2 |
| Cua CLI | version **0.9.0** dans `~/.local/bin` (ce dossier n'est PAS dans le PATH par défaut ; le code de Pi Desktop fait lui-même `export PATH=$HOME/.local/bin:$PATH` avant chaque commande) |
| Service d'hôte | `cua-spacesd-host.service` en **systemd utilisateur** (linger activé sur le compte `cua`), écoute sur `127.0.0.1:3211` dans la VM |
| Inscription Cua | hôte relay nommé **« Proxmox Cua »**, desktop + Spaces partagés, **maximum 1 space**, runtime `runc` (gVisor absent) |
| Compte Cua sur la VM | `cua.sulphuric133@passmail.net`, device `dev_35cfa3c670d1e8393ed3f8a1`, **enrôlé jusqu'au 2026-12-01** |
| Bibliothèques X11 | `libxi6 libxtst6 libx11-6 libxcb1` installées (sans elles, `cua-spacesd` ne peut pas lier le display X11, même headless) |

Commande de contrôle rapide (sans danger, lecture seule) — résultat du 2026-11-01 en commentaire :

```powershell
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes cua@192.168.1.44 'export PATH=$HOME/.local/bin:$PATH; cua --version; systemctl --user is-active cua-spacesd-host'
# -> cua 0.9.0 / active
```

### 2.3 Optionnel : la clé TypeSafe (pour « Auto (Jev) »)

Le mode Auto interroge l'API TypeSafe (`https://api.typesafe.ai/v1/systemone`, modèle `jev-latest`). Sans clé, rien ne casse : le code retombe déterministement sur le backend `docker-vm` (voir §3.4). La clé se saisit dans **Settings → TypeSafe Jev** et est stockée dans un fichier séparé (voir §4.3).

---

## 3. Utiliser le panneau Computer

### 3.1 Ouvrir et fermer

- Le panneau s'ouvre manuellement via l'icône **moniteur** (Computer) dans le rail vertical à droite de la conversation, ou via l'outil agent `show_computer` si l'extension décrite au §3.5 est chargée. Un second clic sur l'icône, ou la croix **X** dans l'en-tête du panneau, le ferme.
- **Fermer le panneau supprime tout** : le space Cua (ou le conteneur) est détruit côté hôte **et** le tunnel SSH local est tué. Vérifié en pratique : après fermeture, il reste 0 space et 0 processus `ssh` parasite.
- Quand l'application quitte (`will-quit`), le tunnel SSH résiduel est coupé (`shutdownCuaSession`). Attention : **les spaces Cua, eux, ne sont pas supprimés** à la fermeture de l'app — voir §5 et §6.2.

### 3.2 Choisir un backend

L'en-tête du panneau contient le menu déroulant **« Session backend »** avec 5 options. La sélection est gardée **en mémoire seulement** (store Zustand) : après un redémarrage de l'app, on revient au défaut `docker-vm`.

Ce que chaque option fait réellement (code : `src/main/ipc/computer-handlers.ts`) :

| Option affichée | Clé interne | Comportement réel | Statut |
|---|---|---|---|
| **Docker (CUA VM)** (défaut) | `docker-vm` | Via SSH, la VM crée un space Linux avec `cua spaces create --name pi-desktop-… linux`, Pi Desktop récupère un ticket viewer (`cua sb view … --json`), puis ouvre un tunnel `ssh -N -L 38100:127.0.0.1:<port>` vers la boucle locale de la VM. Le webview affiche le viewer sur `http://127.0.0.1:38100`. | ✅ **Fonctionnel** (testé, bureau streamé) |
| **Docker (ce PC)** | `docker-host` | `docker.exe run -d -p 127.0.0.1:<port>:3211 ghcr.io/trycua/linux:24.04` lancé par le Docker Desktop local ; attente du jeton interne `/run/cua/env-token` (45 s max), du viewer (`/viewer/` répond, 25 s max) et de l'audio PipeWire (30 s, meilleure-effort) ; le CLI local `cua.exe` enregistre le conteneur comme sandbox `direct:` et délivre le ticket. Pas de tunnel SSH. | ✅ **Fonctionnel** (testé, bureau streamé) |
| **Main OS** | `main-os` | Doit diffuser le bureau Windows de ce PC via le `cua-spacesd` du service Cua local (port 3211) : lecture de `~\.cua\host\env-token`, sondage `cua spacesd targets`, puis ticket direct. | ❌ **Message explicite « non supporté pour l'instant »** |
| **Proxmox VM** | `proxmox-vm` | Doit diffuser le bureau Ubuntu complet de la VM (pas un conteneur) via son `cua-spacesd` d'hôte (`127.0.0.1:3211` dans la VM), sondé et titré via SSH, avec tunnel local. | ❌ **Message explicite « non supporté pour l'instant »** |
| **Auto (Jev)** | `auto` | Le dernier message utilisateur (500 caractères max) est envoyé à Jev qui choisit le backend ; le panneau s'ouvre alors sur ce backend. Détail au §3.4. | ✅ le mécanisme tourne, avec repli `docker-vm` |

**Pourquoi les deux « non supporté » ?** Le pipeline est intégralement écrit côté Pi Desktop (tickets, tunnels, sécurité). Ce qui manque est sur l'hôte : le build `cua-spacesd` installé (sur ce PC comme sur la VM) ne déclare pas de *desktop provider* — la commande de sondage renvoie « no desktop provider », et Pi Desktop affiche cette cause exacte dans le message d'erreur. Il n'y a rien à réparer ici : il faudra un build Cua qui expose le flux bureau.

Un seul comportement sérialisé : **une seule session à la fois**. Si une session `docker-vm` est ouverte et qu'on demande un autre backend, le panneau ferme d'abord l'ancienne puis rouvre sur le nouveau (`setComputerBackend` dans le store). Un garde-fou empêche toute double ouverture : verrou dans le renderer + file d'attente dans le main (la course connue du `<select>` qui émet un événement par flèche clavier a été corrigée et re-testée).

### 3.3 Les boutons de l'en-tête

- **↻ Refresh** : redemande un nouveau ticket viewer à l'hôte (les tickets ont une validité bornée, ~1 h) et **relance le tunnel SSH s'il est mort** ou si le port configuré a changé. À utiliser quand l'image ne répond plus.
- **⧉ Open in browser** : ouvre la même URL du viewer dans votre navigateur habituel (utile si le webview gêne).
- **✕ Close panel** : détruit la session (space + conteneur + tunnel) comme décrit au §3.1.

Dans le corps du panneau : soit le viewer (webview cloisonné, partition `persist:cua-viewer`, sandbox activé), soit l'écran d'erreur avec le message de la cause et un bouton **Retry**, soit un écran d'attente « No active computer session ». L'en-tête affiche aussi l'identifiant de session (`#pi-deskt…` tronqué à 8 caractères) — pratique pour retrouver le space dans `cua spaces list`.

### 3.4 Le mode Auto (Jev)

Flux (code : `src/main/jev-cua.ts`, `src/main/ipc/jev-handlers.ts`, `resolveAutoComputerBackend` dans le store) :

1. À l'ouverture, le renderer prend le **dernier message utilisateur** (tronqué à 500 caractères) et l'envoie via IPC au processus principal.
2. Le principal lit la **clé API TypeSafe dans son fichier dédié** (la clé ne voyage jamais jusqu'à l'interface) et pose à Jev deux questions en une seule requête HTTP : une question « noul » *la demande a-t-elle besoin d'un bureau graphique ?* (seuil : probabilité ≥ 0,5) et une question « choice » *quel backend convient ?* (les critères envoyés décrivent les 4 backends). Timeout : **8 secondes**.
3. La réponse ramène `needsComputer`, le `backend` choisi et une confiance. **Dans l'état actuel, seul le backend est utilisé** : `needsComputer` est calculé mais le panneau s'ouvre de toute façon, puisque c'est vous qui l'avez ouvert manuellement.
4. L'en-tête du panneau affiche le backend réellement résolu et **la raison du jugement** (ex. `jev: needsComputer 0.87; backend docker-host at 0.92`).

Replis déterministes vers `docker-vm` (avec la raison affichée) : aucune clé TypeSafe enregistrée, échec réseau/HTTP/analyse, timeout, backend hors liste, pont indisponible, ou aucun prompt à juger. Jev ne bloque donc jamais l'ouverture.

Le mode Auto manuel utilise le dernier message utilisateur. L'outil agent `show_computer` peut aussi ouvrir le panneau ; son mode Auto pose actuellement à Jev une demande générique, sans transmettre le texte utilisateur.

### 3.5 Contrôle depuis l'agent OMP

La copie portable de l'extension est conservée dans **`resources/pi-cua-control.ts`**, avec les autres extensions du dépôt. Elle n'est pas chargée automatiquement par Pi Desktop : pour l'utiliser, copier ce seul fichier dans `~/.omp/agent/extensions/pi-cua-control.ts`, puis recharger/redémarrer la session OMP. Ne pas copier de configuration, de jeton ou de fichier de credentials.

Découverte du serveur, dans l'ordre : répertoire `PI_DESKTOP_USER_DATA_DIR` si défini, `%APPDATA%/pi-desktop` si disponible, puis `~/.pi-desktop-dev`. Pour une autre plateforme ou plusieurs instances, définir explicitement `PI_DESKTOP_USER_DATA_DIR` vers le profil voulu. La copie portable remplace seulement le chemin de développement Windows nominatif par `homedir()` ; le fichier externe existant reste inchangé.

| Outil OMP | Route HTTP | Effet |
|---|---|---|
| `show_computer({ backend? })` | `POST /computer/open` | Ouvre/réutilise la session ; défaut `auto` ; retourne notamment `success`, `sessionId`, `viewerUrl`, `backend` |
| `hide_computer({})` | `POST /computer/close` | Ferme la session courante et masque le panneau ; ce n'est pas une simple réduction visuelle |
| `computer_status({})` | `GET /computer/status` | Retourne `open`, `sessionId`, `backend` |
| `computer_exec({ command })` | `POST /computer/exec` | Exécute `cua sb exec … -- sh -lc` dans la session active ; nécessite une session ouverte |

Le serveur main écoute uniquement sur `127.0.0.1`, sur un port attribué par l'OS. Il génère un jeton aléatoire de 32 octets par lancement et écrit `{ port, token }` dans `<userData>/cua-control.json`. Chaque route exige `Authorization: Bearer <token>` ; le fichier est retiré à l'arrêt normal. Le perdant du verrou single-instance ne publie pas ce fichier. Les événements main → renderer synchronisent l'ouverture/fermeture du panneau.

Les corps sont limités à 256 Kio. Les erreurs métier peuvent avoir HTTP 200 avec `success: false` : lire le résultat, pas seulement le statut HTTP. `computer_exec` a un délai serveur de 30 s ; un code de sortie non nul est un résultat normal à examiner. L'arrêt du client SSH/CLI au délai ne prouve pas l'arrêt de tous les descendants dans l'invité.

**Sécurité et limites :** `cua-control.json` contient un secret donnant accès au contrôle et au shell invité ; ne jamais le commiter ni le partager, et protéger le profil avec les permissions OS. L'écriture actuelle n'impose pas de mode propriétaire explicite ni d'ACL Windows dédiée. La boucle locale et le bearer ne remplacent pas une validation des actions sensibles par l'utilisateur. Les URL viewer peuvent également contenir un ticket confidentiel. Cette sauvegarde n'atteste aucun succès d'exécution de l'extension, des routes HTTP, du shell invité ou de la synchronisation renderer ; les tests de routage sont présents mais non exécutés.

Validation séparée rapportée par l'agent parent le 2026-11-02 : `npm run typecheck` réussi ; `node --import tsx --test src/main/cua-control-routes.test.ts src/main/jev-cua.test.ts` réussi (**28/28**). Aucun lancement UI ni smoke test bout-en-bout n'a été réalisé pour cette sauvegarde. La mention « non exécutés lors de cette sauvegarde » désigne les actions de l'agent de sauvegarde, pas cette validation parent.


---

## 4. Configurer

### 4.1 Settings → Behavior : les deux champs CUA

Le panneau de réglages (`settings-panel.tsx`, section **Behavior**) expose deux champs :

- **CUA Host** — IP ou nom de la machine qui tourne le Cua CLI et Docker (utilisateur SSH `cua`, clé `~/.ssh/id_pve`). Défaut : **192.168.1.44**. Validation (`src/shared/app-settings.ts`) : chaîne non vide **sans espace**, sinon le défaut est restauré.
- **CUA Tunnel Port** — port local du tunnel SSH qui expose le viewer. Défaut : **38100**. Doit être un entier entre **1024 et 65535**, sinon le défaut revient. **Un redémarrage de l'application est nécessaire après changement** : la liste blanche des origines autorisées dans le webview est figée au démarrage (`setupCuaWebviewSecurity`).

Les deux valeurs sont écrites dans `settings.json`, relu à chaque session par le processus principal (`src/main/cua-settings.ts`), qui applique les mêmes valeurs par défaut.

### 4.2 Où est `settings.json`

Le fichier vit dans le répertoire de données de l'app :

| Instance | Chemin |
|---|---|
| Version installée (par défaut) | `C:\Users\noname\AppData\Roaming\pi-desktop\settings.json` — vérifié : le fichier existe et ne contient **aucune** clé `cua*` aujourd'hui, ce sont donc les défauts qui s'appliquent |
| Instance de développement (`PI_DESKTOP_USER_DATA_DIR`) | `C:\Users\noname\.pi-desktop-dev\settings.json` |

### 4.3 Le port caché de « Docker (ce PC) »

Le port local qui mappe le viewer du conteneur `docker-host` n'a **pas de champ dans l'interface** : c'est la clé `cuaDockerHostPort` dans `settings.json`, défaut **3212** (choisi parce que 3211 est déjà pris sur ce PC par le service Cua Spaces), tolérance 1024–65535. Pour le changer, éditez `settings.json` puis redémarrez l'application :

```json
{ "cuaDockerHostPort": 3300 }
```

### 4.4 La clé TypeSafe (pour Auto)

- Saisie dans **Settings → TypeSafe Jev** : un champ « API key » (bouton Save ; la clé n'est jamais renvoyée à l'interface une fois enregistrée, on voit juste « Saved » et un bouton pour la supprimer).
- Stockage : fichier **`typesafe-api-key`** dans le répertoire de données de l'app (ex. `C:\Users\noname\AppData\Roaming\pi-desktop\typesafe-api-key` — vérifié : présent). Écriture atomique en mode réservé au propriétaire ; la clé ne passe **pas** par `settings.json`, et le jugement renvoyé au renderer ne contient **jamais** la clé.
- Le module Jev du panneau (jev-handlers) lit toujours ce fichier côté principal. (Séparément, `TYPESAFE_API_KEY` dans l'environnement est transmis aux agents Pi/OMP s'il n'y est pas déjà — ce sont deux usages distincts, documentés dans `typesafe-key-store.ts`.)

### 4.5 Ce qui est codé en dur (pas configurable par l'interface)

Dans `src/main/ipc/computer-handlers.ts` : utilisateur SSH **`cua`**, clé **`~/.ssh/id_pve`**, image **`ghcr.io/trycua/linux:24.04`**, chemin du CLI local **`AppData\Local\Programs\Cua\bin\cua.exe`**, chemin de **docker.exe**, port spacesd d'hôte **3211**, jeton conteneur **`/run/cua/env-token`**. Changer l'un d'eux demande de modifier le code.

---

## 5. Que voit-on en cas de problème

Le panneau affiche toujours **la raison technique exacte** (première ligne de l'erreur) sur fond d'écran d'erreur. Tableaux : symptôme → cause probable → action.

| Symptôme affiché | Cause | Action |
|---|---|---|
| « Échec de création du space : … ssh: connect to host 192.168.1.44 … » (timeout/refus) | VM éteinte, IP DHCP qui a bougé, ou mauvais « CUA Host » | Démarrer la VM (§6.1) ; vérifier l'IP réelle ; corriger **Settings → Behavior → CUA Host** |
| Erreur SSH générique type *Permission denied (publickey)* | Clé `C:\Users\noname\.ssh\id_pve` absente/modifiée, ou retirée de `authorized_keys` sur la VM | Re-vérifier la clé : `ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes cua@192.168.1.44 true` |
| « … command not found: cua » (dans une erreur de création) | Cua CLI déplacé hors de `~/.local/bin` sur la VM | Réinstaller/rétablir le binaire (le code ajoute `$HOME/.local/bin` au PATH, ne comptez pas sur le PATH de la VM) |
| « docker-host non supporté pour l'instant : Docker Desktop introuvable (…docker.exe) » | Docker Desktop absent ou déplacé | Lancer Docker Desktop, ou utiliser `docker-vm` |
| « docker-host : « docker run ghcr.io/trycua/linux:24.04 » a échoué : Cannot connect to the Docker daemon… » | Docker Desktop installé mais **pas démarré** | Démarrer Docker Desktop, attendre qu'il soit prêt, rouvrir |
| « docker-host : cua-spacesd n'a pas exposé de jeton (/run/cua/env-token) dans le conteneur — bureau indisponible. » | Le conteneur n'a pas réussi à démarrer son service (image, ressource) | Fermer/rouvrir la session ; au besoin supprimer l'image et relancer pour re-pull |
| « docker-host : le viewer du conteneur ne répond pas sur 127.0.0.1:3212. » | Port 3212 occupé, ou conteneur bloqué au démarrage | Libérer le port ou changer `cuaDockerHostPort` (§4.3) puis redémarrer l'app |
| « Le conteneur docker-host ne tourne plus — fermez la session puis rouvrez-la. » (au Refresh) | Le conteneur est mort en cours de session | Bouton ✕ pour fermer, puis rouvrir |
| « main-os non supporté pour l'instant : le build cua-spacesd de ce PC n'expose pas de desktop provider (flux du bureau indisponible). » / « proxmox-vm non supporté pour l'instant : le build cua-spacesd de l'hôte de la VM n'expose pas de desktop provider… » | Limitation connue côté Cua (voir §3.2 et §7) | Rien à faire côté Pi Desktop ; réessayer après mise à jour des builds Cua |
| « main-os non supporté pour l'instant : … CLI Cua introuvable (…cua.exe) — installez l'app Cua Spaces. » | App Cua Spaces désinstallée/déplacée | Réinstaller l'app Cua |
| « Impossible de récupérer l'URL du viewer Cua. » / « Impossible de rafraîchir l'URL du viewer. » | Le CLI distant n'a pas rendu de JSON exploitable (space mort, service d'hôte en panne) | Bouton Refresh ; sinon ✕ puis rouvrir ; sinon vérifier le service `cua-spacesd-host` (§6.1) |
| « URL du viewer inattendue (attendu 127.0.0.1 sur l'hôte Cua). » | L'hôte renvoie une URL hors boucle locale (configuration Cua inhabituelle) | Vérifier le relay/les partages de l'hôte avec `cua spaces list` |
| Image figée / viewer qui demande « Reconnect » après une longue pause | **Ticket viewer expiré** (validité ~1 h) | Bouton **Refresh** : nouveau ticket + relance du tunnel si mort |
| Le viewer ne charge pas alors que le space existe (erreur de chargement webview sans message de session) | Tunnel `ssh -N -L` mort, ou port 38100 occupé par un autre programme | Refresh (relance le tunnel) ; si le port est pris, changer **CUA Tunnel Port** et **redémarrer l'app** |
| « Une session docker-vm est déjà ouverte — fermez-la avant d'ouvrir un autre backend. » | Garde-fou anti-double-session (le principal refuse tant que l'état du renderer diverge) | Bouton ✕ (ferme la session), puis rouvrir |
| En mode Auto, la raison affichée est `jev-unavailable` | Pas de clé TypeSafe, clé invalide, ou api.typesafe.ai injoignable sous 8 s | Enregistrer la clé dans Settings → TypeSafe Jev ; le backend `docker-vm` est utilisé en attendant |
| Raison `aucun prompt à juger` | Aucun message utilisateur dans la conversation courante | Écrire une demande, puis ouvrir le panneau |
| Création de space refusée par l'hôte avec une erreur Cua (ex. slot occupé) alors que rien n'est ouvert dans Pi Desktop | **Space orphelin** : l'app a crashé (le tunnel est coupé à la fermeture, mais les spaces non) — et l'hôte de la VM est limité à **1 space** | Lister et supprimer le résidu (§6.2) |

Où regarder les logs : les erreurs du tunnel SSH sont journalisées dans la console du processus principal (`[CUA] tunnel error: …`) ; l'écran d'erreur du panneau reste votre première source.

---

## 6. Maintenir

### 6.1 La VM et son service

Depuis PowerShell sur ce PC (toutes ces commandes ont été exécutées avec succès le 2026-11-01) :

```powershell
# État de la VM 110 sur Proxmox
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes root@192.168.1.2 "qm status 110"

# Démarrer / arrêter proprement la VM
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes root@192.168.1.2 "qm start 110"
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes root@192.168.1.2 "qm shutdown 110"

# Dans la VM : version CLI, état du service, espaces en cours
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes cua@192.168.1.44 'export PATH=$HOME/.local/bin:$PATH; cua --version; systemctl --user is-active cua-spacesd-host; cua spaces list'

# Redémarrer le service d'hôte si le viewer ne répond plus
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes cua@192.168.1.44 "systemctl --user restart cua-spacesd-host"

# S'assurer qu'il redémarre avec la session (linger déjà activé)
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes cua@192.168.1.44 "systemctl --user enable cua-spacesd-host"
```

Points d'attention documentés dans le code et la configuration :

- L'IP **192.168.1.44 est du DHCP** : si elle bouge, tout tombe avec le message de connexion SSH. Réservez-la sur l'UDR7 ou mettez à jour **CUA Host**.
- Les 4 bibliothèques X11 (`libxi6 libxtst6 libx11-6 libxcb1`) sont nécessaires au `cua-spacesd` même sans écran : ne pas les désinstaller après un `apt autoremove` sur une future image.

### 6.2 Nettoyer un space ou un conteneur orphelin

À la fermeture de l'application, seul le tunnel SSH est coupé (`shutdownCuaSession` dans `will-quit`) ; un space créé par `docker-vm` peut survivre à un crash. Comme l'hôte n'accepte qu'un seul space :

```powershell
# Lister puis supprimer le space résidu sur la VM
ssh -i C:\Users\noname\.ssh\id_pve -o BatchMode=yes cua@192.168.1.44 'export PATH=$HOME/.local/bin:$PATH; cua spaces list; cua spaces delete <nom-du-space> --force'

# Conteneur résiduel côté Docker Desktop (docker-host)
& "$env:LOCALAPPDATA\DockerDesktop\resources\bin\docker.exe" ps -a --filter "name=pi-desktop-"
& "$env:LOCALAPPDATA\DockerDesktop\resources\bin\docker.exe" rm -f <nom>
```

Le nom des spaces/conteneurs créés par Pi Desktop commence toujours par `pi-desktop-` (suivi d'un horodatage base-36).

### 6.3 Compte / device Cua

L'enrôlement du device de la VM (`dev_35cfa3c670d1e8393ed3f8a1`, compte `cua.sulphuric133@passmail.net`) est **valable jusqu'au 2026-12-01**. Avant cette date, il faudra renouveller l'enrôlement sur la VM via le flux de connexion Cua (le CLI local sur Windows et l'app Cua Spaces sont connectés au même compte, machine « PC-NONAME »). Vérifier l'état avec `cua spaces list` depuis la VM : les hôtes relay (`Proxmox Cua`, `PC-NONAME`) doivent apparaître.

### 6.4 Mettre à jour le Cua CLI

La VM embarque `cua` **0.9.0** dans `~/.local/bin`, l'app Cua Spaces embarque le CLI local dans `AppData\Local\Programs\Cua\bin`. Vérifier les versions avec `cua --version` des deux côtés. La procédure d'upgrade exacte n'est pas fixée dans ce dépôt : pour la VM, réexécuter l'installateur officiel Cua vers `~/.local/bin` (le code ne cherche que cet emplacement) ; pour Windows, c'est l'app Cua Spaces qui fournit le binaire — garder l'application à jour suffit. **Ne pas déplacer les binaires** : les chemins sont codés en dur (§4.5).

### 6.5 L'instance de développement (reconstruire le fork)

Le PATH des shells non interactifs ne contient pas Node ; le Node de la machine (WinGet, vérifié présent) est ici :

```powershell
$nodeDir = 'C:\Users\noname\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.20.0-win-x64'
$env:PATH = "$nodeDir;$env:PATH"
cd C:\Users\noname\Work\pi-desktop-cua

npm install          # échoue sur le rebuild node-gyp de node-pty (pas de Visual Studio) : NON bloquant, les prebuilds win32-x64 sont fournis

# Réparer le binaire Electron si manquant (message d'erreur au lancement) :
node node_modules\electron\install.js

# Lancer l'instance DEV isolée de l'installée :
$env:PI_DESKTOP_USER_DATA_DIR = 'C:\Users\noname\.pi-desktop-dev'
npm run dev          # = electron-vite build + preview
```

Pourquoi l'isolation fonctionne : dans ce fork, `app.requestSingleInstanceLock()` est pris **après** `app.setPath('userData', …)` (modification amont nécessaire — dans l'upstream le verrou est pris avant, ce qui faisait tuer silencieusement l'instance dev par l'app installée). Les deux instances peuvent donc coexister, chacune avec son répertoire de données (`C:\Users\noname\AppData\Roaming\pi-desktop` vs `C:\Users\noname\.pi-desktop-dev`).

### 6.6 Revalider après modification

```powershell
npm run typecheck
# = tsc -b --noEmit (le lib target du main n'inclut pas es2024 : ne pas utiliser Promise.withResolvers dans src/main)

npx --no-install tsx --test src/main/jev-cua.test.ts src/shared/i18n/locales.test.ts
# 23 tests
```

Règle i18n obligatoire pour **toute clé ajoutée** : parité `en` ↔ `zh-Hans` dans `resources/locales/*/translation.json` (le test `locales.test.ts` le vérifie ; les clés CUA existent déjà dans les deux langues).

### 6.7 Mettre à jour le fork depuis le dépôt distant

La sauvegarde CUA se fait sur la branche **`feat/cua-computer-panel`**, exclusivement vers le remote **`fork` = `https://github.com/noshishinitai/pi-desktop.git`**. Le remote `origin` désigne `https://github.com/FaqFirebase/pi-desktop.git` ; ne pas y pousser cette sauvegarde.

Après revue des changements et sélection explicite des fichiers à sauvegarder :

```powershell
git commit -m "feat(cua): preserve agent control bridge and portable OMP extension"
git push fork HEAD:refs/heads/feat/cua-computer-panel
```

Cette procédure ne réécrit ni ne supprime l'historique. Ne pas utiliser `reset --hard`, `clean` ou un push forcé pour sauvegarder le travail. Une mise à jour depuis l'amont est une opération distincte, hors de cette sauvegarde.

### 6.8 Sécurité : ce qui est isolé et pourquoi

Trois couches (`src/main/cua-webview-security.ts` + exception dans `src/main/index.ts`) :

1. **Partition webview dédiée** `persist:cua-viewer` : le viewer n'a ni accès au stockage du renderer principal, ni aux cookies des autres fenêtres. Ses `webpreferences` sont verrouillées : `contextIsolation=yes, nodeIntegration=no, sandbox=yes`, plugins coupés.
2. **Liste blanche d'origines**, figée au démarrage de l'app : `http://127.0.0.1:<tunnelPort>` et `http://localhost:<tunnelPort>` (tunnel docker-vm/proxmox-vm), `…:<cuaDockerHostPort>` (docker-host), `127.0.0.1:3211`/`localhost:3211` (spacesd local, main-os), et `https://relay.cua.ai` (machines relay Cua). **Toute requête réseau du webview vers une autre origine est annulée** (`webRequest.onBeforeRequest`), toute navigation hors liste est bloquée, toute pop-up est niée, tous les menus contextuels désactivés, et **toutes les demandes de permission (caméra, micro, notifications…) sont refusées** sans question.
3. **Exception `will-attach-webview`** dans `index.ts` : la règle générale de l'app n'autorise que des webviews `file://` (les previews HTML locales) ; la partition `persist:cua-viewer` est la seule dérogation (le viewer est une app JS servie en HTTP local), précisément parce que sa surface réseau est déjà bornée par la couche 2. Sans cette dérogation, le JS du viewer serait coupé.

Conséquence pratique : changer le port de tunnel ou `cuaDockerHostPort` **sans redémarrer l'app** rend le viewer inaccessible (la liste blanche a été calculée au démarrage avec les anciens ports) — c'est un choix de sécurité, pas un bug.

---

## 7. Limites actuelles et pistes

- **`main-os` et `proxmox-vm` sont bloqués côté Cua**, pas côté Pi Desktop : la chaîne complète (ticket `sb create --on direct:…`, tunnel, sécurité) est écrite et testable ; il manque un build `cua-spacesd` exposant un *desktop provider* sur ces hôtes. Pistes : suivre les releases Cua, tester à nouveau le sondage `cua spacesd targets` après upgrade.
- **Auto côté agent sans contexte utilisateur** : `show_computer` peut maintenant ouvrir le panneau, mais Jev reçoit une demande générique ; le flux manuel garde le dernier message utilisateur. `needsComputer` reste ignoré à l'ouverture.
- **Une seule session à la fois, un seul space sur l'hôte VM** : pas de multi-bureaux. Les spaces survivent au crash de l'app (voir §6.2). Piste : supprimer les spaces orphelins au démarrage ou à `will-quit`.
- **La sélection de backend n'est pas persistée** (défaut `docker-vm` à chaque lancement). Piste : une clé de settings dédiée si besoin.
- **`cuaDockerHostPort` n'a pas de champ d'interface** (éditation manuelle de `settings.json`). Piste : l'ajouter à Settings → Behavior avec un redémarrage requis, comme le port de tunnel.
- **Runtime `runc` sur la VM (pas gVisor)** : les conteneurs CUA partagent le noyau de l'invité Ubuntu ; acceptable pour un labo local, à garder en tête avant d'y piloter des sites sensibles. Piste : activer gVisor sur l'hôte Cua si disponible.
- **Enrôlement du device VM limité au 2026-12-01** : prévoir le renouvellement avant, sinon tous les backends distants échoueront côté relais.
- Le lib target du processus main reste limité (pas `Promise.withResolvers`) et les clics de fond sur les fenêtres Chromium (menus `<select>` natifs) peuvent nécessiter cua-driver ou un passage au premier plan — pièges notés dans les commentaires du code.

---

## 8. Annuaire des fichiers

### 8.1 Code de l'intégration (fork)

| Fichier | Rôle |
|---|---|
| `src/main/ipc/computer-handlers.ts` | Cœur du main : 4 flux d'ouverture par backend, tickets viewer, tunnel SSH, rafraîchissement, fermeture, file de sérialisation, `shutdownCuaSession` |
| `src/main/jev-cua.ts` | Module Jev : construction des 2 questions TypeSafe, appel HTTP (8 s), validation stricte, repli `jev-unavailable` |
| `src/main/jev-cua.test.ts` | Tests du module Jev (avec fetch stub injecté) |
| `src/main/cua-control-server.ts` | Serveur HTTP loopback, jeton de découverte, opérations de session et événements renderer |
| `src/main/cua-control-routes.ts` et `src/main/cua-control-routes.test.ts` | Authentification, routage, validation et tests unitaires non exécutés lors de cette sauvegarde |
| `resources/pi-cua-control.ts` | Copie portable de l'extension OMP externe ; installation manuelle, sans configuration ni secret |
| `src/main/ipc/jev-handlers.ts` | Canal IPC `jev:judge-cua` : lit la clé TypeSafe côté main, renvoie le jugement seul |
| `src/main/cua-settings.ts` | Lecture synchrone de `settings.json` : `cuaHost`, `cuaTunnelPort`, `cuaDockerHostPort` (+ défauts) |
| `src/main/cua-webview-security.ts` | Partition `persist:cua-viewer` : liste blanche d'origines, filtrage réseau, refus permissions/popups/navigation |
| `src/main/index.ts` | Câblage global : `setPath('userData')` avant le verrou single-instance, exception `will-attach-webview` pour la partition CUA, `setupCuaWebviewSecurity()` au boot, `shutdownCuaSession()` à `will-quit` |
| `src/main/ipc-handlers.ts` | Enregistre `registerComputerHandlers()` + `registerJevHandlers()` |
| `src/main/typesafe-key-store.ts` | Fichier `typesafe-api-key` (mode propriétaire, atomique) + env `TYPESAFE_API_KEY` pour les agents |
| `src/main/app-data-paths.ts` | Répertoire de données : `PI_DESKTOP_USER_DATA_DIR` vs `%APPDATA%\pi-desktop` |
| `src/shared/ipc-contracts.ts` | Types `ComputerBackend`, `CuaJudgment`, résultats IPC, canaux `COMPUTER_*` et `jev:judge-cua` |
| `src/shared/app-settings.ts` | Validation/sanitize de `cuaHost` et `cuaTunnelPort` |
| `src/shared/default-settings.ts` | Défauts : `cuaHost: '192.168.1.44'`, `cuaTunnelPort: 38100` |
| `src/preload/index.ts` | Ponts `window.piDesktop.computer.*` et `window.piDesktop.jev.judgeCuaUse` |
| `src/renderer/src/store.ts` | Tranche Computer du store : verrou renderer, `runComputerOpen`, résolution auto/Jev, fermeture propre, changement de backend |
| `src/renderer/src/components/computer-panel.tsx` | Le panneau : en-tête (sélecteur backend, id de session, raison Jev, refresh, externe, croix) + webview + écrans erreur/attente |
| `src/renderer/src/components/chat-tool-rail.tsx` | Bouton moniteur du rail droit (bascule ouvrir/fermer) |
| `src/renderer/src/components/chat-panel.tsx` | Emplacement du panneau dans la fenêtre de conversation |
| `src/renderer/src/components/settings-panel.tsx` | Champs « CUA Host » / « CUA Tunnel Port » (section Behavior) + réinitialisation aux défauts |
| `src/renderer/src/components/typesafe-settings.tsx` | Section Settings → TypeSafe Jev (enregistrement/suppression de la clé) |
| `resources/locales/en/translation.json` et `resources/locales/zh-Hans/translation.json` | Chaînes `computer.*` et `settings.cua*` (parité exigée) |

### 8.2 Ressources hors dépôt (chemins machine)

| Emplacement | Rôle |
|---|---|
| `C:\Users\noname\.ssh\id_pve` | Clé SSH de l'agent (Windows → VM et Proxmox), sans phrase de passe |
| `C:\Users\noname\AppData\Local\Programs\Cua\bin\cua.exe` | CLI Cua local fourni par l'app Cua Spaces |
| `C:\Users\noname\.cua\host\env-token` | Jeton du service hôte Cua local (backend `main-os`) |
| `C:\Users\noname\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe` | CLI Docker local (backend `docker-host`) |
| `C:\Users\noname\AppData\Roaming\pi-desktop\settings.json` | Réglages de l'app installée (`cuaHost`, `cuaTunnelPort`, `cuaDockerHostPort`) |
| `C:\Users\noname\AppData\Roaming\pi-desktop\typesafe-api-key` | Clé API TypeSafe (fichier propriétaire) |
| `C:\Users\noname\.pi-desktop-dev\` | Données de l'instance de développement |
| VM 110 (Proxmox `pve`, 192.168.1.44) | `cua` CLI 0.9.0 dans `~/.local/bin`, service `cua-spacesd-host.service`, Docker 29.9.2, jeton hôte `~/.cua/host/env-token` |
