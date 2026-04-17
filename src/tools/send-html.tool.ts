import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { KapsoService } from '../services/kapso.service';
import { MediaService } from '../services/media.service';

/**
 * Tool: sendHtmlDocument
 *
 * Permite al agente redactar un archivo HTML y enviarlo al usuario por WhatsApp
 * como documento adjunto (.html). El flujo:
 *   1. Recibe el contenido HTML generado por el LLM.
 *   2. Lo sube al bucket público de Supabase (`mensajes`) bajo la carpeta `html/<folder>`.
 *   3. Envía el link resultante vía Kapso usando `sendDocument`.
 *
 * @param phoneNumberId   phoneNumberId del canal WA desde closure.
 * @param telefono        Destinatario en E.164 sin "+".
 * @param folderHint      Carpeta lógica para organizar los archivos (ej: companyId o contactId).
 */
export const createSendHtmlDocumentTool = (
    phoneNumberId: string,
    telefono: string,
    folderHint: string = 'general'
) => {
    return tool({
        description:
            'Envía un archivo HTML al usuario por WhatsApp como documento adjunto. ' +
            'Usa esta tool cuando necesites entregar contenido enriquecido (resúmenes, reportes, ' +
            'confirmaciones, plantillas) que se verán mejor al abrir el archivo en un navegador. ' +
            'Tú escribes el HTML completo (incluye <!DOCTYPE html>, <html>, <head> con estilos inline, y <body>).',

        inputSchema: z.object({
            html: z
                .string()
                .min(20)
                .describe(
                    'Contenido HTML completo del archivo. Debe ser HTML válido y autocontenido ' +
                    '(estilos inline o <style> dentro del <head>, sin dependencias externas). ' +
                    'Usa UTF-8 y escapa caracteres especiales correctamente.'
                ),

            filename: z
                .string()
                .min(1)
                .max(80)
                .describe(
                    'Nombre del archivo que verá el usuario, sin ruta. Puede incluir o no la extensión .html; ' +
                    'si no la incluye se añade automáticamente. Ej: "resumen-cita" o "factura-oct.html".'
                ),

            caption: z
                .string()
                .max(1024)
                .optional()
                .describe('Texto corto que acompaña al archivo en WhatsApp (opcional).'),
        }),

        execute: async ({ html, filename, caption }) => {
            try {
                const safeFilename = filename.toLowerCase().endsWith('.html')
                    ? filename
                    : `${filename}.html`;

                const buffer = Buffer.from(html, 'utf-8');
                const folder = `html/${folderHint}`;

                const publicUrl = await MediaService.uploadToSupabase(
                    buffer,
                    'text/html; charset=utf-8',
                    'html',
                    folder
                );

                if (!publicUrl) {
                    return { ok: false, error: 'No se pudo subir el HTML a storage.' };
                }

                await KapsoService.enviarDocumento(
                    telefono,
                    { link: publicUrl, filename: safeFilename, caption },
                    phoneNumberId
                );

                logger.info(
                    `[Tool] sendHtmlDocument → ${telefono} | ${safeFilename} (${buffer.length} bytes) | ${publicUrl}`
                );

                return { ok: true, url: publicUrl, filename: safeFilename, bytes: buffer.length };
            } catch (err: any) {
                logger.error(`[Tool] sendHtmlDocument error: ${err.message}`);
                return { ok: false, error: err.message };
            }
        },
    });
};
