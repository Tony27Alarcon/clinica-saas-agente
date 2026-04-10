-- =============================================================================
-- Migración: Extracción de canales de comunicación a tabla independiente
-- =============================================================================
--
-- PROBLEMA:
--   Las clínicas tienen los datos de WhatsApp (wa_phone_number_id, token) 
--   directamente en la tabla `companies`. Esto impide que una clínica tenga 
--   más de un número o que use otros canales (Instagram) de forma flexible.
--
-- SOLUCIÓN:
--   1. Crear tabla `clinicas.channels`.
--   2. Migrar datos existentes.
--   3. Limpiar tabla `clinicas.companies`.
--   4. Actualizar función de ruteo del webhook.
-- =============================================================================

-- 1. Crear tabla de canales
CREATE TABLE IF NOT EXISTS clinicas.channels (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    
    -- Tipo de canal: 'whatsapp', 'instagram', 'web', 'telegram'
    provider            text NOT NULL DEFAULT 'whatsapp',
    
    -- ID técnico del proveedor (el phoneNumberId de Meta o el Page ID de IG)
    provider_id         text NOT NULL,
    
    -- Número de teléfono real (E.164) o identificador legible (ej: @clinica_bella)
    display_name        text, 
    phone_number        text,
    
    -- Credenciales específicas para este canal (sobrescribe las de la clínica si existen)
    access_token        text,
    
    active              boolean NOT NULL DEFAULT true,
    metadata            jsonb NOT NULL DEFAULT '{}',
    
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- Un mismo provider_id no puede estar en dos clínicas distintas
    UNIQUE (provider, provider_id)
);

COMMENT ON TABLE clinicas.channels IS 'Canales de comunicación (WhatsApp, IG, etc.) vinculados a una clínica.';

-- 2. MIGRACIÓN DE DATOS (SI EXISTEN)
-- Mover wa_phone_number_id de companies a la nueva tabla channels
INSERT INTO clinicas.channels (company_id, provider, provider_id, display_name, access_token, active)
SELECT id, 'whatsapp', wa_phone_number_id, wa_phone_display, wa_access_token, active
FROM clinicas.companies
WHERE wa_phone_number_id IS NOT NULL
ON CONFLICT (provider, provider_id) DO NOTHING;

-- 3. LIMPIEZA DE TABLA COMPANIES
-- Eliminamos las columnas que ya no usaremos (después de migrar)
ALTER TABLE clinicas.companies 
    DROP COLUMN IF EXISTS wa_phone_number_id,
    DROP COLUMN IF EXISTS wa_phone_display,
    DROP COLUMN IF EXISTS wa_access_token,
    DROP COLUMN IF EXISTS ig_page_id,
    DROP COLUMN IF EXISTS ig_access_token;

-- 4. ACTUALIZAR FUNCIÓN DE RUTEO (Ruta crítica del Webhook)
-- Ahora busca la compañía a través de la tabla de canales
CREATE OR REPLACE FUNCTION clinicas.get_company_by_wa_phone(
    p_wa_phone_number_id text
)
RETURNS clinicas.companies
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT c.*
    FROM clinicas.companies c
    JOIN clinicas.channels ch ON ch.company_id = c.id
    WHERE ch.provider = 'whatsapp'
      AND ch.provider_id = p_wa_phone_number_id
      AND ch.active = true
      AND c.active = true
    LIMIT 1;
$$;

-- 5. ÍNDICES DE RENDIMIENTO
CREATE INDEX IF NOT EXISTS idx_channels_company_id ON clinicas.channels (company_id);
CREATE INDEX IF NOT EXISTS idx_channels_provider_id ON clinicas.channels (provider, provider_id) WHERE active = true;

-- 6. RLS para la nueva tabla
ALTER TABLE clinicas.channels ENABLE ROW LEVEL SECURITY;
