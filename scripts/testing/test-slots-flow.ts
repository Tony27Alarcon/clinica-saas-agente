/**
 * test-slots-flow.ts — Test de integración del flujo de disponibilidad de slots.
 *
 * Conecta directamente a Supabase real y llama a ClinicasDbService.
 * No requiere servidor corriendo — solo .env configurado.
 *
 * Uso:
 *   npm run test:slots
 *   npm run test:slots -- <company-id>   (override)
 *
 * Requisitos:
 *   - .env con SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   - Al menos una clínica activa en clinicas.companies
 */
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

// ── Console helpers (patrón existente del proyecto) ──────────────────────────

const green  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green('✓ PASS');
const FAIL = red('✗ FAIL');
const WARN = yellow('⚠ WARN');

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg: string) { console.log(`  ${PASS}  ${msg}`); passed++; }
function fail(msg: string, detail?: string) {
    console.log(`  ${FAIL}  ${msg}`);
    if (detail) console.log(`         ${red(detail)}`);
    failed++;
}
function warn(msg: string) { console.log(`  ${WARN}  ${msg}`); warned++; }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log(bold('\n═══ Test de Integración: Flujo de Disponibilidad de Slots ═══\n'));

    // ── 1. Prerrequisitos ────────────────────────────────────────────────────
    console.log(bold('1. Prerrequisitos'));

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        fail('SUPABASE_URL o SUPABASE_SERVICE_KEY no configurados');
        console.log(red('\n  Abortando — se requiere .env con credenciales de Supabase.\n'));
        process.exit(1);
    }
    pass('SUPABASE_URL y SUPABASE_SERVICE_KEY presentes');

    // ── 2. Resolver companyId ────────────────────────────────────────────────
    console.log(bold('\n2. Resolver clínica de prueba'));

    const supabase = createClient(supabaseUrl, supabaseKey);
    const db = () => (supabase as any).schema('clinicas');

    let companyId = process.argv[2];

    if (companyId) {
        pass(`Company ID pasado por CLI: ${companyId}`);
    } else {
        const { data: company } = await db()
            .from('companies')
            .select('id, name')
            .limit(1)
            .maybeSingle();

        if (!company) {
            fail('No se encontró ninguna clínica activa en clinicas.companies');
            console.log(red('\n  Ejecuta npm run test:seed para crear datos de prueba.\n'));
            process.exit(1);
        }

        companyId = company.id;
        pass(`Clínica encontrada: "${company.name}" (${companyId})`);
    }

    // ── 3. Import del servicio ───────────────────────────────────────────────
    console.log(bold('\n3. Import de ClinicasDbService'));

    let ClinicasDbService: any;
    try {
        const mod = await import('../../src/services/clinicas-db.service');
        ClinicasDbService = mod.ClinicasDbService;
        pass('ClinicasDbService importado correctamente');
    } catch (err: any) {
        fail('Error al importar ClinicasDbService', err.message);
        process.exit(1);
    }

    // ── 4. getFreeSlots directo (RPC) ────────────────────────────────────────
    console.log(bold('\n4. getFreeSlots (BD vía RPC)'));

    try {
        const dbSlots = await ClinicasDbService.getFreeSlots(companyId, undefined, 5);

        if (!Array.isArray(dbSlots)) {
            fail('getFreeSlots no retornó un array', `Tipo: ${typeof dbSlots}`);
        } else if (dbSlots.length === 0) {
            warn('getFreeSlots retornó 0 slots — puede no haber datos seed en availability_slots');
            pass('getFreeSlots retornó array (vacío)');
        } else {
            pass(`getFreeSlots retornó ${dbSlots.length} slot(s) de BD`);
            console.log(`         → Primer slot: ${dbSlots[0].slot_id || dbSlots[0].id} | ${dbSlots[0].starts_at}`);
        }
    } catch (err: any) {
        fail('getFreeSlots lanzó error', err.message);
    }

    // ── 5. getGCalConfigs ────────────────────────────────────────────────────
    console.log(bold('\n5. getGCalConfigs'));

    let hasGCal = false;
    try {
        const configs = await ClinicasDbService.getGCalConfigs(companyId);

        if (!Array.isArray(configs)) {
            fail('getGCalConfigs no retornó un array');
        } else if (configs.length === 0) {
            warn('No hay configuraciones de Google Calendar para esta clínica — se usará fallback BD');
            pass('getGCalConfigs retornó array (vacío)');
        } else {
            hasGCal = true;
            pass(`${configs.length} configuración(es) de calendario`);
            for (const c of configs) {
                const mode = c.staffId ? `OAuth (staff: ${c.staffId})` : 'Service Account';
                console.log(`         → ${c.calendarId} | ${c.staffName} | modo: ${mode} | ${c.workStart}–${c.workEnd} | días: [${c.workDays}]`);
            }
        }
    } catch (err: any) {
        fail('getGCalConfigs lanzó error', err.message);
    }

    // ── 6. getFreeSlotsMerged — shape validation ─────────────────────────────
    console.log(bold('\n6. getFreeSlotsMerged — validación de forma'));

    try {
        const result = await ClinicasDbService.getFreeSlotsMerged(companyId, undefined, undefined, 5);

        // Validar source
        if (result.source === 'gcal' || result.source === 'db') {
            pass(`source: "${result.source}"`);
        } else {
            fail(`source inesperado: "${result.source}"`, 'Se esperaba "gcal" o "db"');
        }

        // Validar que slots es array
        if (!Array.isArray(result.slots)) {
            fail('slots no es un array');
        } else {
            pass(`slots: array con ${result.slots.length} elemento(s)`);

            if (result.slots.length > 0) {
                const first = result.slots[0];

                // Validar prefijo de slot_id según source
                if (result.source === 'gcal' && typeof first.slot_id === 'string') {
                    if (first.slot_id.startsWith('gcal_')) {
                        pass('slot_id de GCal tiene prefijo "gcal_"');
                    } else {
                        fail(`slot_id GCal sin prefijo esperado: ${first.slot_id}`);
                    }
                }

                // Validar starts_at parseable
                const parsed = new Date(first.starts_at);
                if (!isNaN(parsed.getTime())) {
                    pass(`starts_at parseable como fecha ISO: ${first.starts_at}`);
                } else {
                    fail(`starts_at no parseable: ${first.starts_at}`);
                }

                // Validar orden cronológico
                if (result.slots.length > 1) {
                    const sorted = result.slots.every((s: any, i: number) => {
                        if (i === 0) return true;
                        return new Date(s.starts_at).getTime() >= new Date(result.slots[i - 1].starts_at).getTime();
                    });
                    if (sorted) {
                        pass('Slots ordenados cronológicamente');
                    } else {
                        fail('Slots NO están ordenados por starts_at');
                    }
                }
            } else {
                warn('getFreeSlotsMerged retornó 0 slots — puede no haber datos ni GCal configurado');
            }
        }
    } catch (err: any) {
        fail('getFreeSlotsMerged lanzó error', err.message);
    }

    // ── 7. Override slotDurationMin (solo si hay GCal) ───────────────────────
    if (hasGCal) {
        console.log(bold('\n7. Override slotDurationMin'));

        try {
            const result30 = await ClinicasDbService.getFreeSlotsMerged(companyId, undefined, 30, 2);
            const result60 = await ClinicasDbService.getFreeSlotsMerged(companyId, undefined, 60, 2);

            if (result30.source === 'gcal' && result30.slots.length > 0 && result30.slots[0].duration_min === 30) {
                pass('slotDurationMin=30 genera slots de 30 minutos');
            } else if (result30.slots.length === 0) {
                warn('No hay slots disponibles para duración 30 min — no se pudo validar');
            } else {
                warn(`duration_min del primer slot: ${result30.slots[0]?.duration_min} (esperado: 30)`);
            }

            if (result60.source === 'gcal' && result60.slots.length > 0 && result60.slots[0].duration_min === 60) {
                pass('slotDurationMin=60 genera slots de 60 minutos');
            } else if (result60.slots.length === 0) {
                warn('No hay slots disponibles para duración 60 min — no se pudo validar');
            } else {
                warn(`duration_min del primer slot: ${result60.slots[0]?.duration_min} (esperado: 60)`);
            }
        } catch (err: any) {
            fail('Error en test de override slotDurationMin', err.message);
        }
    } else {
        console.log(bold('\n7. Override slotDurationMin'));
        warn('Saltando — no hay Google Calendar configurado para esta clínica');
    }

    // ── Resumen ──────────────────────────────────────────────────────────────
    console.log(bold('\n═══ Resumen ═══'));
    console.log(`  ${green(`${passed} pasaron`)}  ${failed > 0 ? red(`${failed} fallaron`) : '0 fallaron'}  ${warned > 0 ? yellow(`${warned} advertencias`) : '0 advertencias'}`);
    console.log();

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(red(`\nError fatal: ${err.message}`));
    process.exit(1);
});
