-- =============================================================================
-- PROPUESTA 1: Permisos del schema `clinicas` para el service_role
-- =============================================================================
--
-- PROBLEMA:
--   El error "permission denied for schema clinicas" ocurre porque Supabase
--   expone los schemas extra via PostgREST solo si están declarados en:
--     Dashboard → Settings → API → Extra schemas
--   Y además el service_role necesita GRANT explícito sobre el schema.
--
-- CÓMO APLICAR:
--   1. Ejecutar este script en el SQL Editor de Supabase.
--   2. Ir a Dashboard → Settings → API → "Extra schemas" y agregar: clinicas
--   3. Guardar y esperar ~30 segundos para que PostgREST recargue.
--
-- Es idempotente: puede ejecutarse múltiples veces sin efectos secundarios.
-- =============================================================================

-- 1. Acceso al schema
GRANT USAGE ON SCHEMA clinicas TO service_role;
GRANT USAGE ON SCHEMA clinicas TO anon;
GRANT USAGE ON SCHEMA clinicas TO authenticated;

-- 2. Acceso a todas las tablas existentes
GRANT ALL ON ALL TABLES IN SCHEMA clinicas TO service_role;

-- 3. Acceso a secuencias (necesario para INSERT con serial/bigserial)
GRANT ALL ON ALL SEQUENCES IN SCHEMA clinicas TO service_role;

-- 4. Acceso a funciones (RPCs como get_available_slots, book_appointment, etc.)
GRANT ALL ON ALL FUNCTIONS IN SCHEMA clinicas TO service_role;

-- 5. Aplicar automáticamente a objetos futuros creados en el schema
ALTER DEFAULT PRIVILEGES IN SCHEMA clinicas
    GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA clinicas
    GRANT ALL ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA clinicas
    GRANT ALL ON FUNCTIONS TO service_role;

-- =============================================================================
-- VALIDACIÓN POST-APLICACIÓN
-- Ejecutar para confirmar que el permiso quedó bien:
-- =============================================================================
-- SELECT grantee, privilege_type
-- FROM information_schema.role_schema_grants
-- WHERE object_schema = 'clinicas'
--   AND grantee = 'service_role';
