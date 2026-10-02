# Trent's Fresh Spaces

Marketing website + online booking for **Trent's Fresh Spaces**, a professional
interior painting business. *Fresh Spaces. Better Places.*

- **Live:** https://trentsfreshspaces.com (droplet `104.236.120.144`)
- **Contact:** call/text **(717) 882-1183**
- **Design:** navy / blue / white, taken from Trent's poster (`assets/poster.jpg`),
  in an Oranssi-Fluid-inspired layout.

## Structure

```
index.html        # single-page marketing site (hero, services, poster, why-us, FAQ, contact)
                  #   + SEO: canonical, OG/Twitter, geo tags, JSON-LD (HousePainter + FAQPage)
robots.txt        # allows search + AI crawlers (GPTBot, PerplexityBot, ClaudeBot, …); points to sitemap
sitemap.xml       # single-URL sitemap
styles.css        # site styles + design tokens
script.js         # header scroll state, mobile nav, footer year
booking.css       # booking widget styles
booking.js        # booking widget (service → date → slot → details → confirm)
assets/poster.jpg # Trent's "Fresh Spaces" poster
server/           # booking + two-way calendar-sync API (Node/Express/SQLite)
```

## Booking + two-way calendar sync

The booking system avoids Google's lengthy OAuth verification by using the
universal, no-OAuth path that works for **both Google and Apple** calendars:

- **Read Trent's blocks → hide site slots.** The API pulls Trent's calendars'
  read-only **ICS feed URLs** (Google "secret iCal address", iCloud published
  calendar) on a short cache interval. Any event there blocks matching slots.
- **Write site bookings → Trent's calendar.** Each booking emails an
  **ICS invite (`METHOD:REQUEST`)** to Trent and the customer; Google and Apple
  both add `REQUEST` invites natively. Optional iCloud CalDAV write-back inserts
  the event instantly into Apple Calendar.
- **No double-booking.** Site availability = local SQLite bookings ∪ calendar
  busy times, re-validated inside a transaction at booking time.

Two booking types: **Free On-Site Estimate** (60 min) and **Phone Consultation**
(20 min). Business hours, slot step, buffer, and lead time are configurable in
`server/config.js` / env.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/api/health` | health check |
| GET  | `/api/services` | service list + booking rules |
| GET  | `/api/availability?service=&date=` | open slots for a day |
| POST | `/api/book` | create a booking |
| GET  | `/api/admin/bookings` | upcoming bookings (admin — send `x-admin-token` header, or `Authorization: Bearer <token>`) |
| POST | `/api/admin/cancel` | cancel a booking (admin — send `x-admin-token` header, or `Authorization: Bearer <token>`) |

### Configuration

Copy `server/.env.example` → `server/.env` and fill in. The site and booking
work without these, but **calendar sync and email need them**:

- `OWNER_EMAIL` — Trent's address(es) that receive invites/alerts (Gmail invites
  auto-add to Google Calendar). Defaults to Trent's two Gmail addresses.
- `ICS_FEEDS` — comma-separated read-only calendar feed URLs (Google secret iCal
  + iCloud published calendar) so Trent's manual blocks hide site slots.
- `SMTP_*` / `FROM_EMAIL` — outbound email for invites + confirmations.
- `ICLOUD_*` — optional iCloud CalDAV write-back.
- `ADMIN_TOKEN` — protects the admin endpoints.

## Deployment

Static files live at `/var/www/trents-fresh-spaces` on the droplet, served by the
nginx site `trents-fresh-spaces`. The booking API runs as the nologin system
user **`trents`** under the systemd unit **`trents-fresh-spaces.service`** (moved off
root's pm2 on 2026-09-26) on `127.0.0.1:3007`, reverse-proxied by nginx at `/api/`.
Setup's `process.exit` restart still works (`Restart=always`).

Ownership the deploy must preserve: code root-owned and read-only to the app;
`server/` is `root:trents 1770` (sticky, so the app can create sqlite `-wal`/`-shm`
files but not replace code); `bookings.sqlite*` belong to `trents`; `server/.env` is
`root:trents 0640`. `rsync -a` copies this Mac's uid 501 and resets `server/`'s
mode, so the api step below re-applies it. The app can no longer rewrite `.env`:
before Trent uses a `setup.html?t=` link run `chown trents server/.env`, and put it
back to `root:trents 0640` afterwards.

```bash
# static
rsync -avz index.html styles.css script.js booking.css booking.js \
  robots.txt sitemap.xml site.webmanifest assets/ \
  root@104.236.120.144:/var/www/trents-fresh-spaces/
rsync -avz services/ root@104.236.120.144:/var/www/trents-fresh-spaces/services/
rsync -avz guides/   root@104.236.120.144:/var/www/trents-fresh-spaces/guides/
# api
rsync -avz --exclude node_modules --exclude .env --exclude '*.sqlite*' \
  server/ root@104.236.120.144:/var/www/trents-fresh-spaces/server/
ssh root@104.236.120.144 'cd /var/www/trents-fresh-spaces/server && npm install --omit=dev && \
  chown -R root:root . && chmod -R go-w . && chown root:trents . && chmod 1770 . && \
  chown trents:trents bookings.sqlite* && chown root:trents .env && chmod 0640 .env && \
  systemctl restart trents-fresh-spaces'
```

### Analytics

Traffic and bookings show up on the owner dashboard at findacrib.com/dashboard
under the **Fresh Spaces** tab (owner-only). Nothing on this site reports them:
the dashboard reads the server's own access log and the booking SQLite directly,
so there is no tag to install and an ad-blocker cannot hide a visitor.

Two things that must not be undone:

* The vhost carries `access_log /var/log/nginx/trents.access.log site;`. Without
  it the site writes into the shared `/var/log/nginx/access.log` in the combined
  format, which records no `$host` — its lines then cannot be told apart from
  any other site on the box, and the tab goes blank.
* **`/etc/nginx/sites-enabled/trents-fresh-spaces` is a real file, not a symlink
  to sites-available, and it has been the newer of the two.** Edit the enabled
  copy, then copy it over sites-available. Editing sites-available and reloading
  changes nothing, silently.
* The live vhost is mirrored in `deploy/nginx-trents-fresh-spaces.conf` (since
  2026-10-01). It carries an enforced CSP on HTML pages; setup.html alone gets
  `'unsafe-inline'` scripts via the `$tfs_script_src` map. A new inline
  `<script>` on any other page is blocked by the browser, so add JS as a file.

There is still no beacon on the `tel:` links, so calls and texts — the actual
conversion for this trade — are uncounted rather than zero.
