-- =============================================================================
-- Migración: Modo Test para staff (clinicas.test_sessions)
-- =============================================================================
--
-- FEATURE:
--   El staff puede enviar `/test` desde su WhatsApp para abrir una conversación
--   aislada de 20 min contra el agente público (como si fuera un paciente real).
--   `/exit` la cierra, genera un resumen y borra los mensajes de prueba.
--
-- Tabla auditable: aunque los messages se borran, queda la fila de la sesión
-- con su `summary` para revisar qué se probó.
-- =============================================================================

-- 1. Ampliar el CHECK de conversations.channel para permitir 'admin' y 'test'.
--    En código ya se usa channel='admin' (processAdminEvent), así que aceptamos
--    ambos aquí. Idempotente: drop + recreate bajo try-catch lógico.
ALTER TABLE clinicas.conversations
    DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE clinicas.conversations
    ADD  CONSTRAINT conversations_channel_check
    CHECK (channel IN ('whatsapp', 'instagram', 'web', 'admin', 'test'));

-- 2. Tabla de sesiones de test
CREATE TABLE IF NOT EXISTS clinicas.test_sessions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id             uuid NOT NULL REFERENCES clinicas.companies(id)     ON DELETE CASCADE,
    staff_id               uuid NOT NULL REFERENCES clinicas.staff(id)         ON DELETE CASCADE,
    admin_conversation_id  uuid NOT NULL REFERENCES clinicas.conversations(id) ON DELETE CASCADE,
    test_conversation_id   uuid NOT NULL REFERENCES clinicas.conversations(id) ON DELETE CASCADE,

    started_at             timestamptz NOT NULL DEFAULT now(),
    expires_at             timestamptz NOT NULL,
    ended_at               timestamptz,

    exit_reason            text CHECK (exit_reason IN ('command', 'timeout', 'admin_force')),
    summary                text,

    status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'ended'))
);

COMMENT ON TABLE  clinicas.test_sessions IS
    'Sesiones de modo test (/test desde WhatsApp del staff). Auditable: summary persiste aunque los messages se borren.';
COMMENT ON COLUMN clinicas.test_sessions.admin_conversation_id IS
    'Conversación admin desde la cual el staff disparó /test. Allí se inyecta el resumen al cerrar.';
COMMENT ON COLUMN clinicas.test_sessions.test_conversation_id IS
    'Conversación aislada (channel=test) donde el staff conversa con el agente público. Se borra entera al /exit.';

-- Unique: un staff solo puede tener UNA sesión activa a la vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_sessions_one_active
    ON clinicas.test_sessions(staff_id)
    WHERE status = 'active';

-- Para el barrido de expiración lazy
CREATE INDEX IF NOT EXISTS idx_test_sessions_expires
    ON clinicas.test_sessions(expires_at)
    WHERE status = 'active';

-- RLS
ALTER TABLE clinicas.test_sessions ENABLE ROW LEVEL SECURITY;
