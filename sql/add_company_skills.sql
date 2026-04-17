-- =============================================================================
-- Migración: Skills configurables por empresa
--
-- Capa de skills extra que cada clínica puede activar/desactivar para SU
-- agente paciente, además de buildBaseAgentSkills() (reglas no editables).
--
-- Dos tipos de skills (columna kind):
--   - 'system'  → definidas globalmente en código (src/skills/system-patient-skills.ts).
--                  La empresa SOLO puede activarlas/desactivarlas. Los campos
--                  name/trigger/guidelines se ignoran (se leen del catálogo).
--                  Si no existe row para una system skill → enabled = true por defecto.
--   - 'private' → creadas por el admin de la empresa con contenido propio.
--                  name/trigger/guidelines son obligatorios y se persisten aquí.
--
-- Idempotente. Ejecutar en Supabase SQL Editor.
-- =============================================================================

CREATE TABLE IF NOT EXISTS clinicas.company_skills (
    id          uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid       NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    kind        text       NOT NULL CHECK (kind IN ('system','private')),
    skill_id    text       NOT NULL,
    name        text,
    trigger     text,
    guidelines  text,
    enabled     boolean    NOT NULL DEFAULT true,
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    -- slug del skill_id válido (lowercase, números, guiones)
    CONSTRAINT company_skills_skill_id_format
        CHECK (skill_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),

    -- contenido obligatorio para skills privadas
    CONSTRAINT company_skills_private_content
        CHECK (
            kind = 'system'
            OR (name IS NOT NULL AND length(trim(name))      > 0
                AND trigger    IS NOT NULL AND length(trim(trigger))    > 0
                AND guidelines IS NOT NULL AND length(trim(guidelines)) >= 30)
        ),

    UNIQUE (company_id, kind, skill_id)
);

CREATE INDEX IF NOT EXISTS company_skills_company_idx
    ON clinicas.company_skills(company_id, enabled);

COMMENT ON TABLE  clinicas.company_skills            IS 'Skills configurables por empresa para el agente paciente. Se inyectan en el system prompt si enabled=true. Convive con buildBaseAgentSkills (no editable).';
COMMENT ON COLUMN clinicas.company_skills.kind       IS 'system = catálogo global (solo toggle); private = contenido propio de la empresa.';
COMMENT ON COLUMN clinicas.company_skills.skill_id   IS 'Identificador slug. Para system debe existir en src/skills/system-patient-skills.ts.';
COMMENT ON COLUMN clinicas.company_skills.guidelines IS 'Instrucciones inyectadas tal cual en el prompt cuando enabled=true.';
COMMENT ON COLUMN clinicas.company_skills.enabled    IS 'Si false, la skill NO se inyecta. Para system, ausencia de row equivale a enabled=true.';

-- Trigger para mantener updated_at
CREATE OR REPLACE FUNCTION clinicas.touch_company_skills_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS company_skills_touch_updated_at ON clinicas.company_skills;
CREATE TRIGGER company_skills_touch_updated_at
    BEFORE UPDATE ON clinicas.company_skills
    FOR EACH ROW EXECUTE FUNCTION clinicas.touch_company_skills_updated_at();

-- Extender el CHECK de prompt_rebuild_queue.triggered_by para aceptar 'company_skills'
ALTER TABLE clinicas.prompt_rebuild_queue
    DROP CONSTRAINT IF EXISTS prompt_rebuild_queue_triggered_by_check;

ALTER TABLE clinicas.prompt_rebuild_queue
    ADD CONSTRAINT prompt_rebuild_queue_triggered_by_check
    CHECK (triggered_by IN ('treatments','staff','companies','agents','manual','company_skills'));

-- Reutilizamos la función global enqueue_prompt_rebuild() (ya extrae company_id de NEW/OLD)
DROP TRIGGER IF EXISTS trg_prompt_rebuild_company_skills ON clinicas.company_skills;
CREATE TRIGGER trg_prompt_rebuild_company_skills
    AFTER INSERT OR UPDATE OR DELETE ON clinicas.company_skills
    FOR EACH ROW EXECUTE FUNCTION clinicas.enqueue_prompt_rebuild();

-- RLS (el backend usa service_role)
ALTER TABLE clinicas.company_skills ENABLE ROW LEVEL SECURITY;
