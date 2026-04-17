-- =============================================================================
-- Migración: mover `logs_eventos` del esquema `public` a `clinicas` con UUIDs
-- =============================================================================
--
-- CONTEXTO:
--   La tabla original `public.logs_eventos` usa `contacto_id` / `conversacion_id`
--   como BIGINT, pensada para el pipeline legacy (Bruno/Clara). Pero el producto
--   actual (multi-tenant "clinicas") identifica contactos y conversaciones con
--   UUID. El resultado: LogService parseaba los UUIDs con Number() → NaN → NULL.
--   Los filtros por contacto/conversación en SQL quedaban vacíos.
--
-- SOLUCIÓN:
--   Tabla nueva `clinicas.logs_eventos` con:
--     - `company_id`, `contact_id`, `conversation_id` como UUID.
--     - Resto de columnas idénticas (message, level, request_id, stage, tipo,
--       error_*, extra, event_code, outcome, reason, summary).
--   Sin FK a propósito: queremos preservar logs aunque el contact/conv se borre
--   (CASCADE). Index parciales para queries frecuentes.
--
-- ESTADO:
--   Ya aplicada en Supabase (dejamos este archivo como parte del inventario
--   de migraciones). La tabla `public.logs_eventos` queda congelada: no se
--   escribe más ahí, pero se conserva como archivo histórico.
--
-- CÓMO APLICAR (si hiciera falta en otro entorno):
--   Ejecutar este script en el SQL Editor de Supabase. Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS clinicas.logs_eventos (
    id              bigserial PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),

    level           text NOT NULL CHECK (level IN ('DEBUG','INFO','WARN','ERROR','CRITICAL')),
    message         text NOT NULL,

    -- Correlation ID del webhook que originó este log.
    request_id      text,

    -- IDs de negocio (UUID, todos en clinicas). Sin FK a propósito: queremos
    -- poder borrar contactos/conversaciones sin perder su histórico de logs.
    company_id      uuid,
    contact_id      uuid,
    conversation_id uuid,

    -- Etapa del pipeline (A, B, C, D, E, F, G).
    stage           text,
    -- Tipo de mensaje WhatsApp (text, image, audio, ...).
    tipo            text,

    -- Error separado en dos columnas: message barato para grep, stack pesado
    -- solo cuando se consulta explícitamente.
    error_message   text,
    error_stack     text,

    -- Metadata libre (redactada por LogService antes de persistir).
    extra           jsonb,

    -- Campos estructurados para consumo por IA.
    event_code      text,
    outcome         text CHECK (outcome IS NULL OR outcome IN ('ok','skipped','fallback','failed','noop')),
    reason          text,
    summary         text
);

COMMENT ON TABLE  clinicas.logs_eventos IS
    'Eventos del backend del agente de clínicas. Sucede a public.logs_eventos (que queda como archivo histórico con IDs bigint legacy).';
COMMENT ON COLUMN clinicas.logs_eventos.request_id IS
    'Correlation ID corto (8 chars) que identifica un webhook puntual. Permite reconstruir el trace completo con distintos contactos en paralelo.';
COMMENT ON COLUMN clinicas.logs_eventos.company_id IS
    'Tenant afectado. NULL si el log es previo a la resolución del tenant (p. ej. error en el routing del webhook).';
COMMENT ON COLUMN clinicas.logs_eventos.contact_id IS
    'UUID de clinicas.contacts. Sin FK para no perder logs cuando el contacto se borra.';
COMMENT ON COLUMN clinicas.logs_eventos.conversation_id IS
    'UUID de clinicas.conversations. Sin FK para no perder logs cuando la conversación se borra.';
COMMENT ON COLUMN clinicas.logs_eventos.event_code IS
    'Código enumerado (ver src/utils/log-events.ts). Permite agregaciones sin NLP.';
COMMENT ON COLUMN clinicas.logs_eventos.outcome IS
    'Resultado enumerado: ok | skipped | fallback | failed | noop.';

-- =============================================================================
-- Índices
-- =============================================================================

-- Tráfico por tenant (el caso más común: "qué pasó en la clínica X hoy")
CREATE INDEX IF NOT EXISTS idx_logs_company_created
    ON clinicas.logs_eventos (company_id, created_at DESC)
    WHERE company_id IS NOT NULL;

-- Drilldown por contacto / conversación.
CREATE INDEX IF NOT EXISTS idx_logs_contact_created
    ON clinicas.logs_eventos (contact_id, created_at DESC)
    WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_logs_conversation_created
    ON clinicas.logs_eventos (conversation_id, created_at DESC)
    WHERE conversation_id IS NOT NULL;

-- Reconstrucción de un request único.
CREATE INDEX IF NOT EXISTS idx_logs_request
    ON clinicas.logs_eventos (request_id)
    WHERE request_id IS NOT NULL;

-- Filtros por severidad en dashboards.
CREATE INDEX IF NOT EXISTS idx_logs_level_created
    ON clinicas.logs_eventos (level, created_at DESC);

-- Filtros por vocabulario de eventos.
CREATE INDEX IF NOT EXISTS idx_logs_event_code
    ON clinicas.logs_eventos (event_code, created_at DESC)
    WHERE event_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_logs_outcome_created
    ON clinicas.logs_eventos (outcome, created_at DESC)
    WHERE outcome IS NOT NULL;

-- =============================================================================
-- RLS (el backend usa service_role, bypasea RLS igualmente)
-- =============================================================================

ALTER TABLE clinicas.logs_eventos ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- RETENCIÓN (manual, opcional)
-- =============================================================================
-- Puede crecer rápido. Para limpiar manualmente:
--   DELETE FROM clinicas.logs_eventos WHERE created_at < now() - interval '30 days';
-- Automatizable con pg_cron si hace falta.
