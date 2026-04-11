// =============================================================================
// PromptRebuildService
//
// Orquesta la recompilación de agents.system_prompt:
//   1. Carga los datos desde la BD  (ClinicasDbService.getPromptCompilerData)
//   2. Compila el prompt             (buildSystemPrompt)
//   3. Guarda el resultado en BD     (ClinicasDbService.saveCompiledPrompt)
//
// Expone dos funciones:
//   - rebuildPromptForCompany(companyId)  → rebuild puntual para una clínica
//   - processRebuildQueue()               → procesa todas las filas pendientes
// =============================================================================

import { buildSystemPrompt }  from './prompt-compiler.service';
import { ClinicasDbService }  from './clinicas-db.service';
import { logger }             from '../utils/logger';

export class PromptRebuildService {

    /**
     * Reconstruye y persiste el system_prompt de la clínica indicada.
     *
     * Uso típico:
     *   - Al finalizar el onboarding de una clínica nueva
     *   - Desde el endpoint POST /internal/rebuild-prompt/:companyId
     *   - Desde processRebuildQueue() al procesar la cola
     */
    static async rebuildPromptForCompany(companyId: string): Promise<void> {
        logger.info(`[PromptRebuild] Iniciando rebuild para company ${companyId}`);

        const data = await ClinicasDbService.getPromptCompilerData(companyId);
        const compiled = buildSystemPrompt(data);

        await ClinicasDbService.saveCompiledPrompt(companyId, compiled);

        logger.info(
            `[PromptRebuild] Prompt compilado y guardado para "${data.company.name}" ` +
            `(${data.treatments.length} tratamientos, ${data.staff.length} staff, ` +
            `${compiled.length} chars)`
        );
    }

    /**
     * Procesa todas las filas pendientes en prompt_rebuild_queue.
     *
     * - Agrupa por company_id para evitar reconstruir la misma clínica N veces
     *   si se acumularon varios cambios antes de que el proceso corriera.
     * - Marca cada fila como procesada (con timestamp o con error).
     * - No lanza excepciones: errores individuales se loguean y continúan.
     *
     * Retorna la cantidad de clínicas cuyo prompt fue reconstruido.
     */
    static async processRebuildQueue(): Promise<number> {
        const pending = await ClinicasDbService.getPendingRebuildQueue(100);

        if (pending.length === 0) return 0;

        logger.info(`[PromptRebuild] Cola pendiente: ${pending.length} fila(s)`);

        // Deduplicar: si hay 5 filas para la misma company, solo rebuildeamos 1 vez
        // pero marcamos todas las filas como procesadas
        const byCompany = new Map<string, number[]>();
        for (const row of pending) {
            const ids = byCompany.get(row.company_id) ?? [];
            ids.push(row.id);
            byCompany.set(row.company_id, ids);
        }

        let rebuilt = 0;

        for (const [companyId, rowIds] of byCompany.entries()) {
            let errorMsg: string | undefined;

            try {
                await PromptRebuildService.rebuildPromptForCompany(companyId);
                rebuilt++;
            } catch (err) {
                errorMsg = (err as Error).message;
                logger.error(`[PromptRebuild] Error rebuilding company ${companyId}: ${errorMsg}`);
            }

            // Marcar todas las filas de esta company (procesadas o con error)
            await Promise.all(
                rowIds.map(id => ClinicasDbService.markRebuildProcessed(id, errorMsg))
            );
        }

        logger.info(`[PromptRebuild] Cola procesada: ${rebuilt}/${byCompany.size} clínicas reconstruidas`);
        return rebuilt;
    }
}
