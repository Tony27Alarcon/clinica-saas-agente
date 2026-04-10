-- ============================================================
-- Migración: Biblioteca de Medios (media_library)
-- Ejecutar en Supabase SQL Editor DESPUÉS de clinicas_schema.sql
-- ============================================================
-- Permite a los agentes enviar imágenes, audios y documentos
-- reutilizables desde una biblioteca centralizada por clínica.
-- ============================================================

-- =============================================================================
-- TABLA: media_library
-- Almacena archivos multimedia que los agentes pueden enviar en conversaciones.
-- Cada archivo pertenece a un tenant (company_id).
-- =============================================================================
CREATE TABLE IF NOT EXISTS clinicas.media_library (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,

    -- Nombre descriptivo para identificar el recurso en el panel y en el agente
    name            text NOT NULL,
    description     text,

    -- Tipo de medio (alineado con los tipos soportados por WhatsApp Business API)
    media_type      text NOT NULL
                    CHECK (media_type IN (
                        'image',        -- JPG, PNG, WEBP
                        'audio',        -- OGG Opus, MP3, AAC
                        'document',     -- PDF, DOCX, XLSX, etc.
                        'video',        -- MP4
                        'sticker'       -- WEBP animado
                    )),

    -- MIME type completo (ej: "image/jpeg", "audio/ogg", "application/pdf")
    mime_type       text NOT NULL,

    -- URL pública del archivo almacenado (Supabase Storage, CDN, etc.)
    file_url        text NOT NULL,

    -- Media ID de WhatsApp Business API (se obtiene al subir el archivo a Meta)
    -- Si está presente, el agente lo usa directamente en lugar de re-subir el archivo.
    -- Se invalida automáticamente después de 30 días si no se usa.
    wa_media_id     text,
    wa_media_id_expires_at timestamptz,

    -- Tamaño en bytes (validación de límites de WhatsApp)
    file_size_bytes bigint,

    -- Nombre original del archivo (para descargas y UI)
    filename        text,

    -- Etiquetas para organización y búsqueda por el agente
    -- Ej: ["bienvenida", "pre-cita", "botox", "precios"]
    tags            text[] NOT NULL DEFAULT '{}',

    -- Categoría de uso del agente: en qué fase del pipeline se envía
    -- NULL = sin restricción de fase
    pipeline_phase  int CHECK (pipeline_phase BETWEEN 1 AND 4),

    -- Quién subió el archivo (opcional, para auditoría)
    uploaded_by_staff_id uuid REFERENCES clinicas.staff(id) ON DELETE SET NULL,

    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinicas.media_library IS
    'Biblioteca de medios por clínica. Los agentes la consultan para enviar imágenes, audios y documentos en conversaciones de WhatsApp.';
COMMENT ON COLUMN clinicas.media_library.wa_media_id IS
    'Media ID de WhatsApp Business API. Permite envío directo sin re-subir. Expira a los 30 días sin uso.';
COMMENT ON COLUMN clinicas.media_library.tags IS
    'Etiquetas de búsqueda. El agente puede filtrar por tag para encontrar el recurso correcto (ej: "precios", "pre-cita", "bienvenida").';
COMMENT ON COLUMN clinicas.media_library.pipeline_phase IS
    'Fase del pipeline en que se usa preferentemente este recurso. NULL = disponible en cualquier fase.';


-- =============================================================================
-- ÍNDICES
-- =============================================================================

-- Lookup por clínica y tipo de medio (consulta principal del agente)
CREATE INDEX IF NOT EXISTS idx_media_library_company_type
    ON clinicas.media_library (company_id, media_type)
    WHERE active = true;

-- Búsqueda por tags usando índice GIN (soporta operadores @> y &&)
CREATE INDEX IF NOT EXISTS idx_media_library_tags
    ON clinicas.media_library USING GIN (tags)
    WHERE active = true;

-- Lookup de wa_media_id vigente (para envío directo sin re-subir)
CREATE INDEX IF NOT EXISTS idx_media_library_wa_media_id
    ON clinicas.media_library (company_id, wa_media_id)
    WHERE wa_media_id IS NOT NULL AND active = true;

-- Filtro por fase del pipeline
CREATE INDEX IF NOT EXISTS idx_media_library_company_phase
    ON clinicas.media_library (company_id, pipeline_phase)
    WHERE active = true AND pipeline_phase IS NOT NULL;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE clinicas.media_library ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- FUNCIÓN AUXILIAR: get_media_by_tags
-- Busca recursos de la biblioteca por tags. Usada por el agente como tool call
-- para encontrar el archivo correcto a enviar en una conversación.
-- =============================================================================
CREATE OR REPLACE FUNCTION clinicas.get_media_by_tags(
    p_company_id    uuid,
    p_tags          text[],
    p_media_type    text DEFAULT NULL,
    p_limit         int  DEFAULT 5
)
RETURNS TABLE (
    id              uuid,
    name            text,
    description     text,
    media_type      text,
    mime_type       text,
    file_url        text,
    wa_media_id     text,
    filename        text,
    tags            text[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT
        m.id,
        m.name,
        m.description,
        m.media_type,
        m.mime_type,
        m.file_url,
        -- Devolver wa_media_id solo si aún no expiró
        CASE WHEN m.wa_media_id_expires_at IS NULL
                  OR m.wa_media_id_expires_at > now()
             THEN m.wa_media_id
             ELSE NULL
        END AS wa_media_id,
        m.filename,
        m.tags
    FROM clinicas.media_library m
    WHERE m.company_id = p_company_id
      AND m.active = true
      AND m.tags && p_tags                              -- intersección de tags
      AND (p_media_type IS NULL OR m.media_type = p_media_type)
    ORDER BY array_length(
        ARRAY(SELECT unnest(m.tags) INTERSECT SELECT unnest(p_tags)),
        1
    ) DESC                                              -- más coincidencias primero
    LIMIT p_limit;
$$;

COMMENT ON FUNCTION clinicas.get_media_by_tags IS
    'Busca archivos en la biblioteca por tags. Ordena por cantidad de coincidencias. Usada por el agente como tool call para seleccionar el recurso a enviar.';
