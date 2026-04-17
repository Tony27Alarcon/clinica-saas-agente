-- =============================================================================
-- Cleanup: eliminar artefactos de este proyecto en el esquema `public`
-- =============================================================================
--
-- CONTEXTO:
--   El esquema `public` pertenece al OTRO proyecto (ver regla de oro en
--   `docs/AGENTS_ARCHITECTURE.md`). Este script elimina los restos que
--   habíamos dejado ahí antes de decidir que todo vive en `clinicas`.
--
-- QUÉ BORRA:
--   1. `public.is_admin()`           — función decorativa (nunca protegió nada
--                                       real: el backend usa service_role, que
--                                       bypasea RLS).
--   2. Views/fn sobre `public.logs_eventos`:
--        - `public.v_conversation_timeline`
--        - `public.v_daily_outcome_ratios`
--        - `public.v_reason_breakdown_7d`
--        - `public.fn_request_trace(text)`
--   3. `public.logs_eventos`         — la tabla de logs vieja. No se trae
--                                       data histórica porque no estamos en
--                                       producción.
--
-- NO TOCA:
--   - Tablas del otro proyecto en `public` (`agents`, `contacts`, `threads`,
--     `messages`, `projects`, `tasks`, `companies` con IDs bigint, etc.).
--   - `public.media_assets` — es híbrida y parte la usa el otro proyecto.
--     Nuestra versión nueva vive en `clinicas.media_assets`.
--
-- CÓMO APLICAR:
--   Ejecutar una vez en el SQL Editor de Supabase. Idempotente (usa IF EXISTS).
-- =============================================================================

-- 1) Función is_admin
DROP FUNCTION IF EXISTS public.is_admin();

-- 2) Views y función sobre public.logs_eventos
DROP VIEW     IF EXISTS public.v_conversation_timeline;
DROP VIEW     IF EXISTS public.v_daily_outcome_ratios;
DROP VIEW     IF EXISTS public.v_reason_breakdown_7d;
DROP FUNCTION IF EXISTS public.fn_request_trace(text);

-- 3) Tabla de logs vieja (reemplazada por clinicas.logs_eventos)
DROP TABLE IF EXISTS public.logs_eventos CASCADE;

-- =============================================================================
-- Sanity checks (opcionales, correr después para verificar)
-- =============================================================================
--
-- Debería devolver 0 filas si el cleanup fue total:
--
--   SELECT n.nspname, p.proname
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('is_admin', 'fn_request_trace');
--
--   SELECT table_schema, table_name
--   FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('logs_eventos',
--                        'v_conversation_timeline',
--                        'v_daily_outcome_ratios',
--                        'v_reason_breakdown_7d');
