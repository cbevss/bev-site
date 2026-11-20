"""Browser check of the raffle's date and time picker on the dashboard: calendar, HH : MM boxes, the time zone list
(with typo search), and that Save sends "YYYY-MM-DD HH:MM" plus the time zone. Uses the real bot's settings.

    python3 tools/check_raffle_picker.py path/to/bev_bot.py     (needs: pip install playwright && playwright install chromium)"""
import functools, http.server, json, os, re, sys, tempfile, threading

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(), "t.db"))
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])))
import bev_bot as b                                          # noqa: E402
from playwright.sync_api import sync_playwright              # noqa: E402

f = b.FEATURE["raffle"]
vals = b.cfg_all(1)
sets = [dict(b.setting_public(None, s, vals[s.key])) for s in f.settings]
for x in sets:
    if x["key"] == "raffle_when":
        x["value"] = "later"
CFG = json.dumps({"guild": {"id": "1", "name": "Test", "icon": None, "members": 5},
                  "categories": [{"key": k, "icon": i, "name": n} for k, i, n in b.CATEGORIES],
                  "features": [{"key": f.key, "name": f.name, "icon": f.icon, "category": f.category, "command": None, "about": f.about,
                                "member_commands": [], "enabled": True, "setup_ok": True, "needs_setup": False, "settings": sets}],
                  "channels": [{"id": "55", "name": "raffles", "type": "text", "category": None}], "roles": []})
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SITE)
http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/dashboard.html?guild=1"
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("FAIL", name, extra)


def run(width):
    saved, errs = {}, []

    def route(r):
        u = r.request.url
        if "/api/servers" in u:
            return r.fulfill(json={"user": {"name": "Tester", "id": "9"}, "servers": [{"id": "1", "name": "Test", "dashboard": True}]})
        if "/api/config" in u and r.request.method == "POST":
            saved.update(json.loads(r.request.post_data))
            return r.fulfill(json={"ok": True, "notes": [], "problems": []})
        if "/api/config" in u:
            return r.fulfill(body=CFG, content_type="application/json")
        if "/api/" in u:
            return r.fulfill(json={})
        return r.continue_()

    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_page(viewport={"width": width, "height": 1600})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.route("**/*", route)
        pg.goto(URL)
        pg.wait_for_timeout(1500)
        pg.evaluate("document.querySelectorAll('dialog[open]').forEach(d => d.close())")
        pg.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)")
        pg.wait_for_timeout(300)
        card = pg.locator('[data-key="raffle_at"]')
        check(f"{width}px: the picker shows, and the time zone isn't shown twice", card.is_visible() and pg.locator('[data-key="raffle_tz"]').is_hidden())
        check(f"{width}px: days before today can't be picked", pg.locator(".calnav").first.is_disabled())
        card.scroll_into_view_if_needed()
        pg.locator(".calnav").nth(1).click()
        pg.locator(".calday:not([disabled])", has_text=re.compile(r"^15$")).first.click()
        pg.fill("#s-raffle_at-h", "18")
        pg.keyboard.type("30")
        check(f"{width}px: two hour digits jump to the minutes box", pg.locator(".dtnum").nth(1).input_value() == "30")
        box = card.locator(".ssin")
        box.click()
        box.fill("new yrok")
        pg.wait_for_timeout(300)
        opts = pg.locator(".sslist:not([hidden]) .ssopt").all_inner_texts()
        check(f"{width}px: the time zone list finds New York even with a typo", any("New York" in o for o in opts), opts[:3])
        pg.locator(".sslist:not([hidden]) .ssopt", has_text="New York").first.click()
        said = pg.locator(".dtsaid").inner_text()
        check(f"{width}px: it says the day and time picked", "15" in said and "18:30" in said and "New York" in said, said)
        pg.locator("#save, button:has-text('Save')").first.click()
        pg.wait_for_timeout(800)
        st = saved.get("settings") or {}
        check(f"{width}px: Save sends the date, time and time zone",
              bool(re.fullmatch(r"\d{4}-\d{2}-15 18:30", st.get("raffle_at", ""))) and st.get("raffle_tz") == "America/New_York", st)
        check(f"{width}px: no script errors", not errs, errs)
        br.close()


for w in (1200, 360):
    run(w)
srv.shutdown()
print(f"{ok}/{ok + fail} passed")
sys.exit(1 if fail else 0)
