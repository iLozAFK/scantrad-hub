# scantrad-hub

Hub d'iLoza : séries, équipes, outils, glossaires et liens de scantrad.
Site statique (aucun build) + panneau admin pour tout modifier depuis le navigateur.

## Structure

- `index.html` : le site public (lit `data/data.js`)
- `data/data.js` : toutes les données (séries, équipes, outils, glossaires, liens, textes)
- `covers/` : couvertures des séries (300x450, webp)
- `admin/index.html` : panneau admin (`/admin/`)
- `_headers` : empêche l'indexation de l'admin

## Mise en ligne (gratuit, Cloudflare Pages)

1. Crée un dépôt GitHub vide (ex. `scantrad-hub`) et pousse ces fichiers.
2. Cloudflare, Workers & Pages, Create, Pages, Connect to Git, choisis le dépôt.
3. Build command : vide. Output directory : `/`. Deploy.
4. Chaque commit sur `main` redéploie le site automatiquement.

## Utiliser l'admin

1. GitHub, Settings, Developer settings, Fine-grained tokens, Generate new token.
2. Repository access : uniquement `scantrad-hub`. Permissions, Contents : Read and write.
3. Ouvre `https://TON-SITE/admin/`, renseigne `owner/scantrad-hub`, la branche et le jeton.
4. Modifie, ajoute ou supprime des séries, équipes, outils, glossaires, liens. Glisse une image pour la couverture (redimensionnée automatiquement).
5. Clique sur **Publier** : les couvertures et `data/data.js` sont commit sur GitHub, Cloudflare redéploie en environ une minute.

Le jeton reste dans le localStorage de ton navigateur ; "Déconnexion" l'efface.
Pour une sécurité en plus, protège `/admin/*` avec Cloudflare Access (gratuit).

## Modifier à la main

`data/data.js` est du JSON précédé de `window.HUB = `. Garde ce format : l'admin le relit tel quel.
Un outil peut utiliser un lien `zeon://open` (voir `zeon-lanceur.reg` pour l'enregistrer sous Windows).
