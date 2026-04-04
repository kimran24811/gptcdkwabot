# Workspace

## Overview

**Multi-tenant SaaS WhatsApp Bot Platform** — anyone can sign up at the web platform, scan a QR code to link their WhatsApp number, and run their own CDK key activation + NayaPay purchase bot. Each tenant gets isolated keys, payments, customers, settings, and Gmail credentials for payment verification.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: SQLite (better-sqlite3) — stored in `artifacts/api-server/data/bot.db`
- **Build**: esbuild (ESM bundle)
- **WhatsApp**: `@whiskeysockets/baileys` (WhatsApp Web protocol, no monthly fees)
- **CDK API**: keys.ovh REST API (`https://keys.ovh/api/v1`)
- **Auth**: bcryptjs + jsonwebtoken (JWT, 30-day expiry)
- **Frontend**: React + Vite + Tailwind (artifacts/platform)

## Artifacts

| Artifact | Port | Preview Path | Description |
|---|---|---|---|
| `api-server` | 8080 | `/api/` | Express API + Baileys WhatsApp |
| `platform` | 23633 | `/platform/` | React tenant dashboard |
| `mockup-sandbox` | 8081 | `/__mockup` | Component preview server |

## Architecture

### Multi-Tenant DB (SQLite)

Tables: `tenants`, `tenant_settings`, `key_pool` (tenant_id scoped), `payments` (tenant_id scoped), `customer_balances` (tenant_id scoped), `processed_emails` (tenant_id scoped)

Each tenant gets auto-seeded default settings on registration.

### Source files (`artifacts/api-server/src/`)
- `db.ts` — All DB queries; every function scoped by `tenantId`
- `wa-manager.ts` — `WAManager` class; manages multiple Baileys sessions keyed by `tenantId`; auth stored in `wa-auth/{tenantId}/`
- `handler.ts` — Conversation state machine; state keys as `${tenantId}:${jid}`
- `gmail.ts` — Gmail payment verification; accepts per-tenant credentials
- `cdk.ts` — CDK API client: `checkKey()` and `activateKey()`
- `platform.ts` — JWT auth + REST routes mounted at `/api/platform/`
- `admin.ts` — Legacy system admin panel at `/api/admin` (uses tenantId=1)
- `routes/index.ts` — Mounts all routers
- `index.ts` — Server startup; auto-reconnects all tenant sessions

### Platform API Routes (`/api/platform/`)
- `POST /register` — Create tenant account (email + password)
- `POST /login` — Get JWT token
- `GET /me` — Current tenant info + connection status
- `GET /bot/status` — QR code data URL + connected status
- `POST /bot/start` — Start/restart WhatsApp session
- `POST /bot/stop` — Stop WhatsApp session
- `GET/POST /settings` — Per-tenant settings (bot_name, payment, prices, gmail)
- `GET/POST/DELETE /keys` — Key pool management
- `GET /payments` — Payment history
- `GET /customers` — Customer analytics

### Frontend Pages (`artifacts/platform/src/`)
- `pages/Auth.tsx` — Login + Register tabs
- `pages/Dashboard.tsx` — QR code scan + bot status + key stats (auto-refreshes every 3s)
- `pages/Settings.tsx` — Bot name, payment account, Gmail creds, plan prices
- `pages/Keys.tsx` — Add keys (bulk paste), view/filter by plan, delete
- `pages/Payments.tsx` — Payment history with verification status
- `pages/Customers.tsx` — Customer list with spend/purchase analytics

## Environment Variables (Replit Secrets)
- `CDK_API_KEY` — API key for keys.ovh
- `CDK_API_BASE` — Base URL (https://keys.ovh/api/v1)
- `ADMIN_TOKEN` — Secret to protect `/api/admin` legacy page
- `JWT_SECRET` — Optional; defaults to a hardcoded dev key (set in production)
- `GMAIL_APP_PASSWORD` — Legacy fallback for tenantId=1 Gmail

## WhatsApp Auth State
Stored in `artifacts/api-server/wa-auth/{tenantId}/` (gitignored). Scan QR once — persists across restarts.

## Key Commands
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-server run typecheck` — typecheck api-server
- `pnpm --filter @workspace/api-server run dev` — build + run api-server
- `pnpm --filter @workspace/platform run dev` — run platform frontend
