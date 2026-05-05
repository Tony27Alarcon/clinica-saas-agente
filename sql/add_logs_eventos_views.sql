-- =============================================================================
-- Views y RPC sobre `clinicas.logs_eventos`
-- =============================================================================
--
-- CONTEXTO:
--   Las views/función originales vivían en `public` con IDs bigint y fueron
--   eliminadas por `sql/cleanup_public_artifacts.sql`. Esta migración las
--   recrea sobre `clinicas.logs_eventos` con UUIDs, alineadas a la API
--   actual del logger.
--
-- QUÉ CREA:
--   - `clinicas.v_conversation_timeline`   — view: trazabilidad por conv.
--   - `clinicas.v_daily_outcome_ratios`    — view: outcomes por día (30d).
--   - `clinicas.v_reason_breakdown_7d`     — view: top reasons por outcome (7d).
--   - `clinicas.fn_request_trace(text)`    — fn: trazabilidad de un webhook.
--
-- CÓMO APLICAR:
--   Ejecutar en SQL Editor de Supabase. Idempotente (CREATE OR REPLACE).
--
-- DOCS:
--   `docs/LOGGING.md` → sección "Consultas típicas para la IA".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- v_conversation_timeline
-- -----------------------------------------------------------------------------
-- Devuelve los eventos de TODAS las conversaciones, ordenados; el caller
-- filtra por `conversation_id = '<uuid>'` en su SELECT. Mantiene la columna
-- `conversation_id` para que ese filtro sea posible (a diferencia de la view
-- vieja que la omitía y obligaba a un parámetro de función).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW clinicas.v_conversation_timeline AS
SELECT
    created_at,
    conversation_id,
    level,
    stage,
    event_code,
    outcome,
    reason,
    summary,
    message,
    error_message
FROM clinicas.logs_eventos
WHERE conversation_id IS NOT NULL
ORDER BY created_at;

COMMENT ON VIEW clinicas.v_conversation_timeline IS
    'Timeline cronológico de eventos por conversación. Filtrar con WHERE conversation_id = <uuid>.';

-- -----------------------------------------------------------------------------
-- v_daily_outcome_ratios
-- -----------------------------------------------------------------------------
-- Conteo de outcomes por día. Limitada a últimos 30 días para evitar full
-- scans cuando crece la tabla. Ignora filas con outcome NULL (logs no
-- decisión).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW clinicas.v_daily_outcome_ratios AS
SELECT
    date_trunc('day', created_at) AS day,
    outcome,
    count(*) AS total
FROM clinicas.logs_eventos
WHERE outcome IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

COMMENT ON VIEW clinicas.v_daily_outcome_ratios IS
    'Conteo diario de outcomes (ok|skipped|fallback|failed|noop) en los últimos 30 días.';

-- -----------------------------------------------------------------------------
-- v_reason_breakdown_7d
-- -----------------------------------------------------------------------------
-- Top reasons por outcome en los últimos 7 días. Útil para detectar de un
-- vistazo cuál es la causa de los `fallback`/`failed` recientes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW clinicas.v_reason_breakdown_7d AS
SELECT
    outcome,
    reason,
    count(*) AS total
FROM clinicas.logs_eventos
WHERE created_at > now() - interval '7 days'
  AND reason IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC;

COMMENT ON VIEW clinicas.v_reason_breakdown_7d IS
    'Top reasons por outcome en los últimos 7 días. Drill-down rápido de fallback/failed.';

-- -----------------------------------------------------------------------------
-- fn_request_trace(p_request_id text)
-- -----------------------------------------------------------------------------
-- Reconstruye el trace completo de un webhook puntual. `request_id` es un
-- string corto que identifica un webhook único (lo setea el logger al
-- entrar al controlador). Devuelve columnas acotadas para no llenar el
-- buffer del cliente con `error_stack`/`extra`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinicas.fn_request_trace(p_request_id text)
RETURNS TABLE (
    created_at      timestamptz,
    level           text,
    stage           text,
    event_code      text,
    outcome         text,
    summary         text,
    message         text,
    error_message   text
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        created_at,
        level,
        stage,
        event_code,
        outcome,
        summary,
        message,
        error_message
    FROM clinicas.logs_eventos
    WHERE request_id = p_request_id
    ORDER BY created_at;
$$;

COMMENT ON FUNCTION clinicas.fn_request_trace(text) IS
    'Devuelve todas las filas del mismo webhook (request_id) ordenadas cronológicamente.';

-- =============================================================================
-- Permisos (service_role bypasea RLS, pero las views deben heredar acceso)
-- =============================================================================
GRANT SELECT ON clinicas.v_conversation_timeline TO service_role;
GRANT SELECT ON clinicas.v_daily_outcome_ratios   TO service_role;
GRANT SELECT ON clinicas.v_reason_breakdown_7d    TO service_role;
GRANT EXECUTE ON FUNCTION clinicas.fn_request_trace(text) TO service_role;

-- =============================================================================
-- Sanity checks (correr después para verificar)
-- =============================================================================
--
-- SELECT count(*) FROM clinicas.v_conversation_timeline LIMIT 1;
-- SELECT * FROM clinicas.v_daily_outcome_ratios LIMIT 5;
-- SELECT * FROM clinicas.v_reason_breakdown_7d LIMIT 5;
-- SELECT * FROM clinicas.fn_request_trace('<request_id_real>');
