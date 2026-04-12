import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

// Mapa de aliases no-IANA → IANA. Sólo para valores conocidos incorrectos en la BD.
const TIMEZONE_ALIASES: Record<string, string> = {
    'Medellin/Colombia': 'America/Bogota',
    'Bogota/Colombia':   'America/Bogota',
    'Colombia':          'America/Bogota',
    'Medellin':          'America/Bogota',
    'Bogota':            'America/Bogota',
    'Cali/Colombia':     'America/Bogota',
    'Lima/Peru':         'America/Lima',
    'Ciudad de Mexico':  'America/Mexico_City',
    'Buenos Aires':      'America/Argentina/Buenos_Aires',
    'Santiago/Chile':    'America/Santiago',
};

function normalizeTimezone(tz: string): string {
    if (!tz) return 'America/Bogota';
    if (TIMEZONE_ALIASES[tz]) {
        logger.warn(`[ReminderDb] Timezone no-IANA "${tz}" → "${TIMEZONE_ALIASES[tz]}". Actualiza companies.timezone en la BD.`);
        return TIMEZONE_ALIASES[tz];
    }
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        logger.warn(`[ReminderDb] Timezone inválido: "${tz}", usando America/Bogota como fallback.`);
        return 'America/Bogota';
    }
}

const db = () => (supabase as any).schema('clinicas');

interface CreateReminderParams {
    companyId: string;
    contactId: string;
    conversationId: string;
    fireAt: string;          // Hora local de la clínica (ISO 8601, sin offset)
    message: string;
    agentType: 'patient' | 'admin';
    companyTimezone: string; // ej: 'America/Bogota'
}

export class ReminderDbService {

    /**
     * Crea un recordatorio. Convierte fire_at desde la TZ de la clínica a UTC.
     */
    static async create(params: CreateReminderParams): Promise<any> {
        const fireAtUtc = ReminderDbService.localToUtc(params.fireAt, params.companyTimezone);

        const { data, error } = await db()
            .from('scheduled_reminders')
            .insert([{
                company_id:       params.companyId,
                contact_id:       params.contactId,
                conversation_id:  params.conversationId,
                fire_at:          fireAtUtc,
                message:          params.message,
                agent_type:       params.agentType,
                status:           'pending',
                created_by_agent: params.agentType,
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
     * Marca un recordatorio como fallido tras un error de procesamiento.
     */
    static async markFailed(reminderId: string, errorMsg: string): Promise<void> {
        await db()
            .from('scheduled_reminders')
            .update({
                status:      'failed',
                fired_error: errorMsg.substring(0, 1000),
                updated_at:  new Date().toISOString(),
            })
            .eq('id', reminderId);
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

        const match = tzOffsetStr.match(/UTC([+-])(\d+)(?::(\d+))?/);
        if (!match) return assumedUtc.toISOString();

        const sign = match[1] === '+' ? 1 : -1;
        const offsetMinutes = sign * (parseInt(match[2]) * 60 + parseInt(match[3] || '0'));
        const correctedMs = assumedUtc.getTime() - offsetMinutes * 60 * 1000;
        return new Date(correctedMs).toISOString();
    }
}
