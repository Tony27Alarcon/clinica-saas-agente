-- =============================================================================
-- Schema: clinicas
-- Multi-tenant SaaS de agente IA para clínicas estéticas
--
-- MODELO DE AISLAMIENTO:
--   Shared DB, logical isolation por company_id + RLS.
--   El service_role del backend tiene acceso total (bypass RLS).
--   Las políticas de RLS aplican al rol de dashboard/cliente.
--
-- ROUTING DEL WEBHOOK:
--   El `phone_number_id` que llega en el payload de WhatsApp se mapea
--   directamente a `companies.wa_phone_number_id` (unique index).
--   Eso identifica el tenant sin ningún JOIN adicional.
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase. Idempotente: usa IF NOT EXISTS.
--   Orden importa: companies → agents/treatments/staff → contacts →
--   conversations → messages → availability_slots → appointments →
--   clinical_forms → follow_ups.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS clinicas;

-- =============================================================================
-- TABLA: companies (Tenants — una fila por clínica)
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.companies (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL,
    slug                text UNIQUE NOT NULL,            -- ej: "clinica-bella-lima" (para URLs)

    -- WhatsApp Business API
    -- wa_phone_number_id es la clave de routing: viene en cada webhook payload.
    wa_phone_number_id  text UNIQUE,                     -- "109876543210" (el phoneNumberId de Meta)
    wa_phone_display    text,                            -- "+51 987 654 321" (solo para UI)
    wa_access_token     text,                            -- Token de acceso permanente o temporal

    -- Instagram (plan Pro+)
    ig_page_id          text,
    ig_access_token     text,

    -- Plan de suscripción
    plan                text NOT NULL DEFAULT 'basico'
                        CHECK (plan IN ('basico', 'pro', 'clinica')),

    -- Config operativa
    timezone            text NOT NULL DEFAULT 'America/Lima',
    currency            text NOT NULL DEFAULT 'USD',
    country_code        text NOT NULL DEFAULT 'PE',      -- ISO 3166-1 alpha-2

    -- Estado
    active              boolean NOT NULL DEFAULT true,
    trial_ends_at       timestamptz,                     -- NULL = no en trial

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.companies IS 'Un registro por clínica (tenant). El wa_phone_number_id es la clave de routing del webhook.';
COMMENT ON COLUMN clinicas.companies.wa_phone_number_id IS 'phoneNumberId de Meta/WhatsApp Business API. Llega en cada webhook y se usa para identificar al tenant sin JOIN.';
COMMENT ON COLUMN clinicas.companies.slug IS 'Identificador URL-friendly. Usado en panel de control y links de onboarding.';


-- =============================================================================
-- TABLA: agents (Configuración del agente IA por clínica)
-- Las instrucciones del agente viven acá, no en src/.
-- Permite dynamic prompting: cambiar el comportamiento sin redeploy.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.agents (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    name                    text NOT NULL DEFAULT 'Asistente',   -- Nombre del agente (ej: "Valentina")

    -- Prompt del sistema completo. Se construye en el backend combinando
    -- este campo con los tratamientos activos y criterios de calificación.
    system_prompt           text NOT NULL,

    -- Tono de comunicación de la clínica
    tone                    text NOT NULL DEFAULT 'amigable'
                            CHECK (tone IN ('formal', 'amigable', 'casual')),

    -- Criterios para calificar/descartar un lead (Fase 1)
    -- Ej: {"min_budget_usd": 80, "excluded_keywords": ["gratis", "regalo"]}
    qualification_criteria  jsonb NOT NULL DEFAULT '{}',

    -- Cuándo y cómo escalar a un humano
    -- Ej: {"trigger_keywords": ["hablar con alguien", "gerente"], "max_unanswered_turns": 6}
    escalation_rules        jsonb NOT NULL DEFAULT '{}',

    -- Base de conocimiento de objeciones frecuentes del sector
    -- Ej: [{"objection": "Es muy caro", "response": "Ofrecemos planes de pago..."}]
    objections_kb           jsonb NOT NULL DEFAULT '[]',

    active                  boolean NOT NULL DEFAULT true,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.agents IS 'Configuración del agente IA por clínica. system_prompt + criterios de calificación + reglas de escalamiento.';
COMMENT ON COLUMN clinicas.agents.system_prompt IS 'Instrucciones base del sistema. El backend las combina en tiempo real con los tratamientos activos de la clínica.';
COMMENT ON COLUMN clinicas.agents.qualification_criteria IS 'JSONB con reglas para clasificar un lead como calificado o descartado (Fase 1).';
COMMENT ON COLUMN clinicas.agents.escalation_rules IS 'JSONB con condiciones para pasar la conversación a un humano.';


-- =============================================================================
-- TABLA: treatments (Catálogo de tratamientos de la clínica)
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.treatments (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    name                        text NOT NULL,
    description                 text,

    -- Precio (rango para tratamientos con variantes)
    price_min                   numeric(10, 2),
    price_max                   numeric(10, 2),

    -- Duración en minutos (para calcular disponibilidad)
    duration_min                int,

    -- Instrucciones pre-tratamiento (Fase 3: se envían 24h antes de la cita)
    -- Ej: "No consumir alcohol 48h antes. Evitar sol directo. Llegar con ropa cómoda."
    preparation_instructions    text,

    -- Cuidados post-tratamiento (Fase 4: se incluyen en el seguimiento)
    post_care_instructions      text,

    -- Días de seguimiento post-cita (Fase 4)
    -- Por defecto: 3, 7 y 30 días. La clínica puede personalizar.
    followup_days               int[] NOT NULL DEFAULT '{3,7,30}',

    active                      boolean NOT NULL DEFAULT true,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.treatments IS 'Catálogo de tratamientos. Incluye instrucciones pre/post para las Fases 3 y 4 del agente.';
COMMENT ON COLUMN clinicas.treatments.preparation_instructions IS 'Se envían automáticamente 24h antes de la cita (Fase 3).';
COMMENT ON COLUMN clinicas.treatments.followup_days IS 'Array de días post-cita en que el agente hace seguimiento. Default: {3, 7, 30}.';


-- =============================================================================
-- TABLA: staff (Personal — médicos y asesores de la clínica)
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.staff (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    name                    text NOT NULL,
    role                    text,                        -- "Médico Estético", "Asesora", etc.
    specialty               text,                        -- "Botox", "Láser", "Rellenos", etc.

    -- Para notificaciones en tiempo real cuando se agenda una cita
    phone                   text,
    email                   text,

    -- Límite diario de citas (para distribución de carga — Fase 2)
    max_daily_appointments  int NOT NULL DEFAULT 8,

    active                  boolean NOT NULL DEFAULT true,
    created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.staff IS 'Médicos y asesores. Reciben notificación cuando el agente agenda una cita. Se usan para distribución de carga (Fase 2).';

-- =============================================================================
-- MIGRACIÓN: OAuth 2.0 de Google Calendar para staff
-- Ejecutar en Supabase SQL Editor (idempotente con IF NOT EXISTS)
-- =============================================================================
ALTER TABLE clinicas.staff
    ADD COLUMN IF NOT EXISTS gcal_refresh_token TEXT,
    ADD COLUMN IF NOT EXISTS gcal_email          TEXT,
    ADD COLUMN IF NOT EXISTS gcal_connected_at   TIMESTAMPTZ;

COMMENT ON COLUMN clinicas.staff.gcal_refresh_token IS 'Refresh token OAuth2 de Google Calendar. Permite crear citas en nombre del staff sin que vuelva a autorizar.';
COMMENT ON COLUMN clinicas.staff.gcal_email          IS 'Email de la cuenta Google que autorizó el acceso (extraído del id_token).';
COMMENT ON COLUMN clinicas.staff.gcal_connected_at   IS 'Timestamp de la última autorización OAuth exitosa.';


-- =============================================================================
-- TABLA: contacts (Leads y pacientes)
-- Un contacto pertenece a exactamente una clínica.
-- El mismo paciente en dos clínicas = dos registros distintos.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.contacts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    phone                   text NOT NULL,
    name                    text,
    email                   text,

    -- Estado en el pipeline del agente
    status                  text NOT NULL DEFAULT 'prospecto'
                            CHECK (status IN (
                                'prospecto',    -- Primer contacto, sin calificar
                                'calificado',   -- Pasó el filtro de la Fase 1
                                'agendado',     -- Tiene cita activa (Fase 2)
                                'paciente',     -- Asistió a la cita al menos una vez
                                'descartado',   -- No calificó o perdió interés
                                'inactivo'      -- Sin actividad > N días
                            )),

    temperature             text NOT NULL DEFAULT 'frio'
                            CHECK (temperature IN ('frio', 'tibio', 'caliente')),

    -- Tratamiento de interés detectado por el agente en la Fase 1
    interest_treatment_id   uuid REFERENCES clinicas.treatments(id) ON DELETE SET NULL,

    -- Notas internas del equipo
    notes                   text,

    -- ID del contacto en el proveedor de WhatsApp (para correlación)
    wa_contact_id           text,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    -- Un número de teléfono es único por clínica
    UNIQUE (company_id, phone)
);

COMMENT ON TABLE clinicas.contacts IS 'Leads y pacientes. UNIQUE(company_id, phone) garantiza un registro por número por clínica.';
COMMENT ON COLUMN clinicas.contacts.status IS 'Estado en el pipeline: prospecto → calificado → agendado → paciente. El agente lo actualiza automáticamente.';
COMMENT ON COLUMN clinicas.contacts.interest_treatment_id IS 'Tratamiento de interés detectado en Fase 1. Facilita el agendamiento en Fase 2.';


-- =============================================================================
-- TABLA: conversations (Conversaciones del agente con un contacto)
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.conversations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    contact_id              uuid NOT NULL REFERENCES clinicas.contacts(id) ON DELETE CASCADE,
    agent_id                uuid NOT NULL REFERENCES clinicas.agents(id),

    channel                 text NOT NULL DEFAULT 'whatsapp'
                            CHECK (channel IN ('whatsapp', 'instagram', 'web')),

    status                  text NOT NULL DEFAULT 'open'
                            CHECK (status IN (
                                'open',       -- Activa, el agente responde
                                'escalated',  -- Pasada a humano
                                'waiting',    -- Esperando respuesta del contacto
                                'closed'      -- Finalizada
                            )),

    -- Fase actual del agente en esta conversación
    pipeline_phase          int NOT NULL DEFAULT 1 CHECK (pipeline_phase BETWEEN 1 AND 4),

    -- Datos de escalamiento (si status = 'escalated')
    assigned_staff_id       uuid REFERENCES clinicas.staff(id) ON DELETE SET NULL,
    escalation_reason       text,
    escalated_at            timestamptz,

    -- ID de la conversación en el proveedor (Kapso, etc.)
    channel_conversation_id text,

    closed_at               timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.conversations IS 'Una conversación por sesión de contacto. pipeline_phase rastrea en qué fase del agente está la interacción.';
COMMENT ON COLUMN clinicas.conversations.pipeline_phase IS '1=Calificación, 2=Agendamiento, 3=Pre-cita, 4=Post-cita.';


-- =============================================================================
-- TABLA: messages (Mensajes de la conversación)
-- bigserial para alto volumen. company_id denormalizado para RLS sin JOIN.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.messages (
    id                  bigserial PRIMARY KEY,
    -- company_id denormalizado: permite RLS por tenant sin JOIN a conversations.
    company_id          uuid NOT NULL,
    conversation_id     uuid NOT NULL REFERENCES clinicas.conversations(id) ON DELETE CASCADE,

    role                text NOT NULL CHECK (role IN ('contact', 'agent', 'system')),
    content             text NOT NULL,

    -- Metadata del mensaje: media, tipo interactivo, payload raw, etc.
    metadata            jsonb NOT NULL DEFAULT '{}',

    created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.messages IS 'Mensajes de cada conversación. company_id denormalizado para RLS eficiente sin JOIN.';
COMMENT ON COLUMN clinicas.messages.metadata IS 'JSONB flexible: media_url, mime_type, message_type, raw_payload, etc.';


-- =============================================================================
-- TABLA: availability_slots (Slots de disponibilidad para agendamiento)
-- MVP: slots de datetime específico. El panel de la clínica los genera.
-- El agente consulta slots libres y reserva directamente en el chat.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.availability_slots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    staff_id        uuid NOT NULL REFERENCES clinicas.staff(id) ON DELETE CASCADE,

    -- NULL = slot aplica para cualquier tratamiento
    treatment_id    uuid REFERENCES clinicas.treatments(id) ON DELETE SET NULL,

    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,

    -- Una vez reservado, el agente no lo ofrece a otros leads
    is_booked       boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CHECK (ends_at > starts_at)
);

COMMENT ON TABLE clinicas.availability_slots IS 'Slots de agenda disponibles. El agente los consulta y reserva en Fase 2. is_booked=true cuando ya tiene cita asignada.';


-- =============================================================================
-- TABLA: appointments (Citas — Fase 2, 3 y 4)
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.appointments (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    contact_id              uuid NOT NULL REFERENCES clinicas.contacts(id) ON DELETE CASCADE,
    treatment_id            uuid REFERENCES clinicas.treatments(id) ON DELETE SET NULL,
    staff_id                uuid REFERENCES clinicas.staff(id) ON DELETE SET NULL,
    slot_id                 uuid REFERENCES clinicas.availability_slots(id) ON DELETE SET NULL,

    -- Conversación que originó la cita
    conversation_id         uuid REFERENCES clinicas.conversations(id) ON DELETE SET NULL,

    scheduled_at            timestamptz NOT NULL,

    status                  text NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN (
                                'scheduled',    -- Agendada por el agente
                                'confirmed',    -- Confirmada por el paciente
                                'rescheduled',  -- Reprogramada
                                'cancelled',    -- Cancelada
                                'completed',    -- Cita realizada
                                'no_show'       -- El paciente no asistió
                            )),

    -- Fase 3: seguimiento pre-cita
    reminder_24h_sent_at    timestamptz,        -- Cuándo se envió el recordatorio
    preparation_sent_at     timestamptz,        -- Cuándo se enviaron las instrucciones

    -- Fase 4: post-cita
    completed_at            timestamptz,
    notes                   text,               -- Notas del médico / asesora

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.appointments IS 'Citas agendadas. Conecta Fases 2 (agendamiento), 3 (recordatorios) y 4 (post-cita).';
COMMENT ON COLUMN clinicas.appointments.reminder_24h_sent_at IS 'Fase 3: timestamp del recordatorio enviado 24h antes. NULL = pendiente de enviar.';
COMMENT ON COLUMN clinicas.appointments.preparation_sent_at IS 'Fase 3: timestamp de instrucciones de preparación enviadas al paciente.';


-- =============================================================================
-- TABLA: clinical_forms (Historia clínica pre-consulta — Fase 4)
-- El agente recolecta estos datos en conversación antes de la primera cita.
-- El backend genera un PDF y lo envía al médico y al paciente.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.clinical_forms (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    contact_id          uuid NOT NULL REFERENCES clinicas.contacts(id) ON DELETE CASCADE,
    appointment_id      uuid REFERENCES clinicas.appointments(id) ON DELETE SET NULL,

    -- Datos clínicos recolectados por el agente
    allergies           text,
    medications         text,
    -- Ej: [{"treatment": "Botox", "date": "2024-06", "clinic": "ClínicaX", "result": "Bueno"}]
    previous_treatments jsonb NOT NULL DEFAULT '[]',
    expectations        text,
    contraindications   text,

    -- Campos adicionales según el tratamiento específico
    extra_data          jsonb NOT NULL DEFAULT '{}',

    -- PDF generado automáticamente
    pdf_url             text,
    pdf_generated_at    timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.clinical_forms IS 'Historia clínica recolectada por el agente antes de la primera consulta. Se exporta como PDF para el médico (Fase 4).';


-- =============================================================================
-- TABLA: follow_ups (Seguimiento post-tratamiento — Fase 4)
-- Un registro por seguimiento programado (3d, 7d, 30d).
-- Un job/cron los procesa y activa el agente para enviar el mensaje.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.follow_ups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    contact_id      uuid NOT NULL REFERENCES clinicas.contacts(id) ON DELETE CASCADE,
    appointment_id  uuid NOT NULL REFERENCES clinicas.appointments(id) ON DELETE CASCADE,

    -- Tipo de seguimiento
    type            text NOT NULL
                    CHECK (type IN (
                        'satisfaction_3d',      -- Chequeo de bienestar a los 3 días
                        'results_7d',           -- Evaluación de resultados a los 7 días
                        'review_request_30d',   -- Solicitud de reseña a los 30 días
                        'reactivation'          -- Reactivación para próxima sesión
                    )),

    -- Cuándo enviar el mensaje (calculado al marcar la cita como completada)
    scheduled_at    timestamptz NOT NULL,

    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'completed', 'skipped')),

    -- Respuesta del paciente capturada en conversación
    response        jsonb,

    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.follow_ups IS 'Seguimientos post-tratamiento programados (3d/7d/30d). Un cron los procesa y activa el agente para enviar el mensaje (Fase 4).';
COMMENT ON COLUMN clinicas.follow_ups.scheduled_at IS 'Calculado al marcar la cita como completada: completed_at + N días del treatment.followup_days.';


-- =============================================================================
-- ÍNDICES
-- =============================================================================

-- Routing del webhook: lookup por phone_number_id (ruta más crítica del sistema)
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_wa_phone_number_id
    ON clinicas.companies (wa_phone_number_id)
    WHERE wa_phone_number_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_active
    ON clinicas.companies (active)
    WHERE active = true;

-- Contactos: lookup por teléfono dentro de una clínica (segunda ruta crítica)
CREATE INDEX IF NOT EXISTS idx_contacts_company_phone
    ON clinicas.contacts (company_id, phone);

CREATE INDEX IF NOT EXISTS idx_contacts_company_status
    ON clinicas.contacts (company_id, status);

-- Conversaciones: buscar la conv abierta de un contacto
CREATE INDEX IF NOT EXISTS idx_conversations_contact_open
    ON clinicas.conversations (contact_id, status)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_conversations_company_status
    ON clinicas.conversations (company_id, status, created_at DESC);

-- Mensajes: historial de una conversación
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON clinicas.messages (conversation_id, created_at DESC);

-- RLS eficiente en mensajes (sin JOIN a conversations)
CREATE INDEX IF NOT EXISTS idx_messages_company_created
    ON clinicas.messages (company_id, created_at DESC);

-- Availability: buscar slots libres por staff y fecha
CREATE INDEX IF NOT EXISTS idx_availability_slots_free_starts
    ON clinicas.availability_slots (company_id, starts_at)
    WHERE is_booked = false;

CREATE INDEX IF NOT EXISTS idx_availability_slots_staff_free
    ON clinicas.availability_slots (staff_id, starts_at)
    WHERE is_booked = false;

-- Appointments: citas próximas activas (para Fase 3 — recordatorios)
CREATE INDEX IF NOT EXISTS idx_appointments_active_scheduled
    ON clinicas.appointments (company_id, status, scheduled_at)
    WHERE status IN ('scheduled', 'confirmed');

-- Reminder 24h pendiente: slots que necesitan recordatorio y aún no lo recibieron
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_pending
    ON clinicas.appointments (scheduled_at)
    WHERE status IN ('scheduled', 'confirmed')
      AND reminder_24h_sent_at IS NULL;

-- Follow-ups: seguimientos pendientes de enviar (procesados por el cron)
CREATE INDEX IF NOT EXISTS idx_follow_ups_pending_scheduled
    ON clinicas.follow_ups (scheduled_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_follow_ups_contact
    ON clinicas.follow_ups (contact_id, status);


-- =============================================================================
-- ROW LEVEL SECURITY
-- El backend (service_role) bypasea RLS automáticamente.
-- Las políticas protegen el acceso desde el panel de control (authenticated role).
-- =============================================================================

ALTER TABLE clinicas.companies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.agents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.treatments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.staff             ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.availability_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.appointments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.clinical_forms    ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinicas.follow_ups        ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- FUNCIÓN AUXILIAR: get_or_create_contact
-- Equivalente multi-tenant del getOrCreateContacto del DbService actual.
-- Retorna el contacto existente o crea uno nuevo.
-- =============================================================================
CREATE OR REPLACE FUNCTION clinicas.get_or_create_contact(
    p_company_id    uuid,
    p_phone         text,
    p_name          text DEFAULT NULL
)
RETURNS clinicas.contacts
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_contact clinicas.contacts;
    v_name    text;
BEGIN
    -- Buscar existente
    SELECT * INTO v_contact
    FROM clinicas.contacts
    WHERE company_id = p_company_id AND phone = p_phone;

    IF FOUND THEN
        RETURN v_contact;
    END IF;

    -- Crear nuevo
    v_name := COALESCE(NULLIF(trim(p_name), ''), 'Desconocido') || ' *No confirmado';

    INSERT INTO clinicas.contacts (company_id, phone, name, status, temperature)
    VALUES (p_company_id, p_phone, v_name, 'prospecto', 'frio')
    RETURNING * INTO v_contact;

    RETURN v_contact;
END;
$$;

COMMENT ON FUNCTION clinicas.get_or_create_contact IS 'Busca o crea un contacto por teléfono dentro de una clínica. SECURITY DEFINER para uso desde el backend.';


-- =============================================================================
-- FUNCIÓN AUXILIAR: get_company_by_wa_phone
-- Lookup del tenant por phone_number_id. Ruta crítica del webhook.
-- =============================================================================
CREATE OR REPLACE FUNCTION clinicas.get_company_by_wa_phone(
    p_wa_phone_number_id text
)
RETURNS clinicas.companies
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT *
    FROM clinicas.companies
    WHERE wa_phone_number_id = p_wa_phone_number_id
      AND active = true
    LIMIT 1;
$$;

COMMENT ON FUNCTION clinicas.get_company_by_wa_phone IS 'Lookup del tenant por wa_phone_number_id. Primera llamada del webhook para identificar la clínica.';


-- =============================================================================
-- FUNCIÓN AUXILIAR: get_available_slots
-- Retorna los próximos N slots libres de una clínica, con datos de staff.
-- La usa el agente (tool calling) para ofrecer disponibilidad en el chat.
-- =============================================================================
CREATE OR REPLACE FUNCTION clinicas.get_available_slots(
    p_company_id    uuid,
    p_treatment_id  uuid DEFAULT NULL,
    p_from          timestamptz DEFAULT now(),
    p_limit         int DEFAULT 5
)
RETURNS TABLE (
    slot_id         uuid,
    staff_name      text,
    staff_specialty text,
    starts_at       timestamptz,
    ends_at         timestamptz,
    duration_min    int
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT
        s.id                                                    AS slot_id,
        st.name                                                 AS staff_name,
        st.specialty                                            AS staff_specialty,
        s.starts_at,
        s.ends_at,
        EXTRACT(EPOCH FROM (s.ends_at - s.starts_at))::int / 60 AS duration_min
    FROM clinicas.availability_slots s
    JOIN clinicas.staff st ON st.id = s.staff_id
    WHERE s.company_id = p_company_id
      AND s.is_booked = false
      AND s.starts_at >= p_from
      AND (p_treatment_id IS NULL OR s.treatment_id IS NULL OR s.treatment_id = p_treatment_id)
      AND st.active = true
    ORDER BY s.starts_at ASC
    LIMIT p_limit;
$$;

COMMENT ON FUNCTION clinicas.get_available_slots IS 'Retorna los próximos slots libres de una clínica. Usada por el agente como tool call en Fase 2.';


-- =============================================================================
-- FUNCIÓN AUXILIAR: book_appointment
-- Reserva un slot y crea la cita en una sola transacción atómica.
-- Evita race conditions donde dos leads reservan el mismo slot.
-- =============================================================================
CREATE OR REPLACE FUNCTION clinicas.book_appointment(
    p_company_id        uuid,
    p_contact_id        uuid,
    p_slot_id           uuid,
    p_treatment_id      uuid DEFAULT NULL,
    p_conversation_id   uuid DEFAULT NULL,
    p_notes             text DEFAULT NULL
)
RETURNS clinicas.appointments
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_slot          clinicas.availability_slots;
    v_appointment   clinicas.appointments;
BEGIN
    -- Bloquear el slot para evitar reservas simultáneas
    SELECT * INTO v_slot
    FROM clinicas.availability_slots
    WHERE id = p_slot_id
      AND company_id = p_company_id
      AND is_booked = false
    FOR UPDATE NOWAIT;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El slot % ya no está disponible.', p_slot_id
            USING ERRCODE = 'P0002';
    END IF;

    -- Marcar slot como reservado
    UPDATE clinicas.availability_slots
    SET is_booked = true
    WHERE id = p_slot_id;

    -- Crear la cita
    INSERT INTO clinicas.appointments (
        company_id, contact_id, treatment_id, staff_id,
        slot_id, conversation_id, scheduled_at, status, notes
    )
    VALUES (
        p_company_id, p_contact_id,
        COALESCE(p_treatment_id, v_slot.treatment_id),
        v_slot.staff_id,
        p_slot_id, p_conversation_id,
        v_slot.starts_at, 'scheduled', p_notes
    )
    RETURNING * INTO v_appointment;

    -- Actualizar estado del contacto
    UPDATE clinicas.contacts
    SET status = 'agendado', updated_at = now()
    WHERE id = p_contact_id;

    RETURN v_appointment;
END;
$$;

COMMENT ON FUNCTION clinicas.book_appointment IS 'Reserva atómica: bloquea el slot (FOR UPDATE NOWAIT) y crea la cita. Previene double-booking en reservas concurrentes.';


-- =============================================================================
-- FUNCIÓN AUXILIAR: create_follow_ups_for_appointment
-- Al marcar una cita como completada, genera los follow_ups según
-- los días configurados en el tratamiento.
-- =============================================================================
CREATE OR REPLACE FUNCTION clinicas.create_follow_ups_for_appointment(
    p_appointment_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_appt      clinicas.appointments;
    v_treatment clinicas.treatments;
    v_day       int;
    v_type      text;
BEGIN
    SELECT * INTO v_appt
    FROM clinicas.appointments
    WHERE id = p_appointment_id AND status = 'completed';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cita % no encontrada o no está completada.', p_appointment_id;
    END IF;

    -- Si el tratamiento no existe, usar días por defecto
    IF v_appt.treatment_id IS NOT NULL THEN
        SELECT * INTO v_treatment
        FROM clinicas.treatments
        WHERE id = v_appt.treatment_id;
    END IF;

    FOREACH v_day IN ARRAY COALESCE(v_treatment.followup_days, '{3,7,30}'::int[])
    LOOP
        v_type := CASE v_day
            WHEN 3  THEN 'satisfaction_3d'
            WHEN 7  THEN 'results_7d'
            WHEN 30 THEN 'review_request_30d'
            ELSE         'reactivation'
        END;

        INSERT INTO clinicas.follow_ups (
            company_id, contact_id, appointment_id, type, scheduled_at
        )
        VALUES (
            v_appt.company_id,
            v_appt.contact_id,
            v_appt.id,
            v_type,
            v_appt.completed_at + (v_day || ' days')::interval
        )
        ON CONFLICT DO NOTHING;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION clinicas.create_follow_ups_for_appointment IS 'Genera follow_ups automáticamente al completar una cita. Llamar cuando status cambia a completed.';
