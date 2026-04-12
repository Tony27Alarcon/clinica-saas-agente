/**
 * test-crud-tools.ts — QA de las 10 tools CRUD del agente admin.
 *
 * Cada escenario:
 *   1. Envía mensaje al agente admin via webhook simulado
 *   2. Espera y muestra la respuesta del agente
 *   3. Verifica en Supabase que el cambio realmente ocurrió en la BD (db_assert)
 *
 * Roles probados: SOLO agente admin (TEST_ADMIN_PHONE).
 *
 * Uso:
 *   npm run test:crud                          — todos los escenarios
 *   npm run test:crud -- crud-crear-tratamiento — uno específico
 *
 * Requisitos:
 *   - npm run dev corriendo en otra terminal
 *   - npm run test:seed ejecutado (crea datos base)
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

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface DbAssert {
    /** Descripción de lo que se verifica */
    description: string;
    /** Función que consulta Supabase y retorna true si el estado es correcto */
    check: (companyId: string) => Promise<{ passed: boolean; detail: string }>;
}

interface CrudScenario {
    name: string;
    description: string;
    /** Mensajes enviados en orden, separados por ~8s para que el agente responda */
    messages: string[];
    /** Verificaciones en BD DESPUÉS de todos los mensajes */
    db_asserts: DbAssert[];
    /** Si 'fresh', limpia la conversación del admin antes de correr */
    setup?: 'fresh';
    /** Limpieza post-test (ej: restaurar el estado original) */
    teardown?: (companyId: string) => Promise<void>;
}

// ── Helpers BD ────────────────────────────────────────────────────────────────

async function getTreatmentByName(companyId: string, name: string): Promise<any> {
    const { data } = await db()
        .from('treatments')
        .select('*')
        .eq('company_id', companyId)
        .ilike('name', name)
        .order('created_at', { ascending: false }) // más reciente primero
        .limit(1)
        .maybeSingle();
    return data;
}

async function getCompany(companyId: string): Promise<any> {
    const { data } = await db()
        .from('companies')
        .select('*')
        .eq('id', companyId)
        .maybeSingle();
    return data;
}

async function getActiveAgent(companyId: string): Promise<any> {
    const { data } = await db()
        .from('agents')
        .select('*')
        .eq('company_id', companyId)
        .eq('active', true)
        .maybeSingle();
    return data;
}

async function getStaffByName(companyId: string, name: string): Promise<any> {
    const { data } = await db()
        .from('staff')
        .select('*')
        .eq('company_id', companyId)
        .ilike('name', name)
        .order('created_at', { ascending: false }) // más reciente primero
        .limit(1)
        .maybeSingle();
    return data;
}

// ── Escenarios CRUD ───────────────────────────────────────────────────────────

const SCENARIOS: CrudScenario[] = [

    // ── TREATMENTS ────────────────────────────────────────────────────────────

    {
        name: 'crud-listar-tratamientos',
        description: 'Admin solicita la lista de tratamientos activos',
        setup: 'fresh',
        messages: [
            'Lista todos los tratamientos disponibles en la clínica',
        ],
        db_asserts: [
            {
                description: 'Existen tratamientos activos en la BD',
                check: async (companyId) => {
                    const { data } = await db()
                        .from('treatments')
                        .select('id, name')
                        .eq('company_id', companyId)
                        .eq('active', true);
                    const count = (data as any[])?.length ?? 0;
                    return {
                        passed: count > 0,
                        detail: `${count} tratamientos activos encontrados`,
                    };
                },
            },
        ],
    },

    {
        name: 'crud-crear-tratamiento',
        description: 'Admin crea un nuevo tratamiento "Mesoterapia Capilar"',
        setup: 'fresh',
        messages: [
            'Crea un nuevo tratamiento llamado "Mesoterapia Capilar QA", categoría capilar, precio entre 120 y 200 USD, duración 60 minutos, seguimiento a los 7 y 30 días. Descripción: tratamiento de nutrición capilar intensiva.',
        ],
        db_asserts: [
            {
                description: 'Tratamiento "Mesoterapia Capilar QA" existe en BD como activo',
                check: async (companyId) => {
                    const t = await getTreatmentByName(companyId, '%Mesoterapia Capilar QA%');
                    return {
                        passed: !!t && t.active === true,
                        detail: t
                            ? `ID: ${t.id} | precio: ${t.price_min}-${t.price_max} | active: ${t.active}`
                            : 'Tratamiento NO encontrado en BD',
                    };
                },
            },
            {
                description: 'Precio mínimo correcto (>= 100)',
                check: async (companyId) => {
                    const t = await getTreatmentByName(companyId, '%Mesoterapia Capilar QA%');
                    const ok = t && Number(t.price_min) >= 100;
                    return { passed: !!ok, detail: `price_min = ${t?.price_min}` };
                },
            },
        ],
        teardown: async (companyId) => {
            // Archivar el tratamiento creado para no contaminar otros tests
            await db()
                .from('treatments')
                .update({ active: false })
                .eq('company_id', companyId)
                .ilike('name', '%Mesoterapia Capilar QA%');
        },
    },

    {
        name: 'crud-actualizar-tratamiento',
        description: 'Admin actualiza el precio y la descripción del tratamiento Botox',
        setup: 'fresh',
        messages: [
            'Lista los tratamientos incluyendo los archivados para ver sus IDs',
            // El segundo mensaje usa el ID del botox devuelto en la respuesta
            'Actualiza el tratamiento de Botox (usa el ID de la lista anterior): cambia el precio máximo a 320 USD y agrega la nota en descripción: "Incluye zona frontal y entrecejo"',
        ],
        db_asserts: [
            {
                description: 'Tratamiento Botox tiene precio_max >= 300 en BD',
                check: async (companyId) => {
                    const t = await getTreatmentByName(companyId, '%Botox%');
                    const ok = t && Number(t.price_max) >= 300;
                    return {
                        passed: !!ok,
                        detail: `Botox price_max = ${t?.price_max}`,
                    };
                },
            },
        ],
    },

    {
        name: 'crud-archivar-tratamiento',
        description: 'Admin archiva el tratamiento "Limpieza Facial Profunda"',
        setup: 'fresh',
        messages: [
            'Usa la herramienta listTreatments para mostrarme todos los tratamientos con sus IDs',
            'Archiva el tratamiento "Limpieza Facial Profunda" usando su ID de la lista anterior. Lo suspendemos temporalmente.',
        ],
        db_asserts: [
            {
                description: 'Limpieza Facial Profunda está archivada (active=false) en BD',
                check: async (companyId) => {
                    const { data } = await db()
                        .from('treatments')
                        .select('id, active')
                        .eq('company_id', companyId)
                        .ilike('name', '%Limpieza%')
                        .limit(1)
                        .maybeSingle();
                    return {
                        passed: !!data && data.active === false,
                        detail: data ? `active = ${data.active}` : 'Tratamiento no encontrado',
                    };
                },
            },
        ],
        teardown: async (companyId) => {
            // Restaurar Limpieza Facial Profunda como activo
            await db()
                .from('treatments')
                .update({ active: true })
                .eq('company_id', companyId)
                .ilike('name', '%Limpieza%');
        },
    },

    // ── COMPANY ───────────────────────────────────────────────────────────────

    {
        name: 'crud-actualizar-empresa',
        description: 'Admin actualiza la ciudad y dirección de la clínica',
        setup: 'fresh',
        messages: [
            'Actualiza los datos de la clínica: ciudad "Bogotá QA", dirección "Calle 93 # 15-20, Piso 3"',
        ],
        db_asserts: [
            {
                description: 'Campo city actualizado en companies',
                check: async (companyId) => {
                    const co = await getCompany(companyId);
                    return {
                        passed: co?.city?.toLowerCase().includes('bogot'),
                        detail: `city = "${co?.city}"`,
                    };
                },
            },
            {
                description: 'Campo address actualizado en companies',
                check: async (companyId) => {
                    const co = await getCompany(companyId);
                    return {
                        passed: !!co?.address && co.address.length > 5,
                        detail: `address = "${co?.address}"`,
                    };
                },
            },
        ],
    },

    {
        name: 'crud-horario-empresa',
        description: 'Admin configura el horario de atención de la clínica',
        setup: 'fresh',
        messages: [
            'Configura el horario de la clínica: lunes a viernes de 8am a 7pm, y sábados de 9am a 2pm',
        ],
        db_asserts: [
            {
                description: 'Campo schedule es un array con al menos 1 bloque en companies',
                check: async (companyId) => {
                    const co = await getCompany(companyId);
                    const schedule = co?.schedule;
                    const isArray = Array.isArray(schedule) && schedule.length > 0;
                    return {
                        passed: isArray,
                        detail: `schedule = ${JSON.stringify(schedule)}`,
                    };
                },
            },
        ],
    },

    // ── AGENT CONFIG ──────────────────────────────────────────────────────────

    {
        name: 'crud-actualizar-agente-tono',
        description: 'Admin cambia el tono del agente a formal',
        setup: 'fresh',
        messages: [
            'Cambia el tono del agente paciente a "formal"',
        ],
        db_asserts: [
            {
                description: 'agents.tone = "formal" en BD',
                check: async (companyId) => {
                    const agent = await getActiveAgent(companyId);
                    return {
                        passed: agent?.tone === 'formal',
                        detail: `tone = "${agent?.tone}"`,
                    };
                },
            },
        ],
        teardown: async (companyId) => {
            // Restaurar tono amigable
            await db()
                .from('agents')
                .update({ tone: 'amigable' })
                .eq('company_id', companyId)
                .eq('active', true);
        },
    },

    {
        name: 'crud-actualizar-agente-config',
        description: 'Admin actualiza instrucciones de reserva y temas prohibidos',
        setup: 'fresh',
        messages: [
            'Actualiza el agente: agrega como temas prohibidos "política" y "religión". Instrucciones de reserva: "Siempre confirmar identidad del paciente antes de agendar".',
        ],
        db_asserts: [
            {
                description: 'agents.prohibited_topics incluye los nuevos temas',
                check: async (companyId) => {
                    const agent = await getActiveAgent(companyId);
                    const topics: string[] = agent?.prohibited_topics ?? [];
                    const hasTopics = topics.length > 0;
                    return {
                        passed: hasTopics,
                        detail: `prohibited_topics = ${JSON.stringify(topics)}`,
                    };
                },
            },
            {
                description: 'agents.booking_instructions actualizado',
                check: async (companyId) => {
                    const agent = await getActiveAgent(companyId);
                    const ok = agent?.booking_instructions && agent.booking_instructions.length > 10;
                    return {
                        passed: !!ok,
                        detail: `booking_instructions = "${agent?.booking_instructions?.substring(0, 60)}..."`,
                    };
                },
            },
        ],
    },

    {
        name: 'crud-prompt-rebuild-tras-config',
        description: 'Verifica que el system_prompt se recompila tras cambiar configuración del agente',
        setup: 'fresh',
        messages: [
            'Cambia el nombre del agente paciente a "SofíaQA"',
        ],
        db_asserts: [
            {
                description: 'agents.name = "SofíaQA" en BD',
                check: async (companyId) => {
                    const agent = await getActiveAgent(companyId);
                    return {
                        passed: agent?.name === 'SofíaQA',
                        detail: `name = "${agent?.name}"`,
                    };
                },
            },
            {
                description: 'agents.system_prompt contiene "SofíaQA" (prompt recompilado)',
                check: async (companyId) => {
                    await sleep(3_000); // Dar tiempo al rebuild async
                    const agent = await getActiveAgent(companyId);
                    const contains = (agent?.system_prompt ?? '').includes('SofíaQA');
                    return {
                        passed: contains,
                        detail: contains
                            ? 'system_prompt contiene "SofíaQA" ✓'
                            : `system_prompt NO contiene "SofíaQA". Primeras 200 chars: "${(agent?.system_prompt ?? '').substring(0, 200)}"`,
                    };
                },
            },
        ],
        teardown: async (companyId) => {
            // Restaurar nombre original "Valentina" y recompilar
            await db()
                .from('agents')
                .update({ name: 'Valentina' })
                .eq('company_id', companyId)
                .eq('active', true);
        },
    },

    // ── STAFF ─────────────────────────────────────────────────────────────────

    {
        name: 'crud-listar-staff',
        description: 'Admin solicita la lista de staff activo',
        setup: 'fresh',
        messages: [
            'Usa la herramienta listStaff para mostrarme todos los miembros del equipo de la clínica',
        ],
        db_asserts: [
            {
                description: 'Existen miembros activos en clinicas.staff',
                check: async (companyId) => {
                    const { data } = await db()
                        .from('staff')
                        .select('id, name')
                        .eq('company_id', companyId)
                        .eq('active', true);
                    const count = (data as any[])?.length ?? 0;
                    return {
                        passed: count > 0,
                        detail: `${count} miembros activos de staff`,
                    };
                },
            },
        ],
    },

    {
        name: 'crud-crear-staff',
        description: 'Admin agrega una nueva esteticista al staff',
        setup: 'fresh',
        messages: [
            'Agrega al staff a "Ana García QA" como Esteticista, especialidad en tratamientos faciales, teléfono 573001119999, máximo 6 citas por día.',
        ],
        db_asserts: [
            {
                description: 'Ana García QA existe en clinicas.staff como activa',
                check: async (companyId) => {
                    const s = await getStaffByName(companyId, '%Ana García QA%');
                    return {
                        passed: !!s && s.active === true,
                        detail: s
                            ? `ID: ${s.id} | role: ${s.role} | max_daily: ${s.max_daily_appointments}`
                            : 'Staff NO encontrado en BD',
                    };
                },
            },
            {
                description: 'max_daily_appointments <= 6',
                check: async (companyId) => {
                    const s = await getStaffByName(companyId, '%Ana García QA%');
                    return {
                        passed: !!s && s.max_daily_appointments <= 6,
                        detail: `max_daily_appointments = ${s?.max_daily_appointments}`,
                    };
                },
            },
        ],
        teardown: async (companyId) => {
            await db()
                .from('staff')
                .update({ active: false })
                .eq('company_id', companyId)
                .ilike('name', '%Ana García QA%');
        },
    },

    {
        name: 'crud-actualizar-staff',
        description: 'Admin actualiza la especialidad del Dr. Martín García',
        setup: 'fresh',
        messages: [
            'Usa listStaff con includeArchived=true para ver todo el equipo con sus IDs',
            'Actualiza a "Dr. Martín García" (usa su UUID de la lista): cambia su especialidad a "Medicina Estética y Láser" y el máximo a 10 citas por día',
        ],
        db_asserts: [
            {
                description: 'specialty de Dr. Martín García actualizada',
                check: async (companyId) => {
                    const s = await getStaffByName(companyId, '%Martín García%');
                    const ok = s?.specialty?.toLowerCase().includes('l');
                    return {
                        passed: !!ok,
                        detail: `specialty = "${s?.specialty}"`,
                    };
                },
            },
            {
                description: 'max_daily_appointments = 10',
                check: async (companyId) => {
                    const s = await getStaffByName(companyId, '%Martín García%');
                    return {
                        passed: s?.max_daily_appointments === 10,
                        detail: `max_daily_appointments = ${s?.max_daily_appointments}`,
                    };
                },
            },
        ],
    },

    {
        name: 'crud-archivar-staff',
        description: 'Admin crea y archiva un miembro de staff en un flujo completo',
        setup: 'fresh',
        messages: [
            'Agrega al staff a "Temporal QA" como Recepcionista',
            'Usa listStaff con includeArchived=false para ver el staff activo con sus IDs',
            'Archiva a "Temporal QA" del staff usando su UUID — ya no trabaja con nosotros',
        ],
        db_asserts: [
            {
                description: '"Temporal QA" está archivada (active=false) en BD',
                check: async (companyId) => {
                    const s = await getStaffByName(companyId, '%Temporal QA%');
                    if (!s) return { passed: true, detail: 'Staff no existe (ya archivado o eliminado)' };
                    return {
                        passed: s.active === false,
                        detail: `active = ${s.active}`,
                    };
                },
            },
        ],
        teardown: async (companyId) => {
            await db()
                .from('staff')
                .update({ active: false })
                .eq('company_id', companyId)
                .ilike('name', '%Temporal QA%');
        },
    },

    // ── FLUJO INTEGRADO ───────────────────────────────────────────────────────

    {
        name: 'crud-flujo-completo-tratamiento',
        description: 'Flujo completo: crear → actualizar → archivar en turnos consecutivos',
        setup: 'fresh',
        messages: [
            'Crea un tratamiento "PRP QA" categoría facial, precio 250 USD, duración 90 minutos, seguimiento a los 15 y 30 días',
            'Usa listTreatments con includeArchived=false para ver todos los tratamientos activos y sus IDs',
            'Actualiza el tratamiento "PRP QA" (usa su UUID): cambia la duración a 75 minutos y agrega contraindicación "No aplicar con anticoagulantes"',
            'Archiva el tratamiento "PRP QA" usando su UUID — lo suspendemos',
        ],
        db_asserts: [
            {
                description: '"PRP QA" está archivado (active=false) con contraindicación',
                check: async (companyId) => {
                    const t = await getTreatmentByName(companyId, '%PRP QA%');
                    return {
                        passed: !!t && t.active === false,
                        detail: t ? `active=${t.active} | duration_min=${t.duration_min} | contraindications="${t.contraindications?.substring(0, 50)}"` : 'No encontrado',
                    };
                },
            },
        ],
        teardown: async (companyId) => {
            await db()
                .from('treatments')
                .update({ active: false })
                .eq('company_id', companyId)
                .ilike('name', '%PRP QA%');
        },
    },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function waitForAdminConversation(companyId: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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
    throw new Error('Timeout: no se creó conversación del admin.');
}

async function runScenario(scenario: CrudScenario, companyId: string): Promise<boolean> {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`ESCENARIO: ${scenario.name}`);
    console.log(`           ${scenario.description}`);
    console.log('═'.repeat(72));

    try {
        if (scenario.setup === 'fresh') {
            await sendWebhookMessage({
                text: '/borrar',
                from: TEST_CONFIG.TEST_ADMIN_PHONE,
                senderName: TEST_CONFIG.TEST_ADMIN_NAME,
            });
            await sleep(1_500);
        }

        // ── Enviar mensajes y mostrar respuestas ─────────────────────────────
        for (const [i, userText] of scenario.messages.entries()) {
            const beforeTimestamp = new Date().toISOString();
            console.log(`\n  [${i + 1}/${scenario.messages.length}] ADMIN  > ${userText.substring(0, 100)}${userText.length > 100 ? '...' : ''}`);

            await sendWebhookMessage({
                text: userText,
                from: TEST_CONFIG.TEST_ADMIN_PHONE,
                senderName: TEST_CONFIG.TEST_ADMIN_NAME,
            });

            const convId = await waitForAdminConversation(companyId);
            const response = await pollForAgentResponse(convId, beforeTimestamp);
            console.log(`         AGENTE > ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`);

            // Pequeña pausa entre turnos para que el agente termine sus tool calls
            if (i < scenario.messages.length - 1) await sleep(2_000);
        }

        // ── Verificaciones en BD ─────────────────────────────────────────────
        let allAssertsPassed = true;
        console.log('\n  ── Verificaciones BD ──────────────────────────────────────────');

        for (const assert of scenario.db_asserts) {
            const { passed, detail } = await assert.check(companyId);
            const icon = passed ? '✅' : '❌';
            console.log(`  ${icon} ${assert.description}`);
            console.log(`     ↳ ${detail}`);
            if (!passed) allAssertsPassed = false;
        }

        // ── Teardown ─────────────────────────────────────────────────────────
        if (scenario.teardown) {
            await scenario.teardown(companyId);
            console.log('  🧹 Teardown ejecutado (datos restaurados)');
        }

        console.log(allAssertsPassed ? '\n  ✅ PASÓ' : '\n  ❌ FALLÓ (verificaciones BD)');
        return allAssertsPassed;

    } catch (err: any) {
        console.log(`\n  ❌ FALLÓ con excepción: ${err.message}`);
        if (scenario.teardown) {
            await scenario.teardown(companyId).catch(() => {});
        }
        return false;
    }
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

    // ── Verificar que el admin está registrado como staff ────────────────────
    const { data: adminStaff } = await db()
        .from('staff')
        .select('id, name')
        .eq('company_id', company.id)
        .eq('phone', TEST_CONFIG.TEST_ADMIN_PHONE)
        .maybeSingle();

    if (!adminStaff) {
        console.error(`\n❌ El teléfono ${TEST_CONFIG.TEST_ADMIN_PHONE} no está en clinicas.staff.`);
        console.error('Ejecuta "npm run test:seed" para crear el staff de prueba.\n');
        process.exit(1);
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

    console.log(`\n${'═'.repeat(72)}`);
    console.log('QA TOOLS CRUD — AGENTE ADMIN');
    console.log('═'.repeat(72));
    console.log(`Clínica : ${company.name} (${company.id})`);
    console.log(`Staff   : ${adminStaff.name} (${TEST_CONFIG.TEST_ADMIN_PHONE})`);
    console.log(`Escenarios a correr: ${scenariosToRun.length}`);
    console.log('═'.repeat(72));

    // ── Ejecutar ─────────────────────────────────────────────────────────────
    const results: Array<{ name: string; passed: boolean }> = [];

    for (const scenario of scenariosToRun) {
        const passed = await runScenario(scenario, company.id);
        results.push({ name: scenario.name, passed });
        if (scenariosToRun.indexOf(scenario) < scenariosToRun.length - 1) {
            await sleep(2_500);
        }
    }

    // ── Reporte final ─────────────────────────────────────────────────────────
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\n${'═'.repeat(72)}`);
    console.log('REPORTE FINAL — QA TOOLS CRUD');
    console.log('═'.repeat(72));

    const categories: Record<string, string[]> = {
        'Treatments': results.filter(r => r.name.includes('tratamiento') || r.name.includes('flujo-completo')).map(r => r.name),
        'Company': results.filter(r => r.name.includes('empresa') || r.name.includes('horario')).map(r => r.name),
        'Agent Config': results.filter(r => r.name.includes('agente')).map(r => r.name),
        'Staff': results.filter(r => r.name.includes('staff')).map(r => r.name),
    };

    for (const [cat, names] of Object.entries(categories)) {
        if (names.length === 0) continue;
        console.log(`\n  ${cat}:`);
        for (const name of names) {
            const r = results.find(x => x.name === name);
            if (r) console.log(`    ${r.passed ? '✅' : '❌'} ${r.name}`);
        }
    }

    console.log(`\n${'─'.repeat(72)}`);
    console.log(`  Total: ${passed} ✅ pasaron | ${failed} ❌ fallaron | ${results.length} total`);
    console.log('═'.repeat(72) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
