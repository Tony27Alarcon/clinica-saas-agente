// =============================================================================
// CompanySkillsService — gestión de skills configurables por empresa
//
// Combina:
//   - Catálogo global de skills 'system' (src/skills/system-patient-skills.ts)
//   - Toggles por empresa (clinicas.company_skills.enabled, kind='system')
//   - Skills 'private' creadas por la empresa con contenido propio
//
// REGLAS de inyección en el system prompt:
//   1. buildBaseAgentSkills() siempre va primero (no editable).
//   2. Skills 'system' activas (default true si no hay row) — globales.
//   3. Skills 'private' activas — específicas de la empresa.
//   4. Las skills NUNCA pueden contradecir las REGLAS FUNDAMENTALES.
//      El recordatorio explícito vive en buildCompanySkillsSection().
// =============================================================================

import { supabase } from '../config/supabase';
import { logger }   from '../utils/logger';
import {
    SYSTEM_PATIENT_SKILLS,
    SYSTEM_PATIENT_SKILL_INDEX,
    PatientSkill,
} from '../skills';

const db = () => (supabase as any).schema('clinicas');

// ─── Tipos públicos ─────────────────────────────────────────────────────────

export type SkillKind = 'system' | 'private';

export interface CompanySkillView {
    id?:          string;     // uuid de la row (sólo si existe)
    kind:         SkillKind;
    skill_id:     string;
    name:         string;
    trigger:      string;
    guidelines:   string;
    enabled:      boolean;
    can_edit:     boolean;    // true para 'private', false para 'system'
    can_delete:   boolean;    // true para 'private'
    updated_at?:  string;
}

export interface CreatePrivateSkillInput {
    skill_id:    string;
    name:        string;
    trigger:     string;
    guidelines:  string;
    enabled?:    boolean;
    created_by?: string;
}

export interface UpdatePrivateSkillInput {
    name?:        string;
    trigger?:     string;
    guidelines?:  string;
    enabled?:     boolean;
}

// ─── Validación de skills privadas (Protocolo) ──────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function validateSkillId(skillId: string): string | null {
    if (!skillId || !SLUG_RE.test(skillId)) {
        return 'skill_id debe ser slug lowercase: a-z, 0-9, guiones (2-64 chars).';
    }
    if (SYSTEM_PATIENT_SKILL_INDEX[skillId]) {
        return `skill_id "${skillId}" colisiona con una skill de sistema. Usá otro identificador.`;
    }
    return null;
}

function validatePrivateContent(payload: { name?: string; trigger?: string; guidelines?: string }): string | null {
    if (!payload.name?.trim())     return 'name es obligatorio.';
    if (!payload.trigger?.trim())  return 'trigger es obligatorio (cuándo activar la skill).';
    const g = payload.guidelines?.trim();
    if (!g || g.length < 30)       return 'guidelines es obligatorio (mínimo 30 chars de instrucciones).';
    return null;
}

// ─── Servicio ───────────────────────────────────────────────────────────────

export class CompanySkillsService {

    /**
     * Lista combinada (system + private) con su estado actual para una empresa.
     * Útil para la UI de toggles.
     */
    static async listForCompany(companyId: string): Promise<CompanySkillView[]> {
        const { data, error } = await db()
            .from('company_skills')
            .select('id, kind, skill_id, name, trigger, guidelines, enabled, updated_at')
            .eq('company_id', companyId);

        if (error) throw new Error(`[company-skills] list: ${error.message}`);

        const rowsBySkillId = new Map<string, any>();
        const privates: CompanySkillView[] = [];

        for (const row of (data ?? [])) {
            const key = `${row.kind}:${row.skill_id}`;
            rowsBySkillId.set(key, row);
            if (row.kind === 'private') {
                privates.push({
                    id:         row.id,
                    kind:       'private',
                    skill_id:   row.skill_id,
                    name:       row.name,
                    trigger:    row.trigger,
                    guidelines: row.guidelines,
                    enabled:    row.enabled,
                    can_edit:   true,
                    can_delete: true,
                    updated_at: row.updated_at,
                });
            }
        }

        // Para cada skill de sistema mostramos el catálogo + estado actual
        const systems: CompanySkillView[] = SYSTEM_PATIENT_SKILLS.map(s => {
            const row = rowsBySkillId.get(`system:${s.id}`);
            return {
                id:         row?.id,
                kind:       'system' as const,
                skill_id:   s.id,
                name:       s.name,
                trigger:    s.trigger,
                guidelines: s.guidelines,
                enabled:    row ? !!row.enabled : true,   // default: activa
                can_edit:   false,
                can_delete: false,
                updated_at: row?.updated_at,
            };
        });

        return [...systems, ...privates];
    }

    /**
     * Devuelve solo las skills ACTIVAS resueltas a su contenido final.
     * Llamado desde getPromptCompilerData para inyectar en el prompt.
     */
    static async getActiveSkillsForPrompt(companyId: string): Promise<PatientSkill[]> {
        const { data, error } = await db()
            .from('company_skills')
            .select('kind, skill_id, name, trigger, guidelines, enabled')
            .eq('company_id', companyId);

        if (error) {
            logger.warn(`[company-skills] getActive failed for ${companyId}: ${error.message}. Falling back to all system skills.`);
            return [...SYSTEM_PATIENT_SKILLS];
        }

        const rows = data ?? [];
        const disabledSystem = new Set(
            rows.filter((r: any) => r.kind === 'system' && r.enabled === false).map((r: any) => r.skill_id)
        );

        const activeSystem: PatientSkill[] = SYSTEM_PATIENT_SKILLS.filter(s => !disabledSystem.has(s.id));

        const activePrivate: PatientSkill[] = rows
            .filter((r: any) => r.kind === 'private' && r.enabled)
            .map((r: any) => ({
                id:         r.skill_id,
                name:       r.name,
                trigger:    r.trigger,
                guidelines: r.guidelines,
            }));

        return [...activeSystem, ...activePrivate];
    }

    /**
     * Activa o desactiva una skill (system o private). Para system, hace upsert.
     */
    static async setEnabled(companyId: string, kind: SkillKind, skillId: string, enabled: boolean): Promise<void> {
        if (kind === 'system' && !SYSTEM_PATIENT_SKILL_INDEX[skillId]) {
            throw new Error(`Skill de sistema "${skillId}" no existe en el catálogo.`);
        }

        if (kind === 'system') {
            // upsert: para system solo persistimos cuando hay un toggle distinto al default (true)
            const { error } = await db()
                .from('company_skills')
                .upsert(
                    { company_id: companyId, kind, skill_id: skillId, enabled },
                    { onConflict: 'company_id,kind,skill_id' }
                );
            if (error) throw new Error(`[company-skills] setEnabled system: ${error.message}`);
            return;
        }

        const { data, error } = await db()
            .from('company_skills')
            .update({ enabled })
            .eq('company_id', companyId)
            .eq('kind', 'private')
            .eq('skill_id', skillId)
            .select('id')
            .maybeSingle();
        if (error) throw new Error(`[company-skills] setEnabled private: ${error.message}`);
        if (!data) throw new Error(`Skill privada "${skillId}" no encontrada.`);
    }

    /**
     * Crea una skill privada con validación del protocolo.
     */
    static async createPrivate(companyId: string, payload: CreatePrivateSkillInput): Promise<CompanySkillView> {
        const idErr = validateSkillId(payload.skill_id);
        if (idErr) throw new Error(idErr);
        const contentErr = validatePrivateContent(payload);
        if (contentErr) throw new Error(contentErr);

        const { data, error } = await db()
            .from('company_skills')
            .insert({
                company_id: companyId,
                kind:       'private',
                skill_id:   payload.skill_id.trim(),
                name:       payload.name.trim(),
                trigger:    payload.trigger.trim(),
                guidelines: payload.guidelines.trim(),
                enabled:    payload.enabled ?? true,
                created_by: payload.created_by ?? null,
            })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') throw new Error(`Ya existe una skill privada con id "${payload.skill_id}".`);
            throw new Error(`[company-skills] create: ${error.message}`);
        }

        return {
            id:         data.id,
            kind:       'private',
            skill_id:   data.skill_id,
            name:       data.name,
            trigger:    data.trigger,
            guidelines: data.guidelines,
            enabled:    data.enabled,
            can_edit:   true,
            can_delete: true,
            updated_at: data.updated_at,
        };
    }

    /**
     * Actualiza contenido o estado de una skill privada.
     */
    static async updatePrivate(companyId: string, skillId: string, payload: UpdatePrivateSkillInput): Promise<void> {
        // Cargamos para validar contenido resultante
        const { data: existing, error: selErr } = await db()
            .from('company_skills')
            .select('name, trigger, guidelines')
            .eq('company_id', companyId).eq('kind', 'private').eq('skill_id', skillId)
            .maybeSingle();
        if (selErr) throw new Error(`[company-skills] update select: ${selErr.message}`);
        if (!existing) throw new Error(`Skill privada "${skillId}" no encontrada.`);

        const merged = {
            name:       payload.name       ?? existing.name,
            trigger:    payload.trigger    ?? existing.trigger,
            guidelines: payload.guidelines ?? existing.guidelines,
        };
        const contentErr = validatePrivateContent(merged);
        if (contentErr) throw new Error(contentErr);

        const updates: Record<string, any> = {};
        if (payload.name       !== undefined) updates.name       = merged.name.trim();
        if (payload.trigger    !== undefined) updates.trigger    = merged.trigger.trim();
        if (payload.guidelines !== undefined) updates.guidelines = merged.guidelines.trim();
        if (payload.enabled    !== undefined) updates.enabled    = payload.enabled;

        if (Object.keys(updates).length === 0) return;

        const { error } = await db()
            .from('company_skills')
            .update(updates)
            .eq('company_id', companyId).eq('kind', 'private').eq('skill_id', skillId);
        if (error) throw new Error(`[company-skills] update: ${error.message}`);
    }

    /**
     * Elimina una skill privada. Las 'system' no se pueden borrar (solo toggle).
     */
    static async deletePrivate(companyId: string, skillId: string): Promise<void> {
        const { error } = await db()
            .from('company_skills')
            .delete()
            .eq('company_id', companyId).eq('kind', 'private').eq('skill_id', skillId);
        if (error) throw new Error(`[company-skills] delete: ${error.message}`);
    }
}
