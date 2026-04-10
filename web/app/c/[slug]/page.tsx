import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface Company {
    name: string;
    slug: string;
    wa_phone_display: string | null;
    timezone: string;
    currency: string;
    country_code: string;
    plan: string;
}

interface Agent {
    name: string;
    system_prompt: string;
    tone: string;
    qualification_criteria: Record<string, unknown>;
    escalation_rules: Record<string, unknown>;
    objections_kb: Array<{ objection: string; response: string }>;
}

interface Treatment {
    id: string;
    name: string;
    description: string | null;
    price_min: number | null;
    price_max: number | null;
    duration_min: number | null;
    preparation_instructions: string | null;
    post_care_instructions: string | null;
    followup_days: number[];
}

interface StaffMember {
    id: string;
    name: string;
    role: string | null;
    specialty: string | null;
}

interface ClinicProfile {
    company: Company | null;
    agent: Agent | null;
    treatments: Treatment[];
    staff: StaffMember[];
}

// ─── Data fetching (server-side, nunca expone credenciales al cliente) ────────

async function getProfile(slug: string): Promise<ClinicProfile | null> {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        throw new Error('Variables de entorno SUPABASE_URL y SUPABASE_SERVICE_KEY requeridas');
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false },
    });

    const { data, error } = await (supabase as any)
        .schema('clinicas')
        .rpc('get_public_profile', { p_slug: slug });

    if (error || !data || !data.company) return null;

    return {
        company:    data.company   ?? null,
        agent:      data.agent     ?? null,
        treatments: data.treatments ?? [],
        staff:      data.staff     ?? [],
    };
}

// ─── Metadata dinámica ────────────────────────────────────────────────────────

export async function generateMetadata(
    { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
    const { slug } = await params;
    const profile = await getProfile(slug);
    if (!profile?.company) {
        return { title: 'Clínica no encontrada · Bruno Lab' };
    }
    return {
        title: `${profile.company.name} · Bruno Lab`,
        description: `Panel de información de ${profile.company.name}`,
    };
}

// ─── Helpers de UI ────────────────────────────────────────────────────────────

function formatPrice(min: number | null, max: number | null, currency: string): string {
    if (!min && !max) return 'Consultar precio';
    const fmt = (n: number) => n.toLocaleString('es', { minimumFractionDigits: 0 });
    if (min && max && min !== max) return `${currency} ${fmt(min)} – ${fmt(max)}`;
    return `${currency} ${fmt((min ?? max)!)}`;
}

function formatDuration(min: number | null): string {
    if (!min) return '';
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60 > 0 ? `${min % 60}m` : ''}`.trim() : `${min} min`;
}

function initials(name: string): string {
    return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function toneLabel(tone: string): string {
    return { formal: 'Formal', amigable: 'Amigable', casual: 'Casual' }[tone] ?? tone;
}

function countryFlag(code: string): string {
    return code.toUpperCase().replace(/./g, c =>
        String.fromCodePoint(c.charCodeAt(0) + 127397)
    );
}

// ─── Componentes ─────────────────────────────────────────────────────────────

function AgentSection({ agent, currency }: { agent: Agent; currency: string }) {
    const hasQualification = agent.qualification_criteria &&
        Object.keys(agent.qualification_criteria).length > 0;
    const hasEscalation = agent.escalation_rules &&
        Object.keys(agent.escalation_rules).length > 0;
    const hasObjections = Array.isArray(agent.objections_kb) && agent.objections_kb.length > 0;

    return (
        <div className="section">
            <div className="section-header">
                <span>🤖</span>
                <h2>Agente IA</h2>
            </div>
            <div className="section-body">
                <div className="agent-name">{agent.name}</div>
                <span className="tone-badge">Tono: {toneLabel(agent.tone)}</span>

                <div className="subsection-title">Sistema Prompt (instrucciones activas)</div>
                <div className="prompt-box">{agent.system_prompt}</div>

                {hasQualification && (
                    <>
                        <div className="subsection-title">Criterios de calificación</div>
                        <div className="criteria-grid">
                            {Object.entries(agent.qualification_criteria).map(([k, v]) => (
                                <div className="criteria-item" key={k}>
                                    <span className="criteria-key">{k}: </span>
                                    {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {hasEscalation && (
                    <>
                        <div className="subsection-title">Reglas de escalamiento</div>
                        <div className="criteria-grid">
                            {Object.entries(agent.escalation_rules).map(([k, v]) => (
                                <div className="criteria-item" key={k}>
                                    <span className="criteria-key">{k}: </span>
                                    {Array.isArray(v) ? (v as string[]).join(', ') : String(v)}
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {hasObjections && (
                    <>
                        <div className="subsection-title">Manejo de objeciones ({agent.objections_kb.length})</div>
                        {agent.objections_kb.map((o, i) => (
                            <div className="objection-item" key={i}>
                                <div className="objection-q">"{o.objection}"</div>
                                <div className="objection-a">→ {o.response}</div>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

function TreatmentsSection({ treatments, currency }: { treatments: Treatment[]; currency: string }) {
    return (
        <div className="section">
            <div className="section-header">
                <span>💊</span>
                <h2>Tratamientos ({treatments.length})</h2>
            </div>
            <div className="section-body">
                {treatments.length === 0 ? (
                    <p className="empty">No hay tratamientos cargados aún.</p>
                ) : (
                    <div className="treatment-grid">
                        {treatments.map(t => (
                            <div className="treatment-card" key={t.id}>
                                <div className="treatment-name">{t.name}</div>
                                {t.description && (
                                    <div className="treatment-desc">{t.description}</div>
                                )}
                                <div className="treatment-meta">
                                    <span className="meta-chip">
                                        💰 {formatPrice(t.price_min, t.price_max, currency)}
                                    </span>
                                    {t.duration_min && (
                                        <span className="meta-chip">
                                            ⏱ {formatDuration(t.duration_min)}
                                        </span>
                                    )}
                                    {t.followup_days?.length > 0 && (
                                        <span className="meta-chip">
                                            📅 Seguimiento: día {t.followup_days.join(', ')}
                                        </span>
                                    )}
                                </div>
                                {t.preparation_instructions && (
                                    <div className="instruction-block">
                                        <strong>Preparación pre-cita</strong>
                                        {t.preparation_instructions}
                                    </div>
                                )}
                                {t.post_care_instructions && (
                                    <div className="instruction-block">
                                        <strong>Cuidados post-tratamiento</strong>
                                        {t.post_care_instructions}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function StaffSection({ staff }: { staff: StaffMember[] }) {
    return (
        <div className="section">
            <div className="section-header">
                <span>👩‍⚕️</span>
                <h2>Personal ({staff.length})</h2>
            </div>
            <div className="section-body">
                {staff.length === 0 ? (
                    <p className="empty">No hay personal cargado aún.</p>
                ) : (
                    <div className="staff-list">
                        {staff.map(s => (
                            <div className="staff-item" key={s.id}>
                                <div className="staff-avatar">{initials(s.name)}</div>
                                <div>
                                    <div className="staff-name">{s.name}</div>
                                    <div className="staff-role">
                                        {[s.role, s.specialty].filter(Boolean).join(' · ')}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default async function ClinicPage(
    { params }: { params: Promise<{ slug: string }> }
) {
    const { slug } = await params;
    const profile = await getProfile(slug);

    if (!profile?.company) {
        notFound();
    }

    const { company, agent, treatments, staff } = profile;

    return (
        <div className="container">

            {/* Header */}
            <div className="clinic-header">
                <h1>{company.name}</h1>
                <div className="clinic-meta">
                    {company.wa_phone_display && (
                        <span>📱 {company.wa_phone_display}</span>
                    )}
                    <span>{countryFlag(company.country_code)} {company.country_code}</span>
                    <span>🕐 {company.timezone}</span>
                    <span className="badge">Plan {company.plan}</span>
                </div>
            </div>

            {/* Agente */}
            {agent ? (
                <AgentSection agent={agent} currency={company.currency} />
            ) : (
                <div className="section">
                    <div className="section-body">
                        <p className="empty">No hay agente configurado para esta clínica.</p>
                    </div>
                </div>
            )}

            {/* Tratamientos */}
            <TreatmentsSection treatments={treatments} currency={company.currency} />

            {/* Personal */}
            <StaffSection staff={staff} />

            <div className="page-footer">
                Generado por <strong>Bruno Lab</strong> · {new Date().toLocaleDateString('es', { dateStyle: 'long' })}
            </div>

        </div>
    );
}
