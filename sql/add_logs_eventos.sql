-- =============================================================================
-- Tabla de logs de eventos para trazabilidad y debugging en producción
-- =============================================================================
--
-- PROBLEMA:
--   En producción los logs viven en Railway, lo que obliga a abrir su consola,
--   filtrar por timestamps y reconstruir manualmente qué le pasó a un contacto
--   puntual. Cuando hay 10 contactos en paralelo y el log es interleaved, esto
--   es inviable. También perdemos los logs de procesos viejos cuando Railway
--   los rota.
--
-- SOLUCIÓN:
--   Persistir cada evento de log relevante (INFO+) en una tabla `logs_eventos`
--   en Supabase, con índices por contacto, conversación, nivel y request_id.
--   Así se puede investigar un contacto con un único query:
--
--     SELECT created_at, level, stage, message, error_message
--     FROM logs_eventos
--     WHERE contacto_id = 38
--     ORDER BY created_at DESC
--     LIMIT 100;
--
--   O ver todos los CRITICAL del último día:
--
--     SELECT * FROM logs_eventos
--     WHERE level = 'CRITICAL'
--       AND created_at > now() - interval '1 day'
--     ORDER BY created_at DESC;
--
--   O reconstruir un único webhook completo siguiendo su request_id:
--
--     SELECT created_at, level, stage, message
--     FROM logs_eventos
--     WHERE request_id = 'a3f4b2c1'
--     ORDER BY created_at ASC;
--
-- DECISIONES DE DISEÑO:
--   - SIN FK a contactos/conversaciones: queremos preservar logs aunque el
--     contacto se borre (CASCADE). Usamos `bigint` plano + índice.
--   - `extra` es JSONB para flexibilidad (metadata variable según el log).
--   - `error_stack` separado de `error_message` para que el grep por mensaje
--     sea barato y el stack solo se traiga cuando hace falta.
--   - Índices parciales (WHERE col IS NOT NULL) para no inflar el espacio
--     con NULLs en queries que filtran por contacto/conv específico.
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase. Es idempotente: CREATE TABLE IF NOT
--   EXISTS y CREATE INDEX IF NOT EXISTS lo hacen seguro de re-correr.
--
-- RETENCIÓN (manual, opcional):
--   Esta tabla puede crecer rápido. Para limpiar logs viejos manualmente:
--     DELETE FROM logs_eventos WHERE created_at < now() - interval '30 days';
--   Si querés automatizarlo, podés crear un cron job en Supabase con
--   pg_cron o un Edge Function diaria.
--
-- VALIDACIÓN POST-APLICACIÓN:
--   SELECT count(*) FROM logs_eventos;
--   SELECT level, count(*) FROM logs_eventos GROUP BY level ORDER BY 2 DESC;
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.logs_eventos (
    id              bigserial PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- Nivel de severidad. CHECK garantiza que el código no inserte basura.
    level           text NOT NULL CHECK (level IN ('DEBUG','INFO','WARN','ERROR','CRITICAL')),

    -- Mensaje principal del log (lo que el dev escribió como descripción).
    message         text NOT NULL,

    -- Correlation ID del webhook que originó este log. Permite reconstruir
    -- el flujo completo de un evento incluso si está interleaved con otros.
    request_id      text,

    -- IDs de negocio para filtrar rápido por contacto o conversación.
    -- SIN FK a propósito (ver decisiones de diseño arriba).
    contacto_id     bigint,
    conversacion_id bigint,

    -- Etapa del pipeline cuando se emitió el log (A, B, C, D, E, F, G).
    -- Útil para detectar dónde se cae más seguido la cosa.
    stage           text,

    -- Tipo de mensaje WhatsApp original (text, interactive, image, audio,
    -- unsupported, etc.). Permite agrupar errores por tipo de input.
    tipo            text,

    -- Detalle del error si lo hay. Separado en dos columnas para que el
    -- grep por mensaje no tenga que cargar el stack entero (que puede ser
    -- de varios KB).
    error_message   text,
    error_stack     text,

    -- Metadata adicional libre. Se llena con cualquier cosa que el dev pase
    -- como `extra` al logger.
    extra           jsonb
);

COMMENT ON TABLE public.logs_eventos IS
    'Logs de eventos del backend (webhook, IA, BD, Kapso). Se llena automáticamente desde el LogService. Pensado para investigación post-mortem y dashboards.';

COMMENT ON COLUMN public.logs_eventos.request_id IS
    'Correlation ID del webhook (8 chars). Todos los logs de un mismo evento comparten este ID.';

COMMENT ON COLUMN public.logs_eventos.stage IS
    'Etapa del pipeline del controller (A=getOrCreateContacto, B=getOrCreateConversacion, C=saveMensaje, D=getHistorial, E=AiService, F=KapsoSend, G=saveRespuesta).';

-- ============================================================================
-- Índices
-- ============================================================================

-- Búsqueda por contacto (la más importante: "qué le pasó a este contacto").
-- Parcial para no indexar NULLs.
CREATE INDEX IF NOT EXISTS idx_logs_eventos_contacto_created_at
    ON public.logs_eventos (contacto_id, created_at DESC)
    WHERE contacto_id IS NOT NULL;

-- Búsqueda por conversación (todos los logs de una conv específica).
CREATE INDEX IF NOT EXISTS idx_logs_eventos_conversacion_created_at
    ON public.logs_eventos (conversacion_id, created_at DESC)
    WHERE conversacion_id IS NOT NULL;

-- Búsqueda por nivel ("dame todos los CRITICAL del último día").
CREATE INDEX IF NOT EXISTS idx_logs_eventos_level_created_at
    ON public.logs_eventos (level, created_at DESC);

-- Trazado de un único webhook completo.
CREATE INDEX IF NOT EXISTS idx_logs_eventos_request_id
    ON public.logs_eventos (request_id)
    WHERE request_id IS NOT NULL;

-- Index global por timestamp (para queries de "últimos N logs").
CREATE INDEX IF NOT EXISTS idx_logs_eventos_created_at
    ON public.logs_eventos (created_at DESC);
