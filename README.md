# bevbotdiscord.com

The BEV website, published by Cloudflare Pages straight from this repository.

- **`site/`** is the whole website, exactly as it goes live: the pages, styles, scripts and `_worker.js` (the site's backend).
- Every change pushed to `main` goes live automatically. Cloudflare's build settings: no framework, no build command, **build output directory `site`**.
- Secrets (Discord client secret, bot token, session secret, the bot's key and address) live in Cloudflare under **Settings → Variables and Secrets**, never in these files.
- The site database (maintenance mode, the banner, visit counts and the admin inbox) is the D1 database bound as `SITE_DB`.
