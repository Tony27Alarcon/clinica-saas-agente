-- ============================================================
-- Migración: Admin Agent para Staff de Clínicas
-- Ejecutar en Supabase SQL Editor DESPUÉS de clinicas_schema.sql
-- ============================================================

-- 1. Ampliar CHECK de contacts.status para incluir 'staff'
ALTER TABLE clinicas.contacts DROP CONSTRAINT IF EXISTS contacts_status_check;
ALTER TABLE clinicas.contacts ADD CONSTRAINT contacts_status_check
    CHECK (status IN ('prospecto','calificado','agendado','paciente',
                      'descartado','inactivo','staff'));

-- 2. Ampliar CHECK de conversations.channel para incluir 'admin'
ALTER TABLE clinicas.conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE clinicas.conversations ADD CONSTRAINT conversations_channel_check
    CHECK (channel IN ('whatsapp','instagram','web','admin'));

-- 3. Índice en staff.phone para lookup eficiente (usado en findStaffByPhone)
CREATE INDEX IF NOT EXISTS idx_staff_company_phone
    ON clinicas.staff (company_id, phone)
    WHERE active = true AND phone IS NOT NULL;

-- 4. Índice en appointments para agenda del día (usado en getUpcomingAppointments)
CREATE INDEX IF NOT EXISTS idx_appointments_company_date
    ON clinicas.appointments (company_id, scheduled_at, status)
    WHERE status IN ('scheduled','confirmed');
