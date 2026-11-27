/* ---------- Scantrad : traduire un chapitre, son historique, le glossaire de la série ----------
   Chargé après le script principal d'index.html : réutilise $, h, icon, cover, SERIES, slugS,
   chLoadCfg, chScript, ntB64d, ntB64e.
   Stockage : le dépôt privé des chapitres (scantrad-data par défaut), dossier traductions/<série>/
     serie.json              règles, résumé, glossaire, index des chapitres traduits
     chapitres/<numéro>.json le texte d'un chapitre traduit
   La clé API Claude reste dans ce navigateur (la même que l'outil OCR de l'admin). */

const ST_PREF = "scantrad-hub-st", ST_KEY_API = "scantrad-hub-ocr-key";
const ST_MODEL = "claude-opus-5-5";   // Claude Opus 5.5
const ST_EFFORT = "medium";           // low | medium | high | xhigh | max
const ST_BAND_H = 2500, ST_MAX_DIM = 7800, ST_MAX_IMG = 20;   // pages webtoon découpées en bandes lisibles
const ST_CATS = ["Personnage", "Lieu", "Technique", "Faction", "Objet", "Autre"];
const ST_VUES = { traduire: ["Traduire", "lang"], chapitres: ["Chapitres", "list"], glossaire: ["Glossaire", "open"] };
const ST_LANGUES = ["anglais", "coréen", "japonais", "chinois"];

let st = { slug: "", vue: "", serie: null, data: null, sha: null, chargement: null, err: "" };
let stJob = null;        // traduction en cours (survit aux changements d'onglet)
let stGl = { filtre: "Tous", q: "", edit: null, sous: "termes" };
let stFile = Promise.resolve();

function stPref() { try { return Object.assign({ prefixes: true, langue: "anglais", traducteur: "iLoza", last: "" }, JSON.parse(localStorage.getItem(ST_PREF) || "{}")); } catch (e) { return { prefixes: true, langue: "anglais", traducteur: "iLoza", last: "" }; } }
function stSetPref(k, v) { try { const p = stPref(); p[k] = v; localStorage.setItem(ST_PREF, JSON.stringify(p)); } catch (e) {} }
function stCle() { try { return localStorage.getItem(ST_KEY_API) || ""; } catch (e) { return ""; } }
function stSerieDe(slug) { return SERIES.find(s => slugS(s.title) === slug) || null; }
function stVide() { return { version: 1, regles: "", resume: "", resumeCh: null, termes: [], chapitres: [] }; }
function stId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function stNorm(x) { return String(x || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); }
function stDate(iso) { return iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : ""; }
function stEl(tag, cls, html) { const e = h(tag, cls); if (html !== undefined) e.innerHTML = html; return e; }

/* ---------- GitHub (dépôt privé) ---------- */
function stCtx() { const c = chLoadCfg(); return c ? { repo: c.repo, token: c.token } : null; }
function stChemin(...p) { return ["traductions", st.slug].concat(p).join("/"); }
async function stGh(path, opts) {
  const c = stCtx(); if (!c) throw new Error("Connecte-toi avec ton jeton GitHub.");
  const res = await fetch("https://api.github.com/repos/" + c.repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/"), Object.assign({}, opts, {
    headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github+json", "Content-Type": "application/json" }
  }));
  if (res.status === 404 && !(opts && opts.method)) return null;
  if (!res.ok) {
    let m = ""; try { m = (await res.json()).message; } catch (e) {}
    if (res.status === 401) throw new Error("Jeton refusé ou expiré.");
    if (res.status === 403 || res.status === 404) throw new Error("Accès refusé : le jeton doit avoir Contents : Read and write sur " + c.repo + ".");
    const e = new Error("GitHub a répondu " + res.status + (m ? " : " + m : "")); e.status = res.status; throw e;
  }
  return res.json();
}
async function stLire(path) {
  const r = await stGh(path); if (!r) return null;
  return { json: JSON.parse(ntB64d(r.content || "")), sha: r.sha };
}
async function stEcrire(path, obj, sha, message) {
  const body = (s) => JSON.stringify({ message, content: ntB64e(JSON.stringify(obj, null, 2) + "\n"), sha: s || undefined });
  try { return (await stGh(path, { method: "PUT", body: body(sha) })).content.sha; }
  catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    const cur = await stGh(path);   // le fichier a bougé entre-temps : on reprend le sha actuel
    return (await stGh(path, { method: "PUT", body: body(cur && cur.sha) })).content.sha;
  }
}
function stSauver(message) {   // les écritures de serie.json passent l'une après l'autre
  const slug = st.slug, data = st.data;
  stFile = stFile.catch(() => {}).then(async () => {
    const sha = await stEcrire(["traductions", slug, "serie.json"].join("/"), data, st.slug === slug ? st.sha : null, message);
    if (st.slug === slug) st.sha = sha;
  });
  return stFile;
}
async function stCharger(slug) {
  st.err = ""; st.data = null; st.sha = null;
  const p = (async () => {
    try { const r = await stLire("traductions/" + slug + "/serie.json"); if (st.slug !== slug) return; st.data = Object.assign(stVide(), r ? r.json : {}); st.sha = r ? r.sha : null; }
    catch (e) { if (st.slug === slug) st.err = e.message; }
  })();
  st.chargement = p; await p;
  if (st.slug === slug) { st.chargement = null; stRendre(); }
}

/* ---------- Navigation ---------- */
function stAfficher(route) {
  stNav(route);
  if (route === null) return;
  const [slug, vue] = route.split("/");
  if (!slug) { st.slug = ""; stListe(); document.title = "Scantrad · Hub scantrad iLoza"; return; }
  const s = stSerieDe(slug);
  if (!s) { location.hash = "scantrad"; return; }
  stSetPref("last", slug);
  st.vue = ST_VUES[vue] ? vue : "traduire";
  document.title = ST_VUES[st.vue][0] + " · " + s.title + " · Hub scantrad iLoza";
  if (st.slug !== slug) { st.slug = slug; st.serie = s; stGl = { filtre: "Tous", q: "", edit: null, sous: "termes" }; if (stCtx()) { stRendre(); stCharger(slug); return; } }
  stRendre();
}
function stNav(route) {
  const sub = $("st-sub"), parts = (route || "").split("/");
  const slug = parts[0] || (route === null ? stPref().last : ""), s = slug ? stSerieDe(slug) : null;
  const tete = document.querySelector('.nav a[href="#scantrad"]');
  if (tete) { const on = route !== null && !parts[0]; tete.classList.toggle("on", on); tete.setAttribute("aria-current", on ? "page" : "false"); }
  if (!s) { sub.hidden = true; sub.textContent = ""; return; }
  sub.hidden = false; sub.textContent = "";
  const cur = h("div", "st-cur");
  if (s.cover) { const im = h("img"); im.src = s.cover; im.alt = ""; cur.append(im); } else { const i = h("span", "st-ini", s.title.charAt(0)); i.style.background = "hsl(" + hue(s.title) + " 35% 22%)"; cur.append(i); }
  cur.append(h("span", "", s.title)); cur.title = s.title; sub.append(cur);
  const vue = route !== null && parts[0] ? (ST_VUES[parts[1]] ? parts[1] : "traduire") : "";
  Object.keys(ST_VUES).forEach(k => {
    const a = h("a", vue === k ? "on" : ""); a.href = "#scantrad/" + slug + "/" + k;
    a.append(icon(ST_VUES[k][1]), document.createTextNode(ST_VUES[k][0]));
    a.setAttribute("aria-current", vue === k ? "page" : "false");
    sub.append(a);
  });
}

/* ---------- Liste des séries ---------- */
function stListe() {
  const box = $("st-in"); box.textContent = "";
  const head = stEl("div", "head", '<div><h1>Scantrad</h1><p class="sub">Choisis une série : tu pourras traduire un chapitre, relire l\'historique et tenir le glossaire.</p></div>');
  const se = stEl("div", "search", '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>');
  const q = h("input"); q.type = "search"; q.placeholder = "Chercher dans toutes les séries..."; q.setAttribute("aria-label", "Chercher une série"); se.append(q);
  head.append(se); box.append(head);
  const grid = h("div", "st-grid"), note = h("p", "note"); box.append(grid, note);
  const draw = () => {
    const t = stNorm(q.value);
    const list = t ? SERIES.filter(s => stNorm(s.title).includes(t)) : actuelles;
    grid.textContent = "";
    list.forEach(s => {
      const a = h("a", "panel st-card"); a.href = "#scantrad/" + slugS(s.title) + "/traduire";
      const t2 = h("div"); t2.style.minWidth = "0";
      t2.append(h("b", "", s.title), h("small", "", [s.team, s.chapitre ? "ch. " + s.chapitre : ""].filter(Boolean).join(" · ")));
      a.append(cover(s), t2); grid.append(a);
    });
    if (!list.length) grid.append(h("p", "empty", "Aucune série ne correspond."));
    note.textContent = t ? "" : "Tes séries en cours. Cherche pour en ouvrir une autre.";
  };
  q.oninput = draw; draw();
}

/* ---------- Page d'une série ---------- */
function stRendre() {
  const box = $("st-in"), s = st.serie; if (!s || !$("scantrad").classList.contains("on")) return;
  box.textContent = "";
  const head = h("div", "st-head"), id = h("div", "st-id"), t = h("div");
  t.style.minWidth = "0";
  t.append(h("h1", "", s.title), h("p", "sub", [s.team, s.status].filter(Boolean).join(" · ")));
  id.append(cover(s), t);
  const seg = h("div", "st-seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Onglets de la série");
  Object.keys(ST_VUES).forEach(k => {
    const b = h("button"); b.type = "button"; b.append(icon(ST_VUES[k][1]), document.createTextNode(ST_VUES[k][0]));
    if (k === "glossaire" && st.data) { const n = st.data.termes.filter(x => x.aValider).length; if (n) b.append(h("span", "st-badge", String(n))); }
    b.setAttribute("aria-pressed", String(st.vue === k));
    b.onclick = () => { location.hash = "scantrad/" + st.slug + "/" + k; };
    seg.append(b);
  });
  head.append(id, seg); box.append(head);
  if (!stCtx()) { box.append(stConnexion()); return; }
  if (st.err) { const p = h("div", "panel pad st-stack"); p.append(h("p", "st-msg err", st.err)); const b = h("button", "btn ghost", "Réessayer"); b.type = "button"; b.onclick = () => { stRendre(); stCharger(st.slug); }; p.append(b); box.append(p); return; }
  if (!st.data) { box.append(h("p", "empty", "Chargement de la série...")); return; }
  ({ traduire: stTraduire, chapitres: stChapitres, glossaire: stGlossaire })[st.vue](box);
}
function stConnexion() {
  const f = h("form", "panel pad st-f st-stack"); f.style.maxWidth = "520px"; f.autocomplete = "off";
  f.append(h("p", "sub", "Les traductions et le glossaire sont gardés dans ton dépôt privé, comme les chapitres. Connecte-toi une fois avec ton jeton GitHub."));
  const r = h("input"); r.type = "text"; r.value = "iLozAFK/scantrad-data"; r.required = true; r.id = "st-repo";
  const tk = h("input"); tk.type = "password"; tk.placeholder = "github_pat_..."; tk.required = true; tk.id = "st-token";
  const l1 = h("label", "", "Dépôt privé"); l1.htmlFor = "st-repo"; const l2 = h("label", "", "Jeton GitHub (Contents : Read and write)"); l2.htmlFor = "st-token";
  const b = h("button", "btn", "Se connecter"); b.type = "submit";
  f.append(l1, r, l2, tk, h("p", "note", "Le jeton reste dans ce navigateur. C'est le même que pour l'onglet Chapitres."), b);
  f.onsubmit = (e) => {
    e.preventDefault();
    try { localStorage.setItem(CH_KEY, JSON.stringify({ repo: r.value.trim(), token: tk.value.trim() })); } catch (err) {}
    const slug = st.slug; st.slug = ""; stAfficher(slug + "/" + st.vue);
  };
  return f;
}

/* ---------- Traduire ---------- */
function stTraduire(box) {
  const p = stPref(), wrap = h("div", "st-stack");
  if (stJob && stJob.slug !== st.slug && (stJob.etat === "cours" || stJob.etat === "a-sauver")) {
    const s = stSerieDe(stJob.slug), a = h("a", "btn", "Y retourner"); a.href = "#scantrad/" + stJob.slug + "/traduire";
    const pn = h("div", "panel pad st-stack"); pn.append(h("p", "", "Une traduction de « " + (s ? s.title : stJob.slug) + " » " + (stJob.etat === "cours" ? "est en cours" : "attend d'être enregistrée") + ". Une seule traduction à la fois."), a);
    box.append(pn); return;
  }
  const dernier = st.data.chapitres.reduce((m, c) => Math.max(m, +c.num || 0), 0);
  if (!stJob || stJob.slug !== st.slug) stJob = { slug: st.slug, pages: [], texte: "", etat: "pret", num: dernier ? dernier + 1 : (st.serie.chapitre ? st.serie.chapitre + 1 : 1), msg: "", bulles: 0, termes: [] };
  const J = stJob, occupe = J.etat === "cours";

  /* réglages */
  const reg = h("div", "panel pad st-f st-stack");
  const row = h("div", "st-row");
  const champ = (lbl, el) => { const d = h("div", "st-f"); const l = h("label", "", lbl); el.id = "st-" + lbl.replace(/\W+/g, "").toLowerCase(); l.htmlFor = el.id; d.append(l, el); return d; };
  const num = h("input"); num.type = "number"; num.min = "0"; num.step = "0.1"; num.value = J.num; num.oninput = () => { J.num = num.value; };
  const lang = h("select"); ST_LANGUES.forEach(x => { const o = h("option", "", x.charAt(0).toUpperCase() + x.slice(1)); o.value = x; lang.append(o); }); lang.value = p.langue; lang.onchange = () => stSetPref("langue", lang.value);
  const tr = h("input"); tr.type = "text"; tr.value = p.traducteur; tr.oninput = () => stSetPref("traducteur", tr.value.trim());
  row.append(champ("Chapitre", num), champ("Langue des pages", lang), champ("Traducteur", tr));
  const cle = h("input"); cle.type = "password"; cle.placeholder = "sk-ant-..."; cle.value = stCle();
  cle.onchange = () => { try { cle.value.trim() ? localStorage.setItem(ST_KEY_API, cle.value.trim()) : localStorage.removeItem(ST_KEY_API); } catch (e) {} };
  const cleBox = champ("Clé API Claude", cle);
  cleBox.append(h("p", "note", "Gardée dans ce navigateur, partagée avec l'outil OCR de l'admin."));
  const pre = h("label", "st-check"), cb = h("input"); cb.type = "checkbox"; cb.checked = p.prefixes; cb.onchange = () => stSetPref("prefixes", cb.checked);
  pre.append(cb, document.createTextNode("Préfixes de locuteur (ex : CM: ...) quand on sait qui parle"));
  reg.append(row, cleBox, pre);
  [num, lang, tr, cle, cb].forEach(x => { x.disabled = occupe; });

  /* pages */
  const pg = h("div", "panel pad");
  const input = h("input"); input.type = "file"; input.multiple = true; input.accept = "image/*,.zip"; input.hidden = true;
  const drop = h("div", "st-drop"); drop.tabIndex = 0; drop.setAttribute("role", "button");
  drop.innerHTML = "<b>Glisse les pages du chapitre ici</b><span>Images (jpg, png, webp) ou un .zip, dans l'ordre des noms de fichiers</span>";
  const ajouter = async (files) => {
    if (occupe) return;
    try { J.pages = await stPages(Array.from(files)); J.texte = ""; J.etat = "pret"; J.msg = J.pages.length ? "" : "Aucune image trouvée."; }
    catch (e) { J.msg = e.message; }
    stRendre();
  };
  drop.onclick = () => !occupe && input.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drop.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); ajouter(e.dataTransfer.files); };
  input.onchange = () => ajouter(input.files);
  const pages = h("div", "st-pages");
  J.pages.forEach((f, i) => { const c = h("span", "st-page " + (f.etat || ""), String(i + 1)); c.title = f.name + (f.err ? " : " + f.err : ""); pages.append(c); });
  pg.append(drop, input, pages);

  /* lancement */
  const act = h("div", "st-actions");
  const msg = h("span", "st-msg" + (J.etat === "erreur" ? " err" : J.etat === "fini" ? " ok" : "")); msg.style.marginRight = "auto"; msg.textContent = J.msg;
  const go = h("button", "btn"); go.type = "button"; go.append(icon("lang"), document.createTextNode(occupe ? "Traduction en cours..." : "Traduire " + (J.pages.length ? J.pages.length + " pages" : "")));
  go.disabled = occupe || !J.pages.length;
  go.onclick = () => stLancer();
  act.append(msg);
  if (occupe) { const stop = h("button", "btn ghost", "Arrêter"); stop.type = "button"; stop.onclick = () => { J.stop = true; stop.disabled = true; }; act.append(stop); }
  act.append(go);
  const bar = h("div", "st-bar"), bi = h("i"); bar.append(bi);
  const fait = J.pages.filter(f => f.etat === "ok" || f.etat === "err").length;
  bi.style.width = J.pages.length ? Math.round(fait / J.pages.length * 100) + "%" : "0";
  if (!occupe && !fait) bar.hidden = true;

  /* résultat */
  const res = h("div", "panel");
  const out = h("div", "st-out"); out.id = "st-out"; out.textContent = J.texte;
  const foot = h("div", "st-foot");
  const cp = h("button", "btn ghost", "Copier"); cp.type = "button"; cp.disabled = !J.texte;
  cp.onclick = () => stCopier(J.texte, cp);
  const dl = h("button", "btn ghost", "Télécharger .txt"); dl.type = "button"; dl.disabled = !J.texte;
  dl.onclick = () => stTelecharger(st.serie.title + " - chapitre " + J.num + ".txt", J.texte);
  foot.append(cp, dl);
  if (J.texte) foot.append(h("span", "gchip plain", plural(J.pages.filter(f => f.etat === "ok").length, "page traduite", "pages traduites") + " · " + plural(J.bulles, "bulle", "bulles")));
  if (J.etat === "a-sauver") { const r = h("button", "btn", "Réessayer l'enregistrement"); r.type = "button"; r.onclick = () => stFinir(); foot.append(r); }
  res.append(out, foot);

  wrap.append(reg, pg, act, bar, res);
  box.append(wrap);
}
async function stPages(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === "application/zip") {
      if (!window.JSZip) await chScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
      const z = await window.JSZip.loadAsync(f);
      for (const e of Object.values(z.files)) {
        if (e.dir || !/\.(jpe?g|png|webp|gif|bmp)$/i.test(e.name) || /(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
        const ext = e.name.split(".").pop().toLowerCase(), type = ext === "jpg" ? "image/jpeg" : "image/" + ext;
        out.push({ name: e.name.split("/").pop(), path: e.name, blob: new Blob([await e.async("arraybuffer")], { type }) });
      }
    } else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name)) out.push({ name: f.name, path: f.name, blob: f });
  }
  const coll = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
  return out.sort((a, b) => coll.compare(a.path, b.path));
}

/* Le contexte envoyé à chaque page : glossaire, règles, résumé */
function stContexte() {
  const d = st.data, lignes = [];
  if (d.regles.trim()) lignes.push("RÈGLES DE LA SÉRIE (à respecter) :\n" + d.regles.trim());
  if (d.resume.trim()) lignes.push("RÉSUMÉ DE L'HISTOIRE JUSQU'ICI :\n" + d.resume.trim());
  const g = d.termes.filter(t => t.vo).map(t => {
    let l = "- " + t.vo + (t.variantes && t.variantes.length ? " (aussi : " + t.variantes.join(", ") + ")" : "") + " → " + (t.garder ? t.vo + " [ne pas traduire]" : (t.fr || "?"));
    const info = [t.cat, t.genre, t.notes].filter(Boolean).join(", ");
    return l + (info ? " — " + info : "") + (t.aValider ? " (proposé, pas encore validé)" : "");
  });
  if (g.length) lignes.push("GLOSSAIRE (traductions imposées) :\n" + g.join("\n"));
  return lignes.join("\n\n");
}
function stPrompt(langue, prefixes, nPage, nTot, suite, ctx) {
  return `Tu es un traducteur professionnel de scantrad (manhwa, webtoon) vers le français. Tu traduis la page ${nPage}/${nTot} d'un chapitre de « ${st.serie.title} ». Les images sont des bandes successives d'une même page, de haut en bas. Le texte source est en ${langue}.

${ctx || "(Pas encore de glossaire ni de règles pour cette série.)"}

${suite ? "FIN DE LA TRADUCTION DES PAGES PRÉCÉDENTES (pour la continuité, ne la répète pas) :\n" + suite + "\n\n" : ""}CONSIGNES :
- Traduis chaque bulle et chaque boîte de narration, dans l'ordre de lecture (haut vers bas, puis gauche vers droite).
- Français naturel et vivant, comme une bonne version scantrad : registre adapté au personnage, tutoiement ou vouvoiement cohérent, ponctuation française (espace avant ? ! : ;).
- Respecte strictement le glossaire et les règles. Un terme marqué [ne pas traduire] reste tel quel.
- Ignore les onomatopées purement sonores, les filigranes, les crédits et le texte illisible.
- Regroupe dans un même bloc les bulles consécutives du même locuteur ; chaque bulle reste un élément séparé de "bulles".
- "locuteur" : ${prefixes ? "les initiales du personnage qui parle (ex : Chung Myung → CM), seulement si tu en es sûr grâce au glossaire, au contexte ou à l'image ; sinon une chaîne vide. Narration : chaîne vide." : "laisse toujours une chaîne vide."}
- "termes" : les noms propres et termes récurrents (personnages, lieux, techniques, factions, objets) qui apparaissent sur cette page et qui NE SONT PAS déjà dans le glossaire. Donne la forme source exacte, ta traduction, une catégorie parmi ${ST_CATS.join(", ")}, le genre si c'est un personnage (Homme, Femme ou vide), une note courte qui aidera la suite, et la citation source où il apparaît. Tableau vide s'il n'y en a pas.
- Si la page n'a aucun texte, "blocs" est un tableau vide.

Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"blocs":[{"locuteur":"CM","bulles":["Première bulle.","Deuxième bulle du même personnage."]}],"termes":[{"vo":"HWASAN SECT","fr":"secte du mont Hua","categorie":"Faction","genre":"","note":"La secte du héros","citation":"WE ARE THE HWASAN SECT!"}]}`;
}

async function stClaude(content, system, maxTokens) {
  const key = stCle();
  if (!key) throw new Error("Clé API manquante : colle ta clé Claude dans le champ « Clé API Claude ».");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true", "x-api-key": key,
      "anthropic-beta": "server-side-fallback-2026-07-01"   // repli automatique si le modèle refuse une page
    },
    body: JSON.stringify({ model: ST_MODEL, max_tokens: maxTokens || 16000, output_config: { effort: ST_EFFORT }, fallbacks: "default", system, messages: [{ role: "user", content }] })
  });
  if (!res.ok) {
    let m = "HTTP " + res.status; try { const e = await res.json(); m = (e.error && (e.error.message || e.error.type)) || m; } catch (e) {}
    throw new Error(res.status === 401 ? "Clé API refusée." : m);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("Le modèle a refusé cette page.");
  const tb = (data.content || []).find(b => b.type === "text");
  return { texte: (tb && tb.text) || "", tronque: data.stop_reason === "max_tokens" };
}
function stJson(raw) {
  let t = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
  try { return JSON.parse(t); } catch (e) { return null; }
}
function stChargerImage(blob) {
  return new Promise((ok, ko) => { const u = URL.createObjectURL(blob), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); ko(new Error("Image illisible")); }; im.src = u; });
}
function stBande(img, y, hSrc, w, outW, outH) {
  return new Promise(ok => {
    const c = document.createElement("canvas"); c.width = outW; c.height = outH;
    c.getContext("2d").drawImage(img, 0, y, w, hSrc, 0, 0, outW, outH);
    c.toBlob(b => ok(b), "image/jpeg", 0.9);
  });
}
async function stBandes(blob) {   // une page webtoon très haute → bandes à hauteur native, lisibles par le modèle
  const img = await stChargerImage(blob), w = img.naturalWidth, H = img.naturalHeight;
  const sc = w > ST_MAX_DIM ? ST_MAX_DIM / w : 1, outW = Math.round(w * sc);
  const n = Math.max(1, Math.ceil(H * sc / ST_BAND_H)), bh = Math.ceil(H / n), out = [];
  for (let i = 0; i < n; i++) {
    const y = i * bh, hh = Math.min(bh, H - y); if (hh <= 0) break;
    const b = await stBande(img, y, hh, w, outW, Math.max(1, Math.round(hh * sc)));
    out.push(await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result.split(",")[1]); r.onerror = () => ko(new Error("Lecture impossible")); r.readAsDataURL(b); }));
  }
  return out;
}
function stFormater(blocs, prefixes) {
  return (blocs || []).map(b => {
    const bulles = (b.bulles || []).map(x => String(x).replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    if (!bulles.length) return "";
    const loc = prefixes && b.locuteur ? String(b.locuteur).trim() : "";
    return (loc ? loc + ": " : "") + bulles.join("\n// ");
  }).filter(Boolean).join("\n\n");
}

function stMaj() { if (stJob && st.slug === stJob.slug && st.vue === "traduire") stRendre(); }
async function stLancer() {
  const J = stJob, slug = st.slug, prefs = stPref();
  if (!stCle()) { J.msg = "Colle ta clé API Claude d'abord."; J.etat = "erreur"; stRendre(); return; }
  if (!(J.num !== "" && +J.num >= 0)) { J.msg = "Indique le numéro du chapitre."; J.etat = "erreur"; stRendre(); return; }
  if (st.data.chapitres.some(c => String(c.num) === String(+J.num)) && !confirm("Le chapitre " + (+J.num) + " est déjà dans l'historique. Le remplacer ?")) return;
  J.num = +J.num; J.etat = "cours"; J.stop = false; J.texte = ""; J.bulles = 0; J.termes = []; J.prefixes = prefs.prefixes;
  J.pages.forEach(f => { f.etat = ""; f.err = ""; });
  const ctx = stContexte(), system = "Tu traduis des manhwas pour une équipe de scantrad française. Tu réponds uniquement en JSON valide.";
  let ko = 0;
  for (let i = 0; i < J.pages.length; i++) {
    if (J.stop) break;
    const f = J.pages[i]; f.etat = "run"; J.msg = "Page " + (i + 1) + " sur " + J.pages.length + "..."; stMaj();
    try {
      const bandes = await stBandes(f.blob), blocs = [], termes = [];
      for (let k = 0; k < bandes.length; k += ST_MAX_IMG) {
        const suite = J.texte.split("\n").slice(-12).join("\n");
        const content = bandes.slice(k, k + ST_MAX_IMG).map(d => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } }));
        content.push({ type: "text", text: stPrompt(prefs.langue, J.prefixes, i + 1, J.pages.length, suite, ctx) });
        const r = await stClaude(content, system, 16000), j = stJson(r.texte);
        if (!j) throw new Error(r.tronque ? "Réponse coupée (page trop dense)" : "Réponse illisible");
        blocs.push(...(j.blocs || [])); termes.push(...(j.termes || []));
      }
      const txt = stFormater(blocs, J.prefixes);
      if (txt) J.texte += (J.texte ? "\n\n" : "") + txt;
      J.bulles += blocs.reduce((n, b) => n + (b.bulles || []).filter(x => String(x).trim()).length, 0);
      termes.forEach(t => J.termes.push(Object.assign({ page: i + 1 }, t)));
      f.etat = "ok";
    } catch (e) { f.etat = "err"; f.err = e.message; ko++; if (/Clé API/.test(e.message)) { J.msg = e.message; J.etat = "erreur"; stMaj(); return; } }
    stMaj();
  }
  if (!J.texte) { J.etat = "erreur"; J.msg = "Aucune page n'a pu être traduite." + (ko ? " Survole une page en rouge pour voir l'erreur." : ""); stMaj(); return; }
  J.ko = ko;
  await stFinir();
}

/* Enregistre le chapitre, propose les nouveaux termes, met à jour le résumé */
async function stFinir() {
  const J = stJob, slug = J.slug;
  if (st.slug !== slug || !st.data) { J.etat = "a-sauver"; J.msg = "Reviens sur la série pour enregistrer ce chapitre."; return; }
  J.etat = "cours"; J.msg = "Enregistrement du chapitre..."; stMaj();
  const d = st.data, ok = J.pages.filter(f => f.etat === "ok").length;
  const entree = { num: J.num, date: new Date().toISOString(), pages: ok, bulles: J.bulles, traducteur: stPref().traducteur || "" };
  try {
    const path = stChemin("chapitres", J.num + ".json"), avant = await stGh(path);
    await stEcrire(path, Object.assign({}, entree, { modele: ST_MODEL, texte: J.texte }), avant && avant.sha, st.serie.title + " : traduction du chapitre " + J.num);
    d.chapitres = d.chapitres.filter(c => String(c.num) !== String(J.num)).concat([entree]).sort((a, b) => b.num - a.num);
    const connus = new Set(); d.termes.forEach(t => [t.vo].concat(t.variantes || []).forEach(v => connus.add(stNorm(v))));
    let n = 0;
    J.termes.forEach(t => {
      const k = stNorm(t.vo); if (!k || connus.has(k)) return; connus.add(k); n++;
      d.termes.push({ id: stId(), vo: String(t.vo).trim(), fr: String(t.fr || "").trim(), cat: ST_CATS.includes(t.categorie) ? t.categorie : "Autre", genre: /^(Homme|Femme)$/.test(t.genre) ? t.genre : "", variantes: [], notes: String(t.note || "").trim(), citation: String(t.citation || "").trim(), vu: J.num, aValider: true });
    });
    await stSauver(st.serie.title + " : chapitre " + J.num + (n ? ", " + n + " termes à valider" : ""));
    J.msg = "Chapitre " + J.num + " enregistré" + (n ? ", " + plural(n, "terme proposé", "termes proposés") + " dans le glossaire" : "") + (J.ko ? ". " + plural(J.ko, "page n'a pas pu être traduite", "pages n'ont pas pu être traduites") + " (en rouge)" : "") + ". Mise à jour du résumé...";
    J.etat = "cours"; stMaj();
  } catch (e) { J.etat = "a-sauver"; J.msg = "La traduction est là, mais l'enregistrement a échoué : " + e.message; stMaj(); return; }
  try {
    const r = await stClaude([{ type: "text", text: `Voici le résumé actuel de « ${st.serie.title} » puis la traduction française du chapitre ${J.num}. Réécris le résumé de l'histoire jusqu'à la fin de ce chapitre, en français, en 120 à 220 mots, centré sur la situation actuelle et les enjeux en cours, avec les noms tels qu'ils sont traduits. Réponds uniquement avec le résumé, sans titre.\n\nRÉSUMÉ ACTUEL :\n${d.resume || "(aucun)"}\n\nCHAPITRE ${J.num} :\n${J.texte}` }], "Tu tiens la fiche d'une série pour une équipe de scantrad.", 4000);
    if (r.texte.trim() && st.slug === slug) { d.resume = r.texte.trim(); d.resumeCh = J.num; await stSauver(st.serie.title + " : résumé mis à jour au chapitre " + J.num); }
    J.msg = J.msg.replace(" Mise à jour du résumé...", " Résumé mis à jour.");
  } catch (e) { J.msg = J.msg.replace(" Mise à jour du résumé...", " Le résumé n'a pas pu être mis à jour (" + e.message + ")."); }
  J.etat = "fini"; stMaj();
}
async function stCopier(txt, btn) {
  try { await navigator.clipboard.writeText(txt); } catch (e) { const t = h("textarea"); t.value = txt; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  const old = btn.textContent; btn.textContent = "Copié"; setTimeout(() => { btn.textContent = old; }, 1400);
}
function stTelecharger(nom, txt) {
  const a = h("a"); a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain;charset=utf-8" })); a.download = nom.replace(/[\\/:*?"<>|]/g, "-");
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- Chapitres ---------- */
function stChapitres(box) {
  const wrap = h("div"); wrap.style.maxWidth = "980px";
  const list = st.data.chapitres.slice().sort((a, b) => b.num - a.num);
  if (!list.length) { wrap.append(h("p", "empty", "Aucun chapitre traduit pour l'instant. Lance une traduction depuis l'onglet Traduire.")); box.append(wrap); return; }
  const cache = {};
  const texte = async (c) => {
    if (cache[c.num] === undefined) { const r = await stLire(stChemin("chapitres", c.num + ".json")); if (!r) throw new Error("Fichier du chapitre " + c.num + " introuvable."); cache[c.num] = r.json.texte || ""; }
    return cache[c.num];
  };
  list.forEach(c => {
    const row = h("div", "panel st-ch"), t = h("div", "st-t");
    const meta = h("div", "st-meta");
    const m = (ic, txt) => { const s = h("span"); s.append(icon(ic), document.createTextNode(txt)); return s; };
    meta.append(m("book", plural(c.pages, "page", "pages")), m("lang", plural(c.bulles, "bulle", "bulles")));
    if (c.traducteur) meta.append(m("users", c.traducteur));
    if (c.date) meta.append(m("clock", stDate(c.date)));
    t.append(h("b", "", "Chapitre " + c.num), meta);
    const lire = h("button", "btn ghost", "Lire"); lire.type = "button";
    const cp = h("button", "btn ghost", "Copier"); cp.type = "button";
    const zone = h("div", "panel st-out st-read"); zone.hidden = true;
    lire.onclick = async () => {
      if (!zone.hidden) { zone.hidden = true; lire.textContent = "Lire"; return; }
      lire.disabled = true;
      try { zone.textContent = await texte(c); zone.hidden = false; lire.textContent = "Fermer"; } catch (e) { alert(e.message); }
      lire.disabled = false;
    };
    cp.onclick = async () => { cp.disabled = true; try { await stCopier(await texte(c), cp); } catch (e) { alert(e.message); } cp.disabled = false; };
    row.append(t, lire, cp);
    wrap.append(row, zone);
  });
  box.append(wrap);
}

/* ---------- Glossaire ---------- */
function stGlossaire(box) {
  const d = st.data, wrap = h("div"); wrap.style.maxWidth = "980px";
  const att = d.termes.filter(t => t.aValider).length;
  const seg = h("div", "st-seg"); seg.style.marginBottom = "18px";
  [["termes", "Termes (" + d.termes.length + ")"], ["fiche", "Fiche de la série"]].forEach(([k, l]) => {
    const b = h("button", "", l); b.type = "button"; b.setAttribute("aria-pressed", String(stGl.sous === k));
    if (k === "termes" && att) b.append(document.createTextNode(" "), h("span", "st-badge", String(att)));
    b.onclick = () => { stGl.sous = k; stRendre(); }; seg.append(b);
  });
  wrap.append(seg);
  (stGl.sous === "fiche" ? stFiche : stTermes)(wrap);
  box.append(wrap);
}
function stTermes(wrap) {
  const d = st.data;
  const tools = h("div", "st-tools");
  const se = stEl("div", "search", '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>');
  const q = h("input"); q.type = "search"; q.placeholder = "Rechercher un terme..."; q.value = stGl.q; q.setAttribute("aria-label", "Rechercher un terme"); se.append(q);
  const nv = h("button", "btn", "Nouveau terme"); nv.type = "button";
  nv.onclick = () => { stGl.edit = { id: "", vo: "", fr: "", cat: "Personnage", genre: "", variantes: [], garder: false, notes: "", citation: "", aValider: false }; stRendre(); };
  tools.append(se, nv); wrap.append(tools);
  const chips = h("div", "chips");
  const cnt = { "Tous": d.termes.length, "À valider": d.termes.filter(t => t.aValider).length };
  ST_CATS.forEach(c => { cnt[c] = d.termes.filter(t => t.cat === c).length; });
  Object.keys(cnt).forEach(k => {
    if (!cnt[k] && k !== "Tous" && stGl.filtre !== k) return;
    const b = h("button", "chip", k + " " + cnt[k]); b.type = "button"; b.setAttribute("aria-pressed", String(stGl.filtre === k));
    b.onclick = () => { stGl.filtre = k; stRendre(); }; chips.append(b);
  });
  wrap.append(chips);
  if (stGl.edit) wrap.append(stEditeur(stGl.edit));
  const list = h("div"); wrap.append(list);
  const draw = () => {
    const t = stNorm(q.value); stGl.q = q.value;
    const xs = d.termes.filter(x => (stGl.filtre === "Tous" || (stGl.filtre === "À valider" ? x.aValider : x.cat === stGl.filtre)) &&
      (!t || [x.vo, x.fr, x.notes].concat(x.variantes || []).some(v => stNorm(v).includes(t))))
      .sort((a, b) => (b.aValider - a.aValider) || ((+b.vu || 0) - (+a.vu || 0)) || a.vo.localeCompare(b.vo));
    list.textContent = "";
    if (!xs.length) { list.append(h("p", "empty", d.termes.length ? "Aucun terme ne correspond." : "Le glossaire est vide. Les termes repérés pendant les traductions arriveront ici, à valider.")); return; }
    xs.forEach(x => {
      const row = h("div", "st-term"); row.tabIndex = 0;
      const tt = h("div", "st-t"), l1 = h("div");
      l1.append(h("span", "vo", x.vo), h("span", "sep", "›"), h("span", "fr", x.garder ? x.vo : (x.fr || "à traduire")));
      tt.append(l1);
      const info = [x.notes, x.citation ? "« " + x.citation + " »" : "", x.variantes && x.variantes.length ? "aussi : " + x.variantes.join(", ") : "", x.vu ? "vu au ch. " + x.vu : ""].filter(Boolean).join(" · ");
      if (info) tt.append(h("p", "", info));
      const pills = h("div", "st-pills");
      if (x.aValider) pills.append(h("span", "gchip wait", "À valider"));
      if (x.garder) pills.append(h("span", "gchip keep", "Tel quel"));
      if (x.genre) pills.append(h("span", "gchip plain", x.genre));
      pills.append(h("span", "gchip", x.cat));
      if (x.aValider) {
        const ok = h("button", "st-ok", "✓"); ok.type = "button"; ok.title = "Valider ce terme"; ok.setAttribute("aria-label", "Valider " + x.vo);
        ok.onclick = (e) => { e.stopPropagation(); x.aValider = false; stSauver(st.serie.title + " : glossaire, " + x.vo + " validé").catch(err => alert(err.message)); stRendre(); };
        pills.append(ok);
      }
      row.append(tt, pills);
      row.onclick = () => { stGl.edit = JSON.parse(JSON.stringify(x)); stRendre(); window.scrollTo({ top: 0, behavior: "smooth" }); };
      row.onkeydown = (e) => { if (e.key === "Enter") row.onclick(); };
      list.append(row);
    });
  };
  q.oninput = draw; draw();
}
function stEditeur(x) {
  const f = h("form", "panel pad st-edit st-stack"); f.style.marginBottom = "16px"; f.autocomplete = "off";
  const champ = (lbl, el, id) => { const d = h("div", "st-f"); const l = h("label", "", lbl); el.id = "st-e-" + id; l.htmlFor = el.id; d.append(l, el); return d; };
  const vo = h("input"); vo.type = "text"; vo.value = x.vo; vo.required = true;
  const fr = h("input"); fr.type = "text"; fr.value = x.fr;
  const cat = h("select"); ST_CATS.forEach(c => cat.append(h("option", "", c))); cat.value = x.cat;
  const r1 = h("div", "st-row"); r1.append(champ("Terme source", vo, "vo"), champ("Traduction", fr, "fr"), champ("Catégorie", cat, "cat"));
  const va = h("input"); va.type = "text"; va.value = (x.variantes || []).join(", "); va.placeholder = "séparées par des virgules";
  const gd = h("label", "st-check"), gc = h("input"); gc.type = "checkbox"; gc.checked = !!x.garder; gd.append(gc, document.createTextNode("Ne pas traduire (garder tel quel)"));
  gc.onchange = () => { fr.disabled = gc.checked; }; fr.disabled = gc.checked;
  const r2 = h("div", "st-row"); const gdBox = h("div", "st-f"); gdBox.style.alignSelf = "end"; gdBox.style.paddingBottom = "8px"; gdBox.append(gd);
  r2.append(champ("Autres écritures (variantes)", va, "va"), gdBox);
  let genre = x.genre || "";
  const gs = h("div", "st-seg"); gs.setAttribute("role", "group"); gs.setAttribute("aria-label", "Genre");
  const drawG = () => { gs.textContent = ""; [["", "—"], ["Femme", "Femme"], ["Homme", "Homme"]].forEach(([v, l]) => { const b = h("button", "", l); b.type = "button"; b.setAttribute("aria-pressed", String(genre === v)); b.onclick = () => { genre = v; drawG(); }; gs.append(b); }); };
  drawG();
  const gBox = h("div", "st-f"); gBox.append(h("span", "st-lbl", "Genre"), gs);
  const no = h("input"); no.type = "text"; no.value = x.notes || ""; no.placeholder = "Ce que l'IA doit savoir : rôle, registre, tutoiement...";
  const r3 = h("div", "st-row"); r3.style.gridTemplateColumns = "auto minmax(0, 1fr)"; r3.append(gBox, champ("Notes pour l'IA", no, "no"));
  const act = h("div", "st-actions");
  if (x.id) {
    const del = h("button", "btn ghost", "Supprimer"); del.type = "button"; del.style.marginRight = "auto";
    del.onclick = () => { if (!confirm("Supprimer « " + x.vo + " » du glossaire ?")) return; st.data.termes = st.data.termes.filter(t => t.id !== x.id); stGl.edit = null; stSauver(st.serie.title + " : glossaire, " + x.vo + " supprimé").catch(e => alert(e.message)); stRendre(); };
    act.append(del);
  }
  const an = h("button", "btn ghost", "Annuler"); an.type = "button"; an.onclick = () => { stGl.edit = null; stRendre(); };
  const ok = h("button", "btn", "Valider"); ok.type = "submit";
  act.append(an, ok);
  f.append(r1, r2, r3, act);
  f.onsubmit = (e) => {
    e.preventDefault();
    const n = { id: x.id || stId(), vo: vo.value.trim(), fr: fr.value.trim(), cat: cat.value, genre, variantes: va.value.split(",").map(s => s.trim()).filter(Boolean), garder: gc.checked, notes: no.value.trim(), citation: x.citation || "", vu: x.vu || "", aValider: false };
    if (!n.vo) return;
    const dup = st.data.termes.find(t => t.id !== n.id && [t.vo].concat(t.variantes || []).some(v => stNorm(v) === stNorm(n.vo)));
    if (dup && !confirm("« " + n.vo + " » existe déjà (" + dup.vo + "). Ajouter quand même ?")) return;
    const i = st.data.termes.findIndex(t => t.id === n.id);
    if (i >= 0) st.data.termes[i] = n; else st.data.termes.push(n);
    stGl.edit = null;
    stSauver(st.serie.title + " : glossaire, " + n.vo).catch(err => alert(err.message));
    stRendre();
  };
  setTimeout(() => (x.id ? fr : vo).focus(), 0);
  return f;
}
function stFiche(wrap) {
  const d = st.data, f = h("form", "st-stack");
  const p1 = h("div", "panel pad st-f"), l1 = h("label", "", "Règles de la série"), rg = h("textarea");
  rg.id = "st-regles"; l1.htmlFor = rg.id; rg.value = d.regles;
  rg.placeholder = "Une règle par ligne, par exemple :\nLady → Dame\nSir → messire\nDiela et Derrick se tutoient\nLes noms de techniques restent en anglais";
  p1.append(l1, rg);
  const p2 = h("div", "panel pad st-f"), hd = h("div", "st-sum-h"), l2 = h("label", "", "Résumé de l'histoire"), rs = h("textarea");
  rs.id = "st-resume"; l2.htmlFor = rs.id; rs.value = d.resume; rs.style.minHeight = "200px";
  rs.placeholder = "Mis à jour par l'IA après chaque chapitre traduit. Tu peux le corriger.";
  hd.append(l2); if (d.resumeCh) hd.append(h("small", "", "mis à jour par l'IA au ch. " + d.resumeCh));
  p2.append(hd, rs);
  const act = h("div", "st-actions"), msg = h("span", "st-msg"); msg.style.marginRight = "auto";
  const ok = h("button", "btn", "Enregistrer la fiche"); ok.type = "submit"; ok.disabled = true;
  [rg, rs].forEach(t => { t.oninput = () => { ok.disabled = false; msg.textContent = ""; }; });
  act.append(msg, ok);
  f.append(p1, p2, act);
  f.onsubmit = async (e) => {
    e.preventDefault(); ok.disabled = true; msg.className = "st-msg"; msg.textContent = "Enregistrement...";
    d.regles = rg.value; d.resume = rs.value;
    try { await stSauver(st.serie.title + " : fiche de la série"); msg.className = "st-msg ok"; msg.textContent = "Fiche enregistrée."; }
    catch (err) { msg.className = "st-msg err"; msg.textContent = err.message; ok.disabled = false; }
  };
  wrap.append(f);
}

/* index.html a déjà affiché l'onglet avant que ce fichier ne soit chargé */
(function () { const n = decodeURIComponent(location.hash.slice(1)); stAfficher(n === "scantrad" || n.indexOf("scantrad/") === 0 ? n.slice(9) : null); })();
