-- ============================================================
-- Sistema de Recordatorios Auto-Programados
--
-- Los agentes (paciente y admin) pueden programar recordatorios
-- usando la tool scheduleReminder. El scheduler los procesa cada
-- minuto con un UPDATE atómico para evitar doble disparo.
--
-- Correr en Supabase SQL Editor (o via migration tool).
-- ============================================================

CREATE TABLE IF NOT EXISTS clinicas.scheduled_reminders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Multi-tenant: siempre filtrar por company_id primero
    company_id      uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    -- Quién recibirá el recordatorio
    contact_id      uuid NOT NULL REFERENCES clinicas.contacts(id) ON DELETE CASCADE,

    -- Conversación que originó el recordatorio (para continuidad de contexto).
    -- ON DELETE SET NULL: si la conversación se borra, el recordatorio subsiste
    -- y el scheduler creará una nueva conversación al disparar.
    conversation_id uuid REFERENCES clinicas.conversations(id) ON DELETE SET NULL,

    -- Cuándo disparar (siempre en UTC — el servicio convierte desde TZ de la clínica)
    fire_at         timestamptz NOT NULL,

    -- Contexto que el scheduler inyecta al agente al activarlo.
    -- Ej: "El usuario pidió que lo contactemos a las 2pm para hablar de botox."
    message         text NOT NULL,

    -- Qué pipeline invocar al disparar
    agent_type      text NOT NULL DEFAULT 'patient'
                    CHECK (agent_type IN ('patient', 'admin')),

    -- Estado del recordatorio:
    --   pending  → Aún no ha llegado fire_at
    --   fired    → El scheduler lo procesó (idempotencia: nunca se re-procesa)
    --   failed   → Error durante el disparo (ver fired_error)
    --   cancelled→ Cancelado manualmente antes de dispararse
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'fired', 'failed', 'cancelled')),

    -- fired_at es la clave de idempotencia: el UPDATE atómico de claim_due_reminders
    -- filtra WHERE fired_at IS NULL, garantizando que ni 2 instancias del servidor
    -- ni un reinicio rápido procesen el mismo recordatorio dos veces.
    fired_at        timestamptz,
    fired_error     text,
    retry_count     int NOT NULL DEFAULT 0,

    -- Para auditoría: qué tipo de agente lo programó
    created_by_agent text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Índice principal del scheduler: busca pendientes vencidos por empresa
CREATE INDEX IF NOT EXISTS idx_reminders_scheduler
    ON clinicas.scheduled_reminders (fire_at)
    WHERE status = 'pending';

-- Índice para cancelar recordatorios de un contacto específico
CREATE INDEX IF NOT EXISTS idx_reminders_contact
    ON clinicas.scheduled_reminders (contact_id)
    WHERE status = 'pending';

-- ============================================================
-- Función RPC: claim_due_reminders
--
-- Claim atómico en un solo statement SQL. Hace el UPDATE y
-- devuelve los rows en la misma operación (RETURNING).
--
-- Postgres garantiza que dos transacciones concurrentes no
-- retornan el mismo row: el primero en llegar adquiere el
-- lock de fila, el segundo no encuentra nada (fired_at ya
-- no es NULL). Esto protege contra múltiples instancias del
-- servidor o reinicios rápidos.
-- ============================================================
CREATE OR REPLACE FUNCTION clinicas.claim_due_reminders(p_now timestamptz)
RETURNS SETOF clinicas.scheduled_reminders
LANGUAGE sql
AS $$
    UPDATE clinicas.scheduled_reminders
    SET
        status     = 'fired',
        fired_at   = p_now,
        updated_at = p_now
    WHERE
        status   = 'pending'
        AND fire_at <= p_now
        AND fired_at IS NULL
    RETURNING *;
$$;

COMMENT ON TABLE clinicas.scheduled_reminders IS
    'Recordatorios programados por el agente IA via tool scheduleReminder. El scheduler los procesa cada 60s con UPDATE atómico para evitar doble disparo.';

COMMENT ON COLUMN clinicas.scheduled_reminders.fire_at IS
    'Timestamp UTC del momento de disparo. El servicio convierte la hora local de la clínica (companies.timezone) a UTC antes de insertar.';

COMMENT ON COLUMN clinicas.scheduled_reminders.fired_at IS
    'NULL mientras no se haya procesado. El UPDATE atómico (UPDATE WHERE fired_at IS NULL RETURNING) garantiza que solo un worker procese este recordatorio.';

COMMENT ON COLUMN clinicas.scheduled_reminders.message IS
    'Contexto para el agente al activarse. Ej: "El usuario pidió que lo contactáramos a las 2pm para continuar la consulta sobre botox."';

COMMENT ON FUNCTION clinicas.claim_due_reminders IS
    'Claim atómico: marca como fired y devuelve los recordatorios vencidos en un solo statement. Garantiza idempotencia bajo concurrencia.';
