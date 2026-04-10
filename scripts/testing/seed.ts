/**
 * seed.ts — Inserta datos de prueba en Supabase para testing local.
 *
 * Es idempotente: si los datos ya existen, no falla ni duplica.
 * Ejecutar una sola vez antes del primer test:
 *
 *   npm run test:seed
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
dotenv.config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);

const db = () => (supabase as any).schema('clinicas');

const SYSTEM_PROMPT = `Eres Valentina, asistente de atención al cliente de Clínica Bella.
Tu objetivo es calificar leads interesados en tratamientos estéticos y ayudarlos a agendar una cita.

TRATAMIENTOS DISPONIBLES:
- Botox facial: desde $150 USD. Duración 30 min. Resultados visibles en 7 días.
- Relleno de labios con ácido hialurónico: desde $200 USD. Duración 45 min.
- Limpieza facial profunda: desde $80 USD. Duración 60 min.
- Peeling químico: desde $120 USD. Duración 45 min.

HORARIOS: Lunes a viernes 9:00 - 19:00, sábados 9:00 - 14:00.

INSTRUCCIONES:
1. Saluda cordialmente y pregunta en qué tratamiento está interesado el cliente.
2. Una vez que conozcas el interés, informa precio y tiempo de recuperación.
3. Invita a agendar con urgencia amable (ej: "tenemos pocos turnos disponibles esta semana").
4. Si el lead pregunta repetidamente sin mostrar intención de agendar, usa la herramienta escalateToHuman.
5. Nunca inventes precios ni tratamientos que no están en la lista de arriba.
6. Mantén un tono amigable y profesional en todo momento.`;

async function seed() {
    console.log('Iniciando seed de datos de prueba...\n');

    // ── 1. Empresa (tenant) ──────────────────────────────────────────────────
    let { data: company, error: companyFetchError } = await db()
        .from('companies')
        .select('id, name')
        .eq('slug', TEST_CONFIG.SEED_COMPANY_SLUG)
        .maybeSingle();

    if (companyFetchError) {
        throw new Error(`Error buscando company: ${companyFetchError.message}`);
    }

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
                active: true,
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
    // UNIQUE (provider, provider_id) — upsert seguro
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
                system_prompt: SYSTEM_PROMPT,
                tone: 'amigable',
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

    // ── 4. Tratamientos de ejemplo ───────────────────────────────────────────
    const { count: treatCount } = await db()
        .from('treatments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id);

    if (!treatCount || treatCount === 0) {
        const { error } = await db()
            .from('treatments')
            .insert([
                {
                    company_id: company.id,
                    name: 'Botox Facial',
                    description: 'Tratamiento con toxina botulínica para reducir arrugas de expresión.',
                    price_min: 150,
                    price_max: 300,
                    duration_min: 30,
                    active: true,
                },
                {
                    company_id: company.id,
                    name: 'Relleno de Labios',
                    description: 'Ácido hialurónico para volumizar y definir el contorno labial.',
                    price_min: 200,
                    price_max: 350,
                    duration_min: 45,
                    active: true,
                },
                {
                    company_id: company.id,
                    name: 'Limpieza Facial Profunda',
                    description: 'Limpieza profunda con extracción y tratamiento hidratante.',
                    price_min: 80,
                    price_max: 120,
                    duration_min: 60,
                    active: true,
                },
            ]);

        if (error) throw new Error(`Error creando tratamientos: ${error.message}`);
        console.log('✓ Tratamientos de ejemplo creados (3)');
    } else {
        console.log(`✓ Tratamientos: ${treatCount} ya existente(s), no se insertaron.`);
    }

    // ── 5. Staff de prueba (activa el pipeline de admin) ────────────────────
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
            }])
            .select('id, name, phone')
            .single();

        if (error) throw new Error(`Error creando staff: ${error.message}`);
        staff = newStaff;
        console.log(`✓ Staff creado: ${staff.name} (${staff.id})`);
    } else {
        console.log(`✓ Staff existente: ${staff.name} (${staff.id})`);
    }

    // ── 6. Availability slots (próximos 5 días laborales) ───────────────────
    const { count: slotCount } = await db()
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('staff_id', staff.id)
        .eq('is_booked', false);

    if (!slotCount || slotCount === 0) {
        const slots = generateFutureSlots(company.id, staff.id);
        const { error } = await db()
            .from('availability_slots')
            .insert(slots);

        if (error) throw new Error(`Error creando slots: ${error.message}`);
        console.log(`✓ Availability slots creados: ${slots.length}`);
    } else {
        console.log(`✓ Availability slots: ${slotCount} ya existentes.`);
    }

    // ── 7. Paciente de prueba con cita agendada ──────────────────────────────
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
            }])
            .select('id, name, phone')
            .single();

        if (error) throw new Error(`Error creando paciente: ${error.message}`);
        patient = newPatient;
        console.log(`✓ Paciente de prueba creado: ${patient.name}`);
    } else {
        console.log(`✓ Paciente de prueba existente: ${patient.name}`);
    }

    // ── 8. Cita agendada para el paciente de prueba ──────────────────────────
    const { count: apptCount } = await db()
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('contact_id', patient.id)
        .in('status', ['scheduled', 'confirmed']);

    if (!apptCount || apptCount === 0) {
        // Cita mañana a las 10:00 AM Colombia (UTC-5 = 15:00 UTC)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setUTCHours(15, 0, 0, 0);
        const tomorrowEnd = new Date(tomorrow.getTime() + 30 * 60 * 1000);

        const { error } = await db()
            .from('appointments')
            .insert([{
                company_id: company.id,
                contact_id: patient.id,
                staff_id: staff.id,
                scheduled_at: tomorrow.toISOString(),
                status: 'scheduled',
                notes: 'Cita de prueba — Botox facial',
            }]);

        if (error) throw new Error(`Error creando cita: ${error.message}`);
        console.log(`✓ Cita de prueba creada para ${patient.name} — ${tomorrow.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' })} 10:00 AM`);
    } else {
        console.log(`✓ Cita de prueba existente para ${patient.name}.`);
    }

    console.log('\n✅ Seed completado exitosamente.');
    console.log('\nPróximos pasos:');
    console.log('  1. En Terminal 1: npm run dev');
    console.log('  2. En Terminal 2: npm run test:chat         (paciente)');
    console.log('  3. En Terminal 2: npm run test:agenda       (admin/agendamiento)');
}

/**
 * Genera 8 slots de disponibilidad distribuidos en los próximos 5 días laborales.
 * Horario Colombia (UTC-5): 9am, 10am, 11am → UTC: 14, 15, 16 horas.
 */
function generateFutureSlots(companyId: string, staffId: string) {
    const slots = [];
    const morningHoursUTC = [14, 15, 16]; // 9am, 10am, 11am Colombia
    const afternoonHoursUTC = [19, 20];   // 2pm, 3pm Colombia

    let day = new Date();
    let slotsAdded = 0;

    while (slotsAdded < 8) {
        day = new Date(day.getTime() + 86_400_000);
        const dow = day.getUTCDay(); // 0=domingo, 6=sábado
        if (dow === 0 || dow === 6) continue; // saltar fines de semana

        const hours = slotsAdded % 2 === 0 ? morningHoursUTC : afternoonHoursUTC;
        for (const h of hours) {
            const start = new Date(day);
            start.setUTCHours(h, 0, 0, 0);
            const end = new Date(start.getTime() + 30 * 60 * 1000);

            slots.push({
                company_id: companyId,
                staff_id: staffId,
                starts_at: start.toISOString(),
                ends_at: end.toISOString(),
                is_booked: false,
            });
            slotsAdded++;
            if (slotsAdded >= 8) break;
        }
    }

    return slots;
}

seed().catch(err => {
    console.error('\n❌ Seed falló:', err.message);
    process.exit(1);
});
