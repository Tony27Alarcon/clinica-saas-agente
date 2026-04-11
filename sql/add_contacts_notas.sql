-- =============================================================================
-- Migration: add_contacts_notas
-- Tabla de notas internas por contacto — no se borran, solo se archivan.
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase. Idempotente: usa IF NOT EXISTS.
--
-- MODELO:
--   Una nota = un registro. El agente puede ver, agregar, editar y archivar.
--   Archivar ≠ borrar: el campo archived=true oculta la nota del contexto
--   activo pero mantiene el historial completo.
-- =============================================================================

-- =============================================================================
-- TABLA: contacts_notas
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.contacts_notas (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid        NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    contact_id  uuid        NOT NULL REFERENCES clinicas.contacts(id)  ON DELETE CASCADE,

    -- Contenido de la nota
    content     text        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),

    -- Quién la creó: "agent" para el agente IA, o nombre del staff
    created_by  text        NOT NULL DEFAULT 'agent',

    -- Estado: las notas nunca se borran, solo se archivan
    archived    boolean     NOT NULL DEFAULT false,
    archived_at timestamptz,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.contacts_notas IS
    'Notas internas sobre un contacto. No se eliminan — solo se archivan. El agente IA y el staff pueden leer, crear, editar y archivar.';

COMMENT ON COLUMN clinicas.contacts_notas.created_by IS
    '"agent" si la creó el agente IA, o el nombre del staff que la ingresó.';

COMMENT ON COLUMN clinicas.contacts_notas.archived IS
    'true = nota archivada. Se excluye del contexto activo del agente pero se preserva en el historial.';


-- =============================================================================
-- ÍNDICES
-- =============================================================================

-- Lookup principal: todas las notas activas de un contacto
CREATE INDEX IF NOT EXISTS idx_contacts_notas_contact_active
    ON clinicas.contacts_notas (contact_id, archived)
    WHERE archived = false;

-- Lookup por clínica (para admin queries)
CREATE INDEX IF NOT EXISTS idx_contacts_notas_company
    ON clinicas.contacts_notas (company_id);

-- Ordenación cronológica dentro de un contacto
CREATE INDEX IF NOT EXISTS idx_contacts_notas_created_at
    ON clinicas.contacts_notas (contact_id, created_at DESC);


-- =============================================================================
-- ROW LEVEL SECURITY
-- El service_role del backend bypasea RLS (acceso total).
-- Las políticas aplican a roles de dashboard/cliente directo.
-- =============================================================================
ALTER TABLE clinicas.contacts_notas ENABLE ROW LEVEL SECURITY;

-- Política de aislamiento por company_id
-- (misma lógica que el resto del schema clinicas)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'clinicas'
          AND tablename  = 'contacts_notas'
          AND policyname = 'contacts_notas_company_isolation'
    ) THEN
        CREATE POLICY contacts_notas_company_isolation
            ON clinicas.contacts_notas
            USING (company_id = (current_setting('app.company_id', true))::uuid);
    END IF;
END $$;


-- =============================================================================
-- PERMISOS (mismo patrón que el resto del schema clinicas)
-- =============================================================================
GRANT SELECT, INSERT, UPDATE ON clinicas.contacts_notas TO authenticated;
GRANT ALL ON clinicas.contacts_notas TO service_role;
