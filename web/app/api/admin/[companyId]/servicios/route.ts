import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

function getSupabase() {
    return createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_KEY!,
        { auth: { persistSession: false } }
    );
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
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;
    const includeArchived = req.nextUrl.searchParams.get('archived') === 'true';

    let query = (getSupabase() as any)
        .schema('clinicas')
        .from('treatments')
        .select('id, name, description, price_min, price_max, duration_min, category, active, created_at, updated_at')
        .eq('company_id', companyId)
        .order('active', { ascending: false })
        .order('name', { ascending: true });

    if (!includeArchived) query = query.eq('active', true);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;
    const body = await req.json();

    if (!body.name?.trim()) {
        return NextResponse.json({ error: 'El nombre es obligatorio' }, { status: 400 });
    }

    const row: Record<string, any> = {
        company_id: companyId,
        name: body.name.trim(),
        active: true,
    };
    if (body.description) row.description = body.description;
    if (body.price_min != null) row.price_min = body.price_min;
    if (body.price_max != null) row.price_max = body.price_max;
    if (body.duration_min != null) row.duration_min = body.duration_min;
    if (body.category) row.category = body.category;

    const { data, error } = await (getSupabase() as any)
        .schema('clinicas')
        .from('treatments')
        .insert([row])
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    triggerRebuild(companyId);
    return NextResponse.json(data, { status: 201 });
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ companyId: string }> }
) {
    const { companyId } = await params;
    const { id, ...updates } = await req.json();

    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

    const { data, error } = await (getSupabase() as any)
        .schema('clinicas')
        .from('treatments')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('company_id', companyId)
        .select()
        .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Servicio no encontrado' }, { status: 404 });

    triggerRebuild(companyId);
    return NextResponse.json(data);
}
