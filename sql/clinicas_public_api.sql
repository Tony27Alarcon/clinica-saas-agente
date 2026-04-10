-- =============================================================================
-- Función pública: clinicas.get_public_profile(slug)
--
-- Retorna un JSONB con todos los datos de una clínica que son seguros para
-- mostrar públicamente. NUNCA incluye: tokens, teléfonos/emails de staff,
-- wa_access_token, ni ningún dato de pacientes.
--
-- Usada por el portal web de la clínica (Next.js en Vercel) con una sola
-- llamada. SECURITY DEFINER para que el rol anónimo pueda llamarla sin
-- acceder directamente a las tablas (que tienen RLS habilitado).
--
-- CÓMO APLICAR:
--   Ejecutar en SQL Editor de Supabase. Idempotente (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION clinicas.get_public_profile(p_slug text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT jsonb_build_object(

        -- Datos básicos de la clínica (sin credenciales)
        'company', (
            SELECT jsonb_build_object(
                'name',             c.name,
                'slug',             c.slug,
                'wa_phone_display', (
                    SELECT COALESCE(ch.display_name, ch.phone_number)
                    FROM clinicas.channels ch
                    WHERE ch.company_id = c.id
                      AND ch.provider = 'whatsapp'
                      AND ch.active = true
                    LIMIT 1
                ),
                'timezone',         c.timezone,
                'currency',         c.currency,
                'country_code',     c.country_code,
                'plan',             c.plan
            )
            FROM clinicas.companies c
            WHERE c.slug = p_slug
              AND c.active = true
            LIMIT 1
        ),

        -- Agente activo: instrucciones, tono y criterios (sin tokens)
        'agent', (
            SELECT jsonb_build_object(
                'name',                   a.name,
                'system_prompt',          a.system_prompt,
                'tone',                   a.tone,
                'qualification_criteria', a.qualification_criteria,
                'escalation_rules',       a.escalation_rules,
                'objections_kb',          a.objections_kb
            )
            FROM clinicas.agents a
            JOIN clinicas.companies c ON c.id = a.company_id
            WHERE c.slug = p_slug
              AND c.active = true
              AND a.active = true
            ORDER BY a.created_at ASC
            LIMIT 1
        ),

        -- Catálogo de tratamientos activos (con precios e instrucciones)
        'treatments', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id',                       t.id,
                    'name',                     t.name,
                    'description',              t.description,
                    'price_min',                t.price_min,
                    'price_max',                t.price_max,
                    'duration_min',             t.duration_min,
                    'preparation_instructions', t.preparation_instructions,
                    'post_care_instructions',   t.post_care_instructions,
                    'followup_days',            t.followup_days
                ) ORDER BY t.name
            ), '[]'::jsonb)
            FROM clinicas.treatments t
            JOIN clinicas.companies c ON c.id = t.company_id
            WHERE c.slug = p_slug
              AND c.active = true
              AND t.active = true
        ),

        -- Personal (solo nombre, rol y especialidad — sin teléfono ni email)
        'staff', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'id',        s.id,
                    'name',      s.name,
                    'role',      s.role,
                    'specialty', s.specialty
                ) ORDER BY s.name
            ), '[]'::jsonb)
            FROM clinicas.staff s
            JOIN clinicas.companies c ON c.id = s.company_id
            WHERE c.slug = p_slug
              AND c.active = true
              AND s.active = true
        )

    );
$$;

COMMENT ON FUNCTION clinicas.get_public_profile IS
    'Retorna datos públicos de una clínica por slug. Seguro para llamar desde el portal web (Next.js). Nunca expone tokens, teléfonos de staff ni datos de pacientes.';
