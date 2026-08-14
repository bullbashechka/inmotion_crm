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

## PostgreSQL и миграции

Схема CRM изолирована в PostgreSQL-схеме `crm`, а закрытый журнал — в `crm_internal`. Worker подключается только через cache-disabled Hyperdrive binding `HYPERDRIVE_FRESH`; локальная строка подключения передаётся исключительно через игнорируемую переменную `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH`.

Первичная инициализация выполняется администратором PostgreSQL через `backend/drizzle/bootstrap.sql`. Она конвергентно ограничивает `crm_owner` (NOLOGIN), `crm_migrations` и `crm_runtime`, закрывает доступ `PUBLIC` и создаёт закрытый журнал `crm_internal.schema_migrations`.

После bootstrap миграции запускаются отдельно от Worker, прямым подключением роли `crm_migrations`:

```sh
DATABASE_MIGRATION_URL=postgres://crm_migrations:...@host:5432/inmotion_crm bun run --cwd backend db:migrate
```

Миграции только forward-only. Раннер удерживает PostgreSQL advisory lock и сверяет SHA-256 каждого уже применённого SQL-файла с журналом. Не изменяйте применённый файл; добавляйте следующую нумерованную миграцию.

Перед deployment создайте Hyperdrive с отключённым query cache и замените placeholder ID в `backend/wrangler.jsonc` на возвращённый ID:

```sh
bunx wrangler hyperdrive create inmotion-crm-fresh --connection-string="postgres://crm_runtime:...@host:5432/inmotion_crm" --caching-disabled
```

Проверки с реальной PostgreSQL запускаются только с явно заданным администраторским `TEST_DATABASE_URL`; каждая создаёт и удаляет собственную временную БД:

```sh
TEST_DATABASE_DISPOSABLE_CLUSTER=1 TEST_DATABASE_URL=postgres://postgres:...@localhost:5432/postgres bun run --cwd backend test:db
TEST_DATABASE_DISPOSABLE_CLUSTER=1 TEST_DATABASE_URL=postgres://postgres:...@localhost:5432/postgres bun run --cwd backend test:db:performance
```

`test:db` и `test:db:performance` намеренно завершаются ошибкой без `TEST_DATABASE_URL` и `TEST_DATABASE_DISPOSABLE_CLUSTER=1`: тесты меняют роли на уровне всего кластера. Обычный suite их исключает. `bun run --cwd backend db:schema:check` проверяет Drizzle Kit snapshot и каталог миграций.

### Гарантии целостности

Критические команды должны использовать `backend/src/db/integrity.ts`: этот слой объединяет idempotency claim, бизнес-изменение, immutable audit и сохранение terminal response в одну PostgreSQL-транзакцию. Повтор с тем же `(scope, operation, key)` возвращает сохранённый результат, а тот же ключ с другим request fingerprint отклоняется. Runtime не может напрямую создавать или менять idempotency rows: PostgreSQL сам задаёт claim/audit time, создаёт private 256-bit completion capability с TTL и разрешает только связанный с ней transition `pending → completed`.

`crm.audit_entries` доступен runtime-роле только для чтения и добавления: непустая причина обязательна, а DB trigger игнорирует supplied audit timestamps и сам рассчитывает `expires_at`. Срок хранения хранится в `crm.audit_retention_policies`, меняется только audited DB-функцией с `expectedVersion` (`0` при создании) и может менять сохранённый `expires_at` только до его истечения. Очистка выполняется узкой no-argument функцией базы и удаляет только уже истёкшие записи. Архивирование/восстановление выполнено через versioned allowlist, а не динамический SQL по имени таблицы. Подробности и правила добавления новых сущностей — в [docs/database-foundation.md](docs/database-foundation.md).
