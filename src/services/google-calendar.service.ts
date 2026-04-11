import { google } from 'googleapis';
import { JWT, OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Configuración del calendario de una clínica.
 * Viene de clinicas.gcal_config + companies.timezone.
 */
export interface GCalConfig {
    calendarId: string;
    workStart: string;      // "09:00" en la timezone de la clínica
    workEnd: string;        // "18:00"
    workDays: number[];     // [1,2,3,4,5] — 0=domingo
    defaultSlotMin: number;
    timezone: string;       // IANA, ej: "America/Bogota"
    staffName: string;         // Nombre del profesional, ej: "Dra. García"
    staffSpecialty: string;    // Especialidad, ej: "Medicina Estética"
    staffId?: string | null;   // UUID de clinicas.staff; si presente → usar OAuth, si null → Service Account
}

/**
 * Slot de disponibilidad calculado desde la freebusy API.
 * Usa slot_id sintético "gcal_{calendarId}_{isoStart}" para distinguirlo
 * de los UUIDs de availability_slots de BD.
 */
export interface GCalSlot {
    slot_id: string;
    staff_name: string;
    staff_specialty: string;
    starts_at: string;          // ISO 8601
    ends_at: string;
    duration_min: number;
    source: 'gcal';
}

/**
 * Servicio singleton que encapsula toda la interacción con Google Calendar API v3.
 * El resto del sistema NO debe importar `googleapis` directamente.
 *
 * Autenticación: Service Account almacenado en GOOGLE_SERVICE_ACCOUNT_JSON.
 * Cada clínica comparte su calendario con el email del service account y
 * proporciona el calendar_id que se guarda en clinicas.gcal_config.
 */
export class GoogleCalendarService {

    /**
     * Crea un cliente autenticado via Service Account.
     * El JWT se auto-renueva en cada petición (no hay expiración por tenant).
     */
    private static getClient() {
        const sa = (env as any).GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!sa) {
            throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no está configurado en las variables de entorno');
        }

        const auth = new JWT({
            email: sa.client_email,
            key: sa.private_key,
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });

        return google.calendar({ version: 'v3', auth });
    }

    /**
     * Crea un cliente OAuth2 autenticado con el refresh_token de un staff.
     * El access_token se renueva automáticamente en cada petición.
     * El staff debe haber autorizado previamente via /auth/google/start.
     */
    private static getOAuthClient(refreshToken: string): ReturnType<typeof google.calendar> {
        if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
            throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET no configurados');
        }

        const oauth2Client = new OAuth2Client(
            env.GOOGLE_OAUTH_CLIENT_ID,
            env.GOOGLE_OAUTH_CLIENT_SECRET,
            env.GOOGLE_OAUTH_REDIRECT_URI
        );
        oauth2Client.setCredentials({ refresh_token: refreshToken });

        return google.calendar({ version: 'v3', auth: oauth2Client });
    }

    /**
     * Verifica que el service account tiene acceso al calendario indicado.
     * Usado durante el onboarding para confirmar que el compartir fue exitoso.
     */
    static async verifyCalendarAccess(calendarId: string): Promise<{
        ok: boolean;
        calendarName?: string;
        error?: string;
    }> {
        try {
            const calendar = this.getClient();
            const res = await calendar.calendars.get({ calendarId });
            return { ok: true, calendarName: res.data.summary || calendarId };
        } catch (err: any) {
            const msg = err?.response?.data?.error?.message || err.message || 'Error desconocido';
            logger.warn(`[GCal] verifyCalendarAccess "${calendarId}": ${msg}`);
            return { ok: false, error: msg };
        }
    }

    /**
     * Calcula slots de disponibilidad usando la freebusy API.
     *
     * Algoritmo:
     * 1. Construye el rango [ahora, ahora + lookAheadDays] en UTC.
     * 2. Consulta los periodos "busy" del calendario via freebusy.query().
     * 3. Para cada día laboral en el rango, genera slots candidatos según
     *    workStart / workEnd / slotDurationMin en la timezone de la clínica.
     * 4. Descarta slots que se solapan con periodos busy.
     * 5. Retorna los primeros `limit` slots disponibles.
     */
    static async getAvailableSlots(
        config: GCalConfig,
        slotDurationMin: number,
        limit: number,
        lookAheadDays: number = 14,
        refreshToken?: string
    ): Promise<GCalSlot[]> {
        // Si hay refreshToken del staff, usar OAuth (su calendario personal).
        // Si no, usar Service Account (calendario compartido de la clínica).
        const calendar = refreshToken ? this.getOAuthClient(refreshToken) : this.getClient();

        // Para OAuth: siempre consultar 'primary'. Para SA: usar el calendarId configurado.
        const freebusyCalendarId = refreshToken ? 'primary' : config.calendarId;

        const now = new Date();
        const maxDate = new Date(now.getTime() + lookAheadDays * 86_400_000);

        // Consultar freebusy
        const freeBusyRes = await calendar.freebusy.query({
            requestBody: {
                timeMin: now.toISOString(),
                timeMax: maxDate.toISOString(),
                timeZone: 'UTC',
                items: [{ id: freebusyCalendarId }],
            },
        });

        const busyTimes: Array<{ start: Date; end: Date }> =
            (freeBusyRes.data.calendars?.[freebusyCalendarId]?.busy || [])
                .map((b: any) => ({
                    start: new Date(b.start),
                    end: new Date(b.end),
                }));

        // Generar slots candidatos para cada día del rango
        const availableSlots: GCalSlot[] = [];
        const [startH, startM] = config.workStart.split(':').map(Number);
        const [endH, endM] = config.workEnd.split(':').map(Number);

        const cursor = new Date(now);
        // Avanzar al inicio del día actual (o al momento actual si es intraday)

        while (cursor <= maxDate && availableSlots.length < limit) {
            const dayOfWeek = this.getDayOfWeekInTimezone(cursor, config.timezone);

            if (config.workDays.includes(dayOfWeek)) {
                // Calcular inicio y fin del horario laboral de este día en UTC
                const dayWorkStart = this.toUtc(cursor, startH, startM, config.timezone);
                const dayWorkEnd   = this.toUtc(cursor, endH, endM, config.timezone);

                // Generar slots candidatos dentro del horario laboral
                let slotStart = new Date(Math.max(dayWorkStart.getTime(), now.getTime()));
                // Redondear al siguiente slot completo (techo al múltiplo de slotDurationMin)
                const rem = slotStart.getMinutes() % slotDurationMin;
                if (rem !== 0) {
                    slotStart = new Date(slotStart.getTime() + (slotDurationMin - rem) * 60_000);
                    slotStart.setSeconds(0, 0);
                } else {
                    slotStart.setSeconds(0, 0);
                }

                while (slotStart < dayWorkEnd && availableSlots.length < limit) {
                    const slotEnd = new Date(slotStart.getTime() + slotDurationMin * 60_000);

                    if (slotEnd > dayWorkEnd) break;

                    // Verificar que no se solapa con ningún periodo busy
                    const isBusy = busyTimes.some(
                        b => b.start < slotEnd && b.end > slotStart
                    );

                    if (!isBusy) {
                        availableSlots.push({
                            slot_id: `gcal_${config.calendarId}_${slotStart.toISOString()}`,
                            staff_name: config.staffName || 'Disponible',
                            staff_specialty: config.staffSpecialty || '',
                            starts_at: slotStart.toISOString(),
                            ends_at: slotEnd.toISOString(),
                            duration_min: slotDurationMin,
                            source: 'gcal',
                        });
                    }

                    slotStart = slotEnd;
                }
            }

            // Avanzar al día siguiente
            cursor.setUTCDate(cursor.getUTCDate() + 1);
            cursor.setUTCHours(0, 0, 0, 0);
        }

        return availableSlots;
    }

    /**
     * Crea un evento en Google Calendar al reservar una cita.
     *
     * Modo Service Account (legacy): calendarId explícito, sin refreshToken.
     * Modo OAuth staff: refreshToken presente → usa 'primary' del staff, ignora calendarId.
     *
     * @returns El eventId del evento creado (para guardar en appointments.gcal_event_id).
     */
    static async createAppointmentEvent(params: {
        calendarId: string;
        summary: string;
        description: string;
        startAt: string;        // ISO 8601
        endAt: string;
        timezone: string;
        attendeeEmail?: string;
        refreshToken?: string;  // Si presente, usa OAuth del staff en lugar del SA
    }): Promise<string> {
        const calendar   = params.refreshToken ? this.getOAuthClient(params.refreshToken) : this.getClient();
        const calendarId = params.refreshToken ? 'primary' : params.calendarId;

        const event: any = {
            summary: params.summary,
            description: params.description,
            start: { dateTime: params.startAt, timeZone: params.timezone },
            end:   { dateTime: params.endAt,   timeZone: params.timezone },
        };

        if (params.attendeeEmail) {
            event.attendees = [{ email: params.attendeeEmail }];
        }

        const res = await calendar.events.insert({
            calendarId,
            requestBody: event,
            sendUpdates: params.attendeeEmail ? 'all' : 'none',
        });

        const eventId = res.data.id;
        if (!eventId) throw new Error('Google Calendar no retornó un eventId al crear el evento');

        const mode = params.refreshToken ? 'OAuth' : 'SA';
        logger.info(`[GCal] Evento creado (${mode}): ${eventId} (${params.summary})`);
        return eventId;
    }

    /**
     * Elimina un evento de Google Calendar al cancelar una cita.
     * Falla silenciosamente si el evento ya no existe (idempotente).
     */
    static async cancelAppointmentEvent(
        calendarId: string,
        gcalEventId: string,
        refreshToken?: string
    ): Promise<void> {
        try {
            const calendar = refreshToken ? this.getOAuthClient(refreshToken) : this.getClient();
            const targetCalendarId = refreshToken ? 'primary' : calendarId;
            await calendar.events.delete({ calendarId: targetCalendarId, eventId: gcalEventId });
            logger.info(`[GCal] Evento cancelado: ${gcalEventId}`);
        } catch (err: any) {
            // 410 Gone o 404 = evento ya eliminado — no es un error
            const status = err?.response?.status;
            if (status === 404 || status === 410) {
                logger.warn(`[GCal] Evento ${gcalEventId} ya no existe (${status}) — ignorando`);
                return;
            }
            throw err;
        }
    }

    /**
     * Actualiza el horario de un evento existente sin recrearlo (reschedule).
     */
    static async rescheduleAppointmentEvent(params: {
        calendarId: string;
        gcalEventId: string;
        newStartAt: string;
        newEndAt: string;
        timezone: string;
        refreshToken?: string;
    }): Promise<void> {
        const calendar = params.refreshToken ? this.getOAuthClient(params.refreshToken) : this.getClient();
        const targetCalendarId = params.refreshToken ? 'primary' : params.calendarId;

        await calendar.events.patch({
            calendarId: targetCalendarId,
            eventId: params.gcalEventId,
            requestBody: {
                start: { dateTime: params.newStartAt, timeZone: params.timezone },
                end:   { dateTime: params.newEndAt,   timeZone: params.timezone },
            },
        });

        logger.info(`[GCal] Evento reprogramado: ${params.gcalEventId} → ${params.newStartAt}`);
    }

    // ─── Utilidades privadas ─────────────────────────────────────────────────

    /**
     * Retorna el día de la semana (0=domingo … 6=sábado) de una fecha UTC
     * interpretada en la timezone de la clínica.
     */
    private static getDayOfWeekInTimezone(date: Date, timezone: string): number {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
        }).formatToParts(date);

        const weekday = parts.find(p => p.type === 'weekday')?.value;
        const map: Record<string, number> = {
            Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
        };
        return map[weekday || 'Mon'] ?? 1;
    }

    /**
     * Convierte una hora "HH:MM" en la timezone de la clínica
     * para un día UTC dado, retornando la fecha resultante en UTC.
     */
    private static toUtc(dayUtc: Date, hour: number, minute: number, timezone: string): Date {
        // Formato YYYY-MM-DD en la timezone de la clínica
        const localDateStr = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(dayUtc); // retorna "2024-05-20"

        // Construir la fecha local como string ISO y parsear sin asumir UTC
        const paddedH = String(hour).padStart(2, '0');
        const paddedM = String(minute).padStart(2, '0');

        const utcMs = getUtcFromLocalString(localDateStr, paddedH, paddedM, timezone);
        return new Date(utcMs);
    }
}

/**
 * Helper: dado un YYYY-MM-DD, HH, MM y una timezone IANA,
 * retorna el timestamp UTC correspondiente en milisegundos.
 *
 * Técnica: construimos la fecha en UTC tentativo y luego ajustamos
 * con la diferencia real que reporta Intl.DateTimeFormat.
 */
function getUtcFromLocalString(
    datePart: string,   // "2024-05-20"
    hh: string,         // "09"
    mm: string,         // "00"
    timezone: string
): number {
    // Punto de partida: interpretar como UTC (fácil de construir)
    const tentativeUtc = new Date(`${datePart}T${hh}:${mm}:00Z`);

    // Ver qué hora muestra Intl en la timezone deseada para ese momento UTC
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit', minute: '2-digit', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
    });

    const parts = formatter.formatToParts(tentativeUtc);
    const localH = parseInt(parts.find(p => p.type === 'hour')!.value);
    const localM = parseInt(parts.find(p => p.type === 'minute')!.value);

    // Diferencia entre lo que queremos y lo que Intl muestra
    const wantedMinutes = parseInt(hh) * 60 + parseInt(mm);
    const actualMinutes = localH * 60 + localM;
    const diffMs = (wantedMinutes - actualMinutes) * 60_000;

    return tentativeUtc.getTime() + diffMs;
}
