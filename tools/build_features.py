"""Rebuilds the parts of the website that come from the bot: the dashboard-feature cards and count on the Features page,
a page for each feature (/features/<name>), the sitemap and llms.txt, then refreshes every ?v= cache-buster.

    python3 tools/build_features.py path/to/bev_bot.py            # build into site/
    python3 tools/build_features.py path/to/bev_bot.py --check    # only check it would change nothing it shouldn't

Things only the website knows (other names people search for, Preview buttons, the Commands section of each page) are
kept in tools/extras.json. Run with --extract once to (re)make extras.json from the current site/."""
import hashlib, html, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
bot_path = sys.argv[1]
os.environ["BOT_DIR"] = os.path.dirname(os.path.abspath(bot_path))
os.environ.setdefault("DB_PATH", os.path.join(HERE, ".build.db"))
sys.path.insert(0, HERE)
import cards                                    # noqa: E402  (imports the bot)
b, E = cards.b, cards.E
CATS = {key: label for key, _, label in b.CATEGORIES} if hasattr(b, "CATEGORIES") else {}
EXTRAS = os.path.join(HERE, "extras.json")


def read(path):
    with open(os.path.join(SITE, path), encoding="utf-8") as fh:
        return fh.read()


def write(path, text):
    with open(os.path.join(SITE, path), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def slug_of(f):
    return f.key.replace("_", "-")


KIND = {"channel": "a channel", "channels": "channels", "role": "a role", "roles": "roles", "users": "members", "words": "a list of words",
        "list": "a list", "text": "text", "number": "a number", "toggle": "on/off", "choice": "a choice", "multi": "several choices"}


def choice_text(st):
    """The choices, or for a very long list (like every time zone) the first few and how many there are."""
    labels = [lab for _, lab, _ in st.options]
    if st.kind == "choice" and len(labels) > 60:
        return ", ".join(labels[:5]) + f" … ({len(labels)} in all)"
    return ", ".join(labels)


def setting_li(st):
    out = f'<li><b>{E(st.label)}</b> <span class="kind">({KIND.get(st.kind, st.kind)})</span>'
    if st.help:
        out += f'<br><span class="shelp">{E(st.help)}</span>'
    if st.options:
        out += f'<br><span class="sopts">Choices: {E(choice_text(st))}</span>'
    if st.fields:
        out += f'<br><span class="shelp">Each one has (up to {st.max_items}):</span><ul class="subf">' + "".join(f"<li>{E(sf.label)}" + (f' <span class="sopts">({E(", ".join(lab for _, lab, _ in sf.options))})</span>' if sf.options else "") + "</li>"
                                                                                                    for sf in st.fields) + "</ul>"
    return out + "</li>"


def page(f, extras, template):
    x = extras.get(f.key, {})
    slug, aliases = slug_of(f), x.get("aliases", [])
    squash = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())
    other = [a for a in aliases if squash(a) not in squash(f.name)]      # the title adds the first name people use that isn't in its own
    title = f"{f.name}{f' ({other[0]})' if other else ''} | BEV Discord bot"
    desc = f"{f.name} in BEV, the free all-in-one Discord bot: {f.about}"
    ld = {"@context": "https://schema.org", "@type": "WebPage", "name": title, "description": desc[:300], "url": f"https://bevbotdiscord.com/features/{slug}",
          "isPartOf": {"@type": "WebSite", "name": "BEV", "url": "https://bevbotdiscord.com"},
          "about": {"@type": "SoftwareApplication", "name": "BEV", "applicationCategory": "CommunicationApplication", "operatingSystem": "Discord",
                    "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}, "featureList": [f.name] + aliases}}
    same = ([(slug_of(g), g.icon, g.name) for g in b.FEATURES if g.category == f.category and g.key != f.key]
            + [(t[0].replace("_", "-"), t[2], t[1]) for t in getattr(b, "TOOLS", []) if t[3] == f.category])[:8]
    settings = ('<section class="sec"><h2 class="disp">Settings</h2><ul class="setlist">' + "".join(setting_li(st) for st in f.settings) + "</ul></section>") if f.settings else ""
    fill = {
        "TITLE": E(title), "DESC": E(desc[:300]), "SLUG": slug, "KEYWORDS": E(", ".join([f.name] + aliases + ["Discord bot", "free Discord bot", "BEV"])),
        "LD": json.dumps(ld, ensure_ascii=False).replace("</", "<\\/"), "CAT": f.category, "CATNAME": E(CATS.get(f.category, f.category.title())),
        "NAME": E(f.name), "ICON": f.icon, "ABOUT": E(f.about),
        "AKA": ('<p class="aka"><b>Also known as:</b> ' + " ".join(f'<span class="k on sm">{E(a)}</span>' for a in aliases) + "</p>") if aliases else "",
        "PANEL": x.get("panel") or STANDARD_PANEL, "SETTINGS": settings, "COMMANDS": x.get("commands", ""),
        "RELATED": "".join(f'<a class="pill" href="/features/{sl}">{ic} {E(nm)}</a> ' for sl, ic, nm in same),
    }
    return re.sub(r"\{\{([A-Z]+)\}\}", lambda m: fill[m.group(1)], template)


TEMPLATE_FILE = os.path.join(HERE, "feature_page.html")
STANDARD_PANEL = ('\n<p class="lab">A free BEV dashboard feature</p>\n<p>Switch it on and set it up on the <a class="inl" href="/dashboard">BEV dashboard</a>. '
                  'Everything below can be changed there, with a preview before anything is posted.</p>\n\n')


def extract():
    page_html = read("features.html")
    extras = cards.extract_extras(page_html)
    for f in b.FEATURES:
        path = os.path.join(SITE, "features", slug_of(f) + ".html")
        if not os.path.exists(path):
            continue
        s = open(path, encoding="utf-8").read()
        p = re.search(r'<div class="panel fdetail">(.*?)</div>\n</section>', s, re.S)
        c = re.search(r'(<section class="sec"><h2 class="disp">Commands</h2>.*?</section>)', s, re.S)
        extras.setdefault(f.key, {})["panel"] = p.group(1) if p else ""
        a = re.search(r'<p class="aka"><b>Also known as:</b> (.*?)</p>', s)
        extras[f.key]["aliases"] = [html.unescape(x) for x in re.findall(r'<span class="k on sm">(.*?)</span>', a.group(1))] if a else []
        extras[f.key].pop("keywords", None)
        extras[f.key]["commands"] = c.group(1) if c else ""
    with open(EXTRAS, "w", encoding="utf-8") as fh:
        json.dump(extras, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"extras.json: {len(extras)} features")


def file_hashes():
    """?v= cache-busters are the first 10 characters of each file's sha256."""
    out = {}
    for name in os.listdir(SITE):
        full = os.path.join(SITE, name)
        if os.path.isfile(full) and name.endswith((".js", ".css", ".png", ".json")):
            out[name] = hashlib.sha256(open(full, "rb").read()).hexdigest()[:10]
    return out


def bust(text, hashes):
    return re.sub(r'/([A-Za-z0-9_.-]+\.(?:js|css|png|json))\?v=[0-9a-f]{10}',
                  lambda m: f"/{m.group(1)}?v={hashes[m.group(1)]}" if m.group(1) in hashes else m.group(0), text)


def build(check=False):
    extras = json.load(open(EXTRAS, encoding="utf-8"))
    template = open(TEMPLATE_FILE, encoding="utf-8").read()
    hashes = file_hashes()
    changed = []
    # 1) one page per feature
    for f in b.FEATURES:
        path = f"features/{slug_of(f)}.html"
        new = bust(page(f, extras, template), hashes)
        old = read(path) if os.path.exists(os.path.join(SITE, path)) else None
        if old != new:
            changed.append(path)
            if not check:
                write(path, new)
    # 2) the cards on the Features page, group by group, and the count
    fp = read("features.html")
    for cat in dict.fromkeys(f.category for f in b.FEATURES):
        body = "".join(cards.card(f, extras) for f in b.FEATURES if f.category == cat)
        fp, n = re.subn(rf'(<div class="fgroup" id="dash-{cat}"><h3 class="disp fgh">[^<]+</h3><div class="grid">).*?(</div></div><div class="fgroup")',
                        lambda m: m.group(1) + body + m.group(2), fp, count=1, flags=re.S)
        if not n:
            raise SystemExit(f"Couldn't find the {cat} group on the Features page")
    fp = re.sub(r'(<span class="stat" id="found" aria-live="polite">\d+ commands, )\d+( features</span>)', rf"\g<1>{len(b.FEATURES)}\g<2>", fp)
    fp = bust(fp, hashes)
    if fp != read("features.html"):
        changed.append("features.html")
        if not check:
            write("features.html", fp)
    # 3) sitemap: every feature page listed once, new ones after the last feature
    sm = read("sitemap.xml")
    for f in b.FEATURES:
        loc = f"<url><loc>https://bevbotdiscord.com/features/{slug_of(f)}</loc></url>"
        if loc not in sm:
            prev = [g for g in b.FEATURES[: b.FEATURES.index(f)] if f"/features/{slug_of(g)}<" in sm]
            anchor = f"<url><loc>https://bevbotdiscord.com/features/{slug_of(prev[-1])}</loc></url>\n" if prev else "</urlset>"
            sm = sm.replace(anchor, anchor + loc + "\n", 1) if prev else sm.replace(anchor, loc + "\n" + anchor, 1)
    if sm != read("sitemap.xml"):
        changed.append("sitemap.xml")
        if not check:
            write("sitemap.xml", sm)
    # 4) llms.txt: a line for any feature it doesn't mention yet, after the previous feature's lines
    lt = read("llms.txt")
    for f in b.FEATURES:
        if re.search(rf"^- {re.escape(f.name)}[ :(]", lt, re.M):
            continue
        lines = [f"- {f.name}: {f.about} Page: https://bevbotdiscord.com/features/{slug_of(f)}"]
        for st in f.settings:
            bit = f"  - Setting: {st.label}."
            if st.help:
                bit += f" {st.help.rstrip('.')}."
            if st.options:
                bit += " Choices: " + choice_text(st) + "."
            if st.fields:
                bit += " Each has: " + ", ".join(sf.label for sf in st.fields) + "."
            lines.append(bit)
        prev = [g for g in b.FEATURES[: b.FEATURES.index(f)] if re.search(rf"^- {re.escape(g.name)}[ :(]", lt, re.M)]
        if prev:
            m = re.search(rf"^- {re.escape(prev[-1].name)}[ :(].*?\n(?:  - .*\n)*", lt, re.M)
            lt = lt[: m.end()] + "\n".join(lines) + "\n" + lt[m.end():]
        else:
            lt += "\n" + "\n".join(lines) + "\n"
    if lt != read("llms.txt"):
        changed.append("llms.txt")
        if not check:
            write("llms.txt", lt)
    # 5) cache-busters on every other page
    for root, _, files in os.walk(SITE):
        for name in files:
            if not name.endswith(".html") and name != "_worker.js":
                continue
            rel = os.path.relpath(os.path.join(root, name), SITE)
            s = read(rel)
            t = bust(s, hashes)
            if t != s and rel not in changed:
                changed.append(rel)
                if not check:
                    write(rel, t)
    return changed


if __name__ == "__main__":
    if "--extract" in sys.argv:
        extract()
    else:
        out = build(check="--check" in sys.argv)
        print(("Would change" if "--check" in sys.argv else "Changed"), len(out), "file(s):")
        for p in out:
            print("  " + p)
