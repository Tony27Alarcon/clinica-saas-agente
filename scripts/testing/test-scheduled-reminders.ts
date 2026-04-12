/**
 * test-scheduled-reminders.ts — QA del sistema de recordatorios programados por el agente.
 *
 * NO requiere el servidor Express corriendo (salvo el test E2E con --fire).
 * Importa los servicios directamente y trabaja contra Supabase real.
 *
 * SUITES:
 *   1. Unit — ReminderDbService.localToUtc()   (sin red, siempre pasan)
 *   2. DB   — create / claimDueReminders / markFailed + idempotencia (necesita Supabase)
 *   3. E2E  — checkAndFire completo: llama a Gemini + guarda mensaje en DB
 *             Solo corre con el flag --fire (hace llamadas reales a la IA)
 *
 * Uso:
 *   npm run test:scheduled-reminders            → suites 1 y 2
 *   npm run test:scheduled-reminders -- --fire  → suites 1, 2 y 3 (llama a Gemini)
 *
 * Prerequisitos:
 *   npm run test:seed  (crea la clínica y el contacto de prueba)
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

import { TEST_CONFIG } from './lib/config';
import { ReminderDbService } from '../../src/services/reminder-db.service';
import { ReminderService } from '../../src/services/reminder.service';

// ── Flags ─────────────────────────────────────────────────────────────────────

const RUN_FIRE = process.argv.includes('--fire');

// ── Supabase directo (solo para inspección/limpieza en tests) ─────────────────

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);
const db = () => (supabase as any).schema('clinicas');

// ── Helpers de output ──────────────────────────────────────────────────────────

function section(title: string) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log(title);
    console.log('─'.repeat(64));
}

function ok(msg: string)   { console.log(`  ✅ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

function assertEqual<T>(label: string, actual: T, expected: T) {
    if (actual === expected) {
        ok(`${label}: "${actual}"`);
    } else {
        fail(`${label}: esperado "${expected}", obtenido "${actual}"`);
        throw new Error(`Assertion failed: ${label}`);
    }
}

function assertContains(label: string, actual: string, substr: string) {
    if (actual.includes(substr)) {
        ok(`${label} contiene "${substr}"`);
    } else {
        fail(`${label}: "${actual}" no contiene "${substr}"`);
        throw new Error(`Assertion failed: ${label}`);
    }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── SUITE 1: Unit tests — localToUtc ─────────────────────────────────────────

async function suiteLocalToUtc(): Promise<number> {
    section('SUITE 1 — localToUtc (sin red, sin DB)');

    let failures = 0;

    const run = (label: string, fn: () => void) => {
        try { fn(); }
        catch (e: any) { fail(`${label}: ${e.message}`); failures++; }
    };

    // ── Casos con offset explícito (pasan directamente por Date) ──────────────

    run('String con Z (UTC)', () => {
        const result = ReminderDbService.localToUtc('2026-04-11T19:00:00Z', 'America/Bogota');
        assertEqual('  result', result, '2026-04-11T19:00:00.000Z');
    });

    run('String con offset +05:30 (India)', () => {
        const result = ReminderDbService.localToUtc('2026-04-11T00:30:00+05:30', 'Asia/Kolkata');
        // 00:30 IST = 19:00 UTC del día anterior
        assertEqual('  result', result, '2026-04-10T19:00:00.000Z');
    });

    run('String con offset -05:00 (Colombia explícito)', () => {
        const result = ReminderDbService.localToUtc('2026-04-11T14:00:00-05:00', 'America/Bogota');
        assertEqual('  result', result, '2026-04-11T19:00:00.000Z');
    });

    // ── Casos sin offset (interpreta como hora local de la clínica) ───────────

    run('America/Bogota (UTC-5, sin DST) — 14:00 local → 19:00 UTC', () => {
        const result = ReminderDbService.localToUtc('2026-04-11T14:00:00', 'America/Bogota');
        assertEqual('  result', result, '2026-04-11T19:00:00.000Z');
    });

    run('America/Bogota — medianoche local → 05:00 UTC del día siguiente', () => {
        const result = ReminderDbService.localToUtc('2026-04-11T00:00:00', 'America/Bogota');
        assertEqual('  result', result, '2026-04-11T05:00:00.000Z');
    });

    run('America/Bogota — sin segundos (HH:MM) también funciona', () => {
        const result = ReminderDbService.localToUtc('2026-06-15T09:30', 'America/Bogota');
        assertEqual('  result', result, '2026-06-15T14:30:00.000Z');
    });

    run('UTC puro — sin offset, timezone UTC', () => {
        const result = ReminderDbService.localToUtc('2026-04-11T10:00:00', 'UTC');
        assertEqual('  result', result, '2026-04-11T10:00:00.000Z');
    });

    run('Formato inválido → lanza error', () => {
        try {
            ReminderDbService.localToUtc('hoy a las 3', 'America/Bogota');
            fail('  Debía haber lanzado error');
            failures++;
        } catch (e: any) {
            ok(`  Lanzó error correctamente: "${e.message.substring(0, 50)}..."`);
        }
    });

    if (failures === 0) ok(`Todos los casos de localToUtc pasaron.`);
    return failures;
}

// ── SUITE 2: DB — create / claim / markFailed / idempotencia ──────────────────

async function suiteDb(companyId: string, contactId: string, conversationId: string): Promise<number> {
    section('SUITE 2 — DB: create / claimDueReminders / markFailed');

    let failures = 0;
    const createdIds: string[] = [];

    // ── TEST 2.1: create() ────────────────────────────────────────────────────

    info('2.1 — Insertando recordatorio con fire_at en el FUTURO (+30 min)...');
    let futureReminder: any;
    try {
        const fireAt = new Date(Date.now() + 30 * 60_000)
            .toISOString()
            .replace('Z', '')
            .slice(0, 19);   // "YYYY-MM-DDTHH:MM:SS" sin offset (hora UTC, que es igual al local para este test)

        futureReminder = await ReminderDbService.create({
            companyId,
            contactId,
            conversationId,
            fireAt:          `${fireAt}`,
            message:         '[TEST] Recordatorio futuro — no debe dispararse aún.',
            agentType:       'patient',
            companyTimezone: 'UTC',          // UTC para que no haya conversión
        });

        createdIds.push(futureReminder.id);
        ok(`Recordatorio futuro creado: ${futureReminder.id}`);
        info(`  fire_at_utc: ${futureReminder.fire_at_utc}`);

        // Verificar en DB que status = 'pending'
        const { data: row } = await db()
            .from('scheduled_reminders')
            .select('status, fired_at')
            .eq('id', futureReminder.id)
            .single();

        assertEqual('  status en DB', (row as any)?.status, 'pending');
        assertEqual('  fired_at en DB', (row as any)?.fired_at, null);
    } catch (e: any) {
        fail(`create() falló: ${e.message}`);
        failures++;
    }

    // ── TEST 2.2: claimDueReminders() — no debe retornar el futuro ───────────

    info('2.2 — claimDueReminders() no debe retornar recordatorios futuros...');
    try {
        const claimed = await ReminderDbService.claimDueReminders();
        const containsFuture = claimed.some(r => r.id === futureReminder?.id);
        if (containsFuture) {
            fail('claimDueReminders() retornó el recordatorio FUTURO — error de lógica');
            failures++;
        } else {
            ok(`claimDueReminders() ignoró correctamente el recordatorio futuro.`);
            if (claimed.length > 0) {
                info(`  (${claimed.length} recordatorio(s) vencido(s) de otros tests procesados)`);
            }
        }
    } catch (e: any) {
        fail(`claimDueReminders() lanzó excepción: ${e.message}`);
        failures++;
    }

    // ── TEST 2.3: Insertar recordatorio VENCIDO y verificar claim ─────────────

    info('2.3 — Insertando recordatorio VENCIDO (fire_at hace 2 min)...');
    let dueReminder: any;
    try {
        const pastFireAt = new Date(Date.now() - 2 * 60_000).toISOString();

        // Insertar directamente en DB con fire_at en el pasado
        const { data, error } = await db()
            .from('scheduled_reminders')
            .insert([{
                company_id:       companyId,
                contact_id:       contactId,
                conversation_id:  conversationId,
                fire_at:          pastFireAt,
                message:          '[TEST] Recordatorio vencido — debe ser reclamado.',
                agent_type:       'patient',
                status:           'pending',
                created_by_agent: 'patient',
            }])
            .select()
            .single();

        if (error) throw error;
        dueReminder = data;
        createdIds.push(dueReminder.id);
        ok(`Recordatorio vencido creado: ${dueReminder.id}`);
        info(`  fire_at: ${dueReminder.fire_at}`);
    } catch (e: any) {
        fail(`Inserción directa fallida: ${e.message}`);
        failures++;
    }

    // ── TEST 2.4: claimDueReminders() debe retornar el vencido ───────────────

    info('2.4 — claimDueReminders() debe reclamar el vencido...');
    let claimedNow: any[] = [];
    try {
        claimedNow = await ReminderDbService.claimDueReminders();
        const claimedDue = claimedNow.find(r => r.id === dueReminder?.id);

        if (!claimedDue) {
            fail(`El recordatorio vencido (${dueReminder?.id}) NO fue retornado por claimDueReminders().`);
            fail('  → Verifica que la función RPC clinicas.claim_due_reminders existe en Supabase.');
            failures++;
        } else {
            ok(`claimDueReminders() retornó el recordatorio vencido.`);
            assertEqual('  status retornado', claimedDue.status, 'fired');

            // Verificar en DB
            const { data: row } = await db()
                .from('scheduled_reminders')
                .select('status, fired_at')
                .eq('id', dueReminder.id)
                .single();

            assertEqual('  status en DB después del claim', (row as any)?.status, 'fired');
            if ((row as any)?.fired_at) {
                ok(`  fired_at registrado: ${(row as any).fired_at}`);
            } else {
                fail('  fired_at es NULL después del claim');
                failures++;
            }
        }
    } catch (e: any) {
        fail(`claimDueReminders() lanzó excepción: ${e.message}`);
        failures++;
    }

    // ── TEST 2.5: Idempotencia — segundo claim no retorna el mismo ────────────

    info('2.5 — Idempotencia: segundo claimDueReminders() no debe retornar el mismo...');
    try {
        const secondClaim = await ReminderDbService.claimDueReminders();
        const duplicate = secondClaim.find(r => r.id === dueReminder?.id);

        if (duplicate) {
            fail('FALLO DE IDEMPOTENCIA: el mismo recordatorio fue retornado dos veces.');
            failures++;
        } else {
            ok('Idempotencia correcta: el recordatorio ya no es retornado en el segundo claim.');
        }
    } catch (e: any) {
        fail(`Segundo claimDueReminders() lanzó excepción: ${e.message}`);
        failures++;
    }

    // ── TEST 2.6: markFailed() ────────────────────────────────────────────────

    info('2.6 — markFailed(): insertando y marcando como fallido...');
    try {
        const { data: failRow, error: insertErr } = await db()
            .from('scheduled_reminders')
            .insert([{
                company_id:       companyId,
                contact_id:       contactId,
                conversation_id:  conversationId,
                fire_at:          new Date(Date.now() - 60_000).toISOString(),
                message:          '[TEST] Recordatorio para prueba de markFailed.',
                agent_type:       'patient',
                status:           'pending',
                created_by_agent: 'patient',
            }])
            .select()
            .single();

        if (insertErr) throw insertErr;
        const failReminderId = (failRow as any).id;
        createdIds.push(failReminderId);

        await ReminderDbService.markFailed(failReminderId, 'Error simulado para QA: conexión rechazada');

        const { data: updatedRow } = await db()
            .from('scheduled_reminders')
            .select('status, fired_error')
            .eq('id', failReminderId)
            .single();

        assertEqual('  status en DB', (updatedRow as any)?.status, 'failed');
        assertContains('  fired_error en DB', (updatedRow as any)?.fired_error ?? '', 'Error simulado');
    } catch (e: any) {
        fail(`markFailed() falló: ${e.message}`);
        failures++;
    }

    // ── Limpieza de registros de prueba ───────────────────────────────────────

    info('Limpiando registros de prueba de la DB...');
    try {
        await db()
            .from('scheduled_reminders')
            .delete()
            .in('id', createdIds);
        ok(`${createdIds.length} registros de prueba eliminados.`);
    } catch (e: any) {
        warn(`Limpieza parcial: ${e.message}`);
    }

    return failures;
}

// ── SUITE 3: E2E — checkAndFire completo ─────────────────────────────────────

async function suiteE2e(companyId: string, contactId: string, conversationId: string): Promise<number> {
    section('SUITE 3 — E2E: checkAndFire (llama a Gemini + guarda en DB)');

    warn('Esta suite hace llamadas REALES a la IA y guarda mensajes en la conversación de prueba.');
    info('El mensaje generado aparecerá en la conversación del contacto de prueba en Supabase.');

    let failures = 0;
    let testReminderId: string | null = null;

    try {
        // Insertar un recordatorio vencido que usa contexto realista
        info('Insertando recordatorio vencido con contexto de negocio...');
        const { data: row, error } = await db()
            .from('scheduled_reminders')
            .insert([{
                company_id:       companyId,
                contact_id:       contactId,
                conversation_id:  conversationId,
                fire_at:          new Date(Date.now() - 60_000).toISOString(),
                message:          'El usuario solicitó ser contactado esta tarde para preguntar sobre el tratamiento de Botox. Debe retomar la conversación de forma proactiva, preguntar si sigue interesado y ofrecer 2 horarios disponibles.',
                agent_type:       'patient',
                status:           'pending',
                created_by_agent: 'patient',
            }])
            .select()
            .single();

        if (error) throw error;
        testReminderId = (row as any).id;
        ok(`Recordatorio E2E creado: ${testReminderId}`);

        // Marcar timestamp antes del disparo
        const beforeFire = new Date().toISOString();
        info('Ejecutando ReminderService.checkAndFire()...');

        await ReminderService.checkAndFire();

        ok('checkAndFire() completado sin excepción.');

        // Verificar que el recordatorio fue marcado como fired
        const { data: reminderRow } = await db()
            .from('scheduled_reminders')
            .select('status, fired_at')
            .eq('id', testReminderId)
            .single();

        assertEqual('  status final en DB', (reminderRow as any)?.status, 'fired');
        if ((reminderRow as any)?.fired_at) {
            ok(`  fired_at: ${(reminderRow as any).fired_at}`);
        } else {
            fail('  fired_at es NULL después del disparo');
            failures++;
        }

        // Verificar que el agente generó y guardó un mensaje
        info('Esperando mensaje del agente en DB (máx 5s)...');
        let agentMessage: string | null = null;

        for (let i = 0; i < 10; i++) {
            const { data: msgs } = await db()
                .from('messages')
                .select('content, role, created_at')
                .eq('conversation_id', conversationId)
                .gt('created_at', beforeFire)
                .order('created_at', { ascending: false })
                .limit(1);

            const msg = (msgs as any[])?.[0];
            if (msg?.role === 'agent' && msg.content) {
                agentMessage = msg.content;
                break;
            }
            await sleep(500);
        }

        if (agentMessage) {
            ok(`Mensaje del agente guardado en DB (${agentMessage.length} chars):`);
            console.log(`\n     ┌${'─'.repeat(56)}┐`);
            const lines = agentMessage.split('\n').flatMap(l =>
                l.match(/.{1,54}/g) || ['']
            );
            for (const line of lines.slice(0, 8)) {
                console.log(`     │ ${line.padEnd(54)} │`);
            }
            if (lines.length > 8) console.log(`     │ ... (${lines.length - 8} líneas más)`.padEnd(57) + '│');
            console.log(`     └${'─'.repeat(56)}┘\n`);
        } else {
            fail('No se encontró mensaje del agente en DB después del disparo.');
            info('  Puede que checkAndFire() haya disparado pero el agente retornó texto vacío.');
            info('  Revisa los logs del servidor o ejecuta con DEBUG=true.');
            failures++;
        }

    } catch (e: any) {
        fail(`E2E falló: ${e.message}`);
        if (e.message?.includes('GEMINI') || e.message?.includes('API')) {
            info('  → Verifica que GEMINI_API_KEY esté configurado en .env');
        }
        failures++;
    } finally {
        // Limpieza — solo el recordatorio; el mensaje del agente se deja para inspección
        if (testReminderId) {
            await db()
                .from('scheduled_reminders')
                .delete()
                .eq('id', testReminderId)
                .eq('status', 'pending'); // Solo borrar si por algún motivo quedó pendiente
        }
    }

    return failures;
}

// ── SUITE 4: Inspección — estado actual de recordatorios en DB ────────────────

async function suiteInspeccion(companyId: string): Promise<void> {
    section('SUITE 4 — Inspección: recordatorios actuales en la BD');

    const { data: all, error } = await db()
        .from('scheduled_reminders')
        .select(`
            id, status, fire_at, agent_type, message,
            contact:contacts (name, phone)
        `)
        .eq('company_id', companyId)
        .order('fire_at', { ascending: false })
        .limit(20);

    if (error) {
        fail(`Error consultando scheduled_reminders: ${error.message}`);
        info('  → ¿Ejecutaste la migración SQL (sql/add_scheduled_reminders.sql) en Supabase?');
        return;
    }

    const rows = (all as any[]) || [];

    if (rows.length === 0) {
        info('No hay recordatorios en la tabla scheduled_reminders para esta clínica.');
        info('(Normal si aún no se ha programado ninguno desde el agente.)');
        return;
    }

    const byStatus = {
        pending:   rows.filter(r => r.status === 'pending'),
        fired:     rows.filter(r => r.status === 'fired'),
        failed:    rows.filter(r => r.status === 'failed'),
        cancelled: rows.filter(r => r.status === 'cancelled'),
    };

    ok(`Total: ${rows.length} recordatorio(s) — pending: ${byStatus.pending.length}, fired: ${byStatus.fired.length}, failed: ${byStatus.failed.length}`);

    if (byStatus.pending.length > 0) {
        info('Pendientes:');
        for (const r of byStatus.pending) {
            const fireLocal = new Date(r.fire_at).toLocaleString('es-CO', {
                timeZone: 'America/Bogota',
                day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit',
            });
            info(`  [${r.agent_type}] ${r.contact?.name} — dispara ${fireLocal} — "${r.message?.substring(0, 60)}..."`);
        }
    }

    if (byStatus.failed.length > 0) {
        warn(`${byStatus.failed.length} recordatorio(s) fallidos — revisar fired_error en la BD.`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n' + '═'.repeat(64));
    console.log('QA — Sistema de Recordatorios Programados (scheduled_reminders)');
    console.log('═'.repeat(64));

    if (RUN_FIRE) {
        warn('Modo --fire activo: se realizarán llamadas REALES a Gemini.');
    }

    // Obtener clínica y contacto de prueba (depende del seed)
    const { data: company } = await db()
        .from('companies')
        .select('id, name, timezone')
        .eq('slug', TEST_CONFIG.SEED_COMPANY_SLUG)
        .maybeSingle();

    if (!company) {
        console.error('\n❌ Clínica de prueba no encontrada. Ejecuta npm run test:seed primero.');
        process.exit(1);
    }

    info(`Clínica: ${company.name} (${company.id})`);

    const { data: contact } = await db()
        .from('contacts')
        .select('id, name, phone')
        .eq('company_id', company.id)
        .eq('phone', TEST_CONFIG.TEST_USER_PHONE)
        .maybeSingle();

    if (!contact) {
        console.error('\n❌ Contacto de prueba no encontrado. Ejecuta npm run test:seed primero.');
        process.exit(1);
    }

    info(`Contacto: ${contact.name} (${contact.phone})`);

    // Obtener o crear conversación de prueba
    let { data: conversation } = await db()
        .from('conversations')
        .select('id')
        .eq('company_id', company.id)
        .eq('contact_id', contact.id)
        .in('status', ['open', 'waiting'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!conversation) {
        // Crear conversación mínima para los tests de DB
        const { data: agent } = await db()
            .from('agents')
            .select('id')
            .eq('company_id', company.id)
            .eq('active', true)
            .limit(1)
            .maybeSingle();

        const { data: newConv, error: convErr } = await db()
            .from('conversations')
            .insert([{
                company_id:  company.id,
                contact_id:  contact.id,
                agent_id:    agent?.id ?? null,
                channel:     'whatsapp',
                status:      'open',
            }])
            .select('id')
            .single();

        if (convErr) {
            console.error(`\n❌ No se pudo crear conversación de prueba: ${convErr.message}`);
            process.exit(1);
        }
        conversation = newConv;
        info(`Conversación de prueba creada: ${conversation.id}`);
    } else {
        info(`Conversación de prueba: ${conversation.id}`);
    }

    const totals = { failures: 0, suites: 0 };

    // Suite 1: Unit
    try {
        const f = await suiteLocalToUtc();
        totals.failures += f;
        totals.suites++;
    } catch (e: any) {
        fail(`Suite 1 crasheó: ${e.message}`);
        totals.failures++;
    }

    // Suite 2: DB
    try {
        const f = await suiteDb(company.id, contact.id, conversation.id);
        totals.failures += f;
        totals.suites++;
    } catch (e: any) {
        fail(`Suite 2 crasheó: ${e.message}`);
        totals.failures++;
    }

    // Suite 3: E2E (opt-in)
    if (RUN_FIRE) {
        try {
            const f = await suiteE2e(company.id, contact.id, conversation.id);
            totals.failures += f;
            totals.suites++;
        } catch (e: any) {
            fail(`Suite 3 crasheó: ${e.message}`);
            totals.failures++;
        }
    } else {
        section('SUITE 3 — E2E (omitida)');
        info('Pasa --fire para ejecutar: npm run test:scheduled-reminders -- --fire');
    }

    // Suite 4: Inspección (solo informativa, no suma failures)
    await suiteInspeccion(company.id).catch(e => warn(`Inspección falló: ${e.message}`));

    // ── Resumen final ─────────────────────────────────────────────────────────

    console.log(`\n${'═'.repeat(64)}`);
    console.log('RESUMEN FINAL');
    console.log('═'.repeat(64));

    if (totals.failures === 0) {
        ok(`${totals.suites} suite(s) completadas sin errores.`);
        if (!RUN_FIRE) {
            info('Para probar el disparo real del agente: npm run test:scheduled-reminders -- --fire');
        }
    } else {
        fail(`${totals.failures} error(es) encontrados en ${totals.suites} suite(s).`);
    }

    console.log('═'.repeat(64) + '\n');
    process.exit(totals.failures > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
