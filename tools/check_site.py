"""Checks the built website in site/: every script parses, every link and file it points to exists, every feature has
its card and page, the counts are right, and build_features.py has nothing left to change (so nothing is stale).

    python3 tools/check_site.py path/to/bev_bot.py"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.normpath(os.path.join(HERE, "..", "site"))
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("FAIL", name, str(extra)[:300])


for name in sorted(os.listdir(SITE)):
    if name.endswith(".js"):
        r = subprocess.run(["node", "--check", os.path.join(SITE, name)], capture_output=True, text=True)
        check(f"{name} parses", r.returncode == 0, r.stderr)

ROUTES = {"/dashboard", "/servers", "/premium", "/discover", "/suggest", "/appeal", "/leaderboard", "/bracket", "/jail-requests",
          "/admin", "/admin-suggestions", "/admin-support", "/terms", "/privacy", "/features", "/support", "/status"}


def exists(url):
    path = url.split("#")[0].split("?")[0]
    if not path or path == "/":
        return True
    if path.startswith(("/auth/", "/api/")) or path.rstrip("/") in ROUTES:
        return True
    p = os.path.join(SITE, path.lstrip("/"))
    return os.path.isfile(p) or os.path.isfile(p + ".html") or os.path.isfile(os.path.join(p, "index.html"))


broken = []
for root, _, files in os.walk(SITE):
    for name in files:
        if not name.endswith(".html"):
            continue
        rel = os.path.relpath(os.path.join(root, name), SITE)
        text = open(os.path.join(root, name), encoding="utf-8").read()
        for url in re.findall(r'(?:href|src)="(/[^"]*)"', text):
            if not exists(url):
                broken.append(f"{rel} -> {url}")
check("every link and file on every page exists", not broken, broken[:10])

if len(sys.argv) > 1:
    bot = sys.argv[1]
    env = dict(os.environ, DB_PATH=os.path.join(HERE, ".check.db"))
    r = subprocess.run([sys.executable, os.path.join(HERE, "build_features.py"), bot, "--check"], capture_output=True, text=True, env=env)
    check("build_features.py has nothing left to change (rebuild if this fails)", r.returncode == 0 and "Would change 0 file" in r.stdout, r.stdout + r.stderr[-500:])
    sys.path.insert(0, os.path.dirname(os.path.abspath(bot)))
    os.environ["DB_PATH"] = env["DB_PATH"]
    import bev_bot as b
    page = open(os.path.join(SITE, "features.html"), encoding="utf-8").read()
    for f in b.FEATURES:
        slug = f.key.replace("_", "-")
        check(f"{slug}: has a page", os.path.isfile(os.path.join(SITE, "features", slug + ".html")))
        check(f"{slug}: has a card on the Features page", f'href="/features/{slug}">Everything about' in page)
        check(f"{slug}: is in the sitemap", f"/features/{slug}<" in open(os.path.join(SITE, "sitemap.xml")).read())
    m = re.search(r"(\d+) commands, (\d+) features", page)
    check("the Features page counts every feature", m and int(m.group(2)) == len(b.FEATURES), m and m.group(0))
    try:
        os.remove(env["DB_PATH"])
    except OSError:
        pass

print(f"{ok}/{ok + fail} passed")
sys.exit(1 if fail else 0)
