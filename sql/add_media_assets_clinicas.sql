-- =============================================================================
-- Tabla: clinicas.media_assets
-- =============================================================================
--
-- CONTEXTO:
--   Cada mensaje entrante/saliente de WhatsApp puede traer adjuntos (imagen,
--   audio, documento, video, sticker). El contenido binario vive en Supabase
--   Storage (bucket `mensajes`); esta tabla guarda el *metadata* del adjunto
--   y su relación con el mensaje y la conversación.
--
--   Distinta de `clinicas.media_library` (biblioteca curada por la clínica,
--   reutilizable por el agente): `media_assets` es per-mensaje, efímera,
--   alimentada por webhooks y por las tools que generan archivos (p. ej.
--   `createSendHtmlDocumentTool`).
--
-- ¿POR QUÉ EN `clinicas` Y NO EN `public.media_assets`?
--   `public.media_assets` quedó como tabla híbrida con columnas de dos
--   proyectos distintos. Por la regla de oro (ver
--   `docs/AGENTS_ARCHITECTURE.md`) lo nuestro vive exclusivamente en
--   `clinicas`. Esta tabla es la versión limpia.
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase (idempotente).
-- =============================================================================

CREATE TABLE IF NOT EXISTS clinicas.media_assets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at       timestamptz NOT NULL DEFAULT now(),

    -- Tenant + contexto del mensaje (sin FK a conversations/messages para no
    -- perder el asset si se borra la conversación o el mensaje).
    company_id       uuid NOT NULL REFERENCES clinicas.companies(id) ON DELETE CASCADE,
    conversation_id  uuid,
    message_id       uuid,
    contact_id       uuid,

    -- Dirección: inbound (lo mandó el contacto) o outbound (lo enviamos nosotros).
    direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),

    -- Tipo de medio alineado con WhatsApp Business API.
    media_type       text NOT NULL
                     CHECK (media_type IN ('image','audio','document','video','sticker')),

    mime_type        text,
    filename         text,
    file_size_bytes  bigint,

    -- Ubicación del binario. `storage_path` es la ruta dentro del bucket
    -- `mensajes` de Supabase Storage; `public_url` es la URL firmada o
    -- pública que se pasó a Kapso/WhatsApp.
    storage_bucket   text NOT NULL DEFAULT 'mensajes',
    storage_path     text,
    public_url       text,

    -- IDs externos para evitar reprocesar el mismo adjunto.
    wa_media_id      text,
    kapso_media_id   text,

    -- Flexibilidad para datos específicos por medio (duración de audio,
    -- dimensiones de imagen, caption, etc.) sin congelar el schema.
    metadata         jsonb
);

COMMENT ON TABLE  clinicas.media_assets IS
    'Metadata de adjuntos por mensaje. El binario vive en Supabase Storage (bucket "mensajes"). Reemplaza a la tabla híbrida public.media_assets.';
COMMENT ON COLUMN clinicas.media_assets.direction IS
    '"inbound" (mensaje del contacto) | "outbound" (lo enviamos nosotros).';
COMMENT ON COLUMN clinicas.media_assets.wa_media_id IS
    'Media ID de WhatsApp Business. Permite detectar reenvíos y evitar re-subir el binario.';
COMMENT ON COLUMN clinicas.media_assets.kapso_media_id IS
    'ID opcional devuelto por Kapso tras subir el archivo. Útil para dedup en outbound.';

-- =============================================================================
-- Índices
-- =============================================================================

-- Listar adjuntos de una conversación (pantalla de debug).
CREATE INDEX IF NOT EXISTS idx_media_assets_conversation
    ON clinicas.media_assets (conversation_id, created_at DESC)
    WHERE conversation_id IS NOT NULL;

-- Tráfico por tenant.
CREATE INDEX IF NOT EXISTS idx_media_assets_company_created
    ON clinicas.media_assets (company_id, created_at DESC);

-- Dedup por wa_media_id inbound.
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_wa_media_id
    ON clinicas.media_assets (company_id, wa_media_id)
    WHERE wa_media_id IS NOT NULL;

-- Filtrado por message (cuando se consulta el mensaje y sus adjuntos).
CREATE INDEX IF NOT EXISTS idx_media_assets_message
    ON clinicas.media_assets (message_id)
    WHERE message_id IS NOT NULL;

-- =============================================================================
-- RLS (el backend usa service_role, bypasea igual)
-- =============================================================================

ALTER TABLE clinicas.media_assets ENABLE ROW LEVEL SECURITY;
