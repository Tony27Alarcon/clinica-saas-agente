// =============================================================================
// API Skills configurables — operaciones por skill
//
// PATCH  /api/admin/[companyId]/skills/[skillId]?kind=system|private
//        body: { enabled?, name?, trigger?, guidelines? }
//        - system → solo se acepta { enabled }
//        - private → cualquier campo permitido
//
// DELETE /api/admin/[companyId]/skills/[skillId]?kind=private
//        Solo skills privadas pueden borrarse. Para system, usar PATCH enabled=false.
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

import { SYSTEM_PATIENT_SKILL_INDEX } from '@/lib/skills-catalog';
import { requireAdmin } from '@/lib/auth';

function db() {
    return (createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_KEY!,
        { auth: { persistSession: false } }
    ) as any).schema('clinicas');
}

function triggerRebuild(companyId: string) {
    const backendUrl = process.env.BACKEND_INTERNAL_URL;
    const secret = process.env.INTERNAL_API_SECRET;
    if (backendUrl && secret) {
        fetch(`${backendUrl}/internal/rebuild-prompt/${companyId}`, {
            method: 'POST',
            headers: { 'x-internal-secret': secret },
        }).catch(() => {});
    }
}

function parseKind(req: NextRequest): 'system' | 'private' | null {
    const k = req.nextUrl.searchParams.get('kind');
    return k === 'system' || k === 'private' ? k : null;
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string; skillId: string }> }
) {
    const { companyId, skillId } = await params;
    const kind = parseKind(req);
    if (!kind) return NextResponse.json({ error: 'query param "kind" requerido (system|private)' }, { status: 400 });

    // Toggles y edición restringidos al admin de la empresa.
    const auth = requireAdmin(req, companyId);
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => ({}));

    if (kind === 'system') {
        if (!SYSTEM_PATIENT_SKILL_INDEX[skillId]) {
            return NextResponse.json({ error: `Skill de sistema "${skillId}" no existe.` }, { status: 404 });
        }
        if (typeof body.enabled !== 'boolean') {
            return NextResponse.json({ error: 'Para system solo se acepta { enabled: boolean }.' }, { status: 400 });
        }

        const { error } = await db()
            .from('company_skills')
            .upsert(
                { company_id: companyId, kind: 'system', skill_id: skillId, enabled: body.enabled },
                { onConflict: 'company_id,kind,skill_id' }
            );
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        triggerRebuild(companyId);
        return NextResponse.json({ ok: true, kind, skill_id: skillId, enabled: body.enabled });
    }

    // ── private: validar contenido si viene ──────────────────────────────────
    const updates: Record<string, any> = {};
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;

    if (body.name !== undefined) {
        const v = String(body.name).trim();
        if (!v) return NextResponse.json({ error: 'name no puede estar vacío.' }, { status: 400 });
        updates.name = v;
    }
    if (body.trigger !== undefined) {
        const v = String(body.trigger).trim();
        if (!v) return NextResponse.json({ error: 'trigger no puede estar vacío.' }, { status: 400 });
        updates.trigger = v;
    }
    if (body.guidelines !== undefined) {
        const v = String(body.guidelines).trim();
        if (v.length < 30) return NextResponse.json({ error: 'guidelines mínimo 30 chars.' }, { status: 400 });
        updates.guidelines = v;
    }

    if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Sin cambios.' }, { status: 400 });
    }

    const { data, error } = await db()
        .from('company_skills')
        .update(updates)
        .eq('company_id', companyId).eq('kind', 'private').eq('skill_id', skillId)
        .select()
        .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data)  return NextResponse.json({ error: `Skill privada "${skillId}" no encontrada.` }, { status: 404 });

    triggerRebuild(companyId);
    return NextResponse.json(data);
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string; skillId: string }> }
) {
    const { companyId, skillId } = await params;
    const kind = parseKind(req);
    if (kind !== 'private') {
        return NextResponse.json({ error: 'Solo se pueden borrar skills privadas. Para system usar PATCH enabled=false.' }, { status: 400 });
    }

    const auth = requireAdmin(req, companyId);
    if (!auth.ok) return auth.response;

    const { data, error } = await db()
        .from('company_skills')
        .delete()
        .eq('company_id', companyId).eq('kind', 'private').eq('skill_id', skillId)
        .select('id')
        .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data)  return NextResponse.json({ error: `Skill privada "${skillId}" no encontrada.` }, { status: 404 });

    triggerRebuild(companyId);
    return NextResponse.json({ ok: true });
}
