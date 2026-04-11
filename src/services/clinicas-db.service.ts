import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';
import { env } from '../config/env';
import { GoogleCalendarService, GCalConfig } from './google-calendar.service';

/**
 * Acceso al schema `clinicas` via PostgREST.
 * Requiere que `clinicas` esté en "Extra schemas" de Supabase:
 * Dashboard → Settings → API → Extra schemas → clinicas
 *
 * El service_role bypasea RLS automáticamente.
 */
const db = () => (supabase as any).schema('clinicas');

export class ClinicasDbService {

    /**
     * Lookup del tenant por wa_phone_number_id.
     * Busca en la tabla clinicas.channels el canal activo que coincide con el ID de Meta.
     */
    static async getCompanyByWaPhone(waPhoneNumberId: string): Promise<any | null> {
        try {
            // Buscamos el canal y hacemos el JOIN manual via PostgREST para identificar la compañía
            const { data, error } = await db()
                .from('channels')
                .select(`
                    id,
                    provider,
                    provider_id,
                    display_name,
                    phone_number,
                    company:companies (
                        id, 
                        name, 
                        slug, 
                        plan, 
                        timezone, 
                        currency,
                        active
                    )
                `)
                .eq('provider', 'whatsapp')
                .eq('provider_id', waPhoneNumberId)
                .eq('active', true)
                .maybeSingle();

            if (error) throw error;
            if (!data || !data.company || !(data.company as any).active) return null;

            // Retornamos la compañía enriquecida con el ID del canal que recibió el mensaje
            return {
                ...(data.company as any),
                channel_id: data.id,
                wa_phone_display: data.display_name || data.phone_number
            };
        } catch (error) {
            logger.error(`[Clinicas] getCompanyByWaPhone: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Busca o crea un contacto por teléfono dentro de una clínica.
     * UNIQUE(company_id, phone) garantiza que no habrá duplicados.
     */
    static async getOrCreateContact(
        companyId: string,
        phone: string,
        name: string,
        initialStatus: string = 'prospecto'
    ): Promise<any> {
        try {
            const { data: existing } = await db()
                .from('contacts')
                .select('*')
                .eq('company_id', companyId)
                .eq('phone', phone)
                .maybeSingle();

            if (existing) return existing;

            const displayName = name?.trim()
                ? `${name.trim()} *No confirmado`
                : 'Desconocido *No confirmado';

            const { data: newContact, error } = await db()
                .from('contacts')
                .insert([{
                    company_id: companyId,
                    phone,
                    name: displayName,
                    status: initialStatus,
                    temperature: 'frio',
                }])
                .select()
                .single();

            if (error) throw error;
            return newContact;
        } catch (error) {
            logger.error(`[Clinicas] getOrCreateContact: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Obtiene el agente activo de la clínica.
     * Cada clínica tiene un agente configurado con su system_prompt, tono y criterios.
     */
    static async getActiveAgent(companyId: string): Promise<any> {
        try {
            const { data, error } = await db()
                .from('agents')
                .select('id, name, system_prompt, tone, qualification_criteria, escalation_rules, objections_kb')
                .eq('company_id', companyId)
                .eq('active', true)
                .limit(1)
                .maybeSingle();

            if (error) throw error;
            if (!data) throw new Error(`No hay agente activo para la clínica ${companyId}`);
            return data;
        } catch (error) {
            logger.error(`[Clinicas] getActiveAgent: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Busca la conversación abierta de un contacto, o crea una nueva.
     * Una sola conversación abierta por contacto a la vez.
     */
    static async getOrCreateConversation(
        companyId: string,
        contactId: string,
        agentId: string,
        channel: string = 'whatsapp'
    ): Promise<any> {
        try {
            const { data: existing } = await db()
                .from('conversations')
                .select('*')
                .eq('contact_id', contactId)
                .eq('status', 'open')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (existing) return existing;

            const { data: newConv, error } = await db()
                .from('conversations')
                .insert([{
                    company_id: companyId,
                    contact_id: contactId,
                    agent_id: agentId,
                    channel,
                    status: 'open',
                    pipeline_phase: 1,
                }])
                .select()
                .single();

            if (error) throw error;
            return newConv;
        } catch (error) {
            logger.error(`[Clinicas] getOrCreateConversation: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Guarda un mensaje en clinicas.messages.
     * company_id se denormaliza para evitar JOINs en RLS.
     */
    static async saveMessage(
        conversationId: string,
        companyId: string,
        role: 'contact' | 'agent' | 'system',
        content: string,
        metadata: Record<string, any> = {}
    ): Promise<any> {
        try {
            const { data, error } = await db()
                .from('messages')
                .insert([{ conversation_id: conversationId, company_id: companyId, role, content, metadata }])
                .select()
                .single();

            if (error) throw error;
            return data;
        } catch (error) {
            logger.error(`[Clinicas] saveMessage: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Recupera el historial de mensajes formateado para el AI SDK.
     * Excluye mensajes 'system' (no válidos en messages[]).
     */
    static async getHistorial(
        conversationId: string,
        limit: number = 20
    ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
        try {
            const { data, error } = await db()
                .from('messages')
                .select('role, content, created_at')
                .eq('conversation_id', conversationId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;

            return ((data || []) as any[])
                .reverse()
                .filter((m: any) => m.role === 'contact' || m.role === 'agent')
                .map((m: any) => ({
                    role: m.role === 'contact' ? 'user' : 'assistant',
                    content: m.content || (m.role === 'agent' ? '...' : '[mensaje vacío]'),
                }));
        } catch (error) {
            logger.error(`[Clinicas] getHistorial: ${(error as Error).message}`);
            return [];
        }
    }

    /**
     * Actualiza el status y/o temperature de un contacto.
     * Llamado por la tool updateContactProfile del agente.
     */
    static async updateContact(contactId: string, updates: {
        status?: string;
        temperature?: string;
        name?: string;
        email?: string;
    }): Promise<void> {
        try {
            const { error } = await db()
                .from('contacts')
                .update({ ...updates, updated_at: new Date().toISOString() })
                .eq('id', contactId);

            if (error) throw error;
        } catch (error) {
            logger.error(`[Clinicas] updateContact: ${(error as Error).message}`);
        }
    }

    /**
     * Marca una conversación como escalada a humano.
     * Llamado por la tool escalateToHuman del agente.
     */
    static async escalateConversation(conversationId: string, reason: string): Promise<void> {
        try {
            const { error } = await db()
                .from('conversations')
                .update({
                    status: 'escalated',
                    escalation_reason: reason,
                    escalated_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', conversationId);

            if (error) throw error;
        } catch (error) {
            logger.error(`[Clinicas] escalateConversation: ${(error as Error).message}`);
        }
    }

    /**
     * Elimina el contacto de la clínica (para comando /borrar en testing).
     * ON DELETE CASCADE en BD borra también sus conversaciones y mensajes.
     */
    static async deleteContact(companyId: string, phone: string): Promise<boolean> {
        try {
            const { error } = await db()
                .from('contacts')
                .delete()
                .eq('company_id', companyId)
                .eq('phone', phone);

            if (error) throw error;
            return true;
        } catch (error) {
            logger.error(`[Clinicas] deleteContact: ${(error as Error).message}`);
            return false;
        }
    }

    // ─── Admin Agent: métodos de soporte ────────────────────────────────────────

    /**
     * Detecta si el número que escribe es un miembro del staff de la clínica.
     * Trae todos los staff activos y compara teléfonos normalizados en JS para
     * evitar lógica de normalización en SQL (fail-soft: retorna null si falla).
     */
    static async findStaffByPhone(companyId: string, rawPhone: string): Promise<any | null> {
        try {
            const { data, error } = await db()
                .from('staff')
                .select('id, name, role, specialty, phone')
                .eq('company_id', companyId)
                .eq('active', true)
                .not('phone', 'is', null);

            if (error) throw error;
            if (!data || data.length === 0) return null;

            const normalizedFrom = normalizePhone(rawPhone);
            if (!normalizedFrom) return null;

            return (data as any[]).find(s => {
                const normalizedStaff = normalizePhone(s.phone);
                return normalizedStaff && normalizedStaff === normalizedFrom;
            }) ?? null;
        } catch (error) {
            logger.error(`[Clinicas] findStaffByPhone: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Busca contactos de la clínica por nombre, teléfono o estado.
     * Excluye contactos con status='staff' (son miembros del equipo).
     */
    static async searchContacts(
        companyId: string,
        filters: { name?: string; phone?: string; status?: string },
        limit: number = 10
    ): Promise<any[]> {
        try {
            let query = db()
                .from('contacts')
                .select('id, name, phone, email, status, temperature, created_at')
                .eq('company_id', companyId)
                .neq('status', 'staff')
                .limit(limit);

            if (filters.name) query = query.ilike('name', `%${filters.name}%`);
            if (filters.phone) query = query.eq('phone', filters.phone);
            if (filters.status) query = query.eq('status', filters.status);

            const { data, error } = await query.order('created_at', { ascending: false });
            if (error) throw error;
            return (data as any[]) || [];
        } catch (error) {
            logger.error(`[Clinicas] searchContacts: ${(error as Error).message}`);
            return [];
        }
    }

    /**
     * Retorna las citas próximas de la clínica (scheduled + confirmed) en los
     * próximos `days` días, con JOIN a contacto, staff y tratamiento.
     */
    static async getUpcomingAppointments(companyId: string, days: number = 7): Promise<any[]> {
        try {
            const from = new Date().toISOString();
            const to = new Date(Date.now() + days * 86_400_000).toISOString();

            const { data, error } = await db()
                .from('appointments')
                .select(`
                    id, scheduled_at, status, notes,
                    contact:contacts (id, name, phone),
                    staff:staff (id, name, role),
                    treatment:treatments (id, name, duration_min)
                `)
                .eq('company_id', companyId)
                .in('status', ['scheduled', 'confirmed'])
                .gte('scheduled_at', from)
                .lte('scheduled_at', to)
                .order('scheduled_at', { ascending: true });

            if (error) throw error;
            return (data as any[]) || [];
        } catch (error) {
            logger.error(`[Clinicas] getUpcomingAppointments: ${(error as Error).message}`);
            return [];
        }
    }

    /**
     * Retorna slots de disponibilidad libres via RPC.
     */
    static async getFreeSlots(
        companyId: string,
        treatmentId?: string,
        limit: number = 10
    ): Promise<any[]> {
        try {
            const { data, error } = await (supabase as any)
                .schema('clinicas')
                .rpc('get_available_slots', {
                    p_company_id: companyId,
                    p_treatment_id: treatmentId ?? null,
                    p_limit: limit,
                });

            if (error) throw error;
            return (data as any[]) || [];
        } catch (error) {
            logger.error(`[Clinicas] getFreeSlots: ${(error as Error).message}`);
            return [];
        }
    }

    /**
     * Actualiza el estado de una cita. Verifica ownership antes de operar.
     * Si newStatus='completed', dispara la creación de follow-ups via RPC.
     * Si newStatus='cancelled', libera el slot asociado.
     */
    static async updateAppointmentStatus(
        companyId: string,
        appointmentId: string,
        newStatus: string,
        notes?: string,
        newStartsAt?: string,
        newEndsAt?: string
    ): Promise<any> {
        try {
            // Verificar ownership y leer gcal_event_id + gcal_calendar_id
            const { data: appt, error: fetchErr } = await db()
                .from('appointments')
                .select('id, company_id, slot_id, gcal_event_id, gcal_calendar_id, scheduled_at')
                .eq('id', appointmentId)
                .maybeSingle();

            if (fetchErr) throw fetchErr;
            if (!appt || (appt as any).company_id !== companyId) {
                return { ok: false, error: 'Cita no encontrada o sin permisos' };
            }

            const updates: Record<string, any> = {
                status: newStatus,
                updated_at: new Date().toISOString(),
            };
            if (notes) updates.notes = notes;
            if (newStatus === 'rescheduled' && newStartsAt) {
                updates.scheduled_at = newStartsAt;
            }

            const { data, error } = await db()
                .from('appointments')
                .update(updates)
                .eq('id', appointmentId)
                .select()
                .single();

            if (error) throw error;

            // Si se completa, crear follow-ups via RPC
            if (newStatus === 'completed') {
                await (supabase as any)
                    .schema('clinicas')
                    .rpc('create_follow_ups_for_appointment', { p_appointment_id: appointmentId })
                    .then(({ error: rpcErr }: any) => {
                        if (rpcErr) logger.warn(`[Clinicas] create_follow_ups RPC: ${rpcErr.message}`);
                    });
            }

            // Si se cancela, liberar el slot de BD (si aplica) y eliminar evento GCal
            if (newStatus === 'cancelled') {
                if ((appt as any).slot_id) {
                    await db()
                        .from('availability_slots')
                        .update({ is_booked: false })
                        .eq('id', (appt as any).slot_id)
                        .then(({ error: slotErr }: any) => {
                            if (slotErr) logger.warn(`[Clinicas] liberar slot: ${slotErr.message}`);
                        });
                }

                if ((appt as any).gcal_event_id) {
                    // Busca el calendario específico (multi-cal); fallback al primero activo
                    const calId = (appt as any).gcal_calendar_id as string | undefined;
                    const gcalCfg = calId
                        ? await this.getGCalConfigByCalendarId(companyId, calId)
                        : await this.getGCalConfigs(companyId).then(cs => cs[0] ?? null);
                    if (gcalCfg) {
                        const cancelOAuth = gcalCfg.staffId
                            ? await this.getStaffOAuthTokens(gcalCfg.staffId).then(t => t?.refreshToken)
                            : undefined;
                        GoogleCalendarService.cancelAppointmentEvent(
                            gcalCfg.calendarId,
                            (appt as any).gcal_event_id,
                            cancelOAuth
                        ).catch((err: Error) =>
                            logger.warn(`[Clinicas] GCal cancel ${(appt as any).gcal_event_id}: ${err.message}`)
                        );
                    }
                }
            }

            // Si se reprograma y hay evento GCal, mover el evento
            if (newStatus === 'rescheduled' && newStartsAt && (appt as any).gcal_event_id) {
                const calId = (appt as any).gcal_calendar_id as string | undefined;
                const gcalCfg = calId
                    ? await this.getGCalConfigByCalendarId(companyId, calId)
                    : await this.getGCalConfigs(companyId).then(cs => cs[0] ?? null);

                if (gcalCfg && newEndsAt) {
                    const reschedOAuth = gcalCfg.staffId
                        ? await this.getStaffOAuthTokens(gcalCfg.staffId).then(t => t?.refreshToken)
                        : undefined;
                    GoogleCalendarService.rescheduleAppointmentEvent({
                        calendarId: gcalCfg.calendarId,
                        gcalEventId: (appt as any).gcal_event_id,
                        newStartAt: newStartsAt,
                        newEndAt: newEndsAt,
                        timezone: gcalCfg.timezone,
                        refreshToken: reschedOAuth,
                    }).catch((err: Error) =>
                        logger.warn(`[Clinicas] GCal reschedule ${(appt as any).gcal_event_id}: ${err.message}`)
                    );
                }
            }

            return { ok: true, data };
        } catch (error) {
            logger.error(`[Clinicas] updateAppointmentStatus: ${(error as Error).message}`);
            return { ok: false, error: (error as Error).message };
        }
    }

    /**
     * Retorna el resumen completo de un contacto: datos, citas e historial reciente.
     * Verifica ownership antes de consultar.
     */
    static async getContactSummary(
        companyId: string,
        contactId: string
    ): Promise<{ contact: any; appointments: any[]; recentMessages: any[] } | null> {
        try {
            const { data: contact, error: contactErr } = await db()
                .from('contacts')
                .select('*')
                .eq('id', contactId)
                .eq('company_id', companyId)
                .maybeSingle();

            if (contactErr) throw contactErr;
            if (!contact) return null;

            const { data: appointments } = await db()
                .from('appointments')
                .select(`
                    id, scheduled_at, status, notes,
                    treatment:treatments (name, duration_min),
                    staff:staff (name, role)
                `)
                .eq('contact_id', contactId)
                .order('scheduled_at', { ascending: false })
                .limit(5);

            // Obtener mensajes de todas las conversaciones del contacto (máx 10)
            const { data: conversations } = await db()
                .from('conversations')
                .select('id')
                .eq('contact_id', contactId)
                .limit(3);

            const convIds = ((conversations as any[]) || []).map((c: any) => c.id);
            let recentMessages: any[] = [];

            if (convIds.length > 0) {
                const { data: msgs } = await db()
                    .from('messages')
                    .select('role, content, created_at')
                    .in('conversation_id', convIds)
                    .order('created_at', { ascending: false })
                    .limit(10);
                recentMessages = ((msgs as any[]) || []).reverse();
            }

            return {
                contact,
                appointments: (appointments as any[]) || [],
                recentMessages,
            };
        } catch (error) {
            logger.error(`[Clinicas] getContactSummary: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Resumen diario de la clínica: citas del día, leads nuevos, conversaciones
     * escaladas y follow-ups pendientes.
     */
    static async getDailySummary(
        companyId: string,
        timezone: string
    ): Promise<{
        todayAppointments: any[];
        newLeadsToday: number;
        escalatedConversations: any[];
        pendingFollowUps: number;
    }> {
        try {
            const nowUtc = new Date();
            // Inicio del día en UTC (simplificado: usamos fecha de hoy en UTC)
            const startOfDay = new Date(nowUtc);
            startOfDay.setUTCHours(0, 0, 0, 0);
            const endOfDay = new Date(nowUtc);
            endOfDay.setUTCHours(23, 59, 59, 999);

            const [appts, newLeads, escalated, followUps] = await Promise.all([
                db()
                    .from('appointments')
                    .select(`
                        id, scheduled_at, status,
                        contact:contacts (name, phone),
                        treatment:treatments (name)
                    `)
                    .eq('company_id', companyId)
                    .in('status', ['scheduled', 'confirmed'])
                    .gte('scheduled_at', startOfDay.toISOString())
                    .lte('scheduled_at', endOfDay.toISOString())
                    .order('scheduled_at', { ascending: true }),

                db()
                    .from('contacts')
                    .select('id', { count: 'exact', head: true })
                    .eq('company_id', companyId)
                    .neq('status', 'staff')
                    .gte('created_at', startOfDay.toISOString()),

                db()
                    .from('conversations')
                    .select(`
                        id, escalation_reason, escalated_at,
                        contact:contacts (name, phone)
                    `)
                    .eq('company_id', companyId)
                    .eq('status', 'escalated')
                    .order('escalated_at', { ascending: false })
                    .limit(10),

                db()
                    .from('follow_ups')
                    .select('id', { count: 'exact', head: true })
                    .eq('company_id', companyId)
                    .eq('status', 'pending')
                    .lte('scheduled_at', nowUtc.toISOString()),
            ]);

            return {
                todayAppointments: (appts.data as any[]) || [],
                newLeadsToday: (newLeads as any).count ?? 0,
                escalatedConversations: (escalated.data as any[]) || [],
                pendingFollowUps: (followUps as any).count ?? 0,
            };
        } catch (error) {
            logger.error(`[Clinicas] getDailySummary: ${(error as Error).message}`);
            return {
                todayAppointments: [],
                newLeadsToday: 0,
                escalatedConversations: [],
                pendingFollowUps: 0,
            };
        }
    }

    // ─── Google Calendar ───────────────────────────────────────────────────────

    /**
     * Retorna TODOS los calendarios de Google Calendar activos de una clínica.
     * Permite multi-calendario: una fila por profesional/sala/recurso.
     */
    static async getGCalConfigs(companyId: string): Promise<GCalConfig[]> {
        try {
            const { data, error } = await db()
                .from('gcal_config')
                .select('calendar_id, work_start, work_end, work_days, default_slot_min, staff_name, staff_specialty, staff_id')
                .eq('company_id', companyId)
                .eq('active', true);

            if (error || !data || (data as any[]).length === 0) return [];

            const company = await this.getCompanyById(companyId);
            const timezone = company?.timezone || 'America/Bogota';

            return (data as any[]).map(row => ({
                calendarId: row.calendar_id,
                workStart: row.work_start,
                workEnd: row.work_end,
                workDays: row.work_days,
                defaultSlotMin: row.default_slot_min,
                timezone,
                staffName: row.staff_name || '',
                staffSpecialty: row.staff_specialty || '',
                staffId: row.staff_id || null,
            }));
        } catch (error) {
            logger.error(`[Clinicas] getGCalConfigs: ${(error as Error).message}`);
            return [];
        }
    }

    /**
     * Obtiene la configuración de Google Calendar de una clínica.
     * Retorna null si la clínica no tiene GCal configurado o está inactivo.
     * @deprecated Usa getGCalConfigs() para soporte multi-calendario.
     */
    static async getGCalConfig(companyId: string): Promise<GCalConfig | null> {
        const configs = await this.getGCalConfigs(companyId);
        return configs[0] ?? null;
    }

    /**
     * Busca la configuración de un calendario específico por su calendarId.
     * Usado al cancelar/reprogramar citas en entornos multi-calendario.
     */
    static async getGCalConfigByCalendarId(
        companyId: string,
        calendarId: string
    ): Promise<GCalConfig | null> {
        const configs = await this.getGCalConfigs(companyId);
        return configs.find(c => c.calendarId === calendarId) ?? null;
    }

    /**
     * Crea o actualiza la fila de gcal_config para un miembro del staff.
     * Se llama automáticamente al completar el flujo OAuth.
     *
     * calendar_id = 'primary' porque el token OAuth ya apunta al calendario
     * principal del staff; no se necesita un ID explícito.
     *
     * El horario laboral (work_start/end/days) se inicializa con valores por
     * defecto razonables. El admin puede ajustarlos después si es necesario.
     *
     * El upsert usa staff_id como clave de conflicto para que re-conectar el
     * OAuth no genere filas duplicadas.
     */
    static async upsertStaffGCalConfig(staffId: string, companyId: string): Promise<void> {
        try {
            // Leer nombre y especialidad del staff para pre-llenar gcal_config
            const { data: staffRow } = await db()
                .from('staff')
                .select('name, specialty')
                .eq('id', staffId)
                .maybeSingle();

            const staffName      = (staffRow as any)?.name      || '';
            const staffSpecialty = (staffRow as any)?.specialty || '';

            const { error } = await db()
                .from('gcal_config')
                .upsert(
                    {
                        company_id:       companyId,
                        staff_id:         staffId,
                        calendar_id:      'primary',
                        work_start:       '09:00',
                        work_end:         '18:00',
                        work_days:        [1, 2, 3, 4, 5],
                        default_slot_min: 60,
                        staff_name:       staffName,
                        staff_specialty:  staffSpecialty,
                        active:           true,
                    },
                    { onConflict: 'staff_id' }
                );

            if (error) throw error;
            logger.info(`[Clinicas] gcal_config upserted para staff ${staffId} (${staffName})`);
        } catch (error) {
            logger.error(`[Clinicas] upsertStaffGCalConfig: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Lookup de una clínica por ID. Helper interno para obtener timezone.
     */
    static async getCompanyById(companyId: string): Promise<any | null> {
        try {
            const { data, error } = await db()
                .from('companies')
                .select('id, name, timezone')
                .eq('id', companyId)
                .maybeSingle();

            if (error || !data) return null;
            return data;
        } catch {
            return null;
        }
    }

    /**
     * Retorna slots de disponibilidad usando Google Calendar si la clínica tiene
     * GCal configurado, o la tabla availability_slots de BD como fallback.
     *
     * Si GCal está configurado pero falla con un error de red/credenciales,
     * se loggea el warning y se retorna vacío (no se hace fallback silencioso
     * a BD para evitar ofrecer slots desactualizados).
     */
    static async getFreeSlotsMerged(
        companyId: string,
        treatmentId?: string,
        slotDurationMin?: number,
        limit: number = 10
    ): Promise<{ slots: any[]; source: 'gcal' | 'db' }> {
        // Intentar GCal primero (soporta múltiples calendarios por clínica)
        // Funciona con calendarios OAuth (staff personal) y Service Account (clínica genérica)
        try {
            const gcalConfigs = await this.getGCalConfigs(companyId);

            if (gcalConfigs.length > 0) {
                const lookAhead = (env as any).GCAL_LOOK_AHEAD_DAYS || 14;

                // Consultar todos los calendarios en paralelo.
                // Para configs con staffId → obtener OAuth token y pasarlo a getAvailableSlots.
                // Para configs sin staffId → usar Service Account (requiere GOOGLE_SERVICE_ACCOUNT_JSON).
                const slotArrays = await Promise.all(
                    gcalConfigs.map(async config => {
                        const duration = slotDurationMin ?? config.defaultSlotMin;

                        let refreshToken: string | undefined;
                        if (config.staffId) {
                            const oauth = await this.getStaffOAuthTokens(config.staffId);
                            refreshToken = oauth?.refreshToken;
                        }

                        // Saltar calendarios SA si no está configurada la variable de entorno
                        if (!refreshToken && !(env as any).GOOGLE_SERVICE_ACCOUNT_JSON) {
                            logger.warn(`[Clinicas] gcal_config ${config.calendarId} sin OAuth ni SA — omitido`);
                            return [] as any[];
                        }

                        return GoogleCalendarService.getAvailableSlots(config, duration, limit, lookAhead, refreshToken);
                    })
                );

                // Mezclar, ordenar por fecha y limitar al total pedido
                const allSlots = slotArrays
                    .flat()
                    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
                    .slice(0, limit);

                if (allSlots.length > 0) {
                    logger.info(`[Clinicas] GCal slots: ${allSlots.length} (${gcalConfigs.length} calendarios, company: ${companyId})`);
                    return { slots: allSlots, source: 'gcal' };
                }
            }
        } catch (err: any) {
            logger.warn(`[Clinicas] GCal freebusy error, retornando vacío: ${err.message}`);
            return { slots: [], source: 'gcal' };
        }

        // Fallback: slots de BD (clínica sin GCal configurado)
        const dbSlots = await this.getFreeSlots(companyId, treatmentId, limit);
        return { slots: dbSlots, source: 'db' };
    }

    /**
     * Reserva una cita unificando GCal (slots con prefix "gcal_") y BD (UUID).
     *
     * - Slot GCal: crea evento en Google Calendar + INSERT en appointments sin slot_id.
     * - Slot BD: usa el RPC book_appointment() existente con locking FOR UPDATE NOWAIT.
     */
    static async bookAppointmentMerged(params: {
        companyId: string;
        contactId: string;
        slotId: string;
        treatmentId?: string;
        notes?: string;
        startsAt?: string;
        endsAt?: string;
        contactName?: string;
        contactEmail?: string;
    }): Promise<{ ok: boolean; appointment?: any; gcalEventId?: string; error?: string }> {
        const { companyId, contactId, slotId, treatmentId, notes, startsAt, endsAt, contactName, contactEmail } = params;

        // ── Slot de Google Calendar ───────────────────────────────────────────
        if (slotId.startsWith('gcal_')) {
            if (!startsAt || !endsAt) {
                return { ok: false, error: 'Para slots de GCal se requieren startsAt y endsAt' };
            }

            try {
                // Buscar el calendario específico al que pertenece este slot
                const gcalConfigs = await this.getGCalConfigs(companyId);
                const gcalConfig = gcalConfigs.find(c => slotId.includes(c.calendarId)) ?? gcalConfigs[0];
                if (!gcalConfig) {
                    return { ok: false, error: 'La clínica no tiene Google Calendar configurado' };
                }

                // Obtener OAuth token si el calendario es personal del staff
                let refreshToken: string | undefined;
                if (gcalConfig.staffId) {
                    const oauth = await this.getStaffOAuthTokens(gcalConfig.staffId);
                    refreshToken = oauth?.refreshToken;
                }

                // Crear evento en Google Calendar
                const summary = `Cita Bruno Lab — ${contactName || 'Paciente'}`;
                const description = [
                    `Contacto: ${contactName || 'Paciente'} (${contactId})`,
                    treatmentId ? `Tratamiento ID: ${treatmentId}` : '',
                    notes ? `Notas: ${notes}` : '',
                ].filter(Boolean).join('\n');

                const gcalEventId = await GoogleCalendarService.createAppointmentEvent({
                    calendarId: gcalConfig.calendarId,
                    summary,
                    description,
                    startAt: startsAt,
                    endAt: endsAt,
                    timezone: gcalConfig.timezone,
                    attendeeEmail: contactEmail,
                    refreshToken,
                });

                // Insertar en BD sin slot_id
                const { data: appointment, error: insertErr } = await db()
                    .from('appointments')
                    .insert([{
                        company_id: companyId,
                        contact_id: contactId,
                        treatment_id: treatmentId || null,
                        slot_id: null,
                        gcal_event_id: gcalEventId,
                        gcal_calendar_id: gcalConfig.calendarId,
                        scheduled_at: startsAt,
                        status: 'scheduled',
                        notes: notes || null,
                    }])
                    .select()
                    .single();

                if (insertErr) {
                    // Rollback del evento GCal
                    GoogleCalendarService.cancelAppointmentEvent(gcalConfig.calendarId, gcalEventId)
                        .catch((e: Error) => logger.warn(`[Clinicas] rollback GCal event: ${e.message}`));
                    throw insertErr;
                }

                // Actualizar status del contacto
                await db()
                    .from('contacts')
                    .update({ status: 'agendado', updated_at: new Date().toISOString() })
                    .eq('id', contactId);

                return { ok: true, appointment, gcalEventId };

            } catch (error) {
                logger.error(`[Clinicas] bookAppointmentMerged (GCal): ${(error as Error).message}`);
                return { ok: false, error: (error as Error).message };
            }
        }

        // ── Slot de BD (UUID) → flujo existente ──────────────────────────────
        try {
            const { data, error } = await (supabase as any)
                .schema('clinicas')
                .rpc('book_appointment', {
                    p_company_id: companyId,
                    p_contact_id: contactId,
                    p_slot_id: slotId,
                    p_treatment_id: treatmentId ?? null,
                    p_notes: notes ?? null,
                });

            if (error) throw error;
            return { ok: true, appointment: data };
        } catch (error) {
            logger.error(`[Clinicas] bookAppointmentMerged (BD): ${(error as Error).message}`);
            return { ok: false, error: (error as Error).message };
        }
    }

    // ─── OAuth 2.0 Google Calendar (staff) ────────────────────────────────────

    /**
     * Persiste el refresh_token y email de Google Calendar para un staff.
     * Se llama una vez tras el callback OAuth exitoso.
     * Sobrescribe tokens anteriores si el staff vuelve a autorizar.
     */
    static async saveStaffOAuthTokens(
        staffId: string,
        tokens: { refreshToken: string; email: string }
    ): Promise<void> {
        try {
            const { error } = await db()
                .from('staff')
                .update({
                    gcal_refresh_token: tokens.refreshToken,
                    gcal_email:         tokens.email,
                    gcal_connected_at:  new Date().toISOString(),
                })
                .eq('id', staffId);

            if (error) throw error;
            logger.info(`[Clinicas] OAuth tokens guardados para staff ${staffId} (${tokens.email})`);
        } catch (error) {
            logger.error(`[Clinicas] saveStaffOAuthTokens: ${(error as Error).message}`);
            throw error;
        }
    }

    /**
     * Recupera el refresh_token de Google Calendar del staff.
     * Retorna null si el staff no ha conectado su Google Calendar.
     */
    static async getStaffOAuthTokens(
        staffId: string
    ): Promise<{ refreshToken: string; email: string } | null> {
        try {
            const { data, error } = await db()
                .from('staff')
                .select('gcal_refresh_token, gcal_email')
                .eq('id', staffId)
                .maybeSingle();

            if (error) throw error;
            if (!data || !(data as any).gcal_refresh_token) return null;

            return {
                refreshToken: (data as any).gcal_refresh_token,
                email:        (data as any).gcal_email || '',
            };
        } catch (error) {
            logger.error(`[Clinicas] getStaffOAuthTokens: ${(error as Error).message}`);
            return null;
        }
    }
}
