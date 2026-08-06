# 001. Монорепозиторий, приложения и общие контракты

**Этап:** 1. Технический фундамент

## Цель

Подготовить воспроизводимую основу frontend и API по утверждённому стеку.

## Контекст продукта

CRM — desktop-first веб-приложение с независимо развёртываемыми React SPA и Cloudflare Worker API.

## Объём

- Адаптировать `di-sukharev/vibe` под Bun workspaces: `webapp`, `backend`, `packages/contracts`.
- Настроить React, TypeScript, Vite, TanStack Router/Query/Form, Zod, Tailwind, shadcn/ui, Radix UI и Recharts.
- Настроить Hono REST API с `/api/v1`, единым форматом ошибок и OpenAPI из общих Zod-схем.
- Зафиксировать зависимости единым lock-файлом и команды lint/typecheck/test/build.

## Вне объёма

`website`, `mobile`, SSR, production-функции предметных модулей.

## Требования

- Браузер обращается только к Worker API, не к таблицам Supabase.
- CORS использует точный список разрешённых origin с credentials.
- Общие DTO импортируются frontend и backend из одного пакета.

## Критерии приёмки

- Чистая установка Bun воспроизводит lock-файл и собирает все три workspace.
- Тестовый endpoint доступен по `/api/v1`, документирован в OpenAPI и типобезопасно вызывается из SPA.
- Typecheck обнаруживает несовместимое изменение контракта одновременно в frontend и backend.
- В сборке frontend отсутствуют привилегированные серверные секреты.

## Зависимости

Нет.

## Примечания по реализации

Production runtime backend — Cloudflare Workers, а не Bun-сервер.
