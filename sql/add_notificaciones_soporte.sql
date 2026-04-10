-- =============================================================================
-- Notificaciones a equipo de soporte (no comerciales)
-- =============================================================================
--
-- PROBLEMA:
--   Cuando Clara (el agente IA) tiene un error de sistema (Gemini caído, BD
--   con timeout, tool de envío que falla) hoy le mandamos al usuario un texto
--   genérico tipo "estoy con un pequeño inconveniente". Eso confunde al lead,
--   y el equipo de soporte no se entera del fallo hasta que abre Railway.
--
-- SOLUCIÓN:
--   Reutilizar la tabla `notificaciones` y su outbox de WhatsApp (ya tiene
--   wa_estado/wa_enviado_at) para mandar un aviso al equipo de soporte por
--   WhatsApp cuando algo se rompe. Es la misma lógica que con comerciales,
--   pero el destinatario es un número fijo configurado por env, no un user
--   de la tabla cotizador.users.
--
--   Para soportar esto necesitamos dos cosas:
--     1. Permitir notificaciones SIN user_id (porque el equipo de soporte no
--        es un user del CRM).
--     2. Una columna `destinatario_phone` para guardar a quién mandarle el
--        WhatsApp cuando user_id es null.
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase. Es idempotente: el ALTER usa IF
--   NOT EXISTS y el DROP NOT NULL está envuelto en DO ... EXCEPTION para no
--   fallar si user_id ya era nullable.
--
-- VALIDACIÓN POST-APLICACIÓN:
--   SELECT column_name, is_nullable, data_type
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'notificaciones'
--     AND column_name IN ('user_id', 'destinatario_phone');
-- =============================================================================

-- 1. Nueva columna: teléfono destino directo (sin pasar por user_id).
ALTER TABLE public.notificaciones
    ADD COLUMN IF NOT EXISTS destinatario_phone text;

COMMENT ON COLUMN public.notificaciones.destinatario_phone IS
    'Teléfono destino directo (E.164 sin "+", ej: 573117391515) para notificaciones que NO van a un user del CRM. Si está set, el outbox de WA usa este número en vez de resolver via user_id.';

-- 2. Hacer user_id nullable. Hoy las notificaciones de soporte (HITL al equipo)
--    no tienen un user en cotizador.users, así que user_id queda null.
DO $$
BEGIN
    ALTER TABLE public.notificaciones ALTER COLUMN user_id DROP NOT NULL;
EXCEPTION
    WHEN OTHERS THEN
        -- Ya era nullable, o la columna no existe (poco probable). No-op.
        NULL;
END $$;

-- 3. Constraint de coherencia: cada notificación debe tener AL MENOS uno de
--    user_id o destinatario_phone (si no, ¿a quién avisamos?).
--    Lo agregamos como CHECK NOT VALID para no romper si hay filas viejas
--    inconsistentes (aunque no debería, porque user_id era NOT NULL antes).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'notificaciones_destinatario_check'
    ) THEN
        ALTER TABLE public.notificaciones
            ADD CONSTRAINT notificaciones_destinatario_check
            CHECK (user_id IS NOT NULL OR destinatario_phone IS NOT NULL)
            NOT VALID;
    END IF;
END $$;

-- 4. Índice para el flush de pendientes por destinatario_phone.
--    Misma forma que el patrón de comerciales (filtrar por estado + ordenar
--    cronológicamente para preservar el orden del outbox).
CREATE INDEX IF NOT EXISTS idx_notificaciones_destinatario_phone_pendientes
    ON public.notificaciones (destinatario_phone, created_at)
    WHERE destinatario_phone IS NOT NULL AND wa_estado = 'pendiente';
