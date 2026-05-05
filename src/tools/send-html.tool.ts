import { tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { KapsoService } from '../services/kapso.service';
import { MediaService } from '../services/media.service';

/**
 * Sanitiza HTML antes de subirlo. Quita vectores de script y handlers de eventos
 * inline. No es un sanitizer industrial (DOMPurify) — es un guardarraíl mínimo:
 * el LLM emite HTML que será visto por el paciente al abrir el adjunto, así que
 * no queremos que un prompt injection bote JS arbitrario.
 *
 * Quita:
 *   - `<script>...</script>` (bloques completos)
 *   - `<iframe>...</iframe>` y otros embebibles ejecutables
 *   - `on*="..."` / `on*='...'` (handlers inline: onclick, onerror, onload, …)
 *   - `javascript:` y `data:text/html` en hrefs/src
 */
export function sanitizeHtmlForUpload(html: string): { html: string; stripped: string[] } {
    const stripped: string[] = [];
    let out = html;

    const scriptRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
    if (scriptRe.test(out)) {
        stripped.push('script');
        out = out.replace(scriptRe, '');
    }

    const iframeRe = /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi;
    if (iframeRe.test(out)) {
        stripped.push('iframe');
        out = out.replace(iframeRe, '');
    }

    const objectRe = /<(object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
    if (objectRe.test(out)) {
        stripped.push('object/embed');
        out = out.replace(objectRe, '');
    }

    const onAttrRe = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
    if (onAttrRe.test(out)) {
        stripped.push('on*-handlers');
        out = out.replace(onAttrRe, '');
    }

    const jsUrlRe = /(href|src|action)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|"data:text\/html[^"]*"|'data:text\/html[^']*')/gi;
    if (jsUrlRe.test(out)) {
        stripped.push('js-url');
        out = out.replace(jsUrlRe, '$1="#"');
    }

    return { html: out, stripped };
}

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

                const { html: safeHtml, stripped } = sanitizeHtmlForUpload(html);
                if (stripped.length > 0) {
                    logger.warn(
                        `[Tool] sendHtmlDocument: sanitización quitó ${stripped.join(', ')} antes de subir`
                    );
                }
                const buffer = Buffer.from(safeHtml, 'utf-8');
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
