# Website build tools

These rebuild the parts of `site/` that come from the bot, so new features show up on the Features page.

    python3 tools/build_features.py ../bevmasterbot/bev_bot.py     # rebuild
    python3 tools/check_site.py ../bevmasterbot/bev_bot.py         # check (scripts parse, links work, nothing stale)

- `build_features.py` writes each feature's card and the count on `features.html`, a page per feature in `features/`,
  the sitemap and `llms.txt`, and refreshes every `?v=` cache-buster (the first 10 characters of the file's sha256).
- `extras.json` keeps what only the website knows: other names people search for, Preview buttons and each page's
  Commands section. `--extract` remakes it from the current `site/`.
- `feature_page.html` is the template for a feature's page.

Needs the bot's packages installed (`pip install -r requirements.txt` in the bot's folder) and Node for `check_site.py`.
