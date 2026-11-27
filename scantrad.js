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
const ST_CATS = ["Personnage", "Constellation", "Roi Démon", "Fable", "Vocabulaire", "Technique", "Lieu", "Faction", "Objet", "Autre"];
function stCats() { const s = new Set(ST_CATS); ((st.data && st.data.termes) || []).forEach(t => t.cat && s.add(t.cat)); return Array.from(s); }
const ST_VUES = { traduire: ["Traduire", "lang"], chapitres: ["Chapitres", "list"], check: ["Check", "pen"], glossaire: ["Glossaire", "open"] };
const ST_LANGUES = ["anglais", "coréen", "japonais", "chinois"];

let st = { slug: "", vue: "", serie: null, data: null, sha: null, chargement: null, err: "" };
let stJob = null;        // traduction en cours (survit aux changements d'onglet)
let stGl = { filtre: "Tous", q: "", edit: null, sous: "termes" };
let stFile = Promise.resolve();

function stPref() { try { return Object.assign({ prefixes: true, langue: "anglais", traducteur: "iLoza", last: "" }, JSON.parse(localStorage.getItem(ST_PREF) || "{}")); } catch (e) { return { prefixes: true, langue: "anglais", traducteur: "iLoza", last: "" }; } }
function stSetPref(k, v) { try { const p = stPref(); p[k] = v; localStorage.setItem(ST_PREF, JSON.stringify(p)); } catch (e) {} }
function stCle() { try { return localStorage.getItem(ST_KEY_API) || ""; } catch (e) { return ""; } }
function stSerieDe(slug) { return SERIES.find(s => slugS(s.title) === slug) || null; }
function stVide() { return { version: 1, regles: "", resume: "", resumeCh: null, termes: [], relations: [], chapitres: [], config: { source: "images", consignes: "" } }; }
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
async function stTexteRepo(path) {   // fichier texte du dépôt (raws, novels), lu tel quel
  const r = await stGh(path); return r && r.content ? ntB64d(r.content) : "";
}
function stRawsStockes() { const c = (st.data && st.data.config) || {}; return c.dossier && c.raws && c.raws.length ? c : null; }
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
    for (const k of Object.keys(stImgPending).filter(k => k.indexOf(slug + "/") === 0)) {   // portraits ajoutés depuis le dernier enregistrement
      const path = "traductions/" + k, av = await stGh(path);
      await stGh(path, { method: "PUT", body: JSON.stringify({ message: "Portrait", content: stImgPending[k].b64, sha: av ? av.sha : undefined }) });
      stImgCache[k] = Promise.resolve(stImgPending[k].url); delete stImgPending[k];
    }
    const sha = await stEcrire(["traductions", slug, "serie.json"].join("/"), data, st.slug === slug ? st.sha : null, message);
    if (st.slug === slug) st.sha = sha;
  });
  return stFile;
}
async function stCharger(slug) {
  st.err = ""; st.data = null; st.sha = null;
  const p = (async () => {
    try { const r = await stLire("traductions/" + slug + "/serie.json"); if (st.slug !== slug) return; st.data = Object.assign(stVide(), r ? r.json : {}); st.data.config = Object.assign({ source: "images", consignes: "" }, st.data.config); st.sha = r ? r.sha : null; }
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
let stDerniers = {};   // série -> dernier chapitre traduit, lu dans serie.json
function stChapLabel(s) { const n = Math.max(+s.chapitre || 0, stDerniers[slugS(s.title)] || 0); return n ? "ch. " + n : ""; }
function stMajChapitres(zone, list) {   // met le nombre de chapitres à jour avec ce qui est traduit ou vérifié
  if (!stCtx()) return;
  list.forEach(async (s) => {
    const sl = slugS(s.title);
    try {
      const r = await stGh("traductions/" + sl + "/serie.json"); if (!r) return;
      const j = JSON.parse(ntB64d(r.content || "")), m = (j.chapitres || []).reduce((a, c) => Math.max(a, +c.num || 0), 0);
      stDerniers[sl] = m;
      zone.querySelectorAll('small[data-slug="' + sl + '"]').forEach(e => { e.textContent = stChapLabel(s); });
    } catch (e) {}
  });
}
function stListe() {
  const box = $("st-in"); box.textContent = "";
  const head = stEl("div", "head", '<div><h1>Scantrad</h1><p class="sub">Choisis une série : tu pourras traduire un chapitre, relire l\'historique et tenir le glossaire.</p></div>');
  const se = stEl("div", "search", '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>');
  const q = h("input"); q.type = "search"; q.placeholder = "Chercher dans toutes les séries..."; q.setAttribute("aria-label", "Chercher une série"); se.append(q);
  head.append(se); box.append(head);
  const groupes = h("div"), note = h("p", "note"); box.append(groupes, note);
  const ordre = ["Poséidon Scans", "Ortega Scans"];
  const draw = () => {
    const t = stNorm(q.value);
    const list = t ? SERIES.filter(s => stNorm(s.title).includes(t)) : actuelles;
    groupes.textContent = "";
    const equipes = Array.from(new Set(list.map(s => s.team || "Autres"))).sort((x, y) => (ordre.indexOf(x) + 1 || 99) - (ordre.indexOf(y) + 1 || 99) || x.localeCompare(y));
    equipes.forEach(eq => {
      const sec = h("div", "st-team"), n = list.filter(s => (s.team || "Autres") === eq);
      sec.append(stEl("h2", "", eq + ' <small>' + n.length + '</small>'));
      const grid = h("div", "st-grid");
      n.forEach(s => {
        const a = h("a", "panel st-card"); a.href = "#scantrad/" + slugS(s.title) + "/traduire";
        const t2 = h("div"); t2.style.minWidth = "0";
        const sm = h("small", "", stChapLabel(s)); sm.dataset.slug = slugS(s.title); t2.append(h("b", "", s.title), sm);
        a.append(cover(s), t2); grid.append(a);
      });
      sec.append(grid); groupes.append(sec);
    });
    if (!list.length) groupes.append(h("p", "empty", "Aucune série ne correspond."));
    stMajChapitres(groupes, list);
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
  if (st.vue === "traduire") stSourceToggle(box);
  ({ traduire: st.data.config.source === "texte" ? stTraduireTexte : stTraduire, chapitres: stChapitres, check: stCheck, glossaire: stGlossaire })[st.vue](box);
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
  const dx = h("button", "btn ghost", "Télécharger .docx"); dx.type = "button"; dx.disabled = !J.texte;
  dx.onclick = () => stDocxBouton(J.num, J.texte.split("\n"), dx);
  foot.append(cp, dl, dx);
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
- "termes" : les noms propres et termes récurrents (personnages, lieux, techniques, factions, objets) qui apparaissent sur cette page et qui NE SONT PAS déjà dans le glossaire. Donne la forme source exacte, ta traduction, une catégorie parmi ${stCats().join(", ")}, le genre si c'est un personnage (Homme, Femme ou vide), une note courte qui aidera la suite, et la citation source où il apparaît. Tableau vide s'il n'y en a pas.
- Si la page n'a aucun texte, "blocs" est un tableau vide.

Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"blocs":[{"locuteur":"CM","bulles":["Première bulle.","Deuxième bulle du même personnage."]}],"termes":[{"vo":"HWASAN SECT","fr":"secte du mont Hua","categorie":"Faction","genre":"","note":"La secte du héros","citation":"WE ARE THE HWASAN SECT!"}]}`;
}

async function stClaude(content, system, maxTokens, schema) {
  const key = stCle();
  if (!key) throw new Error("Clé API manquante : colle ta clé Claude dans le champ « Clé API Claude ».");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true", "x-api-key": key,
      "anthropic-beta": "server-side-fallback-2026-07-01"   // repli automatique si le modèle refuse une page
    },
    body: JSON.stringify({ model: ST_MODEL, max_tokens: maxTokens || 16000, output_config: Object.assign({ effort: ST_EFFORT }, schema ? { format: { type: "json_schema", schema } } : {}), fallbacks: "default", system, messages: [{ role: "user", content }] })
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

function stMaj() { if (st.vue === "traduire" && $("scantrad").classList.contains("on")) stRendre(); }
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
async function stFinir(job) {
  const J = job || stJob, slug = J.slug;
  if (st.slug !== slug || !st.data) { J.etat = "a-sauver"; J.msg = "Reviens sur la série pour enregistrer ce chapitre."; return; }
  J.etat = "cours"; J.msg = "Enregistrement du chapitre..."; stMaj();
  stDerniers[slug] = Math.max(stDerniers[slug] || 0, +J.num || 0);   // la liste des séries suit tout de suite
  const d = st.data, ok = J.pages.filter(f => f.etat === "ok").length;
  const entree = { num: J.num, date: new Date().toISOString(), pages: ok, bulles: J.bulles, mots: J.mode === "texte" ? J.texte.split(/\s+/).filter(Boolean).length : 0, traducteur: stPref().traducteur || "" };
  try {
    const path = stChemin("chapitres", J.num + ".json"), avant = await stGh(path);
    await stEcrire(path, Object.assign({}, entree, { modele: ST_MODEL, texte: J.texte }, J.mode === "texte" ? { raw: J.raw } : {}), avant && avant.sha, st.serie.title + " : traduction du chapitre " + J.num);
    d.chapitres = d.chapitres.filter(c => String(c.num) !== String(J.num)).concat([entree]).sort((a, b) => b.num - a.num);
    const connus = new Set(); d.termes.forEach(t => [t.vo].concat(t.variantes || []).forEach(v => connus.add(stNorm(v))));
    let n = 0;
    J.termes.forEach(t => {
      const k = stNorm(t.vo); if (!k || connus.has(k)) return; connus.add(k); n++;
      d.termes.push({ id: stId(), vo: String(t.vo).trim(), fr: String(t.fr || "").trim(), cat: stCats().includes(t.categorie) ? t.categorie : "Autre", genre: /^(Homme|Femme)$/.test(t.genre) ? t.genre : "", variantes: [], notes: String(t.note || "").trim(), citation: String(t.citation || "").trim(), vu: J.num, aValider: true });
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
    if (c.pages) meta.append(m("book", plural(c.pages, "page", "pages")), m("lang", plural(c.bulles, "bulle", "bulles"))); else meta.append(m("book", plural(c.mots || 0, "mot", "mots")));
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
  [["termes", "Termes (" + d.termes.length + ")"], ["tutoiement", "Tutoiement (" + (d.relations || []).length + ")"], ["fiche", "Fiche de la série"]].forEach(([k, l]) => {
    const b = h("button", "", l); b.type = "button"; b.setAttribute("aria-pressed", String(stGl.sous === k));
    if (k === "termes" && att) b.append(document.createTextNode(" "), h("span", "st-badge", String(att)));
    b.onclick = () => { stGl.sous = k; stRendre(); }; seg.append(b);
  });
  wrap.append(seg);
  ({ fiche: stFiche, tutoiement: stTutoiement, termes: stTermes })[stGl.sous](wrap);
  box.append(wrap);
}
function stTermes(wrap) {
  const d = st.data;
  const tools = h("div", "st-tools");
  const se = stEl("div", "search", '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>');
  const q = h("input"); q.type = "search"; q.placeholder = "Rechercher un terme..."; q.value = stGl.q; q.setAttribute("aria-label", "Rechercher un terme"); se.append(q);
  const nv = h("button", "btn", "Nouveau terme"); nv.type = "button";
  nv.onclick = () => { stGl.edit = { id: "", vo: "", fr: "", cat: stGl.filtre !== "Tous" && stGl.filtre !== "À valider" ? stGl.filtre : "Personnage", genre: "", variantes: [], garder: false, notes: "", details: "", portrait: "", citation: "", aValider: false }; stRendre(); };
  tools.append(se, nv); stPanneauImport(wrap); wrap.append(tools);
  const chips = h("div", "chips");
  const cnt = { "Tous": d.termes.length, "À valider": d.termes.filter(t => t.aValider).length };
  stCats().forEach(c => { cnt[c] = d.termes.filter(t => t.cat === c).length; });
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
      (!t || [x.vo, x.fr, x.notes, x.details].concat(x.variantes || []).some(v => stNorm(v).includes(t))))
      .sort((a, b) => (b.aValider - a.aValider) || ((+b.vu || 0) - (+a.vu || 0)) || a.vo.localeCompare(b.vo));
    list.textContent = "";
    if (!xs.length) { list.append(h("p", "empty", d.termes.length ? "Aucun terme ne correspond." : "Le glossaire est vide. Les termes repérés pendant les traductions arriveront ici, à valider.")); return; }
    xs.forEach(x => {
      const row = h("div", "st-term"); row.tabIndex = 0;
      if (x.portrait) row.append(stPortrait(x.portrait));
      const tt = h("div", "st-t"), l1 = h("div");
      l1.append(h("span", "vo", x.vo), h("span", "sep", "›"), h("span", "fr", x.garder ? x.vo : (x.fr || "à traduire")));
      tt.append(l1);
      const info = [x.details, x.notes, x.citation ? "« " + x.citation + " »" : "", x.variantes && x.variantes.length ? "aussi : " + x.variantes.join(", ") : "", x.vu ? "vu au ch. " + x.vu : ""].filter(Boolean).join(" · ");
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
/* ---------- Portraits (affichage seulement, jamais envoyés à l'IA) ---------- */
let stImgCache = {}, stImgPending = {};
function stImgUrl(path) {
  const k = st.slug + "/" + path;
  if (stImgPending[k]) return Promise.resolve(stImgPending[k].url);
  if (!stImgCache[k]) stImgCache[k] = (async () => {
    const c = stCtx(), res = await fetch("https://api.github.com/repos/" + c.repo + "/contents/" + stChemin(path).split("/").map(encodeURIComponent).join("/"), { headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github.raw+json" } });
    if (!res.ok) throw new Error("portrait introuvable");
    return URL.createObjectURL(await res.blob());
  })();
  return stImgCache[k];
}
function stPortrait(path) { const im = h("img", "st-pt"); im.alt = ""; im.loading = "lazy"; stImgUrl(path).then(u => { im.src = u; }).catch(() => im.remove()); return im; }
async function stReduireImage(file, max) {
  const img = await stChargerImage(file), sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85);
  return { b64: url.split(",")[1], url };
}

/* ---------- Éditeur d'un terme ---------- */
function stEditeur(x) {
  const f = h("form", "panel pad st-edit st-stack"); f.style.marginBottom = "16px"; f.autocomplete = "off";
  const champ = (lbl, el, id) => { const d = h("div", "st-f"); const l = h("label", "", lbl); el.id = "st-e-" + id; l.htmlFor = el.id; d.append(l, el); return d; };
  const tid = x.id || stId();
  let portrait = x.portrait || "";
  const vo = h("input"); vo.type = "text"; vo.value = x.vo; vo.required = true;
  const fr = h("input"); fr.type = "text"; fr.value = x.fr;
  const cat = h("input"); cat.type = "text"; cat.value = x.cat; cat.setAttribute("list", "st-cats"); cat.required = true;
  const dl = h("datalist"); dl.id = "st-cats"; stCats().forEach(c => dl.append(h("option", "", c)));
  const r1 = h("div", "st-row"); r1.append(champ("Terme source (VA)", vo, "vo"), champ("Traduction (VF)", fr, "fr"), champ("Catégorie", cat, "cat"));
  const det = h("input"); det.type = "text"; det.value = x.details || ""; det.placeholder = "Ex : chap 314, nom de la constellation de Jeong Huiwon";
  const va = h("input"); va.type = "text"; va.value = (x.variantes || []).join(", "); va.placeholder = "séparées par des virgules";
  const gd = h("label", "st-check"), gc = h("input"); gc.type = "checkbox"; gc.checked = !!x.garder; gd.append(gc, document.createTextNode("Ne pas traduire (garder tel quel)"));
  gc.onchange = () => { fr.disabled = gc.checked; }; fr.disabled = gc.checked;
  const gdBox = h("div", "st-f"); gdBox.style.alignSelf = "end"; gdBox.style.paddingBottom = "8px"; gdBox.append(gd);
  const r2 = h("div", "st-row"); r2.append(champ("Détails", det, "det"), champ("Autres écritures (variantes)", va, "va"), gdBox);
  let genre = x.genre || "";
  const gs = h("div", "st-seg"); gs.setAttribute("role", "group"); gs.setAttribute("aria-label", "Genre");
  const drawG = () => { gs.textContent = ""; [["", "—"], ["Femme", "Femme"], ["Homme", "Homme"]].forEach(([v, l]) => { const b = h("button", "", l); b.type = "button"; b.setAttribute("aria-pressed", String(genre === v)); b.onclick = () => { genre = v; drawG(); }; gs.append(b); }); };
  drawG();
  const gBox = h("div", "st-f"); gBox.append(h("span", "st-lbl", "Genre"), gs);
  const no = h("input"); no.type = "text"; no.value = x.notes || ""; no.placeholder = "Ce que l'IA doit savoir : rôle, registre, tutoiement...";
  const r3 = h("div", "st-row"); r3.style.gridTemplateColumns = "auto minmax(0, 1fr)"; r3.append(gBox, champ("Notes pour l'IA", no, "no"));
  /* portrait */
  const pb = h("div", "st-f"), pw = h("div", "st-pw"), pf = h("input"); pf.type = "file"; pf.accept = "image/*"; pf.hidden = true;
  const drawP = () => { pw.textContent = ""; if (portrait) pw.append(stPortrait(portrait)); else pw.append(h("span", "st-pt st-pt0", "+")); };
  drawP();
  const pbtn = h("button", "btn ghost", "Portrait"); pbtn.type = "button"; pbtn.onclick = () => pf.click();
  pf.onchange = async () => {
    if (!pf.files[0]) return;
    try { const r = await stReduireImage(pf.files[0], 160); portrait = "images/" + tid + ".jpg"; stImgPending[st.slug + "/" + portrait] = r; delete stImgCache[st.slug + "/" + portrait]; drawP(); } catch (e) { alert(e.message); }
  };
  pb.append(h("span", "st-lbl", "Portrait (affichage)"), pw, pbtn, pf);
  const r4 = h("div", "st-row"); r4.style.gridTemplateColumns = "auto minmax(0, 1fr)"; r4.append(pb, h("div"));
  const act = h("div", "st-actions");
  if (x.id) {
    const del = h("button", "btn ghost", "Supprimer"); del.type = "button"; del.style.marginRight = "auto";
    del.onclick = () => { if (!confirm("Supprimer « " + x.vo + " » du glossaire ?")) return; st.data.termes = st.data.termes.filter(t => t.id !== x.id); stGl.edit = null; stSauver(st.serie.title + " : glossaire, " + x.vo + " supprimé").catch(e => alert(e.message)); stRendre(); };
    act.append(del);
  }
  const an = h("button", "btn ghost", "Annuler"); an.type = "button"; an.onclick = () => { stGl.edit = null; stRendre(); };
  const ok = h("button", "btn", "Valider"); ok.type = "submit";
  act.append(an, ok);
  f.append(dl, r1, r2, r3, r4, act);
  f.onsubmit = (e) => {
    e.preventDefault();
    const n = { id: tid, vo: vo.value.trim(), fr: fr.value.trim(), cat: cat.value.trim() || "Autre", genre, variantes: va.value.split(",").map(s => s.trim()).filter(Boolean), garder: gc.checked, notes: no.value.trim(), details: det.value.trim(), portrait, citation: x.citation || "", vu: x.vu || "", aValider: false };
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

/* ---------- Tutoiement / vouvoiement ---------- */
const ST_REG = ["Tu / Tu", "Vous / Vous", "Vous / Tu", "Tu / Vous"];
function stTutoiement(wrap) {
  const d = st.data; d.relations = d.relations || [];
  wrap.append(h("p", "sub", "Comment P1 parle à P2 / comment P2 parle à P1. Envoyé à l'IA pour les personnages présents dans le chapitre."));
  const f = h("form", "panel pad st-f"); f.style.margin = "14px 0"; f.autocomplete = "off";
  const row = h("div", "st-row"); row.style.gridTemplateColumns = "1fr 1fr 160px auto";
  const p1 = h("input"), p2 = h("input"), reg = h("select"); p1.type = p2.type = "text"; p1.placeholder = "P1 (ex : Kim Dokja)"; p2.placeholder = "P2 (ex : Anna Croft)"; p1.required = p2.required = true;
  p1.setAttribute("aria-label", "P1"); p2.setAttribute("aria-label", "P2"); reg.setAttribute("aria-label", "Registre");
  ST_REG.forEach(x => reg.append(h("option", "", x)));
  const add = h("button", "btn", "Ajouter"); add.type = "submit"; add.style.alignSelf = "center";
  row.append(p1, p2, reg, add); f.append(row); wrap.append(f);
  f.onsubmit = (e) => { e.preventDefault(); d.relations.push({ id: stId(), p1: p1.value.trim(), p2: p2.value.trim(), reg: reg.value }); stSauver(st.serie.title + " : tutoiement, " + p1.value.trim() + " et " + p2.value.trim()).catch(err => alert(err.message)); stRendre(); };
  const list = h("div");
  d.relations.slice().sort((a, b) => a.p1.localeCompare(b.p1) || a.p2.localeCompare(b.p2)).forEach(r => {
    const row = h("div", "st-term"), t = h("div", "st-t");
    t.append(h("span", "vo", r.p1), h("span", "sep", "↔"), h("span", "vo", r.p2));
    const pills = h("div", "st-pills"); pills.append(h("span", "gchip " + (/Vous/.test(r.reg) ? "keep" : ""), r.reg));
    const del = h("button", "st-ok", "×"); del.type = "button"; del.title = "Supprimer"; del.setAttribute("aria-label", "Supprimer " + r.p1 + " et " + r.p2); del.style.color = "#f87171"; del.style.background = "rgba(248,113,113,.1)";
    del.onclick = () => { d.relations = d.relations.filter(x => x.id !== r.id); stSauver(st.serie.title + " : tutoiement supprimé").catch(err => alert(err.message)); stRendre(); };
    pills.append(del); row.append(t, pills); row.style.cursor = "default"; list.append(row);
  });
  if (!d.relations.length) list.append(h("p", "empty", "Aucune relation pour l'instant."));
  wrap.append(list);
}
function stFiche(wrap) {
  const d = st.data, f = h("form", "st-stack");
  const p1 = h("div", "panel pad st-f"), l1 = h("label", "", "Règles de la série"), rg = h("textarea");
  rg.id = "st-regles"; l1.htmlFor = rg.id; rg.value = d.regles;
  rg.placeholder = "Une règle par ligne, par exemple :\nLady → Dame\nSir → messire\nDiela et Derrick se tutoient\nLes noms de techniques restent en anglais";
  p1.append(l1, rg);
  const p0 = h("div", "panel pad st-f"), l0 = h("label", "", "Consignes de traduction (ton CLAUDE.md)"), cg = h("textarea");
  cg.id = "st-consignes"; l0.htmlFor = cg.id; cg.value = d.config.consignes || ST_CONSIGNES; cg.style.minHeight = "260px";
  p0.append(l0, cg, h("p", "note", "Envoyées à l'IA pour chaque traduction et chaque check. Modèle repris de ton CLAUDE.md : modifie-le librement."));
  const p2 = h("div", "panel pad st-f"), hd = h("div", "st-sum-h"), l2 = h("label", "", "Résumé de l'histoire"), rs = h("textarea");
  rs.id = "st-resume"; l2.htmlFor = rs.id; rs.value = d.resume; rs.style.minHeight = "200px";
  rs.placeholder = "Mis à jour par l'IA après chaque chapitre traduit. Tu peux le corriger.";
  hd.append(l2); if (d.resumeCh) hd.append(h("small", "", "mis à jour par l'IA au ch. " + d.resumeCh));
  p2.append(hd, rs);
  const act = h("div", "st-actions"), msg = h("span", "st-msg"); msg.style.marginRight = "auto";
  const ok = h("button", "btn", "Enregistrer la fiche"); ok.type = "submit"; ok.disabled = true;
  [rg, rs, cg].forEach(t => { t.oninput = () => { ok.disabled = false; msg.textContent = ""; }; });
  act.append(msg, ok);
  f.append(p0, p1, p2, act);
  f.onsubmit = async (e) => {
    e.preventDefault(); ok.disabled = true; msg.className = "st-msg"; msg.textContent = "Enregistrement...";
    d.regles = rg.value; d.resume = rs.value; d.config.consignes = cg.value.trim() === ST_CONSIGNES.trim() ? "" : cg.value;
    try { await stSauver(st.serie.title + " : fiche de la série"); msg.className = "st-msg ok"; msg.textContent = "Fiche enregistrée."; }
    catch (err) { msg.className = "st-msg err"; msg.textContent = err.message; ok.disabled = false; }
  };
  wrap.append(f);
}

/* ---------- Consignes (reprises du CLAUDE.md d'iLoza) ---------- */
const ST_CONSIGNES = `GUILLEMETS : pour les dialogues et les citations, utilise toujours les guillemets droits "..." et jamais « » ni les guillemets courbes.
STYLE : traduis à partir de la version anglaise avec une certaine liberté. Suis toujours le sens et le contenu : n'invente rien, ne retire rien d'important. Pas de mot à mot : une phrase naturelle, fluide, qui sonne comme du français parlé. Dans les dialogues, simplifie si besoin : remplace les inversions sujet-verbe par une tournure directe ("Peux-tu venir ?" devient "Tu peux venir ?") et supprime le "ne" des négations quand l'oral l'exige ("Je sais pas").
REGISTRE : garde le registre propre à chaque personnage (tutoiement ou vouvoiement, niveau de langage) tel qu'il est établi dans le glossaire et les chapitres précédents.
MAJUSCULES : si le texte source est en majuscules, écris la traduction en casse normale (majuscule en début de phrase et aux noms propres seulement). Aucune exception : les cris et les onomatopées non plus ("Basil !!" et "Gyuuu !", pas "BASIL !!"). Le cri passe par la ponctuation ou la répétition de lettres.
LIGNES : si des lignes n'ont pas de saut de ligne entre elles dans le texte source, laisse-les telles quelles. Saute une ligne entre chaque retour à la ligne.
FIN : si le texte se termine par "À suivre" ou "To be continued", supprime cette mention.
Une phrase qui commence par HB, BB ou DB est normale : laisse-la.`;
const ST_REG_PROMPT = "Respecte toujours le glossaire (traductions imposées) et les relations de tutoiement / vouvoiement indiquées.";

/* ---------- Contexte ciblé : seulement ce qui apparaît dans le chapitre ---------- */
function stCompact(t) { return " " + stNorm(t).replace(/[^a-z0-9]+/g, " ").trim() + " "; }
function stContexteTexte(texte) {
  const d = st.data, hay = stCompact(texte), lignes = [];
  const present = (v) => { const k = stCompact(v); return k.trim().length > 2 && hay.includes(k); };
  lignes.push("CONSIGNES DE TRADUCTION :\n" + (d.config.consignes || ST_CONSIGNES) + "\n" + ST_REG_PROMPT);
  if (d.regles.trim()) lignes.push("RÈGLES DE LA SÉRIE :\n" + d.regles.trim());
  if (d.resume.trim()) lignes.push("SYNOPSIS :\n" + d.resume.trim());
  const ts = d.termes.filter(t => t.vo && [t.vo].concat(t.variantes || []).some(present));
  if (ts.length) lignes.push("GLOSSAIRE (termes présents dans ce chapitre, traductions imposées) :\n" + ts.map(t => "- " + t.vo + " → " + (t.garder ? t.vo + " [ne pas traduire]" : (t.fr || "?")) + " [" + t.cat + "]" + ([t.details, t.notes].filter(Boolean).length ? " (" + [t.details, t.notes].filter(Boolean).join(" ; ") + ")" : "")).join("\n"));
  const names = new Set(); ts.forEach(t => { names.add(stNorm(t.vo)); names.add(stNorm(t.fr)); });
  const rs = (d.relations || []).filter(r => present(r.p1) || present(r.p2) || names.has(stNorm(r.p1)) || names.has(stNorm(r.p2)));
  if (rs.length) lignes.push("TUTOIEMENT / VOUVOIEMENT (P1 parle à P2 / P2 parle à P1) :\n" + rs.map(r => "- " + r.p1 + " ↔ " + r.p2 + " : " + r.reg).join("\n"));
  return { texte: lignes.join("\n\n"), nbTermes: ts.length, nbRel: rs.length };
}
const stChCache = {};
async function stPrecedents(num, n) {
  const xs = st.data.chapitres.filter(c => +c.num < +num).sort((a, b) => b.num - a.num).slice(0, n || 3).reverse(), out = [];
  for (const c of xs) {
    const k = st.slug + "/" + c.num;
    if (stChCache[k] === undefined) { const r = await stLire(stChemin("chapitres", c.num + ".json")); stChCache[k] = r ? r.json : { texte: "", raw: "" }; }
    if (stChCache[k].texte) out.push("--- Chapitre " + c.num + " ---\n" + stChCache[k].texte);
  }
  return out.join("\n\n");
}

/* ---------- Choix de la source : pages (images) ou texte anglais ---------- */
function stSourceToggle(box) {
  const d = st.data, seg = h("div", "st-seg"); seg.style.marginBottom = "16px";
  seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Source du chapitre");
  [["images", "Pages (images)"], ["texte", "Texte anglais"]].forEach(([k, l]) => {
    const b = h("button", "", l); b.type = "button"; b.setAttribute("aria-pressed", String(d.config.source === k));
    b.onclick = () => { if (d.config.source === k) return; d.config.source = k; stSauver(st.serie.title + " : source des chapitres, " + l).catch(e => alert(e.message)); stRendre(); };
    seg.append(b);
  });
  box.append(seg);
}

/* ---------- Traduire à partir du texte anglais (trad N) ---------- */
let stJobT = null;
const ST_SCHEMA_TRAD = { type: "object", additionalProperties: false, required: ["texte", "termes"], properties: {
  texte: { type: "string" },
  termes: { type: "array", items: { type: "object", additionalProperties: false, required: ["vo", "fr", "categorie", "genre", "note", "citation"], properties: { vo: { type: "string" }, fr: { type: "string" }, categorie: { type: "string" }, genre: { type: "string" }, note: { type: "string" }, citation: { type: "string" } } } }
} };
function stTraduireTexte(box) {
  const wrap = h("div", "st-stack");
  const dernier = st.data.chapitres.reduce((m, c) => Math.max(m, +c.num || 0), 0);
  if (!stJobT || stJobT.slug !== st.slug) stJobT = { slug: st.slug, mode: "texte", raw: "", pages: [], texte: "", etat: "pret", num: dernier ? dernier + 1 : (st.serie.chapitre ? st.serie.chapitre + 1 : 1), msg: "", bulles: 0, termes: [] };
  const J = stJobT, occupe = J.etat === "cours", p = stPref();
  const champ = (lbl, el) => { const d = h("div", "st-f"); const l = h("label", "", lbl); el.id = "st-" + lbl.replace(/\W+/g, "").toLowerCase(); l.htmlFor = el.id; d.append(l, el); return d; };
  const reg = h("div", "panel pad st-f st-stack"), row = h("div", "st-row");
  const num = h("input"); num.type = "number"; num.min = "0"; num.step = "0.1"; num.value = J.num; num.oninput = () => { J.num = num.value; };
  const tr = h("input"); tr.type = "text"; tr.value = p.traducteur; tr.oninput = () => stSetPref("traducteur", tr.value.trim());
  const cle = h("input"); cle.type = "password"; cle.placeholder = "sk-ant-..."; cle.value = stCle();
  cle.onchange = () => { try { cle.value.trim() ? localStorage.setItem(ST_KEY_API, cle.value.trim()) : localStorage.removeItem(ST_KEY_API); } catch (e) {} };
  row.append(champ("Chapitre", num), champ("Traducteur", tr), champ("Clé API Claude", cle));
  reg.append(row); [num, tr, cle].forEach(x => { x.disabled = occupe; });

  const src = h("div", "panel pad st-f"), ta = h("textarea"); ta.className = "st-raw"; ta.value = J.raw; ta.disabled = occupe;
  ta.placeholder = "Colle ici le texte anglais du chapitre (le contenu de Raws/N.txt)...";
  ta.oninput = () => { J.raw = ta.value; go.disabled = occupe || !ta.value.trim(); info.textContent = stInfoRaw(ta.value); };
  const l = h("label", "", "Texte anglais du chapitre"); l.htmlFor = "st-raw"; ta.id = "st-raw";
  const fi = h("input"); fi.type = "file"; fi.accept = ".txt,text/plain"; fi.hidden = true;
  fi.onchange = async () => { if (!fi.files[0]) return; J.raw = await fi.files[0].text(); const m = fi.files[0].name.match(/^(\d+(?:\.\d+)?)\./); if (m) J.num = m[1]; stRendre(); };
  const ob = h("button", "btn ghost", "Ouvrir un .txt"); ob.type = "button"; ob.disabled = occupe; ob.onclick = () => fi.click();
  const info = h("span", "st-msg", stInfoRaw(J.raw)); info.style.marginRight = "auto";
  const bar0 = h("div", "st-actions"); bar0.append(info);
  const rs = stRawsStockes();
  if (rs) {
    const sr = h("select"); sr.id = "st-raw-sel"; sr.disabled = occupe; sr.setAttribute("aria-label", "Raw déjà stocké");
    const o0 = h("option", "", "Raw stocké (" + rs.raws.length + ")..."); o0.value = ""; sr.append(o0);
    rs.raws.slice().sort((a, b) => b - a).forEach(n => { const o = h("option", "", "Chapitre " + n); o.value = n; sr.append(o); });
    sr.onchange = async () => {
      if (sr.value === "") return;
      sr.disabled = true; info.textContent = "Chargement du raw...";
      try { J.raw = await stTexteRepo(rs.dossier + "/raws/" + sr.value + ".txt"); J.num = sr.value; stRendre(); }
      catch (e) { info.textContent = e.message; sr.disabled = false; }
    };
    bar0.append(sr);
  }
  bar0.append(ob, fi);
  src.append(l, ta, bar0);

  const act = h("div", "st-actions");
  const msg = h("span", "st-msg" + (J.etat === "erreur" ? " err" : J.etat === "fini" ? " ok" : "")); msg.style.marginRight = "auto"; msg.textContent = J.msg;
  const go = h("button", "btn"); go.type = "button"; go.append(icon("lang"), document.createTextNode(occupe ? "Traduction en cours..." : "Traduire le chapitre " + (J.num !== "" ? J.num : "")));
  go.disabled = occupe || !J.raw.trim(); go.onclick = () => stLancerTexte();
  act.append(msg, go);

  const res = h("div", "panel"), out = h("div", "st-out"); out.textContent = J.texte;
  const foot = h("div", "st-foot");
  const cp = h("button", "btn ghost", "Copier"); cp.type = "button"; cp.disabled = !J.texte; cp.onclick = () => stCopier(J.texte, cp);
  const dt = h("button", "btn ghost", "Télécharger .txt"); dt.type = "button"; dt.disabled = !J.texte; dt.onclick = () => stTelecharger(J.num + ".txt", J.texte);
  const dx = h("button", "btn", "Télécharger " + J.num + ".docx"); dx.type = "button"; dx.disabled = !J.texte; dx.onclick = () => stDocxBouton(J.num, J.texte.split("\n"), dx);
  foot.append(cp, dt, dx);
  if (J.texte && J.ctx) foot.append(h("span", "gchip plain", plural(J.ctx.nbTermes, "terme du glossaire", "termes du glossaire") + " · " + plural(J.ctx.nbRel, "relation", "relations") + " envoyés"));
  if (J.etat === "a-sauver") { const r = h("button", "btn", "Réessayer l'enregistrement"); r.type = "button"; r.onclick = () => stFinir(stJobT); foot.append(r); }
  res.append(out, foot);
  wrap.append(reg, src, act, res); box.append(wrap);
}
function stInfoRaw(t) { const n = (t.match(/\S+/g) || []).length; return n ? plural(n, "mot", "mots") + " · " + plural(t.split("\n").filter(x => x.trim()).length, "ligne", "lignes") : ""; }
async function stLancerTexte() {
  const J = stJobT, slug = J.slug;
  if (!stCle()) { J.msg = "Colle ta clé API Claude d'abord."; J.etat = "erreur"; stRendre(); return; }
  if (!(J.num !== "" && +J.num >= 0)) { J.msg = "Indique le numéro du chapitre."; J.etat = "erreur"; stRendre(); return; }
  if (st.data.chapitres.some(c => String(c.num) === String(+J.num)) && !confirm("Le chapitre " + (+J.num) + " est déjà dans l'historique. Le remplacer ?")) return;
  J.num = +J.num; J.etat = "cours"; J.texte = ""; J.termes = []; J.msg = "Préparation du contexte..."; stMaj();
  try {
    const ctx = stContexteTexte(J.raw); J.ctx = ctx;
    const prev = await stPrecedents(J.num, 3);
    J.msg = "Traduction en cours..."; stMaj();
    const prompt = `Tu traduis le chapitre ${J.num} de « ${st.serie.title} » en français, à partir de sa version anglaise.\n\n${ctx.texte}\n\n${prev ? "DERNIERS CHAPITRES TRADUITS (pour le ton, les tutoiements et les noms) :\n" + prev + "\n\n" : ""}TEXTE ANGLAIS DU CHAPITRE ${J.num} :\n<<<\n${J.raw.trim()}\n>>>\n\nRéponds en JSON : "texte" = la traduction complète du chapitre (mêmes lignes que la source, une ligne vide entre chaque retour à la ligne) ; "termes" = les noms propres et termes récurrents qui ne sont PAS dans le glossaire ci-dessus (forme source exacte "vo", traduction "fr", "categorie" parmi ${stCats().join(", ")}, "genre" Homme, Femme ou vide, "note" courte, "citation" source). Tableau vide s'il n'y en a pas.`;
    const r = await stClaude([{ type: "text", text: prompt }], "Tu es traducteur, correcteur et bibliothécaire d'une œuvre pour une équipe de scantrad française. Tu réponds uniquement en JSON.", 16000, ST_SCHEMA_TRAD);
    const j = stJson(r.texte); if (!j || !j.texte) throw new Error(r.tronque ? "Réponse coupée (chapitre trop long)" : "Réponse illisible");
    J.texte = j.texte.replace(/[«“„][\s  ]*/g, '"').replace(/[\s  ]*[»”]/g, '"').trim(); J.termes = j.termes || [];
  } catch (e) { J.etat = "erreur"; J.msg = e.message; stMaj(); return; }
  await stFinir(J);
}

/* ---------- Export .docx fidèle à creer_docx.py (Arial 11, interligne simple, 0 pt, guillemets droits) ---------- */
function stGuill(t) { return t.replace(/[«“„][\s  ]*/g, '"').replace(/[\s  ]*[»”]/g, '"'); }
async function stDocx(lignes) {   // lignes : "texte" | "" | [["texte", rouge?], ...]
  if (!window.JSZip) await chScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const run = (t, rouge) => '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>' + (rouge ? '<w:color w:val="FF0000"/>' : "") + '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">' + esc(stGuill(t)) + "</w:t></w:r>";
  const PPR = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>';
  const paras = lignes.map(l => { const segs = typeof l === "string" ? (l.trim() ? [[l, false]] : []) : l; return "<w:p>" + PPR + segs.map(s => run(s[0], s[1])).join("") + "</w:p>"; });
  if (paras.join("").match(/[«»“”„]/)) throw new Error("Guillemets français restants");
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const z = new window.JSZip();
  z.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  z.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  z.file("word/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>');
  z.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + "><w:body>" + paras.join("") + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
  return z.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
async function stDocxBouton(num, lignes, btn) {
  const old = btn.textContent; btn.disabled = true;
  try {
    const blob = await stDocx(lignes), a = h("a"); a.href = URL.createObjectURL(blob); a.download = num + ".docx";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { alert(e.message); }
  btn.textContent = old; btn.disabled = false;
}

/* ---------- Check (check N) : ne renvoie que les lignes fautives ---------- */
let stCk = { slug: "", num: "", texte: "", raw: "", res: null, etat: "pret", msg: "", ctx: null };
const ST_SCHEMA_CHECK = { type: "object", additionalProperties: false, required: ["corrections"], properties: { corrections: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "corrigee"], properties: { n: { type: "integer" }, corrigee: { type: "string" } } } } } };
function stGras(t) { const f = document.createDocumentFragment(); t.split(/\*\*(.+?)\*\*/g).forEach((x, i) => { if (!x) return; if (i % 2) f.append(h("b", "", x)); else f.append(document.createTextNode(x)); }); return f; }
function stCheck(box) {
  const d = st.data;
  if (stCk.slug !== st.slug) stCk = { slug: st.slug, num: "", texte: "", raw: "", res: null, etat: "pret", msg: "", ctx: null };
  const K = stCk, occupe = K.etat === "cours", wrap = h("div", "st-stack");
  const reg = h("div", "panel pad st-f st-stack"), row = h("div", "st-row");
  const sel = h("select"); sel.id = "st-ck-n"; sel.disabled = occupe;
  const o0 = h("option", "", "Texte collé"); o0.value = ""; sel.append(o0);
  d.chapitres.slice().sort((a, b) => b.num - a.num).forEach(c => { const o = h("option", "", "Chapitre " + c.num); o.value = c.num; sel.append(o); });
  sel.value = K.num;
  sel.onchange = async () => {
    K.num = sel.value; K.res = null; K.msg = "";
    if (K.num !== "") { sel.disabled = true; try { const r = await stLire(stChemin("chapitres", K.num + ".json")); K.texte = r ? r.json.texte || "" : ""; K.raw = r ? r.json.raw || "" : "";
      const rs = stRawsStockes(); if (!K.raw && rs && rs.raws.includes(+K.num)) K.raw = await stTexteRepo(rs.dossier + "/raws/" + K.num + ".txt"); } catch (e) { K.msg = e.message; } }
    stRendre();
  };
  const l = h("label", "", "Chapitre à vérifier"); l.htmlFor = sel.id; const dn = h("div", "st-f"); dn.append(l, sel);
  const cle = h("input"); cle.type = "password"; cle.placeholder = "sk-ant-..."; cle.id = "st-ck-key"; cle.value = stCle(); cle.disabled = occupe;
  cle.onchange = () => { try { cle.value.trim() ? localStorage.setItem(ST_KEY_API, cle.value.trim()) : localStorage.removeItem(ST_KEY_API); } catch (e) {} };
  const lc = h("label", "", "Clé API Claude"); lc.htmlFor = cle.id; const dc = h("div", "st-f"); dc.append(lc, cle);
  row.append(dn, dc); reg.append(row);
  const ta = h("textarea"); ta.className = "st-raw"; ta.id = "st-ck-t"; ta.value = K.texte; ta.disabled = occupe; ta.placeholder = "Le chapitre traduit à vérifier...";
  const tb = h("textarea"); tb.className = "st-raw st-raw-s"; tb.id = "st-ck-r"; tb.value = K.raw; tb.disabled = occupe; tb.placeholder = "Version anglaise (facultatif) : aide pour repérer contresens, oublis et ajouts";
  const lt = h("label", "", "Texte traduit"); lt.htmlFor = ta.id; const lr = h("label", "", "Version anglaise (aide)"); lr.htmlFor = tb.id;
  const go = h("button", "btn"); go.type = "button"; go.append(icon("pen"), document.createTextNode(occupe ? "Vérification..." : "Vérifier")); go.disabled = occupe || !K.texte.trim();
  ta.oninput = () => { K.texte = ta.value; go.disabled = !ta.value.trim(); K.res = null; }; tb.oninput = () => { K.raw = tb.value; };
  go.onclick = () => stLancerCheck();
  const src = h("div", "panel pad st-f"); src.append(lt, ta, lr, tb);
  const act = h("div", "st-actions"), msg = h("span", "st-msg" + (K.etat === "erreur" ? " err" : K.res ? " ok" : "")); msg.style.marginRight = "auto"; msg.textContent = K.msg; act.append(msg, go);
  wrap.append(reg, src, act);
  if (K.res) {
    const res = h("div", "panel"), lst = h("div", "st-diffs");
    if (!K.res.length) lst.append(h("p", "empty", "Aucune erreur trouvée."));
    K.res.forEach(c => {
      const b = h("div", "st-diff"), a = h("div", "st-del"), n = h("div", "st-add");
      a.textContent = c.original; n.append(stGras(c.corrigee)); b.append(a, n); lst.append(b);
    });
    const foot = h("div", "st-foot"); foot.append(h("span", "gchip plain", plural(K.res.length, "ligne corrigée", "lignes corrigées")));
    const nm = K.num !== "" ? K.num : "chapitre";
    const dx = h("button", "btn", "Télécharger " + nm + ".docx corrigé"); dx.type = "button"; dx.onclick = () => stDocxBouton(nm, stLignesCheck(), dx);
    foot.append(dx);
    if (K.num !== "" && K.res.length) { const rp = h("button", "btn ghost", "Remplacer le chapitre " + K.num + " dans l'historique"); rp.type = "button"; rp.onclick = () => stRemplacer(rp); foot.append(rp); }
    const cp = h("button", "btn ghost", "Copier la liste"); cp.type = "button"; cp.onclick = () => stCopier(K.res.map(c => c.original + "\n" + c.corrigee.replace(/\*\*/g, "")).join("\n\n"), cp); foot.append(cp);
    res.append(lst, foot); wrap.append(res);
  }
  box.append(wrap);
}
function stLignesCheck() {   // ligne d'origine, puis la ligne corrigée entière en rouge juste dessous (comme creer_docx.py)
  const K = stCk, m = {}; (K.res || []).forEach(c => { m[c.n] = c.corrigee.replace(/\*\*/g, ""); });
  const out = []; K.texte.split("\n").forEach((l, i) => { out.push(l); if (m[i + 1] !== undefined) out.push([[m[i + 1], true]]); });
  return out;
}
async function stLancerCheck() {
  const K = stCk;
  if (!stCle()) { K.msg = "Colle ta clé API Claude d'abord."; K.etat = "erreur"; stRendre(); return; }
  K.etat = "cours"; K.res = null; K.msg = "Vérification en cours..."; stRendre();
  try {
    const lignes = K.texte.split("\n"), ctx = stContexteTexte(K.texte + "\n" + K.raw);
    const num = lignes.map((l, i) => l.trim() ? "L" + (i + 1) + " | " + l : "").filter(Boolean).join("\n");
    const prompt = `Tu vérifies (check) la traduction française d'un chapitre de « ${st.serie.title} ».\n\n${ctx.texte}\n\nCE QUE TU VÉRIFIES : la grammaire et l'orthographe des mots ; les contresens, oublis ou ajouts par rapport à la version anglaise (si elle est donnée). Les majuscules en début de phrase : s'il n'y en a pas, n'en tiens pas rigueur. Un français parlé et naturel n'est PAS une erreur : ne signale pas l'absence de "ne" dans une négation ni l'absence d'inversion sujet-verbe. Tu peux simplifier une phrase lourde (inversion sujet-verbe vers tournure directe, "ne" supprimé) sans changer le sens ni le registre du personnage : ces simplifications comptent comme des corrections. Ne compte pas comme erreurs : les guillemets (« » ou courbes, remplacés par "), la mention "À suivre", les phrases qui commencent par HB, BB ou DB.\n\nCHAPITRE TRADUIT (lignes numérotées L1, L2...) :\n${num}\n\n${K.raw.trim() ? "VERSION ANGLAISE (aide) :\n" + K.raw.trim() + "\n\n" : ""}Réponds en JSON : "corrections" = uniquement les lignes où il y a une erreur ; "n" = le numéro de la ligne ; "corrigee" = la ligne corrigée entière, avec les mots modifiés entourés de ** (ex : "Je suis **allé** au marché"). Tableau vide s'il n'y a aucune erreur.`;
    const r = await stClaude([{ type: "text", text: prompt }], "Tu es correcteur d'une œuvre pour une équipe de scantrad française. Tu réponds uniquement en JSON.", 16000, ST_SCHEMA_CHECK);
    const j = stJson(r.texte); if (!j || !Array.isArray(j.corrections)) throw new Error("Réponse illisible");
    K.res = j.corrections.filter(c => lignes[c.n - 1] !== undefined && lignes[c.n - 1].trim()).map(c => ({ n: c.n, original: lignes[c.n - 1], corrigee: stGuill(c.corrigee) })).sort((a, b) => a.n - b.n);
    K.etat = "fini"; K.msg = K.res.length ? plural(K.res.length, "ligne à corriger", "lignes à corriger") + "." : "Rien à corriger.";
  } catch (e) { K.etat = "erreur"; K.msg = e.message; }
  stRendre();
}
async function stRemplacer(btn) {
  const K = stCk;
  if (!confirm("Remplacer le texte du chapitre " + K.num + " par la version corrigée ? L'ancienne version reste dans l'historique Git.")) return;
  btn.disabled = true;
  try {
    const path = stChemin("chapitres", K.num + ".json"), av = await stLire(path);
    const corr = {}; K.res.forEach(c => { corr[c.n] = c.corrigee.replace(/\*\*/g, ""); });
    const texte = K.texte.split("\n").map((l, i) => corr[i + 1] !== undefined ? corr[i + 1] : l).join("\n");
    await stEcrire(path, Object.assign({}, av ? av.json : {}, { texte, check: new Date().toISOString() }), av && av.sha, st.serie.title + " : check du chapitre " + K.num);
    delete stChCache[st.slug + "/" + K.num]; K.texte = texte; K.res = null; K.msg = "Chapitre " + K.num + " remplacé par la version corrigée.";
  } catch (e) { K.msg = e.message; K.etat = "erreur"; }
  stRendre();
}

/* index.html a déjà affiché l'onglet avant que ce fichier ne soit chargé */
(function () { const n = decodeURIComponent(location.hash.slice(1)); stAfficher(n === "scantrad" || n.indexOf("scantrad/") === 0 ? n.slice(9) : null); })();

/* ---------- Import d'un glossaire .xlsx (termes, catégories, tutoiement, portraits) ---------- */
const ST_XCATS = { "PERSONNAGES": "Personnage", "INVOCATIONS": "Invocation", "ENNEMIS / MONSTRES": "Monstre", "VOCABULAIRE": "Vocabulaire", "TECHNIQUES": "Technique", "LIEUX": "Lieu", "COMPETENCES": "Technique", "ARMES / OBJETS": "Objet", "QUETES": "Quête", "TARDUCTION TERMES": "Vocabulaire", "TECHNIQUE": "Technique" };
let stImp = null;
function stXCol(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
async function stXlsxLire(file) {
  if (!window.JSZip) await chScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  const z = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = async (p) => { const f = z.file(p); return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null; };
  const rels = async (p) => { const d = await xml(p.replace(/([^/]+)$/, "_rels/$1.rels")); const m = {}; if (d) d.querySelectorAll("Relationship").forEach(r => { m[r.getAttribute("Id")] = r.getAttribute("Target"); }); return m; };
  const rel = (base, t) => { if (t[0] === "/") return t.slice(1); const parts = base.split("/").slice(0, -1); t.split("/").forEach(s => { if (s === "..") parts.pop(); else if (s !== ".") parts.push(s); }); return parts.join("/"); };
  const ss = [], sd = await xml("xl/sharedStrings.xml");
  if (sd) sd.querySelectorAll("si").forEach(si => ss.push(Array.from(si.querySelectorAll("t")).map(t => t.textContent).join("")));
  const wb = await xml("xl/workbook.xml"), wr = await rels("xl/workbook.xml");
  if (!wb) throw new Error("Ce fichier n'est pas un classeur .xlsx.");
  const termes = [], relations = [], images = {}; let blocsIgnores = 0;
  for (const sh of Array.from(wb.querySelectorAll("sheet"))) {
    const path = rel("xl/workbook.xml", wr[sh.getAttribute("r:id")] || wr[sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")]);
    if (/^formules$/i.test(sh.getAttribute("name"))) continue;
    const sd2 = await xml(path); if (!sd2) continue;
    const cell = {}; let maxC = 0, maxR = 0;
    sd2.querySelectorAll("c").forEach(c => {
      const ref = c.getAttribute("r"), t = c.getAttribute("t"), v = c.querySelector("v");
      let val = ""; if (t === "inlineStr") val = Array.from(c.querySelectorAll("t")).map(x => x.textContent).join(""); else if (v) val = t === "s" ? (ss[+v.textContent] || "") : v.textContent;
      val = String(val).trim(); if (!val) return;
      const col = stXCol(ref), row = +ref.replace(/\D/g, ""); cell[row + "," + col] = val; maxC = Math.max(maxC, col); maxR = Math.max(maxR, row);
    });
    const g = (r, c) => cell[r + "," + c] || "";
    // images ancrées (portraits)
    const imgs = [], sr = await rels(path), dr = sd2.querySelector("drawing");
    if (dr) {
      const dp = rel(path, sr[dr.getAttribute("r:id")] || ""), dd = await xml(dp), drl = await rels(dp);
      if (dd) for (const an of Array.from(dd.getElementsByTagName("*")).filter(e => /anchor$/i.test(e.localName))) {
        const fr = Array.from(an.children).find(e => e.localName === "from"), bl = Array.from(an.getElementsByTagName("*")).find(e => e.localName === "blip");
        if (!fr || !bl) continue;
        const kids = (n) => +(Array.from(fr.children).find(e => e.localName === n) || {}).textContent;
        const mp = rel(dp, drl[bl.getAttribute("r:embed")] || ""), mf = z.file(mp); if (!mf) continue;
        imgs.push({ row: kids("row") + 1, col: kids("col") + 1, file: mf });
      }
    }
    // en-têtes et blocs
    const heads = ["image", "va", "nom", "aperçu", "apercu", "chapitre webtoon"];
    let hr = 0; for (let r = 1; r <= 7 && !hr; r++) for (let c = 1; c <= maxC; c++) if (heads.includes(g(r, c).toLowerCase())) { hr = r; break; }
    if (!hr) continue;
    let tr = 0; for (const r of [hr - 1, hr - 2]) if (r >= 1 && !tr) for (let c = 1; c <= maxC; c++) if (g(r, c)) { tr = r; break; }
    let starts = []; if (tr) for (let c = 1; c <= maxC; c++) if (g(tr, c)) starts.push([c, g(tr, c).toUpperCase()]);
    for (let c = 1; c <= maxC; c++) if (/^vous\/tu entre/i.test(g(hr, c))) starts.push([c, "TUTOIEMENT LIBRE"]);
    starts.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < starts.length; i++) {
      const [c0, t] = starts[i], c1 = i + 1 < starts.length ? starts[i + 1][0] : maxC + 1;
      if (t.indexOf("HISTOIRE") === 0) continue;
      const hdr = {}; for (let c = c0; c < c1; c++) if (g(hr, c)) hdr[g(hr, c).toLowerCase()] = c;
      if (t.indexOf("TUTOIEMENT") === 0) {
        const cp1 = hdr.p1 || c0, cp2 = hdr.p1 ? hdr.p2 : c0 + 1, cr = hdr.p1 ? hdr["vous/tu"] : c0 + 2; if (!cp2 || !cr) continue;
        for (let r = hr + 1; r <= maxR; r++) if (g(r, cp1) && g(r, cp2) && g(r, cr)) relations.push({ p1: g(r, cp1), p2: g(r, cp2), reg: g(r, cr) });
        continue;
      }
      const cat = ST_XCATS[t]; if (!cat) { blocsIgnores++; continue; }
      let voC = hdr.va || hdr.nom; if (!voC && t === "ENNEMIS / MONSTRES") voC = hdr.description; if (!voC) continue;
      const frC = hdr.vf, detC = t === "ENNEMIS / MONSTRES" ? 0 : (hdr["détails"] || hdr.details || (hdr.nom && voC !== hdr.description ? hdr.description : 0) || hdr.remarque || 0);
      const apC = hdr.image || hdr["aperçu"] || hdr.apercu || 0;
      const extra = ["titre", "rang", "origine", "type", "détenteur", "1ère apparition", "chapitre"].filter(k => hdr[k] && hdr[k] !== voC && hdr[k] !== frC && hdr[k] !== detC);
      for (let r = hr + 1; r <= maxR; r++) {
        const vo = g(r, voC); if (!vo) continue;
        const t0 = { vo, fr: (frC && g(r, frC)) || vo, cat, genre: "", variantes: [], garder: false, notes: "", details: detC ? g(r, detC) : "", portrait: "", citation: "", vu: "", aValider: false };
        const notes = [];
        extra.forEach(k => { const v = g(r, hdr[k]); if (!v) return; if (k === "1ère apparition" || k === "chapitre") { const m = v.match(/\d+/); t0.vu = m ? String(+m[0]) : ""; } else notes.push(k.charAt(0).toUpperCase() + k.slice(1) + " : " + v); });
        t0.notes = notes.join(" · ");
        if (cat === "Personnage" && !frC && vo.indexOf("/") > -1) { const p = vo.split("/").map(x => x.trim()).filter(Boolean); t0.vo = t0.fr = p[0]; t0.variantes = p.slice(1); }
        const im = imgs.find(i => i.row === r && i.col >= c0 && i.col < c1 && (!apC || i.col <= apC + 1)); if (im) t0._img = im.file;
        termes.push(t0);
      }
    }
  }
  return { termes, relations, blocsIgnores };
}
async function stImporterFichier(file) {
  stImp = { slug: st.slug, nom: file.name, etat: "lecture", msg: "Lecture du classeur..." }; stRendre();
  try {
    const r = await stXlsxLire(file), d = st.data, cle = (t) => stNorm(t.vo) + "|" + t.cat, ex = new Set(d.termes.map(cle));
    const nouveaux = r.termes.filter((t, i, a) => !ex.has(cle(t)) && a.findIndex(u => cle(u) === cle(t)) === i);
    const exR = new Set((d.relations || []).map(x => stNorm(x.p1) + "|" + stNorm(x.p2)));
    const nvR = r.relations.filter((x, i, a) => !exR.has(stNorm(x.p1) + "|" + stNorm(x.p2)) && a.findIndex(u => stNorm(u.p1) === stNorm(x.p1) && stNorm(u.p2) === stNorm(x.p2)) === i);
    stImp = { slug: st.slug, nom: file.name, etat: "apercu", msg: "", total: r.termes.length, nouveaux, nvR, rel: r.relations.length, ignores: r.blocsIgnores };
  } catch (e) { stImp = { slug: st.slug, nom: file.name, etat: "erreur", msg: e.message || String(e) }; }
  stRendre();
}
async function stValiderImport() {
  const I = stImp, d = st.data; if (!I || I.etat !== "apercu") return;
  I.etat = "ecriture"; I.msg = "Enregistrement..."; stRendre();
  try {
    let nbP = 0;
    for (const t of I.nouveaux) {
      const id = stId(); const x = Object.assign({}, t, { id }); delete x._img;
      if (t._img) { try { const b = await t._img.async("blob"), r = await stReduireImage(b, 160); x.portrait = "images/" + id + ".jpg"; stImgPending[st.slug + "/" + x.portrait] = r; nbP++; } catch (e) {} }
      d.termes.push(x);
    }
    d.relations = d.relations || [];
    I.nvR.forEach(x => d.relations.push({ id: stId(), p1: x.p1, p2: x.p2, reg: x.reg }));
    await stSauver(st.serie.title + " : import du glossaire " + I.nom + " (" + I.nouveaux.length + " termes, " + I.nvR.length + " relations)");
    stImp = { slug: st.slug, etat: "fini", msg: "Importé : " + plural(I.nouveaux.length, "terme", "termes") + ", " + plural(I.nvR.length, "relation", "relations") + ", " + plural(nbP, "portrait", "portraits") + "." };
  } catch (e) { stImp = Object.assign(I, { etat: "apercu", msg: e.message }); }
  stRendre();
}
function stPanneauImport(wrap) {
  const I = stImp && stImp.slug === st.slug ? stImp : null, p = h("div", "panel pad st-f st-stack"); p.style.marginBottom = "14px";
  const fi = h("input"); fi.type = "file"; fi.accept = ".xlsx"; fi.hidden = true; fi.id = "st-xlsx";
  fi.onchange = () => { if (fi.files[0]) stImporterFichier(fi.files[0]); };
  const dz = h("div", "st-drop"); dz.append(stEl("b", "", "Importer un glossaire (.xlsx)"), h("span", "", "Glisse le fichier ici ou clique pour le choisir. Les termes existants ne sont jamais supprimés."));
  dz.onclick = () => fi.click();
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) stImporterFichier(f); });
  p.append(dz, fi);
  if (I) {
    if (I.msg) p.append(h("p", "st-msg" + (I.etat === "erreur" ? " err" : I.etat === "fini" ? " ok" : ""), I.msg));
    if (I.etat === "apercu" || I.etat === "ecriture") {
      const par = {}; I.nouveaux.forEach(t => { par[t.cat] = (par[t.cat] || 0) + 1; });
      p.append(h("p", "", I.nom + " : " + plural(I.total, "terme", "termes") + " lus, dont " + plural(I.nouveaux.length, "nouveau", "nouveaux") + " (" + (Object.keys(par).map(k => par[k] + " " + k).join(", ") || "aucun") + "), " + plural(I.nvR.length, "relation nouvelle", "relations nouvelles") + " sur " + I.rel + ", " + plural(I.nouveaux.filter(t => t._img).length, "portrait", "portraits") + ". Les termes déjà présents sont ignorés."));
      const a = h("div", "st-actions"), ok = h("button", "btn", "Importer " + plural(I.nouveaux.length, "terme", "termes")); ok.type = "button"; ok.disabled = I.etat === "ecriture" || (!I.nouveaux.length && !I.nvR.length); ok.onclick = stValiderImport;
      const no = h("button", "btn ghost", "Annuler"); no.type = "button"; no.disabled = I.etat === "ecriture"; no.onclick = () => { stImp = null; stRendre(); };
      a.append(no, ok); p.append(a);
    }
  }
  wrap.append(p);
}
