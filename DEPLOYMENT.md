# Deployment — Arena.ge API

Production setup for the Express API. The Angular frontend is deployed separately and proxies `/api`, `/uploads`, `/sitemap.xml` and `/robots.txt` to this service.

## Target architecture

```
Internet ──HTTPS──> Nginx :443 ──> Angular SSR :4000 ──internal──> API :3000 ──> MongoDB Atlas
```

Only Nginx is public. The API and the SSR server listen on the same host and communicate over loopback. This keeps the refresh cookie first-party: the browser always calls the site origin, and the SSR host forwards requests to the API.

## Prerequisites

- Ubuntu 24.04 VPS (2 vCPU / 2 GB RAM minimum; the frontend build is the memory-heavy step)
- A domain with an `A` record pointing at the VPS
- MongoDB Atlas cluster (or any MongoDB 7+ instance) with a dedicated database user
- Node.js 22+ (24 LTS recommended) on the server
- `git`, `nginx`, `certbot`

```bash
sudo apt update
sudo apt install -y nginx git ufw
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 1. MongoDB Atlas

1. Create a free or dedicated cluster and a database named `arena`.
2. Create a user with read/write access to `arena` only.
3. Add the VPS public IP to Network Access.
4. Copy the connection string and append the database name:

```
mongodb+srv://<user>:<password>@<cluster>/arena?retryWrites=true&w=majority
```

Enable Atlas backups or schedule `mongodump` if you use a self-hosted database.

## 2. Application user and directories

```bash
sudo useradd --system --create-home --shell /bin/bash arena
sudo mkdir -p /srv/arena/api /srv/arena/uploads
sudo chown -R arena:arena /srv/arena
sudo -u arena git clone https://github.com/mamasakhlisidaviti/arena-backend.git /srv/arena/api
```

## 3. Environment file

Create `/srv/arena/api/.env` and restrict it:

```bash
sudo -u arena tee /srv/arena/api/.env >/dev/null <<'EOF'
NODE_ENV=production
PORT=3000
PUBLIC_SITE_URL=https://arena.ge
CLIENT_ORIGINS=https://arena.ge

MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER/arena?retryWrites=true&w=majority

JWT_ACCESS_SECRET=replace-with-openssl-rand
JWT_REFRESH_SECRET=replace-with-openssl-rand
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=7d

# Cloudinary is recommended on containers or multi-instance setups.
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_FOLDER=tournament-platform

MAX_UPLOAD_MB=5
UPLOAD_DIR=/srv/arena/uploads

SEED_ADMIN_EMAIL=admin@your-domain.ge
SEED_ADMIN_PASSWORD=replace-with-a-strong-password
SEED_ORGANIZER_EMAIL=organizer@your-domain.ge
SEED_ORGANIZER_PASSWORD=replace-with-a-strong-password
EOF
sudo chmod 600 /srv/arena/api/.env
sudo chown arena:arena /srv/arena/api/.env
```

Generate secrets with `openssl rand -hex 48`. `CLIENT_ORIGINS` must contain the public site origin, otherwise CORS rejects browser requests. `NODE_ENV=production` makes the API refuse dev JWT defaults and a missing `MONGODB_URI`.

If Cloudinary is configured, the three Cloudinary variables must all be set; otherwise uploads are written to `UPLOAD_DIR`. Keep that directory on a persistent volume and include it in backups.

## 4. Build and bootstrap

Run the seed exactly once, before removing development dependencies. In production it creates only the super admin, the chess category and platform settings; demo tournaments and accounts are skipped. It refuses to run while `SEED_ADMIN_PASSWORD` or `SEED_ORGANIZER_PASSWORD` still equals the demo default.

```bash
cd /srv/arena/api
sudo -u arena npm ci
sudo -u arena npm run typecheck
sudo -u arena npm test          # optional smoke test, uses an isolated embedded MongoDB
sudo -u arena npm run seed
sudo -u arena npm run build
sudo -u arena npm prune --omit=dev
```

`npm test` downloads an embedded MongoDB binary and needs temporary disk space; it can be skipped on very small instances.

## 5. systemd service

Create `/etc/systemd/system/arena-api.service`:

```ini
[Unit]
Description=Arena.ge API
After=network.target

[Service]
Type=simple
User=arena
Group=arena
WorkingDirectory=/srv/arena/api
EnvironmentFile=/srv/arena/api/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arena-api
sudo systemctl status arena-api --no-pager
curl -s http://127.0.0.1:3000/api/health
```

Expected: `{"success":true,"data":{"status":"ok",...}}`.

The API listens on all interfaces by default. Do not open port 3000 in the firewall; only Nginx ports 80/443 are exposed. If the API and web server are on different hosts, restrict 3000 to the web server's private IP.

## 6. Update and rollback

```bash
cd /srv/arena/api
sudo -u arena git pull --ff-only
sudo -u arena npm ci
sudo -u arena npm run build
sudo systemctl restart arena-api
journalctl -u arena-api -n 50 --no-pager
```

For a rollback, check out the previous commit, rebuild and restart:

```bash
sudo -u arena git log --oneline -5
sudo -u arena git checkout <commit>
sudo -u arena npm ci && sudo -u arena npm run build
sudo systemctl restart arena-api
sudo -u arena git checkout main
```

## 7. Managed platform alternative (Render, Railway, Fly.io)

Use the same environment variables and a managed MongoDB. Service settings:

- Build: `npm ci && npm run build`
- Start: `npm start`
- Health check: `/api/health`
- Seed: run once from a shell or as a one-off job before the first real login
- Uploads: use Cloudinary, or attach a persistent disk; ephemeral filesystems lose local uploads on redeploy
- Keep the service always-on. Free tiers that sleep cause SSR proxy timeouts and 502 responses.

## 8. Backup and monitoring

- Atlas: enable continuous backups or a nightly snapshot.
- Self-hosted: `mongodump --uri="$MONGODB_URI" --archive=/backup/arena-$(date +%F).gz --gzip` on a cron job.
- Persist and back up `UPLOAD_DIR` when Cloudinary is not used.
- Watch `journalctl -u arena-api` and the `/api/health` endpoint with an external uptime monitor.
- Rotate JWT secrets only during a maintenance window; rotation invalidates all refresh tokens and logs every user out.

## 9. Acceptance checklist

- [ ] `NODE_ENV=production` and both JWT secrets are non-default
- [ ] `MONGODB_URI` points at the production database and the seed has run once
- [ ] `CLIENT_ORIGINS` equals the public site origin (scheme included)
- [ ] `PUBLIC_SITE_URL` equals the public site origin so sitemap/robots emit absolute URLs
- [ ] Port 3000 is unreachable from the internet
- [ ] `/api/health` returns 200 through the site origin
- [ ] Uploads work and survive a restart (Cloudinary or persistent disk)
- [ ] Super-admin login works through the frontend, not directly against the API
