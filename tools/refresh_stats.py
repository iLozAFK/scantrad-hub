#!/usr/bin/env python3
"""
Met à jour les statistiques de l'accueil (data/data.js -> STATS) avec les NOUVEAUX chapitres.

Source unique : D:\\ScanTrad\\Scanlation\\[Cloud]   (Poséidon Scans\\<série>\\Chapitres [Manhwa]\\*.docx
                                                    et Ortega Scans\\<série>\\*.docx)
- Le passé (Drive, archives, anciens dossiers) est déjà dans STATS et n'est jamais modifié.
- Seuls les chapitres absents de STATS sont ajoutés (clé : série + rôle + numéro du chapitre).
- Le rôle est celui de la série dans data.js (TL, sinon CH).
- Ne touche pas à `chapitre` / `dernier` des séries : ceux-là se règlent dans l'admin.

Usage :   python tools/refresh_stats.py
"""
import collections, datetime, html, json, os, re, sys, unicodedata
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "data.js"
CLOUD = Path(r"D:\ScanTrad\Scanlation\[Cloud]")
BLOC_MIN = 4          # >= 4 chapitres d'une même série/rôle dans la même tranche de 5 min = copie en bloc

def norm(s):
    s = unicodedata.normalize("NFKD", html.unescape(s)).lower().replace("’", "'").replace("'", "")
    s = re.sub(r"\b(the|a|an)\b", " ", s)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()

def score(a, b):
    a, b = norm(a), norm(b)
    return 1.0 if a and a == b else (SequenceMatcher(None, a, b).ratio() if a and b else 0)

def chap_num(name):
    n = re.sub(r"\(\s*\d+\s*\)", " ", name)
    n = re.sub(r"(?i)stitched|checked|copie de", " ", n)
    m = re.search(r"(?i)chap(?:t|itre)?\s*0*(\d{1,4})", n) or re.search(r"(\d{1,4})(?!\d)", n)
    return (m.group(1).lstrip("0") or "0") if m else None

def main():
    t = DATA.read_text(encoding="utf-8")
    d = json.loads(t[t.index("{"):t.rindex("}") + 1])
    S = d["SERIES"]
    st = d.setdefault("STATS", {"evenements": []})
    connus = {tuple(e.split("|")[1:4]) for e in st["evenements"]}          # (série, rôle, n°)
    def role_de(s):
        r = s.get("roles", [])
        return next((x for x in ("TL", "CH", "CL", "ED") if x in r), (r[0] if r else "TL"))
    nouveaux = {}
    for team in CLOUD.iterdir():
        if not team.is_dir(): continue
        for serie in team.iterdir():
            if not serie.is_dir(): continue
            s = max(S, key=lambda x: score(x["title"], serie.name))
            if score(s["title"], serie.name) < 0.85: continue
            base = serie / "Chapitres [Manhwa]" if (serie / "Chapitres [Manhwa]").is_dir() else serie
            for dp, _, fn in os.walk(base):
                if any(w in dp.lower() for w in ("novel", "raw", "anglaise", "english")): continue   # pas ton travail
                for f in fn:
                    if not f.lower().endswith(".docx") or f.startswith("~$"): continue
                    n = chap_num(f)
                    if n is None: continue
                    k = (s["title"], role_de(s), n)
                    if k in connus: continue
                    m = os.path.getmtime(os.path.join(dp, f))
                    if k not in nouveaux or m < nouveaux[k]: nouveaux[k] = m
    rows = sorted((m, k) for k, m in nouveaux.items())
    grp = collections.Counter((k[0], k[1], int(m // 300)) for m, k in rows)
    ajout = ["%s|%s|%s|%s%s" % (datetime.datetime.fromtimestamp(m).strftime("%Y-%m-%dT%H:%M"), k[0], k[1], k[2],
                                 "|b" if grp[(k[0], k[1], int(m // 300))] >= BLOC_MIN else "") for m, k in rows]
    st["evenements"] = sorted(st["evenements"] + ajout)
    st["maj"] = datetime.date.today().isoformat()
    DATA.write_text("window.HUB = " + json.dumps(d, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8", newline="\n")
    print("%d nouveau(x) chapitre(s) ajouté(s) | total : %d | mise à jour : %s" % (len(ajout), len(st["evenements"]), st["maj"]))
    for a in ajout[-10:]: print("   +", a)

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
