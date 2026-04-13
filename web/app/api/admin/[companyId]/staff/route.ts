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
        .from('staff')
        .select('id, name, role, specialty, phone, email, max_daily_appointments, active, gcal_email, gcal_connected_at, created_at')
        .eq('company_id', companyId)
        .order('active', { ascending: false })
        .order('name', { ascending: true });

    if (!includeArchived) query = query.eq('active', true);

    const { data: staffList, error: staffError } = await query;
    if (staffError) return NextResponse.json({ error: staffError.message }, { status: 500 });

    // Fetch gcal_config for all staff in this company
    const { data: configs } = await (getSupabase() as any)
        .schema('clinicas')
        .from('gcal_config')
        .select('staff_id, calendar_id, work_start, work_end, work_days, default_slot_min')
        .eq('company_id', companyId);

    const configMap = new Map<string, any>();
    if (configs) {
        for (const c of configs) {
            if (c.staff_id) configMap.set(c.staff_id, c);
        }
    }

    const merged = (staffList ?? []).map((s: any) => ({
        ...s,
        gcal_config: configMap.get(s.id) ?? null,
    }));

    return NextResponse.json(merged);
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
    if (body.role) row.role = body.role;
    if (body.specialty) row.specialty = body.specialty;
    if (body.phone) row.phone = body.phone;
    if (body.email) row.email = body.email;
    if (body.max_daily_appointments != null) row.max_daily_appointments = body.max_daily_appointments;

    const { data, error } = await (getSupabase() as any)
        .schema('clinicas')
        .from('staff')
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

    // staff table has no updated_at column
    const { data, error } = await (getSupabase() as any)
        .schema('clinicas')
        .from('staff')
        .update(updates)
        .eq('id', id)
        .eq('company_id', companyId)
        .select()
        .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Profesional no encontrado' }, { status: 404 });

    triggerRebuild(companyId);
    return NextResponse.json(data);
}
