"""Rebuilds the Features page's dashboard-feature cards from the bot itself. Things only the website knows (other names
people search for, which features have a Preview button) live in extras.json, made once from the last built site."""
import sys, re, html, json, os
sys.path.insert(0, os.environ.get("BOT_DIR", "/home/claude/bevmasterbot"))
import bev_bot as b

E = lambda t: html.escape(str(t), quote=True)


def card(f, extras):
    x = extras.get(f.key, {})
    slug = f.key.replace("_", "-")
    labels = [s.label for s in f.settings]
    cmds = list(f.member_commands)
    aliases = x.get("aliases", [])
    subs = [sf.label for st in f.settings for sf in (st.fields or [])]
    search = " ".join([f.name, f.about, " ".join(labels), " ".join(cmds), " ".join(aliases), " ".join(subs)]).lower()
    out = [f'<div class="cmd fcard" data-search="{E(search)}"><div class="chips"><span class="k on">{f.icon} {E(f.name)}</span></div>',
           f'<p>{E(f.about)}</p>']
    if aliases:
        out.append(f'<p class="aka sm"><b>Also called:</b> {E(", ".join(aliases[:5]))}</p>')   # the card shows 5; search uses all
    if cmds:
        out.append('<p class="setl"><b>Members use:</b> ' + " ".join(f'<span class="k mono on sm">/{E(c)}</span>' for c in cmds) + '</p>')
    if labels:
        out.append(f'<details class="more"><summary>{len(labels)} setting{"s" if len(labels) != 1 else ""}</summary><p class="setl">{E(", ".join(labels))}</p></details>')
    else:
        out.append('<p class="setl">No extra settings: just switch it on.</p>')
    out.append(f'<p class="fmore"><a class="inl" href="/features/{slug}">Everything about {E(f.name)} →</a></p>')
    if x.get("preview"):
        out.append(f'<p class="fpvrow"><button type="button" class="mini pvbtn fpv" data-preview="{f.key}" data-name="{E(f.name)}" aria-haspopup="dialog">👀 Preview</button></p>')
    out.append('</div>')
    return "".join(out)


def site_cards(page):
    """slug -> the card's HTML, from a built Features page."""
    cards = {}
    for m in re.finditer(r'<div class="cmd fcard" data-search=.*?href="/features/([a-z0-9-]+)">Everything about.*?</p>(?:<p class="fpvrow">.*?</p>)?</div>', page, re.S):
        cards[m.group(1)] = m.group(0)
    return cards


def extract_extras(page):
    extras = {}
    for slug, h in site_cards(page).items():
        key = slug.replace("-", "_")
        a = re.search(r'<p class="aka sm"><b>Also called:</b> (.*?)</p>', h)
        extras[key] = {"aliases": html.unescape(a.group(1)).split(", ") if a else [], "preview": "data-preview=" in h}
        f = b.FEATURE.get(key)
        if f is not None:                                # search words that aren't shown on the card
            extras[key]["keywords"] = []
            mine = re.search(r'data-search="(.*?)"', card(f, extras)).group(1)
            site = re.search(r'data-search="(.*?)"', h).group(1)
            subs = " ".join(sf.label for st in f.settings for sf in (st.fields or [])).lower()
            head = mine[: len(mine) - len(E(subs))] if subs else mine
            if site != mine and site.startswith(head) and site.endswith(E(subs)):
                extra = html.unescape(site[len(head): len(site) - len(E(subs))]).strip()
                extras[key]["keywords"] = [extra] if extra else []
    return extras


if __name__ == "__main__":
    page = open(sys.argv[1]).read()
    extras = extract_extras(page)
    have = site_cards(page)
    same = diff = 0
    for f in b.FEATURES:
        slug = f.key.replace("_", "-")
        if slug not in have:
            print("new:", slug); continue
        mine = card(f, extras)
        if mine == have[slug]:
            same += 1
        else:
            diff += 1
            if diff <= 3:
                for i, (p, q) in enumerate(zip(mine, have[slug])):
                    if p != q:
                        print(slug, "\n mine:", mine[max(0, i-80):i+120], "\n site:", have[slug][max(0, i-80):i+120]); break
                else:
                    print(slug, "length differs", len(mine), len(have[slug]))
    print("same", same, "diff", diff)
