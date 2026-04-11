-- =============================================================================
-- Migration: multi-calendar support per company
-- Date: 2026-04-10
--
-- Objetivo: permitir que una misma clínica tenga múltiples calendarios de
-- Google Calendar configurados (ej. un calendario por profesional).
-- El agente consultará todos en paralelo y ofrecerá disponibilidad unificada.
--
-- Cambios:
--   1. gcal_config: agregar staff_name y staff_specialty por fila
--   2. gcal_config: eliminar restricción UNIQUE en company_id (si existe)
--   3. appointments: agregar gcal_calendar_id para rastrear qué calendario
--      se usó al crear el evento (necesario para cancelar/reprogramar en multi-cal)
-- =============================================================================

-- 1. Agregar columnas de identificación del profesional a cada fila de gcal_config
ALTER TABLE clinicas.gcal_config
    ADD COLUMN IF NOT EXISTS staff_name      TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS staff_specialty TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN clinicas.gcal_config.staff_name IS
    'Nombre del profesional asociado a este calendario. Ej: "Dra. García". '
    'Vacío = disponibilidad genérica de la clínica.';

COMMENT ON COLUMN clinicas.gcal_config.staff_specialty IS
    'Especialidad del profesional. Ej: "Medicina Estética". '
    'Se muestra al paciente junto con los slots de disponibilidad.';

-- 2. Eliminar restricción UNIQUE en company_id para permitir múltiples calendarios
--    (se usa DO/EXCEPTION para que sea idempotente si el constraint no existe)
DO $$
BEGIN
    ALTER TABLE clinicas.gcal_config
        DROP CONSTRAINT IF EXISTS gcal_config_company_id_key;
EXCEPTION WHEN others THEN
    -- El constraint puede tener otro nombre; no es crítico si falla
    NULL;
END $$;

-- 3. Agregar gcal_calendar_id a appointments para recordar qué calendario
--    se usó al reservar. Necesario para cancelar/reprogramar en entornos multi-cal.
ALTER TABLE clinicas.appointments
    ADD COLUMN IF NOT EXISTS gcal_calendar_id TEXT;

COMMENT ON COLUMN clinicas.appointments.gcal_calendar_id IS
    'ID del calendario de Google Calendar en el que se creó el evento. '
    'Se necesita para sincronizar cancelaciones y reprogramaciones cuando '
    'la clínica tiene múltiples calendarios configurados.';

-- 4. Ligar gcal_config a un miembro del staff (nullable: puede ser un calendario
--    genérico de la clínica sin staff específico)
ALTER TABLE clinicas.gcal_config
    ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES clinicas.staff(id) ON DELETE SET NULL;

-- Índice único: un staff solo puede tener una fila activa en gcal_config
CREATE UNIQUE INDEX IF NOT EXISTS gcal_config_staff_id_unique
    ON clinicas.gcal_config (staff_id)
    WHERE staff_id IS NOT NULL;

COMMENT ON COLUMN clinicas.gcal_config.staff_id IS
    'Staff vinculado a este calendario. Si está presente, el sistema usará el OAuth '
    'refresh_token del staff para leer freebusy y crear eventos. '
    'NULL = calendario compartido de la clínica (usa Service Account).';

-- 5. gcal_event_id en appointments (columna usada en el código pero sin definición SQL previa)
ALTER TABLE clinicas.appointments
    ADD COLUMN IF NOT EXISTS gcal_event_id TEXT;

COMMENT ON COLUMN clinicas.appointments.gcal_event_id IS
    'ID del evento en Google Calendar. Permite cancelar/reprogramar sin buscar por título.';
