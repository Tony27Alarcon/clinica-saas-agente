-- =============================================================================
-- Schema: public (pipeline Bruno / Clara)
-- Agente IA de ventas para el negocio principal (single-tenant).
--
-- CÓMO APLICAR:
--   Ejecutar en el SQL Editor de Supabase. Idempotente.
--   Orden: agentes → usuarios → contactos → conversaciones →
--          mensajes → notas_contacto → media_assets →
--          biblioteca_multimedia → notificaciones
-- =============================================================================

-- =============================================================================
-- TABLA: agentes
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.agentes (
    id            bigserial PRIMARY KEY,
    nombre        text NOT NULL,
    system_prompt text,
    tono          text NOT NULL DEFAULT 'amigable'
                  CHECK (tono IN ('formal', 'amigable', 'casual')),
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS nombre        text;
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS system_prompt text;
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS tono          text NOT NULL DEFAULT 'amigable';
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS active        boolean NOT NULL DEFAULT true;
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS created_at    timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.agentes IS 'Configuración del agente IA del pipeline público (Bruno/Clara).';


-- =============================================================================
-- TABLA: usuarios (comerciales del equipo)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.usuarios (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo         text UNIQUE NOT NULL,
    full_name      text NOT NULL,
    zona_comercial text,
    phone          text,
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS codigo         text;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS full_name      text;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS zona_comercial text;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS phone          text;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS active         boolean NOT NULL DEFAULT true;
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.usuarios IS 'Comerciales del equipo. El agente los referencia por código [CXXXXX] en el system prompt.';
CREATE INDEX IF NOT EXISTS idx_usuarios_active ON public.usuarios (active) WHERE active = true;


-- =============================================================================
-- TABLA: contactos (leads del pipeline público)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.contactos (
    id          bigserial PRIMARY KEY,
    telefono    text NOT NULL UNIQUE,
    nombre      text,
    email       text,
    temperatura text NOT NULL DEFAULT 'frio'
                CHECK (temperatura IN ('frio', 'tibio', 'caliente')),
    nota        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS telefono    text;
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS nombre      text;
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS email       text;
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS temperatura text NOT NULL DEFAULT 'frio';
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS nota        text;
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.contactos ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.contactos IS 'Leads del pipeline público. UNIQUE(telefono) — un registro por número.';
CREATE INDEX IF NOT EXISTS idx_contactos_telefono ON public.contactos (telefono);


-- =============================================================================
-- TABLA: conversaciones
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.conversaciones (
    id          bigserial PRIMARY KEY,
    contacto_id bigint NOT NULL REFERENCES public.contactos(id) ON DELETE CASCADE,
    agente_id   bigint NOT NULL REFERENCES public.agentes(id),
    user_id     uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
    status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'escalated', 'waiting', 'closed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversaciones ADD COLUMN IF NOT EXISTS contacto_id bigint REFERENCES public.contactos(id) ON DELETE CASCADE;
ALTER TABLE public.conversaciones ADD COLUMN IF NOT EXISTS agente_id   bigint REFERENCES public.agentes(id);
ALTER TABLE public.conversaciones ADD COLUMN IF NOT EXISTS user_id     uuid REFERENCES public.usuarios(id) ON DELETE SET NULL;
ALTER TABLE public.conversaciones ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'open';
ALTER TABLE public.conversaciones ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.conversaciones ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.conversaciones IS 'Conversaciones del pipeline público. Una abierta por contacto a la vez.';
CREATE INDEX IF NOT EXISTS idx_conversaciones_contacto_open
    ON public.conversaciones (contacto_id, status)
    WHERE status = 'open';


-- =============================================================================
-- TABLA: mensajes
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.mensajes (
    id              bigserial PRIMARY KEY,
    conversacion_id bigint NOT NULL REFERENCES public.conversaciones(id) ON DELETE CASCADE,
    contenido       text NOT NULL,
    rol             text NOT NULL CHECK (rol IN ('contacto', 'agente', 'sistema')),
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mensajes ADD COLUMN IF NOT EXISTS conversacion_id bigint REFERENCES public.conversaciones(id) ON DELETE CASCADE;
ALTER TABLE public.mensajes ADD COLUMN IF NOT EXISTS contenido       text;
ALTER TABLE public.mensajes ADD COLUMN IF NOT EXISTS rol             text;
ALTER TABLE public.mensajes ADD COLUMN IF NOT EXISTS metadata        jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.mensajes ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.mensajes IS 'Mensajes del pipeline público. metadata almacena tipo, media_url, etc.';
CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_created
    ON public.mensajes (conversacion_id, created_at DESC);


-- =============================================================================
-- TABLA: notas_contacto (CRM interno)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notas_contacto (
    id          bigserial PRIMARY KEY,
    contacto_id bigint NOT NULL REFERENCES public.contactos(id) ON DELETE CASCADE,
    titulo      text NOT NULL,
    nota        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notas_contacto ADD COLUMN IF NOT EXISTS contacto_id bigint REFERENCES public.contactos(id) ON DELETE CASCADE;
ALTER TABLE public.notas_contacto ADD COLUMN IF NOT EXISTS titulo      text;
ALTER TABLE public.notas_contacto ADD COLUMN IF NOT EXISTS nota        text;
ALTER TABLE public.notas_contacto ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.notas_contacto IS 'Notas del CRM asociadas a un contacto.';
CREATE INDEX IF NOT EXISTS idx_notas_contacto_id
    ON public.notas_contacto (contacto_id, created_at DESC);


-- =============================================================================
-- TABLA: media_assets (media intercambiada con el contacto)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.media_assets (
    id             bigserial PRIMARY KEY,
    contacto_id    bigint NOT NULL REFERENCES public.contactos(id) ON DELETE CASCADE,
    kind           text NOT NULL
                   CHECK (kind IN ('image', 'audio', 'document', 'video', 'sticker')),
    rol            text NOT NULL CHECK (rol IN ('contacto', 'agente')),
    descripcion_ia text,
    url_publica    text,
    metadata       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS contacto_id    bigint REFERENCES public.contactos(id) ON DELETE CASCADE;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS kind           text;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS rol            text;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS descripcion_ia text;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS url_publica    text;
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS metadata       jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.media_assets IS 'Archivos multimedia intercambiados con un contacto en el chat.';
CREATE INDEX IF NOT EXISTS idx_media_assets_contacto
    ON public.media_assets (contacto_id, created_at DESC);


-- =============================================================================
-- TABLA: biblioteca_multimedia (recursos que el agente puede enviar)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.biblioteca_multimedia (
    id              bigserial PRIMARY KEY,
    nombre          text NOT NULL,
    tipo            text NOT NULL
                    CHECK (tipo IN ('image', 'audio', 'document', 'video')),
    url             text NOT NULL,
    categoria       text,
    tags            text[],
    instruccion_uso text,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS nombre          text;
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS tipo            text;
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS url             text;
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS categoria       text;
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS tags            text[];
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS instruccion_uso text;
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS active          boolean NOT NULL DEFAULT true;
ALTER TABLE public.biblioteca_multimedia ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.biblioteca_multimedia IS 'Recursos multimedia que el agente puede enviar proactivamente.';
CREATE INDEX IF NOT EXISTS idx_biblioteca_active
    ON public.biblioteca_multimedia (active, categoria)
    WHERE active = true;


-- =============================================================================
-- TABLA: notificaciones (outbox para comerciales y soporte)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notificaciones (
    id                 bigserial PRIMARY KEY,
    user_id            uuid REFERENCES public.usuarios(id) ON DELETE CASCADE,
    destinatario_phone text,
    contenido          text NOT NULL,
    wa_estado          text NOT NULL DEFAULT 'pendiente'
                       CHECK (wa_estado IN ('pendiente', 'enviado', 'fallido')),
    created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notificaciones ADD COLUMN IF NOT EXISTS user_id            uuid REFERENCES public.usuarios(id) ON DELETE CASCADE;
ALTER TABLE public.notificaciones ADD COLUMN IF NOT EXISTS destinatario_phone text;
ALTER TABLE public.notificaciones ADD COLUMN IF NOT EXISTS contenido          text;
ALTER TABLE public.notificaciones ADD COLUMN IF NOT EXISTS wa_estado          text NOT NULL DEFAULT 'pendiente';
ALTER TABLE public.notificaciones ADD COLUMN IF NOT EXISTS created_at         timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.notificaciones IS 'Cola de notificaciones WA pendientes para comerciales y soporte.';
CREATE INDEX IF NOT EXISTS idx_notificaciones_user_pendiente
    ON public.notificaciones (user_id, wa_estado)
    WHERE wa_estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_notificaciones_soporte_pendiente
    ON public.notificaciones (destinatario_phone, wa_estado)
    WHERE wa_estado = 'pendiente' AND destinatario_phone IS NOT NULL;
