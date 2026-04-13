-- =============================================================================
-- Migration: crear tabla gcal_config
-- Date: 2026-04-12
--
-- Objetivo: tabla de configuración de Google Calendar por clínica/staff.
-- Cada fila representa un calendario conectado (puede haber varios por clínica).
--
-- IMPORTANTE: ejecutar ANTES de add_multi_calendar.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS clinicas.gcal_config (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    calendar_id      text NOT NULL DEFAULT 'primary',
    work_start       text NOT NULL DEFAULT '09:00',
    work_end         text NOT NULL DEFAULT '18:00',
    work_days        int[] NOT NULL DEFAULT '{1,2,3,4,5}',
    default_slot_min int NOT NULL DEFAULT 60,
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Columnas multi-calendar (de add_multi_calendar.sql, incluidas aquí para idempotencia)
ALTER TABLE clinicas.gcal_config
    ADD COLUMN IF NOT EXISTS staff_name      text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS staff_specialty text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS staff_id        uuid REFERENCES clinicas.staff(id) ON DELETE SET NULL;

-- Constraint UNIQUE en staff_id — requerido por el ON CONFLICT del upsert en el código.
-- NO usar partial index (WHERE ...) porque PostgREST/Supabase no lo soporta con ON CONFLICT.
-- PostgreSQL permite múltiples NULLs en UNIQUE indexes, así que no hay problema.
CREATE UNIQUE INDEX IF NOT EXISTS gcal_config_staff_id_unique
    ON clinicas.gcal_config (staff_id);

ALTER TABLE clinicas.gcal_config ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE clinicas.gcal_config IS
    'Configuración de Google Calendar por clínica/staff. Una fila por calendario conectado.';
