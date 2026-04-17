# `sql/` — Migraciones del proyecto

Todas las migraciones de este directorio **aplican sobre el esquema `clinicas`** (regla de oro: ver `docs/AGENTS_ARCHITECTURE.md`). El único script que toca `public` es `cleanup_public_artifacts.sql`, y lo hace para **quitar** restos, no para crear nada.

## Cómo aplicar a un entorno limpio

Ejecutar en el SQL Editor de Supabase, en este orden. Todos son idempotentes (`IF NOT EXISTS` / `CREATE OR REPLACE`), así que repetirlos no rompe nada.

### 0. Limpieza previa (solo si venís de un entorno viejo)

| # | Archivo | Qué hace |
|---|---|---|
| 0 | `cleanup_public_artifacts.sql` | Elimina de `public`: `is_admin()`, `logs_eventos` y sus views (`v_conversation_timeline`, `v_daily_outcome_ratios`, `v_reason_breakdown_7d`), `fn_request_trace()`. |

> En un entorno nuevo lo podés saltar — no hay nada que limpiar.

### 1. Esquema base

| # | Archivo | Qué hace |
|---|---|---|
| 1 | `clinicas_schema.sql` | Crea el esquema `clinicas` y las tablas core: `companies`, `agents`, `treatments`, `staff`, `contacts`, `conversations`, `messages`, `availability_slots`, `appointments`, `clinical_forms`, `follow_ups`, + RPCs principales. |
| 2 | `grant_clinicas_permissions.sql` | Otorga permisos a `service_role`, `anon` y `authenticated` para que PostgREST exponga el esquema. |

### 2. Features y extensiones

| # | Archivo | Qué agrega |
|---|---|---|
| 3 | `add_clinicas_channels.sql` | Tabla `channels` (canales de mensajería por tenant). |
| 4 | `add_onboarding_fields.sql` | Campos iniciales de onboarding en `companies`. |
| 5 | `add_bruno_onboarding_fields.sql` | `companies.kind`, `staff.staff_role`, `channels.connected_at`, `companies.referred_by` (usados por el agente SuperAdmin). |
| 6 | `add_kapso_history_ids.sql` | IDs de Kapso en `messages` para dedup e import de historial. |
| 7 | `add_gcal_config.sql` | Tabla `gcal_config` con tokens OAuth de Google Calendar por staff/company. |
| 8 | `add_multi_calendar.sql` | Soporte de múltiples calendarios por config. |
| 9 | `add_prompt_compiler_fields.sql` | Campos necesarios para que `PromptCompilerService` arme el system prompt dinámico. |
| 10 | `add_prompt_rebuild_queue.sql` | Cola `prompt_rebuild_queue` que dispara recompilaciones asíncronas. |
| 11 | `add_company_skills.sql` | Tabla `company_skills` (skills configurables del agente paciente). |
| 12 | `add_contacts_notas.sql` | Tabla `contacts_notas` para anotaciones por contacto. |
| 13 | `add_scheduled_reminders.sql` | Tabla `scheduled_reminders` + helpers. |
| 14 | `add_recurrent_reminders.sql` | Recurrencia (cron-like) sobre `scheduled_reminders`. |
| 15 | `add_media_library.sql` | Tabla `media_library` (biblioteca curada por clínica, reutilizable). |
| 16 | `add_media_assets_clinicas.sql` | Tabla `media_assets` (metadata de adjuntos per-mensaje). Reemplaza a la híbrida `public.media_assets` que quedó del otro proyecto. |
| 17 | `add_logs_eventos_clinicas.sql` | Tabla `logs_eventos` con columnas UUID (`company_id`, `contact_id`, `conversation_id`). El sink `LogService` escribe ahí. |
| 18 | `add_logs_eventos_retention.sql` | Job `pg_cron` diario (03:15 UTC) que borra logs >60 días. Requiere extensión `pg_cron`. |
| 19 | `add_test_sessions_table.sql` | Tabla `test_sessions` (modo `/test` del staff). |

### 3. API pública

| # | Archivo | Qué expone |
|---|---|---|
| 20 | `clinicas_public_api.sql` | Función `clinicas.get_public_profile(slug)` usada por el portal web para renderizar la página pública de la clínica. |

### 4. Datos de prueba (opcional)

| # | Archivo | Qué carga |
|---|---|---|
| 21 | `seed_data.sql` | Inserta una clínica demo con staff, tratamientos y disponibilidad. Usar solo en staging/desarrollo. |

## Reglas

1. **Esquema.** Toda migración nueva va a `clinicas`. Si sentís la tentación de crear algo en `public`, parar: ese esquema pertenece al otro proyecto.
2. **Idempotencia.** Cada script debe poder ejecutarse dos veces sin error (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ADD COLUMN IF NOT EXISTS`, etc.).
3. **Un archivo por cambio.** Si la feature X necesita tabla + índice + RPC, eso va en un único `add_x.sql`. No dividir por tipo de objeto.
4. **Nombrar por acción.** `add_*` para agregar, `cleanup_*` para borrar, `seed_*` para datos. Nada de `migration_01.sql` sin contexto.
5. **Encabezado documentado.** Cada archivo arranca con un bloque de comentarios que explica contexto, qué crea y cómo aplicar.

## Qué NO hay en este directorio

- Scripts que creen o alteren tablas en `public` (las que había fueron borradas junto con la carpeta `legacy/`).
- Migraciones de Prisma/Drizzle/sqlx — el proyecto usa Supabase + SQL plano intencionalmente.
- Rollbacks automáticos. Si hay que revertir algo, se escribe un `cleanup_*.sql` o `drop_*.sql` explícito.
