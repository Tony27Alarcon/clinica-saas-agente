-- =============================================================================
-- Extensión de `logs_eventos` para consumo por IA
-- =============================================================================
--
-- PROBLEMA:
--   Los logs actuales son legibles por humanos (message libre, extra JSONB),
--   pero caros para una IA: hay que parsear prosa para saber si un evento fue
--   "ok", "skipped" o "fallback", y no hay vocabulario cerrado para filtrar.
--
-- SOLUCIÓN:
--   Cuatro columnas nuevas (todas nullable → no rompen filas existentes):
--     - event_code : string enumerado ("webhook.fallback.sent", etc.)
--     - outcome    : resultado de la decisión ("ok|skipped|fallback|failed|noop")
--     - reason     : causa enumerada en snake_case ("duplicate_message_id")
--     - summary    : una línea ≤120 chars autoexplicativa
--
--   Más views/RPC pensadas para que la IA consulte poco y bien.
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase. Idempotente.
-- =============================================================================

-- ============================================================================
-- Columnas nuevas
-- ============================================================================

ALTER TABLE public.logs_eventos
    ADD COLUMN IF NOT EXISTS event_code text,
    ADD COLUMN IF NOT EXISTS outcome    text,
    ADD COLUMN IF NOT EXISTS reason     text,
    ADD COLUMN IF NOT EXISTS summary    text;

COMMENT ON COLUMN public.logs_eventos.event_code IS
    'Código enumerado del evento (ej: "webhook.fallback.sent"). Vocabulario cerrado definido en src/utils/log-events.ts.';
COMMENT ON COLUMN public.logs_eventos.outcome IS
    'Resultado de la decisión: ok | skipped | fallback | failed | noop. Permite agregaciones sin NLP.';
COMMENT ON COLUMN public.logs_eventos.reason IS
    'Causa enumerada en snake_case (ej: "duplicate_message_id"). Para "por qué se saltó X" sin leer prosa.';
COMMENT ON COLUMN public.logs_eventos.summary IS
    'Una línea ≤120 chars, autoexplicativa. Campo principal que lee la IA por default.';

-- Constraint suave: solo los outcomes conocidos. No se aplica a filas viejas
-- (son NULL) ni a filas nuevas que no usen el nuevo API.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'logs_eventos_outcome_check'
    ) THEN
        ALTER TABLE public.logs_eventos
            ADD CONSTRAINT logs_eventos_outcome_check
            CHECK (outcome IS NULL OR outcome IN ('ok','skipped','fallback','failed','noop'));
    END IF;
END $$;

-- ============================================================================
-- Índices
-- ============================================================================

-- Filtro principal de la IA: "dame eventos de este tipo ordenados por tiempo".
CREATE INDEX IF NOT EXISTS idx_logs_eventos_event_code_created_at
    ON public.logs_eventos (event_code, created_at DESC)
    WHERE event_code IS NOT NULL;

-- "Dame todos los fallback / failed": índice parcial, chico y focalizado.
CREATE INDEX IF NOT EXISTS idx_logs_eventos_outcome_problematico
    ON public.logs_eventos (outcome, created_at DESC)
    WHERE outcome IN ('fallback','failed');

-- Timeline por conversación (sin exigir que conv sea not null en el índice
-- principal porque igual lo filtramos abajo).
CREATE INDEX IF NOT EXISTS idx_logs_eventos_conv_timeline
    ON public.logs_eventos (conversacion_id, created_at)
    WHERE conversacion_id IS NOT NULL AND event_code IS NOT NULL;

-- ============================================================================
-- Views / RPC para consumo por IA
-- ============================================================================

-- Timeline compacto de una conversación: la query #1 que usará la IA.
-- Devuelve solo las columnas informativas, ordenadas cronológicamente.
CREATE OR REPLACE VIEW public.v_conversation_timeline AS
SELECT
    conversacion_id,
    created_at,
    event_code,
    outcome,
    reason,
    summary,
    stage,
    request_id
FROM public.logs_eventos
WHERE event_code IS NOT NULL
ORDER BY conversacion_id, created_at;

COMMENT ON VIEW public.v_conversation_timeline IS
    'Timeline estructurado por conversación. Filtra ruido (solo eventos con event_code). Pensado para que una IA reconstruya qué pasó con una conversación concreta.';

-- Ratios agregados diarios: salud del sistema en pocas filas.
CREATE OR REPLACE VIEW public.v_daily_outcome_ratios AS
SELECT
    date_trunc('day', created_at)::date AS day,
    event_code,
    outcome,
    count(*) AS n
FROM public.logs_eventos
WHERE event_code IS NOT NULL
  AND created_at >= now() - interval '7 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;

COMMENT ON VIEW public.v_daily_outcome_ratios IS
    'Agregación diaria por event_code + outcome para los últimos 7 días. Para que la IA detecte tendencias (ej: aumento de fallbacks) sin escanear crudo.';

-- Drill-down por request_id: todo lo que pasó en un webhook puntual.
CREATE OR REPLACE FUNCTION public.fn_request_trace(p_request_id text)
RETURNS SETOF public.logs_eventos
LANGUAGE sql STABLE AS $$
    SELECT *
    FROM public.logs_eventos
    WHERE request_id = p_request_id
    ORDER BY created_at ASC;
$$;

COMMENT ON FUNCTION public.fn_request_trace(text) IS
    'Dado un request_id, devuelve la traza cronológica completa del webhook. Uso típico por IA: tras detectar un evento interesante en el timeline, drill-down acá.';

-- Razones más frecuentes detrás de un outcome "problemático": la IA lo usa
-- para contestar "¿por qué estamos mandando tantos fallbacks esta semana?".
CREATE OR REPLACE VIEW public.v_reason_breakdown_7d AS
SELECT
    event_code,
    outcome,
    reason,
    count(*) AS n,
    min(created_at) AS first_seen,
    max(created_at) AS last_seen
FROM public.logs_eventos
WHERE created_at >= now() - interval '7 days'
  AND outcome IN ('fallback','failed','skipped')
  AND reason IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY n DESC;

COMMENT ON VIEW public.v_reason_breakdown_7d IS
    'Top reasons por event_code+outcome en los últimos 7 días. Respuesta directa a "por qué está pasando X".';

-- =============================================================================
-- VALIDACIÓN POST-APLICACIÓN
-- =============================================================================
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='logs_eventos' AND table_schema='public'
--     ORDER BY ordinal_position;
--   SELECT * FROM public.v_daily_outcome_ratios;
-- =============================================================================
