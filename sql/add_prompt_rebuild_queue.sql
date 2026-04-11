-- =============================================================================
-- Migración: Cola de recompilación de prompts (prompt_rebuild_queue)
-- =============================================================================
--
-- Cuando cambian datos que alimentan el system_prompt (tratamientos, staff,
-- horarios, etc.), los triggers de Postgres insertan una fila en esta tabla.
-- El backend procesa la cola de forma asíncrona y llama a buildSystemPrompt()
-- para regenerar agents.system_prompt.
--
-- DISEÑO INTENCIONAL:
--   - Los triggers SOLO insertan en la cola. Nunca ejecutan lógica pesada.
--   - La compilación TypeScript ocurre en el backend (tiene contexto, logs, retry).
--   - Una sola fila pending por company es suficiente (ON CONFLICT DO NOTHING).
--
-- Idempotente. Ejecutar en Supabase SQL Editor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tabla de cola
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinicas.prompt_rebuild_queue (
    id              bigserial PRIMARY KEY,
    company_id      uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    -- Qué cambió (para logging/debugging, no afecta la lógica de compilación)
    triggered_by    text NOT NULL
                    CHECK (triggered_by IN ('treatments', 'staff', 'companies', 'agents', 'manual')),

    created_at      timestamptz NOT NULL DEFAULT now(),

    -- NULL = pendiente de procesar. El backend escribe el timestamp al completar.
    processed_at    timestamptz,

    -- Si el rebuild falló, se guarda el error para diagnóstico
    error           text
);

COMMENT ON TABLE clinicas.prompt_rebuild_queue IS 'Cola de recompilación de prompts. Triggers Postgres insertan aquí cuando cambian datos del agente. Backend procesa de forma asíncrona.';
COMMENT ON COLUMN clinicas.prompt_rebuild_queue.processed_at IS 'NULL = pendiente. El backend escribe now() al completar exitosamente el rebuild.';
COMMENT ON COLUMN clinicas.prompt_rebuild_queue.triggered_by IS 'Qué tabla originó el cambio. Solo para trazabilidad.';

-- Índice para procesar eficientemente la cola (filas pendientes más antiguas primero)
CREATE INDEX IF NOT EXISTS idx_prompt_rebuild_queue_pending
    ON clinicas.prompt_rebuild_queue (company_id, created_at)
    WHERE processed_at IS NULL;


-- -----------------------------------------------------------------------------
-- Función auxiliar: encolar rebuild
-- Inserta una fila en la cola. Idempotente por company: si ya hay una fila
-- pendiente para esa empresa, no duplica (evita rafagas de triggers).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinicas.enqueue_prompt_rebuild()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_table_name text := TG_TABLE_NAME;
BEGIN
    -- Extraer el company_id según la tabla que disparó el trigger
    IF v_table_name = 'companies' THEN
        v_company_id := COALESCE(NEW.id, OLD.id);
    ELSE
        -- treatments, staff, agents: todos tienen company_id
        v_company_id := COALESCE(NEW.company_id, OLD.company_id);
    END IF;

    -- Insertar solo si NO hay ya una fila pendiente para este company
    -- Evita acumular docenas de filas por un import masivo de tratamientos
    INSERT INTO clinicas.prompt_rebuild_queue (company_id, triggered_by)
    SELECT v_company_id, v_table_name
    WHERE NOT EXISTS (
        SELECT 1
        FROM clinicas.prompt_rebuild_queue
        WHERE company_id = v_company_id
          AND processed_at IS NULL
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION clinicas.enqueue_prompt_rebuild IS 'Trigger function: encola un rebuild de prompt para la clínica afectada. Idempotente: no duplica si ya hay una fila pendiente.';


-- -----------------------------------------------------------------------------
-- Triggers: uno por tabla que alimenta el prompt
-- Se disparan en INSERT, UPDATE y DELETE para capturar cualquier cambio.
-- -----------------------------------------------------------------------------

-- Tratamientos (catálogo, precios, categorías)
DROP TRIGGER IF EXISTS trg_prompt_rebuild_treatments ON clinicas.treatments;
CREATE TRIGGER trg_prompt_rebuild_treatments
    AFTER INSERT OR UPDATE OR DELETE ON clinicas.treatments
    FOR EACH ROW EXECUTE FUNCTION clinicas.enqueue_prompt_rebuild();

-- Staff (nombre, rol, especialidad)
DROP TRIGGER IF EXISTS trg_prompt_rebuild_staff ON clinicas.staff;
CREATE TRIGGER trg_prompt_rebuild_staff
    AFTER INSERT OR UPDATE OR DELETE ON clinicas.staff
    FOR EACH ROW EXECUTE FUNCTION clinicas.enqueue_prompt_rebuild();

-- Datos de la clínica (horarios, ciudad, dirección)
DROP TRIGGER IF EXISTS trg_prompt_rebuild_companies ON clinicas.companies;
CREATE TRIGGER trg_prompt_rebuild_companies
    AFTER UPDATE OF name, city, address, schedule ON clinicas.companies
    FOR EACH ROW EXECUTE FUNCTION clinicas.enqueue_prompt_rebuild();

-- Configuración del agente (tone, criteria, escalation, objections, campos nuevos)
-- Para agents usamos AFTER UPDATE (INSERT lo maneja el onboarding directamente)
DROP TRIGGER IF EXISTS trg_prompt_rebuild_agents ON clinicas.agents;
CREATE TRIGGER trg_prompt_rebuild_agents
    AFTER UPDATE OF tone, qualification_criteria, escalation_rules, objections_kb,
                    persona_description, clinic_description, booking_instructions,
                    prohibited_topics
    ON clinicas.agents
    FOR EACH ROW EXECUTE FUNCTION clinicas.enqueue_prompt_rebuild();

-- RLS para la tabla de cola (el backend usa service_role, bypasea RLS)
ALTER TABLE clinicas.prompt_rebuild_queue ENABLE ROW LEVEL SECURITY;
