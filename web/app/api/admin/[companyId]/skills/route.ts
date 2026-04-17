// =============================================================================
// API Skills configurables — listar y crear skills privadas
//
// GET  /api/admin/[companyId]/skills          → catálogo combinado (system + private)
// POST /api/admin/[companyId]/skills          → crear skill privada (rol admin)
//
// El backend que persiste y valida vive en src/services/company-skills.service.ts.
// Aquí mantenemos el patrón del proyecto: route handler Next.js → Supabase service key.
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

import { SYSTEM_PATIENT_SKILLS, SYSTEM_PATIENT_SKILL_INDEX } from '@/lib/skills-catalog';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function db() {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_KEY!;
    return (createClient(url, key, { auth: { persistSession: false } }) as any).schema('clinicas');
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

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;

    const { data, error } = await db()
        .from('company_skills')
        .select('id, kind, skill_id, name, trigger, guidelines, enabled, updated_at')
        .eq('company_id', companyId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = data ?? [];
    const indexByKey = new Map<string, any>();
    for (const r of rows) indexByKey.set(`${r.kind}:${r.skill_id}`, r);

    // Skills de sistema (catálogo + estado)
    const systems = SYSTEM_PATIENT_SKILLS.map(s => {
        const row = indexByKey.get(`system:${s.id}`);
        return {
            id:         row?.id,
            kind:       'system',
            skill_id:   s.id,
            name:       s.name,
            trigger:    s.trigger,
            guidelines: s.guidelines,
            enabled:    row ? !!row.enabled : true,
            can_edit:   false,
            can_delete: false,
            updated_at: row?.updated_at ?? null,
        };
    });

    // Skills privadas (todo el contenido en BD)
    const privates = rows
        .filter((r: any) => r.kind === 'private')
        .map((r: any) => ({
            id:         r.id,
            kind:       'private',
            skill_id:   r.skill_id,
            name:       r.name,
            trigger:    r.trigger,
            guidelines: r.guidelines,
            enabled:    r.enabled,
            can_edit:   true,
            can_delete: true,
            updated_at: r.updated_at,
        }));

    const res = NextResponse.json({ system: systems, private: privates });
    res.headers.set('Cache-Control', 'no-store');
    return res;
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;
    const body = await req.json().catch(() => ({}));

    // ── Validación del protocolo ─────────────────────────────────────────────
    const skillId    = String(body.skill_id ?? '').trim();
    const name       = String(body.name ?? '').trim();
    const trigger    = String(body.trigger ?? '').trim();
    const guidelines = String(body.guidelines ?? '').trim();

    if (!SLUG_RE.test(skillId)) {
        return NextResponse.json({ error: 'skill_id debe ser slug lowercase: a-z, 0-9, guiones (2-64 chars).' }, { status: 400 });
    }
    if (SYSTEM_PATIENT_SKILL_INDEX[skillId]) {
        return NextResponse.json({ error: `skill_id "${skillId}" colisiona con el catálogo de sistema.` }, { status: 400 });
    }
    if (!name)                  return NextResponse.json({ error: 'name es obligatorio.' },                                                       { status: 400 });
    if (!trigger)               return NextResponse.json({ error: 'trigger es obligatorio (cuándo activar la skill).' },                          { status: 400 });
    if (guidelines.length < 30) return NextResponse.json({ error: 'guidelines es obligatorio (mínimo 30 chars de instrucciones detalladas).' }, { status: 400 });

    const { data, error } = await db()
        .from('company_skills')
        .insert({
            company_id: companyId,
            kind:       'private',
            skill_id:   skillId,
            name, trigger, guidelines,
            enabled:    body.enabled !== false,
        })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') {
            return NextResponse.json({ error: `Ya existe una skill privada con id "${skillId}".` }, { status: 409 });
        }
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    triggerRebuild(companyId);
    return NextResponse.json(data, { status: 201 });
}
