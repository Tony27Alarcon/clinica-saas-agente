-- =============================================================================
-- Migración: Campos para el sistema de Prompt Compilation
-- =============================================================================
--
-- Agrega las columnas que alimentan buildSystemPrompt() en el backend.
-- Todos los campos son nullable con defaults seguros: si no se rellenan,
-- el compilador simplemente omite esa sección del prompt.
--
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
-- Ejecutar en Supabase SQL Editor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- clinicas.companies — Datos de operación de la clínica
-- -----------------------------------------------------------------------------

ALTER TABLE clinicas.companies
    ADD COLUMN IF NOT EXISTS city     text,
    ADD COLUMN IF NOT EXISTS address  text,

    -- Horarios de atención en formato estructurado.
    -- Ejemplo:
    -- [
    --   {"days": ["lun","mar","mie","jue","vie"], "open": "09:00", "close": "19:00"},
    --   {"days": ["sab"], "open": "09:00", "close": "14:00"}
    -- ]
    ADD COLUMN IF NOT EXISTS schedule jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN clinicas.companies.city    IS 'Ciudad donde opera la clínica. Se inyecta en el prompt ("Estamos en Bogotá").';
COMMENT ON COLUMN clinicas.companies.address IS 'Dirección física. El agente la menciona cuando el paciente pregunta cómo llegar.';
COMMENT ON COLUMN clinicas.companies.schedule IS 'Horarios de atención. Array JSON: [{days:[...], open:"HH:MM", close:"HH:MM"}]. El compilador lo convierte a texto natural.';


-- -----------------------------------------------------------------------------
-- clinicas.agents — Personalidad y reglas extendidas del agente
-- -----------------------------------------------------------------------------

ALTER TABLE clinicas.agents
    -- Personalidad extendida: más granular que el enum tone.
    -- Ej: "Habla con calidez maternal, usa emojis suaves (✨🤍), evita tecnicismos,
    --       es persuasiva pero nunca agresiva ni impaciente."
    ADD COLUMN IF NOT EXISTS persona_description  text,

    -- Descripción institucional de la clínica que el agente puede mencionar.
    -- Ej: "Somos una clínica especializada en medicina estética con 8 años de
    --       experiencia, reconocida por nuestros resultados naturales."
    ADD COLUMN IF NOT EXISTS clinic_description   text,

    -- Instrucciones específicas de cómo ofrecer citas.
    -- Ej: "Siempre ofrece exactamente 2 opciones de horario. Si el paciente
    --       no puede en ninguna, ofrece 2 más. Nunca preguntes '¿cuándo puedes?'."
    ADD COLUMN IF NOT EXISTS booking_instructions text,

    -- Temas que el agente debe rechazar o redirigir.
    -- Ej: {"descuentos_no_autorizados", "comparaciones_con_competencia", "diagnosticos_por_foto"}
    ADD COLUMN IF NOT EXISTS prohibited_topics    text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN clinicas.agents.persona_description  IS 'Personalidad extendida del agente, más granular que el enum tone. Se inyecta en Sección 1 del prompt compilado.';
COMMENT ON COLUMN clinicas.agents.clinic_description   IS 'Descripción institucional de la clínica. Se inyecta en Sección 2 del prompt compilado.';
COMMENT ON COLUMN clinicas.agents.booking_instructions IS 'Reglas específicas de cómo ofrecer citas. Complementa la Fase 2 del pipeline en Sección 6.';
COMMENT ON COLUMN clinicas.agents.prohibited_topics    IS 'Array de temas que el agente rechaza. Se listan en Sección 7 de reglas del prompt.';


-- -----------------------------------------------------------------------------
-- clinicas.treatments — Metadatos del catálogo
-- -----------------------------------------------------------------------------

ALTER TABLE clinicas.treatments
    -- Agrupa tratamientos en el catálogo del prompt: 'facial', 'corporal', 'capilar', 'laser', etc.
    -- Si es NULL, el compilador lista todos los tratamientos sin agrupar.
    ADD COLUMN IF NOT EXISTS category           text,

    -- Condiciones que contraindican el tratamiento.
    -- Ej: "Embarazo, lactancia, enfermedades autoinmunes activas, herpes labial activo."
    -- El agente lo menciona si el paciente pregunta, sin inventarlo.
    ADD COLUMN IF NOT EXISTS contraindications  text;

COMMENT ON COLUMN clinicas.treatments.category          IS 'Categoría para agrupar el catálogo en el prompt. Ej: facial, corporal, capilar, laser. NULL = lista plana.';
COMMENT ON COLUMN clinicas.treatments.contraindications IS 'Condiciones que contraindican el tratamiento. El agente las menciona fielmente sin inventar.';
