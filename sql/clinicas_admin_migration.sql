-- ============================================================
-- Migración: Admin Agent para Staff de Clínicas
-- Ejecutar en Supabase SQL Editor DESPUÉS de clinicas_schema.sql
--
-- Las 3 secciones son independientes — se pueden pegar y ejecutar
-- por separado si alguna falla (por sesión expirada, etc.).
-- ============================================================


-- ── SECCIÓN 1: Ampliar CHECK constraints ────────────────────

ALTER TABLE clinicas.contacts DROP CONSTRAINT IF EXISTS contacts_status_check;
ALTER TABLE clinicas.contacts ADD CONSTRAINT contacts_status_check
    CHECK (status IN ('prospecto','calificado','agendado','paciente','descartado','inactivo','staff'));

ALTER TABLE clinicas.conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE clinicas.conversations ADD CONSTRAINT conversations_channel_check
    CHECK (channel IN ('whatsapp','instagram','web','admin'));


-- ── SECCIÓN 2: Índices de performance ───────────────────────

-- Lookup de staff por teléfono (usado en findStaffByPhone)
CREATE INDEX IF NOT EXISTS idx_staff_company_phone
    ON clinicas.staff (company_id, phone)
    WHERE active = true AND phone IS NOT NULL;

-- Agenda del día (usado en getUpcomingAppointments)
CREATE INDEX IF NOT EXISTS idx_appointments_company_date
    ON clinicas.appointments (company_id, scheduled_at, status)
    WHERE status IN ('scheduled','confirmed');


-- ── SECCIÓN 3: Planes de la empresa demo (MedAgent SaaS) ────

INSERT INTO clinicas.treatments
    (id, company_id, name, description, price_min, price_max, duration_min,
     preparation_instructions, post_care_instructions, followup_days, active,
     created_at, updated_at)
VALUES
    (
        'cde7f800-b8d6-4dc2-844c-c10a17880211',
        '062f4cb7-b06d-45ef-9e54-be684a07d239',
        'Plan Starter',
        '200 conversaciones/mes. Calificación y agendamiento. 1 calendario.',
        99.00, NULL, 30, NULL, NULL, ARRAY['3','7','30'], true,
        '2026-04-10 03:14:16.877225+00', now()
    ),
    (
        '0da1a0a7-7b5e-43a0-abb2-9fb0defa1fad',
        '062f4cb7-b06d-45ef-9e54-be684a07d239',
        'Plan Growth',
        '600 conversaciones/mes. Calificación, agendamiento, recordatorios 24h, historia clínica PDF, seguimiento post-tratamiento. Múltiples médicos y calendarios.',
        199.00, NULL, 30, NULL, NULL, ARRAY['3','7','30'], true,
        '2026-04-10 03:14:16.877225+00', now()
    ),
    (
        '5abe83e0-2a73-41e9-8d5a-cce4b8fca803',
        '062f4cb7-b06d-45ef-9e54-be684a07d239',
        'Plan Enterprise',
        'Más de 1,500 conversaciones. Múltiples sucursales. Integración API con CRM. Soporte técnico preferencial.',
        399.00, NULL, 30, NULL, NULL, ARRAY['3','7','30'], true,
        '2026-04-10 03:14:16.877225+00', now()
    )
ON CONFLICT (id) DO UPDATE SET
    name        = EXCLUDED.name,
    description = EXCLUDED.description,
    price_min   = EXCLUDED.price_min,
    updated_at  = now();
