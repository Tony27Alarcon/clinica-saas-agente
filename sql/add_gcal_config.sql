-- Migración: Integración Google Calendar en MedAgent
-- Ejecutar en Supabase SQL Editor

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabla de configuración de Google Calendar por clínica
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clinicas.gcal_config (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    -- El ID del Google Calendar compartido con el service account.
    -- Puede ser una dirección de Gmail (calendario principal)
    -- o el ID largo de un calendario específico (termina en @group.calendar.google.com).
    calendar_id      text NOT NULL,

    -- Horario laboral de la clínica para calcular slots disponibles.
    -- Formato: "HH:MM" en la timezone de la clínica (companies.timezone).
    work_start       text NOT NULL DEFAULT '09:00',
    work_end         text NOT NULL DEFAULT '18:00',

    -- Días laborables. 0=domingo, 1=lunes, …, 6=sábado.
    -- Default: lunes a viernes.
    work_days        int[] NOT NULL DEFAULT '{1,2,3,4,5}',

    -- Duración por defecto de un slot en minutos cuando no hay treatment_id.
    default_slot_min int NOT NULL DEFAULT 60,

    -- Si false, el agente usa availability_slots de BD como fallback.
    active           boolean NOT NULL DEFAULT true,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- Una sola configuración activa por clínica en el MVP.
    UNIQUE (company_id)
);

COMMENT ON TABLE clinicas.gcal_config IS
    'Configuración de Google Calendar por clínica. Cuando active=true el agente consulta disponibilidad en tiempo real via freebusy API en lugar de availability_slots.';

COMMENT ON COLUMN clinicas.gcal_config.calendar_id IS
    'Email o ID del Google Calendar compartido con el service account de MedAgent.';

-- Índice para el lookup por company_id (usado en cada tool call del agente)
CREATE INDEX IF NOT EXISTS idx_gcal_config_company
    ON clinicas.gcal_config (company_id)
    WHERE active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Columna gcal_event_id en appointments
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clinicas.appointments
    ADD COLUMN IF NOT EXISTS gcal_event_id text;

COMMENT ON COLUMN clinicas.appointments.gcal_event_id IS
    'ID del evento de Google Calendar creado al confirmar esta cita. NULL si la cita fue creada via slots de BD (clínica sin integración GCal).';

-- Índice para lookups por evento (cancelación / reprogramación)
CREATE INDEX IF NOT EXISTS idx_appointments_gcal_event
    ON clinicas.appointments (gcal_event_id)
    WHERE gcal_event_id IS NOT NULL;
