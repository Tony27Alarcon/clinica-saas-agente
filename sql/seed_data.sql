-- =============================================================================
-- seed_data.sql — Datos de ejemplo para Clínica Bella (TEST)
-- =============================================================================
--
-- PROPÓSITO:
--   Insertar datos de prueba representativos que permitan verificar todos los
--   flujos del sistema: agendamiento, notificaciones, follow-ups, escalaciones,
--   y compilación de prompts.
--
-- USO:
--   Ejecutar en Supabase SQL Editor (proyecto de desarrollo/staging).
--   NO ejecutar en producción.
--
-- IDEMPOTENTE:
--   Usa ON CONFLICT DO NOTHING / DO UPDATE para que sea seguro re-ejecutar.
--
-- DESPUÉS DE CORRER:
--   1. Ejecutar: npm run test:seed  (sincroniza con el backend y compila el prompt)
--   2. O llamar: POST /internal/rebuild-prompt/:company_id
-- =============================================================================

-- Habilitar schema clinicas si no está en la sesión
SET search_path TO clinicas, public;

-- =============================================================================
-- 1. EMPRESA (TENANT)
-- =============================================================================

INSERT INTO clinicas.companies (
    id, name, slug, plan, timezone, currency, country_code,
    city, address, schedule, active
)
VALUES (
    gen_random_uuid(),
    'Clínica Bella (TEST)',
    'clinica-test-local',
    'pro',
    'America/Bogota',
    'USD',
    'CO',
    'Bogotá',
    'Calle 72 # 10-43, Piso 3',
    '[
        {"days": ["lun","mar","mie","jue","vie"], "open": "09:00", "close": "19:00"},
        {"days": ["sab"], "open": "09:00", "close": "14:00"}
    ]'::jsonb,
    true
)
ON CONFLICT (slug) DO UPDATE SET
    city     = EXCLUDED.city,
    address  = EXCLUDED.address,
    schedule = EXCLUDED.schedule,
    active   = true;

-- Capturar el company_id para uso en los siguientes inserts
DO $$
DECLARE
    v_company_id     uuid;
    v_agent_id       uuid;
    v_staff1_id      uuid;
    v_staff2_id      uuid;
    v_t_botox        uuid;
    v_t_relleno      uuid;
    v_t_limpieza     uuid;
    v_t_hidrolipo    uuid;
    v_t_laser        uuid;
    v_c_maria        uuid;
    v_c_carlos       uuid;
    v_c_andrea       uuid;
    v_c_luis         uuid;
    v_c_sofia        uuid;
    v_appt_manana    uuid;
    v_appt_23h       uuid;
    v_appt_completed uuid;
    v_slot1          uuid;
    v_slot2          uuid;
    v_conv_escalada  uuid;
    v_manana         timestamptz;
    v_in23h          timestamptz;
    v_3days_ago      timestamptz;
    v_7days_ago      timestamptz;
    v_now            timestamptz := now();
BEGIN

    -- Obtener company_id
    SELECT id INTO v_company_id
    FROM clinicas.companies
    WHERE slug = 'clinica-test-local';

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'company clinica-test-local no encontrada';
    END IF;

    -- =========================================================================
    -- 2. CANAL WHATSAPP
    -- =========================================================================

    INSERT INTO clinicas.channels (
        company_id, provider, provider_id, display_name, active
    )
    VALUES (
        v_company_id, 'whatsapp', 'TEST_PHONE_001',
        'Test Channel WhatsApp', true
    )
    ON CONFLICT (provider, provider_id) DO UPDATE SET
        company_id   = EXCLUDED.company_id,
        display_name = EXCLUDED.display_name,
        active       = true;

    -- =========================================================================
    -- 3. AGENTE IA
    -- =========================================================================

    SELECT id INTO v_agent_id
    FROM clinicas.agents
    WHERE company_id = v_company_id AND active = true
    LIMIT 1;

    IF v_agent_id IS NULL THEN
        INSERT INTO clinicas.agents (
            company_id, name, system_prompt, tone,
            persona_description, clinic_description,
            booking_instructions, prohibited_topics,
            qualification_criteria, escalation_rules, objections_kb,
            active
        )
        VALUES (
            v_company_id,
            'Valentina',
            '(pendiente de compilación)',
            'amigable',
            'Habla con calidez y cercanía. Usa emojis suaves (✨, 🤍, 📅) sin saturar.',
            'Clínica Bella es un centro de medicina estética con 5 años de experiencia en Bogotá.',
            'Ofrece siempre exactamente 2 opciones de horario. Nunca preguntes "¿cuándo puedes?" de forma abierta.',
            ARRAY['descuentos no autorizados', 'comparaciones con otras clínicas', 'diagnósticos por foto'],
            '{"excluded_keywords": ["gratis", "regalo", "sin costo"]}'::jsonb,
            '{"trigger_keywords": ["hablar con alguien", "persona real", "gerente"], "max_turns_without_intent": 6}'::jsonb,
            '[
                {"objection": "Es muy caro", "response": "Ofrecemos planes de financiamiento sin interés. ¿Te cuento cómo funciona?"},
                {"objection": "Lo pienso y te aviso", "response": "Por supuesto. Los turnos de esta semana se están llenando. ¿Hay alguna duda que pueda resolver ahora?"},
                {"objection": "Ya lo hice antes y no funcionó", "response": "Entiendo tu escepticismo. En nuestra clínica el tratamiento se personaliza para cada paciente."}
            ]'::jsonb,
            true
        )
        RETURNING id INTO v_agent_id;
    END IF;

    -- =========================================================================
    -- 4. TRATAMIENTOS (5 — facial, corporal, capilar)
    -- =========================================================================

    -- Botox Facial
    INSERT INTO clinicas.treatments (
        company_id, name, description, price_min, price_max, duration_min,
        category, contraindications, preparation_instructions, post_care_instructions,
        followup_days, active
    ) VALUES (
        v_company_id,
        'Botox Facial',
        'Tratamiento con toxina botulínica para reducir arrugas de expresión.',
        150, 300, 30, 'facial',
        'Embarazo, lactancia, enfermedades autoinmunes activas.',
        'No consumir alcohol 24h antes. Evitar antiinflamatorios. Venir sin maquillaje.',
        'No acostarse 4 horas. Evitar ejercicio intenso. No frotar la zona.',
        ARRAY[3, 7, 30], true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_t_botox;

    IF v_t_botox IS NULL THEN
        SELECT id INTO v_t_botox FROM clinicas.treatments
        WHERE company_id = v_company_id AND name = 'Botox Facial';
    END IF;

    -- Relleno de Labios
    INSERT INTO clinicas.treatments (
        company_id, name, description, price_min, price_max, duration_min,
        category, contraindications, preparation_instructions, post_care_instructions,
        followup_days, active
    ) VALUES (
        v_company_id,
        'Relleno de Labios',
        'Ácido hialurónico para volumizar y definir el contorno labial.',
        200, 350, 45, 'facial',
        'Herpes labial activo, embarazo.',
        'Hidratarse bien el día anterior. Si tienes historial de herpes, consulta antes.',
        'Evitar besos y presión en labios 24h. No exponerse al sol 48h.',
        ARRAY[3, 7, 30], true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_t_relleno;

    IF v_t_relleno IS NULL THEN
        SELECT id INTO v_t_relleno FROM clinicas.treatments
        WHERE company_id = v_company_id AND name = 'Relleno de Labios';
    END IF;

    -- Limpieza Facial Profunda
    INSERT INTO clinicas.treatments (
        company_id, name, description, price_min, price_max, duration_min,
        category, preparation_instructions, post_care_instructions,
        followup_days, active
    ) VALUES (
        v_company_id,
        'Limpieza Facial Profunda',
        'Limpieza profunda con extracción y tratamiento hidratante.',
        80, 120, 60, 'facial',
        'Venir sin maquillaje. No realizarse ningún otro tratamiento facial la misma semana.',
        'Usar protector solar FPS 50. Evitar maquillaje las primeras 12h.',
        ARRAY[7], true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_t_limpieza;

    IF v_t_limpieza IS NULL THEN
        SELECT id INTO v_t_limpieza FROM clinicas.treatments
        WHERE company_id = v_company_id AND name = 'Limpieza Facial Profunda';
    END IF;

    -- Hidrolipoclasia Ultrasónica
    INSERT INTO clinicas.treatments (
        company_id, name, description, price_min, price_max, duration_min,
        category, contraindications, preparation_instructions, post_care_instructions,
        followup_days, active
    ) VALUES (
        v_company_id,
        'Hidrolipoclasia Ultrasónica',
        'Reducción de grasa localizada mediante ultrasonido en abdomen, flancos y muslos.',
        180, 280, 60, 'corporal',
        'Embarazo, marcapasos, implantes metálicos en la zona, diabetes no controlada.',
        'Beber 2L de agua el día anterior. No comer 2h antes. Ropa cómoda.',
        'Tomar mucha agua los siguientes 3 días. Evitar alcohol 48h. Caminar 30 min post-tratamiento.',
        ARRAY[7, 30], true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_t_hidrolipo;

    IF v_t_hidrolipo IS NULL THEN
        SELECT id INTO v_t_hidrolipo FROM clinicas.treatments
        WHERE company_id = v_company_id AND name = 'Hidrolipoclasia Ultrasónica';
    END IF;

    -- Depilación Láser Diodo
    INSERT INTO clinicas.treatments (
        company_id, name, description, price_min, price_max, duration_min,
        category, contraindications, preparation_instructions, post_care_instructions,
        followup_days, active
    ) VALUES (
        v_company_id,
        'Depilación Láser Diodo',
        'Depilación definitiva con láser de diodo 808nm. Efectiva en todos los fototipos.',
        60, 200, 45, 'capilar',
        'Embarazo, epilepsia fotosensible, piel bronceada reciente, isotretinoína.',
        'Afeitar la zona 24-48h antes. No depilarse con cera 4 semanas antes.',
        'Aplicar calmante (aloe vera). Evitar sol 2 semanas. No sauna ni piscina 48h.',
        ARRAY[30], true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_t_laser;

    IF v_t_laser IS NULL THEN
        SELECT id INTO v_t_laser FROM clinicas.treatments
        WHERE company_id = v_company_id AND name = 'Depilación Láser Diodo';
    END IF;

    -- =========================================================================
    -- 5. STAFF (2 doctores)
    -- =========================================================================

    -- Staff 1: Dr. Martín García (médico principal)
    INSERT INTO clinicas.staff (
        company_id, name, role, specialty, phone,
        max_daily_appointments, active
    ) VALUES (
        v_company_id,
        'Dr. Martín García',
        'Médico Estético',
        'Botox y Rellenos',
        '5491100000001',   -- TEST_ADMIN_PHONE
        8, true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_staff1_id;

    IF v_staff1_id IS NULL THEN
        SELECT id INTO v_staff1_id FROM clinicas.staff
        WHERE company_id = v_company_id AND phone = '5491100000001';
    END IF;

    -- Staff 2: Dra. Laura Rodríguez (corporal + láser)
    INSERT INTO clinicas.staff (
        company_id, name, role, specialty, phone, email,
        max_daily_appointments, active
    ) VALUES (
        v_company_id,
        'Dra. Laura Rodríguez',
        'Médico Estético',
        'Tratamientos Corporales y Láser',
        '5491133330005',
        'laura@clinicabella.test',
        6, true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_staff2_id;

    IF v_staff2_id IS NULL THEN
        SELECT id INTO v_staff2_id FROM clinicas.staff
        WHERE company_id = v_company_id AND phone = '5491133330005';
    END IF;

    -- =========================================================================
    -- 6. AVAILABILITY SLOTS (próximos 5 días laborales × 2 staff)
    -- =========================================================================

    -- Eliminar slots viejos no reservados para empezar limpio
    DELETE FROM clinicas.availability_slots
    WHERE company_id = v_company_id
      AND is_booked = false
      AND starts_at < now();

    -- Insertar slots para los próximos 5 días laborales
    -- UTC times: 14=9am CO, 15=10am, 16=11am, 19=2pm, 20=3pm, 21=4pm
    INSERT INTO clinicas.availability_slots (company_id, staff_id, starts_at, ends_at, is_booked)
    SELECT
        v_company_id,
        s.staff_id,
        (current_date + (i || ' days')::interval + (h || ' hours')::interval)::timestamptz,
        (current_date + (i || ' days')::interval + (h || ' hours')::interval + '45 minutes'::interval)::timestamptz,
        false
    FROM
        generate_series(1, 7) i,
        unnest(ARRAY[14, 15, 19, 20]) h,
        (VALUES (v_staff1_id), (v_staff2_id)) s(staff_id)
    WHERE
        -- Solo días laborales (1=lunes, 5=viernes)
        EXTRACT(DOW FROM (current_date + (i || ' days')::interval)) BETWEEN 1 AND 5
    ON CONFLICT DO NOTHING;

    -- =========================================================================
    -- 7. CONTACTOS (5 en diferentes etapas del pipeline)
    -- =========================================================================

    -- 7a. María González — agendada (paciente principal de prueba)
    INSERT INTO clinicas.contacts (company_id, phone, name, status, temperature, notes)
    VALUES (v_company_id, '5571100000002', 'María González', 'agendado', 'caliente',
            'Paciente de prueba principal. Interesada en Botox Facial.')
    ON CONFLICT (company_id, phone) DO UPDATE SET status = 'agendado', temperature = 'caliente'
    RETURNING id INTO v_c_maria;

    IF v_c_maria IS NULL THEN
        SELECT id INTO v_c_maria FROM clinicas.contacts WHERE company_id = v_company_id AND phone = '5571100000002';
    END IF;

    -- 7b. Carlos Mendoza — confirmado (cita en 23h para test de recordatorio)
    INSERT INTO clinicas.contacts (company_id, phone, name, status, temperature, notes)
    VALUES (v_company_id, '5491133330004', 'Carlos Mendoza', 'agendado', 'caliente',
            'Lead para test de recordatorio 24h.')
    ON CONFLICT (company_id, phone) DO NOTHING
    RETURNING id INTO v_c_carlos;

    IF v_c_carlos IS NULL THEN
        SELECT id INTO v_c_carlos FROM clinicas.contacts WHERE company_id = v_company_id AND phone = '5491133330004';
    END IF;

    -- 7c. Andrea Martínez — paciente (cita completada hace 3 días)
    INSERT INTO clinicas.contacts (company_id, phone, name, status, temperature, notes)
    VALUES (v_company_id, '5491133330003', 'Andrea Martínez', 'paciente', 'caliente',
            'Paciente recurrente. Tuvo cita completada hace 3 días. Follow-ups activos.')
    ON CONFLICT (company_id, phone) DO NOTHING
    RETURNING id INTO v_c_andrea;

    IF v_c_andrea IS NULL THEN
        SELECT id INTO v_c_andrea FROM clinicas.contacts WHERE company_id = v_company_id AND phone = '5491133330003';
    END IF;

    -- 7d. Luis Herrera — prospecto frío
    INSERT INTO clinicas.contacts (company_id, phone, name, status, temperature, notes)
    VALUES (v_company_id, '5491133330001', 'Luis Herrera', 'prospecto', 'frio',
            'Preguntó por precios vía Instagram. Sin respuesta desde hace 5 días.')
    ON CONFLICT (company_id, phone) DO NOTHING;

    -- 7e. Sofía Torres — calificada pendiente de agendar
    INSERT INTO clinicas.contacts (company_id, phone, name, status, temperature, notes)
    VALUES (v_company_id, '5491133330002', 'Sofía Torres', 'calificado', 'tibio',
            'Calificada. Tiene presupuesto. Pendiente de agendar hidrolipoclasia.')
    ON CONFLICT (company_id, phone) DO NOTHING
    RETURNING id INTO v_c_sofia;

    IF v_c_sofia IS NULL THEN
        SELECT id INTO v_c_sofia FROM clinicas.contacts WHERE company_id = v_company_id AND phone = '5491133330002';
    END IF;

    -- =========================================================================
    -- 8. CITAS
    -- =========================================================================

    v_manana    := (current_date + '1 day'::interval + '15 hours'::interval)::timestamptz; -- 10am CO
    v_in23h     := now() + '23 hours'::interval;
    v_3days_ago := now() - '3 days'::interval;
    v_7days_ago := now() - '7 days'::interval;

    -- 8a. Cita de María González mañana a las 10am (scheduled)
    INSERT INTO clinicas.appointments (
        company_id, contact_id, staff_id, treatment_id,
        scheduled_at, status, notes
    ) VALUES (
        v_company_id, v_c_maria, v_staff1_id, v_t_botox,
        v_manana, 'scheduled',
        'Cita de prueba — Botox facial. Primera vez.'
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_appt_manana;

    -- 8b. Cita de Carlos Mendoza en 23h (confirmed) — para test de recordatorio
    INSERT INTO clinicas.appointments (
        company_id, contact_id, staff_id, treatment_id,
        scheduled_at, status, notes, reminder_24h_sent_at
    ) VALUES (
        v_company_id, v_c_carlos, v_staff1_id, v_t_relleno,
        v_in23h, 'confirmed',
        'Cita de relleno de labios en 23h — para test de recordatorio.',
        NULL   -- NULL = aún no se envió recordatorio
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_appt_23h;

    -- 8c. Cita de Andrea Martínez — completada hace 3 días
    INSERT INTO clinicas.appointments (
        company_id, contact_id, staff_id, treatment_id,
        scheduled_at, completed_at, status, notes
    ) VALUES (
        v_company_id, v_c_andrea, v_staff2_id, v_t_limpieza,
        v_3days_ago, v_3days_ago, 'completed',
        'Limpieza facial completada. Excelente respuesta al peeling enzimático.'
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_appt_completed;

    IF v_appt_completed IS NULL THEN
        SELECT id INTO v_appt_completed FROM clinicas.appointments
        WHERE company_id = v_company_id AND contact_id = v_c_andrea AND status = 'completed'
        LIMIT 1;
    END IF;

    -- 8d. Cita de Andrea — no-show hace 7 días
    INSERT INTO clinicas.appointments (
        company_id, contact_id, staff_id, treatment_id,
        scheduled_at, status, notes
    ) VALUES (
        v_company_id, v_c_andrea, v_staff1_id, v_t_botox,
        v_7days_ago, 'no_show',
        'No se presentó a la cita. Se intentó contactar 2 veces.'
    )
    ON CONFLICT DO NOTHING;

    -- =========================================================================
    -- 9. FOLLOW-UPS para la cita completada
    -- =========================================================================

    IF v_appt_completed IS NOT NULL THEN
        -- Satisfaction check 3 días (ya vencido → pendiente de envío)
        INSERT INTO clinicas.follow_ups (
            company_id, contact_id, appointment_id, type, scheduled_at, status
        ) VALUES (
            v_company_id, v_c_andrea, v_appt_completed,
            'satisfaction_3d', now(), 'pending'
        )
        ON CONFLICT DO NOTHING;

        -- Results check 7 días (en 4 días)
        INSERT INTO clinicas.follow_ups (
            company_id, contact_id, appointment_id, type, scheduled_at, status
        ) VALUES (
            v_company_id, v_c_andrea, v_appt_completed,
            'results_7d', now() + '4 days'::interval, 'pending'
        )
        ON CONFLICT DO NOTHING;

        -- Review request 30 días (en 27 días)
        INSERT INTO clinicas.follow_ups (
            company_id, contact_id, appointment_id, type, scheduled_at, status
        ) VALUES (
            v_company_id, v_c_andrea, v_appt_completed,
            'review_request_30d', now() + '27 days'::interval, 'pending'
        )
        ON CONFLICT DO NOTHING;
    END IF;

    -- =========================================================================
    -- 10. CONVERSACIÓN ESCALADA (para test de getDailySummary)
    -- =========================================================================

    IF v_c_sofia IS NOT NULL THEN
        INSERT INTO clinicas.conversations (
            company_id, contact_id, agent_id, channel, status,
            pipeline_phase, escalation_reason, escalated_at
        ) VALUES (
            v_company_id, v_c_sofia, v_agent_id, 'whatsapp', 'escalated',
            2,
            'La paciente solicitó hablar con una persona del equipo para discutir el plan de tratamiento personalizado de hidrolipoclasia.',
            now() - '2 hours'::interval
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_conv_escalada;

        -- Mensajes de ejemplo en la conversación escalada
        IF v_conv_escalada IS NOT NULL THEN
            INSERT INTO clinicas.messages (company_id, conversation_id, role, content)
            VALUES
                (v_company_id, v_conv_escalada, 'contact',
                 'Hola! Me interesa la hidrolipoclasia, tengo presupuesto disponible.'),
                (v_company_id, v_conv_escalada, 'agent',
                 '¡Hola Sofía! ✨ Qué bueno que te interesa la hidrolipoclasia. ¿Podrías contarme sobre las zonas que te gustaría tratar?'),
                (v_company_id, v_conv_escalada, 'contact',
                 'Abdomen y flancos principalmente. Quiero hablar con alguien del equipo para que me expliquen el protocolo completo.'),
                (v_company_id, v_conv_escalada, 'agent',
                 'Por supuesto Sofía 🤍 Te voy a conectar con nuestra especialista Dra. Laura Rodríguez. Ella se comunicará contigo en breve.'),
                (v_company_id, v_conv_escalada, 'system',
                 '[Conversación escalada: paciente solicita atención personalizada por tratamiento corporal]')
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    RAISE NOTICE '✅ Seed completado para company_id: %', v_company_id;
    RAISE NOTICE '   Empresa:       Clínica Bella (TEST)';
    RAISE NOTICE '   Agente:        Valentina (id: %)', v_agent_id;
    RAISE NOTICE '   Tratamientos:  5 (botox, relleno, limpieza, hidrolipo, láser)';
    RAISE NOTICE '   Staff:         Dr. Martín García + Dra. Laura Rodríguez';
    RAISE NOTICE '   Contactos:     5 (maría, carlos, andrea, luis, sofía)';
    RAISE NOTICE '   Citas:         mañana + en 23h + completada hace 3 días + no-show';
    RAISE NOTICE '   Follow-ups:    3 (1 pendiente HOY, 2 futuros)';
    RAISE NOTICE '   Escalaciones:  1 conversación escalada';
    RAISE NOTICE '';
    RAISE NOTICE '⚡ Siguiente paso: POST /internal/rebuild-prompt/% para compilar el prompt', v_company_id;

END $$;

-- =============================================================================
-- VERIFICACIÓN: consultas útiles post-seed
-- =============================================================================

-- Descomentar para verificar manualmente:

-- SELECT 'companies' as tabla, count(*) FROM clinicas.companies WHERE slug = 'clinica-test-local'
-- UNION ALL SELECT 'agents', count(*) FROM clinicas.agents WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
-- UNION ALL SELECT 'treatments', count(*) FROM clinicas.treatments WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
-- UNION ALL SELECT 'staff', count(*) FROM clinicas.staff WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
-- UNION ALL SELECT 'contacts', count(*) FROM clinicas.contacts WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
-- UNION ALL SELECT 'appointments', count(*) FROM clinicas.appointments WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
-- UNION ALL SELECT 'follow_ups', count(*) FROM clinicas.follow_ups WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
-- UNION ALL SELECT 'slots_libres', count(*) FROM clinicas.availability_slots WHERE company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local') AND is_booked = false;

-- Citas pendientes de recordatorio 24h (debería incluir la de Carlos Mendoza):
-- SELECT a.id, c.name, c.phone, a.scheduled_at, a.status, a.reminder_24h_sent_at
-- FROM clinicas.appointments a
-- JOIN clinicas.contacts c ON c.id = a.contact_id
-- WHERE a.company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
--   AND a.status IN ('scheduled', 'confirmed')
--   AND a.reminder_24h_sent_at IS NULL
--   AND a.scheduled_at BETWEEN now() AND now() + interval '24 hours';

-- Follow-ups vencidos (debería incluir satisfaction_3d de Andrea):
-- SELECT f.id, f.type, f.scheduled_at, f.status, c.name
-- FROM clinicas.follow_ups f
-- JOIN clinicas.contacts c ON c.id = f.contact_id
-- WHERE f.company_id = (SELECT id FROM clinicas.companies WHERE slug = 'clinica-test-local')
--   AND f.status = 'pending'
--   AND f.scheduled_at <= now();
