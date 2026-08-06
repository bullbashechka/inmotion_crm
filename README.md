# InMotion CRM

Monorepo для desktop-first CRM InMotion Sport Clinic.

## Структура

- `webapp` — React SPA на Vite, Tailwind CSS и shadcn-совместимых компонентах.
- `backend` — Hono REST API, запускаемый в Cloudflare Workers.
- `packages/contracts` — общие Zod-схемы и DTO.

## Команды

```sh
bun install --frozen-lockfile
bun run dev:webapp
bun run dev:backend
bun run check
```

Для локального запуска скопируйте `webapp/.env.example` в `webapp/.env` и задайте публичные параметры. Секреты в `VITE_*` не допускаются.

Worker использует переменные `APP_ENV`, `APP_BUILD_VERSION`, `SUPPORTED_CLIENT_VERSIONS`, `CORS_ORIGINS`; пример находится в `backend/.dev.vars.example`.
