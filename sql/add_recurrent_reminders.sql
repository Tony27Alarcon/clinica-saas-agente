-- ============================================================
-- Migración: Soporte para recordatorios recurrentes
-- Agrega columnas rrule, next_run_at y run_count a la tabla
-- clinicas.scheduled_reminders, y actualiza la RPC de claim
-- para incluir recurrentes activos.
-- ============================================================

-- 1. Nuevas columnas
ALTER TABLE clinicas.scheduled_reminders
    ADD COLUMN IF NOT EXISTS rrule       text,           -- Cron 5 campos: "0 9 * * 1" (lunes 9am)
    ADD COLUMN IF NOT EXISTS next_run_at timestamptz,    -- Próxima ejecución calculada (solo recurrentes)
    ADD COLUMN IF NOT EXISTS run_count   int NOT NULL DEFAULT 0;  -- Contador de disparos completados

-- 2. Ampliar el CHECK de status para incluir 'active' (recurrentes en curso)
--    'pending'   → one-shot esperando disparo
--    'active'    → recurrente activo (se mantiene entre disparos)
--    'fired'     → one-shot ya disparado
--    'failed'    → falló definitivamente (agotó reintentos)
--    'cancelled' → cancelado manualmente
ALTER TABLE clinicas.scheduled_reminders
    DROP CONSTRAINT IF EXISTS scheduled_reminders_status_check;

ALTER TABLE clinicas.scheduled_reminders
    ADD CONSTRAINT scheduled_reminders_status_check
        CHECK (status IN ('pending', 'active', 'fired', 'failed', 'cancelled'));

-- 3. Índice para recurrentes activos con next_run_at vencido
CREATE INDEX IF NOT EXISTS idx_reminders_recurrent
    ON clinicas.scheduled_reminders (next_run_at)
    WHERE status = 'active' AND rrule IS NOT NULL;

-- 4. Actualizar la RPC claim_due_reminders para incluir recurrentes
--    Lógica:
--      - One-shot (rrule IS NULL):  status='pending', fire_at<=now, fired_at IS NULL → marca status='fired'
--      - Recurrente (rrule NOT NULL): status='active', next_run_at<=now, fired_at IS NULL → mantiene status='active', solo marca fired_at
--    En ambos casos fired_at es el mecanismo de idempotencia:
--    el servidor lo resetea a NULL tras procesar (completeRecurrentCycle).
CREATE OR REPLACE FUNCTION clinicas.claim_due_reminders(p_now timestamptz)
RETURNS SETOF clinicas.scheduled_reminders
LANGUAGE sql
AS $$
    UPDATE clinicas.scheduled_reminders
    SET
        fired_at   = p_now,
        updated_at = p_now,
        status     = CASE
                        WHEN rrule IS NULL THEN 'fired'   -- one-shot → marcado permanente
                        ELSE status                        -- recurrente → status se mantiene 'active'
                     END
    WHERE fired_at IS NULL
      AND (
          -- One-shot pendiente vencido
          (status = 'pending'  AND rrule IS NULL     AND fire_at     <= p_now)
          OR
          -- Recurrente activo con siguiente ejecución vencida
          (status = 'active'   AND rrule IS NOT NULL AND next_run_at <= p_now)
      )
    RETURNING *;
$$;
