import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { ReminderService } from './reminder.service';

const db = () => (supabase as any).schema('clinicas');

/**
 * Smart timer para el scheduler de reminders.
 *
 * En vez de hacer polling cada 60s (1,440 queries/día vacías),
 * consulta cuándo vence el próximo reminder y programa un setTimeout
 * justo para ese momento, con un cap máximo de 5 minutos para
 * no perderse reminders creados externamente.
 *
 * Llamar `recalculate()` cuando se crea un reminder nuevo para
 * reprogramar si el nuevo vence antes que el timer actual.
 */

const MAX_INTERVAL_MS = 5 * 60 * 1000; // 5 min — cap de seguridad
const MIN_INTERVAL_MS = 1_000;          // 1s — no disparar más rápido que esto

let timer: ReturnType<typeof setTimeout> | null = null;
let nextFireAt: Date | null = null;
let running = false;

async function getNextFireAt(): Promise<Date | null> {
    const { data, error } = await db()
        .from('scheduled_reminders')
        .select('fire_at')
        .in('status', ['pending', 'active'])
        .is('fired_at', null)
        .order('fire_at', { ascending: true })
        .limit(1)
        .maybeSingle();

    if (error) {
        logger.error('[ReminderScheduler] Error consultando próximo fire_at', error);
        return null;
    }

    return data?.fire_at ? new Date(data.fire_at) : null;
}

async function tick() {
    if (!running) return;

    try {
        await ReminderService.checkAndFire();
    } catch (err) {
        logger.error('[ReminderScheduler] checkAndFire error no capturado', err);
    }

    // Reprogramar tras ejecutar
    await scheduleNext();
}

async function scheduleNext() {
    if (!running) return;

    // Limpiar timer previo
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }

    const next = await getNextFireAt();
    nextFireAt = next;

    let delayMs: number;

    if (next) {
        const now = Date.now();
        const diff = next.getTime() - now;
        // Si ya venció o vence pronto, ejecutar rápido pero respetar el mínimo
        delayMs = Math.max(MIN_INTERVAL_MS, Math.min(diff, MAX_INTERVAL_MS));

        logger.info(
            `[ReminderScheduler] Próximo reminder en ${Math.round(delayMs / 1000)}s` +
            (diff <= 0 ? ' (vencido, ejecutando pronto)' : ` (fire_at: ${next.toISOString()})`)
        );
    } else {
        // Sin reminders pendientes — esperar el cap máximo y volver a revisar
        delayMs = MAX_INTERVAL_MS;
        logger.debug('[ReminderScheduler] Sin reminders pendientes, revisando en 5min');
    }

    timer = setTimeout(() => void tick(), delayMs);
}

export class ReminderScheduler {
    /**
     * Inicia el scheduler. Reemplaza el antiguo setInterval(60s).
     */
    static async start(): Promise<void> {
        if (running) return;
        running = true;
        logger.info('[ReminderScheduler] Smart timer iniciado');

        // Ejecutar inmediatamente para procesar cualquier reminder vencido
        await ReminderService.checkAndFire().catch(err =>
            logger.error('[ReminderScheduler] checkAndFire inicial falló', err)
        );

        await scheduleNext();
    }

    /**
     * Recalcula el timer. Llamar cuando se crea un reminder nuevo
     * para que el scheduler se entere sin esperar al cap de 5min.
     */
    static async recalculate(): Promise<void> {
        if (!running) return;

        const next = await getNextFireAt();
        if (!next) return;

        // Solo reprogramar si el nuevo reminder vence antes que el timer actual
        if (!nextFireAt || next.getTime() < nextFireAt.getTime()) {
            logger.info(`[ReminderScheduler] Recalculando — nuevo reminder más pronto: ${next.toISOString()}`);
            await scheduleNext();
        }
    }

    /**
     * Detiene el scheduler (para graceful shutdown).
     */
    static stop(): void {
        running = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        logger.info('[ReminderScheduler] Detenido');
    }
}
