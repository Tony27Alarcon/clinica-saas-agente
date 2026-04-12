import { KapsoService } from './kapso.service';
import { ClinicasDbService } from './clinicas-db.service';
import { logger } from '../utils/logger';

/**
 * Importa el historial previo de conversaciones desde Kapso cuando un
 * contacto escribe por primera vez al agente.
 *
 * Flujo:
 *  1. Consulta las conversaciones de Kapso para el número de teléfono.
 *  2. Descarga los mensajes de cada conversación.
 *  3. Los persiste en clinicas.messages usando kapso_message_id para deduplicar.
 *  4. Vincula la conversación más reciente de Kapso con la conversación local
 *     guardando el ID en conversations.kapso_conversation_id.
 *
 * El servicio es fail-safe: cualquier error se loguea pero no interrumpe
 * el pipeline principal del webhook.
 */
export class KapsoHistoryImportService {
    static async importarHistorialPrevio(
        companyId: string,
        conversationId: string,
        phone: string,
        phoneNumberId: string
    ): Promise<void> {
        try {
            logger.info(`[KapsoHistory] Importando historial para ${phone}`);

            const kapsoConversaciones = await KapsoService.listarConversacionesKapso(
                phone,
                phoneNumberId
            );

            if (!kapsoConversaciones.length) {
                logger.info(`[KapsoHistory] Sin conversaciones previas en Kapso para ${phone}`);
                return;
            }

            logger.info(`[KapsoHistory] ${kapsoConversaciones.length} conversacion(es) encontrada(s)`);

            // Ordenar de más antigua a más reciente para preservar orden cronológico
            const sortedConvs = [...kapsoConversaciones].sort(
                (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );

            // Vincular la conversación más reciente de Kapso con la nuestra
            const masReciente = sortedConvs[sortedConvs.length - 1];
            if (masReciente?.id) {
                await ClinicasDbService.updateKapsoConversationId(conversationId, masReciente.id);
            }

            let totalImportados = 0;

            for (const kapsoConv of sortedConvs) {
                const mensajes = await KapsoService.listarMensajesKapso(
                    kapsoConv.id,
                    phoneNumberId
                );

                if (!mensajes.length) continue;

                // Ordenar por timestamp Unix (string) ascendente
                const sorted = [...mensajes].sort(
                    (a, b) => parseInt(a.timestamp || '0') - parseInt(b.timestamp || '0')
                );

                for (const msg of sorted) {
                    if (!msg.id) continue;

                    const role: 'contact' | 'agent' =
                        msg.direction === 'inbound' ? 'contact' : 'agent';
                    const content = this.extractContent(msg);

                    if (!content) continue;

                    const createdAt = msg.timestamp
                        ? new Date(parseInt(msg.timestamp) * 1000).toISOString()
                        : undefined;

                    await ClinicasDbService.saveMessageDeduped(
                        conversationId,
                        companyId,
                        role,
                        content,
                        msg.id,
                        {
                            imported_from_kapso: true,
                            kapso_conversation_id: kapsoConv.id,
                            message_type: msg.type,
                        },
                        createdAt
                    );

                    totalImportados++;
                }
            }

            logger.info(
                `[KapsoHistory] Importación completa: ${totalImportados} mensaje(s) importado(s) para ${phone}`
            );
        } catch (error) {
            // Fail-safe: no propagamos para no interrumpir el pipeline principal
            logger.error(
                `[KapsoHistory] Error al importar historial para ${phone}: ${(error as Error).message}`
            );
        }
    }

    /**
     * Extrae el texto legible de un mensaje de Kapso según su tipo.
     * Los tipos sin texto se representan con un marcador descriptivo.
     */
    private static extractContent(msg: any): string {
        switch (msg.type) {
            case 'text':
                return msg.text?.body || '';
            case 'image':
                return msg.image?.caption
                    ? `[Imagen: ${msg.image.caption}]`
                    : '[Imagen]';
            case 'video':
                return msg.video?.caption
                    ? `[Video: ${msg.video.caption}]`
                    : '[Video]';
            case 'audio':
                return '[Audio]';
            case 'document':
                return msg.document?.filename
                    ? `[Documento: ${msg.document.filename}]`
                    : '[Documento]';
            case 'location':
                return msg.location?.name
                    ? `[Ubicación: ${msg.location.name}, ${msg.location.address || ''}]`.trim()
                    : '[Ubicación compartida]';
            case 'interactive':
                return (
                    msg.interactive?.button_reply?.title ||
                    msg.interactive?.list_reply?.title ||
                    '[Interactivo]'
                );
            case 'button':
                return msg.button?.text || '[Botón]';
            case 'sticker':
                return '[Sticker]';
            default:
                return '';
        }
    }
}
