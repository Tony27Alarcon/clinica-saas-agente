-- ============================================================
-- Migración: Soporte para onboarding guiado del agente admin
-- Agrega columna onboarding_completed_at a clinicas.companies
-- para detectar clínicas que aún no completaron la configuración.
-- ============================================================

ALTER TABLE clinicas.companies
    ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz DEFAULT NULL;

COMMENT ON COLUMN clinicas.companies.onboarding_completed_at
    IS 'NULL = clínica en modo onboarding. Se establece al completar la configuración inicial vía agente admin.';

-- Marcar clínicas existentes como ya onboarded (no afectar tenants activos)
UPDATE clinicas.companies
SET onboarding_completed_at = created_at
WHERE onboarding_completed_at IS NULL
  AND active = true;
