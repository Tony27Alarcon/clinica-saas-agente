import { tool } from 'ai';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { DbService } from '../services/db.service';
import { KapsoService } from '../services/kapso.service';

// ============================================================================
// Helpers internos
// ============================================================================

/**
 * Guarda un marcador de mensaje interactivo/media en la tabla `mensajes`
 * del pipeline público. Solo actúa cuando `conversacionId` es un número
 * (pipeline público). Para el pipeline clínicas (UUID string), omite el
 * guardado — ClinicasDbService maneja su propio historial.
 */
async function saveMarker(
    conversacionId: number | string,
    marker: string
): Promise<void> {
    if (typeof conversacionId !== 'number') return;
    try {
        await supabase.from('mensajes').insert([{
            conversacion_id: conversacionId,
            contenido: marker,
            rol: 'agente',
            metadata: { tipo: 'marker' },
        }]);
    } catch {
        // Silencioso: el marcador es best-effort, no rompe el pipeline si falla.
    }
}

// ============================================================================
// CRM Tools
// ============================================================================

/**
 * Tool: updateContactProfile
 * Actualiza los datos del lead en la tabla `contactos`.
 * SILENCIOSA: el usuario no ve nada cuando se llama.
 */
export const createUpdateContactProfileTool = (contactoId: number) => tool({
    description:
        'Actualiza el perfil del contacto con información que descubriste en la conversación (nombre real, nivel de interés, temperatura). ' +
        'Es SILENCIOSA — siempre genera un texto de respuesta después de llamarla.',
    inputSchema: z.object({
        nombre: z
            .string()
            .optional()
            .describe('Nombre real del contacto si lo reveló en la conversación'),
        temperatura: z
            .enum(['frio', 'tibio', 'caliente'])
            .optional()
            .describe('Nivel de interés del lead'),
        nota: z
            .string()
            .optional()
            .describe('Nota libre sobre el contacto para el CRM'),
    }),
    execute: async (args) => {
        try {
            const updates: Record<string, any> = {};
            if (args.nombre)      updates.nombre = args.nombre;
            if (args.temperatura) updates.temperatura = args.temperatura;
            if (args.nota)        updates.nota = args.nota;

            if (Object.keys(updates).length === 0) {
                return { ok: false, error: 'Sin campos a actualizar' };
            }

            await DbService.updateContacto(contactoId, updates);
            logger.info(`[Tool] updateContactProfile → contactoId ${contactoId}: ${JSON.stringify(updates)}`);
            return { ok: true, updated: updates };
        } catch (err: any) {
            logger.error(`[Tool] updateContactProfile error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: createContactNote
 * Agrega una nota al CRM del contacto en `notas_contacto`.
 * SILENCIOSA: el usuario no ve nada cuando se llama.
 */
export const createCreateContactNoteTool = (contactoId: number) => tool({
    description:
        'Crea una nota interna en el CRM del contacto. Úsala para registrar información importante ' +
        '(handoff, resumen de la conversación, compromisos). Es SILENCIOSA.',
    inputSchema: z.object({
        titulo: z
            .string()
            .max(100)
            .describe('Título corto de la nota. Ej: "Interesado en producto X", "Handoff a Juan"'),
        nota: z
            .string()
            .max(1000)
            .describe('Contenido completo de la nota'),
    }),
    execute: async (args) => {
        try {
            await DbService.addNotaContacto(contactoId, args.titulo, args.nota);
            logger.info(`[Tool] createContactNote → contactoId ${contactoId}: "${args.titulo}"`);
            return { ok: true, saved: true };
        } catch (err: any) {
            logger.error(`[Tool] createContactNote error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: assignCommercialAndNotify
 * Asigna un comercial a la conversación y le envía una notificación WA.
 * SILENCIOSA: el contacto no ve nada. Usa el código [CXXXXX] del comercial.
 */
export const createAssignCommercialAndNotifyTool = (
    conversacionId: number,
    agenteId: number,
    phoneNumberId: string,
    contactoTelefono: string,
    contactoNombre: string
) => tool({
    description:
        'Asigna un comercial humano a la conversación y le envía un WhatsApp de aviso. ' +
        'Usa el código entre corchetes del comercial (ej: C9F2D). Es SILENCIOSA respecto al contacto.',
    inputSchema: z.object({
        comercialId: z
            .string()
            .describe('UUID del comercial a asignar (campo `id` de la lista de comerciales disponibles)'),
        razon: z
            .string()
            .max(200)
            .optional()
            .describe('Motivo del handoff. Ej: "Lead calificado, interesado en producto X"'),
        mensaje_comercial: z
            .string()
            .max(500)
            .optional()
            .describe('Mensaje personalizado para el comercial. Si no se pasa, se genera uno automático.'),
    }),
    execute: async (args) => {
        try {
            // 1. Asignar comercial a la conversación
            await DbService.assignCommercialToConversacion(conversacionId, args.comercialId);

            // 2. Obtener datos del comercial para notificarlo
            const comercial = await DbService.getComercialById(args.comercialId);
            if (!comercial?.phone) {
                logger.warn(`[Tool] assignCommercial: comercial ${args.comercialId} sin teléfono. Asignado pero sin notificación WA.`);
                return { ok: true, assigned: true, notified: false, reason: 'Comercial sin teléfono registrado' };
            }

            // 3. Notificar al comercial
            const mensaje = args.mensaje_comercial || [
                `🔔 *Nuevo lead asignado a ti*`,
                ``,
                `Nombre: ${contactoNombre || 'Desconocido'}`,
                `Teléfono: ${contactoTelefono}`,
                args.razon ? `Motivo: ${args.razon}` : '',
                ``,
                `El agente ya calificó al lead. Por favor da seguimiento lo antes posible.`,
            ].filter(Boolean).join('\n');

            await KapsoService.enviarMensaje(comercial.phone, mensaje, phoneNumberId);
            logger.info(`[Tool] assignCommercial → comercial ${comercial.full_name} (${args.comercialId}) asignado y notificado`);

            return { ok: true, assigned: true, notified: true, comercial: comercial.full_name };
        } catch (err: any) {
            logger.error(`[Tool] assignCommercial error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// ============================================================================
// Interactive Message Tools
// ============================================================================

/**
 * Tool: sendInteractiveButtons
 * Envía botones interactivos (Reply Buttons) de WhatsApp.
 * Máximo 3 botones. El controller descarta el texto residual tras llamar esta tool.
 */
export const createSendInteractiveButtonsTool = (
    telefono: string,
    phoneNumberId: string,
    conversacionId: number | string
) => tool({
    description:
        'Envía botones interactivos clicables de WhatsApp (máximo 3). ' +
        'Úsala SIEMPRE que quieras ofrecer opciones — NUNCA simules botones en texto plano. ' +
        'Después de llamarla NO generes texto adicional.',
    inputSchema: z.object({
        bodyText: z
            .string()
            .max(1024)
            .describe('Texto principal del mensaje que acompaña los botones'),
        botones: z
            .array(z.object({
                id: z.string().max(256).describe('ID único del botón (para identificar la respuesta)'),
                title: z.string().max(20).describe('Texto visible del botón (máx 20 caracteres)'),
            }))
            .min(1)
            .max(3)
            .describe('Lista de botones. Máximo 3.'),
        headerText: z.string().max(60).optional().describe('Texto de encabezado opcional'),
        footerText: z.string().max(60).optional().describe('Texto de pie de página opcional'),
    }),
    execute: async (args) => {
        try {
            await KapsoService.enviarInteractivos(
                telefono,
                args.bodyText,
                args.botones,
                phoneNumberId,
                {
                    header: args.headerText ? { type: 'text', text: args.headerText } : undefined,
                    footerText: args.footerText,
                }
            );

            const marker = `[[Mensaje interactivo ya enviado por WhatsApp: "${args.bodyText}" | Botones: ${args.botones.map(b => b.title).join(', ')}]]`;
            await saveMarker(conversacionId, marker);

            logger.info(`[Tool] sendInteractiveButtons → ${telefono}: "${args.bodyText}" (${args.botones.length} botones)`);
            return { ok: true, sent: true };
        } catch (err: any) {
            logger.error(`[Tool] sendInteractiveButtons error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: sendInteractiveList
 * Envía una lista interactiva de WhatsApp (menú desplegable).
 * Soporta múltiples secciones. El controller descarta texto residual tras esta tool.
 */
export const createSendInteractiveListTool = (
    telefono: string,
    phoneNumberId: string,
    conversacionId: number | string
) => tool({
    description:
        'Envía una lista interactiva (menú desplegable) de WhatsApp. ' +
        'Úsala cuando tengas más de 3 opciones o quieras agruparlas en secciones. ' +
        'Después de llamarla NO generes texto adicional.',
    inputSchema: z.object({
        bodyText: z
            .string()
            .max(1024)
            .describe('Texto principal del mensaje'),
        buttonText: z
            .string()
            .max(20)
            .describe('Texto del botón que abre la lista. Ej: "Ver opciones"'),
        sections: z
            .array(z.object({
                title: z.string().max(24).optional().describe('Título de la sección (máx 24 caracteres)'),
                rows: z.array(z.object({
                    id: z.string().max(200).describe('ID único de la fila'),
                    title: z.string().max(24).describe('Texto de la fila (máx 24 caracteres)'),
                    description: z.string().max(72).optional().describe('Descripción opcional (máx 72 caracteres)'),
                })).min(1).max(10),
            }))
            .min(1)
            .max(10)
            .describe('Secciones de la lista'),
        headerText: z.string().max(60).optional().describe('Encabezado opcional'),
        footerText: z.string().max(60).optional().describe('Pie de página opcional'),
    }),
    execute: async (args) => {
        try {
            await KapsoService.enviarListaInteractiva(
                telefono,
                args.bodyText,
                args.buttonText,
                args.sections,
                phoneNumberId,
                {
                    header: args.headerText ? { type: 'text', text: args.headerText } : undefined,
                    footerText: args.footerText,
                }
            );

            const totalRows = args.sections.reduce((acc, s) => acc + s.rows.length, 0);
            const marker = `[[Mensaje interactivo ya enviado por WhatsApp: "${args.bodyText}" | Lista con ${totalRows} opciones]]`;
            await saveMarker(conversacionId, marker);

            logger.info(`[Tool] sendInteractiveList → ${telefono}: "${args.bodyText}" (${totalRows} opciones)`);
            return { ok: true, sent: true };
        } catch (err: any) {
            logger.error(`[Tool] sendInteractiveList error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

// ============================================================================
// Media Sending Tools
// ============================================================================

/**
 * Tool: sendAudio
 * Envía un mensaje de audio vía WhatsApp.
 * Puede acompañarse de texto complementario en la respuesta del agente.
 */
export const createSendAudioTool = (
    telefono: string,
    phoneNumberId: string,
    conversacionId: number | string
) => tool({
    description:
        'Envía un archivo de audio por WhatsApp. Puedes enviar audio de voz (voice=true) ' +
        'o un archivo de audio (voice=false). Puedes agregar texto complementario en tu respuesta.',
    inputSchema: z.object({
        url: z
            .string()
            .url()
            .optional()
            .describe('URL pública del archivo de audio (OGG, MP3, AAC, M4A)'),
        mediaId: z
            .string()
            .optional()
            .describe('Media ID de WhatsApp (alternativo a url)'),
        voice: z
            .boolean()
            .optional()
            .default(false)
            .describe('true = nota de voz (OGG Opus), false = archivo de audio'),
    }).refine(d => d.url || d.mediaId, { message: 'Se requiere url o mediaId' }),
    execute: async (args) => {
        try {
            await KapsoService.enviarAudio(
                telefono,
                { link: args.url, id: args.mediaId, voice: args.voice },
                phoneNumberId
            );

            await saveMarker(conversacionId, `[[Audio enviado por WhatsApp${args.voice ? ' (nota de voz)' : ''}]]`);
            logger.info(`[Tool] sendAudio → ${telefono}${args.voice ? ' (voice)' : ''}`);
            return { ok: true, sent: true };
        } catch (err: any) {
            logger.error(`[Tool] sendAudio error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: sendImage
 * Envía una imagen vía WhatsApp con caption opcional.
 */
export const createSendImageTool = (
    telefono: string,
    phoneNumberId: string,
    conversacionId: number | string
) => tool({
    description:
        'Envía una imagen por WhatsApp. Puedes agregar un caption y texto complementario en tu respuesta.',
    inputSchema: z.object({
        url: z
            .string()
            .url()
            .optional()
            .describe('URL pública de la imagen (JPG, PNG, WEBP)'),
        mediaId: z
            .string()
            .optional()
            .describe('Media ID de WhatsApp (alternativo a url)'),
        caption: z
            .string()
            .max(1024)
            .optional()
            .describe('Texto que acompaña la imagen'),
    }).refine(d => d.url || d.mediaId, { message: 'Se requiere url o mediaId' }),
    execute: async (args) => {
        try {
            await KapsoService.enviarImagen(
                telefono,
                { link: args.url, id: args.mediaId, caption: args.caption },
                phoneNumberId
            );

            await saveMarker(conversacionId, `[[Imagen enviada por WhatsApp${args.caption ? `: "${args.caption}"` : ''}]]`);
            logger.info(`[Tool] sendImage → ${telefono}${args.caption ? ` caption: "${args.caption}"` : ''}`);
            return { ok: true, sent: true };
        } catch (err: any) {
            logger.error(`[Tool] sendImage error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: sendDocument
 * Envía un documento vía WhatsApp (PDF, DOCX, etc.) con caption y nombre de archivo opcionales.
 */
export const createSendDocumentTool = (
    telefono: string,
    phoneNumberId: string,
    conversacionId: number | string
) => tool({
    description:
        'Envía un documento por WhatsApp (PDF, DOCX, XLSX, etc.). ' +
        'Puedes agregar caption y texto complementario en tu respuesta.',
    inputSchema: z.object({
        url: z
            .string()
            .url()
            .optional()
            .describe('URL pública del documento'),
        mediaId: z
            .string()
            .optional()
            .describe('Media ID de WhatsApp (alternativo a url)'),
        caption: z
            .string()
            .max(1024)
            .optional()
            .describe('Texto que acompaña el documento'),
        filename: z
            .string()
            .max(255)
            .optional()
            .describe('Nombre del archivo que verá el receptor. Ej: "Catalogo_Productos.pdf"'),
    }).refine(d => d.url || d.mediaId, { message: 'Se requiere url o mediaId' }),
    execute: async (args) => {
        try {
            await KapsoService.enviarDocumento(
                telefono,
                { link: args.url, id: args.mediaId, caption: args.caption, filename: args.filename },
                phoneNumberId
            );

            await saveMarker(conversacionId, `[[Documento enviado por WhatsApp: "${args.filename || args.caption || 'sin nombre'}"]]`);
            logger.info(`[Tool] sendDocument → ${telefono}: "${args.filename || args.caption || 'sin nombre'}"`);
            return { ok: true, sent: true };
        } catch (err: any) {
            logger.error(`[Tool] sendDocument error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});

/**
 * Tool: sendLocation
 * Envía una ubicación geográfica vía WhatsApp.
 */
export const createSendLocationTool = (
    telefono: string,
    phoneNumberId: string,
    conversacionId: number | string
) => tool({
    description:
        'Envía una ubicación geográfica por WhatsApp (pin en el mapa). ' +
        'Puedes agregar texto complementario en tu respuesta.',
    inputSchema: z.object({
        latitude: z
            .number()
            .min(-90).max(90)
            .describe('Latitud de la ubicación'),
        longitude: z
            .number()
            .min(-180).max(180)
            .describe('Longitud de la ubicación'),
        name: z
            .string()
            .max(100)
            .optional()
            .describe('Nombre del lugar. Ej: "Oficina Principal"'),
        address: z
            .string()
            .max(200)
            .optional()
            .describe('Dirección del lugar. Ej: "Calle 100 #15-20, Bogotá"'),
    }),
    execute: async (args) => {
        try {
            await KapsoService.enviarUbicacion(
                telefono,
                {
                    latitude: args.latitude,
                    longitude: args.longitude,
                    name: args.name,
                    address: args.address,
                },
                phoneNumberId
            );

            await saveMarker(conversacionId, `[[Ubicación enviada por WhatsApp: "${args.name || `${args.latitude},${args.longitude}`}"]]`);
            logger.info(`[Tool] sendLocation → ${telefono}: "${args.name || `${args.latitude},${args.longitude}`}"`);
            return { ok: true, sent: true };
        } catch (err: any) {
            logger.error(`[Tool] sendLocation error: ${err.message}`);
            return { ok: false, error: err.message };
        }
    },
});
