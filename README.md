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
| GET  | `/api/admin/bookings?token=` | upcoming bookings (admin) |
| POST | `/api/admin/cancel?token=` | cancel a booking (admin) |

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
nginx site `trents-fresh-spaces`. The booking API runs under **pm2** on
`127.0.0.1:3007`, reverse-proxied by nginx at `/api/`.

```bash
# static
rsync -avz index.html styles.css script.js booking.css booking.js \
  robots.txt sitemap.xml assets/ \
  root@104.236.120.144:/var/www/trents-fresh-spaces/
# api
rsync -avz --exclude node_modules --exclude .env --exclude '*.sqlite*' \
  server/ root@104.236.120.144:/var/www/trents-fresh-spaces/server/
ssh root@104.236.120.144 'cd /var/www/trents-fresh-spaces/server && npm install --omit=dev && pm2 restart trents-fresh-spaces'
```
