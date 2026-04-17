-- =============================================================================
-- Retención de `clinicas.logs_eventos` — 60 días
-- =============================================================================
--
-- CONTEXTO:
--   La tabla `clinicas.logs_eventos` puede crecer rápido (10-30 rows por
--   webhook × varios webhooks por segundo en hora pico). Sin retención, en
--   unos meses se convierte en un cuello de botella de I/O + storage.
--
-- POLÍTICA:
--   - Borrar todo lo que tenga `created_at < now() - interval '60 days'`.
--   - Correr todos los días a las 03:15 UTC (bajo tráfico en LATAM / EU).
--   - Lote único (`DELETE ... WHERE created_at < ...`): PostgreSQL maneja
--     bien estos batches en una tabla con el índice parcial por
--     `(level, created_at DESC)`. Si en el futuro el DELETE se vuelve
--     pesado (>30s), pasar a borrado por lotes con LIMIT.
--
-- REQUISITOS:
--   - Extensión `pg_cron` habilitada en Supabase (Database → Extensions).
--     En proyectos nuevos puede venir apagada.
--
-- CÓMO APLICAR:
--   Ejecutar en SQL Editor. Idempotente: si el job ya existe, lo reemplaza
--   (cron.schedule devuelve el mismo jobid y podríamos usar cron.alter_job,
--   pero el patrón unschedule+schedule es el más robusto entre versiones).
-- =============================================================================

-- 1) Asegurar extensión (no-op si ya está).
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2) Si ya había un job previo con este nombre, lo desagendamos para que
--    el re-run deje una sola entrada en cron.job.
DO $$
DECLARE
    v_jobid bigint;
BEGIN
    SELECT jobid INTO v_jobid
    FROM cron.job
    WHERE jobname = 'clinicas_logs_eventos_retention_60d';

    IF v_jobid IS NOT NULL THEN
        PERFORM cron.unschedule(v_jobid);
    END IF;
END $$;

-- 3) Agendar el job diario.
--    Formato cron (UTC): "min hour dom mon dow".
--    "15 3 * * *" = todos los días, 03:15 UTC.
SELECT cron.schedule(
    'clinicas_logs_eventos_retention_60d',
    '15 3 * * *',
    $$ DELETE FROM clinicas.logs_eventos
       WHERE created_at < now() - interval '60 days'; $$
);

-- =============================================================================
-- Verificación (opcional, correr después para confirmar)
-- =============================================================================
--
--   SELECT jobid, jobname, schedule, command, active
--   FROM cron.job
--   WHERE jobname = 'clinicas_logs_eventos_retention_60d';
--
-- Para ver las últimas corridas:
--
--   SELECT runid, jobid, start_time, end_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (
--       SELECT jobid FROM cron.job
--       WHERE jobname = 'clinicas_logs_eventos_retention_60d'
--   )
--   ORDER BY start_time DESC
--   LIMIT 10;
--
-- Para DESHABILITAR temporalmente sin borrar el job:
--
--   UPDATE cron.job SET active = false
--   WHERE jobname = 'clinicas_logs_eventos_retention_60d';
--
-- Para CAMBIAR la ventana (p. ej. a 30 días) re-ejecutar este script
-- cambiando el `interval '60 days'`.
