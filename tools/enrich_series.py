#!/usr/bin/env python3
"""
Enrichit chaque série de data/data.js avec une clé `infos` (noms en plusieurs langues, créateurs, éditeurs d'origine,
genres, tags, année, statut et nombre de chapitres de la VO, note...) à partir de :
  1. MangaUpdates (API publique)            -> source principale
  2. Ortega Scans (noms alternatifs, auteur) -> pour les séries Ortega
  3. Asura Scans (titres alternatifs)        -> complète le coréen et le français

Usage :   python tools/enrich_series.py            (toutes les séries sans `infos`)
          python tools/enrich_series.py --force    (refait tout)
          python tools/enrich_series.py "Love Quest" "Tower"   (seulement ces séries)
Un cache (tools/.cache_mu.json) évite de redemander à MangaUpdates ce qui a déjà été lu.
Une requête par seconde maximum, pour rester poli avec les sites.
"""
import html, io, json, re, subprocess, sys, time, unicodedata, urllib.parse
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "data.js"
CACHE = Path(__file__).resolve().parent / ".cache_mu.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
PAUSE = 1.0
# noms sous lesquels la série est connue ailleurs (quand le titre du hub n'est pas celui de MangaUpdates)
ALIAS = {
    "Monarch of Death": ["Death King Karnak"],
    "Broken Constellation": ["Return of the Shattered Constellation", "Return of the Broken Constellation"],
    "The World After The End": ["The World After the Fall", "The World After the End"],
    "Solo Max Level Newbie": ["Solo Max-Level Newbie"],
    "Return of The Unrivaled Spear Knight": ["Return of the Legendary Spear Knight", "Return of the Unrivaled Spear Knight"],
    "Return of the Mount Hua Sect": ["Return of the Blossoming Blade", "Return of the Mount Hua Sect"],
    "The Academy Genius Tamer": ["The Academy's Genius Tamer", "Academy's Genius Tamer"],
}
HANGUL = re.compile(r"[가-힣]")
CJK_KANA = re.compile(r"[぀-ヿ一-鿿฀-๿Ѐ-ӿ؀-ۿ]")
FR_MOTS = {"le", "la", "les", "du", "des", "de", "d", "l", "un", "une", "et", "au", "aux", "retour", "roi", "ma", "mon", "mes", "dans", "sur", "pour", "qui", "que", "est", "je", "il", "elle", "monde", "vie", "ne", "pas"}
EN_MOTS = {"the", "of", "and", "is", "to", "in", "a", "my", "with", "for", "i", "from", "who", "that"}

def norm(s):
    s = unicodedata.normalize("NFKD", html.unescape(s)).lower().replace("’", "'").replace("'", "")
    s = re.sub(r"\b(the|a|an)\b", " ", s)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()

def sim(a, b):
    a, b = norm(a), norm(b)
    return 1.0 if a and a == b else (SequenceMatcher(None, a, b).ratio() if a and b else 0)

def curl(url, body=None):
    cmd = ["curl", "-sS", "-L", "-m", "40", "-A", UA]
    if body is not None: cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    for _ in range(3):
        r = subprocess.run(cmd + [url], capture_output=True)
        if r.returncode == 0 and r.stdout:
            time.sleep(PAUSE)
            return r.stdout.decode("utf-8", "replace")
        time.sleep(3)
    return ""

def jget(url, body=None):
    try: return json.loads(curl(url, body))
    except Exception: return {}

FR_EX = {"le", "les", "du", "des", "au", "aux", "retour", "et", "dans", "qui", "que", "est", "je", "mon", "mes", "pour", "sur", "pas", "ne", "monde", "vie", "roi", "l", "d", "ma", "elle", "il", "une", "un", "la", "de", "en"}
ES_EX = {"el", "los", "las", "del", "y", "con", "por", "regreso", "retorno", "secta", "su", "al", "es", "lo", "mi", "una", "mundo", "vida", "rey"}
PT_EX = {"o", "os", "do", "da", "dos", "das", "seita", "uma", "um", "não", "com", "para", "retorno", "mundo", "vida", "rei"}
EN_EX = {"the", "of", "and", "is", "to", "in", "my", "with", "for", "i", "from", "who", "that", "it"}
FR_LETTRES = set("abcdefghijklmnopqrstuvwxyzàâäçéèêëîïôöùûüÿœæ")

def is_fr(nom):
    """Heuristique : nom latin, uniquement des lettres françaises, avec davantage de repères français que d'autres langues."""
    low = nom.lower().replace("’", "'")
    if any(c.isalpha() and c not in FR_LETTRES for c in low): return False          # coréen, vietnamien, cyrillique...
    mots = [m for m in re.split(r"[\s'\-:!?.,]+", low) if m]
    fr = sum(1 for m in mots if m in FR_EX) + (2 if re.search(r"[àâçéèêëîïôùûœ]", low) else 0)
    exclusifs = sum(1 for m in mots if m in {"le", "les", "du", "des", "au", "aux", "retour", "et", "dans", "qui", "que", "est", "mon", "mes", "pour", "sur", "pas", "ne", "l", "d", "ma", "elle", "il"})
    autres = sum(1 for m in mots if m in ES_EX or m in PT_EX or m in EN_EX)
    return fr >= 2 and exclusifs >= 1 and fr > autres

# ------------------------------------------------------------------ MangaUpdates
def mu_detail(cache, sid):
    k = "d%s" % sid
    if k not in cache: cache[k] = jget("https://api.mangaupdates.com/v1/series/%s" % sid)
    return cache[k]

ADULTE = {"Adult", "Smut", "Hentai", "Ecchi", "Mature"}

def mu_find(cache, titre, alias, adulte=False):
    noms = [titre] + alias
    cand = {}
    for q in noms[:3]:
        key = "s:" + q
        if key not in cache: cache[key] = jget("https://api.mangaupdates.com/v1/series/search", {"search": q, "perpage": 8})
        for x in cache[key].get("results", [])[:4]:                     # les mieux classés par MangaUpdates
            r = x.get("record", {})
            if r.get("series_id") and "novel" not in (r.get("type") or "").lower(): cand.setdefault(r["series_id"], r)
    best = None
    for r in list(cand.values())[:6]:
        d = mu_detail(cache, r["series_id"])
        if not d.get("series_id"): continue
        tous = [d.get("title", "")] + [a.get("title", "") for a in d.get("associated", [])]
        sc = max(sim(n, t) for n in noms for t in tous)
        genres = {g.get("genre") for g in d.get("genres", [])}
        if d.get("type") not in ("Manhwa", "Manhwa (Korean)"): continue                 # un manhwa ne correspond pas à un manhua ou à un manga
        if adulte and not (genres & ADULTE): continue                       # une série Ortega est un pornhwa : genre adulte obligatoire
        if not adulte and genres & {"Adult", "Hentai", "Smut"}: continue    # et inversement
        if sc >= 0.93 and (not best or sc > best[0]): best = (sc, d)
        if sc >= 0.99: break
    return best

# ------------------------------------------------------------------ Ortega / Asura
def ortega_info(titre):
    sl = re.sub(r"[^a-z0-9]+", "-", norm(titre)).strip("-")
    p = curl("https://ortegascans.fr/serie/" + sl)
    m = re.search(r'alternativeNames\\+"?:\\+"(.*?)\\+"', p)
    a = re.search(r'\\"author\\":\\"(.*?)\\"', p)
    return {"alt": [x.strip() for x in html.unescape(m.group(1)).replace("\\", "").split(",") if x.strip()] if m else [],
            "auteur": a.group(1) if a else ""}

def asura_alts(cache, titre, alias):
    key = "a:" + titre
    if key not in cache: cache[key] = jget("https://api.asurascans.com/api/series?search=" + urllib.parse.quote((alias or [titre])[0]))
    for x in cache[key].get("data") or []:
        noms = [x.get("title", "")] + [a for a in (x.get("alt_titles") or []) if isinstance(a, str)]
        if max(sim(n, t) for n in [titre] + alias for t in noms) >= 0.93:
            return {"alt": [a for a in (x.get("alt_titles") or []) if isinstance(a, str)], "auteur": x.get("author") or "", "artiste": x.get("artist") or ""}
    return {"alt": [], "auteur": "", "artiste": ""}

# ------------------------------------------------------------------ assemblage
def clean_list(xs):
    out, vu = [], set()
    for x in xs:
        x = re.sub(r"\s+", " ", (x or "").strip())
        if not x: continue
        k = norm(x) or x                       # les noms non latins (coréen...) se comparent tels quels
        if k in vu: continue
        vu.add(k); out.append(x)
    return out

def mu_find_ko(cache, kos, adulte=False):
    """Dernier recours : chercher par le nom coréen (connu par Ortega ou Asura) et exiger ce nom exact dans la fiche."""
    for ko in kos[:2]:
        key = "s:" + ko
        if key not in cache: cache[key] = jget("https://api.mangaupdates.com/v1/series/search", {"search": ko, "perpage": 8})
        for x in cache[key].get("results", [])[:4]:
            r = x.get("record", {})
            if not r.get("series_id") or r.get("type") != "Manhwa": continue
            d = mu_detail(cache, r["series_id"])
            genres = {g.get("genre") for g in d.get("genres", [])}
            if adulte and not (genres & ADULTE): continue
            if not adulte and genres & {"Adult", "Hentai", "Smut"}: continue
            if any(_ko_norm(a.get("title")) == _ko_norm(ko) for a in d.get("associated", [])) or _ko_norm(d.get("title")) == _ko_norm(ko):
                return (1.0, d)
    return None

def ko_propres(ko):
    """Noms coréens utilisables pour une recherche : sans chaînes parasites, hangeul pur en premier (pas de caractères chinois ni latins)."""
    ko = [k for k in ko if "•" not in k and len(k) <= 60]
    return sorted(ko, key=lambda k: 1 if (re.search(r"[一-鿿㐀-䶿]", k) or re.search(r"[A-Za-z]", k)) else 0)

def construire(s, cache):
    titre = s["title"]; alias = ALIAS.get(titre, [])
    mu = mu_find(cache, titre, alias, s.get("type") == "Pornhwa")
    d = mu[1] if mu else {}
    ort = ortega_info(titre) if "Ortega Scans" in (s.get("teams") or [s["team"]]) else {"alt": [], "auteur": ""}
    asu = asura_alts(cache, titre, alias)
    ko0 = [n for n in clean_list(ort["alt"] + asu["alt"]) if HANGUL.search(n)]
    if not mu and ko0:
        mu = mu_find_ko(cache, ko0, s.get("type") == "Pornhwa"); d = mu[1] if mu else {}
    toutes = [a.get("title", "") for a in d.get("associated", [])] + ort["alt"] + asu["alt"]
    toutes = clean_list(toutes)
    ko = ko_propres([n for n in toutes if HANGUL.search(n)])
    fr = [n for n in toutes if is_fr(n) and norm(n) != norm(titre) and not any(norm(n) == norm(x) for x in alias)]
    autres = [n for n in toutes if n not in ko and n not in fr and norm(n) != norm(titre)]
    auteurs = [a["name"] for a in d.get("authors", []) if a.get("type") == "Author"]
    artistes = [a["name"] for a in d.get("authors", []) if a.get("type") == "Artist"]
    if not auteurs and (ort.get("auteur") or asu.get("auteur")): auteurs = [ort.get("auteur") or asu.get("auteur")]
    if not artistes and asu.get("artiste"): artistes = [asu["artiste"]]
    pubs = d.get("publishers", [])
    infos = {
        "mu": ({"id": d["series_id"], "url": d.get("url"), "note": d.get("bayesian_rating"), "votes": d.get("rating_votes")} if d.get("series_id") else None),
        "noms": {"fr": fr[:3], "ko": ko[:3], "autres": autres[:10]},
        "auteurs": clean_list(auteurs), "artistes": clean_list(artistes),
        "editeurs": clean_list([p["publisher_name"] for p in pubs if p.get("type") == "Original"]),
        "editeurs_en": clean_list([p["publisher_name"] for p in pubs if p.get("type") == "English"]),
        "genres": [g["genre"] for g in d.get("genres", [])],
        "tags": [c["category"] for c in sorted(d.get("categories", []), key=lambda c: -(c.get("votes") or 0))][:12],
        "annee": int(d["year"]) if str(d.get("year") or "").isdigit() else None,
        "type_vo": d.get("type"),
        "termine": bool(d.get("completed")) if d.get("series_id") else None,
        "licence": bool(d.get("licensed")) if d.get("series_id") else None,
        "chapitres_vo": int(d["latest_chapter"]) if str(d.get("latest_chapter") or "").isdigit() else None,
        "liees": [{"nom": r.get("related_series_name"), "relation": r.get("relation_type")} for r in d.get("related_series", [])][:5],
    }
    return infos, bool(mu)

def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    t = DATA.read_text(encoding="utf-8")
    d = json.loads(t[t.index("{"):t.rindex("}") + 1])
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    sans_mu = []
    for i, s in enumerate(d["SERIES"], 1):
        if args and s["title"] not in args: continue
        if s.get("infos") and not force and not args: continue
        infos, ok = construire(s, cache)
        s["infos"] = infos
        if not ok: sans_mu.append(s["title"])
        n = infos["noms"]
        print("%2d/%d %-46s %s  ko=%s fr=%s | %s" % (i, len(d["SERIES"]), s["title"][:46], "MU✓" if ok else "MU✗", n["ko"][:1], n["fr"][:1], (infos["auteurs"] or ["?"])[0]), flush=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        DATA.write_text("window.HUB = " + json.dumps(d, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8", newline="\n")
    print("\nSans fiche MangaUpdates :", sans_mu or "aucune")

if __name__ == "__main__":
    main()
