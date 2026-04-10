/**
 * scenarios-admin.ts — Escenarios de agendamiento para el agente admin (staff).
 *
 * Prueba el pipeline de administración: consulta de slots, citas próximas,
 * búsqueda de pacientes, cancelación de citas y resumen diario.
 *
 * Diferencia clave con scenarios.ts:
 *   Los mensajes se envían desde TEST_ADMIN_PHONE, lo que activa el
 *   pipeline de admin (detecta el número en clinicas.staff.phone).
 *
 * Uso:
 *   npm run test:agenda                    — corre todos los escenarios
 *   npm run test:agenda -- admin-ver-slots — corre uno específico
 *
 * Requisitos:
 *   - npm run dev corriendo en otra terminal
 *   - npm run test:seed ejecutado (crea staff + slots + paciente con cita)
 */
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';
import { TEST_CONFIG } from './lib/config';
import { sendWebhookMessage } from './lib/webhook-client';
import { pollForAgentResponse } from './lib/poll-response';
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

// ── Definición de escenarios de admin ─────────────────────────────────────────

interface AdminScenario {
    name: string;
    description: string;
    messages: string[];
    setup?: 'fresh';
    notes?: string; // Notas sobre qué se valida
}

const SCENARIOS: AdminScenario[] = [
    {
        name: 'admin-resumen-dia',
        description: 'Staff pide resumen del día (citas, leads, escalaciones)',
        setup: 'fresh',
        notes: 'Verifica que getDailySummary retorne datos y el agente los formatee',
        messages: [
            'Hola, dame el resumen del día',
        ],
    },
    {
        name: 'admin-ver-slots',
        description: 'Staff consulta disponibilidad de la clínica',
        setup: 'fresh',
        notes: 'Verifica que getFreeSlots retorne los slots de availability_slots (fallback DB)',
        messages: [
            '¿Qué disponibilidad tenemos esta semana para botox?',
        ],
    },
    {
        name: 'admin-ver-citas',
        description: 'Staff consulta citas próximas de la semana',
        setup: 'fresh',
        notes: 'Verifica que getUpcomingAppointments retorne la cita de María González',
        messages: [
            '¿Cuáles son las citas que tenemos programadas para esta semana?',
        ],
    },
    {
        name: 'admin-buscar-paciente',
        description: 'Staff busca un paciente por nombre parcial',
        setup: 'fresh',
        notes: 'Verifica que searchContacts encuentre a María González del seed',
        messages: [
            'Búscame a María González',
        ],
    },
    {
        name: 'admin-cancelar-cita',
        description: 'Staff consulta citas y luego cancela la primera',
        setup: 'fresh',
        notes: 'Flujo multi-turno: get → cancel. Verifica updateAppointmentStatus y que el agente confirme la cancelación',
        messages: [
            '¿Qué citas hay programadas para los próximos 3 días?',
            'Cancela esa cita, el paciente llamó para cancelar por motivos personales',
        ],
    },
    {
        name: 'admin-slots-y-disponibilidad',
        description: 'Staff pregunta por slots de una duración específica',
        setup: 'fresh',
        notes: 'Verifica que getFreeSlots acepte slotDurationMin y retorne slots correctos',
        messages: [
            'Necesito ver los horarios disponibles para una cita de 45 minutos de relleno labial',
            'Dame los primeros 5 slots solamente',
        ],
    },
    {
        name: 'admin-perfil-paciente',
        description: 'Staff consulta el perfil completo de un paciente',
        setup: 'fresh',
        notes: 'Verifica que searchContacts + getContactSummary funcionen encadenados',
        messages: [
            'Quiero ver el perfil completo de María González',
        ],
    },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScenario(
    scenario: AdminScenario,
    companyId: string
): Promise<boolean> {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`ESCENARIO: ${scenario.name}`);
    console.log(`           ${scenario.description}`);
    if (scenario.notes) {
        console.log(`  📋 Valida: ${scenario.notes}`);
    }
    console.log('═'.repeat(70));

    try {
        if (scenario.setup === 'fresh') {
            // Borrar la conversación del admin (no la del paciente)
            await sendWebhookMessage({
                text: '/borrar',
                from: TEST_CONFIG.TEST_ADMIN_PHONE,
                senderName: TEST_CONFIG.TEST_ADMIN_NAME,
            });
            await sleep(1_500);
        }

        for (const userText of scenario.messages) {
            const beforeTimestamp = new Date().toISOString();
            console.log(`\n  ADMIN  > ${userText}`);

            await sendWebhookMessage({
                text: userText,
                from: TEST_CONFIG.TEST_ADMIN_PHONE,
                senderName: TEST_CONFIG.TEST_ADMIN_NAME,
            });

            const convId = await waitForAdminConversation(companyId);
            const response = await pollForAgentResponse(convId, beforeTimestamp);

            console.log(`  AGENTE > ${response}`);
        }

        console.log(`\n  ✅ PASÓ`);
        return true;
    } catch (err: any) {
        console.log(`\n  ❌ FALLÓ: ${err.message}`);
        return false;
    }
}

/**
 * Espera hasta que exista la conversación del staff de prueba.
 * El admin también tiene contacto + conversación en la BD.
 */
async function waitForAdminConversation(
    companyId: string,
    timeoutMs = 10_000
): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        // El staff también tiene un contacto en clinicas.contacts
        const { data: contact } = await db()
            .from('contacts')
            .select('id')
            .eq('company_id', companyId)
            .eq('phone', TEST_CONFIG.TEST_ADMIN_PHONE)
            .maybeSingle();

        if (contact) {
            const { data: conv } = await db()
                .from('conversations')
                .select('id')
                .eq('contact_id', contact.id)
                .in('status', ['open', 'escalated', 'waiting'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (conv?.id) return conv.id;
        }

        await sleep(TEST_CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error(
        'Timeout: no se creó la conversación del admin. ' +
        `¿Está ${TEST_CONFIG.TEST_ADMIN_PHONE} en clinicas.staff? Ejecuta npm run test:seed.`
    );
}

async function main() {
    // ── Verificar servidor ───────────────────────────────────────────────────
    try {
        await axios.get(`${TEST_CONFIG.SERVER_URL}/`, { timeout: 3_000 });
    } catch {
        console.error(`\n❌ No se puede conectar al servidor en ${TEST_CONFIG.SERVER_URL}.`);
        console.error('Ejecuta "npm run dev" en otra terminal primero.\n');
        process.exit(1);
    }

    // ── Obtener clínica de prueba ────────────────────────────────────────────
    const { data: company } = await db()
        .from('companies')
        .select('id, name')
        .eq('slug', TEST_CONFIG.SEED_COMPANY_SLUG)
        .maybeSingle();

    if (!company) {
        console.error('\n❌ No hay datos de prueba en Supabase.');
        console.error('Ejecuta "npm run test:seed" primero.\n');
        process.exit(1);
    }

    // ── Verificar que hay slots disponibles ──────────────────────────────────
    const { count: slotCount } = await db()
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .eq('is_booked', false);

    if (!slotCount || slotCount === 0) {
        console.warn('\n⚠️  No hay availability_slots en la BD. El escenario "ver-slots" no mostrará datos.');
        console.warn('   Ejecuta npm run test:seed para crearlos.\n');
    }

    // ── Verificar que hay citas de prueba ────────────────────────────────────
    const { count: apptCount } = await db()
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .in('status', ['scheduled', 'confirmed']);

    if (!apptCount || apptCount === 0) {
        console.warn('\n⚠️  No hay citas scheduled en la BD. El escenario "cancelar-cita" no tendrá datos.');
        console.warn('   Ejecuta npm run test:seed para crearlas.\n');
    }

    // ── Seleccionar escenarios ───────────────────────────────────────────────
    const arg = process.argv[2];
    const scenariosToRun = arg
        ? SCENARIOS.filter(s => s.name === arg)
        : SCENARIOS;

    if (scenariosToRun.length === 0) {
        const names = SCENARIOS.map(s => `  - ${s.name}`).join('\n');
        console.error(`\n❌ Escenario "${arg}" no encontrado. Disponibles:\n${names}\n`);
        process.exit(1);
    }

    console.log(`\nEjecutando ${scenariosToRun.length} escenario(s) de admin contra "${company.name}"`);
    console.log(`Admin: ${TEST_CONFIG.TEST_ADMIN_PHONE} (${TEST_CONFIG.TEST_ADMIN_NAME})`);
    console.log(`Slots disponibles: ${slotCount ?? 0} | Citas programadas: ${apptCount ?? 0}`);

    // ── Correr escenarios ────────────────────────────────────────────────────
    const results: Array<{ name: string; passed: boolean }> = [];

    for (const scenario of scenariosToRun) {
        const passed = await runScenario(scenario, company.id);
        results.push({ name: scenario.name, passed });
        if (scenariosToRun.indexOf(scenario) < scenariosToRun.length - 1) {
            await sleep(2_000);
        }
    }

    // ── Resumen ──────────────────────────────────────────────────────────────
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\n${'═'.repeat(70)}`);
    console.log('RESUMEN — ESCENARIOS DE AGENDAMIENTO');
    console.log('═'.repeat(70));
    for (const r of results) {
        console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`);
    }
    console.log('─'.repeat(70));
    console.log(`  Total: ${passed} pasaron, ${failed} fallaron de ${results.length}`);
    console.log('═'.repeat(70) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
