/**
 * seed.ts — Inserta datos de prueba en Supabase para testing local.
 *
 * Es idempotente: si los datos ya existen, no falla ni duplica.
 * Ejecutar una sola vez antes del primer test:
 *
 *   npm run test:seed
 *
 * Datos que genera:
 *   - 1 empresa (tenant)
 *   - 1 canal WhatsApp
 *   - 1 agente IA (Valentina)
 *   - 5 tratamientos (facial, corporal, capilar)
 *   - 2 staff (médico + asesora)
 *   - 16+ availability slots (próximos 7 días laborales)
 *   - 5 contactos en diferentes etapas del pipeline
 *   - 3 citas (mañana, próxima semana, y completada hace 3 días)
 *   - follow_ups pendientes para la cita completada
 *   - 1 conversación escalada (para prueba de resumen diario)
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
dotenv.config();

import { PromptRebuildService } from '../../src/services/prompt-rebuild.service';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);

const db = () => (supabase as any).schema('clinicas');

const SYSTEM_PROMPT_PLACEHOLDER = '(pendiente de compilación — se sobrescribe al final del seed)';

// ── Teléfonos extra de prueba ───────────────────────────────────────────────
// No modificar: están alineados con los escenarios de test.
const EXTRA_PHONES = {
    prospectoFrio:   '5491133330001',
    calificado:      '5491133330002',
    pacienteViejo:   '5491133330003',
    recordatorio24h: '5491133330004',  // tendrá cita en ~23h (test de reminder)
    staff2:          '5491133330005',  // segunda doctora
};

// ── Fechas de referencia ────────────────────────────────────────────────────
function hoursFromNow(h: number): Date {
    return new Date(Date.now() + h * 3_600_000);
}
function daysFromNow(d: number): Date {
    return new Date(Date.now() + d * 86_400_000);
}
function daysAgo(d: number): Date {
    return new Date(Date.now() - d * 86_400_000);
}

async function seed() {
    console.log('Iniciando seed de datos de prueba...\n');

    // ── 1. Empresa (tenant) ──────────────────────────────────────────────────
    let { data: company, error: companyFetchError } = await db()
        .from('companies')
        .select('id, name')
        .eq('slug', TEST_CONFIG.SEED_COMPANY_SLUG)
        .maybeSingle();

    if (companyFetchError) throw new Error(`Error buscando company: ${companyFetchError.message}`);

    if (!company) {
        const { data: newCompany, error } = await db()
            .from('companies')
            .insert([{
                name: 'Clínica Bella (TEST)',
                slug: TEST_CONFIG.SEED_COMPANY_SLUG,
                plan: 'pro',
                timezone: 'America/Bogota',
                currency: 'USD',
                country_code: 'CO',
                city: 'Bogotá',
                address: 'Calle 72 # 10-43, Piso 3',
                schedule: [
                    { days: ['lun', 'mar', 'mie', 'jue', 'vie'], open: '09:00', close: '19:00' },
                    { days: ['sab'], open: '09:00', close: '14:00' },
                ],
                active: true,
                kind: 'tenant',
            }])
            .select('id, name')
            .single();

        if (error) throw new Error(`Error creando company: ${error.message}`);
        company = newCompany;
        console.log(`✓ Empresa creada: ${company.name} (${company.id})`);
    } else {
        console.log(`✓ Empresa existente: ${company.name} (${company.id})`);
    }

    // ── 2. Canal WhatsApp ────────────────────────────────────────────────────
    const { error: channelError } = await db()
        .from('channels')
        .upsert(
            [{
                company_id: company.id,
                provider: 'whatsapp',
                provider_id: TEST_CONFIG.PHONE_NUMBER_ID,
                display_name: `Test Channel (${TEST_CONFIG.PHONE_NUMBER_ID})`,
                active: true,
            }],
            { onConflict: 'provider,provider_id' }
        );

    if (channelError) throw new Error(`Error creando channel: ${channelError.message}`);
    console.log(`✓ Canal WhatsApp: provider_id="${TEST_CONFIG.PHONE_NUMBER_ID}"`);

    // ── 3. Agente IA ─────────────────────────────────────────────────────────
    let { data: agent } = await db()
        .from('agents')
        .select('id, name')
        .eq('company_id', company.id)
        .eq('active', true)
        .maybeSingle();

    if (!agent) {
        const { data: newAgent, error } = await db()
            .from('agents')
            .insert([{
                company_id: company.id,
                name: 'Valentina',
                system_prompt: SYSTEM_PROMPT_PLACEHOLDER,
                tone: 'amigable',
                persona_description: 'Habla con calidez y cercanía. Usa emojis suaves (✨, 🤍, 📅) sin saturar. Es persuasiva pero nunca agresiva ni impaciente.',
                clinic_description: 'Clínica Bella es un centro de medicina estética con 5 años de experiencia en Bogotá, reconocida por sus resultados naturales y un equipo altamente capacitado.',
                booking_instructions: 'Ofrece siempre exactamente 2 opciones de horario. Si el paciente no puede en ninguna, ofrece 2 más. Nunca preguntes "¿cuándo puedes?" de forma abierta.',
                prohibited_topics: ['descuentos no autorizados', 'comparaciones con otras clínicas', 'diagnósticos por foto'],
                qualification_criteria: {
                    excluded_keywords: ['gratis', 'regalo', 'sin costo', 'cortesía'],
                },
                escalation_rules: {
                    trigger_keywords: ['hablar con alguien', 'persona real', 'gerente', 'supervisor'],
                    max_turns_without_intent: 6,
                },
                objections_kb: [
                    {
                        objection: 'Es muy caro',
                        response: 'Entiendo perfectamente. Ofrecemos planes de financiamiento sin interés. ¿Te cuento cómo funciona?',
                    },
                    {
                        objection: 'Lo pienso y te aviso',
                        response: 'Por supuesto, tómate el tiempo que necesites. Para que sepas, los turnos de esta semana se están llenando rápido. ¿Hay alguna duda que pueda resolver ahora?',
                    },
                    {
                        objection: 'Ya lo hice antes y no funcionó',
                        response: 'Entiendo tu escepticismo. En nuestra clínica el tratamiento se personaliza para cada paciente. ¿Te cuento cómo lo hacemos diferente?',
                    },
                ],
                active: true,
            }])
            .select('id, name')
            .single();

        if (error) throw new Error(`Error creando agente: ${error.message}`);
        agent = newAgent;
        console.log(`✓ Agente creado: ${agent.name} (${agent.id})`);
    } else {
        console.log(`✓ Agente existente: ${agent.name} (${agent.id})`);
    }

    // ── 4. Tratamientos ──────────────────────────────────────────────────────
    const { count: treatCount } = await db()
        .from('treatments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id);

    let treatments: Record<string, any> = {};

    if (!treatCount || treatCount === 0) {
        const treatmentRows = [
            {
                company_id: company.id,
                name: 'Botox Facial',
                description: 'Tratamiento con toxina botulínica para reducir arrugas de expresión en frente, entrecejo y patas de gallo.',
                price_min: 150,
                price_max: 300,
                duration_min: 30,
                category: 'facial',
                contraindications: 'Embarazo, lactancia, enfermedades autoinmunes activas, alergia a la toxina botulínica.',
                preparation_instructions: 'No consumir alcohol 24h antes. Evitar antiinflamatorios (ibuprofeno, aspirina) 3 días antes. Venir sin maquillaje.',
                post_care_instructions: 'No acostarse durante 4 horas. Evitar ejercicio intenso el día del tratamiento. No frotar la zona tratada.',
                followup_days: [3, 7, 30],
                active: true,
            },
            {
                company_id: company.id,
                name: 'Relleno de Labios',
                description: 'Ácido hialurónico para volumizar y definir el contorno labial con resultados naturales.',
                price_min: 200,
                price_max: 350,
                duration_min: 45,
                category: 'facial',
                contraindications: 'Herpes labial activo, embarazo, alergia al ácido hialurónico.',
                preparation_instructions: 'Hidratarse bien el día anterior. Si tienes historial de herpes labial, consulta antes para profilaxis.',
                post_care_instructions: 'Evitar besos y presión en los labios por 24h. No exponerse al sol directo por 48h. Hidratación constante.',
                followup_days: [3, 7, 30],
                active: true,
            },
            {
                company_id: company.id,
                name: 'Limpieza Facial Profunda',
                description: 'Limpieza profunda con extracción de comedones, peeling enzimático y tratamiento hidratante.',
                price_min: 80,
                price_max: 120,
                duration_min: 60,
                category: 'facial',
                preparation_instructions: 'Venir sin maquillaje. No realizarse ningún otro tratamiento facial la misma semana.',
                post_care_instructions: 'Usar protector solar FPS 50 todos los días. Evitar maquillaje las primeras 12h. Hidratación abundante.',
                followup_days: [7],
                active: true,
            },
            {
                company_id: company.id,
                name: 'Hidrolipoclasia Ultrasónica',
                description: 'Tratamiento corporal para reducción de grasa localizada en abdomen, flancos y muslos mediante ultrasonido.',
                price_min: 180,
                price_max: 280,
                duration_min: 60,
                category: 'corporal',
                contraindications: 'Embarazo, marcapasos, implantes metálicos en la zona, diabetes no controlada.',
                preparation_instructions: 'Beber 2 litros de agua el día anterior y el día del tratamiento. No comer 2 horas antes. Venir con ropa cómoda.',
                post_care_instructions: 'Tomar mucha agua los siguientes 3 días. Evitar alcohol 48h. Realizar caminata de 30 min post-tratamiento.',
                followup_days: [7, 30],
                active: true,
            },
            {
                company_id: company.id,
                name: 'Depilación Láser Diodo',
                description: 'Depilación definitiva con láser de diodo 808nm. Efectiva en todos los fototipos de piel.',
                price_min: 60,
                price_max: 200,
                duration_min: 45,
                category: 'capilar',
                contraindications: 'Embarazo, epilepsia fotosensible, piel bronceada reciente, tratamiento con isotretinoína.',
                preparation_instructions: 'Afeitar la zona a tratar 24-48h antes. No depilarse con cera ni hacer epilación 4 semanas antes. Evitar exposición solar 2 semanas antes.',
                post_care_instructions: 'Aplicar calmante (aloe vera) en la zona. Evitar sol directo 2 semanas. No sauna ni piscina por 48h.',
                followup_days: [30],
                active: true,
            },
        ];

        const { data: insertedTreatments, error } = await db()
            .from('treatments')
            .insert(treatmentRows)
            .select('id, name, category');

        if (error) throw new Error(`Error creando tratamientos: ${error.message}`);
        console.log(`✓ Tratamientos creados: ${treatmentRows.length} (facial, corporal, capilar)`);

        for (const t of (insertedTreatments as any[])) {
            treatments[t.name] = t;
        }
    } else {
        const { data: existingTreatments } = await db()
            .from('treatments')
            .select('id, name, category')
            .eq('company_id', company.id);
        for (const t of (existingTreatments as any[]) || []) {
            treatments[t.name] = t;
        }
        console.log(`✓ Tratamientos: ${treatCount} ya existente(s), no se insertaron.`);
    }

    // ── 5a. Staff principal (activa pipeline de admin) ───────────────────────
    let { data: staff } = await db()
        .from('staff')
        .select('id, name, phone')
        .eq('company_id', company.id)
        .eq('phone', TEST_CONFIG.TEST_ADMIN_PHONE)
        .maybeSingle();

    if (!staff) {
        const { data: newStaff, error } = await db()
            .from('staff')
            .insert([{
                company_id: company.id,
                name: TEST_CONFIG.TEST_ADMIN_NAME,
                role: 'Médico Estético',
                specialty: 'Botox y Rellenos',
                phone: TEST_CONFIG.TEST_ADMIN_PHONE,
                max_daily_appointments: 8,
                active: true,
                staff_role: 'owner',
            }])
            .select('id, name, phone')
            .single();

        if (error) throw new Error(`Error creando staff: ${error.message}`);
        staff = newStaff;
        console.log(`✓ Staff principal creado: ${staff.name} (${staff.id})`);
    } else {
        console.log(`✓ Staff principal existente: ${staff.name} (${staff.id})`);
    }

    // ── 5b. Segunda doctora (asesora comercial) ──────────────────────────────
    let { data: staff2 } = await db()
        .from('staff')
        .select('id, name, phone')
        .eq('company_id', company.id)
        .eq('phone', EXTRA_PHONES.staff2)
        .maybeSingle();

    if (!staff2) {
        const { data: newStaff2, error } = await db()
            .from('staff')
            .insert([{
                company_id: company.id,
                name: 'Dra. Laura Rodríguez',
                role: 'Médico Estético',
                specialty: 'Tratamientos Corporales y Láser',
                phone: EXTRA_PHONES.staff2,
                email: 'laura@clinicabella.test',
                max_daily_appointments: 6,
                active: true,
                staff_role: 'staff',
            }])
            .select('id, name, phone')
            .single();

        if (error) throw new Error(`Error creando staff2: ${error.message}`);
        staff2 = newStaff2;
        console.log(`✓ Staff secundario creado: ${staff2.name} (${staff2.id})`);
    } else {
        console.log(`✓ Staff secundario existente: ${staff2.name} (${staff2.id})`);
    }

    // Roles funcionales (sql/add_bruno_onboarding_fields.sql): owner único + staff.
    const { error: staffRoleErr } = await db()
        .from('staff')
        .update({ staff_role: 'owner' })
        .eq('id', staff.id);
    if (staffRoleErr) throw new Error(`Error actualizando staff_role (principal): ${staffRoleErr.message}`);
    const { error: staff2RoleErr } = await db()
        .from('staff')
        .update({ staff_role: 'staff' })
        .eq('id', staff2.id);
    if (staff2RoleErr) throw new Error(`Error actualizando staff_role (secundario): ${staff2RoleErr.message}`);

    // ── 6. Availability slots ────────────────────────────────────────────────
    const { count: slotCount } = await db()
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('is_booked', false);

    if (!slotCount || slotCount === 0) {
        const slots = [
            ...generateFutureSlots(company.id, staff.id, 8),
            ...generateFutureSlots(company.id, staff2.id, 8),
        ];
        const { error } = await db()
            .from('availability_slots')
            .insert(slots);

        if (error) throw new Error(`Error creando slots: ${error.message}`);
        console.log(`✓ Availability slots creados: ${slots.length} (${staff.name} + ${staff2.name})`);
    } else {
        console.log(`✓ Availability slots: ${slotCount} ya existentes.`);
    }

    // ── 7. Paciente principal con cita mañana ────────────────────────────────
    let { data: patient } = await db()
        .from('contacts')
        .select('id, name, phone')
        .eq('company_id', company.id)
        .eq('phone', TEST_CONFIG.TEST_PATIENT_PHONE)
        .maybeSingle();

    if (!patient) {
        const { data: newPatient, error } = await db()
            .from('contacts')
            .insert([{
                company_id: company.id,
                name: TEST_CONFIG.TEST_PATIENT_NAME,
                phone: TEST_CONFIG.TEST_PATIENT_PHONE,
                status: 'agendado',
                temperature: 'caliente',
                notes: 'Paciente de prueba principal. Interesada en Botox Facial.',
            }])
            .select('id, name, phone')
            .single();

        if (error) throw new Error(`Error creando paciente: ${error.message}`);
        patient = newPatient;
        console.log(`✓ Paciente principal creado: ${patient.name}`);
    } else {
        console.log(`✓ Paciente principal existente: ${patient.name}`);
    }

    // ── 8a. Cita mañana 10:00 AM (Colombia = UTC-5 = 15:00 UTC) ─────────────
    const { count: apptCount } = await db()
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('contact_id', patient.id)
        .in('status', ['scheduled', 'confirmed']);

    if (!apptCount || apptCount === 0) {
        const tomorrow = daysFromNow(1);
        tomorrow.setUTCHours(15, 0, 0, 0);

        const treatmentId = treatments['Botox Facial']?.id ?? null;

        const { error } = await db()
            .from('appointments')
            .insert([{
                company_id: company.id,
                contact_id: patient.id,
                staff_id: staff.id,
                treatment_id: treatmentId,
                scheduled_at: tomorrow.toISOString(),
                status: 'scheduled',
                notes: 'Cita de prueba — Botox facial. Primera vez.',
            }]);

        if (error) throw new Error(`Error creando cita principal: ${error.message}`);
        console.log(`✓ Cita mañana creada para ${patient.name} — 10:00 AM Colombia`);
    } else {
        console.log(`✓ Cita de mañana existente para ${patient.name}.`);
    }

    // ── 8b. Contacto con cita en ~23h (test de recordatorio 24h) ────────────
    let { data: contactReminder } = await db()
        .from('contacts')
        .select('id, name')
        .eq('company_id', company.id)
        .eq('phone', EXTRA_PHONES.recordatorio24h)
        .maybeSingle();

    if (!contactReminder) {
        const { data: c, error } = await db()
            .from('contacts')
            .insert([{
                company_id: company.id,
                name: 'Carlos Mendoza',
                phone: EXTRA_PHONES.recordatorio24h,
                status: 'agendado',
                temperature: 'caliente',
                notes: 'Lead calificado para test de recordatorio 24h.',
            }])
            .select('id, name')
            .single();
        if (error) throw new Error(`Error creando contacto reminder: ${error.message}`);
        contactReminder = c;
    }

    const { count: reminderApptCount } = await db()
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('contact_id', contactReminder.id)
        .is('reminder_24h_sent_at', null)
        .in('status', ['scheduled', 'confirmed']);

    if (!reminderApptCount || reminderApptCount === 0) {
        // Cita en 23 horas (dentro de la ventana de recordatorio de 24h)
        const in23h = hoursFromNow(23);
        const treatmentId = treatments['Relleno de Labios']?.id ?? null;

        const { error } = await db()
            .from('appointments')
            .insert([{
                company_id: company.id,
                contact_id: contactReminder.id,
                staff_id: staff.id,
                treatment_id: treatmentId,
                scheduled_at: in23h.toISOString(),
                status: 'confirmed',
                notes: 'Cita dentro de 23h — para test de recordatorio 24h.',
                reminder_24h_sent_at: null,
            }]);
        if (error) throw new Error(`Error creando cita de recordatorio: ${error.message}`);
        console.log(`✓ Cita en 23h creada para ${contactReminder.name} (test recordatorio)`);
    } else {
        console.log(`✓ Cita de recordatorio ya existente para ${contactReminder.name}.`);
    }

    // ── 8c. Cita completada hace 3 días + follow-ups ─────────────────────────
    let { data: patientViejo } = await db()
        .from('contacts')
        .select('id, name')
        .eq('company_id', company.id)
        .eq('phone', EXTRA_PHONES.pacienteViejo)
        .maybeSingle();

    if (!patientViejo) {
        const { data: c, error } = await db()
            .from('contacts')
            .insert([{
                company_id: company.id,
                name: 'Andrea Martínez',
                phone: EXTRA_PHONES.pacienteViejo,
                status: 'paciente',
                temperature: 'caliente',
                notes: 'Paciente recurrente. Tuvo cita completada hace 3 días.',
            }])
            .select('id, name')
            .single();
        if (error) throw new Error(`Error creando paciente viejo: ${error.message}`);
        patientViejo = c;
    }

    let completedApptId: string | null = null;

    const { data: existingCompleted } = await db()
        .from('appointments')
        .select('id')
        .eq('company_id', company.id)
        .eq('contact_id', patientViejo.id)
        .eq('status', 'completed')
        .maybeSingle();

    if (!existingCompleted) {
        const threeDaysAgo = daysAgo(3);
        threeDaysAgo.setUTCHours(14, 0, 0, 0);
        const treatmentId = treatments['Limpieza Facial Profunda']?.id ?? null;

        const { data: completedAppt, error } = await db()
            .from('appointments')
            .insert([{
                company_id: company.id,
                contact_id: patientViejo.id,
                staff_id: staff2.id,
                treatment_id: treatmentId,
                scheduled_at: threeDaysAgo.toISOString(),
                status: 'completed',
                completed_at: threeDaysAgo.toISOString(),
                notes: 'Limpieza facial completada. Excelente respuesta al peeling enzimático.',
            }])
            .select('id')
            .single();

        if (error) throw new Error(`Error creando cita completada: ${error.message}`);
        completedApptId = (completedAppt as any).id;
        console.log(`✓ Cita completada hace 3 días creada para ${patientViejo.name}`);
    } else {
        completedApptId = (existingCompleted as any).id;
        console.log(`✓ Cita completada ya existente para ${patientViejo.name}.`);
    }

    // ── 9. Follow-ups para la cita completada ────────────────────────────────
    const { count: followUpCount } = await db()
        .from('follow_ups')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('appointment_id', completedApptId);

    if ((!followUpCount || followUpCount === 0) && completedApptId) {
        const now = new Date();
        // Follow-up de satisfacción 3 días: ya debería haberse enviado (pasado)
        const followUp3d = daysAgo(0); // ahora mismo = pendiente de enviar

        const followUps = [
            {
                company_id: company.id,
                contact_id: patientViejo.id,
                appointment_id: completedApptId,
                type: 'satisfaction_3d',
                scheduled_at: followUp3d.toISOString(),
                status: 'pending',
            },
            {
                company_id: company.id,
                contact_id: patientViejo.id,
                appointment_id: completedApptId,
                type: 'results_7d',
                scheduled_at: daysFromNow(4).toISOString(), // en 4 días
                status: 'pending',
            },
            {
                company_id: company.id,
                contact_id: patientViejo.id,
                appointment_id: completedApptId,
                type: 'review_request_30d',
                scheduled_at: daysFromNow(27).toISOString(), // en 27 días
                status: 'pending',
            },
        ];

        const { error } = await db()
            .from('follow_ups')
            .insert(followUps);

        if (error) throw new Error(`Error creando follow-ups: ${error.message}`);
        console.log(`✓ Follow-ups creados para ${patientViejo.name} (3d pendiente, 7d, 30d)`);
    } else {
        console.log(`✓ Follow-ups ya existentes para ${patientViejo.name}.`);
    }

    // ── 8d. Cita no-show hace 7 días ─────────────────────────────────────────
    const { count: noShowCount } = await db()
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('contact_id', patientViejo.id)
        .eq('status', 'no_show');

    if (!noShowCount || noShowCount === 0) {
        const sevenDaysAgo = daysAgo(7);
        sevenDaysAgo.setUTCHours(16, 0, 0, 0);
        const treatmentId = treatments['Botox Facial']?.id ?? null;

        const { error } = await db()
            .from('appointments')
            .insert([{
                company_id: company.id,
                contact_id: patientViejo.id,
                staff_id: staff.id,
                treatment_id: treatmentId,
                scheduled_at: sevenDaysAgo.toISOString(),
                status: 'no_show',
                notes: 'No se presentó a la cita. Se intentó contactar 2 veces.',
            }]);

        if (error) throw new Error(`Error creando cita no_show: ${error.message}`);
        console.log(`✓ Cita no-show hace 7 días creada para ${patientViejo.name}`);
    }

    // ── 10. Contactos adicionales en diferentes etapas del pipeline ──────────
    const extraContacts = [
        {
            phone: EXTRA_PHONES.prospectoFrio,
            name: 'Luis Herrera',
            status: 'prospecto',
            temperature: 'frio',
            notes: 'Preguntó por precios vía Instagram. Sin respuesta desde hace 5 días.',
        },
        {
            phone: EXTRA_PHONES.calificado,
            name: 'Sofía Torres',
            status: 'calificado',
            temperature: 'tibio',
            notes: 'Calificada. Tiene presupuesto. Pendiente de agendar cita de hidrolipoclasia.',
        },
    ];

    for (const contactData of extraContacts) {
        const { data: existing } = await db()
            .from('contacts')
            .select('id')
            .eq('company_id', company.id)
            .eq('phone', contactData.phone)
            .maybeSingle();

        if (!existing) {
            const { error } = await db()
                .from('contacts')
                .insert([{ company_id: company.id, ...contactData }]);
            if (error) throw new Error(`Error creando contacto ${contactData.name}: ${error.message}`);
            console.log(`✓ Contacto creado: ${contactData.name} (${contactData.status})`);
        } else {
            console.log(`✓ Contacto existente: ${contactData.name}`);
        }
    }

    // ── 11. Conversación escalada (para test de resumen diario) ──────────────
    // Buscamos o creamos el contacto calificado y le generamos una conversación escalada.
    const { data: contactCalificado } = await db()
        .from('contacts')
        .select('id, name')
        .eq('company_id', company.id)
        .eq('phone', EXTRA_PHONES.calificado)
        .maybeSingle();

    if (contactCalificado) {
        const { data: existingEscalation } = await db()
            .from('conversations')
            .select('id')
            .eq('company_id', company.id)
            .eq('contact_id', (contactCalificado as any).id)
            .eq('status', 'escalated')
            .maybeSingle();

        if (!existingEscalation) {
            const { data: conv, error: convErr } = await db()
                .from('conversations')
                .insert([{
                    company_id: company.id,
                    contact_id: (contactCalificado as any).id,
                    agent_id: agent.id,
                    channel: 'whatsapp',
                    status: 'escalated',
                    pipeline_phase: 2,
                    escalation_reason: 'La paciente solicitó hablar con una persona del equipo para discutir el plan de tratamiento personalizado.',
                    escalated_at: hoursFromNow(-2).toISOString(),
                }])
                .select('id')
                .single();

            if (!convErr && conv) {
                // Insertar algunos mensajes de ejemplo en la conversación
                await db()
                    .from('messages')
                    .insert([
                        {
                            company_id: company.id,
                            conversation_id: (conv as any).id,
                            role: 'contact',
                            content: 'Hola! Me interesa la hidrolipoclasia, tengo presupuesto disponible.',
                        },
                        {
                            company_id: company.id,
                            conversation_id: (conv as any).id,
                            role: 'agent',
                            content: '¡Hola Sofía! ✨ Qué bueno que te interesa la hidrolipoclasia. Es un tratamiento excelente para reducción de medidas. ¿Podrías contarme un poco más sobre las zonas que te gustaría tratar?',
                        },
                        {
                            company_id: company.id,
                            conversation_id: (conv as any).id,
                            role: 'contact',
                            content: 'Abdomen y flancos principalmente. Quiero hablar con alguien del equipo para que me expliquen el protocolo completo.',
                        },
                        {
                            company_id: company.id,
                            conversation_id: (conv as any).id,
                            role: 'agent',
                            content: 'Por supuesto Sofía 🤍 Te voy a conectar con nuestra especialista Dra. Laura Rodríguez quien se encarga de los tratamientos corporales. Ella se comunicará contigo en breve.',
                        },
                        {
                            company_id: company.id,
                            conversation_id: (conv as any).id,
                            role: 'system',
                            content: '[Conversación escalada: paciente solicita atención personalizada por tratamiento corporal]',
                        },
                    ]);

                console.log(`✓ Conversación escalada creada para ${(contactCalificado as any).name}`);
            }
        } else {
            console.log(`✓ Conversación escalada ya existente.`);
        }
    }

    // ── 12. Compilar system_prompt ───────────────────────────────────────────
    console.log('\nCompilando system_prompt desde datos de BD...');
    try {
        await PromptRebuildService.rebuildPromptForCompany(company.id);
        console.log('✓ system_prompt compilado y guardado en agents');
    } catch (err: any) {
        console.warn(`⚠ No se pudo compilar el prompt: ${err.message}`);
        console.warn('  El agente usará el placeholder hasta que se ejecute el rebuild.');
    }

    console.log('\n✅ Seed completado exitosamente.');
    console.log('\n📊 Resumen de datos:');
    console.log('  Empresa:       Clínica Bella (TEST)');
    console.log('  Agente:        Valentina');
    console.log('  Tratamientos:  5 (botox, relleno, limpieza, hidrolipo, láser)');
    console.log(`  Staff:         ${staff.name} + ${staff2.name}`);
    console.log('  Contactos:     5 (agendado, agendado/confirmado, completado, prospecto, calificado)');
    console.log('  Citas:         mañana + en 23h (reminder) + completada + no_show');
    console.log('  Follow-ups:    3 (1 pendiente HOY, 2 futuros)');
    console.log('  Escalaciones:  1 conversación escalada');
    console.log('\n🚀 Próximos pasos:');
    console.log('  Terminal 1:  npm run dev');
    console.log('  Terminal 2:  npm run test:chat          — chat interactivo (paciente)');
    console.log('  Terminal 2:  npm run test:scenario      — escenarios automáticos');
    console.log('  Terminal 2:  npm run test:agenda        — escenarios de admin');
    console.log('  Terminal 2:  npm run test:reminders     — test recordatorios/follow-ups');
    console.log('  Terminal 2:  npm run test:rebuild       — test prompt rebuild queue');
}

/**
 * Genera slots de disponibilidad en los próximos 7 días laborales.
 * Horario Colombia (UTC-5): mañana 9-11am, tarde 2-5pm.
 */
function generateFutureSlots(companyId: string, staffId: string, count: number) {
    const slots = [];
    // Mañana: 9am (UTC 14), 10am (UTC 15), 11am (UTC 16)
    // Tarde:  2pm (UTC 19), 3pm (UTC 20), 4pm (UTC 21)
    const morningHoursUTC = [14, 15, 16];
    const afternoonHoursUTC = [19, 20, 21];

    let day = new Date();
    let added = 0;

    while (added < count) {
        day = new Date(day.getTime() + 86_400_000);
        const dow = day.getUTCDay();
        if (dow === 0 || dow === 6) continue; // saltar fines de semana

        const hoursToUse = (added % 2 === 0) ? morningHoursUTC : afternoonHoursUTC;

        for (const h of hoursToUse) {
            const start = new Date(day);
            start.setUTCHours(h, 0, 0, 0);
            const end = new Date(start.getTime() + 45 * 60 * 1000); // 45 min por defecto

            slots.push({
                company_id: companyId,
                staff_id: staffId,
                starts_at: start.toISOString(),
                ends_at: end.toISOString(),
                is_booked: false,
            });
            added++;
            if (added >= count) break;
        }
    }

    return slots;
}

seed().catch(err => {
    console.error('\n❌ Seed falló:', err.message);
    process.exit(1);
});
