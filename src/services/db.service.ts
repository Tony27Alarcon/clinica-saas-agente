import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

/**
 * Servicio de base de datos para el pipeline público (Bruno / Clara).
 *
 * Trabaja con el schema `public` de Supabase (no `clinicas`).
 * El service_role bypasea RLS automáticamente.
 *
 * Tablas usadas:
 *   contactos, conversaciones, mensajes, agentes,
 *   media_assets, biblioteca_multimedia, notas_contacto,
 *   usuarios (comerciales), notificaciones.
 */
export class DbService {
    /**
     * Normaliza un teléfono a solo dígitos para comparación.
     * Misma lógica que `env.ts` para evitar dependencias circulares.
     */
    static normalizePhone(phone: string): string {
        return phone.replace(/\D+/g, '');
    }

    // =========================================================================
    // CONTACTOS
    // =========================================================================

    /**
     * Busca o crea un contacto por teléfono.
     * Si ya existe, lo retorna sin modificar.
     */
    static async getOrCreateContacto(phone: string, name: string): Promise<any> {
        try {
            const { data: existing } = await supabase
                .from('contactos')
                .select('*')
                .eq('telefono', phone)
                .maybeSingle();

            if (existing) return existing;

            const displayName = name?.trim()
                ? `${name.trim()} *No confirmado`
                : 'Desconocido *No confirmado';

            const { data, error } = await supabase
                .from('contactos')
                .insert([{ telefono: phone, nombre: displayName, temperatura: 'frio' }])
                .select()
                .single();

            if (error) throw error;
            return data;
        } catch (err) {
            logger.error(`DbService.getOrCreateContacto: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Elimina un contacto por teléfono.
     * ON DELETE CASCADE borra sus conversaciones y mensajes asociados.
     */
    static async deleteContacto(phone: string): Promise<void> {
        try {
            const { error } = await supabase
                .from('contactos')
                .delete()
                .eq('telefono', phone);

            if (error) throw error;
        } catch (err) {
            logger.error(`DbService.deleteContacto: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Actualiza campos del contacto (nombre, temperatura, nota, etc.).
     * Llamado por la tool updateContactProfile del agente.
     */
    static async updateContacto(
        contactoId: number,
        updates: Record<string, any>
    ): Promise<void> {
        try {
            const { error } = await supabase
                .from('contactos')
                .update({ ...updates, updated_at: new Date().toISOString() })
                .eq('id', contactoId);

            if (error) throw error;
        } catch (err) {
            logger.error(`DbService.updateContacto: ${(err as Error).message}`);
            throw err;
        }
    }

    // =========================================================================
    // CONVERSACIONES
    // =========================================================================

    /**
     * Busca la conversación abierta de un contacto, o crea una nueva.
     * El agente activo se busca por nombre (case-insensitive).
     * Retorna `{ conversacion, agente }`.
     */
    static async getOrCreateConversacion(
        contactoId: number,
        agenteName: string
    ): Promise<{ conversacion: any; agente: any }> {
        try {
            // Agente activo por nombre
            const { data: agente, error: agenteError } = await supabase
                .from('agentes')
                .select('*')
                .ilike('nombre', agenteName)
                .eq('active', true)
                .maybeSingle();

            if (agenteError) throw agenteError;
            if (!agente) throw new Error(`No hay agente activo con nombre "${agenteName}"`);

            // Conversación abierta del contacto
            const { data: existing } = await supabase
                .from('conversaciones')
                .select('*')
                .eq('contacto_id', contactoId)
                .eq('status', 'open')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (existing) return { conversacion: existing, agente };

            // Crear nueva conversación
            const { data: newConv, error } = await supabase
                .from('conversaciones')
                .insert([{
                    contacto_id: contactoId,
                    agente_id: agente.id,
                    status: 'open',
                }])
                .select()
                .single();

            if (error) throw error;
            return { conversacion: newConv, agente };
        } catch (err) {
            logger.error(`DbService.getOrCreateConversacion: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Asigna un comercial (user_id) a una conversación.
     * Llamado por la tool assignCommercial.
     */
    static async assignCommercialToConversacion(
        conversacionId: number,
        userId: string
    ): Promise<void> {
        try {
            const { error } = await supabase
                .from('conversaciones')
                .update({ user_id: userId, updated_at: new Date().toISOString() })
                .eq('id', conversacionId);

            if (error) throw error;
        } catch (err) {
            logger.error(`DbService.assignCommercialToConversacion: ${(err as Error).message}`);
            throw err;
        }
    }

    // =========================================================================
    // MENSAJES
    // =========================================================================

    /**
     * Guarda un mensaje en la conversación.
     */
    static async saveMensaje(
        conversacionId: number,
        contenido: string,
        rol: 'contacto' | 'agente' | 'sistema',
        metadata: Record<string, any> = {}
    ): Promise<void> {
        try {
            const { error } = await supabase
                .from('mensajes')
                .insert([{ conversacion_id: conversacionId, contenido, rol, metadata }]);

            if (error) throw error;
        } catch (err) {
            logger.error(`DbService.saveMensaje: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Recupera el historial de mensajes formateado para el AI SDK.
     * Excluye mensajes tipo 'sistema'. Orden cronológico ascendente.
     */
    static async getHistorialMensajes(
        conversacionId: number,
        limit: number = 25
    ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
        try {
            const { data, error } = await supabase
                .from('mensajes')
                .select('rol, contenido, created_at')
                .eq('conversacion_id', conversacionId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;

            return ((data || []) as any[])
                .reverse()
                .filter((m: any) => m.rol === 'contacto' || m.rol === 'agente')
                .map((m: any) => ({
                    role: m.rol === 'contacto' ? 'user' : 'assistant',
                    content: m.contenido || (m.rol === 'agente' ? '...' : '[mensaje vacío]'),
                }));
        } catch (err) {
            logger.error(`DbService.getHistorialMensajes: ${(err as Error).message}`);
            return [];
        }
    }

    // =========================================================================
    // MEDIA
    // =========================================================================

    /**
     * Retorna los últimos archivos multimedia intercambiados con un contacto.
     */
    static async getUltimosMedia(contactoId: number, limit: number = 5): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('media_assets')
                .select('kind, rol, descripcion_ia, created_at, url_publica')
                .eq('contacto_id', contactoId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;
            return data || [];
        } catch (err) {
            logger.error(`DbService.getUltimosMedia: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Retorna la biblioteca de recursos multimedia activos.
     * El agente los usa para enviar materiales de valor proactivamente.
     */
    static async getBibliotecaMultimedia(): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('biblioteca_multimedia')
                .select('nombre, tipo, url, categoria, tags, instruccion_uso')
                .eq('active', true)
                .order('categoria', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (err) {
            logger.error(`DbService.getBibliotecaMultimedia: ${(err as Error).message}`);
            return [];
        }
    }

    // =========================================================================
    // NOTAS Y CRM
    // =========================================================================

    /**
     * Retorna las notas del CRM para un contacto.
     */
    static async getNotasContacto(contactoId: number, limit: number = 5): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('notas_contacto')
                .select('created_at, titulo, nota')
                .eq('contacto_id', contactoId)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;
            return data || [];
        } catch (err) {
            logger.error(`DbService.getNotasContacto: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Agrega una nota al CRM del contacto.
     * Llamado por la tool createContactNote.
     */
    static async addNotaContacto(
        contactoId: number,
        titulo: string,
        nota: string
    ): Promise<void> {
        try {
            const { error } = await supabase
                .from('notas_contacto')
                .insert([{ contacto_id: contactoId, titulo, nota }]);

            if (error) throw error;
        } catch (err) {
            logger.error(`DbService.addNotaContacto: ${(err as Error).message}`);
            throw err;
        }
    }

    // =========================================================================
    // COMERCIALES
    // =========================================================================

    /**
     * Retorna los comerciales activos con sus datos para handoff.
     * El AI los recibe como lista con código corto [CXXXXX] en el system prompt.
     */
    static async getComercialesActivos(): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('usuarios')
                .select('id, codigo, full_name, zona_comercial')
                .eq('active', true)
                .order('full_name', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (err) {
            logger.error(`DbService.getComercialesActivos: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Busca un comercial por su teléfono normalizado.
     * Retorna null si el número no corresponde a ningún comercial activo.
     * Se llama desde el webhook para detectar si quien escribe es del equipo.
     */
    static async findComercialByPhone(
        phone: string
    ): Promise<{ id: string; full_name: string; phone: string } | null> {
        try {
            const normalized = DbService.normalizePhone(phone);

            const { data, error } = await supabase
                .from('usuarios')
                .select('id, full_name, phone')
                .eq('active', true);

            if (error) throw error;
            if (!data) return null;

            // Comparación normalizada en JS (evita lógica de normalización en SQL)
            return (data as any[]).find((u) => {
                const uNorm = DbService.normalizePhone(u.phone || '');
                return uNorm && uNorm === normalized;
            }) ?? null;
        } catch (err) {
            logger.error(`DbService.findComercialByPhone: ${(err as Error).message}`);
            return null;
        }
    }

    /**
     * Busca un comercial por su ID (UUID).
     * Usado por la tool assignCommercial para obtener el teléfono al notificar.
     */
    static async getComercialById(
        userId: string
    ): Promise<{ id: string; full_name: string; phone: string } | null> {
        try {
            const { data, error } = await supabase
                .from('usuarios')
                .select('id, full_name, phone')
                .eq('id', userId)
                .maybeSingle();

            if (error) throw error;
            return data || null;
        } catch (err) {
            logger.error(`DbService.getComercialById: ${(err as Error).message}`);
            return null;
        }
    }

    // =========================================================================
    // NOTIFICACIONES (outbox para comerciales y soporte)
    // =========================================================================

    /**
     * Retorna notificaciones WA pendientes para un comercial.
     * Se llama desde el webhook cuando el comercial escribe (ventana de 24h abierta).
     */
    static async getNotificacionesWaPendientes(userId: string): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('notificaciones')
                .select('id, contenido')
                .eq('user_id', userId)
                .eq('wa_estado', 'pendiente')
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (err) {
            logger.error(`DbService.getNotificacionesWaPendientes: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Retorna notificaciones de soporte pendientes para el número de soporte.
     * Se llama cuando el equipo de soporte escribe al WA Business.
     */
    static async getNotificacionesSoportePendientes(
        destinatarioPhone: string
    ): Promise<any[]> {
        try {
            const { data, error } = await supabase
                .from('notificaciones')
                .select('id, contenido')
                .eq('destinatario_phone', destinatarioPhone)
                .eq('wa_estado', 'pendiente')
                .order('created_at', { ascending: true });

            if (error) throw error;
            return data || [];
        } catch (err) {
            logger.error(`DbService.getNotificacionesSoportePendientes: ${(err as Error).message}`);
            return [];
        }
    }
}
