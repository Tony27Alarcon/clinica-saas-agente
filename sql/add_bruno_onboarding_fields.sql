-- =============================================================================
-- Migración: Soporte para el onboarding conducido por Bruno (agente comercial)
--
-- Agrega tres piezas mínimas requeridas por commercial/omboarding_tecnico.md:
--   1. staff.staff_role   → distinguir al "owner" del resto del equipo.
--   2. channels.connected_at → timestamp cuando el número queda vinculado.
--   3. companies.referred_by → programa embajador (REFERRAL_PROGRAM.md).
--
-- Idempotente. Seguro de correr múltiples veces.
-- =============================================================================

-- 1. Rol funcional del staff dentro de la company.
--    NOTA: `role` existente (texto libre tipo "Médico Estético") se conserva.
--    Este campo nuevo es el que usa el sistema para permisos.
ALTER TABLE clinicas.staff
    ADD COLUMN IF NOT EXISTS staff_role text NOT NULL DEFAULT 'staff'
        CHECK (staff_role IN ('owner', 'admin', 'staff'));

COMMENT ON COLUMN clinicas.staff.staff_role IS
    'Rol funcional: owner = creador/dueño de la cuenta, admin = puede operar el agente, staff = solo aparece en citas. El owner es único por company.';

-- Un único owner por company (constraint parcial).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_owner_per_company
    ON clinicas.staff (company_id)
    WHERE staff_role = 'owner' AND active = true;


-- 2. Estado de conexión del canal WhatsApp.
--    El flag `active` indica si el webhook debe rutear al canal.
--    `connected_at` persiste cuándo el owner completó el flow de Kapso.
--    El estado pending/connected vive en metadata.connection_status.
ALTER TABLE clinicas.channels
    ADD COLUMN IF NOT EXISTS connected_at timestamptz;

COMMENT ON COLUMN clinicas.channels.connected_at IS
    'Timestamp del primer webhook inbound recibido (= confirmación de conexión vía Kapso). NULL mientras está en estado pending.';


-- 3. Clasificación del tenant: Bruno Lab es "platform", clínicas clientes son "tenant".
--    Solo la company marcada como 'platform' ejecuta el agente SuperAdmin.
ALTER TABLE clinicas.companies
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'tenant'
        CHECK (kind IN ('platform', 'tenant'));

COMMENT ON COLUMN clinicas.companies.kind IS
    'platform = tenant interno (Bruno Lab) que ejecuta el agente SuperAdmin (Bruno comercial/onboarder). tenant = clínica cliente. Solo debería existir una fila con kind=platform.';

-- Garantiza una sola platform en la BD.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_single_platform_company
    ON clinicas.companies (kind)
    WHERE kind = 'platform';


-- 4. Trazabilidad del programa de referidos.
ALTER TABLE clinicas.companies
    ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES clinicas.companies(id) ON DELETE SET NULL;

COMMENT ON COLUMN clinicas.companies.referred_by IS
    'Company que refirió a este tenant (REFERRAL_PROGRAM.md). NULL = outreach directo. Se fija en start_onboarding si el prospecto menciona referido.';

CREATE INDEX IF NOT EXISTS idx_companies_referred_by
    ON clinicas.companies (referred_by)
    WHERE referred_by IS NOT NULL;
