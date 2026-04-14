import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { normalizeTimezone } from '../utils/time';
import { CronExpressionParser } from 'cron-parser';

// Backoffs en minutos por intento (índice = retry_count actual antes del intento)
const BACKOFF_MINUTES = [2, 5, 15, 30, 60, 120, 240, 480]; // 8 reintentos → ~14h total
const MAX_RETRIES = BACKOFF_MINUTES.length;

const db = () => (supabase as any).schema('clinicas');

interface CreateReminderParams {
    companyId: string;
    contactId: string;
    conversationId: string;
    fireAt: string;           // Hora local de la clínica (ISO 8601, sin offset) — primer disparo
    message: string;
    agentType: 'patient' | 'admin';
    companyTimezone: string;  // ej: 'America/Bogota'
    rrule?: string;           // Cron 5 campos para recurrentes (opcional)
}

export class ReminderDbService {

    /**
     * Crea un recordatorio. Convierte fire_at desde la TZ de la clínica a UTC.
     * Si se pasa rrule, crea un recordatorio recurrente (status='active') y calcula next_run_at.
     */
    static async create(params: CreateReminderParams): Promise<any> {
        const fireAtUtc = ReminderDbService.localToUtc(params.fireAt, params.companyTimezone);
        const isRecurrent = !!params.rrule;
        const nextRunAt = isRecurrent
            ? ReminderDbService.calculateNextRun(params.rrule!, params.companyTimezone)
            : null;

        const { data, error } = await db()
            .from('scheduled_reminders')
            .insert([{
                company_id:       params.companyId,
                contact_id:       params.contactId,
                conversation_id:  params.conversationId,
                fire_at:          fireAtUtc,
                message:          params.message,
                agent_type:       params.agentType,
                status:           isRecurrent ? 'active' : 'pending',
                created_by_agent: params.agentType,
                rrule:            params.rrule || null,
                next_run_at:      nextRunAt,
            }])
            .select()
            .single();

        if (error) throw error;
        return { ...data, fire_at_utc: fireAtUtc };
    }

    /**
     * Claim atómico: devuelve los recordatorios pendientes vencidos marcándolos
     * como 'fired' en la misma operación SQL. Garantiza idempotencia bajo
     * concurrencia (dos instancias no procesan el mismo recordatorio).
     */
    static async claimDueReminders(): Promise<any[]> {
        // La función vive en el schema 'clinicas', no en 'public'.
        // Sin .schema('clinicas'), PostgREST la busca en 'public' y devuelve 404.
        const { data, error } = await (supabase as any)
            .schema('clinicas')
            .rpc('claim_due_reminders', {
                p_now: new Date().toISOString(),
            });

        if (error) {
            logger.error(`[ReminderDb] claimDueReminders error: ${error.message}`);
            return [];
        }
        return (data as any[]) || [];
    }

    /**
     * Maneja el fallo de un recordatorio.
     * Si retry_count < MAX_RETRIES: reprograma con backoff exponencial (status='pending').
     * Si agotó los reintentos: marca como 'failed' definitivamente.
     */
    static async markFailed(reminderId: string, errorMsg: string): Promise<void> {
        const { data } = await db()
            .from('scheduled_reminders')
            .select('retry_count')
            .eq('id', reminderId)
            .single();

        const retryCount = data?.retry_count ?? 0;

        if (retryCount < MAX_RETRIES) {
            const delayMs = BACKOFF_MINUTES[retryCount] * 60 * 1000;
            const nextFireAt = new Date(Date.now() + delayMs).toISOString();

            await db()
                .from('scheduled_reminders')
                .update({
                    status:      'pending',
                    fired_at:    null,
                    fire_at:     nextFireAt,
                    retry_count: retryCount + 1,
                    fired_error: errorMsg.substring(0, 1000),
                    updated_at:  new Date().toISOString(),
                })
                .eq('id', reminderId);

            logger.warn(
                `[ReminderDb] Reminder ${reminderId} → reintento ${retryCount + 1}/${MAX_RETRIES} en ${BACKOFF_MINUTES[retryCount]}m`
            );
        } else {
            await db()
                .from('scheduled_reminders')
                .update({
                    status:      'failed',
                    fired_error: errorMsg.substring(0, 1000),
                    updated_at:  new Date().toISOString(),
                })
                .eq('id', reminderId);

            logger.error(
                `[ReminderDb] Reminder ${reminderId} falló definitivamente tras ${MAX_RETRIES} intentos`
            );
        }
    }

    /**
     * Lista los recordatorios pendientes de un contacto (máx 10, ordenados por fire_at).
     */
    static async listPending(companyId: string, contactId: string): Promise<any[]> {
        const { data, error } = await db()
            .from('scheduled_reminders')
            .select('id, fire_at, message, agent_type, status, retry_count, rrule')
            .eq('company_id', companyId)
            .eq('contact_id', contactId)
            .in('status', ['pending', 'active'])
            .is('fired_at', null)
            .order('fire_at', { ascending: true })
            .limit(10);

        if (error) throw error;
        return data || [];
    }

    /**
     * Cancela un recordatorio pendiente (soft-delete: status → 'cancelled').
     * El filtro company_id garantiza aislamiento multi-tenant.
     * Retorna true si se canceló, false si no existía o ya fue procesado.
     */
    static async cancel(reminderId: string, companyId: string): Promise<boolean> {
        const { data, error } = await db()
            .from('scheduled_reminders')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('id', reminderId)
            .eq('company_id', companyId)
            .in('status', ['pending', 'active'])
            .is('fired_at', null)
            .select('id')
            .maybeSingle();

        if (error) throw error;
        return !!data;
    }

    /**
     * Convierte un datetime UTC a la timezone local de la clínica para mostrar al usuario.
     */
    static utcToLocal(utcDatetime: string, timezone: string): string {
        const tz = normalizeTimezone(timezone);
        return new Intl.DateTimeFormat('es-CO', {
            timeZone: tz,
            year:     'numeric',
            month:    '2-digit',
            day:      '2-digit',
            hour:     '2-digit',
            minute:   '2-digit',
        }).format(new Date(utcDatetime));
    }

    /**
     * Convierte un datetime en la timezone local de la clínica a UTC ISO 8601.
     *
     * Si fire_at ya viene con offset explícito (Z o +HH:MM), lo parsea directamente.
     * Si viene sin offset (ej: "2026-04-11T14:00:00"), interpreta en la timezone
     * de la clínica usando Intl.DateTimeFormat con shortOffset para manejar DST.
     */
    static localToUtc(localDatetime: string, timezone: string): string {
        timezone = normalizeTimezone(timezone);

        // Con offset explícito → Date lo parsea correctamente
        if (localDatetime.includes('Z') || /[+-]\d{2}:\d{2}$/.test(localDatetime)) {
            return new Date(localDatetime).toISOString();
        }

        // Sin offset: interpretar como hora local de la clínica
        const parts = localDatetime.match(
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
        );
        if (!parts) {
            throw new Error(`fire_at inválido: "${localDatetime}". Formato esperado: YYYY-MM-DDTHH:MM:SS`);
        }

        const [, y, mo, d, h, mi, s = '00'] = parts;

        // Obtener el offset de la TZ para esa fecha específica (maneja DST)
        const assumedUtc = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            timeZoneName: 'shortOffset',
        });
        const tzParts = formatter.formatToParts(assumedUtc);
        const tzOffsetStr = tzParts.find(p => p.type === 'timeZoneName')?.value || 'UTC+0';

        // Algunos entornos devuelven "GMT-5" en vez de "UTC-5" — capturamos ambos
        const match = tzOffsetStr.match(/(?:UTC|GMT)([+-])(\d+)(?::(\d+))?/);
        if (!match) {
            logger.error(`[ReminderDb] localToUtc: no se pudo parsear offset "${tzOffsetStr}" para tz "${timezone}". Guardando sin conversión.`);
            return assumedUtc.toISOString();
        }

        const sign = match[1] === '+' ? 1 : -1;
        const offsetMinutes = sign * (parseInt(match[2]) * 60 + parseInt(match[3] || '0'));
        const correctedMs = assumedUtc.getTime() - offsetMinutes * 60 * 1000;
        return new Date(correctedMs).toISOString();
    }

    /**
     * Calcula la próxima ejecución de una expresión cron (5 campos) en la timezone dada.
     * Retorna la fecha en UTC ISO 8601.
     */
    static calculateNextRun(rrule: string, timezone: string): string {
        const tz = normalizeTimezone(timezone);
        const interval = CronExpressionParser.parse(rrule, { tz, currentDate: new Date() });
        return interval.next().toDate().toISOString();
    }

    /**
     * Completa un ciclo de recordatorio recurrente tras dispararlo exitosamente:
     * - Resetea fired_at a null (permite ser reclamado en el siguiente ciclo)
     * - Calcula y guarda next_run_at con la siguiente ejecución según el rrule
     * - Incrementa run_count
     */
    static async completeRecurrentCycle(
        reminderId: string,
        rrule: string,
        timezone: string,
        currentRunCount: number
    ): Promise<void> {
        const nextRun = ReminderDbService.calculateNextRun(rrule, timezone);

        await db()
            .from('scheduled_reminders')
            .update({
                fired_at:    null,
                next_run_at: nextRun,
                run_count:   currentRunCount + 1,
                updated_at:  new Date().toISOString(),
            })
            .eq('id', reminderId);

        logger.info(
            `[ReminderDb] Recurrente ${reminderId} → próxima ejecución: ${nextRun} (run_count: ${currentRunCount + 1})`
        );
    }
}
