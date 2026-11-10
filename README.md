# Arena.ge — Backend API

Node.js + Express 5 + MongoDB REST API for the Arena.ge tournament platform. The Angular client lives in a separate repository.

## Stack

- Node.js 24, TypeScript (strict ESM)
- Express 5, Zod validation, helmet, CORS allowlist, rate limiting, sanitization
- MongoDB + Mongoose
- JWT access tokens and rotating httpOnly refresh cookies
- Cloudinary uploads with local disk fallback
- Vitest + Supertest (embedded MongoDB for tests)

## Requirements

- Node.js 22+ (developed on Node 24)
- MongoDB (optional in development — see below)

## Getting started

```bash
npm install
cp .env.example .env
npm run seed      # creates the super admin, chess category, settings and demo data in development
npm run dev       # API on http://localhost:3000
```

When `MONGODB_URI` is empty in development, the server boots an embedded MongoDB with its data persisted under `server/data/mongo`. Set `MONGODB_URI` to use a real instance at any time.

```bash
npm run typecheck
npm test
npm run build && npm start
```

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | `development` or `production` | `development` |
| `PORT` | API port | `3000` |
| `PUBLIC_SITE_URL` | Public site origin used in sitemap/robots and links | `http://localhost:4200` |
| `CLIENT_ORIGINS` | Comma-separated CORS allowlist | `http://localhost:4200,http://localhost:4000` |
| `MONGODB_URI` | MongoDB connection string | embedded development MongoDB |
| `JWT_ACCESS_SECRET` | Access token signing secret | dev placeholder |
| `JWT_REFRESH_SECRET` | Refresh token signing secret | dev placeholder |
| `ACCESS_TOKEN_TTL` | Access token lifetime | `15m` |
| `REFRESH_TOKEN_TTL` | Refresh token lifetime | `7d` |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Cloudinary credentials; local uploads are used when empty | — |
| `CLOUDINARY_FOLDER` | Cloudinary folder | `tournament-platform` |
| `MAX_UPLOAD_MB` | Upload size limit | `5` |
| `UPLOAD_DIR` | Local upload directory | `./uploads` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Seeded super admin | `admin@arena.ge` / `Admin123!` |
| `SEED_ORGANIZER_EMAIL` / `SEED_ORGANIZER_PASSWORD` | Seeded demo organizer | `organizer@arena.ge` / `Organizer123!` |

Production fails fast unless `MONGODB_URI` is set and both JWT secrets differ from the development placeholders. The seed script also refuses to bootstrap production with the default demo passwords and skips demo tournaments, registrations, organizer and participant accounts.

## API overview

All responses use the envelope `{ "success": true, "data": ..., "meta"?: ... }`. Errors return a matching envelope with `success: false` and an error code.

| Area | Prefix |
| --- | --- |
| Auth (login, register, refresh, logout, profile) | `/api/auth` |
| Public tournaments and registration | `/api/tournaments`, `/api/registrations` |
| Categories, settings, home content | `/api/categories`, `/api/settings`, `/api` |
| Account (profile, own registrations, notifications) | `/api/users`, `/api/notifications` |
| Admin tournaments, participants, dashboard, users | `/api/admin/tournaments`, `/api/admin/dashboard` |
| Uploads | `/api/uploads`, `/uploads` |
| SEO | `/sitemap.xml`, `/robots.txt` |
| Health | `/api/health` |

Access tokens are sent as `Authorization: Bearer <token>`; the refresh token is stored in an httpOnly, SameSite=Lax cookie and rotates on every refresh. Roles: `super_admin`, `admin`, `participant`.

## Seed data (development)

| Role | Email | Password |
| --- | --- | --- |
| Super admin | `admin@arena.ge` | `Admin123!` |
| Organizer | `organizer@arena.ge` | `Organizer123!` |
| Participant | `participant@arena.ge` | `Participant123!` |

The seed is idempotent: it creates the chess category, settings and demo tournaments/registrations only when missing.

## Security

- Helmet, CORS allowlist, per-route rate limiting and request sanitization.
- Zod schemas validate every request body and query.
- Passwords are hashed with bcrypt; refresh tokens are stored hashed and rotated.
- Uploads are limited by size and MIME type; Cloudinary is optional.
- `.env` files, runtime data, uploads, build output and dependencies are ignored by git.

## Deployment

Run `npm run build` and start with `node dist/index.js` behind a reverse proxy. Point `PUBLIC_SITE_URL` at the public domain, add the site origin to `CLIENT_ORIGINS`, provide a strong `MONGODB_URI` and JWT secrets, and either configure Cloudinary or mount a persistent volume for `UPLOAD_DIR`.
