-- =============================================================================
-- Función public.is_admin() — requerida si políticas RLS u otras expresiones
-- usan: USING (public.is_admin()) o similar.
--
-- ERROR sin esto: function public.is_admin() does not exist (42883)
--
-- Ajusta la lógica interna según cómo marques admins en tu proyecto:
--   - user_metadata.role = 'admin' (común en cliente)
--   - app_metadata (solo vía service_role / Dashboard)
--   - tabla propia (p. ej. clinicas.staff.supabase_user_id + rol RBAC)
--
-- Ejecutar en SQL Editor de Supabase. Idempotente (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'True si el JWT actual indica rol admin en user_metadata o app_metadata. Personalizar según tu modelo.';

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;
