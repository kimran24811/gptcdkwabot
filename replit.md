# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains a WhatsApp CDK Activation Bot that lets customers activate ChatGPT subscriptions by sending their CDK key and session token via WhatsApp DM.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle)
- **WhatsApp**: `@whiskeysockets/baileys` (WhatsApp Web protocol, no monthly fees)
- **CDK API**: keys.ovh REST API (`https://keys.ovh/api/v1`)

## WhatsApp Bot

### Source files (`artifacts/api-server/src/`)
- `cdk.ts` — CDK API client: `checkKey()` (GET /key/{code}/status) and `activateKey()` (POST /activate with async polling)
- `handler.ts` — Conversation state machine: idle → awaiting_session, rate limiting, deduplication
- `whatsapp.ts` — Baileys connection, QR generation, auto-reconnect, message routing
- `admin.ts` — Express routes: GET /api/admin (QR page, token-protected) and GET /api/health

### Environment Variables (Replit Secrets)
- `CDK_API_KEY` — API key for keys.ovh
- `CDK_API_BASE` — Base URL (https://keys.ovh/api/v1)
- `ADMIN_TOKEN` — Secret to protect the /api/admin page

### Admin Page
Visit `/api/admin?token=<ADMIN_TOKEN>` to see the QR code and connection status.

### Auth state
Stored in `artifacts/api-server/wa-auth/` (gitignored). Scan QR once — persists across restarts.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
